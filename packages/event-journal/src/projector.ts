/**
 * RunState 投影器：从事件流推导 Run 状态（任务书 §5 Agent E 第 3 项）。
 *
 * 契约依据（packages/contracts/src/run-state.ts，冻结）：
 * - 六态 queued/running/aborting/succeeded/failed/aborted；迁移表
 *   `RunStateTransitions`（本文件以 `RUN_STATE_TRANSITIONS` 镜像，并用
 *   编译期赋值与契约类型互检，漂移即编译失败）。
 * - I2 终态吸收 / I3 单终态 / I4 abort 收敛 / I5 无回退 / I6 重启恢复 /
 *   I7 迁移表穷尽（表外迁移非法）。
 *
 * 语义设计：
 * - **journal 与投影分离**：journal 追加式保留一切事件（含非法迁移尝试）；
 *   投影器负责"是否应用到状态"。非法迁移/双终态/失步事件**不改变**投影
 *   状态，但以 `ProjectionAnomaly` 留下可审计记录（任务书：拒绝非法回退、
 *   双终态；留下可审计记录）。
 * - **显式迁移**：`run.state-changed` payload `{ from, to, reason?, failure? }`
 *   是调用方对迁移的显式断言；`from` 必须与投影当前状态一致（否则
 *   out-of-sync 异常），`from→to` 必须在冻结迁移表内。
 * - **派生迁移**：未显式记录状态的事件按下列规则推导：
 *   - `agent.started` → queued→running；
 *   - `run.abort-requested` → running→aborting；
 *   - `runtime.error`（payload.error 为序列化 TreeAIError）→ code 为
 *     `user-abort` 时收敛为 `aborted`（从 `running` 收敛时按 I4 经过
 *     `aborting` 两步），否则收敛为 `failed` 并记录 failure；
 *   - `agent.settled`（payload.status："succeeded"|"failed"|"aborted"；
 *     缺省时按当前状态推导：aborting→aborted、running→succeeded；
 *     已终态后的无 status settle 视为信息性事件、不改状态）；
 *   - `runtime.recovered`（payload `{ cause, from, resolvedTo, error }`，
 *     由 `recoverInterruptedRuns` 生成）→ 收敛为 resolvedTo。
 * - **幂等收敛**：派生/收敛事件指向的状态与当前一致（含已终态后指向同一
 *   终态）时为幂等 no-op；已终态后指向**另一**终态为 double-terminal 异常。
 * - **无状态效果的事件**：message.*、tool.*、session.*、tree.navigated、
 *   run.steer-enqueued、pi.unknown、duration.recorded 及一切未知类型
 *   （前向兼容，不崩溃）。
 */
import type {
  EventId,
  IsoTimestamp,
  JsonRecord,
  RunId,
  RunState,
  RunStateTransitions,
  TerminalRunState,
  TreeAIError,
  TreeAIErrorCode,
  TreeAIEvent,
} from "@treeai/contracts";
import { isJsonObject } from "./util.js";

/* ------------------------------------------------------------------ */
/* 迁移表（运行时镜像 + 编译期与冻结契约互检）                         */
/* ------------------------------------------------------------------ */

/**
 * 冻结迁移表的运行时形式：直接以契约类型 `RunStateTransitions` 注解，
 * 字面量在上下文类型下被校验为精确元组——契约表改动而本镜像未跟随时
 * 编译失败（零运行时依赖 contracts 包）。
 */
export const RUN_STATE_TRANSITIONS: RunStateTransitions = {
  queued: ["running", "failed"],
  running: ["aborting", "succeeded", "failed"],
  aborting: ["aborted", "failed"],
  succeeded: [],
  failed: [],
  aborted: [],
};

export const TERMINAL_RUN_STATES: readonly TerminalRunState[] = ["succeeded", "failed", "aborted"];

export function isTerminalRunState(state: RunState): state is TerminalRunState {
  return RUN_STATE_TRANSITIONS[state].length === 0;
}

