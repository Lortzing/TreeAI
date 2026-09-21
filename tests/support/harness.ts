/**
 * E2E harness for D2 test scenarios (Agent F).
 *
 * TEST INFRASTRUCTURE, NOT PRODUCTION CODE. The production modules
 * (persistence, event-journal, tool-policy, runtime-pi) are delivered by the
 * Wave-1 agents; this harness exists so the e2e fixtures can be exercised
 * offline today and so the live scenario framework has a `fake` driver with
 * identical observable behavior. The pieces below deliberately re-declare the
 * frozen contract semantics (with `satisfies` checks against the type-only
 * contracts package) instead of importing production behavior.
 *
 * Components:
 *   - RunRegistry: RunState machine with I1–I7 enforcement (run-state.ts)
 *   - Journal: per-runId strictly increasing seq + duplicate detection +
 *     RunState projection with illegal-transition rejection (events.ts I7)
 *   - FakeToolPolicy: ToolDecision defaults — default-deny, read-under-roots
 *     allow, write-in-workspace require-approval, shell/network deny
 *     (tool-decision.ts invariants; application-layer policy, NOT a sandbox)
 *   - EventRecorder: PiRuntimeEvent collection with seq assertion across
 *     session replacement
 */

import type {
  JsonRecord,
  PiRuntime,
  PiRuntimeEvent,
  RunId,
  RunState,
  RunStateTransitions,
  ToolActionCategory,
  ToolDecision,
  TreeAIEvent,
} from "@treeai/contracts";

/* ------------------------------------------------------------------ */
/* RunRegistry — I1..I7                                                */
/* ------------------------------------------------------------------ */

/**
 * The frozen transition table, re-declared as data (the contracts package is
 * type-only). `satisfies` fails compilation if this drifts from the contract.
 */
export const TRANSITIONS = {
  queued: ["running", "failed"],
  running: ["aborting", "succeeded", "failed"],
  aborting: ["aborted", "failed"],
  succeeded: [],
  failed: [],
  aborted: [],
} as const satisfies RunStateTransitions;

export const TERMINAL_STATES: readonly RunState[] = ["succeeded", "failed", "aborted"];

export interface RunRecord {
  readonly id: RunId;
  state: RunState;
  readonly createdAt: string;
  /** Set once the run enters a terminal state (I3: at most one). */
  terminal: RunState | null;
  terminalError?: { code: string; message: string; details?: Record<string, unknown> };
  /** Every attempted transition, for audit. */
  readonly history: Array<{ from: RunState; to: RunState; at: string; legal: boolean }>;
}

export class IllegalTransitionError extends Error {
  readonly from: RunState;
  readonly to: RunState;
  readonly runId: string;
  constructor(from: RunState, to: RunState, runId: string) {
    super(`illegal run-state transition ${from} -> ${to} (run ${runId})`);
    this.name = "IllegalTransitionError";
    this.from = from;
    this.to = to;
    this.runId = runId;
  }
}

export class RunRegistry {
  private readonly runs = new Map<string, RunRecord>();

  createRun(runId: RunId | string): RunRecord {
    if (this.runs.has(runId)) throw new Error(`duplicate run id ${runId}`);
    const rec: RunRecord = {
      id: runId as RunId,
      state: "queued", // I1
      createdAt: new Date().toISOString(),
      terminal: null,
      history: [],
    };
    this.runs.set(runId, rec);
    return rec;
  }

  get(runId: RunId | string): RunRecord | undefined {
    return this.runs.get(runId);
  }

  allRuns(): readonly RunRecord[] {
    return [...this.runs.values()];
  }

  /**
   * Apply a transition. Enforces:
   *   I2/I5 — target must be in TRANSITIONS[from] (no leaving terminals, no
   *            going backwards, no skipping states);
   *   I3    — a run that already has a terminal cannot enter another;
   *   I7    — everything outside the table throws.
   */
  transition(runId: RunId | string, to: RunState, error?: RunRecord["terminalError"]): RunRecord {
    const rec = this.runs.get(runId);
    if (rec === undefined) throw new Error(`unknown run ${runId}`);
    const from = rec.state;
    const legal = (TRANSITIONS[from] as readonly RunState[]).includes(to);
    rec.history.push({ from, to, at: new Date().toISOString(), legal });
    if (!legal) {
      throw new IllegalTransitionError(from, to, runId);
    }
    if (rec.terminal !== null) {
      // I3 single-terminal: already absorbed; reaching here means a second
      // terminal was attempted even though the table forbids it.
      throw new IllegalTransitionError(rec.terminal, to, runId);
    }
    rec.state = to;
    if (TERMINAL_STATES.includes(to)) {
      rec.terminal = to;
      if (error !== undefined) rec.terminalError = error;
    }
    return rec;
  }

