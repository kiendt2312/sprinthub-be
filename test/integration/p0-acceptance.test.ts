import { execFile } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { expect, it } from 'vitest';
import { createApi } from '../../src/api/app.js';
import { LIB_VERSION, readConfig } from '../../src/platform/config.js';
import { makeId } from '../../src/platform/http/request.js';
import { createKeys } from '../../src/redis/keys.js';
import { connected, integrationStore, waitForRedisData } from '../support/redis.js';

const exec = promisify(execFile);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

it('T-016 revokes old cookies on suspend racing login and keeps them invalid after reactivate', async () => {
  const maintenance = await connected();
  const runtime = await connected(integrationStore('api'));
  const temp = await mkdtemp(join(tmpdir(), 'sprinthub-admin-fixture-'));
  const { client, keys } = maintenance;
  const config = readConfig('api');
  const operatorEmail = `${randomUUID()}@example.test`;
  const targetEmail = `${randomUUID()}@example.test`;
  const password = 'A password for this fixture only';
  let app: NestExpressApplication | undefined;
  let operatorId: string | null = null;
  let targetId: string | null = null;
  const auditIds = new Set<string>();
  try {
    expect(await client.sCard(keys.platformAdmins())).toBe(0);
    app = await createApi({ ...config, trustedProxies: ['127.0.0.1'] });
    await app.listen(0, '127.0.0.1');
    const url = (await app.getUrl()) + '/api/v1';
    const post = (path: string, body: object, forwarded = '192.0.2.211') => fetch(url + path, {
      method: 'POST', headers: {
        'Content-Type': 'application/json', 'X-CSRF-Protection': '1', Origin: config.authOrigin,
        'X-Forwarded-For': forwarded,
      }, body: JSON.stringify(body),
    });
    const me = (cookie: string) => fetch(url + '/users/me', { headers: { cookie } });
    const cookie = (response: Response) => response.headers.get('set-cookie')!.split(';')[0];
    const version = await runtime.client.fCallRo('sh_lib_version');
    expect(version).toBe(LIB_VERSION);

    expect((await post('/auth/register', { email: operatorEmail, password, displayName: 'Operator' })).status).toBe(202);
    expect((await post('/auth/register', { email: targetEmail, password, displayName: 'Target' })).status).toBe(202);
    operatorId = await client.get(keys.userEmail(digest(operatorEmail)));
    targetId = await client.get(keys.userEmail(digest(targetEmail)));
    expect(operatorId).toBeTruthy();
    expect(targetId).toBeTruthy();
    const adminScript = resolve('dist/scripts/admin/cli.js');
    await writeFile(join(temp, '.env.local'),
      `SPRINT_HUB_CLI_OPERATORS_JSON='${JSON.stringify({ [userInfo().username]: operatorId })}'\n`,
      { mode: 0o600 });
    const cli = async (...args: string[]) => {
      const output = await exec(process.execPath, [adminScript, '--local', ...args], { cwd: temp, timeout: 6000 });
      const result = JSON.parse(output.stdout);
      expect(result.status).toBe('applied');
      auditIds.add(result.requestId);
      return result.requestId as string;
    };

    const grantId = await cli('grant', operatorId!);
    expect(await client.sMembers(keys.platformAdmins())).toEqual([operatorId]);
    const init = await Promise.all([post('/auth/login', { email: targetEmail, password }),
      post('/auth/login', { email: targetEmail, password }, '192.0.2.212')]);
    expect(init.map((response) => response.status)).toEqual([200, 200]);
    const oldCookies = init.map(cookie);

    const [racing, suspendId] = await Promise.all([
      post('/auth/login', { email: targetEmail, password }, '192.0.2.213'),
      cli('suspend', targetId!),
    ]);
    if (racing.status === 200) oldCookies.push(cookie(racing));
    else {
      expect(racing.status).toBe(401);
      expect(await racing.json()).toMatchObject({ error: { code: 'USER_SUSPENDED', params: {} } });
    }
    expect(await client.sCard(keys.userSessions(targetId!))).toBe(0);
    for (const original of oldCookies) {
      const response = await me(original);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: { code: 'SESSION_INVALID', params: {} } });
    }
    await cli('reactivate', targetId!);
    for (const original of oldCookies) expect((await me(original)).status).toBe(401);
    const recovered = await post('/auth/login', { email: targetEmail, password }, '192.0.2.214');
    expect(recovered.status).toBe(200);
    const reactivatedCookie = cookie(recovered);
    expect((await me(reactivatedCookie)).status).toBe(200);
    await cli('grant', targetId!);
    expect((await me(reactivatedCookie)).status).toBe(401);
    const grantedLogin = await post('/auth/login', { email: targetEmail, password }, '192.0.2.214');
    expect(grantedLogin.status).toBe(200);
    const grantedCookie = cookie(grantedLogin);
    await cli('revoke', targetId!);
    expect((await me(grantedCookie)).status).toBe(401);

    await expect(exec(process.execPath, [adminScript, '--local', 'revoke', operatorId!],
      { cwd: temp, timeout: 6000 })).rejects.toMatchObject({
      code: 1, stdout: expect.stringContaining('LAST_PLATFORM_ADMIN'),
    });

    const audit = (await client.xRange(keys.audit(), '-', '+'))!;
    expect(audit.find((entry) => entry.message.requestId === grantId)?.message).toMatchObject({
      actor: 'cli:' + operatorId, osUser: userInfo().username, targetId: operatorId, requestId: grantId,
    });
    expect(audit.filter((entry) => entry.message.requestId === suspendId)).toHaveLength(1);
    expect(audit.find((entry) => entry.message.requestId === suspendId)?.message).toMatchObject({
      type: 'user.suspend', actor: 'cli:' + operatorId, osUser: userInfo().username, targetId, requestId: suspendId,
    });
  } finally {
    await app?.close();
    for (const [id, email] of [[operatorId, operatorEmail], [targetId, targetEmail]] as const) {
      if (!id) continue;
      const sessions = await client.sMembers(keys.userSessions(id));
      await client.del([keys.user(id), keys.userEmail(digest(email)), ...sessions.map(keys.session), keys.userSessions(id)]);
      await client.zRem(keys.usersByCreated(), id);
      await client.sRem(keys.platformAdmins(), id);
    }
    const audit = (await client.xRange(keys.audit(), '-', '+'))!;
    const entries = audit.filter((entry) => auditIds.has(entry.message.requestId)).map((entry) => entry.id);
    if (entries.length) await client.xDel(keys.audit(), entries);
    const ips = ['192.0.2.211', '192.0.2.212', '192.0.2.213', '192.0.2.214'];
    await client.del([
      ...ips.map((ip) => keys.rateLimit('login-ip', createHmac('sha256', config.ipHmacSecret).update(ip).digest('hex'))),
      keys.rateLimit('register', createHmac('sha256', config.ipHmacSecret).update(ips[0]).digest('hex')),
      keys.rateLimit('login-acct', digest(targetEmail)),
    ]);
    runtime.close();
    maintenance.close();
    await rm(temp, { recursive: true, force: true });
  }
});

