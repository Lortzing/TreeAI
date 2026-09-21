/**
 * PiRuntime 核心实现：冻结契约 packages/contracts/src/pi-runtime.ts 的唯一实现。
 *
 * 关键设计（详见 README「设计与已知限制」）：
 *
 * 1. 端口隔离：本文件不 import Pi SDK；全部 Pi 访问经 PiSdkPort 结构接口。
 *    真实端口在 pi-real-port.ts（唯一 import Pi 的文件）；单测注入 fake。
 *    默认端口的装配在 index.ts（公开入口），因此 fake 单测的 import 图
 *    完全不触真实 SDK。
 *
 * 2. settle-once prompt 包装：prompt() 返回**本运行时自有**的 promise，
 *    不透传 Pi 的 promise。abort / dispose / 会话替换可直接以
 *    TreeAIError("user-abort") 收敛该 promise；另设安全计时器兜底
 *    （abort 被接受后若 Pi prompt 在 abortConvergenceMs 内未收敛则强制
 *    收敛），保证「abort 被接受即 resolve、prompt 随后必 settle、
 *    运行时回到非 streaming」的冻结语义。
 *
 * 3. 会话替换：create/restore 先完整建好新会话，成功后才原子替换
 *    （失败不动旧会话）；替换时旧订阅退订、后台清理旧会话、
 *    新会话自动重订阅，listener 依次收到 session.replaced → 新会话事件，
 *    seq 跨替换连续递增。
 *
 * 4. 失败归一：所有 promise 拒绝使用 TreeAIError（8 类，见 errors.ts）；
 *    调用方前置条件违规抛 TypeError（平台标准错误，契约边界）。
 *    非 user-abort 的失败在拒绝前推送 runtime.error（code+脱敏 message），
 *    供 event-journal 侧可见。
 */

import { existsSync } from "node:fs";
import type {
  PiPromptInput,
  PiPromptResult,
  PiRuntime,
  PiRuntimeEvent,
  PiRuntimeEventKind,
  PiRuntimeEventListener,
  PiSessionInit,
  PiSessionSnapshot,
  PiSteerInput,
  PiNavigateTreeTarget,
  PiUnsubscribe,
  PiVersion,
  PinnedPiVersion,
  SessionReference,
  TreeAIError,
} from "@treeai/contracts";
import type { JsonRecord } from "@treeai/contracts";
import {
  classifyPiFailure,
  modelUnavailableError,
  sessionCorruptError,
  TreeAIRuntimeError,
  userAbortError,
} from "./errors.ts";
import { normalizePiEvent } from "./events.ts";
import { redactText } from "./redact.ts";
import type {
  PiEventLike,
  PiPortModelHandle,
  PiPortSession,
  PiPortSessionManager,
  PiSdkPort,
  PiThinkingLevel,
} from "./pi-sdk-port.ts";

/** 冻结的 Pi 精确版本（contracts.PinnedPiVersion 的运行时值）。 */
export const PINNED_PI_VERSION: PinnedPiVersion = "0.85.1";

/** PiVersion 品牌化（"0.85.1" 字面量 → PiVersion）。 */
const PINNED_PI_VERSION_BRANDED: PiVersion = PINNED_PI_VERSION as PiVersion;

/** Pi 版本不一致时明确失败（工厂构造期抛出）。 */
export class PiVersionMismatchError extends Error {
  readonly actualVersion: string;
  readonly expectedVersion: string;

  constructor(actualVersion: string, expectedVersion: string) {
    super(
      `Pi SDK version mismatch: expected ${expectedVersion}, but loaded ${actualVersion}. ` +
        `TreeAI D2 pins @earendil-works/pi-coding-agent to exactly ${expectedVersion} ` +
        `(contracts.PinnedPiVersion); refusing to start the runtime.`,
    );
    this.name = "PiVersionMismatchError";
    this.actualVersion = actualVersion;
    this.expectedVersion = expectedVersion;
  }
}

