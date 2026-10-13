/** decoding ownership for pdf-parser.ts; compatibility entrypoint remains one level above. */
import {
  PdfCorruptError,
  PdfUnsupportedError,
} from "./errors.ts";
import {
  describePdfValue,
  isPdfStream,
  PdfName,
  type PdfValue,
} from "./values.ts";
import {
  inflateSync,
} from "node:zlib";

/* ------------------------------------------------------------------ */
/* Latin-1（单字节 ⇔ U+0000..U+00FF）纯手写编解码                       */
/* ------------------------------------------------------------------ */

/**
 * 字节 → ISO-8859-1 字符串（逐字节 1:1；不用 TextDecoder——其 "latin1"
 * 实为 windows-1252，0x80..0x9F 段会改写，破坏字节回读）。内容流/CMap
 * 的 ASCII 主体与转义后的任意字节都经此无损往返。
 */
export function bytesToLatin1(bytes: Uint8Array): string {
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

export const WIN_ANSI_EXTRAS: Readonly<Record<number, string>> = {
  0x80: "€", 0x82: "‚", 0x83: "ƒ", 0x84: "„", 0x85: "…",
  0x86: "†", 0x87: "‡", 0x88: "ˆ", 0x89: "‰", 0x8a: "Š",
  0x8b: "‹", 0x8c: "Œ", 0x8e: "Ž", 0x91: "‘", 0x92: "’",
  0x93: "“", 0x94: "”", 0x95: "•", 0x96: "–", 0x97: "—",
  0x98: "˜", 0x99: "™", 0x9a: "š", 0x9b: "›", 0x9c: "œ",
  0x9e: "ž", 0x9f: "Ÿ",
};

export const WIN_ANSI_BYTE_TO_TEXT: ReadonlyMap<number, string> = (() => {
  const map = new Map<number, string>();
  for (let b = 0x20; b <= 0x7e; b += 1) map.set(b, String.fromCharCode(b));
  for (let b = 0xa1; b <= 0xff; b += 1) {
    if (b === 0xad) continue; // soft hyphen：WinAnsi 留 0xad 未定义
    map.set(b, String.fromCharCode(b));
  }
  for (const [b, text] of Object.entries(WIN_ANSI_EXTRAS)) map.set(Number(b), text);
  return map;
})();

export function winAnsiDecode(bytes: Uint8Array): string {
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

export function hexToBytes(hex: string): Uint8Array {
  const padded = hex.length % 2 === 0 ? hex : `${hex}0`;
  const out = new Uint8Array(padded.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** 解出流字节：无过滤器原样；FlateDecode 解压；其余 unsupported。 */
export function streamBytes(obj: PdfValue): Uint8Array {
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

export function utf16beToText(hex: string): string {
  if (hex.length % 2 !== 0) throw new PdfCorruptError("odd hex length in ToUnicode entry");
  const bytes = hexToBytes(hex);
  if (bytes.length % 2 !== 0) throw new PdfCorruptError("odd UTF-16BE length in ToUnicode");
  let out = "";
  for (let i = 0; i < bytes.length; i += 2) out += String.fromCharCode((bytes[i]! << 8) | bytes[i + 1]!);
  return out;
}

export function parseToUnicode(cmapText: string): Map<number, string> {
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
    /* 两种形态（PDF 32000-1 §9.10.3）：
       <lo> <hi> <start>        顺序映射（start + 偏移，与参考提取器一致）
       <lo> <hi> [<v1> <v2> …]  数组逐码映射（元素数必须等于码数）
       逐项扫描而非整体正则：数组形态若被「三段 hex」正则吞读，会把数组
       元素误当成顺序区间起点（静默错映射），此处显式区分两种形态。 */
    const block = m[2]!;
    const wsRe = /\s*/y;
    const hexRe = /<([0-9A-Fa-f]+)>/y;
    const skipWs = (p: number): number => {
      wsRe.lastIndex = p;
      return p + (wsRe.exec(block)?.[0].length ?? 0);
    };
    let p = 0;
    for (;;) {
      p = skipWs(p);
      if (p >= block.length) break;
      hexRe.lastIndex = p;
      const loM = hexRe.exec(block);
      if (loM === null) {
        p += 1; // 容错跳过非条目字符（注释文本等）
        continue;
      }
      const q = skipWs(hexRe.lastIndex);
      hexRe.lastIndex = q;
      const hiM = hexRe.exec(block);
      if (hiM === null) {
        p = q; // 只有 <lo> 而无 <hi>：残缺条目，跳过并继续扫描
        continue;
      }
      const r = skipWs(hexRe.lastIndex);
      if (block[r] === "[") {
        // 数组形态：显式逐码值，元素数必须等于 hi-lo+1（失配 = corrupt）
        const values: string[] = [];
        let k = r + 1;
        for (;;) {
          k = skipWs(k);
          if (block[k] === "]") {
            k += 1;
            break;
          }
          hexRe.lastIndex = k;
          const vM = hexRe.exec(block);
          if (vM === null) throw new PdfCorruptError("malformed bfrange array entry in ToUnicode CMap");
          values.push(vM[1]!);
          k = hexRe.lastIndex;
        }
        p = k;
        const lo = parseInt(loM[1]!, 16);
        const hi = parseInt(hiM[1]!, 16);
        if (hi < lo) {
          throw new PdfCorruptError(`ToUnicode bfrange <${loM[1]}> <${hiM[1]}> is a descending range`);
        }
        if (values.length !== hi - lo + 1) {
          throw new PdfCorruptError(
            `ToUnicode bfrange array has ${String(values.length)} values for ${String(hi - lo + 1)} codes (<${loM[1]}>..<${hiM[1]}>)`,
          );
        }
        for (let c = lo; c <= hi; c += 1) map.set(c, utf16beToText(values[c - lo]!));
      } else {
        // 顺序形态
        hexRe.lastIndex = r;
        const dstM = hexRe.exec(block);
        if (dstM === null) {
          p = r; // <lo> <hi> 后无第三段：残缺条目，跳过并继续扫描
          continue;
        }
        p = hexRe.lastIndex;
        const lo = parseInt(loM[1]!, 16);
        const hi = parseInt(hiM[1]!, 16);
        const start = parseInt(dstM[1]!, 16);
        for (let c = lo; c <= hi; c += 1) {
          map.set(c, utf16beToText((start + (c - lo)).toString(16).padStart(4, "0")));
        }
      }
    }
  }
  return map;
}
