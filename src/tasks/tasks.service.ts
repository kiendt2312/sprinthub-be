import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ApiError } from '../platform/http/errors.js';
import type { CurrentSession } from '../auth/auth.types.js';
import { USER_ID } from '../auth/auth.types.js';
import { AuthService } from '../auth/auth.service.js';
import { makeId } from '../platform/http/request.js';
import type { FunctionReply } from '../redis/reply.js';
import type { AssignTaskDto, CreateTaskDto, MoveTaskDto, TaskQueryDto, UpdateTaskDto } from './task.dto.js';
import { compareCandidate, TASK_STATUSES, TasksRepository } from './task.repository.js';
import type { Candidate, TaskPatch, TaskStatus, TaskView } from './task.repository.js';

const PROJECT_ID = /^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const TASK_ID = /^tsk_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const WORKSPACE_ID = /^ws_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const MUTATION_ID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const IDEM_KEY = /^[A-Za-z0-9._-]{1,128}$/;
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  TASK_VERSION_CONFLICT: 409,
  COLUMN_FULL: 409,
  PROJECT_ARCHIVED: 422,
  ASSIGNEE_NOT_MEMBER: 422,
  INVALID_STATUS_TRANSITION: 422,
  INVALID_POSITION_ANCHOR: 422,
  IDEMPOTENCY_KEY_REUSED: 422,
  WORKSPACE_SUSPENDED: 423,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 400,
};

@Injectable()
export class TasksService {
  constructor(private readonly repository: TasksRepository, private readonly auth: AuthService) {}

