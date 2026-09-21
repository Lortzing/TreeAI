/**
 * Deterministic offline fake of the Pi SDK port (runtime-smoke app local).
 *
 * Purpose: drive Agent B's REAL PiRuntime implementation end-to-end without
 * the real SDK, models, or network. This file is app/test scaffolding — it
 * is NOT production code and must not be copied into packages/.
 *
 * Semantics mirrored from Pi 0.85.1 (reference: packages/runtime-pi tests
 * and D1 evidence; this is an independent implementation):
 * - new session appends model_change + thinking_level_change entries;
 *   restored sessions keep their stored entries (model pinned by caller);
 * - entries live in an append-only tree (parentId forks); the session file
 *   is a private JSONL (header + entry lines), lazily flushed only after
 *   the first assistant message (real _persist semantics);
 * - prompt: agent_start -> turn(s) -> agent_end -> agent_settled, then the
 *   promise resolves; answers are deterministic ECHOES of the user texts
 *   visible on the current branch (this is what proves branch context
 *   isolation in the scenario);
 * - navigateTree: user-message target moves the leaf to its parent (fork
 *   point); other targets move the leaf to the target itself; never creates
 *   a new session and never removes entries;
 * - abort converges the run with a synthetic "aborted" assistant message;
 *   "hang" mode parks the run in-flight (host-crash simulation);
 * - openSessionManager rejects missing files with ENOENT (stricter than
 *   real Pi, which silently creates; the runtime pre-checks existence so
 *   the difference is unreachable — same choice as B's unit fake).
 *
 * The class is fully structural: it declares NO import from
 * @treeai/runtime-pi; compatibility with the frozen PiSdkPort seam is
 * enforced by TypeScript at the createPiRuntimeFromConfig call site.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Per-prompt behavior consumed from a port-level queue. */
export type SmokePortBehavior = "echo" | "hang";

/** Normal (ref-counted) delay for turn pacing. */
function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Pacing delay for the in-flight hang loop. It MUST stay ref-counted: a
 * run parked in "hang" mode is still a live in-flight run, and its
 * eventual convergence (e.g. abort) has to be able to wake the process
 * even when no other work is pending — an unref'd timer here lets the
 * event loop drain mid-scenario and kills the process with an unsettled
 * top-level await. The abandoned crash-run zombie is instead reaped
 * explicitly by the scenario (session.dispose() at the simulated
 * process-death point), which is what real process death would do.
 */

/** Session tree entry (fake-private JSONL shape). */
export interface SmokeEntry {
  readonly type: "message" | "model_change" | "thinking_level_change";
  readonly id: string;
  readonly parentId: string | null;
  readonly role?: string;
  readonly text?: string;
  readonly stopReason?: string;
  readonly errorMessage?: string;
  readonly provider?: string;
  readonly modelId?: string;
}

/** Deterministic echo answer from the user texts visible on the branch. */
function echoAnswer(userTexts: readonly string[]): string {
  return `echo:[${userTexts.join("|")}]`;
}

/**
 * Fake session manager: append-only entry tree + lazy JSONL persistence.
 * Structural stand-in for the Pi SessionManager consumption subset.
 */
export class SmokeSessionManager {
  readonly cwd: string;
  private readonly sessionDir: string | undefined;
  private readonly persisted: boolean;
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  private readonly entries: SmokeEntry[] = [];
  private leafId: string | null = null;

  constructor(options: {
    readonly cwd: string;
    readonly sessionDir?: string;
    readonly persisted: boolean;
    readonly sessionId: string;
    readonly sessionFile?: string;
    readonly entries?: readonly SmokeEntry[];
  }) {
    this.cwd = options.cwd;
    this.sessionDir = options.sessionDir;
    this.persisted = options.persisted;
    this.sessionId = options.sessionId;
    this.sessionFile = options.sessionFile;
    if (options.entries !== undefined) {
      this.entries.push(...options.entries);
      // Opened files resume at the last line (real Pi reopens at the file tail).
      this.leafId = this.entries.length > 0 ? this.entries[this.entries.length - 1]!.id : null;
    }
  }

