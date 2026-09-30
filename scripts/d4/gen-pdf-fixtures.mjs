#!/usr/bin/env node
/**
 * TreeAI D4-0 — deterministic PDF fixture generator (B1 text-layer PDFs +
 * B2 anchor selections + 4 committed negatives).
 *
 * Charter: docs/d4/D4-project-v1.md §6 B1/B2, §3.2 (anchors/precise source).
 * Contracts: docs/d4/D4-contracts.md §6 (frozen fixture layout, d4-pdf-v1
 * truth rules: page blocks contiguous in UTF-16 units, trailing "\n" on all
 * but the last page, NO Unicode normalization).
 *
 * ── d4-pdf-v1 pinned reading order (single source: scripts/d4/pdf/layout.mjs) ──
 * Lines are grouped into column bands by x position (a new band starts when
 * the x gap exceeds 40 pt — two-column pages emit the full left column, then
 * the full right column); bands are read left to right; within a band lines
 * are read top to bottom (descending PDF y), ties by ascending x then
 * content-stream order. Header/footer lines are ordinary lines. Page text =
 * ordered lines joined with "\n"; every page block ends with "\n" except the
 * last page's block.
 *
 * Zero npm dependencies (node:fs/node:crypto/node:zlib/node:path only).
 * CJK text embeds subsetted system TrueType fonts (original glyph IDs kept,
 * /CIDToGIDMap /Identity, sparse glyf/loca, rebuilt cmap, ToUnicode CMap,
 * W array from source hmtx); Latin text uses base-14 fonts with
 * WinAnsiEncoding. Determinism: fixed /Info dates, content-hash /ID —
 * running twice produces byte-identical output (verified below).
 *
 * Self-verification performed on every run, before anything is written:
 *   1. round-trip extraction (scripts/d4/pdf/extract.mjs re-parses each PDF
 *      and must reproduce expected.canonicalText EXACTLY, per page);
 *   2. structural sanity (every xref offset points at its object header);
 *   3. determinism (the whole output set is built twice and compared);
 *   4. selection truth (every start/end/excerpt/blockId computed from
 *      canonicalText and asserted, never hand-written);
 *   5. negatives behave (encrypted/corrupt refuse parsing; image-only and
 *      zero-text parse but yield zero text lines; the RC4 layer of the
 *      encrypted negative decrypts back to the plaintext content stream).
 *
 * Usage:
 *   node scripts/d4/gen-pdf-fixtures.mjs              # generate + all checks
 *   node scripts/d4/gen-pdf-fixtures.mjs --no-render  # skip the Chrome smoke
 *   node scripts/d4/gen-pdf-fixtures.mjs --out DIR    # alternate output root
 */

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { assert, sha256hex } from "./pdf/util.mjs";
import { SfntFont, buildSubset } from "./pdf/font.mjs";
import { LayoutDoc, orderPageLines, READING_ORDER_SPEC, nthOccurrence, blockContaining } from "./pdf/layout.mjs";
import { TextPdfBuilder, pdfHex, pdfLiteral } from "./pdf/pdfwriter.mjs";
import { winAnsiEncode } from "./pdf/textenc.mjs";
import { extractDocText, verifyXrefOffsets } from "./pdf/extract.mjs";
import { FIXTURES } from "./pdf/content.mjs";
import {
  buildEncryptedNegative,
  buildCorruptNegative,
  buildImageOnlyNegative,
  buildZeroTextNegative,
  buildGradientPng,
  rc4ObjectDecrypt,
} from "./pdf/negatives.mjs";
import { runRenderSmoke } from "./pdf/render-smoke.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(ROOT, "..");
const DEFAULT_OUT = join(REPO, "tests", "fixtures", "d4");
const FROZEN_AT = "2026-09-30";

const FONT_SOURCES = {
  songti: {
    path: "/System/Library/Fonts/Supplemental/Songti.ttc",
    ttcIndex: 0,
    family: "SongtiSC",
    tag: "SO",
  },
  stheiti: {
    path: "/System/Library/Fonts/STHeiti Light.ttc",
    ttcIndex: 0,
    family: "STHeitiLight",
    tag: "ST",
  },
  arialu: {
    path: "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    ttcIndex: 0,
    family: "ArialUnicode",
    tag: "AR",
  },
};

