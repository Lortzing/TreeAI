/**
 * D4 PDF fixture generator — TrueType/TTC font loading and subsetting.
 *
 * Zero npm deps: reads a system .ttc/.ttf with node:fs and rebuilds a minimal
 * valid TrueType subset suitable for /FontFile2 embedding in a
 * /CIDFontType2 descendant font.
 *
 * Subset strategy (pinned in scripts/d4/pdf/REPORT.md and gen-pdf-fixtures.mjs):
 *   - original glyph IDs are KEPT (no renumbering); /CIDToGIDMap /Identity in
 *     the PDF, and the Tj hex codes are therefore the original glyph IDs;
 *   - loca is rebuilt sparsely: unused glyph slots become zero-length entries,
 *     glyf holds only the used glyphs (plus components of composites,
 *     recursively), laid out in ascending original-GID order;
 *   - maxp.numGlyphs is truncated to maxUsedGid+1 (glyph IDs stay valid);
 *   - hmtx keeps its original semantics (numberOfHMetrics copied or clamped),
 *     so every retained glyph keeps its true advance width;
 *   - cmap is rebuilt as one (3,1) format-4 subtable mapping only the used
 *     code points to their original GIDs (constant-delta runs merged);
 *   - head/hhea/maxp are copied (indexToLocFormat forced to 1 = long loca);
 *     cvt/fpgm/prep are copied when present (hinting programs stay coherent);
 *   - table checksums and head.checkSumAdjustment are computed correctly.
 */

import { readFileSync } from "node:fs";
import { ByteWriter, assert, checksumBytes } from "./util.mjs";

const KEEP_OPTIONAL = ["cvt ", "fpgm", "prep"];

export class SfntFont {
  constructor(buf, tableMap, header) {
    this.buf = buf;
    this.tables = tableMap; // tag -> {offset, length}
    Object.assign(this, header);
  }

  static load(path, ttcIndex = 0) {
    const buf = readFileSync(path);
    if (buf.subarray(0, 4).toString("latin1") === "ttcf") {
      const numFonts = buf.readUInt32BE(8);
      assert(ttcIndex < numFonts, `ttc index ${String(ttcIndex)} out of range (${String(numFonts)} fonts in ${path})`);
      return SfntFont._fromOffset(buf, buf.readUInt32BE(12 + 4 * ttcIndex), path);
    }
    return SfntFont._fromOffset(buf, 0, path);
  }

  static _fromOffset(buf, off, path) {
    assert(buf.readUInt32BE(off) === 0x00010000, `not a TrueType sfnt: ${path}`);
    const numTabs = buf.readUInt16BE(off + 4);
    const tableMap = new Map();
    for (let i = 0; i < numTabs; i += 1) {
      const rec = off + 12 + 16 * i;
      tableMap.set(buf.subarray(rec, rec + 4).toString("latin1"), {
        offset: buf.readUInt32BE(rec + 8),
        length: buf.readUInt32BE(rec + 12),
      });
    }
    const head = tableMap.get("head");
    const hhea = tableMap.get("hhea");
    const maxp = tableMap.get("maxp");
    const hmtx = tableMap.get("hmtx");
    assert(head && hhea && maxp && hmtx && tableMap.get("glyf") && tableMap.get("loca") && tableMap.get("cmap"),
      `font misses a required table in ${path}: ${[...tableMap.keys()].join(" ")}`);
    const upem = buf.readUInt16BE(head.offset + 18);
    const font = new SfntFont(buf, tableMap, {
      path,
      upem: upem === 0 ? 1000 : upem,
      indexToLocFormat: buf.readUInt16BE(head.offset + 50),
      numGlyphs: buf.readUInt16BE(maxp.offset + 4),
      numHMetrics: buf.readUInt16BE(hhea.offset + 34),
      ascent: buf.readInt16BE(hhea.offset + 4),
      descent: buf.readInt16BE(hhea.offset + 6),
      bbox: [
        buf.readInt16BE(head.offset + 36),
        buf.readInt16BE(head.offset + 38),
        buf.readInt16BE(head.offset + 40),
        buf.readInt16BE(head.offset + 42),
      ],
      capHeight: null,
    });
    const os2 = tableMap.get("OS/2");
    if (os2 !== undefined && os2.length >= 90 && buf.readUInt16BE(os2.offset) >= 2) {
      font.capHeight = buf.readInt16BE(os2.offset + 88);
    }
    font._cmapSubtables = font._loadCmapSubtables();
    return font;
  }

