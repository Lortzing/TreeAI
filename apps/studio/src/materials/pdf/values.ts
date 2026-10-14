/** values ownership for pdf-parser.ts; compatibility entrypoint remains one level above. */

/* ------------------------------------------------------------------ */
/* PDF 对象模型（名字 / 字典 / 数组 / 字符串 / 数字 / 间接引用 / 流）     */
/* ------------------------------------------------------------------ */

export class PdfName {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

export interface PdfRef {
  readonly ref: readonly [number, number];
}

export interface PdfStream {
  readonly dict: Map<string, PdfValue>;
  readonly bytes: Uint8Array;
  readonly stream: true;
}

export type PdfValue = number | boolean | null | PdfName | Uint8Array | PdfValue[] | Map<string, PdfValue> | PdfRef | PdfStream;

export const WS_BYTES = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);


export const DELIM_BYTES = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

export function isPdfRef(value: PdfValue | undefined): value is PdfRef {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    !(value instanceof Map) && !(value instanceof Uint8Array) && !(value instanceof PdfName) &&
    "ref" in value;
}

export function isPdfStream(value: PdfValue | undefined): value is PdfStream {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    !(value instanceof Map) && !(value instanceof Uint8Array) && !(value instanceof PdfName) &&
    "stream" in value;
}

/** 值为 PDF 名字时的名字串（否则 undefined）。 */
export function pdfNameOf(value: PdfValue | undefined): string | undefined {
  return value instanceof PdfName ? value.value : undefined;
}

/** 值的紧凑诊断表示（错误消息用；不参与解析）。 */
export function describePdfValue(value: PdfValue | undefined): string {
  if (value === undefined) return "(absent)";
  if (value instanceof PdfName) return `/${value.value}`;
  if (value instanceof Uint8Array) return `(string, ${value.length} bytes)`;
  if (Array.isArray(value)) return "(array)";
  if (value instanceof Map) return "(dictionary)";
  if (isPdfRef(value)) return `${value.ref[0]} ${value.ref[1]} R`;
  if (isPdfStream(value)) return "(stream)";
  return String(value);
}

export interface XrefEntry {
  readonly offset: number;
  readonly gen: number;
}
