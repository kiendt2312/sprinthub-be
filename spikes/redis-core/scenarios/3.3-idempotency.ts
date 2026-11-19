import assert from "node:assert/strict";
import { createTask, moveTask, removeMember } from "../src/functions.js";
import { accepted, events, rejected, runStandalone, taskDocument, type Scenario, unchanged } from "./lib.js";

function countEvent(rows: Array<Record<string, string>>, type: string, taskId?: string) {
  return rows.filter(row => row.type === type && (taskId === undefined || row.taskId === taskId)).length;
}

function countMemberRemoved(rows: Array<Record<string, string>>, userId: string) {
  return rows.filter(row => row.type === "MEMBER_REMOVED" &&
    JSON.parse(row.payload!).userId === userId).length;
}

export const scenario: Scenario = {
  id: "3.3",
  name: "Mutation retries are idempotent",
  async run({ client, keys, fixture, check }) {
    const f = await fixture();

    const createInput = f.createInput();
    const firstCreate = accepted(await createTask(client, createInput, keys));
    const idemKey = keys.idempotency(createInput.actorId, createInput.idempotencyKey);
    await check("create retry exactly replays without changing persisted state", () => unchanged(client, keys, async () => {
      const replay = accepted(await createTask(client, createInput, keys));
      assert.deepEqual(replay, firstCreate);
      assert.equal(await client.get(keys.projectTaskSeq(f.projectId)), "1");
      assert.equal(await client.get(keys.workspaceSeq(f.workspaceId)), "1");
      assert.equal(countEvent(await events(client, keys, f.workspaceId), "TASK_CREATED", createInput.taskId), 1);
      assert.equal(await client.exists(keys.task(createInput.taskId)), 1);
      assert.equal(await client.sCard(keys.projectTasks(f.projectId)), 1);
      assert.equal(await client.zCard(keys.board(f.projectId, "TODO")), 1);
      const stored = JSON.parse((await client.get(idemKey))!) as { requestHash: string; response: string };
      assert.match(stored.requestHash, /^[0-9a-f]{64}$/);
      assert.deepEqual(replay, JSON.parse(stored.response));
    }));
    await check("idempotency record has a 24-hour TTL", async () => {
      const ttl = await client.pTTL(idemKey);
      assert(ttl >= 86_395_000 && ttl <= 86_400_000, `Unexpected idempotency TTL: ${ttl}`);
    });
    const changedCreate = { ...createInput, payload: { ...createInput.payload, title: "Changed payload" } };
    await check("same create key with different payload is rejected without writes", () => unchanged(client, keys, async () => {
      rejected(await createTask(client, changedCreate, keys), "IDEMPOTENCY_KEY_REUSED");
    }));

    const moveCreate = f.createInput();
    accepted(await createTask(client, moveCreate, keys));
    const moveInput = f.moveInput(moveCreate.taskId);
    accepted(await moveTask(client, moveInput, keys)); // Deliberately discard the response.
    const canonical = await taskDocument(client, keys, moveCreate.taskId);
    const moveIdemKey = keys.idempotency(moveInput.actorId, moveInput.idempotencyKey);
    await check("move retry uses canonical from and exactly replays without writes", () => unchanged(client, keys, async () => {
      assert(canonical.status === "IN_PROGRESS", "Expected the original move to have committed");
      const retryInput = { ...moveInput, from: canonical.status };
      const replay = accepted(await moveTask(client, retryInput, keys));
      const stored = JSON.parse((await client.get(moveIdemKey))!) as { response: string };
      assert.deepEqual(replay, JSON.parse(stored.response));
      assert.equal(canonical.version, 2);
      assert.equal(await taskDocument(client, keys, moveCreate.taskId).then(task => task.version), 2);
      assert.equal(await client.get(keys.workspaceSeq(f.workspaceId)), "3");
      assert.equal(countEvent(await events(client, keys, f.workspaceId), "TASK_MOVED", moveCreate.taskId), 1);
      assert.equal(await client.sCard(keys.projectTasks(f.projectId)), 2);
      assert.equal(await client.zCard(keys.board(f.projectId, "TODO")), 1);
      assert.equal(await client.zCard(keys.board(f.projectId, "IN_PROGRESS")), 1);
    }));

    const adminCreate = f.createInput({ actorId: f.adminId });
    const adminCreateReply = await createTask(client, adminCreate, keys);
    await check("active admin can create before removal", () => { accepted(adminCreateReply); });
    accepted(await removeMember(client, f.removeInput({ userId: f.adminId }), keys));
    await check("removed actor cannot replay its saved create response", () => unchanged(client, keys, async () => {
      rejected(await createTask(client, adminCreate, keys), "NOT_FOUND");
    }));

    const removeInput = f.removeInput();
    const firstRemove = accepted(await removeMember(client, removeInput, keys));
    const removeSeq = await client.get(keys.workspaceSeq(f.workspaceId));
    const removeEvents = countMemberRemoved(await events(client, keys, f.workspaceId), f.memberId);
    await check("remove retry replays once without a second sequence or event", () => unchanged(client, keys, async () => {
      const replay = accepted(await removeMember(client, removeInput, keys));
      assert.deepEqual(replay, firstRemove);
      assert.equal(await client.get(keys.workspaceSeq(f.workspaceId)), removeSeq);
      assert.equal(countMemberRemoved(await events(client, keys, f.workspaceId), f.memberId), removeEvents);
      assert.equal(removeEvents, 1);
      const stored = JSON.parse((await client.get(keys.idempotency(removeInput.actorId, removeInput.idempotencyKey)))!) as { response: string };
      assert.deepEqual(replay, JSON.parse(stored.response));
    }));

    const archivedReplayInput = f.createInput();
    const archivedFirst = accepted(await createTask(client, archivedReplayInput, keys));
    await client.json.set(keys.project(f.projectId), "$.archivedAt", new Date().toISOString());
    await check("archived project still replays a previously successful create", () => unchanged(client, keys, async () => {
      const replay = accepted(await createTask(client, { ...archivedReplayInput, nowMs: Date.now() }, keys));
      assert.deepEqual(replay, archivedFirst);
      assert.equal(await client.get(keys.projectTaskSeq(f.projectId)), "4");
      assert.equal(countEvent(await events(client, keys, f.workspaceId), "TASK_CREATED", archivedReplayInput.taskId), 1);
      assert.equal(await client.sCard(keys.projectTasks(f.projectId)), 4);
    }));
    const archivedNewInput = f.createInput();
    await check("archived project rejects a new create without side effects", () => unchanged(client, keys, async () => {
      rejected(await createTask(client, archivedNewInput, keys), "PROJECT_ARCHIVED");
    }));
  },
};

if (import.meta.main) runStandalone(scenario);