  _loadCmapSubtables() {
    const { buf, tables } = this;
    const cmap = tables.get("cmap").offset;
    const n = buf.readUInt16BE(cmap + 2);
    const subs = [];
    for (let i = 0; i < n; i += 1) {
      const platform = buf.readUInt16BE(cmap + 4 + 8 * i);
      const encoding = buf.readUInt16BE(cmap + 6 + 8 * i);
      const offset = buf.readUInt32BE(cmap + 8 + 8 * i);
      const format = buf.readUInt16BE(cmap + offset);
      // (3,10) then (0,x) then (3,1): Unicode-capable subtables we can read.
      if (format === 4 || format === 12) subs.push({ platform, encoding, format, abs: cmap + offset });
    }
    // Prefer format 12 (UCS-4, astral-capable) over format 4.
    subs.sort((a, b) => (b.format === 12 ? 1 : 0) - (a.format === 12 ? 1 : 0));
    return subs;
  }

  /** Unicode code point -> original glyph ID (0 = missing). */
  gidOf(cp) {
    const { buf } = this;
    for (const sub of this._cmapSubtables) {
      if (sub.format === 12) {
        const o = sub.abs;
        const nGroups = buf.readUInt32BE(o + 12);
        let lo = 0;
        let hi = nGroups - 1;
        while (lo <= hi) {
          const m = (lo + hi) >> 1;
          const gs = buf.readUInt32BE(o + 16 + 12 * m);
          const ge = buf.readUInt32BE(o + 20 + 12 * m);
          const go = buf.readUInt32BE(o + 24 + 12 * m);
          if (cp < gs) hi = m - 1;
          else if (cp > ge) lo = m + 1;
          else return go + (cp - gs);
        }
      } else if (sub.format === 4) {
        if (cp > 0xffff) continue;
        const o = sub.abs;
        const segX2 = buf.readUInt16BE(o + 6);
        const segs = segX2 / 2;
        const endBase = o + 14;
        const startBase = endBase + segX2 + 2;
        const deltaBase = startBase + segX2;
        const rangeBase = deltaBase + segX2;
        for (let s = 0; s < segs; s += 1) {
          const end = buf.readUInt16BE(endBase + 2 * s);
          const start = buf.readUInt16BE(startBase + 2 * s);
          if (cp >= start && cp <= end) {
            const delta = buf.readUInt16BE(deltaBase + 2 * s);
            const ro = buf.readUInt16BE(rangeBase + 2 * s);
            if (ro === 0) return (cp + delta) & 0xffff;
            const g = buf.readUInt16BE(rangeBase + 2 * s + ro + 2 * (cp - start));
            return g === 0 ? 0 : (g + delta) & 0xffff;
          }
          if (cp < start) return 0; // segments are sorted
        }
      }
    }
    return 0;
  }

  /** glyf byte range of a glyph (may be empty). */
  glyphRange(gid) {
    const { buf, tables } = this;
    const loca = tables.get("loca").offset;
    const read = (i) => (this.indexToLocFormat === 0 ? buf.readUInt16BE(loca + 2 * i) * 2 : buf.readUInt32BE(loca + 4 * i));
    return { start: read(gid), end: read(gid + 1) };
  }

  /** TrueType advance width (font units) following hmtx semantics. */
  advanceOf(gid) {
    const { buf, tables } = this;
    const hmtx = tables.get("hmtx").offset;
    if (gid < this.numHMetrics) return buf.readUInt16BE(hmtx + 4 * gid);
    return buf.readUInt16BE(hmtx + 4 * (this.numHMetrics - 1));
  }

