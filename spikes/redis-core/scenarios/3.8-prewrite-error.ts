import assert from "node:assert/strict";
import { createTask } from "../src/functions.js";
import { accepted, runStandalone, unchanged, type Scenario } from "./lib.js";

export const scenario: Scenario = {
  id: "3.8",
  name: "Wrong key type before first write",
  async run({ client, keys, fixture, check }) {
    const { projectId, createInput } = await fixture();
    accepted(await createTask(client, createInput(), keys));

    const counter = keys.projectTaskSeq(projectId);
    await client.multi().del(counter).hSet(counter, "wrong-type", "1").exec();
    await check("HASH in project-task-seq raises WRONGTYPE without any writes", () =>
      unchanged(client, keys, async () => {
        await assert.rejects(createTask(client, createInput(), keys), /WRONGTYPE/);
      }));

    await client.multi().del(counter).set(counter, "1").exec();
    const stream = keys.domainEvents();
    await client.rename(stream, `${stream}:original`);
    await client.set(stream, "wrong type");
    await check("Wrong outbox type also raises WRONGTYPE before counters, JSON, or indexes change", () =>
      unchanged(client, keys, async () => {
        await assert.rejects(createTask(client, createInput(), keys), /WRONGTYPE/);
      }));
    await client.rename(`${stream}:original`, stream);
  },
};

if (import.meta.main) runStandalone(scenario);
