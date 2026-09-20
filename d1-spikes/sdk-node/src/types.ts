/**
 * TreeAI D1 spike - shared types for the sdk-node probe.
 *
 * Field names follow the D1 task book section 6 (unified evidence format).
 * This is a spike: types are local to this probe and are NOT a TreeAI
 * domain model (no Forest/Tree/Branch/Episode/Run, no RuntimeAdapter).
 */

export const IMPLEMENTATION = "sdk-node" as const;

export const SCENARIOS = ["basic", "tool", "steer", "abort", "resume"] as const;
export type ScenarioName = (typeof SCENARIOS)[number];

/**
 * Additional architecture probe (owner closure follow-up, 2026-09-20):
 * idle-state in-place tree navigation via AgentSession.navigateTree().
 *
 * Deliberately NOT part of SCENARIOS: `npm run probe:all` and the five
 * unified D1 scenario results never include it, and its evidence is written
 * under evidence/sdk/tree-nav/ instead of evidence/sdk/runs/ so it can never
 * mix into the five-scenario results (or their verification).
 */
export const TREE_NAV_SCENARIO = "tree-nav" as const;
export type TreeNavScenarioName = typeof TREE_NAV_SCENARIO;

/** Any scenario name this probe can record (five unified + tree-nav). */
export type ProbeScenarioName = ScenarioName | TreeNavScenarioName;
export const PROBE_SCENARIO_NAMES: readonly ProbeScenarioName[] = [...SCENARIOS, TREE_NAV_SCENARIO];

export const RESULT_STATUSES = ["PASS", "FAIL", "BLOCKED", "NOT_RUN"] as const;
export type ResultStatus = (typeof RESULT_STATUSES)[number];

/** Blocked reasons distinguish why a real run could not complete. */
export const BLOCKED_REASONS = [
  "BLOCKED_CREDENTIALS",
  "BLOCKED_SDK",
  "BLOCKED_MODEL",
  "BLOCKED_FIXTURE",
] as const;
export type BlockedReason = (typeof BLOCKED_REASONS)[number];

/** Exit code contract: any failure/block must produce a non-zero exit. */
export const EXIT_CODES: Record<ResultStatus, number> = {
  PASS: 0,
  FAIL: 1,
  BLOCKED: 2,
  NOT_RUN: 3,
};

/** One line of the raw event JSONL (task book 6.1). */
export interface EvidenceEvent {
  seq: number;
  observedAt: string;
  implementation: typeof IMPLEMENTATION;
  scenario: ProbeScenarioName;
  sessionId: string;
  piEventType: string;
  runState: string;
  payload: unknown;
  redactionVersion: string;
  /** Optional. Only set by the resume scenario to mark child-process phase. */
  probePhase?: string;
  /** Optional. Set when payload size was capped. */
  payloadTruncated?: boolean;
}

/** Structured error attached to events and results. */
export interface StructuredError {
  name: string;
  message: string;
  blockedReason?: BlockedReason;
  stack?: string;
}

/** Scenario result JSON (task book 6.2). */
export interface ScenarioResult {
  implementation: typeof IMPLEMENTATION;
  scenario: ProbeScenarioName;
  status: ResultStatus;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  command: string;
  exitCode: number;
  evidenceFiles: string[];
  observations: string[];
  limitations: string[];
  error: StructuredError | null;
  /** Extra fields beyond the task book minimum (allowed: "at least"). */
  blockedReason?: BlockedReason;
  failedChecks?: string[];
  environment?: Record<string, unknown>;
}

/** Minimal structural session interface the scenarios depend on. */
export interface ProbeSessionLike {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  readonly isStreaming: boolean;
  subscribe(listener: (event: Record<string, unknown>) => void): () => void;
  prompt(text: string, opts?: { streamingBehavior?: "steer" | "followUp" }): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  /**
   * In-place tree navigation within the same session (Pi
   * AgentSession.navigateTree). Idle-state only: implementations must
   * reject while streaming, mirroring Pi 0.85.1. The probe never passes
   * summarize options (that would trigger an extra model call).
   */
  navigateTree(targetId: string): Promise<{ cancelled: boolean; editorText?: string }>;
  /**
   * Read-only tree state (ids/structure only, no message content) for the
   * tree-nav scenario: entry ids/parentId/type/role, the current leaf id,
   * and the LLM context size on the current branch.
   */
  getTreeState(): ProbeTreeState;
  /**
   * History summary for resume checks. Reads message/entry state the
   * implementation exposes; must not fabricate content.
   */
  getHistorySummary(): {
    entries: number;
    userMessages: number;
    assistantMessages: number;
    lastAssistantText: string | undefined;
  };
}

/** One session entry as seen by the tree-nav probe (structure only). */
export interface ProbeTreeEntryInfo {
  id: string;
  parentId: string | null;
  type: string;
  /** Message role when type === "message". */
  role?: string;
}

/** Tree state snapshot (tree-nav scenario checks; ids only, no content). */
export interface ProbeTreeState {
  sessionId: string;
  leafId: string | null;
  entries: ProbeTreeEntryInfo[];
  /** LLM context size on the current branch (root -> leaf). */
  contextMessageCount: number;
}

export type ToolsMode = "none" | "read-only";

export interface CreateProbeSessionOptions {
  /** Working directory for the session (temp copy of fixtures). */
  cwd: string;
  /** Persist session to disk (resume scenario) vs in-memory. */
  persist: boolean;
  /** Directory for persisted session files. Required when persist=true. */
  sessionDir?: string;
  /**
   * Open an existing session file instead of creating a new one (resume
   * phase B). Takes precedence over sessionDir.
   */
  openSessionFile?: string;
  tools: ToolsMode;
}

export interface ProbeSessionFactory {
  create(options: CreateProbeSessionOptions): Promise<ProbeSessionLike>;
}

export interface ResumeChildRunner {
  /** Phase A: fresh process, persistent session, first prompt, exit. */
  phaseA(opts: {
    cwd: string;
    sessionDir: string;
    eventsDir: string;
    prompt: string;
  }): Promise<{ exitCode: number; sessionFile?: string; sessionId?: string; blockedReason?: BlockedReason }>;
  /** Phase B: fresh process, open session file, read history, second prompt, exit. */
  phaseB(opts: {
    cwd: string;
    sessionFile: string;
    eventsDir: string;
    prompt: string;
  }): Promise<{
    exitCode: number;
    sessionId?: string;
    blockedReason?: BlockedReason;
    history?: {
      entries: number;
      userMessages: number;
      assistantMessages: number;
      lastAssistantText: string | undefined;
    };
    answer?: string;
  }>;
}
