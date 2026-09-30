/**
 * 术语三部分（issue #7 C）——① 独立轻量无工具辅助执行器 + ② 保存/推广
 * 的服务装配。
 *
 * ① TerminologyExecutor（执行器）：
 *   - **隔离**：自带 PiRuntime 实例（独立的 provider/model 选择与非推理
 *     thinkingLevel 装配由宿主完成——见 index.ts 的术语运行时装配）、
 *     独立 sessionDir、独立 cwd。绝不触碰主 Pi 会话/游标/pending
 *     Return——解释与提取是瞬态任务，不是树的产品事实（「关闭 10 次零
 *     正式事实/主会话副作用」由构造保证：explain/extract 路径零树写入，
 *     唯一的持久化面是执行器自身的用量记账与偏好 kv）；
 *   - **任务**：queued → running → succeeded/failed/cancelled；取消后
 *     到达的结果**迟到丢弃**（请求已发生，用量照记——诚实成本口径）；
 *   - **三模式**：term（点词）/ range（任意划线）/ auto（整段候选提取
 *     ——任务面能力；**自动保存不开**：质量门禁未过前 auto 结果不落
 *     批注，issue #7 C ① 的冻结纪律）；
 *   - **缓存语境**（issue #7 P0 整改，2026-09-30 验收）：缓存键 =
 *     来源身份（锚点 turn）+ 选区 start/end + 上下文指纹（选区周围
 *     文本窗口）+ 全文指纹 + 模型/prompt/偏好版本——同文同词不同语义
 *     位置必是不同键（各自调用），同锚点同选区才复用；
 *   - **预算预留**（issue #7 P1 整改）：派发前保守预留输入+输出上限
 *     （原文内嵌有上限——超限 explain 取窗口、extract 零派发拒绝）；
 *     额度不足零派发（budget-exceeded）；完成后按**真实 usage 结算**；
 *     取消/超时（user-abort/timeout）的已发请求保留预留、按未知成本
 *     记账（requests ≥ 1，绝不归零）；日/月/用途与未知成本分开记账；
 *     记账落盘失败不静默清账（fail-closed：重启后 dirty 标记拦截新
 *     派发，直至账目可信）；
 *   - **提取的机械校验**（auto）：模型返回 JSON 候选后逐一验证
 *     （term 必须与 source[start,end) 切片全等；偏移为 UTF-16 码元、
 *     界内有序）；去重（同 term 至多一条）、密度上限（默认 8/答案）、
 *     代码/URL 排除（候选区间与反引号围栏或 URL 形态重叠即剔除）。
 *
 * ② TerminologyService（保存/推广）：
 *   - explain：瞬态任务（去重命中已保存批注时直接返回，零模型调用）；
 *   - saveAnnotation：显式保存（落库为产品事实；同选区至多一条）；
 *   - promote：**幂等推广**（issue #7 P0 整改）——单事务原子落库
 *     Branch/Origin + 绑定 + 首问派发意图（派发账本，migration 0009）；
 *     键冲突（同树同键异批注）→ 409 且**零新增行**（无孤儿分支）；
 *     首问身份不可变（payload hash 落账本：同键异问 → 409）；重放判定
 *     只走账本，绝不信「分支上有无 Turn」；结果未知（dispatched）先对
 *     账（Turn/Run 证据）再决定是否重发，对账不决不盲发（surface
 *     reconcile 状态）；明确失败（failed/pending）可重试（新尝试，不
 *     重建枝）。
 */

import { createHash } from "node:crypto";
import type {
  Branch,
  BranchId,
  IsoTimestamp,
  PiModelSelector,
  PiRuntime,
  RunId,
  TerminologyAnnotation,
  TerminologyMode,
  TerminologyPromotionDispatch,
  TerminologyUsageAccount,
  TerminologyUsageDelta,
  TreeAIErrorCode,
  TreeId,
  TurnId,
  TurnSelection,
} from "@treeai/contracts";
import {
  ConstraintViolationError,
  EntityNotFoundError,
  InvalidArgumentError,
  TreeRepository,
} from "@treeai/persistence";
import type { BranchCreation, PromptOutcome, TreeStudioService } from "./service.ts";

/* ------------------------------------------------------------------ */
/* 上下文纪律与预算口径（issue #7 P1 整改，2026-09-30 验收）             */
/* ------------------------------------------------------------------ */

/**
 * explain 提示词内嵌原文的上限（字符）：全文不无限塞入。超限时取选区
 * 两侧窗口（EXPLAIN_CONTEXT_CONTEXT_CHARS），截断在提示词内如实标注；
 * 选区本身超过 MAX_EXPLAIN_SELECTION_CHARS 的新任务零派发拒绝。
 * （《术语完整方案 v2》的「上下文纪律」条目在库内未定位到文本；本组
 * 常数按验收要求「全量 source 不能无限塞入」定界，修改须同步 bump
 * EXPLAIN_PROMPT_VERSION。）
 */
export const EXPLAIN_SOURCE_LIMIT_CHARS = 24_000;
/** explain 窗口模式：选区每侧保留的上下文字符数。 */
export const EXPLAIN_CONTEXT_CONTEXT_CHARS = 8_000;
/** 单次解释的选区上限（超过 → 零派发，selection-too-large）。 */
export const MAX_EXPLAIN_SELECTION_CHARS = 8_000;
/**
 * extract 提示词内嵌原文的上限：extract 的候选偏移必须锚定全文，
 * 截断会破坏偏移纪律——超限零派发拒绝（source-too-large），不做窗口。
 */
export const EXTRACT_SOURCE_LIMIT_CHARS = 24_000;

/** 输出上限的保守估算（字符）：派发前预算预留的 completion 上界。 */
export const MAX_EXPLAIN_COMPLETION_CHARS = 4_000;
export const MAX_EXTRACT_COMPLETION_CHARS = 12_000;

/** explain 提示词版本（buildExplainPrompt 变化时 bump——缓存键成分）。 */
export const EXPLAIN_PROMPT_VERSION = 2;
/** extract 提示词版本（buildExtractPrompt 变化时 bump）。 */
export const EXTRACT_PROMPT_VERSION = 2;
/** 缓存键格式版本（键成分/窗口策略变化时 bump——旧缓存全部失效）。 */
export const TERMINOLOGY_CACHE_FORMAT_VERSION = 2;
/** 上下文指纹窗口：选区每侧纳入 contextHash 的字符数。 */
const CONTEXT_HASH_CHARS = 256;

/* ------------------------------------------------------------------ */
/* 执行器：任务与用量                                                    */
/* ------------------------------------------------------------------ */

export type TerminologyTaskKind = "explain" | "extract";

/** auto 提取的候选（经机械校验后的形状；切片与偏移已验证全等）。 */
export interface TerminologyCandidate {
  readonly term: string;
  readonly start: number;
  readonly end: number;
}

export type TerminologyTaskState =
  | { readonly kind: "queued" }
  | { readonly kind: "running" }
  | {
      readonly kind: "succeeded";
      /** explain 任务的解释文本；extract 任务为 null。 */
      readonly explanation: string | null;
      /** extract 任务经验证的候选；explain 任务为 null。 */
      readonly candidates: readonly TerminologyCandidate[] | null;
      readonly cached: boolean;
      readonly usage: TerminologyUsageDelta;
    }
  | { readonly kind: "failed"; readonly code: string; readonly message: string }
  | { readonly kind: "cancelled"; readonly lateResultDiscarded: boolean };

export interface TerminologyTask {
  readonly id: string;
  readonly kind: TerminologyTaskKind;
  readonly mode: TerminologyMode;
  readonly treeId: TreeId | null;
  /** explain：被解释的术语；extract：null。 */
  readonly term: string | null;
  readonly selection: TurnSelection | null;
  readonly createdAt: IsoTimestamp;
  readonly state: TerminologyTaskState;
}

