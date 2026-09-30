/**
 * d4-md-v1 规范 Markdown 解析器（D4-1「材料存储和导入」）的离线测试面。
 *
 * 覆盖（对照 D4 契约 §6 真值规则与 B1 fixture 覆盖标签 zh/en/code/
 * repeated-words/emoji/combining/cross-line/links/long-tail）：
 *  - 中文/英文散文多段落分块；同块内单换行不分块；
 *  - 围栏代码块：无内嵌空行 → 单块；内嵌空行 → 按空行切分（解析器不
 *    识别围栏语义——按 d4-md-v1 空行规则诚实切分，不假装理解代码块）；
 *  - CRLF / 孤立 CR / 混合行尾归约为 LF；
 *  - emoji（含星面字符）：UTF-16 偏移把代理对计 2 码元；
 *  - 组合字符逐字保留（无 NFC 归一化）；
 *  - 重复特征词（repeat-word-2nd 选区基础）、跨行摘录（cross-line）、
 *    长文后段（long-tail）；
 *  - 链接/行内代码逐字保留；
 *  - 单块文档、无结尾换行、首尾空行丢弃、空白分隔行只留换行、
 *    多行空白串保留全部换行（非末块恒 ≥ "\n\n"）；
 *  - 四类拒绝（empty / invalid-utf8 / nul-byte / whitespace-only）
 *    与判定优先级；
 *  - 每个成功用例经 assertInvariants 复核冻结结构不变量（join 全等、
 *    UTF-16 连续覆盖、非末块 "\n\n" 结尾、blockId 序列——与
 *    tests/support/verifier/d4-probes.ts 的 validateExpectedStructure
 *    同一套机械校验）。
 *
 * 已裁决的规格歧义在此锁定（详见 markdown-parser.ts 头注）：
 *  - 空白行 = Unicode 空白（含 NBSP/全角空格），其字符被丢弃只留换行；
 *  - 行首 BOM 剥离（TextDecoder 默认）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MARKDOWN_PARSER_KIND,
  MARKDOWN_PARSER_VERSION,
  parseMarkdownMaterial,
  type MarkdownParseSuccess,
} from "../src/materials/markdown-parser.ts";

const ENCODER = new TextEncoder();

/* ---------------- 辅助：字节装配 + 冻结不变量 ---------------- */

function toBytes(input: string | Uint8Array): Uint8Array {
  return typeof input === "string" ? ENCODER.encode(input) : input;
}

function describeInput(input: string | Uint8Array): string {
  return typeof input === "string" ? JSON.stringify(input.slice(0, 48)) : "raw bytes";
}

/**
 * 冻结结构不变量（镜像 d4-probes.validateExpectedStructure + MaterialBlock
 * 契约）：join 全等、自 0 连续覆盖、end = start + text.length、slice 回读
 * 全等、blockId 序列、非末块 "\n\n" 结尾、textUnits = UTF-16 长度。
 */
function assertInvariants(
  result: MarkdownParseSuccess,
  label: string,
  expectedBlockCount?: number,
): void {
  assert.equal(result.parserKind, "markdown", `${label}: parserKind`);
  assert.equal(result.parserVersion, "d4-md-v1", `${label}: parserVersion`);
  assert.ok(result.canonicalText.length > 0, `${label}: canonicalText must be non-empty`);
  assert.ok(result.blocks.length >= 1, `${label}: at least one block`);
  assert.equal(result.textUnits, result.canonicalText.length, `${label}: textUnits (UTF-16)`);
  assert.equal(
    result.blocks.map((block) => block.text).join(""),
    result.canonicalText,
    `${label}: blocks join to canonicalText`,
  );
  let cursor = 0;
  for (let i = 0; i < result.blocks.length; i += 1) {
    const block = result.blocks[i]!;
    assert.equal(block.blockId, `blk-${i}`, `${label}: blockId sequence at ${i}`);
    assert.equal(block.kind, "markdown-block", `${label}: block kind at ${i}`);
    assert.equal(block.start, cursor, `${label}: blk-${i} contiguity (start)`);
    assert.equal(block.end, block.start + block.text.length, `${label}: blk-${i} end = start + len`);
    assert.equal(
      result.canonicalText.slice(block.start, block.end),
      block.text,
      `${label}: blk-${i} slice round-trip`,
    );
    if (i < result.blocks.length - 1) {
      assert.ok(block.text.endsWith("\n\n"), `${label}: non-final blk-${i} ends with \\n\\n`);
    }
    cursor = block.end;
  }
  assert.equal(cursor, result.canonicalText.length, `${label}: full UTF-16 coverage`);
  if (expectedBlockCount !== undefined) {
    assert.equal(result.blocks.length, expectedBlockCount, `${label}: block count`);
  }
}

