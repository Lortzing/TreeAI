/** objects ownership for pdf-parser.ts; compatibility entrypoint remains one level above. */
import {
  bytesToLatin1,
  hexToBytes,
} from "./decoding.ts";
import {
  PdfCorruptError,
  PdfUnsupportedError,
} from "./errors.ts";
import {
  DELIM_BYTES,
  describePdfValue,
  isPdfRef,
  PdfName,
  type PdfValue,
  WS_BYTES,
  type XrefEntry,
} from "./values.ts";

/** 嵌套深度上限（防病态嵌套打穿调用栈：合法 PDF 远不到此深度）。 */
export const MAX_NESTING_DEPTH = 64;

/**
 * 字节级 PDF 对象解析器（移植 scripts/d4/pdf/extract.mjs 的 PdfParser，
 * 增补：/Prev xref 链、间接 /Length、嵌套页树与 /Resources 继承）。
 */
export class PdfObjectParser {
  readonly buf: Uint8Array;
  readonly xref: ReadonlyMap<number, XrefEntry>;
  readonly trailer: ReadonlyMap<string, PdfValue>;
  readonly #objects = new Map<number, PdfValue>();

  constructor(buf: Uint8Array) {
    this.buf = buf;
    if (buf.length < 8 || bytesToLatin1(buf.subarray(0, 5)) !== "%PDF-") {
      throw new PdfCorruptError("not a PDF file (missing %PDF- header)");
    }
    const tail = bytesToLatin1(buf.subarray(Math.max(0, buf.length - 2048)));
    const m = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(tail);
    if (m === null) {
      throw new PdfCorruptError("no startxref/%%EOF at end of file (truncated or corrupt)");
    }
    const { table, trailer } = this.#parseXrefChain(Number(m[1]));
    this.xref = table;
    this.trailer = trailer;
  }

