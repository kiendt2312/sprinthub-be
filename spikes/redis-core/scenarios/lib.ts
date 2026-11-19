import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { inspect, isDeepStrictEqual } from "node:util";
import { RESP_TYPES } from "redis";
import { createRedisClient } from "../src/client.js";
import type { CreateTaskInput, MoveTaskInput, RemoveMemberInput } from "../src/functions.js";
import { createKeys } from "../src/keys.js";
import type { FunctionReply } from "../src/reply.js";
import { verifyTaskIndexes, type TaskIndexFinding } from "../src/verify-task-indexes.js";

export type Client = ReturnType<typeof createRedisClient>;
type Keys = ReturnType<typeof createKeys>;
type Check = () => void | Promise<void>;

interface AssertionRow {
  assertion: string;
  result: "PASS" | "FAIL";
  detail: string;
}

export interface ScenarioContext {
  client: Client;
  keys: Keys;
  fixture(): Promise<Fixture>;
  check(label: string, assertion: Check): Promise<void>;
  expectFindings(...findings: TaskIndexFinding[]): void;
}

export interface Scenario {
  id: string;
  name: string;
  run(context: ScenarioContext): Promise<void>;
}

export interface ScenarioResult {
  id: string;
  name: string;
  passed: number;
  failed: number;
  elapsedMs: number;
}

export async function withClients<T>(count: number, run: (clients: Client[]) => Promise<T>) {
  const clients = Array.from({ length: count }, () => createRedisClient());
  try {
    const connections = await Promise.allSettled(clients.map(client => client.connect()));
    const failed = connections.find(result => result.status === "rejected");
    if (failed) throw failed.reason;
    return await run(clients);
  } finally {
    await Promise.all(clients.map(client => client.isOpen ? client.close() : undefined));
  }
}

async function createFixture(client: Client, keys: Keys) {
  const id = randomUUID();
  const workspaceId = `ws_${id}`;
  const projectId = `prj_${id}`;
  const ownerId = `usr_${id}_owner`;
  const adminId = `usr_${id}_admin`;
  const memberId = `usr_${id}_member`;
  const outsiderId = `usr_${id}_outsider`;
  const projectKey = "SHAPI";
  const nowMs = Date.now();

  await client.multi()
    .json.set(keys.workspace(workspaceId), "$", { id: workspaceId, ownerId })
    .json.set(keys.project(projectId), "$", { id: projectId, workspaceId, key: projectKey, archivedAt: null })
    .hSet(keys.workspaceMembers(workspaceId), { [ownerId]: "OWNER", [adminId]: "ADMIN", [memberId]: "MEMBER" })
    .sAdd(keys.userWorkspaces(ownerId), workspaceId)
    .sAdd(keys.userWorkspaces(adminId), workspaceId)
    .sAdd(keys.userWorkspaces(memberId), workspaceId)
    .exec();

  function mutation() {
    return { workspaceId, actorId: ownerId, idempotencyKey: randomUUID(), nowMs };
  }

  return {
    workspaceId, projectId, ownerId, adminId, memberId, outsiderId, projectKey,
    createInput(overrides: Partial<CreateTaskInput> = {}): CreateTaskInput {
      return {
        ...mutation(), projectId, taskId: `tsk_${randomUUID()}`,
        payload: { title: "Scenario task" }, clientMutationId: randomUUID(), ...overrides,
      };
    },
    moveInput(taskId: string, overrides: Partial<MoveTaskInput> = {}): MoveTaskInput {
      return {
        ...mutation(), projectId, taskId, from: "TODO", to: "IN_PROGRESS", expectedVersion: 1,
        clientMutationId: randomUUID(), ...overrides,
      };
    },
    removeInput(overrides: Partial<RemoveMemberInput> = {}): RemoveMemberInput {
      return { ...mutation(), userId: memberId, ...overrides };
    },
  };
}

export type Fixture = Awaited<ReturnType<typeof createFixture>>;

async function scopedKeys(client: Client, keys: Keys) {
  const names = new Set<string>();
  for await (const batch of client.scanIterator({ MATCH: `${keys.prefix}*`, COUNT: 500 })) {
    for (const name of batch) names.add(name);
  }
  return [...names].sort();
}

