import { randomUUID } from "node:crypto";
import { RESP_TYPES } from "redis";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { createRedisClient, DEFAULT_REDIS_URL } from "../../src/client.js";
import {
  createTask, moveTask, removeMember,
  type CreateTaskInput, type MoveTaskInput, type RemoveMemberInput,
} from "../../src/functions.js";
import { createKeys } from "../../src/keys.js";
import { loadLibrary } from "../../src/load.js";
import type { FunctionReply } from "../../src/reply.js";
import { verifyTaskIndexes } from "../../src/verify-task-indexes.js";

const client = createRedisClient(DEFAULT_REDIS_URL);
const binaryClient = client.withTypeMapping({ [RESP_TYPES.BLOB_STRING]: Buffer });
const owner = "usr_owner";
const admin = "usr_admin";
const member = "usr_member";
const outsider = "usr_outsider";
const nowMs = Date.parse("2026-11-18T08:30:00.123Z");
let keys: ReturnType<typeof createKeys>;
let workspaceId: string;
let projectId: string;

beforeAll(async () => {
  await client.connect();
  await loadLibrary(client);
});

beforeEach(async () => {
  const scope = randomUUID();
  keys = createKeys(`sh:integration:${scope}:`);
  workspaceId = `ws_${scope}`;
  projectId = `prj_${scope}`;
  await client.multi()
    .json.set(keys.workspace(workspaceId), "$", { id: workspaceId, ownerId: owner })
    .json.set(keys.project(projectId), "$", { id: projectId, workspaceId, archivedAt: null, key: "IT" })
    .hSet(keys.workspaceMembers(workspaceId), { [owner]: "OWNER", [admin]: "ADMIN", [member]: "MEMBER" })
    .sAdd(keys.userWorkspaces(owner), workspaceId)
    .sAdd(keys.userWorkspaces(admin), workspaceId)
    .sAdd(keys.userWorkspaces(member), workspaceId)
    .exec();
});

afterEach(async () => {
  if (!client.isOpen || !keys) return;
  const names: string[] = [];
  for await (const batch of client.scanIterator({ MATCH: `${keys.prefix}*` })) names.push(...batch);
  if (names.length) await client.unlink(names);
});

afterAll(async () => {
  if (client.isOpen) await client.close();
});

function createInput(taskId: string, overrides: Partial<CreateTaskInput> = {}): CreateTaskInput {
  return {
    workspaceId, projectId, nowMs, actorId: owner, taskId,
    payload: { title: taskId }, idempotencyKey: randomUUID(), clientMutationId: randomUUID(),
    ...overrides,
  };
}

function moveInput(taskId: string, overrides: Partial<MoveTaskInput> = {}): MoveTaskInput {
  return {
    workspaceId, projectId, nowMs, actorId: owner, taskId,
    from: "TODO", to: "IN_PROGRESS", expectedVersion: 1,
    idempotencyKey: randomUUID(), clientMutationId: randomUUID(), ...overrides,
  };
}

function removeInput(overrides: Partial<RemoveMemberInput> = {}): RemoveMemberInput {
  return { workspaceId, nowMs, actorId: owner, userId: member, idempotencyKey: randomUUID(), ...overrides };
}

async function create(taskId: string, overrides: Partial<CreateTaskInput> = {}) {
  const result = await createTask(client, createInput(taskId, overrides), keys);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return result;
}

async function successfulMove(taskId: string, overrides: Partial<MoveTaskInput> = {}) {
  const result = await moveTask(client, moveInput(taskId, overrides), keys);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return result;
}

async function assertClean() {
  expect(await verifyTaskIndexes(client, keys)).toEqual({ ok: true, findings: [] });
}

async function snapshot() {
  const entries: Record<string, [string | undefined, number]> = {};
  for await (const batch of client.scanIterator({ MATCH: `${keys.prefix}*` })) {
    await Promise.all(batch.map(async (key) => {
      const [dump, expiration] = await Promise.all([binaryClient.dump(key), client.pExpireTime(key)]);
      entries[key] = [dump?.toString("base64"), expiration];
    }));
  }
  return entries;
}

