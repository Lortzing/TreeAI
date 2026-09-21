/**
 * FakePiRuntime — Agent F's offline test double for the frozen `PiRuntime`
 * contract (packages/contracts/src/pi-runtime.ts, CONTRACT-FREEZE-1 item 1).
 *
 * TEST INFRASTRUCTURE, NOT PRODUCTION CODE. It exists so the D2 test suites,
 * fixtures and the live-scenario framework can be exercised with zero
 * dependency on a real model, real credentials, the user's real Pi
 * configuration (~/.pi) or a real Pi session file. It deliberately does NOT
 * reimplement Agent B's runtime-pi package; when the real package lands, the
 * suites in tests/integration that target the real modules activate
 * separately (see tests/integration/real-modules.test.ts).
 *
 * Semantics faithfully mirrored from the frozen contract (and from the D1
 * Pi 0.85.1 observations recorded in d1-verification.md §4):
 *   - single active session; create/restore replace it and emit
 *     session.replaced first, then session.created / session.restored;
 *     subscriptions survive replacement;
 *   - event seq strictly increases per runtime instance across session
 *     replacement (never resets);
 *   - prompt = one agent run: agent.started once; steer during streaming
 *     enqueues and starts a NEW TURN in the SAME agent run (single
 *     agent.started — Pi 0.85.1 semantics); agent.settled after all turns;
 *   - abort: idempotent, silent no-op without an in-flight run; the pending
 *     prompt settles with TreeAIError code "user-abort";
 *   - navigateTree: only while not streaming; same session, same session
 *     file, append-only tree (entries never removed), context rebuilt along
 *     the root→target path;
 *   - dispose: idempotent; in-flight prompt settles with "user-abort"; no
 *     events afterwards; any method except dispose is a caller contract
 *     violation (TypeError);
 *   - caller contract violations throw platform standard errors (TypeError),
 *     not TreeAIError;
 *   - the fake's session files use a dedicated fixture format
 *     (.treeai-fake-session.jsonl) — they are NOT Pi session files and are
 *     never read or written by any Pi code.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type {
  EventId,
  PiEntryId,
  PiModelSelector,
  PiNavigateTreeTarget,
  PiPromptInput,
  PiPromptResult,
  PiRuntime,
  PiRuntimeEvent,
  PiRuntimeEventListener,
  PiSessionId,
  PiSessionInit,
  PiSessionSnapshot,
  PiSteerInput,
  PiUnsubscribe,
  PiVersion,
  SessionReference,
} from "@treeai/contracts";

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/** Runtime-failure shape of the frozen TreeAIError contract. */
export class TreeAIErrorShape extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "TreeAIError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/* ------------------------------------------------------------------ */
/* Scripting (failure / tool injection for scenarios)                  */
/* ------------------------------------------------------------------ */

export interface FakeToolRequest {
  readonly tool: string;
  readonly path: string;
  readonly action: "read" | "write" | "shell" | "network" | "other-high-risk";
}

export interface FakeToolDecision {
  readonly outcome: "allow" | "deny" | "require-approval";
  readonly reason: string;
}

export type FakePromptScript =
  | {
      readonly kind: "ok";
      /** Assistant text per turn (steer consumes the next element). */
      readonly turns: readonly string[];
      readonly toolRequest?: FakeToolRequest;
    }
  | {
      readonly kind: "fail";
      readonly code: string;
      readonly message: string;
    };

export interface FakeRuntimeOptions {
  readonly sessionDir?: string;
  readonly model?: PiModelSelector;
  readonly turnDelayMs?: number;
  /** Consumed FIFO, one entry per prompt() call. Unscripted prompts use a default ok turn. */
  readonly script?: readonly FakePromptScript[];
  /** Policy hook for tool requests; returning deny makes the prompt fail with policy-denied. */
  readonly decideTool?: (request: FakeToolRequest) => FakeToolDecision;
  /** Simulated Pi version drift (must equal PinnedPiVersion in production). */
  readonly versionDrift?: string;
  /** Default true: persist session files; false for pure in-memory use. */
  readonly persist?: boolean;
}

/* ------------------------------------------------------------------ */
/* Session store (fixture format, NOT a Pi session file)               */
/* ------------------------------------------------------------------ */

