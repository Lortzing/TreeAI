/**
 * Deterministic offline echo driver for the Pi SDK port seam (studio app local).
 *
 * This is app-local driver scaffolding, following the D2-validated pattern from
 * apps/runtime-smoke/src/fake-pi-port.ts: the REAL PiRuntime implementation is
 * driven end-to-end through `createPiRuntimeFromConfig` with an injected port —
 * no real SDK calls, no network, no user Pi home access. It is NOT production
 * code and must not be copied into packages/.
 *
 * Semantics mirrored from Pi 0.85.1 (independent implementation, reference:
 * packages/runtime-pi tests and D1/D2 evidence):
 * - new sessions append model_change + thinking_level_change entries; restored
 *   sessions keep their stored entries;
 * - entries live in an append-only tree (parentId forks); the session file is
 *   a private JSONL (header + entry lines) flushed after the first assistant
 *   message;
 * - prompt: agent_start -> turn -> agent_settled, then the promise resolves;
 *   answers are deterministic ECHOES of the user texts visible on the current
 *   branch (this is what proves branch context isolation);
 * - navigateTree: a user-message target moves the leaf to its parent (fork
 *   point); any other target (e.g. an assistant answer entry — the D3 branch
 *   anchor) moves the leaf to the target itself; never creates a new session
 *   and never removes entries;
 * - abort converges the run with a synthetic "aborted" assistant message.
 *
 * The class is fully structural: it declares NO import from
 * @treeai/runtime-pi; compatibility with the frozen PiSdkPort seam is enforced
 * by TypeScript at the createPiRuntimeFromConfig call site.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Session tree entry (driver-private JSONL shape). */
export interface EchoEntry {
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

/** Driver session manager: append-only entry tree + JSONL persistence. */
export class EchoSessionManager {
  readonly cwd: string;
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  private readonly persisted: boolean;
  private readonly entries: EchoEntry[] = [];
  private leafId: string | null = null;

