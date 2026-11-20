import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { makeId } from '../../src/platform/http/request.js';
import { decodeReply } from '../../src/redis/reply.js';
import { integrationStore } from '../support/redis.js';

const store = integrationStore();
const client = store.client;
const prefix = `${store.keys.prefix}task-write-functions:${randomUUID()}:`;
const key = (suffix: string) => `${prefix}${suffix}`;

beforeAll(async () => {
  await client.connect();
});

afterEach(async () => {
  const names: string[] = [];
  for await (const batch of client.scanIterator({ MATCH: `${prefix}*`, COUNT: 100 })) names.push(...batch);
  if (names.length) await client.unlink(names);
});

afterAll(async () => {
  if (client.isOpen) await client.close();
});

async function call(name: string, keys: string[], args: string[]) {
  return decodeReply(await client.fCall(name, { keys, arguments: args }));
}

function meta(label: string): [string, string, string, string, string] {
  return [`idem-${label}`, 'a'.repeat(64), String(Date.now()), `req-${label}`, `mut-${label}`];
}

async function fixture(assigneeId: string | null = null) {
  const owner = makeId('usr');
  const member = makeId('usr');
  const outsider = makeId('usr');
  const ws = makeId('ws');
  const pid = makeId('prj');
  const tid = makeId('tsk');
  const keys = {
    members: key(`workspace-members:${ws}`), workspace: key(`workspace:${ws}`), project: key(`project:${pid}`),
    task: key(`task:${tid}`), projectTasks: key(`project-tasks:${pid}`), board: key(`board:${pid}:TODO`),
    backlog: key(`backlog:${pid}`), ownerAssigned: key(`user-assigned:${owner}`),
    memberAssigned: key(`user-assigned:${member}`), outsiderAssigned: key(`user-assigned:${outsider}`),
    seq: key(`workspace-seq:${ws}`), changes: key(`workspace-changes:${ws}`), events: key('stream:domain-events'),
  };
  await client.multi()
    .hSet(keys.members, { [owner]: 'OWNER', [member]: 'MEMBER' })
    .json.set(keys.workspace, '$', { id: ws, ownerId: owner, suspendedAt: null })
    .json.set(keys.project, '$', { id: pid, workspaceId: ws, key: 'TST', archivedAt: null })
    .json.set(keys.task, '$', {
      id: tid, workspaceId: ws, projectId: pid, number: 1, key: 'TST-1', title: 'Original', description: '',
      descriptionFormat: 'markdown', status: 'TODO', priority: 'MEDIUM', assigneeId, assigneeIndexValue: assigneeId ?? 'UNASSIGNED',
      reporterId: owner, sprintId: null, labelIds: [], dueAtMs: null, createdAt: new Date().toISOString(),
      createdAtMs: Date.now(), deletedAt: null, isDeleted: 'false', lastSeq: 0, lastClientMutationId: 'seed',
      version: 1, schemaVersion: 1,
    })
    .sAdd(keys.projectTasks, tid)
    .zAdd(keys.board, { score: 1024, value: tid })
    .zAdd(keys.backlog, { score: 1, value: tid })
    .exec();
  if (assigneeId === owner) await client.sAdd(keys.ownerAssigned, tid);
  if (assigneeId === member) await client.sAdd(keys.memberAssigned, tid);
  const common = (actor = owner, old = assigneeId ?? '', next = old, expected = 1, payload: unknown = { title: 'Original' }, label = 'one') => [
    ws, pid, tid, actor, old, next, String(expected), JSON.stringify(payload), ...meta(label),
  ];
  const outbox = (idem: string) => [keys.seq, keys.changes, keys.events, key(`idempotency:${owner}:${idem}`)];
  const updateKeys = (old: string, next: string, idem: string) => [keys.members, keys.workspace, keys.project, keys.task,
    key(`user-assigned:${old || 'none'}`), key(`user-assigned:${next || 'none'}`), ...outbox(idem)];
  const deleteKeys = (old: string, idem: string) => [keys.members, keys.workspace, keys.project, keys.task,
    keys.projectTasks, keys.board, keys.backlog, key(`user-assigned:${old || 'none'}`), ...outbox(idem)];
  return { owner, member, outsider, ws, pid, tid, keys, common, updateKeys, deleteKeys };
}

