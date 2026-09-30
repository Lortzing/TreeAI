/**
 * D4-1 材料导入服务测试（issue #8 工作包 D4-1；离线、确定性、临时数据目录）。
 *
 * 覆盖（服务层，HTTP 面见 materials-api.test.ts）：
 * - happy path：markdown 导入 → 异步任务 pending→parsing→ready；
 *   分块读取（块图/textUnits/游标分页）；
 * - PDF 导入（d4-pdf-v1 默认装配）：真实 fixture（pdf-01）→ ready 版本、
 *   page-N 块图（含 page 字段）与冻结真值全等、分页游标、树内同字节复用；
 * - PDF 负例：corrupt fixture → 版本 failed（原因码入 parseError）、读取
 *   409 语义（MaterialNotReadyError）；页数上限（注入 maxPages）→
 *   pages-exceeded，超限文本不落库；
 * - 自定义注册表缺 pdf 槽位 → 415 语义的诚实 "not wired" 拒绝；
 * - 版本语义：树内同字节复用（created=false，零新行）；同材料新字节追加
 *   新版本（版本链完整、旧版本可读、同字节经 versions 端点复用）；
 * - 上限（charter §5）：默认冻结值（20 MiB / 1,000,000 units / 200 页）；
 *   小限额注入 → material-too-large 在解析前拒绝（零持久化）；
 * - 规范文本超限 → 版本 failed text-units-exceeded（超限文本不落库）；
 * - 取消（受控门控假解析器）：cancel → canceled；放行迟到结果 → 状态保持
 *   canceled、迟到丢弃计数、无 ready 版本、无规范文本（迟到不挂靠）；
 * - 宿主中断恢复：遗留 parsing 版本在新服务实例构造时收敛 failed
 *   （parse-interrupted）；
 * - 诚实拒绝：未知扩展名 / 空文件名 / 空字节 / 未知树——全部零持久化；
 * - 非 ready 版本读取 → MaterialNotReadyError（绝不伪装空成功文档）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { MaterialBlock, MaterialId, TreeId } from "@treeai/contracts";
import { EntityNotFoundError, InvalidArgumentError } from "@treeai/persistence";
import {
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_PAGES,
  DEFAULT_MAX_TEXT_UNITS,
  D4_MD_V1_PARSER,
  MaterialImportService,
  MaterialNotReadyError,
  MaterialTooLargeError,
  MaterialUnsupportedError,
  ParseTaskNotCancelableError,
  type MaterialParser,
  type MaterialParserOutcome,
} from "../src/materials/import-service.ts";
import { cleanupDir, makeStudioInstance, makeTempDataDir } from "./helpers.ts";

const ENCODER = new TextEncoder();
const B1_ROOT = fileURLToPath(new URL("../../../tests/fixtures/d4/b1-import/", import.meta.url));

function utf8(text: string): Uint8Array {
  return ENCODER.encode(text);
}

function b1Bytes(rel: string): Uint8Array {
  return new Uint8Array(readFileSync(`${B1_ROOT}${rel}`));
}

/** B1 冻结真值（pdf-01：2 页中文笔记）。 */
const PDF_01 = JSON.parse(readFileSync(`${B1_ROOT}pdf/pdf-01.expected.json`, "utf8")) as {
  canonicalText: string;
  blocks: readonly { blockId: string; start: number; end: number; page: number; text: string }[];
};

/** 轮询等待条件成立（解析任务是微任务/近即时，留足余量）。 */
async function until(predicate: () => boolean, what: string, attempts = 200): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** 三块 markdown（d4-md-v1：blk-0 "One\n\n" / blk-1 "Two\n\n" / blk-2 "Three"）。 */
const THREE_BLOCKS = "One\n\nTwo\n\nThree";
const THREE_BLOCKS_UNITS = THREE_BLOCKS.length; // 18

/**
 * 受控门控假解析器：parse() 挂起直到 release()，随后返回预设产出——
 * 用于确定性观测「取消在途任务 + 迟到结果丢弃」。
 */
class GatedParser implements MaterialParser {
  readonly kind = "markdown" as const;
  readonly parserVersion = "fake-gated-v1";
  #release: (() => void) | null = null;
  readonly #promise: Promise<MaterialParserOutcome>;

