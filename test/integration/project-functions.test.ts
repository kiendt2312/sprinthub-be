import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { makeId } from '../../src/platform/http/request.js';
import { decodeReply } from '../../src/redis/reply.js';
import { integrationStore } from '../support/redis.js';

const store = integrationStore();
const client = store.client;
const prefix = `${store.keys.prefix}project-functions:${randomUUID()}:`;
const key = (suffix: string) => `${prefix}${suffix}`;

type WorkspaceFixture = {
  workspaceId: string;
  ownerId: string;
  adminId: string;
  memberId: string;
};

function mutation(suffix: string, now = Date.now()) {
  return [`idem-${suffix}`, 'a'.repeat(64), String(now), `req-${suffix}`, `mutation-${suffix}`];
}

function createKeysForProject(w: WorkspaceFixture, projectId: string, projectKey: string, idem: string,
  actorId = w.ownerId) {
  return [key(`workspace-members:${w.workspaceId}`), key(`workspace:${w.workspaceId}`), key(`project:${projectId}`),
    key(`workspace-projects:${w.workspaceId}`), key(`workspace-projects-page:${w.workspaceId}`),
    key(`project-key:${w.workspaceId}:${projectKey}`), key(`workspace-seq:${w.workspaceId}`),
    key(`workspace-changes:${w.workspaceId}`), key('stream:domain-events'), key(`idempotency:${actorId}:${idem}`)];
}

function updateKeysForProject(w: WorkspaceFixture, projectId: string, oldKey: string, newKey: string, idem: string,
  actorId = w.ownerId) {
  return [key(`workspace-members:${w.workspaceId}`), key(`workspace:${w.workspaceId}`), key(`project:${projectId}`),
    key(`project-key:${w.workspaceId}:${oldKey}`), key(`project-key:${w.workspaceId}:${newKey}`),
    key(`project-task-seq:${projectId}`), key(`workspace-seq:${w.workspaceId}`),
    key(`workspace-changes:${w.workspaceId}`), key('stream:domain-events'), key(`idempotency:${actorId}:${idem}`)];
}

async function call(name: string, keys: string[], args: string[], redis = client) {
  return decodeReply(await redis.fCall(name, { keys, arguments: args }));
}

async function seedWorkspace() {
  const fixture = {
    workspaceId: makeId('ws'), ownerId: makeId('usr'), adminId: makeId('usr'), memberId: makeId('usr'),
  };
  const now = Date.now();
  await client.json.set(key(`workspace:${fixture.workspaceId}`), '$', {
    id: fixture.workspaceId, name: 'Test workspace', slug: `ws-${randomUUID().slice(0, 8)}`,
    ownerId: fixture.ownerId, createdAt: new Date(now).toISOString(), createdAtMs: now,
    archivedAt: null, suspendedAt: null, suspendedBy: null, version: 1, schemaVersion: 1,
  });
  await client.hSet(key(`workspace-members:${fixture.workspaceId}`), {
    [fixture.ownerId]: 'OWNER', [fixture.adminId]: 'ADMIN', [fixture.memberId]: 'MEMBER',
  });
  return fixture;
}

async function createProject(w: WorkspaceFixture, projectKey = 'PRJ', suffix: string = randomUUID(), redis = client) {
  const projectId = makeId('prj');
  const meta = mutation(suffix);
  const keys = createKeysForProject(w, projectId, projectKey, meta[0]);
  const args = [w.workspaceId, projectId, w.ownerId, projectKey, 'Project', '', ...meta];
  return { projectId, keys, args, meta, reply: await call('sh_create_project', keys, args, redis) };
}

function updateArgs(w: WorkspaceFixture, projectId: string, oldKey: string, newKey: string,
  mode: string, expectedVersion: number, patch: Record<string, unknown>, meta: string[]) {
  return [w.workspaceId, projectId, w.ownerId, oldKey, newKey, mode, String(expectedVersion), JSON.stringify(patch), ...meta];
}

async function updateProject(w: WorkspaceFixture, projectId: string, oldKey: string, newKey: string,
  mode: string, expectedVersion: number, patch: Record<string, unknown>, suffix: string = randomUUID()) {
  const meta = mutation(suffix);
  const keys = updateKeysForProject(w, projectId, oldKey, newKey, meta[0]);
  const args = updateArgs(w, projectId, oldKey, newKey, mode, expectedVersion, patch, meta);
  return { keys, args, meta, reply: await call('sh_update_project', keys, args) };
}

beforeAll(async () => {
  await client.connect();
  expect(await client.fCallRo('sh_lib_version')).toBe(5);
});

afterEach(async () => {
  const names: string[] = [];
  for await (const batch of client.scanIterator({ MATCH: `${prefix}*`, COUNT: 100 })) names.push(...batch);
  if (names.length) await client.unlink(names);
});

afterAll(async () => {
  if (client.isOpen) await client.close();
});