/** 解析并断言成功 + 全部冻结不变量（每个成功用例都走这里）。 */
function parseOk(
  input: string | Uint8Array,
  options: { readonly blockCount?: number; readonly label?: string } = {},
): MarkdownParseSuccess {
  const label = options.label ?? describeInput(input);
  const result = parseMarkdownMaterial(toBytes(input));
  assert.ok(result.ok, `${label}: expected ok:true, got ${JSON.stringify(result)}`);
  assertInvariants(result, label, options.blockCount);
  return result;
}

function parseReject(input: string | Uint8Array, reason: string, label?: string): void {
  const tag = label ?? describeInput(input);
  const result = parseMarkdownMaterial(toBytes(input));
  assert.ok(!result.ok, `${tag}: expected ok:false, got ${JSON.stringify(result)}`);
  if (result.ok) return;
  assert.equal(result.reason, reason, `${tag}: rejection reason`);
  assert.equal(result.parserKind, "markdown", `${tag}: rejection parserKind`);
  assert.equal(result.parserVersion, "d4-md-v1", `${tag}: rejection parserVersion`);
  assert.ok(
    typeof result.message === "string" && result.message.length > 0,
    `${tag}: rejection carries a human message`,
  );
}

function blockTexts(result: MarkdownParseSuccess): string[] {
  return result.blocks.map((block) => block.text);
}

/** 覆盖 [start,end) 的单块（B2 选区的容纳块语义）。 */
function blockContaining(result: MarkdownParseSuccess, start: number, end: number) {
  return result.blocks.find((block) => start >= block.start && end <= block.end) ?? null;
}

/* ---------------- 身份常量 ---------------- */

test("frozen identity constants: parserKind markdown / parserVersion d4-md-v1", () => {
  assert.equal(MARKDOWN_PARSER_KIND, "markdown");
  assert.equal(MARKDOWN_PARSER_VERSION, "d4-md-v1");
});

/* ---------------- 散文分块 ---------------- */

test("Chinese prose: paragraphs split into blocks, same-block line breaks preserved", () => {
  const doc = "树结构笔记的第一段：核心论点。\n\n第二段继续展开，说明分支的语义。\n之后是同一段内的换行。\n";
  const result = parseOk(doc, { blockCount: 2, label: "zh prose" });
  assert.deepEqual(blockTexts(result), [
    "树结构笔记的第一段：核心论点。\n\n",
    "第二段继续展开，说明分支的语义。\n之后是同一段内的换行。\n",
  ]);
  /* 无 CR、无空白分隔行、无首尾空行 → canonicalText 与输入全等。 */
  assert.equal(result.canonicalText, doc);
  /* UTF-16 偏移：中文全 BMP，逐码元计数。 */
  const firstBlockUnits = "树结构笔记的第一段：核心论点。\n\n".length;
  assert.equal(result.blocks[0]!.start, 0);
  assert.equal(result.blocks[0]!.end, firstBlockUnits);
  assert.equal(result.blocks[1]!.start, firstBlockUnits);
  assert.equal(result.blocks[1]!.end, result.canonicalText.length);
  assert.equal(result.textUnits, doc.length);
});

