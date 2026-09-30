/**
 * D4 PDF fixture generator — round-trip PDF parser + text extractor.
 *
 * This is the ground-truth assertion engine for the generator: it parses the
 * PDFs we just wrote (xref, objects, page tree, content streams, ToUnicode
 * CMaps), re-derives each page's text through the PINNED reading order
 * (layout.mjs orderPageLines — same function, no private re-implementation),
 * and the generator asserts extracted === expected for every fixture.
 *
 * It deliberately understands only what our writer emits (plus a little
 * headroom): classic xref tables, one-level page trees, uncompressed or
 * Flate streams, Type0/Identity-H CID fonts with ToUnicode bfchar/bfrange,
 * and base-14 Type1 fonts with WinAnsiEncoding.
 */

import { inflateSync } from "node:zlib";
import { assert } from "./util.mjs";
import { orderPageLines } from "./layout.mjs";
import { winAnsiDecode } from "./textenc.mjs";

export class PdfName {
  constructor(value) {
    this.value = value;
  }
  toString() {
    return `/${this.value}`;
  }
}

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

export class PdfParser {
  constructor(buf) {
    this.buf = buf;
    assert(buf.subarray(0, 5).toString("latin1") === "%PDF-", "not a PDF file");
    const tail = buf.subarray(Math.max(0, buf.length - 2048));
    const m = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(tail.toString("latin1"));
    assert(m !== null, "no startxref/%%EOF at end of file (truncated or corrupt)");
    this.startXref = Number(m[1]);
    this.xref = this._parseXref(this.startXref);
    this.objects = new Map();
  }

  _parseXref(offset) {
    const { buf } = this;
    assert(buf.subarray(offset, offset + 4).toString("latin1") === "xref", `byte ${String(offset)} is not an xref table (corrupt)`);
    let pos = offset + 4;
    const skipWs = () => {
      while (pos < buf.length && WS.has(buf[pos])) pos += 1;
    };
    const readInt = () => {
      skipWs();
      let s = "";
      while (pos < buf.length && /[0-9]/.test(String.fromCharCode(buf[pos]))) {
        s += String.fromCharCode(buf[pos]);
        pos += 1;
      }
      return s === "" ? null : Number(s);
    };
    const table = new Map();
    for (;;) {
      const start = readInt();
      if (start === null) throw new Error("malformed xref subsection header");
      const count = readInt();
      if (count === null) throw new Error("malformed xref subsection count");
      for (let i = 0; i < count; i += 1) {
        skipWs();
        const entry = buf.subarray(pos, pos + 20).toString("latin1");
        pos += 20;
        const em = /^(\d{10}) (\d{5}) ([nf])/.exec(entry);
        if (em === null) throw new Error(`malformed xref entry: ${JSON.stringify(entry.slice(0, 20))}`);
        if (em[3] === "n") table.set(start + i, { offset: Number(em[1]), gen: Number(em[2]) });
      }
      skipWs();
      if (buf.subarray(pos, pos + 7).toString("latin1") === "trailer") break;
    }
    // trailer dict
    const parsed = this._parseValueAt(pos + 7);
    assert(parsed.value instanceof Map, "trailer is not a dictionary");
    this.trailer = parsed.value;
    for (const key of ["Root", "Size"]) assert(this.trailer.get(key) !== undefined, `trailer misses /${key}`);
    return table;
  }