export function isRunState(value: unknown): value is RunState {
  return (
    typeof value === "string" &&
    (value === "queued" || value === "running" || value === "aborting" ||
      value === "succeeded" || value === "failed" || value === "aborted")
  );
}

/** 迁移是否在冻结迁移表内（I7：表外迁移非法）。 */
export function isLegalRunStateTransition(from: RunState, to: RunState): boolean {
  // 元组联合上的 `.includes` 元素类型会坍缩为 never；按元素联合读取。
  const targets = RUN_STATE_TRANSITIONS[from] as readonly RunState[];
  return targets.includes(to);
}

/* ------------------------------------------------------------------ */
/* 投影结果类型                                                        */
/* ------------------------------------------------------------------ */

export type TransitionCause =
  | "explicit:run.state-changed"
  | "derived:agent.started"
  | "derived:run.abort-requested"
  | "derived:runtime.error"
  | "derived:agent.settled"
  | "recovery:runtime.recovered"
  | "implicit:user-abort-via-aborting";

export type ProjectionAnomalyKind =
  /** 非终态之间的非法迁移（回退、跳级；I5/I7）。 */
  | "illegal-transition"
  /** 从终态离开的尝试，含双终态（I2/I3）。 */
  | "double-terminal"
  /** 显式迁移的 from 与投影当前状态不符。 */
  | "out-of-sync"
  /** 派生收敛无合法路径（如 queued→aborted）。 */
  | "illegal-convergence"
  /** 状态承载事件的 payload 形状不符合约定。 */
  | "invalid-payload";

export interface AppliedTransition {
  readonly seq: number;
  readonly eventId: EventId;
  readonly occurredAt: IsoTimestamp;
  readonly from: RunState;
  readonly to: RunState;
  readonly cause: TransitionCause;
}

export interface ProjectionAnomaly {
  readonly seq: number;
  readonly eventId: EventId;
  readonly occurredAt: IsoTimestamp;
  readonly kind: ProjectionAnomalyKind;
  readonly from: RunState;
  readonly attemptedTo: RunState | null;
  readonly detail: string;
}

export interface RunProjection {
  readonly runId: RunId;
  /** 投影得到的当前状态（事件流为空时为初始态 queued 的"零事件"投影）。 */
  readonly state: RunState;
  /** 进入终态的时间；非终态为 null。 */
  readonly terminalAt: IsoTimestamp | null;
  /** state === "failed" 时的失败信息（已脱敏）；否则 null。 */
  readonly failure: TreeAIError | null;
  /** 已应用的迁移（含派生与恢复产生的迁移），按 seq 顺序。 */
  readonly transitions: readonly AppliedTransition[];
  /** 被拒绝的非法/失步/畸形迁移尝试，按 seq 顺序。 */
  readonly anomalies: readonly ProjectionAnomaly[];
  readonly eventCount: number;
  readonly lastSeq: number | null;
}

/* ------------------------------------------------------------------ */
/* payload 解析                                                        */
/* ------------------------------------------------------------------ */

const TREE_AI_ERROR_CODES: readonly TreeAIErrorCode[] = [
  "auth",
  "model-unavailable",
  "user-abort",
  "timeout",
  "policy-denied",
  "upstream",
  "session-corrupt",
  "unknown",
];

/**
 * 从 payload 的指定键解析序列化 TreeAIError。
 * 缺失/形状不符返回 null；code 不在 8 类冻结枚举内时收敛为 "unknown"
 * （不因此抛错或让 run 悬挂在非终态）。
 */
export function parseSerializedError(payload: JsonRecord, key: string): TreeAIError | null {
  const raw = payload[key];
  if (!isJsonObject(raw)) return null;
  const rawCode = raw["code"];
  const code: TreeAIErrorCode =
    typeof rawCode === "string" && (TREE_AI_ERROR_CODES as readonly string[]).includes(rawCode)
      ? (rawCode as TreeAIErrorCode)
      : "unknown";
  const rawMessage = raw["message"];
  const message = typeof rawMessage === "string" ? rawMessage : "";
  const details = isJsonObject(raw["details"]) ? (raw["details"] as JsonRecord) : undefined;
  if (details === undefined) return { code, message };
  return { code, message, details };
}

