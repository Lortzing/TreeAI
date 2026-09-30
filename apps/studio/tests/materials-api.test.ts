/**
 * D4-1 材料导入 HTTP API 测试（issue #8 工作包 D4-1；真实 node:http 服务 +
 * fetch + 离线 echo 驱动；D4 契约 §3）。
 *
 * 覆盖：
 * - 导入 happy path：原始字节 body + x-treeai-filename（UTF-8 百分号编码，
 *   空格/CJK 解码）；201 {material, version, parseTaskId}；就绪轮询；列表/
 *   详情读模型；分块读取分页（afterBlock/limit/nextAfterBlock/textUnits）；
 * - 版本语义：同字节重导 200（同 versionId，零新行）；新字节 201 + 版本链
 *   （旧版本仍可读）；versions 端点同语义；
 * - 拒绝面：413 material-too-large（小限额注入、读体即拒、零持久化）；
 *   415 material-unsupported（未知扩展名；.pdf 集成前诚实说明）；404 未知
 *   树/材料/版本；400 缺文件名头/坏百分号编码/坏查询参数；503 未装配；
 * - 解析失败诚实面：invalid-utf8 → 版本 failed（原因码入 parseError），
 *   分块读取 409 material-not-ready（绝不伪装空成功文档）；
 * - 取消（受控门控假解析器，经 HTTP 注入）：mid-parse 取消 200 → canceled；
 *   迟到结果到达后状态保持 canceled（不复活、无 ready 版本）；终态再取消
 *   409；未知任务 404；
 * - 阅读位置：PUT 204（无 body）+ 详情读取回读；校验失败 400。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import type { MaterialBlock, MaterialId } from "@treeai/contracts";
import { createStudioServer } from "../src/server.ts";
import type { MaterialParser, MaterialParserOutcome } from "../src/materials/import-service.ts";
import {
  cleanupDir,
  makeStudioInstance,
  makeTempDataDir,
  type StudioInstance,
  type StudioInstanceOptions,
} from "./helpers.ts";

const staticDir = fileURLToPath(new URL("../public/", import.meta.url));
const ENCODER = new TextEncoder();

function utf8(text: string): Uint8Array {
  return ENCODER.encode(text);
}

interface JsonOutcome {
  status: number;
  body: any;
}

async function readOutcome(response: Response): Promise<JsonOutcome> {
  let parsed: any = null;
  try {
    parsed = await response.json();
  } catch {
    /* 204 等无 body 响应 */
  }
  return { status: response.status, body: parsed };
}

async function call(url: string, method: string, body?: unknown): Promise<JsonOutcome> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return readOutcome(response);
}

/** 材料导入 POST：原始字节 body + x-treeai-filename（UTF-8 百分号编码）。 */
async function upload(
  url: string,
  filename: string,
  bytes?: Uint8Array,
  options?: { readonly rawFilenameHeader?: string },
): Promise<JsonOutcome> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "x-treeai-filename": options?.rawFilenameHeader ?? encodeURIComponent(filename) },
    ...(bytes === undefined ? {} : { body: bytes }),
  });
  return readOutcome(response);
}

interface RunningStudio {
  port: number;
  /** 底层实例（材料仓储直读 SQLite，用于持久化断言）。 */
  instance: StudioInstance;
  url(path: string): string;
  close(): Promise<void>;
}

async function startStudio(
  dir: string,
  registry: RunningStudio[],
  options?: StudioInstanceOptions,
  wireMaterials = true,
): Promise<RunningStudio> {
  const studio = makeStudioInstance(dir, options);
  const server = createStudioServer({
    service: studio.service,
    staticDir,
    ...(wireMaterials ? { materials: studio.materials } : {}),
  });
  const port = await server.listen(0);
  let closed = false;
  const running: RunningStudio = {
    port,
    instance: studio,
    url: (path: string) => `http://127.0.0.1:${port}${path}`,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await server.close();
      await studio.shutdown();
    },
  };
  registry.push(running);
  return running;
}

