/**
 * MaterialBranchingService — D4-3「原文探索闭环」后端（issue #8 charter
 * §3.3 / ADR-004）。
 *
 * 定位：把「从原回答选区建枝」的 Branch/Origin/Run/Return 服务底层延伸到
 * 用户材料（charter §3.3 规则一：材料选文、术语入口和原回答选区最终使用
 * **同一** Branch/Origin/Run/Return 服务底层；仅来源解析与初始上下文构造
 * 不同）。来源解析复用 D4-2 的区间解析层产物（规范 MaterialSelection，经
 * MaterialRepository.getMaterialSelection 再校验切片/块/sourceHash 纪律）；
 * 建枝/首问/续聊/Return 全部复用 TreeStudioService 既有机制（Episode/Run/
 * Turn、#resolveContinuation、prompt 的 composedPrefix/turnPrefix、
 * submitReturn 的保存先于导航与采用尝试记录）。
 *
 * 显式运行起点（charter §3.3 规则二 / ADR-004 决策一）：材料没有天然 Pi
 * 分叉点——材料 Branch 的首个 Run 在**独立 session** 上开始，组合上下文
 * （材料标题/版本 + 选区摘录 + 有界邻近块）与用户问题一起作为**真实输入**
 * 送入首问；绝不制造假的历史回答，也绝不复用树内任何既有运行/会话
 * （复用必然把未请求的历史带入上下文或伪造延续性）。「同来源恢复已有
 * 探索」= 打开该来源已存在的 Branch 并续用其 session（决策二 a）；
 * 「显式另开」= 新 Branch + 新 session（决策二 b）；session 丢失后的
 * 「显式新探索」走 W1 §3.4 既有语义，材料上下文随行（决策二 c）。
 *
 * 上下文边界（charter §3.3 规则三 / ADR-003 §4）：组合上下文有确定上限
 * MATERIAL_CONTEXT_LIMIT_UNITS（24,000 UTF-16 单元，ADR-003 冻结值），
 * 超限在组合文本内**显式截断标记**（UI 在提交前从 create 响应读到完全
 * 相同的组合文本——范围 {window, contextBlocks, excerpt} 全部由不可变的
 * 版本 canonicalText/块图/选区决定，确定性成立）；选区自身超
 * MATERIAL_MAX_SELECTION_UNITS 直接拒绝（单次建枝容不下，零派发）。
 *
 * 首问提交意图身份（charter §3.3 规则四 / ADR-004 决策三）：
 * - 建枝 + 意图绑定原子落库（MaterialRepository.createMaterialBranch 单
 *   事务）：PRIMARY KEY(tree_id, intent_key)——双击、响应丢失重试、进程
 *   重启重放同一键 → 同一 Branch，不重复建枝；同键不同 selection → 409；
 * - 首问派发至多一次：结果判定**先对账后行动**（0009 派发账本纪律的
 *   服务层实现——见 ADR-004 决策四的 schema 边界记录）：已落库首问
 *   turn（显式前缀 + 问题原文全等）→ 幂等重放，不重发；分支存在非终态
 *   Run（在途/未收敛）→ 结果未知，**不盲发**（dispatch "unknown"）；
 *   无落库 turn 且全部 Run 终态 → 从未送达或明确失败，可（重）派发
 *   （失败重试是显式允许的新尝试）；首问已用**不同内容**送达 → 409
 *   （同分支首问不可变——改问是普通续聊，不是首问重试）；
 * - 浏览/搜索不创建 Turn（建枝调用只落 Branch/来源/绑定，零 Run/Turn）；
 *   保存批注（术语面）不自动建枝（本服务只被显式建枝入口调用）。
 *
 * Return（charter §3.3 规则七）：材料 Branch 的 Return 落所属 Tree 主线，
 * 完全复用 submitReturn 的保存先于导航（导航失败不回滚、结果分离呈现）与
 * return_adoption_attempts 采用尝试记录；targetAnchor 为 null（没有主线
 * 对话锚点，绝不伪造主线位置），卡片数据（材料标题/版本/块·页/摘录/确认
 * 时间/采用记录 + 原文跳转 sourceJump）从不可变材料来源 + return turn
 * 派生，主线按确认时间放置。
 */