export interface TerminologyExecutorOptions {
  /** 隔离的 PiRuntime（独立 sessionDir/provider 装配由宿主完成）。 */
  readonly runtime: PiRuntime;
  readonly model: PiModelSelector;
  /** 执行器专用 session 目录。 */
  readonly sessionDir: string;
  /** 执行器专用工作目录。 */
  readonly cwd: string;
  /** 累计估算 token 预算（chars/4 口径）；达到后新任务 fail-closed。 */
  readonly budgetTokens: number;
  /** 缓存偏好（默认 true：同键解释复用缓存，零新请求）。 */
  readonly cacheEnabled: boolean;
  /**
   * 缓存作用域附加标识（偏好版本面：宿主装配的 thinkingLevel 等）——
   * 变化即令旧缓存失效（键成分）。
   */
  readonly cacheScope?: string;
  /**
   * 重启恢复注入的既有用量（null = 从零开始）。形状向后兼容：缺省的
   * 新字段按 0/空补齐；dirty=true（上次进程在派发中途退出）会令记账
   * 不可信 → 新派发 fail-closed。
   */
  readonly initialUsage?: TerminologyExecutorUsage | null;
  /**
   * 重启时持久化用量不可解析（损坏 kv）→ true：记账不可信，新派发
   * fail-closed（绝不从零静默清账）。恢复动作（清除 kv / 提高预算）
   * 由宿主/用户显式执行。
   */
  readonly initialUsageCorrupt?: boolean;
  /** 用量变化回调（宿主持久化到 repository kv；抛错会计入 fail-closed）。 */
  readonly onUsage?: (usage: TerminologyExecutorUsage) => void;
  /** 时钟注入（测试确定性）。 */
  readonly now?: () => IsoTimestamp;
  /** id 生成注入（测试确定性）。 */
  readonly generateId?: () => string;
}

/** 单个 (日, 用途) 桶的用量（unknownRequests 单列——未知成本分开记账）。 */
export interface TerminologyUsageBucket extends TerminologyUsageDelta {
  /** 结果未知（取消/超时/在途失败）的请求数：completion 成本不可知。 */
  readonly unknownRequests: number;
}

/**
 * 执行器内部用量记账（kv 持久化的 JSON 形状；total 汇总的源数据，
 * estTokens 派生）。向后兼容旧形状（无新字段时按零/空补齐）。
 */
export interface TerminologyExecutorUsage {
  readonly total: TerminologyUsageDelta;
  readonly lateResultsDiscarded: number;
  /** 结果未知（取消/超时/在途失败）的请求数（保守口径已计入 total）。 */
  readonly unknownCostRequests: number;
  /** 按日 × 用途分桶（键 "YYYY-MM-DD|explain|extract"；UTC 日界）。 */
  readonly buckets: Readonly<Record<string, TerminologyUsageBucket>>;
  /**
   * true = 有派发在途时进程退出（或记账落盘失败）：持久化值可能
   * 少记，重启后新派发 fail-closed 直至显式恢复。
   */
  readonly dirty: boolean;
}

/** 旧形状（total + lateResultsDiscarded）兼容还原：缺省字段补零/空。 */
export function normalizeExecutorUsage(raw: unknown): TerminologyExecutorUsage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as {
    total?: unknown;
    lateResultsDiscarded?: unknown;
    unknownCostRequests?: unknown;
    buckets?: unknown;
    dirty?: unknown;
  };
  const total = record.total;
  if (
    typeof total !== "object" ||
    total === null ||
    typeof (total as { requests?: unknown }).requests !== "number" ||
    typeof (total as { promptChars?: unknown }).promptChars !== "number" ||
    typeof (total as { completionChars?: unknown }).completionChars !== "number"
  ) {
    return null;
  }
  const buckets: Record<string, TerminologyUsageBucket> = {};
  if (typeof record.buckets === "object" && record.buckets !== null) {
    for (const [key, value] of Object.entries(record.buckets as Record<string, unknown>)) {
      if (typeof value !== "object" || value === null) continue;
      const bucket = value as { requests?: unknown; promptChars?: unknown; completionChars?: unknown; unknownRequests?: unknown };
      if (
        typeof bucket.requests !== "number" ||
        typeof bucket.promptChars !== "number" ||
        typeof bucket.completionChars !== "number"
      ) {
        continue;
      }
      buckets[key] = {
        requests: bucket.requests,
        promptChars: bucket.promptChars,
        completionChars: bucket.completionChars,
        unknownRequests: typeof bucket.unknownRequests === "number" ? bucket.unknownRequests : 0,
      };
    }
  }
  return {
    total: {
      requests: (total as { requests: number }).requests,
      promptChars: (total as { promptChars: number }).promptChars,
      completionChars: (total as { completionChars: number }).completionChars,
    },
    lateResultsDiscarded: typeof record.lateResultsDiscarded === "number" ? record.lateResultsDiscarded : 0,
    unknownCostRequests: typeof record.unknownCostRequests === "number" ? record.unknownCostRequests : 0,
    buckets,
    dirty: record.dirty === true,
  };
}

/**
 * 用量账户投影（读模型）：在 contracts 的 TerminologyUsageAccount 之上
 * 增列未知成本与日/月/用途聚合（日界 UTC——执行器时钟即 ISO UTC）。
 */
export interface TerminologyUsageReport extends TerminologyUsageAccount {
  /** 结果未知（取消/超时/在途失败）的请求数：completion 按保守上界计入 estTokens。 */
  readonly unknownCostRequests: number;
  /** 按用途聚合（explain / extract；桶含 unknownRequests 单列）。 */
  readonly byPurpose: Readonly<Record<"explain" | "extract", TerminologyUsageBucket>>;
  /** 当日（UTC）聚合。 */
  readonly today: TerminologyUsageDelta;
  /** 当月（UTC）聚合。 */
  readonly monthToDate: TerminologyUsageDelta;
}

const ZERO_USAGE: TerminologyUsageDelta = { requests: 0, promptChars: 0, completionChars: 0 };

/** 估算 token（诚实口径：chars/4；Pi 契约面不透出 token 用量）。 */
function estimateTokens(usage: TerminologyUsageDelta): number {
  return Math.ceil((usage.promptChars + usage.completionChars) / 4);
}

function addUsage(a: TerminologyUsageDelta, b: TerminologyUsageDelta): TerminologyUsageDelta {
  return {
    requests: a.requests + b.requests,
    promptChars: a.promptChars + b.promptChars,
    completionChars: a.completionChars + b.completionChars,
  };
}

/** 记账失败（不可信账目）时新任务的 fail-closed 错误码。 */
export const USAGE_ACCOUNTING_UNAVAILABLE = "usage-accounting-unavailable";