const BASE_FONTS = {
  helv: "Helvetica",
  "helv-bold": "Helvetica-Bold",
  courier: "Courier",
};

/* ---------------------------------------------------------------------- */
/* Build one fixture: layout -> subsets -> PDF bytes + expected truth       */
/* ---------------------------------------------------------------------- */

function buildFixture(fixture, sourceFonts, subsetCache) {
  const fonts = new Map();
  for (const key of fixture.fonts) {
    if (sourceFonts[key] !== undefined) fonts.set(key, { kind: "cid", font: sourceFonts[key] });
    else if (BASE_FONTS[key] !== undefined) fonts.set(key, { kind: "base", name: BASE_FONTS[key] });
    else throw new Error(`${fixture.id}: unknown font key ${key}`);
  }
  const doc = new LayoutDoc({ fonts, mediaBox: [0, 0, 595.28, 841.89] });
  fixture.build(doc);
  const layout = doc.finish();
  assert(layout.pages.length === fixture.expectPages,
    `${fixture.id}: expected ${String(fixture.expectPages)} pages, laid out ${String(layout.pages.length)} — adjust content`);

  // Per-CID-font subsets (cached across fixtures: same font + same codepoint
  // set reuses bytes; distinct sets produce distinct subsets).
  const subsets = new Map(); // fontKey -> subset descriptor
  for (const [key, cpText] of layout.usedCodepoints) {
    const source = sourceFonts[key];
    assert(source !== undefined, `${fixture.id}: CID font ${key} used but not loaded`);
    const cacheKey = `${key}|${[...cpText.keys()].sort((a, b) => a - b).join(",")}`;
    let subset = subsetCache.get(cacheKey);
    if (subset === undefined) {
      subset = buildSubset(source, cpText);
      subsetCache.set(cacheKey, subset);
    }
    subsets.set(key, subset);
  }

  // PDF assembly.
  const builder = new TextPdfBuilder({ title: fixture.title });
  const fixtureNum = fixture.id.slice(4); // "01".."12"
  for (const key of fixture.fonts) {
    if (BASE_FONTS[key] !== undefined) {
      builder.baseFont(key, BASE_FONTS[key]);
    }
  }
  for (const key of fixture.fonts) {
    if (BASE_FONTS[key] === undefined) {
      const subset = subsets.get(key);
      assert(subset !== undefined, `${fixture.id}: no subset for ${key}`);
      const baseName = `D4${fixtureNum}${FONT_SOURCES[key].tag}+${FONT_SOURCES[key].family}`;
      builder.cidFont(key, baseName, subset);
    }
  }
  // Encode each line: CID -> hex string of original GIDs (one 2-byte code per
  // CODE POINT — astral characters are a single CID despite being two UTF-16
  // units); base -> WinAnsi literal.
  const gidOf = (key, ch) => {
    const gid = sourceFonts[key].gidOf(ch.codePointAt(0));
    assert(gid !== 0, `${fixture.id}: ${key} has no glyph for ${JSON.stringify(ch)}`);
    return gid;
  };
  const encodedLines = layout.pages.map((page) =>
    page.lines.map((line) => {
      let encoded;
      if (BASE_FONTS[line.font] !== undefined) {
        encoded = pdfLiteral(winAnsiEncode(line.text));
      } else {
        const chars = [...line.text]; // code points, not UTF-16 units
        const bytes = Buffer.alloc(2 * chars.length);
        chars.forEach((ch, idx) => bytes.writeUInt16BE(gidOf(line.font, ch), idx * 2));
        encoded = pdfHex(bytes);
      }
      return { font: line.font, size: line.size, x: line.x, y: line.y, encoded };
    }),
  );
  for (let i = 0; i < layout.pages.length; i += 1) {
    builder.addPage(encodedLines[i], layout.pages[i].mediaBox);
  }
  const pdfBytes = builder.build();

  const expected = {
    fixtureId: fixture.id,
    kind: "pdf",
    normalizer: "d4-pdf-v1",
    pages: layout.pages.length,
    canonicalText: layout.canonicalText,
    blocks: layout.blocks.map((b) => ({
      blockId: b.blockId,
      kind: b.kind,
      start: b.start,
      end: b.end,
      page: b.page,
      text: b.text,
    })),
  };
  // d4-pdf-v1 truth rules, asserted at the source.
  assert(expected.canonicalText === expected.blocks.map((b) => b.text).join(""), `${fixture.id}: blocks do not join to canonicalText`);
  assert(expected.blocks[0].start === 0, `${fixture.id}: first block does not start at 0`);
  for (let i = 0; i + 1 < expected.blocks.length; i += 1) {
    assert(expected.blocks[i].end === expected.blocks[i + 1].start, `${fixture.id}: blocks are not contiguous`);
  }
  assert(expected.blocks[expected.blocks.length - 1].end === expected.canonicalText.length, `${fixture.id}: last block does not end at len`);
  for (let i = 0; i < expected.blocks.length; i += 1) {
    const isLast = i === expected.blocks.length - 1;
    assert(expected.blocks[i].text.endsWith("\n") === !isLast, `${fixture.id}: page ${String(i + 1)} block trailing-newline rule violated`);
  }
  return {
    fixture,
    pdfBytes,
    expected,
    layout,
    subsetStats: [...subsets.entries()].map(([key, s]) => ({
      fontKey: key,
      family: FONT_SOURCES[key].family,
      codePoints: s.codePoints,
      glyphs: s.glyphs,
      composites: s.composites,
      rawTtfBytes: s.ttf.length,
    })),
  };
}

