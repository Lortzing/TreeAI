/** fonts ownership for pdf-parser.ts; compatibility entrypoint remains one level above. */
import {
  bytesToLatin1,
  parseToUnicode,
  streamBytes,
} from "./decoding.ts";
import {
  PdfCorruptError,
  PdfUnsupportedError,
} from "./errors.ts";
import type {
  PdfObjectParser,
} from "./objects.ts";
import {
  describePdfValue,
  PdfName,
  type PdfValue,
} from "./values.ts";

export type FontSpec =
  | { readonly subtype: "Type0"; readonly toUnicode: ReadonlyMap<number, string> }
  | { readonly subtype: "Type1" };

/**
 * 物化一个字体规格（首次真正用于显示文字时才调用）：
 * Type0/Identity-H + ToUnicode（bfchar/bfrange 两种形态）或
 * base-14 Type1/WinAnsiEncoding；其余一律 unsupported（说明特征，
 * 不猜文本）。惰性口径：未用于显示的字体不会走到这里——坏字体
 * 不拖垮整页，只有它显示的文字才触发拒绝。
 */
export function materializeFontSpec(parser: PdfObjectParser, raw: PdfValue): FontSpec {
  const font = parser.resolve(raw);
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
    return { subtype: "Type0", toUnicode: parseToUnicode(cmapText) };
  }
  if (subtypeName === "Type1") {
    const enc = font.get("Encoding");
    if (!(enc instanceof PdfName) || enc.value !== "WinAnsiEncoding") {
      throw new PdfUnsupportedError(
        `base-14 Type1 fonts must use WinAnsiEncoding (got /Encoding ${describePdfValue(enc)})`,
      );
    }
    return { subtype: "Type1" };
  }
  throw new PdfUnsupportedError(`unsupported font subtype in page resources: ${describePdfValue(subtype)}`);
}
