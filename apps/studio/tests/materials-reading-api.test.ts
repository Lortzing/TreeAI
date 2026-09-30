/**
 * D4-2 材料阅读与来源定位 HTTP API 测试（issue #8 工作包 D4-2；真实
 * node:http 服务 + fetch + 离线 echo 驱动；charter §3.2 / 契约 §3）。
 *
 * 覆盖（D4-2 新端点；导入/分块读取/解析取消见 materials-api.test.ts）：
 * - 阅读位置 GET：空态 {readingPosition: null}；PUT 后回读；UPSERT 整体
 *   替换；404 未知树/材料；405 非 GET/PUT；503 未装配；
 * - 阅读位置按 Tree×材料隔离：同一材料链接两树各自保留位置；同树两材料
 *   各自保留位置；探索活动（prompt）不覆盖阅读位置，写阅读位置不产生
 *   分支/Turn（charter §3.2「原文阅读与分支探索各自保留位置」）；
 * - resolve-selection：200 {selection, block}（text-occurrence 与
 *   utf16-range 两种 locator；sourceHash === canonicalText SHA-256）；
 *   区间纪律拒绝 → 400 + 稳定原因码（out-of-bounds/zero-length/
 *   surrogate-split/cross-block/block-mismatch/excerpt-mismatch/
 *   needle-not-found/invalid-locator）；stale-version → 400；非 ready
 *   版本 → 409 material-not-ready；404 未知树/材料/版本；400 版本属他
 *   材料；405；503 未装配。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { MaterialId, TreeId } from "@treeai/contracts";
import { createStudioServer } from "../src/server.ts";
import {
  cleanupDir,
  makeStudioInstance,
  makeTempDataDir,
  type StudioInstance,
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
async function upload(url: string, filename: string, bytes?: Uint8Array): Promise<JsonOutcome> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "x-treeai-filename": encodeURIComponent(filename) },
    ...(bytes === undefined ? {} : { body: bytes }),
  });
  return readOutcome(response);
}

interface RunningStudio {
  port: number;
  instance: StudioInstance;
  url(path: string): string;
  close(): Promise<void>;
}

async function startStudio(dir: string, registry: RunningStudio[], wireMaterials = true): Promise<RunningStudio> {
  const studio = makeStudioInstance(dir);
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

/** 三块 markdown（blk-0 "One\n\n" [0,5) / blk-1 "Two\n\n" [5,10) / blk-2 "Three" [10,15)，15 units）。 */
const THREE_BLOCKS = "One\n\nTwo\n\nThree";

/** emoji 版本（blk-0 = "🚀 flag\n\n"：🚀 占 [0,2)，" flag" [2,7)，"\n\n" [7,9)）。 */
const EMOJI_BLOCKS = "🚀 flag\n\nbody";

function materialPath(treeId: string, materialId?: string): string {
  return `/api/trees/${encodeURIComponent(treeId)}/materials${materialId === undefined ? "" : `/${encodeURIComponent(materialId)}`}`;
}

async function createTree(studio: RunningStudio): Promise<{ treeId: string; trunkBranchId: string }> {
  const created = await call(studio.url("/api/trees"), "POST", {});
  assert.equal(created.status, 201);
  return { treeId: created.body.tree.id as string, trunkBranchId: created.body.trunkBranchId as string };
}

