import 'reflect-metadata';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi } from '../../src/api/app.js';
import { readConfig } from '../../src/platform/config.js';
import { RedisStore } from '../../src/redis/client.js';
import { loadLibrary } from '../../scripts/load-library.js';
import { createKeys } from '../../src/redis/keys.js';
import { connected } from '../support/redis.js';

const origin = 'http://127.0.0.1';
const workspaceTestId = `${process.pid}-${Date.now()}`;
const prefix = `sh:v1:workspace-http-${workspaceTestId}:`;
const csrf = { Origin: origin, 'X-CSRF-Protection': '1', 'Content-Type': 'application/json' };
const password = 'workspace-test-password-strong';
let mutationNumber = 0;
let accountNumber = 0;

interface WorkspaceView { id: string; name: string; slug: string; ownerId: string; role: string; version: number; createdAt: string; createdAtMs: number }
interface WorkspaceEnvelope { data: WorkspaceView; seq: number; requestId: string }
interface WorkspacePage { data: WorkspaceView[]; nextCursor: string | null; requestId: string }
interface MemberEnvelope { data: { userId: string; role: string }; seq: number; requestId: string }
interface MemberPage { data: Array<{ userId: string; role: string }>; workspaceVersion: number; nextCursor: string | null; seq: number; requestId: string }
interface ErrorEnvelope { error: { code: string; params: Record<string, unknown> }; requestId: string }

