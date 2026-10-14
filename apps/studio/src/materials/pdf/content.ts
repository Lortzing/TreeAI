/** content ownership for pdf-parser.ts; compatibility entrypoint remains one level above. */
import {
  winAnsiDecode,
} from "./decoding.ts";
import {
  PdfCorruptError,
  PdfUnsupportedError,
} from "./errors.ts";
import type {
  FontSpec,
} from "./fonts.ts";
import type {
  PageTextLine,
} from "./model.ts";
import type {
  ContentToken,
} from "./tokenizer.ts";

export function interpretContent(
  tokens: readonly ContentToken[],
  fonts: ReadonlyMap<string, () => FontSpec>,
): PageTextLine[] {
  const lines: PageTextLine[] = [];
  let order = 0;
  let tm: readonly number[] = [1, 0, 0, 1, 0, 0];
  let lm: readonly number[] = [1, 0, 0, 1, 0, 0];
  let leading = 0;
  let fontFactory: (() => FontSpec) | null = null;
  let fontSize: number | null = null;
  const operands: ContentToken[] = [];
  const decode = (bytes: Uint8Array): string => {
    if (fontFactory === null) throw new PdfCorruptError("Tj without a current font");
    if (bytes.length === 0) return ""; // 零字节零字形：无需物化字体（惰性口径）
    const font = fontFactory();
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
    lines.push({ x: tm[4]!, y: tm[5]!, order: order++, text, fontSize });
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
        /* 惰性：Tf 只登记当前字体的物化闭包（名字缺失亦然）——只有
           真正显示非空文字时才解析/校验，未显示的 Tf 不影响页面。 */
        const factory = fonts.get(nameTok.v);
        const sizeTok = operands[operands.length - 1];
        fontSize = sizeTok !== undefined && typeof sizeTok.v === "number" ? Math.abs(sizeTok.v) : null;
        if (factory !== undefined) {
          fontFactory = factory;
        } else {
          const missing = nameTok.v;
          fontFactory = (): FontSpec => {
            throw new PdfCorruptError(`Tf references an unknown font resource: /${missing}`);
          };
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