function toTreeAIErrorCode(err: unknown): string {
  if (err !== null && typeof err === "object" && "code" in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "unknown";
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 解释任务的提示词（点词/划线共用；标记区间以 UTF-16 偏移给出；截断说明置于 [Passage] 之外——偏移只对 passage 成立）。 */
export function buildExplainPrompt(
  sourceText: string,
  selection: TurnSelection,
  truncationNote: string | null = null,
): string {
  const note = truncationNote === null ? "" : `${truncationNote}\n\n`;
  return (
    note +
    "Explain the marked span for a reader of the passage below. Plain text, 2-4 sentences, no markdown, " +
    "no headings. If the span is not a meaningful term or concept, say so plainly in one sentence.\n\n" +
    `[Passage]\n${sourceText}\n\n` +
    `[Marked span]\n"${selection.text}" (character offsets ${String(selection.start)}..${String(selection.end)} in the passage)`
  );
}

/** prepareExplainPassage 的产物（截断时 selection 已重映射到窗口内偏移）。 */
export interface PreparedExplainPassage {
  /** 实际内嵌进提示词的原文（截断时为选区两侧窗口）。 */
  readonly passage: string;
  /** 相对 passage 重映射后的选区。 */
  readonly selection: TurnSelection;
  readonly sourceLength: number;
  readonly truncated: boolean;
  /** 截断说明（未截断为 null；置于 [Passage] 之外，不扰动偏移）。 */
  readonly truncationNote: string | null;
}

/**
 * 上下文纪律（issue #7 P1 整改）：原文不超过 EXPLAIN_SOURCE_LIMIT_CHARS
 * 时全文内嵌；超限取选区两侧 EXPLAIN_CONTEXT_CONTEXT_CHARS 窗口并如实
 * 标注截断（偏移重映射到窗口）。选区自身超过 MAX_EXPLAIN_SELECTION_CHARS
 * 返回哨兵（新任务零派发拒绝——单次解释容不下）。
 */
export function prepareExplainPassage(
  sourceText: string,
  selection: TurnSelection,
): PreparedExplainPassage | "selection-too-large" {
  if (selection.end - selection.start > MAX_EXPLAIN_SELECTION_CHARS) return "selection-too-large";
  if (sourceText.length <= EXPLAIN_SOURCE_LIMIT_CHARS) {
    return { passage: sourceText, selection, sourceLength: sourceText.length, truncated: false, truncationNote: null };
  }
  const windowStart = Math.max(0, selection.start - EXPLAIN_CONTEXT_CONTEXT_CHARS);
  const windowEnd = Math.min(sourceText.length, selection.end + EXPLAIN_CONTEXT_CONTEXT_CHARS);
  return {
    passage: sourceText.slice(windowStart, windowEnd),
    selection: {
      start: selection.start - windowStart,
      end: selection.end - windowStart,
      text: selection.text,
    },
    sourceLength: sourceText.length,
    truncated: true,
    truncationNote:
      `[Passage truncated: the original answer is ${String(sourceText.length)} characters; ` +
      `showing the ${String(windowEnd - windowStart)} characters around the marked span]`,
  };
}

/** auto 提取任务的提示词（要求 JSON 数组；机械校验在后）。 */
export function buildExtractPrompt(sourceText: string, maxTerms: number): string {
  return (
    `List up to ${String(maxTerms)} specialized terms in the passage below that a general reader would likely not ` +
    "understand, most important first. A qualifying term is a domain-specific expression — a named concept, " +
    "technique, entity, or jargon phrase that needs a definition. Do NOT mark:\n" +
    "- ordinary vocabulary even if it sounds technical in context (e.g. common words like signal, noise, " +
    "amplitude, nodes, replicas used in their ordinary meaning);\n" +
    "- code snippets, URLs, commands, file paths;\n" +
    "- single everyday words; prefer the full technical phrase when one exists.\n" +
    "When unsure, leave the word out — precision beats recall here.\n" +
    "Reply with ONLY a JSON array of objects " +
    '{"term": "...", "start": N, "end": M} where start/end are character offsets into the passage ' +
    "(UTF-16 code units, start inclusive, end exclusive; the passage slice [start,end) must equal the term). " +
    "If there are none, reply with [].\n\n" +
    `[Passage]\n${sourceText}`
  );
}

/**
 * 从模型回答中解析 JSON 数组（提取任务）：取回答中首个平衡的 [...] 片段
 * 解析；形状不符的条目剔除（不是整个任务失败——诚实呈现可解析部分；
 * 完全无 JSON → 返回 null，任务 failed）。
 */
export function parseCandidates(
  raw: string,
): ReadonlyArray<{ term?: unknown; start?: unknown; end?: unknown }> | null {
  const start = raw.indexOf("[");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "[") depth += 1;
    if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(raw.slice(start, i + 1));
          if (Array.isArray(parsed)) return parsed as ReadonlyArray<Record<string, unknown>>;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** 源文本中的 URL / 反引号围栏区间（auto 提取的排除带）。 */
export function excludedSpans(sourceText: string): ReadonlyArray<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  const url = /https?:\/\/[^\s）)》>"']+|www\.[^\s）)》>"']+/g;
  for (const match of sourceText.matchAll(url)) {
    if (match.index === undefined) continue;
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  const fence = /`[^`]*`/g;
  for (const match of sourceText.matchAll(fence)) {
    if (match.index === undefined) continue;
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return spans;
}

/**
 * 候选机械校验（auto 提取）：
 * - term 为非空字符串，start/end 为整数、界内有序；
 * - 切片全等：source.slice(start, end) === term（模型偏移错位即剔除，
 *   绝不修正——来源匹配 100% 是冻结目标）；
 * - 去重（同 term 至多一条，保留首个）；
 * - 密度上限（maxTerms，保留前 N）；
 * - 代码/URL 排除（候选区间与排除带重叠即剔除）。
 */
export function validateCandidates(
  sourceText: string,
  raw: ReadonlyArray<{ term?: unknown; start?: unknown; end?: unknown }>,
  maxTerms: number,
): TerminologyCandidate[] {
  const seen = new Set<string>();
  const excluded = excludedSpans(sourceText);
  const accepted: TerminologyCandidate[] = [];
  for (const entry of raw) {
    const term = entry.term;
    const start = entry.start;
    const end = entry.end;
    if (typeof term !== "string" || term.length === 0 || term.length > 200) continue;
    if (typeof start !== "number" || typeof end !== "number") continue;
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
    if (start < 0 || end <= start || end > sourceText.length) continue;
    if (sourceText.slice(start, end) !== term) continue;
    if (seen.has(term)) continue;
    if (excluded.some((span) => start < span.end && span.start < end)) continue;
    seen.add(term);
    accepted.push({ term, start, end });
    if (accepted.length >= maxTerms) break;
  }
  return accepted;
}

/** 执行器内部任务簿记（state 可变；对外投影为 TerminologyTask 拷贝）。 */
interface ExecutorTask {
  readonly id: string;
  readonly kind: TerminologyTaskKind;
  readonly mode: TerminologyMode;
  readonly treeId: TreeId | null;
  readonly term: string | null;
  readonly selection: TurnSelection | null;
  readonly createdAt: IsoTimestamp;
  state: TerminologyTaskState;
  cancelRequested: boolean;
}

const MAX_EXTRACT_TERMS = 8;
const RECENT_TASKS_LIMIT = 50;

/**
 * 术语执行器（①）。单用户语义：任务串行执行（内部链；后继任务排队），
 * 与主服务的单在途 prompt 纪律一致。
 *
 * 记账纪律（issue #7 P1 整改，2026-09-30 验收）：
 * - 派发前：预算按「已用 + 本次预留（输入实测 + 输出保守上界）」检查，
 *   额度不足零派发；预留前先把 dirty 标记落盘（进程中断后重启可见）；
 * - 派发后：按真实 usage 结算（预留的保守 completion 上界被真实值替换）；
 * - 取消（user-abort）/超时（timeout）：已发请求保留预留（保守上界计入
 *   estTokens）并单列 unknownCostRequests——requests ≥ 1，绝不归零；
 * - 落盘失败：记账不可信 → 后续新任务 fail-closed（usage-accounting-
 *   unavailable），绝不静默从零重启清账；重启时 dirty 持久标记同理拦截。
 */
export class TerminologyExecutor {
  readonly #runtime: PiRuntime;
  readonly #model: PiModelSelector;
  readonly #sessionDir: string;
  readonly #cwd: string;
  readonly #budgetTokens: number;
  #cacheEnabled: boolean;
  readonly #cacheScope: string;
  readonly #cache = new Map<string, string>();
  #usage: TerminologyExecutorUsage;
  /** 记账可信度：false（落盘失败 / 重启 dirty / kv 损坏）→ 新派发 fail-closed。 */
  #accountingTrusted: boolean;
  readonly #onUsage: ((usage: TerminologyExecutorUsage) => void) | null;
  readonly #now: () => IsoTimestamp;
  readonly #generateId: () => string;
  readonly #tasks = new Map<string, ExecutorTask>();
  readonly #taskOrder: string[] = [];
  /** 串行链：同一时刻至多一个执行器 prompt 在途。 */
  #tail: Promise<void> = Promise.resolve();

  constructor(options: TerminologyExecutorOptions) {
    this.#runtime = options.runtime;
    this.#model = options.model;
    this.#sessionDir = options.sessionDir;
    this.#cwd = options.cwd;
    this.#budgetTokens = options.budgetTokens;
    this.#cacheEnabled = options.cacheEnabled;
    this.#cacheScope = options.cacheScope ?? "";
    const initial = options.initialUsage ?? null;
    this.#usage =
      initial ??
      { total: ZERO_USAGE, lateResultsDiscarded: 0, unknownCostRequests: 0, buckets: {}, dirty: false };
    this.#accountingTrusted =
      options.initialUsageCorrupt !== true && this.#usage.dirty !== true;
    this.#onUsage = options.onUsage ?? null;
    this.#now = options.now ?? ((): IsoTimestamp => new Date().toISOString());
    this.#generateId = options.generateId ?? ((): string => `term-task-${Math.random().toString(36).slice(2, 10)}`);
  }

  get cacheEnabled(): boolean {
    return this.#cacheEnabled;
  }

  setCacheEnabled(value: boolean): void {
    this.#cacheEnabled = value;
    if (!value) this.#cache.clear();
  }

  /** 用量账户（预算、未知成本与日/月/用途聚合的投影）。 */
  usage(): TerminologyUsageReport {
    const today = this.#now().slice(0, 10);
    const month = today.slice(0, 7);
    let todayUsage = ZERO_USAGE;
    let monthUsage = ZERO_USAGE;
    let explainUsage: TerminologyUsageBucket = { ...ZERO_USAGE, unknownRequests: 0 };
    let extractUsage: TerminologyUsageBucket = { ...ZERO_USAGE, unknownRequests: 0 };
    for (const [key, bucket] of Object.entries(this.#usage.buckets)) {
      const delta: TerminologyUsageDelta = {
        requests: bucket.requests,
        promptChars: bucket.promptChars,
        completionChars: bucket.completionChars,
      };
      const separator = key.indexOf("|");
      const day = separator >= 0 ? key.slice(0, separator) : "";
      const purpose = separator >= 0 ? key.slice(separator + 1) : "";
      if (day === today) todayUsage = addUsage(todayUsage, delta);
      if (day.startsWith(month)) monthUsage = addUsage(monthUsage, delta);
      if (purpose === "explain") {
        explainUsage = {
          ...addUsage(explainUsage, delta),
          unknownRequests: explainUsage.unknownRequests + bucket.unknownRequests,
        };
      }
      if (purpose === "extract") {
        extractUsage = {
          ...addUsage(extractUsage, delta),
          unknownRequests: extractUsage.unknownRequests + bucket.unknownRequests,
        };
      }
    }
    return {
      total: this.#usage.total,
      estTokens: estimateTokens(this.#usage.total),
      lateResultsDiscarded: this.#usage.lateResultsDiscarded,
      budgetTokens: this.#budgetTokens,
      unknownCostRequests: this.#usage.unknownCostRequests,
      byPurpose: { explain: explainUsage, extract: extractUsage },
      today: todayUsage,
      monthToDate: monthUsage,
    };
  }

  /** 近期任务投影（最新在后；进程内瞬态——不是产品事实）。 */
  listTasks(): readonly TerminologyTask[] {
    return this.#taskOrder
      .slice(-RECENT_TASKS_LIMIT)
      .map((id) => this.#tasks.get(id))
      .filter((task): task is ExecutorTask => task !== undefined)
      .map((task) => ({
        id: task.id,
        kind: task.kind,
        mode: task.mode,
        treeId: task.treeId,
        term: task.term,
        selection: task.selection,
        createdAt: task.createdAt,
        state: task.state,
      }));
  }

  findTask(taskId: string): TerminologyTask | null {
    const task = this.#tasks.get(taskId);
    return task === undefined
      ? null
      : {
          id: task.id,
          kind: task.kind,
          mode: task.mode,
          treeId: task.treeId,
          term: task.term,
          selection: task.selection,
          createdAt: task.createdAt,
          state: task.state,
        };
  }

  /** 内存账目应用一条用量（unknown = 未知成本：completion 按保守上界计入并单列）。 */
  #applyUsage(purpose: TerminologyTaskKind, delta: TerminologyUsageDelta, unknown: boolean): void {
    const day = this.#now().slice(0, 10);
    const key = `${day}|${purpose}`;
    const prior = this.#usage.buckets[key] ?? {
      requests: 0,
      promptChars: 0,
      completionChars: 0,
      unknownRequests: 0,
    };
    const buckets: Record<string, TerminologyUsageBucket> = { ...this.#usage.buckets };
    buckets[key] = {
      requests: prior.requests + delta.requests,
      promptChars: prior.promptChars + delta.promptChars,
      completionChars: prior.completionChars + delta.completionChars,
      unknownRequests: prior.unknownRequests + (unknown ? delta.requests : 0),
    };
    this.#usage = {
      ...this.#usage,
      total: addUsage(this.#usage.total, delta),
      unknownCostRequests: this.#usage.unknownCostRequests + (unknown ? delta.requests : 0),
      buckets,
    };
  }

  /** 迟到结果计数（请求已完成，结果被丢弃——诚实成本口径的伴生计数）。 */
  #applyLateResult(): void {
    this.#usage = { ...this.#usage, lateResultsDiscarded: this.#usage.lateResultsDiscarded + 1 };
  }

  /** 落盘当前账目快照；失败 → 记账不可信（返回 false，调用方 fail-closed）。 */
  #persistUsage(): boolean {
    if (this.#onUsage === null) return true;
    try {
      this.#onUsage(this.#usage);
      return true;
    } catch {
      return false;
    }
  }

  /** 派发前置 dirty：账目快照（dirty=true）必须先于模型请求落盘成功。 */
  #markDirty(): boolean {
    this.#usage = { ...this.#usage, dirty: true };
    if (!this.#persistUsage()) {
      this.#accountingTrusted = false;
      return false;
    }
    return true;
  }

  /** 结算落盘：应用后的账目（dirty=false）持久化；失败 → 后续 fail-closed。 */
  #settleAccounting(): void {
    this.#usage = { ...this.#usage, dirty: false };
    if (!this.#persistUsage()) {
      this.#accountingTrusted = false;
    }
  }

  /**
   * 派发前预算/记账预检（零派发门）：
   * - 记账不可信（落盘失败 / 重启 dirty / kv 损坏）→ fail-closed；
   * - 「已用 + 预留（输入实测 + 输出保守上界）」超预算 → budget-exceeded。
   */
  #preflightDispatch(reservation: TerminologyUsageDelta): { code: string; message: string } | null {
    if (!this.#accountingTrusted) {
      return {
        code: USAGE_ACCOUNTING_UNAVAILABLE,
        message:
          "the terminology usage accounting is not trustworthy in this process (a persistence failure or an " +
          "interrupted dispatch left it unverified); no new request is dispatched until the accounting is reset or verified",
      };
    }
    const usedPlusReserved = addUsage(this.#usage.total, reservation);
    if (estimateTokens(usedPlusReserved) > this.#budgetTokens) {
      return {
        code: "budget-exceeded",
        message:
          `this request needs a conservative reservation of ~${String(estimateTokens(reservation))} est tokens ` +
          `(input ${String(reservation.promptChars)} chars + output bound ${String(reservation.completionChars)} chars, ` +
          `settled by real usage after completion), but only ${String(Math.max(0, this.#budgetTokens - estimateTokens(this.#usage.total)))} ` +
          `of the ${String(this.#budgetTokens)}-token budget remain (used ~${String(estimateTokens(this.#usage.total))}); ` +
          "zero dispatch — raise the budget to continue",
      };
    }
    return null;
  }

  /** 缓存作用域键（模型 / prompt 版本 / 偏好装配 / 键格式——变化即失效）。 */
  #cacheScopeKey(): string {
    return [
      `v${String(TERMINOLOGY_CACHE_FORMAT_VERSION)}`,
      `pv${String(EXPLAIN_PROMPT_VERSION)}`,
      `${this.#model.providerId}/${this.#model.modelId}`,
      this.#cacheScope,
    ].join("|");
  }

  /**
   * 上下文指纹：选区两侧各 CONTEXT_HASH_CHARS 字符的窗口身份——同词在
   * 不同语义位置（不同上下文）必是不同键（issue #7 P0 整改）。
   */
  #contextHash(sourceText: string, selection: TurnSelection): string {
    const contextStart = Math.max(0, selection.start - CONTEXT_HASH_CHARS);
    const contextEnd = Math.min(sourceText.length, selection.end + CONTEXT_HASH_CHARS);
    const before = sourceText.slice(contextStart, selection.start);
    const after = sourceText.slice(selection.end, contextEnd);
    return createHash("sha256").update(`${before}\u0001${after}`, "utf8").digest("hex").slice(0, 16);
  }

  /**
   * 缓存键（issue #7 P0 整改）：作用域（版本/模型/偏好）+ 模式 + 来源身份
   * （锚点 turn）+ 全文指纹 + 选区 start/end + 上下文指纹。同文同词不同
   * 语义位置 → 不同键（各自调用）；同锚点同选区才复用。
   */
  #cacheKey(
    mode: TerminologyMode,
    sourceId: string,
    sourceHash: string,
    selection: TurnSelection,
    contextHash: string,
  ): string {
    return [
      this.#cacheScopeKey(),
      mode,
      sourceId,
      sourceHash,
      String(selection.start),
      String(selection.end),
      contextHash,
    ].join("|");
  }

  /** 取消任务：queued/running 即刻呈 cancelled（running 的运行期调用仍在
      途——其结果到达后迟到丢弃；abort 仅对 running 任务发出：任务串行，
      abort 会打断隔离 runtime 上唯一的在途 prompt，绝不能误伤他任务）。 */
  cancel(taskId: string): TerminologyTask {
    const task = this.#tasks.get(taskId);
    if (task === undefined) throw new EntityNotFoundError("terminology task", taskId);
    const priorKind = task.state.kind;
    if (priorKind === "queued" || priorKind === "running") {
      task.cancelRequested = true;
      task.state = { kind: "cancelled", lateResultDiscarded: false };
      if (priorKind === "running") {
        void this.#runtime.abort().catch(() => undefined);
      }
    }
    return this.findTask(taskId)!;
  }

  /**
   * 解释任务（term/range）：await 至终态。缓存命中零请求零新 session
   * （键含来源身份/选区位置/上下文指纹——同词不同语义位置不复用）；
   * 预算按「已用 + 保守预留」预检（不足零派发）；取消后到达的结果迟到
   * 丢弃（用量照记）；已发请求的取消/超时按未知成本记账，绝不归零。
   */
  async explain(input: {
    readonly treeId: TreeId | null;
    /** 来源身份：选区所属的锚点 turn（缓存键成分；同词异位不复用）。 */
    readonly sourceId: string;
    readonly mode: TerminologyMode;
    readonly selection: TurnSelection;
    readonly sourceText: string;
    readonly sourceHash: string;
  }): Promise<TerminologyTask> {
    if (input.mode !== "term" && input.mode !== "range") {
      throw new InvalidArgumentError(`explain mode must be 'term' or 'range' (got '${String(input.mode)}')`);
    }
    if (typeof input.sourceId !== "string" || input.sourceId.length === 0) {
      throw new InvalidArgumentError("explain sourceId (the anchor turn the selection belongs to) must be a non-empty string");
    }
    const task: ExecutorTask = {
      id: this.#generateId(),
      kind: "explain",
      mode: input.mode,
      treeId: input.treeId,
      term: input.selection.text,
      selection: input.selection,
      createdAt: this.#now(),
      state: { kind: "queued" },
      cancelRequested: false,
    };
    this.#register(task);
    await this.#enqueue(async () => {
      if (task.cancelRequested) {
        task.state = { kind: "cancelled", lateResultDiscarded: false };
        return;
      }
      const cacheKey = this.#cacheKey(
        input.mode,
        input.sourceId,
        input.sourceHash,
        input.selection,
        this.#contextHash(input.sourceText, input.selection),
      );
      if (this.#cacheEnabled && this.#cache.has(cacheKey)) {
        const explanation = this.#cache.get(cacheKey)!;
        task.state = {
          kind: "succeeded",
          explanation,
          candidates: null,
          cached: true,
          usage: ZERO_USAGE,
        };
        return;
      }
      /* 上下文纪律：全文超限时取窗口（截断如实标注），选区超限零派发。 */
      const prepared = prepareExplainPassage(input.sourceText, input.selection);
      if (prepared === "selection-too-large") {
        task.state = {
          kind: "failed",
          code: "selection-too-large",
          message:
            `the selection is ${String(input.selection.end - input.selection.start)} characters; a single explain ` +
            `request accepts at most ${String(MAX_EXPLAIN_SELECTION_CHARS)} (context discipline), zero dispatch`,
        };
        return;
      }
      const promptText = buildExplainPrompt(prepared.passage, prepared.selection, prepared.truncationNote);
      /* 预算预留：输入实测 + 输出保守上界；不足零派发。 */
      const reservation: TerminologyUsageDelta = {
        requests: 1,
        promptChars: promptText.length,
        completionChars: MAX_EXPLAIN_COMPLETION_CHARS,
      };
      const preflight = this.#preflightDispatch(reservation);
      if (preflight !== null) {
        task.state = { kind: "failed", code: preflight.code, message: preflight.message };
        return;
      }
      /* 派发前置 dirty 落盘：进程中断后重启以持久标记拦截新派发。 */
      if (!this.#markDirty()) {
        task.state = {
          kind: "failed",
          code: USAGE_ACCOUNTING_UNAVAILABLE,
          message: "the usage accounting could not be persisted before dispatch; zero dispatch (fail-closed)",
        };
        return;
      }
      task.state = { kind: "running" };
      let promptSent = false;
      try {
        await this.#runtime.createSession({
          model: this.#model,
          cwd: this.#cwd,
          sessionDir: this.#sessionDir,
        });
        promptSent = true;
        const result = await this.#runtime.prompt({ text: promptText });
        /* 成功：按真实 usage 结算（预留的输出上界被真实值替换）。 */
        const usage: TerminologyUsageDelta = {
          requests: 1,
          promptChars: promptText.length,
          completionChars: result.message.length,
        };
        this.#applyUsage("explain", usage, false);
        this.#settleAccounting();
        if (task.cancelRequested) {
          this.#applyLateResult();
          if (!this.#persistUsage()) this.#accountingTrusted = false;
          task.state = { kind: "cancelled", lateResultDiscarded: true };
          return;
        }
        if (this.#cacheEnabled) this.#cache.set(cacheKey, result.message);
        task.state = {
          kind: "succeeded",
          explanation: result.message,
          candidates: null,
          cached: false,
          usage,
        };
      } catch (err) {
        const code = toTreeAIErrorCode(err);
        const cancelled = task.cancelRequested || code === "user-abort";
        if (promptSent) {
          /* 已发请求的诚实成本：绝不归零。取消/超时（结果不可知）保留
             预留（输出保守上界计入）并单列未知成本；其余明确失败按
             prompt 已计费、completion 为 0 记账（失败由运行期同步回执）。 */
          const unknown = cancelled || code === "timeout";
          this.#applyUsage(
            "explain",
            {
              requests: 1,
              promptChars: promptText.length,
              completionChars: unknown ? MAX_EXPLAIN_COMPLETION_CHARS : 0,
            },
            unknown,
          );
          this.#settleAccounting();
        } else {
          /* 请求未发出（createSession 阶段失败）：零请求成本，清 dirty。 */
          this.#settleAccounting();
        }
        if (cancelled) {
          task.state = { kind: "cancelled", lateResultDiscarded: false };
          return;
        }
        task.state = { kind: "failed", code, message: toErrorMessage(err) };
      }
    });
    return this.findTask(task.id)!;
  }

  /**
   * 提取任务（auto）：整段候选提取 + 机械校验（切片全等/去重/密度/代码
   * URL 排除）。任务面能力——**结果不落批注**（自动保存的质量门禁未过）。
   * 上下文纪律：extract 偏移锚定全文，原文超限零派发拒绝（不截断）；
   * 预算按「已用 + 保守预留」预检；已发请求的取消/超时按未知成本记账。
   */
  async extract(input: {
    readonly treeId: TreeId | null;
    readonly sourceText: string;
    readonly sourceHash: string;
  }): Promise<TerminologyTask> {
    const task: ExecutorTask = {
      id: this.#generateId(),
      kind: "extract",
      mode: "auto",
      treeId: input.treeId,
      term: null,
      selection: null,
      createdAt: this.#now(),
      state: { kind: "queued" },
      cancelRequested: false,
    };
    this.#register(task);
    await this.#enqueue(async () => {
      if (task.cancelRequested) {
        task.state = { kind: "cancelled", lateResultDiscarded: false };
        return;
      }
      if (input.sourceText.length > EXTRACT_SOURCE_LIMIT_CHARS) {
        task.state = {
          kind: "failed",
          code: "source-too-large",
          message:
            `the answer is ${String(input.sourceText.length)} characters; a single extract request accepts at most ` +
            `${String(EXTRACT_SOURCE_LIMIT_CHARS)} (candidate offsets must anchor the full text — truncation would break them), zero dispatch`,
        };
        return;
      }
      task.state = { kind: "running" };
      const promptText = buildExtractPrompt(input.sourceText, MAX_EXTRACT_TERMS);
      /* 预算预留：输入实测 + 输出保守上界；不足零派发。 */
      const reservation: TerminologyUsageDelta = {
        requests: 1,
        promptChars: promptText.length,
        completionChars: MAX_EXTRACT_COMPLETION_CHARS,
      };
      const preflight = this.#preflightDispatch(reservation);
      if (preflight !== null) {
        task.state = { kind: "failed", code: preflight.code, message: preflight.message };
        return;
      }
      if (!this.#markDirty()) {
        task.state = {
          kind: "failed",
          code: USAGE_ACCOUNTING_UNAVAILABLE,
          message: "the usage accounting could not be persisted before dispatch; zero dispatch (fail-closed)",
        };
        return;
      }
      let promptSent = false;
      try {
        await this.#runtime.createSession({
          model: this.#model,
          cwd: this.#cwd,
          sessionDir: this.#sessionDir,
        });
        promptSent = true;
        const result = await this.#runtime.prompt({ text: promptText });
        const usage: TerminologyUsageDelta = {
          requests: 1,
          promptChars: promptText.length,
          completionChars: result.message.length,
        };
        this.#applyUsage("extract", usage, false);
        this.#settleAccounting();
        if (task.cancelRequested) {
          this.#applyLateResult();
          if (!this.#persistUsage()) this.#accountingTrusted = false;
          task.state = { kind: "cancelled", lateResultDiscarded: true };
          return;
        }
        const raw = parseCandidates(result.message);
        if (raw === null) {
          task.state = {
            kind: "failed",
            code: "terminology-parse",
            message: "the model answer did not contain a parseable JSON candidate array",
          };
          return;
        }
        const candidates = validateCandidates(input.sourceText, raw, MAX_EXTRACT_TERMS);
        task.state = {
          kind: "succeeded",
          explanation: null,
          candidates,
          cached: false,
          usage,
        };
      } catch (err) {
        const code = toTreeAIErrorCode(err);
        const cancelled = task.cancelRequested || code === "user-abort";
        if (promptSent) {
          const unknown = cancelled || code === "timeout";
          this.#applyUsage(
            "extract",
            {
              requests: 1,
              promptChars: promptText.length,
              completionChars: unknown ? MAX_EXTRACT_COMPLETION_CHARS : 0,
            },
            unknown,
          );
          this.#settleAccounting();
        } else {
          this.#settleAccounting();
        }
        if (cancelled) {
          task.state = { kind: "cancelled", lateResultDiscarded: false };
          return;
        }
        task.state = { kind: "failed", code, message: toErrorMessage(err) };
      }
    });
    return this.findTask(task.id)!;
  }

  #register(task: ExecutorTask): void {
    this.#tasks.set(task.id, task);
    this.#taskOrder.push(task.id);
    if (this.#taskOrder.length > RECENT_TASKS_LIMIT * 2) {
      const evict = this.#taskOrder.splice(0, this.#taskOrder.length - RECENT_TASKS_LIMIT * 2);
      for (const id of evict) this.#tasks.delete(id);
    }
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.#tail.then(operation, operation);
    this.#tail = next.catch(() => undefined);
    return next;
  }

  async dispose(): Promise<void> {
    await this.#runtime.dispose();
  }
}

