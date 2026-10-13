/** parsers ownership for import-service.ts; compatibility entrypoint remains one level above. */
import {
  MARKDOWN_PARSER_VERSION,
  parseMarkdownMaterial,
} from "../markdown-parser.ts";
import {
  parsePdfMaterial,
  PDF_PARSER_VERSION,
} from "../pdf-parser.ts";
import type {
  MaterialParseContext,
  MaterialParser,
  MaterialParserOutcome,
} from "./model.ts";
import type {
  MaterialParserKind,
} from "@treeai/contracts";

/** d4-md-v1 解析器装配（同步纯函数 → MaterialParser 缝）。 */
export const D4_MD_V1_PARSER: MaterialParser = {
  kind: "markdown",
  parserVersion: MARKDOWN_PARSER_VERSION,
  parse(bytes: Uint8Array): Promise<MaterialParserOutcome> {
    const result = parseMarkdownMaterial(bytes);
    if (result.ok) {
      return Promise.resolve({
        ok: true,
        canonicalText: result.canonicalText,
        // 块文本是 canonicalText 的切片（派生量）：存块图不带 text，读取时切。
        blocks: result.blocks.map((block) => ({
          blockId: block.blockId,
          kind: block.kind,
          start: block.start,
          end: block.end,
        })),
      });
    }
    return Promise.resolve({ ok: false, reason: result.reason, message: result.message });
  },
};

/** d4-pdf-v1 解析器装配（同步纯函数 → MaterialParser 缝；页块带 1-based page）。 */
export const D4_PDF_V1_PARSER: MaterialParser = {
  kind: "pdf",
  parserVersion: PDF_PARSER_VERSION,
  parse(bytes: Uint8Array, context?: MaterialParseContext): Promise<MaterialParserOutcome> {
    const result = parsePdfMaterial(bytes, { maxPages: context?.maxPages });
    if (result.ok) {
      return Promise.resolve({
        ok: true,
        canonicalText: result.canonicalText,
        // pdf-page 块的 page 字段随块图入库（D4-2 阅读器按页渲染所需）。
        blocks: result.blocks.map((block) => ({
          blockId: block.blockId,
          kind: block.kind,
          start: block.start,
          end: block.end,
          page: block.page,
          ...(block.geometry === null ? {} : { geometry: block.geometry }),
        })),
      });
    }
    return Promise.resolve({ ok: false, reason: result.reason, message: result.message });
  },
};

/**
 * 默认解析器注册表（按 MaterialParserKind）：markdown = d4-md-v1，
 * pdf = d4-pdf-v1（PDF 文字层解析器随本工作包装配）。注入自定义
 * `parsers` 时**整体替换**注册表——缺哪个种类，该扩展名导入即被
 * 415 诚实拒绝（`the 'X' parser is not wired in this process`），
 * 绝无伪成功/伪就绪。
 */
export const DEFAULT_PARSERS: Readonly<Partial<Record<MaterialParserKind, MaterialParser>>> = {
  markdown: D4_MD_V1_PARSER,
  pdf: D4_PDF_V1_PARSER,
};
