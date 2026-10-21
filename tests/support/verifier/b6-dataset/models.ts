/** models owner; frozen probe bodies and order preserved. */


import { B6_SET_ID } from './policy.ts';
 // 11 MiB（不含上限——留确定性余量）

/* ------------------------------------------------------------------ */
/* 类型（数据集计划的序列化形状）                                        */
/* ------------------------------------------------------------------ */

export type B6MaterialKind = "markdown" | "pdf";


/** markdown 材料：段落文本（源文件 = 段落以空行相接 + 单个尾随换行）。 */
export interface B6MarkdownMaterial {
  readonly kind: "markdown";
  readonly materialId: string;
  readonly versionId: string;
  readonly title: string;
  readonly filename: string;
  readonly treeId: string;
  /** 计划 canonicalText 单元数（精确）。 */
  readonly units: number;
  readonly needle: string;
  /** needle 在 canonicalText 内的 UTF-16 起始偏移（精确计算）。 */
  readonly needleIndex: number;
  /** 段落文本（canonical 段落，不含分隔空行）。 */
  readonly paragraphs: readonly string[];
}


/** PDF 材料：页/行计划（scripts/d4 PDF 设施按此构建字节）。 */
export interface B6PdfLinePlan {
  readonly text: string;
  readonly size: number;
}

export interface B6PdfMaterial {
  readonly kind: "pdf";
  readonly materialId: string;
  readonly versionId: string;
  readonly title: string;
  readonly filename: string;
  readonly treeId: string;
  readonly units: number;
  readonly needle: string;
  readonly needleIndex: number;
  /** 每页的行计划（行序 = 页内自上而下发射序 = 阅读序）。 */
  readonly pages: readonly (readonly B6PdfLinePlan[])[];
}


export type B6Material = B6MarkdownMaterial | B6PdfMaterial;


export interface B6Branch {
  readonly id: string;
  readonly parentId: string | null;
  readonly depth: number;
}


export interface B6Tree {
  readonly treeId: string;
  readonly trunkBranchId: string;
  readonly branches: readonly B6Branch[];
}


/** 问答对（user + assistant 两 Turn；同 branch 的对共享 episode/run）。 */
export interface B6QaPair {
  readonly pairIndex: number;
  readonly treeId: string;
  readonly branchId: string;
  readonly episodeId: string;
  readonly runId: string;
  readonly userTurnId: string;
  readonly assistantTurnId: string;
  readonly question: string;
  readonly answer: string;
}


export interface B6Annotation {
  readonly treeId: string;
  readonly branchId: string;
  readonly anchorTurnId: string;
  readonly selStart: number;
  readonly selEnd: number;
  readonly selText: string;
  readonly sourceHash: string;
  readonly term: string;
  readonly explanation: string;
}


export interface B6Return {
  readonly treeId: string;
  readonly branchId: string;
  readonly returnTurnId: string;
  readonly fromBranchId: string;
  readonly idempotencyKey: string;
  readonly text: string;
  readonly anchorTurnId: string;
  readonly anchorEntryId: string;
  readonly selStart: number;
  readonly selEnd: number;
  readonly selText: string;
}


export interface B6Totals {
  readonly materials: number;
  readonly markdownMaterials: number;
  readonly pdfMaterials: number;
  readonly totalTextUnits: number;
  readonly longMaterials: number;
  readonly trees: number;
  readonly branchRows: number;
  readonly nonTrunkBranches: number;
  readonly qaPairs: number;
  readonly turnFacts: number;
  readonly annotationFacts: number;
  readonly returnFacts: number;
  readonly savedFacts: number;
}


export interface B6Dataset {
  readonly version: 1;
  readonly setId: typeof B6_SET_ID;
  readonly seed: string;
  readonly forestId: string;
  readonly materials: readonly B6Material[];
  readonly trees: readonly B6Tree[];
  readonly qaPairs: readonly B6QaPair[];
  readonly annotations: readonly B6Annotation[];
  readonly returns: readonly B6Return[];
  readonly totals: B6Totals;
}


/** 冻结查询集条目（由 needles 派生；期望命中材料一并冻结）。 */
export interface B6FrozenQuery {
  readonly text: string;
  readonly expectedMaterialId: string;
  readonly expectedNeedleIndex: number;
}


export interface B6MaterialStats {
  readonly materialId: string;
  readonly kind: B6MaterialKind;
  readonly filename: string;
  readonly units: number;
  readonly pages: number;
  readonly blocks: number;
  readonly needleIndex: number;
  readonly canonicalSha256: string;
}


export interface B6Manifest {
  readonly version: 1;
  readonly setId: typeof B6_SET_ID;
  readonly seed: string;
  readonly truthSha256: string;
  readonly truthBytes: number;
  readonly materials: readonly B6MaterialStats[];
  readonly totals: B6Totals;
}


/* ------------------------------------------------------------------ */
/* 导入样例（import-10mib-100p 冻结配方）                                */
/* ------------------------------------------------------------------ */

export interface B6ImportSamplePlan {
  readonly filename: string;
  readonly pages: readonly (readonly B6PdfLinePlan[])[];
  readonly expectedUnits: number;
  readonly expectedPages: number;
}
