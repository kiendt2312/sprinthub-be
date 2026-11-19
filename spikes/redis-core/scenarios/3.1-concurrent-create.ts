import assert from "node:assert/strict";
import { createTask, removeMember } from "../src/functions.js";
import { accepted, events, runStandalone, unchanged, withClients, type Scenario } from "./lib.js";

export const scenario: Scenario = {
  id: "3.1",
  name: "Concurrent create and issue-key collision",
  async run({ client, keys, fixture, check }) {
    const f = await fixture();
    const count = 50;
    const inputs = Array.from({ length: count }, () => f.createInput());
    const replies = await withClients(count, clients => Promise.all(
      clients.map((connection, index) => createTask(connection, inputs[index]!, keys)),
    ));

    await check("50 concurrent creates succeed with distinct issue numbers", () => {
      const acceptedReplies = replies.map(accepted);
      const documents = acceptedReplies.map(reply => reply.data as { id: string; key: string });
      assert.equal(new Set(documents.map(task => task.id)).size, count);
      assert.equal(new Set(documents.map(task => task.key)).size, count);
      assert.deepEqual(new Set(documents.map(task => task.key)),
        new Set(Array.from({ length: count }, (_, index) => `${f.projectKey}-${index + 1}`)));
    });
    await check("project and workspace sequences equal 50", async () => {
      assert.equal(await client.get(keys.projectTaskSeq(f.projectId)), String(count));
      assert.equal(await client.get(keys.workspaceSeq(f.workspaceId)), String(count));
      assert.equal(await client.sCard(keys.projectTasks(f.projectId)), count);
      assert.equal((await events(client, keys, f.workspaceId)).filter(event => event.type === "TASK_CREATED").length, count);
    });
    await check("each issue key points to its task", async () => {
      for (const reply of replies) {
        const task = accepted(reply).data as { id: string; key: string };
        assert.equal(await client.hGet(keys.workspaceTaskKeys(f.workspaceId), task.key), task.id);
      }
    });

    // A workspace-only mutation advances its sequence without issuing a task number.
    const removal = accepted(await removeMember(client, f.removeInput(), keys));
    assert.equal(removal.seq, count + 1);
    const collisionKey = `${f.projectKey}-${count + 1}`;
    const workspaceSeqKey = keys.workspaceSeq(f.workspaceId);
    const issueIndex = keys.workspaceTaskKeys(f.workspaceId);
    assert.equal(await client.hSetNX(issueIndex, collisionKey, "reserved-task"), 1);
    try {
      const collisionInput = f.createInput();
      await check("occupied next issue field is rejected without side effects", () => unchanged(client, keys, async () => {
        await assert.rejects(createTask(client, collisionInput, keys), /Next issue key already exists/);
      }));
    } finally {
      await client.hDel(issueIndex, collisionKey);
    }
    await check("the collision leaves both counters unchanged and the fixture is restored", async () => {
      assert.equal(await client.get(workspaceSeqKey), String(count + 1));
      assert.equal(await client.get(keys.projectTaskSeq(f.projectId)), String(count));
      assert.equal(Boolean(await client.hExists(issueIndex, collisionKey)), false);
    });
  },
};

if (import.meta.main) runStandalone(scenario);
