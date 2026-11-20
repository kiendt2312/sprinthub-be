import 'reflect-metadata';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi } from '../../src/api/app.js';
import { readConfig } from '../../src/platform/config.js';
import { RedisStore } from '../../src/redis/client.js';
import { loadLibrary } from '../../scripts/load-library.js';
import { connected } from '../support/redis.js';

const origin = 'http://127.0.0.1';
const testId = `${process.pid}-${Date.now()}`;
const prefix = `sh:v1:project-http-${testId}:`;
const csrf = { Origin: origin, 'X-CSRF-Protection': '1', 'Content-Type': 'application/json' };
const password = 'project-test-password-strong';
let mutationNumber = 0;
let accountNumber = 0;
interface Project { id: string; workspaceId: string; name: string; key: string; description: string; version: number; archivedAt: string | null }
interface ProjectEnvelope { data: Project; seq: number; requestId: string }
interface ProjectPage { data: Project[]; nextCursor: string | null; requestId: string }
interface ErrorEnvelope { error: { code: string; params: Record<string, unknown> }; requestId: string }

describe('project HTTP on Redis', () => {
  let maint: RedisStore;
  let app: NestExpressApplication;
  let url: string;

  beforeAll(async () => {
    maint = await connected();
    await loadLibrary(maint);
    const config = readConfig('api', { ...process.env, REDIS_KEY_PREFIX: prefix, AUTH_ORIGIN: origin,
      AUTH_IP_HMAC_SECRET: 'project-http-test-secret-32-bytes', AUTH_TRUSTED_PROXIES: '127.0.0.1' });
    app = await createApi({ ...config, redisUrl: maint.config.redisUrl });
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
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
    return fetch(url + path, { method, headers: { ...(method === 'GET' ? {} : csrf), ...(cookie ? { Cookie: cookie } : {}), ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function account(label: string) {
    accountNumber++;
    const clientIp = `198.51.100.${accountNumber}`;
    const email = `${label}-${testId}@example.test`;
    const headers = { ...csrf, 'X-Forwarded-For': clientIp };
    const registered = await request('/api/v1/auth/register', 'POST', { email, password, displayName: 'Project User' }, undefined, headers);
    expect(registered.status).toBe(202);
    const login = await request('/api/v1/auth/login', 'POST', { email, password }, undefined, headers);
    expect(login.status).toBe(200);
    const data = await login.json() as { data: { id: string } };
    return { email, userId: data.data.id, cookie: login.headers.get('set-cookie')!.split(';', 1)[0]! };
  }
  function mutationHeaders(label: string) {
    mutationNumber++;
    return { ...csrf, 'Idempotency-Key': `${label}-${testId}-${mutationNumber}`, 'X-Client-Mutation-Id': ulid() };
  }

  it('covers lifecycle routes, RBAC, tenant isolation, cursor filters, and active unarchive no-op', async () => {
    const owner = await account('owner');
    const member = await account('member');
    const outsider = await account('outsider');
    const workspaceResponse = await request('/api/v1/workspaces', 'POST', { name: 'Project Team', slug: `project-${testId}` }, owner.cookie, mutationHeaders('workspace'));
    expect(workspaceResponse.status).toBe(201);
    const workspace = (await workspaceResponse.json() as { data: { id: string } }).data.id;
    expect((await request(`/api/v1/workspaces/${workspace}/members`, 'POST', { userId: member.userId }, owner.cookie, mutationHeaders('member'))).status).toBe(201);

    const create = (key: string, name = `Project ${key}`, cookie = owner.cookie) => request(`/api/v1/workspaces/${workspace}/projects`, 'POST',
      { name, key }, cookie, mutationHeaders(`project-${key}`));
    const aResponse = await create('PA');
    expect(aResponse.status, await aResponse.clone().text()).toBe(201);
    const a = await aResponse.json() as ProjectEnvelope;
    expect(a.data).toMatchObject({ workspaceId: workspace, key: 'PA', name: 'Project PA', description: '', version: 1, archivedAt: null });
    expect(a.data.id).toMatch(/^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect((await create('PB')).status).toBe(201);
    expect((await create('PC')).status).toBe(201);
    expect((await create('PA')).status).toBe(409);
    expect((await create('PD', 'Denied', member.cookie)).status).toBe(403);
    expect((await request(`/api/v1/workspaces/${workspace}/projects`, 'POST', { name: 'Outsider', key: 'OUT' }, outsider.cookie, mutationHeaders('outsider'))).status).toBe(404);

    expect((await request(`/api/v1/projects/${a.data.id}`, 'GET', undefined, member.cookie)).status).toBe(200);
    expect((await request(`/api/v1/projects/${a.data.id}`, 'GET', undefined, outsider.cookie)).status).toBe(404);
    const memberPatch = await request(`/api/v1/projects/${a.data.id}`, 'PATCH', { expectedVersion: 1, name: 'Denied' }, member.cookie, mutationHeaders('member-patch'));
    expect(memberPatch.status).toBe(403);
    const patch = await request(`/api/v1/projects/${a.data.id}`, 'PATCH', { expectedVersion: 1, name: 'Project Alpha', key: 'PAX', description: 'A project' }, owner.cookie, mutationHeaders('patch'));
    expect(patch.status).toBe(200);
    const patched = await patch.json() as ProjectEnvelope;
    expect(patched.data).toMatchObject({ name: 'Project Alpha', key: 'PAX', description: 'A project', version: 2 });
    const stale = await request(`/api/v1/projects/${a.data.id}`, 'PATCH', { expectedVersion: 1, description: 'stale' }, owner.cookie, mutationHeaders('stale'));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: 'PROJECT_VERSION_CONFLICT', params: { currentVersion: 2 } } });

    const archive = await request(`/api/v1/projects/${a.data.id}/archive`, 'POST', { expectedVersion: 2 }, owner.cookie, mutationHeaders('archive'));
    expect(archive.status).toBe(200);
    const archived = await archive.json() as ProjectEnvelope;
    expect(archived.data.archivedAt).toEqual(expect.any(String));
    expect((await request(`/api/v1/projects/${a.data.id}`, 'GET', undefined, member.cookie)).status).toBe(200);
    const blocked = await request(`/api/v1/projects/${a.data.id}`, 'PATCH', { expectedVersion: 3, name: 'Blocked' }, owner.cookie, mutationHeaders('blocked'));
    expect(blocked.status).toBe(422);
    expect((await blocked.json() as ErrorEnvelope).error.code).toBe('PROJECT_ARCHIVED');

    const defaultPage = await request(`/api/v1/workspaces/${workspace}/projects?limit=1`, 'GET', undefined, member.cookie);
    expect(defaultPage.status).toBe(200);
    const firstPage = await defaultPage.json() as ProjectPage;
    expect(firstPage.data).toHaveLength(1);
    expect(firstPage.data[0]!.id).not.toBe(a.data.id);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    const nextPage = await request(`/api/v1/workspaces/${workspace}/projects?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor!)}`, 'GET', undefined, member.cookie);
    const lastPage = await nextPage.json() as ProjectPage;
    expect(lastPage.data).toHaveLength(1);
    expect(lastPage.nextCursor).toBeNull();
    const allPage = await request(`/api/v1/workspaces/${workspace}/projects?archived=true&limit=10`, 'GET', undefined, member.cookie);
    const allProjects = await allPage.json() as ProjectPage;
    expect(allProjects.data).toHaveLength(3);
    expect(allProjects.nextCursor).toBeNull();
    const wrongFilter = await request(`/api/v1/workspaces/${workspace}/projects?archived=true&limit=1&cursor=${encodeURIComponent(firstPage.nextCursor!)}`, 'GET', undefined, member.cookie);
    expect(wrongFilter.status).toBe(400);

    const unarchive = await request(`/api/v1/projects/${a.data.id}/unarchive`, 'POST', { expectedVersion: 3 }, owner.cookie, mutationHeaders('unarchive'));
    expect(unarchive.status).toBe(200);
    const active = await unarchive.json() as ProjectEnvelope;
    expect(active.data.archivedAt).toBeNull();
    const noOp = await request(`/api/v1/projects/${a.data.id}/unarchive`, 'POST', { expectedVersion: 4 }, owner.cookie, mutationHeaders('unarchive-noop'));
    expect(noOp.status).toBe(200);
    expect(await noOp.json()).toMatchObject({ seq: active.seq, data: { version: 4, archivedAt: null } });
    const staleNoOp = await request(`/api/v1/projects/${a.data.id}/unarchive`, 'POST', { expectedVersion: 3 }, owner.cookie, mutationHeaders('stale-noop'));
    expect(staleNoOp.status).toBe(409);
    expect((await staleNoOp.json() as ErrorEnvelope).error.code).toBe('PROJECT_VERSION_CONFLICT');
  }, 90_000);

  it('rejects unknown body fields and unknown list query parameters', async () => {
    const owner = await account('strict');
    const response = await request('/api/v1/workspaces', 'POST', { name: 'Strict Team', slug: `strict-${testId}` }, owner.cookie, mutationHeaders('strict-workspace'));
    const wid = (await response.json() as { data: { id: string } }).data.id;
    const invalid = await request(`/api/v1/workspaces/${wid}/projects`, 'POST', { name: 'Invalid', key: 'IV', surprise: true }, owner.cookie, mutationHeaders('invalid'));
    expect(invalid.status, await invalid.clone().text()).toBe(400);
    expect((await request(`/api/v1/workspaces/${wid}/projects?unknown=1`, 'GET', undefined, owner.cookie)).status).toBe(400);
    expect((await request(`/api/v1/workspaces/${wid}/projects?archived=yes`, 'GET', undefined, owner.cookie)).status).toBe(400);
    expect((await request(`/api/v1/workspaces/${wid}/projects`, 'POST', { name: 'No query', key: 'NQ' }, owner.cookie,
      { ...mutationHeaders('unexpected-query') })).status).toBe(201);
    const description = '📝'.repeat(8_000);
    const validDescription = await request(`/api/v1/workspaces/${wid}/projects`, 'POST',
      { name: 'Project description boundary', key: 'LIM', description }, owner.cookie, mutationHeaders('description-limit'));
    expect(validDescription.status, await validDescription.clone().text()).toBe(201);
    const saved = await validDescription.json() as ProjectEnvelope;
    expect(saved.data.description).toBe(description);
    const oversizedDescription = await request(`/api/v1/projects/${saved.data.id}`, 'PATCH',
      { expectedVersion: 1, description: description + 'x' }, owner.cookie, mutationHeaders('description-over-limit'));
    expect(oversizedDescription.status).toBe(400);
    const read = await request(`/api/v1/projects/${saved.data.id}`, 'GET', undefined, owner.cookie);
    expect((await read.json() as ProjectEnvelope).data).toMatchObject({ version: 1, description });
    const queryOnMutation = await request(`/api/v1/workspaces/${wid}/projects?x=1`, 'POST', { name: 'Query', key: 'QQ' }, owner.cookie, mutationHeaders('query-mutation'));
    expect(queryOnMutation.status).toBe(400);
  }, 60_000);
});