async function assertRejected(
  call: () => Promise<FunctionReply>,
  code: string,
  params: Record<string, unknown> = {},
) {
  const before = await snapshot();
  expect(await call()).toEqual({ ok: false, code, params });
  expect(await snapshot()).toEqual(before);
}

async function assertEvent(seq: number, expected: Record<string, string>, board?: string) {
  const events = await client.xRange(keys.domainEvents(), "-", "+");
  expect(events).toHaveLength(seq);
  expect(events?.at(-1)?.message).toMatchObject({
    workspaceId, seq: String(seq), occurredAt: new Date(nowMs).toISOString(), ...expected,
  });
  if (board) {
    expect(await client.zScore(keys.workspaceChanges(workspaceId), board)).toBe(seq);
  }
}

it("loads the versioned library and exposes a read-only version probe", async () => {
  expect(await client.fCallRo("sh_lib_version")).toBe(1);
});

it("creates canonical JSON and all required indexes for assigned and unassigned tasks", async () => {
  const first = await create("tsk_first", {
    actorId: member, payload: { title: "First", description: "Markdown", priority: "HIGH", dueAtMs: nowMs },
  });
  const second = await create("tsk_second", { assigneeId: member });
  const firstDoc = await client.json.get(keys.task("tsk_first"));
  expect(first).toEqual({ ok: true, data: firstDoc, seq: 1 });
  expect(firstDoc).toMatchObject({
    title: "First", description: "Markdown", priority: "HIGH", dueAtMs: nowMs,
    status: "TODO", assigneeId: null, assigneeIndexValue: "UNASSIGNED", labelIds: [],
    createdAtMs: nowMs, createdAt: new Date(nowMs).toISOString(), reporterId: member,
    number: 1, key: "IT-1", version: 1, lastSeq: 1,
  });
  expect(firstDoc).not.toHaveProperty("position");
  expect(second).toMatchObject({ ok: true, data: { key: "IT-2", assigneeId: member }, seq: 2 });
  expect(await client.exists(keys.userAssigned())).toBe(0);
  expect(await client.sMembers(keys.userAssigned(member))).toEqual(["tsk_second"]);
  expect(await client.get(keys.projectTaskSeq(projectId))).toBe("2");
  expect(await client.get(keys.workspaceSeq(workspaceId))).toBe("2");
  expect(await client.zRangeWithScores(keys.board(projectId, "TODO"), 0, -1)).toEqual([
    { value: "tsk_first", score: 1024 }, { value: "tsk_second", score: 2048 },
  ]);
  expect(await client.zScore(keys.workspaceChanges(workspaceId), "task:tsk_second")).toBe(2);
  await assertEvent(2, { type: "TASK_CREATED", taskId: "tsk_second", entityVersion: "1" });
  await assertClean();
});

it("replays create with normalized payload and unchanged TTL after the project is archived", async () => {
  const input = createInput("tsk_stable", { payload: { title: "Create once" } });
  const original = await createTask(client, input, keys);
  expect(original).toMatchObject({ ok: true, seq: 1 });
  const idem = keys.idempotency(owner, input.idempotencyKey);
  const stored = JSON.parse((await client.get(idem))!);
  expect(stored.requestHash).toMatch(/^[0-9a-f]{64}$/);
  expect(JSON.parse(stored.response)).toEqual(original);
  expect(await client.ttl(idem)).toBeGreaterThanOrEqual(86399);
  expect(await client.ttl(idem)).toBeLessThanOrEqual(86400);
  await client.json.set(keys.project(projectId), "$.archivedAt", "2026-11-18");
  const before = await snapshot();
  expect(await createTask(client, {
    ...input, taskId: "tsk_regenerated", nowMs: nowMs + 100, assigneeId: null,
    payload: { dueAtMs: null, priority: "MEDIUM", description: "", title: "Create once" },
  }, keys)).toEqual(original);
  expect(await snapshot()).toEqual(before);
  await assertClean();
});