it('creates project attributes and both indexes atomically, emits a unique-field event, and replays', async () => {
  const w = await seedWorkspace();
  const created = await createProject(w, 'TEAM42', 'create-project');
  expect(created.reply).toMatchObject({ ok: true, seq: 1, data: {
    id: created.projectId, workspaceId: w.workspaceId, name: 'Project', key: 'TEAM42', description: '',
    createdBy: w.ownerId, version: 1, archivedAt: null,
  } });
  expect(await client.sMembers(key(`workspace-projects:${w.workspaceId}`))).toEqual([created.projectId]);
  expect(await client.zRange(key(`workspace-projects-page:${w.workspaceId}`), 0, -1)).toEqual([created.projectId]);
  expect(await client.get(key(`project-key:${w.workspaceId}:TEAM42`))).toBe(created.projectId);
  expect(await call('sh_create_project', created.keys, created.args)).toEqual(created.reply);
  expect(await client.get(key(`workspace-seq:${w.workspaceId}`))).toBe('1');

  const raw = await client.sendCommand(['XRANGE', key('stream:domain-events'), '-', '+']) as unknown[][];
  const fields = raw[0][1] as string[];
  const names = fields.filter((_value, index) => index % 2 === 0);
  expect(new Set(names).size).toBe(names.length);
  expect(names.filter((field) => field === 'entityVersion')).toHaveLength(1);
  expect(names.filter((field) => field === 'clientMutationId')).toHaveLength(1);
  expect(fields).toContain('projectId');
  expect(fields).toContain(created.projectId);
});

it('serializes competing same-key creates on separate Redis connections and scopes keys by workspace', async () => {
  const w = await seedWorkspace();
  const peer = integrationStore();
  await peer.client.connect();
  try {
    const candidates = [w.ownerId, w.adminId].map(async (actor, index) => {
      const projectId = makeId('prj');
      const meta = mutation(`race-${index}`);
      const keys = createKeysForProject(w, projectId, 'SHARED', meta[0], actor);
      const args = [w.workspaceId, projectId, actor, 'SHARED', `Project ${index}`, '', ...meta];
      return call('sh_create_project', keys, args, index === 0 ? client : peer.client);
    });
    const replies = await Promise.all(candidates);
    expect(replies.filter((reply) => reply.ok)).toHaveLength(1);
    expect(replies.filter((reply) => !reply.ok && reply.code === 'PROJECT_KEY_TAKEN')).toHaveLength(1);
    expect(await client.xLen(key('stream:domain-events'))).toBe(1);

    const other = await seedWorkspace();
    const sameKey = await createProject(other, 'SHARED', 'other-workspace-same-key');
    expect(sameKey.reply.ok).toBe(true);
  } finally {
    await peer.client.close();
  }
});

it('rejects caller KEYS drift and preflights every write target before changing state', async () => {
  const w = await seedWorkspace();
  const projectId = makeId('prj');
  const meta = mutation('bad-key');
  const keys = createKeysForProject(w, projectId, 'VALID', meta[0]);
  const args = [w.workspaceId, projectId, w.ownerId, 'VALID', 'Project', '', ...meta];
  const drifted = [...keys];
  drifted[4] = key(`workspace-projects-page:${makeId('ws')}`);
  expect(await call('sh_create_project', drifted, args)).toMatchObject({ ok: false, code: 'KEYS_MISMATCH' });
  expect(await client.exists(key(`project:${projectId}`))).toBe(0);

  await client.set(keys[4], 'wrong-type');
  await expect(client.fCall('sh_create_project', { keys, arguments: args })).rejects.toThrow();
  expect(await client.exists(keys[2])).toBe(0);
  expect(await client.get(keys[6])).toBeNull();
});

it('enforces role, workspace suspension, replay, and archive rules inside the Function', async () => {
  const w = await seedWorkspace();
  const memberId = makeId('prj');
  const memberMeta = mutation('member-create');
  const memberKeys = createKeysForProject(w, memberId, 'MEM', memberMeta[0], w.memberId);
  const memberArgs = [w.workspaceId, memberId, w.memberId, 'MEM', 'Project', '', ...memberMeta];
  expect(await call('sh_create_project', memberKeys, memberArgs)).toMatchObject({ ok: false, code: 'FORBIDDEN' });
  const outsider = makeId('usr');
  const outsiderArgs = [w.workspaceId, makeId('prj'), outsider, 'OUT', 'Project', '', ...mutation('outsider')];
  const outsiderKeys = createKeysForProject(w, outsiderArgs[1], 'OUT', outsiderArgs[6], outsider);
  expect(await call('sh_create_project', outsiderKeys, outsiderArgs)).toMatchObject({ ok: false, code: 'NOT_FOUND' });

  const created = await createProject(w, 'ARCH', 'archive-create');
  const archive = await updateProject(w, created.projectId, 'ARCH', 'ARCH', 'archive', 1, {}, 'archive-one');
  expect(archive.reply).toMatchObject({ ok: true, seq: 2, data: { version: 2, archivedAt: expect.any(String) } });
  expect(await client.get(key(`project-key:${w.workspaceId}:ARCH`))).toBe(created.projectId);

  const retry = await call('sh_update_project', archive.keys, archive.args);
  expect(retry).toEqual(archive.reply);
  expect(await updateProject(w, created.projectId, 'ARCH', 'ARCH', 'update', 2, { name: 'Later' }, 'archived-update'))
    .toMatchObject({ reply: { ok: false, code: 'PROJECT_ARCHIVED' } });

  await client.json.set(key(`workspace:${w.workspaceId}`), '$.suspendedAt', new Date().toISOString());
  expect(await call('sh_update_project', archive.keys, archive.args)).toEqual(archive.reply);
  const freshMeta = mutation('suspended-new-write');
  const freshKeys = updateKeysForProject(w, created.projectId, 'ARCH', 'ARCH', freshMeta[0]);
  expect(await call('sh_update_project', freshKeys,
    updateArgs(w, created.projectId, 'ARCH', 'ARCH', 'unarchive', 2, {}, freshMeta)))
    .toMatchObject({ ok: false, code: 'WORKSPACE_SUSPENDED' });
});

