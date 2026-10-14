/** policy ownership for import-service.ts; compatibility entrypoint remains one level above. */
import type {
  MaterialParserKind,
} from "@treeai/contracts";

/* ------------------------------------------------------------------ */
/* 冻结常量：上限与稳定原因码（charter §5 / D4 契约 §3）                */
/* ------------------------------------------------------------------ */

/** 单文件上限：20 MiB（charter §5；测试可经构造选项覆盖，缺省即冻结值）。 */
export const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024;

/** 单材料解析规范文本上限：100 万 UTF-16 码元（charter §5）。 */
export const DEFAULT_MAX_TEXT_UNITS = 1_000_000;

/** 超限原因码：规范文本超 100 万 UTF-16 码元（版本 failed 的原因码部分）。 */
export const TEXT_UNITS_EXCEEDED_REASON = "text-units-exceeded";

/** 宿主中断恢复的原因码（构造时收敛遗留 pending/parsing 版本）。 */
export const PARSE_INTERRUPTED_REASON = "parse-interrupted";

/* ------------------------------------------------------------------ */
/* 种类判定（文件名扩展名 → MaterialParserKind）                        */
/* ------------------------------------------------------------------ */

export const EXTENSION_KINDS: Readonly<Record<string, MaterialParserKind>> = {
  md: "markdown",
  markdown: "markdown",
  pdf: "pdf",
};

/** 分块读取的默认/最大页大小（块数；与 journal 投影同一量级约定）。 */
export const DEFAULT_BLOCK_PAGE_LIMIT = 50;


export const MAX_BLOCK_PAGE_LIMIT = 500;
