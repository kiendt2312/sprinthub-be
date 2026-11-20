import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import { Controller, Get, Injectable, Module, Req, UseGuards } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { AuthModule } from '../../src/auth/auth.module.js';
import { SessionGuard } from '../../src/auth/auth.guard.js';
import type { AuthenticatedRequest } from '../../src/auth/auth.types.js';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApi } from '../../src/api/app.js';
import { readConfig } from '../../src/platform/config.js';
import { makeId } from '../../src/platform/http/request.js';
import { RedisStore } from '../../src/redis/client.js';
import { createKeys } from '../../src/redis/keys.js';
import { connected, redisProxy } from '../support/redis.js';

const DAY = 86_400_000;
const PASSWORD = 'a local acceptance test password';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const config = readConfig('api');
const csrf = { Origin: config.authOrigin, 'X-CSRF-Protection': '1', 'Content-Type': 'application/json' };
const prefix = `${config.prefix}auth-edges:${randomUUID()}:`;
const keys = createKeys(prefix);

@Injectable()
class FixtureQuota implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    request.authRateLimit = { policy: 'write', subject: 'fixture', limit: 1, windowSeconds: 60 };
    return true;
  }
}

@Controller('_test/quota')
class QuotaController {
  @Get()
  @UseGuards(FixtureQuota, SessionGuard)
  read(@Req() request: AuthenticatedRequest) {
    return { userId: request.auth?.userId };
  }
}

@Module({ imports: [AuthModule], controllers: [QuotaController], providers: [FixtureQuota] })
class QuotaModule {}