/** 运行时工厂配置（契约备案：更细的运行时配置属实现工厂参数，不进冻结面）。 */
export interface PiRuntimeConfig {
  /** Pi SDK 端口。必填（默认真实端口的装配见 index.ts 的 createPiRuntime）。 */
  readonly port: PiSdkPort;
  /** Pi agent 目录（扩展/provider/auth.json/models.json 的加载根）。默认 Pi 自身默认（~/.pi/agent）。 */
  readonly agentDir?: string;
  /** 未指定 init.cwd 时的默认工作目录。默认 process.cwd()。 */
  readonly defaultCwd?: string;
  /** 新建会话的 thinking level。默认 "off"（D1 基线）。 */
  readonly thinkingLevel?: PiThinkingLevel;
  /** 工具 allowlist。默认 []（零工具启用，最小权限；ToolPolicy 集成时由宿主给出）。 */
  readonly tools?: readonly string[];
  /** abort 收敛安全计时器（毫秒）。默认 10000。 */
  readonly abortConvergenceMs?: number;
}

interface ActiveSession {
  readonly session: PiPortSession;
  readonly manager: PiPortSessionManager;
  readonly unsubscribe: () => void;
}

/** 在途 run 的簿记：settle-once + abort 请求标记 + 安全计时器。 */
interface InFlightRun {
  readonly session: PiPortSession;
  abortRequested: boolean;
  settled: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  reject: (error: TreeAIError) => void;
  resolve: (result: PiPromptResult) => void;
}

const DEFAULT_ABORT_CONVERGENCE_MS = 10_000;

/** 从 Pi SDK 版本加载运行时（版本校验在构造期，不匹配即抛）。 */
export function createPiRuntimeFromConfig(config: PiRuntimeConfig): PiRuntime {
  return new PiRuntimeImpl(config);
}

class PiRuntimeImpl implements PiRuntime {
  private readonly port: PiSdkPort;
  private readonly agentDir: string | undefined;
  private readonly defaultCwd: string;
  private readonly thinkingLevel: PiThinkingLevel;
  private readonly tools: readonly string[];
  private readonly abortConvergenceMs: number;

  private readonly listeners = new Set<PiRuntimeEventListener>();
  private seq = 0;
  private disposed = false;
  private active: ActiveSession | null = null;
  private inFlight: InFlightRun | null = null;

  constructor(config: PiRuntimeConfig) {
    if (config.port === null || typeof config.port !== "object") {
      throw new TypeError("createPiRuntimeFromConfig requires a PiSdkPort (config.port)");
    }
    if (config.port.version !== PINNED_PI_VERSION) {
      throw new PiVersionMismatchError(config.port.version, PINNED_PI_VERSION);
    }
    this.port = config.port;
    this.agentDir = config.agentDir;
    this.defaultCwd = config.defaultCwd ?? process.cwd();
    this.thinkingLevel = config.thinkingLevel ?? "off";
    this.tools = config.tools ?? [];
    this.abortConvergenceMs = config.abortConvergenceMs ?? DEFAULT_ABORT_CONVERGENCE_MS;
  }

  get piVersion(): PiVersion {
    return PINNED_PI_VERSION_BRANDED;
  }

  /* ---------------------------------------------------------------- */
  /* 会话创建 / 恢复                                                    */
  /* ---------------------------------------------------------------- */