  _parseValueAt(pos) {
    const { buf } = this;
    const skipWsAndComments = (p) => {
      for (;;) {
        while (p < buf.length && WS.has(buf[p])) p += 1;
        if (p < buf.length && buf[p] === 0x25) {
          while (p < buf.length && buf[p] !== 0x0a) p += 1;
        } else return p;
      }
    };
    pos = skipWsAndComments(pos);
    const c = buf[pos];
    if (c === 0x3c) {
      if (buf[pos + 1] === 0x3c) return this._parseDict(pos + 2);
      // hex string
      let end = pos + 1;
      while (end < buf.length && buf[end] !== 0x3e) end += 1;
      const hex = buf.subarray(pos + 1, end).toString("latin1").replace(/[^0-9A-Fa-f]/g, "");
      const bytes = Buffer.from(hex.length % 2 === 0 ? hex : `${hex}0`, "hex");
      return { value: bytes, next: end + 1 };
    }
    if (c === 0x28) return this._parseLiteral(pos);
    if (c === 0x5b) {
      // array
      const out = [];
      let p = pos + 1;
      for (;;) {
        p = skipWsAndComments(p);
        if (buf[p] === 0x5d) return { value: out, next: p + 1 };
        const v = this._parseValueAt(p);
        out.push(v.value);
        p = v.next;
      }
    }
    if (c === 0x2f) {
      let end = pos + 1;
      while (end < buf.length && !WS.has(buf[end]) && !DELIM.has(buf[end])) end += 1;
      return { value: new PdfName(buf.subarray(pos + 1, end).toString("latin1")), next: end };
    }
    if (buf.subarray(pos, pos + 4).toString("latin1") === "true") return { value: true, next: pos + 4 };
    if (buf.subarray(pos, pos + 5).toString("latin1") === "false") return { value: false, next: pos + 5 };
    if (buf.subarray(pos, pos + 4).toString("latin1") === "null") return { value: null, next: pos + 4 };
    // number (int/real), possibly the first operand of "N G R" (indirect ref)
    let end = pos;
    while (end < buf.length && /[0-9+.\-]/.test(String.fromCharCode(buf[end]))) end += 1;
    const numStr = buf.subarray(pos, end).toString("latin1");
    assert(numStr !== "", `cannot parse a value at byte ${String(pos)}`);
    let value = numStr.includes(".") ? parseFloat(numStr) : parseInt(numStr, 10);
    let next = end;
    // Indirect reference lookahead: number number R
    const afterWs = skipWsAndComments(next);
    if (/[0-9]/.test(String.fromCharCode(buf[afterWs])) && afterWs !== next) {
      let end2 = afterWs;
      while (end2 < buf.length && /[0-9]/.test(String.fromCharCode(buf[end2]))) end2 += 1;
      const genStr = buf.subarray(afterWs, end2).toString("latin1");
      const afterWs2 = skipWsAndComments(end2);
      if (buf.subarray(afterWs2, afterWs2 + 1).toString("latin1") === "R" && !/[0-9A-Za-z]/.test(String.fromCharCode(buf[afterWs2 + 1] ?? 0x20))) {
        value = { ref: [value, parseInt(genStr, 10)] };
        next = afterWs2 + 1;
      }
    }
    return { value, next };
  }

  _parseDict(pos) {
    const { buf } = this;
    const map = new Map();
    let p = pos;
    const skipWsAndComments = (q) => {
      for (;;) {
        while (q < buf.length && WS.has(buf[q])) q += 1;
        if (q < buf.length && buf[q] === 0x25) {
          while (q < buf.length && buf[q] !== 0x0a) q += 1;
        } else return q;
      }
    };
    for (;;) {
      p = skipWsAndComments(p);
      if (buf[p] === 0x3e && buf[p + 1] === 0x3e) return { value: map, next: p + 2 };
      assert(buf[p] === 0x2f, `expected a name key in dict at byte ${String(p)}`);
      const key = this._parseValueAt(p);
      p = skipWsAndComments(key.next);
      const val = this._parseValueAt(p);
      map.set(key.value.value, val.value);
      p = val.next;
    }
  }

