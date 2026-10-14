/** Terminology candidates ownership; public compatibility exports remain in ../terminology.ts. */
import type {
  TerminologyCandidate,
} from "./model.ts";

/**
 * 从模型回答中解析 JSON 数组（提取任务）：取回答中首个平衡的 [...] 片段
 * 解析；形状不符的条目剔除（不是整个任务失败——诚实呈现可解析部分；
 * 完全无 JSON → 返回 null，任务 failed）。
 */
export function parseCandidates(
  raw: string,
): ReadonlyArray<{ term?: unknown; start?: unknown; end?: unknown }> | null {
  const start = raw.indexOf("[");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "[") depth += 1;
    if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(raw.slice(start, i + 1));
          if (Array.isArray(parsed)) return parsed as ReadonlyArray<Record<string, unknown>>;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** 源文本中的 URL / 反引号围栏区间（auto 提取的排除带）。 */
export function excludedSpans(sourceText: string): ReadonlyArray<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  const url = /https?:\/\/[^\s）)》>"']+|www\.[^\s）)》>"']+/g;
  for (const match of sourceText.matchAll(url)) {
    if (match.index === undefined) continue;
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  const fence = /`[^`]*`/g;
  for (const match of sourceText.matchAll(fence)) {
    if (match.index === undefined) continue;
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return spans;
}

/**
 * 候选机械校验（auto 提取）：
 * - term 为非空字符串，start/end 为整数、界内有序；
 * - 切片全等：source.slice(start, end) === term（模型偏移错位即剔除，
 *   绝不修正——来源匹配 100% 是冻结目标）；
 * - 去重（同 term 至多一条，保留首个）；
 * - 密度上限（maxTerms，保留前 N）；
 * - 代码/URL 排除（候选区间与排除带重叠即剔除）。
 */
export function validateCandidates(
  sourceText: string,
  raw: ReadonlyArray<{ term?: unknown; start?: unknown; end?: unknown }>,
  maxTerms: number,
): TerminologyCandidate[] {
  const seen = new Set<string>();
  const excluded = excludedSpans(sourceText);
  const accepted: TerminologyCandidate[] = [];
  for (const entry of raw) {
    const term = entry.term;
    const start = entry.start;
    const end = entry.end;
    if (typeof term !== "string" || term.length === 0 || term.length > 200) continue;
    if (typeof start !== "number" || typeof end !== "number") continue;
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
    if (start < 0 || end <= start || end > sourceText.length) continue;
    if (sourceText.slice(start, end) !== term) continue;
    if (seen.has(term)) continue;
    if (excluded.some((span) => start < span.end && span.start < end)) continue;
    seen.add(term);
    accepted.push({ term, start, end });
    if (accepted.length >= maxTerms) break;
  }
  return accepted;
}
