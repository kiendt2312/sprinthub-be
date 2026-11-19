import assert from "node:assert/strict";
import { createTask, moveTask, type MoveTaskInput } from "../src/functions.js";
import {
  accepted, rejected, runStandalone, taskDocument, unchanged,
  type Scenario,
} from "./lib.js";

export const scenario: Scenario = {
  id: "3.6",
  name: "Move rejection guards and valid reorder",
  async run({ client, keys, fixture, check }) {
    const f = await fixture();
    async function makeTask(overrides: Parameters<typeof f.createInput>[0] = {}) {
      const input = f.createInput(overrides);
      accepted(await createTask(client, input, keys));
      return input.taskId;
    }
    async function move(id: string, overrides: Parameters<typeof f.moveInput>[1] = {}) {
      return moveTask(client, f.moveInput(id, overrides), keys);
    }

    const mover = await makeTask();
    const todoAnchor = await makeTask();
    const destinationIds = [await makeTask(), await makeTask(), await makeTask()];
    for (const taskId of destinationIds) {
      accepted(await move(taskId, { to: "IN_PROGRESS" }));
    }

    const otherProjectId = `prj_${f.workspaceId}_other`;
    await client.json.set(keys.project(otherProjectId), "$", {
      id: otherProjectId, workspaceId: f.workspaceId, key: "OTHER", archivedAt: null,
    });
    const otherProjectTaskInput = f.createInput({ projectId: otherProjectId });
    accepted(await createTask(client, otherProjectTaskInput, keys));
    accepted(await move(otherProjectTaskInput.taskId, { projectId: otherProjectId }));

    await check("actor outside workspace cannot move a task", async () => {
      const input = f.moveInput(mover, { actorId: f.outsiderId, idempotencyKey: "outside_move" });
      await unchanged(client, keys, async () => rejected(await moveTask(client, input, keys), "NOT_FOUND"));
    });

    await check("absent task is NOT_FOUND without writes", async () => {
      const absent = `tsk_${f.workspaceId}_absent`;
      await unchanged(client, keys, async () => rejected(
        await move(absent, { idempotencyKey: "absent_move" }), "NOT_FOUND",
      ));
    });

    await check("soft-deleted task is NOT_FOUND and remains verifier-clean", async () => {
      const deletedId = await makeTask();
      const { key: issueKey } = await taskDocument(client, keys, deletedId);
      assert(typeof issueKey === "string", "Expected an issue key for the soft-deleted fixture");
      const task = keys.task(deletedId);
      await client.multi()
        .json.set(task, "$.deletedAt", new Date().toISOString())
        .json.set(task, "$.isDeleted", "true")
        .sRem(keys.projectTasks(f.projectId), deletedId)
        .zRem(keys.board(f.projectId, "TODO"), deletedId)
        .exec();
      await unchanged(client, keys, async () => rejected(
        await move(deletedId, { idempotencyKey: "deleted_move" }), "NOT_FOUND",
      ));
      assert.equal(await client.hGet(keys.workspaceTaskKeys(f.workspaceId), issueKey), deletedId);
    });

    await check("archived project rejects new move", async () => {
      const project = keys.project(f.projectId);
      await client.json.set(project, "$.archivedAt", new Date().toISOString());
      try {
        await unchanged(client, keys, async () => rejected(
          await move(mover, { idempotencyKey: "archived_move" }), "PROJECT_ARCHIVED",
        ));
      } finally {
        await client.json.set(project, "$.archivedAt", null);
      }
    });

    await check("TODO to DONE is rejected", async () => {
      await unchanged(client, keys, async () => rejected(
        await move(mover, { to: "DONE", idempotencyKey: "invalid_transition" }), "INVALID_STATUS_TRANSITION",
      ));
    });

    const invalidAnchors: [string, Partial<MoveTaskInput>][] = [
      ["anchor from another project", { afterTaskId: otherProjectTaskInput.taskId }],
      ["anchor in a different column", { afterTaskId: todoAnchor }],
      ["missing anchor", { afterTaskId: `tsk_${f.workspaceId}_missing_anchor` }],
      ["same before and after anchor", { afterTaskId: destinationIds[0], beforeTaskId: destinationIds[0] }],
      ["moving task used as an anchor", { to: "TODO", afterTaskId: mover }],
      ["non-adjacent anchors", { afterTaskId: destinationIds[0], beforeTaskId: destinationIds[2] }],
    ];
    for (const [label, options] of invalidAnchors) {
      await check(`${label} is INVALID_POSITION_ANCHOR`, async () => {
        await unchanged(client, keys, async () => rejected(
          await move(mover, { ...options, idempotencyKey: `anchor_${label.replaceAll(" ", "_")}` }),
          "INVALID_POSITION_ANCHOR",
        ));
      });
    }

    await check("after-only anchor must be the last destination task", async () => {
      await unchanged(client, keys, async () => rejected(
        await move(mover, { afterTaskId: destinationIds[0], idempotencyKey: "after_not_last" }),
        "INVALID_POSITION_ANCHOR",
      ));
    });

    await check("before-only anchor must be the first destination task", async () => {
      await unchanged(client, keys, async () => rejected(
        await move(mover, { beforeTaskId: destinationIds[2], idempotencyKey: "before_not_first" }),
        "INVALID_POSITION_ANCHOR",
      ));
    });

    await check("reorder in one column preserves requested order and increments version", async () => {
      const reorder = await fixture();
      const [first, second, third] = Array.from({ length: 3 }, () => reorder.createInput());
      for (const input of [first, second, third]) accepted(await createTask(client, input, keys));
      const result = accepted(await moveTask(client, reorder.moveInput(first.taskId, {
        from: "TODO", to: "TODO", afterTaskId: second.taskId, beforeTaskId: third.taskId,
      }), keys));
      assert.equal(result.seq, 4);
      assert.deepEqual(await client.zRange(keys.board(reorder.projectId, "TODO"), 0, -1), [
        second.taskId, first.taskId, third.taskId,
      ]);
      assert.equal((await taskDocument(client, keys, first.taskId)).version, 2);
      for (const { taskId } of [second, third]) {
        assert.equal((await taskDocument(client, keys, taskId)).version, 1);
      }
    });
  },
};

if (import.meta.main) runStandalone(scenario);
