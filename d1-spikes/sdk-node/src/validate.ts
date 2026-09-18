/**
 * TreeAI D1 spike - structural validation of evidence files.
 *
 * The shared JSON Schemas (d1-spikes/schemas/, owned by Agent D) were not
 * present when this probe was written. This module therefore implements a
 * minimal structural validator that checks exactly the fields required by
 * the D1 task book sections 6.1/6.2. When Agent D's shared schemas appear,
 * detectSharedSchemas() reports them so the runner can record a limitation
 * noting that full JSON Schema validation against the shared files is a
 * PENDING integration (PENDING_OWNER alignment), while the local rules
 * below stay in force.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  IMPLEMENTATION,
  RESULT_STATUSES,
  SCENARIOS,
  type EvidenceEvent,
  type ScenarioResult,
} from "./types.js";
import { REDACTION_VERSION } from "./redact.js";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

export function validateEvidenceEvent(ev: unknown): ValidationResult {
  const errors: string[] = [];
  const e = ev as Partial<EvidenceEvent>;
  if (typeof e !== "object" || e === null) {
    return { ok: false, errors: ["event is not an object"] };
  }
  if (typeof e.seq !== "number" || !Number.isInteger(e.seq) || e.seq < 1) {
    errors.push(`seq must be a positive integer, got ${String(e.seq)}`);
  }
  if (typeof e.observedAt !== "string" || !ISO_DATE_RE.test(e.observedAt)) {
    errors.push(`observedAt must be an ISO timestamp, got ${String(e.observedAt)}`);
  }
  if (e.implementation !== IMPLEMENTATION) {
    errors.push(`implementation must be "${IMPLEMENTATION}", got ${String(e.implementation)}`);
  }
  if (!SCENARIOS.includes(e.scenario as (typeof SCENARIOS)[number])) {
    errors.push(`scenario must be one of ${SCENARIOS.join("|")}, got ${String(e.scenario)}`);
  }
  if (typeof e.sessionId !== "string" || e.sessionId.length === 0) {
    errors.push("sessionId must be a non-empty string");
  }
  if (typeof e.piEventType !== "string" || e.piEventType.length === 0) {
    errors.push("piEventType must be a non-empty string");
  }
  if (typeof e.runState !== "string" || e.runState.length === 0) {
    errors.push("runState must be a non-empty string");
  }
  if (e.payload === undefined) {
    errors.push("payload is required (may be null)");
  }
  if (e.redactionVersion !== REDACTION_VERSION) {
    errors.push(`redactionVersion must be "${REDACTION_VERSION}", got ${String(e.redactionVersion)}`);
  }
  return { ok: errors.length === 0, errors };
}

export function validateScenarioResult(r: unknown): ValidationResult {
  const errors: string[] = [];
  const res = r as Partial<ScenarioResult>;
  if (typeof res !== "object" || res === null) {
    return { ok: false, errors: ["result is not an object"] };
  }
  if (res.implementation !== IMPLEMENTATION) {
    errors.push(`implementation must be "${IMPLEMENTATION}", got ${String(res.implementation)}`);
  }
  if (!SCENARIOS.includes(res.scenario as (typeof SCENARIOS)[number])) {
    errors.push(`scenario must be one of ${SCENARIOS.join("|")}, got ${String(res.scenario)}`);
  }
  if (!RESULT_STATUSES.includes(res.status as (typeof RESULT_STATUSES)[number])) {
    errors.push(`status must be one of ${RESULT_STATUSES.join("|")}, got ${String(res.status)}`);
  }
  if (typeof res.startedAt !== "string" || !ISO_DATE_RE.test(res.startedAt)) {
    errors.push("startedAt must be an ISO timestamp");
  }
  if (typeof res.endedAt !== "string" || !ISO_DATE_RE.test(res.endedAt)) {
    errors.push("endedAt must be an ISO timestamp");
  }
  if (typeof res.durationMs !== "number" || !Number.isFinite(res.durationMs) || res.durationMs < 0) {
    errors.push("durationMs must be a non-negative number");
  }
  if (typeof res.command !== "string" || res.command.length === 0) {
    errors.push("command must be a non-empty string");
  }
  if (typeof res.exitCode !== "number" || !Number.isInteger(res.exitCode)) {
    errors.push("exitCode must be an integer");
  }
  if (!Array.isArray(res.evidenceFiles) || !res.evidenceFiles.every((f) => typeof f === "string")) {
    errors.push("evidenceFiles must be an array of strings");
  }
  if (!Array.isArray(res.observations) || !res.observations.every((o) => typeof o === "string")) {
    errors.push("observations must be an array of strings");
  }
  if (!Array.isArray(res.limitations) || !res.limitations.every((l) => typeof l === "string")) {
    errors.push("limitations must be an array of strings");
  }
  if (res.error !== null && typeof res.error !== "object") {
    errors.push("error must be null or an object");
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Validate a JSONL event file: every line must parse, validate, and seq
 * must be strictly increasing (task book 6.1).
 */
export function validateEventFile(path: string): ValidationResult & { count: number } {
  const errors: string[] = [];
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  let lastLineHadContent = false;
  let prevSeq = 0;
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === "" && i === lines.length - 1) break; // trailing newline
    if (line.trim() === "") {
      errors.push(`line ${i + 1}: blank line inside JSONL`);
      continue;
    }
    lastLineHadContent = true;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      errors.push(`line ${i + 1}: invalid JSON (${(err as Error).message})`);
      continue;
    }
    const vr = validateEvidenceEvent(parsed);
    for (const e of vr.errors) errors.push(`line ${i + 1}: ${e}`);
    const seq = (parsed as EvidenceEvent).seq;
    if (typeof seq === "number") {
      if (seq <= prevSeq) {
        errors.push(`line ${i + 1}: seq ${seq} not strictly greater than previous ${prevSeq}`);
      }
      prevSeq = seq;
    }
    count += 1;
  }
  if (!lastLineHadContent && text.length > 0 && !text.endsWith("\n")) {
    errors.push("file does not end with a newline");
  }
  return { ok: errors.length === 0, errors, count };
}

/** Detect Agent D's shared schemas (informational; may be absent). */
export function detectSharedSchemas(d1SpikesDir: string): {
  evidenceEventSchema: string | null;
  scenarioResultSchema: string | null;
} {
  const eventPath = join(d1SpikesDir, "schemas", "evidence-event.schema.json");
  const resultPath = join(d1SpikesDir, "schemas", "scenario-result.schema.json");
  return {
    evidenceEventSchema: existsSync(eventPath) ? eventPath : null,
    scenarioResultSchema: existsSync(resultPath) ? resultPath : null,
  };
}