  constructor(outcome?: MaterialParserOutcome) {
    const finalOutcome: MaterialParserOutcome =
      outcome ?? {
        ok: true,
        canonicalText: "Gated head\n\nGated tail",
        blocks: [
          { blockId: "blk-0", kind: "markdown-block", start: 0, end: 12 },
          { blockId: "blk-1", kind: "markdown-block", start: 12, end: 22 },
        ] satisfies MaterialBlock[],
      };
    this.#promise = new Promise<MaterialParserOutcome>((resolve) => {
      this.#release = () => resolve(finalOutcome);
    });
  }

  parse(): Promise<MaterialParserOutcome> {
    return this.#promise;
  }

  release(): void {
    this.#release?.();
  }
}

test("markdown import: async pending→parsing→ready with chunked reads paginating blocks", async () => {
  const dir = makeTempDataDir();
  const studio = makeStudioInstance(dir);
  try {
    const { tree } = studio.service.createTree();

    const result = await studio.materials.importMaterial(tree.id, {
      filename: "notes v1.md",
      bytes: utf8(THREE_BLOCKS),
    });
    assert.equal(result.created, true);
    assert.ok(result.parseTaskId !== null);
    assert.equal(result.version.parseStatus, "parsing", "the parse task advances to parsing before the import returns");
    assert.equal(result.material.title, "notes v1.md", "the decoded filename becomes the (editable) display title");

    await until(
      () => studio.materials.getMaterialDetail(tree.id, result.material.id).versions[0]!.parseStatus === "ready",
      "the version to become ready",
    );
    const version = studio.materials.getMaterialDetail(tree.id, result.material.id).versions[0]!;
    assert.equal(version.parseStatus, "ready");
    assert.equal(version.textUnits, THREE_BLOCKS_UNITS);
    assert.equal(version.parserKind, "markdown");
    assert.equal(version.parserVersion, "d4-md-v1");

    /* 分块读取：整读 + 分页游标。 */
    const full = studio.materials.readVersionBlocks(tree.id, result.material.id, result.version.id, {});
    assert.equal(full.nextAfterBlock, null);
    assert.equal(full.textUnits, THREE_BLOCKS_UNITS);
    assert.deepEqual(
      full.blocks.map((entry) => entry.text),
      ["One\n\n", "Two\n\n", "Three"],
      "block text is the canonicalText slice of the block range",
    );

    const page1 = studio.materials.readVersionBlocks(tree.id, result.material.id, result.version.id, { limit: 2 });
    assert.deepEqual(page1.blocks.map((entry) => entry.block.blockId), ["blk-0", "blk-1"]);
    assert.equal(page1.nextAfterBlock, "blk-1");
    const page2 = studio.materials.readVersionBlocks(tree.id, result.material.id, result.version.id, {
      afterBlock: "blk-1",
      limit: 2,
    });
    assert.deepEqual(page2.blocks.map((entry) => entry.block.blockId), ["blk-2"]);
    assert.equal(page2.nextAfterBlock, null);
    assert.equal(page2.blocks[0]!.text, "Three");

    /* 游标/限额校验。 */
    assert.throws(
      () => studio.materials.readVersionBlocks(tree.id, result.material.id, result.version.id, { afterBlock: "blk-9" }),
      InvalidArgumentError,
    );
    assert.throws(
      () => studio.materials.readVersionBlocks(tree.id, result.material.id, result.version.id, { limit: 0 }),
      InvalidArgumentError,
    );
    assert.throws(
      () => studio.materials.readVersionBlocks(tree.id, result.material.id, result.version.id, { limit: 501 }),
      InvalidArgumentError,
    );

    /* 任务终态投影。 */
    const task = studio.materials.getParseTask(result.parseTaskId!)!;
    assert.equal(task.state, "ready");
    assert.equal(task.lateResultDiscarded, false);
  } finally {
    await studio.shutdown();
    cleanupDir(dir);
  }
});

