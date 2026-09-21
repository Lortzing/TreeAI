/**
 * EventJournal：追加式 TreeAIEvent journal（任务书 §5 Agent E 第 1、2 项）。
 *
 * 职责与不变量：
 * - **追加式**：事件一旦写入不得改写或删除（contracts events.ts 审计纪律）。
 *   唯一的文件级例外是崩溃留下的**尾部不完整行**（torn write，见
 *   `JsonlEventJournal.open`）——那是一个从未提交完成的写，不是事件。
 * - **seq 纪律**：同一 runId 内 seq 严格递增。`append`（调用方提供 seq）
 *   会检测并拒绝：重复 eventId（`duplicate-event-id`）、重复 seq
 *   （`duplicate-seq`）、低于该 run 当前最大 seq 的新 seq（`seq-below-max`）
 *   与各类结构违规。空洞（如 1,2,5）不拒绝——contracts 明确连续性为
 *   推荐实践而非硬性要求。
 * - **兜底脱敏**：调用方必须传入**已脱敏** payload（contracts 义务）；
 *   journal 持久化前对 payload 与 evidence.locator 再做深度脱敏
 *   （`redact.ts` d2-v1），并在结果中报告命中的规则类别。eventId /
 *   runId / type / occurredAt 是受控领域标识，不做模式脱敏。
 * - **存储**：JSONL 文件（每行一个 JSON 事件）或内存（测试/上层 mock）。
 *   journal 是 event-journal 自有的审计日志；不写 TreeAI 产品数据库
 *   （persistence/Agent C 职责），不写 Pi session 文件（ADR-001 §4）。
 * - **单写者假设**：D2 的 journal 由单一宿主进程串行写入（append 经内部
 *   promise 队列串行化）；不支持多进程并发写同一文件（无文件锁，见
 *   README 限制）。
 *
 * 事件 → 状态投影见 `projector.ts`；宿主退出恢复见 `recovery.ts`。
 */
import type {
  EventId,
  EvidenceReference,
  IsoTimestamp,
  JsonRecord,
  RunId,
  TreeAIEvent,
  TreeAIEventType,
} from "@treeai/contracts";
import { randomUUID } from "node:crypto";
import { open, readFile, truncate } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { EventJournalError } from "./errors.js";
import { isTerminalRunState, projectRunEvents, type RunProjection } from "./projector.js";
import { deepRedact, redactStringWithCategories } from "./redact.js";
import {
  resolveRecoveryConvergence,
  type RecoveryCause,
  type RecoveredRun,
  type RecoveryReport,
} from "./recovery.js";
import { isJsonObject, isIsoTimestamp } from "./util.js";

/* ------------------------------------------------------------------ */
/* 公开类型                                                            */
/* ------------------------------------------------------------------ */

export type AppendRejectionReason =
  | "invalid-event-id"
  | "invalid-run-id"
  | "invalid-seq"
  | "invalid-occurred-at"
  | "invalid-type"
  | "invalid-payload"
  | "invalid-evidence"
  | "duplicate-event-id"
  | "duplicate-seq"
  | "seq-below-max";

export interface AppendSuccess {
  readonly status: "appended";
  /** 实际持久化的事件（payload 与 evidence.locator 已深度脱敏）。 */
  readonly event: TreeAIEvent;
  /** 兜底脱敏命中的规则类别；非空说明调用方的先行脱敏义务未尽。 */
  readonly redactionApplied: readonly string[];
}

export interface AppendRejection {
  readonly status: "rejected";
  readonly reason: AppendRejectionReason;
  readonly detail: string;
  readonly attemptedSeq: number | null;
  readonly currentMaxSeq: number | null;
}

/** append 的结果：拒绝是可检测、可审计的预期情形，不以异常表达。 */
export type AppendOutcome = AppendSuccess | AppendRejection;

/** 自动分配 seq/eventId/occurredAt 的事件草稿（recorder 与恢复使用）。 */
export interface EventDraft {
  readonly eventId?: EventId;
  readonly type: TreeAIEventType;
  readonly payload: JsonRecord;
  readonly evidence?: readonly EvidenceReference[];
  readonly occurredAt?: IsoTimestamp;
}

