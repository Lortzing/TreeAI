
import { join } from 'node:path';

import { type D4FixturesStats, MIN_VALID_SELECTIONS_PER_KIND, MIN_INVALID_SELECTIONS, REQUIRED_SELECTION_CATEGORIES, type Expected, readJson, asRecord, asString, asArray, nthOccurrence, graphemeBoundaries, blockContaining, loadExpected } from './truth.ts';
import { type Registry } from './truth.ts';

type Stats = { -readonly [K in keyof D4FixturesStats]: D4FixturesStats[K] };

export function verifySelections(d4Root: string, problems: string[], stats: Stats, expectedById: ReadonlyMap<string, Expected>, registries: readonly Registry[]) {
  // 5. selections -----------------------------------------------------------
  const selectionFiles = ["markdown-selections.json", "pdf-selections.json"];
  const categoryCounts = new Map<string, number>();
  for (const name of selectionFiles) {
    const raw = asRecord(readJson(join(d4Root, "b2-anchors", name), problems, `b2 ${name}`));
    if (raw === null) continue;
    const items = asArray(raw["items"]) ?? [];
    if (items.length < MIN_VALID_SELECTIONS_PER_KIND) {
      problems.push(`b2 ${name}: ${items.length} items < ${MIN_VALID_SELECTIONS_PER_KIND}`);
    }
    for (const itemRaw of items) {
      const item = asRecord(itemRaw);
      if (item === null) { problems.push(`b2 ${name}: non-object item`); continue; }
      const id = asString(item["id"]) ?? "?";
      const fixtureId = asString(item["fixture"]);
      const category = asString(item["category"]);
      const locator = asRecord(item["locator"]);
      const expectedRec = asRecord(item["expected"]);
      if (fixtureId === null || category === null || locator === null || expectedRec === null) {
        problems.push(`b2 ${name} ${id}: missing fixture/category/locator/expected`);
        continue;
      }
      const exp = expectedById.get(fixtureId);
      if (exp === undefined) {
        problems.push(`b2 ${name} ${id}: fixture ${fixtureId} not a ready fixture with truth`);
        continue;
      }
      const eStart = expectedRec["start"];
      const eEnd = expectedRec["end"];
      const eExcerpt = asString(expectedRec["excerpt"]);
      const eBlock = asString(expectedRec["blockId"]);
      if (typeof eStart !== "number" || typeof eEnd !== "number" || eExcerpt === null || eBlock === null) {
        problems.push(`b2 ${name} ${id}: malformed expected`);
        continue;
      }
      // resolve locator
      let rStart: number;
      let rEnd: number;
      const locKind = asString(locator["kind"]);
      if (locKind === "text-occurrence") {
        const needle = asString(locator["needle"]);
        const occurrence = locator["occurrence"];
        if (needle === null || typeof occurrence !== "number") {
          problems.push(`b2 ${name} ${id}: malformed text-occurrence locator`);
          continue;
        }
        const at = nthOccurrence(exp.canonicalText, needle, occurrence);
        if (at === null) {
          problems.push(`b2 ${name} ${id}: needle occurrence ${occurrence} not found in ${fixtureId}`);
          continue;
        }
        rStart = at;
        rEnd = at + needle.length;
        if (category === "repeat-word-2nd" && occurrence < 2) {
          problems.push(`b2 ${name} ${id}: repeat-word-2nd with occurrence ${occurrence} < 2`);
        }
      } else if (locKind === "utf16-range") {
        const s = locator["start"];
        const e = locator["end"];
        if (typeof s !== "number" || typeof e !== "number") {
          problems.push(`b2 ${name} ${id}: malformed utf16-range locator`);
          continue;
        }
        rStart = s;
        rEnd = e;
      } else {
        problems.push(`b2 ${name} ${id}: unknown locator kind ${String(locKind)}`);
        continue;
      }
      if (rStart !== eStart || rEnd !== eEnd) {
        problems.push(
          `b2 ${name} ${id}: locator resolves to [${rStart},${rEnd}) but stored [${eStart},${eEnd})`,
        );
        continue;
      }
      const slice = exp.canonicalText.slice(rStart, rEnd);
      if (slice !== eExcerpt) {
        problems.push(`b2 ${name} ${id}: excerpt ≠ canonicalText.slice(start,end)`);
        continue;
      }
      const block = blockContaining(exp.blocks, rStart, rEnd);
      if (block === null) {
        problems.push(`b2 ${name} ${id}: range [${rStart},${rEnd}) not contained in a single block`);
        continue;
      }
      if (block.blockId !== eBlock) {
        problems.push(`b2 ${name} ${id}: blockId ${eBlock} ≠ containing block ${block.blockId}`);
        continue;
      }
      // grapheme discipline: user selections never split a cluster
      const bounds = graphemeBoundaries(exp.canonicalText);
      if (!bounds.has(rStart) || !bounds.has(rEnd)) {
        problems.push(`b2 ${name} ${id}: range boundary splits a grapheme cluster`);
        continue;
      }
      // category semantics
      if (category === "cross-line" && !slice.includes("\n")) {
        problems.push(`b2 ${name} ${id}: cross-line excerpt contains no line break`);
      }
      if (category === "long-tail" && rEnd <= 0.8 * exp.canonicalText.length) {
        problems.push(`b2 ${name} ${id}: long-tail selection not in the final 20%`);
      }
      categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
      stats.validSelections++;
    }
  }
  for (const req of REQUIRED_SELECTION_CATEGORIES) {
    let count = 0;
    for (const [cat, n] of categoryCounts) {
      if (req.match.has(cat)) count += n;
    }
    if (count < req.min) {
      problems.push(`b2: category ${req.label} covered ${count} < ${req.min}`);
    }
  }

  // 6. invalid selections ----------------------------------------------------
  const invRaw = asRecord(
    readJson(join(d4Root, "b2-anchors", "invalid-selections.json"), problems, "b2 invalid"),
  );
  if (invRaw !== null) {
    const items = asArray(invRaw["items"]) ?? [];
    if (items.length < MIN_INVALID_SELECTIONS) {
      problems.push(`b2 invalid: ${items.length} items < ${MIN_INVALID_SELECTIONS}`);
    }
    const categories = new Set<string>();
    const negativeIds = new Set<string>();
    for (const reg of registries) {
      for (const n of reg.negativeFixtures) negativeIds.add(n.fixtureId);
    }
    for (const itemRaw of items) {
      const item = asRecord(itemRaw);
      if (item === null) { problems.push("b2 invalid: non-object item"); continue; }
      const id = asString(item["id"]) ?? "?";
      const category = asString(item["category"]);
      const input = asRecord(item["input"]);
      if (category === null || input === null) {
        problems.push(`b2 invalid ${id}: missing category/input`);
        continue;
      }
      categories.add(category);
      const fixtureId = asString(input["fixture"]);
      const pair = asString(input["pair"]);
      const start = input["start"];
      const end = input["end"];
      if (category === "unsupported-material") {
        if (fixtureId === null || !negativeIds.has(fixtureId)) {
          problems.push(`b2 invalid ${id}: unsupported-material must reference a negative fixture`);
        }
        stats.invalidSelections++;
        continue;
      }
      if (category === "stale-version") {
        if (pair === null || typeof start !== "number" || typeof end !== "number") {
          problems.push(`b2 invalid ${id}: stale-version needs pair/start/end`);
          continue;
        }
        const reg = registries.find((r) => (r.versionPairs ?? []).some((p) => p["materialKey"] === pair));
        const pairRec = reg?.versionPairs?.find((p) => p["materialKey"] === pair);
        const v1p = asString(pairRec?.["v1Expected"] ?? null);
        const v2p = asString(pairRec?.["v2Expected"] ?? null);
        if (v1p === null || v2p === null) {
          problems.push(`b2 invalid ${id}: unknown version pair ${pair}`);
          continue;
        }
        const e1 = loadExpected(join(d4Root, "b1-import", v1p), problems, `${pair}-v1`);
        const e2 = loadExpected(join(d4Root, "b1-import", v2p), problems, `${pair}-v2`);
        if (e1 === null || e2 === null) continue;
        if (start < 0 || end > Math.min(e1.canonicalText.length, e2.canonicalText.length) || end <= start) {
          problems.push(`b2 invalid ${id}: stale-version range out of bounds or empty`);
          continue;
        }
        if (e1.canonicalText.slice(start, end) === e2.canonicalText.slice(start, end)) {
          problems.push(`b2 invalid ${id}: stale-version range text identical in v1 and v2 (not stale)`);
        }
        stats.invalidSelections++;
        continue;
      }
      // range-based categories against a ready fixture
      if (fixtureId === null) {
        problems.push(`b2 invalid ${id}: category ${category} needs input.fixture`);
        continue;
      }
      const exp = expectedById.get(fixtureId);
      if (exp === undefined) {
        problems.push(`b2 invalid ${id}: fixture ${fixtureId} not a ready fixture`);
        continue;
      }
      if (typeof start !== "number" || typeof end !== "number") {
        problems.push(`b2 invalid ${id}: category ${category} needs start/end`);
        continue;
      }
      const len = exp.canonicalText.length;
      switch (category) {
        case "out-of-bounds":
          if (!(start < 0 || end > len)) {
            problems.push(`b2 invalid ${id}: out-of-bounds range [${start},${end}) is in bounds`);
          }
          break;
        case "zero-length":
          if (end !== start) problems.push(`b2 invalid ${id}: zero-length range is not zero-length`);
          break;
        case "reversed":
          if (end >= start) problems.push(`b2 invalid ${id}: reversed range is not reversed`);
          break;
        case "surrogate-split":
        case "combining-split":
        case "emoji-split": {
          const bounds = graphemeBoundaries(exp.canonicalText);
          const startSplits = start >= 0 && start < len && !bounds.has(start);
          const endSplits = end > 0 && end <= len && !bounds.has(end);
          if (!startSplits && !endSplits) {
            problems.push(`b2 invalid ${id}: ${category} boundaries are grapheme-safe (not invalid)`);
          }
          break;
        }
        case "cross-page": {
          if (exp.kind !== "pdf") {
            problems.push(`b2 invalid ${id}: cross-page only applies to pdf fixtures`);
            break;
          }
          const b1 = blockContaining(exp.blocks, Math.max(0, Math.min(start, end)), Math.max(0, Math.min(start, end)) + 1);
          const s2 = Math.max(0, end - 1);
          const b2 = blockContaining(exp.blocks, s2, s2 + 1);
          if (b1 !== null && b1 === b2) {
            problems.push(`b2 invalid ${id}: cross-page range stays inside one block`);
          }
          break;
        }
        case "block-mismatch": {
          const blockId = asString(input["blockId"]);
          const block = blockContaining(exp.blocks, start, end);
          if (blockId === null || block === null || block.blockId === blockId) {
            problems.push(`b2 invalid ${id}: block-mismatch does not mismatch`);
          }
          break;
        }
        case "excerpt-mismatch": {
          const excerpt = asString(input["excerpt"]);
          if (
            excerpt === null || start < 0 || end > len || end < start ||
            excerpt === exp.canonicalText.slice(start, end)
          ) {
            problems.push(`b2 invalid ${id}: excerpt-mismatch excerpt actually matches`);
          }
          break;
        }
        default:
          problems.push(`b2 invalid ${id}: unknown category ${category}`);
      }
      stats.invalidSelections++;
    }
    if (categories.size < 4) {
      problems.push(`b2 invalid: only ${categories.size} distinct categories (< 4)`);
    }
  }

}
