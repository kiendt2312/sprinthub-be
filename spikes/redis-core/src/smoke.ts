import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRedisClient } from "./client.js";
import { createKeys } from "./keys.js";

const expectedConfig = {
  appendonly: "yes",
  appendfsync: "always",
  "no-appendfsync-on-rewrite": "no",
  "aof-timestamp-enabled": "yes",
  "aof-load-truncated": "yes",
  maxmemory: String(256 * 1024 * 1024),
  "maxmemory-policy": "noeviction",
};

async function main() {
  const key = `${createKeys().prefix}spike-smoke:${randomUUID()}`;
  const client = createRedisClient();
  await client.connect();
  try {
    assert.equal(await client.ping(), "PONG");
    console.log("PASS PING");

    const config = await client.configGet(Object.keys(expectedConfig));
    for (const [setting, value] of Object.entries(expectedConfig)) {
      assert.equal(config[setting], value, `CONFIG GET ${setting}`);
    }
    console.log("PASS CONFIG GET (AOF, fsync, timestamps, truncated load, maxmemory, noeviction)");

    const document = { status: "TODO", assigneeId: null };
    assert.equal(await client.json.set(key, "$", document), "OK");
    try {
      assert.deepEqual(await client.json.get(key), document);
      assert.deepEqual(await client.json.get(key, { path: ["$.status", "$.assigneeId", "$.missing"] }), {
        "$.status": ["TODO"],
        "$.assigneeId": [null],
        "$.missing": [],
      });
    } finally {
      await client.del(key);
    }
    console.log("PASS JSON.SET / JSON.GET (full document and arrays per JSONPath)");

    const libraries = await client.functionList();
    assert.ok(Array.isArray(libraries), "FUNCTION LIST must return an array");
    console.log(`PASS FUNCTION LIST (${libraries.length} libraries)`);
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  console.error("Smoke failed:", error);
  process.exitCode = 1;
});