async function closeAll(registry: RunningStudio[]): Promise<void> {
  for (const running of registry) {
    try {
      await running.close();
    } catch {
      /* 关闭失败不掩盖测试断言失败 */
    }
  }
}

async function until(predicate: () => Promise<boolean> | boolean, what: string, attempts = 200): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** 三块 markdown（blk-0 "One\n\n" / blk-1 "Two\n\n" / blk-2 "Three"，18 units）。 */
const THREE_BLOCKS = "One\n\nTwo\n\nThree";

/** 受控门控假解析器（HTTP 注入）：parse() 挂起直到 release()。 */
class GatedParser implements MaterialParser {
  readonly kind = "markdown" as const;
  readonly parserVersion = "fake-gated-v1";
  #release: (() => void) | null = null;
  readonly #promise: Promise<MaterialParserOutcome>;

  constructor() {
    this.#promise = new Promise<MaterialParserOutcome>((resolve) => {
      this.#release = () =>
        resolve({
          ok: true,
          canonicalText: "Late\n\nresult",
          blocks: [
            { blockId: "blk-0", kind: "markdown-block", start: 0, end: 6 },
            { blockId: "blk-1", kind: "markdown-block", start: 6, end: 12 },
          ] satisfies MaterialBlock[],
        });
    });
  }

  parse(): Promise<MaterialParserOutcome> {
    return this.#promise;
  }

  release(): void {
    this.#release?.();
  }
}

function materialPath(treeId: string, materialId?: string): string {
  return `/api/trees/${encodeURIComponent(treeId)}/materials${materialId === undefined ? "" : `/${encodeURIComponent(materialId)}`}`;
}

async function createTree(studio: RunningStudio): Promise<string> {
  const created = await call(studio.url("/api/trees"), "POST", {});
  assert.equal(created.status, 201);
  return created.body.tree.id as string;
}

/** 等待材料首个版本到达预期状态（解析为近即时微任务）。 */
async function waitVersionStatus(
  studio: RunningStudio,
  treeId: string,
  materialId: string,
  status: string,
): Promise<any> {
  let version: any = null;
  await until(async () => {
    const detail = await call(studio.url(materialPath(treeId, materialId)), "GET");
    assert.equal(detail.status, 200);
    version = detail.body.versions[0];
    return version !== undefined && version.parseStatus === status;
  }, `the first version to become ${status}`);
  return version;
}

