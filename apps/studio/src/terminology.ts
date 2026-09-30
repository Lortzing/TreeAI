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
 *   - **缓存偏好**：同 (mode, 术语/选区文本, sourceHash) 的解释复用
 *     缓存（零新请求、零新 session）；偏好可开关（默认开）；
 *   - **预算 usage**：requests 与字符数是**精确计数**，estTokens 为
 *     chars/4 的诚实估算（当前 Pi 契约面不透出 token 用量）；达到
 *     budgetTokens 后新任务 fail-closed（budget-exceeded）；记账跨重启
 *     持久化（宿主注入 persistUsage → repository kv）；
 *   - **提取的机械校验**（auto）：模型返回 JSON 候选后逐一验证
 *     （term 必须与 source[start,end) 切片全等；偏移为 UTF-16 码元、
 *     界内有序）；去重（同 term 至多一条）、密度上限（默认 8/答案）、
 *     代码/URL 排除（候选区间与反引号围栏或 URL 形态重叠即剔除）。
 *
 * ② TerminologyService（保存/推广）：
 *   - explain：瞬态任务（去重命中已保存批注时直接返回，零模型调用）；
 *   - saveAnnotation：显式保存（落库为产品事实；同选区至多一条）；
 *   - promote：**幂等推广**——复用主服务的 Anchor/Branch/Origin/Run
 *     机制建枝（createBranchFromSelection），批注绑定 promotedBranchId
 *     至多一次（条件 UPDATE + 树内幂等键唯一索引）；首问派发携带
 *     「术语 + 解释 + 摘录」上下文，用户 turn 携带显式标记；响应丢失/
 *     双击/重启后同键重放返回同一分支（首问未成功则重新派发，不重复
 *     建枝）；同批注异键 → 409 冲突；同词不同语境是不同批注、各自
 *     推广（不跨语境复用）。
 */

import { createHash } from "node:crypto";
import type {
  Branch,
  BranchId,
  IsoTimestamp,
  PiModelSelector,
  PiRuntime,
  TerminologyAnnotation,
  TerminologyMode,
  TerminologyUsageAccount,
  TerminologyUsageDelta,
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
  /** 重启恢复注入的既有用量（null = 从零开始）。 */
  readonly initialUsage?: TerminologyExecutorUsage | null;
  /** 用量变化回调（宿主持久化到 repository kv；抛错不影响任务）。 */
  readonly onUsage?: (usage: TerminologyExecutorUsage) => void;
  /** 时钟注入（测试确定性）。 */
  readonly now?: () => IsoTimestamp;
  /** id 生成注入（测试确定性）。 */
  readonly generateId?: () => string;
}

/** 执行器内部用量记账（account 的源数据；estTokens 派生）。 */
export interface TerminologyExecutorUsage {
  readonly total: TerminologyUsageDelta;
  readonly lateResultsDiscarded: number;
}

const ZERO_USAGE: TerminologyUsageDelta = { requests: 0, promptChars: 0, completionChars: 0 };

/** 估算 token（诚实口径：chars/4；Pi 契约面不透出 token 用量）。 */
function estimateTokens(usage: TerminologyUsageDelta): number {
  return Math.ceil((usage.promptChars + usage.completionChars) / 4);
}

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

