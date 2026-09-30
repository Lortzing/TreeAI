/**
 * Shared D4 fixtures-integrity verification (D4-0 wave, issue #8 charter §6).
 *
 * Used by THREE consumers so the gate cannot drift between them:
 *   - tests/unit/d4-fixtures-integrity.test.ts (granular assertions)
 *   - scripts/verify-d4.js  (check `fixtures-integrity-d4`)
 *   - scripts/verify-d4-selftest.js (injects defects and asserts this FAILS)
 *
 * The frozen sets and their formats are specified in
 * docs/d4/D4-contracts.md §6. Thresholds mirror the D4 项目书 §6 matrix
 * (B1/B2/B4 minimums) and are FROZEN together with the fixture set —
 * lowering any of them is a scope change requiring the owner, not an edit
 * here. Expected-file truth is hash-pinned by MANIFEST.sha256; this probe
 * re-validates structure, selection resolution, and query-target truth
 * mechanically (constructive 100% — hand-written offsets are never trusted).
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { scanText, sha256File } from "./secret-scanner.ts";

export interface D4FixturesStats {
  readonly hashedFiles: number;
  readonly mdFixtures: number;
  readonly pdfFixtures: number;
  readonly negativeFixtures: number;
  readonly versionPairs: number;
  readonly validSelections: number;
  readonly invalidSelections: number;
  readonly positiveQueries: number;
  readonly noResultQueries: number;
}

export interface D4FixturesResult {
  /** Empty = fully consistent. Any entry = the gate must FAIL. */
  readonly problems: string[];
  readonly stats: D4FixturesStats;
}

// --- frozen thresholds (D4 项目书 §6 B1/B2/B4) --------------------------

const MIN_MD_FIXTURES = 12;
const MIN_PDF_FIXTURES = 12;
const MIN_NEGATIVE_FIXTURES = 8;
const MIN_VALID_SELECTIONS_PER_KIND = 30;
const MIN_INVALID_SELECTIONS = 12;
const MIN_POSITIVE_QUERIES = 40;
const MIN_NO_RESULT_QUERIES = 10;

/** B2 charter coverage: 重复词第二处、跨行、Unicode、长文后段必须覆盖. */
const REQUIRED_SELECTION_CATEGORIES: ReadonlyArray<{
  match: ReadonlySet<string>;
  min: number;
  label: string;
}> = [
  { match: new Set(["repeat-word-2nd"]), min: 4, label: "repeat-word-2nd" },
  { match: new Set(["cross-line"]), min: 3, label: "cross-line" },
  {
    match: new Set(["unicode", "combining", "emoji", "astral", "full-width"]),
    min: 3,
    label: "unicode-family",
  },
  { match: new Set(["long-tail"]), min: 3, label: "long-tail" },
];

const MD_REQUIRED_COVERAGE = [
  "zh", "en", "code", "repeated-words", "emoji",
  "combining", "cross-line", "links", "long-tail",
] as const;
const PDF_REQUIRED_COVERAGE = [
  "zh", "en", "code", "repeated-words",
  "two-column", "header-footer", "long-tail",
] as const;

const EXPECTED_NORMALIZERS = new Set(["d4-md-v1", "d4-pdf-v1"]);
const BLOCK_KINDS = new Set(["markdown-block", "pdf-page"]);
const FACT_KINDS = new Set(["annotation", "return", "turn", "material-fragment"]);

// --- helpers ------------------------------------------------------------

interface Block {
  readonly blockId: string;
  readonly kind: string;
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly page?: number;
}

interface Expected {
  readonly fixtureId: string;
  readonly kind: string;
  readonly normalizer: string;
  readonly canonicalText: string;
  readonly blocks: readonly Block[];
}

interface RegistryFixture {
  readonly fixtureId: string;
  readonly file: string;
  readonly expected?: string;
  readonly outcome: string;
  readonly coverage?: readonly string[];
  readonly reason?: string;
}

