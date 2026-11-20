import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { makeId } from '../../src/platform/http/request.js';
import { readConfig } from '../../src/platform/config.js';
import { RedisStore } from '../../src/redis/client.js';
import { createTask, removeMember } from '../../src/redis/functions.js';
import { UnassignWorker } from '../../src/worker/unassign-worker.js';
import { connected, integrationStore, redisProxy } from '../support/redis.js';

let maint: RedisStore;
let app: RedisStore;
let workerStore: RedisStore;

beforeAll(async () => {
  [maint, app, workerStore] = await Promise.all([
    connected(), connected(integrationStore('api')), connected(integrationStore('worker')),
  ]);
});

afterAll(() => {
  for (const store of [maint, app, workerStore]) store?.close();
});

async function fixture(taskCount = 0) {
  const id = randomUUID();
  const actorId = makeId('usr');
  const userId = makeId('usr');
  const workspaceId = makeId('ws');
  const projectId = makeId('prj');
  const { keys } = app;
  await maint.client.multi()
    .json.set(keys.workspace(workspaceId), '$', { id: workspaceId, ownerId: actorId, version: 1 })
    .json.set(keys.project(projectId), '$', { id: projectId, key: 'WRK', workspaceId, archivedAt: null })
    .hSet(keys.workspaceMembers(workspaceId), { [actorId]: 'OWNER', [userId]: 'MEMBER' })
    .sAdd(keys.userWorkspaces(userId), workspaceId)
    .exec();
  const taskIds: string[] = [];
  for (let index = 0; index < taskCount; index++) {
    const taskId = makeId('tsk');
    const reply = await createTask(app, {
      workspaceId, projectId, actorId, taskId, assigneeId: userId,
      nowMs: Date.now(), requestId: makeId('req'), clientMutationId: makeId('mut'),
      idempotencyKey: `${id}-${index}`, payload: { title: `Worker fixture ${index}` },
    });
    if (!reply.ok) throw new Error(`Could not create worker fixture: ${reply.code}`);
    taskIds.push(taskId);
  }
  return { id, actorId, userId, workspaceId, projectId, taskIds };
}

async function removeMemberAndFindEvent(f: Awaited<ReturnType<typeof fixture>>) {
  const result = await removeMember(app, {
    workspaceId: f.workspaceId, actorId: f.actorId, userId: f.userId,
    idempotencyKey: `remove-${f.id}`, nowMs: Date.now(), requestId: makeId('req'),
  });
  if (!result.ok || !result.seq) throw new Error('Could not remove worker fixture member');
  const events = await maint.client.xRange(app.keys.domainEvents(), '-', '+') ?? [];
  const event = events.find((entry) => entry.message.eventId === `${f.workspaceId}:${result.seq}`);
  if (!event) throw new Error('Membership event was not written');
  return { event, stream: app.keys.domainEvents(), jobId: `unassign-${f.workspaceId}-${result.seq}` };
}

async function leavePending(eventId: string, consumer: string) {
  const stream = app.keys.domainEvents();
  try {
    await workerStore.client.xGroupCreate(stream, 'unassign', '0-0', { MKSTREAM: true });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('BUSYGROUP')) throw error;
  }
  const delivered = await maint.client.xClaim(stream, 'unassign', consumer, 0, eventId, { FORCE: true });
  expect(delivered).toContainEqual(expect.objectContaining({ id: eventId }));
}

it('reclaims an event left pending before persist and completes it through worker ACL', async () => {
  const f = await fixture();
  const { event, jobId, stream } = await removeMemberAndFindEvent(f);
  const consumer = `crashed-${randomUUID()}`;
  const run = new UnassignWorker(workerStore, readConfig('worker'), { blockMs: 30, claimIdleMs: 0, trimIntervalMs: 60_000 });
  try {
    await leavePending(event.id, consumer);
    const pending = await workerStore.client.xPendingRange(stream, 'unassign', event.id, event.id, 1);
    expect(pending).toHaveLength(1);

    await run.start();
    await vi.waitFor(async () => {
      expect(await maint.client.json.get(app.keys.unassignJob(jobId))).toMatchObject({ status: 'DONE' });
      expect(await maint.client.xPendingRange(stream, 'unassign', event.id, event.id, 1)).toHaveLength(0);
    }, { timeout: 5000 });
    await run.stop();
  } finally {
    await run.stop();
    await maint.client.xDel(stream, event.id);
  }
});

it('replays an already persisted job when the source event remains pending before ACK', async () => {
  const f = await fixture();
  const { event, jobId, stream } = await removeMemberAndFindEvent(f);
  const consumer = `persisted-crash-${randomUUID()}`;
  const jobKeys = [workerStore.keys.unassignJob(jobId), workerStore.keys.unassignJobsByDue()];
  const run = new UnassignWorker(workerStore, readConfig('worker'), { blockMs: 30, claimIdleMs: 0, trimIntervalMs: 60_000 });
  try {
    await leavePending(event.id, consumer);
    expect(await workerStore.call('sh_persist_unassign_job', jobKeys,
      [jobId, f.workspaceId, f.userId, event.message.eventId])).toMatchObject({ ok: true });
    expect(await workerStore.client.xPendingRange(stream, 'unassign', event.id, event.id, 1)).toHaveLength(1);

    await run.start();
    await vi.waitFor(async () => {
      expect(await maint.client.json.get(workerStore.keys.unassignJob(jobId))).toMatchObject({ status: 'DONE' });
      expect(await maint.client.xPendingRange(stream, 'unassign', event.id, event.id, 1)).toHaveLength(0);
    }, { timeout: 5000 });
    await run.stop();
  } finally {
    await run.stop();
    await maint.client.xDel(stream, event.id);
    await maint.client.del(workerStore.keys.unassignJob(jobId));
    await maint.client.zRem(workerStore.keys.unassignJobsByDue(), jobId);
  }
});