/* ------------------------------------------------------------------ */
/* 服务：保存 / 幂等推广 / 读模型                                        */
/* ------------------------------------------------------------------ */

/** 推广与批注当前状态冲突（同批注异键 / 已推广后异键重试）→ 409。 */
export class TerminologyPromotionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminologyPromotionConflictError";
  }
}

export interface TerminologyServiceOptions {
  readonly repository: TreeRepository;
  readonly executor: TerminologyExecutor;
  /** 主产品服务（推广复用其 Anchor/Branch/Origin/Run/prompt 机制）。 */
  readonly studio: TreeStudioService;
}

export interface ExplainOutcome {
  /** 去重命中的既有批注（零模型调用）；null = 本次是瞬态任务结果。 */
  readonly annotation: TerminologyAnnotation | null;
  readonly task: TerminologyTask | null;
}

export interface SaveAnnotationOutcome {
  readonly annotation: TerminologyAnnotation;
  /** false = 同选区既有批注（零写入）。 */
  readonly created: boolean;
}

/**
 * 首问派发账本视角的结局（PromotionOutcome.dispatch；issue #7 P0 整改）：
 * - succeeded：首问已送达（本次或既往——账本 succeeded 终态）；
 * - failed：明确失败（firstQuestionError 携带原因；同键重试允许）；
 * - unknown：结果未知（账本 dispatched 且对账不决）——**未重发**，调用方
 *   须先对账分支 Run/Turn 再决定重试。
 */
