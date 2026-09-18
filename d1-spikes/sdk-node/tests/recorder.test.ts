/**
 * Recorder tests: seq monotonicity, JSONL framing, atomic finalize,
 * redaction-on-write, markers, and merge behavior.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EvidenceRecorder,
  buildEvidenceEvent,
  toSafeJsonLine,
  runStateFor,
  slimPiEvent,
  mergeEventFiles,
} from "../src/recorder.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "treeai-recorder-test-"));
}

test("seq is strictly increasing across records", () => {
  const dir = tmpDir();
  const rec = EvidenceRecorder.open({ dir, scenario: "basic" });
  for (let i = 0; i < 10; i++) {
    rec.record("message_update", { i });
  }
  rec.finalize();
  const lines = readFileSync(rec.finalPath, "utf8").trim().split("\n");
  const seqs = lines.map((l) => (JSON.parse(l) as { seq: number }).seq);
  assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test("every line is valid JSON and single-line framed, including payload newlines and U+2028", () => {
  const dir = tmpDir();
  const rec = EvidenceRecorder.open({ dir, scenario: "basic" });
  rec.record("message_update", {
    text: "line1\nline2\r\nline3 line4 line5",
  });
  rec.finalize();
  const raw = readFileSync(rec.finalPath, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim() !== "");
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]!) as { payload: { text: string } };
  assert.equal(parsed.payload.text, "line1\nline2\r\nline3 line4 line5");
});

test("finalize is atomic: temp file gone, final file exists; no finalize means no final file", () => {
  const dir = tmpDir();
  const rec = EvidenceRecorder.open({ dir, scenario: "basic" });
  rec.record("message_start", {});
  assert.ok(!existsSync(rec.finalPath), "final must not exist before finalize");
  const tmpFiles = readdirSync(dir).filter((f) => f.includes(".tmp"));
  assert.equal(tmpFiles.length, 1, "temp file exists while recording");
  rec.finalize();
  assert.ok(existsSync(rec.finalPath));
  assert.equal(readdirSync(dir).filter((f) => f.includes(".tmp")).length, 0);
});

test("finalize never clobbers a previous final file mid-crash", () => {
  const dir = tmpDir();
  const rec1 = EvidenceRecorder.open({ dir, scenario: "basic" });
  rec1.record("message_start", { v: 1 });
  rec1.finalize();
  const before = readFileSync(join(dir, "events.jsonl"), "utf8");
  // Simulated crash: second recorder writes to tmp but never finalizes.
  const rec2 = EvidenceRecorder.open({ dir, scenario: "basic" });
  rec2.record("message_start", { v: 2 });
  const after = readFileSync(join(dir, "events.jsonl"), "utf8");
  assert.equal(after, before, "existing final file untouched by an unfinalized recorder");
  rec2.discard();
});

test("payloads are redacted on write", () => {
  const dir = tmpDir();
  const rec = EvidenceRecorder.open({ dir, scenario: "basic" });
  rec.record("message_update", {
    apiKey: "sk-ant-api03-AbCdEf123456789012345",
    path: "/Users/alice/secret/file",
  });
  rec.finalize();
  const raw = readFileSync(rec.finalPath, "utf8");
  assert.ok(!raw.includes("sk-ant-"));
  assert.ok(!raw.includes("/Users/alice"));
  assert.ok(raw.includes("[REDACTED:"));
  assert.ok(raw.includes("~/"));
});

test("markers and errors use probe event types", () => {
  const dir = tmpDir();
  const rec = EvidenceRecorder.open({ dir, scenario: "steer" });
  rec.recordMarker("steer_sent", { afterDeltas: 2 });
  rec.recordError(new Error("boom"));
  rec.finalize();
  const events = readFileSync(rec.finalPath, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { piEventType: string; runState: string });
  assert.equal(events[0]!.piEventType, "probe_marker");
  assert.equal(events[0]!.runState, "probe");
  assert.equal(events[1]!.piEventType, "probe_error");
  assert.equal(events[1]!.runState, "error");
});

test("sessionId can be set after open", () => {
  const dir = tmpDir();
  const rec = EvidenceRecorder.open({ dir, scenario: "basic" });
  rec.record("agent_start", {});
  rec.setSessionId("real-id-1");
  rec.record("agent_end", {});
  rec.finalize();
  const events = readFileSync(rec.finalPath, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { sessionId: string });
  assert.equal(events[0]!.sessionId, "pre-session");
  assert.equal(events[1]!.sessionId, "real-id-1");
});

test("oversized payloads are dropped with a marker, not silently truncated", () => {
  const ev = buildEvidenceEvent({
    seq: 1,
    scenario: "basic",
    sessionId: "s",
    piEventType: "message_update",
    payload: { big: "x".repeat(200_000) },
  });
  assert.equal(ev.payloadTruncated, true);
  const payload = ev.payload as { payloadDropped: boolean; reason: string };
  assert.equal(payload.payloadDropped, true);
  assert.ok(payload.reason.includes("MAX_PAYLOAD_CHARS"));
});

test("message_update partial is slimmed but delta preserved", () => {
  const slimmed = slimPiEvent({
    type: "message_update",
    assistantMessageEvent: {
      type: "text_delta",
      delta: "abc",
      partial: { role: "assistant", content: [{ type: "text", text: "full-so-far" }] },
    },
  }) as {
    assistantMessageEvent: { delta: string; partial: { content: Array<{ type: string; text: string }> } };
  };
  assert.equal(slimmed.assistantMessageEvent.delta, "abc");
  assert.equal(slimmed.assistantMessageEvent.partial.content[0]!.text, "full-so-far");
});

test("runStateFor maps event types", () => {
  assert.equal(runStateFor("agent_start"), "running");
  assert.equal(runStateFor("message_update"), "running");
  assert.equal(runStateFor("agent_settled"), "idle");
  assert.equal(runStateFor("probe_error"), "error");
  assert.equal(runStateFor("something_new"), "unknown");
});

test("toSafeJsonLine escapes U+2028/U+2029 so each record stays one line", () => {
  const line = toSafeJsonLine({ t: "a b c" });
  assert.ok(!line.includes(" "));
  assert.ok(!line.includes(" "));
  assert.equal(line.split("\n").length, 1);
});

test("mergeEventFiles re-records child events with global seq and phase tags", () => {
  const dirA = join(tmpDir(), "a");
  const dirB = join(tmpDir(), "b");
  const recA = EvidenceRecorder.open({ dir: dirA, scenario: "resume" });
  recA.record("agent_start", { phase: "A" });
  recA.finalize();
  const recB = EvidenceRecorder.open({ dir: dirB, scenario: "resume" });
  recB.record("agent_start", { phase: "B" });
  recB.record("agent_settled", {});
  recB.finalize();

  const parentDir = tmpDir();
  const parent = EvidenceRecorder.open({ dir: parentDir, scenario: "resume" });
  parent.recordMarker("phaseA_spawn", {});
  const merged = mergeEventFiles(
    [
      { path: join(dirA, "events.jsonl"), probePhase: "A" },
      { path: join(dirB, "events.jsonl"), probePhase: "B" },
    ],
    parent,
  );
  parent.finalize();
  assert.equal(merged, 3);
  const events = readFileSync(parent.finalPath, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { seq: number; probePhase?: string; piEventType: string });
  assert.deepEqual(events.map((e) => e.seq), [1, 2, 3, 4]);
  assert.equal(events[1]!.probePhase, "A");
  assert.equal(events[2]!.probePhase, "B");
  assert.equal(events[3]!.probePhase, "B");
});