/* ------------------------------------------------------------------ */
/* 投影核心                                                            */
/* ------------------------------------------------------------------ */

class ProjectionBuilder {
  state: RunState = "queued";
  terminalAt: IsoTimestamp | null = null;
  failure: TreeAIError | null = null;
  readonly transitions: AppliedTransition[] = [];
  readonly anomalies: ProjectionAnomaly[] = [];

  constructor(private readonly runId: RunId) {}

  private apply(from: RunState, to: RunState, cause: TransitionCause, event: TreeAIEvent): void {
    this.state = to;
    this.transitions.push({
      seq: event.seq,
      eventId: event.eventId,
      occurredAt: event.occurredAt,
      from,
      to,
      cause,
    });
    if (isTerminalRunState(to) && this.terminalAt === null) {
      this.terminalAt = event.occurredAt;
    }
  }

  reject(
    event: TreeAIEvent,
    kind: ProjectionAnomalyKind,
    attemptedTo: RunState | null,
    detail: string,
  ): void {
    this.anomalies.push({
      seq: event.seq,
      eventId: event.eventId,
      occurredAt: event.occurredAt,
      kind,
      from: this.state,
      attemptedTo,
      detail,
    });
  }

  /** 显式迁移（run.state-changed）：先对账 from，再验表，再应用。 */
  explicitTransition(event: TreeAIEvent, from: RunState, to: RunState): void {
    if (from !== this.state) {
      this.reject(
        event,
        "out-of-sync",
        to,
        `explicit transition claims from=${from} but projection is at ${this.state}`,
      );
      return;
    }
    if (isTerminalRunState(this.state)) {
      if (to === this.state) return; // 终态自确认（幂等），不视为异常
      this.reject(
        event,
        "double-terminal",
        to,
        `attempt to leave terminal state ${this.state} for ${to} (I2 terminal absorption)`,
      );
      return;
    }
    if (!isLegalRunStateTransition(this.state, to)) {
      this.reject(
        event,
        "illegal-transition",
        to,
        `transition ${this.state} -> ${to} is outside the frozen RunStateTransitions table (I5/I7)`,
      );
      return;
    }
    this.apply(this.state, to, "explicit:run.state-changed", event);
    if (to === "failed") {
      this.failure =
        parseSerializedError(event.payload, "failure") ??
        {
          code: "unknown",
          message: `run.state-changed to failed without failure payload (seq ${event.seq})`,
        };
    }
  }

  /** 派生非终态迁移（agent.started / run.abort-requested）。 */
  derivedTransition(event: TreeAIEvent, target: RunState, cause: TransitionCause): void {
    if (this.state === target) return; // 幂等（如重复的 agent.started）
    if (isTerminalRunState(this.state)) {
      this.reject(event, "double-terminal", target, `derived ${cause} after terminal state ${this.state}`);
      return;
    }
    if (!isLegalRunStateTransition(this.state, target)) {
      this.reject(
        event,
        "illegal-transition",
        target,
        `derived ${cause}: ${this.state} -> ${target} is outside the frozen transition table`,
      );
      return;
    }
    this.apply(this.state, target, cause, event);
  }