export type TerminologyDispatchOutcome = "succeeded" | "failed" | "unknown";

export interface PromotionOutcome {
  readonly branch: Branch;
  /** 首问结果；null = 首问未在本次调用送达（重放已成功 / 明确失败 / 结果未知）。 */
  readonly outcome: PromptOutcome | null;
  readonly firstQuestionError: { readonly code: string; readonly message: string } | null;
  /** false = 幂等重放（同键既有推广；首问已成功或结果未知时不重复派发）。 */
  readonly created: boolean;
  /** 首问派发账本结局（见 TerminologyDispatchOutcome）。 */
  readonly dispatch: TerminologyDispatchOutcome;
  /** 账本记录的派发 Run 引用（dispatch === "succeeded" 时非空）。 */
  readonly dispatchRunId: RunId | null;
}

export const TERMINOLOGY_PROMOTION_TURN_PREFIX = "[follow-up from a terminology annotation]";

export interface TerminologyReadModel {
  readonly annotations: readonly TerminologyAnnotation[];
  readonly tasks: readonly TerminologyTask[];
  readonly usage: TerminologyUsageReport;
  readonly cacheEnabled: boolean;
}

/** 锚点答案全文的 SHA-256 指纹（十六进制；批注时刻的全文身份）。 */
export function hashSourceText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 推广首问的组合上下文块（模型输入面事实；用户 turn 只带显式标记）。 */
function firstQuestionContext(annotation: TerminologyAnnotation): string {
  return (
    `[Follow-up on the term "${annotation.term}"]\n` +
    `Explanation (saved annotation): ${annotation.explanation}\n` +
    `[Source excerpt]: "${annotation.selection.text}"\n\n`
  );
}

