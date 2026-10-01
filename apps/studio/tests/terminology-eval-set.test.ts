/**
 * 术语冻结评测集完整性测试（issue #7 §4「符合 v2 口径的冻结质量评测」；
 * 评测集 = apps/studio/terminology/eval-set-dev.json + eval-set-frozen.json，
 * 继承自 wip/term-eval 并经 2026-10-01 预冻结审查修正）。
 *
 * 机械锁定（失败即阻断——评测集是冻结评测的分母，任何漂移都必须显式过本测试）：
 *  - 180 + 180 总量；id 文件内与跨文件唯一；
 *  - 分组防泄漏：group id 与来源文本均不得跨 dev/frozen（按条目 group 字段
 *    核查，另加来源文本级强校验）；
 *  - 中文 ≥240（跨 360 条）；
 *  - 负例 ≥25%（跨 360 条：expectedTerms 为空的完整负例提取条目 ＋ 解释
 *    非术语 not-a-term 条目）；
 *  - 六类覆盖（两文件各自齐备：technical-concept / general-explanation /
 *    homonym-polysemy / already-defined / code-mixed / long-answer）；
 *  - 任务面维度齐备：解释正例/歧义（同形异义跨 ≥2 语义组）/非术语
 *    （not-a-term 两文件均有）/提取正例/提取完整负例；
 *  - 逐条机械可解析性：解释条目 term 按词序数（occurrence）在原文解析且
 *    切片全等（评测集不存偏移——runner 现场机械解析）；提取条目
 *    expectedTerms/negativeTerms 均在原文、expectedTerms 不入代码/URL
 *    排除带；完整负例必带非空 negativeTerms；
 *  - 长答案类：≥1500 字且目标词（解释 term 的解析处；提取全部
 *    expectedTerms 的首现处）位于末三分之一；
 *  - 代码混合类：原文含真实代码围栏（反引号）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TERMINOLOGY_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "terminology");

const SIX_CATEGORIES = [
  "technical-concept",
  "general-explanation",
  "homonym-polysemy",
  "already-defined",
  "code-mixed",
  "long-answer",
] as const;

type EvalCategory = (typeof SIX_CATEGORIES)[number];

interface ExplainItem {
  readonly kind: "explain";
  readonly id: string;
  readonly lang: "zh" | "en";
  readonly category: EvalCategory;
  readonly group: string;
  readonly source: string;
  readonly term: string;
  readonly occurrence: number;
  readonly expectation: "term" | "not-a-term";
  readonly mode: "term" | "range";
}

interface ExtractItem {
  readonly kind: "extract";
  readonly id: string;
  readonly lang: "zh" | "en";
  readonly category: EvalCategory;
  readonly group: string;
  readonly source: string;
  readonly expectedTerms: readonly string[];
  readonly negativeTerms: readonly string[];
}

type EvalItem = ExplainItem | ExtractItem;

interface EvalSet {
  readonly version: number;
  readonly split: "dev" | "frozen";
  readonly items: readonly EvalItem[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isEvalItem(value: unknown, idPrefix: string): value is EvalItem {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || !value.id.startsWith(idPrefix)) return false;
  if (value.kind !== "explain" && value.kind !== "extract") return false;
  if (value.lang !== "zh" && value.lang !== "en") return false;
  if (typeof value.category !== "string" || !(SIX_CATEGORIES as readonly string[]).includes(value.category)) return false;
  if (typeof value.group !== "string" || value.group.length === 0) return false;
  if (typeof value.source !== "string" || value.source.length === 0) return false;
  if (value.kind === "explain") {
    return (
      typeof value.term === "string" &&
      value.term.length > 0 &&
      typeof value.occurrence === "number" &&
      Number.isInteger(value.occurrence) &&
      value.occurrence >= 1 &&
      (value.expectation === "term" || value.expectation === "not-a-term") &&
      (value.mode === "term" || value.mode === "range") &&
      isStringArray(value.expectedTerms) === false
    );
  }
  return isStringArray(value.expectedTerms) && isStringArray(value.negativeTerms);
}

function loadSet(split: "dev" | "frozen"): EvalSet {
  const raw = JSON.parse(readFileSync(join(TERMINOLOGY_DIR, `eval-set-${split}.json`), "utf8")) as unknown;
  assert.ok(isRecord(raw), `eval-set-${split}.json must be a JSON object`);
  assert.equal(raw.split, split, `eval-set-${split}.json split field`);
  assert.equal(raw.version, 1, `eval-set-${split}.json version field`);
  assert.ok(Array.isArray(raw.items), `eval-set-${split}.json items array`);
  const items = raw.items as readonly unknown[];
  for (const item of items) {
    assert.ok(isEvalItem(item, split === "dev" ? "dev-" : "frozen-"), `item shape: ${JSON.stringify(item).slice(0, 120)}`);
  }
  return { version: 1, split, items: items as readonly EvalItem[] };
}

const dev = loadSet("dev");
const frozen = loadSet("frozen");
const all = [...dev.items, ...frozen.items];

/** 词序数定位（1 起；与 runner/试标器同口径）：第 n 次出现；未找到 → null。 */
function nthOccurrence(text: string, term: string, n: number): { start: number; end: number } | null {
  let from = 0;
  for (let i = 0; i < n; i += 1) {
    const at = text.indexOf(term, from);
    if (at < 0) return null;
    if (i === n - 1) return { start: at, end: at + term.length };
    from = at + term.length;
  }
  return null;
}