  async createSession(init: PiSessionInit): Promise<PiSessionSnapshot> {
    this.assertNotDisposed();
    if (init === null || typeof init !== "object") {
      throw new TypeError("createSession requires a PiSessionInit object");
    }
    if (
      init.model === null ||
      typeof init.model !== "object" ||
      typeof init.model.providerId !== "string" ||
      typeof init.model.modelId !== "string" ||
      init.model.providerId === "" ||
      init.model.modelId === ""
    ) {
      throw new TypeError("createSession requires init.model with non-empty providerId and modelId strings");
    }
    if (init.cwd !== undefined && typeof init.cwd !== "string") {
      throw new TypeError("createSession: init.cwd must be a string when provided");
    }
    if (init.sessionDir !== undefined && typeof init.sessionDir !== "string") {
      throw new TypeError("createSession: init.sessionDir must be a string when provided");
    }

    const cwd = init.cwd ?? this.defaultCwd;
    try {
      const services = await this.port.createServices(cwd, this.agentDir);
      const model = services.getModel(init.model.providerId, init.model.modelId);
      if (model === undefined) {
        throw modelUnavailableError(
          `model not found in the loaded Pi provider registry: ${init.model.providerId}/${init.model.modelId}`,
          {
            details: { providerId: init.model.providerId, modelId: init.model.modelId },
          },
        );
      }
      const manager =
        init.sessionDir === undefined
          ? this.port.createInMemorySessionManager(cwd)
          : this.port.createSessionManager(cwd, init.sessionDir);
      const created = await this.port.createSession({
        services,
        sessionManager: manager,
        model,
        thinkingLevel: this.thinkingLevel,
        tools: this.tools,
      });
      if (created.session.model === undefined) {
        throw modelUnavailableError(
          "Pi created the session without a usable model",
          { details: { providerId: init.model.providerId, modelId: init.model.modelId } },
        );
      }
      await this.swapActiveSession(created.session, manager, "session.created");
      return { reference: this.referenceFromActive() };
    } catch (err) {
      throw this.toReportedError(err, "createSession");
    }
  }

  async restoreSession(reference: SessionReference): Promise<PiSessionSnapshot> {
    this.assertNotDisposed();
    if (
      reference === null ||
      typeof reference !== "object" ||
      typeof reference.sessionId !== "string" ||
      typeof reference.sessionFile !== "string" ||
      typeof reference.entryId !== "string" ||
      typeof reference.piVersion !== "string" ||
      reference.sessionId === "" ||
      reference.piVersion === ""
    ) {
      throw new TypeError(
        "restoreSession requires a SessionReference with non-empty sessionId/piVersion and string sessionFile/entryId",
      );
    }

    // 版本兼容：契约要求版本不一致以 session-corrupt 拒绝（version-mismatch）。
    if (reference.piVersion !== PINNED_PI_VERSION) {
      throw sessionCorruptError(
        `session reference was produced by Pi ${reference.piVersion}, this runtime pins ${PINNED_PI_VERSION}`,
        {
          details: {
            reason: "version-mismatch",
            referenceVersion: reference.piVersion,
            runtimeVersion: PINNED_PI_VERSION,
          },
        },
      );
    }
    // 内存会话引用不可恢复（无文件）；空 sessionFile 视为缺失。
    if (reference.sessionFile === "") {
      throw sessionCorruptError(
        "session reference has no session file (in-memory sessions cannot be restored)",
        { details: { reason: "missing-file" } },
      );
    }
    // Pi 的 SessionManager.open 对缺失文件不抛错（会隐式新建并写文件），
    // 因此必须先自行校验存在性，避免在用户文件系统留下垃圾文件。
    if (!existsSync(reference.sessionFile)) {
      throw sessionCorruptError("session file does not exist", {
        details: { reason: "missing-file", sessionFile: redactText(reference.sessionFile) },
      });
    }

    let manager: PiPortSessionManager;
    try {
      manager = this.port.openSessionManager(reference.sessionFile);
    } catch (err) {
      throw sessionCorruptError("session file could not be opened or parsed", {
        details: { reason: "corrupt", sessionFile: redactText(reference.sessionFile) },
        cause: err,
      });
    }
    if (manager.getSessionId() !== reference.sessionId) {
      throw sessionCorruptError("session file does not contain the referenced session id", {
        details: { reason: "corrupt", kind: "session-id-mismatch" },
      });
    }

    const leafId = manager.getLeafId();
    if (reference.entryId === "") {
      if (leafId !== null) {
        throw sessionCorruptError(
          "reference points at the session root, but the session file has entries (stale reference)",
          { details: { reason: "corrupt", kind: "stale-root-reference" } },
        );
      }
    } else {
      if (manager.getEntry(reference.entryId) === undefined) {
        throw sessionCorruptError("referenced entry does not exist in the session file", {
          details: { reason: "corrupt", kind: "entry-not-found" },
        });
      }
      if (leafId !== reference.entryId) {
        // 叶指针对齐到引用位置（Pi 公开 branch()，不写文件）。
        manager.branch(reference.entryId);
      }
    }

    // 恢复使用 session 存储的 cwd（Pi header），保证工具执行工作区一致。
    const sessionCwd = this.resolveManagerCwd(manager);
    // 记录恢复前叶位置：Pi 对「无消息条目」的会话走新会话路径并追加
    // 条目（公开 API 无抑制选项）；恢复后把叶指针移回，保证返回引用
    // 与输入引用的 entryId 一致（已知限制，见 README）。
    const leafBeforeCreate = manager.getLeafId();
    try {
      const services = await this.port.createServices(sessionCwd, this.agentDir);

      // 模型固定：从当前分支上最近的 model_change 恢复存储模型并显式传入。
      // 不依赖 Pi 的隐式恢复（其对无消息条目的会话会改用 findInitialModel，
      // 可能静默替换模型，破坏可复现性）。
      const storedModel = findStoredModelOnBranch(manager);
      let model: PiPortModelHandle | undefined;
      if (storedModel !== undefined) {
        model = services.getModel(storedModel.provider, storedModel.modelId);
        if (model === undefined) {
          throw modelUnavailableError(
            `restored session's stored model is not resolvable in the loaded Pi provider registry: ${storedModel.provider}/${storedModel.modelId}`,
            {
              details: {
                providerId: storedModel.provider,
                modelId: storedModel.modelId,
              },
            },
          );
        }
      }

      const restored = await this.port.createSession({
        services,
        sessionManager: manager,
        model,
      });
      if (
        restored.session.model === undefined ||
        restored.modelFallbackMessage !== undefined
      ) {
        throw modelUnavailableError(
          "restored session could not use its stored model (missing, unloaded provider, or fallback)",
          {
            details: {
              ...(restored.modelFallbackMessage === undefined
                ? {}
                : { fallbackMessage: redactText(restored.modelFallbackMessage) }),
            },
          },
        );
      }
      // 叶指针回位（仅当 Pi 在恢复中追加了条目时发生移动）。
      const leafAfterCreate = manager.getLeafId();
      if (leafAfterCreate !== leafBeforeCreate) {
        if (leafBeforeCreate === null) {
          manager.resetLeaf();
        } else {
          manager.branch(leafBeforeCreate);
        }
      }
      await this.swapActiveSession(restored.session, manager, "session.restored");
      return { reference: this.referenceFromActive() };
    } catch (err) {
      throw this.toReportedError(err, "restoreSession");
    }
  }