async function importReady(
  studio: RunningStudio,
  treeId: string,
  filename: string,
  bytes: Uint8Array,
): Promise<{ materialId: string; versionId: string }> {
  const imported = await upload(studio.url(materialPath(treeId)), filename, bytes);
  assert.equal(imported.status, 201);
  const materialId: string = imported.body.material.id;
  const versionId: string = imported.body.version.id;
  await until(
    async () => (await call(studio.url(materialPath(treeId, materialId)), "GET")).body.versions[0].parseStatus === "ready",
    `${filename} to become ready`,
  );
  return { materialId, versionId };
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

test("reading position GET: empty state, PUT round-trip, upsert replaces, 404/405/503 surfaces", async () => {
  const dir = makeTempDataDir();
  const running: RunningStudio[] = [];
  try {
    const studio = await startStudio(dir, running);
    const { treeId } = await createTree(studio);
    const imported = await importReady(studio, treeId, "reader.md", utf8(THREE_BLOCKS));
    const positionPath = `${materialPath(treeId, imported.materialId)}/reading-position`;

    /* 空态：{readingPosition: null}（不是 404——材料在，位置未写过）。 */
    const empty = await call(studio.url(positionPath), "GET");
    assert.equal(empty.status, 200);
    assert.equal(empty.body.readingPosition, null);

    /* PUT → 204 无 body；GET 回读。 */
    const put = await fetch(studio.url(positionPath), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ versionId: imported.versionId, blockId: "blk-1", focusStart: 7 }), // blk-1 = [5, 10)
    });
    assert.equal(put.status, 204);
    const afterPut = await call(studio.url(positionPath), "GET");
    assert.equal(afterPut.status, 200);
    assert.equal(afterPut.body.readingPosition.blockId, "blk-1");
    assert.equal(afterPut.body.readingPosition.focusStart, 7);
    assert.equal(afterPut.body.readingPosition.versionId, imported.versionId);
    assert.equal(typeof afterPut.body.readingPosition.updatedAt, "string");

    /* UPSERT 整体替换：归零（未开始）。 */
    await fetch(studio.url(positionPath), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ versionId: imported.versionId, blockId: null }),
    });
    const afterReset = await call(studio.url(positionPath), "GET");
    assert.equal(afterReset.body.readingPosition.blockId, null);
    assert.equal(afterReset.body.readingPosition.focusStart, null);

    /* 404 未知树/材料；405 非 GET/PUT。 */
    assert.equal((await call(studio.url(`${materialPath("tree-missing", imported.materialId)}/reading-position`), "GET")).status, 404);
    assert.equal((await call(studio.url(`${materialPath(treeId, "material-missing")}/reading-position`), "GET")).status, 404);
    assert.equal((await call(studio.url(positionPath), "POST", {})).status, 405);

    /* 未装配材料服务的进程：GET/PUT 均 503 如实说明。 */
    const bare = await startStudio(dir, running, false);
    const bareTree = await createTree(bare);
    assert.equal((await call(bare.url(`${materialPath(bareTree.treeId, "m")}/reading-position`), "GET")).status, 503);
    assert.equal((await call(bare.url(`${materialPath(bareTree.treeId, "m")}/reading-position`), "PUT", {})).status, 503);
  } finally {
    await closeAll(running);
    cleanupDir(dir);
  }
});

test("reading positions stay isolated per tree and per material; exploration never clobbers reading (charter §3.2)", async () => {
  const dir = makeTempDataDir();
  const running: RunningStudio[] = [];
  try {
    const studio = await startStudio(dir, running);
    const { treeId, trunkBranchId } = await createTree(studio);
    const first = await importReady(studio, treeId, "first.md", utf8(THREE_BLOCKS));
    const second = await importReady(studio, treeId, "second.md", utf8("Second\n\nmaterial"));

    /* 同树两材料：各自位置互不影响。 */
    await fetch(studio.url(`${materialPath(treeId, first.materialId)}/reading-position`), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ versionId: first.versionId, blockId: "blk-2" }),
    });
    await fetch(studio.url(`${materialPath(treeId, second.materialId)}/reading-position`), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ versionId: second.versionId, blockId: "blk-0", focusStart: 1 }),
    });
    const firstPosition = await call(studio.url(`${materialPath(treeId, first.materialId)}/reading-position`), "GET");
    const secondPosition = await call(studio.url(`${materialPath(treeId, second.materialId)}/reading-position`), "GET");
    assert.equal(firstPosition.body.readingPosition.blockId, "blk-2");
    assert.equal(secondPosition.body.readingPosition.blockId, "blk-0");

    /* 同一材料链接第二棵树：阅读位置按 Tree×材料隔离。 */
    const secondTree = await call(studio.url("/api/trees"), "POST", {});
    const treeB = secondTree.body.tree.id as string;
    studio.instance.materialRepository.linkTreeMaterial(treeB as TreeId, first.materialId as MaterialId);
    const treeBPosition = await call(studio.url(`${materialPath(treeB, first.materialId)}/reading-position`), "GET");
    assert.equal(treeBPosition.status, 200);
    assert.equal(treeBPosition.body.readingPosition, null, "tree B starts fresh: positions are per tree x material");

    /* 探索活动（trunk prompt）不覆盖阅读位置；写阅读位置不产生分支/Turn。 */
    const stateBefore = await call(studio.url(`/api/trees/${encodeURIComponent(treeId)}/state`), "GET");
    const branchCountBefore: number = stateBefore.body.branches.length;
    const prompt = await call(studio.url(`/api/trees/${encodeURIComponent(treeId)}/prompt`), "POST", {
      branchId: trunkBranchId,
      text: "exploring, not reading",
    });
    assert.equal(prompt.status, 200);
    const afterExploration = await call(studio.url(`${materialPath(treeId, first.materialId)}/reading-position`), "GET");
    assert.equal(afterExploration.body.readingPosition.blockId, "blk-2", "exploration keeps the reading position intact");
    const stateAfter = await call(studio.url(`/api/trees/${encodeURIComponent(treeId)}/state`), "GET");
    assert.equal(stateAfter.body.branches.length, branchCountBefore, "PUT reading-position creates no branches");
  } finally {
    await closeAll(running);
    cleanupDir(dir);
  }
});