test("English prose: multi-block with same-block continuation lines and a cross-line excerpt", () => {
  const doc =
    "First paragraph makes a claim.\n\n" +
    "Second paragraph supports it.\nA continued line in the same block.\n\n" +
    "Third.\n";
  const result = parseOk(doc, { blockCount: 3, label: "en prose" });
  assert.deepEqual(blockTexts(result), [
    "First paragraph makes a claim.\n\n",
    "Second paragraph supports it.\nA continued line in the same block.\n\n",
    "Third.\n",
  ]);
  assert.equal(result.canonicalText, doc);
  assert.equal(result.blocks[1]!.start, "First paragraph makes a claim.\n\n".length);
  /* cross-line 摘录：横跨块内换行且完整落在一个块里。 */
  const from = result.canonicalText.indexOf("Second paragraph supports");
  const to = result.canonicalText.indexOf("same block") + "same block".length;
  const excerpt = result.canonicalText.slice(from, to);
  assert.ok(excerpt.includes("\n"), "cross-line excerpt spans a line break");
  const block = blockContaining(result, from, to);
  assert.ok(block !== null, "cross-line excerpt stays within one block");
  assert.equal(block.blockId, "blk-1");
});

/* ---------------- 围栏代码块 ---------------- */

test("fenced code block with several lines and no blank line stays ONE block", () => {
  const doc = "```ts\nconst a = 1;\nconst b = 2;\n```";
  const result = parseOk(doc, { blockCount: 1, label: "code fence, single block" });
  assert.deepEqual(blockTexts(result), [doc]);
  /* 内部单换行不切块；代码内容逐字保留。 */
  assert.equal(result.blocks[0]!.text, "```ts\nconst a = 1;\nconst b = 2;\n```");
  assert.equal(result.blocks[0]!.end, result.canonicalText.length);
});

test("fenced code block between prose: only blank lines split blocks", () => {
  const doc = "Intro paragraph.\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\nOutro paragraph.\n";
  const result = parseOk(doc, { blockCount: 3, label: "code fence with prose" });
  assert.deepEqual(blockTexts(result), [
    "Intro paragraph.\n\n",
    "```ts\nconst a = 1;\nconst b = 2;\n```\n\n",
    "Outro paragraph.\n",
  ]);
  assert.equal(result.canonicalText, doc);
});

test("fenced code block containing a blank line SPLITS into blocks (no fence awareness)", () => {
  /* d4-md-v1 只按空行分块，不识别围栏语义：代码块内嵌空行处诚实切块。 */
  const doc = "```js\nconst a = 1;\n\nconst b = 2;\n```\n";
  const result = parseOk(doc, { blockCount: 2, label: "code fence with blank line" });
  assert.deepEqual(blockTexts(result), [
    "```js\nconst a = 1;\n\n",
    "const b = 2;\n```\n",
  ]);
  /* 切分不丢字：两块拼回等于输入。 */
  assert.equal(result.canonicalText, doc);
  assert.ok(result.blocks[0]!.text.endsWith("\n\n"));
});

/* ---------------- 行尾归约 ---------------- */

test("CRLF line endings canonicalize to single LF (never doubled)", () => {
  const result = parseOk("第一段：CRLF 行尾。\r\n\r\nSecond block with CRLF.\r\n", {
    blockCount: 2,
    label: "CRLF",
  });
  assert.equal(result.canonicalText, "第一段：CRLF 行尾。\n\nSecond block with CRLF.\n");
  assert.ok(!result.canonicalText.includes("\r"), "no CR survives canonicalization");
  assert.deepEqual(blockTexts(result), ["第一段：CRLF 行尾。\n\n", "Second block with CRLF.\n"]);
  /* CRLF 是单个行终止符，不是空行：单块内多行保持一块。 */
  const singleBlock = parseOk("line one\r\nline two\r\nline three", {
    blockCount: 1,
    label: "CRLF single block",
  });
  assert.equal(singleBlock.canonicalText, "line one\nline two\nline three");
});

test("lone CR and mixed CRLF/CR/LF endings canonicalize to LF", () => {
  const result = parseOk("para one\rpara two\r\rnext block\r", {
    blockCount: 2,
    label: "lone CR",
  });
  assert.equal(result.canonicalText, "para one\npara two\n\nnext block\n");
  assert.deepEqual(blockTexts(result), ["para one\npara two\n\n", "next block\n"]);

  const mixed = parseOk("a\r\nb\rc\n\nd", { blockCount: 2, label: "mixed endings" });
  assert.equal(mixed.canonicalText, "a\nb\nc\n\nd");
  assert.deepEqual(blockTexts(mixed), ["a\nb\nc\n\n", "d"]);
});

