import assert from "node:assert/strict";
import { createTask, removeMember } from "../src/functions.js";
import {
  accepted, events, rejected, runStandalone, taskDocument, unchanged, withClients,
  type Scenario,
} from "./lib.js";

export const scenario: Scenario = {
  id: "3.5",
  name: "Membership ordering and create/remove races",
  async run({ client, keys, fixture, check }) {
    await check("remove before create rejects assignee without side effects", async () => {
      const f = await fixture();
      const removal = accepted(await removeMember(client, f.removeInput(), keys));
      assert.equal(removal.seq, 1);
      const input = f.createInput({ assigneeId: f.memberId });
      await unchanged(client, keys, async () => {
        rejected(await createTask(client, input, keys), "ASSIGNEE_NOT_MEMBER");
      });
      assert.equal(await client.exists(keys.task(input.taskId)), 0);
      assert.equal(await client.get(keys.projectTaskSeq(f.projectId)), null);
      assert.equal(await client.get(keys.workspaceSeq(f.workspaceId)), "1");
      assert.equal(await client.hGet(keys.workspaceTaskKeys(f.workspaceId), `${f.projectKey}-1`), null);
      assert.equal(await client.exists(keys.idempotency(input.actorId, input.idempotencyKey)), 0);
      const eventRows = await events(client, keys, f.workspaceId);
      assert.equal(eventRows.length, 1);
      assert.equal(eventRows[0]?.eventId, `${f.workspaceId}:1`);
      assert.equal(eventRows[0]?.type, "MEMBER_REMOVED");
      assert.equal(eventRows[0]?.seq, "1");
      assert.equal(eventRows[0]?.workspaceId, f.workspaceId);
      assert.equal(eventRows[0]?.actorId, f.ownerId);
      assert.deepEqual(JSON.parse(eventRows[0]?.payload ?? "null"), { userId: f.memberId });
      assert.deepEqual(await client.zRangeWithScores(keys.workspaceChanges(f.workspaceId), 0, -1), [
        { value: `member:${f.memberId}`, score: 1 },
      ]);
      assert.equal(Boolean(await client.sIsMember(keys.userAssigned(f.memberId), input.taskId)), false);
      assert.equal(await client.exists(keys.userAssigned("none")), 0);
    });

    await check("create before remove keeps the task and assignment", async () => {
      const f = await fixture();
      const input = f.createInput({ assigneeId: f.memberId });
      const created = accepted(await createTask(client, input, keys));
      const removal = accepted(await removeMember(client, f.removeInput(), keys));
      assert.equal(created.seq, 1);
      assert.equal(removal.seq, 2);
      assert.deepEqual(await events(client, keys, f.workspaceId).then(rows => rows.map(row => [row.type, row.seq])), [
        ["TASK_CREATED", "1"], ["MEMBER_REMOVED", "2"],
      ]);
      assert.deepEqual(await client.sMembers(keys.userAssigned(f.memberId)), [input.taskId]);
      assert.equal(Boolean(await client.sIsMember(keys.projectTasks(f.projectId), input.taskId)), true);
      assert.equal(await client.zScore(keys.board(f.projectId, "TODO"), input.taskId), 1024);
      assert.deepEqual(await client.zRangeWithScores(keys.workspaceChanges(f.workspaceId), 0, -1), [
        { value: `task:${input.taskId}`, score: 1 },
        { value: `member:${f.memberId}`, score: 2 },
      ]);
      assert.equal((await taskDocument(client, keys, input.taskId) as { assigneeId: string }).assigneeId, f.memberId);
      assert.equal(await client.exists(keys.userAssigned("none")), 0);
      assert.equal(await client.hGet(keys.workspaceTaskKeys(f.workspaceId), `${f.projectKey}-1`), input.taskId);
      const rejectedRetry = f.createInput({ assigneeId: f.memberId });
      await unchanged(client, keys, async () => rejected(
        await createTask(client, rejectedRetry, keys), "ASSIGNEE_NOT_MEMBER",
      ));
      assert.equal(await client.exists(keys.task(rejectedRetry.taskId)), 0);
      assert.equal(await client.exists(keys.idempotency(rejectedRetry.actorId, rejectedRetry.idempotencyKey)), 0);
    });

    await check("unassigned create succeeds without a none-assignee index", async () => {
      const f = await fixture();
      const input = f.createInput();
      accepted(await createTask(client, input, keys));
      assert.equal(await client.exists(keys.userAssigned("none")), 0);
      assert.equal(Boolean(await client.sIsMember(keys.userAssigned(f.memberId), input.taskId)), false);
      assert.equal((await taskDocument(client, keys, input.taskId) as { assigneeId: unknown }).assigneeId, null);
    });

    let createWins = 0;
    let removeWins = 0;
    await check("Each of 100 independent races preserves task, index, outbox, and retry invariants", () =>
      withClients(2, async ([createClient, removeClient]) => {
        for (let index = 0; index < 100; index += 1) {
          const f = await fixture();
          const input = f.createInput({ assigneeId: f.memberId });
          const removalInput = f.removeInput();
          let createPromise: ReturnType<typeof createTask>;
          let removePromise: ReturnType<typeof removeMember>;
          if (index % 2 === 0) {
            createPromise = createTask(createClient, input, keys);
            removePromise = removeMember(removeClient, removalInput, keys);
          } else {
            removePromise = removeMember(removeClient, removalInput, keys);
            createPromise = createTask(createClient, input, keys);
          }
          const [createReply, removeReply] = await Promise.all([createPromise, removePromise]);
          const removeResult = accepted(removeReply);
          const eventRows = await events(client, keys, f.workspaceId);
          const removals = eventRows.filter(row => row.type === "MEMBER_REMOVED");
          assert.equal(removals.length, 1);
          assert.equal(Number(removals[0].seq), removeResult.seq);
          assert.deepEqual(JSON.parse(removals[0].payload), { userId: f.memberId });
          assert.equal(Boolean(await client.hExists(keys.workspaceMembers(f.workspaceId), f.memberId)), false);
          assert.equal(Boolean(await client.sIsMember(keys.userWorkspaces(f.memberId), f.workspaceId)), false);
          assert.equal(eventRows.filter(row => row.type === "TASK_CREATED").length, createReply.ok ? 1 : 0);
          assert.equal(eventRows.length, createReply.ok ? 2 : 1);
          assert.equal(removeResult.seq, createReply.ok ? 2 : 1);

          if (createReply.ok) {
            createWins += 1;
            assert.equal(createReply.seq, 1);
            assert.ok(createReply.seq < removeResult.seq, "create must linearize before member removal");
            assert.equal(await client.exists(keys.task(input.taskId)), 1);
            assert.equal(await client.get(keys.projectTaskSeq(f.projectId)), "1");
            assert.equal(await client.get(keys.workspaceSeq(f.workspaceId)), "2");
            assert.equal(await client.hGet(keys.workspaceTaskKeys(f.workspaceId), `${f.projectKey}-1`), input.taskId);
            assert.equal(Boolean(await client.sIsMember(keys.userAssigned(f.memberId), input.taskId)), true);
            assert.equal(Boolean(await client.sIsMember(keys.projectTasks(f.projectId), input.taskId)), true);
            assert.equal(await client.zScore(keys.board(f.projectId, "TODO"), input.taskId), 1024);
            assert.deepEqual(await client.zRangeWithScores(keys.workspaceChanges(f.workspaceId), 0, -1), [
              { value: `task:${input.taskId}`, score: 1 },
              { value: `member:${f.memberId}`, score: 2 },
            ]);
            assert.equal(await client.exists(keys.idempotency(input.actorId, input.idempotencyKey)), 1);
            const task = await taskDocument(client, keys, input.taskId) as { assigneeId: string; lastSeq: number };
            assert.equal(task.assigneeId, f.memberId);
            assert.equal(task.lastSeq, createReply.seq);
            assert.deepEqual(eventRows.map(row => [row.type, row.seq]).sort((a, b) => Number(a[1]) - Number(b[1])), [
              ["TASK_CREATED", "1"], ["MEMBER_REMOVED", "2"],
            ]);
          } else {
            removeWins += 1;
            rejected(createReply, "ASSIGNEE_NOT_MEMBER");
            assert.equal(await client.exists(keys.task(input.taskId)), 0);
            assert.equal(await client.get(keys.projectTaskSeq(f.projectId)), null);
            assert.equal(await client.get(keys.workspaceSeq(f.workspaceId)), "1");
            assert.equal(await client.hGet(keys.workspaceTaskKeys(f.workspaceId), `${f.projectKey}-1`), null);
            assert.equal(Boolean(await client.sIsMember(keys.userAssigned(f.memberId), input.taskId)), false);
            assert.equal(Boolean(await client.sIsMember(keys.projectTasks(f.projectId), input.taskId)), false);
            assert.equal(await client.zScore(keys.board(f.projectId, "TODO"), input.taskId), null);
            assert.deepEqual(await client.zRangeWithScores(keys.workspaceChanges(f.workspaceId), 0, -1), [
              { value: `member:${f.memberId}`, score: 1 },
            ]);
            assert.equal(await client.exists(keys.idempotency(input.actorId, input.idempotencyKey)), 0);
            assert.deepEqual(eventRows.map(row => [row.type, row.seq]), [["MEMBER_REMOVED", "1"]]);
          }
          assert.equal(await client.exists(keys.userAssigned("none")), 0);
        }
      }));

    console.log(`3.5 race outcomes: create-before-remove=${createWins}, remove-before-create=${removeWins} (100 pairs)`);
    await check("both serialized outcomes were observed", () => {
      assert.ok(createWins > 0, `No create-before-remove outcomes observed (count ${createWins})`);
      assert.ok(removeWins > 0, `No remove-before-create outcomes observed (count ${removeWins})`);
      assert.equal(createWins + removeWins, 100);
    });
  },
};

if (import.meta.main) runStandalone(scenario);