  async create(session: CurrentSession, projectId: string, dto: CreateTaskDto, requestId: string, idem: string, mutationId: string) {
    this.#projectId(projectId);
    const payload = { title: dto.title.trim(), description: dto.description ?? '', priority: dto.priority ?? 'MEDIUM', dueAtMs: dto.dueAtMs ?? null };
    const assigneeId = dto.assigneeId ?? null;
    this.#assigneeId(assigneeId);
    const access = await this.repository.authorizeProject(projectId, session.userId);
    if (!access) throw new ApiError(404, 'NOT_FOUND');
    const metadata = await this.#metadata(session.userId, 'sh_create_task', [access.workspaceId, projectId],
      { ...payload, assigneeId, clientMutationId: mutationId }, requestId, idem, mutationId);
    const reply = await this.repository.create({ ...metadata, workspaceId: access.workspaceId, projectId,
      taskId: makeId('tsk'), assigneeId, payload });
    const success = this.#success(reply);
    const { rebalancedColumn } = success;
    return { data: task(success.data), seq: success.seq, ...(rebalancedColumn ? { rebalancedColumn } : {}) };
  }

  async board(session: CurrentSession, projectId: string) {
    this.#projectId(projectId);
    const result = await this.repository.board(projectId, session.userId);
    if (!result) throw new ApiError(404, 'NOT_FOUND');
    return { data: result };
  }

  async list(session: CurrentSession, projectId: string, query: TaskQueryDto) {
    this.#projectId(projectId);
    const access = await this.repository.authorizeProject(projectId, session.userId);
    if (!access) throw new ApiError(404, 'NOT_FOUND');
    const limit = query.limit ?? 50;
    const filters = { status: query.status ?? null, assigneeId: query.assigneeId ?? null, priority: query.priority ?? null };
    if (filters.assigneeId && filters.assigneeId !== 'UNASSIGNED' && !USER_ID.test(filters.assigneeId)) throw new ApiError(400, 'VALIDATION_FAILED');
    const after = decodeCursor(query.cursor, session.userId, projectId, filters);
    const selected: Array<{ entry: Candidate; task: TaskView }> = [];
    const seen = new Set<string>();
    const candidates = (await this.repository.listCandidates(projectId, query.status))
      .filter((entry) => !after || compareCandidate(entry, after) > 0);
    for (let start = 0; start < candidates.length && selected.length < limit + 1; start += 100) {
      let chunk = candidates.slice(start, start + 100);
      if (filters.assigneeId || filters.priority) {
        const projected = await this.repository.hydrateCandidates(projectId, access.workspaceId, session.userId, chunk, true);
        if (!projected) throw new ApiError(404, 'NOT_FOUND');
        chunk = projected.filter(({ task }) => matchesFilters(task, filters)).map(({ entry }) => entry);
      }
      if (!chunk.length) continue;
      const rows = await this.repository.hydrateCandidates(projectId, access.workspaceId, session.userId, chunk);
      if (!rows) throw new ApiError(404, 'NOT_FOUND');
      for (const row of rows) {
        if (seen.has(row.task.id) || !matchesFilters(row.task, filters)) continue;
        selected.push(row);
        seen.add(row.task.id);
        if (selected.length > limit) break;
      }
    }
    const hasMore = selected.length > limit;
    const page = selected.slice(0, limit);
    const last = page.at(-1)?.entry;
    return { data: page.map(({ task: item }) => task(item)), nextCursor: hasMore && last
      ? encodeCursor(session.userId, projectId, filters, last) : null };
  }

  async get(session: CurrentSession, taskId: string) {
    this.#taskId(taskId);
    const value = await this.repository.taskById(taskId, session.userId);
    if (!value) throw new ApiError(404, 'NOT_FOUND');
    return { data: task(value) };
  }

  async byKey(session: CurrentSession, workspaceId: string, key: string) {
    this.#workspaceId(workspaceId);
    if (!/^[A-Z0-9]{2,10}-[1-9][0-9]*$/.test(key)) throw new ApiError(400, 'VALIDATION_FAILED');
    const value = await this.repository.taskByKey(workspaceId, key, session.userId);
    if (!value) throw new ApiError(404, 'NOT_FOUND');
    return { data: task(value) };
  }

  async update(session: CurrentSession, taskId: string, dto: UpdateTaskDto, requestId: string, idem: string, mutationId: string) {
    this.#taskId(taskId);
    const patch: TaskPatch = {};
    if (dto.title !== undefined) patch.title = dto.title.trim();
    if (dto.description !== undefined) patch.description = dto.description;
    if (dto.priority !== undefined) patch.priority = dto.priority;
    if (dto.dueAtMs !== undefined) patch.dueAtMs = dto.dueAtMs;
    if (dto.assigneeId !== undefined) { this.#assigneeId(dto.assigneeId); patch.assigneeId = dto.assigneeId; }
    if (!Object.keys(patch).length) throw new ApiError(400, 'VALIDATION_FAILED');
    return this.#mutateTask(session, taskId, requestId, idem, mutationId, 'sh_update_task', dto.expectedVersion, patch,
      (snapshot, metadata) => this.repository.update({ ...metadata, workspaceId: snapshot.workspaceId, projectId: snapshot.projectId,
        taskId, expectedVersion: dto.expectedVersion, patch }));
  }

  async assign(session: CurrentSession, taskId: string, dto: AssignTaskDto, requestId: string, idem: string, mutationId: string) {
    this.#taskId(taskId); this.#assigneeId(dto.assigneeId);
    const patch = { assigneeId: dto.assigneeId };
    return this.#mutateTask(session, taskId, requestId, idem, mutationId, 'sh_assign_task', dto.expectedVersion, patch,
      (snapshot, metadata) => this.repository.assign({ ...metadata, workspaceId: snapshot.workspaceId, projectId: snapshot.projectId,
        taskId, assigneeId: dto.assigneeId, expectedVersion: dto.expectedVersion }));
  }

  async move(session: CurrentSession, taskId: string, dto: MoveTaskDto, requestId: string, idem: string, mutationId: string) {
    this.#taskId(taskId);
    const snapshot = await this.#taskSnapshot(taskId, session.userId);
    const payload = { to: dto.to, afterTaskId: dto.afterTaskId ?? null, beforeTaskId: dto.beforeTaskId ?? null,
      expectedVersion: dto.expectedVersion, clientMutationId: mutationId };
    const metadata = await this.#metadata(session.userId, 'sh_move_task', [snapshot.workspaceId, snapshot.projectId, taskId], payload,
      requestId, idem, mutationId);
    const reply = await this.repository.move({ ...metadata, workspaceId: snapshot.workspaceId, projectId: snapshot.projectId, taskId,
      to: dto.to, afterTaskId: dto.afterTaskId ?? undefined,
      beforeTaskId: dto.beforeTaskId ?? undefined, expectedVersion: dto.expectedVersion });
    const success = this.#success(reply);
    const { rebalancedColumn } = success;
    return { data: task(success.data), seq: success.seq, ...(rebalancedColumn ? { rebalancedColumn } : {}) };
  }

  async delete(session: CurrentSession, taskId: string, expectedVersion: number, requestId: string, idem: string, mutationId: string) {
    this.#taskId(taskId);
    return this.#mutateTask(session, taskId, requestId, idem, mutationId, 'sh_delete_task', expectedVersion, {},
      (snapshot, metadata) => this.repository.delete({ ...metadata, workspaceId: snapshot.workspaceId, projectId: snapshot.projectId,
        taskId, expectedVersion }));
  }

  async #mutateTask(session: CurrentSession, taskId: string, requestId: string, idem: string, mutationId: string, operation: string,
    expectedVersion: number, payload: object, invoke: (snapshot: { workspaceId: string; projectId: string }, metadata: MutationMetadata) => Promise<FunctionReply>) {
    const snapshot = await this.#taskSnapshot(taskId, session.userId);
    const metadata = await this.#metadata(session.userId, operation, [snapshot.workspaceId, snapshot.projectId, taskId],
      { expectedVersion, ...payload, clientMutationId: mutationId }, requestId, idem, mutationId);
    const reply = await invoke(snapshot, metadata);
    const success = this.#success(reply);
    return { data: task(success.data), seq: success.seq };
  }

  async #taskSnapshot(taskId: string, actorId: string) {
    const target = await this.repository.mutationTarget(taskId, actorId);
    if (!target) throw new ApiError(404, 'NOT_FOUND');
    return target;
  }

  async #metadata(actor: string, operation: string, target: string[], payload: object, requestId: string, idem: string, mutationId: string): Promise<MutationMetadata> {
    if (!IDEM_KEY.test(idem ?? '') || !MUTATION_ID.test(mutationId ?? '')) throw new ApiError(400, 'VALIDATION_FAILED');
    await this.auth.takeWriteLimit(actor);
    const hash = createHash('sha256').update(JSON.stringify([operation, target, payload])).digest('hex');
    return { idem, hash, nowMs: Date.now(), requestId, clientMutationId: mutationId, actorId: actor };
  }

  #success(reply: FunctionReply) {
    if (reply.ok) return reply;
    if (!Object.hasOwn(STATUS_BY_CODE, reply.code)) throw new ApiError(500, 'INTERNAL_ERROR');
    const status = STATUS_BY_CODE[reply.code]!;
    if (reply.code === 'TASK_VERSION_CONFLICT') {
      const currentVersion = reply.params.currentVersion;
      if (!Number.isSafeInteger(currentVersion) || Number(currentVersion) < 1) throw new ApiError(500, 'INTERNAL_ERROR');
      throw new ApiError(status, reply.code, { currentVersion });
    }
    if (reply.code === 'COLUMN_FULL') throw new ApiError(status, reply.code, { limit: 500 });
    throw new ApiError(status, reply.code);
  }

  #projectId(id: string) { if (!PROJECT_ID.test(id)) throw new ApiError(400, 'VALIDATION_FAILED'); }
  #taskId(id: string) { if (!TASK_ID.test(id)) throw new ApiError(400, 'VALIDATION_FAILED'); }
  #workspaceId(id: string) { if (!WORKSPACE_ID.test(id)) throw new ApiError(400, 'VALIDATION_FAILED'); }
  #assigneeId(id: string | null | undefined) { if (id != null && !USER_ID.test(id)) throw new ApiError(400, 'VALIDATION_FAILED'); }
}

