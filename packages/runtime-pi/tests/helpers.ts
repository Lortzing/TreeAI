/**
 * Fake Pi SDK 端口：单测专用（不 import Pi SDK）。
 *
 * 以 D1 实测的 Pi 0.85.1 语义为镜像基准重写（未复制 spike 文件）：
 * - prompt 同步 throw 路径（无模型等）+ 异步 run（agent_start →
 *   turn(s) → agent_end → agent_settled 后 promise resolve）；
 * - steer = 同一 agent run 内追加 turn（无第二个 agent_start）；
 * - abort：合成 stopReason "aborted" 的 assistant 消息后收敛；
 * - navigateTree：用户消息目标 → 叶移到 parent（null → resetLeaf）并
 *   返回 editorText；其他目标 → 叶移到目标自身；同 session、追加式；
 * - 新建持久化 session 时追加 model_change + thinking_level_change
 *   条目（Pi sdk.js 的新会话路径行为，restore 据此恢复模型）；条目在
 *   首条 assistant 消息前只驻内存（懒 flush，已镜像真实 _persist）。
 *
 * Fake 的 session 文件格式是测试私有 JSONL（首行 header +
 * 条目行），只服务于 fake 端口的 open/close 往返；真实 Pi 文件格式的
 * 行为由 tests/real-port/ 用真实 SDK 验证。与真实 SDK 的两处刻意差异：
 * - 落盘用整体重写代替 Pi 的 wx-建文件+追加，磁盘内容等价、过程不同；
 * - openSessionManager 对缺失文件抛 ENOENT（真实 Pi 静默新建空会话）。
 *   运行时在 restore 前自行 existsSync 预检，该差异不可达；保留更严的
 *   fake，运行时预检被误删时测试仍会失败。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  PiEventLike,
  PiPortCreateSessionInput,
  PiPortCreateSessionResult,
  PiPortModelHandle,
  PiPortNavigateResult,
  PiPortServices,
  PiPortSession,
  PiPortSessionManager,
  PiSdkPort,
} from "../src/pi-sdk-port.ts";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 一次 fake run 的行为脚本。 */
export interface FakeTurnScript {
  /** 助手回复文本。 */
  readonly answer: string;
  /** 文本增量切分（默认 2 段）。 */
  readonly deltaCount?: number;
  /** turn 间隔延迟（默认 1ms，保证异步可观察）。 */
  readonly interDelayMs?: number;
  /** run 级失败：以 stopReason "error" + errorMessage 结束（prompt 仍 resolve）。 */
  readonly runError?: string;
  /** prompt 同步抛出的错误（模拟 Pi 无模型/认证同步 throw）。 */
  readonly syncThrow?: Error;
  /** 挂起：发出 agent_start 与首个 message_start 后不推进（abort 可打断）。 */
  readonly hang?: boolean;
  /** 邪恶模式：abort() 被调用也不收敛（用于安全计时器测试）。 */
  readonly ignoreAbort?: boolean;
}

export interface FakeEntry {
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

let entryCounter = 0;
function nextEntryId(): string {
  entryCounter += 1;
  return `fake-entry-${entryCounter}`;
}

export class FakeSessionManager implements PiPortSessionManager {
  readonly cwd: string;
  private readonly sessionDir: string | undefined;
  private readonly persisted: boolean;
  sessionId: string;
  sessionFile: string | undefined;
  private readonly entries: FakeEntry[] = [];
  private leafId: string | null = null;
  private fileCounter = 0;