export async function snapshot(client: Client, keys: Keys) {
  const binary = client.withTypeMapping({ [RESP_TYPES.BLOB_STRING]: Buffer });
  const names = await scopedKeys(client, keys);
  return Object.fromEntries(await Promise.all(names.map(async key => {
    const [value, expiresAt] = await Promise.all([binary.dump(key), client.pExpireTime(key)]);
    return [key, { value: value?.toString("base64"), expiresAt }] as const;
  })));
}

export async function unchanged(client: Client, keys: Keys, operation: Check) {
  const before = await snapshot(client, keys);
  try {
    await operation();
  } finally {
    assert.deepEqual(await snapshot(client, keys), before);
  }
}

export async function events(client: Client, keys: Keys, workspaceId: string) {
  const entries = await client.xRange(keys.domainEvents(), "-", "+");
  return (entries ?? []).map(entry => entry.message).filter(event => event.workspaceId === workspaceId);
}

export function accepted(reply: FunctionReply): Extract<FunctionReply, { ok: true }> {
  if (!reply.ok) assert.fail(`Expected a successful reply, got ${inspect(reply)}`);
  return reply;
}

export function rejected(reply: FunctionReply, code: string, params: Record<string, unknown> = {}) {
  assert.deepEqual(reply, { ok: false, code, params });
}

export async function taskDocument(client: Client, keys: Keys, taskId: string) {
  const doc = await client.json.get(keys.task(taskId));
  assert(doc && typeof doc === "object" && !Array.isArray(doc) && !(doc instanceof Date),
    `Missing task object ${taskId}`);
  return doc;
}

export async function assertFindings(client: Client, keys: Keys, expected: TaskIndexFinding[]) {
  const report = await verifyTaskIndexes(client, keys);
  assert.equal(report.ok, expected.length === 0, inspect(report));
  const unmatched = [...report.findings];
  for (const finding of expected) {
    const index = unmatched.findIndex(actual => isDeepStrictEqual(actual, finding));
    assert(index >= 0, `Missing finding ${inspect(finding)} in ${inspect(report.findings)}`);
    unmatched.splice(index, 1);
  }
  assert.deepEqual(unmatched, [], "Unexpected verifier findings");
}

export async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  const started = performance.now();
  const keys = createKeys(`sh:spike-scenario:${randomUUID()}:`);
  const assertions: AssertionRow[] = [];
  const expected: TaskIndexFinding[] = [];

  function fail(assertion: string, error: unknown) {
    assertions.push({ assertion, result: "FAIL", detail: error instanceof Error ? error.message : inspect(error) });
  }

  async function check(label: string, assertion: Check) {
    try {
      await assertion();
      assertions.push({ assertion: label, result: "PASS", detail: "" });
    } catch (error) {
      fail(label, error);
    }
  }

  try {
    await withClients(1, async ([client]) => {
      try {
        await scenario.run({
          client, keys, fixture: () => createFixture(client, keys), check,
          expectFindings: (...findings) => { expected.push(...findings); },
        });
      } catch (error) {
        fail("Scenario execution", error);
      }
      try {
        await check("Offline index verifier matches expected findings", () => assertFindings(client, keys, expected));
      } finally {
        const names = await scopedKeys(client, keys);
        if (names.length) await client.unlink(names);
      }
    });
  } catch (error) {
    fail("Redis connection or fixture cleanup", error);
  }

  const failed = assertions.filter(row => row.result === "FAIL").length;
  const elapsedMs = performance.now() - started;
  console.log(`\n${scenario.id} ${scenario.name} (${elapsedMs.toFixed(1)} ms)`);
  console.table(assertions.map(({ assertion, result }) => ({ assertion, result })));
  for (const row of assertions) {
    if (row.result === "FAIL") console.error(`${row.assertion}\n${row.detail}`);
  }
  return { id: scenario.id, name: scenario.name, passed: assertions.length - failed, failed, elapsedMs };
}

export function runStandalone(scenario: Scenario) {
  void runScenario(scenario).then(result => {
    if (result.failed) process.exitCode = 1;
  }).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
