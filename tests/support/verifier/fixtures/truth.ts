import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';



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

export const MIN_MD_FIXTURES = 12;

export const MIN_PDF_FIXTURES = 12;

export const MIN_NEGATIVE_FIXTURES = 8;

export const MIN_VALID_SELECTIONS_PER_KIND = 30;

export const MIN_INVALID_SELECTIONS = 12;

export const MIN_POSITIVE_QUERIES = 40;

export const MIN_NO_RESULT_QUERIES = 10;


/** B2 charter coverage: 重复词第二处、跨行、Unicode、长文后段必须覆盖. */
export const REQUIRED_SELECTION_CATEGORIES: ReadonlyArray<{
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


export const MD_REQUIRED_COVERAGE = [
  "zh", "en", "code", "repeated-words", "emoji",
  "combining", "cross-line", "links", "long-tail",
] as const;

export const PDF_REQUIRED_COVERAGE = [
  "zh", "en", "code", "repeated-words",
  "two-column", "header-footer", "long-tail",
] as const;


export const EXPECTED_NORMALIZERS = new Set(["d4-md-v1", "d4-pdf-v1"]);

export const BLOCK_KINDS = new Set(["markdown-block", "pdf-page"]);

export const FACT_KINDS = new Set(["annotation", "return", "turn", "material-fragment"]);


// --- helpers ------------------------------------------------------------

export interface Block {
  readonly blockId: string;
  readonly kind: string;
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly page?: number;
}


export interface Expected {
  readonly fixtureId: string;
  readonly kind: string;
  readonly normalizer: string;
  readonly canonicalText: string;
  readonly blocks: readonly Block[];
}


export interface RegistryFixture {
  readonly fixtureId: string;
  readonly file: string;
  readonly expected?: string;
  readonly outcome: string;
  readonly coverage?: readonly string[];
  readonly reason?: string;
}


export interface Registry {
  readonly kind: string;
  readonly fixtures: readonly RegistryFixture[];
  readonly negativeFixtures: readonly RegistryFixture[];
  readonly versionPairs?: ReadonlyArray<Record<string, unknown>>;
}


export function readJson(path: string, problems: string[], what: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (err) {
    problems.push(`${what}: unreadable/invalid JSON at ${path} (${String(err)})`);
    return null;
  }
}


export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}


export function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}


export function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}


export function listFilesRecursive(root: string, rel = ""): string[] {
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
export function nthOccurrence(text: string, needle: string, n: number): number | null {
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


export const boundaryCache = new Map<string, Set<number>>();


/** Offsets that fall on grapheme-cluster boundaries of text. */
export function graphemeBoundaries(text: string): Set<number> {
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


export function blockContaining(blocks: readonly Block[], start: number, end: number): Block | null {
  for (const b of blocks) {
    if (start >= b.start && end <= b.end) return b;
  }
  return null;
}


export function loadExpected(
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


export function validateExpectedStructure(e: Expected, problems: string[]): void {
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


export function findMaterialFragmentText(
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
