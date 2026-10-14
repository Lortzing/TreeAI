/** model ownership for branching.ts; compatibility entrypoint remains one level above. */
import type {
  PromptOutcome,
  ReturnNavigationOutcome,
  TreeStudioService,
} from "../../service.ts";
import type {
  Branch,
  IsoTimestamp,
  MaterialBranchOrigin,
  MaterialId,
  MaterialSelection,
  MaterialVersion,
  MaterialVersionId,
  RunId,
  Turn,
  TurnId,
} from "@treeai/contracts";
import type {
  MaterialRepository,
  TreeRepository,
} from "@treeai/persistence";

/* ------------------------------------------------------------------ */
/* 组合上下文（charter §3.3 规则二/三；纯函数、确定性）                  */
/* ------------------------------------------------------------------ */

/** 组合上下文所含的块范围（对 UI 的「本次使用的材料范围」声明）。 */
export interface MaterialContextBlockRange {
  readonly blockId: string;
  readonly start: number;
  readonly end: number;
}

/**
 * 材料建枝的组合上下文视图：提交前（create 响应）与派发时（首问
 * composedPrefix）**逐字节相同**——全部成分由不可变数据决定（版本
 * canonicalText、块图、选区、parser 元信息；标题为显示量，见上）。
 */
export interface MaterialContextView {
  readonly materialId: MaterialId;
  readonly materialTitle: string;
  readonly versionId: MaterialVersionId;
  readonly parserKind: MaterialVersion["parserKind"];
  readonly parserVersion: string;
  /** 规范选区（blockId/start/end/excerpt/sourceHash 全通过锚定纪律）。 */
  readonly selection: MaterialSelection;
  /** 邻近块窗口在版本 canonicalText 内的 UTF-16 半开区间（含选区）。 */
  readonly window: { readonly start: number; readonly end: number };
  /** 窗口完整覆盖的块（窗口两端可能切在块中间——截断标记如实说明）。 */
  readonly contextBlocks: readonly MaterialContextBlockRange[];
  /** 确定上限（MATERIAL_CONTEXT_LIMIT_UNITS）。 */
  readonly limitUnits: number;
  /** 组合文本的 UTF-16 长度（恒 ≤ limitUnits）。 */
  readonly composedUnits: number;
  /** 窗口未覆盖整份材料（两端有省略）时为 true。 */
  readonly truncated: boolean;
  /** 截断标记（未截断为 null；同一段文本内嵌在 composed 里）。 */
  readonly truncationNote: string | null;
  /** 送入首问的完整组合文本（作为 composedPrefix，模型输入面事实）。 */
  readonly composed: string;
}

/* ------------------------------------------------------------------ */
/* 读模型与服务                                                          */
/* ------------------------------------------------------------------ */

export interface MaterialBranchingServiceOptions {
  readonly treeRepository: TreeRepository;
  readonly materialRepository: MaterialRepository;
  /** 主产品服务（建枝复用其 Branch/Episode/Run/Turn、prompt、Return 机制）。 */
  readonly studio: TreeStudioService;
}

/** 建枝结果（含提交前的组合上下文声明——与首问派发时逐字节相同）。 */
export interface MaterialBranchCreation {
  readonly branch: Branch;
  readonly origin: MaterialBranchOrigin;
  readonly context: MaterialContextView;
  /** false = 同键幂等重放（既有 Branch 原样返回，零新行）。 */
  readonly created: boolean;
}

/** 首问派发账本视角的结局（对齐术语 TerminologyDispatchOutcome 词汇）。 */
export type MaterialDispatchOutcome = "succeeded" | "failed" | "unknown";

export interface MaterialFirstQuestionResult {
  readonly branch: Branch;
  /** 首问派发结局：succeeded（本次或既往送达）/ failed（明确失败，可重试）/ unknown（对账不决，未重发）。 */
  readonly dispatch: MaterialDispatchOutcome;
  /** 本次调用实际送达的首问产物；重放/失败/未知为 null。 */
  readonly outcome: PromptOutcome | null;
  readonly error: { readonly code: string; readonly message: string } | null;
  /** 首问已落库时的定位（fresh 派发与幂等重放都给出；未送达为 null）。 */
  readonly landed: {
    readonly runId: RunId;
    readonly userTurnId: TurnId;
    readonly assistantTurnId: TurnId | null;
  } | null;
}

/** 同来源恢复 / 显式另开的结果。 */
export interface MaterialRestoreResult {
  readonly mode: "restored" | "created";
  readonly branch: Branch;
  readonly origin: MaterialBranchOrigin;
  readonly context: MaterialContextView;
  /** mode "created" 时：false = 同键幂等重放。 */
  readonly created: boolean;
  /** mode "restored" 时的回支导航尝试结果（与打开解耦，失败如实携带）。 */
  readonly navigation:
    | { readonly status: "navigated" }
    | { readonly status: "no-session" }
    | { readonly status: "failed"; readonly code: string; readonly message: string }
    | null;
  /** 恢复目标的续聊点会话可用性（A4 评估；null = 该分支尚无会话）。 */
  readonly sessionAvailability: "available" | "unavailable" | null;
}

/** 材料 Return 的卡片数据（charter §3.3 规则七的最小集）。 */
export interface MaterialReturnCard {
  readonly materialId: MaterialId;
  readonly materialTitle: string;
  readonly versionId: MaterialVersionId;
  readonly parserKind: MaterialVersion["parserKind"];
  readonly parserVersion: string;
  /** 块/页标识（页/段展示；pdf-page 块另有 1-based page）。 */
  readonly blockId: string;
  readonly page: number | null;
  readonly excerpt: string;
  /** 原文跳转（阅读器据此定位材料/版本/块/区间——不伪造主线位置）。 */
  readonly sourceJump: {
    readonly materialId: MaterialId;
    readonly versionId: MaterialVersionId;
    readonly blockId: string;
    readonly start: number;
    readonly end: number;
    readonly sourceHash: string;
  };
  /** 确认时间（无主线锚点时的主线放置依据）。 */
  readonly confirmTime: IsoTimestamp;
  /** 采用记录（尝试 vs 成功分开；signed W1 v3.0 §3.2 词汇）。 */
  readonly adoption: {
    readonly attempts: number;
    readonly deliveredRunId: RunId | null;
    readonly status: "saved" | "attempted" | "adopted";
  };
}

export interface MaterialReturnSubmission {
  readonly returnTurn: Turn;
  /** false = 同 idempotencyKey 同内容幂等重放（零写入）。 */
  readonly created: boolean;
  /** 保存后的回程导航结果（失败不回滚 Return，signed v3 §3.5）。 */
  readonly navigation: ReturnNavigationOutcome;
  readonly card: MaterialReturnCard;
}
