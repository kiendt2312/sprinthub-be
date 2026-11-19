import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRedisClient } from "../src/client.js";
import { createTask, moveTask } from "../src/functions.js";
import { createKeys } from "../src/keys.js";
import { accepted, assertFindings, scopedKeys } from "./lib.js";
import { getSpikeContainerId } from "./persistence-docker.js";

const MEMORY_PROJECTS = 10;
const TASKS_PER_PROJECT = 500;
const REBALANCE_SAMPLES = 100;
const CREATE_SAMPLES = 100;
const MOVE_SAMPLES = 100;
const SLOWLOG_MAX_LEN = 4096;
const FUNCTION_BUDGET_US = 5000;

type Client = ReturnType<typeof createRedisClient>;
type SlowlogRow = [number, number, number, string[], ...unknown[]];

function commandText(value: unknown) {
  return Buffer.isBuffer(value) ? value.toString() : String(value);
}

async function configGet(client: Client) {
  const config = await client.configGet(["slowlog-log-slower-than", "slowlog-max-len"]);
  const { "slowlog-log-slower-than": threshold, "slowlog-max-len": maxLen } = config;
  assert(threshold !== undefined && maxLen !== undefined, "CONFIG GET omitted SLOWLOG settings");
  return { threshold, maxLen };
}

async function slowlogReset(client: Client) {
  await client.sendCommand(["SLOWLOG", "RESET"]);
}

async function fcallDuration(client: Client, functionName: string) {
  const raw = await client.sendCommand(["SLOWLOG", "GET", "16"]);
  assert(Array.isArray(raw), "SLOWLOG GET returned an unexpected response");
  const matches = (raw as unknown[]).filter((entry): entry is SlowlogRow => {
    if (!Array.isArray(entry) || !Array.isArray(entry[3])) return false;
    const args = entry[3].map(commandText);
    return args[0]?.toUpperCase() === "FCALL" && args[1] === functionName;
  });
  assert.equal(matches.length, 1, `Expected exactly one FCALL ${functionName} sample, got ${matches.length}`);
  return matches[0]![2];
}

function percentile(sorted: number[], p: number) {
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
}

function reportDurations(label: string, durations: number[]) {
  assert(durations.length > 0, `${label} produced no samples`);
  const sorted = [...durations].sort((a, b) => a - b);
  const max = sorted.at(-1)!;
  console.log(`${label}: samples=${sorted.length}, unit=server SLOWLOG duration (microseconds), p50=${percentile(sorted, 0.50)}, p99=${percentile(sorted, 0.99)}, max=${max}`);
  return max;
}

async function memoryUsage(client: Client, key: string) {
  const value = await client.sendCommand(["MEMORY", "USAGE", key, "SAMPLES", "0"]);
  assert(value !== null, `MEMORY USAGE returned nil for ${key}`);
  return Number(value);
}

async function reportInfoMemory(client: Client, label: string) {
  const info = await client.info("memory");
  const fields = [...info.matchAll(/^(used_memory(?:_rss)?):(\d+)\r?$/gm)];
  assert.equal(fields.length, 2, "INFO memory omitted used_memory or used_memory_rss");
  console.log(`${label}: ${fields.map(([, key, value]) => `${key}=${value}`).join(", ")}`);
}

async function reportMemory(client: Client, label: string, names: string[]) {
  const bytes = await Promise.all(names.map(name => memoryUsage(client, name)));
  const total = bytes.reduce((sum, value) => sum + value, 0);
  console.log(`${label}: keys=${names.length}, sample_count=${bytes.length}, total_bytes=${total}, mean_bytes=${(total / bytes.length).toFixed(1)}, min_bytes=${Math.min(...bytes)}, max_bytes=${Math.max(...bytes)}, MEMORY USAGE SAMPLES 0`);
}

async function seedWorkspace(client: Client, keys: ReturnType<typeof createKeys>) {
  const workspaceId = `ws_${randomUUID()}`;
  const ownerId = `usr_${randomUUID()}`;
  await client.multi()
    .json.set(keys.workspace(workspaceId), "$", { id: workspaceId, ownerId, archivedAt: null })
    .hSet(keys.workspaceMembers(workspaceId), ownerId, "OWNER")
    .sAdd(keys.userWorkspaces(ownerId), workspaceId)
    .exec();
  return { workspaceId, ownerId };
}

function mutation(workspaceId: string, projectId: string, actorId: string) {
  return { workspaceId, projectId, actorId, idempotencyKey: randomUUID(), nowMs: Date.now(), clientMutationId: randomUUID() };
}

