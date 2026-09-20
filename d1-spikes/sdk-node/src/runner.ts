/**
 * TreeAI D1 spike - scenario runner harness.
 *
 * Guarantees per run (task book 5/9):
 * - total timeout per scenario; on timeout the run is FAIL, not PASS;
 * - cleanup handlers (unsubscribe, abort, dispose) always run via finally;
 * - the recorder is finalized (atomic rename) even when the scenario
 *   fails, so the last known event and a structured error are on disk;
 * - every scenario ends with a structured result JSON and a trustworthy
 *   exit code (PASS=0, FAIL=1, BLOCKED=2, NOT_RUN=3).
 */

import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join, relative } from "node:path";
import { EvidenceRecorder } from "./recorder.js";
import { BlockedError, isBlockedError } from "./blocked.js";
import { redactValue } from "./redact.js";
import { D1_SPIKES_DIR } from "./paths.js";
import {
  EXIT_CODES,
  IMPLEMENTATION,
  type BlockedReason,
  type ProbeScenarioName,
  type ScenarioResult,
  type StructuredError,
} from "./types.js";
import { validateEventFile, validateScenarioResult } from "./validate.js";

export class ScenarioCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioCheckError";
  }
}

export class TimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Scenario exceeded total timeout of ${timeoutMs}ms`);
    this.name = "TimeoutError";
  }
}

export interface ScenarioContext {
  scenario: ProbeScenarioName;
  recorder: EvidenceRecorder;
  /** Directory for this scenario's evidence (already exists). */
  scenarioDir: string;
  /** Top-level run directory for this invocation. */
  runDir: string;
  timeoutMs: number;
  startedAtMs: number;
  observe(message: string): void;
  limit(message: string): void;
  /** Record a pass/fail check; failures mark the scenario FAIL but keep running. */
  check(condition: boolean, name: string): void;
  /** Throw BlockedError (short-circuit to BLOCKED). */
  markBlocked(reason: BlockedReason, message: string): never;
  /** Register cleanup; runs in reverse registration order in finally. */
  onCleanup(fn: () => void | Promise<void>): void;
}

export interface RunScenarioOptions {
  scenario: ProbeScenarioName;
  command: string;
  timeoutMs: number;
  runDir: string;
  exec: (ctx: ScenarioContext) => Promise<void>;
  /** Extra limitations recorded on every result (fixture fallback etc.). */
  limitations?: string[];
}

function toStructuredError(err: unknown): StructuredError {
  if (err === null || err === undefined) {
    return { name: "None", message: "unknown error" };
  }
  const e = err as { name?: string; message?: string; stack?: string; blockedReason?: BlockedReason };
  return {
    name: typeof e.name === "string" ? e.name : typeof err,
    message: typeof e.message === "string" ? e.message : String(err),
    stack: typeof e.stack === "string" ? e.stack : undefined,
    blockedReason: e.blockedReason,
  };
}

export async function runScenario(opts: RunScenarioOptions): Promise<ScenarioResult> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const scenarioDir = join(opts.runDir, opts.scenario);
  mkdirSync(scenarioDir, { recursive: true });
  const recorder = EvidenceRecorder.open({ dir: scenarioDir, scenario: opts.scenario });

  const observations: string[] = [];
  const limitations: string[] = [...(opts.limitations ?? [])];
  const failedChecks: string[] = [];
  const cleanups: Array<() => void | Promise<void>> = [];

  const ctx: ScenarioContext = {
    scenario: opts.scenario,
    recorder,
    scenarioDir,
    runDir: opts.runDir,
    timeoutMs: opts.timeoutMs,
    startedAtMs: t0,
    observe(message) {
      observations.push(message);
    },
    limit(message) {
      limitations.push(message);
    },
    check(condition, name) {
      if (condition) {
        observations.push(`check-pass: ${name}`);
      } else {
        failedChecks.push(name);
        observations.push(`check-FAIL: ${name}`);
      }
    },
    markBlocked(reason, message) {
      throw new BlockedError(reason, message);
    },
    onCleanup(fn) {
      cleanups.push(fn);
    },
  };

  let status: ScenarioResult["status"] = "PASS";
  let error: StructuredError | null = null;

  recorder.recordMarker("scenario_start", { scenario: opts.scenario, command: opts.command, timeoutMs: opts.timeoutMs });

  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new TimeoutError(opts.timeoutMs)), opts.timeoutMs);
      cleanups.push(() => clearTimeout(timer));
    });
    await Promise.race([opts.exec(ctx), timeoutPromise]);
  } catch (err) {
    if (isBlockedError(err)) {
      status = "BLOCKED";
      error = toStructuredError(err);
      recorder.recordError(err, { blockedReason: err.blockedReason });
    } else {
      status = "FAIL";
      error = toStructuredError(err);
      recorder.recordError(err);
    }
  } finally {
    // Cleanups run in reverse order; each is isolated so one failure
    // cannot prevent the remaining ones.
    for (const fn of [...cleanups].reverse()) {
      try {
        await fn();
      } catch (cleanupErr) {
        recorder.recordError(cleanupErr, { during: "cleanup" });
      }
    }
    if (failedChecks.length > 0 && status === "PASS") {
      status = "FAIL";
      error = {
        name: "ScenarioCheckError",
        message: `failed checks: ${failedChecks.join("; ")}`,
      };
    }
    recorder.recordMarker("scenario_end", { status, failedChecks });
    recorder.finalize();
  }

  const endedAt = new Date().toISOString();
  const durationMs = Date.now() - t0;
  const eventsPath = recorder.finalPath;

  // Self-validation of the evidence we just wrote. A validation failure is
  // itself a FAIL (never silently ignored).
  const eventValidation = validateEventFileSafe(eventsPath);
  if (!eventValidation.ok) {
    status = status === "PASS" ? "FAIL" : status;
    failedChecks.push(`event-file-validation: ${eventValidation.errors.slice(0, 3).join(" | ")}`);
  }

  const result: ScenarioResult = {
    implementation: IMPLEMENTATION,
    scenario: opts.scenario,
    status,
    startedAt,
    endedAt,
    durationMs,
    command: opts.command,
    exitCode: EXIT_CODES[status],
    evidenceFiles: [relative(D1_SPIKES_DIR, eventsPath)],
    observations,
    limitations,
    error,
    failedChecks: failedChecks.length > 0 ? failedChecks : undefined,
  };

  const redactedResult = redactValue(result) as ScenarioResult;
  const resultValidation = validateScenarioResult(redactedResult);
  if (!resultValidation.ok) {
    // The harness itself is broken; that is a hard FAIL with details.
    redactedResult.status = "FAIL";
    redactedResult.exitCode = EXIT_CODES.FAIL;
    redactedResult.observations.push(
      `result-schema-violations: ${resultValidation.errors.join(" | ")}`,
    );
  }

  writeResultJson(scenarioDir, redactedResult);
  return redactedResult;
}

function validateEventFileSafe(path: string): { ok: boolean; errors: string[] } {
  try {
    const r = validateEventFile(path);
    return { ok: r.ok, errors: r.errors };
  } catch (err) {
    return { ok: false, errors: [(err as Error).message] };
  }
}

/** Write result.json atomically (tmp + rename), like the event file. */
export function writeResultJson(dir: string, result: ScenarioResult): string {
  const finalPath = join(dir, "result.json");
  const tmpPath = join(dir, `.result.json.${Date.now()}.${process.pid}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(result, null, 2) + "\n");
  renameSync(tmpPath, finalPath);
  return finalPath;
}

/** Aggregate exit code across scenarios (worst first: FAIL > BLOCKED > NOT_RUN). */
export function aggregateExitCode(results: ScenarioResult[]): number {
  if (results.some((r) => r.status === "FAIL")) return EXIT_CODES.FAIL;
  if (results.some((r) => r.status === "BLOCKED")) return EXIT_CODES.BLOCKED;
  if (results.some((r) => r.status === "NOT_RUN")) return EXIT_CODES.NOT_RUN;
  return EXIT_CODES.PASS;
}