/** 推广首问的不可变 payload（组合上下文 + 问题全文——派发与 hash 的唯一来源）。 */
export function buildFirstQuestionPayload(annotation: TerminologyAnnotation, firstQuestion: string): string {
  return firstQuestionContext(annotation) + firstQuestion;
}

/** 首问 payload 的 SHA-256（派发账本 firstQuestionHash；同键异问即冲突）。 */
export function hashFirstQuestionPayload(annotation: TerminologyAnnotation, firstQuestion: string): string {
  return createHash("sha256").update(buildFirstQuestionPayload(annotation, firstQuestion), "utf8").digest("hex");
}

export class TerminologyService {
  readonly repository: TreeRepository;
  readonly executor: TerminologyExecutor;
  readonly studio: TreeStudioService;
  /** 推广操作锁：单用户语义（同一时刻至多一个推广在建枝/派发）。 */
  #promotionInFlight: boolean = false;

  constructor(options: TerminologyServiceOptions) {
    this.repository = options.repository;
    this.executor = options.executor;
    this.studio = options.studio;
  }

  readModel(treeId: TreeId): TerminologyReadModel {
    const tree = this.repository.getTree(treeId); // EntityNotFoundError → 404
    void tree;
    return {
      annotations: this.repository.listTerminologyAnnotations(treeId),
      tasks: this.executor.listTasks().filter((task) => task.treeId === treeId),
      usage: this.executor.usage(),
      cacheEnabled: this.executor.cacheEnabled,
    };
  }

  /** 解释（瞬态任务）：去重命中已保存批注 → 零模型调用直接返回。 */
  async explain(input: {
    readonly treeId: TreeId;
    readonly branchId: BranchId;
    readonly anchorTurnId: TurnId;
    readonly selection: TurnSelection;
    readonly mode: TerminologyMode;
  }): Promise<ExplainOutcome> {
    const { anchorTurn } = this.#validateAnchor(input.treeId, input.branchId, input.anchorTurnId, input.selection);
    const existing = this.repository.findTerminologyAnnotationByRange(
      input.treeId,
      input.anchorTurnId,
      input.selection.start,
      input.selection.end,
    );
    if (existing !== null) {
      return { annotation: existing, task: null };
    }
    const task = await this.executor.explain({
      treeId: input.treeId,
      sourceId: input.anchorTurnId,
      mode: input.mode,
      selection: input.selection,
      sourceText: anchorTurn.text,
      sourceHash: hashSourceText(anchorTurn.text),
    });
    return { annotation: null, task };
  }

  /** auto 提取（任务面能力；结果不落批注——质量门禁未过不开自动保存）。 */
  async extract(input: {
    readonly treeId: TreeId;
    readonly branchId: BranchId;
    readonly anchorTurnId: TurnId;
  }): Promise<TerminologyTask> {
    const { anchorTurn } = this.#validateAnchor(input.treeId, input.branchId, input.anchorTurnId, null);
    return this.executor.extract({
      treeId: input.treeId,
      sourceText: anchorTurn.text,
      sourceHash: hashSourceText(anchorTurn.text),
    });
  }

