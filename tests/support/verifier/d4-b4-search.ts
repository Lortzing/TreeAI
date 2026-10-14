/**
 * Shared B4「跨材料找回」executing check (D4-4 wave, issue #8 charter §6 B4).
 *
 * Runs the PRODUCT document-assembly path (buildSearchDocuments in
 * apps/studio/src/search/search-service.ts — the same pure function the HTTP
 * search endpoints use, NOT a test helper) over the frozen B4 corpus:
 *
 *  - corpus: tests/fixtures/d4/b4-search/facts.json — all saved product facts
 *    across 3 trees; material-fragment facts are pinned to the B1 frozen truth
 *    canonicalText via materialKey (excerpt/start/end are constructively
 *    re-verified: canonicalText.slice(start,end) === excerpt — the anchor
 *    discipline of d4-probes §7, hand-written offsets are never trusted);
 *  - every POSITIVE query must place its pre-specified target factId in the
 *    engine's top-5 (charter floor ≥95% of positive queries; the frozen set +
 *    the deterministic engine assert ALL of them — any regression fails here,
 *    no silent downgrade), as a phrase-tier hit whose span slices back to the
 *    query text in the assembled body; scoped (current-tree) queries must not
 *    leak other trees;
 *  - every NO-RESULT query must return zero hits (nothing fabricated — the
 *    corpus genuinely does not contain them);
 *  - honest per-item reporting: every query contributes one evidence line
 *    (positives: target rank + tier; no-results: zero-hit confirmation), plus
 *    corpus shape lines; nothing is ever moved out of the denominator.
 *
 * Consumers: scripts/verify-d4.js (check `b4-cross-material-find`). The
 * browser/UI part of charter B4 (source jump) stays with run:d4-browser; the
 * HTTP endpoints are covered by apps/studio/tests/search-api.test.ts. The
 * frozen fixture tree stays read-only — nothing under tests/fixtures/d4 is
 * written.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { LocalSearchEngine } from "../../../apps/studio/src/search/search-engine.ts";
import type { SearchDocument } from "../../../apps/studio/src/search/search-engine.ts";
import {
  buildSearchDocuments,
  searchDocumentRefId,
  type SearchSnapshot,
  type SearchSnapshotMaterialVersion,
} from "../../../apps/studio/src/search/search-service.ts";

export interface B4SearchCheckOutcome {
  readonly status: "PASS" | "FAIL" | "NOT_RUN";
  readonly exitCode: number | null;
  /** One-line summary for the check matrix. */
  readonly detail: string;
  /** Per-item execution lines (evidence log). */
  readonly lines: readonly string[];
  readonly problems: readonly string[];
}

/* ------------------------------------------------------------------ */
/* Frozen fixture shapes (mirrors d4-probes.ts field vocabulary)         */
/* ------------------------------------------------------------------ */

interface B1ExpectedTruth {
  readonly canonicalText: string;
  readonly blocks: ReadonlyArray<{ blockId: string; start: number; end: number }>;
}

