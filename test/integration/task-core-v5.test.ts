import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { verifyTaskIndexes } from '../../scripts/verify-task-indexes.js';
import { verifyProjectIndexes } from '../../scripts/verify-project-indexes.js';
import { scanByPrefix } from '../../scripts/index-scan.js';
import { makeId } from '../../src/platform/http/request.js';
import type { RedisStore } from '../../src/redis/client.js';
import { createTask, moveTask } from '../../src/redis/functions.js';
import { createKeys } from '../../src/redis/keys.js';
import type { FunctionReply } from '../../src/redis/reply.js';
import { connected, integrationStore } from '../support/redis.js';

let maint: RedisStore;
let app: RedisStore;
const prefix = 'sh:v1:core-v5-' + randomUUID() + ':';
const keys = createKeys(prefix);

beforeAll(async () => {
  maint = await connected();
  app = await connected(integrationStore());
});

afterAll(async () => {
  if (maint?.client.isReady) {
    const touched = await scanByPrefix(maint.client, prefix);
    if (touched.length) await maint.client.unlink(touched);
  }
  app?.close();
  maint?.close();
});

function metadata() {
  const idempotencyKey = randomUUID();
  return {
    idempotencyKey, hash: createHash('sha256').update(idempotencyKey).digest('hex'),
    nowMs: Date.now(), requestId: makeId('req'), clientMutationId: ulid(),
  };
}

function success(reply: FunctionReply) {
  if (!reply.ok) throw new Error(JSON.stringify(reply));
  return reply as typeof reply & { data: { id: string; key: string; number: number; version: number; assigneeId: string | null } };
}

async function fixture(key: string) {
  const workspaceId = makeId('ws');
  const projectId = makeId('prj');
  const actorId = makeId('usr');
  const member = makeId('usr');
  const now = Date.now();
  await maint.client.json.set(keys.workspace(workspaceId), '$', {
    id: workspaceId, name: 'Core V5', slug: workspaceId.toLowerCase().replace('_', '-'),
    ownerId: actorId, version: 1, createdAtMs: now, createdAt: new Date(now).toISOString(), suspendedAt: null, archivedAt: null,
  });
  await maint.client.hSet(keys.workspaceMembers(workspaceId), { [actorId]: 'OWNER', [member]: 'MEMBER' });
  const meta = metadata();
  success(await app.callWorkspace('sh_create_project', [
    keys.workspaceMembers(workspaceId), keys.workspace(workspaceId), keys.project(projectId),
    keys.workspaceProjects(workspaceId), keys.workspaceProjectsPage(workspaceId),
    keys.projectKey(workspaceId, key), keys.workspaceSeq(workspaceId), keys.workspaceChanges(workspaceId),
    keys.domainEvents(), keys.idempotency(actorId, meta.idempotencyKey),
  ], [workspaceId, projectId, actorId, key, 'Core V5 project', '', meta.idempotencyKey, meta.hash,
    String(meta.nowMs), meta.requestId, meta.clientMutationId]));
  return { workspaceId, projectId, actorId, member };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function creation(f: Fixture, title: string, assigneeId?: string) {
  return { ...f, ...metadata(), taskId: makeId('tsk'), workspaceGuard: true as const, assigneeId, payload: { title } };
}

function outbox(f: Fixture, idem: string) {
  return [keys.workspaceSeq(f.workspaceId), keys.workspaceChanges(f.workspaceId), keys.domainEvents(), keys.idempotency(f.actorId, idem)];
}

it('T-004 allocates 50 distinct issue numbers with 50 connections and writes every P0 index', async () => {
  const f = await fixture('RACE');
  const clients = Array.from({ length: 50 }, () => integrationStore());
  try {
    await Promise.all(clients.map((client) => connected(client)));
    const inputs = clients.map((_, index) => creation(f, 'Concurrent task ' + index, f.member));
    const rows = (await Promise.all(clients.map((client, index) => createTask(client, inputs[index]!, keys)))).map(success);
    expect(rows.map(({ data }) => data.number).sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, index) => index + 1));
    expect(await maint.client.get(keys.projectTaskSeq(f.projectId))).toBe('50');
    expect(await maint.client.zCard(keys.backlog(f.projectId))).toBe(50);
    expect(await maint.client.sCard(keys.userAssigned(f.member))).toBe(50);
    for (const { data } of rows) expect(await maint.client.hGet(keys.workspaceTaskKeys(f.workspaceId), data.key)).toBe(data.id);
    const replay = await createTask(app, { ...inputs[0]!, taskId: makeId('tsk') }, keys);
    expect(replay).toEqual(rows[0]);
    expect(await createTask(app, { ...inputs[0]!, payload: { title: 'Changed request' } }, keys))
      .toMatchObject({ ok: false, code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await verifyTaskIndexes(maint.client, keys)).toEqual({ ok: true, findings: [] });
    expect(await verifyProjectIndexes(maint.client, keys)).toEqual({ ok: true, findings: [] });
  } finally {
    clients.forEach(client => client.close());
  }
}, 20_000);

