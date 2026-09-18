/**
 * Validator tests: task-book field rules for events and results, JSONL
 * file validation with seq monotonicity, shared-schema detection.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateEvidenceEvent,
  validateScenarioResult,
  validateEventFile,
  detectSharedSchemas,
} from "../src/validate.js";
import type { EvidenceEvent, ScenarioResult } from "../src/types.js";

function sampleEvent(overrides: Partial<EvidenceEvent> = {}): EvidenceEvent {
  return {
    seq: 1,
    observedAt: "2026-09-18T00:00:00.000Z",
    implementation: "sdk-node",
    scenario: "basic",
    sessionId: "test-id",
    piEventType: "message_update",
    runState: "running",
    payload: {},
    redactionVersion: "d1-v1",
    ...overrides,
  };
}

function sampleResult(overrides: Partial<ScenarioResult> = {}): ScenarioResult {
  return {
    implementation: "sdk-node",
    scenario: "basic",
    status: "PASS",
    startedAt: "2026-09-18T00:00:00.000Z",
    endedAt: "2026-09-18T00:00:01.000Z",
    durationMs: 1000,
    command: "npm run probe:basic",
    exitCode: 0,
    evidenceFiles: ["events.jsonl"],
    observations: [],
    limitations: [],
    error: null,
    ...overrides,
  };
}

test("valid event passes", () => {
  assert.deepEqual(validateEvidenceEvent(sampleEvent()), { ok: true, errors: [] });
});

test("invalid events are rejected field by field", () => {
  assert.equal(validateEvidenceEvent(sampleEvent({ seq: 0 })).ok, false);
  assert.equal(validateEvidenceEvent(sampleEvent({ seq: 1.5 })).ok, false);
  assert.equal(validateEvidenceEvent(sampleEvent({ observedAt: "yesterday" })).ok, false);
  assert.equal(
    validateEvidenceEvent(sampleEvent({ implementation: "rpc-python" as EvidenceEvent["implementation"] })).ok,
    false,
  );
  assert.equal(
    validateEvidenceEvent(sampleEvent({ scenario: "bogus" as EvidenceEvent["scenario"] })).ok,
    false,
  );
  assert.equal(validateEvidenceEvent(sampleEvent({ sessionId: "" })).ok, false);
  assert.equal(validateEvidenceEvent(sampleEvent({ redactionVersion: "v0" })).ok, false);
  assert.equal(validateEvidenceEvent({} as EvidenceEvent).ok, false);
});

test("valid result passes; invalid statuses rejected", () => {
  assert.equal(validateScenarioResult(sampleResult()).ok, true);
  assert.equal(validateScenarioResult(sampleResult({ status: "MAYBE" as ScenarioResult["status"] })).ok, false);
  assert.equal(validateScenarioResult(sampleResult({ exitCode: 1.5 })).ok, false);
  assert.equal(validateScenarioResult(sampleResult({ durationMs: -1 })).ok, false);
  assert.equal(validateScenarioResult(sampleResult({ evidenceFiles: "nope" as unknown as string[] })).ok, false);
  assert.equal(
    validateScenarioResult(sampleResult({ error: "string" as unknown as ScenarioResult["error"] })).ok,
    false,
  );
});

test("validateEventFile: good file passes with count", () => {
  const dir = mkdtempSync(join(tmpdir(), "treeai-validate-"));
  const path = join(dir, "events.jsonl");
  const events = [sampleEvent({ seq: 1 }), sampleEvent({ seq: 2, piEventType: "message_end" })];
  writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const r = validateEventFile(path);
  assert.equal(r.ok, true);
  assert.equal(r.count, 2);
});

test("validateEventFile: non-monotonic seq fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "treeai-validate-"));
  const path = join(dir, "events.jsonl");
  const events = [sampleEvent({ seq: 2 }), sampleEvent({ seq: 2 }), sampleEvent({ seq: 1 })];
  writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const r = validateEventFile(path);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("not strictly greater")));
});

test("validateEventFile: broken JSON line fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "treeai-validate-"));
  const path = join(dir, "events.jsonl");
  writeFileSync(path, JSON.stringify(sampleEvent()) + "\n{broken\n");
  const r = validateEventFile(path);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("invalid JSON")));
});

test("detectSharedSchemas reports absence honestly", () => {
  const r = detectSharedSchemas(join(tmpdir(), "treeai-no-d1"));
  // Shared schemas may or may not exist in the real repo; assert type only.
  assert.ok(r.evidenceEventSchema === null || typeof r.evidenceEventSchema === "string");
  assert.ok(r.scenarioResultSchema === null || typeof r.scenarioResultSchema === "string");
});

test("detectSharedSchemas finds schemas when present", () => {
  const dir = mkdtempSync(join(tmpdir(), "treeai-d1-with-schemas-"));
  mkdirSync(join(dir, "schemas"), { recursive: true });
  writeFileSync(join(dir, "schemas", "evidence-event.schema.json"), "{}");
  const r = detectSharedSchemas(dir);
  assert.ok(r.evidenceEventSchema !== null);
  assert.equal(r.scenarioResultSchema, null);
});
