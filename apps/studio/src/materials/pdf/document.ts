/** document ownership for pdf-parser.ts; compatibility entrypoint remains one level above. */
import {
  interpretContent,
} from "./content.ts";
import {
  streamBytes,
} from "./decoding.ts";
import {
  PdfCorruptError,
  PdfEncryptedError,
  PdfUnsupportedError,
} from "./errors.ts";
import {
  type FontSpec,
  materializeFontSpec,
} from "./fonts.ts";
import {
  orderPageLines,
} from "./layout.ts";
import type {
  PdfBlock,
  PdfParseOptions,
  PdfParseRejection,
  PdfParseResult,
  PdfRejectionReason,
} from "./model.ts";
import {
  MAX_NESTING_DEPTH,
  PdfObjectParser,
} from "./objects.ts";
import {
  DEFAULT_MAX_PAGES,
  PAGES_EXCEEDED_REASON,
  PDF_PARSER_KIND,
  PDF_PARSER_VERSION,
} from "./policy.ts";
import {
  type ContentToken,
  retokenizeWithArrays,
} from "./tokenizer.ts";
import {
  describePdfValue,
  PdfName,
  pdfNameOf,
  type PdfValue,
} from "./values.ts";
import type {
  MaterialPageGeometry,
} from "@treeai/contracts";

/* ------------------------------------------------------------------ */
/* 文档级提取                                                          */
/* ------------------------------------------------------------------ */

export interface PageNode {
  readonly dict: Map<string, PdfValue>;
  readonly inheritedResources: Map<string, PdfValue> | undefined;
}

/** 递归展开页树（支持中间 /Pages 节点与 /Resources 继承）。 */
export function collectPageNodes(
  parser: PdfObjectParser,
  nodeValue: PdfValue,
  inheritedResources: Map<string, PdfValue> | undefined,
  out: PageNode[],
  depth: number,
): void {
  if (depth > MAX_NESTING_DEPTH) throw new PdfCorruptError("page tree nested too deep (loop?)");
  const node = parser.resolve(nodeValue);
  if (!(node instanceof Map)) throw new PdfCorruptError("page tree node is not a dictionary");
  const type = node.get("Type");
  const typeName = type instanceof PdfName ? type.value : undefined;
  if (typeName === "Page") {
    out.push({ dict: node, inheritedResources });
    return;
  }
  if (typeName !== "Pages") {
    throw new PdfCorruptError(`page tree node has unexpected /Type ${describePdfValue(type)}`);
  }
  const kidsRaw = node.get("Kids");
  if (kidsRaw === undefined) throw new PdfCorruptError("page tree node has no /Kids");
  const kids = parser.resolve(kidsRaw);
  if (!Array.isArray(kids)) throw new PdfCorruptError("page tree node has no /Kids array");
  const ownResourcesRaw = node.get("Resources");
  let resources = inheritedResources;
  if (ownResourcesRaw !== undefined && ownResourcesRaw !== null) {
    const resolved = parser.resolve(ownResourcesRaw);
    if (!(resolved instanceof Map)) throw new PdfCorruptError("page tree /Resources is not a dictionary");
    resources = resolved;
  }
  for (const kid of kids) {
    collectPageNodes(parser, kid, resources, out, depth + 1);
  }
}

export function pageBoxGeometry(
  parser: PdfObjectParser,
  page: PageNode,
): { readonly pageWidth: number; readonly pageHeight: number } | null {
  const raw = page.dict.get("MediaBox");
  if (raw === undefined) return null;
  const box = parser.resolve(raw);
  if (!Array.isArray(box) || box.length !== 4 || !box.every((value) => typeof value === "number")) return null;
  const [x0, y0, x1, y1] = box as [number, number, number, number];
  const pageWidth = Math.abs(x1 - x0);
  const pageHeight = Math.abs(y1 - y0);
  if (!(pageWidth > 0) || !(pageHeight > 0)) return null;
  return { pageWidth, pageHeight };
}