test("material import over HTTP: 201 upload, filename decoding (spaces/CJK), ready polling, chunked pagination", async () => {
  const dir = makeTempDataDir();
  const running: RunningStudio[] = [];
  try {
    const studio = await startStudio(dir, running);
    const treeId = await createTree(studio);

    /* 百分号编码的 CJK+空格文件名 → 解码为标题（文件名是显示名，不是身份）。 */
    const imported = await upload(
      studio.url(materialPath(treeId)),
      "材料 笔记 v1.md",
      utf8(THREE_BLOCKS),
    );
    assert.equal(imported.status, 201);
    assert.equal(imported.body.created, true);
    assert.equal(imported.body.material.title, "材料 笔记 v1.md");
    assert.equal(imported.body.version.parseStatus, "parsing");
    assert.equal(typeof imported.body.parseTaskId, "string");
    const materialId: string = imported.body.material.id;
    const versionId: string = imported.body.version.id;

    const version = await waitVersionStatus(studio, treeId, materialId, "ready");
    assert.equal(version.parserKind, "markdown");
    assert.equal(version.parserVersion, "d4-md-v1");
    assert.equal(version.textUnits, THREE_BLOCKS.length);

    /* 列表读模型（含各版本与状态）。 */
    const list = await call(studio.url(materialPath(treeId)), "GET");
    assert.equal(list.status, 200);
    assert.equal(list.body.materials.length, 1);
    assert.equal(list.body.materials[0].material.id, materialId);
    assert.equal(list.body.materials[0].versions[0].parseStatus, "ready");

    /* 详情：版本链 + 阅读位置（空态 null）+ 近期解析任务投影。 */
    const detail = await call(studio.url(materialPath(treeId, materialId)), "GET");
    assert.equal(detail.status, 200);
    assert.equal(detail.body.readingPosition, null);
    assert.equal(detail.body.parseTasks.length, 1);
    assert.equal(detail.body.parseTasks[0].state, "ready");

    /* 分块读取：整读 + 分页（afterBlock 游标推进，读尽 nextAfterBlock=null）。 */
    const versionPath = `${materialPath(treeId, materialId)}/versions/${encodeURIComponent(versionId)}`;
    const full = await call(`${studio.url(versionPath)}`, "GET");
    assert.equal(full.status, 200);
    assert.equal(full.body.textUnits, THREE_BLOCKS.length);
    assert.equal(full.body.nextAfterBlock, null);
    assert.deepEqual(full.body.blocks.map((b: any) => b.text), ["One\n\n", "Two\n\n", "Three"]);

    const page1 = await call(`${studio.url(versionPath)}?limit=2`, "GET");
    assert.deepEqual(page1.body.blocks.map((b: any) => b.block.blockId), ["blk-0", "blk-1"]);
    assert.equal(page1.body.nextAfterBlock, "blk-1");
    const page2 = await call(`${studio.url(versionPath)}?afterBlock=blk-1&limit=2`, "GET");
    assert.deepEqual(page2.body.blocks.map((b: any) => b.block.blockId), ["blk-2"]);
    assert.equal(page2.body.nextAfterBlock, null);
    assert.equal(page2.body.blocks[0].text, "Three");

    /* 查询参数校验：未知游标 / 越界或非整数 limit → 400。 */
    assert.equal((await call(`${studio.url(versionPath)}?afterBlock=blk-9`, "GET")).status, 400);
    assert.equal((await call(`${studio.url(versionPath)}?limit=0`, "GET")).status, 400);
    assert.equal((await call(`${studio.url(versionPath)}?limit=501`, "GET")).status, 400);
    assert.equal((await call(`${studio.url(versionPath)}?limit=abc`, "GET")).status, 400);

    /* 空格文件名的两种传递（百分号编码与原始空格）解码一致。 */
    const spaced = await upload(
      studio.url(materialPath(treeId)),
      "ignored",
      utf8("Spaced\n\ncontent"),
      { rawFilenameHeader: "my notes.md" },
    );
    assert.equal(spaced.status, 201);
    assert.equal(spaced.body.material.title, "my notes.md");
  } finally {
    await closeAll(running);
    cleanupDir(dir);
  }
});

test("same-bytes re-import → 200 + same versionId with no duplicate rows; new bytes → 201 + version chain with the old version readable", async () => {
  const dir = makeTempDataDir();
  const running: RunningStudio[] = [];
  try {
    const studio = await startStudio(dir, running);
    const treeId = await createTree(studio);

    const first = await upload(studio.url(materialPath(treeId)), "report.md", utf8(THREE_BLOCKS));
    assert.equal(first.status, 201);
    const materialId: string = first.body.material.id;
    const version1: string = first.body.version.id;
    await waitVersionStatus(studio, treeId, materialId, "ready");

    /* 同字节重导（不同文件名也复用）→ 200，同 material/version，零新行。 */
    const reimport = await upload(studio.url(materialPath(treeId)), "renamed.md", utf8(THREE_BLOCKS));
    assert.equal(reimport.status, 200);
    assert.equal(reimport.body.created, false);
    assert.equal(reimport.body.material.id, materialId);
    assert.equal(reimport.body.version.id, version1);
    assert.equal(reimport.body.parseTaskId, null);
    const listAfter = await call(studio.url(materialPath(treeId)), "GET");
    assert.equal(listAfter.body.materials.length, 1, "no duplicate material row");
    assert.equal(
      studio.instance.materialRepository.listVersions(materialId as MaterialId).length,
      1,
      "no duplicate version row",
    );

    /* 新字节 → 201 新版本；版本链含两版，旧版本仍可读。 */
    const second = await upload(
      `${studio.url(materialPath(treeId, materialId))}/versions`,
      "report.md",
      utf8("Revised\n\ncontent"),
    );
    assert.equal(second.status, 201);
    const version2: string = second.body.version.id;
    assert.notEqual(version2, version1);
    const detail = await call(studio.url(materialPath(treeId, materialId)), "GET");
    assert.deepEqual(detail.body.versions.map((v: any) => v.id), [version1, version2]);
    await until(
      async () =>
        (await call(studio.url(materialPath(treeId, materialId)), "GET")).body.versions[1].parseStatus === "ready",
      "the new version to become ready",
    );

    const oldPage = await call(
      `${studio.url(materialPath(treeId, materialId))}/versions/${encodeURIComponent(version1)}`,
      "GET",
    );
    assert.equal(oldPage.status, 200);
    assert.equal(oldPage.body.textUnits, THREE_BLOCKS.length, "the old version stays readable and unchanged");

    /* versions 端点同字节（v1 的字节）→ 200 复用 v1。 */
    const replay = await upload(
      `${studio.url(materialPath(treeId, materialId))}/versions`,
      "report.md",
      utf8(THREE_BLOCKS),
    );
    assert.equal(replay.status, 200);
    assert.equal(replay.body.version.id, version1);
    assert.equal(studio.instance.materialRepository.listVersions(materialId as MaterialId).length, 2);
  } finally {
    await closeAll(running);
    cleanupDir(dir);
  }
});