it('resumes a multi-page job after a lost batch reply', async () => {
  const f = await fixture(205);
  const { event, jobId, stream } = await removeMemberAndFindEvent(f);
  const proxy = await redisProxy(workerStore.config.redisUrl);
  const proxiedStore = new RedisStore({ ...workerStore.config, redisUrl: proxy.url });
  const firstRun = new UnassignWorker(proxiedStore, proxiedStore.config, { blockMs: 30, claimIdleMs: 0, trimIntervalMs: 60_000 });
  let secondRun: UnassignWorker | undefined;
  const { keys } = app;
  try {
    await connected(proxiedStore);
    proxy.trap('sh_run_unassign_batch');
    await firstRun.start();
    await vi.waitFor(() => expect(proxy.count).toBeGreaterThan(0), { timeout: 7000 });
    await firstRun.stop();
    const remaining = await maint.client.sCard(keys.userAssigned(f.userId));
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThan(205);

    await maint.client.del(keys.unassignLock(f.workspaceId, f.userId));
    await maint.client.zAdd(keys.unassignJobsByDue(), { score: Date.now(), value: jobId });
    proxiedStore.close();
    await proxy.close();

    secondRun = new UnassignWorker(workerStore, readConfig('worker'), { blockMs: 30, claimIdleMs: 0, trimIntervalMs: 60_000 });
    await secondRun.start();
    await vi.waitFor(async () => {
      expect(await maint.client.json.get(keys.unassignJob(jobId))).toMatchObject({ status: 'DONE' });
      expect(await maint.client.sCard(keys.userAssigned(f.userId))).toBe(0);
    }, { timeout: 12_000 });
    const versions = await Promise.all(f.taskIds.map(async (taskId) => {
      const task = await maint.client.json.get(keys.task(taskId)) as { version: number };
      return task.version;
    }));
    expect(new Set(versions)).toEqual(new Set([2]));
    expect(await maint.client.xPendingRange(stream, 'unassign', event.id, event.id, 1)).toHaveLength(0);
  } finally {
    await firstRun.stop();
    await secondRun?.stop();
    proxiedStore.close();
    await proxy.close().catch(() => undefined);
    await maint.client.xDel(stream, event.id);
  }
});

it('dead letters malformed membership events on delivery four and trims only fully acknowledged entries', async () => {
  // The private stream lets this test insert old IDs and add a second group
  // while preserving the domain stream used by the other integration tests.
  const config = { ...maint.config, role: 'worker' as const, prefix: `${maint.keys.prefix}retention-${randomUUID()}:` };
  const store = await connected(new RedisStore(config));
  const { keys, client } = store;
  const stream = keys.domainEvents();
  const workspaceId = makeId('ws');
  const runner = new UnassignWorker(store, config, { blockMs: 30, claimIdleMs: 250, trimIntervalMs: 10 });
  const oldEntries: string[] = [];
  let badId: string | undefined;
  try {
    const now = Date.now();
    for (let index = 0; index < 200; index++) {
      oldEntries.push(await client.xAdd(stream, `${now - 8 * 24 * 60 * 60 * 1000 + index}-0`, {
        type: 'IGNORED',
      }));
    }
    badId = await client.xAdd(stream, '*', {
      eventId: `${workspaceId}:202`, type: 'MEMBER_REMOVED', workspaceId, seq: '202', payload: '{bad-json',
    });
    await client.xGroupCreate(stream, 'trim-check', '0-0');
    const held = await client.xReadGroup('trim-check', 'fixture', [{ key: stream, id: '>' }], { COUNT: 500 });
    const heldIds = ((held ?? []) as Array<{ messages: { id: string }[] }>)
      .flatMap((group) => group.messages.map((message) => message.id));
    const marker = keys.unassignDeadLetterMarker(badId);
    await runner.start();
    await vi.waitFor(async () => {
      const [pending] = await client.xPendingRange(stream, 'unassign', badId!, badId!, 1);
      expect(pending?.deliveriesCounter).toBe(3);
      expect(await client.exists(marker)).toBe(0);
    }, { timeout: 7000, interval: 25 });
    await vi.waitFor(async () => {
      expect(await client.exists(marker)).toBe(1);
      expect(await client.xPendingRange(stream, 'unassign', badId!, badId!, 1)).toHaveLength(0);
    }, { timeout: 7000 });
    expect(await client.xLen(keys.deadLetter())).toBe(1);
    expect(await client.xRange(stream, oldEntries[0], oldEntries[0])).toHaveLength(1);
    await client.xAck(stream, 'trim-check', heldIds);
    await vi.waitFor(async () => expect(await client.xRange(stream, oldEntries[0], oldEntries.at(-1)!)).toHaveLength(0), { timeout: 7000 });
  } finally {
    await runner.stop();
    await client.del([stream, keys.deadLetter(), ...(badId ? [keys.unassignDeadLetterMarker(badId)] : [])]);
    store.close();
  }
});