export interface EventQuery {
  readonly runId?: RunId;
  readonly type?: TreeAIEventType;
  readonly types?: readonly TreeAIEventType[];
  readonly afterSeq?: number;
  readonly limit?: number;
}

export interface RecoveryOptions {
  /** 只恢复指定 run；缺省为全部。 */
  readonly runIds?: readonly RunId[];
  /** 测试用确定性时间戳；缺省为追加时刻。 */
  readonly occurredAt?: IsoTimestamp;
}

export interface EventJournal {
  /**
   * 追加一个完整事件（调用方提供 seq）。校验 seq 严格递增、eventId 唯一
   * 与事件结构；持久化前做兜底深度脱敏。
   */
  append(event: TreeAIEvent): Promise<AppendOutcome>;

  /**
   * 追加事件并由 journal 在串行临界区内自动分配 seq（该 run 当前最大
   * seq + 1）、eventId（缺省时）与 occurredAt（缺省时）。
   */
  appendNext(runId: RunId, draft: EventDraft): Promise<AppendOutcome>;

  /** journal 中出现过事件的全部 runId（无顺序保证）。 */
  getRunIds(): readonly RunId[];

  /** 单个 run 的事件，按 seq 升序（回放用）。 */
  getRunEvents(runId: RunId): readonly TreeAIEvent[];

  /** 按条件查询事件（写入顺序稳定排列）。 */
  listEvents(query?: EventQuery): readonly TreeAIEvent[];

  /** 从事件流投影 Run 状态；该 run 无事件时返回 null。 */
  projectRunState(runId: RunId): RunProjection | null;

  /**
   * 恢复宿主退出后仍处于非终态的 run（run-state.ts I6）：对每个非终态
   * run 追加 `runtime.recovered` 事件使其收敛为明确终态。幂等：已终态
   * 的 run 不再处理。
   */
  recoverInterruptedRuns(cause: RecoveryCause, options?: RecoveryOptions): Promise<RecoveryReport>;

  /** 关闭底层存储（幂等）。关闭后写入类方法抛 EventJournalError；查询仍可用。 */
  close(): Promise<void>;
}

export interface JsonlJournalOpenReport {
  readonly path: string;
  /** 文件此前不存在、本次创建。 */
  readonly created: boolean;
  readonly eventsLoaded: number;
  readonly runsLoaded: number;
  /** 尾部不完整行（torn write）被截断修复。 */
  readonly tornTailRepaired: boolean;
  readonly tornTailBytes: number;
}

/* ------------------------------------------------------------------ */
/* 事件结构校验                                                        */
/* ------------------------------------------------------------------ */

const EVIDENCE_SOURCES: readonly string[] = ["pi-runtime", "treeai-journal", "external"];

interface ShapeCheck {
  readonly ok: boolean;
  readonly reason?: AppendRejectionReason;
  readonly detail?: string;
}

function validateEventShape(value: unknown): ShapeCheck {
  if (!isJsonObject(value)) {
    return { ok: false, reason: "invalid-payload", detail: "event must be a JSON object" };
  }
  if (typeof value["eventId"] !== "string" || (value["eventId"] as string).length === 0) {
    return { ok: false, reason: "invalid-event-id", detail: "eventId must be a non-empty string" };
  }
  if (typeof value["runId"] !== "string" || (value["runId"] as string).length === 0) {
    return { ok: false, reason: "invalid-run-id", detail: "runId must be a non-empty string" };
  }
  const seq = value["seq"];
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) {
    return { ok: false, reason: "invalid-seq", detail: `seq must be an integer >= 1 (got ${String(seq)})` };
  }
  if (!isIsoTimestamp(value["occurredAt"])) {
    return { ok: false, reason: "invalid-occurred-at", detail: "occurredAt must be an ISO 8601 timestamp string" };
  }
  if (typeof value["type"] !== "string" || (value["type"] as string).length === 0) {
    return { ok: false, reason: "invalid-type", detail: "type must be a non-empty string" };
  }
  if (!isJsonObject(value["payload"])) {
    return { ok: false, reason: "invalid-payload", detail: "payload must be a JSON object (JsonRecord)" };
  }
  const evidence = value["evidence"];
  if (!Array.isArray(evidence)) {
    return { ok: false, reason: "invalid-evidence", detail: "evidence must be an array of EvidenceReference" };
  }
  for (const entry of evidence) {
    if (!isJsonObject(entry)) {
      return { ok: false, reason: "invalid-evidence", detail: "each evidence entry must be an object" };
    }
    if (!EVIDENCE_SOURCES.includes(entry["source"] as string)) {
      return {
        ok: false,
        reason: "invalid-evidence",
        detail: `evidence.source must be one of ${EVIDENCE_SOURCES.join("|")} (got ${String(entry["source"])})`,
      };
    }
    if (typeof entry["refId"] !== "string" || (entry["refId"] as string).length === 0) {
      return { ok: false, reason: "invalid-evidence", detail: "evidence.refId must be a non-empty string" };
    }
    const locator = entry["locator"];
    if (locator !== undefined && typeof locator !== "string") {
      return { ok: false, reason: "invalid-evidence", detail: "evidence.locator must be a string when present" };
    }
  }
  return { ok: true };
}

