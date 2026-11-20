import { Injectable } from '@nestjs/common';
import { USER_ID } from '../auth/auth.types.js';
import { RedisFailure, RedisStore } from '../redis/client.js';

@Injectable()
export class WorkspaceRepository {
  constructor(private readonly redis: RedisStore) {}

  create(input: { workspaceId: string; actorId: string; name: string; slug: string; idem: string; hash: string; nowMs: number; requestId: string; mutationId: string }) {
    const { keys } = this.redis;
    const id = input.workspaceId;
    return this.redis.callWorkspace('sh_create_workspace', [
      keys.workspaceMembers(id), keys.workspace(id), keys.userWorkspaces(input.actorId), keys.userWorkspacesPage(input.actorId),
      keys.workspaceMembersPage(id), keys.workspaceSlug(input.slug), keys.workspacesByCreated(), keys.user(input.actorId),
      keys.workspaceSeq(id), keys.workspaceChanges(id), keys.domainEvents(), keys.idempotency(input.actorId, input.idem),
    ], [id, input.actorId, input.name, input.slug, input.idem, input.hash, String(input.nowMs), input.requestId, input.mutationId]);
  }

  async get(id: string, actorId: string) {
    const { keys } = this.redis;
    const rows = await this.redis.read((client) => client.multi()
      .json.get(keys.workspace(id))
      .hGet(keys.workspaceMembers(id), actorId)
      .get(keys.workspaceSeq(id))
      .exec() as unknown as Promise<unknown[]>);
    const [document, role, seq] = rows;
    return { document: asObjectOrNull(document), role: stringOrNull(role), seq: safeInteger(seq) };
  }

  async getMany(ids: string[], actorId: string) {
    if (ids.length === 0) return [];
    const { keys } = this.redis;
    const result = await this.redis.read((client) => {
      const tx = client.multi();
      for (const id of ids) {
        tx.json.get(keys.workspace(id));
        tx.hGet(keys.workspaceMembers(id), actorId);
      }
      return tx.exec() as unknown as Promise<unknown[]>;
    });
    return ids.map((id, index) => ({ id, document: asObjectOrNull(result[index * 2]), role: stringOrNull(result[index * 2 + 1]) }));
  }

  async listIds(key: string, after: string | null, limit: number) {
    return this.redis.read(async (client) => {
      const start = after === null ? '-' : `(${after}`;
      return client.zRange(key, start, '+', { BY: 'LEX', LIMIT: { offset: 0, count: limit + 1 } });
    });
  }

  listWorkspaceIds(userId: string, after: string | null, limit: number) {
    return this.listIds(this.redis.keys.userWorkspacesPage(userId), after, limit);
  }

  listMemberIds(workspaceId: string, after: string | null, limit: number) {
    return this.listIds(this.redis.keys.workspaceMembersPage(workspaceId), after, limit);
  }

  async getMembers(id: string, actorId: string, ids: string[]) {
    const { keys } = this.redis;
    const rows = await this.redis.read((client) => {
        const tx = client.multi();
        tx.json.get(keys.workspace(id));
        tx.hGet(keys.workspaceMembers(id), actorId);
        tx.get(keys.workspaceSeq(id));
        for (const uid of ids) tx.hGet(keys.workspaceMembers(id), uid);
        return tx.exec() as unknown as Promise<unknown[]>;
      });
    const [document, actorRole, seq, ...roles] = rows;
    return { document: asObjectOrNull(document), actorRole: stringOrNull(actorRole), seq: safeInteger(seq), roles: roles.map(stringOrNull) };
  }

