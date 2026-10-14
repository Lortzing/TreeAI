/** Terminology executor ownership; public compatibility exports remain in ../terminology.ts. */
import {
  parseCandidates,
  validateCandidates,
} from "./candidates.ts";
import type {
  TerminologyExecutorOptions,
  TerminologyExecutorUsage,
  TerminologyTask,
  TerminologyTaskKind,
  TerminologyTaskState,
  TerminologyUsageBucket,
  TerminologyUsageReport,
} from "./model.ts";
import {
  CONTEXT_HASH_CHARS,
  EXPLAIN_PROMPT_VERSION,
  EXTRACT_SOURCE_LIMIT_CHARS,
  MAX_EXPLAIN_COMPLETION_CHARS,
  MAX_EXPLAIN_SELECTION_CHARS,
  MAX_EXTRACT_COMPLETION_CHARS,
  TERMINOLOGY_CACHE_FORMAT_VERSION,
  TERMINOLOGY_V2_MAX_CANDIDATES,
  ZERO_USAGE,
} from "./policy.ts";
import {
  buildExplainPrompt,
  buildExtractPrompt,
  prepareExplainPassage,
} from "./prompts.ts";
import {
  addUsage,
  estimateTokens,
  promptBudgetFailure,
  toErrorMessage,
  toTreeAIErrorCode,
  USAGE_ACCOUNTING_UNAVAILABLE,
} from "./usage.ts";
import type {
  IsoTimestamp,
  PiModelSelector,
  PiRuntime,
  TerminologyMode,
  TerminologyUsageDelta,
  TreeId,
  TurnSelection,
} from "@treeai/contracts";
import {
  EntityNotFoundError,
  InvalidArgumentError,
} from "@treeai/persistence";
import {
  createHash,
} from "node:crypto";

/** 执行器内部任务簿记（state 可变；对外投影为 TerminologyTask 拷贝）。 */
export interface ExecutorTask {
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

export const MAX_EXTRACT_TERMS = TERMINOLOGY_V2_MAX_CANDIDATES;


export const RECENT_TASKS_LIMIT = 50;

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
      const promptFailure = promptBudgetFailure(promptText);
      if (promptFailure !== null) {
        task.state = { kind: "failed", code: promptFailure.code, message: promptFailure.message };
        return;
      }
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
   * maxTerms：向模型请求的候选上限（缺省 MAX_EXTRACT_TERMS=8；阅读模式
   * 的自动档按各档「每回答」密度上限传入——少量提示 6 / 辅助阅读 12）。
   */
  async extract(input: {
    readonly treeId: TreeId | null;
    readonly sourceText: string;
    readonly sourceHash: string;
    readonly maxTerms?: number;
  }): Promise<TerminologyTask> {
    const maxTerms = input.maxTerms ?? MAX_EXTRACT_TERMS;
    if (!Number.isInteger(maxTerms) || maxTerms < 1 || maxTerms > TERMINOLOGY_V2_MAX_CANDIDATES) {
      throw new InvalidArgumentError(
        `extract maxTerms must be an integer in [1, ${String(TERMINOLOGY_V2_MAX_CANDIDATES)}] (got '${String(input.maxTerms)}')`,
      );
    }
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
      const promptText = buildExtractPrompt(input.sourceText, maxTerms);
      const promptFailure = promptBudgetFailure(promptText);
      if (promptFailure !== null) {
        task.state = { kind: "failed", code: promptFailure.code, message: promptFailure.message };
        return;
      }
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
        const candidates = validateCandidates(input.sourceText, raw, maxTerms);
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