test("version semantics: tree-scoped same-bytes reuse; new bytes append a version; old versions stay readable", async () => {
  const dir = makeTempDataDir();
  const studio = makeStudioInstance(dir);
  try {
    const { tree } = studio.service.createTree();

    const first = await studio.materials.importMaterial(tree.id, {
      filename: "report.md",
      bytes: utf8(THREE_BLOCKS),
    });
    await until(
      () => studio.materials.getMaterialDetail(tree.id, first.material.id).versions[0]!.parseStatus === "ready",
      "the first version to become ready",
    );

    /* 树内同字节重导（不同文件名也复用——文件名不是身份）：零新行。 */
    const reimport = await studio.materials.importMaterial(tree.id, {
      filename: "renamed-copy.md",
      bytes: utf8(THREE_BLOCKS),
    });
    assert.equal(reimport.created, false);
    assert.equal(reimport.material.id, first.material.id);
    assert.equal(reimport.version.id, first.version.id);
    assert.equal(reimport.parseTaskId, null, "reuse does not spawn a new parse task");
    assert.equal(studio.materials.listTreeMaterials(tree.id).length, 1, "no duplicate material row");
    assert.equal(
      studio.materialRepository.listVersions(first.material.id).length,
      1,
      "no duplicate version row",
    );

    /* 新字节 → 新版本（版本链追加，旧版本可读不受影响）。 */
    const second = await studio.materials.addMaterialVersion(tree.id, first.material.id, {
      filename: "report.md",
      bytes: utf8("Revised\n\nContent"),
    });
    assert.equal(second.created, true);
    assert.notEqual(second.version.id, first.version.id);
    const versions = studio.materials.getMaterialDetail(tree.id, first.material.id).versions;
    assert.equal(versions.length, 2);
    assert.deepEqual(versions.map((version) => version.id), [first.version.id, second.version.id], "import order");
    await until(
      () => studio.materials.getMaterialDetail(tree.id, first.material.id).versions[1]!.parseStatus === "ready",
      "the second version to become ready",
    );
    const oldPage = studio.materials.readVersionBlocks(tree.id, first.material.id, first.version.id, {});
    assert.equal(oldPage.textUnits, THREE_BLOCKS_UNITS, "the old version is still readable and unchanged");

    /* 同材料同字节（versions 端点语义）：复用 v1，不追加。 */
    const replay = await studio.materials.addMaterialVersion(tree.id, first.material.id, {
      filename: "report.md",
      bytes: utf8(THREE_BLOCKS),
    });
    assert.equal(replay.created, false);
    assert.equal(replay.version.id, first.version.id);
    assert.equal(studio.materialRepository.listVersions(first.material.id).length, 2);
  } finally {
    await studio.shutdown();
    cleanupDir(dir);
  }
});

test("limits: frozen defaults; small injected limits reject before parsing with zero persistence", async () => {
  const dir = makeTempDataDir();
  const studio = makeStudioInstance(dir);
  try {
    assert.deepEqual(studio.materials.limits, {
      maxFileBytes: DEFAULT_MAX_FILE_BYTES,
      maxTextUnits: DEFAULT_MAX_TEXT_UNITS,
      maxPages: DEFAULT_MAX_PAGES,
    });
    assert.equal(DEFAULT_MAX_FILE_BYTES, 20 * 1024 * 1024, "20 MiB (charter §5)");
    assert.equal(DEFAULT_MAX_TEXT_UNITS, 1_000_000, "1,000,000 UTF-16 units (charter §5)");
    assert.equal(DEFAULT_MAX_PAGES, 200, "200 text-PDF pages (charter §5)");
    /* 默认注册表两槽位齐装（markdown + pdf）。 */
    assert.deepEqual(studio.materials.precheckImport((studio.service.createTree().tree).id, "paper.pdf"), {
      parserKind: "pdf",
      parserVersion: "d4-pdf-v1",
    });
  } finally {
    await studio.shutdown();
    cleanupDir(dir);
  }

  const smallDir = makeTempDataDir();
  const small = makeStudioInstance(smallDir, { materialImport: { limits: { maxFileBytes: 32 } } });
  try {
    const { tree } = small.service.createTree();
    const oversize = utf8("x".repeat(64)); // 64 bytes > 32-byte injected limit
    await assert.rejects(
      () => small.materials.importMaterial(tree.id, { filename: "big.md", bytes: oversize }),
      (error: unknown) => error instanceof MaterialTooLargeError && error.sizeBytes === 64 && error.maxFileBytes === 32,
    );
    assert.deepEqual(small.materials.listTreeMaterials(tree.id), [], "oversize import persists nothing");
  } finally {
    await small.shutdown();
    cleanupDir(smallDir);
  }
});

