import { createHash } from "node:crypto";
import type { createRedisClient } from "./client.js";
import { createKeys } from "./keys.js";
import { decodeReply } from "./reply.js";

type Client = ReturnType<typeof createRedisClient>;
type Keys = ReturnType<typeof createKeys>;

interface Mutation {
  workspaceId: string;
  actorId: string;
  idempotencyKey: string;
  nowMs: number;
}

export interface CreateTaskInput extends Mutation {
  projectId: string;
  taskId: string;
  assigneeId?: string | null;
  payload: {
    title: string;
    description?: string;
    priority?: string;
    dueAtMs?: number | null;
  };
  clientMutationId: string;
}

export interface MoveTaskInput extends Mutation {
  projectId: string;
  taskId: string;
  from: string;
  to: string;
  afterTaskId?: string | null;
  beforeTaskId?: string | null;
  expectedVersion: number;
  clientMutationId: string;
}

export interface RemoveMemberInput extends Mutation {
  userId: string;
}

function requestHash(operation: string, target: string[], payload: object) {
  return createHash("sha256").update(JSON.stringify([operation, target, payload])).digest("hex");
}

function mutationKeys(keys: Keys, input: Mutation) {
  return [
    keys.workspaceSeq(input.workspaceId),
    keys.workspaceChanges(input.workspaceId),
    keys.domainEvents(),
    keys.idempotency(input.actorId, input.idempotencyKey),
  ];
}

export async function createTask(client: Client, input: CreateTaskInput, keys = createKeys()) {
  const { workspaceId, projectId, actorId, taskId, idempotencyKey, clientMutationId, nowMs } = input;
  const assigneeId = input.assigneeId ?? "";
  const payload = {
    title: input.payload.title,
    description: input.payload.description ?? "",
    priority: input.payload.priority ?? "MEDIUM",
    dueAtMs: input.payload.dueAtMs ?? null,
  };
  // The project is the target. The caller's generated taskId can change across API retries.
  const hash = requestHash("sh_create_task", [workspaceId, projectId], {
    ...payload, assigneeId, clientMutationId,
  });

  return decodeReply(await client.fCall("sh_create_task", {
    keys: [
      keys.workspaceMembers(workspaceId), keys.project(projectId), keys.projectTaskSeq(projectId),
      keys.workspaceTaskKeys(workspaceId), keys.task(taskId), keys.projectTasks(projectId),
      keys.board(projectId, "TODO"), keys.userAssigned(assigneeId), ...mutationKeys(keys, input),
    ],
    arguments: [
      workspaceId, projectId, actorId, taskId, assigneeId, JSON.stringify(payload),
      idempotencyKey, hash, clientMutationId, String(nowMs),
    ],
  }));
}

export async function moveTask(client: Client, input: MoveTaskInput, keys = createKeys()) {
  const {
    workspaceId, projectId, taskId, actorId, from, to, expectedVersion,
    idempotencyKey, clientMutationId, nowMs,
  } = input;
  const afterTaskId = input.afterTaskId ?? "";
  const beforeTaskId = input.beforeTaskId ?? "";
  const hash = requestHash("sh_move_task", [workspaceId, projectId, taskId], {
    to, afterTaskId, beforeTaskId, expectedVersion, clientMutationId,
  });

  return decodeReply(await client.fCall("sh_move_task", {
    keys: [
      keys.workspaceMembers(workspaceId), keys.project(projectId), keys.task(taskId),
      keys.board(projectId, from), keys.board(projectId, to), ...mutationKeys(keys, input),
    ],
    arguments: [
      workspaceId, projectId, taskId, actorId, from, to, afterTaskId, beforeTaskId,
      String(expectedVersion), idempotencyKey, hash, clientMutationId, String(nowMs),
    ],
  }));
}

export async function removeMember(client: Client, input: RemoveMemberInput, keys = createKeys()) {
  const { workspaceId, actorId, userId, idempotencyKey, nowMs } = input;
  const hash = requestHash("sh_remove_member", [workspaceId, userId], {});
  return decodeReply(await client.fCall("sh_remove_member", {
    keys: [keys.workspaceMembers(workspaceId), keys.userWorkspaces(userId), ...mutationKeys(keys, input)],
    arguments: [workspaceId, actorId, userId, idempotencyKey, hash, String(nowMs)],
  }));
}