/** 生成新的不透明事件标识。 */
export function createEventId(): EventId {
  return `evt-${randomUUID()}` as EventId;
}

/* ------------------------------------------------------------------ */
/* 行存储                                                              */
/* ------------------------------------------------------------------ */

interface JournalLineStore {
  appendLine(line: string): Promise<void>;
  close(): Promise<void>;
}

class MemoryLineStore implements JournalLineStore {
  appendLine(line: string): Promise<void> {
    this.lines.push(line);
    return Promise.resolve();
  }
  readonly lines: string[] = [];
  close(): Promise<void> {
    return Promise.resolve();
  }
}

class JsonlLineStore implements JournalLineStore {
  private constructor(private readonly handle: FileHandle) {}

  static async create(path: string): Promise<JsonlLineStore> {
    try {
      const handle = await open(path, "a");
      return new JsonlLineStore(handle);
    } catch (error) {
      throw new EventJournalError("io", `failed to open journal file for append: ${path}: ${String(error)}`);
    }
  }

  async appendLine(line: string): Promise<void> {
    try {
      await this.handle.write(line);
    } catch (error) {
      throw new EventJournalError("io", `failed to append to journal file: ${String(error)}`);
    }
  }

  async close(): Promise<void> {
    try {
      await this.handle.close();
    } catch {
      /* 尽力关闭；close 幂等性由 journal 层保证 */
    }
  }
}

/* ------------------------------------------------------------------ */
/* 核心                                                                */
/* ------------------------------------------------------------------ */

abstract class BaseEventJournal implements EventJournal {
  private readonly events: TreeAIEvent[] = [];
  private readonly byRun = new Map<string, TreeAIEvent[]>();
  private readonly seqsByRun = new Map<string, Set<number>>();
  private readonly maxSeqByRun = new Map<string, number>();
  private readonly eventIds = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  protected constructor(private readonly store: JournalLineStore) {}

  /* ---- 写入 ---- */

  append(event: TreeAIEvent): Promise<AppendOutcome> {
    return this.enqueue(async () => {
      this.assertOpen();
      return this.persistNewEvent(event);
    });
  }

  appendNext(runId: RunId, draft: EventDraft): Promise<AppendOutcome> {
    return this.enqueue(async () => {
      this.assertOpen();
      const event: TreeAIEvent = {
        eventId: draft.eventId ?? createEventId(),
        runId,
        seq: (this.maxSeqByRun.get(runId as string) ?? 0) + 1,
        occurredAt: draft.occurredAt ?? new Date().toISOString(),
        type: draft.type,
        payload: draft.payload,
        evidence: draft.evidence ?? [],
      };
      return this.persistNewEvent(event);
    });
  }

