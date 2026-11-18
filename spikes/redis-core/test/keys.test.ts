import { afterEach, expect, it, vi } from "vitest";
import { createKeys } from "../src/keys.js";

afterEach(() => vi.unstubAllEnvs());

it("builds the spike Function keys with the default prefix", () => {
  vi.stubEnv("REDIS_KEY_PREFIX", undefined);
  const keys = createKeys();

  expect({
    workspace: keys.workspace("ws_1"),
    workspaceMembers: keys.workspaceMembers("ws_1"),
    project: keys.project("prj_1"),
    projectTaskSeq: keys.projectTaskSeq("prj_1"),
    workspaceTaskKeys: keys.workspaceTaskKeys("ws_1"),
    task: keys.task("tsk_1"),
    projectTasks: keys.projectTasks("prj_1"),
    board: keys.board("prj_1", "TODO"),
    userAssigned: keys.userAssigned("usr_1"),
    noAssignee: keys.userAssigned(),
    emptyAssignee: keys.userAssigned(""),
    userWorkspaces: keys.userWorkspaces("usr_1"),
    workspaceSeq: keys.workspaceSeq("ws_1"),
    workspaceChanges: keys.workspaceChanges("ws_1"),
    domainEvents: keys.domainEvents(),
    idempotency: keys.idempotency("usr_1", "key-1"),
  }).toEqual({
    workspace: "sh:v1:workspace:ws_1",
    workspaceMembers: "sh:v1:workspace-members:ws_1",
    project: "sh:v1:project:prj_1",
    projectTaskSeq: "sh:v1:project-task-seq:prj_1",
    workspaceTaskKeys: "sh:v1:workspace-task-keys:ws_1",
    task: "sh:v1:task:tsk_1",
    projectTasks: "sh:v1:project-tasks:prj_1",
    board: "sh:v1:board:prj_1:TODO",
    userAssigned: "sh:v1:user-assigned:usr_1",
    noAssignee: "sh:v1:user-assigned:none",
    emptyAssignee: "sh:v1:user-assigned:none",
    userWorkspaces: "sh:v1:user-workspaces:usr_1",
    workspaceSeq: "sh:v1:workspace-seq:ws_1",
    workspaceChanges: "sh:v1:workspace-changes:ws_1",
    domainEvents: "sh:v1:stream:domain-events",
    idempotency: "sh:v1:idempotency:usr_1:key-1",
  });
});

it("reads the prefix from the environment unless a prefix is passed explicitly", () => {
  vi.stubEnv("REDIS_KEY_PREFIX", "sh:test:");
  expect(createKeys().domainEvents()).toBe("sh:test:stream:domain-events");
  expect(createKeys("sh:isolated:").task("tsk_1")).toBe("sh:isolated:task:tsk_1");
});

it("rejects an empty prefix", () => {
  vi.stubEnv("REDIS_KEY_PREFIX", "");
  expect(() => createKeys()).toThrow("REDIS_KEY_PREFIX must not be empty");
});