test("resolve-selection over HTTP: 200 exact canonical selection for both locator kinds; sourceHash equals canonicalText SHA-256", async () => {
  const dir = makeTempDataDir();
  const running: RunningStudio[] = [];
  try {
    const studio = await startStudio(dir, running);
    const { treeId } = await createTree(studio);
    const imported = await importReady(studio, treeId, "resolve.md", utf8(THREE_BLOCKS));
    const resolvePath = `${materialPath(treeId, imported.materialId)}/versions/${encodeURIComponent(imported.versionId)}/resolve-selection`;

    /* utf16-range：blk-1 "Two\n\n" 内 [5,8) → "Two"（blk-0 "One\n\n" 为
       5 单元：O n e \n \n）。 */
    const byRange = await call(studio.url(resolvePath), "POST", {
      locator: { kind: "utf16-range", start: 5, end: 8 },
    });
    assert.equal(byRange.status, 200);
    assert.equal(byRange.body.selection.start, 5);
    assert.equal(byRange.body.selection.end, 8);
    assert.equal(byRange.body.selection.excerpt, "Two");
    assert.equal(byRange.body.selection.blockId, "blk-1");
    assert.equal(byRange.body.selection.versionId, imported.versionId);
    assert.equal(byRange.body.selection.materialId, imported.materialId);
    assert.equal(byRange.body.selection.sourceHash, sha256Text(THREE_BLOCKS));
    assert.equal(byRange.body.block.blockId, "blk-1");
    assert.deepEqual(
      { start: byRange.body.block.start, end: byRange.body.block.end },
      { start: 5, end: 10 },
    );

    /* text-occurrence：needle 的首次出现。 */
    const byNeedle = await call(studio.url(resolvePath), "POST", {
      locator: { kind: "text-occurrence", needle: "Two", occurrence: 1 },
    });
    assert.equal(byNeedle.status, 200);
    assert.deepEqual(
      { start: byNeedle.body.selection.start, end: byNeedle.body.selection.end },
      { start: 5, end: 8 },
    );

    /* 锚点复核往返：带摘录 + 声明块 → 200。 */
    const roundTrip = await call(studio.url(resolvePath), "POST", {
      locator: { kind: "utf16-range", start: 5, end: 8 },
      excerpt: "Two",
      blockId: "blk-1",
    });
    assert.equal(roundTrip.status, 200);
    assert.equal(roundTrip.body.selection.excerpt, "Two");
  } finally {
    await closeAll(running);
    cleanupDir(dir);
  }
});

