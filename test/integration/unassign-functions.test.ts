import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { makeId } from '../../src/platform/http/request.js';
import type { RedisStore } from '../../src/redis/client.js';
import { createTask, removeMember } from '../../src/redis/functions.js';
import { createKeys } from '../../src/redis/keys.js';
import { connected, integrationStore } from '../support/redis.js';

let maint: RedisStore;
let app: RedisStore;
let worker: RedisStore;
let peer: RedisStore;

beforeAll(async () => {
  [maint, app, worker, peer] = await Promise.all([
    connected(), connected(integrationStore('api')),
    connected(integrationStore('worker')), connected(integrationStore('worker')),
  ]);
});

afterAll(() => {
  for (const store of [maint, app, worker, peer]) store?.close();
});

async function workspace(userId = makeId('usr')) {
  const actorId = makeId('usr');
  const workspaceId = makeId('ws');
  const projectId = makeId('prj');
  const { keys } = maint;
  await maint.client.multi()
    .json.set(keys.workspace(workspaceId), '$', { id: workspaceId, ownerId: actorId })
    .hSet(keys.workspaceMembers(workspaceId), { [actorId]: 'OWNER', [userId]: 'MEMBER' })
    .sAdd(keys.userWorkspaces(userId), workspaceId)
    .json.set(keys.project(projectId), '$', { workspaceId, id: projectId, key: 'UNE', archivedAt: null })
    .exec();
  return { actorId, workspaceId, userId, projectId };
}

type Workspace = Awaited<ReturnType<typeof workspace>>;

function mutation() {
  return { idempotencyKey: randomUUID(), nowMs: Date.now(), requestId: makeId('req') };
}

async function createFixtureTask(w: Workspace, assigneeId = w.userId, taskId = makeId('tsk')) {
  const result = await createTask(app, {
    ...w, ...mutation(), assigneeId, taskId,
    clientMutationId: makeId('mut'), payload: { title: 'Fixture', dueAtMs: 9_007_199_254_740_991 },
  });
  return { result, taskId };
}

function jobFor(w: Workspace, seq: number) {
  return { ...w, id: `unassign-${w.workspaceId}-${seq}`, eventId: `${w.workspaceId}:${seq}` };
}

type Job = ReturnType<typeof jobFor>;

async function remove(w: Workspace) {
  const result = await removeMember(app, { ...w, ...mutation() });
  if (!result.ok || !result.seq) throw new Error('Fixture removal failed');
  return jobFor(w, result.seq);
}

function persist(job: Job, caller = worker) {
  const { id, workspaceId, userId, eventId } = job;
  return caller.call('sh_persist_unassign_job',
    [caller.keys.unassignJob(id), caller.keys.unassignJobsByDue()], [id, workspaceId, userId, eventId]);
}

function jobScope(caller: RedisStore, job: Job) {
  const { keys } = caller;
  return [
    keys.unassignJob(job.id), keys.unassignJobsByDue(),
    keys.unassignLock(job.workspaceId, job.userId), keys.unassignFence(job.workspaceId, job.userId),
  ];
}

async function claim(job: Job, caller = worker) {
  const token = randomUUID();
  const reply = await caller.call('sh_claim_unassign_job', jobScope(caller, job),
    [job.id, job.workspaceId, job.userId, token]);
  if (!reply.ok) throw new Error(reply.code);
  return { token, data: reply.data as { epoch: number; cursor: string } | null };
}

function run(job: Job, token: string, epoch: number, tasks: string[], cursor = '0', nextCursor = '0') {
  const { keys } = worker;
  return worker.call('sh_run_unassign_batch', [
    ...jobScope(worker, job), keys.workspaceMembers(job.workspaceId), keys.userAssigned(job.userId),
    keys.workspaceSeq(job.workspaceId), keys.workspaceChanges(job.workspaceId), keys.domainEvents(),
    ...tasks.map(keys.task),
  ], [job.id, job.workspaceId, job.userId, token, String(epoch), cursor, nextCursor, ...tasks]);
}

