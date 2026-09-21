/**
 * EventRecorder：类型化写入 API（任务书 §5 Agent E 第 5、7 项）。
 *
 * 职责：
 * - 在 journal 的串行临界区内自动分配 seq/eventId/occurredAt
 *   （经 `EventJournal.appendNext`），调用方不需要手工维护计数器；
 * - 提供可审计记录的便捷方法：错误（`runtime.error`）、耗时
 *   （`duration.recorded` 及任意事件上的 `timing`）、session reference
 *   变化（`session.created/restored/replaced`）、tree navigation
 *   （`tree.navigated`）与显式状态迁移（`run.state-changed`）；
 * - 将归一化运行时事件 `PiRuntimeEvent` 转换为 `TreeAIEvent`：
 *   - 已知 kind 一一映射（`steer.enqueued` → `run.steer-enqueued`）；
 *   - **未知 kind 前向兼容**：类型记录为 `pi.unknown`，payload 保留
 *     原始 kind（`payload.rawKind`）与（兜底脱敏后的）原 payload，
 *     不崩溃、不丢弃（contracts events.ts 开放联合约定）；
 *   - evidence 引用原始事件（source `pi-runtime` + refId），**不复制
 *     Pi 原始敏感内容**（ADR-001 §4：引用而非内嵌）。
 *
 * 脱敏义务：recorder 产生的 payload 仍须视为"调用方应已脱敏"——recorder
 * 只做结构化封装，最终兜底脱敏由 journal 的 append 临界区完成。
 * `recordError` 特意**不持久化 `TreeAIError.cause`**（contracts errors.ts
 * 明确 cause 不得原样序列化入库；诊断信息需要保留时应由调用方先行
 * 脱敏并放入 message/details）。
 *
 * recorder 方法不校验状态机合法性：journal 保留一切事件，投影器
 * （`projector.ts`）负责拒绝非法迁移——非法迁移尝试也会被记录并在
 * 投影异常中可审计。
 */
import type {
  EpisodeId,
  EventId,
  EvidenceReference,
  IsoTimestamp,
  JsonRecord,
  JsonValue,
  PiEntryId,
  PiRuntimeEvent,
  PiRuntimeEventKind,
  PiSessionId,
  RunId,
  RunState,
  SessionReference,
  TreeAIError,
  TreeAIEventType,
} from "@treeai/contracts";
import type { AppendOutcome, EventJournal } from "./journal.js";

/** 构造期的可变 payload（JsonRecord 的可写形式；构造完成后按只读使用）。 */
type MutableJsonRecord = { [key: string]: JsonValue };

/** 计时信息（任意事件 payload 中的约定字段；audit 报告据此提取耗时）。 */
export interface TimingPayload {
  readonly startedAt: IsoTimestamp;
  readonly endedAt: IsoTimestamp;
  readonly durationMs?: number;
}

export interface RecordOptions {
  readonly occurredAt?: IsoTimestamp;
  readonly eventId?: EventId;
  readonly evidence?: readonly EvidenceReference[];
}

/* ------------------------------------------------------------------ */
/* PiRuntimeEvent → TreeAIEvent 转换                                   */
/* ------------------------------------------------------------------ */

/** 已知 kind → TreeAI 事件类型的一一映射；未知 kind → `pi.unknown`。 */
export function piRuntimeEventKindToType(kind: PiRuntimeEventKind): TreeAIEventType {
  switch (kind) {
    case "session.created":
    case "session.restored":
    case "session.replaced":
    case "agent.started":
    case "agent.settled":
    case "turn.started":
    case "turn.completed":
    case "message.started":
    case "message.updated":
    case "message.completed":
    case "tool.execution.started":
    case "tool.execution.finished":
    case "runtime.error":
    case "tree.navigated":
      return kind;
    case "steer.enqueued":
      return "run.steer-enqueued";
    case "run.abort-requested":
      return "run.abort-requested";
    default:
      // 开放联合：未来 Pi 版本的新事件以原 kind 字符串保留（前向兼容）。
      return "pi.unknown";
  }
}

/** 将 PiRuntimeEvent.payload（JsonValue）封装为 TreeAIEvent.payload（JsonRecord）。 */
function piRuntimeEventPayload(event: PiRuntimeEvent): JsonRecord {
  const raw = event.payload;
  const base: JsonRecord =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? { ...(raw as JsonRecord) }
      : { value: raw };
  if (piRuntimeEventKindToType(event.kind) === "pi.unknown") {
    return { ...base, rawKind: event.kind };
  }
  return base;
}

/* ------------------------------------------------------------------ */
/* 序列化辅助                                                          */
/* ------------------------------------------------------------------ */

/** 只保留可持久化字段（code/message/details）；cause 不入库（契约义务）。 */
export function serializeError(error: TreeAIError): JsonRecord {
  const out: MutableJsonRecord = { code: error.code, message: error.message };
  if (error.details !== undefined) out["details"] = error.details;
  return out;
}

