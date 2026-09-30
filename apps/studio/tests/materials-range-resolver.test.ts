/**
 * D4-2 统一区间/锚点解析层测试（issue #8 工作包 D4-2；charter §3.2 锚点
 * 语义 / §6 B2 精确锚点）。
 *
 * 覆盖（服务层，真实 MaterialRepository 内存库；HTTP 面见
 * materials-reading-api.test.ts；冻结 B2 全集执行见 verify:d4 的
 * b2-precise-anchors）：
 * - 有效类别（B2 必覆盖类别）：repeat-word-2nd（含重叠出现 +1 步进语义）、
 *   cross-line、unicode（星面 emoji / ZWJ 簇安全边界）、long-tail（长文
 *   后段）、utf16-range 精确区间；解析产物与仓储 getMaterialSelection
 *   纪律互检（切片/块/sourceHash）；带期望摘录 + 声明块的锚点复核往返；
 * - 无效类别（B2 冻结类别逐项 + 产品面补充）：out-of-bounds（负 start /
 *   end 超长）、reversed、zero-length、surrogate-split、combining-split、
 *   emoji-split、cross-block、cross-page（pdf 块图）、block-mismatch
 *   （声明错块 / 声明不存在的块）、excerpt-mismatch、needle-not-found、
 *   invalid-locator（非整数 / 空 needle / occurrence<1 / 未知 kind）、
 *   material-not-ready（failed 版本）；
 * - stale-version：同区间跨版本文本改变 → 对新版本 stale-version、对旧
 *   版本仍可解析（旧版本可读、锚点不迁移）；无溯源 → excerpt-mismatch；
 *   溯源 sourceHash 不符 / 跨材料溯源 → InvalidArgumentError；目标版本
 *   文本未变 → 正常解析（不是 stale）；
 * - 引用错误：未知版本 EntityNotFoundError；versionId 属于其他材料 →
 *   InvalidArgumentError；
 * - 图素簇缓存按内容寻址：两份相同 canonicalText 的不同版本互不串扰。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { MaterialBlock, MaterialId, MaterialVersionId } from "@treeai/contracts";
import { EntityNotFoundError, InvalidArgumentError, MaterialRepository } from "@treeai/persistence";
import {
  MaterialRangeResolver,
  type MaterialLocator,
  type ResolveSelectionInput,
} from "../src/materials/range-resolver.ts";

const ENCODER = new TextEncoder();

function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

interface InsertedVersion {
  readonly materialId: MaterialId;
  readonly versionId: MaterialVersionId;
  readonly text: string;
  readonly blocks: readonly MaterialBlock[];
}

/**
 * 直插一个 ready 版本（绕过导入流水线，精确控制 canonicalText 与块图——
 * 解析层的契约对象是仓储中的冻结真值，与解析器产出来源无关）。
 */
function insertReadyVersion(
  repository: MaterialRepository,
  parts: readonly string[],
  options: { readonly parserKind?: "markdown" | "pdf"; readonly prefix?: string } = {},
): InsertedVersion {
  const parserKind = options.parserKind ?? "markdown";
  const text = parts.join("");
  const blocks: MaterialBlock[] = [];
  let at = 0;
  parts.forEach((part, index) => {
    blocks.push({
      blockId: parserKind === "pdf" ? `page-${index + 1}` : `blk-${index}`,
      kind: parserKind === "pdf" ? "pdf-page" : "markdown-block",
      start: at,
      end: at + part.length,
      ...(parserKind === "pdf" ? { page: index + 1 } : {}),
    });
    at += part.length;
  });
  const material = repository.createMaterial({ title: `${options.prefix ?? "m"}-${blocks.length}-blocks` });
  const version = repository.insertVersion({
    materialId: material.id,
    bytes: ENCODER.encode(`${options.prefix ?? "m"}:${text}`),
    parserKind,
    parserVersion: parserKind === "markdown" ? "d4-md-v1" : "d4-pdf-v1",
    parseStatus: "ready",
    canonicalText: text,
    blocks,
  });
  return { materialId: material.id, versionId: version.id, text, blocks };
}

function makeResolver(): { repository: MaterialRepository; resolver: MaterialRangeResolver } {
  const repository = MaterialRepository.open({ path: ":memory:" });
  return { repository, resolver: new MaterialRangeResolver({ repository }) };
}