  _parseLiteral(pos) {
    const { buf } = this;
    const out = [];
    let depth = 1;
    let p = pos + 1;
    while (p < buf.length && depth > 0) {
      const c = buf[p];
      if (c === 0x5c) {
        const e = buf[p + 1];
        if (e === 0x6e) out.push(0x0a);
        else if (e === 0x72) out.push(0x0d);
        else if (e === 0x74) out.push(0x09);
        else if (e === 0x62) out.push(0x08);
        else if (e === 0x66) out.push(0x0c);
        else if (e >= 0x30 && e <= 0x37) {
          let digits = "";
          let q = p + 1;
          while (q < buf.length && digits.length < 3 && buf[q] >= 0x30 && buf[q] <= 0x37) {
            digits += String.fromCharCode(buf[q]);
            q += 1;
          }
          out.push(parseInt(digits, 8));
          p = q - 1;
        } else if (e === 0x0a) {
          // line continuation: skip
        } else out.push(e);
        p += 2;
        continue;
      }
      if (c === 0x28) depth += 1;
      if (c === 0x29) {
        depth -= 1;
        if (depth === 0) break;
      }
      out.push(c);
      p += 1;
    }
    return { value: Buffer.from(out), next: p + 1 };
  }

  getObject(num) {
    if (this.objects.has(num)) return this.objects.get(num);
    const entry = this.xref.get(num);
    assert(entry !== undefined, `object ${String(num)} is not in the xref table`);
    const head = this.buf.subarray(entry.offset, entry.offset + 64).toString("latin1");
    const hm = new RegExp(`^${String(num)} ${String(entry.gen)} obj`).exec(head);
    assert(hm !== null, `xref offset for object ${String(num)} does not point at "${String(num)} ${String(entry.gen)} obj" (corrupt)`);
    let pos = entry.offset + hm[0].length;
    const parsed = this._parseValueAt(pos);
    let value = parsed.value;
    let after = parsed.next;
    // stream? ("<<" dict ">>" whitespace "stream" EOL bytes "endstream")
    let p = after;
    while (p < this.buf.length && WS.has(this.buf[p])) p += 1;
    if (this.buf.subarray(p, p + 6).toString("latin1") === "stream") {
      assert(value instanceof Map, "stream object without a dict");
      p += 6; // "stream"
      if (this.buf[p] === 0x0d) p += 1;
      assert(this.buf[p] === 0x0a, "stream keyword not followed by EOL");
      p += 1;
      const lengthVal = value.get("Length");
      assert(typeof lengthVal === "number", "stream /Length must be a direct number here");
      const bytes = Buffer.from(this.buf.subarray(p, p + lengthVal));
      const endTag = this.buf.subarray(p + lengthVal, p + lengthVal + 20).toString("latin1");
      assert(/^\s*endstream/.test(endTag), `stream of object ${String(num)} is not terminated by endstream where /Length says`);
      value = { dict: value, bytes, stream: true };
      this.objects.set(num, value);
      return value;
    }
    this.objects.set(num, value);
    return value;
  }

  resolve(value) {
    if (value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Map) && !(value instanceof Buffer) && "ref" in value) {
      return this.getObject(value.ref[0]);
    }
    return value;
  }
}

/* ---------------------------------------------------------------------- */
/* ToUnicode CMap parsing                                                  */
/* ---------------------------------------------------------------------- */

function utf16beToText(hex) {
  const bytes = Buffer.from(hex, "hex");
  assert(bytes.length % 2 === 0, "odd UTF-16BE length in ToUnicode");
  let out = "";
  for (let i = 0; i < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
  return out;
}

export function parseToUnicode(cmapText) {
  const map = new Map(); // code -> text
  const bfchar = /(\d+)\s+beginbfchar([\s\S]*?)endbfchar/g;
  let m;
  while ((m = bfchar.exec(cmapText)) !== null) {
    const entry = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let e;
    while ((e = entry.exec(m[2])) !== null) map.set(parseInt(e[1], 16), utf16beToText(e[2]));
  }
  const bfrange = /(\d+)\s+beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = bfrange.exec(cmapText)) !== null) {
    const entry = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let e;
    while ((e = entry.exec(m[2])) !== null) {
      const lo = parseInt(e[1], 16);
      const hi = parseInt(e[2], 16);
      const start = parseInt(e[3], 16);
      for (let c = lo; c <= hi; c += 1) map.set(c, utf16beToText((start + (c - lo)).toString(16).padStart(4, "0")));
    }
  }
  return map;
}

/* ---------------------------------------------------------------------- */
/* Content stream interpretation                                           */
/* ---------------------------------------------------------------------- */

