/**
 * D4 材料层共享形状（issue #8 工作包 D4-1，2026-09-30）。
 *
 * 定位：D4 把「从原回答选区建枝」的来源能力延伸到用户导入的材料
 * （markdown / 文本 PDF）。材料没有 assistant Turn，也没有 Pi entry——
 * 材料来源**不得伪造** anchorTurnId/piEntryId（charter §3.2），因此
 * 材料来源是与 Turn 来源（product.ts BranchOrigin）平行的独立形状，
 * 由 `branches.origin_kind` 判别（ADR-003 §2 决策二）。存储实现归
 * persistence（migration 0008）；本文件只定义共享形状，与 product.ts
 * 的分工一致。按 docs/d2/contracts-README.md 以**纯新增**方式入包，
 * 不修改任何既有冻结文件的内容与语义（ADR-003 §1 治理边界）。
 *
 * 关键不变量（ADR-003 §2/§3）：
 * - 材料**身份**是 materialId；标题只是可编辑显示名，文件名不是身份；
 * - material_blobs 内容寻址：contentHash = 原件字节 SHA-256，同字节全局
 *   一份；不同内容同名文件 hash 不同，不会错误去重；
 * - 版本不可变：UNIQUE(materialId, contentHash)——同材料重复导入相同
 *   字节复用版本；内容变化产生**新版本**，不覆盖旧摘录、批注与来源
 *   锚点；旧版本锚点（versionId + sourceHash）永久可读；
 * - MaterialSelection 锚定纪律（与 Turn 来源同一纪律，按材料改写）：
 *   excerpt === canonicalText.slice(start, end)，区间在版本 canonicalText
 *   边界内，blockId 存在于版本 block map 且区间含于该块，
 *   sourceHash === 版本 canonicalText 的 SHA-256；
 * - 仅 parseStatus = "ready" 的版本可精确建枝；rejected/unsupported/
 *   failed 材料拒绝建枝并说明原因，不把不支持伪装成成功空文档。
 */
import type { Brand } from "./branding.js";
import type { BranchId, IsoTimestamp, TreeId } from "./identifiers.js";

/** 材料标识（身份；标题/文件名不是身份）。 */
export type MaterialId = Brand<string, "MaterialId">;

/** 材料版本标识（不可变；同材料同原件字节至多一个版本）。 */
export type MaterialVersionId = Brand<string, "MaterialVersionId">;

/**
 * 材料解析状态。
 * - pending/parsing：导入后解析流水线的中间态；
 * - ready：canonicalText 与 block map 可用，可精确建枝；
 * - failed：解析失败；canceled：用户取消（迟到结果不挂靠）；
 * - unsupported/rejected：导入判定时即终态（加密/损坏/无文字层/超限），
 *   不产生「已就绪」材料。
 */
export type MaterialParseStatus =
  | "pending"
  | "parsing"
  | "ready"
  | "failed"
  | "canceled"
  | "unsupported"
  | "rejected";

/** 解析器种类（parserVersion 如 "d4-md-v1" / "d4-pdf-v1"）。 */
export type MaterialParserKind = "markdown" | "pdf";

export interface MaterialTextLineGeometry {
  readonly start: number;
  readonly end: number;
  readonly x: number;
  readonly y: number;
  readonly fontSize: number | null;
}

export interface MaterialPageGeometry {
  readonly pageWidth: number;
  readonly pageHeight: number;
  readonly lines: readonly MaterialTextLineGeometry[];
}

/**
 * canonicalText 的有序块（对 canonicalText 的连续覆盖：首块 start=0、
 * 末块 end=canonicalText.length、blocks[i].end === blocks[i+1].start）。
 */
export interface MaterialBlock {
  /** 块标识："blk-N"（markdown）/ "page-N"（pdf）。 */
  readonly blockId: string;
  readonly kind: "markdown-block" | "pdf-page";
  /** canonicalText 内 UTF-16 半开区间。 */
  readonly start: number;
  readonly end: number;
  /** pdf-page 专有，1-based 页码。 */
  readonly page?: number;
  /** pdf-page 专有；canonical UTF-16 offsets remain the source of truth. */
  readonly geometry?: MaterialPageGeometry;
}

