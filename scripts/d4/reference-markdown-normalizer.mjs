#!/usr/bin/env node
/**
 * d4-md-v1 参考归一化器（D4-0 冻结真值生成器，issue #8 契约 §6）。
 *
 * 这是 d4-md-v1 的**独立参考实现**：原始字节 → canonicalText + 块图。
 * 冻结的 *.expected.json 真值由本脚本生成（tests/fixtures/d4/b1-import/
 * markdown/ 与 version-pairs/）；重新运行必须产出逐字节相同的输出，否则
 * 视为破坏冻结。apps/studio/src/materials/markdown-parser.ts 是同一规格
 * 的产品实现，二者以冻结 fixture 交叉复核（对不齐时以本参考实现与契约
 * §6 为准）。
 *
 * d4-md-v1 规则（与契约 §6 真值规则逐条对应；裁决记录见
 * apps/studio/src/materials/markdown-parser.ts 头注）：
 *  1. 输入为原始字节，严格 UTF-8 解码（TextDecoder fatal，非法序列整体
 *     拒绝）；行首 BOM 按解码器默认行为剥离，不进入 canonicalText。
 *  2. 拒绝原因码（稳定，判定顺序即此顺序）：
 *     "empty"（0 字节）→ "invalid-utf8"（任何非法 UTF-8 序列）→
 *     "nul-byte"（内嵌 U+0000）→ "whitespace-only"（全文仅空白）。
 *  3. 行尾规约（仅此一步）：CRLF 与孤立 CR 一律归约为 LF；绝无 Unicode
 *     归一化（无 NFC/NFKC、无宽度折叠、无大小写变化；组合字符、星面
 *     emoji、markdown 语法一律逐字保留）。
 *  4. 空白行 = 仅含 Unicode 空白的行（String.prototype.trim 为空）。
 *  5. 分块：丢弃首部/尾部空白行；正文按「连续一或多行空白行」分隔成块；
 *     分隔的空白行只贡献其换行（空白字符不进入 canonicalText；N≥1 行
 *     空白行产生 N+1 个换行，非末块恒以 "\n\n" 或更多换行结尾）；内容行
 *     连同行终止符、行内首尾空白、缩进、markdown 语法逐字保留；末行若
 *     带单个行终止符 "\n"，保留在末块内。
 *  6. blocks：blockId 顺序编号 "blk-0"、"blk-1"、…；kind
 *     "markdown-block"；start/end 为 canonicalText 内 UTF-16 码元半开
 *     区间偏移，自 0 连续覆盖全文本；canonicalText === blocks.map(b =>
 *     b.text).join("")（构造性成立）。
 *
 * 用法：
 *   node scripts/d4/reference-markdown-normalizer.mjs generate <file.md>...
 *       生成 <file>.expected.json（fixtureId 取文件名去扩展名）。
 *   node scripts/d4/reference-markdown-normalizer.mjs check <file.md>...
 *       校验既有 *.expected.json 与重新生成结果逐字节一致（冻结纪律）；
 *       不一致时退出码 1 并打印差异文件。
 *   node scripts/d4/reference-markdown-normalizer.mjs probe <file>...
 *       解析并打印结果 JSON 到 stdout（不写文件）；拒绝时打印拒绝对象。
 *
 * 零依赖、确定性（同输入恒同输出；无时间戳、无路径泄漏）。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

export const REFERENCE_NORMALIZER_VERSION = "d4-md-v1";

const STRICT_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

/** 空白行：仅含 Unicode 空白（行已按 \n 切开，行内不含换行）。 */
function isBlankLine(line) {
  return line.trim().length === 0;
}

/**
 * d4-md-v1 参考归一化。输入原始字节，输出成功对象或拒绝原因码。
 * 成功对象形状与 *.expected.json 主体一致（fixtureId 由调用方补齐）。
 */
