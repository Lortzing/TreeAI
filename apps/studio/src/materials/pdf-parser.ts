/**
 * d4-pdf-v1 PDF 文字层解析器（D4-1「材料存储和导入」，issue #8；
 * D4 契约 §1/§6 真值规则；charter §5 上限）。
 *
 * 职责：PDF 原始字节 → 规范文本 canonicalText + 每页块图 blocks。
 * 零 npm 依赖的纯 Node 实现（node:zlib 解 FlateDecode；其余手写），
 * 是 scripts/d4/pdf/extract.mjs + layout.mjs（冻结 fixture 波的参考
 * 往返提取器）的应用侧移植——**运行时不 import scripts/**（生成工具
 * 与应用自包含互不依赖）；两侧行为以 12 个冻结 fixture 的
 * *.expected.json 真值为共同裁决。
 *
 * 冻结规则（d4-pdf-v1，与 D4 契约 §6 一致）：
 *  1. 钉死阅读顺序（移植 layout.mjs orderPageLines，唯一实现）：
 *     - 「行」= 一次文字显示操作序列（Tj/TJ/'/"）；位置取 Tj 时刻文本
 *       矩阵的平移点（首字形原点）(x, y)；
 *     - 栏带：页内去重升序 x 值贪心聚带——x 超出当前带最大 x **超过
 *       40 PDF 点**开新带（双栏页先整栏左、后整栏右）；
 *     - 带严格从左到右；带内自上而下（PDF y 递减），同 y 按 x 升序、
 *       再按内容流顺序；页眉页脚只是普通行；
 *     - 页文本 = 行以 "\n" 连接；除末页外每页块以 "\n" 结尾；
 *     - 全程**无任何 Unicode 归一化**（分解式组合字符、星面代理对
 *       逐字保留，UTF-16 偏移按码元计）。
 *  2. blocks：blockId "page-N"（N 为 1-based 真实页码，空页不产生块
 *     但不占位）、kind "pdf-page"、start/end 为 canonicalText 内 UTF-16
 *     码元半开区间连续覆盖（首 0、末 = 长度）、page 1-based；
 *     canonicalText === blocks.map(b => b.text).join("")（构造性成立）。
 *  3. 拒绝（ok:false，原因码稳定，入 MaterialVersion.parseError 前缀）：
 *     - "encrypted"：trailer 携带 /Encrypt（加密件拒收，不尝试解密）；
 *     - "corrupt"：结构损坏（缺 %PDF- 头 / startxref/%%EOF、xref 错位、
 *       对象/trailer 形状破坏、流 /Length 失配、页树破坏、内容流操作
 *       数残缺等）；
 *     - "no-text-layer"：全部页零文字显示操作（或拼得空文本）——
 *       纯图件/空内容流，绝不伪装成空 ready 文档；
 *     - "unsupported"：诚实能力边界（非 FlateDecode 流过滤器、
 *       非 Identity-H 的 Type0、无 ToUnicode 的 Type0、CID 无映射、
 *       非 WinAnsiEncoding 的 base Type1、其他字体子类型、
 *       xref 流/对象流等）——说明特征，不猜文本；
 *     - "pages-exceeded"：文本 PDF 超 200 页（charter §5，在解释任何
 *       内容流之前按页树页数拒绝）。
 *  4. 上限（charter §5，耗尽资源前拒绝）：页数上限经 options.maxPages
 *     注入（服务层共享 DEFAULT_MAX_PAGES = 200）；20 MiB 文件与
 *     100 万 UTF-16 单元上限在导入服务层（读体前 / 落库前）执行。
 *
 * 理解的 PDF 子集（与参考提取器一致的口径 + 少量标准泛化）：
 * 经典 xref 表（支持 /Prev 链；**不支持** xref 流/对象流）、未压缩或
 * FlateDecode 流（/Length 直数或间接引用）、可嵌套页树（页可继承
 * 父节点 /Resources）、Type0/Identity-H + ToUnicode（bfchar/bfrange）
 * 与 base-14 Type1/WinAnsiEncoding 字体、内容流文字操作
 * BT、ET、Tf、Td、TD、TL、T-star、Tm、Tj、TJ、单引号与双引号
 * （其余操作符忽略）。
 * 这是**应用解析器的诚实范围**，不是通用 PDF 规范实现；范围外特征
 * 一律按原因码拒绝，绝不静默产出猜测文本。
 */

