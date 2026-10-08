/** Pure terminology density rules: behavior moved without semantic changes. */
import type { ReadingModeDensityLimits, TerminologyCandidate } from "../terminology.ts";

/**
 * 「每段」的切分口径（**工程占位**：v2 的段落精确口径未在库内定位到文本，
 * 按空行分段——连续空行（\n、空白、\n 序列）视为一段边界，单换行不分段，
 * 与聊天答案的常见段落形态一致）。返回按序的段落区间。
 */
export function paragraphRangesOf(text: string): ReadonlyArray<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  /* 连续空行（\n、空白、\n 的任意重复）整体视为一个段边界。 */
  const separator = /(?:\n[ \t]*)+\n/g;
  let start = 0;
  for (const match of text.matchAll(separator)) {
    const at = match.index ?? 0;
    if (at > start) ranges.push({ start, end: at });
    start = at + match[0].length;
  }
  if (start < text.length) ranges.push({ start, end: text.length });
  return ranges;
}

function paragraphIndexOf(
  ranges: ReadonlyArray<{ start: number; end: number }>,
  offset: number,
): number {
  for (let index = 0; index < ranges.length; index += 1) {
    if (offset >= ranges[index]!.start && offset < ranges[index]!.end) return index;
  }
  return ranges.length === 0 ? 0 : ranges.length - 1;
}

/**
 * 密度上限（每段/每回答）：按候选原序（模型优先序）保留——先到先得，
 * 超出所在段上限或回答总上限的候选计入 hiddenCount（partial 状态的
 * 「还有 N 个候选未显示」）。
 */
export function applySuggestionDensity(
  sourceText: string,
  candidates: readonly TerminologyCandidate[],
  limits: ReadingModeDensityLimits,
): { kept: TerminologyCandidate[]; hiddenCount: number } {
  const ranges = paragraphRangesOf(sourceText);
  const perParagraph = new Map<number, number>();
  const kept: TerminologyCandidate[] = [];
  let total = 0;
  let hiddenCount = 0;
  for (const candidate of candidates) {
    const paragraph = paragraphIndexOf(ranges, candidate.start);
    const count = perParagraph.get(paragraph) ?? 0;
    if (total >= limits.perAnswer || count >= limits.perParagraph) {
      hiddenCount += 1;
      continue;
    }
    perParagraph.set(paragraph, count + 1);
    total += 1;
    kept.push(candidate);
  }
  return { kept, hiddenCount };
}

