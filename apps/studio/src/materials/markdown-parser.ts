/**
 * d4-md-v1 规范 Markdown 解析器（D4-1「材料存储和导入」，issue #8；
 * D4 契约 §1 类型 / §6 真值规则）。
 *
 * 职责：导入材料的原始字节 → 规范文本 canonicalText + 块图 blocks。
 * 纯函数（零依赖、无 fs、无网络），供 studio 导入服务装配与 D4-0 真值
 * 工具共用；blocks 即 B1 真值文件的块形状（tests/support/verifier/
 * d4-probes.ts validateExpectedStructure 的机械校验面）。
 *
 * 冻结规则（d4-md-v1）：
 *  1. 输入为原始字节（Uint8Array），严格 UTF-8 解码（TextDecoder fatal，
 *     任何非法序列整体拒绝）；行首 BOM 按解码器默认行为剥离
 *     （EF BB BF 不进入 canonicalText）。
 *  2. 拒绝（ok:false，原因码稳定，对应 MaterialVersion.parseError 的
 *     原因码部分）：
 *     - "empty"：0 字节；
 *     - "invalid-utf8"：任何非法 UTF-8 序列（截断/非法连续字节/超长/
 *       代理对编码）；
 *     - "nul-byte"：内嵌 U+0000；
 *     - "whitespace-only"：全文仅空白，无有意义内容。
 *     判定顺序：empty → invalid-utf8 → nul-byte → whitespace-only。
 *  3. 行尾规约（仅此一步）：CRLF 与孤立 CR 一律归约为 LF。绝无 Unicode
 *     归一化——无 NFC/NFKC、无宽度折叠、无大小写变化；组合字符序列、
 *     星面 emoji、链接/行内代码等 markdown 语法一律逐字保留。
 *  4. 空白行 = 仅含 Unicode 空白的行（空串、空格、制表符、NBSP、全角
 *     空格等）。与「whitespace-only」拒绝共用同一定义（trim 为空）。
 *  5. 分块：丢弃首部/尾部空白行；正文按「连续一或多行空白行」分隔成
 *     块。分隔的空白行只贡献其换行（空白字符本身不进入 canonicalText
 *     ——由此非末块恒以 "\n\n" 或更多换行结尾，满足契约 §6 真值规则；
 *     N≥1 行空白行产生 N+1 个换行）。内容行（连同其行终止符、行内
 *     首尾空白、缩进、markdown 语法）逐字保留；末行若带单个行终止
 *     "\n"（行终止符而非空白行），保留在末块内。
 *  6. blocks：blockId 顺序编号 "blk-0"、"blk-1"、…；kind
 *     "markdown-block"；start/end 为 canonicalText 内 UTF-16 码元半开
 *     区间偏移，自 0 连续覆盖全文本（end = start + text.length，末块
 *     end = canonicalText.length）；canonicalText === blocks.map(b =>
 *     b.text).join("")（构造性成立）；textUnits === canonicalText.length
 *     （UTF-16 码元数；代理对计 2）。
 *
 * 已裁决的规格歧义（与 scripts/d4/reference-markdown-normalizer.mjs
 * 对齐时的关注点；该参考归一化器成文后须逐项复核）：
 *  - 空白行取「Unicode 空白」（trim），而非 CommonMark 的仅空格/制表
 *    符——与任务书「whitespace-only（无有意义内容）」措辞一致；
 *  - 空白行的空白字符不进入 canonicalText（非末块 "\n\n" 结尾不变量
 *    所迫：保留空白则 "a\n \nb" 的前块以 "  \n" 类结尾，机械门禁必挂）；
 *  - 行首 BOM 剥离（TextDecoder 默认）；BOM-only 文档解得空串 →
 *    whitespace-only（非 empty——字节非 0）。
 */

export const MARKDOWN_PARSER_KIND = "markdown" as const;
export const MARKDOWN_PARSER_VERSION = "d4-md-v1" as const;

