/**
 * Unit tests for the e2e harness: RunState machine (I1–I7), journal seq
 * discipline and projection, and the fake tool policy defaults.
 */

import test from "node:test";
import assert from "node:assert/strict";

import type { RunState, RunStateTransitions } from "@treeai/contracts";
import {
  DuplicateEventError,
  FakeToolPolicy,
  IllegalTransitionError,
  Journal,
  RunRegistry,
  TRANSITIONS,
  isUnder,
} from "../support/harness.ts";

test("TRANSITIONS re-declaration matches the frozen contract table (satisfies check)", () => {
  // The `satisfies RunStateTransitions` in harness.ts enforces this at compile
  // time; the runtime mirror here guards against accidental value drift.
  const expected: RunStateTransitions = {
    queued: ["running", "failed"],
    running: ["aborting", "succeeded", "failed"],
    aborting: ["aborted", "failed"],
    succeeded: [],
    failed: [],
    aborted: [],
  };
  assert.deepEqual(TRANSITIONS, expected);
});

test("I1: new runs start queued", () => {
  const reg = new RunRegistry();
  const rec = reg.createRun("r1");
  assert.equal(rec.state, "queued");
  assert.equal(rec.terminal, null);
});

test("legal path queued->running->succeeded", () => {
  const reg = new RunRegistry();
  reg.createRun("r1");
  reg.transition("r1", "running");
  reg.transition("r1", "succeeded");
  assert.equal(reg.get("r1")!.terminal, "succeeded");
});

test("I5: no skipping states (queued -> succeeded is illegal)", () => {
  const reg = new RunRegistry();
  reg.createRun("r1");
  assert.throws(() => reg.transition("r1", "succeeded"), IllegalTransitionError);
});

test("I5: no backwards transitions (running -> queued is illegal)", () => {
  const reg = new RunRegistry();
  reg.createRun("r1");
  reg.transition("r1", "running");
  assert.throws(() => reg.transition("r1", "queued"), IllegalTransitionError);
});

test("I2: terminals are absorbing (succeeded -> running illegal)", () => {
  const reg = new RunRegistry();
  reg.createRun("r1");
  reg.transition("r1", "running");
  reg.transition("r1", "succeeded");
  assert.throws(() => reg.transition("r1", "running"), IllegalTransitionError);
});

test("I3: a run cannot enter a second terminal even through the table", () => {
  const reg = new RunRegistry();
  reg.createRun("r1");
  reg.transition("r1", "running");
  reg.transition("r1", "failed");
  // running -> succeeded is table-legal from `running`, but the run is already
  // absorbed; the single-terminal rule must refuse.
  assert.throws(() => reg.transition("r1", "succeeded"), IllegalTransitionError);
});

test("I4: aborting only from running; converges to aborted or failed", () => {
  const reg = new RunRegistry();
  reg.createRun("r1");
  reg.transition("r1", "running");
  reg.transition("r1", "aborting");
  assert.throws(() => reg.transition("r1", "succeeded"), IllegalTransitionError);
  reg.transition("r1", "aborted");
  assert.equal(reg.get("r1")!.terminal, "aborted");

  const reg2 = new RunRegistry();
  reg2.createRun("r2");
  reg2.transition("r2", "running");
  reg2.transition("r2", "aborting");
  reg2.transition("r2", "failed", { code: "unknown", message: "abort machinery failed" });
  assert.equal(reg2.get("r2")!.terminalError!.code, "unknown");
});

test("I6: host-crash recovery moves every non-terminal run to failed with hostInterrupted", () => {
  const reg = new RunRegistry();
  reg.createRun("q"); // still queued
  reg.createRun("r");
  reg.transition("r", "running");
  reg.createRun("a");
  reg.transition("a", "running");
  reg.transition("a", "aborting");
  reg.createRun("t");
  reg.transition("t", "running");
  reg.transition("t", "succeeded"); // terminal, must NOT be touched

  const recovered = reg.recoverNonTerminal("host-crash");
  assert.equal(recovered.length, 3);
  for (const rec of recovered) {
    assert.equal(rec.terminal, "failed");
    assert.equal(rec.terminalError!.code, "unknown");
    assert.equal((rec.terminalError!.details as Record<string, unknown>)["hostInterrupted"], true);
  }
  assert.equal(reg.get("t")!.terminal, "succeeded", "terminal states survive recovery");
});

test("I6: dispose recovery converges running/aborting to aborted", () => {
  const reg = new RunRegistry();
  reg.createRun("r");
  reg.transition("r", "running");
  reg.createRun("a");
  reg.transition("a", "running");
  reg.transition("a", "aborting");
  const recovered = reg.recoverNonTerminal("dispose");
  assert.equal(recovered.length, 2);
  assert.equal(reg.get("r")!.terminal, "aborted");
  assert.equal(reg.get("r")!.terminalError!.code, "user-abort");
  assert.equal(reg.get("a")!.terminal, "aborted");
});

