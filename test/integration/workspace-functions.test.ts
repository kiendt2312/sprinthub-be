import assert from "node:assert/strict";
import { randomUUID } from 'node:crypto';
import { decodeReply } from '../../src/redis/reply.js';
import { createKeys } from '../../src/redis/keys.js';
import { verifyWorkspaceIndexes } from '../../scripts/verify-workspace-indexes.js';
import { integrationStore } from '../support/redis.js';
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

const store = integrationStore();
const client = store.client;
const prefix = `${store.keys.prefix}workspace-functions:${randomUUID()}:`;
const key = (suffix: string) => `${prefix}${suffix}`;
const owner = "usr_01JCS9Y0S7R4XK3X2B8Q8H4V1A";
const admin = "usr_01JCS9Y0S7R4XK3X2B8Q8H4V1B";
const member = "usr_01JCS9Y0S7R4XK3X2B8Q8H4V1C";
const ownerWs = "ws_01JCS9Y0S7R4XK3X2B8Q8H4V1A";
const otherWs = "ws_01JCS9Y0S7R4XK3X2B8Q8H4V1B";

async function call(name: string, keys: string[], args: string[] = []) {
  const raw = await client.fCall(name, { keys, arguments: args });
  assert.equal(typeof raw, "string");
  return decodeReply(raw);
}

function mutation(suffix: string, now = Date.now()) {
  return [`idem-${suffix}`, "a".repeat(64), String(now), `req-${suffix}`, `mutation-${suffix}`];
}

function createWorkspaceFunctionKeys(ws: string, actor: string, slug: string, idem: string) {
  return [key(`workspace-members:${ws}`), key(`workspace:${ws}`), key(`user-workspaces:${actor}`),
    key(`user-workspaces-page:${actor}`), key(`workspace-members-page:${ws}`), key(`workspace-slug:${slug}`),
    key("workspaces-by-created"), key(`user:${actor}`), key(`workspace-seq:${ws}`),
    key(`workspace-changes:${ws}`), key("stream:domain-events"), key(`idempotency:${actor}:${idem}`)];
}

async function seedUser(userId: string) {
  await client.json.set(key(`user:${userId}`), "$", {
    id: userId, email: `${userId}@example.test`, displayName: "Test user", disabledAt: null, version: 1,
  });
}

async function createWorkspace(ws: string, actor: string, slug: string, idem: string) {
  await seedUser(actor);
  const meta = mutation(idem);
  const keys = createWorkspaceFunctionKeys(ws, actor, slug, meta[0]);
  const args = [ws, actor, "Workspace", slug, ...meta];
  return { keys, args, reply: await call("sh_create_workspace", keys, args) };
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

it("creates workspace, keeps indexes reciprocal, and replays the exact response", async () => {
  const created = await createWorkspace(ownerWs, owner, "team-one", "create-one");
  expect(created.reply).toMatchObject({ ok: true, data: {
    id: ownerWs, name: "Workspace", slug: "team-one", ownerId: owner, role: "OWNER", version: 1,
  }, seq: 1 });
  expect(await client.hGet(created.keys[0], owner)).toBe("OWNER");
  expect(await client.sMembers(created.keys[2])).toEqual([ownerWs]);
  expect(await client.zRange(created.keys[3], 0, -1)).toEqual([ownerWs]);
  expect(await client.zRange(created.keys[4], 0, -1)).toEqual([owner]);
  expect(await client.get(created.keys[5])).toBe(ownerWs);
  expect(await client.zScore(created.keys[6], ownerWs)).toBeGreaterThan(0);
  expect((await verifyWorkspaceIndexes(client, createKeys(prefix))).ok).toBe(true);
  await client.zAdd(created.keys[3], { score: 0, value: "ws_01JCS9Y0S7R4XK3X2B8Q8H4V1D" });
  expect((await verifyWorkspaceIndexes(client, createKeys(prefix))).findings)
    .toContainEqual(expect.objectContaining({ type: "orphan", index: created.keys[3] }));
  await client.zRem(created.keys[3], "ws_01JCS9Y0S7R4XK3X2B8Q8H4V1D");
  expect(await call("sh_create_workspace", created.keys, created.args)).toEqual(created.reply);
  expect(await client.xLen(key("stream:domain-events"))).toBe(1);
});

it("rejects incorrect keys before writing and serializes expectedVersion", async () => {
  const created = await createWorkspace(ownerWs, owner, "team-one", "create-one");
  const badKeys = [...created.keys];
  badKeys[1] = key(`workspace:${otherWs}`);
  const badReply = await call("sh_create_workspace", badKeys, created.args);
  expect(badReply).toMatchObject({ ok: false, code: "KEYS_MISMATCH" });
  expect(await client.json.get(created.keys[1])).toMatchObject({ id: ownerWs, version: 1 });

  const peer = integrationStore();
  await peer.client.connect();
  try {
    const race = [0, 1].map(async (index) => {
      const meta = mutation(`version${index}`);
      const keys = [created.keys[0], created.keys[1], created.keys[5], created.keys[5],
        key(`workspace-seq:${ownerWs}`), key(`workspace-changes:${ownerWs}`), key("stream:domain-events"),
        key(`idempotency:${owner}:${meta[0]}`)];
      const args = [ownerWs, owner, "team-one", "team-one", "1", `Name ${index}`, "", ...meta];
      const raw = index === 0
        ? await client.fCall("sh_update_workspace", { keys, arguments: args })
        : await peer.client.fCall("sh_update_workspace", { keys, arguments: args });
      return decodeReply(raw);
    });
    const results = await Promise.all(race);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.code === "WORKSPACE_VERSION_CONFLICT")).toHaveLength(1);
    expect(await client.json.get(created.keys[1])).toMatchObject({ version: 2 });
  } finally {
    await peer.client.close();
  }
});