function resolve(
  resolver: MaterialRangeResolver,
  version: InsertedVersion,
  locator: MaterialLocator,
  extra: Omit<ResolveSelectionInput, "versionId" | "locator" | "materialId"> = {},
) {
  return resolver.resolve({
    materialId: version.materialId,
    versionId: version.versionId,
    locator,
    ...extra,
  });
}

/* ------------------------------------------------------------------ */
/* 有效类别：精确解析 + 锚点复核往返                                    */
/* ------------------------------------------------------------------ */

test("valid categories resolve exactly: repeat-word-2nd (overlapping occurrences), cross-line, unicode, long-tail, utf16-range", () => {
  const { repository, resolver } = makeResolver();
  try {
    /* repeat-word-2nd：三个重叠词，第 2 处出现。 */
    const repeat = insertReadyVersion(repository, ["重复 重复 重复\n\nagain again again"], { prefix: "repeat" });
    const second = resolve(resolver, repeat, { kind: "text-occurrence", needle: "重复", occurrence: 2 });
    assert.ok(second.ok, `repeat-word-2nd must resolve: ${second.ok ? "" : second.rejection.message}`);
    assert.equal(second.result.selection.start, 3); // 第 2 处“重复”自偏移 3 起
    assert.equal(second.result.selection.end, 5);
    assert.equal(second.result.selection.excerpt, "重复");
    assert.equal(second.result.selection.blockId, "blk-0");

    /* +1 步进语义（与冻结探针一致）：needle "aa" 在 "aaa" 中的第 2 次
       出现是 [1,3)（重叠计数），不是 not-found。 */
    const overlap = insertReadyVersion(repository, ["aaa"], { prefix: "overlap" });
    const overlapping = resolve(resolver, overlap, { kind: "text-occurrence", needle: "aa", occurrence: 2 });
    assert.ok(overlapping.ok);
    assert.equal(overlapping.result.selection.start, 1);
    assert.equal(overlapping.result.selection.end, 3);

    /* cross-line：同一块内跨行选区（含 \n）。 */
    const crossLine = insertReadyVersion(repository, ["first line\nsecond line\n\nafter gap"], { prefix: "crossline" });
    const crossed = resolve(resolver, crossLine, { kind: "utf16-range", start: 0, end: 22 });
    assert.ok(crossed.ok, `cross-line must resolve: ${crossed.ok ? "" : crossed.rejection.message}`);
    assert.equal(crossed.result.selection.excerpt, "first line\nsecond line");
    assert.equal(crossed.result.selection.blockId, "blk-0");

    /* unicode：星面 emoji 前后与 ZWJ 簇整体（安全边界）。
       "🚀 rocket 👨‍💻 pair"：🚀 [0,2)、" rocket " [2,10)、👨 [10,12)、
       ZWJ [12,13)、💻 [13,15)、" pair" [15,20)。 */
    const unicode = insertReadyVersion(repository, ["🚀 rocket 👨‍💻 pair\n\ntail"], { prefix: "unicode" });
    const rocket = resolve(resolver, unicode, { kind: "text-occurrence", needle: "🚀 rocket", occurrence: 1 });
    assert.ok(rocket.ok, `emoji selection must resolve: ${rocket.ok ? "" : rocket.rejection.message}`);
    assert.equal(rocket.result.selection.start, 0);
    assert.equal(rocket.result.selection.end, 9); // 🚀 占 2 码元 + " rocket" 7
    const wholeCluster = resolve(resolver, unicode, { kind: "utf16-range", start: 10, end: 15 });
    assert.ok(wholeCluster.ok, `whole ZWJ cluster must resolve: ${wholeCluster.ok ? "" : wholeCluster.rejection.message}`);
    assert.equal(wholeCluster.result.selection.excerpt, "👨‍💻");

    /* long-tail：长文（20k 单元）后段选区。 */
    const longTail = insertReadyVersion(repository, [`${"x".repeat(19_000)}TAIL-MARKER-NEAR-END`], { prefix: "long" });
    const tail = resolve(resolver, longTail, { kind: "text-occurrence", needle: "TAIL-MARKER", occurrence: 1 });
    assert.ok(tail.ok);
    assert.ok(tail.result.selection.start > 0.95 * longTail.text.length, "long-tail selection must be in the final stretch");
    const tailRange = resolve(resolver, longTail, { kind: "utf16-range", start: 19_000, end: 19_004 });
    assert.ok(tailRange.ok);
    assert.equal(tailRange.result.selection.excerpt, "TAIL");

    /* utf16-range 精确 + sourceHash + 与仓储选区纪律互检。 */
    const exact = resolve(resolver, repeat, { kind: "utf16-range", start: 6, end: 8 });
    assert.ok(exact.ok);
    assert.equal(exact.result.selection.excerpt, "重复");
    assert.equal(exact.result.selection.sourceHash, sha256Text(repeat.text));
    assert.equal(exact.result.block.blockId, "blk-0");
    const discipline = repository.getMaterialSelection(exact.result.selection);
    assert.equal(discipline.selection.excerpt, "重复");

    /* 锚点复核往返：带期望摘录 + 声明块同样通过。 */
    const roundTrip = resolve(resolver, crossLine, { kind: "utf16-range", start: 0, end: 22 }, {
      excerpt: "first line\nsecond line",
      blockId: "blk-0",
    });
    assert.ok(roundTrip.ok, `anchor round-trip must resolve: ${roundTrip.ok ? "" : roundTrip.rejection.message}`);
  } finally {
    repository.close();
  }
});

