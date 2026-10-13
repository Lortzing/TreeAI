/** model ownership for material-repository.ts; compatibility entrypoint remains one level above. */
import type {
  Branch,
  BranchId,
  BranchOrigin,
  IsoTimestamp,
  Material,
  MaterialBlock,
  MaterialBranchOrigin,
  MaterialId,
  MaterialParserKind,
  MaterialParseStatus,
  MaterialSelection,
  MaterialVersion,
  MaterialVersionId,
  TreeId,
} from "@treeai/contracts";

/** branches.origin_kind 的合法取值（migration 0008 CHECK 同集合）。 */
export type BranchOriginKind = "none" | "turn" | "material";

/* ------------------------------------------------------------------ */
/* 选项与输入形状                                                       */
/* ------------------------------------------------------------------ */

export interface MaterialRepositoryOptions {
  /** 数据库文件路径；`":memory:"` 为纯内存库。 */
  readonly path: string;
  /** 时钟注入（默认真实 UTC ISO 8601）。 */
  readonly now?: () => IsoTimestamp;
  /** 原始 id 生成器注入（默认 randomUUID；仓储自动加实体前缀）。 */
  readonly generateId?: () => string;
  /** 写锁等待毫秒数（默认 5000）。 */
  readonly busyTimeoutMs?: number;
}

export interface CreateMaterialInput {
  readonly id?: MaterialId;
  /** 可编辑显示名；不是身份（文件名不是身份——charter §3.1）。 */
  readonly title: string;
}

export interface InsertMaterialVersionInput {
  readonly id?: MaterialVersionId;
  readonly materialId: MaterialId;
  /** 原件字节（先经内容寻址入库；同材料同字节复用既有版本）。 */
  readonly bytes: Uint8Array;
  readonly parserKind: MaterialParserKind;
  /** 解析器版本（如 "d4-md-v1" / "d4-pdf-v1"）。 */
  readonly parserVersion: string;
  readonly parseStatus: MaterialParseStatus;
  /** failed/unsupported/rejected 必填（原因码+说明）；其他状态必须为 null/缺省。 */
  readonly parseError?: string | null;
  /** 版本 canonicalText（解析器产出；未解析状态可为空串）。 */
  readonly canonicalText: string;
  /** canonicalText 的有序连续块覆盖（MaterialBlock[]）。 */
  readonly blocks: readonly MaterialBlock[];
}

/** updateVersionParseResult 允许的目标状态（解析流水线的中间态与终态）。 */
export type MaterialParseTransitionStatus = "parsing" | "ready" | "failed" | "canceled";

export interface UpdateVersionParseResultInput {
  readonly versionId: MaterialVersionId;
  /** 目标状态：'parsing'（中间态）或终态 'ready' | 'failed' | 'canceled'。 */
  readonly parseStatus: MaterialParseTransitionStatus;
  /** failed 必填（原因码+说明）；其他状态必须 null/缺省。 */
  readonly parseError?: string | null;
  /**
   * ready：解析产出 canonicalText（块覆盖校验同 insertVersion）；
   * 非 ready：必须为空串（规范文本只随 ready 落库——超限/失败文本不存储）。
   */
  readonly canonicalText: string;
  readonly blocks: readonly MaterialBlock[];
}

/** 版本内容读取（分块读取 API 的存储面；canonicalText 只在此暴露）。 */
export interface MaterialVersionContent {
  readonly version: MaterialVersion;
  readonly canonicalText: string;
  readonly blocks: readonly MaterialBlock[];
}

export interface MaterialVersionBlob {
  readonly version: MaterialVersion;
  readonly bytes: Uint8Array;
}

export interface TreeMaterialLink {
  readonly treeId: TreeId;
  readonly materialId: MaterialId;
  readonly linkedAt: IsoTimestamp;
}

export interface UpsertReadingPositionInput {
  readonly treeId: TreeId;
  readonly materialId: MaterialId;
  readonly versionId: MaterialVersionId;
  /** 最后阅读块；null = 未开始。给出时必须存在于版本 block map。 */
  readonly blockId?: string | null;
  /** 可选：块内关注偏移；要求 blockId 同时给出且落在该块区间内。 */
  readonly focusStart?: number | null;
}

