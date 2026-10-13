/** Instance UI event projection, ordered journal writes/recovery and the safe policy ring. */
import type {
  EventJournal,
  RecoveryReport,
} from "@treeai/event-journal";
import {
  EventRecorder,
  piRuntimeEventKindToType,
} from "@treeai/event-journal";
import type {
  JsonRecord,
  PiRuntimeEvent,
  RunId,
  RunState,
} from "@treeai/contracts";
import type {
  ActiveRunRecord,
  PolicyDecisionView,
  StudioEvent,
  StudioEventListener,
} from "./model.ts";
import {
  payloadRuleId,
  payloadString,
} from "./event-summary.ts";

export class StudioEventObserver {
  readonly #journal: EventJournal | null;
  readonly #recorder: EventRecorder | null;
  #journalTail: Promise<void> = Promise.resolve();
  readonly journalRecovery: Promise<RecoveryReport> | null;
  readonly #studioListeners = new Set<StudioEventListener>();
  readonly #policyObservations: PolicyDecisionView[] = [];
  readonly #getActiveRun: () => ActiveRunRecord | null;
  readonly #getPrelude: () => PiRuntimeEvent[] | null;
  constructor(options: {
    journal: EventJournal | null;
    getActiveRun: () => ActiveRunRecord | null;
    getPrelude: () => PiRuntimeEvent[] | null;
  }) {
    this.#journal = options.journal;
    this.#getActiveRun = options.getActiveRun;
    this.#getPrelude = options.getPrelude;
    this.#recorder = this.#journal === null ? null : new EventRecorder(this.#journal);
    if (this.#journal !== null) {
      // I6 重启恢复（journal 面）：构造时把 journal 中仍非终态的 run 收敛为
      // failed（host-crash 语义，与下方 DB 恢复一致）。失败不挂进程；测试
      // 与宿主可经 journalRecovery await 确定性观测。
      const recovery = this.#journal.recoverInterruptedRuns("host-crash");
      recovery.catch(() => undefined);
      this.journalRecovery = recovery;
    } else {
      this.journalRecovery = null;
    }
  }
  get policyObservations(): readonly PolicyDecisionView[] { return this.#policyObservations; }
  flushJournal(): Promise<void> { return this.#journalTail; }
  clearListeners(): void { this.#studioListeners.clear(); }

  /**
   * 订阅安全 UI 事件（run-started / message-delta / abort-requested /
   * run-terminal / tool-activity）。可多订阅；返回退订函数（幂等）。
   * dispose 后不再推送。
   */
  subscribeStudioEvents(listener: StudioEventListener): () => void {
    this.#studioListeners.add(listener);
    return () => {
      this.#studioListeners.delete(listener);
    };
  }

  emitStudio(event: StudioEvent): void {
    for (const listener of [...this.#studioListeners]) {
      try {
        listener(event);
      } catch {
        // 监听器异常不得影响服务（与 runtime 的监听纪律一致）。
      }
    }
  }

  /**
   * 运行时事件入口：journal 归属（在途 run 实时归属；会话对准阶段缓冲）
   * + 事件面投影（message-delta / tool-activity，仅在途 run）。
   * 绝不向事件面搬运 payload 原文（工具参数/路径/命令不出境）。
   * tool.decision（P0 请求时策略门）：记入诊断观测（脱敏投影）；
   * 拒绝类决定（deny / require-approval）以 tool-activity(phase "denied")
   * + 决定 provenance 推送（allow 的执行生命周期由后续
   * tool.execution.started/finished 事件表达）。
   */
  handleRuntimeEvent(event: PiRuntimeEvent): void {
    const active = this.#getActiveRun();
    const prelude = this.#getPrelude();
    if (active !== null) {
      this.journalRuntimeEvent(active.runId, event);
    } else if (prelude !== null) {
      prelude.push(event);
    }
    if (event.kind === "tool.decision") {
      this.#observePolicyDecision(event);
    }
    if (active === null) return;
    switch (event.kind) {
      case "message.updated": {
        const delta = payloadString(event.payload, "delta");
        if (delta !== undefined) {
          this.emitStudio({ type: "message-delta", treeId: active.treeId, runId: active.runId, delta });
        }
        return;
      }
      case "tool.execution.started":
      case "tool.execution.finished": {
        this.emitStudio({
          type: "tool-activity",
          treeId: active.treeId,
          runId: active.runId,
          tool: payloadString(event.payload, "toolName") ?? null,
          phase: event.kind === "tool.execution.started" ? "started" : "finished",
        });
        return;
      }
      case "tool.decision": {
        const outcome = payloadString(event.payload, "decision");
        if (outcome === "deny" || outcome === "require-approval") {
          this.emitStudio({
            type: "tool-activity",
            treeId: active.treeId,
            runId: active.runId,
            tool: payloadString(event.payload, "toolName") ?? null,
            phase: "denied",
            decision: {
              outcome,
              reason: payloadString(event.payload, "reason") ?? "tool policy decision",
              ruleId: payloadRuleId(event.payload),
            },
          });
        }
        return;
      }
      default:
        return;
    }
  }

  /**
   * 记录一条策略决策观测（白名单字段；参数/路径/命令/主机绝不进入）。
   * 形状不符的事件按诚实边界忽略（不伪造观测）；环形上限 20 条。
   */
  #observePolicyDecision(event: PiRuntimeEvent): void {
    const outcome = payloadString(event.payload, "decision");
    if (outcome !== "allow" && outcome !== "deny" && outcome !== "require-approval") {
      return;
    }
    const view: PolicyDecisionView = {
      tool: payloadString(event.payload, "toolName") ?? null,
      outcome,
      category: payloadString(event.payload, "category") ?? "unknown",
      risk: payloadString(event.payload, "risk") ?? "unknown",
      reason: payloadString(event.payload, "reason") ?? "tool policy decision",
      ruleId: payloadRuleId(event.payload),
      occurredAt: event.occurredAt,
    };
    this.#policyObservations.push(view);
    if (this.#policyObservations.length > 20) {
      this.#policyObservations.splice(0, this.#policyObservations.length - 20);
    }
  }

  /**
   * 归一化运行时事件 → journal 追加（保序串行链）。
   * eventId 由 journal 生成（evt-<uuid>）：journal 文件跨重启复用，而
   * runtime 的 per-instance pi-runtime-<seq> 会撞 journal 全局 eventId
   * 唯一性；原始事件 id 经 evidence 保留审计链。runtime.error 做载荷
   * 形状适配（顶层 {code,message} → 投影器期望的 {error:{code,message}}，
   * D2 runtime-smoke 集成发现的同一适配）。写失败静默丢弃（DB 是事实源）。
   */
  journalRuntimeEvent(runId: RunId, event: PiRuntimeEvent): void {
    const recorder = this.#recorder;
    if (recorder === null) return;
    const type = piRuntimeEventKindToType(event.kind);
    let payload: JsonRecord;
    if (event.kind === "runtime.error") {
      payload = {
        error: {
          code: payloadString(event.payload, "code") ?? "unknown",
          message: payloadString(event.payload, "message") ?? "runtime error",
        },
      };
    } else if (event.payload !== null && typeof event.payload === "object" && !Array.isArray(event.payload)) {
      payload = { ...(event.payload as JsonRecord) };
    } else {
      payload = { value: event.payload };
    }
    this.#journalTail = this.#journalTail.then(() =>
      recorder
        .recordCustom(runId, type, payload, {
          occurredAt: event.occurredAt,
          evidence: [{ source: "pi-runtime", refId: event.eventId }],
        })
        .then(() => undefined, () => undefined),
    );
  }

  /**
   * journal 记录服务侧显式状态迁移（queued→running；agent.started 随后为幂等 no-op）。
   * occurredAt 取**调用时刻**而非 append 时刻：append 在异步临界区内执行，
   * 可能晚于随后运行时事件的发射时间戳，破坏 journal 插入序的时序单调性。
   */
  journalStateChange(runId: RunId, from: RunState, to: RunState): void {
    const recorder = this.#recorder;
    if (recorder === null) return;
    const occurredAt = new Date().toISOString();
    this.#journalTail = this.#journalTail.then(() =>
      recorder.recordStateChange(runId, from, to, { occurredAt }).then(() => undefined, () => undefined),
    );
  }

  /** journal 记录服务侧中止请求（运行时自身的事件随后为幂等 no-op；调用时刻戳）。 */
  journalAbortRequested(runId: RunId): void {
    const recorder = this.#recorder;
    if (recorder === null) return;
    const occurredAt = new Date().toISOString();
    this.#journalTail = this.#journalTail.then(() =>
      recorder.recordAbortRequested(runId, { occurredAt }).then(() => undefined, () => undefined),
    );
  }

}
