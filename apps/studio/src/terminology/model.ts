/** Terminology model ownership; public compatibility exports remain in ../terminology.ts. */
import type {
  PromptOutcome,
  TreeStudioService,
} from "../service.ts";
import type {
  TerminologyExecutor,
} from "./executor.ts";
import type {
  READING_MODE_DENSITY_LIMITS,
} from "./policy.ts";
import type {
  Branch,
  BranchId,
  IsoTimestamp,
  PiModelSelector,
  PiRuntime,
  RunId,
  TerminologyAnnotation,
  TerminologyMode,
  TerminologyUsageAccount,
  TerminologyUsageDelta,
  TreeId,
  TurnId,
  TurnSelection,
} from "@treeai/contracts";
import type {
  TreeRepository,
} from "@treeai/persistence";

/* ------------------------------------------------------------------ */
/* 阅读模式（issue #7 术语①，2026-10-01）：触发范围 / 密度 / 质量门禁    */
/* ------------------------------------------------------------------ */

/**
 * 每树阅读模式（issue #7 增量验收 2026-09-30：「term/range/auto 是任务
 * 类型，不是『少量提示/辅助阅读/仅手动』阅读模式」）：
 * - manual-only（默认）：仅手动——选区解释/批注/推广的既有交互照旧，
 *   **零自动派发**；
 * - minimal-hints：少量提示——assistant 回答完成后对该条 turn 文本自动
 *   提取候选，密度上限每段 ≤3、每回答 ≤6；
 * - assisted-reading：辅助阅读——同上，密度上限每段 ≤6、每回答 ≤12。
 * 自动产出的建议**只展示**：不自动建枝、不自动解释、不自动保存批注
 * （前端点击建议 = 预填该词的解释请求，用户显式确认才发）。
 * 持久化：repository 的 terminology_state kv（键 `reading-mode:<treeId>`，
 * JSON 文本）——复用既有设置机制，零新迁移。
 */
export type TerminologyReadingMode = "manual-only" | "minimal-hints" | "assisted-reading";

/** 单模式的密度上限。**v2 精确数值待负责人确认，当前为工程占位参数。** */
export interface ReadingModeDensityLimits {
  readonly perParagraph: number;
  readonly perAnswer: number;
}

/** 术语建议（auto 档展示面）：候选词 + 区间（UTF-16 偏移，切片已验证全等）。 */
export interface TerminologySuggestion {
  readonly term: string;
  readonly start: number;
  readonly end: number;
}

/**
 * 某条 assistant 回答的建议集状态机（进程内瞬态——不是产品事实，重启即空）：
 * - pending：提取在途；
 * - ready：候选齐备、无截断；
 * - no-suggestions：提取完成、零候选（四状态之一）；
 * - partial：密度截断（四状态之一，hiddenCount 携带「还有 N 个候选未显示」）；
 * - budget-paused：预算不足暂停（四状态之一，error 携带服务端零派发原因）；
 * - source-invalid：来源失效（四状态之一——锚点答案缺失/漂移，投影时降级，
 *   建议只作快照展示）；
 * - failed：其余诚实失败（解析/上游/超限——error 携带 code/message）。
 */
export type TerminologySuggestionSetStatus =
  | "pending"
  | "ready"
  | "no-suggestions"
  | "partial"
  | "budget-paused"
  | "source-invalid"
  | "failed";

/** 存储形态的建议集（sourceHash 是提取时刻锚点答案全文的 SHA-256）。 */
export interface TerminologySuggestionSet {
  readonly treeId: TreeId;
  readonly branchId: BranchId;
  readonly anchorTurnId: TurnId;
  readonly readingMode: TerminologyReadingMode;
  readonly status: TerminologySuggestionSetStatus;
  readonly suggestions: readonly TerminologySuggestion[];
  /** partial：被密度上限截断的候选数。 */
  readonly hiddenCount: number;
  readonly sourceHash: string;
  readonly createdAt: IsoTimestamp;
  /** failed/budget-paused 的如实原因。 */
  readonly error: { readonly code: string; readonly message: string } | null;
}

/** readModel 暴露的自动建议总状态（gate × 模式联合决定生效与否）。 */
export interface TerminologyAutoSuggestionsState {
  readonly enabled: boolean;
  /** 未生效原因（quality-gate-pending | manual-only）；生效时 null。 */
  readonly reason: "quality-gate-pending" | "manual-only" | null;
  /** 该树的建议集（按产生序；投影时已做来源校验）。 */
  readonly sets: readonly TerminologySuggestionSet[];
}

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

export interface TerminologyServiceOptions {
  readonly repository: TreeRepository;
  readonly executor: TerminologyExecutor;
  /** 主产品服务（推广复用其 Anchor/Branch/Origin/Run/prompt 机制）。 */
  readonly studio: TreeStudioService;
  /**
   * 自动建议质量门禁（缺省 TERMINOLOGY_AUTO_QUALITY_GATE = false）。
   * **仅测试可强开**：宿主（index.ts）不传——生产恒为 false（零自动派发）。
   */
  readonly autoQualityGate?: boolean;
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

export interface TerminologyReadModel {
  readonly annotations: readonly TerminologyAnnotation[];
  readonly tasks: readonly TerminologyTask[];
  readonly usage: TerminologyUsageReport;
  readonly cacheEnabled: boolean;
  readonly limits: {
    readonly version: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly maxCandidates: number;
    readonly density: Readonly<typeof READING_MODE_DENSITY_LIMITS>;
    readonly tokenEstimate: "chars/4-unverified";
  };
  /** 每树阅读模式（issue #7 术语①；缺省 manual-only）。 */
  readonly readingMode: TerminologyReadingMode;
  /** 自动建议总状态（gate × 模式联合决定生效；建议集按产生序投影）。 */
  readonly autoSuggestions: TerminologyAutoSuggestionsState;
}
