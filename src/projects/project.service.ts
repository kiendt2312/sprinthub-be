import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ApiError } from '../platform/http/errors.js';
import type { CurrentSession } from '../auth/auth.types.js';
import { USER_ID } from '../auth/auth.types.js';
import { AuthService } from '../auth/auth.service.js';
import { makeId } from '../platform/http/request.js';
import type { FunctionReply } from '../redis/reply.js';
import type { CreateProjectDto, PatchProjectDto } from './project.dto.js';
import { ProjectRepository } from './project.repository.js';

const WORKSPACE_ID = /^ws_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const PROJECT_ID = /^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const MUTATION_ID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const IDEM_KEY = /^[A-Za-z0-9._-]{1,128}$/;
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  PROJECT_KEY_TAKEN: 409, PROJECT_KEY_IMMUTABLE: 409, PROJECT_VERSION_CONFLICT: 409,
  IDEMPOTENCY_KEY_REUSED: 422, PROJECT_ARCHIVED: 422, WORKSPACE_SUSPENDED: 423,
  FORBIDDEN: 403, NOT_FOUND: 404, VALIDATION_FAILED: 400,
};
type Role = 'OWNER' | 'ADMIN' | 'MEMBER';

@Injectable()
export class ProjectService {
  constructor(private readonly repository: ProjectRepository, private readonly auth: AuthService) {}

  async create(session: CurrentSession, wid: string, dto: CreateProjectDto, requestId: string, idem: string, mutationId: string) {
    this.#workspaceId(wid);
    const name = dto.name.trim();
    const description = dto.description ?? '';
    const meta = await this.#metadata(session.userId, requestId, idem, mutationId, 'sh_create_project', [wid], { key: dto.key, name, description });
    const reply = await this.repository.create({ workspaceId: wid, projectId: makeId('prj'), actorId: session.userId,
      key: dto.key, name, description, meta });
    const success = this.#success(reply);
    return { data: project(success.data), seq: success.seq };
  }

  async list(session: CurrentSession, wid: string, limit: number, archived: boolean, cursor?: string) {
    this.#workspaceId(wid);
    let after = decodeCursor(cursor, session.userId, wid, archived);
    const access = await this.repository.getWorkspaceAccess(wid, session.userId);
    if (!access.workspace || access.workspace.id !== wid || !isRole(access.role)) throw new ApiError(404, 'NOT_FOUND');
    const data: Record<string, unknown>[] = [];
    let hasMore = false;
    let exhausted = false;
    let scannedThrough: string | null = after;
    for (let batch = 0; batch < 3 && data.length <= limit; batch++) {
      // On the last bounded scan, ask for one extra ID to distinguish an exact
      // index end from a full batch that still has another page.
      const requestCount = limit + (batch === 2 ? 2 : 1);
      const ids = await this.repository.listIds(wid, after, requestCount);
      if (ids.length === 0) { exhausted = true; break; }
      const read = await this.repository.getMany(wid, session.userId, ids);
      if (!read.workspace || read.workspace.id !== wid || !isRole(read.role)) throw new ApiError(404, 'NOT_FOUND');
      const found = ids.flatMap((id, index) => {
        const doc = read.rows[index];
        if (!doc || doc.id !== id || doc.workspaceId !== wid) return [];
        const isArchived = doc.archivedAt !== null && doc.archivedAt !== undefined;
        return archived || !isArchived ? [doc] : [];
      });
      data.push(...found);
      const consumed = ids[ids.length - 1]!;
      after = consumed;
      scannedThrough = consumed;
      if (data.length > limit) { hasMore = true; break; }
      if (ids.length < requestCount) { exhausted = true; break; }
    }
    if (!exhausted && data.length <= limit && scannedThrough) {
      exhausted = !(await this.repository.hasIdsAfter(wid, scannedThrough));
    }
    const selected = data.slice(0, limit);
    const cursorId = hasMore && selected.length ? selected[selected.length - 1]!.id as string : scannedThrough;
    return { data: selected.map(project), nextCursor: !exhausted && cursorId
      ? encodeCursor(session.userId, wid, archived, cursorId) : null };
  }

  async get(session: CurrentSession, pid: string) {
    this.#projectId(pid);
    const result = await this.repository.get(pid, session.userId);
    if (!result.document || result.document.id !== pid || !isRole(result.role)) throw new ApiError(404, 'NOT_FOUND');
    if (result.seq === null) throw new ApiError(500, 'INTERNAL_ERROR');
    return { data: project(result.document), seq: result.seq };
  }

  async update(session: CurrentSession, pid: string, dto: PatchProjectDto, requestId: string, idem: string, mutationId: string) {
    this.#projectId(pid);
    if (dto.name === undefined && dto.key === undefined && dto.description === undefined) throw new ApiError(400, 'VALIDATION_FAILED');
    const current = await this.repository.get(pid, session.userId);
    if (!current.document || current.document.id !== pid || typeof current.document.workspaceId !== 'string'
      || !WORKSPACE_ID.test(current.document.workspaceId) || !isRole(current.role)) throw new ApiError(404, 'NOT_FOUND');
    const patch = { expectedVersion: dto.expectedVersion,
      ...(dto.name === undefined ? {} : { name: dto.name.trim() }),
      ...(dto.key === undefined ? {} : { key: dto.key }),
      ...(dto.description === undefined ? {} : { description: dto.description }) };
    const meta = await this.#metadata(session.userId, requestId, idem, mutationId, 'sh_update_project', [current.document.workspaceId, pid], patch);
    const success = this.#success(await this.repository.update(current.document.workspaceId, pid, session.userId, patch, 'update', meta));
    return { data: project(success.data), seq: success.seq };
  }