interface MutationMetadata { actorId: string; idem: string; hash: string; nowMs: number; requestId: string; clientMutationId: string }
interface Cursor { v: 1; actorId: string; projectId: string; filters: { status: string | null; assigneeId: string | null; priority: string | null }; score: number; id: string }

function task(value: unknown) {
  const normalized = value && typeof value === 'object' && !Array.isArray(value) ? normalizeTask(value as Record<string, unknown>) : null;
  if (!normalized) throw new ApiError(500, 'INTERNAL_ERROR');
  return normalized;
}
function normalizeTask(value: Record<string, unknown>): TaskView | null {
  if (typeof value.id !== 'string' || !TASK_ID.test(value.id) || typeof value.workspaceId !== 'string' || !WORKSPACE_ID.test(value.workspaceId)
    || typeof value.projectId !== 'string' || !PROJECT_ID.test(value.projectId) || !TASK_STATUSES.includes(value.status as TaskStatus)
    || typeof value.key !== 'string' || !/^[A-Z0-9]{2,10}-[1-9][0-9]*$/.test(value.key) || typeof value.title !== 'string'
    || !Number.isSafeInteger(value.number) || !Number.isSafeInteger(value.version) || Number(value.version) < 1) return null;
  const createdAtMs = value.createdAtMs;
  if (!Number.isSafeInteger(createdAtMs) || Number(createdAtMs) < 1) return null;
  return {
    id: value.id, workspaceId: value.workspaceId, projectId: value.projectId, number: value.number, key: value.key,
    title: value.title, description: typeof value.description === 'string' ? value.description : '',
    descriptionFormat: 'markdown', status: value.status, priority: value.priority, assigneeId: value.assigneeId ?? null,
    reporterId: value.reporterId, sprintId: null, labelIds: [], dueAtMs: value.dueAtMs ?? null,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date(Number(createdAtMs)).toISOString(),
    createdAtMs, deletedAt: value.deletedAt ?? null, lastSeq: value.lastSeq, lastClientMutationId: value.lastClientMutationId,
    version: value.version,
  } as TaskView;
}
function matchesFilters(task: TaskView, filters: Cursor['filters']) {
  const assignee = task.assigneeId ?? 'UNASSIGNED';
  return (!filters.assigneeId || assignee === filters.assigneeId) && (!filters.priority || task.priority === filters.priority);
}
function encodeCursor(actorId: string, projectId: string, filters: Cursor['filters'], entry: Candidate) {
  const value: Cursor = { v: 1, actorId, projectId, filters, score: entry.score, id: entry.id };
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
function decodeCursor(cursor: string | undefined, actorId: string, projectId: string, filters: Cursor['filters']): Pick<Candidate, 'score' | 'id'> | null {
  if (cursor === undefined) return null;
  if (!cursor || cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new ApiError(400, 'VALIDATION_FAILED');
  try {
    const raw = Buffer.from(cursor, 'base64url');
    if (raw.toString('base64url') !== cursor) throw new Error('cursor');
    const value = JSON.parse(raw.toString('utf8')) as Cursor;
    if (value.v !== 1 || value.actorId !== actorId || value.projectId !== projectId || JSON.stringify(value.filters) !== JSON.stringify(filters)
      || !Number.isSafeInteger(value.score) || Math.abs(value.score) > 2 ** 50 || typeof value.id !== 'string' || !TASK_ID.test(value.id)) throw new Error('cursor');
    return { score: value.score, id: value.id };
  } catch { throw new ApiError(400, 'VALIDATION_FAILED'); }
}
