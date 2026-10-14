
import { join } from 'node:path';

import { type D4FixturesStats, MIN_POSITIVE_QUERIES, MIN_NO_RESULT_QUERIES, FACT_KINDS, type Expected, readJson, asRecord, asString, asArray, loadExpected, findMaterialFragmentText } from './truth.ts';
import { type Registry } from './truth.ts';

type Stats = { -readonly [K in keyof D4FixturesStats]: D4FixturesStats[K] };

export function verifySearch(d4Root: string, problems: string[], stats: Stats, expectedById: ReadonlyMap<string, Expected>, registries: readonly Registry[]) {
  // 7. search sets -------------------------------------------------------------
  const factsRaw = asRecord(readJson(join(d4Root, "b4-search", "facts.json"), problems, "b4 facts"));
  const queriesRaw = asRecord(
    readJson(join(d4Root, "b4-search", "queries.json"), problems, "b4 queries"),
  );
  const factById = new Map<string, { kind: string; treeId: string; text: string }>();
  /** The version-pair truth (for old-version query verification). */
  let pairV1Text: string | null = null;
  let pairV2Text: string | null = null;
  for (const reg of registries) {
    for (const pair of reg.versionPairs ?? []) {
      const v1p = asString(pair["v1Expected"]);
      const v2p = asString(pair["v2Expected"]);
      if (v1p === null || v2p === null) continue;
      const e1 = loadExpected(join(d4Root, "b1-import", v1p), problems, "pair-v1");
      const e2 = loadExpected(join(d4Root, "b1-import", v2p), problems, "pair-v2");
      if (e1 !== null && e2 !== null) {
        pairV1Text = e1.canonicalText;
        pairV2Text = e2.canonicalText;
      }
    }
  }
  if (factsRaw !== null && queriesRaw !== null) {
    const trees = asArray(factsRaw["trees"]) ?? [];
    if (trees.length < 3) problems.push(`b4 facts: ${trees.length} trees < 3`);
    for (const treeRaw of trees) {
      const tree = asRecord(treeRaw);
      if (tree === null) { problems.push("b4 facts: non-object tree"); continue; }
      const treeId = asString(tree["treeId"]) ?? "?";
      for (const factRaw of asArray(tree["facts"]) ?? []) {
        const fact = asRecord(factRaw);
        if (fact === null) { problems.push(`b4 facts ${treeId}: non-object fact`); continue; }
        const factId = asString(fact["factId"]);
        const kind = asString(fact["kind"]);
        if (factId === null || kind === null || !FACT_KINDS.has(kind)) {
          problems.push(`b4 facts ${treeId}: fact missing factId or unknown kind`);
          continue;
        }
        if (factById.has(factId)) {
          problems.push(`b4 facts: duplicate factId ${factId}`);
        }
        let text = "";
        for (const key of ["text", "explanation", "term", "note"]) {
          const v = asString(fact[key]);
          if (v !== null) text += v;
        }
        if (kind === "material-fragment") {
          const ref = asString(fact["materialKey"]);
          const needle = asString(fact["needle"]);
          if (ref === null || needle === null) {
            problems.push(`b4 facts ${factId}: material-fragment needs materialKey+needle`);
          } else if (!expectedById.has(ref)) {
            problems.push(`b4 facts ${factId}: materialKey ${ref} is not a ready fixture`);
          } else if (!expectedById.get(ref)!.canonicalText.includes(needle)) {
            problems.push(`b4 facts ${factId}: needle not present in ${ref} canonicalText`);
          }
        }
        factById.set(factId, { kind, treeId, text });
      }
    }
    const positives = asArray(queriesRaw["positive"]) ?? [];
    const noResults = asArray(queriesRaw["noResult"]) ?? [];
    stats.positiveQueries = positives.length;
    stats.noResultQueries = noResults.length;
    if (positives.length < MIN_POSITIVE_QUERIES) {
      problems.push(`b4: positive queries ${positives.length} < ${MIN_POSITIVE_QUERIES}`);
    }
    if (noResults.length < MIN_NO_RESULT_QUERIES) {
      problems.push(`b4: no-result queries ${noResults.length} < ${MIN_NO_RESULT_QUERIES}`);
    }
    const kindTargets = new Map<string, number>();
    const coverageTags = new Map<string, number>();
    for (const qRaw of positives) {
      const q = asRecord(qRaw);
      if (q === null) { problems.push("b4 positive: non-object query"); continue; }
      const id = asString(q["id"]) ?? "?";
      const text = asString(q["text"]);
      const expect = asArray(q["expect"]);
      if (text === null || expect === null || expect.length === 0) {
        problems.push(`b4 positive ${id}: missing text/expect`);
        continue;
      }
      const tags = (asArray(q["coverage"]) ?? []).filter((t): t is string => typeof t === "string");
      const effectiveTags = asString(q["treeId"]) !== null ? [...tags, "current-tree"] : tags;
      for (const tag of effectiveTags) {
        coverageTags.set(tag, (coverageTags.get(tag) ?? 0) + 1);
      }
      if (effectiveTags.includes("old-version")) {
        if (pairV1Text === null || pairV2Text === null ||
            !pairV1Text.includes(text) || pairV2Text.includes(text)) {
          problems.push(`b4 positive ${id}: old-version query text must exist in v1 only (stale in v2)`);
        }
      }
      for (const eRaw of expect) {
        const e = asRecord(eRaw);
        if (e === null) { problems.push(`b4 positive ${id}: non-object expect`); continue; }
        const factId = asString(e["factId"]);
        const fact = factId === null ? undefined : factById.get(factId);
        if (fact === undefined) {
          problems.push(`b4 positive ${id}: expect target ${String(factId)} not in facts`);
          continue;
        }
        kindTargets.set(fact.kind, (kindTargets.get(fact.kind) ?? 0) + 1);
        // the query text must mechanically appear in the target truth
        const truth =
          fact.kind === "material-fragment"
            ? findMaterialFragmentText(factsRaw, factId!, expectedById)
            : fact.text;
        if (truth === null || !truth.includes(text)) {
          problems.push(`b4 positive ${id}: query text not present in target ${factId} truth`);
        }
        // scoped queries stay in-tree
        const treeId = asString(q["treeId"]);
        if (treeId !== null && fact.treeId !== treeId) {
          problems.push(`b4 positive ${id}: scoped to tree ${treeId} but target ${factId} is in ${fact.treeId}`);
        }
      }
    }
    for (const kind of FACT_KINDS) {
      if ((kindTargets.get(kind) ?? 0) < 2) {
        problems.push(`b4: kind ${kind} targeted < 2 times`);
      }
    }
    /** Frozen B4 coverage floor（charter §6：覆盖中文/英文及各来源类型）。 */
    const COVERAGE_FLOOR: ReadonlyArray<{ tag: string; min: number }> = [
      { tag: "zh", min: 5 },
      { tag: "en", min: 5 },
      { tag: "code", min: 1 },
      { tag: "old-version", min: 3 },
      { tag: "current-tree", min: 2 },
    ];
    for (const { tag, min } of COVERAGE_FLOOR) {
      if ((coverageTags.get(tag) ?? 0) < min) {
        problems.push(`b4: coverage tag ${tag} appears ${String(coverageTags.get(tag) ?? 0)} < ${String(min)}`);
      }
    }
    // no-result queries must be absent from the WHOLE corpus
    const corpus: string[] = [];
    for (const [, fact] of factById) corpus.push(fact.text);
    for (const [, exp] of expectedById) corpus.push(exp.canonicalText);
    for (const qRaw of noResults) {
      const q = asRecord(qRaw);
      if (q === null) { problems.push("b4 noResult: non-object query"); continue; }
      const id = asString(q["id"]) ?? "?";
      const text = asString(q["text"]);
      if (text === null || text.length === 0) {
        problems.push(`b4 noResult ${id}: empty text`);
        continue;
      }
      for (const doc of corpus) {
        if (doc.includes(text)) {
          problems.push(`b4 noResult ${id}: text actually present in the corpus`);
          break;
        }
      }
    }
  }

}