interface Registry {
  readonly kind: string;
  readonly fixtures: readonly RegistryFixture[];
  readonly negativeFixtures: readonly RegistryFixture[];
  readonly versionPairs?: ReadonlyArray<Record<string, unknown>>;
}

function readJson(path: string, problems: string[], what: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (err) {
    problems.push(`${what}: unreadable/invalid JSON at ${path} (${String(err)})`);
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function listFilesRecursive(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(root, rel))) {
    const relPath = rel === "" ? name : `${rel}/${name}`;
    if (statSync(join(root, relPath)).isDirectory()) {
      out.push(...listFilesRecursive(root, relPath));
    } else {
      out.push(relPath);
    }
  }
  return out.sort();
}

/** 1-based nth occurrence of needle in text; null when absent. */
function nthOccurrence(text: string, needle: string, n: number): number | null {
  if (n < 1 || needle.length === 0) return null;
  let from = 0;
  for (let i = 0; i < n; i++) {
    const at = text.indexOf(needle, from);
    if (at === -1) return null;
    if (i === n - 1) return at;
    from = at + 1;
  }
  return null;
}

const boundaryCache = new Map<string, Set<number>>();

/** Offsets that fall on grapheme-cluster boundaries of text. */
function graphemeBoundaries(text: string): Set<number> {
  const cached = boundaryCache.get(text);
  if (cached !== undefined) return cached;
  const set = new Set<number>([0, text.length]);
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let pos = 0;
  for (const seg of segmenter.segment(text)) {
    pos += seg.segment.length;
    set.add(pos);
  }
  boundaryCache.set(text, set);
  return set;
}

function blockContaining(blocks: readonly Block[], start: number, end: number): Block | null {
  for (const b of blocks) {
    if (start >= b.start && end <= b.end) return b;
  }
  return null;
}

function loadExpected(
  path: string,
  problems: string[],
  fixtureId: string,
): Expected | null {
  if (!existsSync(path)) {
    problems.push(`b1: expected file missing for ${fixtureId}: ${path}`);
    return null;
  }
  const raw = asRecord(readJson(path, problems, `b1 expected ${fixtureId}`));
  if (raw === null) return null;
  const fixtureIdF = asString(raw["fixtureId"]);
  const kind = asString(raw["kind"]);
  const normalizer = asString(raw["normalizer"]);
  const canonicalText = asString(raw["canonicalText"]);
  const blocksRaw = asArray(raw["blocks"]);
  if (
    fixtureIdF === null || kind === null || normalizer === null ||
    canonicalText === null || blocksRaw === null
  ) {
    problems.push(`b1 expected ${fixtureId}: missing required field(s)`);
    return null;
  }
  if (!EXPECTED_NORMALIZERS.has(normalizer)) {
    problems.push(`b1 expected ${fixtureId}: unknown normalizer ${normalizer}`);
    return null;
  }
  const expectedKind = normalizer === "d4-md-v1" ? "markdown" : "pdf";
  if (kind !== expectedKind) {
    problems.push(`b1 expected ${fixtureId}: kind ${kind} ≠ normalizer ${normalizer}`);
    return null;
  }
  const blocks: Block[] = [];
  for (const b of blocksRaw) {
    const r = asRecord(b);
    if (r === null) {
      problems.push(`b1 expected ${fixtureId}: non-object block`);
      return null;
    }
    const blockId = asString(r["blockId"]);
    const bkind = asString(r["kind"]);
    const start = r["start"];
    const end = r["end"];
    const text = asString(r["text"]);
    if (
      blockId === null || bkind === null || text === null ||
      typeof start !== "number" || typeof end !== "number"
    ) {
      problems.push(`b1 expected ${fixtureId}: malformed block entry`);
      return null;
    }
    if (!BLOCK_KINDS.has(bkind)) {
      problems.push(`b1 expected ${fixtureId}: unknown block kind ${bkind}`);
      return null;
    }
    if (bkind === "pdf-page" && typeof r["page"] !== "number") {
      problems.push(`b1 expected ${fixtureId}: pdf-page block without page number`);
      return null;
    }
    blocks.push({ blockId, kind: bkind, start, end, text });
  }
  const expected: Expected = { fixtureId: fixtureIdF, kind, normalizer, canonicalText, blocks };
  validateExpectedStructure(expected, problems);
  return expected;
}