export function normalizeMarkdown(bytes) {
  if (bytes.length === 0) {
    return { ok: false, reason: "empty" };
  }
  let decoded;
  try {
    decoded = STRICT_UTF8_DECODER.decode(bytes);
  } catch {
    return { ok: false, reason: "invalid-utf8" };
  }
  if (decoded.includes("\u0000")) {
    return { ok: false, reason: "nul-byte" };
  }

  /* 规约行尾（仅此一步）：CRLF / 孤立 CR → LF；不做任何 Unicode 归一化。 */
  const normalized = decoded.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");

  /* 首个/末个内容行；全空白 → whitespace-only 拒绝。 */
  let firstContent = -1;
  let lastContent = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (isBlankLine(lines[i])) continue;
    if (firstContent < 0) firstContent = i;
    lastContent = i;
  }
  if (firstContent < 0) {
    return { ok: false, reason: "whitespace-only" };
  }

  /*
   * 分块扫描：从首个内容行到末个内容行。
   *  - 空白行：只把一个 "\n"（其行终止符）计入当前块，空白字符丢弃。
   *  - 内容行紧跟在空白行之后（且不是首个内容行）→ 先结算前块。
   *  - 内容行连同行终止符逐字保留（末元素除外——它不带终止符）。
   */
  const blockTexts = [];
  let buffer = "";
  for (let i = firstContent; i <= lastContent; i += 1) {
    const line = lines[i];
    const terminated = i < lines.length - 1;
    if (isBlankLine(line)) {
      if (terminated) buffer += "\n";
      continue;
    }
    if (i > firstContent && isBlankLine(lines[i - 1])) {
      blockTexts.push(buffer);
      buffer = "";
    }
    buffer += line;
    if (terminated) buffer += "\n";
  }
  blockTexts.push(buffer);

  /* 连续覆盖全文本的块图（UTF-16 码元半开区间偏移）。 */
  const blocks = [];
  let cursor = 0;
  for (const text of blockTexts) {
    blocks.push({
      blockId: `blk-${blocks.length}`,
      kind: "markdown-block",
      start: cursor,
      end: cursor + text.length,
      text,
    });
    cursor += text.length;
  }
  const canonicalText = blockTexts.join("");
  return { ok: true, canonicalText, textUnits: canonicalText.length, blocks };
}

/** 由成功结果构造 expected.json 文档（字段顺序固定 → 确定性序列化）。 */
export function buildExpectedDocument(fixtureId, result) {
  if (!result.ok) {
    throw new Error(`buildExpectedDocument expects a success result (${fixtureId})`);
  }
  return {
    fixtureId,
    kind: "markdown",
    normalizer: REFERENCE_NORMALIZER_VERSION,
    canonicalText: result.canonicalText,
    textUnits: result.textUnits,
    blocks: result.blocks,
  };
}

/** 确定性序列化：两空格缩进 + 末尾换行；重跑必须逐字节相同。 */
export function serializeExpected(doc) {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function expectedPathFor(mdPath) {
  return mdPath.replace(/\.md$/, ".expected.json");
}

function fixtureIdFor(mdPath) {
  return basename(mdPath).replace(/\.md$/, "");
}

function main(argv) {
  const [mode, ...files] = argv;
  if (
    (mode !== "generate" && mode !== "check" && mode !== "probe") ||
    files.length === 0
  ) {
    process.stderr.write(
      "usage: reference-markdown-normalizer.mjs generate|check|probe <file.md>...\n",
    );
    process.exit(1);
  }
  let failures = 0;
  for (const file of files) {
    const bytes = readFileSync(file);
    const result = normalizeMarkdown(bytes);
    if (mode === "probe") {
      process.stdout.write(
        `${JSON.stringify({ file: basename(file), ...result }, null, 2)}\n`,
      );
      continue;
    }
    if (!result.ok) {
      process.stderr.write(`${file}: rejected (${result.reason}) — no truth emitted\n`);
      failures += 1;
      continue;
    }
    const doc = buildExpectedDocument(fixtureIdFor(file), result);
    const serialized = serializeExpected(doc);
    if (mode === "generate") {
      writeFileSync(expectedPathFor(file), serialized, "utf8");
      process.stdout.write(
        `${file} -> ${expectedPathFor(file)} (${result.textUnits} units, ${result.blocks.length} blocks)\n`,
      );
      continue;
    }
    // check：逐字节比对（冻结纪律）。
    let current = null;
    try {
      current = readFileSync(expectedPathFor(file), "utf8");
    } catch {
      process.stderr.write(`${expectedPathFor(file)}: missing (run generate)\n`);
      failures += 1;
      continue;
    }
    if (current !== serialized) {
      process.stderr.write(
        `${expectedPathFor(file)}: NOT byte-identical to regeneration (frozen truth broken)\n`,
      );
      failures += 1;
    }
  }
  process.exit(failures > 0 ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