  /* ---------------------------------------------------------------- */
  /* prompt / steer / abort / navigateTree                              */
  /* ---------------------------------------------------------------- */

  prompt(input: PiPromptInput): Promise<PiPromptResult> {
    this.assertNotDisposed();
    if (input === null || typeof input !== "object" || typeof input.text !== "string") {
      throw new TypeError("prompt requires a PiPromptInput with a string text");
    }
    const active = this.requireActiveSession("prompt");
    if (this.inFlight !== null) {
      throw new TypeError(
        "a prompt is already in flight on this runtime; use steer() to queue input or abort() first",
      );
    }

    return new Promise<PiPromptResult>((resolve, reject) => {
      const run: InFlightRun = {
        session: active.session,
        abortRequested: false,
        settled: false,
        timer: undefined,
        reject,
        resolve,
      };
      this.inFlight = run;
      void this.drivePrompt(active, input.text, run);
    });
  }

  private async drivePrompt(
    active: ActiveSession,
    text: string,
    run: InFlightRun,
  ): Promise<void> {
    try {
      await active.session.prompt(text);
    } catch (err) {
      if (run.settled) {
        return;
      }
      const error = classifyPiFailure(err, "Pi prompt failed");
      if (error.code === "user-abort") {
        this.settleRun(run, undefined, userAbortError("prompt was aborted", { cause: err }));
        return;
      }
      this.reportRuntimeError(error);
      this.settleRun(run, undefined, error);
      return;
    }
    if (run.settled) {
      return;
    }

    // Pi 的 prompt 正常 resolve：从会话终态判定结果。
    const lastAssistant = lastAssistantMessage(active.session);
    const stopReason = lastAssistant?.stopReason;
    const stateError = active.session.state.errorMessage;

    if (run.abortRequested || stopReason === "aborted") {
      this.settleRun(run, undefined, userAbortError("prompt was aborted"));
      return;
    }
    if (stopReason === "error" || (typeof stateError === "string" && stateError.length > 0)) {
      const message =
        (typeof stateError === "string" && stateError.length > 0
          ? stateError
          : lastAssistant?.errorMessage) ?? "assistant turn failed";
      const error = classifyPiFailure(new Error(message), "Pi run failed");
      this.reportRuntimeError(error);
      this.settleRun(run, undefined, error);
      return;
    }
    const message = active.session.getLastAssistantText() ?? "";
    this.settleRun(run, { message, reference: this.referenceFromActive() }, undefined);
  }

