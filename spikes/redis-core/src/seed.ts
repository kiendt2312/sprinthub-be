import { parseArgs } from "node:util";
import { createRedisClient, DEFAULT_REDIS_URL } from "./client.js";
import { createKeys } from "./keys.js";

const workspaceId = "ws_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const projectId = "prj_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const ownerId = "usr_01ARZ3NDEKTSV4RRFFQ69G5FAX";
const members = {
  [ownerId]: "OWNER",
  usr_01ARZ3NDEKTSV4RRFFQ69G5FAY: "ADMIN",
  usr_01ARZ3NDEKTSV4RRFFQ69G5FAZ: "MEMBER",
};
const projectKey = "SHAPI";
const createdAt = "2016-07-30T23:54:10.259Z";
const metadata = { createdAt, createdAtMs: Date.parse(createdAt), version: 1, schemaVersion: 1 };

async function resetPrefix(client: ReturnType<typeof createRedisClient>, prefix: string) {
  // Escape Redis glob syntax so a configured prefix always matches literally.
  const pattern = `${prefix.replace(/[\\*?[\]]/g, "\\$&")}*`;
  let deleted = 0;
  for await (const batch of client.scanIterator({ MATCH: pattern, COUNT: 100 })) {
    if (batch.length > 0) {
      deleted += await client.unlink(batch);
    }
  }
  return deleted;
}

async function main() {
  const { values: { reset } } = parseArgs({ options: { reset: { type: "boolean" } } });
  const keys = createKeys();
  const url = process.env.REDIS_URL ?? DEFAULT_REDIS_URL;
  if (reset) {
    const target = new URL(url);
    const isSpikeHost = target.hostname === "127.0.0.1" || target.hostname === "localhost";
    if (target.protocol !== "redis:" || !isSpikeHost || target.port !== "6390") {
      throw new Error("Seed --reset only runs against the local Redis spike on port 6390");
    }
  }

  const client = createRedisClient(url);
  await client.connect();
  try {
    if (reset) {
      const deleted = await resetPrefix(client, keys.prefix);
      console.log(`Reset ${keys.prefix}: removed ${deleted} keys`);
    }

    const fixture = client.multi()
      .json.set(keys.workspace(workspaceId), "$", {
        ...metadata,
        id: workspaceId,
        name: "SprintHub Spike",
        slug: "sprinthub-spike",
        ownerId,
        archivedAt: null,
        suspendedAt: null,
        suspendedBy: null,
      }, { condition: "NX" })
      .json.set(keys.project(projectId), "$", {
        ...metadata,
        id: projectId,
        workspaceId,
        key: projectKey,
        name: "SprintHub API",
        description: "",
        createdBy: ownerId,
        archivedAt: null,
      }, { condition: "NX" });

    for (const [userId, role] of Object.entries(members)) {
      fixture.hSetNX(keys.workspaceMembers(workspaceId), userId, role);
      fixture.sAdd(keys.userWorkspaces(userId), workspaceId);
    }
    await fixture.exec();

    console.log(`Seed ready: ${workspaceId}, ${projectKey} (${projectId}), roles OWNER, ADMIN, MEMBER`);
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  console.error("Seed failed:", error);
  process.exitCode = 1;
});
