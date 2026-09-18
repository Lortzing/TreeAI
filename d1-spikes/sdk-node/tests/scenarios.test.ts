/**
 * Scenario tests with scripted fake sessions: all five scenarios produce
 * structured, verifiable results without network access. These tests
 * exercise the SAME scenario code paths used by the real probe; they write
 * only to temp directories, never to d1-spikes/evidence/.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runScenario } from "../src/runner.js";
import { executeScenario } from "../src/scenarios/index.js";
import {
  createFakeSessionFactory,
  createFakeSessionFactoryQueue,
  FakeProbeSession,
  readFakeSessionFile,
  type FakeTurnScript,
} from "../src/fake-session.js";
import { EvidenceRecorder } from "../src/recorder.js";
import type { ProbeSessionFactory, ResumeChildRunner } from "../src/types.js";
import {
  BASIC_PROMPT,
  RESUME_PROMPT_A,
  RESUME_PROMPT_B,
  STEER_BASE_PROMPT,
} from "../src/prompts.js";

function tmpRunDir(): string {
  return mkdtempSync(join(tmpdir(), "treeai-scenarios-"));
}

/**
 * Fake resume child runner: simulates two separate processes using only
 * the persisted file as the boundary (real runner spawns actual OS
 * processes; see src/child-runner.ts).
 */
function fakeResumeChildRunner(
  scriptsA: FakeTurnScript[],
  scriptsB: FakeTurnScript[],
): ResumeChildRunner {
  return {
    async phaseA(opts) {
      const recorder = EvidenceRecorder.open({ dir: opts.eventsDir, scenario: "resume", probePhase: "A" });
      try {
        const session = new FakeProbeSession(scriptsA, {
          persist: true,
          sessionFile: join(opts.sessionDir, "fake-session.jsonl"),
        });
        recorder.setSessionId(session.sessionId);
        session.subscribe((ev) => recorder.record(ev.type as string, ev));
        await session.prompt(opts.prompt);
        session.dispose();
        recorder.finalize();
        return { exitCode: 0, sessionFile: session.sessionFile, sessionId: session.sessionId };
      } catch (err) {
        recorder.recordError(err, { phase: "A" });
        recorder.finalize();
        return { exitCode: 1 };
      }
    },
    async phaseB(opts) {
      const recorder = EvidenceRecorder.open({ dir: opts.eventsDir, scenario: "resume", probePhase: "B" });
      try {
        const entries = readFakeSessionFile(opts.sessionFile);
        const header = entries.find((e) => e.role === "session-header") as
          | { role: string; sessionId?: string }
          | undefined;
        const seed = entries
          .filter((e) => e.role === "user" || e.role === "assistant")
          .map((e) => ({ role: e.role as "user" | "assistant", text: e.text ?? "" }));
        const session = new FakeProbeSession(scriptsB, {
          persist: true,
          sessionFile: opts.sessionFile,
          seedHistory: seed,
          sessionId: header?.sessionId,
        });
        recorder.setSessionId(session.sessionId);
        session.subscribe((ev) => recorder.record(ev.type as string, ev));
        const historyBefore = session.getHistorySummary();
        recorder.recordMarker("phaseB_history_read", { history: historyBefore });
        await session.prompt(opts.prompt);
        const history = session.getHistorySummary();
        session.dispose();
        recorder.finalize();
        return {
          exitCode: 0,
          sessionId: session.sessionId,
          history,
          answer: history.lastAssistantText,
        };
      } catch (err) {
        recorder.recordError(err, { phase: "B" });
        recorder.finalize();
        return { exitCode: 1 };
      }
    },
  };
}

async function runFakeScenario(
  scenario: "basic" | "tool" | "steer" | "abort" | "resume",
  factory: ProbeSessionFactory,
  childRunner?: ResumeChildRunner,
) {
  const runDir = tmpRunDir();
  return runScenario({
    scenario,
    command: "test",
    timeoutMs: 20_000,
    runDir,
    exec: async (ctx) => {
      await executeScenario(scenario, ctx, {
        createSession: factory,
        childRunner: childRunner ?? fakeResumeChildRunner([], []),
      });
    },
  });
}

