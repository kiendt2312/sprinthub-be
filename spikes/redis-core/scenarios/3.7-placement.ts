import assert from "node:assert/strict";
import { createTask, moveTask } from "../src/functions.js";
import {
  accepted, events, rejected, runStandalone, taskDocument, unchanged, withClients,
  type Client, type Scenario,
} from "./lib.js";

const STEP = 1024;
const MAX_SCORE = 2 ** 50;
const LIMIT = 500;

async function order(client: Client, board: string) {
  return client.zRange(board, 0, -1);
}

async function scores(client: Client, board: string) {
  return (await client.zRangeWithScores(board, 0, -1)).map(row => row.score);
}

function assertIntegerScores(values: number[]) {
  assert(values.every(value => Number.isSafeInteger(value) && Math.abs(value) <= MAX_SCORE), `Invalid scores: ${values}`);
}

export const scenario: Scenario = {
  id: "3.7",
  name: "Sparse placement, rebalance, and column limit",
  async run({ client, keys, fixture, check }) {
    let f = await fixture();
    let board = keys.board(f.projectId, "TODO");
    let inProgress = keys.board(f.projectId, "IN_PROGRESS");
    const create = async (title: string) => accepted(await createTask(client, f.createInput({ payload: { title } }), keys)).data as { id: string };
    const createTaskId = async (title: string) => (await create(title)).id;
    const move = async (taskId: string, from: string, overrides: Parameters<typeof f.moveInput>[1] = {}) =>
      moveTask(client, f.moveInput(taskId, { from, to: "TODO", ...overrides }), keys);

    async function newFixture() {
      f = await fixture();
      board = keys.board(f.projectId, "TODO");
      inProgress = keys.board(f.projectId, "IN_PROGRESS");
    }

    async function stageInProgress(title: string) {
      const id = await createTaskId(title);
      await client.multi()
        .zRem(board, id)
        .json.set(keys.task(id), "$.status", "IN_PROGRESS")
        .zAdd(inProgress, { score: STEP, value: id })
        .exec();
      return id;
    }

    await check("empty, end, head, and middle insertion use sparse integer scores", async () => {
      const first = await createTaskId("empty column");
      assert.equal(await client.zScore(board, first), STEP);
      const second = await createTaskId("end insertion");
      assert.equal(await client.zScore(board, second), STEP * 2);
      // Create a deliberate gap so the following placements exercise the documented values.
      await client.zAdd(board, { score: STEP * 3, value: second });
      const end = await createTaskId("sparse end");
      assert.equal(await client.zScore(board, end), STEP * 4);

      const head = await stageInProgress("head mover");
      accepted(await move(head, "IN_PROGRESS", { beforeTaskId: first }));
      assert.equal(await client.zScore(board, head), 0);

      const middle = await stageInProgress("middle mover");
      accepted(await move(middle, "IN_PROGRESS", { afterTaskId: first, beforeTaskId: second }));
      assert.equal(await client.zScore(board, middle), STEP * 2);
      assert.deepEqual(await order(client, board), [head, first, middle, second, end]);
      assertIntegerScores(await scores(client, board));
      for (const id of [first, second, end, head, middle]) {
        assert.equal(Object.hasOwn(await taskDocument(client, keys, id), "position"), false);
      }
    });

    await check("adjacent scores 1024 and 1025 trigger one rebalance and one sequenced event", async () => {
      await newFixture();
      const upper = await createTaskId("upper anchor");
      const lower = await createTaskId("lower anchor");
      const mover = await stageInProgress("adjacent-score mover");
      await client.zAdd(board, { score: STEP + 1, value: lower });
      assert.deepEqual(await scores(client, board), [1024, 1025]);

      const peers = await Promise.all([upper, lower].map(id => taskDocument(client, keys, id)));
      const before = (await events(client, keys, f.workspaceId)).length;
      const reply = accepted(await move(mover, "IN_PROGRESS", { afterTaskId: upper, beforeTaskId: lower }));
      assert.deepEqual(await order(client, board), [upper, mover, lower]);
      assert.deepEqual(await scores(client, board), [1024, 1536, 2048]);
      assert.deepEqual(await Promise.all([upper, lower].map(id => taskDocument(client, keys, id))), peers);
      assert.equal((await taskDocument(client, keys, mover)).version, 2);

      const emitted = (await events(client, keys, f.workspaceId)).slice(before);
      assert.equal(emitted.length, 1);
      assert.equal(emitted[0].type, "TASK_MOVED");
      assert.equal(emitted[0].taskId, mover);
      assert.equal(emitted[0].rebalancedColumn, "TODO");
      assert.equal(Number(emitted[0].seq), reply.seq);
      const changes = keys.workspaceChanges(f.workspaceId);
      assert.equal(await client.zScore(changes, `board:${f.projectId}:TODO`), reply.seq);
      assert.equal(await client.zScore(changes, `task:${mover}`), reply.seq);
    });

    await check("repeated narrowing preserves expected order and integer scores until rebalance", async () => {
      await newFixture();
      const anchor = await createTaskId("narrowing anchor");
      const lower = await createTaskId("narrowing lower");
      const expected = await order(client, board);
      const inserted: string[] = [];
      let rebalanceAt = 0;
      for (let i = 0; i < 11; i++) {
        const id = await stageInProgress(`narrowing ${i}`);
        const beforeEvents = (await events(client, keys, f.workspaceId)).length;
        const reply = accepted(await move(id, "IN_PROGRESS", {
          afterTaskId: inserted.at(-1) ?? anchor,
          beforeTaskId: lower,
          expectedVersion: 1,
        }));
        expected.splice(expected.indexOf(lower), 0, id);
        inserted.push(id);
        const actual = await order(client, board);
        assert.deepEqual(actual, expected);
        const currentScores = await scores(client, board);
        assertIntegerScores(currentScores);
        const eventRows = (await events(client, keys, f.workspaceId)).slice(beforeEvents);
        assert.equal(eventRows.length, 1);
        const event = eventRows[0]!;
        assert.equal(reply.seq, Number(event.seq));
        if (event.rebalancedColumn !== undefined) {
          assert.equal(event.rebalancedColumn, "TODO");
          assert.equal(await client.zScore(keys.workspaceChanges(f.workspaceId), `board:${f.projectId}:TODO`), reply.seq);
          rebalanceAt = i + 1;
          break;
        }
      }
      assert(rebalanceAt > 0, "Expected narrowing to trigger a rebalance within 11 insertions");
      console.log(`3.7 first rebalance after ${rebalanceAt} adjacent insertions`);
    });

    await check("create at score limit rebalances the complete column and emits one correlated event", async () => {
      await newFixture();
      const existing = await createTaskId("overflow setup");
      await client.zAdd(board, { score: MAX_SCORE, value: existing });
      const before = (await events(client, keys, f.workspaceId)).length;
      const newId = await createTaskId("overflow trigger");
      const eventRows = (await events(client, keys, f.workspaceId)).slice(before);
      assert.equal(eventRows.length, 1);
      assert.equal(eventRows[0]?.type, "TASK_CREATED");
      assert.equal(eventRows[0]?.rebalancedColumn, "TODO");
      assert.equal(await client.zScore(board, existing), STEP);
      assert.equal(await client.zScore(board, newId), STEP * 2);
      assertIntegerScores(await scores(client, board));
      assert.equal(await client.zScore(keys.workspaceChanges(f.workspaceId), `board:${f.projectId}:TODO`), Number(eventRows[0]?.seq));
    });

    await check("full 500 task reorder rebalances, preserves order, versions, peer documents, and one event", async () => {
      await newFixture();
      await stageInProgress("full-column move source");
      const ids: string[] = [];
      for (let i = 0; i < LIMIT; i++) ids.push(await createTaskId(`full board ${i}`));
      // Adjacent integer scores force rebalance at the chosen slot while keeping the board full.
      await client.zAdd(board, ids.map((value, index) => ({ score: index + 1, value })));
      const mover = ids[10]!;
      const desired = [...ids];
      desired.splice(10, 1);
      desired.splice(250, 0, mover);
      const peerDocs = new Map(await Promise.all(ids.filter(id => id !== mover).map(async id => [id, await taskDocument(client, keys, id)] as const)));
      const before = (await events(client, keys, f.workspaceId)).length;
      const started = performance.now();
      accepted(await moveTask(client, f.moveInput(mover, {
        from: "TODO", to: "TODO", afterTaskId: desired[249], beforeTaskId: desired[251], expectedVersion: 1,
      }), keys));
      const elapsedMs = performance.now() - started;
      console.log(`3.7 full-board 500-task reorder client FCALL elapsed: ${elapsedMs.toFixed(3)} ms`);
      assert.deepEqual(await order(client, board), desired);
      const resultingScores = await scores(client, board);
      assertIntegerScores(resultingScores);
      assert(resultingScores.filter((_score, index) => index !== 250).every(score => score % STEP === 0));
      assert.equal((await taskDocument(client, keys, mover)).version, 2);
      for (const [id, beforeDoc] of peerDocs) assert.deepEqual(await taskDocument(client, keys, id), beforeDoc, `Peer changed: ${id}`);
      const emitted = (await events(client, keys, f.workspaceId)).slice(before);
      assert.equal(emitted.length, 1);
      assert.equal(emitted[0]?.type, "TASK_MOVED");
      assert.equal(emitted[0]?.rebalancedColumn, "TODO");
      assert.equal(await client.zScore(keys.workspaceChanges(f.workspaceId), `board:${f.projectId}:TODO`), Number(emitted[0]?.seq));
    });

    await check("create and cross-column move into a full column reject without changing any key", async () => {
      await unchanged(client, keys, async () => {
        rejected(await createTask(client, f.createInput(), keys), "COLUMN_FULL", { limit: LIMIT });
      });

      const [source] = await order(client, inProgress);
      assert(source, "Expected a cross-column mover");
      await unchanged(client, keys, async () => {
        rejected(await move(source, "IN_PROGRESS"), "COLUMN_FULL", { limit: LIMIT });
      });
    });

    await check("499 task race on two connected clients admits exactly one create", async () => {
      await newFixture();
      for (let i = 0; i < LIMIT - 1; i++) await createTaskId(`race fill ${i}`);
      assert.equal(await client.zCard(board), LIMIT - 1);
      await withClients(2, async ([a, b]) => {
        const inputs = [f.createInput({ payload: { title: "last slot A" } }), f.createInput({ payload: { title: "last slot B" } })];
        const results = await Promise.all([createTask(a, inputs[0], keys), createTask(b, inputs[1], keys)]);
        assert.equal(results.filter(reply => reply.ok).length, 1);
        const loserIndex = results.findIndex(reply => !reply.ok);
        rejected(results[loserIndex], "COLUMN_FULL", { limit: LIMIT });
        const loser = inputs[loserIndex];
        assert.equal(await client.exists([
          keys.task(loser.taskId), keys.idempotency(loser.actorId, loser.idempotencyKey),
        ]), 0);
        assert.equal(await client.zCard(board), LIMIT);
        assert.equal(await client.get(keys.projectTaskSeq(f.projectId)), String(LIMIT));
        assert.equal(await client.get(keys.workspaceSeq(f.workspaceId)), String(LIMIT));
        const stream = await events(client, keys, f.workspaceId);
        assert.equal(stream.length, LIMIT);
        assert(!stream.some(event => event.taskId === loser.taskId));
      });
    });
  },
};

if (import.meta.main) runStandalone(scenario);