  async update(id: string, actorId: string, dto: { expectedVersion: number; name?: string; slug?: string }, metadata: MutationMetadata) {
    const { keys } = this.redis;
    return this.redis.withKeySnapshot(async (deadline) => {
      const document = asObjectOrNull(await this.redis.read((client) => client.json.get(keys.workspace(id)), deadline));
      if (!document) return { ok: false as const, code: 'NOT_FOUND', params: {} };
      const oldSlug = typeof document.slug === 'string' ? document.slug : '';
      return this.redis.callWorkspace('sh_update_workspace', [
        keys.workspaceMembers(id), keys.workspace(id), keys.workspaceSlug(oldSlug), keys.workspaceSlug(dto.slug ?? oldSlug),
        keys.workspaceSeq(id), keys.workspaceChanges(id), keys.domainEvents(), keys.idempotency(actorId, metadata.idem),
      ], [id, actorId, oldSlug, dto.slug ?? oldSlug, String(dto.expectedVersion), dto.name ?? '', dto.slug ?? '',
        metadata.idem, metadata.hash, String(metadata.nowMs), metadata.requestId, metadata.mutationId], deadline);
    });
  }

  addMember(id: string, actorId: string, userId: string, digest: string, metadata: MutationMetadata) {
    const { keys } = this.redis;
    return this.redis.withKeySnapshot(async (deadline) => {
      const target = userId || await this.redis.read((client) => client.get(keys.userEmail(digest)), deadline) || '';
      if (target && !USER_ID.test(target)) throw new RedisFailure('INTERNAL_ERROR');
      const indexUser = target || 'none';
      return this.redis.callWorkspace('sh_add_workspace_member', [
        keys.workspaceMembers(id), keys.workspace(id), keys.userWorkspaces(indexUser), keys.userWorkspacesPage(indexUser),
        keys.workspaceMembersPage(id), keys.user(indexUser), keys.userEmail(digest || 'none'),
        keys.workspaceSeq(id), keys.workspaceChanges(id), keys.domainEvents(), keys.idempotency(actorId, metadata.idem),
      ], [id, actorId, target, digest, metadata.idem, metadata.hash, String(metadata.nowMs), metadata.requestId, metadata.mutationId], deadline);
    });
  }

  updateRole(id: string, actorId: string, userId: string, role: 'ADMIN' | 'MEMBER', version: number, metadata: MutationMetadata) {
    const { keys } = this.redis;
    return this.redis.callWorkspace('sh_update_workspace_role', [keys.workspaceMembers(id), keys.workspace(id), keys.workspaceSeq(id),
      keys.workspaceChanges(id), keys.domainEvents(), keys.idempotency(actorId, metadata.idem)],
    [id, actorId, userId, role, String(version), metadata.idem, metadata.hash,
      String(metadata.nowMs), metadata.requestId, metadata.mutationId]);
  }

  transferOwner(id: string, actorId: string, userId: string, metadata: MutationMetadata) {
    const { keys } = this.redis;
    return this.redis.callWorkspace('sh_transfer_workspace_owner', [keys.workspaceMembers(id), keys.workspace(id), keys.workspaceSeq(id),
      keys.workspaceChanges(id), keys.domainEvents(), keys.idempotency(actorId, metadata.idem)],
    [id, actorId, userId, metadata.idem, metadata.hash,
      String(metadata.nowMs), metadata.requestId, metadata.mutationId]);
  }

  removeMember(id: string, actorId: string, userId: string, mode: 'remove' | 'leave', metadata: MutationMetadata) {
    const { keys } = this.redis;
    return this.redis.callWorkspace('sh_remove_workspace_member', [keys.workspaceMembers(id), keys.workspace(id), keys.userWorkspaces(userId),
      keys.userWorkspacesPage(userId), keys.workspaceMembersPage(id), keys.audit(), keys.workspaceSeq(id), keys.workspaceChanges(id),
      keys.domainEvents(), keys.idempotency(actorId, metadata.idem)],
    [id, actorId, userId, mode, metadata.idem, metadata.hash,
      String(metadata.nowMs), metadata.requestId, metadata.mutationId]);
  }
}

export interface MutationMetadata { idem: string; hash: string; nowMs: number; requestId: string; mutationId: string }

function asObjectOrNull(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new RedisFailure('INTERNAL_ERROR');
  return value as Record<string, unknown>;
}

function safeInteger(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new RedisFailure('INTERNAL_ERROR');
  return number;
}

function stringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new RedisFailure('INTERNAL_ERROR');
  return value;
}