test("basic: three sub-runs, deltas concatenate, answer correct -> PASS", async () => {
  const factory = createFakeSessionFactory([{ answer: "42", deltaCount: 6 }]);
  const result = await runFakeScenario("basic", factory);
  assert.equal(result.status, "PASS", JSON.stringify(result.failedChecks));
  assert.equal(result.exitCode, 0);
  assert.ok(result.observations.some((o) => o.includes("three consecutive sub-runs")));
});

test("basic: wrong answer -> FAIL with named checks", async () => {
  const factory = createFakeSessionFactory([{ answer: "41", deltaCount: 3 }]);
  const result = await runFakeScenario("basic", factory);
  assert.equal(result.status, "FAIL");
  assert.ok(result.failedChecks?.some((c) => c.includes("expected value 42")));
});

test("basic: prompt error propagates as FAIL with structured error", async () => {
  const factory = createFakeSessionFactory([
    { answer: "42", turnError: new Error("connection reset by peer") },
  ]);
  const result = await runFakeScenario("basic", factory);
  assert.equal(result.status, "FAIL");
  assert.equal(result.error?.message, "connection reset by peer");
});

test("tool: read-only tool used, fixture values verified, error path observed -> PASS", async () => {
  const factory = createFakeSessionFactory([
    {
      answer: "MARKER=TREEAI-D1-FIXTURE-7f3a\nSUM=42",
      toolCalls: [
        {
          toolName: "read",
          args: { path: "numbers.json" },
          result: { content: "..." },
          isError: false,
        },
      ],
    },
    {
      answer: "The file definitely-missing-9b1c.json could not be read.",
      toolCalls: [
        {
          toolName: "read",
          args: { path: "definitely-missing-9b1c.json" },
          result: { error: "ENOENT: no such file" },
          isError: true,
        },
      ],
    },
  ]);
  const result = await runFakeScenario("tool", factory);
  assert.equal(result.status, "PASS", JSON.stringify(result.failedChecks));
  assert.ok(result.observations.some((o) => o.includes("tool only accessed the fixture temp copy")));
});

test("tool: tool returns wrong marker -> FAIL", async () => {
  const factory = createFakeSessionFactory([
    {
      answer: "MARKER=WRONG\nSUM=41",
      toolCalls: [{ toolName: "read", args: { path: "numbers.json" }, result: {}, isError: false }],
    },
  ]);
  const result = await runFakeScenario("tool", factory);
  assert.equal(result.status, "FAIL");
  assert.ok(result.failedChecks?.some((c) => c.includes("MARKER=")));
});

test("steer: queue observed, second run, final output reflects instruction -> PASS", async () => {
  const longAnswer = Array.from({ length: 20 }, (_, i) => `${i + 1}. something about ${i + 1}`).join("\n");
  const factory = createFakeSessionFactory([
    { answer: longAnswer, deltaCount: 12 },
    { answer: "STEERED-OK", deltaCount: 2 },
  ]);
  const result = await runFakeScenario("steer", factory);
  assert.equal(result.status, "PASS", JSON.stringify(result.failedChecks));
  assert.ok(result.observations.some((o) => o.includes("queue_update")));
  const result2 = result;
  void result2;
});

test("steer: steer ignored (no second run) -> FAIL", async () => {
  const longAnswer = Array.from({ length: 20 }, (_, i) => `${i + 1}. x`).join("\n");
  // Second turn script still returns the counting answer, not STEERED-OK.
  const factory = createFakeSessionFactory([
    { answer: longAnswer, deltaCount: 12 },
    { answer: "21. still counting", deltaCount: 2 },
  ]);
  const result = await runFakeScenario("steer", factory);
  assert.equal(result.status, "FAIL");
  assert.ok(result.failedChecks?.some((c) => c.includes("final output reflects the new instruction")));
});