  /** Component glyph IDs of a composite glyph (empty for simple glyphs). */
  componentGids(gid) {
    const { buf, tables } = this;
    const { start, end } = this.glyphRange(gid);
    if (end - start < 10) return [];
    const glyf = tables.get("glyf").offset;
    if (buf.readInt16BE(glyf + start) >= 0) return [];
    const out = [];
    let off = glyf + start + 10; // skip numberOfContours + bbox
    for (;;) {
      const flags = buf.readUInt16BE(off);
      const componentGid = buf.readUInt16BE(off + 2);
      out.push(componentGid);
      let step = 4;
      step += (flags & 0x0001) !== 0 ? 4 : 2; // ARG_1_AND_2_ARE_WORDS
      if ((flags & 0x0008) !== 0) step += 2; // WE_HAVE_A_SCALE
      else if ((flags & 0x0040) !== 0) step += 4; // X_AND_Y_SCALE
      else if ((flags & 0x0080) !== 0) step += 8; // TWO_BY_TWO
      off += step;
      if ((flags & 0x0020) === 0) break; // MORE_COMPONENTS
    }
    return out;
  }

  tableBytes(tag) {
    const t = this.tables.get(tag);
    return t === undefined ? null : Buffer.from(this.buf.subarray(t.offset, t.offset + t.length));
  }
}

/**
 * Rebuild the cmap: a (3,1) format-4 subtable for the BMP code points, plus a
 * (3,10) format-12 subtable whenever non-BMP code points are present (astral
 * coverage), so the subset stays a well-formed Unicode font.
 */
function buildCmap(cpToGid) {
  const cps = [...cpToGid.keys()].sort((a, b) => a - b);
  assert(cps.length > 0, "cmap rebuild needs at least one code point");
  const bmp = cps.filter((cp) => cp <= 0xffff);
  const hasNonBmp = cps.some((cp) => cp > 0xffff);

  const subtables = [{ platform: 3, encoding: 1, data: buildCmapFormat4(new Map(bmp.map((cp) => [cp, cpToGid.get(cp)]))) }];
  if (hasNonBmp) {
    subtables.push({ platform: 3, encoding: 10, data: buildCmapFormat12(cpToGid) });
  }
  const w = new ByteWriter();
  w.u16(0); // version
  w.u16(subtables.length);
  let offset = 4 + 8 * subtables.length;
  const offsets = [];
  for (const sub of subtables) {
    offsets.push(offset);
    offset += sub.data.length;
  }
  subtables.forEach((sub, i) => {
    w.u16(sub.platform);
    w.u16(sub.encoding);
    w.u32(offsets[i]);
  });
  for (const sub of subtables) w.bytes(sub.data);
  return w.toBuffer();
}

/** Format 12 (UCS-4) subtable: maximal runs where gid advances with cp. */
function buildCmapFormat12(cpToGid) {
  const cps = [...cpToGid.keys()].sort((a, b) => a - b);
  const groups = [];
  let startCp = cps[0];
  let prevCp = cps[0];
  for (let i = 1; i <= cps.length; i += 1) {
    const cp = cps[i];
    if (cp !== undefined && cp === prevCp + 1 && cpToGid.get(cp) === cpToGid.get(prevCp) + 1) {
      prevCp = cp;
      continue;
    }
    groups.push([startCp, prevCp, cpToGid.get(startCp)]);
    startCp = cp;
    prevCp = cp;
  }
  const length = 16 + 12 * groups.length;
  const w = new ByteWriter();
  w.u16(12); // format
  w.u16(0); // reserved
  w.u32(length);
  w.u32(0); // language
  w.u32(groups.length);
  for (const [start, end, gid] of groups) {
    w.u32(start);
    w.u32(end);
    w.u32(gid);
  }
  // sanity: every mapping resolves
  for (const [cp, gid] of cpToGid) {
    const group = groups.find((g) => cp >= g[0] && cp <= g[1]);
    assert(group !== undefined && group[2] + (cp - group[0]) === gid, `format-12 group math broke for U+${cp.toString(16)}`);
  }
  return w.toBuffer();
}