export function extractPdfDocument(bytes: Uint8Array, maxPages: number): PdfParseResult {
  const parser = new PdfObjectParser(bytes);
  if (parser.trailer.get("Encrypt") !== undefined) {
    throw new PdfEncryptedError(
      "trailer carries /Encrypt — encrypted PDFs are rejected by text-layer import (no decryption is attempted)",
    );
  }
  const root = parser.resolve(parser.trailer.get("Root")!);
  if (!(root instanceof Map) || pdfNameOf(root.get("Type")) !== "Catalog") {
    throw new PdfCorruptError("bad document catalog");
  }
  const pagesRootRaw = root.get("Pages");
  if (pagesRootRaw === undefined) throw new PdfCorruptError("catalog has no /Pages");
  const pagesRoot = parser.resolve(pagesRootRaw);
  if (!(pagesRoot instanceof Map) || pdfNameOf(pagesRoot.get("Type")) !== "Pages") {
    throw new PdfCorruptError("bad page tree root");
  }
  const pageNodes: PageNode[] = [];
  collectPageNodes(parser, pagesRoot, undefined, pageNodes, 0);
  const countRaw = pagesRoot.get("Count");
  if (countRaw === undefined) throw new PdfCorruptError("page tree root has no /Count");
  const count = parser.resolve(countRaw);
  if (typeof count !== "number") throw new PdfCorruptError("page tree root has no numeric /Count");
  if (pageNodes.length !== count) {
    throw new PdfCorruptError(`page /Count (${String(count)}) != leaf pages (${String(pageNodes.length)})`);
  }
  if (pageNodes.length === 0) throw new PdfCorruptError("page tree has no pages");

  // charter §5：页数上限在解释任何内容流之前拒绝（不耗资源抽取超限文本）。
  if (pageNodes.length > maxPages) {
    return {
      ok: false,
      parserKind: PDF_PARSER_KIND,
      parserVersion: PDF_PARSER_VERSION,
      reason: PAGES_EXCEEDED_REASON,
      message:
        `the document has ${String(pageNodes.length)} pages, exceeding the ${String(maxPages)}-page text-PDF limit ` +
        "(rejected before extracting text; charter D4 §5)",
    };
  }

  let totalLines = 0;
  const pages: {
    readonly text: string;
    readonly lineCount: number;
    readonly geometry: MaterialPageGeometry | null;
  }[] = [];
  for (const page of pageNodes) {
    // /Resources：页自有优先，缺省继承最近祖先（中间 /Pages 节点）。
    const ownResourcesRaw = page.dict.get("Resources");
    let resources = page.inheritedResources;
    if (ownResourcesRaw !== undefined && ownResourcesRaw !== null) {
      const resolved = parser.resolve(ownResourcesRaw);
      if (!(resolved instanceof Map)) throw new PdfCorruptError("page /Resources is not a dictionary");
      resources = resolved;
    }
    const fontDictRaw = resources?.get("Font");
    /* 字体惰性物化：资源表只登记 名字 → 原始值；只有真正用于显示文字
       的字体才经 materializeFontSpec 解析校验（同页重复使用命中闭包内
       缓存）——未用于显示的坏字体不拖垮整页。 */
    const fonts = new Map<string, () => FontSpec>();
    if (fontDictRaw !== undefined && fontDictRaw !== null) {
      const fontDict = parser.resolve(fontDictRaw);
      if (!(fontDict instanceof Map)) throw new PdfCorruptError("page resources /Font is not a dictionary");
      for (const [name, raw] of fontDict) {
        let cached: FontSpec | null = null;
        fonts.set(
          name,
          () => (cached ??= materializeFontSpec(parser, raw)),
        );
      }
    }
    const contentsRaw = page.dict.get("Contents");
    const tokens: ContentToken[] = [];
    if (contentsRaw !== undefined) {
      const contents = parser.resolve(contentsRaw);
      const streams: PdfValue[] = Array.isArray(contents) ? contents : [contents];
      for (const s of streams) {
        for (const tok of retokenizeWithArrays(streamBytes(parser.resolve(s)))) tokens.push(tok);
      }
    }
    const lines = interpretContent(tokens, fonts);
    totalLines += lines.length;
    const ordered = orderPageLines(lines);
    const pageBox = pageBoxGeometry(parser, page);
    let lineStart = 0;
    const geometry =
      pageBox === null
        ? null
        : {
            ...pageBox,
            lines: ordered.map((line) => {
              const lineEnd = lineStart + line.text.length;
              const value = {
                start: lineStart,
                end: lineEnd,
                x: line.x,
                y: line.y,
                fontSize: line.fontSize,
              };
              lineStart = lineEnd + 1;
              return value;
            }),
          } satisfies MaterialPageGeometry;
    pages.push({ text: ordered.map((l) => l.text).join("\n"), lineCount: ordered.length, geometry });
  }

  if (totalLines === 0) {
    return {
      ok: false,
      parserKind: PDF_PARSER_KIND,
      parserVersion: PDF_PARSER_VERSION,
      reason: "no-text-layer",
      message:
        "the document has no extractable text layer (zero text-showing operations across all pages; " +
        "scanned/image-only or empty-content PDFs are not OCR targets in this version)",
    };
  }

  // 组块：非末页（含仅空行的页）以 "\n" 收尾；末页无强制终止符；零文字
  // 操作的页（或拼得 0 单元的末页）不产生块——blockId 仍用真实 1-based 页码。
  let canonicalText = "";
  const blocks: PdfBlock[] = [];
  for (let i = 0; i < pages.length; i += 1) {
    const isFinalPage = i === pages.length - 1;
    const pageText = isFinalPage ? pages[i]!.text : `${pages[i]!.text}\n`;
    if (pages[i]!.lineCount === 0 || pageText.length === 0) continue;
    blocks.push({
      blockId: `page-${String(i + 1)}`,
      kind: "pdf-page",
      start: canonicalText.length,
      end: canonicalText.length + pageText.length,
      page: i + 1,
      geometry: pages[i]!.geometry,
      text: pageText,
    });
    canonicalText += pageText;
  }
  if (canonicalText.length === 0) {
    return {
      ok: false,
      parserKind: PDF_PARSER_KIND,
      parserVersion: PDF_PARSER_VERSION,
      reason: "no-text-layer",
      message:
        "the document has no extractable text layer (text-showing operations carry no text; " +
        "the canonical text would be empty)",
    };
  }
  return {
    ok: true,
    parserKind: PDF_PARSER_KIND,
    parserVersion: PDF_PARSER_VERSION,
    canonicalText,
    blocks,
    textUnits: canonicalText.length,
    pages: pages.length,
  };
}