  constructor(options: {
    readonly cwd: string;
    readonly persisted: boolean;
    readonly sessionId: string;
    readonly sessionFile?: string;
    readonly entries?: readonly EchoEntry[];
  }) {
    this.cwd = options.cwd;
    this.persisted = options.persisted;
    this.sessionId = options.sessionId;
    this.sessionFile = options.sessionFile;
    if (options.entries !== undefined) {
      this.entries.push(...options.entries);
      // Opened files resume at the last line (real Pi reopens at the tail).
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

  getEntry(id: string): EchoEntry | undefined {
    return this.entries.find((entry) => entry.id === id);
  }

  getEntries(): readonly EchoEntry[] {
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
  append(entry: Omit<EchoEntry, "id" | "parentId">): string {
    const full: EchoEntry = {
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
  entriesOnBranch(): EchoEntry[] {
    const path: EchoEntry[] = [];
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

  messageEntriesOnBranch(): EchoEntry[] {
    return this.entriesOnBranch().filter((entry) => entry.type === "message");
  }

  /** Flush after the first assistant entry (real Pi lazily persists). */
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

interface EchoMessage {
  readonly role: string;
  readonly stopReason?: string;
  readonly errorMessage?: string;
  readonly text?: string;
}

/** Driver agent session (structural stand-in for the PiPortSession subset). */
export class EchoPiSession {
  readonly sessionManager: EchoSessionManager;
  private readonly listeners = new Set<(event: { type: string; [key: string]: unknown }) => void>();
  private readonly modelRef: { provider: string; id: string } | undefined;
  private messagesList: EchoMessage[] = [];
  private active = false;
  private aborted = false;
  private disposed = false;
  private readonly stateRef: { errorMessage?: string } = {};

  constructor(
    manager: EchoSessionManager,
    model: { provider: string; id: string } | undefined,
  ) {
    this.sessionManager = manager;
    this.modelRef = model;
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

  get messages(): readonly EchoMessage[] {
    return this.messagesList;
  }

  get model(): { provider: string; id: string } | undefined {
    return this.modelRef;
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
    if (this.modelRef === undefined) throw new Error("No model selected");
    if (this.active) throw new Error("Agent is already processing");
    this.active = true;
    this.aborted = false;
    this.stateRef.errorMessage = undefined;
    return new Promise<void>((resolve) => {
      void this.executeRun(text).then(resolve);
    });
  }

  async steer(text: string): Promise<void> {
    // Steer is not exercised by the studio MVP; minimal queue semantics.
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
 * Minimal structural supertype of the port's session-manager seam, so the
 * port's createSession parameter accepts any PiPortSessionManager-shaped input
 * (method bivariance) while the driver internally narrows to its own type.
 */
export interface EchoPortManagerInput {
  getCwd(): string;
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getLeafId(): string | null;
  getEntry(id: string): unknown;
  getEntries(): readonly unknown[];
  branch(branchFromId: string): void;
  resetLeaf(): void;
}

/** Module-level session counter: ids/files stay unique across port instances. */
let echoSessionCounter = 0;

function nextEchoSessionId(): string {
  echoSessionCounter += 1;
  return `echo-session-${echoSessionCounter}`;
}

/**
 * Offline echo SDK port. Answers are always deterministic echoes — the studio
 * MVP runs fully offline; swap in the real Pi port with --driver pi.
 */
export class EchoSdkPort {
  readonly version = "0.85.1";
  private readonly providerId: string;
  private readonly modelId: string;
  readonly createdManagers: EchoSessionManager[] = [];
  readonly createdSessions: EchoPiSession[] = [];

  constructor(model?: { readonly providerId: string; readonly modelId: string }) {
    this.providerId = model?.providerId ?? "studio-provider";
    this.modelId = model?.modelId ?? "studio-model";
  }

  async createServices(
    cwd: string,
    agentDir: string | undefined,
  ): Promise<{
    getModel: (providerId: string, modelId: string) => { provider: string; id: string } | undefined;
  }> {
    void cwd;
    void agentDir;
    return {
      getModel: (providerId, modelId) =>
        providerId === this.providerId && modelId === this.modelId
          ? { provider: this.providerId, id: this.modelId }
          : undefined,
    };
  }

  createSessionManager(cwd: string, sessionDir: string): EchoSessionManager {
    if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });
    const sessionId = nextEchoSessionId();
    const manager = new EchoSessionManager({
      cwd,
      persisted: true,
      sessionId,
      sessionFile: join(sessionDir, `${sessionId}.jsonl`),
    });
    this.createdManagers.push(manager);
    return manager;
  }

  createInMemorySessionManager(cwd: string): EchoSessionManager {
    const manager = new EchoSessionManager({
      cwd,
      persisted: false,
      sessionId: nextEchoSessionId(),
    });
    this.createdManagers.push(manager);
    return manager;
  }

  openSessionManager(sessionFile: string): EchoSessionManager {
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
      throw new Error(`Session file is not a valid echo session: ${sessionFile}`);
    }
    const entries = lines.slice(1).map((line) => JSON.parse(line) as unknown as EchoEntry);
    const manager = new EchoSessionManager({
      cwd: first["cwd"],
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
    readonly sessionManager: EchoPortManagerInput;
    readonly model?: { provider: string; id: string };
  }): Promise<{ session: EchoPiSession; modelFallbackMessage?: string }> {
    const manager = input.sessionManager as EchoSessionManager;
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
        modelChange.provider === this.providerId &&
        modelChange.modelId === this.modelId
      ) {
        model = { provider: modelChange.provider, id: modelChange.modelId };
      } else if (modelChange !== undefined) {
        modelFallbackMessage = `Could not restore model ${String(modelChange.provider)}/${String(modelChange.modelId)}`;
      }
    }
    if (model === undefined) {
      model = { provider: this.providerId, id: this.modelId };
    }

    if (hasMessages) {
      if (!hasThinking) {
        manager.append({ type: "thinking_level_change" });
      }
    } else {
      manager.append({ type: "model_change", provider: model.provider, modelId: model.id });
      manager.append({ type: "thinking_level_change" });
    }

    const session = new EchoPiSession(manager, model);
    this.createdSessions.push(session);
    return { session, modelFallbackMessage };
  }
}