  /** 显式保存批注（产品事实；同选区至多一条，重复保存返回既有批注）。 */
  saveAnnotation(input: {
    readonly treeId: TreeId;
    readonly branchId: BranchId;
    readonly anchorTurnId: TurnId;
    readonly selection: TurnSelection;
    readonly mode: TerminologyMode;
    readonly term: string;
    readonly explanation: string;
  }): SaveAnnotationOutcome {
    const { anchorTurn } = this.#validateAnchor(input.treeId, input.branchId, input.anchorTurnId, input.selection);
    if (typeof input.term !== "string" || input.term.trim().length === 0) {
      throw new InvalidArgumentError("terminology term must be a non-empty string");
    }
    if (typeof input.explanation !== "string" || input.explanation.trim().length === 0) {
      throw new InvalidArgumentError("terminology explanation must be a non-empty string");
    }
    const existing = this.repository.findTerminologyAnnotationByRange(
      input.treeId,
      input.anchorTurnId,
      input.selection.start,
      input.selection.end,
    );
    if (existing !== null) {
      return { annotation: existing, created: false };
    }
    try {
      const annotation = this.repository.createTerminologyAnnotation({
        treeId: input.treeId,
        branchId: input.branchId,
        anchorTurnId: input.anchorTurnId,
        selection: input.selection,
        sourceHash: hashSourceText(anchorTurn.text),
        term: input.term,
        explanation: input.explanation,
        mode: input.mode,
      });
      return { annotation, created: true };
    } catch (error) {
      /* 并发同选区竞争：唯一索引判负 → 重读对齐（返回既有批注）。 */
      if (error instanceof ConstraintViolationError) {
        const raced = this.repository.findTerminologyAnnotationByRange(
          input.treeId,
          input.anchorTurnId,
          input.selection.start,
          input.selection.end,
        );
        if (raced !== null) return { annotation: raced, created: false };
      }
      throw error;
    }
  }

