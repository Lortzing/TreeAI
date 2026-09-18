/**
 * TreeAI D1 spike - evidence recorder.
 *
 * Writes raw events as JSONL: one JSON object per line (task book 6.1).
 * - seq is assigned by this recorder and strictly increases per file.
 * - Events are redacted (redact.ts) before serialization.
 * - Writing goes to a temp file first; finalize() fsyncs and atomically
 *   renames to events.jsonl. A crash never leaves a truncated final file.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
  fsyncSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { IMPLEMENTATION, type EvidenceEvent, type ScenarioName } from "./types.js";
import { REDACTION_VERSION, redactValue, findLeakCandidates } from "./redact.js";

/** Cap for any single serialized payload (chars). Prevents runaway JSONL. */
export const MAX_PAYLOAD_CHARS = 65_536;

/**
 * Slim bulky Pi event fields while preserving audit-relevant structure:
 * - message_update: assistantMessageEvent.partial is replaced by a summary
 *   (the delta itself is kept, so streamed text stays reassemblable).
 * - Any "message" object: thinking content is summarized, text capped.
 */
export function slimPiEvent(event: unknown): unknown {
  if (event === null || typeof event !== "object") return event;
  const ev = event as Record<string, unknown>;
  if (ev.type === "message_update" && ev.assistantMessageEvent && typeof ev.assistantMessageEvent === "object") {
    const ame = { ...(ev.assistantMessageEvent as Record<string, unknown>) };
    if (ame.partial && typeof ame.partial === "object") {
      ame.partial = summarizeMessage(ame.partial);
    }
    return { ...ev, assistantMessageEvent: ame };
  }
  if (ev.message && typeof ev.message === "object") {
    return { ...ev, message: summarizeMessage(ev.message) };
  }
  return ev;
}

function summarizeMessage(message: unknown): unknown {
  if (message === null || typeof message !== "object") return message;
  const msg = message as Record<string, unknown>;
  if (typeof msg.content !== "object" || msg.content === null) return message;
  if (!Array.isArray(msg.content)) return message;
  const content = msg.content.map((part) => {
    if (part === null || typeof part !== "object") return part;
    const p = part as Record<string, unknown>;
    if (p.type === "thinking") {
      return { type: "thinking", slimmed: true, length: String(p.thinking ?? "").length };
    }
    if (typeof p.text === "string" && p.text.length > 16_384) {
      return { ...p, text: p.text.slice(0, 16_384), textTruncated: true };
    }
    return p;
  });
  return { ...msg, content };
}

/** Coarse run state derived from the Pi event type (documented mapping). */
export function runStateFor(piEventType: string): string {
  switch (piEventType) {
    case "agent_start":
    case "turn_start":
    case "message_start":
    case "message_update":
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end":
    case "queue_update":
    case "compaction_start":
    case "auto_retry_start":
    case "summarization_retry_attempt_start":
      return "running";
    case "agent_end":
    case "agent_settled":
      return "idle";
    case "message_end":
    case "turn_end":
      return "running";
    case "probe_error":
      return "error";
    default:
      return "unknown";
  }
}

/** Build one evidence event (pure; exported for tests). */
export function buildEvidenceEvent(opts: {
  seq: number;
  scenario: ScenarioName;
  sessionId: string;
  piEventType: string;
  payload: unknown;
  observedAt?: string;
  runState?: string;
  probePhase?: string;
}): EvidenceEvent {
  let payload = redactValue(slimPiEvent(opts.payload));
  let truncated = false;
  const serialized = JSON.stringify(payload);
  if (serialized !== undefined && serialized.length > MAX_PAYLOAD_CHARS) {
    payload = {
      payloadDropped: true,
      reason: "payload exceeded MAX_PAYLOAD_CHARS",
      piEventType: opts.piEventType,
      serializedLength: serialized.length,
    };
    truncated = true;
  }
  const leaks = findLeakCandidates(payload);
  if (leaks.length > 0) {
    // Never let a leak candidate reach disk; replace payload body but keep type.
    payload = {
      payloadDropped: true,
      reason: `leak candidates detected: ${leaks.join(",")}`,
      piEventType: opts.piEventType,
    };
    truncated = true;
  }
  const ev: EvidenceEvent = {
    seq: opts.seq,
    observedAt: opts.observedAt ?? new Date().toISOString(),
    implementation: IMPLEMENTATION,
    scenario: opts.scenario,
    sessionId: opts.sessionId,
    piEventType: opts.piEventType,
    runState: opts.runState ?? runStateFor(opts.piEventType),
    payload,
    redactionVersion: REDACTION_VERSION,
  };
  if (opts.probePhase !== undefined) ev.probePhase = opts.probePhase;
  if (truncated) ev.payloadTruncated = true;
  return ev;
}

