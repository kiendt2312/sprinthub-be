import assert from "node:assert/strict";
import { randomUUID } from 'node:crypto';
import { decodeReply } from '../../src/redis/reply.js';
import { integrationStore } from '../support/redis.js';
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

const store = integrationStore();
const client = store.client;
const uid = "usr_01JCS9Y0S7R4XK3X2B8Q8H4V1A";
const email = "user@example.com";
const emailDigest = "a".repeat(64);
const digest = "b".repeat(64);
const prefix = `${store.keys.prefix}auth-test:${randomUUID()}:`;
const key = (suffix: string) => `${prefix}${suffix}`;

async function call(name: string, keys: string[], args: string[] = []) {
  const raw = await client.fCall(name, { keys, arguments: args });
  assert.equal(typeof raw, "string");
  return decodeReply(raw);
}

async function register() {
  return call("sh_register_user", [key("platform-settings"), key(`user-email:${emailDigest}`), key(`user:${uid}`), key("users-by-created")],
    [uid, emailDigest, email, email, "$argon2id$v=19$m=65536,t=3,p=4$salt$hash", "User"]);
}

beforeAll(async () => {
  await client.connect();
  expect(await store.ready()).toBe(true);
});

afterEach(async () => {
  const names: string[] = [];
  for await (const batch of client.scanIterator({ MATCH: `${prefix}*`, COUNT: 100 })) names.push(...batch);
  if (names.length) await client.unlink(names);
});

afterAll(async () => {
  if (client.isOpen) await client.close();
});

it("registers atomically, returns a common duplicate reply, and honors registration off", async () => {
  expect(await register()).toEqual({ ok: true, data: { status: "accepted" }, seq: null });
  const original = await client.json.get(key(`user:${uid}`));
  expect(original).toMatchObject({ id: uid, email, emailNormalized: email, locale: "en", version: 1, avatarUrl: null });
  expect(await client.get(key(`user-email:${emailDigest}`))).toBe(uid);
  expect(await client.zCard(key("users-by-created"))).toBe(1);
  expect(await register()).toEqual({ ok: true, data: { status: "accepted" }, seq: null });
  expect(await client.json.get(key(`user:${uid}`))).toEqual(original);

  await client.hSet(key("platform-settings"), "registrationEnabled", "0");
  expect(await register()).toEqual({ ok: false, code: "REGISTRATION_DISABLED", params: {} });
  expect(await client.json.get(key(`user:${uid}`))).toEqual(original);
});

it("serializes simultaneous registrations for the same normalized email", async () => {
  const ids = [uid, "usr_01JCS9Y0S7R4XK3X2B8Q8H4V1D"];
  const peer = integrationStore();
  await peer.client.connect();
  const results = await Promise.all(ids.map((id, index) => (index === 0 ? store : peer).call("sh_register_user", [
    key("platform-settings"), key(`user-email:${emailDigest}`), key(`user:${id}`), key("users-by-created"),
  ], [id, emailDigest, email, email, "$argon2id$v=19$m=65536,t=3,p=4$salt$hash", "User"]))).finally(() => peer.close());
  expect(results).toEqual(ids.map(() => ({ ok: true, data: { status: "accepted" }, seq: null })));
  expect(await client.zCard(key("users-by-created"))).toBe(1);
  expect(ids).toContain(await client.get(key(`user-email:${emailDigest}`)));
  expect(Number(await client.exists(key(`user:${ids[0]}`))) + Number(await client.exists(key(`user:${ids[1]}`)))).toBe(1);
});

it("takes fixed-window quota and reports the blocked policy with a positive TTL", async () => {
  const keys = [key(`ratelimit:register:${"c".repeat(64)}`)];
  const args = ["register", "c".repeat(64), ""];
  for (let i = 0; i < 3; i += 1) {
    expect(await call("sh_take_auth_rate_limit", keys, args)).toEqual({ ok: true, data: { blocked: [] }, seq: null });
  }
  expect(await call("sh_take_auth_rate_limit", keys, args)).toMatchObject({
    ok: true, data: { blocked: [{ policy: "register", retryAfter: expect.any(Number) }] }, seq: null,
  });
  const ttl = (await client.ttl(keys[0]));
  expect(ttl).toBeGreaterThan(0);
});

