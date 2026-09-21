/**
 * @treeai/event-journal 公开 API（D2 Agent E）。
 *
 * 模块职责：TreeAIEvent 的追加式持久化（内存 / JSONL 文件）、RunState
 * 投影、统一脱敏（d2-v1）、宿主退出恢复收敛、可观测性审计记录。
 *
 * 使用概览：
 * - 写入：`EventRecorder`（推荐；自动分配 seq/eventId）或
 *   `EventJournal.appendNext`（手动 draft）；
 * - 读取/回放：`getRunEvents` / `listEvents`（按 query 过滤）；
 * - 投影：`projectRunEvents` / `EventJournal.projectRunState`；
 * - 恢复：`recoverInterruptedRuns`（host-crash / host-dispose）；
 * - 审计：`buildRunAudit`；
 * - 脱敏工具：`deepRedact` / `redactString` / `findRemainingSecrets`。
 *
 * 详见 package README（事件兼容、脱敏边界、恢复语义、限制）。
 */
export {
  EventJournalError,
  type EventJournalErrorReason,
} from "./errors.js";

export {
  type AppendOutcome,
  type AppendRejection,
  type AppendRejectionReason,
  type AppendSuccess,
  type EventDraft,
  type EventJournal,
  type EventQuery,
  type JsonlJournalOpenReport,
  type RecoveryOptions,
  createEventId,
  JsonlEventJournal,
  MemoryEventJournal,
} from "./journal.js";

export {
  REDACTION_VERSION,
  type RedactionResult,
  deepRedact,
  findRemainingSecrets,
  redactString,
  redactStringWithCategories,
} from "./redact.js";

export {
  RUN_STATE_TRANSITIONS,
  TERMINAL_RUN_STATES,
  type AppliedTransition,
  type ProjectionAnomaly,
  type ProjectionAnomalyKind,
  type RunProjection,
  type TransitionCause,
  isLegalRunStateTransition,
  isRunState,
  isTerminalRunState,
  parseSerializedError,
  projectRunEvents,
} from "./projector.js";

export {
  type RecoveryCause,
  type RecoveryConvergence,
  type RecoveryReport,
  type RecoveredRun,
  resolveRecoveryConvergence,
} from "./recovery.js";

export {
  EventRecorder,
  type DurationRecordInput,
  type RecordOptions,
  type TimingPayload,
  type TreeNavigationRecordInput,
  piRuntimeEventKindToType,
  serializeError,
  serializeSessionReference,
} from "./recorder.js";

export {
  type AuditDurationRecord,
  type AuditErrorRecord,
  type AuditNavigationRecord,
  type AuditSessionChangeRecord,
  type RunAuditReport,
  buildRunAudit,
} from "./audit.js";