/* ---------------- Unicode：emoji / 代理对 / 组合字符 ---------------- */

test("emoji incl. astral-plane characters: UTF-16 offsets count surrogate pairs as 2 units", () => {
  const block0 = "🌳🌳 森林与树。\n\n";
  const block1 = "A rocket 🚀 and a BMP snowman ☃ follow.\n";
  const doc = block0 + block1;
  const result = parseOk(doc, { blockCount: 2, label: "emoji" });
  assert.deepEqual(blockTexts(result), [block0, block1]);
  /* 🌳（U+1F333）是星面字符：JS 字符串里占 2 个 UTF-16 码元。 */
  assert.equal("🌳".length, 2);
  assert.equal(result.canonicalText.slice(0, 2), "🌳");
  assert.equal(result.canonicalText.codePointAt(0), 0x1f333);
  assert.equal(result.blocks[0]!.start, 0);
  assert.equal(result.blocks[0]!.end, block0.length);
  /* 第二块起点把两个代理对（4 码元）如实计入。 */
  assert.equal(result.blocks[1]!.start, block0.length);
  assert.equal(result.blocks[1]!.end, block0.length + block1.length);
  assert.equal(result.textUnits, doc.length);
});

test("combining characters kept verbatim: no NFC normalization anywhere", () => {
  const block0 = "café 的分解形式。\n\n";
  const block1 = "second block with café again";
  const doc = block0 + block1;
  const result = parseOk(doc, { blockCount: 2, label: "combining" });
  assert.equal(result.canonicalText, doc);
  /* e + U+0301 是 2 个 UTF-16 码元；NFC 折叠会改变长度——必须原样保留。 */
  assert.ok(doc.includes("é"));
  assert.equal("é".length, 2);
  assert.notEqual(doc.normalize("NFC"), doc);
  assert.notEqual(result.canonicalText.normalize("NFC"), result.canonicalText);
  assert.equal(result.blocks[0]!.end, block0.length);
  assert.equal(result.blocks[1]!.start, block0.length);
  assert.ok(result.blocks[1]!.text.startsWith("second block with café"));
});

/* ---------------- 重复词 / 链接 ---------------- */

test("repeated distinctive words: both occurrences resolved to stable offsets and blocks", () => {
  const doc =
    "quokka appears first here.\n\n" +
    "unrelated middle block.\n\n" +
    "the quokka returns at the tail.\n";
  const result = parseOk(doc, { blockCount: 3, label: "repeated words" });
  const first = result.canonicalText.indexOf("quokka");
  const second = result.canonicalText.indexOf("quokka", first + 1);
  assert.ok(first >= 0, "first occurrence present");
  assert.ok(second > first, "second occurrence present and later");
  /* 切片全等（B2 选区的机械校验基础）。 */
  assert.equal(result.canonicalText.slice(first, first + "quokka".length), "quokka");
  assert.equal(result.canonicalText.slice(second, second + "quokka".length), "quokka");
  const firstBlock = blockContaining(result, first, first + "quokka".length);
  const secondBlock = blockContaining(result, second, second + "quokka".length);
  assert.ok(firstBlock !== null && secondBlock !== null);
  assert.equal(firstBlock.blockId, "blk-0");
  assert.equal(secondBlock.blockId, "blk-2", "repeat-word-2nd lands in a later block");
});

test("links and inline code kept verbatim", () => {
  const doc =
    "See [the docs](https://example.com/docs?a=1&b=2) and `inline code`.\n\n" +
    "[second link](relative-path.md) follows.\n";
  const result = parseOk(doc, { blockCount: 2, label: "links" });
  assert.equal(result.canonicalText, doc);
  assert.ok(result.canonicalText.includes("[the docs](https://example.com/docs?a=1&b=2)"));
  assert.ok(result.blocks[1]!.text.startsWith("[second link](relative-path.md)"));
  /* 链接 URL 不经任何改写：逐字节同输入。 */
  assert.equal(result.canonicalText.indexOf("(https://example.com/docs?a=1&b=2)"), doc.indexOf("(https://example.com/docs?a=1&b=2)"));
});

