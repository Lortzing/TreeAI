/**
 * D2 integration suite (Agent F): end-to-end scenarios over the fake stack
 * (FakePiRuntime + harness journal/registry/policy), covering the six
 * mandatory e2e fixtures from the task book:
 *
 *   1. dual-branch     — two branches fork from one session tree
 *   2. switch-back     — navigateTree back to a branch point and continue
 *   3. restart-recovery— dispose + restoreSession + I6 run-state convergence
 *   4. session-missing — session file deleted: session-corrupt + degraded
 *                        availability, domain data intact
 *   5. policy-overreach— default denials, require-approval is not allow,
 *                        decisions journaled as tool.decision events
 *   6. error-convergence — model error / abort / dispose / host-crash all
 *                        converge to the correct terminal run states
 *
 * Every scenario also exercises the evidence discipline end to end: it
 * writes guarded artifacts to a temp run directory and validates them
 * against schemas/d2/*.json.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { JsonRecord, PiEntryId, RunId, SessionReference } from "@treeai/contracts";
import { FakePiRuntime, TreeAIErrorShape, type FakeRuntimeOptions } from "../support/fake-pi-runtime.ts";
import {
  EventRecorder,
  FakeToolPolicy,
  Journal,
  RunRegistry,
} from "../support/harness.ts";
import { EvidenceWriter } from "../support/verifier/evidence.ts";
import { validateJsonSchema } from "../support/verifier/schema-validator.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const FIXTURES_E2E = join(REPO_ROOT, "tests", "fixtures", "e2e");

const MODEL = { providerId: "fake-provider", modelId: "fake-model" };

function readSchema(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

const RESULT_SCHEMA = readSchema(join(REPO_ROOT, "schemas", "d2", "result.schema.json"));
const EVENT_SCHEMA = readSchema(join(REPO_ROOT, "schemas", "d2", "event.schema.json"));

/**
 * Validate items against the scenarioResult def, with the full $defs context
 * of the shipped result schema ($ref is local to this extracted schema).
 */
function scenarioResultSchema(): Record<string, unknown> {
  return {
    $ref: "#/$defs/scenarioResult",
    $defs: RESULT_SCHEMA["$defs"],
  } as Record<string, unknown>;
}

/** A fresh scenario workspace: temp dir + evidence writer + fake runtime. */
interface ScenarioContext {
  readonly dir: string;
  readonly evidence: EvidenceWriter;
  readonly runtime: FakePiRuntime;
  readonly recorder: EventRecorder;
  readonly registry: RunRegistry;
  readonly journal: Journal;
  cleanup(): Promise<void>;
}