interface B4Fact {
  readonly factId: string;
  readonly docKind: "material" | "annotation" | "return" | "turn";
  /** 装配后文档的 refId（材料 = versionId 事实行；其余 = factId）。 */
  readonly refId: string;
  readonly treeId: string;
  readonly title: string;
  readonly createdAt: string;
  readonly text?: string;
  readonly explanation?: string;
  readonly term?: string;
  readonly note?: string;
  readonly materialId?: string;
  readonly materialTitle?: string;
  readonly materialKey?: string;
  readonly versionId?: string;
  readonly versionLabel?: string;
  readonly oldVersion?: boolean;
  readonly start?: number;
  readonly end?: number;
  readonly excerpt?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function readJson(path: string, problems: string[], what: string): Record<string, unknown> | null {
  try {
    const record = asRecord(JSON.parse(readFileSync(path, "utf8")));
    if (record === null) {
      problems.push(`${what}: not a JSON object at ${path}`);
      return null;
    }
    return record;
  } catch (error) {
    problems.push(`${what}: unreadable/invalid JSON at ${path} (${error instanceof Error ? error.message : String(error)})`);
    return null;
  }
}

/** B1 冻结真值（canonicalText + blocks；materialKey → expected 路径）。 */
function loadB1Expected(
  b1Root: string,
  problems: string[],
): Map<string, B1ExpectedTruth> {
  const byMaterialKey = new Map<string, B1ExpectedTruth>();
  for (const name of ["md-registry.json", "pdf-registry.json"]) {
    const registry = readJson(join(b1Root, name), problems, `b1 ${name}`);
    if (registry === null) continue;
    for (const entry of asArray(registry["fixtures"]) ?? []) {
      const record = asRecord(entry);
      const fixtureId = record === null ? null : asString(record["fixtureId"]);
      const expected = record === null ? null : asString(record["expected"]);
      const outcome = record === null ? null : asString(record["outcome"]);
      if (fixtureId === null || expected === null || outcome !== "ready") continue;
      const truthRaw = readJson(join(b1Root, expected), problems, `b1 expected ${fixtureId}`);
      if (truthRaw === null) continue;
      const canonicalText = asString(truthRaw["canonicalText"]);
      const blocksRaw = asArray(truthRaw["blocks"]);
      if (canonicalText === null || blocksRaw === null) {
        problems.push(`b1 expected ${fixtureId}: missing canonicalText/blocks`);
        continue;
      }
      const blocks: { blockId: string; start: number; end: number }[] = [];
      let blocksOk = true;
      for (const blockRaw of blocksRaw) {
        const block = asRecord(blockRaw);
        const blockId = block === null ? null : asString(block["blockId"]);
        const start = block === null ? undefined : block["start"];
        const end = block === null ? undefined : block["end"];
        if (blockId === null || typeof start !== "number" || typeof end !== "number") {
          blocksOk = false;
          break;
        }
        blocks.push({ blockId, start, end });
      }
      if (!blocksOk) {
        problems.push(`b1 expected ${fixtureId}: malformed block entry`);
        continue;
      }
      byMaterialKey.set(fixtureId, { canonicalText, blocks });
    }
  }
  return byMaterialKey;
}

/* ------------------------------------------------------------------ */
/* The check                                                            */
/* ------------------------------------------------------------------ */

/** facts.json 的 kind → 引擎文档 kind（material-fragment 归 material）。 */
const DOC_KIND_BY_FACT_KIND: Readonly<Record<string, B4Fact["docKind"]>> = {
  "material-fragment": "material",
  annotation: "annotation",
  return: "return",
  turn: "turn",
};

function runB4SearchCheck(d4Root: string): B4SearchCheckOutcome {
  const problems: string[] = [];
  const lines: string[] = [];
  const b4Root = join(d4Root, "b4-search");
  const b1Root = join(d4Root, "b1-import");
  if (!existsSync(b4Root)) {
    return {
      status: "NOT_RUN",
      exitCode: null,
      detail: "tests/fixtures/d4/b4-search not present in this tree",
      lines,
      problems,
    };
  }

  /* ---- corpus: facts.json → SearchSnapshot（产品装配的同一输入形状） ---- */
  const factsRaw = readJson(join(b4Root, "facts.json"), problems, "b4 facts");
  const queriesRaw = readJson(join(b4Root, "queries.json"), problems, "b4 queries");
  if (factsRaw === null || queriesRaw === null) {
    return { status: "FAIL", exitCode: 2, detail: "b4 fixtures unreadable", lines, problems };
  }

  const expectedById = loadB1Expected(b1Root, problems);
  const facts: B4Fact[] = [];
  const trees: { treeId: string; title: string }[] = [];
  const materialVersions: SearchSnapshotMaterialVersion[] = [];
  const annotations: SearchSnapshot["annotations"][number][] = [];
  const returns: SearchSnapshot["returns"][number][] = [];
  const turns: SearchSnapshot["turns"][number][] = [];

  for (const treeRaw of asArray(factsRaw["trees"]) ?? []) {
    const tree = asRecord(treeRaw);
    const treeId = tree === null ? null : asString(tree["treeId"]);
    const treeTitle = tree === null ? null : asString(tree["title"]);
    if (tree === null || treeId === null || treeTitle === null) {
      problems.push("b4 facts: tree entry missing treeId/title");
      continue;
    }
    trees.push({ treeId, title: treeTitle });
    for (const factRaw of asArray(tree["facts"]) ?? []) {
      const record = asRecord(factRaw);
      const factId = record === null ? null : asString(record["factId"]);
      const kind = record === null ? null : asString(record["kind"]);
      const title = record === null ? null : asString(record["title"]);
      const createdAt = record === null ? null : asString(record["createdAt"]);
      if (record === null || factId === null || kind === null || title === null || createdAt === null) {
        problems.push(`b4 facts ${treeId}: fact missing factId/kind/title/createdAt`);
        continue;
      }
      const docKind = DOC_KIND_BY_FACT_KIND[kind];
      if (docKind === undefined) {
        problems.push(`b4 facts ${factId}: unknown kind '${kind}'`);
        continue;
      }
      let fact: B4Fact;
      if (docKind === "material") {
        const materialKey = asString(record["materialKey"]);
        const materialId = asString(record["materialId"]);
        const materialTitle = asString(record["materialTitle"]);
        const versionId = asString(record["versionId"]);
        const versionLabel = asString(record["versionLabel"]);
        const oldVersion = record["oldVersion"];
        const start = record["start"];
        const end = record["end"];
        const excerpt = asString(record["excerpt"]);
        if (
          materialKey === null || materialId === null || materialTitle === null ||
          versionId === null || versionLabel === null || typeof oldVersion !== "boolean" ||
          typeof start !== "number" || typeof end !== "number" || excerpt === null
        ) {
          problems.push(`b4 facts ${factId}: material-fragment missing material metadata`);
          continue;
        }
        const truth = expectedById.get(materialKey);
        if (truth === undefined) {
          problems.push(`b4 facts ${factId}: materialKey ${materialKey} is not a ready B1 truth`);
          continue;
        }
        // 构造性复核（锚点纪律，同 d4-probes §7）：切片全等，不信任手写偏移。
        if (truth.canonicalText.slice(start, end) !== excerpt) {
          problems.push(`b4 facts ${factId}: excerpt ≠ canonicalText.slice(start,end)`);
          continue;
        }
        materialVersions.push({
          treeId,
          materialId,
          materialTitle,
          versionId,
          versionLabel,
          oldVersion,
          canonicalText: truth.canonicalText,
          blocks: truth.blocks,
          title,
          importedAt: createdAt,
        });
        // 材料文档的事实行 id = versionId（装配 refId 方案）。
        fact = {
          factId, docKind, treeId, title, createdAt,
          refId: searchDocumentRefId(treeId, "material", versionId),
          materialId, materialTitle, materialKey, versionId, versionLabel, oldVersion, start, end, excerpt,
        };
      } else if (docKind === "annotation") {
        const term = asString(record["term"]);
        const explanation = asString(record["explanation"]);
        const note = asString(record["note"]);
        if (term === null || explanation === null) {
          problems.push(`b4 facts ${factId}: annotation missing term/explanation`);
          continue;
        }
        // The frozen B4 facts already carry a real Branch identifier; retain it
        // in the shared SearchSnapshot rather than manufacturing a UI target.
        const branchId = asString(record["branchId"]);
        if (branchId === null || branchId.length === 0) {
          problems.push(`b4 facts ${factId}: annotation missing branchId`);
          continue;
        }
        annotations.push({ id: factId, treeId, branchId, title, term, explanation, note: note ?? null, createdAt });
        fact = {
          factId, docKind, treeId, title, createdAt,
          refId: searchDocumentRefId(treeId, "annotation", factId),
          term, explanation,
          ...(note !== null ? { note } : {}),
        };
      } else {
        // return / turn：正文 = text。
        const text = asString(record["text"]);
        if (text === null) {
          problems.push(`b4 facts ${factId}: ${docKind} missing text`);
          continue;
        }
        const branchId = asString(record["branchId"]);
        if (branchId === null || branchId.length === 0) {
          problems.push(`b4 facts ${factId}: ${docKind} missing branchId`);
          continue;
        }
        const entry = { id: factId, treeId, branchId, title, text, createdAt };
        if (docKind === "return") returns.push(entry);
        else turns.push(entry);
        fact = {
          factId, docKind, treeId, title, createdAt,
          refId: searchDocumentRefId(treeId, docKind, factId),
          text,
        };
      }
      facts.push(fact);
    }
  }

  if (facts.length === 0) {
    return {
      status: "NOT_RUN",
      exitCode: null,
      detail: "b4-search present but no facts were loadable",
      lines,
      problems,
    };
  }

  /* ---- queries ---- */
  interface PositiveQuery {
    readonly id: string;
    readonly text: string;
    readonly treeId: string | null;
    readonly expectFactId: string;
  }
  const positives: PositiveQuery[] = [];
  for (const entry of asArray(queriesRaw["positive"]) ?? []) {
    const record = asRecord(entry);
    const id = record === null ? null : asString(record["id"]);
    const text = record === null ? null : asString(record["text"]);
    const treeId = record === null ? null : asString(record["treeId"]);
    const expect = record === null ? null : asArray(record["expect"]);
    if (id === null || text === null || expect === null || expect.length === 0) {
      problems.push(`b4 positive ${String(id)}: missing id/text/expect`);
      continue;
    }
    for (const expectRaw of expect) {
      const expectRecord = asRecord(expectRaw);
      const factId = expectRecord === null ? null : asString(expectRecord["factId"]);
      if (factId === null) {
        problems.push(`b4 positive ${id}: malformed expect entry`);
        continue;
      }
      positives.push({ id, text, treeId, expectFactId: factId });
    }
  }
  const noResults: { id: string; text: string }[] = [];
  for (const entry of asArray(queriesRaw["noResult"]) ?? []) {
    const record = asRecord(entry);
    const id = record === null ? null : asString(record["id"]);
    const text = record === null ? null : asString(record["text"]);
    if (id === null || text === null) {
      problems.push(`b4 noResult ${String(id)}: missing id/text`);
      continue;
    }
    noResults.push({ id, text });
  }
  if (positives.length === 0 || noResults.length === 0) {
    return {
      status: "NOT_RUN",
      exitCode: null,
      detail: `b4-search present but no queries were loadable (${positives.length} positive / ${noResults.length} no-result)`,
      lines,
      problems,
    };
  }

  /* ---- assembly through the PRODUCT code path + corpus shape honesty ---- */
  const snapshot: SearchSnapshot = { trees, materialVersions, annotations, returns, turns };
  const documents: SearchDocument[] = buildSearchDocuments(snapshot);
  const documentsByKind = new Map<string, number>();
  for (const document of documents) {
    documentsByKind.set(document.kind, (documentsByKind.get(document.kind) ?? 0) + 1);
  }
  const expectedDocumentsByKind = new Map<string, number>();
  for (const fact of facts) {
    expectedDocumentsByKind.set(fact.docKind, (expectedDocumentsByKind.get(fact.docKind) ?? 0) + 1);
  }
  // 每条种子事实必须恰好成为一个文档（空正文静默丢失 = 装配缺陷，FAIL）。
  for (const [kind, expected] of expectedDocumentsByKind) {
    if (documentsByKind.get(kind) !== expected) {
      problems.push(
        `b4 corpus: ${kind} documents ${String(documentsByKind.get(kind) ?? 0)} ≠ facts ${String(expected)} (assembly dropped facts)`,
      );
    }
  }
  lines.push(
    `corpus: ${String(facts.length)} frozen facts → ${String(documents.length)} documents via buildSearchDocuments ` +
      `(${[...documentsByKind.entries()].map(([k, n]) => `${k} x${String(n)}`).join(", ")})`,
  );

  /* ---- execution ---- */
  const engine = LocalSearchEngine.build(documents);
  const bodyByRefId = new Map(documents.map((doc) => [doc.refId, doc.body] as const));
  const factById = new Map(facts.map((fact) => [fact.factId, fact] as const));

  let inTop5 = 0;
  let worstRank = 0;
  let phraseTierOk = 0;
  for (const query of positives) {
    const target = factById.get(query.expectFactId);
    if (target === undefined) {
      problems.push(`b4 positive ${query.id}: expect target ${query.expectFactId} not in facts`);
      continue;
    }
    const hits = engine.search(query.text, { treeId: query.treeId });
    if (hits.length === 0) {
      problems.push(`b4 positive ${query.id} "${query.text}": zero hits (target ${query.expectFactId})`);
      continue;
    }
    if (query.treeId !== null) {
      for (const hit of hits) {
        if (hit.treeId !== query.treeId) {
          problems.push(`b4 positive ${query.id}: current-tree query leaked tree ${hit.treeId}`);
        }
      }
    }
    const targetRefId = target.refId;
    const top5 = hits.slice(0, 5);
    const rank = top5.findIndex((hit) => hit.refId === targetRefId);
    if (rank === -1) {
      problems.push(
        `b4 positive ${query.id} "${query.text}": target ${query.expectFactId} NOT in top-5 ` +
          `(top5=[${top5.map((hit) => hit.refId).join(", ")}])`,
      );
      lines.push(`b4 positive ${query.id}: MISS — target ${query.expectFactId} outside top-5`);
      continue;
    }
    inTop5 += 1;
    worstRank = Math.max(worstRank, rank + 1);
    const hit = top5[rank]!;
    if (hit.matchType !== "phrase") {
      problems.push(
        `b4 positive ${query.id}: target ${query.expectFactId} hit at ${hit.matchType} tier (frozen truth guarantees the substring ⇒ phrase)`,
      );
    } else {
      phraseTierOk += 1;
    }
    // 切片纪律：命中区间在装配正文内逐字等于查询（大小写折算后）。
    const body = bodyByRefId.get(targetRefId);
    if (body === undefined || body.slice(hit.start, hit.end).toLowerCase() !== query.text.trim().toLowerCase()) {
      problems.push(`b4 positive ${query.id}: hit span does not slice to the query text in ${query.expectFactId}`);
    }
    lines.push(
      `b4 positive ${query.id}: target ${query.expectFactId} at rank ${String(rank + 1)} ` +
        `(${hit.matchType}, x${String(hit.matchCount)}${query.treeId !== null ? `, scoped ${query.treeId}` : ""})`,
    );
  }

  let zeroHits = 0;
  for (const query of noResults) {
    const hits = engine.search(query.text);
    if (hits.length !== 0) {
      problems.push(
        `b4 no-result ${query.id} "${query.text}": ${String(hits.length)} hits fabricated (corpus does not contain it)`,
      );
      lines.push(`b4 no-result ${query.id}: FABRICATED ${String(hits.length)} hits`);
      continue;
    }
    zeroHits += 1;
    lines.push(`b4 no-result ${query.id} "${query.text}": zero hits — nothing fabricated`);
  }

  /* ---- verdict ---- */
  const charterFloor = 0.95;
  const floorOk = inTop5 / positives.length >= charterFloor;
  if (!floorOk) {
    problems.push(
      `b4 charter floor violated: only ${String(inTop5)}/${String(positives.length)} positives in top-5 (< 95%)`,
    );
  }
  // 冻结集 + 确定性引擎 ⇒ 当前实测全量命中；任何回退都显式失败，不允许静默降级。
  if (inTop5 !== positives.length) {
    problems.push(
      `b4 frozen regression: ${String(inTop5)}/${String(positives.length)} positives in top-5 (expected all)`,
    );
  }
  if (zeroHits !== noResults.length) {
    problems.push(
      `b4 frozen regression: ${String(zeroHits)}/${String(noResults.length)} no-result queries returned zero hits (expected all)`,
    );
  }
  const passed = problems.length === 0;
  const detail =
    `${String(inTop5)}/${String(positives.length)} positive queries hit their pre-specified target in the top-5 ` +
    `(worst rank ${String(worstRank)}; all phrase-tier; charter floor 95%); ` +
    `${String(zeroHits)}/${String(noResults.length)} no-result queries returned zero hits; ` +
    `corpus ${String(facts.length)} facts → ${String(documents.length)} documents via the product assembly path`;
  return {
    status: passed ? "PASS" : "FAIL",
    exitCode: passed ? 0 : 2,
    detail,
    lines,
    problems,
  };
}

export { runB4SearchCheck };
