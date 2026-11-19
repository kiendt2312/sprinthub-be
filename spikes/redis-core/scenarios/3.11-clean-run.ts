import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createKeys } from "../src/keys.js";
import { assertFindings, withClients } from "./lib.js";
import { runAll } from "./run-all.js";

function runScript(path: string, ...args: string[]) {
  const script = fileURLToPath(new URL(path, import.meta.url));
  const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), script, ...args], {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${path} exited with ${result.signal ?? result.status}`);
}

async function main() {
  const started = performance.now();
  const results: { assertion: string; result: "PASS" | "FAIL" }[] = [];

  async function check(assertion: string, run: () => void | Promise<void>) {
    try {
      await run();
      results.push({ assertion, result: "PASS" });
      return true;
    } catch (error) {
      results.push({ assertion, result: "FAIL" });
      console.error(error);
      return false;
    }
  }

  const reset = await check("Seed reset completed", () => runScript("../src/seed.ts", "--reset"));
  if (reset && await check("Production library loaded", () => runScript("../src/load.ts"))) {
    const keys = createKeys();
    if (await check("Seed index verifier is clean before the suite", () =>
      withClients(1, ([client]) => assertFindings(client, keys, [])))) {
      await check("All ten scenarios passed their expected post-run verifier checks", async () => {
        assert(await runAll(), "At least one scenario failed");
      });
      await check("Seed index verifier is clean after the suite", () =>
        withClients(1, ([client]) => assertFindings(client, keys, [])));
    }
  }

  console.log(`\n3.11 Clean run (${(performance.now() - started).toFixed(1)} ms)`);
  console.table(results);
  if (results.some(result => result.result === "FAIL")) process.exitCode = 1;
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