/* ------------------------------------------------------------------ */
/* 入口                                                               */
/* ------------------------------------------------------------------ */

export function rejection(reason: PdfRejectionReason, message: string): PdfParseRejection {
  return { ok: false, parserKind: PDF_PARSER_KIND, parserVersion: PDF_PARSER_VERSION, reason, message };
}

/** d4-pdf-v1 解析：PDF 原始字节 → 规范文本 + 每页块图；非法/超范围稳定拒绝。 */
export function parsePdfMaterial(bytes: Uint8Array, options: PdfParseOptions = {}): PdfParseResult {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new RangeError(`maxPages must be a positive integer (got ${String(maxPages)})`);
  }
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("parsePdfMaterial expects a Uint8Array");
  }
  try {
    return extractPdfDocument(bytes, maxPages);
  } catch (error) {
    if (error instanceof PdfEncryptedError) return rejection("encrypted", error.message);
    if (error instanceof PdfUnsupportedError) return rejection("unsupported", error.message);
    if (error instanceof PdfCorruptError) return rejection("corrupt", error.message);
    if (error instanceof RangeError) {
      return rejection("corrupt", `malformed nesting exceeds the interpreter stack (${error.message})`);
    }
    throw error; // 意外错误如实上抛（服务层记 parse-internal），绝不伪成功
  }
}