it('blocks platform-admin changes and audit reads or trimming through runtime ACLs', async () => {
  const app = await connected(integrationStore('api'));
  const worker = await connected(integrationStore('worker'));
  const { keys } = app;
  const actor = makeId('usr');
  try {
    expect(await app.client.fCallRo('sh_lib_version')).toBe(LIB_VERSION);
    for (const [name, signature] of [
      ['sh_grant_admin', [actor, actor, 'fixture', 'req_fixture', '[]']],
      ['sh_revoke_admin', [actor, actor, 'fixture', 'req_fixture', '[]', '[]']],
      ['sh_suspend_user', [actor, actor, 'fixture', 'req_fixture', '[]', '[]']],
      ['sh_reactivate_user', [actor, actor, 'fixture', 'req_fixture']],
      ['sh_revoke_sessions', [actor, actor, 'fixture', 'req_fixture', '[]']],
      ['sh_set_platform_setting', [actor, 'registrationEnabled', '0', 'fixture', 'req_fixture']],
    ] as const) {
      const declared = name === 'sh_set_platform_setting'
        ? [keys.platformAdmins(), keys.user(actor), keys.platformSettings(), keys.audit()]
        : [keys.platformAdmins(), keys.user(actor), keys.user(actor), keys.audit(), keys.userSessions(actor)];
      await expect(app.client.fCall(name, { keys: declared, arguments: [...signature] })).rejects.toThrow(/NOPERM/);
    }
    await expect(app.client.hSet(keys.platformSettings(), 'registrationEnabled', '0')).rejects.toThrow(/NOPERM/);
    for (const store of [app, worker]) {
      await expect(store.client.sendCommand(['XRANGE', keys.audit(), '-', '+'])).rejects.toThrow(/NOPERM/);
      await expect(store.client.sendCommand(['XTRIM', keys.audit(), 'MAXLEN', '0'])).rejects.toThrow(/NOPERM/);
    }
    await expect(worker.client.hGetAll(keys.session('0'.repeat(64)))).rejects.toThrow(/NOPERM/);
  } finally {
    app.close();
    worker.close();
  }
});

