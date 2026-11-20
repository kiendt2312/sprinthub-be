import 'reflect-metadata';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApi } from '../../src/api/app.js';
import { readConfig } from '../../src/platform/config.js';
import { makeId } from '../../src/platform/http/request.js';
import { RedisStore } from '../../src/redis/client.js';
import { createKeys } from '../../src/redis/keys.js';
import { loadLibrary } from '../../scripts/load-library.js';
import { connected } from '../support/redis.js';

const origin = 'http://127.0.0.1';
const testId = randomUUID();
const prefix = `sh:v1:task-board-http-${testId}:`;
const csrf = { Origin: origin, 'X-CSRF-Protection': '1', 'Content-Type': 'application/json' };
const password = 'task-board-test-password-strong';
let mutationNumber = 0;
let accountNumber = 0;

interface TaskView { id: string; workspaceId: string; projectId: string; number: number; key: string; title: string; description?: string; status: string; version: number }
interface TaskEnvelope { data: TaskView; seq: number; requestId: string; rebalancedColumn?: string }

describe('task and board HTTP on Redis', () => {
  let maint: RedisStore;
  let apiRedis: RedisStore;
  let app: NestExpressApplication;
  let url: string;
  let keys: ReturnType<typeof createKeys>;

  beforeAll(async () => {
    maint = await connected();
    keys = createKeys(prefix);
    await loadLibrary(maint);
    const config = readConfig('api', {
      ...process.env, REDIS_KEY_PREFIX: prefix, AUTH_ORIGIN: origin,
      AUTH_IP_HMAC_SECRET: 'task-board-http-test-secret-32-bytes', AUTH_TRUSTED_PROXIES: '127.0.0.1',
    });
    app = await createApi({ ...config, redisUrl: maint.config.redisUrl });
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
    apiRedis = app.get(RedisStore);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    if (maint?.client.isReady) {
      let cursor = '0';
      do {
        const reply = await maint.client.sendCommand(['SCAN', cursor, 'MATCH', `${prefix}*`, 'COUNT', '200']) as [string, string[]];
        cursor = reply[0];
        if (reply[1].length) await maint.client.del(reply[1]);
      } while (cursor !== '0');
    }
    maint?.close();
  });

  async function request(path: string, method = 'GET', body?: unknown, cookie?: string, extra: Record<string, string> = {}) {
    return fetch(url + path, {
      method, headers: { ...(method === 'GET' ? {} : csrf), ...(cookie ? { Cookie: cookie } : {}), ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function account(label: string) {
    accountNumber++;
    const clientIp = `198.51.100.${accountNumber}`;
    const email = `${label}-${testId}@example.test`;
    const headers = { ...csrf, 'X-Forwarded-For': clientIp };
    const registered = await request('/api/v1/auth/register', 'POST', { email, password, displayName: 'Task User' }, undefined, headers);
    expect(registered.status, await registered.clone().text()).toBe(202);
    const login = await request('/api/v1/auth/login', 'POST', { email, password }, undefined, headers);
    expect(login.status).toBe(200);
    const response = await login.json() as { data: { id: string } };
    return { userId: response.data.id, cookie: login.headers.get('set-cookie')!.split(';', 1)[0]! };
  }

  function mutationHeaders(label: string) {
    mutationNumber++;
    return { ...csrf, 'Idempotency-Key': `${label}-${testId}-${mutationNumber}`, 'X-Client-Mutation-Id': ulid() };
  }

  async function createWorkspace(cookie: string) {
    const response = await request('/api/v1/workspaces', 'POST', { name: 'Task HTTP Team', slug: `task-${testId.slice(-20)}` }, cookie, mutationHeaders('workspace'));
    expect(response.status).toBe(201);
    return (await response.json() as { data: { id: string } }).data.id;
  }

  async function createProject(cookie: string, workspaceId: string, key: string) {
    const response = await request(`/api/v1/workspaces/${workspaceId}/projects`, 'POST', { name: `${key} Project`, key }, cookie, mutationHeaders('project'));
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json() as { data: { id: string } }).data.id;
  }

  async function seedTasks(workspaceId: string, projectId: string, keyPrefix: string, count: number, assignedTo: string) {
    const commands = maint.client.multi();
    const ids: string[] = [];
    for (let number = 1; number <= count; number++) {
      const id = makeId('tsk');
      ids.push(id);
      const status = (['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE'] as const)[(number - 1) % 4]!;
      const assigneeId = number % 5 === 0 ? assignedTo : null;
      const task = {
        id, workspaceId, projectId, number, key: `${keyPrefix}-${number}`, title: `Task ${number}`,
        description: '', descriptionFormat: 'markdown', status, priority: (['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const)[(number - 1) % 4]!,
        assigneeId, assigneeIndexValue: assigneeId ?? 'UNASSIGNED', reporterId: assignedTo, sprintId: null, labelIds: [], dueAtMs: null,
        createdAt: new Date(1_700_000_000_000 + number).toISOString(), createdAtMs: 1_700_000_000_000 + number,
        deletedAt: null, isDeleted: 'false', lastSeq: 0, lastClientMutationId: 'fixture', version: 1, schemaVersion: 1,
      };
      commands.json.set(keys.task(id), '$', task);
      commands.sAdd(keys.projectTasks(projectId), id);
      commands.zAdd(keys.board(projectId, status), { score: Math.floor(number / 4) * 1024, value: id });
      commands.zAdd(keys.backlog(projectId), { score: number, value: id });
      commands.hSet(keys.workspaceTaskKeys(workspaceId), `${keyPrefix}-${number}`, id);
      if (assigneeId) commands.sAdd(keys.userAssigned(assigneeId), id);
    }
    commands.set(keys.projectTaskSeq(projectId), String(count));
    await commands.execAsPipeline();
    return ids;
  }

  it('paginates 250 tasks uniquely, keeps every task route tenant scoped, and measures board batches with stale projections', async () => {
    const owner = await account('owner');
    const outsiderId = makeId('usr');
    const outsiderToken = randomBytes(32).toString('base64url');
    const outsiderDigest = createHash('sha256').update(outsiderToken).digest('hex');
    const expiresAt = Date.now() + 60 * 60_000;
    await maint.client.hSet(keys.session(outsiderDigest), {
      userId: outsiderId, expiresAtMs: String(expiresAt), absoluteExpiresAtMs: String(expiresAt), lastSeenAtMs: String(Date.now()),
    });
    const outsider = { userId: outsiderId, cookie: `__Host-sh_session=${outsiderToken}` };
    const workspaceId = await createWorkspace(owner.cookie);
    const boardProjectId = await createProject(owner.cookie, workspaceId, 'BRD');
    const listProjectId = await createProject(owner.cookie, workspaceId, 'LST');
    const boardIds = await seedTasks(workspaceId, boardProjectId, 'BRD', 200, owner.userId);
    await seedTasks(workspaceId, listProjectId, 'LST', 250, owner.userId);

    const pages: TaskView[] = [];
    let cursor: string | null = null;
    do {
      const response = await request(`/api/v1/projects/${listProjectId}/tasks?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, 'GET', undefined, owner.cookie);
      expect(response.status, await response.clone().text()).toBe(200);
      const body = await response.json() as { data: TaskView[]; nextCursor: string | null };
      pages.push(...body.data);
      cursor = body.nextCursor;
    } while (cursor);
    expect(pages).toHaveLength(250);
    expect(new Set(pages.map((item) => item.id)).size).toBe(250);
    expect(pages.map((item) => item.number)).toEqual([...pages.map((item) => item.number)].sort((a, b) => a - b));

    const filtered = await request(`/api/v1/projects/${listProjectId}/tasks?status=TODO&assigneeId=UNASSIGNED&priority=LOW&limit=20`, 'GET', undefined, owner.cookie);
    expect(filtered.status).toBe(200);
    const filteredBody = await filtered.json() as { data: TaskView[]; nextCursor: string | null };
    expect(filteredBody.data.length).toBeGreaterThan(0);
    expect(filteredBody.data.every((item) => item.status === 'TODO' && item.key.startsWith('LST-'))).toBe(true);
    const assigned = await request(`/api/v1/projects/${listProjectId}/tasks?assigneeId=${owner.userId}&priority=LOW&limit=20`, 'GET', undefined, owner.cookie);
    expect(assigned.status).toBe(200);
    expect((await assigned.json() as { data: TaskView[] }).data.length).toBeGreaterThan(0);
    expect(filteredBody.nextCursor).toBeTruthy();
    const mismatchedCursor = await request(`/api/v1/projects/${listProjectId}/tasks?status=TODO&assigneeId=${owner.userId}&priority=LOW&limit=20&cursor=${encodeURIComponent(filteredBody.nextCursor!)}`, 'GET', undefined, owner.cookie);
    expect(mismatchedCursor.status).toBe(400);

    const first = pages[0]!;
    const foreignReadPaths = [
      `/api/v1/projects/${listProjectId}/tasks`, `/api/v1/projects/${boardProjectId}/board`,
      `/api/v1/tasks/${first.id}`, `/api/v1/workspaces/${workspaceId}/tasks/by-key/${first.key}`,
    ];
    for (const path of foreignReadPaths) expect((await request(path, 'GET', undefined, outsider.cookie)).status).toBe(404);
    for (const [path, method, body] of [
      [`/api/v1/tasks/${first.id}`, 'PATCH', { expectedVersion: 1, title: 'Outsider' }],
      [`/api/v1/tasks/${first.id}/assignee`, 'PATCH', { expectedVersion: 1, assigneeId: null }],
      [`/api/v1/tasks/${first.id}/move`, 'PATCH', { expectedVersion: 1, to: 'IN_PROGRESS' }],
      [`/api/v1/tasks/${first.id}`, 'DELETE', { expectedVersion: 1 }],
    ] as const) {
      expect((await request(path, method, body, outsider.cookie, mutationHeaders('foreign'))).status).toBe(404);
    }

    // T-021: Redis is real. Measure 200 direct JSON reads against one native pipeline,
    // and count the API's three protocol batches without MONITOR.
    const sampleIds = boardIds.slice(0, 200);
    const nativeStart = performance.now();
    const native = [];
    for (const id of sampleIds) native.push(await maint.client.json.get(keys.task(id), { path: ['$.id', '$.title'] }));
    const nativeMs = performance.now() - nativeStart;
    const pipelineStart = performance.now();
    const pipeline = maint.client.multi();
    for (const id of sampleIds) pipeline.json.get(keys.task(id), { path: ['$.id', '$.title'] });
    const projected = await pipeline.execAsPipeline();
    const pipelineMs = performance.now() - pipelineStart;
    expect(native).toHaveLength(200);
    expect(projected).toHaveLength(200);
    expect(Number.isFinite(nativeMs) && Number.isFinite(pipelineMs)).toBe(true);

    const readSpy = vi.spyOn(apiRedis, 'read');
    const mutateSpy = vi.spyOn(apiRedis, 'mutate');
    const boardResponse = await request(`/api/v1/projects/${boardProjectId}/board`, 'GET', undefined, owner.cookie);
    expect(boardResponse.status).toBe(200);
    const boardBody = await boardResponse.json() as { data: { projectId: string; columns: Record<string, TaskView[]> } };
    expect(boardBody.data.projectId).toBe(boardProjectId);
    expect(Object.values(boardBody.data.columns).flat()).toHaveLength(200);
    expect(readSpy.mock.calls).toHaveLength(2);
    expect(mutateSpy.mock.calls).toHaveLength(1);
    process.stdout.write(`T-021: 200 tasks, 3 batches (native ${nativeMs.toFixed(1)} ms, pipeline ${pipelineMs.toFixed(1)} ms)\n`);
    readSpy.mockRestore();
    mutateSpy.mockRestore();

    let readCount = 0;
    const originalRead = apiRedis.read.bind(apiRedis);
    const betweenBatchesSpy = vi.spyOn(apiRedis, 'read').mockImplementation((async (operation, deadline) => {
      const result = await originalRead(operation, deadline);
      readCount++;
      if (readCount === 1) {
        await maint.client.json.del(keys.task(boardIds[0]!));
        await maint.client.json.set(keys.task(boardIds[1]!), '$.workspaceId', makeId('ws'));
        await maint.client.json.set(keys.task(boardIds[2]!), '$.status', 'DONE');
      }
      return result;
    }) as typeof apiRedis.read);
    const staleBoard = await request(`/api/v1/projects/${boardProjectId}/board`, 'GET', undefined, owner.cookie);
    expect(staleBoard.status).toBe(200);
    expect(readCount).toBe(2);
    betweenBatchesSpy.mockRestore();
    const staleData = await staleBoard.json() as { data: { columns: Record<string, TaskView[]> } };
    expect(Object.values(staleData.data.columns).flat()).toHaveLength(197);
    expect(Object.values(staleData.data.columns).flat().some((item) => [boardIds[0], boardIds[1], boardIds[2]].includes(item.id))).toBe(false);
    expect(Object.values(staleData.data.columns).flat().every((item) => !Object.hasOwn(item, 'description'))).toBe(true);

    const headers = mutationHeaders('create-task');
    const createdResponse = await request(`/api/v1/projects/${boardProjectId}/tasks`, 'POST',
      { title: 'Markdown task', description: '😀'.repeat(20_000) }, owner.cookie, headers);
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as TaskEnvelope;
    expect(created.data).toMatchObject({ projectId: boardProjectId, workspaceId, number: 201, key: 'BRD-201', status: 'TODO', version: 1 });
    expect(Array.from(created.data.description ?? '').length).toBe(20_000);
    const replay = await request(`/api/v1/projects/${boardProjectId}/tasks`, 'POST',
      { title: 'Markdown task', description: '😀'.repeat(20_000) }, owner.cookie, headers);
    expect(replay.status).toBe(201);
    expect((await replay.json() as TaskEnvelope).data.id).toBe(created.data.id);
    const get = await request(`/api/v1/tasks/${created.data.id}`, 'GET', undefined, owner.cookie);
    expect(get.status).toBe(200);
    const byKey = await request(`/api/v1/workspaces/${workspaceId}/tasks/by-key/BRD-201`, 'GET', undefined, owner.cookie);
    expect(byKey.status).toBe(200);
    const update = await request(`/api/v1/tasks/${created.data.id}`, 'PATCH', { expectedVersion: 1, title: 'Updated' }, owner.cookie, mutationHeaders('update'));
    expect(update.status).toBe(200);
    const assign = await request(`/api/v1/tasks/${created.data.id}/assignee`, 'PATCH', { expectedVersion: 2, assigneeId: owner.userId }, owner.cookie, mutationHeaders('assign'));
    expect(assign.status).toBe(200);
    const move = await request(`/api/v1/tasks/${created.data.id}/move`, 'PATCH', { expectedVersion: 3, to: 'IN_PROGRESS' }, owner.cookie, mutationHeaders('move'));
    expect(move.status).toBe(200);
    const remove = await request(`/api/v1/tasks/${created.data.id}`, 'DELETE', { expectedVersion: 4 }, owner.cookie, mutationHeaders('delete'));
    expect(remove.status).toBe(200);
    expect((await request(`/api/v1/tasks/${created.data.id}`, 'GET', undefined, owner.cookie)).status).toBe(404);

    expect((await request(`/api/v1/projects/${listProjectId}/tasks?limit=250`, 'GET', undefined, owner.cookie)).status).toBe(400);
    expect((await request(`/api/v1/projects/${listProjectId}/tasks?unexpected=1`, 'GET', undefined, owner.cookie)).status).toBe(400);
    await maint.client.hDel(keys.workspaceMembers(workspaceId), owner.userId);
    expect((await request(`/api/v1/projects/${boardProjectId}/board`, 'GET', undefined, owner.cookie)).status).toBe(404);
  }, 120_000);
});
