/** model ownership for b9-dataset.ts; compatibility entrypoint remains one level above. */

/* ------------------------------------------------------------------ */
/* 类型（结构真值的序列化形状）                                          */
/* ------------------------------------------------------------------ */

export type B9OriginKind = "none" | "turn" | "material";

export interface B9OriginRefTurn {
  readonly kind: "turn";
  readonly sourceBranchId: string;
  readonly anchorTurnId: string;
  readonly anchorEntryId: string;
  readonly selStart: number;
  readonly selEnd: number;
  readonly selText: string;
}

export interface B9OriginRefMaterial {
  readonly kind: "material";
  readonly materialId: string;
  readonly versionId: string;
  readonly blockId: string;
  readonly start: number;
  readonly end: number;
  readonly excerpt: string;
}

export type B9OriginRef = B9OriginRefTurn | B9OriginRefMaterial;

export interface B9Node {
  readonly id: string;
  readonly parentId: string | null;
  /** 分支标题 = 该分支首个 user Turn 的文本（产品事实）；null = 无首问（b9-empty trunk）。 */
  readonly title: string | null;
  readonly depth: number;
  readonly originKind: B9OriginKind;
  /** 来源引用全字段；originKind === "none" 时为 null。 */
  readonly origin: B9OriginRef | null;
  /** 完整父路径：trunk→…→父 的祖先 id 链（不含本节点）；trunk 为空数组。 */
  readonly parentPath: readonly string[];
  /**
   * Turn 来源锚点所需的回答文本（该节点作为 source 时 assistant Turn 的
   * 全文）。仅 Turn 来源的 source 节点非 null；属结构真值的装载载荷。
   */
  readonly answerText: string | null;
}

export interface B9Tree {
  readonly treeId: string;
  readonly kind: "special" | "normal";
  /** 特殊树的规格规则描述（普通树为 null）。 */
  readonly rule: string | null;
  readonly title: string | null;
  readonly trunkBranchId: string;
  readonly nodes: readonly B9Node[];
}

export interface B9Material {
  readonly materialId: string;
  readonly versionId: string;
  readonly title: string;
  readonly filename: string;
  /** markdown 原文（UTF-8 装载字节由此派生；真实 d4-md-v1 解析）。 */
  readonly markdown: string;
}

export interface B9Totals {
  readonly trees: number;
  readonly specialTrees: number;
  readonly normalTrees: number;
  readonly branchRows: number;
  readonly nonTrunkBranches: number;
  readonly maxDepth: number;
  readonly turnOrigins: number;
  readonly materialOrigins: number;
  readonly titledNodes: number;
}

export interface B9Dataset {
  readonly version: 1;
  readonly setId: "b9-nav";
  readonly seed: string;
  readonly forestId: string;
  readonly materials: readonly B9Material[];
  readonly trees: readonly B9Tree[];
  readonly totals: B9Totals;
}

export interface B9TreeStats {
  readonly treeId: string;
  readonly kind: "special" | "normal";
  readonly rule: string | null;
  readonly nodes: number;
  readonly nonTrunkBranches: number;
  readonly maxDepth: number;
  readonly turnOrigins: number;
  readonly materialOrigins: number;
}

export interface B9Manifest {
  readonly version: 1;
  readonly setId: "b9-nav";
  readonly seed: string;
  readonly structureTruthSha256: string;
  readonly structureTruthBytes: number;
  readonly trees: readonly B9TreeStats[];
  readonly totals: B9Totals;
}

/* ------------------------------------------------------------------ */
/* 材料（最小 md fixture；真实 d4-md-v1 解析取得 canonicalText/块图）     */
/* ------------------------------------------------------------------ */

export interface MaterialSpec {
  readonly materialId: string;
  readonly title: string;
  readonly filename: string;
  readonly markdown: string;
}

export interface ParsedMaterial {
  readonly spec: MaterialSpec;
  readonly canonicalText: string;
  readonly blocks: ReadonlyArray<{ blockId: string; start: number; end: number }>;
}

/* ------------------------------------------------------------------ */
/* 生成过程中的可变工作形状（终结时冻结为 B9Node/B9Tree）                 */
/* ------------------------------------------------------------------ */

export interface WorkingNode {
  id: string;
  parentId: string | null;
  title: string | null;
  depth: number;
  parentPath: string[];
  answerText: string | null;
  originKind: B9OriginKind;
  origin: B9OriginRef | null;
}

export interface WorkingTree {
  treeId: string;
  kind: "special" | "normal";
  rule: string | null;
  nodes: WorkingNode[];
}