test("rejection surface: 413 oversize, 415 unsupported extension and pending pdf, 404/400, 503 when not wired", async () => {
  const dir = makeTempDataDir();
  const running: RunningStudio[] = [];
  try {
    /* 小限额注入（冻结缺省 20 MiB 由服务级测试锁定）。 */
    const studio = await startStudio(dir, running, { materialImport: { limits: { maxFileBytes: 64 } } });
    const treeId = await createTree(studio);

    /* 超限：读体即拒（413 material-too-large），零持久化。 */
    const oversize = await upload(studio.url(materialPath(treeId)), "big.md", utf8("x".repeat(100)));
    assert.equal(oversize.status, 413);
    assert.equal(oversize.body.error.code, "material-too-large");
    assert.ok(oversize.body.error.message.includes("100"));
    assert.equal((await call(studio.url(materialPath(treeId)), "GET")).body.materials.length, 0);

    /* 未知扩展名 → 415（消息指明扩展名与支持集合）。 */
    const docx = await upload(studio.url(materialPath(treeId)), "notes.docx", utf8("x"));
    assert.equal(docx.status, 415);
    assert.equal(docx.body.error.code, "material-unsupported");
    assert.ok(docx.body.error.message.includes(".docx"));

    /* .pdf：D4-1 集成前的诚实拒绝（绝不伪成功）。 */
    const pdf = await upload(studio.url(materialPath(treeId)), "paper.pdf", utf8("%PDF-1.7 fake"));
    assert.equal(pdf.status, 415);
    assert.equal(pdf.body.error.code, "material-unsupported");
    assert.ok(
      pdf.body.error.message.includes("pdf parser lands with D4-1 integration"),
      "the honest pending-integration detail is carried",
    );

    /* 缺文件名头 / 坏百分号编码 → 400。 */
    const noHeader = await fetch(studio.url(materialPath(treeId)), { method: "POST" });
    assert.equal((await readOutcome(noHeader)).status, 400);
    const badEncoding = await upload(studio.url(materialPath(treeId)), "ignored", undefined, {
      rawFilenameHeader: "%zz.md",
    });
    assert.equal(badEncoding.status, 400);

    /* 未知树 → 404；未知材料/版本 → 404；空体 .md → 400。 */
    assert.equal((await upload(studio.url(materialPath("tree-missing")), "a.md", utf8("x"))).status, 404);
    assert.equal((await call(studio.url(materialPath(treeId, "material-missing")), "GET")).status, 404);
    assert.equal(
      (
        await call(
          `${studio.url(materialPath(treeId, "material-missing"))}/versions/matver-x`,
          "GET",
        )
      ).status,
      404,
    );
    const emptyBody = await upload(studio.url(materialPath(treeId)), "empty.md", new Uint8Array(0));
    assert.equal(emptyBody.status, 400);

    /* 方法不支持 → 405。 */
    assert.equal((await call(studio.url(materialPath(treeId)), "PUT", {})).status, 405);

    /* 拒绝全部零持久化。 */
    assert.equal((await call(studio.url(materialPath(treeId)), "GET")).body.materials.length, 0);

    /* 未装配材料服务的进程：503 如实说明（绝不伪装成功）。 */
    const bare = await startStudio(dir, running, undefined, false);
    const bareTree = await createTree(bare);
    const notWired = await fetch(bare.url(materialPath(bareTree)), { method: "POST" });
    const notWiredOutcome = await readOutcome(notWired);
    assert.equal(notWiredOutcome.status, 503);
    assert.equal(notWiredOutcome.body.error.code, "materials-not-wired");
    assert.equal((await call(bare.url(materialPath(bareTree)), "GET")).status, 503);
  } finally {
    await closeAll(running);
    cleanupDir(dir);
  }
});