it('updates and assigns with reverse-index changes, then replays through archived tombstone', async () => {
  const f = await fixture();
  const updateMeta = meta('updated');
  const updateArgs = [f.ws, f.pid, f.tid, f.owner, '', f.member, '1', JSON.stringify({ title: 'Renamed', assigneeId: f.member }), ...updateMeta];
  const updateIdem = updateMeta[0];
  const updateKeys = f.updateKeys('', f.member, updateIdem);
  const updated = await call('sh_update_task', updateKeys, updateArgs);
  expect(updated).toMatchObject({ ok: true, data: { title: 'Renamed', assigneeId: f.member, version: 2 }, seq: 1 });
  expect(await client.sMembers(f.keys.memberAssigned)).toEqual([f.tid]);

  const deletionMeta = meta('deleted-after-update');
  const deletionIdem = deletionMeta[0];
  const deletionArgs = [f.ws, f.pid, f.tid, f.owner, 'TODO', f.member, '2', ...deletionMeta];
  const deletionKeys = f.deleteKeys(f.member, deletionIdem);
  const deleted = await call('sh_delete_task', deletionKeys, deletionArgs);
  expect(deleted).toMatchObject({ ok: true, data: { deletedAt: expect.any(String), isDeleted: 'true', version: 3 }, seq: 2 });
  await client.json.set(f.keys.project, '$.archivedAt', new Date().toISOString());
  expect(await call('sh_delete_task', deletionKeys, deletionArgs)).toEqual(deleted);
  expect(Boolean(await client.sIsMember(f.keys.projectTasks, f.tid))).toBe(false);
  expect(await client.zScore(f.keys.board, f.tid)).toBeNull();
  expect(await client.zScore(f.keys.backlog, f.tid)).toBeNull();
  expect(Boolean(await client.sIsMember(f.keys.memberAssigned, f.tid))).toBe(false);
  expect(await call('sh_update_task', updateKeys, updateArgs)).toEqual(updated);
});

it('uses expectedVersion to serialize concurrent assign and unassign calls', async () => {
  const f = await fixture();
  const peer = integrationStore();
  await peer.client.connect();
  try {
    const metaA = meta('assign-race');
    const metaB = meta('unassign-race');
    const argsA = [f.ws, f.pid, f.tid, f.owner, '', f.member, '1', JSON.stringify({ assigneeId: f.member }), ...metaA];
    const argsB = [f.ws, f.pid, f.tid, f.owner, '', '', '1', JSON.stringify({ assigneeId: null }), ...metaB];
    const keysA = f.updateKeys('', f.member, metaA[0]);
    const keysB = f.updateKeys('', '', metaB[0]);
    const results = await Promise.all([
      call('sh_assign_task', keysA, argsA),
      peer.client.fCall('sh_assign_task', { keys: keysB, arguments: argsB }).then(decodeReply),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.code === 'TASK_VERSION_CONFLICT')).toHaveLength(1);
    const task = await client.json.get(f.keys.task) as { assigneeId: string | null };
    expect(task.assigneeId === f.member ? Boolean(await client.sIsMember(f.keys.memberAssigned, f.tid)) : false)
      .toBe(task.assigneeId === f.member);
  } finally {
    await peer.client.close();
  }
});

it('allows a non-assignment patch when the task retains a now-removed assignee', async () => {
  const f = await fixture();
  await client.json.set(f.keys.task, '$.assigneeId', f.member);
  await client.json.set(f.keys.task, '$.assigneeIndexValue', f.member);
  await client.sAdd(f.keys.memberAssigned, f.tid);
  await client.hDel(f.keys.members, f.member);
  const metaArgs = meta('removed-assignee-title-update');
  const args = [f.ws, f.pid, f.tid, f.owner, f.member, f.member, '1', JSON.stringify({ title: 'Still assigned' }), ...metaArgs];
  expect(await call('sh_update_task', f.updateKeys(f.member, f.member, metaArgs[0]), args))
    .toMatchObject({ ok: true, data: { title: 'Still assigned', assigneeId: f.member, version: 2 } });
  expect(Boolean(await client.sIsMember(f.keys.memberAssigned, f.tid))).toBe(true);
});

it('rejects tenant, membership, malformed payload, and key preflight before any writes', async () => {
  const f = await fixture();
  const m = meta('invalid');
  const idem = m[0];
  const args = [f.ws, f.pid, f.tid, f.owner, '', f.outsider, '1', JSON.stringify({ assigneeId: f.outsider }), ...m];
  const keys = f.updateKeys('', f.outsider, idem);
  expect(await call('sh_assign_task', keys, args)).toMatchObject({ ok: false, code: 'ASSIGNEE_NOT_MEMBER' });
  const wrongKeys = [...keys];
  wrongKeys[2] = key(`project:${makeId('prj')}`);
  expect(await call('sh_assign_task', wrongKeys, args)).toMatchObject({ ok: false, code: 'KEYS_MISMATCH' });
  const invalidTitle = [...args];
  const invalidMeta = meta('invalid-title');
  invalidTitle.splice(8, 5, ...invalidMeta);
  invalidTitle[5] = '';
  invalidTitle[7] = JSON.stringify({ title: '   ' });
  expect(await call('sh_update_task', f.updateKeys('', '', invalidMeta[0]), invalidTitle))
    .toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
  expect(await client.json.get(f.keys.task)).toMatchObject({ version: 1, title: 'Original', assigneeId: null });
  expect(await client.get(f.keys.seq)).toBeNull();
  expect(await client.xLen(f.keys.events)).toBe(0);
});

it('keeps delete safe for a legacy task whose backlog member is already absent', async () => {
  const f = await fixture();
  await client.zRem(f.keys.backlog, f.tid);
  const m = meta('legacy-delete');
  const args = [f.ws, f.pid, f.tid, f.owner, 'TODO', '', '1', ...m];
  const keys = f.deleteKeys('', m[0]);
  expect(await call('sh_delete_task', keys, args)).toMatchObject({ ok: true });
  expect(await client.exists(f.keys.backlog)).toBe(0);
});
