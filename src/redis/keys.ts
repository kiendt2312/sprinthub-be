export const DEFAULT_KEY_PREFIX = "sh:v1:";

export function createKeys(prefix = process.env.REDIS_KEY_PREFIX ?? DEFAULT_KEY_PREFIX) {
  if (prefix.length === 0) {
    throw new Error("REDIS_KEY_PREFIX must not be empty");
  }

  return {
    prefix,
    user: (userId: string) => `${prefix}user:${userId}`,
    userEmail: (digest: string) => `${prefix}user-email:${digest}`,
    usersByCreated: () => `${prefix}users-by-created`,
    session: (digest: string) => `${prefix}session:${digest}`,
    userSessions: (userId: string) => `${prefix}user-sessions:${userId}`,
    platformAdmins: () => `${prefix}platform-admins`,
    platformSettings: () => `${prefix}platform-settings`,
    audit: () => `${prefix}stream:audit`,
    rateLimit: (policy: string, subject: string) => `${prefix}ratelimit:${policy}:${subject}`,
    workspace: (workspaceId: string) => `${prefix}workspace:${workspaceId}`,
    workspaceSlug: (slug: string) => `${prefix}workspace-slug:${slug}`,
    workspacesByCreated: () => `${prefix}workspaces-by-created`,
    userWorkspacesPage: (userId: string) => `${prefix}user-workspaces-page:${userId}`,
    workspaceMembersPage: (workspaceId: string) => `${prefix}workspace-members-page:${workspaceId}`,
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
    unassignJob: (id: string) => `${prefix}job:${id}`,
    unassignJobsByDue: () => `${prefix}unassign-jobs-by-due`,
    unassignLock: (workspaceId: string, userId: string) => `${prefix}lock:unassign:${workspaceId}:${userId}`,
    unassignFence: (workspaceId: string, userId: string) => `${prefix}fence:unassign:${workspaceId}:${userId}`,
    deadLetter: () => `${prefix}stream:dead-letter`,
    unassignDeadLetterMarker: (streamId: string) => `${prefix}processed:dlq:${streamId}`,
    idempotency: (actorId: string, key: string) => `${prefix}idempotency:${actorId}:${key}`,
  };
}
