import 'reflect-metadata';
import { createHash } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApi } from '../../src/api/app.js';
import { readConfig } from '../../src/platform/config.js';
import { RedisStore } from '../../src/redis/client.js';
import { loadLibrary } from '../../scripts/load-library.js';
import { createKeys } from '../../src/redis/keys.js';
import { connected, integrationStore } from '../support/redis.js';
import { ipDigest } from '../../src/auth/auth.security.js';

const origin = 'http://127.0.0.1';
const ipSecret = 'auth-http-integration-test-secret-32-bytes';
const authTestId = `${process.pid}-${Date.now()}`;
const prefix = `sh:v1:auth-http-${authTestId}:`;
const csrfHeaders = { Origin: origin, 'X-CSRF-Protection': '1', 'Content-Type': 'application/json' };
const signup = (email: string) => ({ email, password: 'sufficiently-long-password', displayName: 'Test User' });

describe('auth HTTP on Redis', () => {
  let maint: RedisStore;
  let app: NestExpressApplication;
  let url: string;
  let keys: ReturnType<typeof integrationStore>['keys'];

  beforeAll(async () => {
    maint = await connected();
    keys = createKeys(prefix);
    await loadLibrary(maint);
    const config = readConfig('api', {
      ...process.env,
      REDIS_KEY_PREFIX: prefix,
      AUTH_ORIGIN: origin,
      AUTH_IP_HMAC_SECRET: ipSecret,
      AUTH_TRUSTED_PROXIES: '127.0.0.1',
    });
    // Use the maintenance credential with a unique prefix so test data is isolated.
    app = await createApi({ ...config, redisUrl: maint.config.redisUrl });
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
    await vi.waitFor(async () => expect((await fetch(url + '/health/ready')).status).toBe(200));
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

  async function post(path: string, body: unknown, clientIp: string, headers: Record<string, string> = csrfHeaders) {
    return fetch(url + path, {
      method: 'POST', headers: { ...headers, 'X-Forwarded-For': clientIp },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function register(email: string, clientIp: string) {
    return post('/api/v1/auth/register', signup(email), clientIp);
  }

  it('rejects CSRF before touching a Redis rate counter', async () => {
    const clientIp = '198.51.100.1';
    const response = await post('/api/v1/auth/register', signup(`csrf-${authTestId}@example.test`), clientIp,
      { 'Content-Type': 'application/json', Origin: 'https://attacker.example', 'X-CSRF-Protection': '1' });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'CSRF_INVALID', params: {} } });
    expect(await maint.client.exists(keys.rateLimit('register', ipDigest(clientIp, ipSecret)))).toBe(0);
    const malformedEmail = await register('name..x@-.example', '198.51.100.1');
    expect(malformedEmail.status).toBe(400);
    expect(await maint.client.exists(keys.rateLimit('register', ipDigest(clientIp, ipSecret)))).toBe(0);
    const invalidBody = await post('/api/v1/auth/logout', 'not json', clientIp,
      { Origin: origin, 'X-CSRF-Protection': '1', 'Content-Type': 'text/plain' });
    expect(invalidBody.status).toBe(400);
  });

  it('T-001 returns a common response for concurrent normalized duplicate emails', async () => {
    const address = `concurrent-${authTestId}@example.test`;
    const [first, second] = await Promise.all([
      register(address.toUpperCase(), '198.51.100.2'), register(` ${address} `, '198.51.100.2'),
    ]);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const firstBody = await first.json() as { status: string; requestId: string };
    const secondBody = await second.json() as { status: string; requestId: string };
    expect(firstBody.status).toBe('accepted');
    expect(secondBody.status).toBe('accepted');
    expect(firstBody.requestId).not.toBe(secondBody.requestId);
    const digest = createHash('sha256').update(address).digest('hex');
    const userId = await maint.client.get(keys.userEmail(digest));
    expect(userId).toMatch(/^usr_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    const stored = await maint.client.json.get(keys.user(userId!)) as Record<string, unknown>;
    expect(stored).toMatchObject({ emailNormalized: address, locale: 'en', avatarUrl: null, version: 1 });
    expect(stored.passwordHash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=4\$/);
    expect(await maint.client.zCard(keys.usersByCreated())).toBe(1);
    expect(await maint.client.exists(keys.userSessions(userId!))).toBe(0);
  }, 60_000);

  it('T-002 applies the register IP quota on the fourth attempt with rate headers', async () => {
    const clientIp = '198.51.100.3';
    for (let index = 0; index < 3; index++) {
      expect((await register(`register-${index}-${authTestId}@example.test`, clientIp)).status).toBe(202);
    }
    const limited = await register(`register-over-${authTestId}@example.test`, clientIp);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toMatch(/^[1-9]\d*$/);
    expect(limited.headers.get('ratelimit')).toContain('"register";r=0;t=');

    const counter = keys.rateLimit('register', ipDigest(clientIp, ipSecret));
    await maint.client.pExpire(counter, 15);
    await vi.waitFor(async () => expect(await maint.client.exists(counter)).toBe(0));
    expect((await register(`register-reopened-${authTestId}@example.test`, clientIp)).status).toBe(202);
    expect(await maint.client.get(counter)).toBe('1');
    expect(await maint.client.pTTL(counter)).toBeGreaterThan(3_590_000);
  }, 60_000);

  it('rejects registration after registration is disabled without creating user indexes', async () => {
    const email = `disabled-${authTestId}@example.test`;
    const count = await maint.client.zCard(keys.usersByCreated());
    await maint.client.hSet(keys.platformSettings(), 'registrationEnabled', '0');
    try {
      const response = await register(email, '198.51.100.7');
      expect(response.status).toBe(403);
      const emailKey = keys.userEmail(createHash('sha256').update(email).digest('hex'));
      expect(await maint.client.exists(emailKey)).toBe(0);
      expect(await maint.client.zCard(keys.usersByCreated())).toBe(count);
    } finally {
      await maint.client.hDel(keys.platformSettings(), 'registrationEnabled');
    }
  }, 60_000);

  it('T-002 limits one account across different client IPs', async () => {
    const address = `account-${authTestId}@example.test`;
    expect((await register(address, '198.51.100.4')).status).toBe(202);
    for (let index = 1; index <= 6; index++) {
      const response = await post('/api/v1/auth/login', { email: address, password: 'wrong-password-for-this-account' },
        `198.51.100.${10 + index}`);
      expect(response.status).toBe(index === 6 ? 429 : 401);
    }
  }, 60_000);

  it('T-002 limits login attempts from one IP across different emails', async () => {
    const clientIp = '198.51.100.6';
    for (let index = 1; index <= 21; index++) {
      const response = await post('/api/v1/auth/login', {
        email: `unknown-${index}-${authTestId}@example.test`, password: 'sufficiently-long-password',
      }, clientIp);
      expect(response.status).toBe(index === 21 ? 429 : 401);
    }
  }, 60_000);

  it('supports opaque session login, profile update/list, and stale-cookie logout', async () => {
    const address = `profile-${authTestId}@example.test`;
    const password = 'sufficiently-long-password';
    expect((await register(address, '198.51.100.5')).status).toBe(202);
    const login = await post('/api/v1/auth/login', { email: address, password }, '198.51.100.5');
    expect(login.status).toBe(200);
    const setCookie = login.headers.get('set-cookie')!;
    expect(setCookie).toMatch(/^__Host-sh_session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax$/);
    const token = setCookie.match(/^__Host-sh_session=([^;]+)/)![1]!;
    const cookie = `__Host-sh_session=${token}`;
    const profile = await login.json() as { data: Record<string, unknown>; requestId: string };
    expect(profile.data).toMatchObject({ email: address, locale: 'en', avatarUrl: null, version: 2 });
    expect(Object.keys(profile.data).sort()).toEqual(['avatarUrl', 'displayName', 'email', 'id', 'locale', 'version']);
    const tokenDigest = createHash('sha256').update(token).digest('hex');
    const storedSession = await maint.client.hGetAll(keys.session(tokenDigest));
    expect(storedSession).toMatchObject({ userId: profile.data.id });
    expect(JSON.stringify(storedSession)).not.toContain(token);

    const current = await fetch(url + '/api/v1/users/me', { headers: { Cookie: cookie } });
    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject({ data: { id: profile.data.id }, requestId: expect.any(String) });
    const sessions = await fetch(url + '/api/v1/users/me/sessions', { headers: { Cookie: cookie } });
    expect(sessions.status).toBe(200);
    const listed = await sessions.json() as { data: Array<Record<string, unknown>> };
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0]).toMatchObject({ current: true });
    expect(Object.keys(listed.data[0]!).sort()).toEqual(['absoluteExpiresAtMs', 'createdAtMs', 'current', 'expiresAtMs', 'id', 'lastSeenAtMs']);

    const patch = await fetch(url + '/api/v1/users/me', {
      method: 'PATCH', headers: { ...csrfHeaders, Cookie: cookie, 'Idempotency-Key': `locale-${authTestId}`,
        'X-Client-Mutation-Id': '01ARZ3NDEKTSV4RRFFQ69G5FAV' },
      body: JSON.stringify({ expectedVersion: profile.data.version, locale: 'vi', avatarUrl: null }),
    });
    expect(patch.status).toBe(200);
    expect(await patch.json()).toMatchObject({ data: { locale: 'vi', avatarUrl: null, version: 3 } });

    const secondLogin = await post('/api/v1/auth/login', { email: address, password }, '198.51.100.5');
    expect(secondLogin.status).toBe(200);
    const secondToken = secondLogin.headers.get('set-cookie')!.match(/^__Host-sh_session=([^;]+)/)![1]!;
    const secondCookie = `__Host-sh_session=${secondToken}`;
    const secondSessions = await fetch(url + '/api/v1/users/me/sessions', { headers: { Cookie: secondCookie } });
    expect((await secondSessions.json() as { data: unknown[] }).data).toHaveLength(2);

    const logout = await post('/api/v1/auth/logout', {}, '198.51.100.5', { ...csrfHeaders, Cookie: cookie });
    expect(logout.status).toBe(204);
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await fetch(url + '/api/v1/users/me', { headers: { Cookie: cookie } })).status).toBe(401);
    expect((await fetch(url + '/api/v1/users/me', { headers: { Cookie: secondCookie } })).status).toBe(200);

    const logoutAll = await post('/api/v1/auth/logout-all', {}, '198.51.100.5', { ...csrfHeaders, Cookie: secondCookie });
    expect(logoutAll.status).toBe(204);
    expect((await fetch(url + '/api/v1/users/me', { headers: { Cookie: secondCookie } })).status).toBe(401);
    const repeatedLogout = await post('/api/v1/auth/logout-all', {}, '198.51.100.5', { ...csrfHeaders, Cookie: secondCookie });
    expect(repeatedLogout.status).toBe(204);
  }, 60_000);
});