/* ---------------------------------------------------------------------- */
/* B2 selections (30 frozen items, computed — never hand-written offsets)  */
/* ---------------------------------------------------------------------- */

function countOccurrences(text, needle) {
  let count = 0;
  let idx = text.indexOf(needle);
  while (idx >= 0) {
    count += 1;
    idx = text.indexOf(needle, idx + 1);
  }
  return count;
}

/** Locate the ordered page/line containing a canonicalText offset. */
function locateLineAt(layout, offset) {
  let pageIdx = layout.blocks.findIndex((b) => offset >= b.start && offset < b.end);
  if (pageIdx < 0) pageIdx = layout.blocks.length - 1;
  const lines = layout.orderedPages[pageIdx];
  let acc = layout.blocks[pageIdx].start;
  for (const line of lines) {
    const lineLen = line.text.length;
    if (offset < acc + lineLen + (line === lines[lines.length - 1] ? 0 : 1)) {
      return { pageIdx, line, lineStart: acc };
    }
    acc += lineLen + 1;
  }
  return { pageIdx, line: lines[lines.length - 1], lineStart: acc };
}

/** Derive a unique cross-line needle around the break between two lines. */
function crossLineNeedle(layout, pageIdx, lineIdx) {
  const lines = layout.orderedPages[pageIdx];
  assert(lineIdx + 1 < lines.length, `page ${String(pageIdx + 1)} line ${String(lineIdx)} has no successor line`);
  const a = lines[lineIdx].text;
  const b = lines[lineIdx + 1].text;
  const tail = (w) => a.slice(Math.max(0, a.length - w));
  const head = (w) => b.slice(0, Math.min(b.length, w));
  let w = 5;
  let needle = null;
  for (; w <= 24; w += 1) {
    const candidate = `${tail(w)}\n${head(w)}`;
    if (countOccurrences(layout.canonicalText, candidate) === 1 && !candidate.startsWith("\n") && !candidate.endsWith("\n")) {
      needle = candidate;
      break;
    }
  }
  assert(needle !== null, `could not derive a unique cross-line needle at page ${String(pageIdx + 1)} line ${String(lineIdx)}`);
  return needle;
}

/** Snap an offset onto a UTF-16 code-point boundary (never splits a pair). */
function snapForward(text, offset) {
  let o = offset;
  while (o > 0 && o < text.length) {
    const prev = text.charCodeAt(o - 1);
    if (prev >= 0xd800 && prev <= 0xdbff) o += 1;
    else break;
  }
  while (o < text.length) {
    const c = text.charCodeAt(o);
    if (c >= 0xdc00 && c <= 0xdfff) o += 1;
    else break;
  }
  return Math.min(o, text.length);
}

