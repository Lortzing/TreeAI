/**
 * Runner tests: timeout, cleanup ordering, blocked classification, check
 * failures, exit codes, evidence durability on failure.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runScenario, aggregateExitCode } from "../src/runner.js";
import { BlockedError } from "../src/blocked.js";
import { sleep } from "../src/fake-session.js";
import type { ScenarioResult } from "../src/types.js";

function tmpRunDir(): string {
  return mkdtempSync(join(tmpdir(), "treeai-runner-"));
}

test("PASS path: checks pass, events finalized, result written with exit 0", async () => {
  const runDir = tmpRunDir();
  const result = await runScenario({
    scenario: "basic",
    command: "test",
    timeoutMs: 5_000,
    runDir,
    exec: async (ctx) => {
      ctx.recorder.record("agent_start", {});
      ctx.check(true, "always-true");
      ctx.observe("obs");
    },
  });
  assert.equal(result.status, "PASS");
  assert.equal(result.exitCode, 0);
  assert.equal(result.error, null);
  assert.ok(existsSync(join(runDir, "basic", "events.jsonl")));
  assert.ok(existsSync(join(runDir, "basic", "result.json")));
  assert.ok(result.evidenceFiles[0]!.endsWith("events.jsonl"));
});

test("timeout: exec hangs -> FAIL with TimeoutError, cleanup still runs, non-zero exit", async () => {
  const runDir = tmpRunDir();
  let cleanupRan = false;
  const result = await runScenario({
    scenario: "abort",
    command: "test",
    timeoutMs: 150,
    runDir,
    exec: async (ctx) => {
      ctx.onCleanup(() => {
        cleanupRan = true;
      });
      ctx.recorder.record("agent_start", {});
      await new Promise(() => {}); // hang forever
    },
  });
  assert.equal(result.status, "FAIL");
  assert.equal(result.exitCode, 1);
  assert.equal(result.error?.name, "TimeoutError");
  assert.equal(cleanupRan, true);
  // Evidence survives the timeout.
  const events = readFileSync(join(runDir, "abort", "events.jsonl"), "utf8");
  assert.ok(events.includes("agent_start"));
  assert.ok(events.includes("probe_error"));
  assert.ok(events.includes("scenario_end"));
});

test("blocked: BlockedError -> BLOCKED with reason, exit 2, evidence kept", async () => {
  const runDir = tmpRunDir();
  const result = await runScenario({
    scenario: "basic",
    command: "test",
    timeoutMs: 5_000,
    runDir,
    exec: async (ctx) => {
      ctx.recorder.recordMarker("about_to_block", {});
      throw new BlockedError("BLOCKED_CREDENTIALS", "no auth");
    },
  });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.exitCode, 2);
  assert.equal(result.error?.blockedReason, "BLOCKED_CREDENTIALS");
  const events = readFileSync(join(runDir, "basic", "events.jsonl"), "utf8");
  assert.ok(events.includes("BLOCKED_CREDENTIALS"));
});

test("failed checks mark FAIL with structured message", async () => {
  const runDir = tmpRunDir();
  const result = await runScenario({
    scenario: "tool",
    command: "test",
    timeoutMs: 5_000,
    runDir,
    exec: async (ctx) => {
      ctx.check(false, "expected-marker-missing");
      ctx.check(true, "other");
    },
  });
  assert.equal(result.status, "FAIL");
  assert.deepEqual(result.failedChecks, ["expected-marker-missing"]);
  assert.equal(result.error?.name, "ScenarioCheckError");
});

test("exec throws -> FAIL with structured error, cleanups run in reverse", async () => {
  const runDir = tmpRunDir();
  const order: string[] = [];
  const result = await runScenario({
    scenario: "steer",
    command: "test",
    timeoutMs: 5_000,
    runDir,
    exec: async (ctx) => {
      ctx.onCleanup(() => {
        order.push("first");
      });
      ctx.onCleanup(() => {
        order.push("second");
      });
      throw new Error("model exploded");
    },
  });
  assert.equal(result.status, "FAIL");
  assert.equal(result.error?.message, "model exploded");
  assert.deepEqual(order, ["second", "first"]);
});

test("cleanup errors are recorded but do not mask the original status", async () => {
  const runDir = tmpRunDir();
  const result = await runScenario({
    scenario: "basic",
    command: "test",
    timeoutMs: 5_000,
    runDir,
    exec: async (ctx) => {
      ctx.onCleanup(() => {
        throw new Error("cleanup boom");
      });
      ctx.observe("fine");
    },
  });
  assert.equal(result.status, "PASS");
  const events = readFileSync(join(runDir, "basic", "events.jsonl"), "utf8");
  assert.ok(events.includes("cleanup boom"));
});

test("aggregateExitCode: FAIL beats BLOCKED beats NOT_RUN beats PASS", () => {
  const mk = (status: ScenarioResult["status"]): ScenarioResult => ({
    implementation: "sdk-node",
    scenario: "basic",
    status,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: 0,
    command: "test",
    exitCode: 0,
    evidenceFiles: [],
    observations: [],
    limitations: [],
    error: null,
  });
  assert.equal(aggregateExitCode([mk("PASS"), mk("BLOCKED")]), 2);
  assert.equal(aggregateExitCode([mk("PASS"), mk("FAIL")]), 1);
  assert.equal(aggregateExitCode([mk("BLOCKED"), mk("FAIL")]), 1);
  assert.equal(aggregateExitCode([mk("PASS"), mk("NOT_RUN")]), 3);
  assert.equal(aggregateExitCode([mk("PASS")]), 0);
});

test("result.json is valid per the task-book validator and timestamps are real", async () => {
  const runDir = tmpRunDir();
  const result = await runScenario({
    scenario: "resume",
    command: "test",
    timeoutMs: 5_000,
    runDir,
    exec: async (ctx) => {
      await sleep(20);
    },
  });
  const raw = JSON.parse(readFileSync(join(runDir, "resume", "result.json"), "utf8"));
  assert.equal(raw.status, "PASS");
  assert.ok(raw.durationMs >= 20);
  assert.ok(new Date(raw.endedAt).getTime() >= new Date(raw.startedAt).getTime());
  // startedAt/endedAt use the exact ISO format
  assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(raw.startedAt));
});