  /**
   * I6 restart recovery sweep. Mode:
   *   - "host-crash": non-terminal runs -> failed (code unknown,
   *     details.hostInterrupted true)
   *   - "dispose": in-flight runs -> aborted (code user-abort) via the LEGAL
   *     path running -> aborting -> aborted (the table forbids running ->
   *     aborted directly); queued runs never started, so they converge via
   *     the only legal edge queued -> failed.
   * Returns the recovered runs for assertions.
   */
  recoverNonTerminal(mode: "host-crash" | "dispose"): RunRecord[] {
    const recovered: RunRecord[] = [];
    for (const rec of this.runs.values()) {
      if (rec.terminal !== null) continue;
      if (mode === "host-crash") {
        this.transition(
          rec.id,
          "failed",
          {
            code: "unknown",
            message: "host process exited before the run settled; recovered by restart sweep",
            details: { hostInterrupted: true },
          },
        );
      } else if (rec.state === "running" || rec.state === "aborting") {
        if (rec.state === "running") {
          this.transition(rec.id, "aborting");
        }
        this.transition(
          rec.id,
          "aborted",
          { code: "user-abort", message: "host disposed while the run was in flight" },
        );
      } else {
        this.transition(
          rec.id,
          "failed",
          { code: "user-abort", message: "host disposed before the queued run started" },
        );
      }
      recovered.push(rec);
    }
    return recovered;
  }
}

/* ------------------------------------------------------------------ */
/* Journal — strict seq + projection                                   */
/* ------------------------------------------------------------------ */

export class DuplicateEventError extends Error {
  readonly runId: string;
  readonly seq: number;
  constructor(runId: string, seq: number) {
    super(`duplicate (runId, seq) pair: ${runId}#${seq}`);
    this.name = "DuplicateEventError";
    this.runId = runId;
    this.seq = seq;
  }
}

export class Journal {
  private readonly byRun = new Map<string, TreeAIEvent[]>();
  private readonly seen = new Set<string>();
  private counter = 0;

  append(
    runId: RunId | string,
    type: string,
    payload: JsonRecord,
    evidence: TreeAIEvent["evidence"] = [],
  ): TreeAIEvent {
    const key = String(runId);
    const events = this.byRun.get(key) ?? [];
    const lastSeq = events.length > 0 ? events[events.length - 1]!.seq : 0;
    const seq = lastSeq + 1;
    const dedupeKey = `${key}#${seq}`;
    if (this.seen.has(dedupeKey)) throw new DuplicateEventError(key, seq);
    this.seen.add(dedupeKey);
    this.counter += 1;
    const event: TreeAIEvent = {
      eventId: `${key}-e${this.counter}` as TreeAIEvent["eventId"],
      runId: runId as RunId,
      seq,
      occurredAt: new Date().toISOString(),
      type,
      payload,
      evidence,
    };
    events.push(event);
    this.byRun.set(key, events);
    return event;
  }

  eventsOf(runId: RunId | string): readonly TreeAIEvent[] {
    return this.byRun.get(String(runId)) ?? [];
  }

  allEvents(): TreeAIEvent[] {
    const out: TreeAIEvent[] = [];
    for (const events of this.byRun.values()) out.push(...events);
    out.sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : a.seq - b.seq));
    return out;
  }

  /**
   * Projection: replay run.state-changed events onto a fresh RunRegistry.
   * Illegal transitions in the stream are rejected with an audit record
   * (contract I7) instead of being silently applied.
   */
  projectRunStates(): { registry: RunRegistry; rejected: Array<{ runId: string; from: string; to: string }> } {
    const registry = new RunRegistry();
    const rejected: Array<{ runId: string; from: string; to: string }> = [];
    const created = new Set<string>();
    for (const evt of this.allEvents()) {
      if (evt.type !== "run.state-changed") continue;
      const runId = String(evt.runId);
      if (!created.has(runId)) {
        registry.createRun(evt.runId);
        created.add(runId);
      }
      const rec = registry.get(runId);
      if (rec === undefined) continue;
      const to = (evt.payload as Record<string, unknown>)["state"] as RunState | undefined;
      if (to === undefined) continue;
      const from = rec.state;
      if (!(TRANSITIONS[from] as readonly RunState[]).includes(to)) {
        rejected.push({ runId, from, to });
        continue;
      }
      try {
        registry.transition(runId, to);
      } catch {
        rejected.push({ runId, from, to });
      }
    }
    return { registry, rejected };
  }
}