it("returns KEYS_MISMATCH for a forged idempotency slot before replay", async () => {
  const input = createInput("tsk_forged");
  expect((await createTask(client, input, keys)).ok).toBe(true);
  const forged = { ...keys, idempotency: (_actor: string, key: string) => keys.idempotency(admin, key) };
  await assertRejected(() => createTask(client, input, forged), "KEYS_MISMATCH");
});

it("returns NOT_FOUND for a caller without membership", async () => {
  const input = createInput("tsk_no_actor", { actorId: outsider });
  await assertRejected(() => createTask(client, input, keys), "NOT_FOUND");
});

it("returns PROJECT_ARCHIVED for a new mutation in an archived project", async () => {
  await client.json.set(keys.project(projectId), "$.archivedAt", "2026-11-18");
  const input = createInput("tsk_archived");
  await assertRejected(() => createTask(client, input, keys), "PROJECT_ARCHIVED");
});

it("returns ASSIGNEE_NOT_MEMBER for an absent assignee", async () => {
  const input = createInput("tsk_no_assignee", { assigneeId: outsider });
  await assertRejected(() => createTask(client, input, keys), "ASSIGNEE_NOT_MEMBER");
});

it("returns IDEMPOTENCY_KEY_REUSED when payload changes", async () => {
  const input = createInput("tsk_existing");
  expect((await createTask(client, input, keys)).ok).toBe(true);
  await assertRejected(() => createTask(client, {
    ...input, payload: { title: "Different payload" },
  }, keys), "IDEMPOTENCY_KEY_REUSED");
});

it("returns NOT_FOUND for a missing task", async () => {
  const input = moveInput("tsk_missing");
  await assertRejected(() => moveTask(client, input, keys), "NOT_FOUND");
});

it("returns TASK_VERSION_CONFLICT with the current version", async () => {
  await create("tsk_conflict");
  await successfulMove("tsk_conflict");
  const input = moveInput("tsk_conflict", { from: "IN_PROGRESS", to: "TODO" });
  await assertRejected(() => moveTask(client, input, keys), "TASK_VERSION_CONFLICT", { currentVersion: 2 });
});

it("returns INVALID_STATUS_TRANSITION for TODO to DONE", async () => {
  await create("tsk_transition");
  const input = moveInput("tsk_transition", { to: "DONE" });
  await assertRejected(() => moveTask(client, input, keys), "INVALID_STATUS_TRANSITION");
});

it.each(["missing", "self", "same", "nonadjacent", "not-first", "not-last"])(
  "returns INVALID_POSITION_ANCHOR for %s anchors",
  async (kind) => {
    for (const id of ["tsk_a", "tsk_b", "tsk_c", "tsk_mover"]) await create(id);
    const invalid: Record<string, Partial<MoveTaskInput>> = {
      missing: { afterTaskId: "tsk_unknown" },
      self: { afterTaskId: "tsk_mover" },
      same: { afterTaskId: "tsk_a", beforeTaskId: "tsk_a" },
      nonadjacent: { afterTaskId: "tsk_a", beforeTaskId: "tsk_c" },
      "not-first": { beforeTaskId: "tsk_b" },
      "not-last": { afterTaskId: "tsk_b" },
    };
    const input = moveInput("tsk_mover", { to: "TODO", ...invalid[kind] });
    await assertRejected(() => moveTask(client, input, keys), "INVALID_POSITION_ANCHOR");
  },
);

it("returns COLUMN_FULL on create and cross-column move at 500 tasks", async () => {
  await create("tsk_outside");
  await successfulMove("tsk_outside");
  for (let i = 0; i < 500; i += 1) await create(`tsk_full_${i}`);
  const createInFull = createInput("tsk_overflow");
  const moveIntoFull = moveInput("tsk_outside", { from: "IN_PROGRESS", to: "TODO", expectedVersion: 2 });
  await assertRejected(() => createTask(client, createInFull, keys), "COLUMN_FULL", { limit: 500 });
  await assertRejected(() => moveTask(client, moveIntoFull, keys), "COLUMN_FULL", { limit: 500 });
  await successfulMove("tsk_full_0", { to: "TODO" });
  expect(await client.zCard(keys.board(projectId, "TODO"))).toBe(500);
  await assertClean();
});