  async steer(input: PiSteerInput): Promise<void> {
    this.assertNotDisposed();
    if (input === null || typeof input !== "object" || typeof input.text !== "string") {
      throw new TypeError("steer requires a PiSteerInput with a string text");
    }
    const active = this.requireActiveSession("steer");
    const run = this.inFlight;
    if (run === null) {
      throw new TypeError("steer requires an in-flight prompt (none is running)");
    }
    if (run.session !== active.session) {
      throw new TypeError("steer requires an in-flight prompt on the active session");
    }
    try {
      await active.session.steer(input.text);
    } catch (err) {
      throw this.toReportedError(err, "steer");
    }
    this.emitEvent("steer.enqueued", {});
  }

  async abort(): Promise<void> {
    this.assertNotDisposed();
    const run = this.inFlight;
    if (run === null || run.settled) {
      return; // 幂等：无在途 run 时静默 no-op。
    }
    if (run.abortRequested) {
      return; // 已请求过：不重复推送事件 / 不重复调用 Pi abort。
    }
    run.abortRequested = true;
    this.emitEvent("run.abort-requested", {});
    this.armSafetyTimer(run);
    try {
      await run.session.abort();
      // prompt 由 drivePrompt 的后续正常收敛（Pi abort 等待 run 空闲后 resolve）。
    } catch (err) {
      // abort 路径自身失败：强制收敛 prompt 保证契约（非 streaming），
      // 并把失败以 runtime.error 上报。
      const error = classifyPiFailure(err, "Pi abort failed");
      this.reportRuntimeError(error);
      this.settleRun(run, undefined, userAbortError("prompt was aborted (abort path failed)", { cause: err }));
    }
  }

  async navigateTree(target: PiNavigateTreeTarget): Promise<SessionReference> {
    this.assertNotDisposed();
    if (
      target === null ||
      typeof target !== "object" ||
      typeof target.entryId !== "string" ||
      target.entryId === ""
    ) {
      throw new TypeError("navigateTree requires a target with a non-empty entryId string");
    }
    const active = this.requireActiveSession("navigateTree");
    if (this.inFlight !== null) {
      throw new TypeError("navigateTree requires no in-flight prompt (wait for it to settle or abort first)");
    }

    const manager = active.manager;
    const entry = manager.getEntry(target.entryId);
    if (entry === undefined) {
      throw sessionCorruptError("navigateTree target entry does not exist in the session", {
        details: { reason: "corrupt", kind: "entry-not-found" },
      });
    }

    const beforeId = active.session.sessionId;
    const beforeFile = active.session.sessionFile;
    const beforeEntryCount = manager.getEntries().length;

    let result;
    try {
      result = await active.session.navigateTree(target.entryId);
    } catch (err) {
      throw this.toReportedError(err, "navigateTree");
    }
    if (result.cancelled) {
      // 仅扩展 cancel 钩子可触发；导航没有发生，如实失败。
      throw classifyPiFailure(
        new Error("tree navigation was cancelled before it took effect"),
        "navigateTree cancelled",
      );
    }

    // D2 回归不变量：同 session / 同文件 / 追加式树。
    if (
      active.session.sessionId !== beforeId ||
      active.session.sessionFile !== beforeFile ||
      manager.getEntries().length !== beforeEntryCount
    ) {
      const error = classifyPiFailure(
        new Error("navigateTree violated the same-session invariant (session id/file or entry count changed)"),
        "navigateTree invariant",
      );
      this.reportRuntimeError(error);
      throw error;
    }

    const newLeaf = manager.getLeafId() ?? "";
    this.emitEvent("tree.navigated", {
      targetEntryId: target.entryId,
      leafEntryId: newLeaf,
      sessionId: active.session.sessionId,
    });
    return this.referenceFromActive();
  }

