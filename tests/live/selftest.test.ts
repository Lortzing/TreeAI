/**
 * Offline self-test of the live scenario framework: all six scenarios run
 * against the fake driver (zero credentials, zero network), and every
 * produced record validates against the scenarioResult schema.
 *
 * This is what guarantees scripts/verify-d2-live.js --driver=fake is
 * meaningful: the framework exercised here is the very same module.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LIVE_SCENARIO_IDS,
  defaultFakeScripts,
  fakeDriver,
  loadPiDriver,
  runAllScenarios,
} from "./framework.ts";
import { validateJsonSchema } from "../support/verifier/schema-validator.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");

function scenarioResultSchema(): Record<string, unknown> {
  const resultSchema = JSON.parse(
    readFileSync(join(REPO_ROOT, "schemas", "d2", "result.schema.json"), "utf8"),
  ) as Record<string, unknown>;
  return { $ref: "#/$defs/scenarioResult", $defs: resultSchema["$defs"] } as Record<string, unknown>;
}

test("the six frozen scenario ids are exactly the task-book list", () => {
  assert.deepEqual([...LIVE_SCENARIO_IDS], [
    "basic",
    "tool-policy",
    "steer",
    "abort",
    "resume",
    "tree-navigation",
  ]);
});

test("all six scenarios PASS against the fake driver and validate against scenarioResult", async () => {
  const dir = mkdtempSync(join(tmpdir(), "treeai-live-selftest."));
  try {
    const records = await runAllScenarios({
      driver: fakeDriver({ scriptByScenario: defaultFakeScripts(), longDelayMs: 300 }),
      model: { providerId: "fake-provider", modelId: "fake-model" },
      sessionDir: join(dir, "sessions"),
    });
    assert.equal(records.length, 6);
    const schema = scenarioResultSchema();
    for (const record of records) {
      assert.equal(
        record.status,
        "PASS",
        `scenario ${record.scenario} did not pass: ${JSON.stringify(record.error ?? record.reason)}`,
      );
      assert.equal(record.exitCode, 0);
      assert.equal(record.driver, "fake");
      assert.equal(record.piVersion, "0.85.1");
      const res = validateJsonSchema(record, schema);
      assert.ok(res.valid, `record failed schema: ${JSON.stringify(res.errors)}`);
    }
    const ids = records.map((r) => r.scenario);
    assert.deepEqual(ids, [...LIVE_SCENARIO_IDS]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadPiDriver reports the honest state (real module or NOT_RUN reason)", async () => {
  const result = await loadPiDriver();
  // Either the real module exposes a factory (driver != null) or we get an
  // honest problem string. Never a silent fake fallback.
  if (result.driver === null) {
    assert.ok(typeof result.problem === "string" && result.problem.length > 0);
  } else {
    assert.equal(result.driver.name, "pi");
  }
});