  /**
   * 校验 + 兜底脱敏 + 落盘 + 入索引。只在串行临界区内调用。
   * 顺序：先全部校验（拒绝时不产生任何副作用），再写文件，最后入内存
   * 索引——文件写失败时内存状态不变。
   */
  private async persistNewEvent(event: TreeAIEvent): Promise<AppendOutcome> {
    const check = validateEventShape(event);
    if (!check.ok) {
      return this.rejectOutcome(check.reason ?? "invalid-payload", check.detail ?? "invalid event", event, null);
    }
    const runKey = event.runId as string;
    const currentMax = this.maxSeqByRun.get(runKey) ?? null;

    if (this.eventIds.has(event.eventId as string)) {
      return this.rejectOutcome(
        "duplicate-event-id",
        `eventId ${event.eventId} already exists in this journal`,
        event,
        currentMax,
      );
    }
    const seqs = this.seqsByRun.get(runKey);
    if (seqs !== undefined && seqs.has(event.seq)) {
      return this.rejectOutcome(
        "duplicate-seq",
        `seq ${event.seq} already recorded for run ${event.runId}`,
        event,
        currentMax,
      );
    }
    if (currentMax !== null && event.seq < currentMax) {
      return this.rejectOutcome(
        "seq-below-max",
        `seq ${event.seq} is below the current max seq ${currentMax} for run ${event.runId} (strictly increasing required)`,
        event,
        currentMax,
      );
    }

    // 兜底深度脱敏（调用方应已脱敏；此处为纵深防御）。
    const payloadRedaction = deepRedact(event.payload);
    const redactionApplied = [...payloadRedaction.applied];
    const evidence: EvidenceReference[] = event.evidence.map((ref) => {
      if (ref.locator === undefined) return ref;
      const locatorResult = redactStringWithCategories(ref.locator);
      for (const category of locatorResult.applied) redactionApplied.push(`locator:${category}`);
      return { ...ref, locator: locatorResult.value };
    });

    const stored: TreeAIEvent = {
      ...event,
      payload: payloadRedaction.value as JsonRecord,
      evidence,
    };

    await this.store.appendLine(JSON.stringify(stored) + "\n");
    this.adopt(stored);

    return {
      status: "appended",
      event: stored,
      redactionApplied: [...new Set(redactionApplied)],
    };
  }

  private rejectOutcome(
    reason: AppendRejectionReason,
    detail: string,
    event: TreeAIEvent,
    currentMax: number | null,
  ): AppendRejection {
    return {
      status: "rejected",
      reason,
      detail,
      attemptedSeq: typeof event.seq === "number" ? event.seq : null,
      currentMaxSeq: currentMax,
    };
  }

  /** 入内存索引（只在校验通过且已落盘/加载后调用）。 */
  private adopt(event: TreeAIEvent): void {
    const runKey = event.runId as string;
    this.events.push(event);
    let runEvents = this.byRun.get(runKey);
    if (runEvents === undefined) {
      runEvents = [];
      this.byRun.set(runKey, runEvents);
    }
    runEvents.push(event);
    let seqs = this.seqsByRun.get(runKey);
    if (seqs === undefined) {
      seqs = new Set<number>();
      this.seqsByRun.set(runKey, seqs);
    }
    seqs.add(event.seq);
    const maxSeq = this.maxSeqByRun.get(runKey) ?? 0;
    if (event.seq > maxSeq) this.maxSeqByRun.set(runKey, event.seq);
    this.eventIds.add(event.eventId as string);
  }

  /** 从既有行加载（open 时）。行内事件违规按文件损坏处理（corrupt）。 */
  protected loadFromLines(lines: readonly string[], source: string): void {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const lineNumber = i + 1;
      if (line.trim().length === 0) {
        throw new EventJournalError(
          "corrupt",
          `${source}: line ${lineNumber} is blank; journal files must contain exactly one JSON event per line`,
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        throw new EventJournalError("corrupt", `${source}: line ${lineNumber} is not valid JSON: ${String(error)}`);
      }
      const check = validateEventShape(parsed);
      if (!check.ok) {
        throw new EventJournalError(
          "corrupt",
          `${source}: line ${lineNumber} failed event validation: ${check.detail ?? "invalid event"}`,
        );
      }
      const event = parsed as TreeAIEvent;
      const runKey = event.runId as string;
      if (this.eventIds.has(event.eventId as string)) {
        throw new EventJournalError(
          "corrupt",
          `${source}: line ${lineNumber} repeats eventId ${event.eventId} (internal inconsistency)`,
        );
      }
      const seqs = this.seqsByRun.get(runKey);
      const currentMax = this.maxSeqByRun.get(runKey) ?? 0;
      if (seqs !== undefined && seqs.has(event.seq)) {
        throw new EventJournalError(
          "corrupt",
          `${source}: line ${lineNumber} repeats seq ${event.seq} for run ${event.runId} (internal inconsistency)`,
        );
      }
      if (event.seq <= currentMax) {
        throw new EventJournalError(
          "corrupt",
          `${source}: line ${lineNumber} has seq ${event.seq} not strictly increasing after max ${currentMax} for run ${event.runId}`,
        );
      }
      this.adopt(event);
    }
  }

