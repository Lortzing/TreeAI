/**
 * d4-pdf-v1 PDF 文字层解析器（D4-1「材料存储和导入」）的离线测试面。
 *
 * 覆盖（对照 D4 契约 §6 真值规则与 B1 PDF 覆盖标签 zh/en/code/
 * repeated-words/two-column/header-footer/multipage/combining/full-width/
 * fonts/long-tail/unicode/astral）：
 *  - 12 个冻结 fixture（tests/fixtures/d4/b1-import/pdf-registry.json 逐项
 *    驱动）：canonicalText / blocks（含 page 与 text）/ pages 与
 *    *.expected.json 真值**逐字节全等**；每个成功用例经 assertInvariants
 *    复核冻结结构不变量（join 全等、UTF-16 连续覆盖、非末页块 "\n"
 *    结尾、blockId = page-N、page 1-based 递增）；
 *  - 4 个已提交负例（registry negativeFixtures + sidecar .json 交叉）：
 *    encrypted / corrupt / no-text-layer×2 稳定拒绝；
 *  - 页数上限（charter §5）：DEFAULT_MAX_PAGES = 200 冻结值；pdf-08
 *    （10 页）在 maxPages<10 时于内容解释前拒绝 pages-exceeded；
 *  - 内容流操作面（fixture 生成器只写 BT/Tf/Td/Tj/ET——其余文字操作
 *    经测试内装配的微型 PDF 覆盖）：TJ 数组（数字项不计）、TL+T*、
 *    ' 与 " 换行显示、TD 置 leading、Tm 绝对定位、空串 Tj 空行、
 *    FlateDecode 压缩内容流（fixture 内容流均未压缩——解压路径只有
 *    此处真跑）、bfrange ToUnicode（fixture 只产 bfchar；顺序与**数组
 *    值**两种形态都测）、字面串八进制转义 + WinAnsi 高位字节、
 *    BI/ID/EI 内联图整段跳过（二进制里的括号与裸 EI 不误触发）；
 *  - 字体惰性物化：未用于显示文字的坏字体（含未知资源名）不拖垮
 *    页面；真正用于显示时才 unsupported/corrupt（空字节显示零字形
 *    不物化字体）；
 *  - 钉死阅读顺序：栏带（x 差 > 40pt 先左栏后右栏）、同 y 按 x 升序；
 *  - 块规则：非末页 "\n" 收尾、空页跳过且 blockId 用真实页码；
 *  - 拒绝面：not-a-PDF / 截断（无 startxref/%%EOF）/ /Length 失配 /
 *    startxref 错位（corrupt）；xref 流（unsupported）；DCTDecode 过滤器、
 *    非 WinAnsiEncoding 的 Type1、无 ToUnicode 的 Type0、CID 无映射
 *    （unsupported）；加密 trailer（encrypted）；纯图页（no-text-layer）；
 *  - 确定性：同输入两次解析 deepEqual。
 *
 * 微型 PDF 装配器是**测试本地**的确定性构造工具（正确偏移的经典 xref），
 * 只服务于上述操作面；真值裁决永远以仓内冻结 fixture 为准。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import {
  BAND_GAP,
  DEFAULT_MAX_PAGES,
  PAGES_EXCEEDED_REASON,
  PDF_PARSER_KIND,
  PDF_PARSER_VERSION,
  parsePdfMaterial,
  type PdfParseRejection,
  type PdfParseSuccess,
} from "../src/materials/pdf-parser.ts";

const B1_ROOT = fileURLToPath(new URL("../../../tests/fixtures/d4/b1-import/", import.meta.url));

/* ---------------- 辅助：fixture 读取 + 冻结不变量 ---------------- */

interface RegistryFixture {
  readonly fixtureId: string;
  readonly file: string;
  readonly expected?: string;
  readonly outcome: string;
  readonly pages?: number;
  readonly coverage?: readonly string[];
}
interface RegistryNegative {
  readonly fixtureId: string;
  readonly file: string;
  readonly outcome: string;
  readonly reason: string;
}
interface PdfRegistry {
  readonly kind: string;
  readonly fixtures: readonly RegistryFixture[];
  readonly negativeFixtures: readonly RegistryNegative[];
}

function readRegistry(): PdfRegistry {
  return JSON.parse(readFileSync(`${B1_ROOT}pdf-registry.json`, "utf8")) as PdfRegistry;
}

