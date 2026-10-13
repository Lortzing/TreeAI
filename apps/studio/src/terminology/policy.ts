/** Terminology policy ownership; public compatibility exports remain in ../terminology.ts. */
import type {
  ReadingModeDensityLimits,
  TerminologyReadingMode,
} from "./model.ts";
import type {
  TerminologyUsageDelta,
} from "@treeai/contracts";

/* ------------------------------------------------------------------ */
/* 上下文纪律与预算口径（issue #7 P1 整改，2026-09-30 验收）             */
/* ------------------------------------------------------------------ */

/**
 * explain 提示词内嵌原文的上限（字符）：全文不无限塞入。超限时取选区
 * 两侧窗口（EXPLAIN_CONTEXT_CONTEXT_CHARS），截断在提示词内如实标注；
 * 选区本身超过 MAX_EXPLAIN_SELECTION_CHARS 的新任务零派发拒绝。
 * （《术语完整方案 v2》的「上下文纪律」条目在库内未定位到文本；本组
 * 常数按验收要求「全量 source 不能无限塞入」定界，修改须同步 bump
 * EXPLAIN_PROMPT_VERSION。）
 */
export const EXPLAIN_SOURCE_LIMIT_CHARS = 24_000;


/** explain 窗口模式：选区每侧保留的上下文字符数。 */
export const EXPLAIN_CONTEXT_CONTEXT_CHARS = 2_000;


/** 单次解释的选区上限（超过 → 零派发，selection-too-large）。 */
export const MAX_EXPLAIN_SELECTION_CHARS = 8_000;


/**
 * extract 提示词内嵌原文的上限：extract 的候选偏移必须锚定全文，
 * 截断会破坏偏移纪律——超限零派发拒绝（source-too-large），不做窗口。
 */
export const EXTRACT_SOURCE_LIMIT_CHARS = 7_000;

/** Output upper bound reserved for v2 requests (800 tokens × chars/4 estimate). */
export const TERMINOLOGY_V2_INPUT_TOKEN_LIMIT = 2_000;


export const TERMINOLOGY_V2_OUTPUT_TOKEN_LIMIT = 800;


export const TERMINOLOGY_V2_MAX_CANDIDATES = 6;


export const TERMINOLOGY_LIMITS_VERSION = 2;

/** 输出上限的保守估算（字符）：派发前预算预留的 completion 上界。 */
export const MAX_EXPLAIN_COMPLETION_CHARS = TERMINOLOGY_V2_OUTPUT_TOKEN_LIMIT * 4;


export const MAX_EXTRACT_COMPLETION_CHARS = TERMINOLOGY_V2_OUTPUT_TOKEN_LIMIT * 4;

/** explain 提示词版本（buildExplainPrompt 变化时 bump——缓存键成分）。 */
export const EXPLAIN_PROMPT_VERSION = 2;


/** extract 提示词版本（buildExtractPrompt 变化时 bump）。 */
export const EXTRACT_PROMPT_VERSION = 2;


/** 缓存键格式版本（键成分/窗口策略变化时 bump——旧缓存全部失效）。 */
export const TERMINOLOGY_CACHE_FORMAT_VERSION = 2;


/** 上下文指纹窗口：选区每侧纳入 contextHash 的字符数。 */
export const CONTEXT_HASH_CHARS = 256;

export const TERMINOLOGY_READING_MODES: readonly TerminologyReadingMode[] = [
  "manual-only",
  "minimal-hints",
  "assisted-reading",
];

export function isTerminologyReadingMode(value: unknown): value is TerminologyReadingMode {
  return (
    value === "manual-only" || value === "minimal-hints" || value === "assisted-reading"
  );
}

/**
 * 自动标注质量门禁（默认 **false**；issue #7 验收 2026-09-30「质量门禁
 * 未过保持自动展示/自动请求关闭」「自动标注不得开启」）。false 时：阅读
 * 模式可保存、可切换，但**零自动派发**（assistant 回答完成不触发 extract，
 * 预算/记账零变动），readModel 如实暴露 `autoSuggestions.enabled=false` +
 * 未生效原因（quality-gate-pending）。true 仅测试可强开
 * （TerminologyServiceOptions.autoQualityGate）——即使强开，自动建议仍只
 * 展示、**绝不自动保存批注**（自动保存是独立产品语义，与门禁分开）。
 */
export const TERMINOLOGY_AUTO_QUALITY_GATE = false;

/**
 * 各自动档的密度上限（每段/每回答的候选数）。**v2 精确数值待负责人确认，
 * 当前为工程占位参数**（少量提示 3/6、辅助阅读 6/12——按任务书工程口径）。
 */
export const READING_MODE_DENSITY_LIMITS: Readonly<
  Record<"minimal-hints" | "assisted-reading", ReadingModeDensityLimits>
> = {
  "minimal-hints": { perParagraph: 1, perAnswer: 3 },
  "assisted-reading": { perParagraph: 2, perAnswer: 6 },
};

/** 建议集存储上限（进程内瞬态面；超出按产生序淘汰最旧）。 */
export const MAX_SUGGESTION_SETS = 60;

export const ZERO_USAGE: TerminologyUsageDelta = { requests: 0, promptChars: 0, completionChars: 0 };