  /* ---------------------------------------------------------------- */
  /* 订阅 / 释放                                                        */
  /* ---------------------------------------------------------------- */

  subscribe(listener: PiRuntimeEventListener): PiUnsubscribe {
    this.assertNotDisposed();
    if (typeof listener !== "function") {
      throw new TypeError("subscribe requires a listener function");
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener); // 退订幂等，dispose 后调用仍安全。
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return; // 幂等：重复调用安全 resolve。
    }
    this.disposed = true;

    const run = this.inFlight;
    if (run !== null && !run.settled) {
      this.settleRun(run, undefined, userAbortError("runtime disposed while a prompt was in flight"));
    }
    const active = this.active;
    this.active = null;
    this.listeners.clear();

    if (active !== null) {
      await this.cleanupSessionInBackground(active.session);
    }
  }

  /* ---------------------------------------------------------------- */
  /* 内部：会话替换 / 事件 / 收敛                                        */
  /* ---------------------------------------------------------------- */

  /**
   * 原子替换活跃会话：新会话已创建成功后才执行；
   * 在途 run 以 user-abort 收敛（宿主发起的终止），旧会话后台清理，
   * 新会话重订阅后推送 created/restored。
   */
  private async swapActiveSession(
    session: PiPortSession,
    manager: PiPortSessionManager,
    lifecycleKind: "session.created" | "session.restored",
  ): Promise<void> {
    const old = this.active;
    const oldRun = this.inFlight;
    if (old !== null) {
      if (oldRun !== null && !oldRun.settled) {
        this.settleRun(
          oldRun,
          undefined,
          userAbortError("active session was replaced while a prompt was in flight"),
        );
      }
      old.unsubscribe();
      this.emitEvent("session.replaced", { sessionId: old.session.sessionId });
      void this.cleanupSessionInBackground(old.session);
    }
    const unsubscribe = session.subscribe((event) => {
      this.handlePiEvent(session, event);
    });
    this.active = { session, manager, unsubscribe };
    this.emitEvent(lifecycleKind, {
      sessionId: session.sessionId,
      sessionFile: session.sessionFile ?? "",
    });
  }

  /** 后台清理旧/被替换会话：尽力 abort 后 dispose，超时兜底，绝不 reject。 */
  private async cleanupSessionInBackground(session: PiPortSession): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          try {
            await session.abort();
          } catch {
            // 尽力而为：清理路径的失败不外泄。
          }
          session.dispose();
        })(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.abortConvergenceMs);
          timer.unref?.();
        }),
      ]);
    } catch {
      // 理论不可达（race 的两条路径都不 reject）；防御性吞掉。
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  /** Pi 事件入口：只处理当前活跃会话的事件（防替换后的迟到事件）。 */
  private handlePiEvent(session: PiPortSession, event: PiEventLike): void {
    if (this.disposed) {
      return;
    }
    const active = this.active;
    if (active === null || active.session !== session) {
      return;
    }
    const normalized = normalizePiEvent(event);
    if (normalized !== null) {
      this.emitEvent(normalized.kind, normalized.payload);
    }
  }

  /** 统一事件出口：分配 seq（生命周期内严格递增、跨替换连续）、脱敏由构造侧保证。 */
  private emitEvent(kind: PiRuntimeEventKind, payload: JsonRecord): void {
    if (this.disposed) {
      return;
    }
    this.seq += 1;
    const event: PiRuntimeEvent = {
      eventId: `pi-runtime-${this.seq}` as PiRuntimeEvent["eventId"],
      seq: this.seq,
      occurredAt: new Date().toISOString(),
      kind,
      payload,
    };
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // 监听器异常不得破坏运行时（吞掉；由监听器方负责自身健壮性）。
      }
    }
  }

  /** 非 user-abort 失败的可见性事件（code + 脱敏 message）。 */
  private reportRuntimeError(error: TreeAIError): void {
    if (error.code === "user-abort") {
      return;
    }
    this.emitEvent("runtime.error", { code: error.code, message: error.message });
  }

  /** settle-once：计时器清理 + inFlight 摘除 + 单次 settle。 */
  private settleRun(
    run: InFlightRun,
    result: PiPromptResult | undefined,
    error: TreeAIError | undefined,
  ): void {
    if (run.settled) {
      return;
    }
    run.settled = true;
    if (run.timer !== undefined) {
      clearTimeout(run.timer);
      run.timer = undefined;
    }
    if (this.inFlight === run) {
      this.inFlight = null;
    }
    if (error !== undefined) {
      run.reject(error);
    } else if (result !== undefined) {
      run.resolve(result);
    }
  }

  private armSafetyTimer(run: InFlightRun): void {
    if (run.timer !== undefined || run.settled) {
      return;
    }
    run.timer = setTimeout(() => {
      if (!run.settled) {
        this.settleRun(
          run,
          undefined,
          userAbortError("prompt was aborted (convergence safety timer)"),
        );
      }
    }, this.abortConvergenceMs);
    run.timer.unref?.();
  }

  /** 从活跃会话生成引用三元组（+版本/可用性）。 */
  private referenceFromActive(): SessionReference {
    const active = this.requireActiveSession("referenceFromActive");
    return {
      sessionId: active.session.sessionId as SessionReference["sessionId"],
      sessionFile: active.session.sessionFile ?? "",
      entryId: (active.manager.getLeafId() ?? "") as SessionReference["entryId"],
      piVersion: PINNED_PI_VERSION_BRANDED,
      availability: { status: "available" },
    };
  }

  private resolveManagerCwd(manager: PiPortSessionManager): string {
    const cwd = manager.getCwd();
    return typeof cwd === "string" && cwd.length > 0 ? cwd : this.defaultCwd;
  }

  private requireActiveSession(method: string): ActiveSession {
    if (this.active === null) {
      throw new TypeError(
        `${method} requires an active session (call createSession or restoreSession first)`,
      );
    }
    return this.active;
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new TypeError("this PiRuntime instance has been disposed; only dispose() may be called");
    }
  }

  /**
   * 统一失败出口：TreeAIError 透传，其他按上下文归类；
   * 非 user-abort 先推送 runtime.error（code + 脱敏 message）再返回给调用方抛出。
   */
  private toReportedError(err: unknown, context: string): TreeAIError {
    const error =
      err instanceof TreeAIRuntimeError
        ? err
        : classifyPiFailure(err, `${context} failed`);
    this.reportRuntimeError(error);
    return error;
  }
}

/** 会话消息表里最后一条 assistant 消息（失败判定的权威位置）。 */
function lastAssistantMessage(session: PiPortSession): { stopReason?: string; errorMessage?: string } | undefined {
  const messages = session.messages;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message !== null && typeof message === "object" && message.role === "assistant") {
      return message;
    }
  }
  return undefined;
}

/**
 * 沿当前分支（叶→根）找最近的 model_change 条目，
 * 返回其 provider/modelId（restore 的模型固定来源）。
 */
function findStoredModelOnBranch(
  manager: PiPortSessionManager,
): { provider: string; modelId: string } | undefined {
  let cursor = manager.getLeafId();
  let steps = 0;
  while (cursor !== null) {
    steps += 1;
    if (steps > 100_000) {
      return undefined; // 防御：异常环形结构不至于死循环。
    }
    const entry = manager.getEntry(cursor);
    if (entry === undefined) {
      return undefined;
    }
    if (entry.type === "model_change" && typeof entry.provider === "string" && typeof entry.modelId === "string") {
      return { provider: entry.provider, modelId: entry.modelId };
    }
    cursor = entry.parentId;
  }
  return undefined;
}
