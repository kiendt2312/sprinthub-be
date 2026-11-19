import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { events, runStandalone, taskDocument, type Scenario } from "./lib.js";

const injectionPoints = [
  {
    label: "after JSON.SET task",
    line: "    redis.call('JSON.SET', keys[5], '$', document)",
    after: true,
  },
  {
    label: "before XADD",
    line: "        redis.call('XADD', stream, '*', unpack(fields))",
    after: false,
  },
];

function injectFailure(source: string, name: string, point: typeof injectionPoints[number]) {
  const registrations = "\nredis.register_function('sh_create_task', create_task)";
  const end = source.indexOf(registrations);
  assert(end >= 0, "Could not locate production function registrations");
  const body = source.slice(0, end);
  assert.equal(body.split(point.line).length, 2, `Expected one injection point ${point.label}`);

  // Use a conditional so Lua permits the following production statements.
  const failure = "if true then error('Injected spike failure') end";
  const replacement = point.after ? `${point.line}\n    ${failure}` : `        ${failure}\n${point.line}`;
  return body.replace("#!lua name=sprinthub\n", `#!lua name=${name}\n`)
    .replace(point.line, () => replacement) + `\nredis.register_function('${name}', create_task)\n`;
}

export const scenario: Scenario = {
  id: "3.9",
  name: "Partial writes after injected runtime errors",
  async run({ client, keys, fixture, check, expectFindings }) {
    const source = await readFile(new URL("../functions/sprinthub.lua", import.meta.url), "utf8");
    const listProduction = () => client.sendCommand(["FUNCTION", "LIST", "LIBRARYNAME", "sprinthub", "WITHCODE"]);
    const productionLibrary = await listProduction();
    assert(Array.isArray(productionLibrary) && productionLibrary.length === 1);
    const [library] = productionLibrary;
    assert(library && typeof library === "object" && "library_code" in library && library.library_code === source,
      "Loaded production Lua differs from the source under test");

    for (const point of injectionPoints) {
      const { workspaceId, projectId, projectKey, memberId, createInput } = await fixture();
      const input = createInput({ assigneeId: memberId });
      const { actorId, taskId, idempotencyKey, clientMutationId, nowMs } = input;
      const idem = keys.idempotency(actorId, idempotencyKey);
      const projectTasks = keys.projectTasks(projectId);
      const board = keys.board(projectId, "TODO");
      const issueIndex = keys.workspaceTaskKeys(workspaceId);
      const name = `sh_fault_${randomBytes(12).toString("hex")}`;

      const payload = { title: input.payload.title, description: "", priority: "MEDIUM", dueAtMs: null };
      const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");

      if (point.after) {
        expectFindings({ type: "missing", taskId, index: projectTasks }, { type: "missing", taskId, index: board });
      }

      assert.equal(await client.functionLoad(injectFailure(source, name, point)), name);
      try {
        await check(`${point.label}: instrumented FCALL fails at the injected error`, async () => {
          await assert.rejects(client.fCall(name, {
            keys: [
              keys.workspaceMembers(workspaceId), keys.project(projectId), keys.projectTaskSeq(projectId),
              issueIndex, keys.task(taskId), projectTasks, board, keys.userAssigned(memberId),
              keys.workspaceSeq(workspaceId), keys.workspaceChanges(workspaceId), keys.domainEvents(), idem,
            ],
            arguments: [
              workspaceId, projectId, actorId, taskId, memberId, JSON.stringify(payload),
              idempotencyKey, hash, clientMutationId, String(nowMs),
            ],
          }), /Injected spike failure/);
        });

        await check(`${point.label}: JSON, counters, and issue pointer survive`, async () => {
          const task = await taskDocument(client, keys, taskId);
          assert.equal(task.id, taskId);
          assert.equal(task.assigneeId, memberId);
          assert.equal(task.lastSeq, 1);
          assert.equal(await client.get(keys.projectTaskSeq(projectId)), "1");
          assert.equal(await client.get(keys.workspaceSeq(workspaceId)), "1");
          assert.equal(await client.hGet(issueIndex, `${projectKey}-1`), taskId);
        });

        await check(`${point.label}: remaining indexes show exactly how far the write reached`, async () => {
          assert.equal(Boolean(await client.sIsMember(projectTasks, taskId)), !point.after);
          assert.equal(await client.zScore(board, taskId), point.after ? null : 1024);
          assert.equal(Boolean(await client.sIsMember(keys.userAssigned(memberId), taskId)), !point.after);
          assert.equal(await client.zScore(keys.workspaceChanges(workspaceId), `task:${taskId}`), point.after ? null : 1);
        });

        await check(`${point.label}: event and idempotency record are both missing`, async () => {
          assert.deepEqual(await events(client, keys, workspaceId), []);
          assert.equal(await client.exists(idem), 0);
        });
      } finally {
        await client.functionDelete(name);
      }
    }

    await check("The production library has the same registered functions and source", async () => {
      assert.deepEqual(await listProduction(), productionLibrary);
    });
  },
};

if (import.meta.main) runStandalone(scenario);
