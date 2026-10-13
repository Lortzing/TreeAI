/** policy ownership for pdf-parser.ts; compatibility entrypoint remains one level above. */

export const PDF_PARSER_KIND = "pdf" as const;


export const PDF_PARSER_VERSION = "d4-pdf-v1" as const;

/** 文本 PDF 页数上限（charter §5：200 页；页树装载后、内容解释前拒绝）。 */
export const DEFAULT_MAX_PAGES = 200;

/** 超限原因码：文本 PDF 超 200 页（与导入服务共享的稳定前缀）。 */
export const PAGES_EXCEEDED_REASON = "pages-exceeded";
