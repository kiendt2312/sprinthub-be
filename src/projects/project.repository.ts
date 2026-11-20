import { Injectable } from '@nestjs/common';
import { RedisFailure, RedisStore } from '../redis/client.js';

@Injectable()
export class ProjectRepository {
  constructor(private readonly redis: RedisStore) {}

  create(input: { workspaceId: string; projectId: string; actorId: string; key: string; name: string; description: string; meta: MutationMetadata }) {
    const { keys } = this.redis;
    const { workspaceId: wid, projectId: pid, actorId, key, name, description, meta } = input;
    return this.redis.callWorkspace('sh_create_project', [keys.workspaceMembers(wid), keys.workspace(wid), keys.project(pid),
      keys.workspaceProjects(wid), keys.workspaceProjectsPage(wid), keys.projectKey(wid, key), keys.workspaceSeq(wid),
      keys.workspaceChanges(wid), keys.domainEvents(), keys.idempotency(actorId, meta.idem)],
    [wid, pid, actorId, key, name, description, ...mutationArgs(meta)]);
  }

  async get(id: string, actorId: string) {
    const { keys } = this.redis;
    if (!PROJECT_ID.test(id)) return { document: null, role: null, seq: null };
    const [raw] = pipelineRows(await this.redis.read((client) => client.multi()
      .json.get(keys.project(id)).execAsPipeline()), 1);
    const doc = asObjectOrNull(raw);
    if (!doc || doc.id !== id || typeof doc.workspaceId !== 'string' || !WORKSPACE_ID.test(doc.workspaceId)) {
      return { document: null, role: null, seq: null };
    }
    const result = pipelineRows(await this.redis.read((client) => client.multi()
      .json.get(keys.workspace(doc.workspaceId as string))
      .hGet(keys.workspaceMembers(doc.workspaceId as string), actorId)
      .get(keys.workspaceSeq(doc.workspaceId as string)).execAsPipeline()), 3);
    const workspace = asObjectOrNull(result[0]);
    return { document: workspace?.id === doc.workspaceId ? doc : null,
      role: stringOrNull(result[1]), seq: safeInteger(result[2]) };
  }

  async listIds(wid: string, after: string | null, count: number) {
    const start = after === null ? '-' : `(${after}`;
    const rows = await this.redis.read((client) => client.multi()
      .zRange(this.redis.keys.workspaceProjectsPage(wid), start, '+', { BY: 'LEX', LIMIT: { offset: 0, count } })
      .execAsPipeline());
    const [ids] = pipelineRows(rows, 1);
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) throw new RedisFailure('INTERNAL_ERROR');
    return ids;
  }

  async hasIdsAfter(wid: string, after: string) {
    const ids = await this.listIds(wid, after, 1);
    return ids.length > 0;
  }

  async getWorkspaceAccess(wid: string, actorId: string) {
    const { keys } = this.redis;
    const result = pipelineRows(await this.redis.read((client) => client.multi()
      .json.get(keys.workspace(wid)).hGet(keys.workspaceMembers(wid), actorId).execAsPipeline()), 2);
    return { workspace: asObjectOrNull(result[0]), role: stringOrNull(result[1]) };
  }

  async getMany(wid: string, actorId: string, ids: string[]) {
    if (ids.length === 0) return { workspace: null, role: null, seq: null, rows: [] as Array<Record<string, unknown> | null> };
    const { keys } = this.redis;
    const result = pipelineRows(await this.redis.read((client) => {
      const tx = client.multi();
      tx.json.get(keys.workspace(wid));
      tx.hGet(keys.workspaceMembers(wid), actorId);
      tx.get(keys.workspaceSeq(wid));
      for (const id of ids) tx.json.get(keys.project(id));
      return tx.execAsPipeline();
    }), ids.length + 3);
    return { workspace: asObjectOrNull(result[0]), role: stringOrNull(result[1]), seq: safeInteger(result[2]),
      rows: result.slice(3).map(asObjectOrNull) };
  }

  update(wid: string, pid: string, actor: string, input: { expectedVersion: number; name?: string; key?: string; description?: string }, mode: 'update' | 'archive' | 'unarchive', meta: MutationMetadata) {
    const { keys } = this.redis;
    return this.redis.withKeySnapshot(async (deadline) => {
      const [raw] = pipelineRows(await this.redis.read((client) => client.multi()
        .json.get(keys.project(pid)).execAsPipeline(), deadline));
      const doc = asObjectOrNull(raw);
      if (!doc || doc.id !== pid || doc.workspaceId !== wid || !WORKSPACE_ID.test(wid) || typeof doc.key !== 'string') {
        return { ok: false as const, code: 'NOT_FOUND', params: {} };
      }
      const oldKey = doc.key;
      const nextKey = input.key ?? oldKey;
      return this.redis.callWorkspace('sh_update_project', [keys.workspaceMembers(wid), keys.workspace(wid), keys.project(pid),
        keys.projectKey(wid, oldKey), keys.projectKey(wid, nextKey), keys.projectTaskSeq(pid), keys.workspaceSeq(wid),
        keys.workspaceChanges(wid), keys.domainEvents(), keys.idempotency(actor, meta.idem)],
      [wid, pid, actor, oldKey, nextKey, mode, String(input.expectedVersion), JSON.stringify({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined ? {} : { description: input.description }),
      }), ...mutationArgs(meta)], deadline);
    });
  }
}

export interface MutationMetadata { idem: string; hash: string; nowMs: number; requestId: string; mutationId: string }
const PROJECT_ID = /^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const WORKSPACE_ID = /^ws_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
function mutationArgs(meta: MutationMetadata) {
  return [meta.idem, meta.hash, String(meta.nowMs), meta.requestId, meta.mutationId];
}
function pipelineRows(value: unknown, expectedLength?: number): unknown[] {
  if (!Array.isArray(value) || (expectedLength !== undefined && value.length !== expectedLength)) {
    throw new RedisFailure('INTERNAL_ERROR');
  }
  return value;
}
function asObjectOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function stringOrNull(value: unknown) { return typeof value === 'string' ? value : null; }
function safeInteger(value: unknown) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))) return Number(value);
  return null;
}