/** JSON.stringify with U+2028/U+2029 escaped so every record is one line. */
export function toSafeJsonLine(value: unknown): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export class EvidenceRecorder {
  readonly finalPath: string;
  private readonly tmpPath: string;
  private readonly scenario: ScenarioName;
  private sessionId: string;
  private seqCounter = 0;
  private fd: number | null = null;
  private finalized = false;
  private probePhase: string | undefined;

  private constructor(opts: {
    dir: string;
    scenario: ScenarioName;
    sessionId: string;
    probePhase?: string;
  }) {
    this.scenario = opts.scenario;
    this.sessionId = opts.sessionId;
    this.probePhase = opts.probePhase;
    this.finalPath = join(opts.dir, "events.jsonl");
    this.tmpPath = join(opts.dir, `.events.jsonl.${Date.now()}.${process.pid}.tmp`);
  }

  static open(opts: {
    dir: string;
    scenario: ScenarioName;
    sessionId?: string;
    probePhase?: string;
  }): EvidenceRecorder {
    mkdirSync(opts.dir, { recursive: true });
    const recorder = new EvidenceRecorder({
      dir: opts.dir,
      scenario: opts.scenario,
      sessionId: opts.sessionId ?? "pre-session",
      probePhase: opts.probePhase,
    });
    recorder.fd = openSync(recorder.tmpPath, "w");
    return recorder;
  }

  /** Session id becomes known only after session creation. */
  setSessionId(id: string): void {
    this.sessionId = id;
  }

  setProbePhase(phase: string | undefined): void {
    this.probePhase = phase;
  }

  record(piEventType: string, payload: unknown, runState?: string): EvidenceEvent {
    if (this.finalized) {
      throw new Error("EvidenceRecorder.record called after finalize");
    }
    if (this.fd === null) {
      throw new Error("EvidenceRecorder is not open");
    }
    this.seqCounter += 1;
    const ev = buildEvidenceEvent({
      seq: this.seqCounter,
      scenario: this.scenario,
      sessionId: this.sessionId,
      piEventType,
      payload,
      runState,
      probePhase: this.probePhase,
    });
    const line = toSafeJsonLine(ev);
    if (line.includes("\n") || line.includes("\r")) {
      // Defensive: toSafeJsonLine must guarantee single-line framing.
      throw new Error(`JSONL framing violated for seq=${ev.seq}`);
    }
    writeSync(this.fd, line + "\n");
    return ev;
  }

  /** Probe-internal marker (steer sent, phase boundary, ...). */
  recordMarker(marker: string, detail: Record<string, unknown> = {}): EvidenceEvent {
    return this.record("probe_marker", { marker, ...detail }, "probe");
  }

  /** Structured error event; always written even when the scenario fails. */
  recordError(error: unknown, extra: Record<string, unknown> = {}): EvidenceEvent {
    const err = error as { name?: string; message?: string; stack?: string; blockedReason?: string };
    return this.record("probe_error", {
      name: err && typeof err.name === "string" ? err.name : typeof error,
      message: err && typeof err.message === "string" ? err.message : String(error),
      stack: err && typeof err.stack === "string" ? err.stack : undefined,
      ...extra,
    });
  }

  /** fsync + close + atomic rename tmp -> events.jsonl. */
  finalize(): void {
    if (this.finalized) return;
    if (this.fd !== null) {
      fsyncSync(this.fd);
      closeSync(this.fd);
      this.fd = null;
    }
    if (existsSync(this.tmpPath)) {
      renameSync(this.tmpPath, this.finalPath);
    }
    this.finalized = true;
  }

  /** Remove temp file without producing a final file (tests only). */
  discard(): void {
    if (this.finalized) return;
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
    if (existsSync(this.tmpPath)) {
      unlinkSync(this.tmpPath);
    }
    this.finalized = true;
  }

  get eventCount(): number {
    return this.seqCounter;
  }
}

/**
 * Merge child-process event files into a parent recorder: re-records each
 * payload with a fresh global seq, preserving the child's observedAt and
 * piEventType, and tagging probePhase. Used by the resume scenario.
 */
export function mergeEventFiles(
  files: Array<{ path: string; probePhase: string }>,
  recorder: EvidenceRecorder,
): number {
  let merged = 0;
  for (const { path, probePhase } of files) {
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    recorder.setProbePhase(probePhase);
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      const parsed = JSON.parse(line) as EvidenceEvent;
      recorder.record(parsed.piEventType, parsed.payload, parsed.runState);
      merged += 1;
    }
    recorder.setProbePhase(undefined);
  }
  return merged;
}

/** Remove a directory tree if it exists (temp cleanup helper). */
export function removeDirIfPresent(path: string): void {
  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true });
  }
}
