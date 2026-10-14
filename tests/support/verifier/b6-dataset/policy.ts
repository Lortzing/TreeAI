/** policy owner; frozen probe bodies and order preserved. */





/* ------------------------------------------------------------------ */
/* 冻结常量（spec.json 的实现面）                                        */
/* ------------------------------------------------------------------ */

export const B6_SET_ID = "b6-scale";

export const B6_SEED = "d4-b6-2026-09-30";

export const B6_FOREST_ID = "b6-forest";


/** 材料：100 份 = 70 markdown + 30 pdf（spec.dataset.materials.composition）。 */
export const B6_MATERIAL_COUNT = 100;

export const B6_MARKDOWN_COUNT = 70;

export const B6_PDF_COUNT = 30;


/** 全部材料 canonicalText 的 UTF-16 码元总和（精确等于）。 */
export const B6_TOTAL_TEXT_UNITS = 1_000_000;


/** 长文：≥10 份 ≥5 万单元（实现 12 份：8 md × 52,000 + 4 pdf × 51,000）。 */
export const B6_LONG_MARKDOWN_COUNT = 8;

export const B6_LONG_MARKDOWN_UNITS = 52_000;

export const B6_LONG_PDF_COUNT = 4;

export const B6_LONG_PDF_UNITS = 51_000;


/** 保存事实：10,000 = 6,000 turn（3,000 组问答对）+ 2,500 annotation + 1,500 return。 */
export const B6_TURN_COUNT = 6_000;

export const B6_QA_PAIR_COUNT = 3_000;

export const B6_ANNOTATION_COUNT = 2_500;

export const B6_RETURN_COUNT = 1_500;


/** 树与分支：10 棵树 ×（1 trunk + 100 非根分支）= 1,000 非根 / 1,010 行。 */
export const B6_TREE_COUNT = 10;

export const B6_NON_TRUNK_BRANCHES_PER_TREE = 100;

export const B6_NON_TRUNK_BRANCH_COUNT = B6_TREE_COUNT * B6_NON_TRUNK_BRANCHES_PER_TREE;


/** 冻结查询集：50 条（spec performanceProbes search-p95：repetitions 50）。 */
export const B6_FROZEN_QUERY_COUNT = 50;


/** per-material 上限（charter §5；生成侧防御性复核）。 */
export const B6_PER_MATERIAL_MAX_UNITS = 1_000_000;

export const B6_PER_MATERIAL_MAX_PAGES = 200;

export const B6_PER_MATERIAL_MAX_BYTES = 20 * 1024 * 1024;


/** 装载确定性时钟纪元（与 b9 同款纪律：真实时间戳不进产品库）。 */
export const B6_EPOCH_MS = Date.parse("2026-09-30T00:00:00.000Z");


/** PDF 页面配方（语料 pdf；每页 28 行 × 30 单元正文 + 页首标题行）。 */
export const B6_PDF_LINES_PER_PAGE = 28;

export const B6_PDF_BODY_LINE_UNITS = 30;

export const B6_PDF_BODY_FONT_SIZE = 10.5;

export const B6_PDF_TITLE_FONT_SIZE = 15;

export const B6_PDF_LINE_STEP = 17;

export const B6_PDF_TOP_Y = 760;

export const B6_PDF_X = 72;


/** 导入样例配方（10 MiB / 100 页；见文件头「导入探针样例」段）。 */
export const B6_SAMPLE_FILENAME = "b6-import-sample.pdf";

export const B6_SAMPLE_PAGES = 100;

export const B6_SAMPLE_LINES_PER_PAGE = 2_000;

export const B6_SAMPLE_LINE_UNITS = 4;

export const B6_SAMPLE_MIN_BYTES = 10 * 1024 * 1024;
 // 10 MiB（含）
export const B6_SAMPLE_MAX_BYTES = 11 * 1024 * 1024;
