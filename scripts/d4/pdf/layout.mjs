/**
 * D4 PDF fixture generator — page layout engine + the PINNED reading order.
 *
 * The reading order below is the single source of truth for d4-pdf-v1: it is
 * applied to the laid-out lines to produce the expected canonicalText, AND
 * re-implemented on the extraction side (scripts/d4/pdf/extract.mjs imports
 * this exact function), so the round-trip check verifies the PDF encodes what
 * the pinned rule says — never a private coincidence.
 *
 * ── d4-pdf-v1 pinned reading order ────────────────────────────────────────
 * 1. A "line" is one text-showing operation sequence drawing one visual line
 *    (the generator emits exactly one Tj per visual line, never split runs).
 *    Its position (x, y) is the text-matrix translation point (first glyph
 *    origin) at the time of the Tj.
 * 2. Column bands, per page: take the sorted set of distinct line x values
 *    and group them greedily — a new band starts when an x value exceeds the
 *    previous band's maximum x by MORE THAN 40 PDF points. A line belongs to
 *    the band containing its x. (Two-column layouts therefore emit the full
 *    left column, then the full right column.)
 * 3. Bands are read strictly left to right. Header and footer lines are just
 *    lines at the top/bottom of their band — no special ordering rule.
 * 4. Within a band, lines are read top to bottom (descending PDF y, which is
 *    bottom-origin), ties broken by ascending x, then by content-stream order.
 * 5. Page text = ordered lines joined with "\n"; every page block ends with
 *    "\n" except the last page's block. No Unicode normalization, ever.
 * ──────────────────────────────────────────────────────────────────────────
 */

import { assert } from "./util.mjs";
import { base14CharWidth, isWinAnsiEncodable } from "./textenc.mjs";

export const READING_ORDER_SPEC = [
  "1. A 'line' is one text-showing operation sequence drawing one visual line (the generator emits exactly one Tj per visual line, never split runs). Its position (x, y) is the text-matrix translation point (first glyph origin) at the time of the Tj.",
  "2. Column bands, per page: take the sorted set of distinct line x values and group them greedily - a new band starts when an x value exceeds the previous band's maximum x by MORE THAN 40 PDF points. A line belongs to the band containing its x. (Two-column layouts therefore emit the full left column, then the full right column.)",
  "3. Bands are read strictly left to right. Header and footer lines are just lines at the top/bottom of their band - no special ordering rule.",
  "4. Within a band, lines are read top to bottom (descending PDF y, which is bottom-origin), ties broken by ascending x, then by content-stream order.",
  "5. Page text = ordered lines joined with \\n; every page block ends with \\n except the last page's block. No Unicode normalization, ever.",
].join("\n");

export const BAND_GAP = 40; // PDF points

/** Order the lines of one page by the pinned reading order. */
export function orderPageLines(lines) {
  const xs = [...new Set(lines.map((l) => l.x))].sort((a, b) => a - b);
  const bands = [];
  let band = null;
  for (const x of xs) {
    if (band === null || x - band.maxX > BAND_GAP) {
      band = { minX: x, maxX: x };
      bands.push(band);
    } else if (x > band.maxX) {
      band.maxX = x;
    }
  }
  const bandIndexOf = (x) => {
    for (let i = 0; i < bands.length; i += 1) {
      if (x >= bands[i].minX && x <= bands[i].maxX) return i;
    }
    throw new Error(`x ${String(x)} not in any band`);
  };
  return [...lines].sort((a, b) => {
    const ba = bandIndexOf(a.x);
    const bb = bandIndexOf(b.x);
    if (ba !== bb) return ba - bb;
    if (a.y !== b.y) return b.y - a.y; // descending y (top first)
    if (a.x !== b.x) return a.x - b.x;
    return a.order - b.order;
  });
}

/* ---------------------------------------------------------------------- */
/* Text measuring + wrapping                                               */
/* ---------------------------------------------------------------------- */

const COMBINING = /[̀-ͯ]/; // U+0300..U+036F