test("steer: prompt rejects during the streaming poll window -> structured FAIL, no unhandled rejection", async () => {
  // Regression: the prompt promise is not awaited while polling for
  // deltas. A rejection in that window used to escape as an unhandled
  // rejection and kill the whole probe process before any result.json was
  // written (observed live with a 403 on the first real run).
  const longAnswer = Array.from({ length: 20 }, (_, i) => `${i + 1}. x`).join("\n");
  const factory = createFakeSessionFactory([
    { answer: longAnswer, deltaCount: 12, turnError: new Error("403 Access denied") },
  ]);
  const result = await runFakeScenario("steer", factory);
  assert.equal(result.status, "FAIL");
  assert.equal(result.error?.message, "403 Access denied");
  assert.ok(existsSync(join(result.evidenceFiles[0]!, "..", "result.json")));
});

test("abort: hanging stream aborted, settles fast, new session works -> PASS", async () => {
  const longAnswer = Array.from({ length: 50 }, (_, i) => `${i + 1}. y`).join("\n");
  const factory = createFakeSessionFactoryQueue([
    [{ answer: longAnswer, deltaCount: 20, hang: true }],
    [{ answer: "5", deltaCount: 3 }],
  ]);
  const result = await runFakeScenario("abort", factory);
  assert.equal(result.status, "PASS", JSON.stringify(result.failedChecks));
  assert.ok(result.observations.some((o) => o.includes("stopReason after abort: aborted")));
});

test("abort: new session broken after abort -> FAIL on post-abort check", async () => {
  const longAnswer = Array.from({ length: 50 }, (_, i) => `${i + 1}. y`).join("\n");
  const factory = createFakeSessionFactoryQueue([
    [{ answer: longAnswer, deltaCount: 20, hang: true }],
    [{ answer: "wrong", deltaCount: 3 }],
  ]);
  const result = await runFakeScenario("abort", factory);
  assert.equal(result.status, "FAIL");
  assert.ok(result.failedChecks?.some((c) => c.includes("new session works after abort")));
});

test("resume: two phases, file-based identity, history read, answer recalls passphrase -> PASS", async () => {
  const factory = createFakeSessionFactory([{ answer: "ACK" }]);
  // Phase B seeds history from the persisted file (1 prior user turn), so
  // its first NEW prompt consumes scriptsB[1]; scriptsB[0] stands in for the
  // already-completed phase A turn.
  const childRunner = fakeResumeChildRunner(
    [{ answer: "ACK", deltaCount: 2 }],
    [{ answer: "ACK" }, { answer: "TREEAI-RESUME-9c4e", deltaCount: 3 }],
  );
  const result = await runFakeScenario("resume", factory, childRunner);
  assert.equal(result.status, "PASS", JSON.stringify(result.failedChecks));
  assert.ok(result.observations.some((o) => o.includes("session identity preserved across processes")));
  assert.ok(result.observations.some((o) => o.includes("merged")));
});

test("resume: phase A crash -> FAIL with evidence of the crash", async () => {
  const factory = createFakeSessionFactory([{ answer: "ACK" }]);
  const childRunner: ResumeChildRunner = {
    async phaseA() {
      return { exitCode: 1 };
    },
    async phaseB() {
      return { exitCode: 0 };
    },
  };
  const result = await runFakeScenario("resume", factory, childRunner);
  assert.equal(result.status, "FAIL");
  assert.ok(result.failedChecks?.some((c) => c.includes("phase A child exited 0")));
});