import type {
  Branch,
  BranchId,
  IsoTimestamp,
  Material,
  MaterialBranchOrigin,
  MaterialBlock,
  MaterialId,
  MaterialSelection,
  MaterialVersion,
  MaterialVersionId,
  RunId,
  TreeId,
  Turn,
  TurnId,
} from "@treeai/contracts";
import {
  EntityNotFoundError,
  InvalidArgumentError,
  MaterialRepository,
  TreeRepository,
} from "@treeai/persistence";
import type { PromptOutcome, ReturnNavigationOutcome, TreeStudioService } from "../service.ts";
import { MaterialNotReadyError } from "./import-service.ts";

/* ------------------------------------------------------------------ */
/* 冻结常量（charter §3.3 / ADR-003 §4 / ADR-004 决策三）                */
/* ------------------------------------------------------------------ */

/**
 * 组合上下文的确定上限（UTF-16 单元；ADR-003 §4 冻结首版值 24,000）。
 * 选区摘录 + 有界邻近块 + 标题/版本标签的总预算；超限截断并在组合文本内
 * 显式标记（context.truncationNote 同时进 UI 预览与模型输入两处）。
 */
export const MATERIAL_CONTEXT_LIMIT_UNITS = 24_000;

/**
 * 单次建枝的选区上限（UTF-16 单元）：选区摘录必须**完整**进入组合上下文
 * （截断用户自己的选区是不诚实的锚定），因此选区自身超限即拒绝（400，
 * 零派发）——与术语解释的 MAX_EXPLAIN_SELECTION_CHARS 同一纪律。预留
 * MATERIAL_CONTEXT_RESERVE_UNITS 给标题/标签/截断标记，保证组合文本
 * 恒 ≤ MATERIAL_CONTEXT_LIMIT_UNITS。
 */
export const MATERIAL_MAX_SELECTION_UNITS = 20_000;

/** 组合上下文内材料标题的显示上限（标题可编辑、可很长——截断并标记）。 */
export const MATERIAL_CONTEXT_TITLE_UNITS = 80;

/** 标题/标签/截断标记的预算预留（组合文本恒 ≤ 上限的构造性保证）。 */
const MATERIAL_CONTEXT_RESERVE_UNITS = 800;

/**
 * 首问用户 turn 的显式标记前缀（可审计、不冒充历史——对齐
 * NEW_EXPLORATION_TURN_PREFIX / TERMINOLOGY_PROMOTION_TURN_PREFIX 模式）。
 * ADR-003 §4 的示意是 `[exploration from material <标题> v<版本>]`；ADR-004
 * 决策三把它细化为**只含 versionId**：材料标题是可编辑显示名（不是身份，
 * charter §3.1），把它写进 turn 前缀会让「同键异问」的对账基准随改名漂移
 * ——versionId 不可变，前缀因此稳定。
 */
export function materialExplorationTurnPrefix(origin: MaterialBranchOrigin): string {
  return `[exploration from material ${origin.selection.versionId}]`;
}

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

/** 选区身份（同一来源判定的全部维度：材料×版本×块×区间，缺一不可）。 */
export function sameMaterialSelectionIdentity(a: MaterialSelection, b: MaterialSelection): boolean {
  return (
    a.materialId === b.materialId &&
    a.versionId === b.versionId &&
    a.blockId === b.blockId &&
    a.start === b.start &&
    a.end === b.end
  );
}

function truncateTitle(title: string): string {
  if (title.length <= MATERIAL_CONTEXT_TITLE_UNITS) return title;
  return `${title.slice(0, MATERIAL_CONTEXT_TITLE_UNITS)}…`;
}

/**
 * 组合材料上下文（charter §3.3 规则二：「将选区、必要邻近段落、材料标题/
 * 版本和用户问题作为真实输入」）。确定性算法：
 * 1. 标题/版本头（标题截断到 MATERIAL_CONTEXT_TITLE_UNITS 并以 … 标记）；
 * 2. 选区摘录（完整引用——锚定事实，绝不截断用户的选区）；
 * 3. 有界邻近块窗口：从选区所在块开始，向两侧按整块交替扩展，直到预算
 *    用尽或覆盖整份材料；所在块自身超预算时改为选区两侧对称切片；
 * 4. 截断标记：窗口未覆盖整份材料（windowStart > 0 或 windowEnd <
 *    canonicalText.length）时，在组合文本内显式标注省略量与上限。
 */