/**
 * 冻结结构不变量（镜像 d4-probes.validateExpectedStructure + MaterialBlock
 * 契约的 pdf 分支）：join 全等、自 0 连续覆盖、end = start + text.length、
 * slice 回读全等、blockId = page-N 与 page 字段一致且 1-based 递增、
 * 非末块（非末页）"\n" 结尾、textUnits = UTF-16 长度。
 */
function assertInvariants(result: PdfParseSuccess, label: string): void {
  assert.equal(result.parserKind, "pdf", `${label}: parserKind`);
  assert.equal(result.parserVersion, "d4-pdf-v1", `${label}: parserVersion`);
  assert.ok(result.canonicalText.length > 0, `${label}: canonicalText must be non-empty`);
  assert.ok(result.blocks.length >= 1, `${label}: at least one block`);
  assert.equal(result.textUnits, result.canonicalText.length, `${label}: textUnits (UTF-16)`);
  assert.equal(
    result.blocks.map((block) => block.text).join(""),
    result.canonicalText,
    `${label}: blocks join to canonicalText`,
  );
  let cursor = 0;
  let lastPage = 0;
  for (let i = 0; i < result.blocks.length; i += 1) {
    const block = result.blocks[i]!;
    assert.equal(block.blockId, `page-${String(block.page)}`, `${label}: blockId matches page at ${i}`);
    assert.equal(block.kind, "pdf-page", `${label}: block kind at ${i}`);
    assert.ok(block.page > lastPage, `${label}: page numbers strictly ascend at ${i} (empty pages skip, never renumber)`);
    lastPage = block.page;
    assert.equal(block.start, cursor, `${label}: page-${String(block.page)} contiguity (start)`);
    assert.equal(block.end, block.start + block.text.length, `${label}: page-${String(block.page)} end = start + len`);
    assert.equal(
      result.canonicalText.slice(block.start, block.end),
      block.text,
      `${label}: page-${String(block.page)} slice round-trip`,
    );
    if (i < result.blocks.length - 1) {
      assert.ok(block.text.endsWith("\n"), `${label}: non-final page-${String(block.page)} ends with \\n`);
    }
    cursor = block.end;
  }
  assert.equal(cursor, result.canonicalText.length, `${label}: full UTF-16 coverage`);
  assert.ok(result.pages >= result.blocks.length, `${label}: pages >= emitted blocks`);
}

function fixtureBytes(rel: string): Uint8Array {
  return new Uint8Array(readFileSync(`${B1_ROOT}${rel}`));
}

function parseOk(bytes: Uint8Array, label: string, options?: { readonly maxPages?: number }): PdfParseSuccess {
  const result = parsePdfMaterial(bytes, options);
  assert.ok(result.ok, `${label}: expected ok:true, got ${JSON.stringify(result)}`);
  assertInvariants(result, label);
  return result;
}

function parseReject(bytes: Uint8Array, reason: string, label: string): PdfParseRejection {
  const result = parsePdfMaterial(bytes);
  assert.ok(!result.ok, `${label}: expected ok:false, got ok:true`);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.reason, reason, `${label}: rejection reason`);
  assert.equal(result.parserKind, "pdf", `${label}: rejection parserKind`);
  assert.equal(result.parserVersion, "d4-pdf-v1", `${label}: rejection parserVersion`);
  assert.ok(
    typeof result.message === "string" && result.message.length > 0,
    `${label}: rejection carries a human message`,
  );
  return result;
}

/* ---------------- 身份常量 ---------------- */

test("frozen identity constants: parserKind pdf / parserVersion d4-pdf-v1 / limits", () => {
  assert.equal(PDF_PARSER_KIND, "pdf");
  assert.equal(PDF_PARSER_VERSION, "d4-pdf-v1");
  assert.equal(DEFAULT_MAX_PAGES, 200, "charter D4 §5: 200-page text-PDF limit");
  assert.equal(PAGES_EXCEEDED_REASON, "pages-exceeded");
  assert.equal(BAND_GAP, 40, "pinned reading order: column band gap is 40 PDF points");
});

/* ---------------- 冻结 fixture 真值（registry 驱动，逐字节全等） ---------------- */