test("resolve-selection rejection surface: 400 with the frozen reason codes, 409 not-ready, 404/400/405/503", async () => {
  const dir = makeTempDataDir();
  const running: RunningStudio[] = [];
  try {
    const studio = await startStudio(dir, running);
    const { treeId } = await createTree(studio);
    const plain = await importReady(studio, treeId, "plain.md", utf8(THREE_BLOCKS));
    const emoji = await importReady(studio, treeId, "emoji.md", utf8(EMOJI_BLOCKS));
    const plainPath = `${materialPath(treeId, plain.materialId)}/versions/${encodeURIComponent(plain.versionId)}/resolve-selection`;
    const emojiPath = `${materialPath(treeId, emoji.materialId)}/versions/${encodeURIComponent(emoji.versionId)}/resolve-selection`;

    const rejections: ReadonlyArray<{ readonly body: unknown; readonly code: string }> = [
      { body: { locator: { kind: "utf16-range", start: -1, end: 4 } }, code: "out-of-bounds" },
      { body: { locator: { kind: "utf16-range", start: 3, end: 3 } }, code: "zero-length" },
      { body: { locator: { kind: "utf16-range", start: 9, end: 2 } }, code: "reversed" },
      /* blk-0 [0,5) / blk-1 [5,10)：[4,8) 跨块。 */
      { body: { locator: { kind: "utf16-range", start: 4, end: 8 } }, code: "cross-block" },
      { body: { locator: { kind: "utf16-range", start: 5, end: 8 }, blockId: "blk-0" }, code: "block-mismatch" },
      { body: { locator: { kind: "utf16-range", start: 5, end: 8 }, excerpt: "wrong" }, code: "excerpt-mismatch" },
      { body: { locator: { kind: "text-occurrence", needle: "Two", occurrence: 9 } }, code: "needle-not-found" },
      { body: { locator: { kind: "utf16-range", start: 1.5, end: 3 } }, code: "invalid-locator" },
    ];
    for (const item of rejections) {
      const outcome = await call(studio.url(plainPath), "POST", item.body);
      assert.equal(outcome.status, 400, `${item.code}: expected 400`);
      assert.equal(outcome.body.error.code, item.code, `${item.code}: wrong reason code`);
      assert.ok(outcome.body.error.message.length > 0, `${item.code}: message carried`);
    }
    /* emoji 材料上验证代理对拆分消息与材料无关地正确。 */
    const surrogate = await call(studio.url(emojiPath), "POST", { locator: { kind: "utf16-range", start: 1, end: 3 } });
    assert.equal(surrogate.status, 400);
    assert.equal(surrogate.body.error.code, "surrogate-split");

    /* stale-version over HTTP：同区间改写 + 溯源 → 400 stale-version。 */
    const revised = await upload(
      `${studio.url(materialPath(treeId, plain.materialId))}/versions`,
      "revised.md",
      utf8("One\n\nTWO\n\nThree"),
    );
    assert.equal(revised.status, 201);
    const version2: string = revised.body.version.id;
    await until(
      async () => (await call(studio.url(materialPath(treeId, plain.materialId)), "GET")).body.versions.length === 2,
      "the second version to appear",
    );
    const stalePath = `${materialPath(treeId, plain.materialId)}/versions/${encodeURIComponent(version2)}/resolve-selection`;
    const stale = await call(studio.url(stalePath), "POST", {
      locator: { kind: "utf16-range", start: 5, end: 8 },
      excerpt: "Two",
      anchor: { versionId: plain.versionId, sourceHash: sha256Text(THREE_BLOCKS) },
    });
    assert.equal(stale.status, 400);
    assert.equal(stale.body.error.code, "stale-version");
    assert.ok(stale.body.error.message.includes(plain.versionId), "the intact old version is named");
    /* 无溯源的同区间摘录不误报 stale。 */
    const noProvenance = await call(studio.url(stalePath), "POST", {
      locator: { kind: "utf16-range", start: 5, end: 8 },
      excerpt: "Two",
    });
    assert.equal(noProvenance.body.error.code, "excerpt-mismatch");

    /* 非 ready 版本：invalid-utf8 → failed → 409 material-not-ready。 */
    const broken = await upload(studio.url(materialPath(treeId)), "broken.md", new Uint8Array([0xff, 0xfe, 0x41]));
    assert.equal(broken.status, 201);
    await until(
      async () =>
        (await call(studio.url(materialPath(treeId, broken.body.material.id)), "GET")).body.versions[0].parseStatus ===
        "failed",
      "the broken version to fail",
    );
    const brokenPath = `${materialPath(treeId, broken.body.material.id)}/versions/${encodeURIComponent(broken.body.version.id)}/resolve-selection`;
    const notReady = await call(studio.url(brokenPath), "POST", { locator: { kind: "utf16-range", start: 0, end: 3 } });
    assert.equal(notReady.status, 409);
    assert.equal(notReady.body.error.code, "material-not-ready");

    /* 404 未知树/材料/版本；400 版本属他材料；405/503；400 非 JSON。 */
    assert.equal(
      (
        await call(
          studio.url(`${materialPath("tree-missing", plain.materialId)}/versions/${encodeURIComponent(plain.versionId)}/resolve-selection`),
          "POST",
          { locator: { kind: "utf16-range", start: 0, end: 3 } },
        )
      ).status,
      404,
    );
    assert.equal(
      (await call(studio.url(`${materialPath(treeId, "material-missing")}/versions/x/resolve-selection`), "POST", {})).status,
      404,
    );
    assert.equal(
      (
        await call(
          studio.url(`${materialPath(treeId, plain.materialId)}/versions/matver-missing/resolve-selection`),
          "POST",
          { locator: { kind: "utf16-range", start: 0, end: 3 } },
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await call(
          studio.url(`${materialPath(treeId, emoji.materialId)}/versions/${encodeURIComponent(plain.versionId)}/resolve-selection`),
          "POST",
          { locator: { kind: "utf16-range", start: 0, end: 3 } },
        )
      ).status,
      400,
    );
    assert.equal((await call(studio.url(plainPath), "GET")).status, 405);
    const badBody = await fetch(studio.url(plainPath), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    assert.equal(badBody.status, 400);

    const bare = await startStudio(dir, running, false);
    const bareTree = await createTree(bare);
    assert.equal(
      (
        await call(bare.url(`${materialPath(bareTree.treeId, "m")}/versions/v/resolve-selection`), "POST", {})
      ).status,
      503,
    );
  } finally {
    await closeAll(running);
    cleanupDir(dir);
  }
});