export function composeMaterialContext(input: {
  readonly material: Material;
  readonly version: MaterialVersion;
  readonly canonicalText: string;
  readonly blocks: readonly MaterialBlock[];
  readonly selection: MaterialSelection;
}): MaterialContextView {
  const { material, version, canonicalText, blocks, selection } = input;
  const header =
    `[Exploration context from material "${truncateTitle(material.title)}" — ` +
    `version ${version.id} (${version.parserKind} ${version.parserVersion})]`;
  const excerptLine =
    `[Selected excerpt]: "${selection.excerpt}" ` +
    `(block ${selection.blockId}, units ${String(selection.start)}–${String(selection.end)} ` +
    "of the version canonical text)";
  const label = "[Surrounding material]:";

  /* 邻近块窗口（含选区；整块交替扩展，预算 = 上限 − 摘录行 − 预留）。 */
  const windowBudget = Math.max(
    0,
    MATERIAL_CONTEXT_LIMIT_UNITS - excerptLine.length - MATERIAL_CONTEXT_RESERVE_UNITS,
  );
  const containing = blocks.find((block) => block.blockId === selection.blockId);
  const blockStart = containing?.start ?? selection.start;
  const blockEnd = containing?.end ?? selection.end;
  let windowStart = blockStart;
  let windowEnd = blockEnd;
  if (windowEnd - windowStart <= windowBudget) {
    /* 整块交替扩展：优先补下一块、再补上一块（首选侧放不下/到边界时回落
       另一侧），直至预算或材料边界——确定性，两端任意一端先到边界即全力
       扩另一端。 */
    const anchorIndex = blocks.findIndex((block) => block.blockId === selection.blockId);
    let lowIndex = anchorIndex;
    let highIndex = anchorIndex;
    let growNext = true;
    if (anchorIndex >= 0) {
      for (;;) {
        const next = highIndex + 1 < blocks.length ? blocks[highIndex + 1] : undefined;
        const previous = lowIndex - 1 >= 0 ? blocks[lowIndex - 1] : undefined;
        const canNext = next !== undefined && next.end - windowStart <= windowBudget;
        const canPrevious = previous !== undefined && windowEnd - previous.start <= windowBudget;
        if (canNext && (growNext || !canPrevious)) {
          windowEnd = next!.end;
          highIndex += 1;
        } else if (canPrevious) {
          windowStart = previous!.start;
          lowIndex -= 1;
        } else {
          break;
        }
        growNext = !growNext;
      }
    }
  } else {
    /* 所在块超预算：选区两侧对称切片（选区本身完整保留在切片内——
       选区长度 ≤ MATERIAL_MAX_SELECTION_UNITS < 预算下界的构造保证）。 */
    const selectionLength = selection.end - selection.start;
    if (windowBudget <= selectionLength) {
      windowStart = selection.start;
      windowEnd = selection.end;
    } else {
      const sideBudget = Math.floor((windowBudget - selectionLength) / 2);
      windowStart = Math.max(blockStart, selection.start - sideBudget);
      windowEnd = Math.min(blockEnd, selection.end + (windowBudget - (selection.end - windowStart)));
    }
  }
  const windowText = canonicalText.slice(windowStart, windowEnd);
  const truncated = windowStart > 0 || windowEnd < canonicalText.length;
  const truncationNote = truncated
    ? `[Context truncated: the surrounding-material window shows units ${String(windowStart)}–${String(windowEnd)} ` +
      `of ${String(canonicalText.length)}; the composed context is capped at ` +
      `${String(MATERIAL_CONTEXT_LIMIT_UNITS)} UTF-16 units]`
    : null;

  const parts = [header, excerptLine, `${label}\n"${windowText}"`];
  if (truncationNote !== null) parts.push(truncationNote);
  parts.push("");
  let composed = parts.join("\n");
  /* 防御性钳制（各上限的构造下不应触发；如触发则收窄窗口，绝不超过上限）。 */
  if (composed.length > MATERIAL_CONTEXT_LIMIT_UNITS) {
    const excess = composed.length - MATERIAL_CONTEXT_LIMIT_UNITS;
    const clampedWindow = windowText.slice(0, Math.max(0, windowText.length - excess));
    composed =
      `${header}\n${excerptLine}\n${label}\n"${clampedWindow}"\n` +
      `[Context truncated: the composed context is capped at ${String(MATERIAL_CONTEXT_LIMIT_UNITS)} UTF-16 units]\n`;
  }

  const contextBlocks: MaterialContextBlockRange[] = blocks
    .filter((block) => block.start >= windowStart && block.end <= windowEnd)
    .map((block) => ({ blockId: block.blockId, start: block.start, end: block.end }));

  return {
    materialId: material.id,
    materialTitle: material.title,
    versionId: version.id,
    parserKind: version.parserKind,
    parserVersion: version.parserVersion,
    selection,
    window: { start: windowStart, end: windowEnd },
    contextBlocks,
    limitUnits: MATERIAL_CONTEXT_LIMIT_UNITS,
    composedUnits: composed.length,
    truncated,
    truncationNote,
    composed,
  };
}