test("all registry ready fixtures extract to their frozen truth byte-exactly (12 PDF)", () => {
  const registry = readRegistry();
  assert.equal(registry.kind, "pdf");
  assert.ok(registry.fixtures.length >= 12, `B1 requires >= 12 pdf fixtures (got ${String(registry.fixtures.length)})`);
  for (const fixture of registry.fixtures) {
    const label = fixture.fixtureId;
    assert.equal(fixture.outcome, "ready", `${label}: registry outcome`);
    const expected = JSON.parse(readFileSync(`${B1_ROOT}${fixture.expected}`, "utf8")) as {
      fixtureId: string;
      kind: string;
      normalizer: string;
      pages: number;
      canonicalText: string;
      blocks: readonly {
        blockId: string;
        kind: string;
        start: number;
        end: number;
        page: number;
        text: string;
      }[];
    };
    assert.equal(expected.fixtureId, fixture.fixtureId, `${label}: expected fixtureId`);
    assert.equal(expected.normalizer, "d4-pdf-v1", `${label}: expected normalizer`);
    const result = parseOk(fixtureBytes(fixture.file), label);
    assert.equal(result.canonicalText, expected.canonicalText, `${label}: canonicalText byte-exact`);
    assert.deepEqual(result.blocks, expected.blocks, `${label}: blocks deep-equal (incl. page + text)`);
    assert.equal(result.pages, expected.pages, `${label}: page count`);
    assert.equal(result.pages, fixture.pages, `${label}: registry page count agrees`);
    assert.equal(result.textUnits, expected.canonicalText.length, `${label}: textUnits`);
  }
  /* 覆盖标签快照（charter B1 要求的形态分布；标签集合变化 = fixture 变更）。 */
  const coverage = new Set(registry.fixtures.flatMap((f) => f.coverage ?? []));
  for (const tag of ["zh", "en", "code", "repeated-words", "two-column", "header-footer", "long-tail"]) {
    assert.ok(coverage.has(tag), `B1 pdf coverage tag present: ${tag}`);
  }
});

test("all registry negatives reject with their frozen reason (encrypted/corrupt/no-text-layer)", () => {
  const registry = readRegistry();
  assert.ok(registry.negativeFixtures.length >= 4, "the committed pdf negatives are 4");
  for (const negative of registry.negativeFixtures) {
    assert.equal(negative.outcome, "rejected", `${negative.fixtureId}: registry outcome`);
    /* sidecar .json 与 registry 的 reason 必须一致（双登记互证）。 */
    const sidecar = JSON.parse(
      readFileSync(`${B1_ROOT}${negative.file.replace(/\.pdf$/, ".json")}`, "utf8"),
    ) as { fixtureId: string; outcome: string; reason: string };
    assert.equal(sidecar.reason, negative.reason, `${negative.fixtureId}: sidecar reason matches registry`);
    parseReject(fixtureBytes(negative.file), negative.reason, negative.fixtureId);
  }
});

test("determinism: the same bytes parse to deep-equal results", () => {
  const bytes = fixtureBytes("pdf/pdf-06.pdf"); // 双栏 + 两页 + 多字体行
  assert.deepEqual(parsePdfMaterial(bytes), parsePdfMaterial(bytes));
});

/* ---------------- 页数上限（charter §5） ---------------- */

test("pages limit: pdf-08 (10 pages) is rejected before content interpretation under a tighter limit", () => {
  const bytes = fixtureBytes("pdf/pdf-08.pdf");
  /* 10 页 > 9 → pages-exceeded，消息指明实际页数与上限。 */
  const over = parsePdfMaterial(bytes, { maxPages: 9 });
  assert.ok(!over.ok && over.reason === "pages-exceeded");
  if (!over.ok) {
    assert.ok(over.message.includes("10 pages"), "the message names the actual page count");
    assert.ok(over.message.includes("9-page"), "the message names the limit");
  }
  /* 恰好等于上限 → 放行（边界含端）。 */
  parseOk(bytes, "pdf-08 at exactly 10 pages", { maxPages: 10 });
  /* 缺省 = 冻结值 200。 */
  parseOk(bytes, "pdf-08 under the frozen default limit");
  /* 非法选项如实抛错（编程错误，不吞成拒绝）。 */
  assert.throws(() => parsePdfMaterial(bytes, { maxPages: 0 }), RangeError);
});

/* ---------------- 微型 PDF 装配器（操作面/拒绝面构造工具） ---------------- */

/** latin1 字符串 → 字节（每字符 ≤ U+00FF；与解析器编解码同一语义）。 */
function latin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