test("pdf import (default wiring): pdf-01 reaches ready with page blocks matching the frozen truth; chunked pagination", async () => {
  const dir = makeTempDataDir();
  const studio = makeStudioInstance(dir);
  try {
    const { tree } = studio.service.createTree();
    const result = await studio.materials.importMaterial(tree.id, {
      filename: "递归学习笔记 v1.pdf",
      bytes: b1Bytes("pdf/pdf-01.pdf"),
    });
    assert.equal(result.created, true);
    assert.equal(result.version.parserKind, "pdf");
    assert.equal(result.version.parserVersion, "d4-pdf-v1");
    await until(
      () => studio.materials.getMaterialDetail(tree.id, result.material.id).versions[0]!.parseStatus === "ready",
      "the pdf version to become ready",
    );
    const version = studio.materials.getMaterialDetail(tree.id, result.material.id).versions[0]!;
    assert.equal(version.textUnits, PDF_01.canonicalText.length, "textUnits match the frozen truth");

    /* 块图：page-N 块 + page 字段 + 文本切片与真值全等。 */
    const full = studio.materials.readVersionBlocks(tree.id, result.material.id, result.version.id, {});
    assert.equal(full.nextAfterBlock, null);
    assert.deepEqual(
      full.blocks.map((entry) => entry.block),
      PDF_01.blocks.map((block) => ({
        blockId: block.blockId,
        kind: "pdf-page",
        start: block.start,
        end: block.end,
        page: block.page,
      })),
      "the stored block map (incl. page) matches the frozen truth",
    );
    assert.deepEqual(
      full.blocks.map((entry) => entry.text),
      PDF_01.blocks.map((block) => block.text),
      "block text slices match the frozen truth",
    );

    /* 分页游标：按页块推进。 */
    const page1 = studio.materials.readVersionBlocks(tree.id, result.material.id, result.version.id, { limit: 1 });
    assert.deepEqual(page1.blocks.map((entry) => entry.block.blockId), ["page-1"]);
    assert.equal(page1.nextAfterBlock, "page-1");
    const page2 = studio.materials.readVersionBlocks(tree.id, result.material.id, result.version.id, {
      afterBlock: "page-1",
      limit: 1,
    });
    assert.deepEqual(page2.blocks.map((entry) => entry.block.blockId), ["page-2"]);
    assert.equal(page2.nextAfterBlock, null);

    /* 树内同字节复用（不同文件名）：零新行、零新任务。 */
    const reimport = await studio.materials.importMaterial(tree.id, {
      filename: "renamed copy.pdf",
      bytes: b1Bytes("pdf/pdf-01.pdf"),
    });
    assert.equal(reimport.created, false);
    assert.equal(reimport.material.id, result.material.id);
    assert.equal(reimport.version.id, result.version.id);
    assert.equal(reimport.parseTaskId, null);
    assert.equal(studio.materialRepository.listVersions(result.material.id).length, 1);

    const task = studio.materials.getParseTask(result.parseTaskId!)!;
    assert.equal(task.parserKind, "pdf");
    assert.equal(task.parserVersion, "d4-pdf-v1");
    assert.equal(task.state, "ready");
  } finally {
    await studio.shutdown();
    cleanupDir(dir);
  }
});

test("pdf negative: the corrupt fixture fails the version with the frozen reason; reads are material-not-ready", async () => {
  const dir = makeTempDataDir();
  const studio = makeStudioInstance(dir);
  try {
    const { tree } = studio.service.createTree();
    const result = await studio.materials.importMaterial(tree.id, {
      filename: "broken.pdf",
      bytes: b1Bytes("negative/neg-pdf-corrupt.pdf"),
    });
    await until(
      () => studio.materials.getMaterialDetail(tree.id, result.material.id).versions[0]!.parseStatus === "failed",
      "the corrupt pdf version to fail",
    );
    const version = studio.materials.getMaterialDetail(tree.id, result.material.id).versions[0]!;
    assert.match(version.parseError!, /^corrupt:/);
    assert.equal(version.textUnits, 0, "no canonical text is stored for a rejected document");
    assert.throws(
      () => studio.materials.readVersionBlocks(tree.id, result.material.id, result.version.id, {}),
      (error: unknown) => error instanceof MaterialNotReadyError && error.parseStatus === "failed",
    );
  } finally {
    await studio.shutdown();
    cleanupDir(dir);
  }
});