  constructor(cwd: string, sessionDir: string | undefined, persisted: boolean, sessionId?: string, entries?: FakeEntry[], sessionFile?: string) {
    this.cwd = cwd;
    this.sessionDir = sessionDir;
    this.persisted = persisted;
    this.sessionId = sessionId ?? `fake-session-${Math.random().toString(36).slice(2, 10)}`;
    if (entries !== undefined) {
      this.entries.push(...entries);
      for (const entry of entries) {
        this.leafId = entry.id;
      }
    }
    if (sessionFile !== undefined) {
      this.sessionFile = sessionFile;
    } else if (persisted && sessionDir !== undefined) {
      this.fileCounter += 1;
      this.sessionFile = join(sessionDir, `fake-session-${this.fileCounter}-${this.sessionId}.jsonl`);
      // 镜像 Pi newSession()：只计算路径，不落盘（懒 flush）。
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

  getEntry(id: string): FakeEntry | undefined {
    return this.entries.find((entry) => entry.id === id);
  }

  getEntries(): readonly FakeEntry[] {
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

  appendMessage(message: { role: string; text: string; stopReason?: string; errorMessage?: string }): string {
    return this.appendEntry({
      type: "message",
      id: nextEntryId(),
      parentId: this.leafId,
      role: message.role,
      text: message.text,
      stopReason: message.stopReason,
      errorMessage: message.errorMessage,
    });
  }

  appendModelChange(provider: string, modelId: string): string {
    return this.appendEntry({
      type: "model_change",
      id: nextEntryId(),
      parentId: this.leafId,
      provider,
      modelId,
    });
  }

  appendThinkingLevelChange(): string {
    return this.appendEntry({
      type: "thinking_level_change",
      id: nextEntryId(),
      parentId: this.leafId,
    });
  }

  private appendEntry(entry: FakeEntry): string {
    this.entries.push(entry);
    this.leafId = entry.id;
    this.persist();
    return entry.id;
  }

  /** 当前分支（叶→根）上的消息条目，按时间序返回。 */
  /** 当前分支（叶→根）上的全部条目，按时间序返回。 */
  entriesOnBranch(): FakeEntry[] {
    const path: FakeEntry[] = [];
    let cursor = this.leafId;
    let steps = 0;
    while (cursor !== null) {
      steps += 1;
      if (steps > 100_000) {
        break;
      }
      const entry = this.getEntry(cursor);
      if (entry === undefined) {
        break;
      }
      path.unshift(entry);
      cursor = entry.parentId;
    }
    return path;
  }

  messageEntriesOnBranch(): FakeEntry[] {
    return this.entriesOnBranch().filter((entry) => entry.type === "message");
  }

  private persist(): void {
    if (!this.persisted || this.sessionFile === undefined) {
      return;
    }
    // 镜像 Pi 0.85.1 _persist 的懒 flush：首条 assistant 消息出现前
    // 什么都不写（真实 SDK 在 newSession/创建期条目只驻内存；assistant
    // 到达时才整体落盘——tests/real-port/ 已实证）。为简化 fake 用整体
    // 重写代替 wx-建文件+追加，落盘内容等价。
    const hasAssistant = this.entries.some(
      (entry) => entry.type === "message" && entry.role === "assistant",
    );
    if (!hasAssistant) {
      return;
    }
    const lines = [
      JSON.stringify({ type: "session", id: this.sessionId, cwd: this.cwd }),
      ...this.entries.map((entry) => JSON.stringify(entry)),
    ];
    writeFileSync(this.sessionFile, `${lines.join("\n")}\n`, "utf8");
  }
}

interface FakeMessage {
  readonly role: string;
  readonly stopReason?: string;
  readonly errorMessage?: string;
  readonly text?: string;
}

export class FakePiSession implements PiPortSession {
  readonly sessionManager: FakeSessionManager;
  private readonly listeners = new Set<(event: PiEventLike) => void>();
  private script: FakeTurnScript;
  private _model: PiPortModelHandle | undefined;
  private messagesList: FakeMessage[] = [];
  private active = false;
  private aborted = false;
  private disposed = false;
  private readonly steeringQueue: string[] = [];
  private runResolvers: Array<() => void> = [];
  readonly turnInputs: string[] = [];

  constructor(manager: FakeSessionManager, script: FakeTurnScript, model: PiPortModelHandle | undefined) {
    this.sessionManager = manager;
    this.script = script;
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

  private readonly stateRef: { errorMessage?: string } = {};

  get messages(): readonly FakeMessage[] {
    return this.messagesList;
  }

  get model(): PiPortModelHandle | undefined {
    return this._model;
  }

  subscribe(listener: (event: PiEventLike) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: PiEventLike): void {
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }

  prompt(text: string): Promise<void> {
    if (this.disposed) {
      throw new Error("session disposed");
    }
    if (this._model === undefined) {
      throw new Error("No model selected");
    }
    if (this.active) {
      throw new Error("Agent is already processing");
    }
    if (this.script.syncThrow !== undefined) {
      throw this.script.syncThrow;
    }
    this.active = true;
    this.aborted = false;
    this.stateRef.errorMessage = undefined;
    return new Promise<void>((resolve) => {
      this.runResolvers.push(resolve);
      void this.executeRun(text);
    });
  }

  steer(text: string): Promise<void> {
    this.steeringQueue.push(text);
    return Promise.resolve();
  }

  async abort(): Promise<void> {
    if (!this.active || this.script.ignoreAbort) {
      return;
    }
    this.aborted = true;
    // 等待 run 收敛（fake 的 abort 立即触发收敛流程）。
    await delay(1);
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  async navigateTree(targetId: string): Promise<PiPortNavigateResult> {
    if (this.active) {
      throw new Error("Cannot navigate tree while streaming");
    }
    const entry = this.sessionManager.getEntry(targetId);
    if (entry === undefined) {
      throw new Error(`Entry not found: ${targetId}`);
    }
    if (targetId === this.sessionManager.getLeafId()) {
      return { cancelled: false };
    }
    if (entry.type === "message" && entry.role === "user") {
      const editorText = entry.text ?? "";
      if (entry.parentId === null) {
        this.sessionManager.resetLeaf();
      } else {
        this.sessionManager.branch(entry.parentId);
      }
      this.rebuildMessages();
      return { cancelled: false, editorText };
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

  /** 测试辅助：直接换脚本（复用同一 fake 会话跑多轮不同行为）。 */
  setScript(script: FakeTurnScript): void {
    this.script = script;
  }

  private async executeRun(text: string): Promise<void> {
    this.emit({ type: "agent_start" });
    await this.executeTurn(text);
    // Pi 0.85.1 steer 语义：同一 agent run 内追加 turn（单 agent_start）。
    while (this.steeringQueue.length > 0 && !this.aborted) {
      const steerText = this.steeringQueue.shift();
      if (steerText !== undefined) {
        await this.executeTurn(steerText);
      }
    }
    if (this.aborted) {
      this.emitSyntheticAborted();
    }
    this.emit({ type: "agent_end" });
    this.emit({ type: "agent_settled" });
    this.active = false;
    const resolvers = this.runResolvers;
    this.runResolvers = [];
    for (const resolve of resolvers) {
      resolve();
    }
  }

  private async executeTurn(text: string): Promise<void> {
    const delayMs = this.script.interDelayMs ?? 1;
    this.turnInputs.push(text);
    this.emit({ type: "turn_start" });
    this.emit({ type: "message_start", message: { role: "user" } });
    this.emit({ type: "message_end", message: { role: "user" } });
    this.sessionManager.appendMessage({ role: "user", text });
    await delay(delayMs);

    if (this.script.hang === true) {
      // 挂起：只发 assistant message_start，不推进（abort/dispose 可打断）。
      this.emit({ type: "message_start", message: { role: "assistant" } });
      while (this.active && !this.aborted && !this.disposed) {
        await delay(5);
      }
      this.rebuildMessages();
      return;
    }

    if (this.aborted) {
      this.emitSyntheticAborted();
      this.emit({ type: "turn_end", message: { role: "assistant", stopReason: "aborted" } });
      return;
    }

    const answer = this.script.answer;
    this.emit({ type: "message_start", message: { role: "assistant" } });
    const deltaCount = Math.max(1, this.script.deltaCount ?? 2);
    const chunkLength = Math.ceil(answer.length / deltaCount);
    for (let i = 0; i < deltaCount; i += 1) {
      if (this.aborted || this.disposed) {
        break;
      }
      const delta = answer.slice(i * chunkLength, (i + 1) * chunkLength);
      this.emit({
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
      });
      await delay(delayMs);
    }

    if (this.script.runError !== undefined) {
      // 失败收敛（Pi handleRunFailure）：合成 error 消息后 run 正常 resolve。
      const errorMessage = this.script.runError;
      this.emit({
        type: "message_end",
        message: { role: "assistant", stopReason: "error", errorMessage },
      });
      this.emit({
        type: "turn_end",
        message: { role: "assistant", stopReason: "error", errorMessage },
      });
      this.stateRef.errorMessage = errorMessage;
      this.sessionManager.appendMessage({ role: "assistant", text: "", stopReason: "error", errorMessage });
      this.rebuildMessages();
      return;
    }

    this.emit({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
    this.emit({ type: "turn_end", message: { role: "assistant", stopReason: "stop" } });
    this.sessionManager.appendMessage({ role: "assistant", text: answer, stopReason: "stop" });
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
    this.sessionManager.appendMessage({ role: "assistant", text: "", stopReason: "aborted", errorMessage: "aborted" });
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

export interface FakePortOptions {
  readonly version?: string;
  /** "provider/model" → 模型句柄。 */
  readonly models?: ReadonlyMap<string, PiPortModelHandle>;
  readonly defaultScript?: FakeTurnScript;
}

export class FakePiSdkPort implements PiSdkPort {
  readonly version: string;
  private readonly models: ReadonlyMap<string, PiPortModelHandle>;
  readonly defaultScript: FakeTurnScript;
  /** 每次 createServices 的调用记录（测试断言用）。 */
  readonly servicesCalls: Array<{ cwd: string; agentDir: string | undefined }> = [];
  readonly createdManagers: FakeSessionManager[] = [];
  /** createSession 产出的 fake 会话（测试可 setScript 复用）。 */
  readonly createdSessions: FakePiSession[] = [];

  constructor(options?: FakePortOptions) {
    this.version = options?.version ?? "0.85.1";
    this.models =
      options?.models ??
      new Map([
        ["fake-provider/fake-model", { provider: "fake-provider", id: "fake-model" }],
        ["fake-provider/fake-model-2", { provider: "fake-provider", id: "fake-model-2" }],
      ]);
    this.defaultScript = options?.defaultScript ?? { answer: "fake answer" };
  }

  async createServices(cwd: string, agentDir: string | undefined): Promise<PiPortServices> {
    this.servicesCalls.push({ cwd, agentDir });
    return {
      getModel: (providerId: string, modelId: string): PiPortModelHandle | undefined =>
        this.models.get(`${providerId}/${modelId}`),
    };
  }

  createSessionManager(cwd: string, sessionDir: string): PiPortSessionManager {
    if (!existsSync(sessionDir)) {
      mkdirSync(sessionDir, { recursive: true });
    }
    const manager = new FakeSessionManager(cwd, sessionDir, true);
    this.createdManagers.push(manager);
    return manager;
  }

  createInMemorySessionManager(cwd: string): PiPortSessionManager {
    const manager = new FakeSessionManager(cwd, undefined, false);
    this.createdManagers.push(manager);
    return manager;
  }

  openSessionManager(sessionFile: string): PiPortSessionManager {
    if (!existsSync(sessionFile)) {
      throw Object.assign(new Error(`ENOENT: no such file, open '${sessionFile}'`), { code: "ENOENT" });
    }
    const lines = readFileSync(sessionFile, "utf8").split("\n").filter((line) => line.length > 0);
    if (lines.length === 0) {
      throw new Error(`Session file is not a valid pi session: ${sessionFile}`);
    }
    let header: { id: string; cwd: string } | undefined;
    const firstLine = lines[0];
    if (firstLine === undefined) {
      throw new Error(`Session file is not a valid pi session: ${sessionFile}`);
    }
    try {
      const first = JSON.parse(firstLine) as Record<string, unknown>;
      if (first.type !== "session" || typeof first.id !== "string" || typeof first.cwd !== "string") {
        throw new Error(`Session file is not a valid pi session: ${sessionFile}`);
      }
      header = { id: first.id, cwd: first.cwd };
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Session file is not a valid")) {
        throw err;
      }
      throw new Error(`Session file is not a valid pi session: ${sessionFile}`);
    }
    const entries: FakeEntry[] = [];
    for (const line of lines.slice(1)) {
      entries.push(JSON.parse(line) as unknown as FakeEntry);
    }
    const manager = new FakeSessionManager(
      header.cwd,
      sessionFile,
      true,
      header.id,
      entries,
      sessionFile,
    );
    this.createdManagers.push(manager);
    return manager;
  }

  async createSession(input: PiPortCreateSessionInput): Promise<PiPortCreateSessionResult> {
    const manager = input.sessionManager as FakeSessionManager;
    // 镜像 Pi sdk.js createAgentSession 的模型/条目规则：
    // hasExistingSession = buildSessionContext().messages.length > 0。
    const hasExistingSession = manager.messageEntriesOnBranch().length > 0;
    const hasThinkingEntry = manager.entriesOnBranch().some((entry) => entry.type === "thinking_level_change");

    let model = input.model;
    let modelFallbackMessage: string | undefined;
    if (model === undefined && hasExistingSession) {
      // 恢复路径：从 model_change 恢复存储模型（失败 → 回退警告）。
      const modelChange = [...manager.entriesOnBranch()].reverse().find((entry) => entry.type === "model_change");
      if (modelChange !== undefined && modelChange.provider !== undefined && modelChange.modelId !== undefined) {
        model = this.models.get(`${modelChange.provider}/${modelChange.modelId}`);
        if (model === undefined) {
          modelFallbackMessage = `Could not restore model ${modelChange.provider}/${modelChange.modelId}`;
        }
      }
    }
    if (model === undefined) {
      // findInitialModel ≈ 环境默认（fake：模型表首项）。
      model = this.models.values().next().value;
      if (model === undefined) {
        modelFallbackMessage = "no models available";
      }
    }
    if (hasExistingSession) {
      if (!hasThinkingEntry) {
        manager.appendThinkingLevelChange();
      }
    } else {
      // Pi 对无消息条目的会话走「新会话」路径：追加 model_change + thinking。
      if (model !== undefined) {
        manager.appendModelChange(model.provider, model.id);
      }
      manager.appendThinkingLevelChange();
    }
    const session = new FakePiSession(manager, this.defaultScript, model);
    this.createdSessions.push(session);
    return { session, modelFallbackMessage };
  }
}

/** 便捷构造：默认 fake 端口 + 默认脚本。 */
export function makeFakePort(options?: FakePortOptions): FakePiSdkPort {
  return new FakePiSdkPort(options);
}