interface AssembleOptions {
  /** 页面对象使用的内容流过滤器（缺省无）。 */
  readonly contentFilter?: "FlateDecode" | "DCTDecode";
  /** 字体对象体（缺省 base-14 Helvetica/WinAnsi）。 */
  readonly fontBody?: string;
  /** 附加对象体（排在字体对象之后、页对象之前）。 */
  readonly extraObjects?: readonly string[];
  /** 追加进页 /Resources /Font 字典的串（如 " /F2 4 0 R"——多字体/惰性用例）。 */
  readonly fontResources?: string;
  /** 把 startxref 指向某个对象（xref 流/错位构造）。 */
  readonly startxrefObjectNum?: number;
  /** 追加进 trailer 的键值串（如 " /Encrypt 4 0 R"）。 */
  readonly trailerExtra?: string;
}

const DEFAULT_FONT_BODY = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";

function contentStreamBody(content: string, filter?: "FlateDecode" | "DCTDecode"): string {
  let data = content;
  let filterEntry = "";
  if (filter === "FlateDecode") {
    data = String.fromCharCode(...deflateSync(latin1(content)));
    filterEntry = " /Filter /FlateDecode";
  } else if (filter === "DCTDecode") {
    filterEntry = " /Filter /DCTDecode";
  }
  const bytes = latin1(data);
  return `<< /Length ${String(bytes.length)}${filterEntry} >>\nstream\n${data}\nendstream`;
}

/** 单字体（/F1）多页文档：经典 xref、逐字节正确偏移。 */
function buildTextPdf(pageContents: readonly string[], options: AssembleOptions = {}): Uint8Array {
  const bodies: string[] = [];
  bodies.push("<< /Type /Catalog /Pages 2 0 R >>"); // 1: Catalog
  bodies.push(""); // 2: Pages（占位，最后回填）
  bodies.push(options.fontBody ?? DEFAULT_FONT_BODY); // 3: Font /F1
  for (const extra of options.extraObjects ?? []) bodies.push(extra);
  const pageRefs: string[] = [];
  for (const content of pageContents) {
    const contentNum = bodies.push(contentStreamBody(content, options.contentFilter));
    const pageNum = bodies.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] ` +
        `/Resources << /Font << /F1 3 0 R${options.fontResources ?? ""} >> >> /Contents ${String(contentNum)} 0 R >>`,
    );
    pageRefs.push(`${String(pageNum)} 0 R`);
  }
  bodies[1] = `<< /Type /Pages /Kids [${pageRefs.join(" ")}] /Count ${String(pageRefs.length)} >>`;

  const parts: string[] = [];
  const offsets: number[] = [];
  let pos = 0;
  const header = "%PDF-1.5\n%\xE2\xE3\xCF\xD3\n";
  parts.push(header);
  pos += header.length;
  bodies.forEach((body, i) => {
    offsets.push(pos);
    const chunk = `${String(i + 1)} 0 obj\n${body}\nendobj\n`;
    parts.push(chunk);
    pos += chunk.length;
  });
  const xrefStart = pos;
  let xref = `xref\n0 ${String(bodies.length + 1)}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  parts.push(xref);
  const startxref = options.startxrefObjectNum !== undefined ? offsets[options.startxrefObjectNum - 1]! : xrefStart;
  const trailer =
    `trailer\n<< /Size ${String(bodies.length + 1)} /Root 1 0 R${options.trailerExtra ?? ""} ` +
    `/ID [<0102030405060708090A0B0C0D0E0F10> <0102030405060708090A0B0C0D0E0F10>] >>\n` +
    `startxref\n${String(startxref)}\n%%EOF\n`;
  parts.push(trailer);
  return latin1(parts.join(""));
}