/** d4-md-v1 的稳定拒绝原因码（parseError 的原因码部分）。 */
export type MarkdownRejectionReason = "empty" | "invalid-utf8" | "nul-byte" | "whitespace-only";

/** 规范化后的文本块（B1 真值 blocks 数组项 = MaterialBlock + text）。 */
export interface MarkdownBlock {
  readonly blockId: string;
  readonly kind: "markdown-block";
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export interface MarkdownParseSuccess {
  readonly ok: true;
  readonly parserKind: "markdown";
  readonly parserVersion: "d4-md-v1";
  readonly canonicalText: string;
  readonly blocks: readonly MarkdownBlock[];
  readonly textUnits: number;
}

export interface MarkdownParseRejection {
  readonly ok: false;
  readonly parserKind: "markdown";
  readonly parserVersion: "d4-md-v1";
  readonly reason: MarkdownRejectionReason;
  readonly message: string;
}

export type MarkdownParseResult = MarkdownParseSuccess | MarkdownParseRejection;

/** 严格 UTF-8 解码器（fatal；无流式状态，进程内可复用）。 */
const STRICT_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function rejection(reason: MarkdownRejectionReason, message: string): MarkdownParseRejection {
  return {
    ok: false,
    parserKind: MARKDOWN_PARSER_KIND,
    parserVersion: MARKDOWN_PARSER_VERSION,
    reason,
    message,
  };
}

/** 空白行：仅含 Unicode 空白（行已按 \n 切开，行内不含换行）。 */
function isBlankLine(line: string): boolean {
  return line.trim().length === 0;
}

/** d4-md-v1 解析：原始字节 → 规范文本 + 块图；非法输入稳定拒绝。 */
export function parseMarkdownMaterial(bytes: Uint8Array): MarkdownParseResult {
  if (bytes.length === 0) {
    return rejection("empty", "material is empty (0 bytes)");
  }
  let decoded: string;
  try {
    decoded = STRICT_UTF8_DECODER.decode(bytes);
  } catch {
    return rejection("invalid-utf8", "material is not well-formed UTF-8");
  }
  if (decoded.includes("\u0000")) {
    return rejection("nul-byte", "material contains an embedded U+0000 NUL byte");
  }

  /* 行尾规约（仅此一步）：CRLF / 孤立 CR → LF。 */
  const text = decoded.replace(/\r\n?/g, "\n");
  /* 按行切分：除末元素外，每个元素原本以 "\n" 结尾。 */
  const lines = text.split("\n");

  let firstContent = -1;
  let lastContent = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (isBlankLine(lines[i]!)) continue;
    if (firstContent < 0) firstContent = i;
    lastContent = i;
  }
  if (firstContent < 0) {
    return rejection("whitespace-only", "material contains only whitespace (no meaningful content)");
  }

  const blocks: MarkdownBlock[] = [];
  let buffer = "";
  let bufferStart = 0;
  const flushBlock = (): void => {
    blocks.push({
      blockId: `blk-${blocks.length}`,
      kind: "markdown-block",
      start: bufferStart,
      end: bufferStart + buffer.length,
      text: buffer,
    });
    bufferStart += buffer.length;
    buffer = "";
  };

  for (let i = firstContent; i <= lastContent; i += 1) {
    const line = lines[i]!;
    const terminated = i < lines.length - 1;
    if (isBlankLine(line)) {
      /* 分隔空白行：只保留其换行（空白字符丢弃），归入前块尾部。 */
      if (terminated) buffer += "\n";
      continue;
    }
    /* 非空行紧随空白行 → 开新块；同块内容行连同行终止符逐字保留。 */
    if (i > firstContent && isBlankLine(lines[i - 1]!)) flushBlock();
    buffer += line;
    if (terminated) buffer += "\n";
  }
  flushBlock();

  const canonicalText = blocks.map((block) => block.text).join("");
  return {
    ok: true,
    parserKind: MARKDOWN_PARSER_KIND,
    parserVersion: MARKDOWN_PARSER_VERSION,
    canonicalText,
    blocks,
    textUnits: canonicalText.length,
  };
}