/* ------------------------------------------------------------------ */
/* 无效类别：逐项拒绝 + 正确原因码                                      */
/* ------------------------------------------------------------------ */

test("invalid categories are rejected with the correct frozen reason code", () => {
  const { repository, resolver } = makeResolver();
  try {
    const md = insertReadyVersion(repository, ["alpha beta\n\n", "gamma delta"], { prefix: "md" });
    const emoji = insertReadyVersion(repository, ["🚀 flag and 👨‍💻 pair"], { prefix: "emoji" });
    const combining = insertReadyVersion(repository, ["café done"], { prefix: "comb" }); // e + U+0301 分解形
    const pdf = insertReadyVersion(
      repository,
      ["Page one text\n", "Page two text"],
      { parserKind: "pdf", prefix: "pdf" },
    );
    assert.equal(combining.text.length, 10, "é must be the decomposed form (e + U+0301 = 2 units)");

    const cases: ReadonlyArray<{
      readonly what: string;
      readonly version: InsertedVersion;
      readonly locator: MaterialLocator;
      readonly extra?: Omit<ResolveSelectionInput, "versionId" | "locator" | "materialId">;
      readonly code: string;
    }> = [
      { what: "negative start", version: md, locator: { kind: "utf16-range", start: -1, end: 5 }, code: "out-of-bounds" },
      { what: "end beyond the text", version: md, locator: { kind: "utf16-range", start: 0, end: md.text.length + 1 }, code: "out-of-bounds" },
      { what: "reversed range", version: md, locator: { kind: "utf16-range", start: 10, end: 4 }, code: "reversed" },
      { what: "zero-length range", version: md, locator: { kind: "utf16-range", start: 3, end: 3 }, code: "zero-length" },
      { what: "surrogate split", version: emoji, locator: { kind: "utf16-range", start: 1, end: 3 }, code: "surrogate-split" },
      { what: "combining split", version: combining, locator: { kind: "utf16-range", start: 4, end: 6 }, code: "combining-split" },
      { what: "emoji ZWJ split", version: emoji, locator: { kind: "utf16-range", start: 14, end: 16 }, code: "emoji-split" },
      { what: "cross block (markdown)", version: md, locator: { kind: "utf16-range", start: 5, end: 15 }, code: "cross-block" },
      { what: "cross page (pdf)", version: pdf, locator: { kind: "utf16-range", start: 10, end: 16 }, code: "cross-page" },
      {
        what: "block mismatch (declares the wrong existing block)",
        version: md,
        locator: { kind: "utf16-range", start: 0, end: 5 },
        extra: { blockId: "blk-1" },
        code: "block-mismatch",
      },
      {
        what: "block mismatch (declares a nonexistent block)",
        version: md,
        locator: { kind: "utf16-range", start: 0, end: 5 },
        extra: { blockId: "blk-9" },
        code: "block-mismatch",
      },
      {
        what: "excerpt mismatch",
        version: md,
        locator: { kind: "utf16-range", start: 0, end: 5 },
        extra: { excerpt: "wrong" },
        code: "excerpt-mismatch",
      },
      { what: "needle not found", version: md, locator: { kind: "text-occurrence", needle: "alpha", occurrence: 5 }, code: "needle-not-found" },
      { what: "non-integer offsets", version: md, locator: { kind: "utf16-range", start: 1.5, end: 5 } as unknown as MaterialLocator, code: "invalid-locator" },
      { what: "empty needle", version: md, locator: { kind: "text-occurrence", needle: "", occurrence: 1 }, code: "invalid-locator" },
      { what: "occurrence below 1", version: md, locator: { kind: "text-occurrence", needle: "alpha", occurrence: 0 }, code: "invalid-locator" },
      { what: "unknown locator kind", version: md, locator: { kind: "css-selector", selector: "p" } as unknown as MaterialLocator, code: "invalid-locator" },
    ];
    for (const item of cases) {
      const resolution = resolve(resolver, item.version, item.locator, item.extra ?? {});
      assert.ok(!resolution.ok, `${item.what}: expected a rejection`);
      assert.equal(resolution.rejection.code, item.code, `${item.what}: wrong rejection code`);
      assert.ok(resolution.rejection.message.length > 0, `${item.what}: rejection carries a message`);
    }

    /* 非 ready 版本：failed 版本无规范文本可锚定。 */
    const failedMaterial = repository.createMaterial({ title: "failed" });
    const failedVersion = repository.insertVersion({
      materialId: failedMaterial.id,
      bytes: ENCODER.encode("never parsed"),
      parserKind: "markdown",
      parserVersion: "d4-md-v1",
      parseStatus: "failed",
      parseError: "invalid-utf8: material is not well-formed UTF-8",
      canonicalText: "",
      blocks: [],
    });
    const notReady = resolver.resolve({
      materialId: failedMaterial.id,
      versionId: failedVersion.id,
      locator: { kind: "utf16-range", start: 0, end: 4 },
    });
    assert.ok(!notReady.ok);
    assert.equal(notReady.rejection.code, "material-not-ready");
    assert.ok(notReady.rejection.message.includes("invalid-utf8"), "the failure reason is carried, not hidden");
  } finally {
    repository.close();
  }
});