import { inflateSync } from "node:zlib";

export const PDF_PARSER_KIND = "pdf" as const;
export const PDF_PARSER_VERSION = "d4-pdf-v1" as const;

/** 文本 PDF 页数上限（charter §5：200 页；页树装载后、内容解释前拒绝）。 */
export const DEFAULT_MAX_PAGES = 200;

/** 超限原因码：文本 PDF 超 200 页（与导入服务共享的稳定前缀）。 */
export const PAGES_EXCEEDED_REASON = "pages-exceeded";

/** d4-pdf-v1 的稳定拒绝原因码（parseError 的原因码部分）。 */
export type PdfRejectionReason = "encrypted" | "corrupt" | "no-text-layer" | "unsupported" | typeof PAGES_EXCEEDED_REASON;

/** 规范化后的 PDF 页块（B1 真值 blocks 数组项 = MaterialBlock + text）。 */
export interface PdfBlock {
  readonly blockId: string;
  readonly kind: "pdf-page";
  readonly start: number;
  readonly end: number;
  /** 1-based 真实页码（空页跳过不占号）。 */
  readonly page: number;
  readonly text: string;
}

export interface PdfParseSuccess {
  readonly ok: true;
  readonly parserKind: "pdf";
  readonly parserVersion: "d4-pdf-v1";
  readonly canonicalText: string;
  readonly blocks: readonly PdfBlock[];
  readonly textUnits: number;
  /** 文档页数（含无文字被跳过的空页）。 */
  readonly pages: number;
}

export interface PdfParseRejection {
  readonly ok: false;
  readonly parserKind: "pdf";
  readonly parserVersion: "d4-pdf-v1";
  readonly reason: PdfRejectionReason;
  readonly message: string;
}

export type PdfParseResult = PdfParseSuccess | PdfParseRejection;

export interface PdfParseOptions {
  /** 页数上限（缺省 DEFAULT_MAX_PAGES = 200，charter §5）。 */
  readonly maxPages?: number;
}

/* ------------------------------------------------------------------ */
/* 内部错误分类（top-level 统一映射为拒绝原因码）                        */
/* ------------------------------------------------------------------ */

/** 结构损坏（不可继续解析）。 */
class PdfCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfCorruptError";
  }
}

/** 加密文档（trailer /Encrypt）。 */
class PdfEncryptedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfEncryptedError";
  }
}

/** 能力边界之外的特征（诚实说明，不猜文本）。 */
class PdfUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfUnsupportedError";
  }
}

/* ------------------------------------------------------------------ */
/* Latin-1（单字节 ⇔ U+0000..U+00FF）纯手写编解码                       */
/* ------------------------------------------------------------------ */

/**
 * 字节 → ISO-8859-1 字符串（逐字节 1:1；不用 TextDecoder——其 "latin1"
 * 实为 windows-1252，0x80..0x9F 段会改写，破坏字节回读）。内容流/CMap
 * 的 ASCII 主体与转义后的任意字节都经此无损往返。
 */
function bytesToLatin1(bytes: Uint8Array): string {
  let out = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(bytes.length, i + CHUNK));
    out += String.fromCharCode(...slice);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* WinAnsiEncoding（PDF 1.7 Annex D.2；移植 scripts/d4/pdf/textenc.mjs） */
/* ------------------------------------------------------------------ */

const WIN_ANSI_EXTRAS: Readonly<Record<number, string>> = {
  0x80: "€", 0x82: "‚", 0x83: "ƒ", 0x84: "„", 0x85: "…",
  0x86: "†", 0x87: "‡", 0x88: "ˆ", 0x89: "‰", 0x8a: "Š",
  0x8b: "‹", 0x8c: "Œ", 0x8e: "Ž", 0x91: "‘", 0x92: "’",
  0x93: "“", 0x94: "”", 0x95: "•", 0x96: "–", 0x97: "—",
  0x98: "˜", 0x99: "™", 0x9a: "š", 0x9b: "›", 0x9c: "œ",
  0x9e: "ž", 0x9f: "Ÿ",
};

const WIN_ANSI_BYTE_TO_TEXT: ReadonlyMap<number, string> = (() => {
  const map = new Map<number, string>();
  for (let b = 0x20; b <= 0x7e; b += 1) map.set(b, String.fromCharCode(b));
  for (let b = 0xa1; b <= 0xff; b += 1) {
    if (b === 0xad) continue; // soft hyphen：WinAnsi 留 0xad 未定义
    map.set(b, String.fromCharCode(b));
  }
  for (const [b, text] of Object.entries(WIN_ANSI_EXTRAS)) map.set(Number(b), text);
  return map;
})();

