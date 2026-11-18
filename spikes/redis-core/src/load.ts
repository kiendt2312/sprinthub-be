import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRedisClient } from "./client.js";

export async function loadLibrary(client: ReturnType<typeof createRedisClient>) {
  const code = await readFile(new URL("../functions/sprinthub.lua", import.meta.url), "utf8");
  const name = await client.functionLoad(code, { REPLACE: true });
  assert.equal(name, "sprinthub");
  return name;
}

async function main() {
  const client = createRedisClient();
  await client.connect();
  try {
    const name = await loadLibrary(client);
    const version = await client.fCallRo("sh_lib_version");
    console.log(`Loaded ${name} (version ${version})`);
  } finally {
    await client.close();
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error("Function load failed:", error);
    process.exitCode = 1;
  });
}
