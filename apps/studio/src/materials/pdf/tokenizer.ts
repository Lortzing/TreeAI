/** tokenizer ownership for pdf-parser.ts; compatibility entrypoint remains one level above. */
import {
  bytesToLatin1,
  hexToBytes,
} from "./decoding.ts";
import {
  PdfCorruptError,
} from "./errors.ts";

/* ------------------------------------------------------------------ */
/* 内容流：字节级 tokenizer + 文字操作解释器（移植 extract.mjs）         */
/* ------------------------------------------------------------------ */

export type ContentToken =
  | { readonly t: "num"; readonly v: number }
  | { readonly t: "str"; readonly v: Uint8Array }
  | { readonly t: "name"; readonly v: string }
  | { readonly t: "op"; readonly v: string }
  | { readonly t: "arr"; readonly v: readonly ContentToken[] }
  | { readonly t: "delim"; readonly v: string };

export const CONTENT_DELIMS = new Set([" ", "\n", "\r", "\t", "\f", "\0", "(", ")", "<", ">", "[", "]", "{", "}", "/", "%"]);

export function isContentWs(c: string): boolean {
  return c === " " || c === "\n" || c === "\r" || c === "\t" || c === "\f" || c === "\0";
}

export function tokenizeContent(bytes: Uint8Array): ContentToken[] {
  const tokens: ContentToken[] = [];
  const text = bytesToLatin1(bytes);
  let i = 0;
  const n = text.length;
  /* BI/ID/EI 内联图（PDF 32000-1 §8.9.7）状态：BI 之后、ID 之前的字典
     经正常词法消费但不产出 token（字符串/名字里的 "ID"/"EI" 不会误触
     发）；ID 之后单个空白起为二进制，整体跳到「前置空白 + 后随空白/
     分隔符」的 EI——无 /Length 时的通行启发式。内联图对文字模型零效果。 */
  let inInlineImage = false;
  const push = (tok: ContentToken): void => {
    if (!inInlineImage) tokens.push(tok);
  };
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
      push({ t: "str", v: latin1ToBytes(out) });
      i = j + 1;
      continue;
    }
    if (c === "<" && text[i + 1] !== "<") {
      let j = i + 1;
      while (j < n && text[j] !== ">") j += 1;
      let hex = text.slice(i + 1, j).replace(/[^0-9A-Fa-f]/g, "");
      if (hex.length % 2 === 1) hex += "0";
      push({ t: "str", v: hexToBytes(hex) });
      i = j + 1;
      continue;
    }
    if (c === "<" || c === ">" || c === "[" || c === "]") {
      push({ t: "delim", v: c });
      i += 1;
      continue;
    }
    if (c === "/") {
      let j = i + 1;
      while (j < n && !CONTENT_DELIMS.has(text[j]!)) j += 1;
      push({ t: "name", v: text.slice(i + 1, j) });
      i = j;
      continue;
    }
    // 数字或关键字（操作符）
    let j = i;
    while (j < n && !CONTENT_DELIMS.has(text[j]!)) j += 1;
    const word = text.slice(i, j);
    if (word === "BI") {
      inInlineImage = true;
      i = j;
      continue;
    }
    if (inInlineImage) {
      if (word === "ID") {
        // ID 后单个空白字符（CRLF 记作一对）之后是二进制数据
        let k = j;
        if (k < n && isContentWs(text[k]!)) k += 1;
        if (text[k - 1] === "\r" && text[k] === "\n") k += 1;
        let end = -1;
        while (k < n) {
          if (text[k] === "E" && text[k + 1] === "I") {
            const after = text[k + 2];
            const afterOk = after === undefined || isContentWs(after) || "()<>[]{}/%".includes(after);
            if (isContentWs(text[k - 1]!) && afterOk) {
              end = k + 2;
              break;
            }
          }
          k += 1;
        }
        if (end < 0) throw new PdfCorruptError("inline image (BI/ID) is not terminated by EI");
        i = end;
        inInlineImage = false;
        continue;
      }
      i = j; // BI 与 ID 之间的字典 token：词法消费、不产出
      continue;
    }
    if (/^[0-9+\-.]/.test(word)) push({ t: "num", v: parseFloat(word) });
    else push({ t: "op", v: word });
    i = j;
  }
  if (inInlineImage) throw new PdfCorruptError("inline image (BI) is not terminated by ID");
  return tokens;
}

/** latin1 字符串（每字符 ≤ U+00FF）→ 字节。 */
export function latin1ToBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** 把 [ ] 分隔符折叠为数组 token（TJ 操作数；嵌套数组不生成——与参考一致静默忽略）。 */
export function retokenizeWithArrays(content: Uint8Array): ContentToken[] {
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