/** 材料：身份与标题（D4-contracts §1）。 */
export interface Material {
  readonly id: MaterialId;
  /** 可编辑显示名；不是身份。 */
  readonly title: string;
  readonly createdAt: IsoTimestamp;
}

/**
 * 材料版本：一次导入的不可变快照（canonicalText 与 block map 不在本
 * 接口——按块分页读取，见 D4-contracts §3 读取 API）。
 */
export interface MaterialVersion {
  readonly id: MaterialVersionId;
  readonly materialId: MaterialId;
  /** 原件字节 SHA-256（内容寻址；同材料同字节复用版本）。 */
  readonly contentHash: string;
  readonly parserKind: MaterialParserKind;
  readonly parserVersion: string;
  readonly importedAt: IsoTimestamp;
  readonly sizeBytes: number;
  readonly parseStatus: MaterialParseStatus;
  /** failed/unsupported/rejected 的原因码+说明；其他状态为 null。 */
  readonly parseError: string | null;
  /** canonicalText 的 UTF-16 长度。 */
  readonly textUnits: number;
}

/**
 * 材料选区：材料建枝的锚定载荷（ADR-003 §2 最小集，字段与
 * material_branch_origins 行对齐）。
 *
 * 不变量（仓储层写入校验 + schema CHECK 互为防御）：
 * - start/end 是 versionId 版本 canonicalText 内的 UTF-16 半开区间，
 *   满足 0 <= start < end <= textUnits；
 * - excerpt === canonicalText.slice(start, end)（切片一致）；
 * - blockId 存在于版本 block map，且 [start, end) 含于该块区间；
 * - sourceHash === 版本 canonicalText 的 SHA-256（与术语 sourceHash
 *   同纪律：锚点绑定 versionId + sourceHash，版本不可变 ⇒ 永久可读）。
 */
export interface MaterialSelection {
  readonly materialId: MaterialId;
  readonly versionId: MaterialVersionId;
  /** 解析器产生的块/页标识（MaterialBlock.blockId）。 */
  readonly blockId: string;
  /** 版本 canonicalText 内 UTF-16 半开区间（含）。 */
  readonly start: number;
  /** 版本 canonicalText 内 UTF-16 半开区间（不含）。 */
  readonly end: number;
  /** 选区原文（与 canonicalText.slice(start, end) 一致）。 */
  readonly excerpt: string;
  /** 版本 canonicalText 的 SHA-256（锚点身份；与 origin 级 sourceHash 同值）。 */
  readonly sourceHash: string;
}

/**
 * 材料来源：从材料版本选区创建的非根分支的出处（与 product.ts
 * BranchOrigin 平行；每分支至多一条，material_branch_origins 以
 * branchId 为主键结构性保证）。材料来源**永不**携带 anchorTurnId /
 * piEntryId（charter §3.2）。
 */
export interface MaterialBranchOrigin {
  readonly branchId: BranchId;
  readonly treeId: TreeId;
  readonly selection: MaterialSelection;
  /** 版本 canonicalText 的 SHA-256（ADR-003 §2；=== selection.sourceHash）。 */
  readonly sourceHash: string;
  readonly createdAt: IsoTimestamp;
}

/** 阅读位置：Tree × 材料的持久化阅读进度（charter §3.2 阅读与探索各自保留位置）。 */
export interface MaterialReadingPosition {
  readonly treeId: TreeId;
  readonly materialId: MaterialId;
  readonly versionId: MaterialVersionId;
  /** 最后阅读块；null = 未开始。 */
  readonly blockId: string | null;
  /** 可选：块内关注区间。 */
  readonly focusStart: number | null;
  readonly updatedAt: IsoTimestamp;
}
