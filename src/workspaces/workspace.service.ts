import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ApiError } from '../platform/http/errors.js';
import type { CurrentSession } from '../auth/auth.types.js';
import { USER_ID } from '../auth/auth.types.js';
import { emailDigest, validateEmail } from '../auth/auth.security.js';
import { AuthService } from '../auth/auth.service.js';
import { makeId } from '../platform/http/request.js';
import type { FunctionReply } from '../redis/reply.js';
import type { CreateWorkspaceDto, PatchWorkspaceDto } from './workspace.dto.js';
import { WorkspaceRepository } from './workspace.repository.js';

const WORKSPACE_ID = /^ws_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const MUTATION_ID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const IDEM_KEY = /^[A-Za-z0-9._-]{1,128}$/;
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  WORKSPACE_SLUG_TAKEN: 409,
  MEMBER_ALREADY_EXISTS: 409,
  WORKSPACE_VERSION_CONFLICT: 409,
  WORKSPACE_OWNER_REQUIRED: 409,
  IDEMPOTENCY_KEY_REUSED: 422,
  INVALID_MEMBER_TARGET: 422,
  WORKSPACE_SUSPENDED: 423,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 400,
};
type Role = 'OWNER' | 'ADMIN' | 'MEMBER';

@Injectable()
export class WorkspaceService {
  constructor(private readonly repository: WorkspaceRepository, private readonly auth: AuthService) {}

