/**
 * MaterialImportService — D4-1「材料存储和导入」的导入编排 + 解析流水线
 * （issue #8 工作包 D4-1；D4 契约 §3 HTTP 语义 / §5 资源上限）。
 *
 * 职责（在已落地的 MaterialRepository + d4-md-v1/d4-pdf-v1 解析器之上）：
 *   - 导入：文件名扩展名 → 解析器种类（.md/.markdown → markdown；
 *     .pdf → pdf；其他 → 415 material-unsupported，如实说明，绝不伪成功）；
 *   - 上限（charter §5，在耗尽资源前明确拒绝）：
 *     · 单文件 20 MiB：读体/解析前拒绝（413 material-too-large）；
 *     · 规范文本 100 万 UTF-16 码元：解析后、落库前拒绝（版本 failed，
 *       原因码 text-units-exceeded——超限文本不落库、不外泄）；
 *     · 文本 PDF 200 页：pdf 解析器在解释任何内容流之前拒绝（原因码
 *       pages-exceeded，常量在 pdf-parser.ts 冻结、此处再导出共享）；
 *   - 版本语义（ADR-003 §3）：内容寻址 blob + UNIQUE(material_id,
 *     content_hash)——同材料同字节复用版本（200），新字节追加新版本（201），
 *     旧版本（及其锚点/摘录）永不受影响；导入端点按**树内**同字节去重
 *     （重导/双击返回既有 material+version，零新行）；
 *   - 异步解析流水线：导入即返回（版本 pending），任务 pending →
 *     parsing → ready | failed | canceled；解析器拒绝（invalid-utf8 等）
 *     → failed（原因码+说明入 parseError）；
 *   - 取消：pending/parsing 任务即刻呈 canceled；**迟到结果结构性丢弃**
 *     ——版本行的条件 UPDATE（parse_status IN ('pending','parsing')）保证
 *     已取消的版本不可能被迟到的解析结果复活或覆盖（数据库行仲裁竞争，
 *     任务面只做第一道短路）；迟到丢弃在任务面如实计数（不静默吞掉）；
 *   - 宿主中断恢复（与 TreeStudioService.recoverInterruptedRuns 同一
 *     纪律）：构造时把上次进程遗留的 pending/parsing 版本收敛为 failed
 *     （parse-interrupted），绝不留永远悬置的「幽灵解析中」；
 *   - 分块读取：canonicalText 按块分页（afterBlock 游标 + limit），
 *     仅 ready 版本可读（非 ready → 409 material-not-ready，不伪装空成功）。
 *
 * 诚实边界：默认注册表装配 markdown d4-md-v1 + pdf d4-pdf-v1（PDF 文字
 * 层解析器，apps/studio/src/materials/pdf-parser.ts——参考提取器
 * scripts/d4/pdf/extract.mjs 的应用侧移植，以 12 个冻结 fixture 真值为
 * 验收）。注入自定义 parsers 注册表时整体替换：缺位的种类在预检即被
 * 415 拒绝并说明 "not wired in this process"（绝无伪成功/伪就绪）。
 */

/** Stable public material import entrypoint. */
export {
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_TEXT_UNITS,
  TEXT_UNITS_EXCEEDED_REASON,
  PARSE_INTERRUPTED_REASON,
  DEFAULT_BLOCK_PAGE_LIMIT,
  MAX_BLOCK_PAGE_LIMIT,
} from "./import/policy.ts";
export type {
  MaterialImportLimits,
  MaterialParserOutcome,
  MaterialParser,
  MaterialParseContext,
  MaterialParseExecution,
  MaterialParseExecutor,
  MaterialImportResult,
  MaterialVersionPage,
  MaterialParseTaskView,
  MaterialListItem,
  MaterialDetailView,
  ImportMaterialInput,
  MaterialImportServiceOptions,
} from "./import/model.ts";
export {
  D4_MD_V1_PARSER,
  D4_PDF_V1_PARSER,
} from "./import/parsers.ts";
export {
  MaterialUnsupportedError,
  MaterialTooLargeError,
  MaterialNotReadyError,
  ParseTaskNotCancelableError,
} from "./import/errors.ts";
export {
  detectMaterialParserKind,
} from "./import/validation.ts";
export {
  MaterialImportService,
} from "./import/service.ts";
export { PAGES_EXCEEDED_REASON } from "./pdf-parser.ts";
export { DEFAULT_MAX_PAGES } from "./pdf-parser.ts";
