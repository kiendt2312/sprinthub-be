import assert from "node:assert/strict";
import { createTask, moveTask, removeMember } from "../src/functions.js";
import {
  accepted, rejected, runStandalone, taskDocument, unchanged,
  type Scenario,
} from "./lib.js";

export const scenario: Scenario = {
  id: "3.4",
  name: "Tenant and idempotency key guards",
  async run({ client, keys, fixture, check }) {
    const fixtureA = await fixture();
    const fixtureB = await fixture();
    const actorId = `usr_${fixtureB.workspaceId}_shared`;
    await client.hSet(keys.workspaceMembers(fixtureA.workspaceId), actorId, "MEMBER");
    await client.sAdd(keys.userWorkspaces(actorId), fixtureA.workspaceId);
    await client.hSet(keys.workspaceMembers(fixtureB.workspaceId), actorId, "MEMBER");
    await client.sAdd(keys.userWorkspaces(actorId), fixtureB.workspaceId);
    const foreignIdempotencyKey = `tenant_${actorId}`;
    const used = fixtureB.createInput({ actorId, idempotencyKey: foreignIdempotencyKey });

    await check("workspace B successful create seeds its replay record", async () => {
      const reply = accepted(await createTask(client, used, keys));
      assert.equal((reply.data as { id: string }).id, used.taskId);
      assert.equal(await client.exists(keys.idempotency(actorId, foreignIdempotencyKey)), 1);
    });

    await check("B owner removes the actor who also belongs to A", async () => {
      const removed = accepted(await removeMember(client, fixtureB.removeInput({ userId: actorId }), keys));
      assert.equal(removed.seq, 2);
      assert.equal(Boolean(await client.hExists(keys.workspaceMembers(fixtureB.workspaceId), actorId)), false);
      assert.equal(Boolean(await client.hExists(keys.workspaceMembers(fixtureA.workspaceId), actorId)), true);
    });

    const mismatchedWorkspaceKeys = {
      ...keys,
      workspaceMembers: (workspaceId: string) =>
        workspaceId === fixtureB.workspaceId
          ? keys.workspaceMembers(fixtureA.workspaceId)
          : keys.workspaceMembers(workspaceId),
    };
    await check("workspace A membership key cannot replay B's successful create", async () => {
      await unchanged(client, keys, async () => {
        rejected(await createTask(client, used, mismatchedWorkspaceKeys), "KEYS_MISMATCH");
      });
      assert.equal((await taskDocument(client, keys, used.taskId) as { id: string }).id, used.taskId);
    });

    await check("coherent workspace A keys cannot target B's project", async () => {
      const crossTenant = fixtureA.createInput({ projectId: fixtureB.projectId, actorId });
      await unchanged(client, keys, async () => {
        rejected(await createTask(client, crossTenant, keys), "NOT_FOUND");
      });
      assert.equal(await client.exists(keys.task(crossTenant.taskId)), 0);
      assert.equal(await client.exists(keys.idempotency(actorId, crossTenant.idempotencyKey)), 0);
    });

    const actorAInput = fixtureA.createInput({ actorId: fixtureA.ownerId, idempotencyKey: foreignIdempotencyKey });
    const mismatchedActorKeys = {
      ...keys,
      idempotency: (requestedActorId: string, idempotencyKey: string) =>
        requestedActorId === fixtureA.ownerId && idempotencyKey === foreignIdempotencyKey
          ? keys.idempotency(actorId, foreignIdempotencyKey)
          : keys.idempotency(requestedActorId, idempotencyKey),
    };
    await check("actor A cannot read actor B's idempotency record", async () => {
      await unchanged(client, keys, async () => {
        rejected(await createTask(client, actorAInput, mismatchedActorKeys), "KEYS_MISMATCH");
      });
      assert.equal(await client.exists(keys.task(actorAInput.taskId)), 0);
    });

    const movedInput = fixtureA.createInput();
    await check("stale from value is rejected before idempotency", async () => {
      accepted(await createTask(client, movedInput, keys));
      accepted(await moveTask(client, fixtureA.moveInput(movedInput.taskId), keys));
      const staleFrom = fixtureA.moveInput(movedInput.taskId, {
        from: "TODO", to: "IN_REVIEW", idempotencyKey: `stale_${fixtureA.ownerId}`,
      });
      assert.equal(await client.exists(keys.idempotency(staleFrom.actorId, staleFrom.idempotencyKey)), 0);
      await unchanged(client, keys, async () => {
        rejected(await moveTask(client, staleFrom, keys), "KEYS_MISMATCH");
      });
      assert.equal(await client.exists(keys.idempotency(staleFrom.actorId, staleFrom.idempotencyKey)), 0);
      assert.equal((await taskDocument(client, keys, movedInput.taskId) as { status: string }).status, "IN_PROGRESS");
    });

    await check("outsider create is NOT_FOUND and leaves the full fixture unchanged", async () => {
      const outsiderInput = fixtureA.createInput({ actorId: fixtureA.outsiderId });
      await unchanged(client, keys, async () => {
        rejected(await createTask(client, outsiderInput, keys), "NOT_FOUND");
      });
      assert.equal(await client.exists(keys.task(outsiderInput.taskId)), 0);
      assert.equal(await client.exists(keys.idempotency(outsiderInput.actorId, outsiderInput.idempotencyKey)), 0);
    });
  },
};

if (import.meta.main) runStandalone(scenario);