function tokenizeContent(text) {
  // Returns a flat token list: numbers, strings (Buffer), names (PdfName),
  // arrays (array of those), keywords (operator strings).
  const tokens = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === " " || c === "\n" || c === "\r" || c === "\t" || c === "\f" || c === "\0") {
      i += 1;
      continue;
    }
    if (c === "%") {
      while (i < n && text[i] !== "\n") i += 1;
      continue;
    }
    if (c === "(") {
      let depth = 1;
      let j = i + 1;
      let out = "";
      while (j < n && depth > 0) {
        const d = text[j];
        if (d === "\\") {
          const e = text[j + 1];
          if (e === "n") out += "\n";
          else if (e === "r") out += "\r";
          else if (e === "t") out += "\t";
          else if (e === "b") out += "\b";
          else if (e === "f") out += "\f";
          else if (e >= "0" && e <= "7") {
            let digits = "";
            let q = j + 1;
            while (q < n && digits.length < 3 && text[q] >= "0" && text[q] <= "7") {
              digits += text[q];
              q += 1;
            }
            out += String.fromCharCode(parseInt(digits, 8));
            j = q - 1;
          } else if (e === "\n") {
            // continuation
          } else out += e;
          j += 2;
          continue;
        }
        if (d === "(") depth += 1;
        if (d === ")") {
          depth -= 1;
          if (depth === 0) break;
        }
        out += d;
        j += 1;
      }
      const bytes = Buffer.from(out, "latin1");
      tokens.push({ t: "str", v: bytes });
      i = j + 1;
      continue;
    }
    if (c === "<" && text[i + 1] !== "<") {
      let j = i + 1;
      while (j < n && text[j] !== ">") j += 1;
      let hex = text.slice(i + 1, j).replace(/[^0-9A-Fa-f]/g, "");
      if (hex.length % 2 === 1) hex += "0";
      tokens.push({ t: "str", v: Buffer.from(hex, "hex") });
      i = j + 1;
      continue;
    }
    if (c === "<" || c === ">" || c === "[" || c === "]") {
      tokens.push({ t: "delim", v: c });
      i += 1;
      continue;
    }
    if (c === "/") {
      let j = i + 1;
      while (j < n && !" \n\r\t\f\0()<>[]{}/%".includes(text[j])) j += 1;
      tokens.push({ t: "name", v: text.slice(i + 1, j) });
      i = j;
      continue;
    }
    // number or keyword
    let j = i;
    while (j < n && !" \n\r\t\f\0()<>[]{}/%".includes(text[j])) j += 1;
    const word = text.slice(i, j);
    if (/^[0-9+\-.]/.test(word)) tokens.push({ t: "num", v: parseFloat(word) });
    else tokens.push({ t: "op", v: word });
    i = j;
  }
  return tokens;
}

/**
 * Run a content-stream token list and return the text lines it draws.
 * @param {object[]} tokens from retokenizeWithArrays()
 * @param {Map} fonts resource name -> font descriptor:
 *   {subtype:"Type0", toUnicode: Map} or {subtype:"Type1"}
 */
