/**
 * D4 PDF fixture generator — minimal deterministic PDF 1.5 writer.
 *
 * Produces correct classic-PDF documents: %PDF header with binary comment,
 * sequentially numbered indirect objects, an exact xref table, and a trailer
 * with /Root, /Info (FIXED dates) and a content-hash /ID. Serialization is
 * fully deterministic: same logical content -> identical bytes.
 */

import { deflateSync } from "node:zlib";
import { assert, sha256 } from "./util.mjs";

/** PDF literal string with required escapes (bytes as latin1 buffer). */
export function pdfLiteral(bytes) {
  let out = "(";
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) out += `\\${String.fromCharCode(b)}`;
    else if (b < 0x20 || b > 0x7e) out += `\\${b.toString(8).padStart(3, "0")}`;
    else out += String.fromCharCode(b);
  }
  return `${out})`;
}

/** PDF hex string from bytes (uppercase). */
export function pdfHex(bytes) {
  return `<${Buffer.from(bytes).toString("hex").toUpperCase()}>`;
}

/** PDF text string: ASCII -> literal, otherwise UTF-16BE with BOM as hex. */
export function pdfTextString(text) {
  const bytes = Buffer.from(text, "utf8");
  let ascii = true;
  for (const b of bytes) {
    if (b < 0x20 || b > 0x7e) {
      ascii = false;
      break;
    }
  }
  if (ascii) return pdfLiteral(bytes);
  const utf16 = Buffer.from(text, "utf16le").swap16();
  return pdfHex(Buffer.concat([Buffer.from([0xfe, 0xff]), utf16]));
}

/** ToUnicode CMap (bfchar) for a CID subset: gid -> UTF-16BE text. */
export function toUnicodeCMap(gidText) {
  const entries = [...gidText.entries()].sort((a, b) => a[0] - b[0]);
  let out = "";
  out += "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n";
  out += "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n";
  out += "/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n";
  out += "1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n";
  const CHUNK = 100;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const slice = entries.slice(i, i + CHUNK);
    out += `${String(slice.length)} beginbfchar\n`;
    for (const [gid, text] of slice) {
      const uni = Buffer.from(text, "utf16le").swap16().toString("hex").toUpperCase();
      out += `<${gid.toString(16).toUpperCase().padStart(4, "0")}> <${uni}>\n`;
    }
    out += "endbfchar\n";
  }
  out += "endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n";
  return out;
}

export class PdfDoc {
  constructor() {
    this.objects = []; // index i -> object number i+1
    this.fixedDate = "D:20260930000000Z"; // frozen CreationDate/ModDate (determinism)
  }

  /** Add an indirect object whose body is a preformatted string. Returns its number. */
  add(body) {
    this.objects.push(body);
    return this.objects.length;
  }

  /**
   * Add a stream object. `extraDict` holds serialized extra entries.
   * @param {Buffer|string} data raw stream bytes (string = latin1)
   */
  addStream(extraDict, data, opts = {}) {
    const raw = typeof data === "string" ? Buffer.from(data, "latin1") : data;
    const flate = opts.flate === true;
    const payload = flate ? deflateSync(raw, { level: 9 }) : raw;
    let dict = `<< /Length ${String(payload.length)}`;
    if (extraDict !== "") dict += ` ${extraDict}`;
    if (flate) dict += " /Filter /FlateDecode";
    if (opts.length1 !== undefined) dict += ` /Length1 ${String(opts.length1)}`;
    dict += " >>";
    return this.add(`${dict}\nstream\n${payload.toString("latin1")}\nendstream`);
  }

  /**
   * Serialize: header + objects + xref, then trailer with /Root, /Info and a
   * deterministic /ID (SHA-256 of everything before the trailer).
   */
  serialize(rootNum, infoNum, encryptNum = null) {
    assert(this.objects.length > 0, "empty document");
    assert(rootNum >= 1 && rootNum <= this.objects.length, "root ref out of range");
    assert(infoNum >= 1 && infoNum <= this.objects.length, "info ref out of range");
    const parts = [Buffer.from("%PDF-1.5\n%\xE2\xE3\xCF\xD3\n", "latin1")];
    const offsets = [];
    let pos = parts[0].length;
    for (let i = 0; i < this.objects.length; i += 1) {
      offsets.push(pos);
      const body = Buffer.from(`${String(i + 1)} 0 obj\n${this.objects[i]}\nendobj\n`, "latin1");
      parts.push(body);
      pos += body.length;
    }
    const xrefStart = pos;
    let xref = `xref\n0 ${String(this.objects.length + 1)}\n0000000000 65535 f \n`;
    for (const off of offsets) xref += `${String(off).padStart(10, "0")} 00000 n \n`;
    parts.push(Buffer.from(xref, "latin1"));
    const id = sha256(Buffer.concat(parts)).subarray(0, 16);
    const idHex = pdfHex(id);
    let trailer =
      `trailer\n<< /Size ${String(this.objects.length + 1)} /Root ${String(rootNum)} 0 R` +
      ` /Info ${String(infoNum)} 0 R /ID [${idHex} ${idHex}]`;
    if (encryptNum !== null) trailer += ` /Encrypt ${String(encryptNum)} 0 R`;
    trailer += ` >>\nstartxref\n${String(xrefStart)}\n%%EOF\n`;
    return Buffer.concat([...parts, Buffer.from(trailer, "latin1")]);
  }
}

/**
 * Document skeleton shared by the text fixtures: catalog + pages tree +
 * fonts + page content streams + Info. Object layout is fixed:
 *   1: Catalog, 2: Pages, then per-font object groups, then per-page
 *   (content stream + page object), then Info.
 */
