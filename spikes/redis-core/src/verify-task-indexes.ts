import { parseArgs } from "node:util";
import { createRedisClient } from "./client.js";
import { createKeys } from "./keys.js";

type Client = ReturnType<typeof createRedisClient>;

export type TaskIndexFinding = {
  type: "missing" | "orphan" | "duplicate" | "wrong-pointer" | "bad-score";
  taskId?: string;
  key?: string;
  index?: string;
  indexes?: string[];
  expected?: string;
  actual?: string;
  score?: number | string;
  detail?: string;
};

export type TaskIndexReport = { ok: boolean; findings: TaskIndexFinding[] };

type TaskDoc = {
  id: string;
  workspaceId: string;
  projectId: string;
  status: string;
  key: string;
  deletedAt?: unknown;
  isDeleted?: unknown;
};

const STATUSES = new Set(["TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"]);
const MAX_SCORE = 2 ** 50;

function isTaskDoc(value: unknown, id: string): value is TaskDoc {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const task = value as Partial<TaskDoc>;
  return id !== "" && task.id === id &&
    typeof task.workspaceId === "string" && task.workspaceId.length > 0 &&
    typeof task.projectId === "string" && task.projectId.length > 0 &&
    typeof task.key === "string" && task.key.length > 0 &&
    typeof task.status === "string" && STATUSES.has(task.status);
}

function active(task: TaskDoc) {
  return task.deletedAt == null && task.isDeleted !== "true" && task.isDeleted !== true;
}

async function scanByPrefix(client: Client, prefix: string) {
  const pattern = `${prefix.replace(/[\\*?[\]]/g, "\\$&")}*`;
  const found = new Set<string>();
  for await (const batch of client.scanIterator({ MATCH: pattern, COUNT: 500 })) {
    for (const key of batch) found.add(key);
  }
  return [...found].sort();
}

/** Read both directions against a quiescent keyspace. This function never repairs data. */
export async function verifyTaskIndexes(
  client: Client,
  keys = createKeys(),
): Promise<TaskIndexReport> {
  const findings: TaskIndexFinding[] = [];
  const tasks = new Map<string, TaskDoc>();
  const taskPrefix = `${keys.prefix}task:`;

  async function hasType(key: string, expected: string) {
    const actual = await client.type(key);
    if (actual === expected) return true;
    findings.push({ type: "wrong-pointer", key, expected, actual, detail: "Redis key type" });
    return false;
  }

  for (const key of await scanByPrefix(client, taskPrefix)) {
    const taskId = key.slice(taskPrefix.length);
    if (!await hasType(key, "ReJSON-RL")) continue;
    const doc = await client.json.get(key);
    if (!isTaskDoc(doc, taskId)) {
      findings.push({ type: "wrong-pointer", key, taskId, detail: "Invalid task document or ID" });
      continue;
    }
    tasks.set(taskId, doc);
  }

  async function readActiveIndex(
    pattern: string,
    redisType: string,
    readMembers: (key: string) => Promise<Iterable<string>>,
    expectedIndex: (task: TaskDoc) => string,
  ) {
    const locations = new Map<string, Set<string>>();
    for (const index of await scanByPrefix(client, `${keys.prefix}${pattern}:`)) {
      if (!await hasType(index, redisType)) continue;

      for (const taskId of await readMembers(index)) {
        const indexes = locations.get(taskId) ?? new Set<string>();
        indexes.add(index);
        locations.set(taskId, indexes);
        const task = tasks.get(taskId);
        if (!task || !active(task)) {
          findings.push({ type: "orphan", taskId, index });
        } else {
          const expected = expectedIndex(task);
          if (index !== expected) findings.push({ type: "wrong-pointer", taskId, index, expected });
        }
      }
    }

    for (const [taskId, indexes] of locations) {
      if (indexes.size > 1) findings.push({ type: "duplicate", taskId, indexes: [...indexes] });
    }
    for (const [taskId, task] of tasks) {
      if (!active(task)) continue;
      const index = expectedIndex(task);
      if (!locations.get(taskId)?.has(index)) findings.push({ type: "missing", taskId, index });
    }
  }

  await readActiveIndex("project-tasks", "set", key => client.sMembers(key),
    task => keys.projectTasks(task.projectId));
  await readActiveIndex("board", "zset", async (index) => {
    const rows = await client.zRangeWithScores(index, 0, -1);
    for (const { value: taskId, score } of rows) {
      if (!Number.isInteger(score) || Math.abs(score) > MAX_SCORE) {
        findings.push({
          type: "bad-score", taskId, index,
          score: Number.isFinite(score) ? score : String(score),
        });
      }
    }
    return rows.map(row => row.value);
  }, task => keys.board(task.projectId, task.status));

  const workspaceEntries = new Map<string, Map<string, string>>();
  for (const index of await scanByPrefix(client, `${keys.prefix}workspace-task-keys:`)) {
    if (!await hasType(index, "hash")) continue;
    workspaceEntries.set(index, new Map(Object.entries(await client.hGetAll(index))));
  }

  // Permalinks are unique issue-key pointers for canonical tasks, including soft-deleted tasks.
  const expectedEntries = new Map<string, Map<string, string>>();
  for (const [taskId, task] of tasks) {
    const index = keys.workspaceTaskKeys(task.workspaceId);
    const expected = expectedEntries.get(index) ?? new Map<string, string>();
    const duplicate = expected.get(task.key);
    if (duplicate !== undefined) {
      findings.push({ type: "duplicate", taskId, key: task.key, index, actual: duplicate });
    }
    expected.set(task.key, taskId);
    expectedEntries.set(index, expected);
    if (!workspaceEntries.get(index)?.has(task.key)) {
      findings.push({ type: "missing", taskId, key: task.key, index });
    }
  }

  for (const [index, entries] of workspaceEntries) {
    for (const [key, taskId] of entries) {
      const task = tasks.get(taskId);
      const expected = expectedEntries.get(index)?.get(key);
      if (!task) {
        findings.push({ type: "orphan", taskId, key, index, expected });
      } else if (index !== keys.workspaceTaskKeys(task.workspaceId) || key !== task.key) {
        findings.push({ type: "wrong-pointer", taskId, key, index, expected, actual: taskId });
      }
    }
  }
  return { ok: findings.length === 0, findings };
}

async function main() {
  const { values } = parseArgs({ options: { "report-only": { type: "boolean" } } });
  const client = createRedisClient();
  await client.connect();
  try {
    const report = await verifyTaskIndexes(client);
    console.log(JSON.stringify(report, null, 2));
    if (!values["report-only"] && !report.ok) process.exitCode = 1;
  } finally {
    await client.close();
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error("Index verification failed:", error);
    process.exitCode = 1;
  });
}