it('keeps expectedVersion checks for no-op unarchive and resolves concurrent updates once', async () => {
  const w = await seedWorkspace();
  const created = await createProject(w, 'VER', 'version-create');
  const peer = integrationStore();
  await peer.client.connect();
  try {
    const attempts = [0, 1].map(async (index) => {
      const meta = mutation(`version-race-${index}`);
      const keys = updateKeysForProject(w, created.projectId, 'VER', 'VER', meta[0]);
      const args = updateArgs(w, created.projectId, 'VER', 'VER', 'update', 1, { name: `Name ${index}` }, meta);
      return call('sh_update_project', keys, args, index === 0 ? client : peer.client);
    });
    const replies = await Promise.all(attempts);
    expect(replies.filter((reply) => reply.ok)).toHaveLength(1);
    expect(replies.filter((reply) => !reply.ok && reply.code === 'PROJECT_VERSION_CONFLICT'))
      .toHaveLength(1);
  } finally {
    await peer.client.close();
  }

  const current = await client.json.get(key(`project:${created.projectId}`)) as { version: number; key: string; archivedAt: unknown };
  await client.json.set(key(`project:${created.projectId}`), '$.archivedAt', new Date().toISOString());
  const unarchive = await updateProject(w, created.projectId, current.key, current.key,
    'unarchive', current.version, {}, 'unarchive-once');
  expect(unarchive.reply).toMatchObject({ ok: true, data: { version: current.version + 1, archivedAt: null } });

  const noOpMeta = mutation('unarchive-noop');
  const noOpKeys = updateKeysForProject(w, created.projectId, current.key, current.key, noOpMeta[0]);
  const noOpArgs = updateArgs(w, created.projectId, current.key, current.key, 'unarchive', current.version + 1, {}, noOpMeta);
  const noOp = await call('sh_update_project', noOpKeys, noOpArgs);
  expect(noOp).toMatchObject({ ok: true, seq: unarchive.reply.ok ? unarchive.reply.seq : -1,
    data: { version: current.version + 1, archivedAt: null } });
  expect(await call('sh_update_project', noOpKeys, noOpArgs)).toEqual(noOp);

  const staleMeta = mutation('unarchive-stale');
  const staleKeys = updateKeysForProject(w, created.projectId, current.key, current.key, staleMeta[0]);
  expect(await call('sh_update_project', staleKeys,
    updateArgs(w, created.projectId, current.key, current.key, 'unarchive', current.version, {}, staleMeta)))
    .toMatchObject({ ok: false, code: 'PROJECT_VERSION_CONFLICT', params: { currentVersion: current.version + 1 } });
});

it('releases a project key only while its durable task counter is zero, including tombstones', async () => {
  const w = await seedWorkspace();
  const unused = await createProject(w, 'OLD', 'unused-key');
  const rename = await updateProject(w, unused.projectId, 'OLD', 'NEW', 'update', 1, {}, 'key-change-empty');
  expect(rename.reply).toMatchObject({ ok: true, data: { key: 'NEW', version: 2 } });
  expect(await client.get(key(`project-key:${w.workspaceId}:OLD`))).toBeNull();
  expect(await client.get(key(`project-key:${w.workspaceId}:NEW`))).toBe(unused.projectId);

  const used = await createProject(w, 'USED', 'used-key');
  const tombstoneId = makeId('tsk');
  await client.set(key(`project-task-seq:${used.projectId}`), '1');
  await client.json.set(key(`task:${tombstoneId}`), '$', {
    id: tombstoneId, workspaceId: w.workspaceId, projectId: used.projectId, number: 1,
    key: 'USED-1', deletedAt: new Date().toISOString(), isDeleted: 'true', version: 2,
  });
  const immutable = await updateProject(w, used.projectId, 'USED', 'NEXT', 'update', 1, {}, 'key-change-tombstone');
  expect(immutable.reply).toMatchObject({ ok: false, code: 'PROJECT_KEY_IMMUTABLE' });
  expect(await client.get(key(`project-key:${w.workspaceId}:USED`))).toBe(used.projectId);
  expect(await client.get(key(`project-key:${w.workspaceId}:NEXT`))).toBeNull();
});
