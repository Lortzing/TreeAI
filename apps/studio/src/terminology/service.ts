import {
  TerminologyPromotionCoordinator,
} from "./promotion.ts";
/** Terminology service ownership; public compatibility exports remain in ../terminology.ts. */
import type {
  TreeStudioService,
} from "../service.ts";

import type {
  TerminologyExecutor,
} from "./executor.ts";
import type {
  ExplainOutcome,
  PromotionOutcome,
  SaveAnnotationOutcome,
  TerminologyAutoSuggestionsState,
  TerminologyReadingMode,
  TerminologyReadModel,
  TerminologyServiceOptions,
  TerminologySuggestionSet,
  TerminologySuggestionSetStatus,
  TerminologyTask,
} from "./model.ts";
import {
  isTerminologyReadingMode,
  MAX_SUGGESTION_SETS,
  READING_MODE_DENSITY_LIMITS,
  TERMINOLOGY_AUTO_QUALITY_GATE,
  TERMINOLOGY_LIMITS_VERSION,
  TERMINOLOGY_V2_INPUT_TOKEN_LIMIT,
  TERMINOLOGY_V2_MAX_CANDIDATES,
  TERMINOLOGY_V2_OUTPUT_TOKEN_LIMIT,
} from "./policy.ts";
import {
  hashSourceText,
} from "./prompts.ts";
import {
  applySuggestionDensity,
} from "./suggestion-density.ts";
import {
  projectSuggestionSet,
} from "./suggestion-projection.ts";

import type {
  BranchId,
  RunId,
  TerminologyMode,
  TreeId,
  TurnId,
  TurnSelection,
} from "@treeai/contracts";
import {
  ConstraintViolationError,
  EntityNotFoundError,
  InvalidArgumentError,
  type TreeRepository,
} from "@treeai/persistence";

export class TerminologyService {
  readonly repository: TreeRepository;
  readonly executor: TerminologyExecutor;
  readonly studio: TreeStudioService;
  readonly #promotion: TerminologyPromotionCoordinator;
  /** 自动标注质量门禁（缺省 TERMINOLOGY_AUTO_QUALITY_GATE = false）。 */
  readonly #autoQualityGate: boolean;
  /** 建议集存储（进程内瞬态；键 `${treeId}\0${anchorTurnId}`，按产生序）。 */
  readonly #suggestionSets = new Map<string, TerminologySuggestionSet>();
  /** studio 事件退订（进程生命期——与服务同寿，无 dispose 面）。 */
  readonly #unsubscribeStudio: () => void;