function winAnsiDecode(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) {
    const text = WIN_ANSI_BYTE_TO_TEXT.get(b);
    if (text === undefined) {
      throw new PdfUnsupportedError(
        `byte 0x${b.toString(16)} has no WinAnsiEncoding mapping (character mapping cannot be verified)`,
      );
    }
    out += text;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* PDF 对象模型（名字 / 字典 / 数组 / 字符串 / 数字 / 间接引用 / 流）     */
/* ------------------------------------------------------------------ */

class PdfName {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

interface PdfRef {
  readonly ref: readonly [number, number];
}

interface PdfStream {
  readonly dict: Map<string, PdfValue>;
  readonly bytes: Uint8Array;
  readonly stream: true;
}

type PdfValue = number | boolean | null | PdfName | Uint8Array | PdfValue[] | Map<string, PdfValue> | PdfRef | PdfStream;

const WS_BYTES = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM_BYTES = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

function isPdfRef(value: PdfValue | undefined): value is PdfRef {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    !(value instanceof Map) && !(value instanceof Uint8Array) && !(value instanceof PdfName) &&
    "ref" in value;
}

function isPdfStream(value: PdfValue | undefined): value is PdfStream {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    !(value instanceof Map) && !(value instanceof Uint8Array) && !(value instanceof PdfName) &&
    "stream" in value;
}

/** 值为 PDF 名字时的名字串（否则 undefined）。 */
function pdfNameOf(value: PdfValue | undefined): string | undefined {
  return value instanceof PdfName ? value.value : undefined;
}

/** 值的紧凑诊断表示（错误消息用；不参与解析）。 */
function describePdfValue(value: PdfValue | undefined): string {
  if (value === undefined) return "(absent)";
  if (value instanceof PdfName) return `/${value.value}`;
  if (value instanceof Uint8Array) return `(string, ${value.length} bytes)`;
  if (Array.isArray(value)) return "(array)";
  if (value instanceof Map) return "(dictionary)";
  if (isPdfRef(value)) return `${value.ref[0]} ${value.ref[1]} R`;
  if (isPdfStream(value)) return "(stream)";
  return String(value);
}

interface XrefEntry {
  readonly offset: number;
  readonly gen: number;
}

/** 嵌套深度上限（防病态嵌套打穿调用栈：合法 PDF 远不到此深度）。 */
const MAX_NESTING_DEPTH = 64;

/**
 * 字节级 PDF 对象解析器（移植 scripts/d4/pdf/extract.mjs 的 PdfParser，
 * 增补：/Prev xref 链、间接 /Length、嵌套页树与 /Resources 继承）。
 */
class PdfObjectParser {
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

function hexToBytes(hex: string): Uint8Array {
  const padded = hex.length % 2 === 0 ? hex : `${hex}0`;
  const out = new Uint8Array(padded.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** 解出流字节：无过滤器原样；FlateDecode 解压；其余 unsupported。 */
function streamBytes(obj: PdfValue): Uint8Array {
  if (!isPdfStream(obj)) throw new PdfCorruptError("expected a stream object");
  const filter = obj.dict.get("Filter");
  if (filter === undefined) return obj.bytes;
  const filters: string[] =
    filter instanceof PdfName
      ? [filter.value]
      : Array.isArray(filter) && filter.every((f) => f instanceof PdfName)
        ? (filter as PdfName[]).map((f) => f.value)
        : [];
  if (filters.length !== 1 || filters[0] !== "FlateDecode") {
    throw new PdfUnsupportedError(
      `unsupported stream filter: ${describePdfValue(filter)} (only no filter or /FlateDecode)`,
    );
  }
  try {
    return new Uint8Array(inflateSync(obj.bytes));
  } catch (error) {
    throw new PdfCorruptError(`FlateDecode stream failed to inflate (${error instanceof Error ? error.message : String(error)})`);
  }
}

/* ------------------------------------------------------------------ */
/* ToUnicode CMap（bfchar / bfrange；移植 extract.mjs parseToUnicode）   */
/* ------------------------------------------------------------------ */

function utf16beToText(hex: string): string {
  if (hex.length % 2 !== 0) throw new PdfCorruptError("odd hex length in ToUnicode entry");
  const bytes = hexToBytes(hex);
  if (bytes.length % 2 !== 0) throw new PdfCorruptError("odd UTF-16BE length in ToUnicode");
  let out = "";
  for (let i = 0; i < bytes.length; i += 2) out += String.fromCharCode((bytes[i]! << 8) | bytes[i + 1]!);
  return out;
}

function parseToUnicode(cmapText: string): Map<number, string> {
  const map = new Map<number, string>(); // code -> text
  const bfchar = /(\d+)\s+beginbfchar([\s\S]*?)endbfchar/g;
  let m: RegExpExecArray | null;
  while ((m = bfchar.exec(cmapText)) !== null) {
    const entry = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let e: RegExpExecArray | null;
    while ((e = entry.exec(m[2]!)) !== null) {
      map.set(parseInt(e[1]!, 16), utf16beToText(e[2]!));
    }
  }
  const bfrange = /(\d+)\s+beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = bfrange.exec(cmapText)) !== null) {
    const entry = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let e: RegExpExecArray | null;
    while ((e = entry.exec(m[2]!)) !== null) {
      const lo = parseInt(e[1]!, 16);
      const hi = parseInt(e[2]!, 16);
      const start = parseInt(e[3]!, 16);
      for (let c = lo; c <= hi; c += 1) {
        map.set(c, utf16beToText((start + (c - lo)).toString(16).padStart(4, "0")));
      }
    }
  }
  return map;
}

/* ------------------------------------------------------------------ */
/* 内容流：字节级 tokenizer + 文字操作解释器（移植 extract.mjs）         */
/* ------------------------------------------------------------------ */

type ContentToken =
  | { readonly t: "num"; readonly v: number }
  | { readonly t: "str"; readonly v: Uint8Array }
  | { readonly t: "name"; readonly v: string }
  | { readonly t: "op"; readonly v: string }
  | { readonly t: "arr"; readonly v: readonly ContentToken[] }
  | { readonly t: "delim"; readonly v: string };

const CONTENT_DELIMS = new Set([" ", "\n", "\r", "\t", "\f", "\0", "(", ")", "<", ">", "[", "]", "{", "}", "/", "%"]);

function tokenizeContent(bytes: Uint8Array): ContentToken[] {
  const tokens: ContentToken[] = [];
  const text = bytesToLatin1(bytes);
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
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
        const d = text[j]!;
        if (d === "\\") {
          const e = text[j + 1];
          if (e === "n") {
            out += "\n";
            j += 2;
          } else if (e === "r") {
            out += "\r";
            j += 2;
          } else if (e === "t") {
            out += "\t";
            j += 2;
          } else if (e === "b") {
            out += "\b";
            j += 2;
          } else if (e === "f") {
            out += "\f";
            j += 2;
          } else if (e === "\n") {
            j += 2; // 行续接：跳过
          } else if (e !== undefined && e >= "0" && e <= "7") {
            // 八进制转义：前进到反斜杠 + 全部数字之后。（参考提取器在此
            // 多跳一位——生成器从不产八进制转义，冻结语料无法触发的潜在
            // bug；本移植修正，否则 "\351)" 会吞掉右括号。）
            let digits = "";
            let q = j + 1;
            while (q < n && digits.length < 3 && text[q]! >= "0" && text[q]! <= "7") {
              digits += text[q]!;
              q += 1;
            }
            out += String.fromCharCode(parseInt(digits, 8));
            j = q;
          } else if (e !== undefined) {
            out += e;
            j += 2;
          } else {
            j += 1; // 文件末尾的孤立反斜杠
          }
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
      tokens.push({ t: "str", v: latin1ToBytes(out) });
      i = j + 1;
      continue;
    }
    if (c === "<" && text[i + 1] !== "<") {
      let j = i + 1;
      while (j < n && text[j] !== ">") j += 1;
      let hex = text.slice(i + 1, j).replace(/[^0-9A-Fa-f]/g, "");
      if (hex.length % 2 === 1) hex += "0";
      tokens.push({ t: "str", v: hexToBytes(hex) });
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
      while (j < n && !CONTENT_DELIMS.has(text[j]!)) j += 1;
      tokens.push({ t: "name", v: text.slice(i + 1, j) });
      i = j;
      continue;
    }
    // 数字或关键字（操作符）
    let j = i;
    while (j < n && !CONTENT_DELIMS.has(text[j]!)) j += 1;
    const word = text.slice(i, j);
    if (/^[0-9+\-.]/.test(word)) tokens.push({ t: "num", v: parseFloat(word) });
    else tokens.push({ t: "op", v: word });
    i = j;
  }
  return tokens;
}

/** latin1 字符串（每字符 ≤ U+00FF）→ 字节。 */
function latin1ToBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** 把 [ ] 分隔符折叠为数组 token（TJ 操作数；嵌套数组不生成——与参考一致静默忽略）。 */
function retokenizeWithArrays(content: Uint8Array): ContentToken[] {
  const flat = tokenizeContent(content);
  const out: ContentToken[] = [];
  let stack: ContentToken[] | null = null;
  for (const tok of flat) {
    if (tok.t === "delim" && tok.v === "[") {
      if (stack === null) stack = [];
      // 嵌套数组：与参考提取器一致——标记并入当前数组，后续 TJ 只取字符串项
      else stack.push({ t: "delim", v: "[" });
      continue;
    }
    if (tok.t === "delim" && tok.v === "]") {
      if (stack === null) throw new PdfCorruptError("unbalanced ] in content stream");
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

type FontSpec =
  | { readonly subtype: "Type0"; readonly toUnicode: ReadonlyMap<number, string> }
  | { readonly subtype: "Type1" };

/** 一条视觉文字行（Tj 时刻的文本矩阵平移点 + 顺序号）。 */
export interface PageTextLine {
  readonly x: number;
  readonly y: number;
  readonly order: number;
  readonly text: string;
}

function interpretContent(tokens: readonly ContentToken[], fonts: ReadonlyMap<string, FontSpec>): PageTextLine[] {
  const lines: PageTextLine[] = [];
  let order = 0;
  let tm: readonly number[] = [1, 0, 0, 1, 0, 0];
  let lm: readonly number[] = [1, 0, 0, 1, 0, 0];
  let leading = 0;
  let font: FontSpec | null = null;
  const operands: ContentToken[] = [];
  const decode = (bytes: Uint8Array): string => {
    if (font === null) throw new PdfCorruptError("Tj without a current font");
    if (font.subtype === "Type0") {
      if (bytes.length % 2 !== 0) {
        throw new PdfCorruptError("Identity-H string has an odd byte count");
      }
      let out = "";
      for (let i = 0; i < bytes.length; i += 2) {
        const code = (bytes[i]! << 8) | bytes[i + 1]!;
        const text = font.toUnicode.get(code);
        if (text === undefined) {
          throw new PdfUnsupportedError(
            `CID ${String(code)} (0x${code.toString(16)}) has no ToUnicode entry (character mapping cannot be verified)`,
          );
        }
        out += text;
      }
      return out;
    }
    return winAnsiDecode(bytes);
  };
  const emit = (text: string): void => {
    // 空串也是一条行：生成器用 () Tj 表示空代码行，真值如实带空行。
    lines.push({ x: tm[4]!, y: tm[5]!, order: order++, text });
  };
  const translateLm = (tx: number, ty: number): void => {
    lm = [lm[0]!, lm[1]!, lm[2]!, lm[3]!, lm[4]! + tx, lm[5]! + ty];
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
        if (nameTok === undefined || nameTok.t !== "name") {
          throw new PdfCorruptError("Tf without a font name");
        }
        font = fonts.get(nameTok.v) ?? null;
        if (font === null) {
          throw new PdfCorruptError(`Tf references an unknown font resource: /${nameTok.v}`);
        }
        break;
      }
      case "Td":
      case "TD": {
        const ty = operands[operands.length - 1]?.v;
        const tx = operands[operands.length - 2]?.v;
        if (typeof tx !== "number" || typeof ty !== "number") {
          throw new PdfCorruptError("Td without two numbers");
        }
        if (tok.v === "TD") leading = -ty;
        translateLm(tx, ty);
        break;
      }
      case "TL": {
        const tl = operands[operands.length - 1]?.v;
        if (typeof tl !== "number") throw new PdfCorruptError("TL without a number");
        leading = tl;
        break;
      }
      case "T*":
        translateLm(0, -leading);
        break;
      case "Tm": {
        const f = operands.slice(-6).map((o) => o.v);
        if (f.length !== 6 || !f.every((v) => typeof v === "number")) {
          throw new PdfCorruptError("Tm needs 6 numeric operands");
        }
        lm = f as readonly number[];
        tm = [...lm];
        break;
      }
      case "Tj": {
        const s = operands[operands.length - 1];
        if (s === undefined || s.t !== "str") throw new PdfCorruptError("Tj without a string");
        emit(decode(s.v));
        break;
      }
      case "TJ": {
        const arr = operands[operands.length - 1];
        if (arr === undefined || arr.t !== "arr") throw new PdfCorruptError("TJ without an array");
        let text = "";
        for (const item of arr.v) {
          if (item.t === "str") text += decode(item.v);
        }
        emit(text);
        break;
      }
      case "'": {
        const s = operands[operands.length - 1];
        if (s === undefined || s.t !== "str") throw new PdfCorruptError("' without a string");
        translateLm(0, -leading);
        emit(decode(s.v));
        break;
      }
      case '"': {
        // PDF 32000-1 §9.4.3：aw ac string "——字符串是最后一个操作数。
        // （参考提取器在此取 len-3，是未被生成器触发的潜在 bug；本移植修正。）
        const s = operands[operands.length - 1];
        if (s === undefined || s.t !== "str") throw new PdfCorruptError('" without a string');
        translateLm(0, -leading);
        emit(decode(s.v));
        break;
      }
      default:
        break; // q/Q/cm/gs/rg/Do/...：本解析器口径内无文字模型效果
    }
    operands.length = 0;
  }
  return lines;
}

/* ------------------------------------------------------------------ */
/* 钉死阅读顺序（移植 layout.mjs orderPageLines——d4-pdf-v1 唯一规则）    */
/* ------------------------------------------------------------------ */

/** 栏带间隔阈值（PDF 点）：x 超出当前带最大 x 超过该值开新带。 */
export const BAND_GAP = 40;

export function orderPageLines(lines: readonly PageTextLine[]): PageTextLine[] {
  const xs = [...new Set(lines.map((l) => l.x))].sort((a, b) => a - b);
  const bands: { minX: number; maxX: number }[] = [];
  let band: { minX: number; maxX: number } | null = null;
  for (const x of xs) {
    if (band === null || x - band.maxX > BAND_GAP) {
      band = { minX: x, maxX: x };
      bands.push(band);
    } else if (x > band.maxX) {
      band.maxX = x;
    }
  }
  const bandIndexOf = (x: number): number => {
    for (let i = 0; i < bands.length; i += 1) {
      if (x >= bands[i]!.minX && x <= bands[i]!.maxX) return i;
    }
    throw new PdfCorruptError(`x ${String(x)} not in any band`);
  };
  return [...lines].sort((a, b) => {
    const ba = bandIndexOf(a.x);
    const bb = bandIndexOf(b.x);
    if (ba !== bb) return ba - bb;
    if (a.y !== b.y) return b.y - a.y; // y 递减（页首在前）
    if (a.x !== b.x) return a.x - b.x;
    return a.order - b.order;
  });
}

/* ------------------------------------------------------------------ */
/* 文档级提取                                                          */
/* ------------------------------------------------------------------ */

interface PageNode {
  readonly dict: Map<string, PdfValue>;
  readonly inheritedResources: Map<string, PdfValue> | undefined;
}

/** 递归展开页树（支持中间 /Pages 节点与 /Resources 继承）。 */
function collectPageNodes(
  parser: PdfObjectParser,
  nodeValue: PdfValue,
  inheritedResources: Map<string, PdfValue> | undefined,
  out: PageNode[],
  depth: number,
): void {
  if (depth > MAX_NESTING_DEPTH) throw new PdfCorruptError("page tree nested too deep (loop?)");
  const node = parser.resolve(nodeValue);
  if (!(node instanceof Map)) throw new PdfCorruptError("page tree node is not a dictionary");
  const type = node.get("Type");
  const typeName = type instanceof PdfName ? type.value : undefined;
  if (typeName === "Page") {
    out.push({ dict: node, inheritedResources });
    return;
  }
  if (typeName !== "Pages") {
    throw new PdfCorruptError(`page tree node has unexpected /Type ${describePdfValue(type)}`);
  }
  const kidsRaw = node.get("Kids");
  if (kidsRaw === undefined) throw new PdfCorruptError("page tree node has no /Kids");
  const kids = parser.resolve(kidsRaw);
  if (!Array.isArray(kids)) throw new PdfCorruptError("page tree node has no /Kids array");
  const ownResourcesRaw = node.get("Resources");
  let resources = inheritedResources;
  if (ownResourcesRaw !== undefined && ownResourcesRaw !== null) {
    const resolved = parser.resolve(ownResourcesRaw);
    if (!(resolved instanceof Map)) throw new PdfCorruptError("page tree /Resources is not a dictionary");
    resources = resolved;
  }
  for (const kid of kids) {
    collectPageNodes(parser, kid, resources, out, depth + 1);
  }
}

function extractPdfDocument(bytes: Uint8Array, maxPages: number): PdfParseResult {
  const parser = new PdfObjectParser(bytes);
  if (parser.trailer.get("Encrypt") !== undefined) {
    throw new PdfEncryptedError(
      "trailer carries /Encrypt — encrypted PDFs are rejected by text-layer import (no decryption is attempted)",
    );
  }
  const root = parser.resolve(parser.trailer.get("Root")!);
  if (!(root instanceof Map) || pdfNameOf(root.get("Type")) !== "Catalog") {
    throw new PdfCorruptError("bad document catalog");
  }
  const pagesRootRaw = root.get("Pages");
  if (pagesRootRaw === undefined) throw new PdfCorruptError("catalog has no /Pages");
  const pagesRoot = parser.resolve(pagesRootRaw);
  if (!(pagesRoot instanceof Map) || pdfNameOf(pagesRoot.get("Type")) !== "Pages") {
    throw new PdfCorruptError("bad page tree root");
  }
  const pageNodes: PageNode[] = [];
  collectPageNodes(parser, pagesRoot, undefined, pageNodes, 0);
  const countRaw = pagesRoot.get("Count");
  if (countRaw === undefined) throw new PdfCorruptError("page tree root has no /Count");
  const count = parser.resolve(countRaw);
  if (typeof count !== "number") throw new PdfCorruptError("page tree root has no numeric /Count");
  if (pageNodes.length !== count) {
    throw new PdfCorruptError(`page /Count (${String(count)}) != leaf pages (${String(pageNodes.length)})`);
  }
  if (pageNodes.length === 0) throw new PdfCorruptError("page tree has no pages");

  // charter §5：页数上限在解释任何内容流之前拒绝（不耗资源抽取超限文本）。
  if (pageNodes.length > maxPages) {
    return {
      ok: false,
      parserKind: PDF_PARSER_KIND,
      parserVersion: PDF_PARSER_VERSION,
      reason: PAGES_EXCEEDED_REASON,
      message:
        `the document has ${String(pageNodes.length)} pages, exceeding the ${String(maxPages)}-page text-PDF limit ` +
        "(rejected before extracting text; charter D4 §5)",
    };
  }

  let totalLines = 0;
  const pages: { readonly text: string; readonly lineCount: number }[] = [];
  for (const page of pageNodes) {
    // /Resources：页自有优先，缺省继承最近祖先（中间 /Pages 节点）。
    const ownResourcesRaw = page.dict.get("Resources");
    let resources = page.inheritedResources;
    if (ownResourcesRaw !== undefined && ownResourcesRaw !== null) {
      const resolved = parser.resolve(ownResourcesRaw);
      if (!(resolved instanceof Map)) throw new PdfCorruptError("page /Resources is not a dictionary");
      resources = resolved;
    }
    const fontDictRaw = resources?.get("Font");
    const fonts = new Map<string, FontSpec>();
    if (fontDictRaw !== undefined && fontDictRaw !== null) {
      const fontDict = parser.resolve(fontDictRaw);
      if (!(fontDict instanceof Map)) throw new PdfCorruptError("page resources /Font is not a dictionary");
      for (const [name, ref] of fontDict) {
        const font = parser.resolve(ref);
        if (!(font instanceof Map)) throw new PdfCorruptError("font entry is not a dict");
        const subtype = font.get("Subtype");
        const subtypeName = subtype instanceof PdfName ? subtype.value : undefined;
        if (subtypeName === "Type0") {
          const enc = font.get("Encoding");
          if (!(enc instanceof PdfName) || enc.value !== "Identity-H") {
            throw new PdfUnsupportedError(
              `only Identity-H Type0 fonts are understood (got /Encoding ${describePdfValue(enc)})`,
            );
          }
          const toUnicodeRaw = font.get("ToUnicode");
          if (toUnicodeRaw === undefined) {
            throw new PdfUnsupportedError("Type0 font without a ToUnicode CMap cannot be mapped to text");
          }
          const toUnicode = parser.resolve(toUnicodeRaw);
          const cmapText = bytesToLatin1(streamBytes(toUnicode));
          fonts.set(name, { subtype: "Type0", toUnicode: parseToUnicode(cmapText) });
        } else if (subtypeName === "Type1") {
          const enc = font.get("Encoding");
          if (!(enc instanceof PdfName) || enc.value !== "WinAnsiEncoding") {
            throw new PdfUnsupportedError(
              `base-14 Type1 fonts must use WinAnsiEncoding (got /Encoding ${describePdfValue(enc)})`,
            );
          }
          fonts.set(name, { subtype: "Type1" });
        } else {
          throw new PdfUnsupportedError(`unsupported font subtype in page resources: ${describePdfValue(subtype)}`);
        }
      }
    }
    const contentsRaw = page.dict.get("Contents");
    const tokens: ContentToken[] = [];
    if (contentsRaw !== undefined) {
      const contents = parser.resolve(contentsRaw);
      const streams: PdfValue[] = Array.isArray(contents) ? contents : [contents];
      for (const s of streams) {
        for (const tok of retokenizeWithArrays(streamBytes(parser.resolve(s)))) tokens.push(tok);
      }
    }
    const lines = interpretContent(tokens, fonts);
    totalLines += lines.length;
    const ordered = orderPageLines(lines);
    pages.push({ text: ordered.map((l) => l.text).join("\n"), lineCount: ordered.length });
  }

  if (totalLines === 0) {
    return {
      ok: false,
      parserKind: PDF_PARSER_KIND,
      parserVersion: PDF_PARSER_VERSION,
      reason: "no-text-layer",
      message:
        "the document has no extractable text layer (zero text-showing operations across all pages; " +
        "scanned/image-only or empty-content PDFs are not OCR targets in this version)",
    };
  }

  // 组块：非末页（含仅空行的页）以 "\n" 收尾；末页无强制终止符；零文字
  // 操作的页（或拼得 0 单元的末页）不产生块——blockId 仍用真实 1-based 页码。
  let canonicalText = "";
  const blocks: PdfBlock[] = [];
  for (let i = 0; i < pages.length; i += 1) {
    const isFinalPage = i === pages.length - 1;
    const pageText = isFinalPage ? pages[i]!.text : `${pages[i]!.text}\n`;
    if (pages[i]!.lineCount === 0 || pageText.length === 0) continue;
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
  if (canonicalText.length === 0) {
    return {
      ok: false,
      parserKind: PDF_PARSER_KIND,
      parserVersion: PDF_PARSER_VERSION,
      reason: "no-text-layer",
      message:
        "the document has no extractable text layer (text-showing operations carry no text; " +
        "the canonical text would be empty)",
    };
  }
  return {
    ok: true,
    parserKind: PDF_PARSER_KIND,
    parserVersion: PDF_PARSER_VERSION,
    canonicalText,
    blocks,
    textUnits: canonicalText.length,
    pages: pages.length,
  };
}

/* ------------------------------------------------------------------ */
/* 入口                                                               */
/* ------------------------------------------------------------------ */

function rejection(reason: PdfRejectionReason, message: string): PdfParseRejection {
  return { ok: false, parserKind: PDF_PARSER_KIND, parserVersion: PDF_PARSER_VERSION, reason, message };
}

/** d4-pdf-v1 解析：PDF 原始字节 → 规范文本 + 每页块图；非法/超范围稳定拒绝。 */
export function parsePdfMaterial(bytes: Uint8Array, options: PdfParseOptions = {}): PdfParseResult {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new RangeError(`maxPages must be a positive integer (got ${String(maxPages)})`);
  }
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("parsePdfMaterial expects a Uint8Array");
  }
  try {
    return extractPdfDocument(bytes, maxPages);
  } catch (error) {
    if (error instanceof PdfEncryptedError) return rejection("encrypted", error.message);
    if (error instanceof PdfUnsupportedError) return rejection("unsupported", error.message);
    if (error instanceof PdfCorruptError) return rejection("corrupt", error.message);
    if (error instanceof RangeError) {
      return rejection("corrupt", `malformed nesting exceeds the interpreter stack (${error.message})`);
    }
    throw error; // 意外错误如实上抛（服务层记 parse-internal），绝不伪成功
  }
}
