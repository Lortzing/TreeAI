/** model ownership for nav-engine.ts; compatibility entrypoint remains one level above. */
import type {
  Branch,
  IsoTimestamp,
} from "@treeai/contracts";
import type {
  MaterialRepository,
  TreeRepository,
} from "@treeai/persistence";

/* ------------------------------------------------------------------ */
/* 公共视图类型                                                          */
/* ------------------------------------------------------------------ */

export type NavOriginKind = "none" | "turn" | "material";

/** 导航树节点视图（标题 = 该分支首个 user Turn 文本；null = 尚无首问）。 */
export interface NavNodeView {
  readonly id: string;
  readonly treeId: string;
  readonly parentBranchId: string | null;
  readonly depth: number;
  readonly title: string | null;
  readonly originKind: NavOriginKind;
  readonly childCount: number;
  readonly createdAt: IsoTimestamp;
}

export interface NavChildrenPage {
  readonly treeId: string;
  readonly parentBranchId: string;
  readonly nodes: readonly NavNodeView[];
  readonly nextCursor: string | null;
  readonly totalChildren: number;
}

export interface NavSubtreePage {
  readonly treeId: string;
  readonly rootBranchId: string;
  /** BFS 序（root 在首），受 maxDepth 限制。 */
  readonly nodes: readonly NavNodeView[];
  readonly maxDepth: number;
  /** 深度受限子树的全部节点数（分页截断前的总量）。 */
  readonly totalNodes: number;
  readonly truncated: boolean;
  readonly nextCursor: string | null;
}

export interface NavAncestor {
  readonly id: string;
  readonly title: string | null;
  readonly depth: number;
}

export interface NavOriginSelection {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export interface NavOriginTurnView {
  readonly kind: "turn";
  readonly sourceBranchId: string;
  readonly anchorTurnId: string;
  readonly anchorEntryId: string;
  readonly selection: NavOriginSelection;
}

export interface NavOriginMaterialView {
  readonly kind: "material";
  readonly materialId: string;
  readonly versionId: string;
  readonly blockId: string;
  readonly start: number;
  readonly end: number;
  readonly excerpt: string;
  readonly sourceHash: string;
}

export type NavOriginView = NavOriginTurnView | NavOriginMaterialView;

/** 节点定位：跨树按 id 找到树、祖先链、兄弟位次与来源。 */
export interface NavLocation {
  readonly treeId: string;
  readonly treeTitle: string | null;
  readonly node: NavNodeView;
  /** 根→父 的祖先链（不含本节点；迭代计算）。 */
  readonly ancestors: readonly NavAncestor[];
  /** 根→本节点 的完整路径（含本节点）。 */
  readonly path: readonly NavAncestor[];
  /** 兄弟位次（trunk 无父 → null）。 */
  readonly siblingPosition: { readonly index: number; readonly total: number } | null;
  readonly origin: NavOriginView | null;
}

export interface NavTreeSummary {
  readonly treeId: string;
  readonly forestId: string;
  readonly createdAt: IsoTimestamp;
  /** 树标题 = trunk 首个 user Turn 文本（产品事实；无首问为 null）。 */
  readonly title: string | null;
  readonly trunkBranchId: string;
}

export interface NavTreeOverview extends NavTreeSummary {
  readonly nodeCount: number;
  readonly maxDepth: number;
}

export interface NavTreesPage {
  readonly trees: readonly NavTreeSummary[];
  readonly nextCursor: string | null;
  readonly totalTrees: number;
}

export type NavSearchMode = "exact" | "prefix" | "substring";

export interface NavBranchSearchHit {
  readonly branchId: string;
  readonly treeId: string;
  readonly treeTitle: string | null;
  readonly title: string | null;
  readonly matchedOn: "title" | "id";
  readonly depth: number;
  /** 根→本节点 的完整路径（含本节点）——同名消歧的身份载荷。 */
  readonly path: readonly NavAncestor[];
  readonly originKind: NavOriginKind;
  readonly createdAt: IsoTimestamp;
}

export interface NavTreeSearchHit {
  readonly treeId: string;
  readonly forestId: string;
  readonly title: string | null;
  readonly matchedOn: "title" | "id";
  readonly createdAt: IsoTimestamp;
}

/** 树搜索页（确定性全序 + 偏移游标）。 */
export interface NavTreeSearchPage {
  readonly hits: readonly NavTreeSearchHit[];
  readonly nextCursor: string | null;
}

/** Branch 搜索页（确定性全序 + 偏移游标；命中与 searchBranches 同序）。 */
export interface NavBranchSearchPage {
  readonly hits: readonly NavBranchSearchHit[];
  readonly nextCursor: string | null;
}

export type NavEngineErrorCode =
  | "unknown-tree"
  | "unknown-branch"
  | "invalid-argument"
  | "invalid-cursor"
  | "stale-cursor"
  | "data-integrity";

/* ------------------------------------------------------------------ */
/* 游标（不透明；携带索引版本——跨版本=过期，显式报错不静默跳页）            */
/* ------------------------------------------------------------------ */

export interface CursorPayload {
  readonly v: number;
  readonly o: number;
}

/* ------------------------------------------------------------------ */
/* 每树读索引（派生缓存；invalidate 显式失效）                           */
/* ------------------------------------------------------------------ */

export interface NavIndexEntry {
  readonly branch: Branch;
  readonly depth: number;
  /** 子分支 id（listBranches 序 = 创建序）；构建期赋值一次，成品只读消费。 */
  childIds: string[];
  readonly parentPath: readonly string[];
  readonly title: string | null;
}

export interface TreeIndex {
  readonly treeId: string;
  readonly trunkBranchId: string;
  /** listBranches 的 (created_at, rowid) 序——与结构真值创建序一致。 */
  readonly order: readonly string[];
  readonly entries: ReadonlyMap<string, NavIndexEntry>;
  readonly treeTitle: string | null;
  readonly maxDepth: number;
  /** 索引版本（invalidate 重建时 +1；游标跨版本即过期）。 */
  readonly version: number;
}

/* ------------------------------------------------------------------ */
/* 引擎                                                                */
/* ------------------------------------------------------------------ */

export interface NavEngineOptions {
  readonly repository: TreeRepository;
  readonly materialRepository: MaterialRepository;
}