function isBreakableChar(ch) {
  const cp = ch.codePointAt(0);
  return (
    (cp >= 0x2e80 && cp <= 0x9fff) || // CJK radicals..Yi (incl. CJK punct U+3000..303F)
    (cp >= 0xff00 && cp <= 0xff60) || // full-width forms
    (cp >= 0x20000 && cp <= 0x3fffd) // astral CJK (surrogate pairs)
  );
}

/** Split text into tokens: words (CJK chars are single-char words) + spaces. */
function tokenize(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === " ") {
      out.push({ t: " ", space: true });
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < text.length && COMBINING.test(text[j])) j += 1; // marks attach to the base char
    if (isBreakableChar(ch)) {
      out.push({ t: text.slice(i, j), space: false });
      i = j;
      continue;
    }
    while (j < text.length) {
      if (text[j] === " ") break;
      if (COMBINING.test(text[j])) {
        j += 1;
        continue;
      }
      if (isBreakableChar(text[j])) break;
      j += 1;
    }
    out.push({ t: text.slice(i, j), space: false });
    i = j;
  }
  return out;
}

/* ---------------------------------------------------------------------- */
/* Document layout                                                         */
/* ---------------------------------------------------------------------- */

const round2 = (v) => Number(v.toFixed(2));

export class LayoutDoc {
  /**
   * @param {object} opts
   * @param {Map<string,object>} opts.fonts  fontKey -> font spec:
   *   {kind:"cid", font: SfntFont} or {kind:"base", name:"Helvetica"|"Courier"}
   * @param {number[]} opts.mediaBox
   */
  constructor(opts) {
    this.fonts = opts.fonts;
    this.mediaBox = opts.mediaBox ?? [0, 0, 595.28, 841.89];
    this.marginLeft = opts.marginLeft ?? 72;
    this.marginRight = opts.marginRight ?? 72;
    this.topY = opts.topY ?? 780;
    this.bottomY = opts.bottomY ?? 72;
    this.textWidth = this.mediaBox[2] - this.marginLeft - this.marginRight;
    this.columns = [{ x: this.marginLeft, width: this.textWidth }];
    this.chrome = null; // {header?, footer?} — callbacks: (pageNo) => line spec | null
    this.pages = [];
    this.colIdx = 0;
    this.cursorY = this.topY;
    this._startPage();
  }

  _startPage() {
    this.pages.push({ lines: [], chrome: [] });
    this.colIdx = 0;
    this.cursorY = this.topY;
  }

  get _page() {
    return this.pages[this.pages.length - 1];
  }

  get _col() {
    return this.columns[this.colIdx];
  }

  setColumns(columns) {
    this.columns = columns;
    this.colIdx = 0;
    this.cursorY = this.topY;
  }

  /** Running header/footer: each callback gets the 1-based page number. */
  setChrome(chrome) {
    this.chrome = chrome;
  }

  _closePage() {
    const pageNo = this.pages.length;
    const page = this._page;
    if (this.chrome !== null) {
      for (const which of ["header", "footer"]) {
        const spec = this.chrome[which]?.(pageNo) ?? null;
        if (spec === null) continue;
        const width = this.measure(spec.text, spec.font, spec.size);
        const x = spec.align === "center" ? round2((this.mediaBox[2] - width) / 2) : spec.x ?? this.marginLeft;
        // Chrome lines join the page's line list with leading order values;
        // order only breaks (band, y, x) ties, which chrome never hits.
        page.chrome.push({ which, text: spec.text, font: spec.font, size: spec.size, x, y: spec.y, order: which === "header" ? -2 : -1 });
      }
    }
  }

  _advanceIfFull() {
    if (this.cursorY < this.bottomY) {
      if (this.colIdx + 1 < this.columns.length) {
        this.colIdx += 1;
        this.cursorY = this.topY;
      } else {
        this._closePage();
        this._startPage();
      }
    }
  }