test("resume: phase B forgets history (amnesia) -> FAIL", async () => {
  const factory = createFakeSessionFactory([{ answer: "ACK" }]);
  // Phase B seeds NOTHING (simulates broken restore) and answers wrong.
  const childRunner: ResumeChildRunner = {
    async phaseA(opts) {
      const recorder = EvidenceRecorder.open({ dir: opts.eventsDir, scenario: "resume", probePhase: "A" });
      const session = new FakeProbeSession([{ answer: "ACK" }], {
        persist: true,
        sessionFile: join(opts.sessionDir, "fake-session.jsonl"),
      });
      recorder.setSessionId(session.sessionId);
      session.subscribe((ev) => recorder.record(ev.type as string, ev));
      await session.prompt(opts.prompt);
      session.dispose();
      recorder.finalize();
      return { exitCode: 0, sessionFile: session.sessionFile, sessionId: session.sessionId };
    },
    async phaseB(opts) {
      const recorder = EvidenceRecorder.open({ dir: opts.eventsDir, scenario: "resume", probePhase: "B" });
      const session = new FakeProbeSession([{ answer: "I do not remember any passphrase." }], {});
      recorder.setSessionId(session.sessionId);
      session.subscribe((ev) => recorder.record(ev.type as string, ev));
      await session.prompt(opts.prompt);
      const history = session.getHistorySummary();
      session.dispose();
      recorder.finalize();
      return { exitCode: 0, sessionId: session.sessionId, history, answer: history.lastAssistantText };
    },
  };
  const result = await runFakeScenario("resume", factory, childRunner);
  assert.equal(result.status, "FAIL");
  assert.ok(result.failedChecks?.some((c) => c.includes("read prior history")));
  assert.ok(result.failedChecks?.some((c) => c.includes("recalls the passphrase")));
});

test("all scenarios: event files are valid JSONL with monotonic seq (cross-check)", async () => {
  const runDir = tmpRunDir();
  const factory = createFakeSessionFactory([{ answer: "42", deltaCount: 3 }]);
  const result = await runScenario({
    scenario: "basic",
    command: "test",
    timeoutMs: 20_000,
    runDir,
    exec: async (ctx) => {
      await executeScenario("basic", ctx, {
        createSession: factory,
        childRunner: fakeResumeChildRunner([], []),
      });
    },
  });
  assert.equal(result.status, "PASS");
  const { validateEventFile } = await import("../src/validate.js");
  const v = validateEventFile(join(runDir, "basic", "events.jsonl"));
  assert.equal(v.ok, true, v.errors.join("; "));
  // Prompt text is preserved in the event stream (auditability).
  const raw = readFileSync(join(runDir, "basic", "events.jsonl"), "utf8");
  assert.ok(raw.includes(BASIC_PROMPT.slice(0, 20)), "user prompt visible in events");
});

test("scenario evidence files exist for every scenario shape", async () => {
  const runDir = tmpRunDir();
  const result = await runScenario({
    scenario: "resume",
    command: "test",
    timeoutMs: 20_000,
    runDir,
    exec: async (ctx) => {
      await executeScenario("resume", ctx, {
        createSession: createFakeSessionFactory([{ answer: "ACK" }]),
        childRunner: fakeResumeChildRunner(
          [{ answer: "ACK" }],
          [{ answer: "ACK" }, { answer: "TREEAI-RESUME-9c4e" }],
        ),
      });
    },
  });
  assert.equal(result.status, "PASS", JSON.stringify(result.failedChecks));
  assert.ok(existsSync(join(runDir, "resume", "events.jsonl")));
  assert.ok(existsSync(join(runDir, "resume", "result.json")));
  assert.ok(existsSync(join(runDir, "resume", "phase-a", "events.jsonl")));
  assert.ok(existsSync(join(runDir, "resume", "phase-b", "events.jsonl")));
  // Global stream must include both phases with correct tags.
  const merged = readFileSync(join(runDir, "resume", "events.jsonl"), "utf8");
  assert.ok(merged.includes('"probePhase":"A"'));
  assert.ok(merged.includes('"probePhase":"B"'));
  assert.ok(merged.includes(RESUME_PROMPT_A.slice(0, 15)));
  assert.ok(merged.includes(RESUME_PROMPT_B.slice(0, 15)));
  void STEER_BASE_PROMPT;
});