it("moves across columns and replays only after refreshing a stale from value", async () => {
  await create("tsk_move");
  const input = moveInput("tsk_move");
  const moved = await moveTask(client, input, keys);
  const task = await client.json.get(keys.task(input.taskId));
  expect(moved).toEqual({ ok: true, data: task, seq: 2 });
  expect(task).toMatchObject({ status: "IN_PROGRESS", version: 2, lastSeq: 2, labelIds: [] });
  expect(await client.zScore(keys.board(projectId, "TODO"), input.taskId)).toBeNull();
  expect(await client.zScore(keys.board(projectId, "IN_PROGRESS"), input.taskId)).toBe(1024);
  // A raw retry with stale from fails the source check; the caller re-reads before replay.
  await assertRejected(() => moveTask(client, input, keys), "KEYS_MISMATCH");
  const before = await snapshot();
  const current = await client.json.get(keys.task(input.taskId)) as { status: string };
  expect(await moveTask(client, { ...input, from: current.status, nowMs: nowMs + 20 }, keys)).toEqual(moved);
  expect(await snapshot()).toEqual(before);
  await assertEvent(2, { type: "TASK_MOVED", taskId: input.taskId, entityVersion: "2" });
  await assertClean();
});

it("inserts into an empty destination and at the tail, head, and middle", async () => {
  for (const id of ["tsk_a", "tsk_b", "tsk_c", "tsk_d", "tsk_e"]) await create(id);
  const board = keys.board(projectId, "IN_PROGRESS");
  await successfulMove("tsk_a");
  expect(await client.zScore(board, "tsk_a")).toBe(1024);
  await successfulMove("tsk_b");
  await successfulMove("tsk_c", { afterTaskId: "tsk_b" });
  expect(await client.zScore(board, "tsk_c")).toBe(3072);
  await successfulMove("tsk_d", { beforeTaskId: "tsk_a" });
  expect(await client.zScore(board, "tsk_d")).toBe(0);
  await successfulMove("tsk_e", { afterTaskId: "tsk_b", beforeTaskId: "tsk_c" });
  expect(await client.zScore(board, "tsk_e")).toBe(2560);
  expect(await client.zRange(board, 0, -1)).toEqual(["tsk_d", "tsk_a", "tsk_b", "tsk_e", "tsk_c"]);
  await assertClean();
});

it("reorders in-column with anchors adjacent only after the mover is excluded", async () => {
  for (const id of ["tsk_a", "tsk_b", "tsk_c"]) await create(id);
  await successfulMove("tsk_b", { to: "TODO", afterTaskId: "tsk_a", beforeTaskId: "tsk_c" });
  expect(await client.zScore(keys.board(projectId, "TODO"), "tsk_b")).toBe(2048);
  await successfulMove("tsk_a", { to: "TODO", afterTaskId: "tsk_b", beforeTaskId: "tsk_c" });
  expect(await client.zRange(keys.board(projectId, "TODO"), 0, -1)).toEqual(["tsk_b", "tsk_a", "tsk_c"]);
  await assertClean();
});

it("rebalances the 1024/1025 gap with one TASK_MOVED and a board delta", async () => {
  for (const id of ["tsk_a", "tsk_b", "tsk_mover"]) await create(id);
  const board = keys.board(projectId, "TODO");
  await client.zAdd(board, { value: "tsk_b", score: 1025 });
  const untouched = await client.json.get(keys.task("tsk_b"));
  const moved = await successfulMove("tsk_mover", { to: "TODO", afterTaskId: "tsk_a", beforeTaskId: "tsk_b" });
  expect(moved).toMatchObject({ ok: true, seq: 4, data: { version: 2 } });
  expect(await client.zRangeWithScores(board, 0, -1)).toEqual([
    { value: "tsk_a", score: 1024 }, { value: "tsk_mover", score: 1536 }, { value: "tsk_b", score: 2048 },
  ]);
  expect(await client.json.get(keys.task("tsk_b"))).toEqual(untouched);
  expect(await client.zScore(keys.workspaceChanges(workspaceId), "task:tsk_mover")).toBe(4);
  await assertEvent(4, { type: "TASK_MOVED", rebalancedColumn: "TODO" }, `board:${projectId}:TODO`);
  await assertClean();
});