it("creates, touches, updates, replays, and revokes one opaque session", async () => {
  expect((await register()).ok).toBe(true);
  const userKey = key(`user:${uid}`);
  const sessionsIndex = key(`user-sessions:${uid}`);
  const sessionKey = key(`session:${digest}`);
  expect(await call("sh_create_session", [
    key(`user-email:${emailDigest}`), userKey, sessionsIndex, sessionKey,
  ], [uid, emailDigest, digest, "ses_01JCS9Y0S7R4XK3X2B8Q8H4V1B", "", "[]"])).toMatchObject({
    ok: true, data: { id: uid, email, version: 2 }, seq: null,
  });
  expect(await client.sMembers(sessionsIndex)).toEqual([digest]);
  expect(await client.hGet(sessionKey, "userId")).toBe(uid);
  expect(await client.hGet(sessionKey, "expiresAtMs")).toBeTruthy();

  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(await call("sh_touch_session", [sessionKey, sessionsIndex], [uid, digest, "0"])).toEqual({
    ok: true, data: { changed: true }, seq: null,
  });

  const idempotencyKey = "profile-change-1";
  const profileKeys = [sessionKey, userKey, sessionsIndex, key(`idempotency:${uid}:${idempotencyKey}`)];
  const profileArgs = [uid, digest, "2", JSON.stringify({ locale: "vi", avatarUrl: null }), idempotencyKey, "d".repeat(64)];
  const changed = await call("sh_update_my_profile", profileKeys, profileArgs);
  expect(changed).toMatchObject({ ok: true, data: { locale: "vi", avatarUrl: null, version: 3 }, seq: null });
  expect(await call("sh_update_my_profile", profileKeys, profileArgs)).toEqual(changed);
  expect(await client.json.get(userKey)).toMatchObject({ locale: "vi", version: 3 });

  expect(await call("sh_logout_session", [sessionKey, userKey, sessionsIndex], [uid, digest])).toEqual({
    ok: true, data: { changed: true }, seq: null,
  });
  expect(await client.exists(sessionKey)).toBe(0);
  expect(await client.sMembers(sessionsIndex)).toEqual([]);
  expect(await call("sh_touch_session", [sessionKey, sessionsIndex], [uid, digest, "0"])).toEqual({
    ok: true, data: { changed: false }, seq: null,
  });
});

it("revokes an exact bounded session snapshot with logout-all", async () => {
  expect((await register()).ok).toBe(true);
  const index = key(`user-sessions:${uid}`);
  const first = "b".repeat(64);
  const second = "c".repeat(64);
  const create = (tokenDigest: string, publicId: string, snapshot: string[]) => call("sh_create_session", [
    key(`user-email:${emailDigest}`), key(`user:${uid}`), index, key(`session:${tokenDigest}`),
    ...snapshot.map((item) => key(`session:${item}`)),
  ], [uid, emailDigest, tokenDigest, publicId, "", JSON.stringify(snapshot)]);
  expect((await create(first, "ses_01JCS9Y0S7R4XK3X2B8Q8H4V1B", [])).ok).toBe(true);
  expect((await create(second, "ses_01JCS9Y0S7R4XK3X2B8Q8H4V1C", [first])).ok).toBe(true);

  const snapshot = [first, second].sort();
  expect(await call("sh_logout_all_sessions", [
    key(`session:${second}`), key(`user:${uid}`), index, key(`session:${second}`),
  ], [uid, second, JSON.stringify([second])])).toMatchObject({ ok: false, code: 'KEYS_MISMATCH' });
  expect((await client.sMembers(index)).sort()).toEqual(snapshot);
  expect(await call("sh_logout_all_sessions", [
    key(`session:${second}`), key(`user:${uid}`), index,
    ...snapshot.map((item) => key(`session:${item}`)),
  ], [uid, second, JSON.stringify(snapshot)])).toEqual({
    ok: true, data: { changed: true }, seq: null,
  });
  expect(await client.sMembers(index)).toEqual([]);
  expect(await client.exists([key(`session:${first}`), key(`session:${second}`)])).toBe(0);
  expect(await call("sh_logout_all_sessions", [
    key(`session:${second}`), key(`user:${uid}`), index,
  ], [uid, second, "[]"])).toEqual({ ok: true, data: { changed: false }, seq: null });
});

it('keeps other sessions when the calling cookie vanishes after the logout-all pre-read', async () => {
  expect((await register()).ok).toBe(true);
  const ix = key(`user-sessions:${uid}`);
  const user = key(`user:${uid}`);
  const first = 'b'.repeat(64);
  const second = 'c'.repeat(64);
  const session = (d: string) => key(`session:${d}`);
  for (const [offset, tokenDigest] of [first, second].entries()) {
    const prior = offset === 0 ? [] : [first];
    expect((await call('sh_create_session', [
      key(`user-email:${emailDigest}`), user, ix, session(tokenDigest), ...prior.map(session),
    ], [uid, emailDigest, tokenDigest, `ses_01JCS9Y0S7R4XK3X2B8Q8H4V1${offset}`, '', JSON.stringify(prior)])).ok).toBe(true);
  }
  expect(await call('sh_logout_session', [session(first), user, ix], [uid, first]))
    .toMatchObject({ ok: true, data: { changed: true } });
  expect(await call('sh_logout_all_sessions', [session(first), user, ix, session(first), session(second)],
    [uid, first, JSON.stringify([first, second])])).toEqual({ ok: true, data: { changed: false }, seq: null });
  expect(await client.sMembers(ix)).toEqual([second]);
  expect(await client.exists(session(second))).toBe(1);
});