  /* ---- 恢复 ---- */

  async recoverInterruptedRuns(cause: RecoveryCause, options?: RecoveryOptions): Promise<RecoveryReport> {
    this.assertOpen();
    const filter =
      options?.runIds !== undefined
        ? new Set((options.runIds as readonly RunId[]).map((r) => r as string))
        : null;
    const targets: RunId[] = [];
    const seen = new Set<string>();
    for (const runId of [...this.getRunIds(), ...(options?.runIds ?? [])]) {
      const key = runId as string;
      if (seen.has(key)) continue;
      seen.add(key);
      if (filter !== null && !filter.has(key)) continue;
      targets.push(runId);
    }

    const recovered: RecoveredRun[] = [];
    const alreadyTerminal: { runId: RunId; state: "succeeded" | "failed" | "aborted" }[] = [];
    const unknownRuns: RunId[] = [];

    for (const runId of targets) {
      const runEvents = this.byRun.get(runId as string);
      if (runEvents === undefined || runEvents.length === 0) {
        unknownRuns.push(runId);
        continue;
      }
      const projection = projectRunEvents(runId, runEvents);
      if (isTerminalRunState(projection.state)) {
        alreadyTerminal.push({ runId, state: projection.state });
        continue;
      }
      const { resolvedTo, error } = resolveRecoveryConvergence(projection.state, cause);
      const outcome = await this.appendNext(runId, {
        type: "runtime.recovered",
        payload: {
          cause,
          from: projection.state,
          resolvedTo,
          error: {
            code: error.code,
            message: error.message,
            ...(error.details !== undefined ? { details: error.details } : {}),
          },
        },
        evidence: [{ source: "treeai-journal", refId: `recovery:${cause}` }],
        occurredAt: options?.occurredAt,
      });
      if (outcome.status !== "appended") {
        throw new EventJournalError(
          "io",
          `recovery append unexpectedly rejected for run ${runId}: ${outcome.reason}: ${outcome.detail}`,
        );
      }
      recovered.push({
        runId,
        from: projection.state,
        resolvedTo,
        error,
        seq: outcome.event.seq,
        eventId: outcome.event.eventId,
      });
    }

    return { cause, recovered, alreadyTerminal, unknownRuns };
  }

  /* ---- 查询 ---- */

  getRunIds(): readonly RunId[] {
    return [...this.byRun.keys()] as RunId[];
  }

  getRunEvents(runId: RunId): readonly TreeAIEvent[] {
    return [...(this.byRun.get(runId as string) ?? [])];
  }

  listEvents(query?: EventQuery): readonly TreeAIEvent[] {
    const typeSet = query?.types !== undefined ? new Set(query.types as readonly string[]) : null;
    const out = this.events.filter((event) => {
      if (query?.runId !== undefined && (event.runId as string) !== (query.runId as string)) return false;
      if (query?.type !== undefined && event.type !== query.type) return false;
      if (typeSet !== null && !typeSet.has(event.type)) return false;
      if (query?.afterSeq !== undefined && !(event.seq > query.afterSeq)) return false;
      return true;
    });
    return query?.limit !== undefined ? out.slice(0, query.limit) : out;
  }

  projectRunState(runId: RunId): RunProjection | null {
    const runEvents = this.byRun.get(runId as string);
    if (runEvents === undefined || runEvents.length === 0) return null;
    return projectRunEvents(runId, runEvents);
  }