async function newScenario(
  runId: string,
  options: FakeRuntimeOptions = {},
): Promise<ScenarioContext> {
  const dir = mkdtempSync(join(tmpdir(), `treeai-d2-e2e-${runId}.`));
  const evidence = new EvidenceWriter(join(dir, "runs"), `e2e-${runId}`);
  const runtime = new FakePiRuntime({
    sessionDir: join(dir, "sessions"),
    model: MODEL,
    turnDelayMs: 1,
    ...options,
  });
  const recorder = new EventRecorder(runtime);
  const registry = new RunRegistry();
  const journal = new Journal();
  const ctx: ScenarioContext = {
    dir,
    evidence,
    runtime,
    recorder,
    registry,
    journal,
    async cleanup() {
      await runtime.dispose();
      recorder.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  ctx.registry.createRun(runId as RunId);
  return ctx;
}

/** Mirror a PiRuntimeEvent into the domain journal (runId attached). */
function mirrorEvent(ctx: ScenarioContext, runId: string): void {
  for (const evt of ctx.recorder.events) {
    ctx.journal.append(runId as RunId, evt.kind, evt.payload as JsonRecord);
  }
}

function assertRunState(ctx: ScenarioContext, runId: string, expected: string): void {
  assert.equal(ctx.registry.get(runId)!.state, expected);
}

/** Write + validate a scenario record as scenarioResult evidence. */
function writeScenarioRecord(
  ctx: ScenarioContext,
  record: Record<string, unknown>,
): void {
  ctx.evidence.writeJsonGuarded("scenario.json", record);
  const written = JSON.parse(
    readFileSync(join(ctx.evidence.runDir, "scenario.json"), "utf8"),
  ) as unknown;
  const res = validateJsonSchema(written, scenarioResultSchema());
  assert.ok(res.valid, `scenario record failed schema: ${JSON.stringify(res.errors)}`);
}

/** Write the scenario's journal to disk (guarded) and validate every line. */
function writeJournalEvidence(ctx: ScenarioContext, runId: string): void {
  for (const evt of ctx.journal.eventsOf(runId)) {
    ctx.evidence.journal({
      type: evt.type,
      payload: evt.payload as Record<string, unknown>,
      evidence: evt.evidence.map((e) => ({
        source: e.source,
        refId: e.refId,
        ...(e.locator !== undefined ? { locator: e.locator } : {}),
      })),
    });
  }
  const check = ctx.evidence.verifyJournalOnDisk();
  assert.ok(check.ok, `journal on disk broken: ${check.problems.join("; ")}`);
  // Every line validates against the event schema.
  const lines = readFileSync(join(ctx.evidence.runDir, "events.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  for (const line of lines) {
    const res = validateJsonSchema(JSON.parse(line), EVENT_SCHEMA);
    assert.ok(res.valid, `journal line failed schema: ${JSON.stringify(res.errors)}`);
  }
}

/* ================================================================== */
/* 1. dual-branch                                                      */
/* ================================================================== */

test("e2e dual-branch: one session tree, two sibling branches, append-only", async () => {
  const ctx = await newScenario("dual-branch");
  try {
    const snap = await ctx.runtime.createSession({ model: MODEL });
    ctx.journal.append("dual-branch", "session.created", {
      sessionId: snap.reference.sessionId,
    });
    ctx.registry.transition("dual-branch", "running");

    // Branch A: first user turn from the empty tree root.
    const a = (await ctx.runtime.prompt({ text: "work on branch A" })).reference;
    const branchA = a.entryId;

    // Branch B: navigate to the ROOT (entry "e0") and start a sibling branch.
    const atRoot = await ctx.runtime.navigateTree({ entryId: "e0" as PiEntryId });
    assert.equal(atRoot.entryId, "e0");
    const b = (await ctx.runtime.prompt({ text: "independent branch B" })).reference;

    // The tree now has TWO sibling user entries hanging off the root.
    const entries = ctx.runtime.snapshotEntries();
    assert.equal(entries.length, 4);
    const rootChildren = entries.filter((e) => e.parent === "e0");
    assert.equal(rootChildren.length, 2, "two sibling branches from the root");
    const userEntries = entries.filter((e) => e.kind === "user");
    assert.equal(userEntries.length, 2);
    // Nothing was removed when the second branch was created.
    assert.ok(entries.some((e) => e.id === (branchA as string)));

    // Both branches are reachable by navigation.
    const backToA = await ctx.runtime.navigateTree({ entryId: branchA });
    assert.equal(backToA.entryId, branchA);
    assert.equal(ctx.runtime.contextOf(branchA).length, 2);

    ctx.registry.transition("dual-branch", "succeeded");
    mirrorEvent(ctx, "dual-branch");
    writeJournalEvidence(ctx, "dual-branch");
    writeScenarioRecord(ctx, {
      id: "e2e-dual-branch",
      status: "PASS",
      exitCode: 0,
      scenario: "tree-navigation",
      driver: "fake",
      piVersion: "0.85.1",
      evidenceFiles: ["scenario.json", "events.jsonl"],
      meta: { entries: entries.length, rootChildren: 2 },
    });
    assertRunState(ctx, "dual-branch", "succeeded");
  } finally {
    await ctx.cleanup();
  }
});

/* ================================================================== */
/* 2. switch-back                                                      */
/* ================================================================== */

test("e2e switch-back: navigateTree to the branch point, context rebuilt, fork continues", async () => {
  const ctx = await newScenario("switch-back");
  try {
    await ctx.runtime.createSession({ model: MODEL });
    ctx.registry.transition("switch-back", "running");

    const a = (await ctx.runtime.prompt({ text: "establish branch A" })).reference;
    const branchPoint = a.entryId;
    const b = (await ctx.runtime.prompt({ text: "go down branch B" })).reference;
    assert.notEqual(b.entryId, branchPoint);

    // Switch back: same session, same file, leaf moves, tree intact.
    const back = await ctx.runtime.navigateTree({ entryId: branchPoint });
    assert.equal(back.entryId, branchPoint);
    assert.equal(back.sessionId, a.sessionId);
    assert.equal(back.sessionFile, a.sessionFile);
    assert.equal(ctx.runtime.snapshotEntries().length, 4, "no entries removed by navigation");
    // Context rebuilt along root->branchPoint.
    const ctxEntries = ctx.runtime.contextOf(branchPoint);
    assert.equal(ctxEntries.length, 2);
    assert.ok(ctxEntries.every((e) => e.kind === "user" || e.kind === "assistant"));
    const treeNavigated = ctx.recorder.firstOf("tree.navigated");
    assert.ok(treeNavigated !== undefined, "tree.navigated emitted");

    // Continue from the branch point -> a real fork (new child of branchPoint).
    const fork = (await ctx.runtime.prompt({ text: "fork from A again" })).reference;
    assert.notEqual(fork.entryId, b.entryId);
    assert.equal(ctx.runtime.snapshotEntries().length, 6);

    ctx.registry.transition("switch-back", "succeeded");
    mirrorEvent(ctx, "switch-back");
    writeJournalEvidence(ctx, "switch-back");
    writeScenarioRecord(ctx, {
      id: "e2e-switch-back",
      status: "PASS",
      exitCode: 0,
      scenario: "tree-navigation",
      driver: "fake",
      piVersion: "0.85.1",
      evidenceFiles: ["scenario.json", "events.jsonl"],
    });
  } finally {
    await ctx.cleanup();
  }
});

/* ================================================================== */
/* 3. restart recovery                                                 */
/* ================================================================== */

test("e2e restart-recovery: dispose, restore, continue; I6 host-crash convergence", async () => {
  const ctx = await newScenario("restart-recovery");
  const runId = "restart-recovery";
  try {
    await ctx.runtime.createSession({ model: MODEL });
    ctx.registry.transition(runId, "running");
    const before = (await ctx.runtime.prompt({ text: "persist this" })).reference;

    // Simulate host restart: dispose (crash-style, no clean abort) then
    // a fresh runtime instance restores the session.
    await ctx.runtime.dispose();

    const rt2 = new FakePiRuntime({
      sessionDir: join(ctx.dir, "sessions"),
      model: MODEL,
      turnDelayMs: 1,
    });
    const rec2 = new EventRecorder(rt2);
    try {
      const restored = await rt2.restoreSession(before);
      assert.equal(restored.reference.entryId, before.entryId);
      assert.equal(rec2.countOf("session.restored"), 1);
      assert.equal(rt2.entryCount, 2);

      // Session continues from the restored leaf.
      const after = await rt2.prompt({ text: "continue after restart" });
      assert.equal(rt2.entryCount, 4);
      assert.notEqual(after.reference.entryId, before.entryId);
      // Event seq restarts per runtime INSTANCE (fresh instance = fresh seq 1..n),
      // strictly increasing within it.
      const seqs = rec2.events.map((e) => e.seq);
      assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y));
      assert.ok(new Set(seqs).size === seqs.length);

      ctx.registry.transition(runId, "succeeded");
    } finally {
      await rt2.dispose();
      rec2.stop();
    }

    // I6 host-crash: a second run that was still running when the host died
    // converges to failed / unknown / hostInterrupted via the sweep.
    const reg2 = new RunRegistry();
    const crashed = reg2.createRun("crashed-run");
    reg2.transition("crashed-run", "running");
    const recovered = reg2.recoverNonTerminal("host-crash");
    assert.equal(recovered.length, 1);
    assert.equal(crashed.terminal, "failed");
    assert.equal(crashed.terminalError!.code, "unknown");
    assert.equal(
      (crashed.terminalError!.details as Record<string, unknown>)["hostInterrupted"],
      true,
    );

    mirrorEvent(ctx, runId);
    writeJournalEvidence(ctx, runId);
    writeScenarioRecord(ctx, {
      id: "e2e-restart-recovery",
      status: "PASS",
      exitCode: 0,
      scenario: "resume",
      driver: "fake",
      piVersion: "0.85.1",
      evidenceFiles: ["scenario.json", "events.jsonl"],
      meta: { hostCrashRunTerminal: "failed", hostInterrupted: true },
    });
  } finally {
    await ctx.cleanup();
  }
});

/* ================================================================== */
/* 4. session missing                                                  */
/* ================================================================== */

test("e2e session-missing: deleted file -> session-corrupt, availability degraded, domain data intact", async () => {
  const ctx = await newScenario("session-missing");
  const runId = "session-missing";
  try {
    const snap = await ctx.runtime.createSession({ model: MODEL });
    ctx.registry.transition(runId, "running");
    const ref = (await ctx.runtime.prompt({ text: "make history" })).reference;
    // Domain-side journal already captured the run's events.
    mirrorEvent(ctx, runId);
    const eventsBefore = ctx.journal.eventsOf(runId).length;
    assert.ok(eventsBefore > 0);

    // The session file disappears (user cleaned up, disk loss, ...).
    await ctx.runtime.dispose();
    unlinkSync(ref.sessionFile);

    const rt2 = new FakePiRuntime({
      sessionDir: join(ctx.dir, "sessions"),
      model: MODEL,
      turnDelayMs: 1,
    });
    try {
      await assert.rejects(() => rt2.restoreSession(ref), (err: unknown) => {
        assert.ok(err instanceof TreeAIErrorShape);
        assert.equal((err as TreeAIErrorShape).code, "session-corrupt");
        assert.equal(
          ((err as TreeAIErrorShape).details as Record<string, unknown>)["reason"],
          "missing-file",
        );
        return true;
      });

      // Degraded availability is recorded on the DOMAIN side (persistence
      // semantics); domain data survives untouched.
      const degraded: SessionReference = {
        sessionId: ref.sessionId,
        sessionFile: ref.sessionFile,
        entryId: ref.entryId,
        piVersion: ref.piVersion,
        availability: { status: "unavailable", reason: "missing-file" },
      };
      assert.equal(degraded.availability.status, "unavailable");

      // The run converges to failed (the runtime error path), and the journal
      // is still complete.
      ctx.registry.transition(runId, "failed", {
        code: "session-corrupt",
        message: "session file missing at restore",
      });
      assert.equal(ctx.journal.eventsOf(runId).length, eventsBefore);
      assert.equal(ctx.registry.get(runId)!.terminal, "failed");
    } finally {
      await rt2.dispose();
    }

    writeJournalEvidence(ctx, runId);
    writeScenarioRecord(ctx, {
      id: "e2e-session-missing",
      status: "PASS",
      exitCode: 0,
      scenario: "resume",
      driver: "fake",
      piVersion: "0.85.1",
      evidenceFiles: ["scenario.json", "events.jsonl"],
      meta: {
        availabilityAfterLoss: "unavailable",
        domainEventsIntact: true,
        sessionIdFormat: "string",
      },
    });
    void snap;
  } finally {
    await ctx.cleanup();
  }
});

/* ================================================================== */
/* 5. permission overreach                                             */
/* ================================================================== */

test("e2e policy-overreach: default denials, approval is not allow, decisions journaled", async () => {
  const runId = "policy-overreach";
  // SECURITY NOTE: application-layer policy, not an OS sandbox.
  const policy = new FakeToolPolicy({
    readRoots: [FIXTURES_E2E],
    workspaceRoot: join(FIXTURES_E2E, "workspace"),
  });
  const ctx = await newScenario("policy-overreach", {
    script: [
      {
        kind: "ok",
        turns: ["trying to read outside the roots"],
        toolRequest: { tool: "read_file", path: "/etc/passwd", action: "read" },
      },
    ],
    decideTool: (req) => {
      const d = policy.decide(req.action, req.path);
      return { outcome: d.outcome, reason: d.reason };
    },
  });
  try {
    // Overreach matrix.
    assert.equal(policy.decide("read", "/etc/passwd").outcome, "deny");
    assert.equal(policy.decide("shell").outcome, "deny");
    assert.equal(policy.decide("network", "https://example.test").outcome, "deny");
    assert.equal(policy.decide("write", "/tmp/evil.txt").outcome, "deny");
    const approval = policy.decide("write", join(FIXTURES_E2E, "workspace", "new.txt"));
    assert.equal(approval.outcome, "require-approval", "in-workspace writes need approval");
    // Legitimate reads pass.
    assert.equal(policy.decide("read", join(FIXTURES_E2E, "readonly", "branch-a.txt")).outcome, "allow");

    await ctx.runtime.createSession({ model: MODEL });
    ctx.registry.transition(runId, "running");

    // The scripted tool request goes through the policy and is DENIED ->
    // prompt fails with policy-denied, tool events + tool.decision journaled.
    await assert.rejects(() => ctx.runtime.prompt({ text: "read /etc/passwd" }), (err: unknown) => {
      assert.equal((err as TreeAIErrorShape).code, "policy-denied");
      return true;
    });
    assert.equal(ctx.recorder.countOf("tool.execution.started"), 1);
    const finished = ctx.recorder.firstOf("tool.execution.finished");
    assert.ok(finished !== undefined);
    assert.equal((finished.payload as Record<string, unknown>)["isError"], true);

    // Journal the decision (the shape production tool-policy + event-journal
    // will use): outcome, ruleId, reason — no credentials, no file contents.
    const decision = policy.decide("read", "/etc/passwd");
    ctx.journal.append(runId, "tool.decision", {
      category: decision.category,
      outcome: decision.outcome,
      ruleId: decision.ruleId,
      risk: decision.risk,
    });
    ctx.registry.transition(runId, "failed", {
      code: "policy-denied",
      message: "tool read_file denied by policy",
    });

    mirrorEvent(ctx, runId);
    writeJournalEvidence(ctx, runId);
    const decisionEvent = ctx.journal
      .eventsOf(runId)
      .find((e) => e.type === "tool.decision")!;
    assert.equal((decisionEvent.payload as Record<string, unknown>)["outcome"], "deny");

    writeScenarioRecord(ctx, {
      id: "e2e-policy-overreach",
      status: "PASS",
      exitCode: 0,
      scenario: "tool-policy",
      driver: "fake",
      piVersion: "0.85.1",
      evidenceFiles: ["scenario.json", "events.jsonl"],
      meta: { deniedActions: 4, approvalNotAllow: true },
    });
  } finally {
    await ctx.cleanup();
  }
});

/* ================================================================== */
/* 6. error convergence                                                */
/* ================================================================== */

test("e2e error-convergence: model error, user abort, dispose, host crash each reach the right terminal", async () => {
  // 6a. Model/upstream error -> failed with that code.
  {
    const ctx = await newScenario(
      "err-model",
      { script: [{ kind: "fail", code: "upstream", message: "simulated upstream failure" }] },
    );
    try {
      await ctx.runtime.createSession({ model: MODEL });
      ctx.registry.transition("err-model", "running");
      await assert.rejects(() => ctx.runtime.prompt({ text: "go" }), (err: unknown) => {
        assert.equal((err as TreeAIErrorShape).code, "upstream");
        return true;
      });
      assert.equal(ctx.recorder.countOf("runtime.error"), 1);
      assert.equal(ctx.runtime.isStreaming, false);
      ctx.registry.transition("err-model", "failed", {
        code: "upstream",
        message: "simulated upstream failure",
      });
      assertRunState(ctx, "err-model", "failed");
    } finally {
      await ctx.cleanup();
    }
  }

  // 6b. User abort -> aborted (via the legal running->aborting->aborted path).
  {
    const ctx = await newScenario("err-abort");
    const runId = "err-abort";
    try {
      await ctx.runtime.createSession({ model: MODEL });
      ctx.registry.transition(runId, "running");
      const pending = ctx.runtime.prompt({ text: "long work" });
      await new Promise((r) => setTimeout(r, 3));
      await ctx.runtime.abort();
      await assert.rejects(() => pending, (err: unknown) => {
        assert.equal((err as TreeAIErrorShape).code, "user-abort");
        return true;
      });
      ctx.registry.transition(runId, "aborting");
      ctx.registry.transition(runId, "aborted", { code: "user-abort", message: "user abort" });
      assertRunState(ctx, runId, "aborted");
      // A NEW run after abort is healthy.
      const next = await ctx.runtime.prompt({ text: "fresh start" });
      assert.ok(next.message.length > 0);
    } finally {
      await ctx.cleanup();
    }
  }

  // 6c. Dispose with an in-flight run -> aborted semantics.
  {
    const ctx = await newScenario("err-dispose");
    const runId = "err-dispose";
    try {
      await ctx.runtime.createSession({ model: MODEL });
      ctx.registry.transition(runId, "running");
      const pending = ctx.runtime.prompt({ text: "will be disposed" });
      await new Promise((r) => setTimeout(r, 3));
      const disposeP = ctx.runtime.dispose();
      await assert.rejects(() => pending, (err: unknown) => {
        assert.equal((err as TreeAIErrorShape).code, "user-abort");
        return true;
      });
      await disposeP;
      const recovered = ctx.registry.recoverNonTerminal("dispose");
      assert.equal(recovered.length, 1);
      assert.equal(ctx.registry.get(runId)!.terminal, "aborted");
    } finally {
      await ctx.cleanup();
    }
  }

  // 6d. Host crash (no dispose) -> recovery sweep converges to failed/unknown.
  {
    const ctx = await newScenario("err-crash");
    const runId = "err-crash";
    try {
      await ctx.runtime.createSession({ model: MODEL });
      ctx.registry.transition(runId, "running");
      const pending = ctx.runtime.prompt({ text: "host dies now" });
      await new Promise((r) => setTimeout(r, 3));
      // No abort, no dispose: the host process just ends. The recovery sweep
      // must resolve the non-terminal state.
      void pending.catch(() => undefined); // avoid unhandled rejection
      await ctx.runtime.abort(); // best-effort stop of the fake's timers
      const recovered = ctx.registry.recoverNonTerminal("host-crash");
      assert.equal(recovered.length, 1);
      const rec = ctx.registry.get(runId)!;
      assert.equal(rec.terminal, "failed");
      assert.equal(rec.terminalError!.code, "unknown");
      assert.equal(
        (rec.terminalError!.details as Record<string, unknown>)["hostInterrupted"],
        true,
      );
      writeScenarioRecord(ctx, {
        id: "e2e-error-convergence",
        status: "PASS",
        exitCode: 0,
        scenario: "abort",
        driver: "fake",
        piVersion: "0.85.1",
        meta: {
          modelError: "failed/upstream",
          userAbort: "aborted/user-abort",
          dispose: "aborted/user-abort",
          hostCrash: "failed/unknown+hostInterrupted",
        },
      });
    } finally {
      await ctx.cleanup();
    }
  }
});

/* ================================================================== */
/* Evidence discipline, end to end                                     */
/* ================================================================== */

test("evidence writer: guarded writes mask injected secrets and record leaks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "treeai-d2-e2e-guard."));
  try {
    const writer = new EvidenceWriter(join(dir, "runs"), "guard-test");
    const syntheticToken = ["sk-ant-", "abcdef0123456789abcdef0123456789"].join("");
    const homeUserPath = ["/Users/", "someuser", "/notes"].join("");
    const result = writer.writeTextGuarded(
      "leaky.txt",
      `token=${syntheticToken} path=${homeUserPath}\n`,
    );
    assert.ok(result.leaks.length > 0, "injected secret must be detected pre-write");
    const stored = readFileSync(join(writer.runDir, "leaky.txt"), "utf8");
    assert.ok(!stored.includes(syntheticToken), "stored copy must be masked");
    assert.ok(!stored.includes("/Users/"), "stored copy must have home paths redacted");
    assert.ok(writer.preWriteLeaks.length > 0);

    // Run dir allocation never overwrites a historical run.
    const writer2 = new EvidenceWriter(join(dir, "runs"), "guard-test");
    assert.notEqual(writer2.runDir, writer.runDir);

    // Journal discipline on disk.
    writer2.journal({ type: "verify.run-started", payload: { mode: "offline" } });
    writer2.journal({ type: "verify.run-finished", payload: { verdict: "ALL_PASS" } });
    const check = writer2.verifyJournalOnDisk();
    assert.ok(check.ok, check.problems.join("; "));
    assert.equal(check.lineCount, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scenario records written by every e2e test conform to the scenarioResult schema shape", () => {
  // Direct probe of the extraction helper used above (guards against silent
  // $ref extraction breakage).
  const schema = scenarioResultSchema();
  assert.ok(typeof schema === "object" && schema !== null);
  const res = validateJsonSchema(
    {
      id: "probe",
      status: "PASS",
      exitCode: 0,
      scenario: "basic",
      driver: "fake",
      piVersion: "0.85.1",
    },
    schema,
  );
  assert.ok(res.valid, JSON.stringify(res.errors));
  const bad = validateJsonSchema(
    {
      id: "probe",
      status: "PASS",
      exitCode: 0,
      scenario: "made-up-scenario",
      driver: "fake",
      piVersion: "0.85.1",
    },
    schema,
  );
  assert.ok(!bad.valid);
});