  getCwd(): string {
    return this.cwd;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getSessionFile(): string | undefined {
    return this.sessionFile;
  }

  getLeafId(): string | null {
    return this.leafId;
  }

  getEntry(id: string): SmokeEntry | undefined {
    return this.entries.find((entry) => entry.id === id);
  }

  getEntries(): readonly SmokeEntry[] {
    return [...this.entries];
  }

  branch(branchFromId: string): void {
    if (this.getEntry(branchFromId) === undefined) {
      throw new Error(`Entry not found: ${branchFromId}`);
    }
    this.leafId = branchFromId;
  }

  resetLeaf(): void {
    this.leafId = null;
  }

  /** Append an entry as the new leaf (ids stay unique across reopens). */
  append(entry: Omit<SmokeEntry, "id" | "parentId">): string {
    const full: SmokeEntry = {
      ...entry,
      id: `entry-${this.entries.length + 1}`,
      parentId: this.leafId,
    };
    this.entries.push(full);
    this.leafId = full.id;
    this.persist();
    return full.id;
  }

  /** Entries on the current branch (leaf -> root), in time order. */
  entriesOnBranch(): SmokeEntry[] {
    const path: SmokeEntry[] = [];
    let cursor = this.leafId;
    let steps = 0;
    while (cursor !== null) {
      steps += 1;
      if (steps > 100_000) break;
      const entry = this.getEntry(cursor);
      if (entry === undefined) break;
      path.unshift(entry);
      cursor = entry.parentId;
    }
    return path;
  }

  messageEntriesOnBranch(): SmokeEntry[] {
    return this.entriesOnBranch().filter((entry) => entry.type === "message");
  }

  /** Lazy flush: nothing hits disk before the first assistant entry. */
  private persist(): void {
    if (!this.persisted || this.sessionFile === undefined) return;
    const hasAssistant = this.entries.some(
      (entry) => entry.type === "message" && entry.role === "assistant",
    );
    if (!hasAssistant) return;
    const lines = [
      JSON.stringify({ type: "session", id: this.sessionId, cwd: this.cwd }),
      ...this.entries.map((entry) => JSON.stringify(entry)),
    ];
    writeFileSync(this.sessionFile, `${lines.join("\n")}\n`, "utf8");
  }
}

interface SmokeMessage {
  readonly role: string;
  readonly stopReason?: string;
  readonly errorMessage?: string;
  readonly text?: string;
}

/**
 * Fake agent session. Structural stand-in for the PiPortSession subset.
 * Emits Pi-shaped raw events (agent_start / turn_start / message_* / …).
 */
export class SmokePiSession {
  readonly sessionManager: SmokeSessionManager;
  private readonly listeners = new Set<(event: { type: string; [key: string]: unknown }) => void>();
  private readonly behavior: () => SmokePortBehavior;
  private readonly _model: { provider: string; id: string } | undefined;
  private messagesList: SmokeMessage[] = [];
  private active = false;
  private aborted = false;
  private disposed = false;
  private readonly stateRef: { errorMessage?: string } = {};

  constructor(
    manager: SmokeSessionManager,
    behavior: () => SmokePortBehavior,
    model: { provider: string; id: string } | undefined,
  ) {
    this.sessionManager = manager;
    this.behavior = behavior;
    this._model = model;
    this.rebuildMessages();
  }

  get sessionId(): string {
    return this.sessionManager.getSessionId();
  }

  get sessionFile(): string | undefined {
    return this.sessionManager.getSessionFile();
  }

  get isStreaming(): boolean {
    return this.active;
  }

  get state(): { errorMessage?: string } {
    return this.stateRef;
  }

  get messages(): readonly SmokeMessage[] {
    return this.messagesList;
  }

  get model(): { provider: string; id: string } | undefined {
    return this._model;
  }

  subscribe(listener: (event: { type: string; [key: string]: unknown }) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: { type: string; [key: string]: unknown }): void {
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }

  prompt(text: string): Promise<void> {
    if (this.disposed) throw new Error("session disposed");
    if (this._model === undefined) throw new Error("No model selected");
    if (this.active) throw new Error("Agent is already processing");
    this.active = true;
    this.aborted = false;
    this.stateRef.errorMessage = undefined;
    return new Promise<void>((resolve) => {
      void this.executeRun(text).then(resolve);
    });
  }

  async steer(text: string): Promise<void> {
    // Steer is not exercised by the smoke scenario; minimal queue semantics.
    void text;
    return Promise.resolve();
  }