it('keeps invariants through 100 concurrent move versus assignment conflicts', async () => {
  const f = await fixture('LANE');
  const other = await connected(integrationStore());
  const outcomes = new Set<string>();
  try {
    for (let i = 0; i < 100; i++) {
      const { data: task } = success(await createTask(app, creation(f, 'Concurrent move/assign ' + i), keys));
      const meta = metadata();
      const move = () => moveTask(app, {
        ...f, ...metadata(), workspaceGuard: true, taskId: task.id, from: 'TODO', to: 'IN_PROGRESS', expectedVersion: task.version,
      }, keys);
      const assign = () => other.callWorkspace('sh_assign_task', [
        keys.workspaceMembers(f.workspaceId), keys.workspace(f.workspaceId), keys.project(f.projectId), keys.task(task.id),
        keys.userAssigned(), keys.userAssigned(f.member), ...outbox(f, meta.idempotencyKey),
      ], [f.workspaceId, f.projectId, task.id, f.actorId, '', f.member, String(task.version),
        JSON.stringify({ assigneeId: f.member }), meta.idempotencyKey, meta.hash, String(meta.nowMs), meta.requestId, meta.clientMutationId]);
      const [a, b] = await Promise.all(i % 2 ? [move(), assign()] : [assign(), move()]);
      expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
      expect(a.ok ? b : a).toMatchObject({ ok: false, code: 'TASK_VERSION_CONFLICT', params: { currentVersion: task.version + 1 } });
      const doc = await maint.client.json.get(keys.task(task.id)) as { version: number; status: string; assigneeId: string | null };
      expect(doc.version).toBe(2);
      outcomes.add(doc.status);
    }
    expect(outcomes.has('TODO') || outcomes.has('IN_PROGRESS')).toBe(true);
    expect(await verifyTaskIndexes(maint.client, keys)).toEqual({ ok: true, findings: [] });
  } finally {
    other.close();
  }
}, 25_000);

it('keeps the 500-card cap, rebalances a full column once, and measures v5 server time', async () => {
  const f = await fixture('FULL');
  const other = await connected(integrationStore());
  const client = maint.client;
  const prior = await client.configGet('slowlog-*');
  const longDescription = '🔥'.repeat(20_000);
  const made = [];
  try {
    for (let i = 0; i < 499; i++) {
      const input = creation(f, 'Cap test task ' + i);
      if (i === 0 || i === 2) {
        made.push(success(await createTask(app, { ...input, payload: { ...input.payload, description: longDescription } }, keys)).data);
      } else {
        made.push(success(await createTask(app, input, keys)).data);
      }
    }
    await client.configSet({ 'slowlog-log-slower-than': '0', 'slowlog-max-len': '4096' });
    await client.sendCommand(['SLOWLOG', 'RESET']);
    const race = await Promise.all([
      createTask(app, creation(f, 'Slot 500 from app'), keys),
      createTask(other, creation(f, 'Slot 500 from other app'), keys),
    ]);
    expect(race.filter((result) => result.ok)).toHaveLength(1);
    expect(race.find((result) => !result.ok)).toMatchObject({ code: 'COLUMN_FULL', params: { limit: 500 } });
    const added = success(race.find((result) => result.ok)!);
    expect(await client.zCard(keys.board(f.projectId, 'TODO'))).toBe(500);
    expect(await createTask(app, creation(f, 'Over limit'), keys)).toMatchObject({ ok: false, code: 'COLUMN_FULL' });

    const [first, second, moving] = made;
    const column = keys.board(f.projectId, 'TODO');
    await client.zAdd(column, [{ value: first!.id, score: 1024 }, { value: second!.id, score: 1025 }]);
    const reorder = {
      ...f, ...metadata(), workspaceGuard: true as const, taskId: moving!.id, from: 'TODO', to: 'TODO',
      afterTaskId: first!.id, beforeTaskId: second!.id, expectedVersion: 1,
    };
    const reordered = success(await moveTask(app, reorder, keys));
    expect(reordered.rebalancedColumn).toBe('TODO');
    expect(await moveTask(app, reorder, keys)).toEqual(reordered);
    expect(reordered.data.version).toBe(2);
    expect(await client.zRange(column, 0, 2)).toEqual([first!.id, moving!.id, second!.id]);
    expect(await client.json.get(keys.task(second!.id), { path: '$.version' })).toEqual([1]);
    const events = (await client.xRange(keys.domainEvents(), '-', '+') ?? []).filter(({ message }) =>
      message.workspaceId === f.workspaceId && message.rebalancedColumn === 'TODO');
    expect(events).toHaveLength(1);
    expect(events[0]!.message).toMatchObject({ type: 'TASK_MOVED', seq: String(reordered.seq) });
    expect(await client.zScore(keys.workspaceChanges(f.workspaceId), 'board:' + f.projectId + ':TODO')).toBe(reordered.seq);

    const moved = success(await moveTask(app, { ...f, ...metadata(), workspaceGuard: true, taskId: added.data.id,
      from: 'TODO', to: 'IN_PROGRESS', expectedVersion: 1 }, keys));
    success(await createTask(app, creation(f, 'Refill the last slot'), keys));
    expect(await moveTask(app, { ...f, ...metadata(), workspaceGuard: true, taskId: added.data.id,
      from: 'IN_PROGRESS', to: 'TODO', expectedVersion: moved.data.version }, keys)).toMatchObject({ code: 'COLUMN_FULL' });
    const slowlog = await client.sendCommand(['SLOWLOG', 'GET', '4096']) as [number, number, number, string[]][];
    const timings = slowlog.filter(([, , , [command, fn, , firstKey]]) => command?.toUpperCase() === 'FCALL'
      && (fn === 'sh_create_task' || fn === 'sh_move_task') && firstKey === keys.workspaceMembers(f.workspaceId))
      .map(([, , microseconds, [, functionName]]) => ({ microseconds, functionName }));
    expect(timings.length).toBeGreaterThanOrEqual(8);
    const slowest = timings.reduce((max, sample) => sample.microseconds > max.microseconds ? sample : max);
    process.stdout.write(`P0 v5 task SLOWLOG max ${slowest.microseconds} µs (${slowest.functionName}) on the 500-card workload\n`);
    expect(slowest.microseconds).toBeLessThan(5_000);
    expect(await verifyTaskIndexes(client, keys)).toEqual({ ok: true, findings: [] });
  } finally {
    await client.configSet(prior);
    other.close();
  }
}, 35_000);