export interface MaterialFirstQuestion {
  readonly treeId: TreeId;
  readonly intentKey: string;
  readonly branchId: BranchId;
  readonly createdAt: IsoTimestamp;
}

export interface InsertFirstQuestionInput {
  readonly treeId: TreeId;
  readonly branchId: BranchId;
  /** 提交意图身份（树内唯一；双击/重试/重启重放同键返回同一 Branch）。 */
  readonly intentKey: string;
}

export interface InsertFirstQuestionResult {
  readonly question: MaterialFirstQuestion;
  /** true = 幂等重放（既有行原样返回，不重复建枝、不重复派发首问）。 */
  readonly replayed: boolean;
}

export interface InsertMaterialBranchOriginInput {
  readonly branchId: BranchId;
  readonly treeId: TreeId;
  readonly selection: MaterialSelection;
}

/**
 * 材料建枝的原子落库输入（D4-3，ADR-004）：Branch 行 + 材料来源 + 首问
 * 意图绑定三方写入同一事务的载荷。
 */
export interface CreateMaterialBranchInput {
  readonly treeId: TreeId;
  /** 父分支（材料建枝服务传所属树的 Trunk；必须属于同一 Tree）。 */
  readonly parentBranchId: BranchId;
  readonly selection: MaterialSelection;
  /** 提交意图身份（树内唯一；同键重放返回既有绑定，零新行）。 */
  readonly intentKey: string;
  /** 分支 id 注入（测试确定性；缺省 branch_&lt;uuid&gt;）。 */
  readonly branchId?: BranchId;
}

/** 材料建枝落库结果；replayed=true 时为同键幂等重放（零新行）。 */
export interface CreateMaterialBranchResult {
  readonly branch: Branch;
  readonly origin: MaterialBranchOrigin;
  readonly question: MaterialFirstQuestion;
  /** false = 本次调用新建；true = 同键既有绑定原样返回。 */
  readonly replayed: boolean;
}

/** getMaterialSelection 的校验结果：选区 + 锚定所需的材料与版本上下文。 */
export interface MaterialSelectionContext {
  /** 已校验的选区（切片/摘录/块/sourceHash 一致性全部通过）。 */
  readonly selection: MaterialSelection;
  readonly material: Material;
  readonly version: MaterialVersion;
}

/**
 * 统一来源读取（ADR-003 §2）：Turn 来源或 Material 来源或 null。
 * 判别以两张来源表的实际行为准（各自 branch_id 主键结构性保证每枝
 * 至多一条；两表同时有行按库损坏处理）。
 */
export type BranchOriginRef =
  | { readonly kind: "turn"; readonly origin: BranchOrigin }
  | { readonly kind: "material"; readonly origin: MaterialBranchOrigin };

/* ------------------------------------------------------------------ */
/* 行形状与领域还原（本仓储私有；canonicalText/block map 不外泄到契约形状） */
/* ------------------------------------------------------------------ */

export interface MaterialRow {
  material_id: string;
  title: string;
  created_at: string;
}

export interface MaterialVersionRow {
  version_id: string;
  material_id: string;
  content_hash: string;
  parser_kind: string;
  parser_version: string;
  imported_at: string;
  size_bytes: number;
  parse_status: string;
  parse_error: string | null;
  text_units: number;
  canonical_text: string;
  block_map_json: string;
}

export interface MaterialBranchOriginRow {
  branch_id: string;
  tree_id: string;
  material_id: string;
  version_id: string;
  block_id: string;
  start: number;
  end: number;
  excerpt: string;
  source_hash: string;
  created_at: string;
}

export interface ReadingPositionRow {
  tree_id: string;
  material_id: string;
  version_id: string;
  block_id: string | null;
  focus_start: number | null;
  updated_at: string;
}

export interface FirstQuestionRow {
  intent_key: string;
  tree_id: string;
  branch_id: string;
  created_at: string;
}
