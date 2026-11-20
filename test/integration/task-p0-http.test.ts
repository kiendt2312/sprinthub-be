import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ulid } from 'ulid';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { scanByPrefix } from '../../scripts/index-scan.js';
import { verifyTaskIndexes } from '../../scripts/verify-task-indexes.js';
import { createApi } from '../../src/api/app.js';
import { readConfig } from '../../src/platform/config.js';
import { RedisStore } from '../../src/redis/client.js';
import { createKeys } from '../../src/redis/keys.js';
import { UnassignWorker } from '../../src/worker/unassign-worker.js';
import { connected, redisProxy } from '../support/redis.js';

const prefix = 'sh:v1:task-p0-http-' + randomUUID() + ':';
const keys = createKeys(prefix);
const origin = 'http://127.0.0.1';
const jsonHeaders = { Origin: origin, 'X-CSRF-Protection': '1', 'Content-Type': 'application/json' };
const mutationHeaders = () => ({ 'Idempotency-Key': randomUUID(), 'X-Client-Mutation-Id': ulid() });

let app: NestExpressApplication;
let appUrl: string;
let maint: RedisStore;
let workerStore: RedisStore;
let worker: UnassignWorker;
let proxy: Awaited<ReturnType<typeof redisProxy>>;
type Actor = { id: string; cookie: string };
let owner: Actor;
let member: Actor;
let outsider: Actor;
let wid: string;

beforeAll(async () => {
  maint = await connected();
  const config = readConfig('api', { ...process.env, REDIS_KEY_PREFIX: prefix, AUTH_ORIGIN: origin, REDIS_TIMEOUT_MS: '350' });
  proxy = await redisProxy(maint.config.redisUrl);
  app = await createApi({ ...config, redisUrl: proxy.url });
  await app.listen(0, '127.0.0.1');
  appUrl = await app.getUrl();
  await vi.waitFor(async () => expect((await fetch(appUrl + '/health/ready')).status).toBe(200));
  owner = await account('Owner');
  member = await account('Member');
  outsider = await account('Other tenant');
  const workspace = await result<{ id: string }>(
    await mutation(owner, 'POST', '/workspaces', { name: 'Task P0 HTTP', slug: 'task-p0-http' }), 201);
  wid = workspace.data.id;
  await result(await mutation(outsider, 'POST', '/workspaces', { name: 'Other space', slug: 'other-space' }), 201);
  await result(await mutation(owner, 'POST', '/workspaces/' + wid + '/members', { userId: member.id }), 201);
  const workerConfig = readConfig('worker', { ...process.env, REDIS_KEY_PREFIX: prefix });
  workerStore = await connected(new RedisStore({ ...workerConfig, redisUrl: maint.config.redisUrl }));
  worker = new UnassignWorker(workerStore, workerStore.config, { blockMs: 50 });
  await worker.start();
}, 30_000);

afterAll(async () => {
  await worker?.stop();
  workerStore?.close();
  await app?.close();
  await proxy?.close();
  if (maint?.client.isReady) {
    const touched = await scanByPrefix(maint.client, prefix);
    if (touched.length) await maint.client.unlink(touched);
  }
  maint?.close();
});

interface Task {
  id: string;
  key: string;
  title: string;
  version: number;
  status: string;
  assigneeId: string | null;
  description: string;
  dueAtMs: number | null;
  deletedAt: string | null;
}
type MutationResponse<T> = { data: T; seq: number; requestId: string };