function validateExpectedStructure(e: Expected, problems: string[]): void {
  const tag = `b1 expected ${e.fixtureId}`;
  if (e.canonicalText.length === 0) {
    problems.push(`${tag}: empty canonicalText`);
  }
  if (e.blocks.length === 0) {
    problems.push(`${tag}: no blocks`);
    return;
  }
  const joined = e.blocks.map((b) => b.text).join("");
  if (joined !== e.canonicalText) {
    problems.push(`${tag}: blocks do not join to canonicalText`);
  }
  let cursor = 0;
  const seenIds = new Set<string>();
  for (let i = 0; i < e.blocks.length; i++) {
    const b = e.blocks[i]!;
    if (b.start !== cursor) {
      problems.push(`${tag}: block ${b.blockId} start ${b.start} ≠ expected ${cursor}`);
    }
    if (b.end !== b.start + b.text.length) {
      problems.push(`${tag}: block ${b.blockId} end does not match start+text length`);
    }
    cursor = b.end;
    if (seenIds.has(b.blockId)) {
      problems.push(`${tag}: duplicate blockId ${b.blockId}`);
    }
    seenIds.add(b.blockId);
    const isLast = i === e.blocks.length - 1;
    const trailing = e.kind === "markdown" ? "\n\n" : "\n";
    if (!isLast && !b.text.endsWith(trailing)) {
      problems.push(
        `${tag}: non-final block ${b.blockId} must end with ${JSON.stringify(trailing)}`,
      );
    }
  }
  if (cursor !== e.canonicalText.length) {
    problems.push(`${tag}: blocks cover ${cursor} units, canonicalText is ${e.canonicalText.length}`);
  }
}

// --- main entry ---------------------------------------------------------