test("honest parse failure: invalid UTF-8 markdown fails the version with the reason; reads are 409 material-not-ready", async () => {
  const dir = makeTempDataDir();
  const running: RunningStudio[] = [];
  try {
    const studio = await startStudio(dir, running);
    const treeId = await createTree(studio);

    const imported = await upload(studio.url(materialPath(treeId)), "broken.md", new Uint8Array([0xff, 0xfe, 0x41]));
    assert.equal(imported.status, 201);
    const materialId: string = imported.body.material.id;

    const version = await waitVersionStatus(studio, treeId, materialId, "failed");
    assert.match(version.parseError, /^invalid-utf8:/);
    assert.equal(version.textUnits, 0);

    const read = await call(
      `${studio.url(materialPath(treeId, materialId))}/versions/${encodeURIComponent(imported.body.version.id)}`,
      "GET",
    );
    assert.equal(read.status, 409);
    assert.equal(read.body.error.code, "material-not-ready");
    assert.ok(read.body.error.message.includes("invalid-utf8"), "the failure reason is carried, not hidden behind an empty success");
  } finally {
    await closeAll(running);
    cleanupDir(dir);
  }
});

test("parse cancellation over HTTP: mid-parse cancel with a gated fake parser; the late result never resurrects the canceled state", async () => {
  const dir = makeTempDataDir();
  const running: RunningStudio[] = [];
  try {
    /* 受控门控假解析器经 helpers 注入（HTTP 面与真实装配同一路径）。 */
    const gated = new GatedParser();
    const studio = await startStudio(dir, running, { materialImport: { parsers: { markdown: gated } } });
    const treeId = await createTree(studio);

    const imported = await upload(studio.url(materialPath(treeId)), "gated.md", utf8("gated bytes"));
    assert.equal(imported.status, 201);
    const materialId: string = imported.body.material.id;
    const versionId: string = imported.body.version.id;
    const taskId: string = imported.body.parseTaskId;
    const cancelPath = `${materialPath(treeId, materialId)}/parse-tasks/${encodeURIComponent(taskId)}/cancel`;

    /* 等任务进入 parsing（门控解析器会停在那里）。 */
    await until(
      async () => (await call(studio.url(materialPath(treeId, materialId)), "GET")).body.parseTasks[0]?.state === "parsing",
      "the parse task to enter parsing",
    );

    /* 取消在途任务 → 200 canceled。 */
    const canceled = await call(studio.url(cancelPath), "POST");
    assert.equal(canceled.status, 200);
    assert.equal(canceled.body.task.state, "canceled");

    const detailAfterCancel = await call(studio.url(materialPath(treeId, materialId)), "GET");
    assert.equal(detailAfterCancel.body.versions[0].parseStatus, "canceled");

    /* 放行迟到结果：状态保持 canceled，无 ready 版本，迟到丢弃如实可见。 */
    gated.release();
    await until(
      async () =>
        (await call(studio.url(materialPath(treeId, materialId)), "GET")).body.parseTasks[0]?.lateResultDiscarded ===
        true,
      "the late result to be discarded",
    );
    const detailLate = await call(studio.url(materialPath(treeId, materialId)), "GET");
    assert.equal(detailLate.body.versions[0].parseStatus, "canceled", "the canceled state is never resurrected");
    assert.equal(detailLate.body.versions[0].textUnits, 0, "no canonical text is attached");
    assert.equal(detailLate.body.versions.length, 1, "no ready version appears");

    /* 取消后的版本读取 → 409 material-not-ready。 */
    const read = await call(
      `${studio.url(materialPath(treeId, materialId))}/versions/${encodeURIComponent(versionId)}`,
      "GET",
    );
    assert.equal(read.status, 409);
    assert.equal(read.body.error.code, "material-not-ready");

    /* 终态任务再取消 → 409；未知任务 → 404；未知材料下的取消 → 404。 */
    assert.equal((await call(studio.url(cancelPath), "POST")).status, 409);
    assert.equal(
      (await call(studio.url(cancelPath), "POST")).body.error.code,
      "parse-task-not-cancelable",
    );
    const unknownTask = await call(
      `${studio.url(materialPath(treeId, materialId))}/parse-tasks/mat-task-missing/cancel`,
      "POST",
    );
    assert.equal(unknownTask.status, 404);
    assert.equal(
      (
        await call(
          `${studio.url(materialPath(treeId, "material-missing"))}/parse-tasks/${encodeURIComponent(taskId)}/cancel`,
          "POST",
        )
      ).status,
      404,
    );
  } finally {
    await closeAll(running);
    cleanupDir(dir);
  }
});

