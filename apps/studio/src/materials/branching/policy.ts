/** policy ownership for branching.ts; compatibility entrypoint remains one level above. */

/* ------------------------------------------------------------------ */
/* 冻结常量（charter §3.3 / ADR-003 §4 / ADR-004 决策三）                */
/* ------------------------------------------------------------------ */

/**
 * 组合上下文的确定上限（UTF-16 单元；ADR-003 §4 冻结首版值 24,000）。
 * 选区摘录 + 有界邻近块 + 标题/版本标签的总预算；超限截断并在组合文本内
 * 显式标记（context.truncationNote 同时进 UI 预览与模型输入两处）。
 */
export const MATERIAL_CONTEXT_LIMIT_UNITS = 24_000;

/**
 * 单次建枝的选区上限（UTF-16 单元）：选区摘录必须**完整**进入组合上下文
 * （截断用户自己的选区是不诚实的锚定），因此选区自身超限即拒绝（400，
 * 零派发）——与术语解释的 MAX_EXPLAIN_SELECTION_CHARS 同一纪律。预留
 * MATERIAL_CONTEXT_RESERVE_UNITS 给标题/标签/截断标记，保证组合文本
 * 恒 ≤ MATERIAL_CONTEXT_LIMIT_UNITS。
 */
export const MATERIAL_MAX_SELECTION_UNITS = 20_000;

/** 组合上下文内材料标题的显示上限（标题可编辑、可很长——截断并标记）。 */
export const MATERIAL_CONTEXT_TITLE_UNITS = 80;

/** 标题/标签/截断标记的预算预留（组合文本恒 ≤ 上限的构造性保证）。 */
export const MATERIAL_CONTEXT_RESERVE_UNITS = 800;