function buildSelections(built) {
  const byId = new Map(built.map((b) => [b.fixture.id, b]));
  let seq = 0;
  const items = [];

  const textOcc = (fixtureId, category, needle, occurrence, extra = {}) => {
    const b = byId.get(fixtureId);
    const text = b.expected.canonicalText;
    const start = nthOccurrence(text, needle, occurrence);
    assert(start >= 0, `${fixtureId}: needle ${JSON.stringify(needle)} occurrence ${String(occurrence)} not found`);
    const end = start + needle.length;
    const block = blockContaining(b.expected.blocks, start, end);
    const excerpt = text.slice(start, end);
    assert(excerpt === needle, "excerpt/needle mismatch");
    const located = locateLineAt(b.layout, start);
    if (extra.assertLine !== undefined) extra.assertLine(located, b);
    items.push({
      id: `pdf-sel-${String((seq += 1)).padStart(2, "0")}`,
      fixture: fixtureId,
      category,
      locator: { kind: "text-occurrence", needle, occurrence },
      expected: { blockId: block.blockId, start, end, excerpt },
    });
  };

  const crossLine = (fixtureId, pageIdx, lineIdx) => {
    const b = byId.get(fixtureId);
    const needle = crossLineNeedle(b.layout, pageIdx, lineIdx);
    const start = b.expected.canonicalText.indexOf(needle);
    const end = start + needle.length;
    const block = blockContaining(b.expected.blocks, start, end);
    items.push({
      id: `pdf-sel-${String((seq += 1)).padStart(2, "0")}`,
      fixture: fixtureId,
      category: "cross-line",
      locator: { kind: "text-occurrence", needle, occurrence: 1 },
      expected: { blockId: block.blockId, start, end, excerpt: b.expected.canonicalText.slice(start, end) },
    });
  };

  const utf16Range = (fixtureId, category, start, end, extra = {}) => {
    const b = byId.get(fixtureId);
    const text = b.expected.canonicalText;
    const s = snapForward(text, start);
    const e = snapForward(text, Math.max(s + 2, end));
    const block = blockContaining(b.expected.blocks, s, e);
    const excerpt = text.slice(s, e);
    assert(excerpt.length === e - s && e > s, "empty utf16 range");
    if (extra.expectedExcerpt !== undefined) assert(excerpt === extra.expectedExcerpt, `utf16-range excerpt is not the intended one: ${JSON.stringify(excerpt)}`);
    items.push({
      id: `pdf-sel-${String((seq += 1)).padStart(2, "0")}`,
      fixture: fixtureId,
      category,
      locator: { kind: "utf16-range", start: s, end: e },
      expected: { blockId: block.blockId, start: s, end: e, excerpt },
    });
  };

  const HEADER_TEXT = "问题分解手记 · 第 1 章 分解";

  /** Add a text-occurrence item whose occurrence is CHOSEN by a predicate over
   *  the located line (e.g. "the occurrence that is the page-3 footer"). */
  const textOccWhere = (fixtureId, category, needle, matches) => {
    const b = byId.get(fixtureId);
    const text = b.expected.canonicalText;
    let occurrence = 0;
    let start = -1;
    let located = null;
    let idx = text.indexOf(needle);
    while (idx >= 0) {
      occurrence += 1;
      const line = locateLineAt(b.layout, idx);
      if (matches(line, b)) {
        start = idx;
        located = line;
        break;
      }
      idx = text.indexOf(needle, idx + 1);
    }
    assert(start >= 0, `${fixtureId}: no occurrence of ${JSON.stringify(needle)} satisfies the predicate`);
    const end = start + needle.length;
    const block = blockContaining(b.expected.blocks, start, end);
    items.push({
      id: `pdf-sel-${String((seq += 1)).padStart(2, "0")}`,
      fixture: fixtureId,
      category,
      locator: { kind: "text-occurrence", needle, occurrence },
      expected: { blockId: block.blockId, start, end, excerpt: text.slice(start, end) },
    });
    return located;
  };

  /* 30 frozen selections, in id order. */
  textOcc("pdf-01", "zh", "递归", 1);
  crossLine("pdf-01", 0, 4);
  textOcc("pdf-02", "en", "stack overflow", 1);
  textOcc("pdf-02", "repeat-word-2nd", "stack", 3);
  crossLine("pdf-02", 0, 6);
  textOcc("pdf-03", "zh", "闭包", 1);
  textOcc("pdf-03", "en", "closure", 1);
  textOcc("pdf-03", "repeat-word-2nd", "closure", 2);
  textOcc("pdf-04", "code", "fibNaive", 1);
  textOcc("pdf-04", "code", "递归终止条件", 1);
  textOcc("pdf-05", "zh", "递归", 1);
  textOcc("pdf-05", "repeat-word-2nd", "递归", 2);
  textOcc("pdf-05", "repeat-word-2nd", "递归", 8);
  textOcc("pdf-06", "two-column-left", "自顶向下", 1, {
    assertLine: (loc) => assert(loc.line.x < 306, "two-column-left needle is not in the left band"),
  });
  textOcc("pdf-06", "two-column-right", "自底向上", 1, {
    assertLine: (loc) => assert(loc.line.x >= 312, "two-column-right needle is not in the right band"),
  });
  crossLine("pdf-06", 0, 3);
  textOcc("pdf-07", "header", HEADER_TEXT, 1, {
    assertLine: (loc) => assert(loc.line.y > 790, "header needle is not on a header line"),
  });
  textOcc("pdf-07", "repeat-word-2nd", HEADER_TEXT, 2, {
    assertLine: (loc) => assert(loc.line.y > 790 && loc.pageIdx === 1, "header second occurrence is not page 2's header"),
  });
  textOccWhere("pdf-07", "footer", "第 3 页", (loc, b) => loc.line.y < 60 && loc.pageIdx === 2);
  textOcc("pdf-08", "multipage", "手记完", 1, {
    assertLine: (loc, b) => assert(loc.pageIdx === b.layout.blocks.length - 1, "multipage needle is not on the last page"),
  });
  {
    const b = byId.get("pdf-08");
    const text = b.expected.canonicalText;
    const at = text.indexOf("十个章节不是十个孤岛");
    assert(at >= 0, "pdf-08 late needle missing");
    assert(at >= 0.8 * text.length, "pdf-08 late needle is not in the last 20%");
    textOcc("pdf-08", "long-tail", "十个章节不是十个孤岛", 1);
  }
  {
    const b = byId.get("pdf-08");
    const len = b.expected.canonicalText.length;
    utf16Range("pdf-08", "long-tail", Math.floor(len * 0.92), Math.floor(len * 0.92) + 16);
  }
  crossLine("pdf-11", 28, 2);
  textOcc("pdf-09", "unicode", "cafe\u0301", 1, {
    assertLine: () => {},
  });
  textOcc("pdf-09", "unicode", "ＡＢＣＤＥＦＧ", 1);
  textOcc("pdf-10", "fonts", "Font Sampler", 1);
  textOcc("pdf-11", "long-tail", "递归的三个检查点", 1, {
    assertLine: (loc, b) => assert(loc.pageIdx >= b.layout.blocks.length - 2, "long-tail needle is not on the last pages"),
  });
  textOcc("pdf-11", "long-tail", "长文样本至此收束", 1, {
    assertLine: (loc, b) => assert(loc.pageIdx === b.layout.blocks.length - 1, "closing needle is not on the last page"),
  });
  textOcc("pdf-12", "unicode", "𠀋𠀖𠀪𠀲𠁆", 1);
  {
    const b = byId.get("pdf-12");
    const text = b.expected.canonicalText;
    const anchor = text.indexOf("：𠀋");
    assert(anchor >= 0, "pdf-12 astral anchor missing");
    utf16Range("pdf-12", "unicode", anchor + 1, anchor + 7, { expectedExcerpt: "𠀋𠀖𠀪" });
  }

  assert(items.length === 30, `selections must total 30, got ${String(items.length)}`);

  // Mechanical category minimums (charter B2).
  const need = {
    "repeat-word-2nd": 4,
    "cross-line": 3,
    "long-tail": 3,
    unicode: 2,
    zh: 1,
    en: 1,
    code: 1,
    "two-column-left": 1,
    "two-column-right": 1,
    header: 1,
    footer: 1,
    multipage: 1,
  };
  for (const [cat, min] of Object.entries(need)) {
    const count = items.filter((i) => i.category === cat).length;
    assert(count >= min, `selection category ${cat} has ${String(count)} items, needs ${String(min)}`);
  }
  // Cross-line excerpts really cross a line; long-tail really is late;
  // repeat items really use occurrence >= 2.
  for (const item of items) {
    const b = byId.get(item.fixture);
    const text = b.expected.canonicalText;
    assert(text.slice(item.expected.start, item.expected.end) === item.expected.excerpt, `${item.id}: excerpt is not canonicalText.slice(start,end)`);
    const block = b.expected.blocks.find((bl) => bl.blockId === item.expected.blockId);
    assert(block !== undefined && item.expected.start >= block.start && item.expected.end <= block.end, `${item.id}: block containment violated`);
    if (item.category === "cross-line") assert(item.expected.excerpt.includes("\n"), `${item.id}: cross-line excerpt has no newline`);
    if (item.category === "long-tail") assert(item.expected.start >= 0.8 * text.length, `${item.id}: long-tail item sits before the last 20%`);
    if (item.category === "repeat-word-2nd") assert(item.locator.occurrence >= 2, `${item.id}: repeat-word-2nd must use occurrence >= 2`);
  }
  return { version: 1, frozenAt: FROZEN_AT, kind: "pdf", items };
}