it("serializes same-slug creates on separate Redis connections", async () => {
  const peer = integrationStore();
  await peer.client.connect();
  try {
    await seedUser(owner);
    await seedUser(admin);
    const calls = [
      { ws: ownerWs, actor: owner, call: (keys: string[], args: string[]) => call("sh_create_workspace", keys, args) },
      { ws: otherWs, actor: admin, call: (keys: string[], args: string[]) => peer.client.fCall("sh_create_workspace", { keys, arguments: args }).then(decodeReply) },
    ].map(async ({ ws, actor, call: invoke }, index) => {
      const meta = mutation(`race${index}`);
      const keys = createWorkspaceFunctionKeys(ws, actor, "shared-slug", meta[0]);
      return invoke(keys, [ws, actor, "Workspace", "shared-slug", ...meta]);
    });
    const results = await Promise.all(calls);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.code === "WORKSPACE_SLUG_TAKEN")).toHaveLength(1);
    expect(await client.get(key("workspace-slug:shared-slug"))).toBeTruthy();
    expect(await client.xLen(key("stream:domain-events"))).toBe(1);
  } finally {
    await peer.client.close();
  }
});

it("validates missing email targets in-function and detects resolver key drift", async () => {
  await createWorkspace(ownerWs, owner, "team-one", "create-one");
  const digest = "b".repeat(64);
  const keys = [key(`workspace-members:${ownerWs}`), key(`workspace:${ownerWs}`), key("user-workspaces:none"),
    key("user-workspaces-page:none"), key(`workspace-members-page:${ownerWs}`), key("user:none"),
    key(`user-email:${digest}`), key(`workspace-seq:${ownerWs}`), key(`workspace-changes:${ownerWs}`),
    key("stream:domain-events"), key(`idempotency:${owner}:idem-add-missing`)];
  expect(await call("sh_add_workspace_member", keys,
    [ownerWs, owner, "", digest, ...mutation("add-missing")])).toMatchObject({ ok: false, code: "NOT_FOUND" });
  await client.set(keys[6], member);
  keys[10] = key(`idempotency:${owner}:idem-add-raced`);
  expect(await call("sh_add_workspace_member", keys,
    [ownerWs, owner, "", digest, ...mutation("add-raced")])).toMatchObject({ ok: false, code: "KEYS_MISMATCH" });
  expect(await client.hLen(keys[0])).toBe(1);
});

it("preserves replay on suspend and keeps ownership transfer atomic", async () => {
  const created = await createWorkspace(ownerWs, owner, "team-one", "create-one");
  await seedUser(member);
  const addMeta = mutation("add-member");
  const addKeys = [created.keys[0], created.keys[1], key(`user-workspaces:${member}`),
    key(`user-workspaces-page:${member}`), key(`workspace-members-page:${ownerWs}`), key(`user:${member}`),
    key("user-email:none"), key(`workspace-seq:${ownerWs}`), key(`workspace-changes:${ownerWs}`),
    key("stream:domain-events"), key(`idempotency:${owner}:${addMeta[0]}`)];
  expect(await call("sh_add_workspace_member", addKeys,
    [ownerWs, owner, member, "", ...addMeta])).toMatchObject({ ok: true, data: { userId: member, role: "MEMBER" } });

  const transferMeta = mutation("transfer");
  const transferKeys = [created.keys[0], created.keys[1], key(`workspace-seq:${ownerWs}`),
    key(`workspace-changes:${ownerWs}`), key("stream:domain-events"), key(`idempotency:${owner}:${transferMeta[0]}`)];
  const transferArgs = [ownerWs, owner, member, ...transferMeta];
  const transferred = await call("sh_transfer_workspace_owner", transferKeys, transferArgs);
  expect(transferred).toMatchObject({ ok: true, data: { ownerId: member, role: "ADMIN" } });
  expect(await client.hGet(created.keys[0], owner)).toBe("ADMIN");
  expect(await client.hGet(created.keys[0], member)).toBe("OWNER");
  expect(await call("sh_transfer_workspace_owner", transferKeys, transferArgs)).toEqual(transferred);

  const workspace = await client.json.get(created.keys[1]) as Record<string, unknown>;
  await client.json.set(created.keys[1], "$", { ...workspace, suspendedAt: "2026-11-20T00:00:00.000Z" });
  const updateMeta = mutation("suspended");
  const updateKeys = [created.keys[0], created.keys[1], key("workspace-slug:team-one"), key("workspace-slug:team-one"),
    key(`workspace-seq:${ownerWs}`), key(`workspace-changes:${ownerWs}`), key("stream:domain-events"),
    key(`idempotency:${member}:${updateMeta[0]}`)];
  expect(await call("sh_update_workspace", updateKeys,
    [ownerWs, member, "team-one", "team-one", "2", "Changed", "", ...updateMeta]))
    .toMatchObject({ ok: false, code: "WORKSPACE_SUSPENDED" });
  expect(await call("sh_create_workspace", created.keys, created.args)).toEqual(created.reply);
});