/** URL / 反引号围栏排除带（与 apps/studio/src/terminology.ts 的正则一致）。 */
function excludedSpans(sourceText: string): ReadonlyArray<{ start: number; end: number }> {
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

test("terminology eval sets: 180 + 180 items, ids unique within and across files", () => {
  assert.equal(dev.items.length, 180, "dev set has exactly 180 items");
  assert.equal(frozen.items.length, 180, "frozen set has exactly 180 items");
  const ids = new Set<string>();
  for (const item of all) {
    assert.ok(!ids.has(item.id), `duplicate id ${item.id}`);
    ids.add(item.id);
  }
  assert.equal(ids.size, 360, "360 unique ids across both files");
});

test("terminology eval sets: group-based leakage prevention (group ids and source texts never straddle dev/frozen)", () => {
  const devGroups = new Set(dev.items.map((item) => item.group));
  const frozenGroups = new Set(frozen.items.map((item) => item.group));
  const straddling = [...devGroups].filter((group) => frozenGroups.has(group));
  assert.deepEqual(straddling, [], "no group id appears in both dev and frozen");
  const devSources = new Set(dev.items.map((item) => item.source));
  const sharedSources = frozen.items.filter((item) => devSources.has(item.source));
  assert.deepEqual(sharedSources.map((item) => item.id), [], "no source text appears in both dev and frozen");
});

test("terminology eval sets: Chinese >= 240 across 360; negatives >= 25% across 360", () => {
  const zhCount = all.filter((item) => item.lang === "zh").length;
  assert.ok(zhCount >= 240, `zh items ${zhCount} >= 240 across 360`);
  const negatives = all.filter(
    (item) =>
      (item.kind === "extract" && item.expectedTerms.length === 0) ||
      (item.kind === "explain" && item.expectation === "not-a-term"),
  );
  assert.ok(
    negatives.length / all.length >= 0.25,
    `negatives ${negatives.length}/${all.length} = ${((negatives.length / all.length) * 100).toFixed(1)}% >= 25%`,
  );
});

test("terminology eval sets: all six v2 coverage categories present in both files, with both task kinds", () => {
  for (const set of [dev, frozen]) {
    const categories = new Set(set.items.map((item) => item.category));
    for (const category of SIX_CATEGORIES) {
      assert.ok(categories.has(category), `${set.split} covers ${category}`);
    }
    const explain = set.items.filter((item): item is ExplainItem => item.kind === "explain");
    const extract = set.items.filter((item): item is ExtractItem => item.kind === "extract");
    assert.ok(explain.length > 0 && extract.length > 0, `${set.split} has both explain and extract items`);
    assert.ok(
      extract.some((item) => item.expectedTerms.length > 0),
      `${set.split} has extract positives`,
    );
    assert.ok(
      extract.some((item) => item.expectedTerms.length === 0),
      `${set.split} has full-negative extract items`,
    );
    assert.ok(
      explain.some((item) => item.expectation === "not-a-term"),
      `${set.split} has explain not-a-term (非术语) coverage`,
    );
  }
});

test("terminology eval sets: homonym-polysemy terms (ambiguity dimension) span >= 2 semantic-context groups per file", () => {
  for (const set of [dev, frozen]) {
    const byTerm = new Map<string, Set<string>>();
    for (const item of set.items) {
      if (item.kind !== "explain" || item.category !== "homonym-polysemy" || item.expectation !== "term") continue;
      const groups = byTerm.get(item.term) ?? new Set<string>();
      groups.add(item.group);
      byTerm.set(item.term, groups);
    }
    assert.ok(byTerm.size >= 3, `${set.split} has at least 3 distinct homonym surface forms`);
    for (const [term, groups] of byTerm) {
      assert.ok(
        groups.size >= 2,
        `${set.split}: homonym term '${term}' appears in >= 2 distinct semantic-context groups (got ${groups.size})`,
      );
    }
  }
});

test("terminology eval sets: every explain term resolves mechanically at its occurrence with slice equality", () => {
  for (const item of all) {
    if (item.kind !== "explain") continue;
    const span = nthOccurrence(item.source, item.term, item.occurrence);
    assert.ok(span !== null, `${item.id}: term '${item.term}' occurrence ${item.occurrence} resolves in source`);
    assert.equal(
      item.source.slice(span.start, span.end),
      item.term,
      `${item.id}: slice equality at the resolving occurrence`,
    );
  }
});

test("terminology eval sets: extract expectedTerms and negativeTerms verified against sources (expectedTerms outside code/URL spans; full negatives carry negativeTerms)", () => {
  for (const item of all) {
    if (item.kind !== "extract") continue;
    assert.ok(
      item.expectedTerms.length > 0 || item.negativeTerms.length > 0,
      `${item.id}: a full negative must carry non-empty negativeTerms`,
    );
    const excluded = excludedSpans(item.source);
    for (const term of [...item.expectedTerms, ...item.negativeTerms]) {
      assert.ok(item.source.includes(term), `${item.id}: term '${term}' appears in source`);
    }
    for (const term of item.expectedTerms) {
      const at = item.source.indexOf(term);
      assert.ok(
        !excluded.some((span) => at < span.end && span.start < at + term.length),
        `${item.id}: expectedTerm '${term}' must stay outside code/URL excluded spans`,
      );
    }
  }
});

test("terminology eval sets: long-answer items are >= 1500 chars with every target term in the final third", () => {
  for (const item of all) {
    if (item.category !== "long-answer") continue;
    assert.ok(item.source.length >= 1500, `${item.id}: long-answer source ${item.source.length} >= 1500 chars`);
    const finalThirdStart = (2 * item.source.length) / 3;
    if (item.kind === "explain") {
      const span = nthOccurrence(item.source, item.term, item.occurrence);
      assert.ok(span !== null, `${item.id}: term resolves`);
      assert.ok(
        span.start > finalThirdStart,
        `${item.id}: explain term position ${span.start} is in the final third (starts ${finalThirdStart.toFixed(0)})`,
      );
    } else {
      for (const term of item.expectedTerms) {
        const at = item.source.indexOf(term);
        assert.ok(at >= 0, `${item.id}: expectedTerm '${term}' present`);
        assert.ok(
          at > finalThirdStart,
          `${item.id}: expectedTerm '${term}' first occurrence ${at} is in the final third (starts ${finalThirdStart.toFixed(0)})`,
        );
      }
    }
  }
});

test("terminology eval sets: code-mixed items carry real code fences", () => {
  for (const item of all) {
    if (item.category !== "code-mixed") continue;
    assert.ok(/`[^`]+`/.test(item.source), `${item.id}: code-mixed source contains a backtick code fence`);
    if (item.kind === "extract") {
      const excluded = excludedSpans(item.source);
      for (const term of item.expectedTerms) {
        const at = item.source.indexOf(term);
        assert.ok(
          !excluded.some((span) => at < span.end && span.start < at + term.length),
          `${item.id}: expectedTerm '${term}' stays in prose (outside code fences)`,
        );
      }
    }
  }
});