async function seedProject(client: Client, keys: ReturnType<typeof createKeys>, workspaceId: string,
  ownerId: string, projectKey: string, initialTasks: number) {
  const projectId = `prj_${randomUUID()}`;
  await client.json.set(keys.project(projectId), "$", { id: projectId, workspaceId, key: projectKey, archivedAt: null });
  const taskIds: string[] = [];
  const idempotencyKeys: string[] = [];
  for (let index = 0; index < initialTasks; index++) {
    const taskId = `tsk_${randomUUID()}`;
    const input = mutation(workspaceId, projectId, ownerId);
    accepted(await createTask(client, { ...input, taskId, payload: { title: "Benchmark task" } }, keys));
    taskIds.push(taskId);
    idempotencyKeys.push(keys.idempotency(ownerId, input.idempotencyKey));
  }
  return { projectId, taskIds, idempotencyKeys };
}

async function benchmarkMemory(client: Client, keys: ReturnType<typeof createKeys>) {
  await reportInfoMemory(client, "INFO memory baseline");
  const { workspaceId, ownerId } = await seedWorkspace(client, keys);
  const projects = [];
  for (let index = 0; index < MEMORY_PROJECTS; index++) {
    projects.push(await seedProject(client, keys, workspaceId, ownerId, `MEM${index}`, TASKS_PER_PROJECT));
  }

  const taskKeys = projects.flatMap(project => project.taskIds.map(keys.task));
  const count = MEMORY_PROJECTS * TASKS_PER_PROJECT;
  assert.equal(taskKeys.length, count);
  assert.equal(await client.xLen(keys.domainEvents()), count);
  assert.equal(await client.zCard(keys.workspaceChanges(workspaceId)), count);
  await reportInfoMemory(client, "INFO memory with the 10×500 task fixture");
  await assertFindings(client, keys, []);
  console.log(`Memory fixture: ${MEMORY_PROJECTS} projects × ${TASKS_PER_PROJECT} tasks = ${count} tasks, created via sh_create_task.`);
  await reportMemory(client, "Task JSON", taskKeys);
  await reportMemory(client, "project-tasks SET", projects.map(project => keys.projectTasks(project.projectId)));
  await reportMemory(client, "board TODO ZSET", projects.map(project => keys.board(project.projectId, "TODO")));
  await reportMemory(client, "workspace-task-keys HASH", [keys.workspaceTaskKeys(workspaceId)]);
  await reportMemory(client, "workspace-changes ZSET", [keys.workspaceChanges(workspaceId)]);
  await reportMemory(client, "Domain event STREAM", [keys.domainEvents()]);
  await reportMemory(client, "Idempotency STRING", projects.flatMap(project => project.idempotencyKeys));
  await client.unlink(await scopedKeys(client, keys));
}