it('checks the queue before persist and enqueues the job atomically with JSON.SET NX', async () => {
  const keys = createKeys(`${maint.keys.prefix}unassign-preflight:${randomUUID()}:`);
  const queue = keys.unassignJobsByDue();
  const job = jobFor(await workspace(), 1);
  try {
    await maint.client.set(queue, 'wrong type');
    await expect(maint.call('sh_persist_unassign_job', [keys.unassignJob(job.id), queue],
      [job.id, job.workspaceId, job.userId, job.eventId])).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(await maint.client.exists(keys.unassignJob(job.id))).toBe(0);
  } finally {
    await maint.client.del([queue, keys.unassignJob(job.id)]);
  }
});

it('T-007 removes only active tasks of the removed user in the job workspace', async () => {
  const local = await workspace();
  const foreign = await workspace(local.userId);
  const { taskId: localTask } = await createFixtureTask(local);
  const { taskId: foreignTask } = await createFixtureTask(foreign);
  const job = await remove(local);
  const { keys } = maint;
  const absent = await createFixtureTask(local);
  expect(absent.result).toMatchObject({ ok: false, code: 'ASSIGNEE_NOT_MEMBER' });

  await maint.client.json.set(keys.project(local.projectId), '$.archivedAt', '2026-11-20T00:00:00.000Z');
  await maint.client.json.del(keys.task(localTask), { path: '$.deletedAt' });
  const records = await Promise.all([persist(job), persist(job, peer)]);
  expect(records.map((entry) => entry.ok && entry.data).sort()).toEqual([false, true]);
  expect(await maint.client.zScore(keys.unassignJobsByDue(), job.id)).not.toBeNull();

  const { token, data } = await claim(job);
  expect(data).toEqual({ epoch: 1, cursor: '0' });
  expect(await run(job, token, 1, [localTask, foreignTask, localTask])).toMatchObject({
    ok: true, data: { done: true, cursor: '0' },
  });

  expect(await maint.client.json.get(keys.task(localTask))).toMatchObject({
    assigneeId: null, assigneeIndexValue: 'UNASSIGNED', version: 2, lastSeq: 3,
    dueAtMs: Number.MAX_SAFE_INTEGER,
  });
  expect(await maint.client.json.get(keys.task(foreignTask))).toMatchObject({ assigneeId: local.userId, version: 1 });
  expect(await maint.client.sMembers(keys.userAssigned(local.userId))).toEqual([foreignTask]);
  expect(await maint.client.get(keys.workspaceSeq(local.workspaceId))).toBe('3');
  expect(await maint.client.zScore(keys.workspaceChanges(local.workspaceId), 'task:' + localTask)).toBe(3);
  expect(await maint.client.zScore(keys.unassignJobsByDue(), job.id)).toBeNull();
  expect(await maint.client.exists(keys.unassignLock(local.workspaceId, local.userId))).toBe(0);
  expect(await persist(job)).toMatchObject({ ok: true, data: false });
  expect(await maint.client.zScore(keys.unassignJobsByDue(), job.id)).toBeNull();
});

it('T-010 fences a zombie and completes without touching a task after rejoin', async () => {
  const w = await workspace();
  const { taskId } = await createFixtureTask(w);
  const job = await remove(w);
  await persist(job);
  const { keys } = maint;
  const claims = await Promise.all([claim(job), claim(job, peer)]);
  expect(claims.filter(({ data }) => data !== null)).toHaveLength(1);
  const stale = claims.find(({ data }) => data !== null)!;
  const lock = keys.unassignLock(w.workspaceId, w.userId);
  await maint.client.pExpire(lock, 1);
  await expect.poll(() => maint.client.exists(lock)).toBe(0);

  const current = await claim(job, peer);
  expect(current.data).toEqual({ epoch: 2, cursor: '0' });
  expect(await run(job, stale.token, 1, [taskId])).toMatchObject({ ok: false, code: 'STALE_JOB_EPOCH' });
  expect(await run(job, current.token, 2, [taskId], '18')).toMatchObject({ ok: false, code: 'STALE_JOB_CURSOR' });
  expect(await maint.client.json.get(keys.task(taskId))).toMatchObject({ assigneeId: w.userId, version: 1 });

  await maint.client.hSet(keys.workspaceMembers(w.workspaceId), w.userId, 'MEMBER');
  expect(await run(job, current.token, 2, [taskId])).toMatchObject({ ok: true, data: { done: true } });
  expect(await maint.client.json.get(keys.task(taskId))).toMatchObject({ assigneeId: w.userId, version: 1 });
  expect(await maint.client.sIsMember(keys.userAssigned(w.userId), taskId)).toBe(1);
  expect(await maint.client.zScore(keys.unassignJobsByDue(), job.id)).toBeNull();
});

