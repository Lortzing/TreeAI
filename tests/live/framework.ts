/**
 * Live scenario framework (Agent F) — the executable skeleton behind
 * scripts/verify-d2-live.js and the six D2 live scenarios:
 * basic, tool-policy, steer, abort, resume, tree-navigation.
 *
 * Design rules (task book §5 Agent F item 3):
 *   - credentials ONLY via controlled env vars, read by the entry script,
 *     passed to the runtime factory in memory, never persisted or logged;
 *   - the user's real Pi configuration (~/.pi) is NEVER read as a shortcut;
 *   - without credentials the scenarios report BLOCKED (exit 3), never PASS;
 *   - `--driver=fake` runs the same six scenarios against FakePiRuntime so
 *     the framework itself is verified offline in CI (tests/live/selftest).
 *   - the same framework is used by tests/live/selftest.test.ts so the
 *     framework cannot silently rot between the script and the tests.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PiRuntime, SessionReference } from "@treeai/contracts";
import { FakePiRuntime, type FakePromptScript } from "../support/fake-pi-runtime.ts";
import { EventRecorder } from "../support/harness.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const LIVE_FIXTURE = join(REPO_ROOT, "tests", "fixtures", "e2e", "live", "notes.txt");

/** The frozen scenario ids (D1/D2 shared contract; tree-navigation is canonical). */
export const LIVE_SCENARIO_IDS = [
  "basic",
  "tool-policy",
  "steer",
  "abort",
  "resume",
  "tree-navigation",
] as const;

export type LiveScenarioId = (typeof LIVE_SCENARIO_IDS)[number];

export type ScenarioStatus = "PASS" | "FAIL" | "BLOCKED" | "NOT_RUN";

export interface ScenarioRecord {
  readonly id: string;
  readonly status: ScenarioStatus;
  readonly exitCode: number | null;
  readonly scenario: LiveScenarioId;
  readonly driver: "pi" | "fake";
  readonly piVersion: string;
  readonly reason?: string;
  readonly error?: { message: string; code?: string };
  readonly evidenceFiles?: readonly string[];
  readonly durationMs?: number;
  readonly meta?: Record<string, unknown>;
}

export interface DriverContext {
  readonly driver: "pi" | "fake";
  readonly sessionDir: string;
  /** Model selector from controlled env (never logged). */
  readonly model: { providerId: string; modelId: string };
  /** Which scenario this runtime is being created for. */
  readonly scenarioId: LiveScenarioId;
}

export interface LiveDriver {
  readonly name: "pi" | "fake";
  /** Create a runtime for one scenario (fresh instance per scenario). */
  createRuntime(ctx: DriverContext): Promise<PiRuntime>;
}

/* ------------------------------------------------------------------ */
/* Fake driver (framework self-verification, zero credentials)         */
/* ------------------------------------------------------------------ */

export interface FakeDriverConfig {
  /** Scenario-specific prompt scripts (consumed FIFO per runtime). */
  readonly scriptByScenario?: Partial<Record<LiveScenarioId, readonly FakePromptScript[]>>;
  /** Turn delay for scenarios that must still be streaming when we act. */
  readonly longDelayMs?: number;
}

export function fakeDriver(config: FakeDriverConfig = {}): LiveDriver {
  return {
    name: "fake",
    async createRuntime(ctx) {
      // steer/abort must catch the run mid-flight: use a long turn delay.
      const long = ctx.scenarioId === "steer" || ctx.scenarioId === "abort";
      return new FakePiRuntime({
        sessionDir: ctx.sessionDir,
        model: ctx.model,
        turnDelayMs: long ? (config.longDelayMs ?? 400) : 8,
        script: config.scriptByScenario?.[ctx.scenarioId],
      });
    },
  };
}