/* ---------------------------------------------------------------------- */
/* Negatives                                                               */
/* ---------------------------------------------------------------------- */

function buildNegatives() {
  const encrypted = buildEncryptedNegative({
    title: "TreeAI negative: encrypted",
    bodyLines: [
      { text: "This page has a real text layer, but the document carries", y: 720 },
      { text: "a standard /Encrypt dictionary (RC4 128-bit, empty user", y: 700 },
      { text: "password). A text-layer importer must reject it.", y: 680 },
    ],
  });
  // Prove the encryption is real: object 4's stream decrypts to the content.
  const decrypted = rc4ObjectDecrypt(
    Buffer.from(/stream\n([\s\S]*)\nendstream/.exec(encrypted.bytes.toString("latin1"))[1], "latin1"),
    4,
    encrypted,
  );
  assert(decrypted.equals(encrypted.plainContent), "encrypted negative: RC4 round-trip failed");

  // A small valid text PDF as the corruption base (distinct from the 12
  // acceptance fixtures; deterministic, defined inline).
  const base = new TextPdfBuilder({ title: "TreeAI negative: corrupt base" });
  base.baseFont("helv", "Helvetica");
  const lines = [];
  for (let i = 0; i < 24; i += 1) {
    lines.push({ font: "helv", size: 11, x: 72, y: 760 - i * 24, encoded: pdfLiteral(winAnsiEncode(`corruption base line ${String(i)}: the quick brown fox jumps over the lazy dog`)) });
  }
  base.addPage(lines, [0, 0, 595.28, 841.89]);
  const corrupt = buildCorruptNegative(base.build());
  const imageOnly = buildImageOnlyNegative();
  const zeroText = buildZeroTextNegative();
  const png = buildGradientPng();
  return [
    {
      fixtureId: "neg-pdf-encrypted",
      bytes: encrypted.bytes,
      reason: "encrypted",
      detail: "Trailer carries /Encrypt (Standard security handler, V2/R3, RC4 128-bit, empty user password); strings and streams are genuinely encrypted (self-check: object 4 decrypts back to the plaintext content stream).",
    },
    {
      fixtureId: "neg-pdf-corrupt",
      bytes: corrupt,
      reason: "corrupt",
      detail: "Truncated at 70% of the pre-xref region and given a 512-byte deterministic garbage tail; no startxref/%%EOF is reachable.",
    },
    {
      fixtureId: "neg-pdf-image-only",
      bytes: imageOnly,
      reason: "no-text-layer",
      detail: "Single page whose only content is one 64x64 grayscale image XObject (hand-rolled PNG, Predictor 15); the content stream has zero text operators.",
    },
    {
      fixtureId: "neg-pdf-zero-text",
      bytes: zeroText,
      reason: "no-text-layer",
      detail: "Structurally valid single page whose content stream is empty (/Length 0).",
    },
  ];
}