test("pdf pages limit: an injected maxPages rejects pdf-08 (10 pages) with pages-exceeded before extracting", async () => {
  const dir = makeTempDataDir();
  const studio = makeStudioInstance(dir, { materialImport: { limits: { maxPages: 5 } } });
  try {
    const { tree } = studio.service.createTree();
    const result = await studio.materials.importMaterial(tree.id, {
      filename: "算法学习手记.pdf",
      bytes: b1Bytes("pdf/pdf-08.pdf"),
    });
    await until(
      () => studio.materials.getMaterialDetail(tree.id, result.material.id).versions[0]!.parseStatus === "failed",
      "the over-page pdf version to fail",
    );
    const version = studio.materials.getMaterialDetail(tree.id, result.material.id).versions[0]!;
    assert.match(version.parseError!, /^pages-exceeded:/);
    assert.ok(version.parseError!.includes("10 pages"), "the reason names the actual page count");
    assert.equal(version.textUnits, 0, "the over-limit text is never persisted");
  } finally {
    await studio.shutdown();
    cleanupDir(dir);
  }
});

test("custom registry omitting the pdf kind: .pdf import is honestly rejected as not wired, zero persistence", async () => {
  const dir = makeTempDataDir();
  const studio = makeStudioInstance(dir, { materialImport: { parsers: { markdown: D4_MD_V1_PARSER } } });
  try {
    const { tree } = studio.service.createTree();
    await assert.rejects(
      () => studio.materials.importMaterial(tree.id, { filename: "paper.pdf", bytes: utf8("%PDF-1.7") }),
      (error: unknown) =>
        error instanceof MaterialUnsupportedError && error.message.includes("pdf") && error.message.includes("not wired"),
    );
    assert.throws(() => studio.materials.precheckImport(tree.id, "paper.pdf"), MaterialUnsupportedError);
    /* markdown 槽位照常可用（自定义注册表不整体失效）。 */
    assert.deepEqual(studio.materials.precheckImport(tree.id, "notes.md"), {
      parserKind: "markdown",
      parserVersion: "d4-md-v1",
    });
    assert.deepEqual(studio.materials.listTreeMaterials(tree.id), [], "the rejection persists nothing");
  } finally {
    await studio.shutdown();
    cleanupDir(dir);
  }
});

test("canonical text over the limit: version fails with text-units-exceeded; the oversized text is never stored", async () => {
  const dir = makeTempDataDir();
  const studio = makeStudioInstance(dir, { materialImport: { limits: { maxTextUnits: 5 } } });
  try {
    const { tree } = studio.service.createTree();
    const result = await studio.materials.importMaterial(tree.id, {
      filename: "long.md",
      bytes: utf8(THREE_BLOCKS), // 18 units > 5-unit injected limit
    });
    await until(
      () => studio.materials.getMaterialDetail(tree.id, result.material.id).versions[0]!.parseStatus === "failed",
      "the over-limit version to fail",
    );
    const version = studio.materials.getMaterialDetail(tree.id, result.material.id).versions[0]!;
    assert.match(version.parseError!, /^text-units-exceeded:/);
    assert.equal(version.textUnits, 0, "the oversized canonical text is not persisted");
    assert.throws(
      () => studio.materials.readVersionBlocks(tree.id, result.material.id, result.version.id, {}),
      MaterialNotReadyError,
    );
  } finally {
    await studio.shutdown();
    cleanupDir(dir);
  }
});

test("parse cancellation with a gated fake parser: canceled stays canceled; the late result is discarded, never attached", async () => {
  const dir = makeTempDataDir();
  const gated = new GatedParser();
  const studio = makeStudioInstance(dir, { materialImport: { parsers: { markdown: gated } } });
  try {
    const { tree } = studio.service.createTree();
    const result = await studio.materials.importMaterial(tree.id, {
      filename: "gated.md",
      bytes: utf8("gated bytes"),
    });
    const taskId = result.parseTaskId!;
    await until(() => studio.materials.getParseTask(taskId)?.state === "parsing", "the task to enter parsing");

    /* 取消在途任务 → canceled。 */
    const canceled = studio.materials.cancelParseTask(taskId);
    assert.equal(canceled.state, "canceled");
    assert.equal(
      studio.materials.getMaterialDetail(tree.id, result.material.id).versions[0]!.parseStatus,
      "canceled",
    );

    /* 放行门控：迟到结果到达并被丢弃——状态保持 canceled，无 ready 版本。 */
    gated.release();
    await until(() => studio.materials.getParseTask(taskId)?.lateResultDiscarded === true, "the late result to be discarded");
    const detail = studio.materials.getMaterialDetail(tree.id, result.material.id);
    assert.equal(detail.versions[0]!.parseStatus, "canceled", "the canceled state is never resurrected");
    assert.equal(detail.versions[0]!.textUnits, 0, "no canonical text is attached after the cancel");
    assert.equal(detail.versions.length, 1, "no ready version appears");
    assert.equal(studio.materials.lateResultsDiscarded, 1);
    assert.throws(
      () => studio.materials.readVersionBlocks(tree.id, result.material.id, result.version.id, {}),
      (error: unknown) => error instanceof MaterialNotReadyError && error.parseStatus === "canceled",
    );

    /* 终态任务不可再取消（409 语义）；未知任务 404 语义。 */
    assert.throws(() => studio.materials.cancelParseTask(taskId), ParseTaskNotCancelableError);
    assert.throws(() => studio.materials.cancelParseTask("mat-task-missing"), EntityNotFoundError);
  } finally {
    await studio.shutdown();
    cleanupDir(dir);
  }
});