it('keeps the 16-admin and 32-session workloads below 5 ms in Redis SLOWLOG and persists their effects', async () => {
  const redis = await connected();
  const { client } = redis;
  const keys = createKeys(`${redis.keys.prefix}acceptance:${randomUUID()}:`);
  const ids = Array.from({ length: 17 }, () => makeId('usr'));
  const [operator, target] = ids;
  const source = await readFile('redis/functions/sprinthub.lua', 'utf8');
  const register = (uid: string) => {
    const email = `${uid.toLowerCase()}@example.test`;
    const sha = digest(email);
    return redis.call('sh_register_user',
      [keys.platformSettings(), keys.userEmail(sha), keys.user(uid), keys.usersByCreated()],
      [uid, sha, email, email, 'fixture-password-hash', uid]);
  };
  const osUser = 'fixture';
  const requestId = makeId('req');
  const admin = (name: string, uid: string, sessions: string[], admins?: string[]) => redis.call(name,
    [keys.platformAdmins(), keys.user(operator), keys.user(uid), keys.audit(), keys.userSessions(uid),
      ...(admins ?? []).map(keys.user), ...sessions.map(keys.session)],
    [operator, uid, osUser, requestId, ...admins ? [JSON.stringify(admins)] : [], JSON.stringify(sessions)]);
  const emailSha = digest(`${target.toLowerCase()}@example.test`);
  const sessionIds: string[] = [];
  const login = (sha: string, existing: string, current: string[]) => redis.call('sh_create_session',
    [keys.userEmail(emailSha), keys.user(target), keys.userSessions(target), keys.session(sha), ...current.map(keys.session)],
    [target, emailSha, sha, makeId('ses'), existing, JSON.stringify(current)]);
  const config = await client.configGet(['slowlog-log-slower-than', 'slowlog-max-len']);
  try {
    for (const uid of ids) expect((await register(uid)).ok).toBe(true);
    for (const uid of ids.slice(0, 16)) expect((await admin('sh_grant_admin', uid, [])).ok).toBe(true);
    expect(await admin('sh_grant_admin', ids[16], [])).toMatchObject({ ok: false, code: 'PLATFORM_ADMIN_LIMIT_REACHED' });
    for (let index = 0; index < 32; index++) {
      const sha = digest('session ' + index);
      expect((await login(sha, '', [...sessionIds].sort())).ok).toBe(true);
      sessionIds.push(sha);
    }
    expect(await client.sCard(keys.platformAdmins())).toBe(16);
    expect(await client.sCard(keys.userSessions(target))).toBe(32);
    let measured = 0;
    try {
      await client.configSet({ 'slowlog-log-slower-than': '0', 'slowlog-max-len': '4096' });
      await client.sendCommand(['SLOWLOG', 'RESET']);
      const last = digest('session replacement');
      expect(await login(last, '', [...sessionIds].sort())).toMatchObject({ ok: false, code: 'SESSION_LIMIT_REACHED' });
      expect((await login(last, sessionIds[0], [...sessionIds].sort())).ok).toBe(true);
      expect((await admin('sh_suspend_user', target, [last, ...sessionIds.slice(1)].sort(), ids.slice(0, 16).sort())).ok)
        .toBe(true);
      const slowlog = await client.sendCommand(['SLOWLOG', 'GET', '4096']) as [number, number, number, string[]][];
      const durations = slowlog.filter((row) => row[3][0].toUpperCase() === 'FCALL').map((row) => row[2]);
      expect(durations).toHaveLength(3);
      measured = Math.max(...durations);
      expect(measured).toBeLessThan(5000);
    } finally {
      await client.configSet(config);
    }
    process.stdout.write(`P0 auth SLOWLOG max ${measured} µs at 16 admins and 32 sessions\n`);
    expect(await client.sCard(keys.userSessions(target))).toBe(0);
    const keepDigest = digest('an active operator session');
    const keepSession = keys.session(keepDigest);
    const operatorEmail = digest(`${operator.toLowerCase()}@example.test`);
    expect((await redis.call('sh_create_session',
      [keys.userEmail(operatorEmail), keys.user(operator), keys.userSessions(operator), keepSession],
      [operator, operatorEmail, keepDigest, makeId('ses'), '', '[]'])).ok).toBe(true);
    const libraries = async () => (await client.functionListWithCode({ LIBRARYNAME: 'sprinthub' }))
      .map(({ functions, ...library }) => ({
        ...library,
        functions: [...functions].sort((left, right) => left.name.localeCompare(right.name)),
      }));
    const state = async () => ({
      user: await client.json.get(keys.user(target)), admins: (await client.sMembers(keys.platformAdmins())).sort(),
      count: await client.sCard(keys.userSessions(target)), audit: await client.xRange(keys.audit(), '-', '+'),
      liveSession: await client.hGetAll(keepSession), liveExpiry: await client.pExpireTime(keepSession),
      lib: await libraries(),
    });
    const before = await state();
    expect(before.lib).toMatchObject([{ library_code: source }]);
    expect(before.liveSession.userId).toBe(operator);
    expect(before.liveExpiry).toBe(Number(before.liveSession.expiresAtMs));
    expect(before.liveExpiry).toBeGreaterThan(Date.now());
    const runId = /^run_id:([^\s]+)/m.exec(await client.info('server'))?.[1];
    const containerInfo = await exec('docker', ['compose', 'exec', '-T', 'redis', 'sh', '-c',
      'REDISCLI_AUTH="$REDIS_MAINT_PASSWORD" redis-cli --user sh-maint INFO server'], { timeout: 6000 });
    expect(runId).toBeTruthy();
    expect(containerInfo.stdout).toContain(`run_id:${runId}`);
    await exec('docker', ['compose', 'restart', 'redis'], { timeout: 25_000 });
    await waitForRedisData(redis);
    expect(await state()).toEqual(before);
  } finally {
    try {
      const fixture: string[] = [];
      for await (const batch of client.scanIterator({ MATCH: `${keys.prefix}*`, COUNT: 500 })) fixture.push(...batch);
      if (fixture.length) await client.unlink(fixture);
    } finally {
      redis.close();
    }
  }
}, 60_000);