interface FakeEntry {
  readonly id: string;
  readonly kind: "user" | "assistant";
  readonly text: string;
  readonly parent: string | null;
  readonly createdAt: string;
}

interface FakeSession {
  sessionId: string;
  sessionFile: string;
  piVersion: string;
  model: PiModelSelector;
  entries: FakeEntry[];
  leafEntryId: string;
}

function isoNow(): string {
  return new Date().toISOString();
}

/* ------------------------------------------------------------------ */
/* The fake runtime                                                    */
/* ------------------------------------------------------------------ */

interface InFlight {
  resolve: (result: PiPromptResult) => void;
  reject: (err: unknown) => void;
  steerQueue: string[];
  timers: NodeJS.Timeout[];
  cancelled: boolean;
  settled: boolean;
}

export class FakePiRuntime implements PiRuntime {
  readonly piVersion: PiVersion;
  private readonly options: FakeRuntimeOptions;
  private readonly listeners = new Set<PiRuntimeEventListener>();
  private session: FakeSession | null = null;
  private eventSeq = 0;
  private entryCounter = 0;
  private scriptIndex = 0;
  private inFlight: InFlight | null = null;
  private disposed = false;
  private ownsSessionDir = false;
  private sessionDir: string;
  private sessionCounter = 0;

  constructor(options: FakeRuntimeOptions = {}) {
    this.options = options;
    this.piVersion = (options.versionDrift ?? "0.85.1") as PiVersion;
    if (options.sessionDir !== undefined) {
      this.sessionDir = options.sessionDir;
    } else {
      this.sessionDir = join(
        tmpdir(),
        `treeai-d2-fake.${Date.now()}.${process.pid}.${Math.floor(Math.random() * 1e6)}`,
      );
      this.ownsSessionDir = true;
    }
    mkdirSync(this.sessionDir, { recursive: true });
  }

  /* -------------------- introspection (tests only) ----------------- */

  get isStreaming(): boolean {
    return this.inFlight !== null;
  }

  get activeSessionId(): string | null {
    return this.session?.sessionId ?? null;
  }

  get entryCount(): number {
    return this.session?.entries.length ?? 0;
  }

  get currentEntryId(): string | null {
    return this.session?.leafEntryId ?? null;
  }

  /** Entries along the root→entryId path: the rebuilt context. */
  contextOf(entryId: string): FakeEntry[] {
    if (this.session === null) return [];
    const byId = new Map(this.session.entries.map((e) => [e.id, e] as const));
    const path: FakeEntry[] = [];
    let cur = byId.get(entryId);
    while (cur !== undefined) {
      path.unshift(cur);
      cur = cur.parent !== null ? byId.get(cur.parent) : undefined;
    }
    return path;
  }

  snapshotEntries(): readonly FakeEntry[] {
    return this.session ? [...this.session.entries] : [];
  }

  /* -------------------- events ------------------------------------- */

