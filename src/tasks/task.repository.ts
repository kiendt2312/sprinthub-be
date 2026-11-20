import { Injectable } from '@nestjs/common';
import { RedisFailure, RedisStore } from '../redis/client.js';
import type { FunctionReply } from '../redis/reply.js';
import { createTask, moveTask } from '../redis/functions.js';

export const TASK_STATUSES = ['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE'] as const;
export type TaskStatus = typeof TASK_STATUSES[number];

const BOARD_PATHS = ['$.id', '$.workspaceId', '$.projectId', '$.status', '$.isDeleted', '$.deletedAt', '$.key', '$.title', '$.priority',
  '$.assigneeId', '$.dueAtMs', '$.labelIds', '$.version'] as const;
const SNAPSHOT_PATHS = ['$.id', '$.workspaceId', '$.projectId', '$.status', '$.assigneeId'];

@Injectable()
export class TasksRepository {
  constructor(private readonly redis: RedisStore) {}

  async #taskSnapshot(taskId: string, deadline?: number) {
    const raw = await this.redis.read(
      client => client.json.get(this.redis.keys.task(taskId), { path: SNAPSHOT_PATHS }), deadline,
    );
    const snapshot = pathProjection(raw, SNAPSHOT_PATHS);
    if (!snapshot || snapshot.id !== taskId || !validId(snapshot.workspaceId, WORKSPACE_ID)
      || !validId(snapshot.projectId, PROJECT_ID) || !isStatus(snapshot.status)) return null;
    return { workspaceId: snapshot.workspaceId, projectId: snapshot.projectId, status: snapshot.status,
      assigneeId: typeof snapshot.assigneeId === 'string' ? snapshot.assigneeId : '' };
  }

  async mutationTarget(taskId: string, actorId: string) {
    const task = await this.#taskSnapshot(taskId);
    if (!task) return null;
    const { keys } = this.redis;
    const [rawProject, role] = await this.redis.read(client => client.multi()
      .json.get(keys.project(task.projectId), { path: ['$.id', '$.workspaceId'] })
      .hGet(keys.workspaceMembers(task.workspaceId), actorId)
      .execAsPipeline());
    return isRole(role) && pathScalar(rawProject, '$.id') === task.projectId
      && pathScalar(rawProject, '$.workspaceId') === task.workspaceId ? task : null;
  }

  async authorizeProject(projectId: string, actorId: string) {
    const { keys } = this.redis;
    const project = await this.redis.read(client => client.json.get(keys.project(projectId), { path: ['$.id', '$.workspaceId'] }));
    const workspaceId = pathScalar(project, '$.workspaceId');
    if (pathScalar(project, '$.id') !== projectId || !validId(workspaceId, WORKSPACE_ID)) return null;
    const role = await this.redis.read(client => client.hGet(keys.workspaceMembers(workspaceId), actorId));
    return isRole(role) ? { workspaceId } : null;
  }

  async board(projectId: string, actorId: string) {
    const { keys } = this.redis;
    // Batch 2 after SessionGuard's session+quota pipeline.
    const batch = await this.redis.read((client) => client.multi()
      .json.get(keys.project(projectId), { path: ['$.workspaceId'] })
      .zRange(keys.board(projectId, 'TODO'), 0, 499)
      .zRange(keys.board(projectId, 'IN_PROGRESS'), 0, 499)
      .zRange(keys.board(projectId, 'IN_REVIEW'), 0, 499)
      .zRange(keys.board(projectId, 'DONE'), 0, 499)
      .execAsPipeline());
    const workspaceId = pathScalar(batch[0], '$.workspaceId');
    if (!validId(workspaceId, WORKSPACE_ID)) return null;
    const idsByStatus = batch.slice(1).map(asStringArray);
    if (idsByStatus.some((ids) => ids.length > 500)) throw new RedisFailure('INTERNAL_ERROR');
    // Batch 3 performs a membership recheck and bounded task projections.
    const rows = await this.redis.read((client) => {
      const pipeline = client.multi();
      pipeline.hGet(keys.workspaceMembers(workspaceId), actorId);
      for (const ids of idsByStatus) for (const id of ids) pipeline.json.get(keys.task(id), { path: [...BOARD_PATHS] });
      return pipeline.execAsPipeline();
    });
    if (!isRole(rows[0])) return null;
    const columns = {} as Record<TaskStatus, BoardCard[]>;
    let offset = 1;
    for (let index = 0; index < TASK_STATUSES.length; index++) {
      const status = TASK_STATUSES[index]!;
      columns[status] = [];
      for (const id of idsByStatus[index]!) {
        const doc = pathProjection(rows[offset++], BOARD_PATHS);
        const task = safeTask(id, doc);
        if (task && task.workspaceId === workspaceId && task.projectId === projectId && task.status === status && task.deletedAt === null) {
          columns[status].push(card(task));
        }
      }
    }
    return { projectId, columns };
  }

  async taskById(taskId: string, actorId: string) {
    const { keys } = this.redis;
    const raw = await this.redis.read(client => client.json.get(keys.task(taskId)));
    const task = safeTask(taskId, objectOrNull(raw));
    if (!task || !PROJECT_ID.test(task.projectId) || !WORKSPACE_ID.test(task.workspaceId)) return null;
    const [project, role] = await this.redis.read(client => client.multi()
      .json.get(keys.project(task.projectId), { path: ['$.id', '$.workspaceId'] })
      .hGet(keys.workspaceMembers(task.workspaceId), actorId)
      .execAsPipeline());
    return isRole(role) && pathScalar(project, '$.id') === task.projectId
      && pathScalar(project, '$.workspaceId') === task.workspaceId ? task : null;
  }

  async taskByKey(workspaceId: string, key: string, actorId: string) {
    const { keys } = this.redis;
    const id = await this.redis.read((client) => client.hGet(keys.workspaceTaskKeys(workspaceId), key));
    if (!id || !TASK_ID.test(id)) return null;
    const task = await this.taskById(id, actorId);
    return task?.workspaceId === workspaceId && task.key === key ? task : null;
  }

  async listCandidates(projectId: string, status: TaskStatus | undefined) {
    const sources = status ? [status] : [...TASK_STATUSES];
    const pages = await this.redis.read((client) => {
      const pipeline = client.multi();
      for (const source of sources) {
        const index = this.redis.keys.board(projectId, source);
        pipeline.zRangeWithScores(index, 0, 499);
      }
      return pipeline.execAsPipeline();
    });
    return pages.flatMap((raw, index) => asScoredArray(raw).map((entry) => ({ ...entry, status: sources[index]! })))
      .sort(compareCandidate);
  }

  async hydrateCandidates(projectId: string, workspaceId: string, actorId: string,
    entries: Candidate[], projectFiltersOnly = false) {
    const { keys } = this.redis;
    const [project, role, ...rows] = await this.redis.read(client => {
      const pipeline = client.multi()
        .json.get(keys.project(projectId), { path: ['$.id', '$.workspaceId'] })
        .hGet(keys.workspaceMembers(workspaceId), actorId);
      for (const { id } of entries) {
        if (projectFiltersOnly) pipeline.json.get(keys.task(id), { path: [...BOARD_PATHS] });
        else pipeline.json.get(keys.task(id));
      }
      return pipeline.execAsPipeline();
    });
    if (!isRole(role) || pathScalar(project, '$.id') !== projectId
      || pathScalar(project, '$.workspaceId') !== workspaceId) return null;
    return entries.flatMap((entry, index) => {
      const raw = projectFiltersOnly ? pathProjection(rows[index], BOARD_PATHS) : objectOrNull(rows[index]);
      const task = safeTask(entry.id, raw);
      return task && task.projectId === projectId && task.workspaceId === workspaceId && task.status === entry.status
        ? [{ entry, task }] : [];
    });
  }

  async create(input: TaskMutationInput & { workspaceId: string; projectId: string; taskId: string; assigneeId: string | null; payload: { title: string; description?: string; priority?: string; dueAtMs?: number | null } }) {
    return createTask(this.redis, { workspaceGuard: true, workspaceId: input.workspaceId, projectId: input.projectId,
      actorId: input.actorId, taskId: input.taskId, assigneeId: input.assigneeId, payload: input.payload,
      idempotencyKey: input.idem, clientMutationId: input.clientMutationId, nowMs: input.nowMs, requestId: input.requestId });
  }

  move(input: TargetedMutation & {
    to: TaskStatus; afterTaskId?: string; beforeTaskId?: string;
  }) {
    return this.#withTaskSnapshot(input, (task, deadline) => moveTask(this.redis, {
      ...input, workspaceGuard: true, from: task.status, idempotencyKey: input.idem,
    }, this.redis.keys, deadline));
  }

  update(input: TargetedMutation & { patch: TaskPatch }) {
    return this.#write('sh_update_task', input, input.patch);
  }

  assign(input: TargetedMutation & { assigneeId: string | null }) {
    return this.#write('sh_assign_task', input, { assigneeId: input.assigneeId });
  }

  #write(name: string, input: TargetedMutation, patch: TaskPatch) {
    const { keys } = this.redis;
    return this.#withTaskSnapshot(input, ({ assigneeId: oldAssignee }, deadline) => {
      const newAssignee = patch.assigneeId === undefined ? oldAssignee : patch.assigneeId ?? '';
      return this.redis.callWorkspace(name, [
        ...this.#entityKeys(input), keys.userAssigned(oldAssignee), keys.userAssigned(newAssignee),
        ...this.#outboxKeys(input),
      ], [input.workspaceId, input.projectId, input.taskId, input.actorId, oldAssignee, newAssignee,
        String(input.expectedVersion), JSON.stringify(patch), ...mutationArgs(input)], deadline);
    });
  }

  delete(input: TargetedMutation) {
    const { keys } = this.redis;
    return this.#withTaskSnapshot(input, ({ status, assigneeId }, deadline) => this.redis.callWorkspace('sh_delete_task', [
      ...this.#entityKeys(input), keys.projectTasks(input.projectId), keys.board(input.projectId, status),
      keys.backlog(input.projectId), keys.userAssigned(assigneeId), ...this.#outboxKeys(input),
    ], [input.workspaceId, input.projectId, input.taskId, input.actorId, status, assigneeId,
      String(input.expectedVersion), ...mutationArgs(input)], deadline));
  }

  #entityKeys({ workspaceId, projectId, taskId }: TargetedMutation) {
    const { keys } = this.redis;
    return [keys.workspaceMembers(workspaceId), keys.workspace(workspaceId), keys.project(projectId), keys.task(taskId)];
  }

  #outboxKeys({ workspaceId, actorId, idem }: TargetedMutation) {
    const { keys } = this.redis;
    return [keys.workspaceSeq(workspaceId), keys.workspaceChanges(workspaceId), keys.domainEvents(), keys.idempotency(actorId, idem)];
  }

  #withTaskSnapshot(input: TargetedMutation,
    run: (snapshot: { status: TaskStatus; assigneeId: string }, deadline: number) => Promise<FunctionReply>) {
    return this.redis.withKeySnapshot(async deadline => {
      const current = await this.#taskSnapshot(input.taskId, deadline);
      if (!current || current.projectId !== input.projectId || current.workspaceId !== input.workspaceId) {
        return { ok: false as const, code: 'NOT_FOUND', params: {} };
      }
      return run(current, deadline);
    });
  }
}