  async archive(session: CurrentSession, pid: string, expectedVersion: number, requestId: string, idem: string, mutationId: string) {
    return this.#lifecycle(session, pid, expectedVersion, 'archive', requestId, idem, mutationId);
  }

  async unarchive(session: CurrentSession, pid: string, expectedVersion: number, requestId: string, idem: string, mutationId: string) {
    return this.#lifecycle(session, pid, expectedVersion, 'unarchive', requestId, idem, mutationId);
  }

  async #lifecycle(session: CurrentSession, pid: string, expectedVersion: number, mode: 'archive' | 'unarchive', requestId: string, idem: string, mutationId: string) {
    this.#projectId(pid);
    const current = await this.repository.get(pid, session.userId);
    if (!current.document || typeof current.document.workspaceId !== 'string'
      || !WORKSPACE_ID.test(current.document.workspaceId) || !isRole(current.role)) throw new ApiError(404, 'NOT_FOUND');
    const wid = current.document.workspaceId;
    const meta = await this.#metadata(session.userId, requestId, idem, mutationId, 'sh_update_project', [wid, pid], { mode, expectedVersion });
    const success = this.#success(await this.repository.update(wid, pid, session.userId, { expectedVersion }, mode, meta));
    return { data: project(success.data), seq: success.seq };
  }

  #workspaceId(id: string) { if (!WORKSPACE_ID.test(id)) throw new ApiError(400, 'VALIDATION_FAILED'); }
  #projectId(id: string) { if (!PROJECT_ID.test(id)) throw new ApiError(400, 'VALIDATION_FAILED'); }

  async #metadata(actor: string, requestId: string, idem: string, mutationId: string, operation: string, target: string[], payload: object) {
    if (!IDEM_KEY.test(idem) || !MUTATION_ID.test(mutationId)) throw new ApiError(400, 'VALIDATION_FAILED');
    await this.auth.takeWriteLimit(actor);
    const hash = createHash('sha256').update(JSON.stringify([operation, target, { ...payload, clientMutationId: mutationId }])).digest('hex');
    return { idem, hash, nowMs: Date.now(), requestId, mutationId };
  }

  #success(reply: FunctionReply) {
    if (reply.ok) return reply;
    if (!Object.hasOwn(STATUS_BY_CODE, reply.code)) throw new ApiError(500, 'INTERNAL_ERROR');
    if (reply.code === 'PROJECT_VERSION_CONFLICT') {
      const currentVersion = reply.params.currentVersion;
      if (!Number.isSafeInteger(currentVersion) || Number(currentVersion) < 1) throw new ApiError(500, 'INTERNAL_ERROR');
      throw new ApiError(409, reply.code, { currentVersion });
    }
    throw new ApiError(STATUS_BY_CODE[reply.code]!, reply.code);
  }
}

function project(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(500, 'INTERNAL_ERROR');
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || !PROJECT_ID.test(v.id) || typeof v.workspaceId !== 'string' || !WORKSPACE_ID.test(v.workspaceId)
    || typeof v.name !== 'string' || typeof v.key !== 'string' || !/^[A-Z0-9]{2,10}$/.test(v.key)
    || typeof v.description !== 'string'
    || typeof v.createdBy !== 'string' || !USER_ID.test(v.createdBy)
    || typeof v.createdAtMs !== 'number' || !Number.isSafeInteger(v.createdAtMs) || v.createdAtMs < 1
    || (v.archivedAt !== null && typeof v.archivedAt !== 'string')
    || !Number.isSafeInteger(v.version) || Number(v.version) < 1) throw new ApiError(500, 'INTERNAL_ERROR');
  return { id: v.id, workspaceId: v.workspaceId, name: v.name, key: v.key, description: v.description, createdBy: v.createdBy,
    createdAt: typeof v.createdAt === 'string' ? v.createdAt : new Date(v.createdAtMs).toISOString(), createdAtMs: v.createdAtMs,
    archivedAt: v.archivedAt, version: v.version };
}

function encodeCursor(actor: string, workspaceId: string, archived: boolean, id: string) {
  return Buffer.from(JSON.stringify({ v: 1, kind: 'projects', actor, workspaceId, archived, id })).toString('base64url');
}
function decodeCursor(cursor: string | undefined, actor: string, workspaceId: string, archived: boolean): string | null {
  if (cursor === undefined) return null;
  if (!cursor || cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new ApiError(400, 'VALIDATION_FAILED');
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (Buffer.from(JSON.stringify(value)).toString('base64url') !== cursor || value.v !== 1 || value.kind !== 'projects'
      || value.actor !== actor || value.workspaceId !== workspaceId || value.archived !== archived
      || typeof value.id !== 'string' || !PROJECT_ID.test(value.id)) throw new Error();
    return value.id;
  } catch { throw new ApiError(400, 'VALIDATION_FAILED'); }
}
function isRole(value: unknown): value is Role { return value === 'OWNER' || value === 'ADMIN' || value === 'MEMBER'; }