/* ---------------------------------------------------------------------- */
/* Main                                                                    */
/* ---------------------------------------------------------------------- */

function buildAll() {
  const sourceFonts = {};
  for (const [key, spec] of Object.entries(FONT_SOURCES)) {
    assert(existsSync(spec.path), `system font missing: ${spec.path}`);
    sourceFonts[key] = SfntFont.load(spec.path, spec.ttcIndex);
  }
  const subsetCache = new Map();
  const built = FIXTURES.map((fixture) => buildFixture(fixture, sourceFonts, subsetCache));
  const negatives = buildNegatives();
  const selections = buildSelections(built);
  const registry = {
    kind: "pdf",
    fixtures: built.map((b) => ({
      fixtureId: b.fixture.id,
      file: `pdf/${b.fixture.id}.pdf`,
      expected: `pdf/${b.fixture.id}.expected.json`,
      outcome: "ready",
      pages: b.expected.pages,
      coverage: b.fixture.coverage,
    })),
    negativeFixtures: negatives.map((n) => ({
      fixtureId: n.fixtureId,
      file: `negative/${n.fixtureId}.pdf`,
      outcome: "rejected",
      reason: n.reason,
      coverage: ["negative"],
    })),
  };
  return { built, negatives, selections, registry, png: buildGradientPng().png };
}