describe('auth edge cases on Redis', () => {
  let maint: RedisStore;
  let app: NestExpressApplication;
  let base: string;

  beforeAll(async () => {
    maint = await connected();
    app = await createApi({ ...config, prefix, trustedProxies: ['127.0.0.1'], redisUrl: maint.config.redisUrl });
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
    await vi.waitFor(async () => expect((await fetch(base + '/health/ready')).status).toBe(200));
  });

  afterAll(async () => {
    await app?.close();
    if (!maint?.client.isReady) return maint?.close();
    const fixture: string[] = [];
    for await (const batch of maint.client.scanIterator({ MATCH: `${prefix}*`, COUNT: 500 })) fixture.push(...batch);
    if (fixture.length) await maint.client.unlink(fixture);
    maint.close();
  });

  async function post(path: string, ip: string, body?: object, cookie?: string, host = base) {
    return fetch(host + '/api/v1/auth/' + path, {
      method: 'POST', headers: { ...csrf, 'X-Forwarded-For': ip, ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function createUser(ip: string) {
    const email = `${randomUUID()}@example.test`;
    const response = await post('register', ip, { email, password: PASSWORD, displayName: 'Test user' });
    expect(response.status).toBe(202);
    const uid = (await maint.client.get(keys.userEmail(digest(email))))!;
    return { email, uid };
  }

  const tokenFrom = (response: Response) => response.headers.get('set-cookie')!.split(';')[0].split('=')[1];
  const cookieFor = (token: string) => `__Host-sh_session=${token}`;
  const me = (token: string, host = base) => fetch(host + '/api/v1/users/me', { headers: { Cookie: cookieFor(token) } });
  const login = (email: string, ip: string, host = base) => post('login', ip, { email, password: PASSWORD }, undefined, host);

  it('uses one Redis batch for session and a quota known before authentication', async () => {
    const { email, uid } = await createUser('192.0.2.38');
    const token = tokenFrom(await login(email, '192.0.2.38'));
    const proxy = await redisProxy(maint.config.redisUrl);
    const proxied = await createApi({ ...config, prefix, redisUrl: proxy.url }, [{ module: QuotaModule }]);
    try {
      await proxied.listen(0, '127.0.0.1');
      const url = await proxied.getUrl();
      await vi.waitFor(async () => expect((await fetch(url + '/health/ready')).status).toBe(200));
      const commands = ['HGETALL', 'INCR', 'EXPIRE', 'PTTL', 'FCALL', 'JSON.GET'];
      const batches: string[][] = [];
      proxy.observe((data) => batches.push(commands.filter((command) => data.includes(`\r\n${command}\r\n`))));
      const request = () => fetch(url + '/_test/quota', { headers: { Cookie: cookieFor(token) } });
      const allowed = await request();
      expect(allowed.status).toBe(200);
      expect(await allowed.json()).toEqual({ userId: uid });
      expect(batches).toEqual([['HGETALL', 'INCR', 'EXPIRE', 'PTTL']]);
      const limited = await request();
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(await maint.client.get(keys.rateLimit('write', 'fixture'))).toBe('2');
    } finally {
      await proxied.close();
      await proxy.close();
    }
  });

  it('registration switch rejects both new and existing email while preserving user indexes', async () => {
    const { email, uid } = await createUser('192.0.2.39');
    const absent = `${randomUUID()}@example.test`;
    const userBefore = await maint.client.json.get(keys.user(uid));
    const count = await maint.client.zCard(keys.usersByCreated());
    await maint.client.hSet(keys.platformSettings(), 'registrationEnabled', '0');
    try {
      for (const address of [email, absent]) {
        const response = await post('register', '192.0.2.40', { email: address, password: PASSWORD, displayName: 'Ignored' });
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ error: { code: 'REGISTRATION_DISABLED', params: {} } });
      }
      expect(await maint.client.get(keys.userEmail(digest(absent)))).toBeNull();
      expect(await maint.client.json.get(keys.user(uid))).toEqual(userBefore);
      expect(await maint.client.zCard(keys.usersByCreated())).toBe(count);
    } finally {
      await maint.client.hSet(keys.platformSettings(), 'registrationEnabled', '1');
    }
    expect((await post('register', '192.0.2.40', { email: absent, password: PASSWORD, displayName: 'Reopened' })).status).toBe(202);
  });

  it('rotates the current cookie even with 32 live sessions and rejects a new device at the cap', async () => {
    const ip = '192.0.2.41';
    const { email, uid } = await createUser(ip);
    const current = tokenFrom(await login(email, ip));
    const now = Date.now();
    for (let index = 0; index < 31; index++) {
      const hash = digest(`fixture device ${index}`);
      const session = keys.session(hash);
      await maint.client.hSet(session, {
        userId: uid, id: makeId('ses'), createdAtMs: String(now), lastSeenAtMs: String(now),
        expiresAtMs: String(now + 7 * DAY), absoluteExpiresAtMs: String(now + 30 * DAY),
      });
      await maint.client.pExpireAt(session, now + 7 * DAY);
      await maint.client.sAdd(keys.userSessions(uid), hash);
    }
    const full = await login(email, ip);
    expect(full.status).toBe(409);
    expect(full.headers.get('set-cookie')).toBeNull();
    expect(await full.json()).toMatchObject({ error: { code: 'SESSION_LIMIT_REACHED', params: { limit: 32 } } });
    const replaced = await post('login', ip, { email, password: PASSWORD }, cookieFor(current));
    expect(replaced.status).toBe(200);
    expect(tokenFrom(replaced)).not.toBe(current);
    expect((await me(current)).status).toBe(401);
    expect((await me(tokenFrom(replaced))).status).toBe(200);
    expect(await maint.client.sCard(keys.userSessions(uid))).toBe(32);
  });

  it('returns an unknown outcome after a committed login with no reply and sends one FCALL', async () => {
    const { email, uid } = await createUser('192.0.2.31');
    const proxy = await redisProxy(maint.config.redisUrl);
    const proxied = await createApi({
      ...config, prefix, trustedProxies: ['127.0.0.1'], redisUrl: proxy.url, timeoutMs: 200,
    });
    try {
      await proxied.listen(0, '127.0.0.1');
      const host = await proxied.getUrl();
      await vi.waitFor(async () => expect((await fetch(host + '/health/ready')).status).toBe(200));
      proxy.trap('sh_create_session');
      const dropped = await login(email, '192.0.2.31', host);
      expect(dropped.status).toBe(503);
      expect(dropped.headers.get('set-cookie')).toBeNull();
      expect(await dropped.json()).toMatchObject({ error: { code: 'MUTATION_OUTCOME_UNKNOWN', params: {} } });
      expect(proxy.count).toBe(1);
      expect(await maint.client.sCard(keys.userSessions(uid))).toBe(1);
      const retry = await login(email, '192.0.2.31');
      expect(retry.status).toBe(200);
      expect(await maint.client.sCard(keys.userSessions(uid))).toBe(2);
    } finally {
      await proxied.close();
      await proxy.close();
    }
  });

  it('uses the digest in Redis and updates the sliding expiry asynchronously without crossing day 30', async () => {
    const { email, uid } = await createUser('192.0.2.32');
    const loggedIn = await login(email, '192.0.2.32');
    const token = tokenFrom(loggedIn);
    const hashKey = keys.session(digest(token));
    const initial = await maint.client.hGetAll(hashKey);
    expect(await maint.client.sMembers(keys.userSessions(uid))).toEqual([digest(token)]);
    expect(JSON.stringify(initial)).not.toContain(token);
    expect(Number(initial.expiresAtMs) - Number(initial.createdAtMs)).toBe(7 * DAY);
    expect(Number(initial.absoluteExpiresAtMs) - Number(initial.createdAtMs)).toBe(30 * DAY);
    expect(await maint.client.pExpireTime(hashKey)).toBe(Number(initial.expiresAtMs));
    expect((await me(token)).status).toBe(200);
    expect((await maint.client.hGetAll(hashKey)).lastSeenAtMs).toBe(initial.lastSeenAtMs);

    const now = Date.now();
    await maint.client.hSet(hashKey, 'lastSeenAtMs', String(now - 600_001));
    expect((await me(token)).status).toBe(200);
    await vi.waitFor(async () => expect(Number(await maint.client.hGet(hashKey, 'lastSeenAtMs'))).toBeGreaterThanOrEqual(now));
    let value = await maint.client.hGetAll(hashKey);
    expect(Number(value.expiresAtMs) - Number(value.lastSeenAtMs)).toBe(7 * DAY);

    const createdAt = now - 29 * DAY;
    const day30 = createdAt + 30 * DAY;
    await maint.client.hSet(hashKey, {
      createdAtMs: String(createdAt), absoluteExpiresAtMs: String(day30),
      lastSeenAtMs: String(now - 600_001), expiresAtMs: String(now + 3_600_000),
    });
    await maint.client.pExpireAt(hashKey, now + 3_600_000);
    expect((await me(token)).status).toBe(200);
    await vi.waitFor(async () => expect(await maint.client.pExpireTime(hashKey)).toBe(day30));
    value = await maint.client.hGetAll(hashKey);
    expect(Number(value.expiresAtMs)).toBe(day30);

    // Advance the fixture to its absolute deadline without sleeping for a day.
    await maint.client.hSet(hashKey, { expiresAtMs: String(now - 1), absoluteExpiresAtMs: String(now - 1) });
    await maint.client.pExpireAt(hashKey, now - 1);
    expect((await me(token)).status).toBe(401);
    expect(await maint.client.exists(hashKey)).toBe(0);
  });

  it('returns the response before background touch completes and correlates touch failures', async () => {
    const { email } = await createUser('192.0.2.33');
    const token = tokenFrom(await login(email, '192.0.2.33'));
    const sessionKey = keys.session(digest(token));
    const oldSeen = Date.now() - 600_001;
    await maint.client.hSet(sessionKey, 'lastSeenAtMs', String(oldSeen));
    const proxy = await redisProxy(maint.config.redisUrl);
    const proxied = await createApi({
      ...config, prefix, redisUrl: proxy.url, timeoutMs: 250,
    });
    const write = vi.spyOn(process.stdout, 'write');
    try {
      await proxied.listen(0, '127.0.0.1');
      const host = await proxied.getUrl();
      await vi.waitFor(async () => expect((await fetch(host + '/health/ready')).status).toBe(200));
      proxy.trap('sh_touch_session', '-ERR fixture touch failure\r\n');
      const response = await me(token, host);
      expect(response.status).toBe(200);
      const requestId = response.headers.get('x-request-id');
      await vi.waitFor(() => expect(write.mock.calls.flat().join('\n')).toContain('session_touch_failed'));
      const lines = write.mock.calls.flat().join('\n').split('\n');
      expect(lines.find((line) => line.includes('session_touch_failed'))).toContain(requestId);
      expect(Number(await maint.client.hGet(sessionKey, 'lastSeenAtMs'))).toBe(oldSeen);
    } finally {
      write.mockRestore();
      await proxied.close();
      await proxy.close();
    }
  });

  it('logs out one device and then all devices, leaving the other user alone', async () => {
    const { email } = await createUser('192.0.2.34');
    const other = await createUser('192.0.2.35');
    const otherToken = tokenFrom(await login(other.email, '192.0.2.35'));
    const tokens = [];
    for (let offset = 0; offset < 3; offset++) tokens.push(tokenFrom(await login(email, '192.0.2.34')));
    const logout = (action: string, token: string) => post(action, '192.0.2.34', {}, cookieFor(token));
    const one = await logout('logout', tokens[0]);
    expect(one.status).toBe(204);
    expect(await one.text()).toBe('');
    expect((await me(tokens[0])).status).toBe(401);
    expect((await me(tokens[1])).status).toBe(200);
    const all = await logout('logout-all', tokens[1]);
    expect(all.status).toBe(204);
    expect(all.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await logout('logout-all', tokens[1])).status).toBe(204);
    expect((await me(tokens[1])).status).toBe(401);
    expect((await me(tokens[2])).status).toBe(401);
    expect((await me(otherToken)).status).toBe(200);
  });

  it('applies one concurrent profile write, preserves replay and excludes stale or foreign sessions', async () => {
    const { uid, email } = await createUser('192.0.2.36');
    const other = await createUser('192.0.2.37');
    const otherToken = tokenFrom(await login(other.email, '192.0.2.37'));
    const first = tokenFrom(await login(email, '192.0.2.36'));
    const second = tokenFrom(await login(email, '192.0.2.36'));
    const { data } = await (await me(first)).json();
    const ids = [makeId('mut').slice(4), makeId('mut').slice(4)];
    const ambiguous = [
      { expectedVersion: data.version, locale: 'vi', avatarUrl: 'https://example.test/avatar' },
      { expectedVersion: data.version, displayName: 'Other name' },
    ];
    const patch = (index: number, body: object, key = `write-${index}`) => fetch(base + '/api/v1/users/me', {
      method: 'PATCH', body: JSON.stringify(body), headers: { ...csrf, Cookie: cookieFor(first),
        'Idempotency-Key': key, 'X-Client-Mutation-Id': ids[index] },
    });
    const responses = await Promise.all(ambiguous.map((body, index) => patch(index, body)));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const winner = responses.findIndex((response) => response.status === 200);
    const result = await responses[winner].json();
    const loser = await responses[1 - winner].json();
    expect(loser.error).toEqual({ code: 'USER_VERSION_CONFLICT', params: { currentVersion: data.version + 1 } });
    const replay = await patch(winner, ambiguous[winner]);
    expect((await replay.json()).data).toEqual(result.data);
    expect((await patch(winner, { ...ambiguous[winner], displayName: 'Payload changed' })).status).toBe(422);
    expect((await patch(0, { expectedVersion: result.data.version, disabledAt: null }, 'forbidden')).status).toBe(400);
    expect((await patch(0, { expectedVersion: result.data.version, locale: 'de' }, 'bad-locale')).status).toBe(400);
    const backToEnglish = await patch(0, { expectedVersion: result.data.version, locale: 'en', avatarUrl: null }, 'english');
    expect(backToEnglish.status).toBe(200);
    expect((await backToEnglish.json()).data).toMatchObject({ locale: 'en', avatarUrl: null });

    await maint.client.sAdd(keys.userSessions(uid), ['f'.repeat(64), digest(otherToken)]);
    const listed = await fetch(base + '/api/v1/users/me/sessions', { headers: { cookie: cookieFor(first) } });
    expect(listed.status).toBe(200);
    const list = (await listed.json()).data;
    expect(list).toHaveLength(2);
    expect(list.filter((row: { current: boolean }) => row.current)).toHaveLength(1);
    expect(JSON.stringify(list)).not.toMatch(new RegExp(`${digest(first)}|${digest(second)}|${digest(otherToken)}`));
    await maint.client.sRem(keys.userSessions(uid), ['f'.repeat(64), digest(otherToken)]);

    await maint.client.set(keys.rateLimit('write', uid), '120', { EX: 60 });
    const limited = await patch(0, { expectedVersion: result.data.version + 1, locale: 'vi' }, 'limited');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('ratelimit')).toMatch(/^"write";r=0;t=[1-9]/);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});
