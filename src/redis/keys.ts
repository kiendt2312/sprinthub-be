export const DEFAULT_KEY_PREFIX = "sh:v1:";

export function createKeys(prefix = process.env.REDIS_KEY_PREFIX ?? DEFAULT_KEY_PREFIX) {
  if (prefix.length === 0) {
    throw new Error("REDIS_KEY_PREFIX must not be empty");
  }

  return {
    prefix,
    workspace: (workspaceId: string) => `${prefix}workspace:${workspaceId}`,
    workspaceMembers: (workspaceId: string) => `${prefix}workspace-members:${workspaceId}`,
    project: (projectId: string) => `${prefix}project:${projectId}`,
    projectTaskSeq: (projectId: string) => `${prefix}project-task-seq:${projectId}`,
    workspaceTaskKeys: (workspaceId: string) => `${prefix}workspace-task-keys:${workspaceId}`,
    task: (taskId: string) => `${prefix}task:${taskId}`,
    projectTasks: (projectId: string) => `${prefix}project-tasks:${projectId}`,
    board: (projectId: string, status: string) => `${prefix}board:${projectId}:${status}`,
    userAssigned: (userId?: string) => `${prefix}user-assigned:${userId || "none"}`,
    userWorkspaces: (userId: string) => `${prefix}user-workspaces:${userId}`,
    workspaceSeq: (workspaceId: string) => `${prefix}workspace-seq:${workspaceId}`,
    workspaceChanges: (workspaceId: string) => `${prefix}workspace-changes:${workspaceId}`,
    domainEvents: () => `${prefix}stream:domain-events`,
    idempotency: (actorId: string, key: string) => `${prefix}idempotency:${actorId}:${key}`,
  };
}