/** Format 4 subtable covering BMP code points (constant-delta run merging). */
function buildCmapFormat4(cpToGid) {
  const cps = [...cpToGid.keys()].sort((a, b) => a - b);
  assert(cps.length > 0 && cps.every((cp) => cp <= 0xfffd), "cmap rebuild needs BMP code points");
  // Merge consecutive code points whose gid delta is constant (idDelta trick).
  const segments = [];
  let runStart = cps[0];
  let prevCp = cps[0];
  let delta = (cpToGid.get(cps[0]) - cps[0]) & 0xffff;
  const pushRun = (start, end, d) => segments.push({ start, end, delta: d });
  for (let i = 1; i < cps.length; i += 1) {
    const cp = cps[i];
    const d = (cpToGid.get(cp) - cp) & 0xffff;
    if (cp === prevCp + 1 && d === delta) {
      prevCp = cp;
      continue;
    }
    pushRun(runStart, prevCp, delta);
    runStart = cp;
    prevCp = cp;
    delta = d;
  }
  pushRun(runStart, prevCp, delta);
  segments.push({ start: 0xffff, end: 0xffff, delta: 1 }); // required terminator

  const segCount = segments.length;
  const w = new ByteWriter();
  const length = 16 + 8 * segCount;
  w.u16(4); // format
  w.u16(length);
  w.u16(0); // language
  w.u16(segCount * 2);
  const searchRange = 2 * 2 ** Math.floor(Math.log2(segCount));
  w.u16(searchRange);
  w.u16(Math.floor(Math.log2(segCount)));
  w.u16(segCount * 2 - searchRange);
  for (const seg of segments) w.u16(seg.end);
  w.u16(0); // reservedPad
  for (const seg of segments) w.u16(seg.start);
  for (const seg of segments) w.u16(seg.delta);
  for (let i = 0; i < segCount; i += 1) w.u16(0); // idRangeOffset: unused
  // sanity: every mapping resolves through (cp + delta) & 0xffff
  for (const [cp, gid] of cpToGid) {
    const seg = segments.find((s) => cp >= s.start && cp <= s.end);
    assert(seg !== undefined && ((cp + seg.delta) & 0xffff) === gid, `cmap segment math broke for U+${cp.toString(16)}`);
  }
  return w.toBuffer();
}

/** Assemble a TrueType file from tag->bytes (computes checksums + adjustment). */
function assembleTtf(tableMap) {
  const tags = [...tableMap.keys()].sort();
  const numTables = tags.length;
  const searchRange = 16 * 2 ** Math.floor(Math.log2(numTables));
  const header = new ByteWriter();
  header.u32(0x00010000);
  header.u16(numTables);
  header.u16(searchRange);
  header.u16(Math.floor(Math.log2(numTables)));
  header.u16(numTables * 16 - searchRange);

  let offset = 12 + 16 * numTables;
  const records = [];
  const bodies = [];
  for (const tag of tags) {
    const data = tableMap.get(tag);
    const padded = data.length % 4 === 0 ? data : Buffer.concat([data, Buffer.alloc(4 - (data.length % 4))]);
    records.push({ tag, offset, checksum: checksumBytes(data) });
    bodies.push(padded);
    offset += padded.length;
  }
  for (const rec of records) {
    header.bytes(Buffer.from(rec.tag, "latin1"));
    header.u32(rec.checksum);
    header.u32(rec.offset);
    header.u32(tableMap.get(rec.tag).length);
  }
  const font = Buffer.concat([header.toBuffer(), ...bodies], offset);
  // head.checkSumAdjustment: recompute whole-file sum with the field zeroed.
  const headRec = records.find((r) => r.tag === "head");
  font.writeUInt32BE(0, headRec.offset + 8);
  const adjustment = (0xb1b0afba - checksumBytes(font)) >>> 0;
  font.writeUInt32BE(adjustment, headRec.offset + 8);
  return font;
}

/**
 * Build a sparse subset keeping original glyph IDs.
 *
 * @param {SfntFont} font
 * @param {Map<number, string>} cpText  used code point -> its text (for ToUnicode)
 * @returns subset descriptor
 */