export class TextPdfBuilder {
  constructor({ title }) {
    this.doc = new PdfDoc();
    this.title = title;
    this.catalogNum = this.doc.add("<< /Type /Catalog /Pages 2 0 R >>");
    this.pagesNum = this.doc.add(""); // patched in build()
    this.fontObjects = new Map(); // fontKey -> {resourceName, refNum, subset?}
    this.pages = []; // {mediaBox, lines: [{font, size, x, y, encoded}]}
  }

  /** Register a base-14 Type1 font (Helvetica/Courier, WinAnsiEncoding). */
  baseFont(key, baseFontName) {
    if (this.fontObjects.has(key)) return this.fontObjects.get(key).resourceName;
    const num = this.doc.add(
      `<< /Type /Font /Subtype /Type1 /BaseFont /${baseFontName} /Encoding /WinAnsiEncoding >>`,
    );
    return this._register(key, num, null);
  }

  /**
   * Register an embedded CID font (Identity-H + CIDFontType2 with an
   * embedded subset as FontFile2 and a ToUnicode CMap).
   * `subset` = {ttf, gidText, gidWidth, descriptor} from font.buildSubset.
   */
  cidFont(key, baseFontName, subset) {
    if (this.fontObjects.has(key)) return this.fontObjects.get(key).resourceName;
    const doc = this.doc;
    const fd = subset.descriptor;
    const toUnicodeNum = doc.addStream("", toUnicodeCMap(subset.gidText));
    const fontFileNum = doc.addStream("/Type /FontFile2", subset.ttf, { flate: true, length1: subset.ttf.length });
    const descriptorNum = doc.add(
      `<< /Type /FontDescriptor /FontName /${baseFontName} /Flags 4 ` +
      `/FontBBox [${fd.bbox.join(" ")}] /ItalicAngle 0 /Ascent ${String(fd.ascent)} /Descent ${String(fd.descent)} ` +
      `/CapHeight ${String(fd.capHeight)} /StemV 80 /FontFile2 ${String(fontFileNum)} 0 R >>`,
    );
    // W array: runs of consecutive gids with equal width as "g w gEnd w".
    const wParts = [];
    const gids = [...subset.gidWidth.keys()].sort((a, b) => a - b);
    let i = 0;
    while (i < gids.length) {
      let j = i;
      while (j + 1 < gids.length && subset.gidWidth.get(gids[j + 1]) === subset.gidWidth.get(gids[i])) j += 1;
      const w = subset.gidWidth.get(gids[i]);
      wParts.push(j > i ? `${String(gids[i])} ${String(w)} ${String(gids[j])} ${String(w)}` : `${String(gids[i])} ${String(w)}`);
      i = j + 1;
    }
    const cidFontNum = doc.add(
      `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${baseFontName} ` +
      `/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ` +
      `/FontDescriptor ${String(descriptorNum)} 0 R /DW 1000 /W [${wParts.join(" ")}] /CIDToGIDMap /Identity >>`,
    );
    const type0Num = doc.add(
      `<< /Type /Font /Subtype /Type0 /BaseFont /${baseFontName} /Encoding /Identity-H ` +
      `/DescendantFonts [${String(cidFontNum)} 0 R] /ToUnicode ${String(toUnicodeNum)} 0 R >>`,
    );
    return this._register(key, type0Num, subset);
  }

  _register(key, refNum, subset) {
    const resourceName = `/F${String(this.fontObjects.size + 1)}`;
    this.fontObjects.set(key, { resourceName, refNum, subset });
    return resourceName;
  }

  addPage(lines, mediaBox) {
    this.pages.push({ mediaBox, lines });
  }

  /** Finalize and return PDF bytes. */
  build() {
    const doc = this.doc;
    assert(this.pages.length > 0, "no pages added");
    const pageRefs = [];
    for (const page of this.pages) {
      const fontKeys = [...new Set(page.lines.map((l) => l.font))];
      const resources = fontKeys
        .map((key) => {
          const f = this.fontObjects.get(key);
          assert(f !== undefined, `page references unregistered font key: ${key}`);
          return `${f.resourceName} ${String(f.refNum)} 0 R`;
        })
        .join(" ");
      const content = page.lines
        .map((line) => {
          const f = this.fontObjects.get(line.font);
          return `BT\n${f.resourceName} ${String(line.size)} Tf\n${line.x.toFixed(2)} ${line.y.toFixed(2)} Td\n${line.encoded} Tj\nET`;
        })
        .join("\n");
      const contentNum = doc.addStream("", Buffer.from(content, "latin1"));
      const pageNum = doc.add(
        `<< /Type /Page /Parent ${String(this.pagesNum)} 0 R /MediaBox [${page.mediaBox.join(" ")}] ` +
        `/Resources << /Font << ${resources} >> >> /Contents ${String(contentNum)} 0 R >>`,
      );
      pageRefs.push(`${String(pageNum)} 0 R`);
    }
    doc.objects[this.pagesNum - 1] = `<< /Type /Pages /Kids [${pageRefs.join(" ")}] /Count ${String(pageRefs.length)} >>`;
    const infoNum = doc.add(
      `<< /Title ${pdfTextString(this.title)} /Producer (TreeAI D4 PDF fixture generator d4-pdf-v1) ` +
      `/CreationDate (${doc.fixedDate}) /ModDate (${doc.fixedDate}) >>`,
    );
    return doc.serialize(this.catalogNum, infoNum);
  }
}