  /** 派生终态收敛（runtime.error / agent.settled / runtime.recovered）。 */
  converge(
    event: TreeAIEvent,
    target: TerminalRunState,
    cause: TransitionCause,
    failure?: TreeAIError,
  ): void {
    if (this.state === target) return; // 幂等（含已终态后指向同一终态）
    if (isTerminalRunState(this.state)) {
      this.reject(
        event,
        "double-terminal",
        target,
        `attempt to converge terminal state ${this.state} to ${target} (I3 single terminal state)`,
      );
      return;
    }
    if (isLegalRunStateTransition(this.state, target)) {
      this.apply(this.state, target, cause, event);
    } else if (this.state === "running" && target === "aborted") {
      // I4/I6：user-abort 语义从 running 收敛时经 aborting 两步
      // （运行时若未先记录 run.abort-requested，如宿主 dispose 场景）。
      this.apply(this.state, "aborting", "implicit:user-abort-via-aborting", event);
      this.apply("aborting", "aborted", cause, event);
    } else {
      this.reject(
        event,
        "illegal-convergence",
        target,
        `no legal path from ${this.state} to ${target} in the frozen transition table`,
      );
      return;
    }
    if (target === "failed") {
      this.failure =
        failure ??
        { code: "unknown", message: `converged to failed without error payload (seq ${event.seq})` };
    }
  }
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

/**
 * 从一个 run 的事件流投影 RunState。
 * 事件按 seq 升序处理（函数内部防御性排序）；空事件流得到零事件投影
 * （state = queued、terminalAt = null）。
 */
export function projectRunEvents(runId: RunId, events: readonly TreeAIEvent[]): RunProjection {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const builder = new ProjectionBuilder(runId);

  for (const event of ordered) {
    switch (event.type) {
      case "run.state-changed": {
        const from = event.payload["from"];
        const to = event.payload["to"];
        if (!isRunState(from) || !isRunState(to)) {
          builder.reject(
            event,
            "invalid-payload",
            null,
            `run.state-changed payload requires from/to RunState strings (got from=${String(from)}, to=${String(to)})`,
          );
          break;
        }
        builder.explicitTransition(event, from, to);
        break;
      }
      case "agent.started": {
        builder.derivedTransition(event, "running", "derived:agent.started");
        break;
      }
      case "run.abort-requested": {
        builder.derivedTransition(event, "aborting", "derived:run.abort-requested");
        break;
      }
      case "runtime.error": {
        const error = parseSerializedError(event.payload, "error");
        if (error === null) {
          builder.reject(
            event,
            "invalid-payload",
            null,
            "runtime.error payload requires an error object (serialized TreeAIError)",
          );
          break;
        }
        if (error.code === "user-abort") {
          builder.converge(event, "aborted", "derived:runtime.error");
        } else {
          builder.converge(event, "failed", "derived:runtime.error", error);
        }
        break;
      }
      case "agent.settled": {
        const status = event.payload["status"];
        if (status === undefined) {
          if (isTerminalRunState(builder.state)) break; // 信息性 settle（已收敛）
          const target: TerminalRunState = builder.state === "aborting" ? "aborted" : "succeeded";
          builder.converge(event, target, "derived:agent.settled");
          break;
        }
        if (status !== "succeeded" && status !== "failed" && status !== "aborted") {
          builder.reject(
            event,
            "invalid-payload",
            null,
            `agent.settled status must be succeeded|failed|aborted (got ${String(status)})`,
          );
          break;
        }
        const failure =
          status === "failed" ? (parseSerializedError(event.payload, "error") ?? undefined) : undefined;
        builder.converge(event, status, "derived:agent.settled", failure);
        break;
      }
      case "runtime.recovered": {
        const resolvedTo = event.payload["resolvedTo"];
        if (resolvedTo !== "failed" && resolvedTo !== "aborted") {
          builder.reject(
            event,
            "invalid-payload",
            null,
            `runtime.recovered payload requires resolvedTo failed|aborted (got ${String(resolvedTo)})`,
          );
          break;
        }
        const failure = parseSerializedError(event.payload, "error") ?? undefined;
        builder.converge(event, resolvedTo, "recovery:runtime.recovered", failure);
        break;
      }
      default:
        // message.* / tool.* / session.* / tree.navigated / run.steer-enqueued /
        // pi.unknown / duration.recorded / 未知类型：无状态效果（前向兼容）。
        break;
    }
  }

  return {
    runId,
    state: builder.state,
    terminalAt: builder.terminalAt,
    failure: builder.failure,
    transitions: builder.transitions,
    anomalies: builder.anomalies,
    eventCount: ordered.length,
    lastSeq: ordered.length > 0 ? ordered[ordered.length - 1]!.seq : null,
  };
}