export interface TaskMutationInput { actorId: string; idem: string; hash: string; nowMs: number; requestId: string; clientMutationId: string }
type TargetedMutation = TaskMutationInput & { workspaceId: string; projectId: string; taskId: string; expectedVersion: number };
export interface TaskPatch { title?: string; description?: string; priority?: string; dueAtMs?: number | null; assigneeId?: string | null }
export type Candidate = { id: string; score: number; status: TaskStatus };

function mutationArgs(input: TaskMutationInput) {
  return [input.idem, input.hash, String(input.nowMs), input.requestId, input.clientMutationId];
}
export type TaskView = Record<string, unknown> & { id: string; workspaceId: string; projectId: string; status: TaskStatus; deletedAt: string | null };
export interface BoardCard { id: string; key: string; title: string; priority: string; assigneeId: string | null; dueAtMs: number | null; labelIds: string[]; version: number }

const WORKSPACE_ID = /^ws_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const PROJECT_ID = /^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const TASK_ID = /^tsk_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
function objectOrNull(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function isRole(value: unknown): value is 'OWNER' | 'ADMIN' | 'MEMBER' { return value === 'OWNER' || value === 'ADMIN' || value === 'MEMBER'; }
function asStringArray(value: unknown) { if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw new RedisFailure('INTERNAL_ERROR'); return value as string[]; }
function asScoredArray(value: unknown) {
  if (!Array.isArray(value)) throw new RedisFailure('INTERNAL_ERROR');
  return value.map((item) => {
    if (!item || typeof item !== 'object' || typeof item.value !== 'string' || typeof item.score !== 'number' || !Number.isFinite(item.score)) throw new RedisFailure('INTERNAL_ERROR');
    return { id: item.value, score: item.score };
  });
}
export function compareCandidate(a: Pick<Candidate, 'score' | 'id'>, b: Pick<Candidate, 'score' | 'id'>) {
  if (a.score !== b.score) return a.score - b.score;
  return a.id < b.id ? -1 : Number(a.id > b.id);
}

function validId(value: unknown, regex: RegExp): value is string {
  return typeof value === 'string' && regex.test(value);
}

function isStatus(value: unknown): value is TaskStatus {
  return TASK_STATUSES.includes(value as TaskStatus);
}
function pathProjection(value: unknown, paths: readonly string[]) {
  const object = objectOrNull(value);
  if (!object) return null;
  return Object.fromEntries(paths.map(path => [path.slice(2), pathScalar(value, path)]));
}

function pathScalar(value: unknown, path: string) {
  const raw = Array.isArray(value) ? value : objectOrNull(value)?.[path];
  return Array.isArray(raw) && raw.length === 1 ? raw[0] : undefined;
}

function safeTask(id: string, value: Record<string, unknown> | null): TaskView | null {
  if (!value) return null;
  const task: Record<string, unknown> = { ...value, deletedAt: value.deletedAt ?? null };
  if (value.id !== id || value.isDeleted === true || value.isDeleted === 'true' || value.deletedAt != null
    || typeof task.workspaceId !== 'string' || typeof task.projectId !== 'string'
    || !isStatus(task.status) || typeof task.key !== 'string' || typeof task.title !== 'string'
    || typeof task.priority !== 'string' || !Number.isSafeInteger(task.version) || typeof task.deletedAt !== 'string' && task.deletedAt !== null) return null;
  return task as TaskView;
}
function card(task: TaskView) {
  return { id: task.id, key: task.key as string, title: task.title as string, priority: task.priority as string,
    assigneeId: typeof task.assigneeId === 'string' ? task.assigneeId : null,
    dueAtMs: typeof task.dueAtMs === 'number' ? task.dueAtMs : null,
    labelIds: Array.isArray(task.labelIds) ? task.labelIds as string[] : [], version: task.version as number };
}