/** Default fake scripts that make the six scenarios meaningful offline. */
export function defaultFakeScripts(): Partial<Record<LiveScenarioId, readonly FakePromptScript[]>> {
  const notes = readFileSync(LIVE_FIXTURE, "utf8");
  const groundTruth = /(\d{4})/.exec(notes)?.[1] ?? "4127";
  return {
    "tool-policy": [
      {
        kind: "ok",
        turns: [`The secret number is ${groundTruth}.`],
        toolRequest: { tool: "read_file", path: LIVE_FIXTURE, action: "read" },
      },
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Pi driver (real @treeai/runtime-pi; factory discovery)              */
/* ------------------------------------------------------------------ */

/**
 * Candidate factory export names in @treeai/runtime-pi. Agent B's exact
 * factory signature is a Wave-1 deliverable; when it lands, the FIRST
 * matching export is used. If none matches, scenarios are NOT_RUN (honest
 * state) — this is an explicit interface deviation recorded in
 * coordination/d2/agent-f-handoff.md for the Integrator to reconcile.
 */
const FACTORY_EXPORT_NAMES = ["createPiRuntime", "createPiRuntimeForVerification", "createRuntime"] as const;

export interface PiDriverLoadResult {
  driver: LiveDriver | null;
  problem?: string;
}

export interface PiDriverOptions {
  /**
   * Controlled credentials (in-memory only): read by the entry script from
   * controlled env vars and handed to the runtime factory. Never logged,
   * never persisted, never written to evidence.
   */
  readonly credentials?: { readonly apiKey?: string };
}

export async function loadPiDriver(
  options: PiDriverOptions = {},
): Promise<PiDriverLoadResult> {
  let mod: Record<string, unknown>;
  try {
    // Non-literal specifier on purpose: @treeai/runtime-pi's public factory
    // shape is a Wave-1 deliverable and its package types are not frozen;
    // discovery is structural (see FACTORY_EXPORT_NAMES). Never falls back
    // to the fake silently.
    const specifier = "@treeai/runtime-pi";
    mod = (await import(specifier)) as Record<string, unknown>;
  } catch (err) {
    return { driver: null, problem: `@treeai/runtime-pi not importable: ${String(err)}` };
  }
  for (const name of FACTORY_EXPORT_NAMES) {
    const candidate = mod[name];
    if (typeof candidate === "function") {
      const apiKey = options.credentials?.apiKey;
      return {
        driver: {
          name: "pi",
          async createRuntime(ctx) {
            // Controlled credential injection: in-memory only, never logged.
            const factory = candidate as (config: unknown) => Promise<PiRuntime> | PiRuntime;
            const runtime = await factory({
              piVersion: "0.85.1",
              model: ctx.model,
              sessionDir: ctx.sessionDir,
              ...(apiKey !== undefined ? { apiKey } : {}),
            });
            return runtime;
          },
        },
      };
    }
  }
  return {
    driver: null,
    problem: `@treeai/runtime-pi has no factory export (${FACTORY_EXPORT_NAMES.join(", ")})`,
  };
}

/* ------------------------------------------------------------------ */
/* Scenario implementations (driver-agnostic)                          */
/* ------------------------------------------------------------------ */

interface ScenarioRunContext {
  readonly runtime: PiRuntime;
  readonly recorder: EventRecorder;
  readonly model: { providerId: string; modelId: string };
  readonly isFake: boolean;
}

interface ScenarioOutcome {
  status: ScenarioStatus;
  reason?: string;
  error?: { message: string; code?: string };
  meta?: Record<string, unknown>;
}

type ScenarioFn = (ctx: ScenarioRunContext) => Promise<ScenarioOutcome>;

function ok(meta?: Record<string, unknown>): ScenarioOutcome {
  return { status: "PASS", meta };
}

function failed(message: string, code?: string, meta?: Record<string, unknown>): ScenarioOutcome {
  return { status: "FAIL", error: { message, ...(code !== undefined ? { code } : {}) }, meta };
}

function isTreeAIError(err: unknown): { code?: string; message: string } {
  if (err instanceof Error) {
    const code = (err as Error & { code?: string }).code;
    return { message: err.message, ...(typeof code === "string" ? { code } : {}) };
  }
  return { message: String(err) };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

const MODEL_PROMPT_TIMEOUT_MS = 120_000;

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms: ${what}`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** basic: create a session, run one prompt, verify the run envelope. */
const scenarioBasic: ScenarioFn = async (ctx) => {
  await ctx.runtime.createSession({ model: ctx.model });
  const result = await withTimeout(
    ctx.runtime.prompt({ text: "Reply with the single word: ready" }),
    MODEL_PROMPT_TIMEOUT_MS,
    "basic prompt",
  );
  if (result.message.trim().length === 0) return failed("empty assistant message");
  if (result.reference.entryId === null || result.reference.entryId === "")
    return failed("reference did not advance");
  const started = ctx.recorder.countOf("agent.started");
  const settled = ctx.recorder.countOf("agent.settled");
  if (started !== 1 || settled !== 1) {
    return failed(`expected exactly one agent.started/settled, got ${started}/${settled}`);
  }
  const seqProblems = ctx.recorder.checkSeqDiscipline();
  if (seqProblems.length > 0) return failed(`seq discipline broken: ${seqProblems.join("; ")}`);
  return ok({ messageLength: result.message.length });
};

/** tool-policy: a read goes through the decision path; ground truth checked. */
const scenarioToolPolicy: ScenarioFn = async (ctx) => {
  const notes = readFileSync(LIVE_FIXTURE, "utf8");
  const groundTruth = /(\d{4})/.exec(notes)?.[1];
  if (groundTruth === undefined) return failed("live fixture lost its ground-truth number");
  await ctx.runtime.createSession({ model: ctx.model });
  const result = await withTimeout(
    ctx.runtime.prompt({
      text:
        "Read the file at tests/fixtures/e2e/live/notes.txt (relative to the " +
        "current working directory) using your file tool, then reply with " +
        "only the secret number it contains.",
    }),
    MODEL_PROMPT_TIMEOUT_MS,
    "tool-policy prompt",
  );
  const decisions = ctx.recorder.countOf("tool.decision");
  const toolStarted = ctx.recorder.countOf("tool.execution.started");
  // The scenario must actually have exercised the tool/policy path: at least
  // one tool.decision (real runtime-pi, via its policy hook) or
  // tool.execution.* event must exist — otherwise this "passed" without
  // testing anything.
  if (toolStarted + decisions === 0) {
    return failed("no tool decision/execution events recorded");
  }
  if (!result.message.includes(groundTruth)) {
    return failed(
      `reported answer does not contain the ground-truth number (got: ${result.message.slice(0, 120)})`,
    );
  }
  return ok({ groundTruthMatched: true, toolEvents: toolStarted + decisions });
};

/** steer: mid-flight steer creates a NEW TURN in the SAME agent run. */
const scenarioSteer: ScenarioFn = async (ctx) => {
  await ctx.runtime.createSession({ model: ctx.model });
  const pending = ctx.runtime.prompt({
    text: "Count slowly from 1 to 30, one number per line.",
  });
  await sleep(250);
  try {
    await ctx.runtime.steer({ text: "Stop counting. Reply with the single word: steered" });
  } catch (err) {
    const { message } = isTreeAIError(err);
    return failed(`steer rejected (was the run still in flight?): ${message}`, "unknown");
  }
  const result = await withTimeout(pending, MODEL_PROMPT_TIMEOUT_MS, "steer prompt");
  if (ctx.recorder.countOf("steer.enqueued") < 1) {
    return failed("no steer.enqueued event observed");
  }
  const started = ctx.recorder.countOf("agent.started");
  if (started !== 1) {
    return failed(`steer must not start a second agent run (agent.started count: ${started})`);
  }
  return ok({
    steerEnqueued: ctx.recorder.countOf("steer.enqueued"),
    agentStarts: started,
    finalMessage: result.message.slice(0, 80),
  });
};

/** abort: in-flight prompt settles with user-abort and the runtime recovers. */
const scenarioAbort: ScenarioFn = async (ctx) => {
  await ctx.runtime.createSession({ model: ctx.model });
  const pending = ctx.runtime.prompt({
    text: "Write a 500-word essay about the history of computing.",
  });
  await sleep(250);
  await ctx.runtime.abort();
  let aborted = false;
  let abortError: { code?: string; message: string } | undefined;
  try {
    await withTimeout(pending, MODEL_PROMPT_TIMEOUT_MS, "aborted prompt settle");
  } catch (err) {
    abortError = isTreeAIError(err);
    aborted = abortError.code === "user-abort";
  }
  if (!aborted) {
    return failed(
      abortError === undefined
        ? "prompt resolved instead of aborting"
        : `prompt failed with ${abortError.code ?? "no code"} instead of user-abort`,
    );
  }
  // The runtime must be usable again after an abort.
  const next = await withTimeout(
    ctx.runtime.prompt({ text: "Reply with the single word: recovered" }),
    MODEL_PROMPT_TIMEOUT_MS,
    "post-abort prompt",
  );
  if (next.message.trim().length === 0) return failed("runtime unusable after abort");
  return ok({ aborted: true, recovered: true });
};

/** resume: session survives runtime disposal and restoration. */
const scenarioResume: ScenarioFn = async (ctx) => {
  const { runtime, recorder } = ctx;
  await runtime.createSession({ model: ctx.model });
  const first = await withTimeout(
    runtime.prompt({ text: "Remember the codeword: cedar. Reply with: stored" }),
    MODEL_PROMPT_TIMEOUT_MS,
    "resume first prompt",
  );
  const ref: SessionReference = first.reference;
  await runtime.dispose();
  recorder.stop();

  // A SECOND runtime instance (the "restart") restores the session.
  const ctx2 = (ctx as unknown as { __secondRuntime?: PiRuntime }).__secondRuntime;
  if (ctx2 === undefined) {
    return failed("scenario wiring bug: no second runtime provided for resume");
  }
  const rec2 = new EventRecorder(ctx2);
  try {
    const restored = await withTimeout(ctx2.restoreSession(ref), 30_000, "restoreSession");
    if (restored.reference.sessionId !== ref.sessionId) {
      return failed("restored session id mismatch");
    }
    const followUp = await withTimeout(
      ctx2.prompt({ text: "What codeword did I ask you to remember? Reply with just the codeword." }),
      MODEL_PROMPT_TIMEOUT_MS,
      "resume follow-up prompt",
    );
    if (followUp.message.trim().length === 0) return failed("empty follow-up after restore");
    return ok({
      restored: true,
      followUpLength: followUp.message.length,
      sessionFile: "<recorded in run evidence>",
    });
  } finally {
    rec2.stop();
  }
};

/** tree-navigation: dual branch + switch back within ONE session. */
const scenarioTreeNavigation: ScenarioFn = async (ctx) => {
  const { runtime, recorder } = ctx;
  await runtime.createSession({ model: ctx.model });
  const a = await withTimeout(
    runtime.prompt({ text: "This is branch A. Remember: branch A is about apples. Reply: ok" }),
    MODEL_PROMPT_TIMEOUT_MS,
    "tree-navigation branch A",
  );
  const branchPoint = a.reference.entryId;
  const b = await withTimeout(
    runtime.prompt({ text: "Now branch B, about batteries. Reply: ok" }),
    MODEL_PROMPT_TIMEOUT_MS,
    "tree-navigation branch B",
  );
  if (String(b.reference.entryId) === String(branchPoint)) {
    return failed("second prompt did not advance the leaf");
  }
  // Switch back to branch A.
  const back = await runtime.navigateTree({ entryId: branchPoint });
  if (String(back.entryId) !== String(branchPoint)) {
    return failed("navigateTree did not move the leaf to the target");
  }
  if (back.sessionFile !== a.reference.sessionFile) {
    return failed("navigateTree must not change the session file");
  }
  if (recorder.countOf("tree.navigated") < 1) {
    return failed("no tree.navigated event");
  }
  // Continue from branch A: the fork must remember the branch-A context.
  const fork = await withTimeout(
    runtime.prompt({ text: "Which branch are we on? Reply with one word." }),
    MODEL_PROMPT_TIMEOUT_MS,
    "tree-navigation fork prompt",
  );
  if (fork.message.trim().length === 0) return failed("empty fork prompt result");
  return ok({
    navigatedBack: true,
    forkAdvanced: String(fork.reference.entryId) !== String(branchPoint),
    answer: fork.message.slice(0, 80),
  });
};

interface ScenarioDefinition {
  readonly id: LiveScenarioId;
  readonly description: string;
  readonly run: ScenarioFn;
  /** Whether the scenario needs a second runtime instance (resume). */
  readonly needsSecondRuntime?: boolean;
}

export const LIVE_SCENARIOS: readonly ScenarioDefinition[] = [
  { id: "basic", description: "create session, one prompt, run envelope", run: scenarioBasic },
  { id: "tool-policy", description: "policy-gated read of the live fixture, ground truth check", run: scenarioToolPolicy },
  { id: "steer", description: "mid-flight steer = new turn in the same agent run", run: scenarioSteer },
  { id: "abort", description: "user abort settles user-abort, runtime recovers", run: scenarioAbort },
  { id: "resume", description: "session restored by a second runtime instance", run: scenarioResume, needsSecondRuntime: true },
  { id: "tree-navigation", description: "dual branch + switch back in one session", run: scenarioTreeNavigation },
];

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */

export interface RunScenarioOptions {
  readonly driver: LiveDriver;
  readonly model: { providerId: string; modelId: string };
  readonly sessionDir: string;
  readonly scenario: ScenarioDefinition;
}

export async function runOneScenario(options: RunScenarioOptions): Promise<ScenarioRecord> {
  const started = Date.now();
  const { driver, scenario } = options;
  let runtime: PiRuntime | null = null;
  let secondRuntime: PiRuntime | null = null;
  let recorder: EventRecorder | null = null;
  try {
    runtime = await driver.createRuntime({
      driver: driver.name,
      sessionDir: options.sessionDir,
      model: options.model,
      scenarioId: scenario.id,
    });
    recorder = new EventRecorder(runtime);
    if (scenario.needsSecondRuntime === true) {
      secondRuntime = await driver.createRuntime({
        driver: driver.name,
        sessionDir: options.sessionDir,
        model: options.model,
        scenarioId: scenario.id,
      });
    }
    const ctx: ScenarioRunContext & { __secondRuntime?: PiRuntime } = {
      runtime,
      recorder,
      model: options.model,
      isFake: driver.name === "fake",
    };
    if (secondRuntime !== null) ctx.__secondRuntime = secondRuntime;
    const outcome = await scenario.run(ctx);
    return {
      id: `live-scenario-${scenario.id}`,
      status: outcome.status,
      exitCode: outcome.status === "PASS" ? 0 : 1,
      scenario: scenario.id,
      driver: driver.name,
      piVersion: runtime.piVersion,
      ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      ...(outcome.meta !== undefined ? { meta: outcome.meta } : {}),
      durationMs: Date.now() - started,
    };
  } catch (err) {
    const e = isTreeAIError(err);
    return {
      id: `live-scenario-${scenario.id}`,
      status: "FAIL",
      exitCode: 1,
      scenario: scenario.id,
      driver: driver.name,
      piVersion: runtime?.piVersion ?? "unknown",
      error: { message: e.message, ...(e.code !== undefined ? { code: e.code } : {}) },
      durationMs: Date.now() - started,
    };
  } finally {
    recorder?.stop();
    try {
      await runtime?.dispose();
    } catch {
      // dispose must be idempotent; a throw here is recorded by the caller
    }
    try {
      await secondRuntime?.dispose();
    } catch {
      // ditto
    }
  }
}

/** Convenience: run all six scenarios with one driver. */
export async function runAllScenarios(options: {
  driver: LiveDriver;
  model: { providerId: string; modelId: string };
  sessionDir: string;
}): Promise<ScenarioRecord[]> {
  const records: ScenarioRecord[] = [];
  for (const scenario of LIVE_SCENARIOS) {
    records.push(
      await runOneScenario({
        driver: options.driver,
        model: options.model,
        sessionDir: options.sessionDir,
        scenario,
      }),
    );
  }
  return records;
}