test("host interruption recovery: a version left parsing converges to failed (parse-interrupted) on the next construction", async () => {
  const dir = makeTempDataDir();
  const gated = new GatedParser(); // 永不放行：模拟进程在解析中途退出
  const first = makeStudioInstance(dir, { materialImport: { parsers: { markdown: gated } } });
  const { tree } = first.service.createTree();
  const result = await first.materials.importMaterial(tree.id, {
    filename: "stuck.md",
    bytes: utf8("stuck bytes"),
  });
  assert.equal(
    first.materials.getMaterialDetail(tree.id, result.material.id).versions[0]!.parseStatus,
    "parsing",
  );
  await first.shutdown();

  const second = makeStudioInstance(dir); // 同一数据目录上的新实例（= 重启）
  try {
    const version = second.materials.getMaterialDetail(tree.id, result.material.id).versions[0]!;
    assert.equal(version.parseStatus, "failed");
    assert.match(version.parseError!, /^parse-interrupted:/);
  } finally {
    await second.shutdown();
    cleanupDir(dir);
  }
});

test("honest rejections before any persistence: unknown extension, empty input, unknown tree", async () => {
  const dir = makeTempDataDir();
  const studio = makeStudioInstance(dir);
  try {
    const { tree } = studio.service.createTree();
    const assertEmpty = (): void => {
      assert.deepEqual(studio.materials.listTreeMaterials(tree.id), []);
    };

    /* 未知扩展名 → material-unsupported（指明扩展名）。importMaterial 为
       async——拒绝断言用 rejects。 */
    await assert.rejects(
      () => studio.materials.importMaterial(tree.id, { filename: "notes.docx", bytes: utf8("x") }),
      (error: unknown) =>
        error instanceof MaterialUnsupportedError && error.message.includes(".docx") && error.message.includes("markdown"),
    );

    /* 空文件名 / 空字节 → 400 语义。 */
    await assert.rejects(
      () => studio.materials.importMaterial(tree.id, { filename: "", bytes: utf8("x") }),
      InvalidArgumentError,
    );
    await assert.rejects(
      () => studio.materials.importMaterial(tree.id, { filename: "a.md", bytes: new Uint8Array(0) }),
      InvalidArgumentError,
    );

    /* 未知树 → 404 语义。 */
    await assert.rejects(
      () => studio.materials.importMaterial("tree-missing" as TreeId, { filename: "a.md", bytes: utf8("x") }),
      EntityNotFoundError,
    );

    /* 预检面与导入面同口径；.pdf 在默认注册表已装配（415 只留给缺位种类，
       见自定义注册表用例）。 */
    assert.throws(() => studio.materials.precheckImport(tree.id, "a.docx"), MaterialUnsupportedError);
    assert.deepEqual(studio.materials.precheckImport(tree.id, "a.MARKDOWN"), {
      parserKind: "markdown",
      parserVersion: "d4-md-v1",
    });
    assert.deepEqual(studio.materials.precheckImport(tree.id, "a.pdf"), {
      parserKind: "pdf",
      parserVersion: "d4-pdf-v1",
    });

    /* 上述拒绝全部零持久化。 */
    assertEmpty();
    assert.throws(
      () => studio.materials.getMaterialDetail(tree.id, "material-missing" as MaterialId),
      EntityNotFoundError,
    );
  } finally {
    await studio.shutdown();
    cleanupDir(dir);
  }
});