it('T-020 reports malformed task and project indexes in a fixture without scanning unrelated namespaces', async () => {
  const f = await fixture('VERIFY');
  const { data: task } = success(await createTask(app, creation(f, 'Verifier fixture', f.member), keys));
  const client = maint.client;
  expect(await verifyTaskIndexes(client, keys)).toEqual({ ok: true, findings: [] });
  expect(await verifyProjectIndexes(client, keys)).toEqual({ ok: true, findings: [] });
  const column = keys.board(f.projectId, 'TODO');
  const backlog = keys.backlog(f.projectId);
  const projects = keys.workspaceProjects(f.workspaceId);
  const page = keys.workspaceProjectsPage(f.workspaceId);
  const unique = keys.projectKey(f.workspaceId, 'VERIFY');
  const permalink = keys.workspaceTaskKeys(f.workspaceId);
  const wrongTask = makeId('tsk');
  const wrongProject = makeId('prj');
  try {
    await client.zRem(column, task.id);
    await client.zAdd(backlog, { value: task.id, score: 1.5 });
    await client.sRem(keys.userAssigned(f.member), task.id);
    await client.hSet(permalink, task.key, wrongTask);
    await client.sRem(projects, f.projectId);
    await client.zAdd(page, [{ value: f.projectId, score: 2 }, { value: wrongProject, score: 0 }]);
    await client.set(unique, wrongProject);
    expect(await verifyTaskIndexes(client, keys)).toMatchObject({ ok: false, findings: expect.arrayContaining([
      { type: 'missing', taskId: task.id, index: column },
      { type: 'bad-score', taskId: task.id, index: backlog, score: 1.5 },
      { type: 'missing', taskId: task.id, index: keys.userAssigned(f.member) },
      expect.objectContaining({ type: 'orphan', taskId: wrongTask, index: permalink }),
    ]) });
    expect(await verifyProjectIndexes(client, keys)).toMatchObject({ ok: false, findings: expect.arrayContaining([
      { type: 'missing', projectId: f.projectId, index: projects },
      { type: 'bad-score', projectId: f.projectId, index: page, actual: 2 },
      { type: 'orphan', projectId: wrongProject, index: page },
      { type: 'wrong-pointer', projectId: f.projectId, index: unique, actual: wrongProject },
    ]) });
  } finally {
    await client.zAdd(column, { value: task.id, score: 1024 });
    await client.zAdd(backlog, { value: task.id, score: task.number });
    await client.sAdd(keys.userAssigned(f.member), task.id);
    await client.hSet(permalink, task.key, task.id);
    await client.sAdd(projects, f.projectId);
    await client.zRem(page, wrongProject);
    await client.zAdd(page, { value: f.projectId, score: 0 });
    await client.set(unique, f.projectId);
  }
  expect(await verifyTaskIndexes(client, keys)).toEqual({ ok: true, findings: [] });
  expect(await verifyProjectIndexes(client, keys)).toEqual({ ok: true, findings: [] });
});