/** SessionReference → 可放入 payload 的 JSON 形状（sessionFile 会被兜底脱敏规约）。 */
export function serializeSessionReference(reference: SessionReference): JsonRecord {
  return {
    sessionId: reference.sessionId,
    sessionFile: reference.sessionFile,
    entryId: reference.entryId,
    piVersion: reference.piVersion,
    availability: reference.availability as unknown as JsonRecord,
  };
}

/* ------------------------------------------------------------------ */
/* Recorder                                                            */
/* ------------------------------------------------------------------ */

export interface TreeNavigationRecordInput {
  readonly fromEntryId: PiEntryId;
  readonly toEntryId: PiEntryId;
  readonly sessionId: PiSessionId;
  /** 可选域上下文（treeId/branchId/episodeId 等，由调用方补充）。 */
  readonly context?: JsonRecord;
}

export interface DurationRecordInput {
  /** 阶段标签（如 "run" / "turn" / "tool"）。 */
  readonly phase: string;
  readonly timing: TimingPayload;
  readonly attributes?: JsonRecord;
}

export class EventRecorder {
  constructor(private readonly journal: EventJournal) {}

  /** 追加任意自定义事件（开放类型联合内的逃生口）。 */
  async recordCustom(
    runId: RunId,
    type: TreeAIEventType,
    payload: JsonRecord,
    options?: RecordOptions,
  ): Promise<AppendOutcome> {
    return this.journal.appendNext(runId, {
      type,
      payload,
      evidence: options?.evidence,
      occurredAt: options?.occurredAt,
      eventId: options?.eventId,
    });
  }

  /**
   * 记录归一化运行时事件（PiRuntimeEvent）。已知 kind 映射为对应
   * TreeAI 事件类型；未知 kind 以 `pi.unknown` + `payload.rawKind` 保留。
   */
  async recordPiRuntimeEvent(runId: RunId, event: PiRuntimeEvent): Promise<AppendOutcome> {
    return this.journal.appendNext(runId, {
      type: piRuntimeEventKindToType(event.kind),
      payload: piRuntimeEventPayload(event),
      evidence: [{ source: "pi-runtime", refId: event.eventId }],
      occurredAt: event.occurredAt,
      eventId: event.eventId,
    });
  }

  /** 显式状态迁移断言（投影器负责校验合法性与 from 对账）。 */
  async recordStateChange(
    runId: RunId,
    from: RunState,
    to: RunState,
    options?: {
      readonly reason?: string;
      readonly failure?: TreeAIError;
      readonly timing?: TimingPayload;
      readonly occurredAt?: IsoTimestamp;
      readonly eventId?: EventId;
      readonly evidence?: readonly EvidenceReference[];
    },
  ): Promise<AppendOutcome> {
    const payload: MutableJsonRecord = { from, to };
    if (options?.reason !== undefined) payload["reason"] = options.reason;
    if (options?.failure !== undefined) payload["failure"] = serializeError(options.failure);
    if (options?.timing !== undefined) payload["timing"] = timingToRecord(options.timing);
    return this.journal.appendNext(runId, {
      type: "run.state-changed",
      payload,
      evidence: options?.evidence,
      occurredAt: options?.occurredAt,
      eventId: options?.eventId,
    });
  }

  /** 请求中止（派生迁移 running→aborting 的信号事件）。 */
  async recordAbortRequested(runId: RunId, options?: RecordOptions): Promise<AppendOutcome> {
    return this.journal.appendNext(runId, {
      type: "run.abort-requested",
      payload: {},
      evidence: options?.evidence,
      occurredAt: options?.occurredAt,
      eventId: options?.eventId,
    });
  }

  /** steer 入队（文本为用户输入，脱敏兜底仍会清理意外混入的秘密）。 */
  async recordSteerEnqueued(
    runId: RunId,
    text: string,
    options?: RecordOptions,
  ): Promise<AppendOutcome> {
    return this.journal.appendNext(runId, {
      type: "run.steer-enqueued",
      payload: { text },
      evidence: options?.evidence,
      occurredAt: options?.occurredAt,
      eventId: options?.eventId,
    });
  }

  /**
   * 记录运行期错误（`runtime.error`）。只持久化 code/message/details；
   * `cause` 被有意丢弃（contracts errors.ts：cause 不得原样序列化入库）。
   */
  async recordError(
    runId: RunId,
    error: TreeAIError,
    options?: RecordOptions,
  ): Promise<AppendOutcome> {
    return this.journal.appendNext(runId, {
      type: "runtime.error",
      payload: { error: serializeError(error) },
      evidence: options?.evidence,
      occurredAt: options?.occurredAt,
      eventId: options?.eventId,
    });
  }

  /** agent run 开始（派生迁移 queued→running 的信号事件）。 */
  async recordAgentStarted(
    runId: RunId,
    options?: { readonly timing?: TimingPayload } & RecordOptions,
  ): Promise<AppendOutcome> {
    const payload: MutableJsonRecord = {};
    if (options?.timing !== undefined) payload["timing"] = timingToRecord(options.timing);
    return this.journal.appendNext(runId, {
      type: "agent.started",
      payload,
      evidence: options?.evidence,
      occurredAt: options?.occurredAt,
      eventId: options?.eventId,
    });
  }