  /* ---- 生命周期 ---- */

  async close(): Promise<void> {
    await this.queue;
    if (this.closed) return;
    this.closed = true;
    await this.store.close();
  }

  /* ---- 内部 ---- */

  private assertOpen(): void {
    if (this.closed) {
      throw new EventJournalError(
        "closed",
        "journal is closed; append/recovery are no longer allowed (queries remain available)",
      );
    }
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const result = this.queue.then(op, op);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/* ------------------------------------------------------------------ */
/* 内存实现                                                            */
/* ------------------------------------------------------------------ */

/** 内存 journal：与文件实现共享全部校验/脱敏/投影逻辑；用于测试与上层 mock。 */
export class MemoryEventJournal extends BaseEventJournal {
  constructor() {
    super(new MemoryLineStore());
  }
}

/* ------------------------------------------------------------------ */
/* JSONL 文件实现                                                      */
/* ------------------------------------------------------------------ */

/**
 * JSONL 文件 journal：每行一个 JSON 序列化的 TreeAIEvent。
 *
 * 打开语义：
 * - 文件不存在则创建（`created: true`）；存在则整文件读入重建索引。
 * - **尾部 torn write 修复**：若文件不以换行结尾，最后一个不完整行视为
 *   崩溃中未提交完成的写，截断至最后一个完整行并报告
 *   （`tornTailRepaired` / `tornTailBytes`）。这是 WAL 的标准恢复做法，
 *   不触碰任何完整事件行。
 * - 文件中部存在无法解析/校验失败/内部不一致（重复 eventId、seq 非递增）
 *   的行：抛 `EventJournalError("corrupt")`（含行号），**不静默跳过**。
 *   修复方式由调用方决定（journal 永不改写既有行）。
 */
export class JsonlEventJournal extends BaseEventJournal {
  private report: JsonlJournalOpenReport;

  private constructor(
    store: JournalLineStore,
    private readonly openInfo: {
      readonly path: string;
      readonly created: boolean;
      readonly tornTailRepaired: boolean;
      readonly tornTailBytes: number;
    },
  ) {
    super(store);
    this.report = {
      path: openInfo.path,
      created: openInfo.created,
      eventsLoaded: 0,
      runsLoaded: 0,
      tornTailRepaired: openInfo.tornTailRepaired,
      tornTailBytes: openInfo.tornTailBytes,
    };
  }

  /** open 时刻的快照（后续追加不改变该报告）。 */
  get openReport(): JsonlJournalOpenReport {
    return this.report;
  }

  static async open(path: string): Promise<JsonlEventJournal> {
    let text = "";
    let created = false;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        created = true;
      } else {
        throw new EventJournalError("io", `failed to read journal file ${path}: ${String(error)}`);
      }
    }

    let tornTailRepaired = false;
    let tornTailBytes = 0;
    if (!created && text.length > 0 && !text.endsWith("\n")) {
      const lastNewline = text.lastIndexOf("\n");
      const validPart = lastNewline < 0 ? "" : text.slice(0, lastNewline + 1);
      tornTailBytes = Buffer.byteLength(text.slice(validPart.length), "utf8");
      tornTailRepaired = true;
      try {
        await truncate(path, Buffer.byteLength(validPart, "utf8"));
      } catch (error) {
        throw new EventJournalError("io", `failed to repair torn tail of journal file ${path}: ${String(error)}`);
      }
      text = validPart;
    }

    const rawLines = text.split("\n");
    if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") {
      rawLines.pop();
    }

    const store = await JsonlLineStore.create(path);
    const journal = new JsonlEventJournal(store, {
      path,
      created,
      tornTailRepaired,
      tornTailBytes,
    });
    try {
      journal.loadFromLines(rawLines, `journal file ${path}`);
    } catch (error) {
      await store.close();
      throw error;
    }
    journal.report = {
      path,
      created,
      eventsLoaded: journal.listEvents().length,
      runsLoaded: journal.getRunIds().length,
      tornTailRepaired,
      tornTailBytes,
    };
    return journal;
  }
}
