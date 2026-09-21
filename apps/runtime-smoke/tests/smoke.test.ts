/**
 * Wave 2 offline integration test (task book §6.1, 11 steps).
 *
 * Runs the full scenario in-process against the REAL Wave 1 package
 * implementations (contracts + runtime-pi + persistence + event-journal +
 * tool-policy) with the app-local deterministic fake Pi SDK port.
 *
 * Every step's detailed assertions live inside the scenario
 * (src/scenario.ts); this test additionally pins the scenario report.
 * Output hygiene: only markers/counts are printed — no paths, no
 * credentials, no session content (test stdout is captured into D2
 * evidence logs and must stay secret-free).
 */

import { strict as assert } from "node:assert";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runWave2Scenario } from "../src/scenario.ts";

test("wave-2 offline scenario: full eleven-step integration flow", async () => {
  const root = await mkdtemp(join(tmpdir(), "runtime-smoke-test-"));
  const report = await runWave2Scenario(root);

  // Eight runs: 5 succeeded / 2 failed (host-crash recovery + degraded
  // session) / 1 aborted.
  assert.equal(report.runs, 8, "scenario run count");
  assert.equal(report.succeeded, 5, "succeeded run count");
  assert.equal(report.failed, 2, "failed run count");
  assert.equal(report.aborted, 1, "aborted run count");
  assert.equal(report.recoveredRuns, 1, "exactly one host-crash recovery");
  assert.equal(report.policyDecisions, 8, "eight policy probe decisions");
  assert.equal(report.sessionFilesCreated, 2, "two sessions were created");
  assert.equal(report.sessionFilesPersisted, 1, "only session A persists (B was deleted)");
  assert.ok(report.journalEventsGen1 >= 5, "generation-1 journal must hold events");
  assert.ok(report.journalEventsGen2 >= 20, "generation-2 journal must hold events");

  console.log(
    `runtime-smoke:scenario-report ok (runs=${report.runs} gen1-events=${report.journalEventsGen1} gen2-events=${report.journalEventsGen2})`,
  );
});