  /** Measure text width in points for a registered font. */
  measure(text, fontKey, size) {
    const font = this.fonts.get(fontKey);
    assert(font !== undefined, `unknown font key: ${fontKey}`);
    if (font.kind === "base") {
      let units = 0;
      for (const ch of text) units += base14CharWidth(font.name, ch);
      return (units * size) / 1000;
    }
    // CID: per-glyph thousandths EXACTLY as they will appear in the PDF /W.
    let units = 0;
    for (const ch of text) {
      const gid = font.font.gidOf(ch.codePointAt(0));
      assert(gid !== 0, `${fontKey} lacks a glyph for ${JSON.stringify(ch)} (U+${ch.codePointAt(0).toString(16)})`);
      units += Math.round((font.font.advanceOf(gid) * 1000) / font.font.upem);
    }
    return (units * size) / 1000;
  }

  /** Greedy wrap into lines fitting maxWidth (points). */
  wrap(text, maxWidth, fontKey, size) {
    assert(!text.includes("\n"), "wrap() takes a single paragraph");
    const tokens = tokenize(text);
    const lines = [];
    let current = "";
    let width = 0;
    const flush = () => {
      lines.push(current.replace(/ +$/, ""));
      current = "";
      width = 0;
    };
    for (const tok of tokens) {
      if (tok.space) {
        if (current !== "") {
          current += " ";
          width += this.measure(" ", fontKey, size);
        }
        continue;
      }
      const w = this.measure(tok.t, fontKey, size);
      if (current === "" && w > maxWidth) {
        // Hard-split an over-long word by characters.
        let chunk = "";
        let chunkW = 0;
        for (const ch of tok.t) {
          const cw = this.measure(ch, fontKey, size);
          if (chunk !== "" && chunkW + cw > maxWidth) {
            lines.push(chunk);
            chunk = "";
            chunkW = 0;
          }
          chunk += ch;
          chunkW += cw;
        }
        current = chunk;
        width = chunkW;
        continue;
      }
      if (current !== "" && width + w > maxWidth) flush();
      if (current === "") {
        current = tok.t;
        width = w;
      } else {
        current += tok.t;
        width += w;
      }
    }
    if (current !== "") flush();
    return lines;
  }

  /** Place one unwrapped line at an explicit position. */
  placeLine(text, { font, size, x, y }) {
    const page = this._page;
    page.lines.push({ text, font, size, x: round2(x), y: round2(y), order: page.lines.length });
    this._validateText(text, font);
  }

  /** Every character of every line must be representable by its font. */
  _validateText(text, fontKey) {
    const spec = this.fonts.get(fontKey);
    assert(spec !== undefined, `unknown font key: ${fontKey}`);
    if (spec.kind === "base") {
      assert(isWinAnsiEncodable(text), `base-font line is not WinAnsi-encodable: ${JSON.stringify(text)}`);
    } else {
      for (const ch of text) {
        assert(spec.font.gidOf(ch.codePointAt(0)) !== 0,
          `font ${fontKey} lacks a glyph for ${JSON.stringify(ch)} (U+${ch.codePointAt(0).toString(16)})`);
      }
    }
  }

  /**
   * Flow a paragraph: wrap to the current column width, place lines.
   * @param {object} opts font, size, lineStep, indent (extra x, points),
   *   spaceAfter, spaceBefore
   */
  para(text, opts = {}) {
    const font = opts.font;
    const size = opts.size ?? 12;
    const lineStep = opts.lineStep ?? round2(size * 1.7);
    if (opts.spaceBefore !== undefined) this.vspace(opts.spaceBefore);
    const indent = opts.indent ?? 0;
    const col = this._col;
    const lines = this.wrap(text, col.width - indent, font, size);
    for (const line of lines) {
      this._advanceIfFull();
      this.placeLine(line, { font, size, x: col.x + indent, y: this.cursorY });
      this.cursorY -= lineStep;
    }
    if (opts.spaceAfter !== undefined) this.vspace(opts.spaceAfter);
  }

  /** Heading: same as para with defaults tuned for titles. */
  heading(text, opts = {}) {
    this.para(text, {
      font: opts.font,
      size: opts.size ?? 16,
      lineStep: opts.lineStep ?? round2((opts.size ?? 16) * 1.6),
      spaceBefore: opts.spaceBefore ?? 14,
      spaceAfter: opts.spaceAfter ?? 10,
    });
  }

