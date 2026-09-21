/**
 * Unit tests for verdict computation and the independent exit-code
 * consistency check — the exact rules the verifier and result.schema.json
 * both enforce (defense in depth).
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  checkExitCodeConsistency,
  computeVerdict,
  type ResultItem,
} from "../support/verifier/verdict.ts";

function item(id: string, status: ResultItem["status"], exitCode: number | null): ResultItem {
  return { id, status, exitCode };
}

test("all PASS -> ALL_PASS / exit 0", () => {
  const s = computeVerdict([item("a", "PASS", 0), item("b", "PASS", 0)]);
  assert.equal(s.verdict, "ALL_PASS");
  assert.equal(s.exitCode, 0);
  assert.deepEqual(s.counts, { pass: 2, fail: 0, blocked: 0, notRun: 0 });
});

test("any FAIL -> HAS_FAIL / exit 2 even with BLOCKED and NOT_RUN present", () => {
  const s = computeVerdict([
    item("a", "PASS", 0),
    item("b", "FAIL", 1),
    item("c", "BLOCKED", null),
    item("d", "NOT_RUN", null),
  ]);
  assert.equal(s.verdict, "HAS_FAIL");
  assert.equal(s.exitCode, 2);
  assert.deepEqual(s.counts, { pass: 1, fail: 1, blocked: 1, notRun: 1 });
});

test("no FAIL but BLOCKED/NOT_RUN -> INCOMPLETE / exit 3", () => {
  const s1 = computeVerdict([item("a", "PASS", 0), item("b", "BLOCKED", null)]);
  assert.equal(s1.verdict, "INCOMPLETE");
  assert.equal(s1.exitCode, 3);
  const s2 = computeVerdict([item("a", "PASS", 0), item("d", "NOT_RUN", null)]);
  assert.equal(s2.verdict, "INCOMPLETE");
  assert.equal(s2.exitCode, 3);
});

test("empty item list -> ALL_PASS / exit 0 (a verifier with zero checks is a bug caught elsewhere)", () => {
  const s = computeVerdict([]);
  assert.equal(s.verdict, "ALL_PASS");
  assert.equal(s.exitCode, 0);
});

test("exit-code consistency: PASS must be 0", () => {
  const problems = checkExitCodeConsistency([item("a", "PASS", 1)]);
  assert.equal(problems.length, 1);
  assert.ok(problems[0]!.includes("PASS must carry exitCode 0"));
});

test("exit-code consistency: FAIL needs non-zero exit AND structured error", () => {
  assert.equal(checkExitCodeConsistency([item("a", "FAIL", 0)]).length, 2);
  const noError = checkExitCodeConsistency([{ id: "a", status: "FAIL", exitCode: 2 }]);
  assert.equal(noError.length, 1);
  assert.ok(noError[0]!.includes("structured error"));
  const good: ResultItem[] = [
    { id: "a", status: "FAIL", exitCode: 2, error: { message: "boom" } },
  ];
  assert.deepEqual(checkExitCodeConsistency(good), []);
});

test("exit-code consistency: BLOCKED/NOT_RUN need reason, never exit 0", () => {
  // exitCode 0 AND missing reason -> two distinct problems.
  assert.equal(checkExitCodeConsistency([item("a", "BLOCKED", 0)]).length, 2);
  const missingReason = checkExitCodeConsistency([item("a", "NOT_RUN", null)]);
  assert.equal(missingReason.length, 1);
  assert.ok(missingReason[0]!.includes("reason"));
  const okItems: ResultItem[] = [
    { id: "a", status: "BLOCKED", exitCode: null, reason: "no credentials" },
    { id: "b", status: "BLOCKED", exitCode: 3, reason: "attempted, exited 3" },
    { id: "c", status: "NOT_RUN", exitCode: null, reason: "module not delivered yet" },
  ];
  assert.deepEqual(checkExitCodeConsistency(okItems), []);
});

test("exit-code consistency: unknown status is a problem", () => {
  const problems = checkExitCodeConsistency([
    { id: "a", status: "MAYBE" as ResultItem["status"], exitCode: 0 },
  ]);
  assert.equal(problems.length, 1);
});