/* ---------------- 文档形态：单块 / 无尾换行 / 首尾空行 / 空白分隔 ---------------- */

test("single-block document with and without a trailing newline", () => {
  const withNewline = parseOk("just one line\n", { blockCount: 1, label: "single block + NL" });
  assert.deepEqual(blockTexts(withNewline), ["just one line\n"]);
  assert.equal(withNewline.textUnits, "just one line\n".length);

  const bare = parseOk("solo", { blockCount: 1, label: "single block, no NL" });
  assert.deepEqual(blockTexts(bare), ["solo"]);
  assert.equal(bare.blocks[0]!.start, 0);
  assert.equal(bare.blocks[0]!.end, 4);
  assert.equal(bare.textUnits, 4);
});

test("document without trailing newline: final block keeps no forced terminator", () => {
  const result = parseOk("a\n\nb", { blockCount: 2, label: "no trailing NL" });
  assert.deepEqual(blockTexts(result), ["a\n\n", "b"]);
  assert.ok(!result.blocks[1]!.text.endsWith("\n"));
  /* 末行带单个行终止符时保留在末块内（不是空行）。 */
  const terminated = parseOk("a\n\nb\n", { blockCount: 2, label: "final terminator kept" });
  assert.deepEqual(blockTexts(terminated), ["a\n\n", "b\n"]);
});

test("leading and trailing blank lines are dropped entirely", () => {
  const result = parseOk("\n\n   \n\t\nreal content\n\n\n\n", {
    blockCount: 1,
    label: "leading/trailing blanks",
  });
  assert.deepEqual(blockTexts(result), ["real content\n"]);
  assert.equal(result.canonicalText, "real content\n");
  assert.equal(result.textUnits, "real content\n".length);

  const twoBlocks = parseOk("\n\nfirst\n\nsecond\n  \n\n", {
    blockCount: 2,
    label: "blanks around two blocks",
  });
  assert.deepEqual(blockTexts(twoBlocks), ["first\n\n", "second\n"]);
  assert.ok(twoBlocks.canonicalText.length < "\n\nfirst\n\nsecond\n  \n\n".length);
});

test("whitespace-only separator lines contribute only their newline (blank-line whitespace dropped)", () => {
  /* 规格裁决锁定：空白行的空白字符不进入 canonicalText，否则非末块
     无法以 "\n\n" 结尾（机械门禁必挂）。 */
  const result = parseOk("alpha\n \nbeta", { blockCount: 2, label: "space-only separator" });
  assert.deepEqual(blockTexts(result), ["alpha\n\n", "beta"]);
  assert.equal(result.canonicalText, "alpha\n\nbeta");
  assert.notEqual(result.canonicalText, "alpha\n \nbeta");

  const tabbed = parseOk("alpha\n\t\nbeta", { blockCount: 2, label: "tab-only separator" });
  assert.deepEqual(blockTexts(tabbed), ["alpha\n\n", "beta"]);

  /* Unicode 空白（NBSP / 全角空格）同属空白行——与 whitespace-only 拒绝
     同一「无有意义内容」定义。 */
  const nbsp = parseOk("alpha\n \nbeta", { blockCount: 2, label: "NBSP separator" });
  assert.deepEqual(blockTexts(nbsp), ["alpha\n\n", "beta"]);
  const fullWidth = parseOk("前段\n　\n后段", { blockCount: 2, label: "全角空格 separator" });
  assert.deepEqual(blockTexts(fullWidth), ["前段\n\n", "后段"]);
});

test("multi-blank-line runs keep every newline (N blanks yield N+1 newlines)", () => {
  const result = parseOk("a\n\n\n\nb", { blockCount: 2, label: "3 blank lines" });
  assert.deepEqual(blockTexts(result), ["a\n\n\n\n", "b"]);
  assert.ok(result.blocks[0]!.text.endsWith("\n\n"), "still satisfies the \\n\\n invariant");

  const wider = parseOk("first\n\n\nsecond", { blockCount: 2, label: "2 blank lines" });
  assert.deepEqual(blockTexts(wider), ["first\n\n\n", "second"]);
});

