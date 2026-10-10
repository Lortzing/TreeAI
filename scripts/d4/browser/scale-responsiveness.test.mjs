import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyB6Responsiveness } from "./scale-responsiveness.mjs";

const limits = { mainThreadSegmentLimitMs: 200, keystrokeP95LimitMs: 200 };
const keys = (n, duration) => Array.from({ length: n }, () => ({ keydownToRender: duration }));
const sample = (changes = {}) => ({ longTasks: [], steps: [20, 30, 40], keys: keys(12, 50), ...changes });

test("B6 responsiveness retains original p95, longtask and minimum typing count", () => {
  const result = classifyB6Responsiveness(sample(), limits);
  assert.deepEqual(result.problems, []);
  assert.equal(result.stepStats.p95Ms, 40);
  assert.equal(result.keyStats.count, 12);
  assert.equal(result.keyStats.p95Ms, 50);
  assert.equal(result.worstTask, 0);
});

test("B6 fails a longtask over 200ms even when scroll frames are fast", () => {
  const result = classifyB6Responsiveness(sample({ longTasks: [{ duration: 201 }] }), limits);
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /main-thread segment/);
});

test("B6 independently rejects slow scroll frames and too few rendered keystrokes", () => {
  const result = classifyB6Responsiveness(sample({ steps: [201], keys: keys(9, 50) }), limits);
  assert.equal(result.problems.length, 2);
  assert.match(result.problems[0], /scroll step-to-frame p95/);
  assert.match(result.problems[1], /only 9 keystrokes/);
});

test("B6 keeps keystroke-to-render p95 frozen at 200ms, not keydown-to-value", () => {
  const result = classifyB6Responsiveness(sample({ keys: keys(12, 201) }), limits);
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /keystroke-to-render p95/);
});

test("B6 accepts values exactly at the frozen limits", () => {
  const result = classifyB6Responsiveness(sample({ longTasks: [{ duration: 200 }], steps: [200], keys: keys(10, 200) }), limits);
  assert.deepEqual(result.problems, []);
});