/* ------------------------------------------------------------------ */
/* 错误（HTTP 层映射见 server.ts：409）                                 */
/* ------------------------------------------------------------------ */

/**
 * 材料**建枝**意图冲突：同树同 intent_key 已绑定不同材料选区（materialId/
 * versionId/blockId/start/end 任一不同）→ 409。既有 Branch/来源/绑定不变；
 * 一次逻辑提交（同一键）不得静默换源——换选区必须换键。
 */
export class MaterialBranchConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaterialBranchConflictError";
  }
}

/**
 * 材料**首问**内容冲突：该材料分支的首问已用不同内容落库（dispatched 且
 * 送达）→ 409。首问对同一 intent 键不可变（改问是普通续聊，不是首问重试）；
 * 与术语推广的「同键异问 → 409」同一纪律（issue #7 P0 整改口径）。
 */
export class MaterialFirstQuestionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaterialFirstQuestionConflictError";
  }
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

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toErrorCode(err: unknown): string {
  if (err !== null && typeof err === "object" && "code" in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "unknown";
}

export class MaterialBranchingService {
  readonly treeRepository: TreeRepository;
  readonly materialRepository: MaterialRepository;
  readonly studio: TreeStudioService;

  constructor(options: MaterialBranchingServiceOptions) {
    this.treeRepository = options.treeRepository;
    this.materialRepository = options.materialRepository;
    this.studio = options.studio;
  }

  /* ------------------------------ 建枝（规则一/三） ------------------------------ */

  /**
   * 从材料选区建枝（幂等）：Branch + 材料来源 + 首问意图绑定**单事务原子
   * 落库**（MaterialRepository.createMaterialBranch——任何一步失败零新增
   * 行）；同键重放返回既有 Branch；同键不同选区 → 409。本次调用零 Run/
   * Turn（浏览/搜索不创建 Turn——首问是独立的显式提交，见 firstQuestion）。
   * 返回的组合上下文与后续首问派发的 composedPrefix 逐字节相同（UI 在
   * 提交前据此说明材料范围与截断状态）。
   */
  createMaterialBranch(input: {
    readonly treeId: TreeId;
    readonly selection: MaterialSelection;
    readonly intentKey: string;
  }): MaterialBranchCreation {
    if (typeof input.intentKey !== "string" || input.intentKey.trim().length === 0) {
      throw new InvalidArgumentError("material branching intentKey must be a non-empty string");
    }
    const tree = this.treeRepository.getTree(input.treeId); // EntityNotFoundError → 404
    this.#assertMaterialLinked(tree.id, input.selection.materialId); // 404
    const anchored = this.materialRepository.getMaterialSelection(input.selection); // 纪律 400 / 引用 404
    if (anchored.version.parseStatus !== "ready") {
      throw new MaterialNotReadyError(anchored.version); // 409：不把不支持伪装成成功
    }
    const selectionLength = input.selection.end - input.selection.start;
    if (selectionLength > MATERIAL_MAX_SELECTION_UNITS) {
      throw new InvalidArgumentError(
        `the selection is ${String(selectionLength)} UTF-16 units; a material branch accepts at most ` +
          `${String(MATERIAL_MAX_SELECTION_UNITS)} (the excerpt must enter the composed context in full — ` +
          "truncating the user's own selection would be a dishonest anchor), zero dispatch",
      );
    }
    const trunk = this.#trunkOf(tree.id);
    const existing = this.materialRepository.findFirstQuestion(tree.id, input.intentKey);
    if (existing !== null) {
      return this.#replayCreation(tree.id, input.intentKey, existing, input.selection);
    }
    const created = this.materialRepository.createMaterialBranch({
      treeId: tree.id,
      parentBranchId: trunk.id,
      selection: input.selection,
      intentKey: input.intentKey,
    });
    if (created.replayed && !sameMaterialSelectionIdentity(created.origin.selection, input.selection)) {
      /* 并发同键异选区判负：createMaterialBranch 已零写入（事务内只读回放），
         以 409 如实呈现——一次逻辑提交不得静默换源。 */
      throw this.#selectionConflict(input.intentKey, created.origin.selection, input.selection);
    }
    return {
      branch: created.branch,
      origin: created.origin,
      context: this.buildContext(created.origin),
      created: !created.replayed,
    };
  }

  /** 同键重放对齐：既有绑定的 Branch + 来源；选区不一致 → 409（不换源）。 */
  #replayCreation(
    treeId: TreeId,
    intentKey: string,
    existing: { readonly branchId: BranchId },
    selection: MaterialSelection,
  ): MaterialBranchCreation {
    const branch = this.treeRepository.getBranch(existing.branchId); // 404（绑定悬空）
    if (branch.treeId !== treeId) {
      throw new InvalidArgumentError(
        `material first-question binding points at branch ${branch.id} of tree ${branch.treeId}, not ${treeId} ` +
          "(schema integrity violation)",
      );
    }
    const originRef = this.materialRepository.getBranchOrigin(branch.id);
    if (originRef === null || originRef.kind !== "material") {
      throw new InvalidArgumentError(
        `branch ${branch.id} has a first-question binding but no material origin (schema integrity violation)`,
      );
    }
    if (!sameMaterialSelectionIdentity(originRef.origin.selection, selection)) {
      throw this.#selectionConflict(intentKey, originRef.origin.selection, selection);
    }
    return { branch, origin: originRef.origin, context: this.buildContext(originRef.origin), created: false };
  }

  #selectionConflict(intentKey: string, bound: MaterialSelection, requested: MaterialSelection): MaterialBranchConflictError {
    const describe = (selection: MaterialSelection): string =>
      `material ${selection.materialId} version ${selection.versionId} block ${selection.blockId} ` +
      `[${String(selection.start)}, ${String(selection.end)})`;
    return new MaterialBranchConflictError(
      `material branching intent key '${intentKey}' is already bound to a branch from a different selection ` +
        `(bound: ${describe(bound)}; requested: ${describe(requested)}); ` +
        "an intent key identifies exactly one material branching submission — use a new key for a new selection",
    );
  }

  /** 组合上下文视图（建枝与首问派发共用；全部成分不可变 ⇒ 确定性）。 */
  buildContext(origin: MaterialBranchOrigin): MaterialContextView {
    const anchored = this.materialRepository.getMaterialSelection(origin.selection);
    const content = this.materialRepository.getVersionContent(origin.selection.versionId);
    return composeMaterialContext({
      material: anchored.material,
      version: content.version,
      canonicalText: content.canonicalText,
      blocks: content.blocks,
      selection: origin.selection,
    });
  }

  /* ------------------------------ 首问（规则二/四/五） ------------------------------ */

  /**
   * 幂等首问（提交意图身份，0009 派发账本纪律的服务层实现——ADR-004
   * 决策四）：以 (tree, intentKey) 绑定的 Branch 为对象，先**对账**再行动：
   * - 已落库首问 turn（显式前缀 + 问题原文全等）→ 幂等重放（succeeded，
   *   不重发、不重建枝）；
   * - 分支存在非终态 Run（在途/未收敛）→ dispatch "unknown"，**不盲发**；
   * - 首问已用不同内容落库 → 409（首问不可变；改问走普通续聊）；
   * - 其余（无落库 turn 且全部 Run 终态或无 Run）→ 从未送达或明确失败，
   *   派发首问：组合上下文作 composedPrefix（模型输入面），用户 turn 落库
   *   为 前缀 + 问题原文（可审计）。失败 → dispatch "failed"（同键重试是
   *   显式允许的新尝试）。
   */
  async firstQuestion(input: {
    readonly treeId: TreeId;
    readonly intentKey: string;
    readonly firstQuestion: string;
  }): Promise<MaterialFirstQuestionResult> {
    if (typeof input.intentKey !== "string" || input.intentKey.trim().length === 0) {
      throw new InvalidArgumentError("material first-question intentKey must be a non-empty string");
    }
    if (typeof input.firstQuestion !== "string" || input.firstQuestion.trim().length === 0) {
      throw new InvalidArgumentError("material firstQuestion must be a non-empty string");
    }
    const tree = this.treeRepository.getTree(input.treeId); // 404
    const intent = this.materialRepository.findFirstQuestion(tree.id, input.intentKey);
    if (intent === null) {
      throw new InvalidArgumentError(
        `material first-question intent key '${input.intentKey}' is not registered in tree ${tree.id}; ` +
          "create the material branch with this key first",
      );
    }
    const branch = this.treeRepository.getBranch(intent.branchId); // 404
    if (branch.treeId !== tree.id) {
      throw new InvalidArgumentError(
        `material first-question binding points at branch ${branch.id} of tree ${branch.treeId}, not ${tree.id} ` +
          "(schema integrity violation)",
      );
    }
    const originRef = this.materialRepository.getBranchOrigin(branch.id);
    if (originRef === null || originRef.kind !== "material") {
      throw new InvalidArgumentError(
        `branch ${branch.id} has a first-question binding but no material origin (schema integrity violation)`,
      );
    }
    const origin = originRef.origin;
    const prefix = materialExplorationTurnPrefix(origin);
    const expectedTurnText = `${prefix}\n\n${input.firstQuestion}`;

    /* 对账证据一：首问 turn 已落库（前缀 + 问题原文全等）→ 已送达。 */
    const turns = this.treeRepository.listTurns(branch.id);
    const landed = turns.find((turn) => turn.role === "user" && turn.text === expectedTurnText);
    if (landed !== undefined) {
      if (landed.runId === null) {
        throw new InvalidArgumentError(
          `first-question turn ${landed.id} has no run (schema integrity violation)`,
        );
      }
      const assistant = turns.find((turn) => turn.role === "assistant" && turn.runId === landed!.runId) ?? null;
      return {
        branch,
        dispatch: "succeeded",
        outcome: null,
        error: null,
        landed: { runId: landed.runId, userTurnId: landed.id, assistantTurnId: assistant?.id ?? null },
      };
    }
    /* 首问已用不同内容落库 → 不可变冲突（改问是普通续聊）。 */
    const landedDifferent = turns.find((turn) => turn.role === "user" && turn.text.startsWith(prefix));
    if (landedDifferent !== undefined) {
      throw new MaterialFirstQuestionConflictError(
        `the first question on material branch ${branch.id} was already dispatched with different content ` +
          `(turn ${landedDifferent.id}); the first question is immutable for this branch — ` +
          "ask the changed question as a normal continuation instead of retrying the first-question endpoint",
      );
    }
    /* 对账证据二：非终态 Run（在途/未收敛）→ 结果未知，不盲发。 */
    for (const episode of this.treeRepository.listEpisodes(branch.id)) {
      for (const run of this.treeRepository.listRuns(episode.id)) {
        if (run.terminalAt === null) {
          return {
            branch,
            dispatch: "unknown",
            outcome: null,
            error: {
              code: "dispatch-unknown",
              message:
                `the first question for material branch ${branch.id} was dispatched but never reached a ` +
                "terminal state (the process exited mid-dispatch or another dispatch may still be in flight); " +
                "it was NOT re-sent — reconcile the branch's runs, then retry",
            },
            landed: null,
          };
        }
      }
    }
    /* 未送达（从未派发 / 明确失败）→ 派发（失败重试是显式允许的新尝试）。 */
    const context = this.buildContext(origin);
    try {
      const outcome = await this.studio.prompt(tree.id, branch.id, input.firstQuestion, {
        composedPrefix: context.composed,
        turnPrefix: prefix,
      });
      return {
        branch,
        dispatch: "succeeded",
        outcome,
        error: null,
        landed: {
          runId: outcome.run.id,
          userTurnId: outcome.userTurn.id,
          assistantTurnId: outcome.assistantTurn.id,
        },
      };
    } catch (err) {
      return {
        branch,
        dispatch: "failed",
        outcome: null,
        error: { code: toErrorCode(err), message: toErrorMessage(err) },
        landed: null,
      };
    }
  }

  /* ------------------------------ 同来源恢复 / 显式另开（规则五/六） ------------------------------ */

  /**
   * 给定材料锚点：恢复该来源的既有探索（mode "restore"——打开既有 Branch
   * 并续用其 session，不新建、不重注入材料上下文），或显式另开
   * （mode "new"——新 Branch + 新 session）。同一来源 = 选区身份全等
   * （材料×版本×块×区间）；同名词/同摘录在不同材料、不同版本、不同
   * Tree、甚至同版本不同偏移都**不会**被复用（零误匹配纪律，与区间解析
   * 层同一口径——绝不以相似文字兜底）。
   */
  async restoreOrOpen(input: {
    readonly treeId: TreeId;
    readonly selection: MaterialSelection;
    readonly mode: "restore" | "new";
    readonly intentKey?: string;
  }): Promise<MaterialRestoreResult> {
    if (input.mode !== "restore" && input.mode !== "new") {
      throw new InvalidArgumentError(`mode must be 'restore' or 'new' (got '${String(input.mode)}')`);
    }
    const tree = this.treeRepository.getTree(input.treeId); // 404
    this.#assertMaterialLinked(tree.id, input.selection.materialId); // 404
    this.materialRepository.getMaterialSelection(input.selection); // 选区纪律（404/400）
    if (input.mode === "new") {
      if (typeof input.intentKey !== "string" || input.intentKey.trim().length === 0) {
        throw new InvalidArgumentError("mode 'new' requires an intentKey (a new exploration is a new submission)");
      }
      const creation = this.createMaterialBranch({
        treeId: tree.id,
        selection: input.selection,
        intentKey: input.intentKey,
      });
      return {
        mode: "created",
        branch: creation.branch,
        origin: creation.origin,
        context: creation.context,
        created: creation.created,
        navigation: null,
        sessionAvailability: null,
      };
    }
    const target = this.#findExplorationForSelection(tree.id, input.selection);
    /* 打开既有探索：对准其续聊点（导航失败如实分离——分支与来源照常返回，
       session 不可用时 UI 给出显式新探索入口，charter §5）。 */
    let navigation: MaterialRestoreResult["navigation"];
    try {
      const cursor = await this.studio.switchBranch(tree.id, target.branch.id);
      navigation = cursor === null ? { status: "no-session" } : { status: "navigated" };
    } catch (err) {
      navigation = { status: "failed", code: toErrorCode(err), message: toErrorMessage(err) };
    }
    const view = this.studio
      .getTreeState(tree.id)
      .branches.find((candidate) => candidate.branch.id === target.branch.id);
    return {
      mode: "restored",
      branch: target.branch,
      origin: target.origin,
      context: this.buildContext(target.origin),
      created: false,
      navigation,
      sessionAvailability: view?.sessionAvailability ?? null,
    };
  }

  /** 树内以该选区为来源的最新探索（多枝时取最新；无则 404）。 */
  #findExplorationForSelection(
    treeId: TreeId,
    selection: MaterialSelection,
  ): { readonly branch: Branch; readonly origin: MaterialBranchOrigin } {
    const branches = this.treeRepository.listBranches(treeId); // created_at, rowid 序
    for (let index = branches.length - 1; index >= 0; index -= 1) {
      const branch = branches[index]!;
      const originRef = this.materialRepository.getBranchOrigin(branch.id);
      if (originRef === null || originRef.kind !== "material") continue;
      if (sameMaterialSelectionIdentity(originRef.origin.selection, selection)) {
        return { branch, origin: originRef.origin };
      }
    }
    throw new EntityNotFoundError(
      `material exploration for this source in tree ${treeId}`,
      `${selection.materialId} ${selection.versionId} ${selection.blockId} [${String(selection.start)},${String(selection.end)})`,
    );
  }

  /* ------------------------------ Return（规则七） ------------------------------ */

  /**
   * 材料 Branch 的 Return：完全复用 studio.submitReturn（保存先于导航、
   * 幂等键、采用尝试/成功分离——W1 §3.2/§3.5 既有语义），叠加材料卡片数据
   * （标题/版本/块·页/摘录/确认时间/采用记录 + sourceJump）。targetAnchor
   * 为 null（材料来源没有主线对话锚点，主线按确认时间放置，绝不伪造）。
   */
  async submitMaterialReturn(input: {
    readonly treeId: TreeId;
    readonly fromBranchId: BranchId;
    readonly text: string;
    readonly idempotencyKey: string;
  }): Promise<MaterialReturnSubmission> {
    const tree = this.treeRepository.getTree(input.treeId); // 404
    const branch = this.treeRepository.getBranch(input.fromBranchId); // 404
    if (branch.treeId !== tree.id) {
      throw new InvalidArgumentError(
        `branch ${input.fromBranchId} belongs to tree ${branch.treeId}, not ${tree.id}`,
      );
    }
    const originRef = this.materialRepository.getBranchOrigin(branch.id);
    if (originRef === null || originRef.kind !== "material") {
      throw new InvalidArgumentError(
        `branch ${input.fromBranchId} is not a material branch; use the standard return endpoint for turn-source branches`,
      );
    }
    const submission = await this.studio.submitReturn(
      tree.id,
      branch.id,
      input.text,
      input.idempotencyKey,
    );
    return {
      returnTurn: submission.turn,
      created: submission.created,
      navigation: submission.navigation,
      card: this.#returnCard(submission.turn, originRef.origin),
    };
  }

  /** 材料 Return 卡片（从不可变材料来源 + return turn 派生）。 */
  #returnCard(turn: Turn, origin: MaterialBranchOrigin): MaterialReturnCard {
    const anchored = this.materialRepository.getMaterialSelection(origin.selection);
    const content = this.materialRepository.getVersionContent(origin.selection.versionId);
    const block = content.blocks.find((entry) => entry.blockId === origin.selection.blockId) ?? null;
    const attempts = this.treeRepository.listReturnAdoptionAttempts(turn.id);
    const status: MaterialReturnCard["adoption"]["status"] =
      turn.deliveredRunId !== null ? "adopted" : attempts.length > 0 ? "attempted" : "saved";
    return {
      materialId: anchored.material.id,
      materialTitle: anchored.material.title,
      versionId: origin.selection.versionId,
      parserKind: content.version.parserKind,
      parserVersion: content.version.parserVersion,
      blockId: origin.selection.blockId,
      page: block?.page ?? null,
      excerpt: origin.selection.excerpt,
      sourceJump: {
        materialId: origin.selection.materialId,
        versionId: origin.selection.versionId,
        blockId: origin.selection.blockId,
        start: origin.selection.start,
        end: origin.selection.end,
        sourceHash: origin.selection.sourceHash,
      },
      confirmTime: turn.createdAt,
      adoption: { attempts: attempts.length, deliveredRunId: turn.deliveredRunId, status },
    };
  }

  /* ------------------------------ 缺 session 显式新探索（规则八） ------------------------------ */

  /**
   * 「以保存内容开始新的探索」的材料分支版（W1 §3.4 / signed v3 §4.4 语义
   * + 材料上下文随行）：仅在该分支续聊点 session **当前不可用**时成立
   * （可用 → NewExplorationConflictError 409，应走普通续聊；无历史 session
   * 同样拒绝——普通 prompt 即会新建）。新 session 的首问以
   * #newExplorationContext（显式声明旧上下文未恢复 + 材料来源上下文块 +
   * 分支已保存历史文本化带入）+ 用户问题为真实输入；旧历史保持可读，
   * 来源关系（材料 origin）不动。
   */
  async promptNewMaterialExploration(treeId: TreeId, branchId: BranchId, text: string): Promise<PromptOutcome> {
    const tree = this.treeRepository.getTree(treeId); // 404
    const branch = this.treeRepository.getBranch(branchId); // 404
    if (branch.treeId !== tree.id) {
      throw new InvalidArgumentError(`branch ${branchId} belongs to tree ${branch.treeId}, not ${tree.id}`);
    }
    const originRef = this.materialRepository.getBranchOrigin(branch.id);
    if (originRef === null || originRef.kind !== "material") {
      throw new InvalidArgumentError(
        `branch ${branchId} is not a material branch; use the standard new-exploration endpoint for turn-source branches`,
      );
    }
    const context = this.buildContext(originRef.origin);
    return this.studio.prompt(tree.id, branch.id, text, {
      newExploration: true,
      newExplorationMaterialContext: context.composed,
    });
  }

  /* ------------------------------ 内部校验 ------------------------------ */

  /** 材料必须链接到该树（一树多材料、一材料多树——讨论/Return 按树隔离）。 */
  #assertMaterialLinked(treeId: TreeId, materialId: MaterialId): void {
    const linked = this.materialRepository
      .listTreeMaterials(treeId)
      .some((material) => material.id === materialId);
    if (!linked) {
      throw new EntityNotFoundError(`material in tree ${treeId}`, materialId);
    }
  }

  #trunkOf(treeId: TreeId): Branch {
    const trunk = this.treeRepository.listBranches(treeId).find((branch) => branch.parentBranchId === null);
    if (trunk === undefined) {
      throw new InvalidArgumentError(`tree ${treeId} has no trunk (root) branch`);
    }
    return trunk;
  }
}