/* ------------------------------------------------------------------ */
/* FakeToolPolicy — ToolDecision defaults (application layer only)     */
/* ------------------------------------------------------------------ */

/**
 * D2 test policy. SECURITY NOTE (frozen contract wording): ToolPolicy is an
 * application-layer policy, NOT an OS sandbox and NOT a security boundary;
 * any README/report must not describe it as one.
 */
export interface FakePolicyConfig {
  readonly readRoots: readonly string[];
  readonly workspaceRoot: string;
}

function normalizePath(p: string): string {
  // Lexical normalization sufficient for the fixture tree (resolve .., dup slashes).
  const abs = p.startsWith("/") ? p : `${process.cwd()}/${p}`;
  const parts = abs.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return `/${out.join("/")}`;
}

export function isUnder(path: string, root: string): boolean {
  const nPath = normalizePath(path);
  const nRoot = normalizePath(root).replace(/\/+$/, "");
  return nPath === nRoot || nPath.startsWith(`${nRoot}/`);
}

export class FakeToolPolicy {
  readonly config: FakePolicyConfig;

  constructor(config: FakePolicyConfig) {
    this.config = config;
  }

  decide(category: ToolActionCategory, targetPath?: string): ToolDecision {
    switch (category) {
      case "read": {
        if (targetPath === undefined) {
          return this.deny(category, "read without a target path");
        }
        for (const root of this.config.readRoots) {
          if (isUnder(targetPath, root)) {
            return {
              outcome: "allow",
              category,
              risk: "low",
              reason: `read under configured root ${normalizePath(root)}`,
              ruleId: "read-roots",
              scope: { roots: [normalizePath(root)] },
            };
          }
        }
        return this.deny(category, `read outside configured roots: ${normalizePath(targetPath)}`);
      }
      case "write": {
        if (targetPath === undefined) {
          return this.deny(category, "write without a target path");
        }
        if (isUnder(targetPath, this.config.workspaceRoot)) {
          return {
            outcome: "require-approval",
            category,
            risk: "medium",
            reason: `write inside workspace ${normalizePath(this.config.workspaceRoot)} requires user approval`,
            ruleId: "workspace-write",
            scope: { roots: [normalizePath(this.config.workspaceRoot)] },
          };
        }
        return this.deny(category, `write outside workspace: ${normalizePath(targetPath)}`);
      }
      case "shell":
        return this.deny(category, "shell commands are denied by default (no allow rule configured)");
      case "network":
        return this.deny(category, "network access is denied by default (no allow rule configured)");
      case "other-high-risk":
        return this.deny(category, "unclassified high-risk operations are denied by default");
    }
  }

  private deny(category: ToolActionCategory, reason: string): ToolDecision {
    return {
      outcome: "deny",
      category,
      risk: "high",
      reason,
      ruleId: null,
      scope: { roots: [] },
    };
  }
}

/* ------------------------------------------------------------------ */
/* EventRecorder — PiRuntimeEvent stream assertions                    */
/* ------------------------------------------------------------------ */

export class EventRecorder {
  readonly events: PiRuntimeEvent[] = [];
  private readonly unsubscribe: () => void;

  constructor(runtime: PiRuntime) {
    this.unsubscribe = runtime.subscribe((event) => {
      this.events.push(event);
    });
  }

  /** seq must strictly increase across the whole runtime instance lifetime. */
  checkSeqDiscipline(): string[] {
    const problems: string[] = [];
    for (let i = 1; i < this.events.length; i++) {
      const prev = this.events[i - 1]!;
      const cur = this.events[i]!;
      if (cur.seq <= prev.seq) {
        problems.push(`seq ${cur.seq} (event ${cur.eventId}) not greater than ${prev.seq}`);
      }
    }
    return problems;
  }

  kinds(): string[] {
    return this.events.map((e) => e.kind);
  }

  countOf(kind: string): number {
    return this.events.filter((e) => e.kind === kind).length;
  }

  firstOf(kind: string): PiRuntimeEvent | undefined {
    return this.events.find((e) => e.kind === kind);
  }

  stop(): void {
    this.unsubscribe();
  }
}