test("I6: queued run at dispose converges via the only legal edge (failed)", () => {
  const reg = new RunRegistry();
  reg.createRun("q");
  const recovered = reg.recoverNonTerminal("dispose");
  assert.equal(recovered.length, 1);
  assert.equal(reg.get("q")!.terminal, "failed");
  assert.equal(reg.get("q")!.terminalError!.code, "user-abort");
});

test("Journal: seq strictly increases per runId and is independent across runs", () => {
  const j = new Journal();
  const e1 = j.append("run-a", "run.state-changed", { state: "running" });
  const e2 = j.append("run-b", "run.state-changed", { state: "running" });
  const e3 = j.append("run-a", "run.state-changed", { state: "succeeded" });
  assert.equal(e1.seq, 1);
  assert.equal(e2.seq, 1, "seq is per-run");
  assert.equal(e3.seq, 2);
  assert.equal(j.eventsOf("run-a").length, 2);
  assert.equal(j.eventsOf("run-b").length, 1);
  assert.notEqual(e1.eventId, e2.eventId);
});

test("Journal: duplicate (runId, seq) is impossible by construction (append allocates seq)", () => {
  const j = new Journal();
  j.append("run-a", "run.state-changed", { state: "running" });
  // Append is the only entry point; calling it again must give seq 2, never a
  // duplicate. The DuplicateEventError path is exercised via the on-disk
  // verifier when a tampered journal repeats a line.
  const e2 = j.append("run-a", "run.state-changed", { state: "aborting" });
  assert.equal(e2.seq, 2);
  assert.ok(DuplicateEventError !== undefined);
});

test("Journal: projection replays legal state machines and rejects illegal ones", () => {
  const j = new Journal();
  j.append("good", "run.state-changed", { state: "running" });
  j.append("good", "run.state-changed", { state: "succeeded" });
  j.append("bad", "run.state-changed", { state: "succeeded" }); // queued -> succeeded illegal
  const { registry, rejected } = j.projectRunStates();
  assert.equal(registry.get("good")!.terminal, "succeeded");
  assert.equal(registry.get("bad")!.state, "queued", "illegal transition not applied");
  assert.equal(rejected.length, 1);
  assert.deepEqual(rejected[0], { runId: "bad", from: "queued", to: "succeeded" });
});

test("FakeToolPolicy: default deny with ruleId null", () => {
  const policy = new FakeToolPolicy({ readRoots: ["/repo/tests/fixtures/e2e/readonly"], workspaceRoot: "/repo/workspace" });
  const d = policy.decide("shell");
  assert.equal(d.outcome, "deny");
  assert.equal(d.ruleId, null);
  assert.equal(d.risk, "high");
  assert.deepEqual(d.scope.roots, []);
});

test("FakeToolPolicy: read under roots allowed, outside denied (with .. normalization)", () => {
  const policy = new FakeToolPolicy({ readRoots: ["/repo/readonly"], workspaceRoot: "/repo/workspace" });
  assert.equal(policy.decide("read", "/repo/readonly/a.txt").outcome, "allow");
  assert.equal(policy.decide("read", "/repo/readonly/sub/../a.txt").outcome, "allow");
  assert.equal(policy.decide("read", "/etc/passwd").outcome, "deny");
  assert.equal(policy.decide("read", "/repo/readonly/../../etc/passwd").outcome, "deny");
  assert.equal(policy.decide("read").outcome, "deny");
});

test("FakeToolPolicy: write inside workspace requires approval, outside denied", () => {
  const policy = new FakeToolPolicy({ readRoots: ["/repo/readonly"], workspaceRoot: "/repo/workspace" });
  const inWs = policy.decide("write", "/repo/workspace/out.txt");
  assert.equal(inWs.outcome, "require-approval");
  assert.equal(inWs.ruleId, "workspace-write");
  assert.equal(policy.decide("write", "/repo/elsewhere/out.txt").outcome, "deny");
});

test("FakeToolPolicy: network denied; other-high-risk denied", () => {
  const policy = new FakeToolPolicy({ readRoots: ["/r"], workspaceRoot: "/w" });
  assert.equal(policy.decide("network", "https://example.test").outcome, "deny");
  assert.equal(policy.decide("other-high-risk").outcome, "deny");
});

test("isUnder handles plain and nested paths", () => {
  assert.ok(isUnder("/a/b/c.txt", "/a/b"));
  assert.ok(isUnder("/a/b", "/a/b"));
  assert.ok(!isUnder("/a/bc", "/a/b"));
  assert.ok(isUnder("/a/x/../b/c.txt", "/a/b"));
});

test("policy decisions carry no secrets or file contents in reason", () => {
  const policy = new FakeToolPolicy({ readRoots: ["/r"], workspaceRoot: "/w" });
  for (const cat of ["read", "write", "shell", "network", "other-high-risk"] as const) {
    const d = policy.decide(cat, "/r/some/file.txt");
    assert.equal(typeof d.reason, "string");
    assert.ok(d.reason.length > 0);
    assert.ok(!d.reason.includes("sk-ant-"), "reason must never carry credentials");
  }
});