function interpretContent(tokens, fonts) {
  const lines = [];
  let order = 0;
  let tm = [1, 0, 0, 1, 0, 0];
  let lm = [1, 0, 0, 1, 0, 0];
  let leading = 0;
  let font = null;
  const operands = [];
  const decode = (bytes) => {
    assert(font !== null, "Tj without a current font");
    if (font.subtype === "Type0") {
      assert(bytes.length % 2 === 0, "Identity-H string has an odd byte count");
      let out = "";
      for (let i = 0; i < bytes.length; i += 2) {
        const code = (bytes[i] << 8) | bytes[i + 1];
        const text = font.toUnicode.get(code);
        assert(text !== undefined, `CID ${String(code)} (0x${code.toString(16)}) has no ToUnicode entry`);
        out += text;
      }
      return out;
    }
    return winAnsiDecode(bytes);
  };
  const emit = (text) => {
    // Even an empty string is a line: the generator uses () Tj for blank code
    // lines, and the expected text carries them as empty lines.
    lines.push({ x: tm[4], y: tm[5], order: order++, text });
  };
  const translateLm = (tx, ty) => {
    lm = [lm[0], lm[1], lm[2], lm[3], lm[4] + tx, lm[5] + ty];
    tm = [...lm];
  };
  for (const tok of tokens) {
    if (tok.t !== "op") {
      operands.push(tok);
      continue;
    }
    switch (tok.v) {
      case "BT":
        tm = [1, 0, 0, 1, 0, 0];
        lm = [1, 0, 0, 1, 0, 0];
        break;
      case "ET":
        break;
      case "Tf": {
        const nameTok = operands[operands.length - 2];
        assert(nameTok !== undefined && nameTok.t === "name", "Tf without a font name");
        font = fonts.get(nameTok.v) ?? null;
        assert(font !== null, `Tf references an unknown font resource: /${nameTok.v}`);
        break;
      }
      case "Td":
      case "TD": {
        const ty = operands[operands.length - 1]?.v;
        const tx = operands[operands.length - 2]?.v;
        assert(typeof tx === "number" && typeof ty === "number", "Td without two numbers");
        if (tok.v === "TD") leading = -ty;
        translateLm(tx, ty);
        break;
      }
      case "TL": {
        const tl = operands[operands.length - 1]?.v;
        assert(typeof tl === "number", "TL without a number");
        leading = tl;
        break;
      }
      case "T*":
        translateLm(0, -leading);
        break;
      case "Tm": {
        const f = operands.slice(-6).map((o) => o.v);
        assert(f.length === 6 && f.every((v) => typeof v === "number"), "Tm needs 6 numeric operands");
        lm = f;
        tm = [...lm];
        break;
      }
      case "Tj": {
        const s = operands[operands.length - 1];
        assert(s !== undefined && s.t === "str", "Tj without a string");
        emit(decode(s.v));
        break;
      }
      case "TJ": {
        const arr = operands[operands.length - 1];
        assert(arr !== undefined && arr.t === "arr", "TJ without an array");
        let text = "";
        for (const item of arr.v) {
          if (item.t === "str") text += decode(item.v);
        }
        emit(text);
        break;
      }
      case "'": {
        const s = operands[operands.length - 1];
        assert(s !== undefined && s.t === "str", "' without a string");
        translateLm(0, -leading);
        emit(decode(s.v));
        break;
      }
      case '"': {
        const s = operands[operands.length - 3];
        assert(s !== undefined && s.t === "str", '" without a string');
        translateLm(0, -leading);
        emit(decode(s.v));
        break;
      }
      default:
        break; // q/Q/cm/gs/rg/Do/...: no text-model effect in our fixtures
    }
    operands.length = 0;
  }
  return lines;
}

/** Build operand arrays for TJ (nested arrays only appear there). */
function retokenizeWithArrays(content) {
  // tokenizeContent emits [ and ] as delimiters; fold them into array tokens.
  const flat = tokenizeContent(content);
  const out = [];
  let stack = null;
  for (const tok of flat) {
    if (tok.t === "delim" && tok.v === "[") {
      if (stack === null) stack = [];
      else stack.push({ t: "arrayStart" }); // nested arrays unsupported (not emitted by our writer)
      continue;
    }
    if (tok.t === "delim" && tok.v === "]") {
      assert(stack !== null, "unbalanced ] in content stream");
      const arr = stack;
      stack = null;
      out.push({ t: "arr", v: arr });
      continue;
    }
    if (stack !== null) stack.push(tok);
    else out.push(tok);
  }
  return out;
}

/* ---------------------------------------------------------------------- */
/* Document-level extraction                                               */
/* ---------------------------------------------------------------------- */

export function streamBytes(obj, parser) {
  assert(obj !== null && typeof obj === "object" && obj.stream === true, "expected a stream object");
  const filter = obj.dict.get("Filter");
  if (filter === undefined) return obj.bytes;
  assert(filter instanceof PdfName && filter.value === "FlateDecode", `unsupported stream filter: ${String(filter)}`);
  return inflateSync(obj.bytes);
}