  async create(session: CurrentSession, dto: CreateWorkspaceDto, requestId: string, idem: string, mutationId: string) {
    const name = dto.name.trim();
    const metadata = await this.#metadata(session.userId, requestId, idem, mutationId,
      'sh_create_workspace', [], { name, slug: dto.slug });
    const reply = await this.repository.create({ ...metadata, workspaceId: makeId('ws'), actorId: session.userId, name, slug: dto.slug });
    const success = this.#success(reply);
    return { data: workspace(success.data), seq: success.seq };
  }

  async list(session: CurrentSession, limit: number, cursor?: string) {
    const after = decodeCursor(cursor, 'workspaces', session.userId);
    const ids = await this.repository.listWorkspaceIds(session.userId, after, limit);
    const hasMore = ids.length > limit;
    const selected = ids.slice(0, limit);
    const rows = await this.repository.getMany(selected, session.userId);
    const data = rows.flatMap(({ id, document, role }) =>
      document?.id === id && isRole(role) ? [workspace(document, role)] : []);
    return { data, nextCursor: hasMore && selected.length ? encodeCursor('workspaces', session.userId, selected[selected.length - 1]!) : null };
  }

  async get(session: CurrentSession, id: string) {
    this.#workspaceId(id);
    const result = await this.repository.get(id, session.userId);
    if (!result.document || result.document.id !== id || !isRole(result.role)) throw new ApiError(404, 'NOT_FOUND');
    if (result.seq === null) throw new ApiError(500, 'INTERNAL_ERROR');
    return { data: workspace(result.document, result.role), seq: result.seq };
  }

  async listMembers(session: CurrentSession, id: string, limit: number, cursor?: string) {
    this.#workspaceId(id);
    const after = decodeCursor(cursor, 'members', session.userId, id);
    const ids = await this.repository.listMemberIds(id, after, limit);
    const hasMore = ids.length > limit;
    const selected = ids.slice(0, limit);
    const result = await this.repository.getMembers(id, session.userId, selected);
    if (!result.document || result.document.id !== id || !isRole(result.actorRole)) throw new ApiError(404, 'NOT_FOUND');
    const data = selected.flatMap((userId, index) => {
      const memberRole = result.roles[index];
      return isRole(memberRole) ? [{ userId, role: memberRole }] : [];
    });
    if (result.seq === null) throw new ApiError(500, 'INTERNAL_ERROR');
    return { data, workspaceVersion: validVersion(result.document), nextCursor: hasMore && selected.length
      ? encodeCursor('members', session.userId, selected[selected.length - 1]!, id) : null, seq: result.seq };
  }

  async update(session: CurrentSession, id: string, dto: PatchWorkspaceDto, requestId: string, idem: string, mutationId: string) {
    this.#workspaceId(id);
    if (dto.name === undefined && dto.slug === undefined) throw new ApiError(400, 'VALIDATION_FAILED');
    const patch = { ...(dto.name === undefined ? {} : { name: dto.name.trim() }), ...(dto.slug === undefined ? {} : { slug: dto.slug }) };
    const metadata = await this.#metadata(session.userId, requestId, idem, mutationId, 'sh_update_workspace', [id], {
      expectedVersion: dto.expectedVersion, ...patch,
    });
    const reply = await this.repository.update(id, session.userId, { expectedVersion: dto.expectedVersion, ...patch }, metadata);
    const success = this.#success(reply);
    return { data: workspace(success.data), seq: success.seq };
  }

  async addMember(session: CurrentSession, id: string, input: { userId?: string; email?: string }, requestId: string, idem: string, mutationId: string) {
    this.#workspaceId(id);
    const byId = input.userId !== undefined;
    const byEmail = input.email !== undefined;
    if (byId === byEmail) throw new ApiError(400, 'VALIDATION_FAILED');
    const userId = input.userId ?? '';
    let digest = '';
    if (byId && !USER_ID.test(userId)) throw new ApiError(400, 'VALIDATION_FAILED');
    if (byEmail) digest = emailDigest(validateEmail(input.email!).normalized);
    const metadata = await this.#metadata(session.userId, requestId, idem, mutationId, 'sh_add_workspace_member', [id],
      { target: byId ? userId : digest });
    const reply = await this.repository.addMember(id, session.userId, userId, digest, metadata);
    const success = this.#success(reply);
    return { data: member(success.data), seq: success.seq };
  }

  async updateRole(session: CurrentSession, id: string, userId: string, input: { expectedVersion: number; role: 'ADMIN' | 'MEMBER' }, requestId: string, idem: string, mutationId: string) {
    this.#workspaceId(id);
    this.#userId(userId);
    const metadata = await this.#metadata(session.userId, requestId, idem, mutationId, 'sh_update_workspace_role', [id, userId],
      { expectedVersion: input.expectedVersion, role: input.role });
    const success = this.#success(await this.repository.updateRole(id, session.userId, userId, input.role, input.expectedVersion, metadata));
    return { data: member(success.data), seq: success.seq };
  }

  async removeMember(session: CurrentSession, id: string, userId: string, requestId: string, idem: string, mutationId: string) {
    this.#workspaceId(id);
    this.#userId(userId);
    const metadata = await this.#metadata(session.userId, requestId, idem, mutationId, 'sh_remove_workspace_member', [id, userId], { mode: 'remove' });
    const success = this.#success(await this.repository.removeMember(id, session.userId, userId, 'remove', metadata));
    return { data: removed(success.data), seq: success.seq };
  }

  async leave(session: CurrentSession, id: string, requestId: string, idem: string, mutationId: string) {
    this.#workspaceId(id);
    const metadata = await this.#metadata(session.userId, requestId, idem, mutationId, 'sh_remove_workspace_member', [id, session.userId], { mode: 'leave' });
    const success = this.#success(await this.repository.removeMember(id, session.userId, session.userId, 'leave', metadata));
    return { data: removed(success.data), seq: success.seq };
  }

  async transferOwner(session: CurrentSession, id: string, userId: string, requestId: string, idem: string, mutationId: string) {
    this.#workspaceId(id);
    this.#userId(userId);
    const metadata = await this.#metadata(session.userId, requestId, idem, mutationId, 'sh_transfer_workspace_owner', [id, userId], {});
    const success = this.#success(await this.repository.transferOwner(id, session.userId, userId, metadata));
    return { data: workspace(success.data), seq: success.seq };
  }

  #workspaceId(id: string) { if (!WORKSPACE_ID.test(id)) throw new ApiError(400, 'VALIDATION_FAILED'); }
  #userId(id: string) { if (!USER_ID.test(id)) throw new ApiError(400, 'VALIDATION_FAILED'); }

  async #metadata(actor: string, requestId: string, idem: string, mutationId: string, operation: string, target: string[], payload: object) {
    if (!IDEM_KEY.test(idem) || !MUTATION_ID.test(mutationId)) throw new ApiError(400, 'VALIDATION_FAILED');
    await this.auth.takeWriteLimit(actor);
    const hash = createHash('sha256').update(JSON.stringify([operation, target, { ...payload, clientMutationId: mutationId }])).digest('hex');
    return { idem, hash, nowMs: Date.now(), requestId, mutationId };
  }

  #success(reply: FunctionReply) {
    if (reply.ok) return reply;
    if (!Object.hasOwn(STATUS_BY_CODE, reply.code)) throw new ApiError(500, 'INTERNAL_ERROR');
    const status = STATUS_BY_CODE[reply.code];
    if (reply.code === 'WORKSPACE_VERSION_CONFLICT') {
      const currentVersion = reply.params.currentVersion;
      if (!Number.isSafeInteger(currentVersion) || Number(currentVersion) < 1) throw new ApiError(500, 'INTERNAL_ERROR');
      throw new ApiError(status, reply.code, { currentVersion });
    }
    throw new ApiError(status, reply.code);
  }

}

