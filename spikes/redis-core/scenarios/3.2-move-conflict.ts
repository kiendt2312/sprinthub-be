import assert from "node:assert/strict";
import { moveTask, createTask } from "../src/functions.js";
import { accepted, events, rejected, runStandalone, taskDocument, type Scenario, unchanged, withClients } from "./lib.js";

export const scenario: Scenario = {
  id: "3.2",
  name: "Concurrent moves detect version conflicts",
  async run({ client, keys, fixture, check }) {
    const f = await fixture();
    const createInput = f.createInput();
    accepted(await createTask(client, createInput, keys));
    const taskKey = keys.task(createInput.taskId);
    await client.json.set(taskKey, "$.version", 7);

    const staleInput = f.moveInput(createInput.taskId, { expectedVersion: 6 });
    await check("version conflict returns structured currentVersion 7", () => unchanged(client, keys, async () => {
      rejected(await moveTask(client, staleInput, keys), "TASK_VERSION_CONFLICT", { currentVersion: 7 });
    }));

    const inputs = [
      f.moveInput(createInput.taskId, { expectedVersion: 7 }),
      f.moveInput(createInput.taskId, { expectedVersion: 7 }),
    ];
    const replies = await withClients(2, clients => Promise.all(
      clients.map((connection, index) => moveTask(connection, inputs[index]!, keys)),
    ));
    const successes = replies.filter(reply => reply.ok);
    const initialFailures = replies.filter(reply => !reply.ok);
    await check("same-version race has one winner and one stale-from response", () => {
      assert.equal(successes.length, 1);
      assert.equal(initialFailures.length, 1);
      rejected(initialFailures[0]!, "KEYS_MISMATCH");
    });

    await check("loser rereads canonical status and gets current version conflict", async () => {
      const loserIndex = replies.findIndex(reply => !reply.ok);
      assert.notEqual(loserIndex, -1);
      const { status } = await taskDocument(client, keys, createInput.taskId);
      assert(status === "IN_PROGRESS", "Expected the winner's canonical status");
      const loserInput = { ...inputs[loserIndex], from: status };
      assert.equal(await client.exists(keys.idempotency(loserInput.actorId, loserInput.idempotencyKey)), 0);
      await unchanged(client, keys, async () => {
        const rereadFailure = await moveTask(client, loserInput, keys);
        rejected(rereadFailure, "TASK_VERSION_CONFLICT", { currentVersion: 8 });
      });
    });

    await check("one mutation increments version and emits one event", async () => {
      const task = await taskDocument(client, keys, createInput.taskId);
      assert.equal(task.status, "IN_PROGRESS");
      assert.equal(task.version, 8);
      const moved = (await events(client, keys, f.workspaceId)).filter(event =>
        event.type === "TASK_MOVED" && event.taskId === createInput.taskId);
      assert.equal(moved.length, 1);
      assert.equal(await client.get(keys.workspaceSeq(f.workspaceId)), "2");
      assert.equal(await client.zScore(keys.board(f.projectId, "TODO"), createInput.taskId), null);
      assert.notEqual(await client.zScore(keys.board(f.projectId, "IN_PROGRESS"), createInput.taskId), null);
    });
  },
};

if (import.meta.main) runStandalone(scenario);