  /** Code block: verbatim lines (no wrapping); entries may be {text, font, indent}. */
  codeBlock(entries, opts = {}) {
    const font = opts.font ?? "courier";
    const size = opts.size ?? 10;
    const lineStep = opts.lineStep ?? round2(size * 1.5);
    const col = this._col;
    for (const entry of entries) {
      const item = typeof entry === "string" ? { text: entry } : entry;
      const lineFont = item.font ?? font;
      const indent = item.indent ?? 0;
      this._advanceIfFull();
      this.placeLine(item.text, { font: lineFont, size, x: col.x + indent, y: this.cursorY });
      this.cursorY -= lineStep;
    }
    if (opts.spaceAfter !== undefined) this.vspace(opts.spaceAfter);
  }

  vspace(pts) {
    this.cursorY -= pts;
  }

  /** Explicit column break: next column on the same page, or a new page. */
  columnBreak() {
    if (this.colIdx + 1 < this.columns.length) {
      this.colIdx += 1;
      this.cursorY = this.topY;
    } else {
      this._closePage();
      this._startPage();
    }
  }

  pageBreak() {
    this._closePage();
    this._startPage();
  }

  /**
   * Finish: close the last page, compute expected canonical text/blocks and
   * collect per-font data for encoding + subsetting.
   */
  finish() {
    this._closePage();
    assert(this.pages.length > 0, "no pages laid out");
    assert(this.pages.every((p) => p.lines.length > 0 || p.chrome.length > 0), "empty page produced");
    const pages = this.pages.map((page) => {
      const all = [
        ...page.chrome,
        ...page.lines,
      ];
      return { mediaBox: this.mediaBox, lines: all };
    });
    const orderedPages = pages.map((p) => orderPageLines(p.lines));
    let canonicalText = "";
    const blocks = [];
    for (let i = 0; i < orderedPages.length; i += 1) {
      const text = orderedPages[i].map((l) => l.text).join("\n");
      const pageText = i < orderedPages.length - 1 ? `${text}\n` : text;
      blocks.push({
        blockId: `page-${String(i + 1)}`,
        kind: "pdf-page",
        start: canonicalText.length,
        end: canonicalText.length + pageText.length,
        page: i + 1,
        text: pageText,
      });
      canonicalText += pageText;
    }
    // Collect used code points per CID font across ALL lines.
    const usedCodepoints = new Map(); // fontKey -> Map<cp, char>
    for (const page of pages) {
      for (const line of page.lines) {
        const spec = this.fonts.get(line.font);
        if (spec.kind !== "cid") continue;
        let m = usedCodepoints.get(line.font);
        if (m === undefined) {
          m = new Map();
          usedCodepoints.set(line.font, m);
        }
        for (const ch of line.text) m.set(ch.codePointAt(0), ch);
      }
    }
    // Verify the W-array measurement rule holds for every placed line.
    for (const page of pages) {
      for (const line of page.lines) {
        const width = this.measure(line.text, line.font, line.size);
        const pageWidth = this.mediaBox[2];
        assert(line.x + width <= pageWidth + 0.01, `line overflows the page: ${JSON.stringify(line.text.slice(0, 30))} (x=${String(line.x)}, width=${width.toFixed(1)})`);
      }
    }
    return { pages, orderedPages, canonicalText, blocks, usedCodepoints };
  }
}

/* ---------------------------------------------------------------------- */
/* Selection helpers (B2 anchors)                                          */
/* ---------------------------------------------------------------------- */

/** 1-based nth occurrence of needle in text (UTF-16), or -1. */
export function nthOccurrence(text, needle, n) {
  assert(n >= 1, "occurrence is 1-based");
  let idx = -1;
  for (let i = 0; i < n; i += 1) {
    idx = text.indexOf(needle, idx + 1);
    if (idx < 0) return -1;
  }
  return idx;
}

/** Block containing [start, end) fully; throws if it spans blocks. */
export function blockContaining(blocks, start, end) {
  const hit = blocks.find((b) => start >= b.start && end <= b.end);
  assert(hit !== undefined, `range [${String(start)},${String(end)}) does not sit inside one block`);
  return hit;
}