it("rebalances append past the score bound with one TASK_CREATED and a board delta", async () => {
  await create("tsk_a");
  const board = keys.board(projectId, "TODO");
  await client.zAdd(board, { value: "tsk_a", score: 2 ** 50 - 1024 });
  await create("tsk_b");
  expect(await client.zScore(board, "tsk_b")).toBe(2 ** 50);
  const untouched = await client.json.get(keys.task("tsk_b"));
  await create("tsk_c");
  expect(await client.zRangeWithScores(board, 0, -1)).toEqual([
    { value: "tsk_a", score: 1024 }, { value: "tsk_b", score: 2048 }, { value: "tsk_c", score: 3072 },
  ]);
  expect(await client.json.get(keys.task("tsk_b"))).toEqual(untouched);
  expect(await client.zScore(keys.workspaceChanges(workspaceId), "task:tsk_c")).toBe(3);
  await assertEvent(3, { type: "TASK_CREATED", rebalancedColumn: "TODO" }, `board:${projectId}:TODO`);
  await assertClean();
});

it("removes membership and the reverse link, and replays with one MEMBER_REMOVED", async () => {
  const input = removeInput({ actorId: admin });
  const result = await removeMember(client, input, keys);
  expect(result).toEqual({ ok: true, data: { userId: member }, seq: 1 });
  expect(await client.hGet(keys.workspaceMembers(workspaceId), member)).toBeNull();
  expect(await client.sMembers(keys.userWorkspaces(member))).toEqual([]);
  expect(await client.get(keys.workspaceSeq(workspaceId))).toBe("1");
  expect(await client.zScore(keys.workspaceChanges(workspaceId), `member:${member}`)).toBe(1);
  const before = await snapshot();
  expect(await removeMember(client, { ...input, nowMs: nowMs + 5 }, keys)).toEqual(result);
  expect(await snapshot()).toEqual(before);
  await assertEvent(1, { type: "MEMBER_REMOVED", actorId: admin, payload: JSON.stringify({ userId: member }) });
  await assertClean();
});

it.each([
  [member, admin], [admin, owner], [admin, admin], [owner, outsider],
])("rejects removal by %s of %s without writes", async (actorId, userId) => {
  const input = removeInput({ actorId, userId });
  await assertRejected(() => removeMember(client, input, keys), "NOT_FOUND");
});

it("stops before its first write when a new mutation reuses a generated task ID", async () => {
  const input = createInput("tsk_existing");
  expect((await createTask(client, input, keys)).ok).toBe(true);
  const before = await snapshot();
  await expect(createTask(client, { ...input, idempotencyKey: "different-request" }, keys))
    .rejects.toThrow("Caller-generated task ID already exists");
  expect(await snapshot()).toEqual(before);
});

it("stops before its first write on an occupied issue field or invalid outbox type", async () => {
  const input = createInput("tsk_internal");
  const issueIndex = keys.workspaceTaskKeys(workspaceId);
  await client.hSet(issueIndex, "IT-1", "tsk_reserved");
  let before = await snapshot();
  await expect(createTask(client, input, keys)).rejects.toThrow("Next issue key already exists");
  expect(await snapshot()).toEqual(before);

  await client.del(issueIndex);
  await client.set(keys.domainEvents(), "wrong type");
  before = await snapshot();
  await expect(createTask(client, input, keys)).rejects.toThrow("WRONGTYPE");
  expect(await snapshot()).toEqual(before);
});