/* ------------------------------------------------------------------ */
/* stale-version：跨版本文本改变                                        */
/* ------------------------------------------------------------------ */

test("stale-version: same range, changed text → stale for the new version; the old version stays readable and the anchor is not migrated", () => {
  const { repository, resolver } = makeResolver();
  try {
    const material = repository.createMaterial({ title: "versioned" });
    const v1 = repository.insertVersion({
      materialId: material.id,
      bytes: ENCODER.encode("v1:alpha beta gamma\n\ndelta"),
      parserKind: "markdown",
      parserVersion: "d4-md-v1",
      parseStatus: "ready",
      canonicalText: "alpha beta gamma\n\ndelta",
      blocks: [
        { blockId: "blk-0", kind: "markdown-block", start: 0, end: 18 },
        { blockId: "blk-1", kind: "markdown-block", start: 18, end: 23 },
      ],
    });
    /* v2：同长度改写（[6,10) 由 "beta" → "BETA"）。 */
    const v2 = repository.insertVersion({
      materialId: material.id,
      bytes: ENCODER.encode("v2:alpha BETA gamma\n\ndelta"),
      parserKind: "markdown",
      parserVersion: "d4-md-v1",
      parseStatus: "ready",
      canonicalText: "alpha BETA gamma\n\ndelta",
      blocks: [
        { blockId: "blk-0", kind: "markdown-block", start: 0, end: 18 },
        { blockId: "blk-1", kind: "markdown-block", start: 18, end: 23 },
      ],
    });

    const anchorInput = {
      materialId: material.id,
      locator: { kind: "utf16-range", start: 6, end: 10 } as MaterialLocator,
      excerpt: "beta",
    };

    /* 锚定版本自身：锚点完好可解析。 */
    const onOld = resolver.resolve({ ...anchorInput, versionId: v1.id });
    assert.ok(onOld.ok, "the anchor re-validates on its own version");
    assert.equal(onOld.result.selection.excerpt, "beta");

    /* 重锚到 v2（带溯源）：stale-version，绝不落到相似文字。 */
    const reanchored = resolver.resolve({
      ...anchorInput,
      versionId: v2.id,
      anchor: { versionId: v1.id, sourceHash: sha256Text("alpha beta gamma\n\ndelta") },
    });
    assert.ok(!reanchored.ok);
    assert.equal(reanchored.rejection.code, "stale-version");
    assert.ok(reanchored.rejection.message.includes(v1.id), "the stale rejection names the intact old version");

    /* 无溯源：excerpt-mismatch（同一切片不等，不误报 stale）。 */
    const withoutProvenance = resolver.resolve({ ...anchorInput, versionId: v2.id });
    assert.ok(!withoutProvenance.ok);
    assert.equal(withoutProvenance.rejection.code, "excerpt-mismatch");

    /* 文本未变的区间（[17,22) "delta" 两版一致）：跨版本重锚正常成功。 */
    const unchanged = resolver.resolve({
      materialId: material.id,
      versionId: v2.id,
      locator: { kind: "utf16-range", start: 18, end: 23 },
      excerpt: "delta",
      anchor: { versionId: v1.id, sourceHash: sha256Text("alpha beta gamma\n\ndelta") },
    });
    assert.ok(unchanged.ok, "an unchanged range is not stale");
    assert.equal(unchanged.result.selection.excerpt, "delta");

    /* 溯源 sourceHash 与锚定版本不符 → 引用错误（InvalidArgumentError）。 */
    assert.throws(
      () =>
        resolver.resolve({
          ...anchorInput,
          versionId: v2.id,
          anchor: { versionId: v1.id, sourceHash: "0".repeat(64) },
        }),
      InvalidArgumentError,
    );

    /* 跨材料溯源 → 引用错误。 */
    const otherMaterial = repository.createMaterial({ title: "other" });
    const otherVersion = repository.insertVersion({
      materialId: otherMaterial.id,
      bytes: ENCODER.encode("other"),
      parserKind: "markdown",
      parserVersion: "d4-md-v1",
      parseStatus: "ready",
      canonicalText: "alpha beta",
      blocks: [{ blockId: "blk-0", kind: "markdown-block", start: 0, end: 10 }],
    });
    assert.throws(
      () =>
        resolver.resolve({
          ...anchorInput,
          versionId: v2.id,
          anchor: { versionId: otherVersion.id, sourceHash: sha256Text("alpha beta") },
        }),
      InvalidArgumentError,
    );
  } finally {
    repository.close();
  }
});