  /**
   * 幂等推广（②；issue #7 P0 整改，2026-09-30 验收）：
   * - **原子性**：Branch/Origin 创建 + 批注绑定 + 首问派发意图（账本，
   *   migration 0009）在**同一事务**内落库——键冲突（同树同键异批注 /
   *   并发判负）→ 409 且零新增行（无孤儿 Branch/Origin/绑定/账本）；
   * - **首问身份**：payload hash 落账本，同键异问 → 409（首问不可变）；
   * - **重放判定只走账本**（绝不信「分支上有无 Turn」）：succeeded →
   *   原样幂等重放；failed（明确失败）/ pending（从未派发）→ 重新派发
   *   （不重建枝）；dispatched（结果未知）→ 先对账（首问 turn / Run
   *   终态证据）：送达 → 补结算幂等重放；明确未送达 → 可重试；对账
   *   不决（有非终态 Run）→ **不盲发**，返回 dispatch "unknown"；
   * - 同批注异键：409（一个批注至多推广一次——明确另开 = 新批注）。
   */
  async promote(input: {
    readonly treeId: TreeId;
    readonly annotationId: string;
    readonly idempotencyKey: string;
    readonly firstQuestion: string;
  }): Promise<PromotionOutcome> {
    if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.trim().length === 0) {
      throw new InvalidArgumentError("promotion idempotencyKey must be a non-empty string");
    }
    if (typeof input.firstQuestion !== "string" || input.firstQuestion.trim().length === 0) {
      throw new InvalidArgumentError("promotion firstQuestion must be a non-empty string");
    }
    const tree = this.repository.getTree(input.treeId); // EntityNotFoundError → 404
    const annotation = this.repository.getTerminologyAnnotation(input.annotationId);
    if (annotation.treeId !== tree.id) {
      throw new InvalidArgumentError(
        `terminology annotation ${input.annotationId} belongs to tree ${annotation.treeId}, not ${tree.id}`,
      );
    }
    if (annotation.promotedBranchId !== null) {
      if (annotation.promotionKey !== input.idempotencyKey) {
        throw new TerminologyPromotionConflictError(
          `annotation ${input.annotationId} is already promoted (branch ${annotation.promotedBranchId}); ` +
            "a new follow-up needs a new annotation",
        );
      }
      /* 同键重放：判定只走派发账本（首问身份 / 派发状态 / 对账）。 */
      return await this.#replayPromotion(tree.id, annotation, input.firstQuestion);
    }
    /* 键可用性预检（零写入）：同树同键已绑在别的批注上 → 409。 */
    const keyHolder = this.repository.findTerminologyAnnotationByPromotionKey(tree.id, input.idempotencyKey);
    if (keyHolder !== null && keyHolder.id !== annotation.id) {
      throw new TerminologyPromotionConflictError(
        `promotion key '${input.idempotencyKey}' is already used by annotation ${keyHolder.id} in this tree; ` +
          "a promotion key identifies exactly one follow-up",
      );
    }
    if (this.#promotionInFlight) {
      throw new TypeError("a terminology promotion is already in flight; wait for it to settle first");
    }
    this.#promotionInFlight = true;
    try {
      const firstQuestionHash = hashFirstQuestionPayload(annotation, input.firstQuestion);
      let creation: BranchCreation;
      try {
        /* 单事务（BEGIN IMMEDIATE；嵌套仓储调用以 SAVEPOINT 加入）：
           Branch + Origin（createBranchFromSelection）→ 绑定 → 派发意图
           （账本 pending 行）。任何一步失败整体回滚——零新增行。 */
        creation = this.repository.transaction(() => {
          const created = this.studio.createBranchFromSelection(
            tree.id,
            annotation.branchId,
            annotation.anchorTurnId,
            annotation.selection,
          );
          const bound = this.repository.bindTerminologyPromotion(
            annotation.id,
            input.idempotencyKey,
            created.branch.id,
          );
          if (!bound) {
            throw new TerminologyPromotionConflictError(
              `annotation ${annotation.id} was promoted concurrently; zero rows were written by this attempt ` +
                "(the branch created inside this transaction was rolled back)",
            );
          }
          this.repository.createTerminologyDispatch({
            annotationId: annotation.id,
            treeId: tree.id,
            promotionKey: input.idempotencyKey,
            branchId: created.branch.id,
            firstQuestionHash,
          });
          return created;
        });
      } catch (error) {
        if (error instanceof TerminologyPromotionConflictError) throw error;
        if (error instanceof ConstraintViolationError) {
          /* 唯一索引判负（并发同键/同批注）：整个事务已回滚——零新增行。 */
          const winner = this.repository.findTerminologyAnnotationByPromotionKey(
            tree.id,
            input.idempotencyKey,
          );
          throw new TerminologyPromotionConflictError(
            `promotion key '${input.idempotencyKey}' lost a concurrent race` +
              `${winner !== null ? ` (annotation ${winner.id} holds it)` : ""}; ` +
              "zero rows were written by this attempt (the branch created inside the transaction was rolled back)",
          );
        }
        throw error;
      }
      const dispatched = await this.#dispatchFirstQuestionWithLedger(
        tree.id,
        creation.branch.id,
        annotation,
        input.firstQuestion,
      );
      return {
        branch: creation.branch,
        outcome: dispatched.outcome,
        firstQuestionError: dispatched.error,
        created: true,
        dispatch: dispatched.dispatch,
        dispatchRunId: dispatched.runId,
      };
    } finally {
      this.#promotionInFlight = false;
    }
  }

  /**
   * 同键重放（批注已推广）：首问身份校验（同键异问 → 409）+ 账本状态机。
   */
  async #replayPromotion(
    treeId: TreeId,
    annotation: TerminologyAnnotation,
    firstQuestion: string,
  ): Promise<PromotionOutcome> {
    const promotedBranchId = annotation.promotedBranchId;
    if (promotedBranchId === null || annotation.promotionKey === null) {
      throw new InvalidArgumentError(
        `annotation ${annotation.id} has no promotion binding (schema integrity violation)`,
      );
    }
    const branchView = this.studio
      .getTreeState(treeId)
      .branches.find((view) => view.branch.id === promotedBranchId);
    if (branchView === undefined) {
      throw new InvalidArgumentError(
        `the promoted branch ${promotedBranchId} no longer exists (schema integrity violation)`,
      );
    }
    const ledger = this.repository.findTerminologyDispatchByAnnotation(annotation.id);
    if (ledger === null) {
      throw new InvalidArgumentError(
        `annotation ${annotation.id} is bound to a promotion but has no dispatch ledger row ` +
          "(schema integrity violation)",
      );
    }
    const firstQuestionHash = hashFirstQuestionPayload(annotation, firstQuestion);
    if (ledger.firstQuestionHash !== firstQuestionHash) {
      throw new TerminologyPromotionConflictError(
        `promotion key '${String(annotation.promotionKey)}' was already used with a different first question; ` +
          "the first question is immutable for a promotion key — a retry with this key must carry the same question, " +
          "and a different question needs a new annotation",
      );
    }
    if (ledger.dispatchState === "succeeded") {
      /* 首问已送达：幂等重放（不重复派发，不重建枝）。 */
      return {
        branch: branchView.branch,
        outcome: null,
        firstQuestionError: null,
        created: false,
        dispatch: "succeeded",
        dispatchRunId: ledger.runId,
      };
    }
    if (ledger.dispatchState === "dispatched") {
      /* 结果未知：先对账（Turn/Run 证据）——绝不以 turns.length 盲判。 */
      const reconciled = this.#reconcileUnknownDispatch(annotation, promotedBranchId, firstQuestion);
      if (reconciled.state === "succeeded") {
        return {
          branch: branchView.branch,
          outcome: null,
          firstQuestionError: null,
          created: false,
          dispatch: "succeeded",
          dispatchRunId: reconciled.runId,
        };
      }
      if (reconciled.state === "undecidable") {
        /* 对账不决（分支有非终态 Run：可能仍在途/未收敛）：不盲发。 */
        return {
          branch: branchView.branch,
          outcome: null,
          firstQuestionError: {
            code: "dispatch-unknown",
            message:
              `the first question for annotation ${annotation.id} was dispatched but never reached a terminal state ` +
              "(the process exited mid-dispatch or another dispatch may still be in flight); it was NOT re-sent — " +
              "reconcile the promoted branch's runs, then retry this promotion",
          },
          created: false,
          dispatch: "unknown",
          dispatchRunId: null,
        };
      }
      /* reconciled.state === "not-landed"：对账结论 = 明确未送达 → 落入下方重试。 */
    }
    /* pending（从未派发）| failed（明确失败）| dispatched→对账判负：重试派发（不重建枝）。 */
    const dispatched = await this.#dispatchFirstQuestionWithLedger(
      treeId,
      promotedBranchId,
      annotation,
      firstQuestion,
    );
    return {
      branch: branchView.branch,
      outcome: dispatched.outcome,
      firstQuestionError: dispatched.error,
      created: false,
      dispatch: dispatched.dispatch,
      dispatchRunId: dispatched.runId,
    };
  }

  /**
   * 对账一次结果未知的派发（账本 dispatched；issue #7 P0 整改）：
   * - 证据一：首问 turn 已落库（用户 turn 文本 = 推广标记 + 问题原文）→
   *   实际已送达：账本补结算 succeeded（Run 引用取自该 turn）；
   * - 证据二：分支存在非终态 Run（在途/未收敛）→ 对账不决（不盲发）；
   * - 其余（无落库 turn 且全部 Run 终态或无 Run）→ 明确未送达：账本补
   *   结算 failed（可重试）。
   */
  #reconcileUnknownDispatch(
    annotation: TerminologyAnnotation,
    promotedBranchId: BranchId,
    firstQuestion: string,
  ): { state: "succeeded"; runId: RunId } | { state: "undecidable" } | { state: "not-landed" } {
    const expectedTurnText = `${TERMINOLOGY_PROMOTION_TURN_PREFIX}\n\n${firstQuestion}`;
    const landing = this.repository
      .listTurns(promotedBranchId)
      .find((turn) => turn.role === "user" && turn.text === expectedTurnText);
    if (landing !== undefined && landing.runId !== null) {
      this.repository.settleTerminologyDispatch(annotation.id, { state: "succeeded", runId: landing.runId });
      return { state: "succeeded", runId: landing.runId };
    }
    for (const episode of this.repository.listEpisodes(promotedBranchId)) {
      for (const run of this.repository.listRuns(episode.id)) {
        if (run.terminalAt === null) return { state: "undecidable" };
      }
    }
    this.repository.settleTerminologyDispatch(annotation.id, {
      state: "failed",
      failure: {
        code: "unknown",
        message:
          "reconciled after an unknown-result dispatch: the first question never landed " +
          "(no matching turn on the promoted branch and all its runs are terminal)",
      },
    });
    return { state: "not-landed" };
  }

  /** 派发前账本标记（并发在途 → 409 冲突语义）。 */
  #markDispatchSent(annotationId: string): void {
    try {
      this.repository.markTerminologyDispatchSent(annotationId);
    } catch (error) {
      if (error instanceof InvalidArgumentError) {
        const ledger = this.repository.findTerminologyDispatchByAnnotation(annotationId);
        if (ledger !== null && ledger.dispatchState === "dispatched") {
          throw new TerminologyPromotionConflictError(
            `a dispatch for annotation ${annotationId} is already in flight or its result is unknown; ` +
              "reconcile before re-sending",
          );
        }
      }
      throw error;
    }
  }

  /**
   * 账本护航的首问派发：markSent（attempts+1，崩溃窗口内重放看到
   * dispatched → 先对账）→ 派发 → 终局结算（succeeded 带 Run 引用 /
   * failed 带明确失败）。派发错误由 #dispatchFirstQuestion 捕获并随
   * error 字段返回（绝不向外抛），此处只结算账本。
   */
  async #dispatchFirstQuestionWithLedger(
    treeId: TreeId,
    branchId: BranchId,
    annotation: TerminologyAnnotation,
    firstQuestion: string,
  ): Promise<{
    readonly outcome: PromptOutcome | null;
    readonly error: { readonly code: string; readonly message: string } | null;
    readonly dispatch: TerminologyDispatchOutcome;
    readonly runId: RunId | null;
  }> {
    this.#markDispatchSent(annotation.id);
    const dispatched = await this.#dispatchFirstQuestion(treeId, branchId, annotation, firstQuestion);
    if (dispatched.outcome !== null) {
      this.repository.settleTerminologyDispatch(annotation.id, {
        state: "succeeded",
        runId: dispatched.outcome.run.id,
      });
      return {
        outcome: dispatched.outcome,
        error: null,
        dispatch: "succeeded",
        runId: dispatched.outcome.run.id,
      };
    }
    const error = dispatched.error!;
    this.repository.settleTerminologyDispatch(annotation.id, {
      state: "failed",
      failure: { code: error.code as TreeAIErrorCode, message: error.message },
    });
    return { outcome: null, error, dispatch: "failed", runId: null };
  }

  async #dispatchFirstQuestion(
    treeId: TreeId,
    branchId: BranchId,
    annotation: TerminologyAnnotation,
    firstQuestion: string,
  ): Promise<{ outcome: PromptOutcome | null; error: { code: string; message: string } | null }> {
    const context = firstQuestionContext(annotation);
    try {
      const outcome = await this.studio.prompt(treeId, branchId, firstQuestion, {
        composedPrefix: context,
        turnPrefix: TERMINOLOGY_PROMOTION_TURN_PREFIX,
      });
      return { outcome, error: null };
    } catch (err) {
      const code = toTreeAIErrorCode(err);
      return { outcome: null, error: { code, message: toErrorMessage(err) } };
    }
  }

  /** 缓存偏好（执行器 + kv 持久化由宿主完成；此处只透传执行器）。 */
  setCachePreference(enabled: boolean): void {
    this.executor.setCacheEnabled(enabled);
  }

  /** 校验锚点三件套（tree/branch/assistant turn + 选区切片不变量）。 */
  #validateAnchor(
    treeId: TreeId,
    branchId: BranchId,
    anchorTurnId: TurnId,
    selection: TurnSelection | null,
  ): { anchorTurn: { readonly text: string } } {
    const tree = this.repository.getTree(treeId); // EntityNotFoundError → 404
    const branch = this.repository.getBranch(branchId);
    if (branch.treeId !== tree.id) {
      throw new InvalidArgumentError(`branch ${branchId} belongs to tree ${branch.treeId}, not ${tree.id}`);
    }
    const anchorTurn = this.repository.getTurn(anchorTurnId);
    if (anchorTurn.branchId !== branchId) {
      throw new InvalidArgumentError(
        `anchor turn ${anchorTurnId} belongs to branch ${anchorTurn.branchId}, not ${branchId}`,
      );
    }
    if (anchorTurn.role !== "assistant") {
      throw new InvalidArgumentError("terminology anchors must reference an assistant turn (an answer)");
    }
    if (selection === null) return { anchorTurn };
    if (
      !Number.isInteger(selection.start) ||
      !Number.isInteger(selection.end) ||
      selection.start < 0 ||
      selection.end < selection.start ||
      selection.end > anchorTurn.text.length
    ) {
      throw new InvalidArgumentError(
        `selection [${String(selection.start)}, ${String(selection.end)}) is out of bounds for the anchor answer (${anchorTurn.text.length} chars)`,
      );
    }
    if (anchorTurn.text.slice(selection.start, selection.end) !== selection.text) {
      throw new InvalidArgumentError(
        "selection text does not match the anchor answer at the given offsets (anchor integrity violation)",
      );
    }
    return { anchorTurn };
  }
}