  #parseXrefChain(startOffset: number): { table: Map<number, XrefEntry>; trailer: Map<string, PdfValue> } {
    const table = new Map<number, XrefEntry>();
    const trailer = new Map<string, PdfValue>();
    const seenOffsets = new Set<number>();
    let offset = startOffset;
    for (;;) {
      if (offset <= 0 || offset >= this.buf.length) {
        throw new PdfCorruptError(`startxref points outside the file (byte ${String(offset)})`);
      }
      if (seenOffsets.has(offset)) {
        throw new PdfCorruptError("xref /Prev chain loops (corrupt)");
      }
      seenOffsets.add(offset);
      const section = this.#parseXrefSection(offset);
      for (const [num, entry] of section.table) {
        if (!table.has(num)) table.set(num, entry);
      }
      for (const [key, value] of section.trailer) {
        if (!trailer.has(key)) trailer.set(key, value);
      }
      const prev = section.trailer.get("Prev");
      if (prev === undefined) break;
      if (typeof prev !== "number") {
        throw new PdfCorruptError(`trailer /Prev must be a number (got ${describePdfValue(prev)})`);
      }
      offset = prev;
    }
    for (const key of ["Root", "Size"]) {
      if (trailer.get(key) === undefined) {
        throw new PdfCorruptError(`trailer misses /${key}`);
      }
    }
    return { table, trailer };
  }

  #parseXrefSection(offset: number): { table: Map<number, XrefEntry>; trailer: Map<string, PdfValue> } {
    const { buf } = this;
    if (bytesToLatin1(buf.subarray(offset, offset + 4)) !== "xref") {
      // 区分「损坏」与「不支持」：startxref 指向间接对象头且对象体带
      // /XRef（xref 流，PDF 1.5 压缩交叉引用）是合法 PDF 但超出本解析
      // 器口径——如实按 unsupported 拒绝；其余错位一律 corrupt。
      const head = bytesToLatin1(buf.subarray(offset, offset + 32));
      if (/^\d+\s+\d+\s+obj/.test(head)) {
        const body = bytesToLatin1(buf.subarray(offset, offset + 512));
        if (body.includes("/XRef")) {
          throw new PdfUnsupportedError(
            "cross-reference streams (compressed xref, PDF 1.5+) are not supported; only classic xref tables",
          );
        }
      }
      throw new PdfCorruptError(`byte ${String(offset)} is not an xref table (corrupt)`);
    }
    let pos = offset + 4;
    const skipWs = (): void => {
      while (pos < buf.length && WS_BYTES.has(buf[pos]!)) pos += 1;
    };
    const readInt = (): number | null => {
      skipWs();
      let s = "";
      while (pos < buf.length && buf[pos]! >= 0x30 && buf[pos]! <= 0x39) {
        s += String.fromCharCode(buf[pos]!);
        pos += 1;
      }
      return s === "" ? null : Number(s);
    };
    const table = new Map<number, XrefEntry>();
    for (;;) {
      const start = readInt();
      if (start === null) throw new PdfCorruptError("malformed xref subsection header");
      const count = readInt();
      if (count === null) throw new PdfCorruptError("malformed xref subsection count");
      for (let i = 0; i < count; i += 1) {
        skipWs();
        const entry = bytesToLatin1(buf.subarray(pos, pos + 20));
        pos += 20;
        const em = /^(\d{10}) (\d{5}) ([nf])/.exec(entry);
        if (em === null) {
          throw new PdfCorruptError(`malformed xref entry: ${JSON.stringify(entry.slice(0, 20))}`);
        }
        if (em[3] === "n") table.set(start + i, { offset: Number(em[1]), gen: Number(em[2]) });
      }
      skipWs();
      if (bytesToLatin1(buf.subarray(pos, pos + 7)) === "trailer") break;
    }
    const parsed = this.parseValueAt(pos + 7, 0);
    if (!(parsed.value instanceof Map)) throw new PdfCorruptError("trailer is not a dictionary");
    return { table, trailer: parsed.value };
  }

  parseValueAt(pos: number, depth: number): { value: PdfValue; next: number } {
    if (depth > MAX_NESTING_DEPTH) {
      throw new PdfCorruptError(`object nesting deeper than ${String(MAX_NESTING_DEPTH)} levels (corrupt)`);
    }
    const { buf } = this;
    const skipWsAndComments = (p: number): number => {
      for (;;) {
        while (p < buf.length && WS_BYTES.has(buf[p]!)) p += 1;
        if (p < buf.length && buf[p] === 0x25) {
          while (p < buf.length && buf[p] !== 0x0a) p += 1;
        } else return p;
      }
    };
    pos = skipWsAndComments(pos);
    const c = buf[pos];
    if (c === 0x3c) {
      if (buf[pos + 1] === 0x3c) return this.#parseDict(pos + 2, depth);
      // 十六进制字符串
      let end = pos + 1;
      while (end < buf.length && buf[end] !== 0x3e) end += 1;
      const hex = bytesToLatin1(buf.subarray(pos + 1, end)).replace(/[^0-9A-Fa-f]/g, "");
      return { value: hexToBytes(hex), next: end + 1 };
    }
    if (c === 0x28) return this.#parseLiteral(pos);
    if (c === 0x5b) {
      // 数组
      const out: PdfValue[] = [];
      let p = pos + 1;
      for (;;) {
        p = skipWsAndComments(p);
        if (buf[p] === 0x5d) return { value: out, next: p + 1 };
        const v = this.parseValueAt(p, depth + 1);
        out.push(v.value);
        p = v.next;
      }
    }
    if (c === 0x2f) {
      let end = pos + 1;
      while (end < buf.length && !WS_BYTES.has(buf[end]!) && !DELIM_BYTES.has(buf[end]!)) end += 1;
      return { value: new PdfName(bytesToLatin1(buf.subarray(pos + 1, end))), next: end };
    }
    if (bytesToLatin1(buf.subarray(pos, pos + 4)) === "true") return { value: true, next: pos + 4 };
    if (bytesToLatin1(buf.subarray(pos, pos + 5)) === "false") return { value: false, next: pos + 5 };
    if (bytesToLatin1(buf.subarray(pos, pos + 4)) === "null") return { value: null, next: pos + 4 };
    // 数字（整数/实数），可能是间接引用 "N G R" 的第一操作数
    let end = pos;
    while (end < buf.length && /[0-9+.\-]/.test(String.fromCharCode(buf[end]!))) end += 1;
    const numStr = bytesToLatin1(buf.subarray(pos, end));
    if (numStr === "") {
      throw new PdfCorruptError(`cannot parse a value at byte ${String(pos)}`);
    }
    let value: PdfValue = numStr.includes(".") ? parseFloat(numStr) : parseInt(numStr, 10);
    let next = end;
    // 间接引用前瞻：number number R
    const afterWs = skipWsAndComments(next);
    if (afterWs !== next && buf[afterWs] !== undefined && buf[afterWs]! >= 0x30 && buf[afterWs]! <= 0x39) {
      let end2 = afterWs;
      while (end2 < buf.length && buf[end2]! >= 0x30 && buf[end2]! <= 0x39) end2 += 1;
      const genStr = bytesToLatin1(buf.subarray(afterWs, end2));
      const afterWs2 = skipWsAndComments(end2);
      if (
        bytesToLatin1(buf.subarray(afterWs2, afterWs2 + 1)) === "R" &&
        !/[0-9A-Za-z]/.test(String.fromCharCode(buf[afterWs2 + 1] ?? 0x20))
      ) {
        value = { ref: [value as number, parseInt(genStr, 10)] };
        next = afterWs2 + 1;
      }
    }
    return { value, next };
  }

  #parseDict(pos: number, depth: number): { value: Map<string, PdfValue>; next: number } {
    const { buf } = this;
    const map = new Map<string, PdfValue>();
    let p = pos;
    const skipWsAndComments = (q: number): number => {
      for (;;) {
        while (q < buf.length && WS_BYTES.has(buf[q]!)) q += 1;
        if (q < buf.length && buf[q] === 0x25) {
          while (q < buf.length && buf[q] !== 0x0a) q += 1;
        } else return q;
      }
    };
    for (;;) {
      p = skipWsAndComments(p);
      if (buf[p] === 0x3e && buf[p + 1] === 0x3e) return { value: map, next: p + 2 };
      if (buf[p] !== 0x2f) {
        throw new PdfCorruptError(`expected a name key in dict at byte ${String(p)}`);
      }
      const key = this.parseValueAt(p, depth + 1);
      if (!(key.value instanceof PdfName)) throw new PdfCorruptError("dict key is not a name");
      p = skipWsAndComments(key.next);
      const val = this.parseValueAt(p, depth + 1);
      map.set(key.value.value, val.value);
      p = val.next;
    }
  }

  #parseLiteral(pos: number): { value: Uint8Array; next: number } {
    const { buf } = this;
    const out: number[] = [];
    let depth = 1;
    let p = pos + 1;
    while (p < buf.length && depth > 0) {
      const c = buf[p]!;
      if (c === 0x5c) {
        const e = buf[p + 1];
        if (e === 0x6e) {
          out.push(0x0a);
          p += 2;
        } else if (e === 0x72) {
          out.push(0x0d);
          p += 2;
        } else if (e === 0x74) {
          out.push(0x09);
          p += 2;
        } else if (e === 0x62) {
          out.push(0x08);
          p += 2;
        } else if (e === 0x66) {
          out.push(0x0c);
          p += 2;
        } else if (e === 0x0a) {
          p += 2; // 行续接：跳过
        } else if (e !== undefined && e >= 0x30 && e <= 0x37) {
          // 八进制转义：前进到反斜杠 + 全部数字之后（修正参考提取器的
          // 潜在多跳一位；见 tokenizeContent 同处注释）。
          let digits = "";
          let q = p + 1;
          while (q < buf.length && digits.length < 3 && buf[q]! >= 0x30 && buf[q]! <= 0x37) {
            digits += String.fromCharCode(buf[q]!);
            q += 1;
          }
          out.push(parseInt(digits, 8));
          p = q;
        } else if (e !== undefined) {
          out.push(e);
          p += 2;
        } else {
          p += 1; // 文件末尾的孤立反斜杠
        }
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
    return { value: Uint8Array.from(out), next: p + 1 };
  }

  getObject(num: number): PdfValue {
    const cached = this.#objects.get(num);
    if (cached !== undefined) return cached;
    const entry = this.xref.get(num);
    if (entry === undefined) {
      throw new PdfCorruptError(`object ${String(num)} is not in the xref table`);
    }
    const head = bytesToLatin1(this.buf.subarray(entry.offset, entry.offset + 64));
    const hm = new RegExp(`^${String(num)} ${String(entry.gen)} obj`).exec(head);
    if (hm === null) {
      throw new PdfCorruptError(
        `xref offset for object ${String(num)} does not point at "${String(num)} ${String(entry.gen)} obj" (corrupt)`,
      );
    }
    let pos = entry.offset + hm[0].length;
    const parsed = this.parseValueAt(pos, 0);
    let value = parsed.value;
    const after = parsed.next;
    // 流对象？（"<<" dict ">>" 空白 "stream" EOL 字节 "endstream"）
    let p = after;
    while (p < this.buf.length && WS_BYTES.has(this.buf[p]!)) p += 1;
    if (bytesToLatin1(this.buf.subarray(p, p + 6)) === "stream") {
      if (!(value instanceof Map)) throw new PdfCorruptError("stream object without a dict");
      p += 6; // "stream"
      if (this.buf[p] === 0x0d) p += 1;
      if (this.buf[p] !== 0x0a) throw new PdfCorruptError("stream keyword not followed by EOL");
      p += 1;
      const lengthRaw = value.get("Length");
      let length: number;
      if (typeof lengthRaw === "number") {
        length = lengthRaw;
      } else if (isPdfRef(lengthRaw)) {
        const resolved = this.resolve(lengthRaw);
        if (typeof resolved !== "number") {
          throw new PdfCorruptError(`stream /Length must be a number (indirect target is ${describePdfValue(resolved)})`);
        }
        length = resolved;
      } else {
        throw new PdfCorruptError(`stream /Length must be a direct or indirect number (got ${describePdfValue(lengthRaw)})`);
      }
      const bytes = this.buf.subarray(p, p + length);
      const endTag = bytesToLatin1(this.buf.subarray(p + length, p + length + 20));
      if (!/^\s*endstream/.test(endTag)) {
        throw new PdfCorruptError(`stream of object ${String(num)} is not terminated by endstream where /Length says`);
      }
      value = { dict: value, bytes, stream: true };
    }
    this.#objects.set(num, value);
    return value;
  }

  resolve(value: PdfValue): PdfValue {
    if (isPdfRef(value)) return this.getObject(value.ref[0]);
    return value;
  }
}