function workspace(value: unknown, actorRole?: Role) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(500, 'INTERNAL_ERROR');
  const v = value as Record<string, unknown>;
  const id = v.id;
  const roleValue = actorRole ?? v.role;
  if (typeof id !== 'string' || !WORKSPACE_ID.test(id) || typeof v.name !== 'string' || typeof v.slug !== 'string'
    || typeof v.ownerId !== 'string' || !USER_ID.test(v.ownerId) || !isRole(roleValue)
    || !Number.isSafeInteger(v.version) || Number(v.version) < 1
    || typeof v.createdAtMs !== 'number' || !Number.isSafeInteger(v.createdAtMs) || v.createdAtMs < 1) throw new ApiError(500, 'INTERNAL_ERROR');
  const date = typeof v.createdAt === 'string' ? v.createdAt : new Date(v.createdAtMs).toISOString();
  return { id, name: v.name, slug: v.slug, ownerId: v.ownerId, role: roleValue, version: v.version, createdAt: date, createdAtMs: v.createdAtMs };
}

function member(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(500, 'INTERNAL_ERROR');
  const v = value as Record<string, unknown>;
  if (typeof v.userId !== 'string' || !USER_ID.test(v.userId) || !isRole(v.role)) throw new ApiError(500, 'INTERNAL_ERROR');
  return { userId: v.userId, role: v.role };
}
function removed(value: unknown) {
  if (!value || typeof value !== 'object' || typeof (value as Record<string, unknown>).userId !== 'string') throw new ApiError(500, 'INTERNAL_ERROR');
  return { userId: (value as { userId: string }).userId };
}
function validVersion(value: Record<string, unknown> | null) {
  const version = value?.version;
  if (!Number.isSafeInteger(version) || Number(version) < 1) throw new ApiError(500, 'INTERNAL_ERROR');
  return Number(version);
}
function isRole(value: unknown): value is Role {
  return value === 'OWNER' || value === 'ADMIN' || value === 'MEMBER';
}
function encodeCursor(kind: 'workspaces' | 'members', actor: string, id: string, workspaceId?: string) {
  return Buffer.from(JSON.stringify({ v: 1, kind, actor, id, ...(workspaceId ? { workspaceId } : {}) })).toString('base64url');
}
function decodeCursor(cursor: string | undefined, kind: 'workspaces' | 'members', actor: string, workspaceId?: string): string | null {
  if (cursor === undefined) return null;
  if (!cursor || cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new ApiError(400, 'VALIDATION_FAILED');
  try {
    const decoded = Buffer.from(cursor, 'base64url');
    if (decoded.toString('base64url') !== cursor) throw new Error();
    const value = JSON.parse(decoded.toString('utf8')) as Record<string, unknown>;
    if (value.v !== 1 || value.kind !== kind || value.actor !== actor || value.workspaceId !== workspaceId
      || typeof value.id !== 'string' || !(kind === 'workspaces' ? WORKSPACE_ID : USER_ID).test(value.id)) throw new Error();
    return value.id;
  } catch { throw new ApiError(400, 'VALIDATION_FAILED'); }
}