it('preflights every task before writing any part of a batch', async () => {
  const w = await workspace();
  const first = await createFixtureTask(w);
  const second = await createFixtureTask(w);
  const job = await remove(w);
  await persist(job);
  const { token } = await claim(job);
  const k = maint.keys;
  await maint.client.json.set(k.task(second.taskId), '$.version', Number.MAX_SAFE_INTEGER);
  await expect(run(job, token, 1, [first.taskId, second.taskId])).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  expect(await maint.client.json.get(k.task(first.taskId))).toMatchObject({ assigneeId: w.userId, version: 1 });
  expect(await maint.client.get(k.workspaceSeq(w.workspaceId))).toBe('3');
  expect(await maint.client.json.get(k.unassignJob(job.id))).toMatchObject({ cursor: '0', status: 'RUNNING' });
  expect(await maint.client.sCard(k.userAssigned(w.userId))).toBe(2);

  await maint.client.json.set(k.task(second.taskId), '$.version', 1);
  expect(await run(job, token, 1, [first.taskId, second.taskId])).toMatchObject({ ok: true, data: { done: true } });
});

it('processes a full batch within the 5 ms Redis Function budget', async () => {
  const w = await workspace();
  const taskIds: string[] = [];
  for (let i = 0; i < 100; i++) {
    const taskId = makeId('tsk');
    const reply = await createTask(app, {
      ...w, ...mutation(), taskId, assigneeId: w.userId,
      clientMutationId: makeId('mut'),
      payload: { title: 'Task with a full description', description: 'x'.repeat(20_000) },
    });
    expect(reply.ok).toBe(true);
    taskIds.push(taskId);
  }
  const job = await remove(w);
  await persist(job);
  const { token } = await claim(job);
  const { client, keys } = maint;
  const config = await client.configGet('slowlog-log-slower-than');
  try {
    await client.configSet({ 'slowlog-log-slower-than': '0' });
    expect(await run(job, token, 1, taskIds)).toMatchObject({ ok: true, data: { done: true } });
    const records = await client.sendCommand(['SLOWLOG', 'GET', '16']) as [number, number, number, string[]][];
    const duration = records.find(([, , , args]) =>
      args[1] === 'sh_run_unassign_batch' && args[3] === keys.unassignJob(job.id))?.[2];
    expect(duration).toBeTypeOf('number');
    expect(duration).toBeLessThan(5000);
    process.stdout.write(`P0 unassign SLOWLOG ${duration} µs at 100 tasks\n`);
  } finally {
    await client.configSet(config);
  }
  expect(await client.sCard(keys.userAssigned(w.userId))).toBe(0);
  expect(await client.get(keys.workspaceSeq(w.workspaceId))).toBe('201');
});

it('writes one dead-letter entry when the same source is retried concurrently', async () => {
  const { keys } = worker;
  const sourceId = await maint.client.xAdd(keys.domainEvents(), '*', {
    type: 'MEMBER_REMOVED', payload: '{malformed',
  });
  const marker = keys.unassignDeadLetterMarker(sourceId);
  const deadLetter = (caller: RedisStore) => caller.call('sh_dead_letter_unassign',
    [keys.domainEvents(), keys.deadLetter(), marker], [sourceId]);
  let entries: { id: string }[] = [];
  try {
    const results = await Promise.all([deadLetter(worker), deadLetter(peer)]);
    expect(results.map((result) => result.ok && result.data).sort()).toEqual([false, true]);
    entries = (await maint.client.xRange(keys.deadLetter(), '-', '+') ?? [])
      .filter(({ message }) => message.sourceId === sourceId);
    expect(entries).toHaveLength(1);
    expect(await maint.client.get(marker)).toBe('1');
  } finally {
    for (const entry of entries) await maint.client.xDel(keys.deadLetter(), entry.id);
    await maint.client.xDel(keys.domainEvents(), sourceId);
    await maint.client.del(marker);
  }
});