test("content lines keep leading/trailing spaces and tabs verbatim", () => {
  const doc = "  indented line  \n\ttabbed content\t\n";
  const result = parseOk(doc, { blockCount: 1, label: "content-line whitespace" });
  assert.equal(result.canonicalText, doc);
  assert.deepEqual(blockTexts(result), [doc]);
});

test("realistic mixed document: zh prose + fenced code + links + emoji, exact block map", () => {
  const doc =
    "# 树结构笔记\n\n" +
    "树（Tree）以分支组织探索。见 [术语说明](glossary.md)。\n\n" +
    "```ts\nconst tree = createTree();\n```\n\n" +
    "末段：🌳 长在最后，供 long-tail 选区验证。\n";
  const result = parseOk(doc, { blockCount: 4, label: "mixed document" });
  assert.deepEqual(blockTexts(result), [
    "# 树结构笔记\n\n",
    "树（Tree）以分支组织探索。见 [术语说明](glossary.md)。\n\n",
    "```ts\nconst tree = createTree();\n```\n\n",
    "末段：🌳 长在最后，供 long-tail 选区验证。\n",
  ]);
  assert.equal(result.canonicalText, doc);
  /* long-tail：后 20% 的选区落在末块。 */
  const at = doc.lastIndexOf("long-tail");
  assert.ok(at > 0.8 * doc.length, "tail word sits in the final 20%");
  const tailBlock = blockContaining(result, at, at + "long-tail".length);
  assert.ok(tailBlock !== null);
  assert.equal(tailBlock.blockId, "blk-3");
});

/* ---------------- 拒绝：四类原因码与优先级 ---------------- */

test("rejection: empty (0 bytes)", () => {
  parseReject(new Uint8Array(0), "empty", "0-byte input");
});

test("rejection: invalid-utf8 (truncated / bad continuation / overlong / surrogate)", () => {
  parseReject(new Uint8Array([0xff]), "invalid-utf8", "lone continuation byte");
  parseReject(new Uint8Array([0x61, 0xc3, 0x28]), "invalid-utf8", "bad continuation after valid prefix");
  parseReject(new Uint8Array([0xf0, 0x9f]), "invalid-utf8", "truncated 4-byte sequence");
  parseReject(new Uint8Array([0xed, 0xa0, 0x80]), "invalid-utf8", "encoded surrogate (CESU-8)");
  parseReject(new Uint8Array([0xc0, 0xaf]), "invalid-utf8", "overlong encoding");
  parseReject(new Uint8Array([0x61, 0x62, 0xe2, 0x82]), "invalid-utf8", "truncated euro after valid prefix");
});

test("rejection: nul-byte (embedded U+0000, incl. precedence over whitespace-only)", () => {
  parseReject("before\u0000after", "nul-byte", "NUL between words");
  parseReject(new Uint8Array([0x00]), "nul-byte", "single NUL byte");
  parseReject(new Uint8Array(8), "nul-byte", "zero-filled 8-byte buffer");
  /* NUL 判定先于 whitespace-only：全空白 + NUL → nul-byte。 */
  parseReject(" \u0000 ", "nul-byte", "whitespace around NUL wins nul-byte");
});

test("rejection: whitespace-only (no meaningful content)", () => {
  parseReject("   \n\t\n", "whitespace-only", "spaces and tabs");
  parseReject("\n\n\n", "whitespace-only", "newlines only");
  parseReject("   ", "whitespace-only", "spaces only, no newline");
  parseReject("　 ", "whitespace-only", "CJK/full-width spaces only");
  /* BOM-only：字节非 0（非 empty），解码（默认剥离行首 BOM）得空串。 */
  parseReject(new Uint8Array([0xef, 0xbb, 0xbf]), "whitespace-only", "BOM-only document");
});

test("rejection precedence: decode failure precedes NUL detection", () => {
  parseReject(new Uint8Array([0x00, 0xff]), "invalid-utf8", "NUL followed by bad byte: decode fails first");
});

test("leading BOM is stripped by the strict decoder; content parses normally", () => {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...ENCODER.encode("content")]);
  const result = parseOk(bytes, { blockCount: 1, label: "BOM + content" });
  assert.equal(result.canonicalText, "content");
  assert.deepEqual(blockTexts(result), ["content"]);
});