export function buildSubset(font, cpText) {
  // 1. code point -> gid (all must exist), and gid -> unicode for ToUnicode.
  const cpToGid = new Map();
  const gidText = new Map();
  for (const cp of [...cpText.keys()].sort((a, b) => a - b)) {
    const gid = font.gidOf(cp);
    assert(gid !== 0, `font ${font.path} has no glyph for U+${cp.toString(16).toUpperCase()} (${cpText.get(cp)})`);
    cpToGid.set(cp, gid);
    if (!gidText.has(gid)) gidText.set(gid, cpText.get(cp));
  }
  // Every line is one Tj with one font, so a glyph shared by two code points
  // would make ToUnicode ambiguous — verify it never happens.
  for (const [cp, gid] of cpToGid) {
    assert(gidText.get(gid) === cpText.get(cp),
      `glyph ${String(gid)} is mapped from two code points with different text (U+${cp.toString(16)})`);
  }

  // 2. Close the used-glyph set over composite components.
  const used = new Set([0]);
  const addWithComponents = (gid) => {
    if (used.has(gid)) return;
    used.add(gid);
    for (const c of font.componentGids(gid)) addWithComponents(c);
  };
  for (const gid of new Set(cpToGid.values())) addWithComponents(gid);
  const maxUsedGid = Math.max(...used);
  const numGlyphsNew = maxUsedGid + 1;

  // 3. Sparse glyf + long loca, ascending original-GID order.
  const glyfSource = font.tables.get("glyf").offset;
  const glyfW = new ByteWriter();
  const loca = new Uint32Array(numGlyphsNew + 1);
  for (let gid = 0; gid <= numGlyphsNew; gid += 1) {
    loca[gid] = glyfW.length;
    if (gid < numGlyphsNew && used.has(gid)) {
      const { start, end } = font.glyphRange(gid);
      const data = font.buf.subarray(glyfSource + start, glyfSource + end);
      glyfW.bytes(data);
      glyfW.align(4);
    }
  }

  // 4. hmtx with original semantics (clamp numberOfHMetrics, keep lsbs).
  const numHMetricsNew = Math.min(font.numHMetrics, numGlyphsNew);
  const hmtxSource = font.tables.get("hmtx").offset;
  const hmtxW = new ByteWriter();
  for (let gid = 0; gid < numGlyphsNew; gid += 1) {
    if (gid < numHMetricsNew) {
      // (advance, lsb) pair, copied verbatim from the original 4-byte entry.
      hmtxW.bytes(Buffer.from(font.buf.subarray(hmtxSource + 4 * gid, hmtxSource + 4 * gid + 4)));
    } else if (gid < font.numHMetrics) {
      // Original had a full entry here; keep its lsb, advance comes from the
      // last entry (identical semantics to the source font).
      hmtxW.u16(font.buf.readInt16BE(hmtxSource + 4 * gid + 2));
    } else {
      // Original lsb-only entry.
      const pos = hmtxSource + 4 * font.numHMetrics + 2 * (gid - font.numHMetrics);
      hmtxW.u16(font.buf.readInt16BE(pos));
    }
  }

  // 5. head / hhea / maxp copies with the subset fields patched.
  const head = Buffer.from(font.tableBytes("head"));
  head.writeUInt16BE(1, 50); // indexToLocFormat = long
  head.writeUInt32BE(0, 8); // checkSumAdjustment (set by assembleTtf)
  const hhea = Buffer.from(font.tableBytes("hhea"));
  hhea.writeUInt16BE(numHMetricsNew, 34);
  const maxp = Buffer.from(font.tableBytes("maxp"));
  maxp.writeUInt16BE(numGlyphsNew, 4);

  const locaW = new ByteWriter();
  for (let i = 0; i <= numGlyphsNew; i += 1) locaW.u32(loca[i]);

  const tables = new Map([
    ["cmap", buildCmap(cpToGid)],
    ["glyf", glyfW.toBuffer()],
    ["head", head],
    ["hhea", hhea],
    ["hmtx", hmtxW.toBuffer()],
    ["loca", locaW.toBuffer()],
    ["maxp", maxp],
  ]);
  for (const tag of KEEP_OPTIONAL) {
    const bytes = font.tableBytes(tag);
    if (bytes !== null) tables.set(tag, bytes);
  }
  const ttf = assembleTtf(tables);

  // 6. Metrics for the PDF font objects (1000-unit text space).
  const scale = 1000 / font.upem;
  const gidWidth = new Map();
  for (const gid of used) gidWidth.set(gid, Math.round(font.advanceOf(gid) * scale));
  return {
    ttf,
    gidText,
    gidWidth,
    descriptor: {
      ascent: Math.round(font.ascent * scale),
      descent: Math.round(font.descent * scale),
      capHeight: font.capHeight === null ? 700 : Math.round(font.capHeight * scale),
      bbox: font.bbox.map((v) => Math.round(v * scale)),
    },
    maxUsedGid,
    numGlyphsNew,
    upem: font.upem,
    codePoints: cpToGid.size,
    glyphs: used.size,
    composites: [...used].filter((g) => font.componentGids(g).length > 0).length,
  };
}