  /** agent run 收敛（status 供投影器推导终态；可携带 error 与 timing）。 */
  async recordAgentSettled(
    runId: RunId,
    settled: {
      readonly status: "succeeded" | "failed" | "aborted";
      readonly error?: TreeAIError;
      readonly timing?: TimingPayload;
    },
    options?: RecordOptions,
  ): Promise<AppendOutcome> {
    const payload: MutableJsonRecord = { status: settled.status };
    if (settled.error !== undefined) payload["error"] = serializeError(settled.error);
    if (settled.timing !== undefined) payload["timing"] = timingToRecord(settled.timing);
    return this.journal.appendNext(runId, {
      type: "agent.settled",
      payload,
      evidence: options?.evidence,
      occurredAt: options?.occurredAt,
      eventId: options?.eventId,
    });
  }

  /** 新会话创建（session reference 变化记录）。 */
  async recordSessionCreated(
    runId: RunId,
    reference: SessionReference,
    options?: RecordOptions,
  ): Promise<AppendOutcome> {
    return this.journal.appendNext(runId, {
      type: "session.created",
      payload: { reference: serializeSessionReference(reference) },
      evidence: options?.evidence,
      occurredAt: options?.occurredAt,
      eventId: options?.eventId,
    });
  }

  /** 会话恢复（可携带恢复前的引用快照）。 */
  async recordSessionRestored(
    runId: RunId,
    reference: SessionReference,
    previous?: SessionReference,
    options?: RecordOptions,
  ): Promise<AppendOutcome> {
    const payload: MutableJsonRecord = { reference: serializeSessionReference(reference) };
    if (previous !== undefined) payload["previous"] = serializeSessionReference(previous);
    return this.journal.appendNext(runId, {
      type: "session.restored",
      payload,
      evidence: options?.evidence,
      occurredAt: options?.occurredAt,
      eventId: options?.eventId,
    });
  }

  /** 活跃会话替换（单活跃会话模型；可携带替换前的引用快照）。 */
  async recordSessionReplaced(
    runId: RunId,
    reference: SessionReference,
    previous?: SessionReference,
    options?: RecordOptions,
  ): Promise<AppendOutcome> {
    const payload: MutableJsonRecord = { reference: serializeSessionReference(reference) };
    if (previous !== undefined) payload["previous"] = serializeSessionReference(previous);
    return this.journal.appendNext(runId, {
      type: "session.replaced",
      payload,
      evidence: options?.evidence,
      occurredAt: options?.occurredAt,
      eventId: options?.eventId,
    });
  }

  /** 树导航记录（同 session 内 entryId 叶指针移动）。 */
  async recordTreeNavigation(
    runId: RunId,
    navigation: TreeNavigationRecordInput,
    options?: RecordOptions,
  ): Promise<AppendOutcome> {
    const payload: MutableJsonRecord = {
      fromEntryId: navigation.fromEntryId,
      toEntryId: navigation.toEntryId,
      sessionId: navigation.sessionId,
      ...(navigation.context !== undefined ? { context: navigation.context } : {}),
    };
    return this.journal.appendNext(runId, {
      type: "tree.navigated",
      payload,
      evidence: options?.evidence,
      occurredAt: options?.occurredAt,
      eventId: options?.eventId,
    });
  }

  /**
   * 耗时记录。事件类型 `duration.recorded` 是 event-journal 定义的自有
   * 审计类型（`TreeAIEventType` 为开放联合；未进入 contracts 冻结面，
   * 见 README）。任意其他事件也可通过 payload.timing 携带耗时，audit
   * 报告对两种形态都会提取。
   */
  async recordDuration(
    runId: RunId,
    duration: DurationRecordInput,
    options?: RecordOptions,
  ): Promise<AppendOutcome> {
    const payload: MutableJsonRecord = {
      phase: duration.phase,
      timing: timingToRecord(duration.timing),
      ...(duration.attributes !== undefined ? { attributes: duration.attributes } : {}),
    };
    return this.journal.appendNext(runId, {
      type: "duration.recorded",
      payload,
      evidence: options?.evidence,
      occurredAt: options?.occurredAt,
      eventId: options?.eventId,
    });
  }

  /** 记录一个 run 与 episode 的归属关系（可选的定位辅助事件）。 */
  async recordEpisodeLink(
    runId: RunId,
    episodeId: EpisodeId,
    options?: RecordOptions,
  ): Promise<AppendOutcome> {
    return this.journal.appendNext(runId, {
      type: "run.episode-linked",
      payload: { episodeId },
      evidence: options?.evidence,
      occurredAt: options?.occurredAt,
      eventId: options?.eventId,
    });
  }
}

function timingToRecord(timing: TimingPayload): JsonRecord {
  const out: MutableJsonRecord = { startedAt: timing.startedAt, endedAt: timing.endedAt };
  if (timing.durationMs !== undefined) out["durationMs"] = timing.durationMs;
  return out;
}
