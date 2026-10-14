/** Terminology prompts ownership; public compatibility exports remain in ../terminology.ts. */
import type {
  PreparedExplainPassage,
} from "./model.ts";
import {
  EXPLAIN_CONTEXT_CONTEXT_CHARS,
  EXPLAIN_SOURCE_LIMIT_CHARS,
  MAX_EXPLAIN_SELECTION_CHARS,
} from "./policy.ts";
import type {
  TerminologyAnnotation,
  TurnSelection,
} from "@treeai/contracts";
import {
  createHash,
} from "node:crypto";

/** 解释任务的提示词（点词/划线共用；标记区间以 UTF-16 偏移给出；截断说明置于 [Passage] 之外——偏移只对 passage 成立）。 */
export function buildExplainPrompt(
  sourceText: string,
  selection: TurnSelection,
  truncationNote: string | null = null,
): string {
  const note = truncationNote === null ? "" : `${truncationNote}\n\n`;
  return (
    note +
    "Explain the marked span for a reader of the passage below. Plain text, 2-4 sentences, no markdown, " +
    "no headings. If the span is not a meaningful term or concept, say so plainly in one sentence.\n\n" +
    `[Passage]\n${sourceText}\n\n` +
    `[Marked span]\n"${selection.text}" (character offsets ${String(selection.start)}..${String(selection.end)} in the passage)`
  );
}

/**
 * 上下文纪律（issue #7 P1 整改）：原文不超过 EXPLAIN_SOURCE_LIMIT_CHARS
 * 时全文内嵌；超限取选区两侧 EXPLAIN_CONTEXT_CONTEXT_CHARS 窗口并如实
 * 标注截断（偏移重映射到窗口）。选区自身超过 MAX_EXPLAIN_SELECTION_CHARS
 * 返回哨兵（新任务零派发拒绝——单次解释容不下）。
 */
export function prepareExplainPassage(
  sourceText: string,
  selection: TurnSelection,
): PreparedExplainPassage | "selection-too-large" {
  if (selection.end - selection.start > MAX_EXPLAIN_SELECTION_CHARS) return "selection-too-large";
  if (sourceText.length <= EXPLAIN_SOURCE_LIMIT_CHARS) {
    return { passage: sourceText, selection, sourceLength: sourceText.length, truncated: false, truncationNote: null };
  }
  const windowStart = Math.max(0, selection.start - EXPLAIN_CONTEXT_CONTEXT_CHARS);
  const windowEnd = Math.min(sourceText.length, selection.end + EXPLAIN_CONTEXT_CONTEXT_CHARS);
  return {
    passage: sourceText.slice(windowStart, windowEnd),
    selection: {
      start: selection.start - windowStart,
      end: selection.end - windowStart,
      text: selection.text,
    },
    sourceLength: sourceText.length,
    truncated: true,
    truncationNote:
      `[Passage truncated: the original answer is ${String(sourceText.length)} characters; ` +
      `showing the ${String(windowEnd - windowStart)} characters around the marked span]`,
  };
}

/** auto 提取任务的提示词（要求 JSON 数组；机械校验在后）。 */
export function buildExtractPrompt(sourceText: string, maxTerms: number): string {
  return (
    `List up to ${String(maxTerms)} specialized terms in the passage below that a general reader would likely not ` +
    "understand, most important first. A qualifying term is a domain-specific expression — a named concept, " +
    "technique, entity, or jargon phrase that needs a definition. Do NOT mark:\n" +
    "- ordinary vocabulary even if it sounds technical in context (e.g. common words like signal, noise, " +
    "amplitude, nodes, replicas used in their ordinary meaning);\n" +
    "- code snippets, URLs, commands, file paths;\n" +
    "- single everyday words; prefer the full technical phrase when one exists.\n" +
    "When unsure, leave the word out — precision beats recall here.\n" +
    "Reply with ONLY a JSON array of objects " +
    '{"term": "...", "start": N, "end": M} where start/end are character offsets into the passage ' +
    "(UTF-16 code units, start inclusive, end exclusive; the passage slice [start,end) must equal the term). " +
    "If there are none, reply with [].\n\n" +
    `[Passage]\n${sourceText}`
  );
}

export const TERMINOLOGY_PROMOTION_TURN_PREFIX = "[follow-up from a terminology annotation]";

/** 锚点答案全文的 SHA-256 指纹（十六进制；批注时刻的全文身份）。 */
export function hashSourceText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 推广首问的组合上下文块（模型输入面事实；用户 turn 只带显式标记）。 */
export function firstQuestionContext(annotation: TerminologyAnnotation): string {
  return (
    `[Follow-up on the term "${annotation.term}"]\n` +
    `Explanation (saved annotation): ${annotation.explanation}\n` +
    `[Source excerpt]: "${annotation.selection.text}"\n\n`
  );
}

/** 推广首问的不可变 payload（组合上下文 + 问题全文——派发与 hash 的唯一来源）。 */
export function buildFirstQuestionPayload(annotation: TerminologyAnnotation, firstQuestion: string): string {
  return firstQuestionContext(annotation) + firstQuestion;
}

/** 首问 payload 的 SHA-256（派发账本 firstQuestionHash；同键异问即冲突）。 */
export function hashFirstQuestionPayload(annotation: TerminologyAnnotation, firstQuestion: string): string {
  return createHash("sha256").update(buildFirstQuestionPayload(annotation, firstQuestion), "utf8").digest("hex");
}
