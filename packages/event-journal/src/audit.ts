/**
 * 可观测性读模型：从事件流提取可审计记录（任务书 §5 Agent E 第 7 项）。
 *
 * 覆盖四类审计视角（全部从已持久化事件流推导，不额外存储状态）：
 * 1. **错误**（`runtime.error`、收敛为 failed 的 `agent.settled` /
 *    `runtime.recovered`、投影 failure）；
 * 2. **耗时**（`duration.recorded` 事件 + 任意事件 payload.timing 约定
 *    字段；durationMs 缺失时从 startedAt/endedAt 推导）；
 * 3. **session reference 变化**（session.created/restored/replaced）；
 * 4. **tree navigation**（tree.navigated 的扁平约定 payload）。
 *
 * 状态投影复用 `projectRunEvents`，因此审计报告天然包含投影异常
 * （非法迁移/双终态/失步/畸形 payload）的可审计记录。
 *
 * 所有记录只包含脱敏后事件流中已有的内容：audit 不回查 Pi、不读取
 * 文件系统、不引入新的秘密来源。
 */
import type {
  EventId,
  IsoTimestamp,
  JsonRecord,
  PiEntryId,
  PiSessionId,
  RunId,
  TreeAIError,
  TreeAIEvent,
} from "@treeai/contracts";
import { isJsonObject } from "./util.js";
import { parseSerializedError, projectRunEvents, type RunProjection } from "./projector.js";

/* ------------------------------------------------------------------ */
/* 记录形状                                                            */
/* ------------------------------------------------------------------ */

export interface AuditErrorRecord {
  readonly seq: number;
  readonly eventId: EventId;
  readonly occurredAt: IsoTimestamp;
  /** 记录来源事件类型。 */
  readonly source: TreeAIEvent["type"];
  readonly error: TreeAIError;
}

export interface AuditDurationRecord {
  readonly seq: number;
  readonly eventId: EventId;
  readonly occurredAt: IsoTimestamp;
  /** 阶段标签：payload.phase，缺省时取事件类型。 */
  readonly phase: string;
  readonly startedAt: IsoTimestamp;
  readonly endedAt: IsoTimestamp;
  readonly durationMs: number;
}

export interface AuditSessionChangeRecord {
  readonly seq: number;
  readonly eventId: EventId;
  readonly occurredAt: IsoTimestamp;
  readonly changeType: "created" | "restored" | "replaced";
  /** 新引用（脱敏后；sessionFile 经 journal 兜底脱敏规约为 ~/ 形式）。 */
  readonly reference: JsonRecord;
  /** 变更前引用（仅 restored/replaced 且事件携带时存在）。 */
  readonly previous: JsonRecord | null;
}

export interface AuditNavigationRecord {
  readonly seq: number;
  readonly eventId: EventId;
  readonly occurredAt: IsoTimestamp;
  readonly fromEntryId: PiEntryId | null;
  readonly toEntryId: PiEntryId | null;
  readonly sessionId: PiSessionId | null;
  readonly context: JsonRecord | null;
}

export interface RunAuditReport {
  readonly runId: RunId;
  readonly eventCount: number;
  /** 复用投影器的 RunState 投影（含 transitions 与 anomalies）。 */
  readonly projection: RunProjection;
  readonly errors: readonly AuditErrorRecord[];
  readonly durations: readonly AuditDurationRecord[];
  readonly sessionReferenceChanges: readonly AuditSessionChangeRecord[];
  readonly treeNavigations: readonly AuditNavigationRecord[];
}

/* ------------------------------------------------------------------ */
/* 提取逻辑                                                            */
/* ------------------------------------------------------------------ */

function extractErrorRecord(event: TreeAIEvent, key: string): AuditErrorRecord | null {
  const error = parseSerializedError(event.payload, key);
  if (error === null) return null;
  return {
    seq: event.seq,
    eventId: event.eventId,
    occurredAt: event.occurredAt,
    source: event.type,
    error,
  };
}

function extractTimingRecord(event: TreeAIEvent): AuditDurationRecord | null {
  const timing = event.payload["timing"];
  if (!isJsonObject(timing)) return null;
  const startedAt = timing["startedAt"];
  const endedAt = timing["endedAt"];
  if (typeof startedAt !== "string" || typeof endedAt !== "string") return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  const explicit = timing["durationMs"];
  const phaseRaw = event.payload["phase"];
  return {
    seq: event.seq,
    eventId: event.eventId,
    occurredAt: event.occurredAt,
    phase: typeof phaseRaw === "string" ? phaseRaw : event.type,
    startedAt,
    endedAt,
    durationMs:
      typeof explicit === "number" && Number.isFinite(explicit)
        ? explicit
        : Math.max(0, end - start),
  };
}

function extractSessionChange(event: TreeAIEvent): AuditSessionChangeRecord | null {
  let changeType: "created" | "restored" | "replaced";
  switch (event.type) {
    case "session.created":
      changeType = "created";
      break;
    case "session.restored":
      changeType = "restored";
      break;
    case "session.replaced":
      changeType = "replaced";
      break;
    default:
      return null;
  }
  const reference = event.payload["reference"];
  if (!isJsonObject(reference)) return null;
  const previous = event.payload["previous"];
  return {
    seq: event.seq,
    eventId: event.eventId,
    occurredAt: event.occurredAt,
    changeType,
    reference,
    previous: isJsonObject(previous) ? previous : null,
  };
}

function extractNavigation(event: TreeAIEvent): AuditNavigationRecord | null {
  if (event.type !== "tree.navigated") return null;
  const from = event.payload["fromEntryId"];
  const to = event.payload["toEntryId"];
  const session = event.payload["sessionId"];
  const context = event.payload["context"];
  return {
    seq: event.seq,
    eventId: event.eventId,
    occurredAt: event.occurredAt,
    fromEntryId: typeof from === "string" ? (from as PiEntryId) : null,
    toEntryId: typeof to === "string" ? (to as PiEntryId) : null,
    sessionId: typeof session === "string" ? (session as PiSessionId) : null,
    context: isJsonObject(context) ? context : null,
  };
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

/**
 * 从一个 run 的事件流构建审计报告。
 * events 通常来自 `EventJournal.getRunEvents(runId)`；函数内部按 seq
 * 防御性排序后提取。只读、不落盘、无副作用。
 */
export function buildRunAudit(runId: RunId, events: readonly TreeAIEvent[]): RunAuditReport {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const errors: AuditErrorRecord[] = [];
  const durations: AuditDurationRecord[] = [];
  const sessionReferenceChanges: AuditSessionChangeRecord[] = [];
  const treeNavigations: AuditNavigationRecord[] = [];

  for (const event of ordered) {
    switch (event.type) {
      case "runtime.error":
      case "runtime.recovered": {
        const record = extractErrorRecord(event, "error");
        if (record !== null) errors.push(record);
        break;
      }
      case "agent.settled": {
        if (event.payload["status"] === "failed") {
          const record = extractErrorRecord(event, "error");
          if (record !== null) errors.push(record);
        }
        break;
      }
      default:
        break;
    }
    const timing = extractTimingRecord(event);
    if (timing !== null) durations.push(timing);

    const sessionChange = extractSessionChange(event);
    if (sessionChange !== null) sessionReferenceChanges.push(sessionChange);

    const navigation = extractNavigation(event);
    if (navigation !== null) treeNavigations.push(navigation);
  }

  return {
    runId,
    eventCount: ordered.length,
    projection: projectRunEvents(runId, ordered),
    errors,
    durations,
    sessionReferenceChanges,
    treeNavigations,
  };
}