async function main() {
  const prefix = `sh:spike-bench:${randomUUID()}:`;
  await getSpikeContainerId();
  const memoryKeys = createKeys(`${prefix}memory:`);
  const keys = createKeys(`${prefix}mutation:`);
  const client = createRedisClient();
  await client.connect();
  let originalConfig: Awaited<ReturnType<typeof configGet>> | undefined;
  try {
    const persistenceConfig = await client.configGet(["appendfsync", "appendonly"]);
    assert.equal(persistenceConfig.appendonly, "yes");
    console.log(`Redis persistence config: ${JSON.stringify(persistenceConfig)}`);
    await benchmarkMemory(client, memoryKeys);

    const { workspaceId, ownerId } = await seedWorkspace(client, keys);
    const createProject = await seedProject(client, keys, workspaceId, ownerId, "CRT", 0);
    const moveProject = await seedProject(client, keys, workspaceId, ownerId, "MOV", MOVE_SAMPLES);
    const rebalanceProject = await seedProject(client, keys, workspaceId, ownerId, "RBL", TASKS_PER_PROJECT);
    await assertFindings(client, keys, []);

    originalConfig = await configGet(client);
    await client.configSet({ "slowlog-log-slower-than": "0", "slowlog-max-len": String(SLOWLOG_MAX_LEN) });
    const benchmarkConfig = await configGet(client);
    assert.deepEqual(benchmarkConfig, { threshold: "0", maxLen: String(SLOWLOG_MAX_LEN) });
    console.log(`SLOWLOG benchmark mode: ${JSON.stringify(benchmarkConfig)} (confirmed by CONFIG GET)`);
    const createDurations: number[] = [];
    for (let index = 0; index < CREATE_SAMPLES; index++) {
      const taskId = `tsk_${randomUUID()}`;
      const input = {
        ...mutation(workspaceId, createProject.projectId, ownerId), taskId,
        payload: { title: `Create benchmark ${index}` },
      };
      await slowlogReset(client);
      const reply = await createTask(client, input, keys);
      assert(reply.ok, `Create benchmark ${index} was rejected: ${JSON.stringify(reply)}`);
      createDurations.push(await fcallDuration(client, "sh_create_task"));
    }
    const createMax = reportDurations("sh_create_task", createDurations);

    const moveDurations: number[] = [];
    for (const taskId of moveProject.taskIds) {
      await slowlogReset(client);
      const reply = await moveTask(client, {
        ...mutation(workspaceId, moveProject.projectId, ownerId), taskId,
        from: "TODO", to: "IN_PROGRESS", expectedVersion: 1,
      }, keys);
      assert(reply.ok, `Normal move benchmark was rejected: ${JSON.stringify(reply)}`);
      moveDurations.push(await fcallDuration(client, "sh_move_task"));
    }
    const moveMax = reportDurations("sh_move_task (cross-column, ordinary placement)", moveDurations);

    const rebalanceDurations: number[] = [];
    const rebalanceIds = rebalanceProject.taskIds;
    const boardKey = keys.board(rebalanceProject.projectId, "TODO");
    const mover = rebalanceIds[10]!;
    let expectedVersion = 1;
    const beforeEvents = await client.xLen(keys.domainEvents());
    let expectedSeq = beforeEvents;
    for (let index = 0; index < REBALANCE_SAMPLES; index++) {
      // Restore adjacent scores outside the measured FCALL so every sample rebalances exactly 500 members.
      await client.zAdd(boardKey, rebalanceIds.map((value, rank) => ({ value, score: rank + 1 })));
      await slowlogReset(client);
      const reply = await moveTask(client, {
        ...mutation(workspaceId, rebalanceProject.projectId, ownerId), taskId: mover,
        from: "TODO", to: "TODO", afterTaskId: rebalanceIds[250]!, beforeTaskId: rebalanceIds[251]!,
        expectedVersion,
      }, keys);
      assert(reply.ok, `Rebalance benchmark ${index} was rejected: ${JSON.stringify(reply)}`);
      expectedVersion++;
      expectedSeq++;
      assert.equal(reply.seq, expectedSeq);
      rebalanceDurations.push(await fcallDuration(client, "sh_move_task"));
    }
    const rebalanceMax = reportDurations("sh_move_task (same-column reorder, full 500-task rebalance)", rebalanceDurations);

    const afterEvents = await client.xLen(keys.domainEvents());
    assert.equal(afterEvents - beforeEvents, REBALANCE_SAMPLES, "Expected one stream event per rebalance FCALL");
    const rebalanceEvents = await client.xRange(keys.domainEvents(), "-", "+");
    const matchingEvents = (rebalanceEvents ?? []).map(row => row.message)
      .filter(event => event.type === "TASK_MOVED" && event.projectId === rebalanceProject.projectId);
    assert.equal(matchingEvents.length, REBALANCE_SAMPLES);
    assert(matchingEvents.every((event, index) => event.rebalancedColumn === "TODO" &&
      event.taskId === mover && Number(event.seq) === beforeEvents + index + 1),
      "Every full-column reorder must emit one TASK_MOVED event marked rebalancedColumn=TODO");
    const moverDoc = await client.json.get(keys.task(mover)) as { version?: number; lastSeq?: number } | null;
    assert.equal(moverDoc?.version, expectedVersion);
    assert.equal(moverDoc?.lastSeq, expectedSeq);
    const expectedOrder = rebalanceIds.filter(id => id !== mover);
    expectedOrder.splice(expectedOrder.indexOf(rebalanceIds[251]!), 0, mover);
    assert.deepEqual(await client.zRange(boardKey, 0, -1), expectedOrder);
    await assertFindings(client, keys, []);
    console.log(`Rebalance verification: ${REBALANCE_SAMPLES} TASK_MOVED events, each reported rebalancedColumn=TODO; board remained at ${TASKS_PER_PROJECT}, mover version=${expectedVersion}, lastSeq=${expectedSeq}; index verifier clean.`);

    assert(Math.max(createMax, moveMax, rebalanceMax) < FUNCTION_BUDGET_US,
      `Observed Redis Function exceeded the ${FUNCTION_BUDGET_US} µs server budget`);
  } finally {
    try {
      if (originalConfig) {
        await client.configSet({
          "slowlog-log-slower-than": originalConfig.threshold, "slowlog-max-len": originalConfig.maxLen,
        });
        assert.deepEqual(await configGet(client), originalConfig);
        console.log(`SLOWLOG config restored: ${JSON.stringify(originalConfig)}`);
      }
      const leftovers = await scopedKeys(client, createKeys(prefix));
      if (leftovers.length) await client.unlink(leftovers);
    } finally {
      await client.close();
    }
  }
}

main().catch((error: unknown) => {
  console.error("4.3 benchmark failed:", error);
  process.exitCode = 1;
});