/** 解释任务的提示词（点词/划线共用；标记区间以 UTF-16 偏移给出）。 */
export function buildExplainPrompt(sourceText: string, selection: TurnSelection): string {
  return (
    "Explain the marked span for a reader of the passage below. Plain text, 2-4 sentences, no markdown, " +
    "no headings. If the span is not a meaningful term or concept, say so plainly in one sentence.\n\n" +
    `[Passage]\n${sourceText}\n\n` +
    `[Marked span]\n"${selection.text}" (character offsets ${String(selection.start)}..${String(selection.end)} in the passage)`
  );
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
 */
export class TerminologyExecutor {
  readonly #runtime: PiRuntime;
  readonly #model: PiModelSelector;
  readonly #sessionDir: string;
  readonly #cwd: string;
  readonly #budgetTokens: number;
  #cacheEnabled: boolean;
  readonly #cache = new Map<string, string>();
  #usage: TerminologyExecutorUsage;
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
    this.#usage = options.initialUsage ?? { total: ZERO_USAGE, lateResultsDiscarded: 0 };
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

  /** 用量账户（预算与迟到的投影）。 */
  usage(): TerminologyUsageAccount {
    return {
      total: this.#usage.total,
      estTokens: estimateTokens(this.#usage.total),
      lateResultsDiscarded: this.#usage.lateResultsDiscarded,
      budgetTokens: this.#budgetTokens,
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

  #recordUsage(delta: TerminologyUsageDelta): void {
    const total = {
      requests: this.#usage.total.requests + delta.requests,
      promptChars: this.#usage.total.promptChars + delta.promptChars,
      completionChars: this.#usage.total.completionChars + delta.completionChars,
    };
    this.#usage = { ...this.#usage, total };
    if (this.#onUsage !== null) {
      try {
        this.#onUsage(this.#usage);
      } catch {
        /* 持久化失败不影响任务（内存记账为准） */
      }
    }
  }

  #recordLateResult(): void {
    this.#usage = { ...this.#usage, lateResultsDiscarded: this.#usage.lateResultsDiscarded + 1 };
    if (this.#onUsage !== null) {
      try {
        this.#onUsage(this.#usage);
      } catch {
        /* 同上 */
      }
    }
  }

  #cacheKey(mode: TerminologyMode, text: string, sourceHash: string): string {
    return `${mode}|${text}|${sourceHash}`;
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
   * 解释任务（term/range）：await 至终态。缓存命中零请求零新 session；
   * 预算超限 fail-closed；取消后到达的结果迟到丢弃（用量照记）。
   */
  async explain(input: {
    readonly treeId: TreeId | null;
    readonly mode: TerminologyMode;
    readonly selection: TurnSelection;
    readonly sourceText: string;
    readonly sourceHash: string;
  }): Promise<TerminologyTask> {
    if (input.mode !== "term" && input.mode !== "range") {
      throw new InvalidArgumentError(`explain mode must be 'term' or 'range' (got '${String(input.mode)}')`);
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
      const cacheKey = this.#cacheKey(input.mode, input.selection.text, input.sourceHash);
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
      if (estimateTokens(this.#usage.total) >= this.#budgetTokens) {
        task.state = {
          kind: "failed",
          code: "budget-exceeded",
          message: `the terminology budget is exhausted (est. ${String(estimateTokens(this.#usage.total))} of ${String(this.#budgetTokens)} tokens); raise the budget to continue`,
        };
        return;
      }
      task.state = { kind: "running" };
      const promptText = buildExplainPrompt(input.sourceText, input.selection);
      try {
        const session = await this.#runtime.createSession({
          model: this.#model,
          cwd: this.#cwd,
          sessionDir: this.#sessionDir,
        });
        const result = await this.#runtime.prompt({ text: promptText });
        const usage: TerminologyUsageDelta = {
          requests: 1,
          promptChars: promptText.length,
          completionChars: result.message.length,
        };
        this.#recordUsage(usage);
        if (task.cancelRequested) {
          this.#recordLateResult();
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
        if (task.cancelRequested || code === "user-abort") {
          task.state = { kind: "cancelled", lateResultDiscarded: false };
          return;
        }
        /* 失败请求的诚实成本：请求已发出、prompt 已计费，补记（幂等护栏：
           只在尚未记过本任务用量时补记）。 */
        if (
          task.state.kind === "running" &&
          this.#usage.total.requests >= 0
        ) {
          this.#recordUsage({ requests: 1, promptChars: promptText.length, completionChars: 0 });
        }
        task.state = { kind: "failed", code, message: toErrorMessage(err) };
      }
    });
    return this.findTask(task.id)!;
  }

  /**
   * 提取任务（auto）：整段候选提取 + 机械校验（切片全等/去重/密度/代码
   * URL 排除）。任务面能力——**结果不落批注**（自动保存的质量门禁未过）。
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
      if (estimateTokens(this.#usage.total) >= this.#budgetTokens) {
        task.state = {
          kind: "failed",
          code: "budget-exceeded",
          message: `the terminology budget is exhausted (est. ${String(estimateTokens(this.#usage.total))} of ${String(this.#budgetTokens)} tokens)`,
        };
        return;
      }
      task.state = { kind: "running" };
      const promptText = buildExtractPrompt(input.sourceText, MAX_EXTRACT_TERMS);
      try {
        await this.#runtime.createSession({
          model: this.#model,
          cwd: this.#cwd,
          sessionDir: this.#sessionDir,
        });
        const result = await this.#runtime.prompt({ text: promptText });
        const usage: TerminologyUsageDelta = {
          requests: 1,
          promptChars: promptText.length,
          completionChars: result.message.length,
        };
        this.#recordUsage(usage);
        if (task.cancelRequested) {
          this.#recordLateResult();
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
        if (task.cancelRequested || code === "user-abort") {
          task.state = { kind: "cancelled", lateResultDiscarded: false };
          return;
        }
        this.#recordUsage({ requests: 1, promptChars: promptText.length, completionChars: 0 });
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

export interface PromotionOutcome {
  readonly branch: Branch;
  /** 首问结果；null = 首问派发失败（分支与绑定已是事实，同键重试会重新派发）。 */
  readonly outcome: PromptOutcome | null;
  readonly firstQuestionError: { readonly code: string; readonly message: string } | null;
  /** false = 幂等重放（同键既有推广；首问已成功时不重复派发）。 */
  readonly created: boolean;
}

export const TERMINOLOGY_PROMOTION_TURN_PREFIX = "[follow-up from a terminology annotation]";

export interface TerminologyReadModel {
  readonly annotations: readonly TerminologyAnnotation[];
  readonly tasks: readonly TerminologyTask[];
  readonly usage: TerminologyUsageAccount;
  readonly cacheEnabled: boolean;
}

/** 锚点答案全文的 SHA-256 指纹（十六进制；批注时刻的全文身份）。 */
export function hashSourceText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
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
   * 幂等推广（②）：复用主服务 Anchor/Branch/Origin 机制建枝 + 首问派发。
   * - 同键重放：返回既有分支；首问已成功不重复派发，未成功（此前失败/
   *   响应丢失）则重新派发；
   * - 同批注异键：409 冲突（一个批注至多推广一次——明确另开=新批注）；
   * - 响应丢失/双击/重启：promotedBranchId 绑定与幂等键唯一索引保证
   *   至多一条分支、至多一次成功首问。
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
      /* 同键重放：首问已成功 → 原样返回；未成功 → 重新派发（不重建枝）。 */
      const branchView = this.studio
        .getTreeState(tree.id)
        .branches.find((view) => view.branch.id === annotation.promotedBranchId);
      if (branchView === undefined) {
        throw new InvalidArgumentError(
          `the promoted branch ${annotation.promotedBranchId} no longer exists (schema integrity violation)`,
        );
      }
      if (branchView.turns.length > 0) {
        return {
          branch: branchView.branch,
          outcome: null,
          firstQuestionError: null,
          created: false,
        };
      }
      const dispatched = await this.#dispatchFirstQuestion(
        tree.id,
        annotation.promotedBranchId,
        annotation,
        input.firstQuestion,
      );
      return {
        branch: branchView.branch,
        outcome: dispatched.outcome,
        firstQuestionError: dispatched.error,
        created: false,
      };
    }
    if (this.#promotionInFlight) {
      throw new TypeError("a terminology promotion is already in flight; wait for it to settle first");
    }
    this.#promotionInFlight = true;
    try {
      const creation: BranchCreation = this.studio.createBranchFromSelection(
        tree.id,
        annotation.branchId,
        annotation.anchorTurnId,
        annotation.selection,
      );
      const bound = this.repository.bindTerminologyPromotion(
        annotation.id,
        input.idempotencyKey,
        creation.branch.id,
      );
      if (!bound) {
        /* 并发竞争判负：按键重读对齐（同键 → 既有推广的分支；删除刚建的
           竞争分支不可行——branches 无删除路径，如实以冲突呈报并保留）。 */
        const raced = this.repository.getTerminologyAnnotation(annotation.id);
        throw new TerminologyPromotionConflictError(
          `annotation ${annotation.id} was promoted concurrently (branch ${String(raced.promotedBranchId)}); ` +
            `the branch created by this attempt (${creation.branch.id}) is left in place — use the existing promotion`,
        );
      }
      const dispatched = await this.#dispatchFirstQuestion(tree.id, creation.branch.id, annotation, input.firstQuestion);
      return {
        branch: creation.branch,
        outcome: dispatched.outcome,
        firstQuestionError: dispatched.error,
        created: true,
      };
    } finally {
      this.#promotionInFlight = false;
    }
  }

  async #dispatchFirstQuestion(
    treeId: TreeId,
    branchId: BranchId,
    annotation: TerminologyAnnotation,
    firstQuestion: string,
  ): Promise<{ outcome: PromptOutcome | null; error: { code: string; message: string } | null }> {
    const context =
      `[Follow-up on the term "${annotation.term}"]\n` +
      `Explanation (saved annotation): ${annotation.explanation}\n` +
      `[Source excerpt]: "${annotation.selection.text}"\n\n`;
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