function request(method: string, path: string, actor?: Actor, body?: unknown, headers: Record<string, string> = {}) {
  return fetch(appUrl + '/api/v1' + path, {
    method, headers: { ...jsonHeaders, ...(actor ? { Cookie: actor.cookie } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function mutation(actor: Actor, method: string, path: string, body?: object, headers = mutationHeaders()) {
  return request(method, path, actor, body, headers);
}

async function account(label: string): Promise<Actor> {
  const email = randomUUID() + '@example.test';
  const password = 'Test fixture password only';
  expect((await request('POST', '/auth/register', undefined, { email, password, displayName: label })).status).toBe(202);
  const login = await request('POST', '/auth/login', undefined, { email, password });
  const { data } = await result<{ id: string }>(login, 200);
  return { id: data.id, cookie: login.headers.get('set-cookie')!.split(';')[0]! };
}

async function result<T>(response: Response, status = 200) {
  const body = await response.json() as MutationResponse<T>;
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body;
}

async function rejected(response: Response, status: number, code: string, params: object = {}) {
  const body: unknown = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(status);
  expect(body).toMatchObject({ error: { code, params }, requestId: expect.any(String) });
}

async function project(key: string) {
  return (await result<{ id: string; version: number }>(await mutation(owner, 'POST', '/workspaces/' + wid + '/projects',
    { key, name: key + ' project' }), 201)).data;
}

it('T-008 times out after Redis commits, then replays the same create once and rejects different payload as T-009', async () => {
  const { id: pid } = await project('REPLAY');
  const path = '/projects/' + pid + '/tasks';
  const headers = mutationHeaders();
  const payload = { title: 'Committed before proxy dropped the reply' };
  const commandCount = proxy.count;
  proxy.trap('sh_create_task');
  try {
    await rejected(await mutation(owner, 'POST', path, payload, headers), 503, 'MUTATION_OUTCOME_UNKNOWN');
    expect(proxy.count - commandCount).toBe(1);
    expect(await maint.client.get(keys.projectTaskSeq(pid))).toBe('1');
  } finally {
    proxy.trap('disabled-reply-trap');
    proxy.disconnect();
    await vi.waitFor(async () => expect((await fetch(appUrl + '/health/ready')).status).toBe(200), { timeout: 5000 });
  }
  const replay = await result<Task>(await mutation(owner, 'POST', path, payload, headers), 201);
  expect(replay.data).toMatchObject({ key: 'REPLAY-1', title: payload.title, version: 1 });
  expect(await maint.client.hGet(keys.workspaceTaskKeys(wid), 'REPLAY-1')).toBe(replay.data.id);
  await rejected(await mutation(owner, 'POST', path, { title: 'Different payload' }, headers), 422, 'IDEMPOTENCY_KEY_REUSED');
  const events = (await maint.client.xRange(keys.domainEvents(), '-', '+') ?? []).filter(({ message }) =>
    message.projectId === pid && message.type === 'TASK_CREATED');
  expect(events).toHaveLength(1);
  expect(events[0]!.message.seq).toBe(String(replay.seq));
  expect(await verifyTaskIndexes(maint.client, keys)).toEqual({ ok: true, findings: [] });
}, 10_000);

it('enforces T-003, T-005 and T-006 through the API and accepts 20,000 Unicode characters of Markdown', async () => {
  const { id: pid } = await project('FLOW');
  const list = '/projects/' + pid + '/tasks';
  const markdown = '📚'.repeat(20_000);
  const body = { title: 'Task for HTTP and ID problems', description: markdown, assigneeId: member.id, priority: 'URGENT' };
  const headers = mutationHeaders();
  const created = (await result<Task>(await mutation(owner, 'POST', list, body, headers), 201)).data;
  const detail = '/tasks/' + created.id;
  const permalink = '/workspaces/' + wid + '/tasks/by-key/' + created.key;
  const board = '/projects/' + pid + '/board';
  for (const path of [list, detail, permalink, board]) await rejected(await request('GET', path, outsider), 404, 'NOT_FOUND');
  await rejected(await mutation(outsider, 'POST', list, body, headers), 404, 'NOT_FOUND');
  for (const [method, path, data] of [
    ['PATCH', detail, { title: 'Forbidden title', expectedVersion: 1 }],
    ['PATCH', detail + '/move', { to: 'IN_PROGRESS', expectedVersion: 1 }],
    ['PATCH', detail + '/assignee', { assigneeId: null, expectedVersion: 1 }],
    ['DELETE', detail, { expectedVersion: 1 }],
  ] as const) await rejected(await mutation(outsider, method, path, data), 404, 'NOT_FOUND');
  expect((await result<Task>(await request('GET', permalink, member))).data.description).toBe(markdown);
  await rejected(await mutation(member, 'PATCH', detail, { expectedVersion: 1, description: markdown + 'x' }), 400, 'VALIDATION_FAILED');
  await rejected(await mutation(owner, 'PATCH', detail + '/assignee', { expectedVersion: 1, assigneeId: outsider.id }), 422, 'ASSIGNEE_NOT_MEMBER');
  await rejected(await mutation(member, 'DELETE', detail, { expectedVersion: 1 }), 403, 'FORBIDDEN');
  await rejected(await mutation(owner, 'PATCH', detail + '/move', { to: 'DONE', expectedVersion: 1 }), 422, 'INVALID_STATUS_TRANSITION');
  await rejected(await mutation(owner, 'PATCH', detail + '/move', { to: 'TODO', beforeTaskId: created.id, expectedVersion: 1 }), 422, 'INVALID_POSITION_ANCHOR');
  const race = await Promise.all([owner, member].map(actor =>
    mutation(actor, 'PATCH', detail + '/move', { to: 'IN_PROGRESS', expectedVersion: 1 })));
  expect(race.map(r => r.status).sort()).toEqual([200, 409]);
  await rejected(race.find(r => r.status === 409)!, 409, 'TASK_VERSION_CONFLICT', { currentVersion: 2 });
  const first = await result<Task>(race.find(r => r.status === 200)!);
  expect(first.data.status).toBe('IN_PROGRESS');
  const second = await result<Task>(await mutation(member, 'PATCH', detail + '/move',
    { to: 'IN_REVIEW', expectedVersion: first.data.version }));
  const next = await result<Task>(await mutation(member, 'PATCH', detail + '/move',
    { to: 'DONE', expectedVersion: second.data.version }));
  expect(next.data).toMatchObject({ status: 'DONE', version: 4, assigneeId: member.id });
  const editRace = await Promise.all([owner, member].map((actor, index) =>
    mutation(actor, 'PATCH', detail, { title: 'Title update ' + index, expectedVersion: 4, dueAtMs: Number.MAX_SAFE_INTEGER })));
  expect(editRace.map(r => r.status).sort()).toEqual([200, 409]);
  expect((await result<Task>(editRace.find(r => r.status === 200)!)).data).toMatchObject({
    assigneeId: member.id, dueAtMs: Number.MAX_SAFE_INTEGER, description: markdown, version: 5,
  });
  await rejected(editRace.find(r => r.status === 409)!, 409, 'TASK_VERSION_CONFLICT', { currentVersion: 5 });
  const deleteHeaders = mutationHeaders();
  const deleted = await result<Task>(await mutation(owner, 'DELETE', detail, { expectedVersion: 5 }, deleteHeaders));
  expect(deleted.data.deletedAt).toBeTypeOf('string');
  const duplicate = await result<Task>(await mutation(owner, 'DELETE', detail, { expectedVersion: 5 }, deleteHeaders));
  expect({ data: duplicate.data, seq: duplicate.seq }).toEqual({ data: deleted.data, seq: deleted.seq });
  for (const path of [detail, permalink]) await rejected(await request('GET', path, owner), 404, 'NOT_FOUND');
  const secondTask = await result<Task>(await mutation(owner, 'POST', list, { title: 'Keeps the issue sequence' }), 201);
  expect(secondTask.data.key).toBe('FLOW-2');
  expect(await verifyTaskIndexes(maint.client, keys)).toEqual({ ok: true, findings: [] });
}, 15_000);

it('keeps permalink, prior replay and worker cleanup available while archived, then allows writes after unarchive', async () => {
  const { id: pid, version } = await project('ARCH');
  const list = '/projects/' + pid + '/tasks';
  const createPayload = { title: 'Assigned task in archived project', assigneeId: member.id };
  const createHeaders = mutationHeaders();
  const original = await result<Task>(await mutation(owner, 'POST', list, createPayload, createHeaders), 201);
  const path = '/projects/' + pid;
  const detail = '/tasks/' + original.data.id;
  const permalink = '/workspaces/' + wid + '/tasks/by-key/' + original.data.key;
  const archived = await result<{ version: number; archivedAt: string }>(
    await mutation(owner, 'POST', path + '/archive', { expectedVersion: version }));
  expect(archived.data.archivedAt).toBeTypeOf('string');
  expect((await result<Task>(await request('GET', permalink, member))).data.id).toBe(original.data.id);
  for (const [method, target, payload] of [
    ['POST', list, { title: 'Archived' }],
    ['PATCH', detail, { title: 'Archived', expectedVersion: 1 }],
    ['PATCH', detail + '/move', { to: 'IN_PROGRESS', expectedVersion: 1 }],
    ['PATCH', detail + '/assignee', { assigneeId: null, expectedVersion: 1 }],
    ['DELETE', detail, { expectedVersion: 1 }],
  ] as const) await rejected(await mutation(owner, method, target, payload), 422, 'PROJECT_ARCHIVED');

  const replay = await result<Task>(await mutation(owner, 'POST', list, createPayload, createHeaders), 201);
  expect({ data: replay.data, seq: replay.seq }).toEqual({ data: original.data, seq: original.seq });
  await result(await mutation(owner, 'DELETE', '/workspaces/' + wid + '/members/' + member.id));
  await rejected(await request('GET', permalink, member), 404, 'NOT_FOUND');
  const unassigned = await vi.waitFor(async () => {
    const task = (await result<Task>(await request('GET', permalink, owner))).data;
    expect(task.assigneeId).toBe(null);
    return task;
  }, { timeout: 5000 });
  await result(await mutation(owner, 'POST', path + '/unarchive', { expectedVersion: archived.data.version }));
  expect((await result<Task>(await mutation(owner, 'PATCH', detail,
    { expectedVersion: unassigned.version, title: 'Writes enabled again' }))).data.title).toBe('Writes enabled again');
  expect(await verifyTaskIndexes(maint.client, keys)).toEqual({ ok: true, findings: [] });
}, 12_000);