/** Walk the document and extract per-page ordered text. */
export function extractDocText(buf) {
  const parser = new PdfParser(buf);
  if (parser.trailer.get("Encrypt") !== undefined) {
    throw new Error("encrypted: trailer carries /Encrypt (text-layer import must reject)");
  }
  const root = parser.resolve(parser.trailer.get("Root"));
  assert(root instanceof Map && root.get("Type")?.value === "Catalog", "bad document catalog");
  const pagesRoot = parser.resolve(root.get("Pages"));
  assert(pagesRoot instanceof Map && pagesRoot.get("Type")?.value === "Pages", "bad page tree root");
  const kids = parser.resolve(pagesRoot.get("Kids"));
  assert(Array.isArray(kids), "page tree has no /Kids array");
  const pageCount = parser.resolve(pagesRoot.get("Count"));
  assert(kids.length === pageCount, `page /Count (${String(pageCount)}) != /Kids length (${String(kids.length)})`);

  const pageTexts = [];
  for (const kidRef of kids) {
    const page = parser.resolve(kidRef);
    assert(page instanceof Map && page.get("Type")?.value === "Page", "page tree kid is not a /Page");
    const resources = parser.resolve(page.get("Resources"));
    assert(resources instanceof Map, "page has no /Resources");
    const fontDict = parser.resolve(resources.get("Font"));
    const fonts = new Map();
    if (fontDict !== undefined && fontDict !== null) {
      assert(fontDict instanceof Map, "page resources /Font is not a dictionary");
      for (const [name, ref] of fontDict) {
        const font = parser.resolve(ref);
        assert(font instanceof Map, "font entry is not a dict");
        const subtype = font.get("Subtype")?.value;
        if (subtype === "Type0") {
          const enc = font.get("Encoding");
          assert(enc instanceof PdfName && enc.value === "Identity-H", "only Identity-H Type0 fonts are understood");
          const toUnicode = parser.resolve(font.get("ToUnicode"));
          const cmapText = streamBytes(toUnicode, parser).toString("latin1");
          fonts.set(name, { subtype: "Type0", toUnicode: parseToUnicode(cmapText) });
        } else if (subtype === "Type1") {
          const enc = font.get("Encoding");
          assert(enc instanceof PdfName && enc.value === "WinAnsiEncoding", "base fonts must use WinAnsiEncoding");
          fonts.set(name, { subtype: "Type1" });
        } else {
          throw new Error(`unsupported font subtype in fixture: ${String(subtype)}`);
        }
      }
    }
    const contentsRef = page.get("Contents");
    let content = "";
    if (contentsRef !== undefined) {
      const contents = parser.resolve(contentsRef);
      const streams = Array.isArray(contents) ? contents : [contents];
      content = streams.map((s) => streamBytes(parser.resolve(s), parser).toString("latin1")).join("\n");
    }
    const lines = interpretContent(retokenizeWithArrays(content), fonts);
    const ordered = orderPageLines(lines);
    pageTexts.push(ordered.map((l) => l.text).join("\n"));
  }
  const info = parser.resolve(parser.trailer.get("Info"));
  const titleBytes = info instanceof Map ? info.get("Title") : undefined;
  return {
    pageTexts,
    pageCount: pageTexts.length,
    title: Buffer.isBuffer(titleBytes) ? titleBytes.toString("latin1") : null,
    id: parser.trailer.get("ID"),
  };
}

/** Structural sanity: every xref entry must point at its "N G obj" header. */
export function verifyXrefOffsets(buf) {
  const parser = new PdfParser(buf);
  let checked = 0;
  for (const [num, entry] of parser.xref) {
    const head = buf.subarray(entry.offset, entry.offset + 32).toString("latin1");
    if (!head.startsWith(`${String(num)} ${String(entry.gen)} obj`)) {
      throw new Error(`xref entry ${String(num)} offset ${String(entry.offset)} is wrong`);
    }
    checked += 1;
  }
  return { objects: checked, startxref: parser.startXref };
}