/** 字节 → latin1 字符串（与 latin1() 互逆；装配产物是 latin1 可逆的）。 */
function toLatin1String(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

/** 微型文档解析成功的单页文本（快捷断言用）。 */
function singlePageText(content: string, options: AssembleOptions = {}): string {
  const result = parseOk(buildTextPdf([content], options), `mini pdf: ${JSON.stringify(content.slice(0, 40))}`);
  assert.equal(result.pages, 1);
  assert.equal(result.blocks.length, 1);
  return result.canonicalText;
}

/* ---------------- 内容流操作面（fixture 之外的文字操作） ---------------- */

test("content operators beyond the fixture writer: TJ array, T-star, quote forms, TD, Tm", () => {
  /* TJ 数组：字符串项拼接、数字位移项不产生文本。 */
  assert.equal(singlePageText("BT /F1 12 Tf 72 700 Td [(Hel) 20 (lo)] TJ ET"), "Hello");
  /* TL + T-star：按 leading 换行。 */
  assert.equal(singlePageText("BT /F1 12 Tf 72 700 Td 16 TL (one) Tj T* (two) Tj ET"), "one\ntwo");
  /* 单引号：先换行（-leading）后显示。 */
  assert.equal(singlePageText("BT /F1 12 Tf 72 700 Td 16 TL (one) Tj (two)' ET"), "one\ntwo");
  /* 双引号：aw ac 双参数后显示（也走 -leading 换行）。 */
  assert.equal(singlePageText("BT /F1 12 Tf 72 700 Td 16 TL 0 0 (two) \" ET"), "two");
  /* TD 置 leading：T-star 跟随其后。 */
  assert.equal(singlePageText("BT /F1 12 Tf 72 700 Td 0 -16 TD (a) Tj T* (b) Tj ET"), "a\nb");
  /* Tm 绝对定位（替换行矩阵与文本矩阵）。 */
  assert.equal(singlePageText("BT /F1 12 Tf 1 0 0 1 100 650 Tm (pos) Tj ET"), "pos");
  /* 相对 Td 累计（行矩阵平移，不是绝对坐标）。 */
  assert.equal(singlePageText("BT /F1 12 Tf 72 700 Td (a) Tj 0 -20 Td (b) Tj ET"), "a\nb");
  /* 空串 Tj 产生空行（生成器空代码行语义）。 */
  assert.equal(singlePageText("BT /F1 12 Tf 72 700 Td (a) Tj 0 -20 Td () Tj 0 -20 Td (b) Tj ET"), "a\n\nb");
  /* BT 重置行/文本矩阵：两次 BT 各自从原点起。 */
  assert.equal(
    singlePageText("BT /F1 12 Tf 72 700 Td (first) Tj ET\nBT /F1 12 Tf 72 680 Td (second) Tj ET"),
    "first\nsecond",
  );
});

test("FlateDecode-compressed content stream round-trips (fixture content streams are uncompressed)", () => {
  const content = "BT /F1 12 Tf 72 700 Td (compressed line one) Tj 0 -20 Td (line two) Tj ET";
  assert.equal(
    singlePageText(content, { contentFilter: "FlateDecode" }),
    "compressed line one\nline two",
    "the inflate path is exercised here, not by the frozen fixtures",
  );
});

test("literal string octal escapes and WinAnsi high bytes decode exactly", () => {
  assert.equal(singlePageText("BT /F1 12 Tf 72 700 Td (caf\\351) Tj ET"), "café"); /* 0xe9 = é */
  assert.equal(singlePageText("BT /F1 12 Tf 72 700 Td (a\\226b) Tj ET"), "a–b"); /* 0x96 = – */
  assert.equal(singlePageText("BT /F1 12 Tf 72 700 Td (euro: \\200) Tj ET"), "euro: €"); /* 0x80 = € */
  assert.equal(singlePageText("BT /F1 12 Tf 72 700 Td <9650> Tj ET"), "–P"); /* 十六进制串同一解码表 */
});

/* ---------------- 钉死阅读顺序（栏带 / 同 y 平手） ---------------- */

test("pinned reading order: left band completes before the right band; same-y ties break by x", () => {
  /* x=72 与 x=312 相差 240 > 40：两栏带。左栏 700/500 全部先于右栏 700。 */
  const twoColumn =
    "BT /F1 12 Tf 72 700 Td (left top) Tj ET\n" +
    "BT /F1 12 Tf 312 700 Td (right top) Tj ET\n" +
    "BT /F1 12 Tf 72 500 Td (left bottom) Tj ET";
  assert.equal(singlePageText(twoColumn), "left top\nleft bottom\nright top");
  /* 同 y 不同 x（同带内）：按 x 升序，与内容流顺序无关。 */
  const sameY =
    "BT /F1 12 Tf 120 700 Td (b-at-120) Tj ET\n" +
    "BT /F1 12 Tf 72 700 Td (a-at-72) Tj ET";
  assert.equal(singlePageText(sameY), "a-at-72\nb-at-120");
  /* x 差 ≤ 40 保持同带：同带内仍按 y 降序（垂直顺序优先于 x）。 */
  const oneBand =
    "BT /F1 12 Tf 72 700 Td (top) Tj ET\n" +
    "BT /F1 12 Tf 100 650 Td (middle) Tj ET\n" +
    "BT /F1 12 Tf 72 600 Td (bottom) Tj ET";
  assert.equal(singlePageText(oneBand), "top\nmiddle\nbottom");
});

/* ---------------- 块规则：分页 / 空页跳过 ---------------- */

test("page blocks: non-final pages end with a newline; empty pages are skipped with true page numbers kept", () => {
  const twoPages = buildTextPdf(["BT /F1 12 Tf 72 700 Td (p1) Tj ET", "BT /F1 12 Tf 72 700 Td (p2) Tj ET"]);
  const two = parseOk(twoPages, "two mini pages");
  assert.deepEqual(two.blocks.map((b) => b.text), ["p1\n", "p2"]);
  assert.deepEqual(two.blocks.map((b) => b.blockId), ["page-1", "page-2"]);
  assert.deepEqual(two.blocks.map((b) => b.page), [1, 2]);

  /* 第 2 页零文字操作 → 跳过；块号仍用真实页码 page-1 / page-3。 */
  const withBlank = buildTextPdf([
    "BT /F1 12 Tf 72 700 Td (p1) Tj ET",
    "q 1 0 0 1 0 0 cm Q", /* 无文字操作 */
    "BT /F1 12 Tf 72 700 Td (p3) Tj ET",
  ]);
  const skipped = parseOk(withBlank, "blank middle page");
  assert.deepEqual(skipped.blocks.map((b) => b.blockId), ["page-1", "page-3"]);
  assert.deepEqual(skipped.blocks.map((b) => b.text), ["p1\n", "p3"]);
  assert.deepEqual(skipped.blocks.map((b) => b.page), [1, 3]);
  assert.equal(skipped.pages, 3, "pages counts real pages including the empty one");
  assert.equal(skipped.canonicalText, "p1\np3");
});

/* ---------------- 拒绝面：corrupt ---------------- */

test("rejection: corrupt — not a PDF / truncated / Length mismatch / misplaced startxref", () => {
  parseReject(latin1("hello, not a pdf"), "corrupt", "no %PDF- header");
  parseReject(new Uint8Array(0), "corrupt", "empty bytes");
  const pdf = buildTextPdf(["BT /F1 12 Tf 72 700 Td (x) Tj ET"]);
  parseReject(pdf.subarray(0, pdf.length - 30), "corrupt", "tail cut (startxref/%%EOF gone)");
  /* startxref 指向 Catalog 对象（非 xref 表、非 XRef 流）→ corrupt。 */
  parseReject(
    buildTextPdf(["BT /F1 12 Tf 72 700 Td (x) Tj ET"], { startxrefObjectNum: 1 }),
    "corrupt",
    "startxref at the catalog object",
  );
  /* /Length 多算 5 字节 → endstream 失配（经典截断/损坏形态）。 */
  const content = "BT /F1 12 Tf 72 700 Td (x) Tj ET";
  const tampered = toLatin1String(buildTextPdf([content])).replace(
    `<< /Length ${String(content.length)} >>`,
    `<< /Length ${String(content.length + 5)} >>`,
  );
  parseReject(latin1(tampered), "corrupt", "declared /Length overshoots endstream");
});

/* ---------------- 拒绝面：unsupported（能力边界，如实说明） ---------------- */

test("rejection: unsupported — xref stream, DCTDecode, non-WinAnsi Type1, Type0 without ToUnicode", () => {
  /* xref 流：startxref 指向带 /Type /XRef 的对象 → unsupported（非 corrupt）。 */
  const xrefStreamPdf = buildTextPdf(["BT /F1 12 Tf 72 700 Td (x) Tj ET"], {
    extraObjects: ["<< /Type /XRef /W [1 2 1] /Size 9 >>"],
    startxrefObjectNum: 4,
  });
  parseReject(xrefStreamPdf, "unsupported", "cross-reference stream");
  /* 内容流声明 DCTDecode → unsupported。 */
  parseReject(
    buildTextPdf(["BT /F1 12 Tf 72 700 Td (x) Tj ET"], { contentFilter: "DCTDecode" }),
    "unsupported",
    "DCTDecode content filter",
  );
  /* Type1 但 StandardEncoding → unsupported。 */
  parseReject(
    buildTextPdf(["BT /F1 12 Tf 72 700 Td (x) Tj ET"], {
      fontBody: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /StandardEncoding >>",
    }),
    "unsupported",
    "Type1 StandardEncoding",
  );
  /* Type0 缺 ToUnicode → 无法映射文本 → unsupported。 */
  parseReject(
    buildTextPdf(["BT /F1 12 Tf 72 700 Td <0041> Tj ET"], {
      fontBody: "<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /DescendantFonts [4 0 R] >>",
      extraObjects: ["<< /Type /Font /Subtype /CIDFontType2 /BaseFont /X >>"],
    }),
    "unsupported",
    "Type0 without ToUnicode",
  );
});

test("rejection: unsupported — a CID absent from the ToUnicode map refuses to guess text", () => {
  /* ToUnicode 只映射 <0041> → A；内容使用 <0041 0042>，CID 0x42 无映射。
     对象布局：3 = Type0 字体，4 = CMap 流，5 = CIDFontType2，6 = 内容流，7 = 页。 */
  const cmap =
    "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n" +
    "/CMapName /Test def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n" +
    "1 beginbfchar\n<0041> <0041>\nendbfchar\nendcmap\nend\nend\n";
  const pdf = buildTextPdf(["BT /F1 12 Tf 72 700 Td <00410042> Tj ET"], {
    fontBody:
      "<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /DescendantFonts [5 0 R] /ToUnicode 4 0 R >>",
    extraObjects: [contentStreamBody(cmap), "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /X >>"],
  });
  parseReject(pdf, "unsupported", "CID 0x42 has no ToUnicode entry");
});

test("Identity-H mapping: bfchar and bfrange both decode; surrogate pairs carry through", () => {
  /* bfrange <0041> <0043> <0061> → A/B/C 映射到 a/b/c（fixture 只产 bfchar）；
     bfchar <0044> → U+1F333（星面代理对，2 个 UTF-16 码元）。 */
  /* bfchar <0044> → U+1F333 的 UTF-16BE 代理对 D83C DF33（星面字符经
     两个码元携带——奇数长度 hex 会被如实拒为 corrupt）。 */
  const cmap =
    "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n" +
    "1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n" +
    "1 beginbfrange\n<0041> <0043> <0061>\nendbfrange\n" +
    "1 beginbfchar\n<0044> <D83CDF33>\nendbfchar\nendcmap\nend\nend\n";
  const result = parseOk(
    buildTextPdf(["BT /F1 12 Tf 72 700 Td <0041004200430044> Tj ET"], {
      fontBody:
        "<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /DescendantFonts [5 0 R] /ToUnicode 4 0 R >>",
      extraObjects: [contentStreamBody(cmap), "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /X >>"],
    }),
    "bfchar+bfrange identity-H",
  );
  /* 0041..0043 → a b c（bfrange），0044 → 🌳（bfchar，星面代理对 2 码元）。 */
  assert.equal(result.canonicalText, "abc🌳");
  assert.equal(result.textUnits, "abc🌳".length);
  assert.equal("🌳".length, 2, "the astral glyph occupies two UTF-16 units");
});

test("bfrange array values map code-by-code (an array is never misread as a sequential range)", () => {
  /* 数组形态 <lo> <hi> [<v>…]（PDF 32000-1 §9.10.3）：值故意非顺序
     （A、B、🌳）——若被「三段 hex」正则吞读，会错映射成顺序区间
     （如 0x41→0x42、0x42→0x43）。 */
  const cmap =
    "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n" +
    "1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n" +
    "1 beginbfrange\n<0001> <0003> [<0041> <0042> <D83CDF33>]\nendbfrange\n" +
    "endcmap\nend\nend\n";
  const result = parseOk(
    buildTextPdf(["BT /F1 12 Tf 72 700 Td <000100020003> Tj ET"], {
      fontBody:
        "<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /DescendantFonts [5 0 R] /ToUnicode 4 0 R >>",
      extraObjects: [contentStreamBody(cmap), "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /X >>"],
    }),
    "bfrange array values",
  );
  assert.equal(result.canonicalText, "AB🌳");
  /* 数组元素数必须等于码数（hi-lo+1）——失配是损坏的 CMap，如实 corrupt。 */
  const mismatchCmap =
    "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n" +
    "1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n" +
    "1 beginbfrange\n<0001> <0004> [<0041> <0042>]\nendbfrange\n" +
    "endcmap\nend\nend\n";
  parseReject(
    buildTextPdf(["BT /F1 12 Tf 72 700 Td <0001> Tj ET"], {
      fontBody:
        "<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /DescendantFonts [5 0 R] /ToUnicode 4 0 R >>",
      extraObjects: [contentStreamBody(mismatchCmap), "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /X >>"],
    }),
    "corrupt",
    "bfrange array count mismatch",
  );
});

test("inline images (BI/ID/EI) are skipped whole; text before and after survives intact", () => {
  /* 二进制里故意埋两重陷阱：裸 EI 前置非空白字节（仅空白前置条件能否
     拒绝它）、其后的未配对括号（若提前终止扫描，括号会吞掉后续文字
     的 Tj 串——两种误判都会让本用例失败）。 */
  const binary = "\x01\x02EI)\xff(unbalanced-until-the-real-terminator";
  const withImage =
    "BT /F1 12 Tf 72 700 Td (before) Tj ET\n" +
    `q BI /W 2 /H 2 /CS /G /BPC 8 ID ${binary} EI Q\n` +
    "BT /F1 12 Tf 72 680 Td (after) Tj ET";
  assert.equal(singlePageText(withImage), "before\nafter");
  /* BI 之后没有 ID（内容流残缺）→ corrupt。 */
  parseReject(
    buildTextPdf(["BT /F1 12 Tf 72 700 Td (x) Tj ET\nBI /W 1 /H 1"]),
    "corrupt",
    "BI without ID",
  );
  /* ID 之后没有 EI 终结符 → corrupt。 */
  parseReject(
    buildTextPdf(["q BI /W 1 /H 1 /CS /G /BPC 8 ID \x01\x02 Q"]),
    "corrupt",
    "ID without EI",
  );
});

test("lazy fonts: only a font actually used to show text can fail the page", () => {
  const brokenFont = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /StandardEncoding >>";
  const twoFonts = { extraObjects: [brokenFont], fontResources: " /F2 4 0 R" };
  /* /F2 不支持（StandardEncoding），但内容只用 /F1 → 照常解析。 */
  assert.equal(singlePageText("BT /F1 12 Tf 72 700 Td (fine) Tj ET", twoFonts), "fine");
  /* Tf 选中 /F2 但从未显示文字 → 不失败（未用于显示的字体不物化）。 */
  assert.equal(
    singlePageText("BT /F2 12 Tf ET\nBT /F1 12 Tf 72 700 Td (fine) Tj ET", twoFonts),
    "fine",
  );
  /* /F2 真正显示文字 → unsupported（诚实能力边界，消息说明特征）。 */
  parseReject(
    buildTextPdf(["BT /F2 12 Tf 72 700 Td (x) Tj ET"], twoFonts),
    "unsupported",
    "broken font actually used to show text",
  );
  /* 空串显示（零字节零字形）不物化字体：坏字体 + () Tj → 不失败。 */
  assert.equal(
    singlePageText("BT /F2 12 Tf 72 700 Td () Tj ET\nBT /F1 12 Tf 72 680 Td (fine) Tj ET", twoFonts),
    "\nfine",
  );
  /* 未知资源名：Tf 后真正显示 → corrupt；只 Tf 不显示 → 不影响。 */
  parseReject(
    buildTextPdf(["BT /F9 12 Tf 72 700 Td (x) Tj ET"]),
    "corrupt",
    "unknown font resource actually used to show text",
  );
  assert.equal(singlePageText("BT /F9 12 Tf ET\nBT /F1 12 Tf 72 700 Td (fine) Tj ET"), "fine");
});

/* ---------------- 拒绝面：encrypted / no-text-layer ---------------- */

test("rejection: encrypted — a trailer carrying /Encrypt is refused without any decryption attempt", () => {
  /* trailer 带 /Encrypt（对象 4 为标准安全处理器形状；解析器从不解密）。 */
  const rejected = parseReject(
    buildTextPdf(["BT /F1 12 Tf 72 700 Td (secret) Tj ET"], {
      extraObjects: ["<< /Filter /Standard /V 2 /R 3 /Length 128 /O <0102> /U <0304> /P -4 >>"],
      trailerExtra: " /Encrypt 4 0 R",
    }),
    "encrypted",
    "trailer /Encrypt",
  );
  assert.ok(rejected.message.includes("/Encrypt"), "the message names /Encrypt");
});

test("rejection: no-text-layer — image-only content (no text operators) is never an empty ready document", () => {
  const rejected = parseReject(
    buildTextPdf(["q 595.28 0 0 841.89 0 0 cm /Im0 Do Q"]),
    "no-text-layer",
    "image-only page",
  );
  assert.ok(rejected.message.includes("no extractable text"), "the message explains the honest absence of a text layer");
});
