import { scenario as concurrentCreate } from "./3.1-concurrent-create.js";
import { scenario as moveConflict } from "./3.2-move-conflict.js";
import { scenario as idempotency } from "./3.3-idempotency.js";
import { scenario as tenant } from "./3.4-tenant.js";
import { scenario as membership } from "./3.5-membership.js";
import { scenario as moveGuards } from "./3.6-move-guards.js";
import { scenario as placement } from "./3.7-placement.js";
import { scenario as prewriteError } from "./3.8-prewrite-error.js";
import { scenario as partialWrite } from "./3.9-partial-write.js";
import { scenario as verifier } from "./3.10-verifier.js";
import { runScenario, type ScenarioResult } from "./lib.js";

const scenarios = [
  concurrentCreate, moveConflict, idempotency, tenant, membership,
  moveGuards, placement, prewriteError, partialWrite, verifier,
];

export async function runAll() {
  const started = performance.now();
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    results.push(await runScenario(scenario));
  }

  console.log("\nScenario summary");
  console.table(results.map(({ id, name, passed, failed, elapsedMs }) => ({
    scenario: id, name, result: failed ? "FAIL" : "PASS", passed, failed, ms: elapsedMs.toFixed(1),
  })));
  const passed = results.filter(result => result.failed === 0).length;
  console.log(`${passed}/${results.length} scenarios passed in ${(performance.now() - started).toFixed(1)} ms`);
  return passed === results.length;
}

if (import.meta.main) {
  runAll().then(ok => {
    if (!ok) process.exitCode = 1;
  }).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
