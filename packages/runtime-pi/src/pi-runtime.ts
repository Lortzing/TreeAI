import {
  RuntimeSessionCoordinator,
} from "./session-coordinator.ts";
import type {
  ActiveSession,
  InFlightRun,
} from "./runtime-state.ts";
import {
  PINNED_PI_VERSION,
  PINNED_PI_VERSION_BRANDED,
  PiVersionMismatchError,
} from "./version.ts";
export { PINNED_PI_VERSION, PiVersionMismatchError } from "./version.ts";
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


import {
  lastAssistantMessage,
} from "./session-inspection.ts";
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
  SessionReference,
  ToolDecision,
  TreeAIError,
} from "@treeai/contracts";
import type {
  JsonRecord,
} from "@treeai/contracts";
import {
  classifyPiFailure,
  policyDeniedError,
  TreeAIRuntimeError,
  userAbortError,
} from "./errors.ts";
import {
  normalizePiEvent,
} from "./events.ts";

import type {
  PiEventLike,
  PiPortSession,
  PiPortSessionManager,
  PiSdkPort,
  PiThinkingLevel,
} from "./pi-sdk-port.ts";
import type {
  PiToolPolicyEvaluator,
} from "./tool-policy.ts";
import {
  classifyPiToolCall,
} from "./tool-policy.ts";

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
  /**
   * 请求时工具策略评估器（issue #5 P0；@treeai/tool-policy 的
   * ToolPolicyEngine 结构满足本接口，由宿主注入）。注入后，本运行时
   * 创建/恢复的每个会话在**实际工具执行前**（参数校验后）经
   * evaluate() 评估（映射见 tool-policy.ts 的 classifyPiToolCall）：
   * - allow → 放行执行（执行事件照常以 tool.execution.started/finished
   *   上报）；
   * - deny / require-approval → **不执行**（require-approval 在本路径没有
   *   审批 UI，按 fail-closed 拒绝，与 contracts "policy-denied" 的语义
   *   一致），以 `tool.decision` 事件上报决定（toolName/outcome/category/
   *   risk/reason/ruleId 白名单字段，绝不携带参数/路径/命令），当前
   *   in-flight run 以 TreeAIError("policy-denied") 收敛（fail closed，
   *   见 README）。
   */
  readonly toolPolicy?: PiToolPolicyEvaluator;
  /** abort 收敛安全计时器（毫秒）。默认 10000。 */
  readonly abortConvergenceMs?: number;
}

const DEFAULT_ABORT_CONVERGENCE_MS = 10_000;

/** 从 Pi SDK 版本加载运行时（版本校验在构造期，不匹配即抛）。 */
export function createPiRuntimeFromConfig(config: PiRuntimeConfig): PiRuntime {
  return new PiRuntimeImpl(config);
}