describe('workspace HTTP on Redis', () => {
  let maint: RedisStore;
  let app: NestExpressApplication;
  let url: string;
  let keys: ReturnType<typeof createKeys>;

  beforeAll(async () => {
    maint = await connected();
    keys = createKeys(prefix);
    await loadLibrary(maint);
    const config = readConfig('api', {
      ...process.env, REDIS_KEY_PREFIX: prefix, AUTH_ORIGIN: origin,
      AUTH_IP_HMAC_SECRET: 'workspace-http-test-secret-32-bytes',
      AUTH_TRUSTED_PROXIES: '127.0.0.1',
    });
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
    return fetch(url + path, {
      method,
      headers: { ...(method === 'GET' ? {} : csrf), ...(cookie ? { Cookie: cookie } : {}), ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function account(label: string) {
    accountNumber++;
    const clientIp = `198.51.100.${accountNumber}`;
    const email = `${label}-${workspaceTestId}@example.test`;
    const registered = await request('/api/v1/auth/register', 'POST', { email, password, displayName: 'Workspace User' }, undefined,
      { Origin: origin, 'X-CSRF-Protection': '1', 'Content-Type': 'application/json', 'X-Forwarded-For': clientIp });
    expect(registered.status).toBe(202);
    const login = await request('/api/v1/auth/login', 'POST', { email, password }, undefined,
      { Origin: origin, 'X-CSRF-Protection': '1', 'Content-Type': 'application/json', 'X-Forwarded-For': clientIp });
    expect(login.status).toBe(200);
    const data = await login.json() as { data: { id: string } };
    const cookie = login.headers.get('set-cookie')!.split(';', 1)[0]!;
    return { email, userId: data.data.id, cookie };
  }

  function mutationHeaders(label: string) {
    mutationNumber++;
    return { ...csrf, 'Idempotency-Key': `${label}-${workspaceTestId}-${mutationNumber}`, 'X-Client-Mutation-Id': ulid() };
  }

  async function createWorkspace(cookie: string, name: string, slug: string, headers = mutationHeaders('create')) {
    const response = await request('/api/v1/workspaces', 'POST', { name, slug }, cookie, headers);
    return { response, body: await response.json() as WorkspaceEnvelope };
  }

  it('creates and replays workspaces, enforces version and tenant permissions, and removes access immediately', async () => {
    const owner = await account('owner');
    const member = await account('member');
    const idempotency = mutationHeaders('workspace-replay');
    const first = await createWorkspace(owner.cookie, '  Team Alpha  ', `alpha-${workspaceTestId}`, idempotency);
    expect(first.response.status, JSON.stringify(first.body)).toBe(201);
    expect(first.response.headers.get('x-request-id')).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(first.response.headers.get('server-timing')).toMatch(/^app;dur=/);
    expect(first.response.headers.get('cache-control')).toBe('no-store');
    expect(first.body.data).toMatchObject({ name: 'Team Alpha', ownerId: owner.userId, role: 'OWNER', version: 1 });
    expect(first.body.data.createdAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(first.body.data.createdAtMs).toEqual(expect.any(Number));
    const duplicateSlug = await createWorkspace(owner.cookie, 'Another Team', `alpha-${workspaceTestId}`);
    expect(duplicateSlug.response.status).toBe(409);
    expect((duplicateSlug.body as unknown as ErrorEnvelope).error.code).toBe('WORKSPACE_SLUG_TAKEN');
    const replay = await createWorkspace(owner.cookie, 'Team Alpha', `alpha-${workspaceTestId}`, idempotency);
    expect(replay.response.status).toBe(201);
    expect(replay.body.data.id).toBe(first.body.data.id);
    expect(replay.body.seq).toBe(first.body.seq);
    expect(replay.body.requestId).not.toBe(first.body.requestId);
    const reused = await createWorkspace(owner.cookie, 'Other name', `different-${workspaceTestId}`, idempotency);
    expect(reused.response.status).toBe(422);
    expect((reused.body as unknown as ErrorEnvelope).error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    const wid = first.body.data.id as string;
    const memberAdd = await request(`/api/v1/workspaces/${wid}/members`, 'POST', { email: member.email }, owner.cookie, mutationHeaders('add-member'));
    expect(memberAdd.status).toBe(201);
    expect((await memberAdd.json() as MemberEnvelope).data).toEqual({ userId: member.userId, role: 'MEMBER' });

    const secondWorkspace = await createWorkspace(owner.cookie, 'Team Beta', `beta-${workspaceTestId}`);
    expect(secondWorkspace.response.status).toBe(201);

    const firstPage = await request(`/api/v1/workspaces?limit=1`, 'GET', undefined, owner.cookie);
    expect(firstPage.status).toBe(200);
    const firstPageBody = await firstPage.json() as WorkspacePage;
    expect(firstPageBody.data).toHaveLength(1);
    expect(firstPageBody.nextCursor).toEqual(expect.any(String));
    const secondPage = await request(`/api/v1/workspaces?limit=1&cursor=${encodeURIComponent(firstPageBody.nextCursor!)}`, 'GET', undefined, owner.cookie);
    expect(secondPage.status).toBe(200);
    const secondPageBody = await secondPage.json() as WorkspacePage;
    expect(secondPageBody.data).toHaveLength(1);
    expect(secondPageBody.data[0].id).not.toBe(firstPageBody.data[0].id);
    const memberPage = await request(`/api/v1/workspaces/${wid}/members?limit=1`, 'GET', undefined, owner.cookie);
    expect(memberPage.status).toBe(200);
    const memberPageBody = await memberPage.json() as MemberPage;
    expect(memberPageBody.data).toHaveLength(1);
    expect(memberPageBody.nextCursor).toEqual(expect.any(String));
    const memberPage2 = await request(`/api/v1/workspaces/${wid}/members?limit=1&cursor=${encodeURIComponent(memberPageBody.nextCursor!)}`, 'GET', undefined, owner.cookie);
    expect(memberPage2.status).toBe(200);
    expect((await memberPage2.json() as MemberPage).data).toHaveLength(1);

    const deniedUpdate = await request(`/api/v1/workspaces/${wid}`, 'PATCH', { expectedVersion: 2, name: 'Member edit' }, member.cookie, mutationHeaders('denied'));
    expect(deniedUpdate.status).toBe(403);
    const updated = await request(`/api/v1/workspaces/${wid}`, 'PATCH', { expectedVersion: 2, name: 'Renamed Team' }, owner.cookie, mutationHeaders('rename'));
    expect(updated.status).toBe(200);
    expect((await updated.json() as WorkspaceEnvelope).data).toMatchObject({ name: 'Renamed Team', version: 3 });
    const stale = await request(`/api/v1/workspaces/${wid}`, 'PATCH', { expectedVersion: 2, slug: `renamed-${workspaceTestId}` }, owner.cookie, mutationHeaders('stale'));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: 'WORKSPACE_VERSION_CONFLICT', params: { currentVersion: 3 } } });

    const removed = await request(`/api/v1/workspaces/${wid}/members/${member.userId}`, 'DELETE', undefined, owner.cookie, mutationHeaders('remove'));
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ data: { userId: member.userId } });
    expect((await request(`/api/v1/workspaces/${wid}`, 'GET', undefined, member.cookie)).status).toBe(404);
    expect((await request(`/api/v1/workspaces/${wid}/members`, 'GET', undefined, member.cookie)).status).toBe(404);

    const leaver = await account('leaver');
    const addLeaver = await request(`/api/v1/workspaces/${wid}/members`, 'POST', { userId: leaver.userId }, owner.cookie, mutationHeaders('add-leaver'));
    expect(addLeaver.status).toBe(201);
    const leave = await request(`/api/v1/workspaces/${wid}/leave`, 'POST', undefined, leaver.cookie, mutationHeaders('leave'));
    expect(leave.status).toBe(200);
    expect(await leave.json()).toMatchObject({ data: { userId: leaver.userId } });
    expect((await request(`/api/v1/workspaces/${wid}`, 'GET', undefined, leaver.cookie)).status).toBe(404);
  }, 60_000);

  it('validates strict bodies, CSRF and cursors, and returns write quota headers', async () => {
    const owner = await account('guards');
    const invalid = await request('/api/v1/workspaces', 'POST', { name: 'Invalid', slug: `bad-${workspaceTestId}`, unexpected: true }, owner.cookie, mutationHeaders('invalid'));
    expect(invalid.status).toBe(400);
    const csrfFailure = await request('/api/v1/workspaces', 'POST', { name: 'No CSRF', slug: `no-csrf-${workspaceTestId}` }, owner.cookie,
      { 'Content-Type': 'application/json', Origin: 'https://attacker.example', 'X-CSRF-Protection': '1', 'Idempotency-Key': 'bad-csrf', 'X-Client-Mutation-Id': ulid() });
    expect(csrfFailure.status).toBe(403);
    expect((await request('/api/v1/workspaces?unknown=1', 'GET', undefined, owner.cookie)).status).toBe(400);
    const badCursor = await request('/api/v1/workspaces?cursor=not-a-cursor', 'GET', undefined, owner.cookie);
    expect(badCursor.status).toBe(400);
    const counter = keys.rateLimit('write', owner.userId);
    await maint.client.set(counter, '120', { EX: 60 });
    const limited = await request('/api/v1/workspaces', 'POST', { name: 'Quota', slug: `quota-${workspaceTestId}` }, owner.cookie, mutationHeaders('quota'));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toMatch(/^[1-9]\d*$/);
    expect(limited.headers.get('ratelimit')).toContain('"write";r=0;t=');
  }, 60_000);

  it('allows transfer replay after demotion and checks suspension after replay', async () => {
    const owner = await account('transfer-owner');
    const nextOwner = await account('transfer-target');
    const created = await createWorkspace(owner.cookie, 'Transfer Team', `transfer-${workspaceTestId}`);
    expect(created.response.status).toBe(201);
    const wid = created.body.data.id as string;
    const add = await request(`/api/v1/workspaces/${wid}/members`, 'POST', { userId: nextOwner.userId }, owner.cookie, mutationHeaders('transfer-add'));
    expect(add.status).toBe(201);
    const roleUpdate = await request(`/api/v1/workspaces/${wid}/members/${nextOwner.userId}`, 'PATCH',
      { expectedVersion: 2, role: 'ADMIN' }, owner.cookie, mutationHeaders('promote'));
    expect(roleUpdate.status).toBe(200);
    expect((await roleUpdate.json() as MemberEnvelope).data).toEqual({ userId: nextOwner.userId, role: 'ADMIN' });
    const transferHeaders = mutationHeaders('transfer');
    const transfer = await request(`/api/v1/workspaces/${wid}/transfer-ownership`, 'POST', { userId: nextOwner.userId }, owner.cookie, transferHeaders);
    expect(transfer.status).toBe(200);
    const transferBody = await transfer.json() as WorkspaceEnvelope;
    expect(transferBody.data).toMatchObject({ ownerId: nextOwner.userId, role: 'ADMIN' });
    const replay = await request(`/api/v1/workspaces/${wid}/transfer-ownership`, 'POST', { userId: nextOwner.userId }, owner.cookie, transferHeaders);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ seq: transferBody.seq });

    const priorPatchHeaders = mutationHeaders('prior-patch');
    const priorPatch = await request(`/api/v1/workspaces/${wid}`, 'PATCH', { expectedVersion: 4, name: 'Before suspension' }, owner.cookie, priorPatchHeaders);
    expect(priorPatch.status).toBe(200);
    const priorPatchBody = await priorPatch.json() as WorkspaceEnvelope;

    await maint.client.json.set(keys.workspace(wid), '$.suspendedAt', new Date().toISOString());
    const priorReplay = await request(`/api/v1/workspaces/${wid}`, 'PATCH', { expectedVersion: 4, name: 'Before suspension' }, owner.cookie, priorPatchHeaders);
    expect(priorReplay.status).toBe(200);
    expect(await priorReplay.json()).toMatchObject({ seq: priorPatchBody.seq, data: { version: 5 } });
    const suspended = await request(`/api/v1/workspaces/${wid}`, 'PATCH', { expectedVersion: 5, name: 'Blocked' }, nextOwner.cookie, mutationHeaders('suspended'));
    expect(suspended.status).toBe(423);
    expect((await suspended.json() as ErrorEnvelope).error.code).toBe('WORKSPACE_SUSPENDED');
  }, 60_000);
});