  private emit(kind: string, payload: Record<string, unknown>): void {
    if (this.disposed) return;
    this.eventSeq += 1;
    const event: PiRuntimeEvent = {
      eventId: `fake-${this.eventSeq}` as EventId,
      seq: this.eventSeq,
      occurredAt: isoNow(),
      kind,
      payload: payload as PiRuntimeEvent["payload"],
    };
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A listener throwing must not break the runtime (test double policy).
      }
    }
  }

  subscribe(listener: PiRuntimeEventListener): PiUnsubscribe {
    this.assertLive("subscribe");
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /* -------------------- session lifecycle -------------------------- */

  private reference(): SessionReference {
    const s = this.session;
    if (s === null) throw new TypeError("no active session");
    return {
      sessionId: s.sessionId as PiSessionId,
      sessionFile: s.sessionFile,
      entryId: s.leafEntryId as PiEntryId,
      piVersion: s.piVersion as PiVersion,
      availability: { status: "available" },
    };
  }

  private persistSessionHeader(s: FakeSession): void {
    if (this.options.persist === false) return;
    writeFileSync(
      s.sessionFile,
      `${JSON.stringify({
        format: "treeai-fake-session",
        version: 1,
        sessionId: s.sessionId,
        piVersion: s.piVersion,
        model: s.model,
      })}\n`,
      "utf8",
    );
  }

  private persistEntry(s: FakeSession, e: FakeEntry): void {
    if (this.options.persist === false) return;
    appendFileSync(s.sessionFile, `${JSON.stringify(e)}\n`, "utf8");
  }

  private appendEntry(kind: "user" | "assistant", text: string): FakeEntry {
    const s = this.session;
    if (s === null) throw new TypeError("no active session");
    this.entryCounter += 1;
    const entry: FakeEntry = {
      id: `e${this.entryCounter}`,
      kind,
      text,
      parent: s.leafEntryId,
      createdAt: isoNow(),
    };
    s.entries.push(entry);
    s.leafEntryId = entry.id;
    this.persistEntry(s, entry);
    return entry;
  }

  private assertLive(method: string): void {
    if (this.disposed) {
      throw new TypeError(`PiRuntime.${method} called after dispose (caller contract violation)`);
    }
  }

  async createSession(init: PiSessionInit): Promise<PiSessionSnapshot> {
    this.assertLive("createSession");
    if (init.model.providerId.length === 0 || init.model.modelId.length === 0) {
      throw new TreeAIErrorShape("model-unavailable", "empty model selector");
    }
    const dir = init.sessionDir ?? this.sessionDir;
    mkdirSync(dir, { recursive: true });
    this.sessionCounter += 1;
    const sessionId = `fake-session-${this.sessionCounter}`;
    const sessionFile = join(dir, `${sessionId}.treeai-fake-session.jsonl`);
    if (this.session !== null) {
      this.emit("session.replaced", { previousSessionId: this.session.sessionId });
    }
    this.session = {
      sessionId,
      sessionFile,
      piVersion: this.piVersion,
      model: init.model,
      entries: [],
      leafEntryId: "e0",
    };
    // root pseudo-entry is implicit (leafEntryId "e0" = no entries yet)
    this.persistSessionHeader(this.session);
    this.emit("session.created", { sessionId, model: init.model, piVersion: this.piVersion });
    return { reference: this.reference() };
  }

  async restoreSession(ref: SessionReference): Promise<PiSessionSnapshot> {
    this.assertLive("restoreSession");
    if (!existsSync(ref.sessionFile)) {
      throw new TreeAIErrorShape("session-corrupt", "session file not found", {
        reason: "missing-file",
        sessionId: ref.sessionId,
      });
    }
    if (ref.piVersion !== this.piVersion) {
      throw new TreeAIErrorShape("session-corrupt", "session pi version mismatch", {
        reason: "version-mismatch",
        expected: this.piVersion,
        found: ref.piVersion,
      });
    }
    let header: Record<string, unknown> | null = null;
    const entries: FakeEntry[] = [];
    try {
      const lines = readFileSync(ref.sessionFile, "utf8").split("\n").filter((l) => l.trim().length > 0);
      for (let i = 0; i < lines.length; i++) {
        const parsed = JSON.parse(lines[i]!) as unknown;
        if (i === 0) {
          if (
            typeof parsed !== "object" ||
            parsed === null ||
            (parsed as Record<string, unknown>)["format"] !== "treeai-fake-session"
          ) {
            throw new Error("bad header");
          }
          header = parsed as Record<string, unknown>;
        } else {
          const e = parsed as FakeEntry;
          if (typeof e.id !== "string" || typeof e.text !== "string") throw new Error("bad entry");
          entries.push(e);
        }
      }
    } catch (err) {
      throw new TreeAIErrorShape("session-corrupt", "session file could not be parsed", {
        reason: "corrupt",
        cause: String(err),
      });
    }
    if (header === null || header["sessionId"] !== ref.sessionId) {
      throw new TreeAIErrorShape("session-corrupt", "session file does not match the reference", {
        reason: "corrupt",
      });
    }
    const leafExists = ref.entryId === "e0" || entries.some((e) => e.id === ref.entryId);
    if (!leafExists) {
      throw new TreeAIErrorShape("session-corrupt", "referenced entry not found in session", {
        reason: "entry-not-found",
      });
    }
    // Recreate the runtime entry counter so new ids stay unique.
    let maxN = 0;
    for (const e of entries) {
      const n = Number(e.id.slice(1));
      if (Number.isInteger(n) && n > maxN) maxN = n;
    }
    this.entryCounter = maxN;
    if (this.session !== null) {
      this.emit("session.replaced", { previousSessionId: this.session.sessionId });
    }
    this.session = {
      sessionId: ref.sessionId,
      sessionFile: ref.sessionFile,
      piVersion: this.piVersion,
      model: (header["model"] as PiModelSelector | undefined) ?? { providerId: "unknown", modelId: "unknown" },
      entries,
      leafEntryId: ref.entryId,
    };
    this.emit("session.restored", { sessionId: ref.sessionId, entryCount: entries.length });
    return { reference: this.reference() };
  }

  /* -------------------- prompt / steer / abort --------------------- */

  private nextScript(): FakePromptScript | null {
    const script = this.options.script;
    if (script === undefined) return null;
    if (this.scriptIndex >= script.length) return null;
    const s = script[this.scriptIndex]!;
    this.scriptIndex += 1;
    return s;
  }

  private delay(fn: () => void): NodeJS.Timeout {
    const t = setTimeout(fn, this.options.turnDelayMs ?? 5);
    return t;
  }

  async prompt(input: PiPromptInput): Promise<PiPromptResult> {
    this.assertLive("prompt");
    if (this.inFlight !== null) {
      throw new TypeError("prompt called while a run is already in flight (caller contract violation)");
    }
    if (this.session === null) {
      throw new TypeError("prompt called without an active session (caller contract violation)");
    }
    const script = this.nextScript();
    const sessionAtStart = this.session;
    this.emit("agent.started", { sessionId: sessionAtStart.sessionId });
    return new Promise<PiPromptResult>((resolve, reject) => {
      const flight: InFlight = {
        resolve,
        reject,
        steerQueue: [],
        timers: [],
        cancelled: false,
        settled: false,
      };
      this.inFlight = flight;
      this.runUserTurn(input.text, script, sessionAtStart.sessionId);
    });
  }

  private runUserTurn(text: string, script: FakePromptScript | null, sessionId: string): void {
    const flight = this.inFlight;
    if (flight === null || flight.cancelled) return;
    this.appendEntry("user", text);
    this.emit("turn.started", { sessionId });
    if (script !== null && script.kind === "fail") {
      this.emit("message.started", { sessionId });
      this.emit("runtime.error", { sessionId, code: script.code, message: script.message });
      this.settleFailure(new TreeAIErrorShape(script.code, script.message));
      return;
    }
    const turns = script !== null && script.kind === "ok" ? [...script.turns] : ["ok: acknowledged."];
    this.runAssistantTurn(turns, 0, script !== null && script.kind === "ok" ? script.toolRequest : undefined, sessionId);
  }

  private runAssistantTurn(
    turns: string[],
    index: number,
    toolRequest: FakeToolRequest | undefined,
    sessionId: string,
  ): void {
    const flight = this.inFlight;
    if (flight === null || flight.cancelled) return;
    if (index >= turns.length) {
      // All scripted turns consumed; check the steer queue for a new turn.
      const steerText = flight.steerQueue.shift();
      if (steerText !== undefined) {
        // New TURN in the SAME agent run (no second agent.started).
        this.emit("turn.started", { sessionId, steered: true });
        this.appendEntry("user", steerText);
        this.runAssistantTurn(["ok: steer acknowledged."], 0, undefined, sessionId);
        return;
      }
      this.emit("agent.settled", { sessionId });
      this.settleSuccess();
      return;
    }
    this.emit("message.started", { sessionId, turn: index });
    const text = turns[index]!;
    // Two streaming deltas then completion.
    flight.timers.push(
      this.delay(() => {
        if (flight.cancelled) return;
        this.emit("message.updated", { sessionId, turn: index, delta: text.slice(0, Math.ceil(text.length / 2)) });
        flight.timers.push(
          this.delay(() => {
            if (flight.cancelled) return;
            if (index === 0 && toolRequest !== undefined) {
              this.emit("tool.execution.started", {
                sessionId,
                tool: toolRequest.tool,
                action: toolRequest.action,
                path: toolRequest.path,
              });
              const decision = this.options.decideTool
                ? this.options.decideTool(toolRequest)
                : { outcome: "allow" as const, reason: "fake default allow" };
              const allowed = decision.outcome === "allow";
              this.emit("tool.execution.finished", {
                sessionId,
                tool: toolRequest.tool,
                isError: !allowed,
                reason: decision.reason,
              });
              if (!allowed) {
                this.emit("runtime.error", {
                  sessionId,
                  code: "policy-denied",
                  message: `tool ${toolRequest.tool} denied: ${decision.reason}`,
                });
                this.settleFailure(
                  new TreeAIErrorShape("policy-denied", `tool ${toolRequest.tool} denied: ${decision.reason}`),
                );
                return;
              }
            }
            this.emit("message.updated", { sessionId, turn: index, delta: text.slice(Math.ceil(text.length / 2)) });
            flight.timers.push(
              this.delay(() => {
                if (flight.cancelled) return;
                const entry = this.appendEntry("assistant", text);
                this.emit("message.completed", { sessionId, turn: index, entryId: entry.id });
                this.emit("turn.completed", { sessionId, turn: index });
                this.runAssistantTurn(turns, index + 1, toolRequest, sessionId);
              }),
            );
          }),
        );
      }),
    );
  }

  private settleSuccess(): void {
    const flight = this.inFlight;
    if (flight === null || flight.settled) return;
    flight.settled = true;
    for (const t of flight.timers) clearTimeout(t);
    this.inFlight = null;
    const lastAssistant = [...(this.session?.entries ?? [])]
      .reverse()
      .find((e) => e.kind === "assistant");
    flight.resolve({
      message: lastAssistant?.text ?? "",
      reference: this.reference(),
    });
  }

  private settleFailure(err: unknown): void {
    const flight = this.inFlight;
    if (flight === null || flight.settled) return;
    flight.settled = true;
    for (const t of flight.timers) clearTimeout(t);
    this.inFlight = null;
    flight.reject(err);
  }

  async steer(input: PiSteerInput): Promise<void> {
    this.assertLive("steer");
    if (this.inFlight === null) {
      throw new TypeError("steer called without an in-flight run (caller contract violation)");
    }
    this.inFlight.steerQueue.push(input.text);
    this.emit("steer.enqueued", { queued: this.inFlight.steerQueue.length });
  }

  async abort(): Promise<void> {
    // Idempotent: silent no-op without an in-flight run (even after dispose).
    if (this.inFlight === null) return;
    this.emit("run.abort-requested", { sessionId: this.session?.sessionId ?? null });
    this.settleFailure(new TreeAIErrorShape("user-abort", "run aborted by user"));
  }

  /* -------------------- tree navigation ----------------------------- */

  async navigateTree(target: PiNavigateTreeTarget): Promise<SessionReference> {
    this.assertLive("navigateTree");
    if (this.inFlight !== null) {
      throw new TypeError("navigateTree called while a run is in flight (caller contract violation)");
    }
    const s = this.session;
    if (s === null) {
      throw new TypeError("navigateTree called without an active session (caller contract violation)");
    }
    const found = target.entryId === "e0" || s.entries.some((e) => e.id === target.entryId);
    if (!found) {
      throw new TreeAIErrorShape("session-corrupt", "navigation target not found", {
        reason: "entry-not-found",
        target: target.entryId,
      });
    }
    const from = s.leafEntryId;
    s.leafEntryId = target.entryId;
    const context = this.contextOf(target.entryId);
    this.emit("tree.navigated", {
      sessionId: s.sessionId,
      from,
      to: target.entryId,
      entryCount: s.entries.length,
      contextEntries: context.length,
    });
    return this.reference();
  }

  /* -------------------- dispose -------------------------------------- */

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.inFlight !== null) {
      this.emit("run.abort-requested", { sessionId: this.session?.sessionId ?? null, viaDispose: true });
      this.settleFailure(new TreeAIErrorShape("user-abort", "run aborted by dispose"));
    }
    if (this.ownsSessionDir) {
      try {
        rmSync(this.sessionDir, { recursive: true, force: true });
      } catch {
        // best effort cleanup; the residual-resource check reports leftovers
      }
    }
  }

  /** Test-only: the directory the runtime owns (for temp cleanup checks). */
  get ownedSessionDir(): string | null {
    return this.ownsSessionDir ? this.sessionDir : null;
  }
}