class PiRuntimeImpl implements PiRuntime {
  private readonly sessions: RuntimeSessionCoordinator;
  private readonly port: PiSdkPort;
  private readonly agentDir: string | undefined;
  private readonly defaultCwd: string;
  private readonly thinkingLevel: PiThinkingLevel;
  private readonly tools: readonly string[];
  private readonly toolPolicy: PiToolPolicyEvaluator | undefined;
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
    this.toolPolicy = config.toolPolicy;
    this.abortConvergenceMs = config.abortConvergenceMs ?? DEFAULT_ABORT_CONVERGENCE_MS;
    const runtime = this;
    this.sessions = new RuntimeSessionCoordinator({
      port: this.port, agentDir: this.agentDir, defaultCwd: this.defaultCwd,
      thinkingLevel: this.thinkingLevel, tools: this.tools,
      get inFlight() { return runtime.inFlight; },
      assertNotDisposed: () => this.assertNotDisposed(),
      requireActiveSession: (method) => this.requireActiveSession(method),
      swapActiveSession: (session, manager, kind) => this.swapActiveSession(session, manager, kind),
      installToolGate: (session) => this.installToolGate(session),
      toReportedError: (err, context) => this.toReportedError(err, context),
      reportRuntimeError: (error) => this.reportRuntimeError(error),
      emitEvent: (kind, payload) => this.emitEvent(kind, payload),
    });
  }

  get piVersion(): PiVersion {
    return PINNED_PI_VERSION_BRANDED;
  }
  createSession(init: PiSessionInit): Promise<PiSessionSnapshot> {
    return this.sessions.createSession(init);
  }

  restoreSession(reference: SessionReference): Promise<PiSessionSnapshot> {
    return this.sessions.restoreSession(reference);
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
        policyDenial: null,
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
    if (run.policyDenial !== null) {
      // 请求时策略拒绝（fail closed）：工具未执行、决定已以 tool.decision
      // 上报、runtime.error 已在拒绝发生时即时推送（见 installToolGate）；
      // 这里只收敛 prompt（先于模型错误判定——宿主的越权拒绝是对本次
      // run 的权威结论；abort 请求仍然优先）。
      const error = policyDeniedError(
        `tool execution was blocked by tool policy: ${run.policyDenial.reason}`,
        { details: { reason: run.policyDenial.reason } },
      );
      this.settleRun(run, undefined, error);
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
  navigateTree(target: PiNavigateTreeTarget): Promise<SessionReference> {
    return this.sessions.navigateTree(target);
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
   * 请求时工具执行门（issue #5 P0）：评估先于执行——allow 放行；
   * deny / require-approval 阻止执行（fail closed，require-approval 在
   * 本路径无审批 UI，按拒绝处理）并记录到当前 in-flight run（收敛依据）。
   * 决定以 tool.decision 事件上报（白名单字段，见 #emitToolDecision）；
   * 首次拒绝即时推送 runtime.error（policy-denied）——必须在会话的
   * agent.settled（无 status）之前到达 journal，否则投影器会先把 run
   * 收敛为 succeeded 再产生 double-terminal 异常（见 README 已知限制）。
   * 未注入 toolPolicy 时不安装（行为不变）。
   */
  private installToolGate(session: PiPortSession): void {
    const evaluator = this.toolPolicy;
    if (evaluator === undefined) {
      return;
    }
    session.installToolExecutionGate(async (request) => {
      const decision = evaluator.evaluate(classifyPiToolCall(request));
      const isActiveSession = this.active !== null && this.active.session === session;
      if (isActiveSession) {
        this.emitToolDecision(request.toolName, decision);
      }
      if (decision.outcome === "allow") {
        return undefined; // 放行：后续 tool.execution.started/finished 照常上报。
      }
      if (isActiveSession) {
        const run = this.inFlight;
        if (run !== null && run.session === session && !run.settled && run.policyDenial === null) {
          run.policyDenial = { reason: decision.reason };
          // 即时失败可见性（先于 agent.settled 到达 journal，见方法头）。
          this.reportRuntimeError(
            policyDeniedError(`tool execution was blocked by tool policy: ${decision.reason}`, {
              details: { reason: decision.reason },
            }),
          );
        }
      }
      // 阻止执行 + 提示底层运行时在当前工具批次后提前结束（确定性收敛）。
      return { block: true, reason: decision.reason, terminate: true };
    });
  }

  /**
   * tool.decision 事件（journal 侧 KnownTreeAIEventType "tool.decision"）。
   * 载荷是白名单投影：工具名 + 决定判别字段 + 固定模板 reason + 规则 id；
   * 工具参数、目标路径、命令、主机**绝不**进入载荷（脱敏边界与
   * tool-activity 的工具名+阶段纪律一致；完整审计含规范化路径留在
   * 引擎自身的审计环形日志）。
   */
  private emitToolDecision(toolName: string, decision: ToolDecision): void {
    this.emitEvent("tool.decision", {
      toolName,
      decision: decision.outcome,
      category: decision.category,
      risk: decision.risk,
      reason: decision.reason,
      ruleId: decision.ruleId,
    });
  }

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
  private referenceFromActive(): SessionReference {
    return this.sessions.referenceFromActive();
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
