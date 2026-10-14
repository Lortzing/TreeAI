import { createHash } from "node:crypto";
import { join } from "node:path";
import { readFileSync } from "node:fs";
/** Terminology evaluator set-integrity with unchanged denominator and gates Instance-owned state and dependencies. */

export function createEvalSetIntegrity(deps) {

  /* ---------------- 机械工具（与产品/测试同口径） ---------------- */

  /** 词序数定位（1 起）：第 n 次出现的 {start,end}；未找到 → null。 */
  function nthOccurrence(text, term, n) {
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
  function excludedSpans(sourceText) {
    const spans = [];
    const url = /https?:\/\/[^\s））》>"']+|www\.[^\s））》>"']+/g;
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

  function sha256Hex(text) {
    return createHash("sha256").update(text, "utf8").digest("hex");
  }

  /* ---------------- 评测集完整性（与测试文件同口径的运行前门禁） ---------------- */

  function loadSet(split) {
    const path = join(deps.ROOT, "apps", "studio", "terminology", `eval-set-${split}.json`);
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.items)) throw new Error(`eval-set-${split}.json has no items array`);
    return { raw, parsed, path };
  }

  function verifySetIntegrity(devSet, frozenSet) {
    const problems = [];
    const dev = devSet.parsed.items;
    const frozen = frozenSet.parsed.items;
    const all = [...dev, ...frozen];
    if (dev.length !== 180) problems.push(`dev has ${dev.length} items (expected 180)`);
    if (frozen.length !== 180) problems.push(`frozen has ${frozen.length} items (expected 180)`);
    const ids = new Set();
    for (const item of all) {
      if (ids.has(item.id)) problems.push(`duplicate id ${item.id}`);
      ids.add(item.id);
    }
    /* 分组防泄漏：组 id 与来源文本都不得跨集。 */
    const devGroups = new Set(dev.map((i) => i.group));
    const frozenGroups = new Set(frozen.map((i) => i.group));
    for (const group of devGroups) {
      if (frozenGroups.has(group)) problems.push(`group ${group} straddles dev and frozen`);
    }
    const devSources = new Set(dev.map((i) => i.source));
    for (const item of frozen) {
      if (devSources.has(item.source)) problems.push(`source text of ${item.id} also appears in dev`);
    }
    /* 中文 ≥240（跨 360）。 */
    const zhCount = all.filter((i) => i.lang === "zh").length;
    if (zhCount < 240) problems.push(`zh items ${zhCount} < 240 across 360`);
    /* 负例 ≥25%（跨 360）：全负例提取条目 + 解释非术语条目。 */
    const negatives = all.filter(
      (i) => (i.kind === "extract" && (i.expectedTerms ?? []).length === 0) ||
        (i.kind === "explain" && i.expectation === "not-a-term"),
    ).length;
    if (negatives / all.length < 0.25) {
      problems.push(`negatives ${negatives}/${all.length} = ${(negatives / all.length * 100).toFixed(1)}% < 25%`);
    }
    /* 六类覆盖（两文件各自齐备）。 */
    for (const [name, items] of [["dev", dev], ["frozen", frozen]]) {
      const categories = new Set(items.map((i) => i.category));
      for (const category of deps.SIX_CATEGORIES) {
        if (!categories.has(category)) problems.push(`${name} misses category ${category}`);
      }
    }
    /* 逐条机械可解析性（解释词序数切片全等；提取词表在原文且不入排除带）。 */
    const spans = new Map();
    for (const item of all) {
      if (item.kind === "explain") {
        const span = nthOccurrence(item.source, item.term, item.occurrence ?? 1);
        if (span === null) {
          problems.push(`${item.id}: term '${item.term}' occurrence ${String(item.occurrence ?? 1)} not found`);
        } else if (item.source.slice(span.start, span.end) !== item.term) {
          problems.push(`${item.id}: slice mismatch at occurrence`);
        } else {
          spans.set(item.id, span);
        }
      } else if (item.kind === "extract") {
        const expected = item.expectedTerms ?? [];
        const negative = item.negativeTerms ?? [];
        if (expected.length === 0 && negative.length === 0) {
          problems.push(`${item.id}: full negative without negativeTerms`);
        }
        const excluded = excludedSpans(item.source);
        for (const term of [...expected, ...negative]) {
          if (!item.source.includes(term)) problems.push(`${item.id}: term '${term}' not in source`);
        }
        for (const term of expected) {
          const at = item.source.indexOf(term);
          if (at >= 0 && excluded.some((span) => at < span.end && span.start < at + term.length)) {
            problems.push(`${item.id}: expectedTerm '${term}' inside code/URL span`);
          }
        }
      } else {
        problems.push(`${item.id}: unknown kind '${String(item.kind)}'`);
      }
    }
    return { problems, spans, zhCount, negatives };
  }

  /** frozen 一次性锁判定（纯函数）：已有同 setHash 的已执行 real 冻结裁决即锁定。 */
  function isFrozenVerdictLocked(existingRuns, setHash) {
    for (const run of existingRuns) {
      if (
        run.mode === "real" &&
        run.set === "frozen" &&
        run.executed === true &&
        run.observe !== true &&
        run.setHash === setHash
      ) {
        return run;
      }
    }
    return null;
  }

  return {
    nthOccurrence,
    isFrozenVerdictLocked,
    loadSet,
    sha256Hex,
    verifySetIntegrity,
  };
}