/** Assemble the output file set in memory (path -> bytes). */
function outputSet(result) {
  const files = new Map();
  for (const b of result.built) {
    files.set(`b1-import/pdf/${b.fixture.id}.pdf`, b.pdfBytes);
    files.set(
      `b1-import/pdf/${b.fixture.id}.expected.json`,
      Buffer.from(`${JSON.stringify(b.expected, null, 2)}\n`, "utf8"),
    );
  }
  for (const n of result.negatives) {
    files.set(`b1-import/negative/${n.fixtureId}.pdf`, n.bytes);
    files.set(
      `b1-import/negative/${n.fixtureId}.json`,
      Buffer.from(
        `${JSON.stringify({ fixtureId: n.fixtureId, kind: "pdf", outcome: "rejected", reason: n.reason, detail: n.detail }, null, 2)}\n`,
        "utf8",
      ),
    );
  }
  files.set("b1-import/pdf-registry.json", Buffer.from(`${JSON.stringify(result.registry, null, 2)}\n`, "utf8"));
  files.set("b2-anchors/pdf-selections.json", Buffer.from(`${JSON.stringify(result.selections, null, 2)}\n`, "utf8"));
  return files;
}

async function main() {
  const args = process.argv.slice(2);
  const noRender = args.includes("--no-render");
  const outFlag = args.indexOf("--out");
  const outRoot = outFlag >= 0 ? args[outFlag + 1] : DEFAULT_OUT;

  console.log("D4 PDF fixture generator (d4-pdf-v1)");
  console.log(`node ${process.version}; fonts: ${Object.values(FONT_SOURCES).map((f) => f.path.split("/").pop()).join(", ")}`);

  // 1. Build everything (includes all layout-time and selection-time asserts).
  const t0 = Date.now();
  const result = buildAll();
  const files = outputSet(result);
  console.log(`built ${String(result.built.length)} fixtures + ${String(result.negatives.length)} negatives + selections in ${String(Date.now() - t0)}ms`);

  // 2. Determinism: rebuild from scratch and compare every byte.
  const result2 = buildAll();
  const files2 = outputSet(result2);
  assert(files.size === files2.size, "determinism: output set size changed");
  let identical = 0;
  for (const [path, bytes] of files) {
    const other = files2.get(path);
    assert(other !== undefined && other.equals(bytes), `determinism: ${path} differs between two builds`);
    identical += 1;
  }
  console.log(`determinism: ${String(identical)}/${String(files.size)} files byte-identical across two in-process builds`);

  // 3. Round-trip extraction + structural sanity for every fixture.
  for (const b of result.built) {
    console.log(`  round-trip ${b.fixture.id}…`);
    const xref = verifyXrefOffsets(b.pdfBytes);
    const extracted = extractDocText(b.pdfBytes);
    assert(extracted.pageCount === b.expected.pages, `${b.fixture.id}: page count mismatch after extraction`);
    for (let i = 0; i < extracted.pageTexts.length; i += 1) {
      const want = b.expected.blocks[i].text;
      const pageText = i < extracted.pageTexts.length - 1 ? `${extracted.pageTexts[i]}\n` : extracted.pageTexts[i];
      assert(pageText === want, `${b.fixture.id} page ${String(i + 1)}: extracted page text differs from expected`);
    }
    const rebuilt = extracted.pageTexts.map((t, i) => (i < extracted.pageTexts.length - 1 ? `${t}\n` : t)).join("");
    assert(rebuilt === b.expected.canonicalText, `${b.fixture.id}: extracted canonicalText differs`);
    b.roundTrip = { ok: true, pages: extracted.pageCount, objects: xref.objects };
  }
  console.log(`round-trip: ${String(result.built.length)}/${String(result.built.length)} fixtures extract to their expected canonicalText exactly`);

  // 4. Negative behavior.
  for (const n of result.negatives) {
    if (n.reason === "encrypted" || n.reason === "corrupt") {
      let threw = null;
      try {
        extractDocText(n.bytes);
      } catch (err) {
        threw = err.message;
      }
      assert(threw !== null, `${n.fixtureId}: parser unexpectedly accepted the file`);
      n.check = threw;
    } else {
      const extracted = extractDocText(n.bytes);
      assert(extracted.pageCount === 1 && extracted.pageTexts[0] === "", `${n.fixtureId}: expected zero text lines`);
      n.check = `parsed ok, 1 page, 0 text lines (${n.reason})`;
    }
  }
  console.log(`negatives: encrypted -> "${result.negatives[0].check.slice(0, 60)}"; corrupt -> "${result.negatives[1].check.slice(0, 60)}"; image-only/zero-text -> zero text lines`);

  // 5. Write outputs (idempotent: identical inputs rewrite identical bytes).
  for (const [relPath, bytes] of files) {
    const abs = join(outRoot, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, bytes);
  }
  console.log(`wrote ${String(files.size)} files under ${outRoot}`);

  // 6. Inventory + hashes (for REPORT.md).
  const inventory = result.built.map((b) => ({
    id: b.fixture.id,
    title: b.fixture.title,
    pages: b.expected.pages,
    coverage: b.fixture.coverage,
    pdfBytes: b.pdfBytes.length,
    sha256: sha256hex(b.pdfBytes),
    textUnits: b.expected.canonicalText.length,
    fonts: b.subsetStats,
  }));

  // 7. Render smoke test (best effort, headless Chrome via CDP).
  let render = { status: "skipped", detail: "--no-render" };
  if (!noRender) {
    try {
      render = await runRenderSmoke([
        join(outRoot, "b1-import/pdf/pdf-01.pdf"),
        join(outRoot, "b1-import/pdf/pdf-06.pdf"),
        join(outRoot, "b1-import/pdf/pdf-12.pdf"),
      ]);
    } catch (err) {
      render = { status: "error", detail: err instanceof Error ? err.message : String(err) };
    }
  }

  const summary = {
    readingOrderSpec: READING_ORDER_SPEC,
    generatedAt: "deterministic — see REPORT.md for the run log",
    fixtures: inventory,
    negatives: result.negatives.map((n) => ({ fixtureId: n.fixtureId, reason: n.reason, bytes: n.bytes.length, sha256: sha256hex(n.bytes), check: n.check })),
    selections: { count: result.selections.items.length, byCategory: result.selections.items.reduce((acc, i) => { acc[i.category] = (acc[i.category] ?? 0) + 1; return acc; }, {}) },
    determinism: { filesCompared: identical, byteIdentical: true },
    roundTrip: "all fixtures extract exactly",
    renderSmoke: render,
    gradientPng: { bytes: result.png.length, sha256: sha256hex(result.png) },
  };
  writeFileSync(join(dirname(fileURLToPath(import.meta.url)), "pdf", "run-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

  console.log("\nfixture inventory:");
  for (const f of inventory) {
    console.log(
      `  ${f.id}  ${String(f.pages).padStart(2)}p  ${String(f.pdfBytes).padStart(7)} B  ${String(f.textUnits).padStart(6)} u  ${f.coverage.join(",")}  ${f.sha256.slice(0, 16)}…`,
    );
  }
  console.log(`\nselections: ${String(summary.selections.count)} items; categories: ${JSON.stringify(summary.selections.byCategory)}`);
  console.log(`render smoke: ${render.status}${render.detail !== undefined ? ` — ${String(render.detail).slice(0, 200)}` : ""}`);
  console.log("\nOK: all self-checks passed.");
}

main().catch((err) => {
  console.error(`FAILED: ${err instanceof Error ? err.stack : String(err)}`);
  process.exitCode = 1;
});