test("reading position: PUT 204 upsert + detail read-back; validation failures are 400/404", async () => {
  const dir = makeTempDataDir();
  const running: RunningStudio[] = [];
  try {
    const studio = await startStudio(dir, running);
    const treeId = await createTree(studio);
    const imported = await upload(studio.url(materialPath(treeId)), "reader.md", utf8(THREE_BLOCKS));
    const materialId: string = imported.body.material.id;
    const versionId: string = imported.body.version.id;
    await waitVersionStatus(studio, treeId, materialId, "ready");
    const positionPath = `${materialPath(treeId, materialId)}/reading-position`;

    /* PUT → 204 无 body。 */
    const put = await fetch(studio.url(positionPath), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ versionId, blockId: "blk-1", focusStart: 7 }), // blk-1 = [6, 12)
    });
    assert.equal(put.status, 204);
    assert.equal(await put.text(), "");

    const detail = await call(studio.url(materialPath(treeId, materialId)), "GET");
    assert.equal(detail.body.readingPosition.blockId, "blk-1");
    assert.equal(detail.body.readingPosition.focusStart, 7);
    assert.equal(detail.body.readingPosition.versionId, versionId);

    /* UPSERT 整体替换：blockId 清空（未开始）。 */
    const putReset = await fetch(studio.url(positionPath), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ versionId, blockId: null }),
    });
    assert.equal(putReset.status, 204);
    const detailReset = await call(studio.url(materialPath(treeId, materialId)), "GET");
    assert.equal(detailReset.body.readingPosition.blockId, null);
    assert.equal(detailReset.body.readingPosition.focusStart, null);

    /* 校验失败：未知块 / focusStart 无 blockId / 未知版本 / 非 JSON → 400（未知树 404）。 */
    assert.equal(
      (await call(studio.url(positionPath), "PUT", { versionId, blockId: "blk-9" })).status,
      400,
    );
    assert.equal((await call(studio.url(positionPath), "PUT", { versionId, focusStart: 2 })).status, 400);
    assert.equal(
      (await call(studio.url(positionPath), "PUT", { versionId: "matver-missing", blockId: "blk-0" })).status,
      404,
    );
    const badBody = await fetch(studio.url(positionPath), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    assert.equal(badBody.status, 400);
    assert.equal(
      (
        await call(
          `${studio.url(materialPath(treeId, "material-missing"))}/reading-position`,
          "PUT",
          { versionId, blockId: "blk-0" },
        )
      ).status,
      404,
    );
    assert.equal((await call(studio.url(positionPath), "GET")).status, 405);
  } finally {
    await closeAll(running);
    cleanupDir(dir);
  }
});
