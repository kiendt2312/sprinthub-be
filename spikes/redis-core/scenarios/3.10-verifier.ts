import assert from "node:assert/strict";
import { createTask } from "../src/functions.js";
import { verifyTaskIndexes, type TaskIndexFinding } from "../src/verify-task-indexes.js";
import { accepted, runStandalone, type Scenario } from "./lib.js";

export const scenario: Scenario = {
  id: "3.10",
  name: "Verifier detects six types of corrupted fixture",
  async run({ client, keys, fixture, check, expectFindings }) {
    const { projectId, workspaceId, projectKey, createInput } = await fixture();
    const inputs = Array.from({ length: 6 }, () => createInput());
    for (const input of inputs) accepted(await createTask(client, input, keys));

    const [boardMissing, bothMissing, duplicate, wrongPointer, target, fractional] = inputs.map(input => input.taskId);
    const orphan = "tsk_missing_document";
    const todo = keys.board(projectId, "TODO");
    const inProgress = keys.board(projectId, "IN_PROGRESS");
    const projectTasks = keys.projectTasks(projectId);
    const issueIndex = keys.workspaceTaskKeys(workspaceId);
    const issueKey = `${projectKey}-4`;

    await check("The verifier reports a clean fixture before corruption", async () => {
      assert.deepEqual(await verifyTaskIndexes(client, keys), { ok: true, findings: [] });
    });

    await client.multi()
      .zRem(todo, [boardMissing, bothMissing])
      .sRem(projectTasks, bothMissing)
      .zAdd(inProgress, { value: duplicate, score: 1024 })
      .zAdd(todo, { value: orphan, score: 8192 })
      .hSet(issueIndex, issueKey, target)
      .zAdd(todo, { value: fractional, score: 1.5 })
      .exec();

    const cases: { label: string; findings: TaskIndexFinding[] }[] = [
      { label: "Missing from board", findings: [{ type: "missing", taskId: boardMissing, index: todo }] },
      { label: "Missing from both active indexes", findings: [
        { type: "missing", taskId: bothMissing, index: projectTasks },
        { type: "missing", taskId: bothMissing, index: todo },
      ] },
      { label: "Duplicate board placement and unexpected column", findings: [
        { type: "duplicate", taskId: duplicate, indexes: [inProgress, todo] },
        { type: "wrong-pointer", taskId: duplicate, index: inProgress, expected: todo },
      ] },
      { label: "Orphan board entry", findings: [{ type: "orphan", taskId: orphan, index: todo }] },
      { label: "Issue key points to the wrong task", findings: [
        { type: "wrong-pointer", taskId: target, key: issueKey, index: issueIndex, expected: wrongPointer, actual: target },
      ] },
      { label: "Fractional board score", findings: [{ type: "bad-score", taskId: fractional, index: todo, score: 1.5 }] },
    ];
    const report = await verifyTaskIndexes(client, keys);
    for (const { label, findings } of cases) {
      expectFindings(...findings);
      await check(label, () => {
        for (const finding of findings) assert.deepEqual(
          report.findings.find(actual => actual.type === finding.type &&
            actual.taskId === finding.taskId && actual.index === finding.index),
          finding,
        );
      });
    }
  },
};

if (import.meta.main) runStandalone(scenario);
