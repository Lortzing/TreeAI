/**
 * 事件契约（任务书 §3.3 第 5 项冻结内容）。
 *
 * 两个层次：
 * 1. `PiRuntimeEvent`：runtime-pi（Agent B）归一化后的运行时事件流，
 *    经 `PiRuntime.subscribe` 推送。不含 TreeAI 域标识（runId 等），
 *    域归属由 event-journal（Agent E）在转换时补齐。
 * 2. `TreeAIEvent`：event-journal 持久化的可审计领域事件，
 *    追加式写入，是 Run 状态投影的唯一事实源。
 */
import type { EventId, IsoTimestamp, RunId } from "./identifiers.js";
import type { JsonRecord, JsonValue } from "./json.js";

/* ------------------------------------------------------------------ */
/* TreeAIEvent（持久化领域事件）                                       */
/* ------------------------------------------------------------------ */

/**
 * 已知事件类型。命名采用 `<对象>.<动作>` 点分风格；
 * agent/turn/message/tool.execution 系列对应 D1 实测的 Pi 事件族
 * （agent_*、turn_*、message_*、tool_execution_*）的归一化名。
 */
export type KnownTreeAIEventType =
  /* Run 生命周期 */
  | "run.state-changed"
  | "run.abort-requested"
  | "run.steer-enqueued"
  /* agent / turn */
  | "agent.started"
  | "agent.settled"
  | "turn.started"
  | "turn.completed"
  /* 消息 */
  | "message.started"
  | "message.updated"
  | "message.completed"
  /* 工具执行 */
  | "tool.execution.started"
  | "tool.execution.finished"
  /* 工具策略 */
  | "tool.decision"
  /* 会话与树导航 */
  | "session.created"
  | "session.restored"
  | "session.replaced"
  | "tree.navigated"
  /* 运行时 / 恢复 */
  | "runtime.error"
  | "runtime.recovered"
  /* 未知 Pi 事件的保真记录（前向兼容） */
  | "pi.unknown";

/**
 * 事件类型为开放联合：已知类型提供补全与一致性，
 * 未知 Pi 版本引入的新事件以原类型字符串记录为 `pi.unknown` + payload
 * 原始 kind（event-journal 不得因未知事件崩溃或丢弃）。
 */
export type TreeAIEventType = KnownTreeAIEventType | (string & {});

/**
 * 原始证据引用：TreeAIEvent 指向产生它的原始记录。
 * TreeAI 数据库是产品事实源，但审计需要能回溯到原始证据。
 */
export interface EvidenceReference {
  /** 证据来源分类。 */
  readonly source: "pi-runtime" | "treeai-journal" | "external";
  /** 原始记录标识（如 PiRuntimeEvent.eventId 的字符串值）。 */
  readonly refId: string;
  /** 可选定位符（如文件路径/行号），必须已脱敏。 */
  readonly locator?: string;
}

/**
 * TreeAI 持久化领域事件。
 *
 * 不变量：
 * - seq：同一 `runId` 内从 1 开始**严格递增**；重复 seq 是可检测的
 *   契约违规（journal 必须能检出重复写入）。连续性（无空洞）为推荐
 *   实践而非硬性要求。
 * - occurredAt：UTC ISO 8601。
 * - payload：写入前必须完成脱敏（provider URL、token、Authorization、
 *   cookie、敏感路径等统一脱敏规则由 event-journal 实现并测试）。
 * - evidence：由 Pi 运行时事件派生的事件必须至少携带一条指向该原始
 *   事件的引用；纯投影/恢复事件（如 run.state-changed）可为空数组，
 *   但存在来源记录时应引用。
 * - 追加式：事件一旦写入不得改写或删除（审计纪律）。
 */
export interface TreeAIEvent {
  readonly eventId: EventId;
  readonly runId: RunId;
  readonly seq: number;
  readonly occurredAt: IsoTimestamp;
  readonly type: TreeAIEventType;
  readonly payload: JsonRecord;
  readonly evidence: readonly EvidenceReference[];
}

/* ------------------------------------------------------------------ */
/* PiRuntimeEvent（运行时事件，journal 的输入）                        */
/* ------------------------------------------------------------------ */

/**
 * 归一化的运行时事件类型。已知 kind 对应 D1 实测事件族；
 * `(string & {})` 保持对未知 Pi 事件的开放性（记录原始 kind，不崩溃）。
 */
export type PiRuntimeEventKind =
  | "session.created"
  | "session.restored"
  | "session.replaced"
  | "agent.started"
  | "agent.settled"
  | "turn.started"
  | "turn.completed"
  | "message.started"
  | "message.updated"
  | "message.completed"
  | "tool.execution.started"
  | "tool.execution.finished"
  | "steer.enqueued"
  | "run.abort-requested"
  | "runtime.error"
  | "tree.navigated"
  | (string & {});

/**
 * runtime-pi 归一化后的事件包络。
 *
 * 不变量：
 * - seq：单个 PiRuntime 实例生命周期内从 1 开始严格递增
 *  （跨 session 替换连续，不重置）。
 * - kind 与 payload 由 runtime-pi 从 Pi SDK 事件归一化而来；
 *   未知事件保留原始 kind 字符串（可放入 payload.rawKind）与脱敏 payload。
 * - payload 推送前必须已脱敏（runtime-pi 的义务）。
 * - 事件不含 TreeAI 域标识（runId 等）；域归属由消费方补齐。
 * - 订阅在 session 替换后保持有效（session.replaced 会被推送）。
 */
export interface PiRuntimeEvent {
  readonly eventId: EventId;
  readonly seq: number;
  readonly occurredAt: IsoTimestamp;
  readonly kind: PiRuntimeEventKind;
  readonly payload: JsonValue;
}