  async abort(): Promise<void> {
    if (!this.active) return;
    this.aborted = true;
    await delay(1);
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  async navigateTree(targetId: string): Promise<{ cancelled: boolean; editorText?: string }> {
    if (this.active) throw new Error("Cannot navigate tree while streaming");
    const entry = this.sessionManager.getEntry(targetId);
    if (entry === undefined) throw new Error(`Entry not found: ${targetId}`);
    if (targetId === this.sessionManager.getLeafId()) {
      return { cancelled: false };
    }
    if (entry.type === "message" && entry.role === "user") {
      // Pi semantics: a user-message target lands on its parent (fork point).
      if (entry.parentId === null) {
        this.sessionManager.resetLeaf();
      } else {
        this.sessionManager.branch(entry.parentId);
      }
      this.rebuildMessages();
      return { cancelled: false, editorText: entry.text ?? "" };
    }
    this.sessionManager.branch(targetId);
    this.rebuildMessages();
    return { cancelled: false };
  }

  getLastAssistantText(): string | undefined {
    for (let i = this.messagesList.length - 1; i >= 0; i -= 1) {
      const message = this.messagesList[i];
      if (message !== undefined && message.role === "assistant") {
        return message.text;
      }
    }
    return undefined;
  }

  private async executeRun(text: string): Promise<void> {
    this.emit({ type: "agent_start" });
    await this.executeTurn(text);
    if (this.aborted) {
      this.emitSyntheticAborted();
    }
    this.emit({ type: "agent_end" }); // dropped by the runtime's normalizer
    this.emit({ type: "agent_settled" });
    this.active = false;
  }

  private async executeTurn(text: string): Promise<void> {
    this.emit({ type: "turn_start" });
    this.emit({ type: "message_start", message: { role: "user" } });
    this.emit({ type: "message_end", message: { role: "user" } });
    this.sessionManager.append({ type: "message", role: "user", text });
    await delay(1);

    this.emit({ type: "message_start", message: { role: "assistant" } });

    const mode = this.behavior();
    if (mode === "hang") {
      // Park in flight: no assistant entry, no persist, no settle. The
      // loop exits on abort or dispose (a host crash reaps it via the
      // scenario's process-death simulation, not via unref'd timers).
      while (this.active && !this.aborted && !this.disposed) {
        await delay(2);
      }
      this.rebuildMessages();
      return;
    }

    if (this.aborted) {
      this.emitSyntheticAborted();
      this.emit({ type: "turn_end", message: { role: "assistant", stopReason: "aborted" } });
      return;
    }

    // Deterministic echo of the user texts visible on this branch.
    const answer = echoAnswer(
      this.sessionManager
        .messageEntriesOnBranch()
        .filter((entry) => entry.role === "user")
        .map((entry) => entry.text ?? ""),
    );
    const mid = Math.ceil(answer.length / 2);
    const deltas = [answer.slice(0, mid), answer.slice(mid)];
    for (const delta of deltas) {
      if (this.aborted || this.disposed) break;
      this.emit({
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
      });
      await delay(1);
    }
    this.emit({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
    this.emit({ type: "turn_end", message: { role: "assistant", stopReason: "stop" } });
    this.sessionManager.append({
      type: "message",
      role: "assistant",
      text: answer,
      stopReason: "stop",
    });
    this.rebuildMessages();
  }

  private emitSyntheticAborted(): void {
    this.emit({
      type: "message_start",
      message: { role: "assistant", stopReason: "aborted", errorMessage: "aborted" },
    });
    this.emit({
      type: "message_end",
      message: { role: "assistant", stopReason: "aborted", errorMessage: "aborted" },
    });
    this.stateRef.errorMessage = "aborted";
    this.sessionManager.append({
      type: "message",
      role: "assistant",
      text: "",
      stopReason: "aborted",
      errorMessage: "aborted",
    });
    this.rebuildMessages();
  }

  private rebuildMessages(): void {
    this.messagesList = this.sessionManager.messageEntriesOnBranch().map((entry) => ({
      role: entry.role ?? "user",
      ...(entry.stopReason === undefined ? {} : { stopReason: entry.stopReason }),
      ...(entry.errorMessage === undefined ? {} : { errorMessage: entry.errorMessage }),
      ...(entry.text === undefined ? {} : { text: entry.text }),
    }));
  }
}

/**
 * Minimal structural supertype of the port's session-manager seam.
 * Declared so that the port's createSession parameter accepts any
 * PiPortSessionManager-shaped input (method bivariance) while the fake
 * internally narrows to its own manager type.
 */
export interface SmokePortManagerInput {
  getCwd(): string;
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getLeafId(): string | null;
  getEntry(id: string): unknown;
  getEntries(): readonly unknown[];
  branch(branchFromId: string): void;
  resetLeaf(): void;
}

/**
 * Module-level session counter: session ids/files must be unique ACROSS
 * port instances (a restart creates a new port instance; reusing its
 * per-instance counter would collide with generation-1 session files).
 * Still deterministic within a process run.
 */
let smokeSessionCounter = 0;

function nextSmokeSessionId(): string {
  smokeSessionCounter += 1;
  return `smoke-session-${smokeSessionCounter}`;
}

/**
 * Fake SDK port. Structural stand-in for the frozen PiSdkPort seam.
 * Behavior queue: each prompt() consumes the next entry ("echo" default).
 */
export class SmokeSdkPort {
  readonly version = "0.85.1";
  private readonly behaviors: SmokePortBehavior[];
  private behaviorIndex = 0;
  readonly createdManagers: SmokeSessionManager[] = [];
  readonly createdSessions: SmokePiSession[] = [];
  readonly servicesCalls: Array<{ cwd: string; agentDir: string | undefined }> = [];

  constructor(behaviors: readonly SmokePortBehavior[] = []) {
    this.behaviors = [...behaviors];
  }

  private nextBehavior(): SmokePortBehavior {
    const behavior = this.behaviors[this.behaviorIndex];
    this.behaviorIndex += 1;
    return behavior ?? "echo";
  }

  async createServices(
    cwd: string,
    agentDir: string | undefined,
  ): Promise<{
    getModel: (providerId: string, modelId: string) => { provider: string; id: string } | undefined;
  }> {
    this.servicesCalls.push({ cwd, agentDir });
    return {
      getModel: (providerId: string, modelId: string) =>
        providerId === "smoke-provider" && modelId === "smoke-model"
          ? { provider: "smoke-provider", id: "smoke-model" }
          : undefined,
    };
  }

  createSessionManager(cwd: string, sessionDir: string): SmokeSessionManager {
    if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });
    const sessionId = nextSmokeSessionId();
    const manager = new SmokeSessionManager({
      cwd,
      sessionDir,
      persisted: true,
      sessionId,
      sessionFile: join(sessionDir, `${sessionId}.jsonl`),
    });
    this.createdManagers.push(manager);
    return manager;
  }

  createInMemorySessionManager(cwd: string): SmokeSessionManager {
    const manager = new SmokeSessionManager({
      cwd,
      persisted: false,
      sessionId: nextSmokeSessionId(),
    });
    this.createdManagers.push(manager);
    return manager;
  }

  openSessionManager(sessionFile: string): SmokeSessionManager {
    if (!existsSync(sessionFile)) {
      throw Object.assign(new Error(`ENOENT: no such file, open '${sessionFile}'`), {
        code: "ENOENT",
      });
    }
    const lines = readFileSync(sessionFile, "utf8").split("\n").filter((line) => line.length > 0);
    const first = lines[0] === undefined ? null : (JSON.parse(lines[0]) as Record<string, unknown>);
    if (
      first === null ||
      first["type"] !== "session" ||
      typeof first["id"] !== "string" ||
      typeof first["cwd"] !== "string"
    ) {
      throw new Error(`Session file is not a valid smoke session: ${sessionFile}`);
    }
    const entries = lines.slice(1).map((line) => JSON.parse(line) as unknown as SmokeEntry);
    const manager = new SmokeSessionManager({
      cwd: first["cwd"],
      sessionDir: undefined,
      persisted: true,
      sessionId: first["id"],
      sessionFile,
      entries,
    });
    this.createdManagers.push(manager);
    return manager;
  }

  async createSession(input: {
    readonly services: unknown;
    readonly sessionManager: SmokePortManagerInput;
    readonly model?: { provider: string; id: string };
  }): Promise<{ session: SmokePiSession; modelFallbackMessage?: string }> {
    const manager = input.sessionManager as SmokeSessionManager;
    const hasMessages = manager.messageEntriesOnBranch().length > 0;
    const hasThinking = manager.entriesOnBranch().some((e) => e.type === "thinking_level_change");

    let model = input.model;
    let modelFallbackMessage: string | undefined;
    if (model === undefined && hasMessages) {
      const modelChange = [...manager.entriesOnBranch()]
        .reverse()
        .find((entry) => entry.type === "model_change");
      if (
        modelChange !== undefined &&
        modelChange.provider !== undefined &&
        modelChange.modelId !== undefined &&
        modelChange.provider === "smoke-provider" &&
        modelChange.modelId === "smoke-model"
      ) {
        model = { provider: modelChange.provider, id: modelChange.modelId };
      } else if (modelChange !== undefined) {
        modelFallbackMessage = `Could not restore model ${String(modelChange.provider)}/${String(modelChange.modelId)}`;
      }
    }
    if (model === undefined) {
      model = { provider: "smoke-provider", id: "smoke-model" };
    }

    if (hasMessages) {
      if (!hasThinking) {
        manager.append({ type: "thinking_level_change" });
      }
    } else {
      manager.append({ type: "model_change", provider: model.provider, modelId: model.id });
      manager.append({ type: "thinking_level_change" });
    }

    const session = new SmokePiSession(manager, () => this.nextBehavior(), model);
    this.createdSessions.push(session);
    return { session, modelFallbackMessage };
  }
}
