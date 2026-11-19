import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRedisClient } from "../src/client.js";
import { createTask, moveTask } from "../src/functions.js";
import { createKeys } from "../src/keys.js";
import { accepted, assertFindings, createFixture, events, scopedKeys, taskDocument, type Client } from "./lib.js";
import { docker, getSpikeContainerId, waitForRedis } from "./persistence-docker.js";

const SCORE_STEP = 1024;

async function snapshot(client: Client, keys: ReturnType<typeof createKeys>, boardKey: string,
  workspaceSeqKey: string, idempotencyKeys: string[]) {
  const names = await scopedKeys(client, keys);
  const data = Object.fromEntries(await Promise.all(names.map(async key => {
    const [type, expiresAt] = await Promise.all([client.type(key), client.pExpireTime(key)]);
    let value: unknown;
    switch (type) {
      case "string":
        value = await client.get(key);
        break;
      case "hash":
        value = await client.hGetAll(key);
        break;
      case "set":
        value = (await client.sMembers(key)).sort();
        break;
      case "zset":
        value = (await client.zRangeWithScores(key, 0, -1)).map(({ value: member, score }) => ({ member, score }));
        break;
      case "stream":
        value = await client.xRange(key, "-", "+");
        break;
      case "ReJSON-RL":
        value = await client.json.get(key);
        break;
      default:
        assert.fail(`Unsupported Redis type ${type} for ${key}`);
    }
    return [key, { type, value, expiresAt }] as const;
  })));
  const boardOrderAndScores = (await client.zRangeWithScores(boardKey, 0, -1))
    .map(({ value, score }) => ({ taskId: value, score }));
  const idempotency = await Promise.all(idempotencyKeys.map(async key => {
    const [value, expiresAt] = await Promise.all([client.get(key), client.pExpireTime(key)]);
    return { key, value, expiresAt };
  }));
  const [library] = await client.functionListWithCode({ LIBRARYNAME: "sprinthub" });
  assert.equal(library?.library_name, "sprinthub", "Missing Function library");

  return {
    library: { ...library, functions: [...library.functions].sort((a, b) => a.name.localeCompare(b.name)) },
    data,
    boardOrderAndScores,
    workspaceSeq: await client.get(workspaceSeqKey),
    idempotency,
  };
}

async function close(client: Client) {
  if (client.isOpen) await client.close();
}

async function cleanup(client: Client, keys: ReturnType<typeof createKeys>) {
  const names = await scopedKeys(client, keys);
  return names.length ? client.unlink(names) : 0;
}

async function main() {
  const started = performance.now();
  const containerId = await getSpikeContainerId();
  const keys = createKeys(`sh:spike-restart:${randomUUID()}:`);
  const client = createRedisClient();
  let afterClient: Client | undefined;
  let cleanupComplete = false;

  try {
    await client.connect();
    const { workspaceId, projectId, ownerId, createInput, moveInput } = await createFixture(client, keys);
    const inputs = [createInput(), createInput(), createInput()];
    for (const input of inputs) accepted(await createTask(client, input, keys));
    const [firstId, secondId, moverId] = inputs.map(input => input.taskId);
    const initialMove = moveInput(moverId);
    accepted(await moveTask(client, initialMove, keys));
    const rebalanceMove = moveInput(moverId, {
      from: "IN_PROGRESS", to: "TODO", afterTaskId: firstId, beforeTaskId: secondId, expectedVersion: 2,
    });
    const idempotencyKeys = [...inputs, initialMove, rebalanceMove]
      .map(input => keys.idempotency(ownerId, input.idempotencyKey));
    const boardKey = keys.board(projectId, "TODO");
    const workspaceSeqKey = keys.workspaceSeq(workspaceId);
    await client.zAdd(boardKey, { value: secondId, score: SCORE_STEP + 1 });
    const rebalanceReply = accepted(await moveTask(client, rebalanceMove, keys));

    await assertFindings(client, keys, []);
    const postMoveEvents = await events(client, keys, workspaceId);
    assert(postMoveEvents.some(event => event.type === "TASK_MOVED" && event.taskId === moverId &&
      event.rebalancedColumn === "TODO" && Number(event.seq) === rebalanceReply.seq),
    "Expected the prepared mutation to rebalance TODO");
    assert.deepEqual(await client.zRangeWithScores(boardKey, 0, -1), [
      { value: firstId, score: SCORE_STEP },
      { value: moverId, score: SCORE_STEP + SCORE_STEP / 2 },
      { value: secondId, score: SCORE_STEP * 2 },
    ]);
    assert.equal((await taskDocument(client, keys, moverId)).status, "TODO");

    const before = await snapshot(client, keys, boardKey, workspaceSeqKey, idempotencyKeys);
    assert.equal(before.workspaceSeq, "5");
    assert(before.idempotency.every(record => record.value !== null && record.expiresAt > Date.now()),
      "Expected all five idempotency records to be live before restart");
    console.log(`4.1 prepared snapshot: ${Object.keys(before.data).length} Redis keys, ` +
      `${before.boardOrderAndScores.length} ordered TODO tasks, workspace seq ${before.workspaceSeq}`);
    const appendFsyncBefore = await client.configGet("appendfsync");

    await close(client);
    const restartStarted = performance.now();
    await docker("restart", containerId);
    await waitForRedis();
    const restartAndPongMs = performance.now() - restartStarted;

    afterClient = createRedisClient();
    await afterClient.connect();
    const after = await snapshot(afterClient, keys, boardKey, workspaceSeqKey, idempotencyKeys);
    assert.deepEqual(after, before, "Persistent Redis state changed across container restart");
    await assertFindings(afterClient, keys, []);
    const appendFsyncAfter = await afterClient.configGet("appendfsync");
    assert.deepEqual(appendFsyncAfter, appendFsyncBefore, "appendfsync changed across restart");

    const cleanedKeys = await cleanup(afterClient, keys);
    cleanupComplete = true;

    console.log("4.1 docker restart persistence: PASS");
    console.log(`  Container: ${containerId}`);
    console.log(`  Restart + PONG: ${restartAndPongMs.toFixed(1)} ms`);
    console.log(`  Function library and source unchanged: ${after.library.library_name}`);
    console.log(`  Board order and scores: ${JSON.stringify(after.boardOrderAndScores)}`);
    console.log(`  Workspace seq: ${after.workspaceSeq}`);
    console.log(`  Idempotency values and absolute expiries unchanged: ${after.idempotency.length}`);
    console.log(`  appendfsync: ${appendFsyncBefore.appendfsync} (before and after)`);
    console.log("  Offline task index verifier: clean before and after restart");
    console.log(`  Isolated fixture keys cleaned: ${cleanedKeys}`);
    console.log(`  Total elapsed: ${(performance.now() - started).toFixed(1)} ms`);
  } finally {
    if (!cleanupComplete) {
      const cleanupClient = afterClient?.isOpen ? afterClient : client.isOpen ? client : undefined;
      if (cleanupClient) {
        try {
          await cleanup(cleanupClient, keys);
        } catch (error) {
          console.error("Could not clean isolated 4.1 fixture keys:", error);
        }
      }
    }
    await close(client);
    if (afterClient) await close(afterClient);
  }
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