export function verifyD4FixturesIntegrity(d4Root: string): D4FixturesResult {
  const problems: string[] = [];
  const stats: {
    hashedFiles: number; mdFixtures: number; pdfFixtures: number;
    negativeFixtures: number; versionPairs: number;
    validSelections: number; invalidSelections: number;
    positiveQueries: number; noResultQueries: number;
  } = {
    hashedFiles: 0, mdFixtures: 0, pdfFixtures: 0, negativeFixtures: 0,
    versionPairs: 0, validSelections: 0, invalidSelections: 0,
    positiveQueries: 0, noResultQueries: 0,
  };

  // 1. hash manifest ------------------------------------------------------
  const manifestPath = join(d4Root, "MANIFEST.sha256");
  try {
    const entries = new Map<string, string>();
    for (const line of readFileSync(manifestPath, "utf8").split("\n")) {
      if (line.trim().length === 0) continue;
      const m = /^([0-9a-f]{64})  (.+)$/.exec(line);
      if (m === null) {
        problems.push(`malformed MANIFEST.sha256 line: ${line.slice(0, 80)}`);
        continue;
      }
      entries.set(m[2]!, m[1]!);
    }
    const filesOnDisk = listFilesRecursive(d4Root).filter((f) => f !== "MANIFEST.sha256");
    stats.hashedFiles = filesOnDisk.length;
    const manifestKeys = [...entries.keys()].sort();
    if (JSON.stringify(manifestKeys) !== JSON.stringify(filesOnDisk)) {
      problems.push("MANIFEST.sha256 and the D4 fixture tree diverged (added/removed/renamed file)");
    }
    for (const [rel, expectedHash] of entries) {
      try {
        if (sha256File(join(d4Root, rel)) !== expectedHash) {
          problems.push(`fixture ${rel} hash mismatch (tampered)`);
        }
      } catch {
        problems.push(`fixture ${rel} listed in manifest but unreadable`);
      }
    }
  } catch {
    problems.push("MANIFEST.sha256 missing or unreadable");
  }

  // 2. assembled top manifest ---------------------------------------------
  const topManifest = asRecord(
    readJson(join(d4Root, "manifest.json"), problems, "d4 manifest.json"),
  );
  if (topManifest !== null) {
    if (topManifest["version"] !== 1) problems.push("d4 manifest.json: version must be 1");
    if (typeof topManifest["frozenAt"] !== "string") {
      problems.push("d4 manifest.json: frozenAt missing");
    }
    const sets = asRecord(topManifest["sets"]);
    if (sets === null) {
      problems.push("d4 manifest.json: sets object missing");
    } else {
      const b1 = asRecord(sets["b1-import"]);
      if (b1 === null) {
        problems.push("d4 manifest.json: sets.b1-import missing");
      } else {
        const oversize = asArray(b1["generatedOversize"]);
        if (oversize === null || oversize.length < 3) {
          problems.push("d4 manifest.json: sets.b1-import.generatedOversize must document ≥3 probes");
        }
      }
      for (const key of ["b2-anchors", "b4-search", "b6-scale", "b9-nav"]) {
        if (sets[key] === undefined) {
          problems.push(`d4 manifest.json: sets.${key} missing`);
        }
      }
    }
  }

  // 3. registries ----------------------------------------------------------
  const registries: Registry[] = [];
  for (const name of ["md-registry.json", "pdf-registry.json"]) {
    const raw = asRecord(readJson(join(d4Root, "b1-import", name), problems, `b1 ${name}`));
    if (raw === null) continue;
    const kind = asString(raw["kind"]) ?? "?";
    const fixturesRaw = asArray(raw["fixtures"]) ?? [];
    const negativesRaw = asArray(raw["negativeFixtures"]) ?? [];
    const fixtures: RegistryFixture[] = [];
    for (const f of fixturesRaw) {
      const r = asRecord(f);
      if (r === null) { problems.push(`${name}: non-object fixture entry`); continue; }
      const fixtureId = asString(r["fixtureId"]);
      const file = asString(r["file"]);
      const outcome = asString(r["outcome"]);
      if (fixtureId === null || file === null || outcome === null) {
        problems.push(`${name}: fixture entry missing fixtureId/file/outcome`);
        continue;
      }
      if (!existsSync(join(d4Root, "b1-import", file))) {
        problems.push(`${name}: fixture file missing on disk: ${file}`);
      }
      const expected = asString(r["expected"]);
      if (outcome === "ready" && expected === null) {
        problems.push(`${name}: ready fixture ${fixtureId} without expected file`);
      }
      fixtures.push({
        fixtureId, file, outcome, expected: expected ?? undefined,
        coverage: (asArray(r["coverage"]) ?? []).filter((c): c is string => typeof c === "string"),
        reason: asString(r["reason"]) ?? undefined,
      });
    }
    const negatives: RegistryFixture[] = [];
    for (const f of negativesRaw) {
      const r = asRecord(f);
      if (r === null) { problems.push(`${name}: non-object negative entry`); continue; }
      const fixtureId = asString(r["fixtureId"]);
      const file = asString(r["file"]);
      const reason = asString(r["reason"]);
      if (fixtureId === null || file === null || reason === null) {
        problems.push(`${name}: negative entry missing fixtureId/file/reason`);
        continue;
      }
      if (!existsSync(join(d4Root, "b1-import", file))) {
        problems.push(`${name}: negative file missing on disk: ${file}`);
      }
      negatives.push({ fixtureId, file, outcome: "rejected", reason });
    }
    stats.mdFixtures += kind === "markdown" ? fixtures.length : 0;
    stats.pdfFixtures += kind === "pdf" ? fixtures.length : 0;
    stats.negativeFixtures += negatives.length;
    const pairsRaw = asArray(raw["versionPairs"]) ?? [];
    stats.versionPairs += pairsRaw.length;
    registries.push({ kind, fixtures, negativeFixtures: negatives, versionPairs: pairsRaw.map((p) => asRecord(p) ?? {}) });
  }
  if (stats.mdFixtures < MIN_MD_FIXTURES) {
    problems.push(`b1: markdown fixtures ${stats.mdFixtures} < ${MIN_MD_FIXTURES}`);
  }
  if (stats.pdfFixtures < MIN_PDF_FIXTURES) {
    problems.push(`b1: pdf fixtures ${stats.pdfFixtures} < ${MIN_PDF_FIXTURES}`);
  }
  if (stats.negativeFixtures < MIN_NEGATIVE_FIXTURES) {
    problems.push(`b1: negative fixtures ${stats.negativeFixtures} < ${MIN_NEGATIVE_FIXTURES}`);
  }
  if (stats.versionPairs < 1) {
    problems.push("b1: no version pair registered (required for 改版/stale-anchor tests)");
  }

  // coverage tags across the B1 set
  const coverage = new Set<string>();
  for (const reg of registries) {
    for (const f of reg.fixtures) for (const c of f.coverage ?? []) coverage.add(c);
  }
  const requiredByKind = (kind: string): readonly string[] =>
    kind === "markdown" ? MD_REQUIRED_COVERAGE : PDF_REQUIRED_COVERAGE;
  for (const reg of registries) {
    if (reg.kind !== "markdown" && reg.kind !== "pdf") continue;
    const own = new Set<string>();
    for (const f of reg.fixtures) for (const c of f.coverage ?? []) own.add(c);
    for (const req of requiredByKind(reg.kind)) {
      if (!own.has(req)) {
        problems.push(`b1 ${reg.kind}: required coverage tag missing: ${req}`);
      }
    }
  }
  for (const req of ["zh", "en", "code", "repeated-words"]) {
    if (!coverage.has(req)) problems.push(`b1: charter coverage tag missing across set: ${req}`);
  }

  // load expected truth for all ready fixtures
  const expectedById = new Map<string, Expected>();
  for (const reg of registries) {
    for (const f of reg.fixtures) {
      if (f.outcome !== "ready" || f.expected === undefined) continue;
      const exp = loadExpected(join(d4Root, "b1-import", f.expected), problems, f.fixtureId);
      if (exp !== null) {
        if (exp.fixtureId !== f.fixtureId) {
          problems.push(`b1: expected.fixtureId ${exp.fixtureId} ≠ registry ${f.fixtureId}`);
        }
        expectedById.set(f.fixtureId, exp);
      }
    }
  }

  // 4. version pair structure ---------------------------------------------
  for (const reg of registries) {
    for (const pair of reg.versionPairs ?? []) {
      const v1 = asString(pair["v1Expected"]);
      const v2 = asString(pair["v2Expected"]);
      const materialKey = asString(pair["materialKey"]) ?? "?";
      if (v1 === null || v2 === null) {
        problems.push(`b1 version pair ${materialKey}: v1Expected/v2Expected missing`);
        continue;
      }
      const e1 = loadExpected(join(d4Root, "b1-import", v1), problems, `${materialKey}-v1`);
      const e2 = loadExpected(join(d4Root, "b1-import", v2), problems, `${materialKey}-v2`);
      if (e1 === null || e2 === null) continue;
      if (e1.canonicalText === e2.canonicalText) {
        problems.push(`b1 version pair ${materialKey}: v1 and v2 canonical texts are identical`);
        continue;
      }
      const t1 = e1.blocks.map((b) => b.text);
      const t2 = e2.blocks.map((b) => b.text);
      let prefix = 0;
      while (prefix < t1.length && prefix < t2.length && t1[prefix] === t2[prefix]) prefix++;
      let suffix = 0;
      while (
        suffix < t1.length - prefix && suffix < t2.length - prefix &&
        t1[t1.length - 1 - suffix] === t2[t2.length - 1 - suffix]
      ) suffix++;
      if (prefix < 2 || suffix < 2) {
        problems.push(
          `b1 version pair ${materialKey}: shared prefix/suffix blocks ${prefix}/${suffix} < 2`,
        );
      }
    }
  }

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

  // 8. scale specs -----------------------------------------------------------
  const b6 = asRecord(readJson(join(d4Root, "b6-scale", "spec.json"), problems, "b6 spec"));
  if (b6 !== null) {
    const b6Dataset = asRecord(b6["dataset"]) ?? b6;
    const materials = asRecord(b6Dataset["materials"]);
    const facts = asRecord(b6Dataset["savedFacts"]);
    const branches = asRecord(b6Dataset["branches"]);
    if (materials === null || facts === null || branches === null) {
      problems.push("b6 spec: materials/savedFacts/branches sections missing");
    } else {
      if ((materials["count"] as number) < 100) problems.push("b6 spec: materials.count < 100");
      if ((materials["totalCanonicalTextUnits"] as number) < 1_000_000) {
        problems.push("b6 spec: totalCanonicalTextUnits < 1,000,000");
      }
      if ((facts["count"] as number) < 10_000) problems.push("b6 spec: savedFacts.count < 10,000");
      if ((branches["count"] as number) < 1000) problems.push("b6 spec: branches.count < 1000");
    }
    const det = asRecord(b6["determinism"]);
    if (det === null || typeof det["seed"] !== "string") {
      problems.push("b6 spec: determinism.seed missing");
    }
  }
  const b9 = asRecord(readJson(join(d4Root, "b9-nav", "spec.json"), problems, "b9 spec"));
  if (b9 !== null) {
    const b9Dataset = asRecord(b9["dataset"]) ?? b9;
    const trees = asRecord(b9Dataset["trees"]);
    if (trees === null) {
      problems.push("b9 spec: trees section missing");
    } else {
      if ((trees["count"] as number) < 100) problems.push("b9 spec: trees.count < 100");
      if ((trees["totalBranches"] as number) < 10_000) {
        problems.push("b9 spec: totalBranches < 10,000");
      }
      const special = JSON.stringify(asArray(trees["specialTrees"]) ?? []);
      for (const needle of ["5000", "100", "宽树"]) {
        if (!special.includes(needle)) {
          problems.push(`b9 spec: specialTrees does not mention ${needle}`);
        }
      }
    }
    const det = asRecord(b9["determinism"]);
    if (det === null || typeof det["seed"] !== "string") {
      problems.push("b9 spec: determinism.seed missing");
    }
  }

  // 9. secret scan over text fixtures ---------------------------------------
  for (const rel of listFilesRecursive(d4Root)) {
    if (!/\.(json|md|txt)$/.test(rel)) continue;
    const text = readFileSync(join(d4Root, rel), "utf8");
    for (const finding of scanText(text, rel)) {
      problems.push(`secret-scan: ${rel}: ${finding.ruleId}`);
    }
  }

  return { problems, stats };
}

function findMaterialFragmentText(
  factsRaw: Record<string, unknown>,
  factId: string,
  expectedById: ReadonlyMap<string, Expected>,
): string | null {
  for (const treeRaw of asArray(factsRaw["trees"]) ?? []) {
    const tree = asRecord(treeRaw);
    if (tree === null) continue;
    for (const factRaw of asArray(tree["facts"]) ?? []) {
      const fact = asRecord(factRaw);
      if (fact === null || fact["factId"] !== factId) continue;
      const ref = asString(fact["materialKey"]);
      const exp = ref === null ? undefined : expectedById.get(ref);
      return exp?.canonicalText ?? null;
    }
  }
  return null;
}