  constructor(options: TerminologyServiceOptions) {
    this.repository = options.repository;
    this.executor = options.executor;
    this.studio = options.studio;
    this.#promotion = new TerminologyPromotionCoordinator(this.repository, this.studio);
    this.#autoQualityGate = options.autoQualityGate ?? TERMINOLOGY_AUTO_QUALITY_GATE;
    /* 触发范围（issue #7 术语①阅读模式）：仅订阅 assistant 回答完成
       （run-terminal succeeded）——浏览/搜索/打开树不产生该事件，零派发的
       既有不变量由事件面结构性保证。处理器 fire-and-forget（绝不阻塞
       prompt 收尾）；门禁未过时第一行即返回（零派发、零记账变动）。 */
    this.#unsubscribeStudio = this.studio.subscribeStudioEvents((event) => {
      if (event.type !== "run-terminal" || event.state !== "succeeded") return;
      void this.#autoSuggestForRun(event.treeId, event.runId).catch(() => undefined);
    });
  }

  readModel(treeId: TreeId): TerminologyReadModel {
    const tree = this.repository.getTree(treeId); // EntityNotFoundError → 404
    void tree;
    return {
      annotations: this.repository.listTerminologyAnnotations(treeId),
      tasks: this.executor.listTasks().filter((task) => task.treeId === treeId),
      usage: this.executor.usage(),
      cacheEnabled: this.executor.cacheEnabled,
      limits: {
        version: TERMINOLOGY_LIMITS_VERSION,
        inputTokens: TERMINOLOGY_V2_INPUT_TOKEN_LIMIT,
        outputTokens: TERMINOLOGY_V2_OUTPUT_TOKEN_LIMIT,
        maxCandidates: TERMINOLOGY_V2_MAX_CANDIDATES,
        density: READING_MODE_DENSITY_LIMITS,
        tokenEstimate: "chars/4-unverified",
      },
      readingMode: this.#readingModeOf(treeId),
      autoSuggestions: this.autoSuggestionsState(treeId),
    };
  }

  /* ------------------ 阅读模式（issue #7 术语①） ------------------ */

  /** kv 键（每树一条；terminology_state 是全局键值表，树 id 入键）。 */
  static readonly READING_MODE_KEY_PREFIX = "reading-mode:";

  /** 读取阅读模式（未知树 → 404；kv 缺失/损坏 → 缺省 manual-only——
      阅读模式是展示偏好，损坏降级为缺省即可（与用量 fail-closed 不同）。） */
  getReadingMode(treeId: TreeId): TerminologyReadingMode {
    this.repository.getTree(treeId); // EntityNotFoundError → 404
    return this.#readingModeOf(treeId);
  }

  /** 保存阅读模式（枚举校验 → 400；未知树 → 404；kv JSON 文本落库）。 */
  setReadingMode(treeId: TreeId, mode: TerminologyReadingMode): void {
    if (!isTerminologyReadingMode(mode)) {
      throw new InvalidArgumentError(
        `reading mode must be one of 'manual-only' | 'minimal-hints' | 'assisted-reading' (got '${String(mode)}')`,
      );
    }
    this.repository.getTree(treeId); // EntityNotFoundError → 404
    this.repository.setTerminologyState(
      `${TerminologyService.READING_MODE_KEY_PREFIX}${treeId}`,
      JSON.stringify({ readingMode: mode } satisfies { readingMode: TerminologyReadingMode }),
    );
  }

  #readingModeOf(treeId: TreeId): TerminologyReadingMode {
    const raw = this.repository.getTerminologyState(
      `${TerminologyService.READING_MODE_KEY_PREFIX}${treeId}`,
    );
    if (raw === null) return "manual-only";
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        isTerminologyReadingMode((parsed as { readingMode?: unknown }).readingMode)
      ) {
        return (parsed as { readingMode: TerminologyReadingMode }).readingMode;
      }
    } catch {
      /* 损坏 kv：展示偏好降级为缺省（诚实口径见 getReadingMode 注释） */
    }
    return "manual-only";
  }

  /** 自动建议总状态（readModel / retry 响应共用；含来源投影）。 */
  autoSuggestionsState(treeId: TreeId): TerminologyAutoSuggestionsState {
    const mode = this.#readingModeOf(treeId);
    let enabled = true;
    let reason: TerminologyAutoSuggestionsState["reason"] = null;
    if (!this.#autoQualityGate) {
      enabled = false;
      reason = "quality-gate-pending";
    } else if (mode === "manual-only") {
      enabled = false;
      reason = "manual-only";
    }
    const sets: TerminologySuggestionSet[] = [];
    for (const set of this.#suggestionSets.values()) {
      if (set.treeId !== treeId) continue;
      sets.push(this.#projectSet(set));
    }
    return { enabled, reason, sets };
  }

  /** 存储形态 → 读取投影（来源校验：锚点缺失/漂移 → source-invalid）。 */
  #projectSet(set: TerminologySuggestionSet): TerminologySuggestionSet {
    let anchorTurn: { branchId: BranchId; text: string } | null = null;
    try {
      const turn = this.repository.getTurn(set.anchorTurnId);
      anchorTurn = { branchId: turn.branchId, text: turn.text };
    } catch {
      anchorTurn = null; /* 锚点答案缺失（EntityNotFoundError） */
    }
    return projectSuggestionSet(set, anchorTurn);
  }

  #storeSet(set: TerminologySuggestionSet): void {
    const key = `${set.treeId}\0${set.anchorTurnId}`;
    this.#suggestionSets.delete(key); /* 重置插入序（重试/更新置尾） */
    this.#suggestionSets.set(key, set);
    while (this.#suggestionSets.size > MAX_SUGGESTION_SETS) {
      const oldest = this.#suggestionSets.keys().next();
      if (oldest.done === true) break;
      this.#suggestionSets.delete(oldest.value);
    }
  }

  #setOf(treeId: TreeId, anchorTurnId: TurnId): TerminologySuggestionSet | null {
    return this.#suggestionSets.get(`${treeId}\0${anchorTurnId}`) ?? null;
  }

  /**
   * run-terminal succeeded → 定位该 run 的 assistant turn 并跑自动建议管线
   * （fire-and-forget）。门禁未过 / 仅手动模式 / run 无 assistant turn
   * （对账不到）→ 零派发直接返回。
   */
  async #autoSuggestForRun(treeId: TreeId, runId: RunId): Promise<void> {
    if (!this.#autoQualityGate) return; /* 质量门禁未过：零自动派发 */
    const mode = this.#readingModeOf(treeId);
    if (mode === "manual-only") return;
    let anchor: { branchId: BranchId; turnId: TurnId; text: string } | null = null;
    try {
      const run = this.repository.getRun(runId);
      const episode = this.repository.getEpisode(run.episodeId);
      const branch = this.repository.getBranch(episode.branchId);
      if (branch.treeId !== treeId) return; /* 事件树与 run 归属不一致：如实不动 */
      const turn = this.repository
        .listTurns(branch.id)
        .find((candidate) => candidate.runId === runId && candidate.role === "assistant");
      if (turn === undefined) return; /* run 无 assistant turn（如纯派发失败） */
      anchor = { branchId: branch.id, turnId: turn.id, text: turn.text };
    } catch {
      return; /* run/episode/branch 对账不到：零派发（不伪造触发） */
    }
    await this.#extractSuggestions(treeId, anchor.branchId, anchor.turnId, anchor.text, mode);
  }

  /**
   * 自动建议管线（gate 已过、模式非 manual-only 的调用方保证）：pending
   * 落位 → executor.extract（走既有预算预留/usage/取消路径，密度按模式
   * 「每回答」上限请求）→ 按任务终态映射建议集状态。**只展示**：本方法
   * 绝不写 annotations/branches/promotion——自动保存明确保持关闭。
   */
  async #extractSuggestions(
    treeId: TreeId,
    branchId: BranchId,
    anchorTurnId: TurnId,
    sourceText: string,
    mode: TerminologyReadingMode,
  ): Promise<void> {
    if (mode === "manual-only") return; /* 调用方已保证；显式窄化兜底 */
    const limits = READING_MODE_DENSITY_LIMITS[mode];
    const sourceHash = hashSourceText(sourceText);
    this.#storeSet({
      treeId,
      branchId,
      anchorTurnId,
      readingMode: mode,
      status: "pending",
      suggestions: [],
      hiddenCount: 0,
      sourceHash,
      createdAt: new Date().toISOString(),
      error: null,
    });
    const task = await this.executor.extract({
      treeId,
      sourceText,
      sourceHash,
      maxTerms: limits.perAnswer,
    });
    if (task.state.kind === "succeeded") {
      const { kept, hiddenCount } = applySuggestionDensity(
        sourceText,
        task.state.candidates ?? [],
        limits,
      );
      const status: TerminologySuggestionSetStatus =
        kept.length === 0 ? "no-suggestions" : hiddenCount > 0 ? "partial" : "ready";
      this.#storeSet({
        treeId,
        branchId,
        anchorTurnId,
        readingMode: mode,
        status,
        suggestions: kept,
        hiddenCount,
        sourceHash,
        createdAt: new Date().toISOString(),
        error: null,
      });
      return;
    }
    if (task.state.kind === "failed" && task.state.code === "budget-exceeded") {
      this.#storeSet({
        treeId,
        branchId,
        anchorTurnId,
        readingMode: mode,
        status: "budget-paused",
        suggestions: [],
        hiddenCount: 0,
        sourceHash,
        createdAt: new Date().toISOString(),
        error: { code: task.state.code, message: task.state.message },
      });
      return;
    }
    /* 其余终态（failed 任何原因 / cancelled——含迟到丢弃）如实入 failed。 */
    const error =
      task.state.kind === "failed" || task.state.kind === "cancelled"
        ? task.state.kind === "failed"
          ? { code: task.state.code, message: task.state.message }
          : { code: "cancelled", message: "the auto suggestion extraction was cancelled" }
        : { code: "unknown", message: "the auto suggestion task ended without a result" };
    this.#storeSet({
      treeId,
      branchId,
      anchorTurnId,
      readingMode: mode,
      status: "failed",
      suggestions: [],
      hiddenCount: 0,
      sourceHash,
      createdAt: new Date().toISOString(),
      error,
    });
  }

  /**
   * 建议集的显式重试（budget-paused/failed 的「可恢复入口」——用户显式
   * 动作）：以锚点答案**当前**文本重跑管线（来源漂移后重试即以新文本为准，
   * sourceHash 随之更新）。门禁未过 → 400（建议管线整体关闭，绝不旁路）；
   * 仅手动模式 → 400；无既有建议集 → 404；pending 在途 → 400。
   */
  async retrySuggestions(treeId: TreeId, anchorTurnId: TurnId): Promise<TerminologyAutoSuggestionsState> {
    if (!this.#autoQualityGate) {
      throw new InvalidArgumentError(
        "the auto-annotation quality gate has not passed — the suggestion pipeline stays off (zero auto dispatch)",
      );
    }
    this.repository.getTree(treeId); // EntityNotFoundError → 404
    const mode = this.#readingModeOf(treeId);
    if (mode === "manual-only") {
      throw new InvalidArgumentError(
        "the reading mode for this tree is manual-only — automatic suggestions are off",
      );
    }
    const existing = this.#setOf(treeId, anchorTurnId);
    if (existing === null) {
      throw new EntityNotFoundError("terminology suggestion set", anchorTurnId);
    }
    if (this.#projectSet(existing).status === "pending") {
      throw new InvalidArgumentError(
        "a suggestion extraction for this answer is already in flight — wait for it to settle first",
      );
    }
    const turn = this.repository.getTurn(anchorTurnId); // EntityNotFoundError → 404
    if (turn.branchId !== existing.branchId || turn.role !== "assistant") {
      throw new InvalidArgumentError(
        `anchor turn ${anchorTurnId} no longer matches the recorded suggestion anchor (schema integrity violation)`,
      );
    }
    await this.#extractSuggestions(treeId, turn.branchId, turn.id, turn.text, mode);
    return this.autoSuggestionsState(treeId);
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
  /** Promotion delegates to the instance-owned atomic coordinator and durable dispatch ledger. */
  async promote(input: {
    readonly treeId: TreeId;
    readonly annotationId: string;
    readonly idempotencyKey: string;
    readonly firstQuestion: string;
  }): Promise<PromotionOutcome> {
    return this.#promotion.promote(input);
  }

  /** 缓存偏好（执行器 + kv 持久化由宿主完成；此处只透传执行器）。 */
  setCachePreference(enabled: boolean): void {
    this.executor.setCacheEnabled(enabled);
  }

  /** 退订 studio 事件（进程收尾/测试清理；幂等——重复调用无副作用）。 */
  dispose(): void {
    this.#unsubscribeStudio();
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
