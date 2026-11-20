import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { readConfig } from '../../src/platform/config.js';
import { RedisStore } from '../../src/redis/client.js';
import { integrationStore } from '../support/redis.js';
import { verifyAuth } from '../../scripts/verify-auth.js';

const base = integrationStore('maintenance');
const prefix = `${base.keys.prefix}test_${ulid()}:`;
const testConfig = readConfig('maintenance', {
  ...process.env,
  REDIS_MAINT_URL: base.config.redisUrl,
  REDIS_KEY_PREFIX: prefix,
  REDIS_LIB_VERSION: '3',
});
const actor = `usr_${ulid()}`;
const target = `usr_${ulid()}`;
const now = Date.now();

function user(id: string) {
  const emailNormalized = `${id}@example.test`;
  const emailDigest = createHash('sha256').update(emailNormalized).digest('hex');
  return {
    id, email: emailNormalized, emailNormalized, emailDigest,
    passwordHash: '$argon2id$fixture', displayName: id, avatarUrl: null, locale: 'en',
    version: 1, schemaVersion: 1, createdAtMs: now, createdAt: new Date(now).toISOString(), disabledAt: null,
    suspendedBy: null, lastLoginAt: null,
  };
}

describe('Platform Admin Redis Functions', () => {
  const redis = new RedisStore(testConfig, 'maintenance');
  const keys = redis.keys;

  async function putUser(id: string, store = redis) {
    const document = user(id);
    await store.client.sendCommand(['JSON.SET', store.keys.user(id), '$', JSON.stringify(document)]);
    await store.client.set(store.keys.userEmail(document.emailDigest), id);
    await store.client.zAdd(store.keys.usersByCreated(), { score: document.createdAtMs, value: id });
  }

  async function grant(actorId: string, targetId: string, snapshots: string[] = [], store = redis) {
    const sessionKeys = snapshots.map(digest => store.keys.session(digest));
    return store.call('sh_grant_admin', [
      store.keys.platformAdmins(), store.keys.user(actorId), store.keys.user(targetId), store.keys.audit(),
      store.keys.userSessions(targetId), ...sessionKeys,
    ], [actorId, targetId, 'test-operator', ulid(), JSON.stringify(snapshots)]);
  }

  async function operatorAction(store: RedisStore, action: 'revoke' | 'suspend', actorId: string, targetId: string) {
    const deadline = store.deadline();
    const localKeys = store.keys;
    return store.withKeySnapshot(async deadline => {
      const [adminIds, sessionDigests] = await Promise.all([
        store.read(client => client.sMembers(localKeys.platformAdmins()), deadline),
        store.read(client => client.sMembers(localKeys.userSessions(targetId)), deadline),
      ]);
      adminIds.sort();
      sessionDigests.sort();
      const fn = action === 'revoke' ? 'sh_revoke_admin' : 'sh_suspend_user';
      const functionKeys = [
        localKeys.platformAdmins(), localKeys.user(actorId), localKeys.user(targetId), localKeys.audit(), localKeys.userSessions(targetId),
        ...adminIds.map(localKeys.user), ...sessionDigests.map(localKeys.session),
      ];
      return store.call(fn, functionKeys, [
        actorId, targetId, `operator-${actorId}`, ulid(), JSON.stringify(adminIds), JSON.stringify(sessionDigests),
      ], deadline);
    }, deadline);
  }

  beforeAll(async () => {
    await redis.client.connect();
    if (!await redis.ready()) throw new Error('Load Redis Function library v3 before integration tests');
    await putUser(actor);
    await putUser(target);
  });

  afterAll(async () => {
    if (!redis.client.isOpen) { base.close(); return; }
    let cursor = '0';
    do {
      const reply = await redis.client.sendCommand(['SCAN', cursor, 'MATCH', `${prefix}*`, 'COUNT', '200']) as [string, string[]];
      cursor = reply[0];
      if (reply[1].length) await redis.client.del(reply[1]);
    } while (cursor !== '0');
    redis.close();
    base.close();
  });

  it('allows only the mapped user to bootstrap, then keeps an active admin', async () => {
    const bootstrap = await grant(actor, actor);
    expect(bootstrap).toMatchObject({ ok: true, data: { changed: true }, seq: null });
    expect(await redis.client.sMembers(keys.platformAdmins())).toEqual([actor]);

    const unauthorized = await grant(target, actor);
    expect(unauthorized).toMatchObject({ ok: false, code: 'OPERATOR_FORBIDDEN' });
    expect(await redis.client.xLen(keys.audit())).toBe(1);

    const second = await grant(actor, target);
    expect(second).toMatchObject({ ok: true, data: { changed: true }, seq: null });
    const repeated = await grant(actor, target);
    expect(repeated).toMatchObject({ ok: true, data: { changed: false }, seq: null });
    expect(await redis.client.xLen(keys.audit())).toBe(2);
    const adminIds = (await redis.client.sMembers(keys.platformAdmins())).sort();
    const revokeKeys = (targetId: string, snapshot: string[]) => [
      keys.platformAdmins(), keys.user(actor), keys.user(targetId), keys.audit(), keys.userSessions(targetId),
      ...snapshot.map(keys.user),
    ];
    const revokeTarget = await redis.call('sh_revoke_admin', revokeKeys(target, adminIds), [
      actor, target, 'test-operator', ulid(), JSON.stringify(adminIds), JSON.stringify([]),
    ]);
    expect(revokeTarget).toMatchObject({ ok: true, data: { changed: true } });
    const lastAdminIds = [actor];
    const denied = await redis.call('sh_revoke_admin', revokeKeys(actor, lastAdminIds), [
      actor, actor, 'test-operator', ulid(), JSON.stringify(lastAdminIds), JSON.stringify([]),
    ]);
    expect(denied).toMatchObject({ ok: false, code: 'LAST_PLATFORM_ADMIN' });
    expect(await redis.client.sMembers(keys.platformAdmins())).toEqual([actor]);
  });

  it('suspends only after removing every declared session and records one audit event', async () => {
    const digest = 'a'.repeat(64);
    const sessionsKey = keys.userSessions(target);
    await redis.client.sAdd(sessionsKey, digest);
    await redis.client.hSet(keys.session(digest), {
      userId: target, id: `ses_${ulid()}`, createdAtMs: String(now), lastSeenAtMs: String(now),
      expiresAtMs: String(now + 60_000), absoluteExpiresAtMs: String(now + 60_000),
    });
    const adminIds = (await redis.client.sMembers(keys.platformAdmins())).sort();
    const sessionIds = [digest];
    const reply = await redis.call('sh_suspend_user', [
      keys.platformAdmins(), keys.user(actor), keys.user(target), keys.audit(), sessionsKey,
      ...adminIds.map(keys.user), keys.session(digest),
    ], [actor, target, 'test-operator', ulid(), JSON.stringify(adminIds), JSON.stringify(sessionIds)]);
    expect(reply).toMatchObject({ ok: true, data: { changed: true }, seq: null });
    expect(await redis.client.exists(keys.session(digest))).toBe(0);
    expect(await redis.client.sCard(sessionsKey)).toBe(0);
    const suspended = JSON.parse(await redis.client.sendCommand(['JSON.GET', keys.user(target)]) as string) as { disabledAt: string | null };
    expect(suspended.disabledAt).not.toBeNull();
    expect(await redis.client.xLen(keys.audit())).toBe(4); // bootstrap + grant + revoke + suspend
    expect(await verifyAuth(redis)).toEqual([]);
  });

  it('rejects an invalid audit key before changing admin membership', async () => {
    const freshTarget = `usr_${ulid()}`;
    await putUser(freshTarget);
    await redis.client.set(keys.audit(), 'wrong-type');
    const before = await redis.client.sMembers(keys.platformAdmins());
    await expect(grant(actor, freshTarget)).rejects.toThrow();
    expect(await redis.client.sMembers(keys.platformAdmins())).toEqual(before);
    await redis.client.del(keys.audit());
  });

  it('revokes sessions and makes repeated empty-index revocation an audited no-op', async () => {
    const sessionOwner = `usr_${ulid()}`;
    const digest = 'd'.repeat(64);
    await putUser(sessionOwner);
    await redis.client.sAdd(keys.userSessions(sessionOwner), digest);
    await redis.client.hSet(keys.session(digest), {
      userId: sessionOwner, id: `ses_${ulid()}`, createdAtMs: String(now), lastSeenAtMs: String(now),
      expiresAtMs: String(now + 60_000), absoluteExpiresAtMs: String(now + 60_000),
    });
    const args = (snapshot: string[]) => [actor, sessionOwner, 'test-operator', ulid(), JSON.stringify(snapshot)];
    const first = await redis.call('sh_revoke_sessions', [
      keys.platformAdmins(), keys.user(actor), keys.user(sessionOwner), keys.audit(), keys.userSessions(sessionOwner), keys.session(digest),
    ], args([digest]));
    expect(first).toMatchObject({ ok: true, data: { changed: true }, seq: null });
    expect(await redis.client.exists(keys.session(digest))).toBe(0);
    const auditCount = await redis.client.xLen(keys.audit());
    const repeated = await redis.call('sh_revoke_sessions', [
      keys.platformAdmins(), keys.user(actor), keys.user(sessionOwner), keys.audit(), keys.userSessions(sessionOwner),
    ], args([]));
    expect(repeated).toMatchObject({ ok: true, data: { changed: false }, seq: null });
    expect(await redis.client.xLen(keys.audit())).toBe(auditCount);
  });

  it('serializes reciprocal admin revokes and self-suspends on separate connections', async () => {
    const racePrefix = `${base.keys.prefix}race_${ulid()}:`;
    const raceConfig = readConfig('maintenance', {
      ...process.env, REDIS_MAINT_URL: base.config.redisUrl, REDIS_KEY_PREFIX: racePrefix, REDIS_LIB_VERSION: '3',
    });
    const raceStore = new RedisStore(raceConfig, 'maintenance');
    const raceKeys = raceStore.keys;
    const peer = new RedisStore(raceConfig, 'maintenance');
    await raceStore.connect();
    await peer.connect();
    try {
      const a = `usr_${ulid()}`;
      const b = `usr_${ulid()}`;
      await putUser(a, raceStore);
      await putUser(b, raceStore);
      expect((await grant(a, a, [], raceStore)).ok).toBe(true);
      expect((await grant(a, b, [], raceStore)).ok).toBe(true);

      const revokeResults = await Promise.all([
        operatorAction(raceStore, 'revoke', a, b),
        operatorAction(peer, 'revoke', b, a),
      ]);
      expect(revokeResults.filter(result => result.ok)).toHaveLength(1);
      expect(revokeResults.filter(result => !result.ok && result.code === 'OPERATOR_FORBIDDEN')).toHaveLength(1);
      expect(await raceStore.client.sCard(raceKeys.platformAdmins())).toBe(1);
      const survivor = (await raceStore.client.sMembers(raceKeys.platformAdmins()))[0];

      const c = `usr_${ulid()}`;
      const d = `usr_${ulid()}`;
      await putUser(c, raceStore);
      await putUser(d, raceStore);
      expect((await grant(survivor, c, [], raceStore)).ok).toBe(true);
      expect((await grant(survivor, d, [], raceStore)).ok).toBe(true);
      expect((await operatorAction(raceStore, 'revoke', survivor, survivor)).ok).toBe(true);
      const suspendResults = await Promise.all([
        operatorAction(raceStore, 'suspend', c, c),
        operatorAction(peer, 'suspend', d, d),
      ]);
      expect(suspendResults.filter(result => result.ok)).toHaveLength(1);
      expect(suspendResults.filter(result => !result.ok && result.code === 'LAST_PLATFORM_ADMIN')).toHaveLength(1);
      const members = await raceStore.client.sMembers(raceKeys.platformAdmins());
      expect(members).toHaveLength(2);
      const remainingActive = await Promise.all(members.map(async id => {
        const raw = await raceStore.client.sendCommand(['JSON.GET', raceKeys.user(id)]) as string;
        return JSON.parse(raw) as { disabledAt: string | null };
      }));
      expect(remainingActive.some(value => value.disabledAt === null)).toBe(true);
    } finally {
      peer.close();
      let cursor = '0';
      do {
        const reply = await raceStore.client.sendCommand(['SCAN', cursor, 'MATCH', `${racePrefix}*`, 'COUNT', '200']) as [string, string[]];
        cursor = reply[0];
        if (reply[1].length) await raceStore.client.del(reply[1]);
      } while (cursor !== '0');
      raceStore.close();
    }
  });

  it('serializes registration against registration-off and leaves no partial account', async () => {
    const peer = new RedisStore(testConfig, 'maintenance');
    await peer.connect();
    try {
      const id = `usr_${ulid()}`;
      const email = `${id}@example.test`.toLowerCase();
      const digest = createHash('sha256').update(email).digest('hex');
      const registration = redis.call('sh_register_user', [
        keys.platformSettings(), keys.userEmail(digest), keys.user(id), keys.usersByCreated(),
      ], [id, digest, email, email, '$argon2id$fixture', id]);
      const closeRegistration = peer.call('sh_set_platform_setting', [
        keys.platformAdmins(), keys.user(actor), keys.platformSettings(), keys.audit(),
      ], [actor, 'registrationEnabled', '0', 'test-operator', ulid()]);
      const [registerReply, settingReply] = await Promise.all([registration, closeRegistration]);
      expect(settingReply).toMatchObject({ ok: true, data: { changed: true }, seq: null });
      if (registerReply.ok) {
        expect(registerReply.data).toEqual({ status: 'accepted' });
        expect(await redis.client.get(keys.userEmail(digest))).toBe(id);
        expect(await redis.client.zScore(keys.usersByCreated(), id)).not.toBeNull();
      } else {
        expect(registerReply.code).toBe('REGISTRATION_DISABLED');
        expect(await redis.client.get(keys.userEmail(digest))).toBeNull();
        expect(await redis.client.exists(keys.user(id))).toBe(0);
        expect(await redis.client.zScore(keys.usersByCreated(), id)).toBeNull();
      }
      const auditCount = await redis.client.xLen(keys.audit());
      expect(await redis.call('sh_set_platform_setting', [
        keys.platformAdmins(), keys.user(actor), keys.platformSettings(), keys.audit(),
      ], [actor, 'registrationEnabled', '0', 'test-operator', ulid()]))
        .toMatchObject({ ok: true, data: { changed: false }, seq: null });
      expect(await redis.client.xLen(keys.audit())).toBe(auditCount);
    } finally {
      peer.close();
    }
  });

  it('verifier detects disabled users with live sessions, then passes after cleanup', async () => {
    const disabled = `usr_${ulid()}`;
    await putUser(disabled);
    await redis.client.sendCommand(['JSON.SET', keys.user(disabled), '$.disabledAt', JSON.stringify(new Date(now).toISOString())]);
    const digest = 'e'.repeat(64);
    await redis.client.sAdd(keys.userSessions(disabled), digest);
    await redis.client.hSet(keys.session(digest), {
      userId: disabled, id: `ses_${ulid()}`, createdAtMs: String(now), lastSeenAtMs: String(now),
      expiresAtMs: String(now + 60_000), absoluteExpiresAtMs: String(now + 60_000),
    });
    expect(await verifyAuth(redis)).toContain(`disabled user has an active session: ${disabled}`);
    await redis.client.del([keys.session(digest), keys.userSessions(disabled)]);
    expect(await verifyAuth(redis)).toEqual([]);
  });

  it('reports wrong-type auth indexes without aborting the offline verification pass', async () => {
    const digest = createHash('sha256').update(user(actor).emailNormalized).digest('hex');
    await redis.client.del(keys.userEmail(digest));
    await redis.client.sendCommand(['JSON.SET', keys.userEmail(digest), '$', JSON.stringify({ id: actor })]);
    const errors = await verifyAuth(redis);
    expect(errors).toContain(`invalid email mapping type: ${actor}`);
    await redis.client.del(keys.userEmail(digest));
    await redis.client.set(keys.userEmail(digest), actor);
    expect(await verifyAuth(redis)).toEqual([]);
  });

  it('injects a partial suspend failure in an isolated library and verifies the user stays active', async () => {
    const library = `sh_admin_fault_${ulid().toLowerCase()}`;
    const faultFunction = 'sh_test_inject_suspend_partial';
    const account = `usr_${ulid()}`;
    const firstDigest = 'e'.repeat(64);
    const secondDigest = 'f'.repeat(64);
    let loaded = false;
    try {
      const source = `#!lua name=${library}\nredis.register_function('${faultFunction}', function(keys, args) redis.call('DEL', keys[1]); error('injected partial suspend failure') end)`;
      expect(await redis.client.sendCommand(['FUNCTION', 'LOAD', source])).toBe(library);
      loaded = true;
      await putUser(account);
      await redis.client.sAdd(keys.userSessions(account), [firstDigest, secondDigest]);
      for (const digest of [firstDigest, secondDigest]) {
        await redis.client.hSet(keys.session(digest), {
          userId: account, id: `ses_${ulid()}`, createdAtMs: String(now), lastSeenAtMs: String(now),
          expiresAtMs: String(now + 60_000), absoluteExpiresAtMs: String(now + 60_000),
        });
      }
      await expect(redis.client.fCall(faultFunction, { keys: [keys.session(firstDigest)], arguments: [] })).rejects.toThrow();
      const stillActive = JSON.parse(await redis.client.sendCommand(['JSON.GET', keys.user(account)]) as string) as { disabledAt: string | null };
      expect(stillActive.disabledAt).toBeNull();
      expect(await redis.client.exists(keys.session(firstDigest))).toBe(0);
      expect(await redis.client.exists(keys.session(secondDigest))).toBe(1);
      expect(await verifyAuth(redis)).toEqual([]);

      const adminIds = (await redis.client.sMembers(keys.platformAdmins())).sort();
      const sessionIds = [firstDigest, secondDigest];
      const reply = await redis.call('sh_suspend_user', [
        keys.platformAdmins(), keys.user(actor), keys.user(account), keys.audit(), keys.userSessions(account),
        ...adminIds.map(keys.user), ...sessionIds.map(keys.session),
      ], [actor, account, 'test-operator', ulid(), JSON.stringify(adminIds), JSON.stringify(sessionIds)]);
      expect(reply).toMatchObject({ ok: true, data: { changed: true }, seq: null });
      expect(await verifyAuth(redis)).toEqual([]);
    } finally {
      if (loaded) await redis.client.sendCommand(['FUNCTION', 'DELETE', library]);
    }
  });
});