/* ------------------------------------------------------------------ */
/* 引用错误与缓存正确性                                                */
/* ------------------------------------------------------------------ */

test("reference errors: unknown version 404s; a version of another material is an input error", () => {
  const { repository, resolver } = makeResolver();
  try {
    const first = insertReadyVersion(repository, ["first material"], { prefix: "a" });
    const second = insertReadyVersion(repository, ["second material"], { prefix: "b" });
    assert.throws(
      () =>
        resolver.resolve({
          versionId: "matver-missing" as MaterialVersionId,
          locator: { kind: "utf16-range", start: 0, end: 5 },
        }),
      EntityNotFoundError,
    );
    /* versionId 属于材料 b，却声明 materialId a → InvalidArgumentError。 */
    assert.throws(
      () =>
        resolver.resolve({
          materialId: first.materialId,
          versionId: second.versionId,
          locator: { kind: "utf16-range", start: 0, end: 5 },
        }),
      InvalidArgumentError,
    );
    /* 不给出 materialId 时照常解析（版本自身即真值来源）。 */
    const noMaterialCheck = resolver.resolve({
      versionId: second.versionId,
      locator: { kind: "utf16-range", start: 0, end: 6 },
    });
    assert.ok(noMaterialCheck.ok);
    assert.equal(noMaterialCheck.result.selection.excerpt, "second");
  } finally {
    repository.close();
  }
});

test("grapheme cache is content-addressed: identical canonical texts in different versions never cross-contaminate", () => {
  const { repository, resolver } = makeResolver();
  try {
    /* 两个材料、完全相同的 canonicalText（前缀只影响原件字节，不影响文本）。 */
    const left = insertReadyVersion(repository, ["🚀 same text"], { prefix: "left" });
    const right = insertReadyVersion(repository, ["🚀 same text"], { prefix: "right" });
    for (const version of [left, right]) {
      const ok = resolve(resolver, version, { kind: "utf16-range", start: 0, end: 2 });
      assert.ok(ok.ok, `whole-cluster selection on ${version.versionId} must resolve`);
      assert.equal(ok.result.selection.excerpt, "🚀");
      const split = resolve(resolver, version, { kind: "utf16-range", start: 1, end: 2 });
      assert.ok(!split.ok && split.rejection.code === "surrogate-split");
    }
  } finally {
    repository.close();
  }
});
