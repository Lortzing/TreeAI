/** model ownership for pdf-parser.ts; compatibility entrypoint remains one level above. */
import type {
  PAGES_EXCEEDED_REASON,
} from "./policy.ts";
import type {
  MaterialPageGeometry,
} from "@treeai/contracts";

/** d4-pdf-v1 的稳定拒绝原因码（parseError 的原因码部分）。 */
export type PdfRejectionReason = "encrypted" | "corrupt" | "no-text-layer" | "unsupported" | typeof PAGES_EXCEEDED_REASON;

/** 规范化后的 PDF 页块（B1 真值 blocks 数组项 = MaterialBlock + text）。 */
export interface PdfBlock {
  readonly blockId: string;
  readonly kind: "pdf-page";
  readonly start: number;
  readonly end: number;
  /** 1-based 真实页码（空页跳过不占号）。 */
  readonly page: number;
  readonly geometry: MaterialPageGeometry | null;
  readonly text: string;
}

export interface PdfParseSuccess {
  readonly ok: true;
  readonly parserKind: "pdf";
  readonly parserVersion: "d4-pdf-v1";
  readonly canonicalText: string;
  readonly blocks: readonly PdfBlock[];
  readonly textUnits: number;
  /** 文档页数（含无文字被跳过的空页）。 */
  readonly pages: number;
}

export interface PdfParseRejection {
  readonly ok: false;
  readonly parserKind: "pdf";
  readonly parserVersion: "d4-pdf-v1";
  readonly reason: PdfRejectionReason;
  readonly message: string;
}

export type PdfParseResult = PdfParseSuccess | PdfParseRejection;

export interface PdfParseOptions {
  /** 页数上限（缺省 DEFAULT_MAX_PAGES = 200，charter §5）。 */
  readonly maxPages?: number;
}

/** 一条视觉文字行（Tj 时刻的文本矩阵平移点 + 顺序号）。 */
export interface PageTextLine {
  readonly x: number;
  readonly y: number;
  readonly order: number;
  readonly text: string;
  readonly fontSize: number | null;
}
