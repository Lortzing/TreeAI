/**
 * D4-8 大规模树导航 —— HTTP API 测试（issue #8 D4-8 接线增量；真实
 * node:http 服务 + fetch + B9 冻结数据集全量装载）。
 *
 * 覆盖（任务书 D4-8 接线增量的验证义务；引擎语义在 nav-engine.test.ts、
 * 全量探针在 b9-nav.test.ts——本文件测 HTTP 面）：
 *  - /api/nav/trees 分页树列表：标量摘要（无全树载荷）、无重复无空洞、
 *    totalTrees 恒定；
 *  - 单树概览：六棵特殊树的结构真值形状（b9-big 5000 节点、b9-deep
 *    深度 100、b9-empty 仅 trunk 且标题 null）；
 *  - 子节点分页：b9-wide 根下 220 直接子枝按页翻完（序=真值创建序）；
 *  - 深链：/path 返回 100 层完整链（101 个节点，深度 0..100）；
 *  - 跨树定位：按分支 id 携带树/祖先链/兄弟位次/来源；
 *  - 同名消歧：标题搜索 ≥50 命中各携带可区分完整路径，分页序=全量序；
 *  - 空树诚实：空页/单节点子树/null 标题概览；
 *  - 惰性端点有界：单页节点数 ≤ limit 上限（b9-big 全树经 subtree 分页
 *    翻完 5000 节点），响应体 < 1 MiB；
 *  - 展开状态：PUT → 204 → GET 回读；校验面（幽灵 id 404/跨树 400/非
 *    数组 400/未知树 404）；模拟重启（关闭全部连接 → 重开）后不丢；
 *  - 产品树 ≠ 运行 session 树：session 可用性全量清扫降级后，导航响应
 *    逐字节不变（结构性保证的实测）；
 *  - 未装配 nav → 503 nav-not-wired；错误映射（404/400/409 纪律）。
 *
 * 不覆盖（诚实边界）：虚拟化/DOM 计数/键盘/浏览器 p95——前端增量。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPiRuntimeFromConfig } from "@treeai/runtime-pi";
import { createStudioServer } from "../src/server.ts";
import { EchoSdkPort } from "../src/echo-port.ts";
import { TreeStudioService } from "../src/service.ts";
import { STUDIO_MODEL, makeStudioInstance } from "./helpers.ts";
import {
  B9_BIG_TREE_ID,
  B9_DEEP_TREE_ID,
  B9_EMPTY_TREE_ID,
  B9_SAME_NAME_TITLE,
  B9_SAMENAME_TREE_ID,
  B9_WIDE_TREE_ID,
  generateB9Dataset,
  type B9Dataset,
} from "../src/nav/b9-dataset.ts";
import { loadB9IntoFreshDir, openB9Repositories } from "../src/nav/b9-loader.ts";
import { NavService } from "../src/nav/nav-service.ts";

const staticDir = fileURLToPath(new URL("../public/", import.meta.url));

/* ------------------------------------------------------------------ */
/* HTTP 辅助                                                            */
/* ------------------------------------------------------------------ */

interface JsonOutcome {
  readonly status: number;
  readonly body: any;
  readonly text: string;
}

async function call(url: string, method = "GET", body?: unknown): Promise<JsonOutcome> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: any = null;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON 响应（204/错误页） */
  }
  return { status: response.status, body: parsed, text };
}

/* ------------------------------------------------------------------ */
/* 共享 B9 实例 + 真实 HTTP 服务（重装载只做一次）                        */
/* ------------------------------------------------------------------ */

interface RunningNav {
  readonly dataset: B9Dataset;
  readonly dataDir: string;
  readonly port: number;
  url(path: string): string;
  close(): Promise<void>;
}

const shared: { running: RunningNav | null } = { running: null };

function treeOf(dataset: B9Dataset, treeId: string) {
  const tree = dataset.trees.find((candidate) => candidate.treeId === treeId);
  if (tree === undefined) throw new Error(`test setup: tree ${treeId} missing`);
  return tree;
}

async function startShared(): Promise<RunningNav> {
  const dataset = generateB9Dataset();
  const dataDir = mkdtempSync(join(tmpdir(), "treeai-nav-api-"));
  const loaded = loadB9IntoFreshDir(dataset, dataDir);
  mkdirSync(join(dataDir, "workspace"), { recursive: true });
  const service = new TreeStudioService({
    repository: loaded.repository,
    runtime: createPiRuntimeFromConfig({
      port: new EchoSdkPort(),
      defaultCwd: join(dataDir, "workspace"),
    }),
    model: STUDIO_MODEL,
    sessionDir: join(dataDir, "sessions"),
    cwd: join(dataDir, "workspace"),
  });
  const nav = new NavService({ repository: loaded.repository, materialRepository: loaded.materialRepository });
  const server = createStudioServer({ service, staticDir, nav });
  const port = await server.listen(0);
  return {
    dataset,
    dataDir,
    port,
    url: (path: string) => `http://127.0.0.1:${String(port)}${path}`,
    async close(): Promise<void> {
      await server.close();
      await service.dispose();
      loaded.close();
    },
  };
}

async function runningNav(): Promise<RunningNav> {
  if (shared.running === null) {
    shared.running = await startShared();
  }
  return shared.running;
}

test("nav api: trees listing is paginated scalar summaries with no full-tree payloads", async () => {
  const nav = await runningNav();
  const collected: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  for (;;) {
    const query = new URLSearchParams({ limit: "40" });
    if (cursor !== null) query.set("cursor", cursor);
    const outcome = await call(nav.url(`/api/nav/trees?${query.toString()}`));
    assert.equal(outcome.status, 200);
    assert.equal(outcome.body.totalTrees, 100, "totalTrees is constant across pages");
    assert.ok(outcome.body.trees.length <= 40, "page size bounded by limit");
    for (const entry of outcome.body.trees) {
      // 标量摘要：绝无嵌套 branches/nodes（无全树载荷）
      assert.deepEqual(Object.keys(entry).sort(), ["createdAt", "forestId", "title", "treeId", "trunkBranchId"]);
      collected.push(entry.treeId);
    }
    pages += 1;
    cursor = outcome.body.nextCursor;
    if (cursor === null) break;
    assert.ok(pages <= 10, "pagination must terminate");
  }
  assert.equal(pages, 3, "100 trees at limit 40 paginates as 3 pages (40/40/20)");
  assert.equal(collected.length, 100);
  assert.equal(new Set(collected).size, 100, "no duplicates across pages");
  const truthIds = new Set(nav.dataset.trees.map((tree) => tree.treeId));
  assert.deepEqual(new Set(collected), truthIds, "listing covers exactly the dataset trees");
});

test("nav api: tree overview carries the structure-truth shape of the special trees", async () => {
  const nav = await runningNav();
  const cases: Array<{ treeId: string; nodeCount: number; maxDepth: number; title: string | null }> = [];
  for (const treeId of [B9_BIG_TREE_ID, B9_DEEP_TREE_ID, B9_WIDE_TREE_ID, B9_EMPTY_TREE_ID]) {
    const tree = treeOf(nav.dataset, treeId);
    cases.push({
      treeId,
      nodeCount: tree.nodes.length,
      maxDepth: tree.nodes.reduce((max, node) => Math.max(max, node.depth), 0),
      title: tree.nodes[0]!.title,
    });
  }
  for (const expected of cases) {
    const outcome = await call(nav.url(`/api/nav/trees/${expected.treeId}`));
    assert.equal(outcome.status, 200, expected.treeId);
    assert.equal(outcome.body.nodeCount, expected.nodeCount, `${expected.treeId} nodeCount`);
    assert.equal(outcome.body.maxDepth, expected.maxDepth, `${expected.treeId} maxDepth`);
    assert.equal(outcome.body.title, expected.title, `${expected.treeId} title`);
  }
  const big = await call(nav.url(`/api/nav/trees/${B9_BIG_TREE_ID}`));
  assert.equal(big.body.nodeCount, 5000, "b9-big is exactly 5000 nodes");
  const deep = await call(nav.url(`/api/nav/trees/${B9_DEEP_TREE_ID}`));
  assert.equal(deep.body.maxDepth, 100, "b9-deep reaches depth 100");
  const empty = await call(nav.url(`/api/nav/trees/${B9_EMPTY_TREE_ID}`));
  assert.equal(empty.body.nodeCount, 1);
  assert.equal(empty.body.title, null, "b9-empty trunk has no title (honest null)");
  const unknown = await call(nav.url("/api/nav/trees/no-such-tree"));
  assert.equal(unknown.status, 404);
});

test("nav api: children pagination pages b9-wide's 220 root children in truth order", async () => {
  const nav = await runningNav();
  const wide = treeOf(nav.dataset, B9_WIDE_TREE_ID);
  const truthOrder = wide.nodes.filter((node) => node.parentId === wide.trunkBranchId).map((node) => node.id);
  assert.ok(truthOrder.length >= 200, "b9-wide really is wide (>=200 root children)");

  const collected: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  for (;;) {
    const query = new URLSearchParams({ limit: "50" });
    if (cursor !== null) query.set("cursor", cursor);
    const outcome = await call(
      nav.url(`/api/nav/trees/${B9_WIDE_TREE_ID}/branches/${wide.trunkBranchId}/children?${query.toString()}`),
    );
    assert.equal(outcome.status, 200);
    assert.equal(outcome.body.totalChildren, truthOrder.length, "totalChildren constant");
    assert.ok(outcome.body.nodes.length <= 50);
    collected.push(...outcome.body.nodes.map((node: any) => node.id));
    pages += 1;
    cursor = outcome.body.nextCursor;
    if (cursor === null) break;
    assert.ok(pages <= 20, "pagination must terminate");
  }
  assert.deepEqual(collected, truthOrder, "pages concatenate to the creation-order truth sequence (no dups/gaps)");
  assert.equal(pages, Math.ceil(truthOrder.length / 50));
});

test("nav api: lazy endpoints enforce bounded limits and reject malformed cursors/params", async () => {
  const nav = await runningNav();
  const big = treeOf(nav.dataset, B9_BIG_TREE_ID);
  const childrenUrl = `/api/nav/trees/${B9_BIG_TREE_ID}/branches/${big.trunkBranchId}/children`;
  for (const limit of ["501", "0", "-1", "abc", "2.5"]) {
    const outcome = await call(nav.url(`${childrenUrl}?limit=${limit}`));
    assert.equal(outcome.status, 400, `limit=${limit} must be 400`);
    assert.equal(outcome.body.error.code, "invalid-argument");
  }
  const badCursor = await call(nav.url(`${childrenUrl}?cursor=not-a-cursor`));
  assert.equal(badCursor.status, 400);
  assert.equal(badCursor.body.error.code, "invalid-cursor");
  const badDepth = await call(
    nav.url(`/api/nav/trees/${B9_BIG_TREE_ID}/branches/${big.trunkBranchId}/subtree?maxDepth=1001`),
  );
  assert.equal(badDepth.status, 400);
  assert.equal(badDepth.body.error.code, "invalid-argument");
  // 未知树/未知分支 → 404（invalid-argument 之外的诚实拒绝面）
  assert.equal((await call(nav.url("/api/nav/trees/no-such-tree/branches/x/children"))).status, 404);
  assert.equal((await call(nav.url(`/api/nav/trees/${B9_BIG_TREE_ID}/branches/ghost/children`))).status, 404);
  // 错误方法 → 405
  assert.equal((await call(nav.url("/api/nav/trees"), "POST")).status, 405);
});

test("nav api: b9-big full tree only ever arrives page-bounded (5000 nodes via subtree pagination, <1MiB pages)", async () => {
  const nav = await runningNav();
  const big = treeOf(nav.dataset, B9_BIG_TREE_ID);
  const collected: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  let maxPageBytes = 0;
  for (;;) {
    const query = new URLSearchParams({ maxDepth: "1000", limit: "1000" });
    if (cursor !== null) query.set("cursor", cursor);
    const outcome = await call(
      nav.url(`/api/nav/trees/${B9_BIG_TREE_ID}/branches/${big.trunkBranchId}/subtree?${query.toString()}`),
    );
    assert.equal(outcome.status, 200);
    assert.ok(outcome.body.nodes.length <= 1000, "single page never exceeds the limit cap");
    maxPageBytes = Math.max(maxPageBytes, outcome.text.length);
    collected.push(...outcome.body.nodes.map((node: any) => node.id));
    pages += 1;
    cursor = outcome.body.nextCursor;
    if (cursor === null) break;
    assert.ok(pages <= 10, "pagination must terminate");
  }
  assert.equal(collected.length, 5000, "the whole 5000-node tree arrives across pages");
  assert.equal(new Set(collected).size, 5000, "no duplicates");
  assert.deepEqual(
    new Set(collected),
    new Set(big.nodes.map((node) => node.id)),
    "subtree pagination covers exactly b9-big's nodes",
  );
  assert.equal(pages, 5, "5000 nodes at limit 1000 paginates as 5 pages");
  assert.ok(maxPageBytes < 1_000_000, `largest page is ${String(maxPageBytes)} bytes (< 1 MiB bounded payload)`);
});

test("nav api: deep chain /path returns the complete 100-level chain", async () => {
  const nav = await runningNav();
  const leaf = treeOf(nav.dataset, B9_DEEP_TREE_ID).nodes.find((node) => node.id === "b9-deep-c100")!;
  assert.equal(leaf.depth, 100, "dataset leaf really is at depth 100");
  const outcome = await call(nav.url(`/api/nav/trees/${B9_DEEP_TREE_ID}/branches/${leaf.id}/path`));
  assert.equal(outcome.status, 200);
  assert.equal(outcome.body.path.length, 101, "trunk + 100 levels");
  const truthIds = [...leaf.parentPath, leaf.id];
  assert.deepEqual(
    outcome.body.path.map((step: any) => step.id),
    truthIds,
    "path ids equal the truth parent chain (complete, in order)",
  );
  for (let i = 0; i < outcome.body.path.length; i += 1) {
    assert.equal(outcome.body.path[i].depth, i, `level ${String(i)} depth`);
  }
});

test("nav api: locate switches trees by branch id alone with ancestors and origin", async () => {
  const nav = await runningNav();
  const deep = treeOf(nav.dataset, B9_DEEP_TREE_ID);
  const mid = deep.nodes.find((node) => node.id === "b9-deep-c050")!;
  const outcome = await call(nav.url(`/api/nav/branches/${mid.id}/locate`));
  assert.equal(outcome.status, 200);
  assert.equal(outcome.body.treeId, B9_DEEP_TREE_ID);
  assert.equal(outcome.body.node.id, mid.id);
  assert.equal(outcome.body.ancestors.length, 50);
  assert.equal(outcome.body.path.length, 51);
  assert.equal(outcome.body.node.originKind, mid.originKind, "origin kind matches the structure truth");
  const unknown = await call(nav.url("/api/nav/branches/ghost/locate"));
  assert.equal(unknown.status, 404);
});

test("nav api: same-name search disambiguates by full path and paginates in the full-order", async () => {
  const nav = await runningNav();
  const samename = treeOf(nav.dataset, B9_SAMENAME_TREE_ID);
  const truthHits = samename.nodes.filter((node) => node.title === B9_SAME_NAME_TITLE);
  assert.ok(truthHits.length >= 50, "dataset really has >=50 same-name branches");

  // 分页翻完（页大小 13 —— 不整除，验证游标边界）
  const collected: any[] = [];
  let cursor: string | null = null;
  for (;;) {
    const query = new URLSearchParams({ text: B9_SAME_NAME_TITLE, mode: "exact", limit: "13" });
    if (cursor !== null) query.set("cursor", cursor);
    const outcome = await call(nav.url(`/api/nav/search/branches?${query.toString()}`));
    assert.equal(outcome.status, 200);
    collected.push(...outcome.body.hits);
    cursor = outcome.body.nextCursor;
    if (cursor === null) break;
    assert.ok(collected.length <= 600, "pagination must terminate");
  }
  assert.equal(collected.length, truthHits.length, "all same-name hits collected");
  const paths = new Set(collected.map((hit) => hit.path.map((step: any) => step.id).join(">")));
  assert.equal(paths.size, truthHits.length, "every hit carries a distinct full path (disambiguation payload)");
  // 分页序 = 全量序（确定性）
  const unpaginated = await call(
    nav.url(`/api/nav/search/branches?text=${encodeURIComponent(B9_SAME_NAME_TITLE)}&mode=exact&limit=500`),
  );
  assert.deepEqual(
    collected.map((hit) => hit.branchId),
    unpaginated.body.hits.map((hit: any) => hit.branchId),
  );
  // 命中可按 id 精确定位（消歧闭环：路径 → locate → 同一节点）
  const first = collected[0];
  const located = await call(nav.url(`/api/nav/branches/${first.branchId}/locate`));
  assert.equal(located.status, 200);
  assert.deepEqual(
    located.body.path.map((step: any) => step.id),
    first.path.map((step: any) => step.id),
  );
  // 树范围 + 校验面
  const scoped = await call(
    nav.url(`/api/nav/search/branches?text=${encodeURIComponent(B9_SAME_NAME_TITLE)}&mode=exact&treeId=${B9_SAMENAME_TREE_ID}&limit=500`),
  );
  assert.equal(scoped.status, 200);
  assert.ok(scoped.body.hits.every((hit: any) => hit.treeId === B9_SAMENAME_TREE_ID));
  assert.equal((await call(nav.url("/api/nav/search/branches"))).status, 400, "missing text → 400");
  assert.equal((await call(nav.url("/api/nav/search/branches?text=%20%20"))).status, 400, "blank text → 400");
  assert.equal(
    (await call(nav.url(`/api/nav/search/branches?text=x&mode=fuzzy`))).status,
    400,
    "unknown mode → 400",
  );
  assert.equal(
    (await call(nav.url("/api/nav/search/branches?text=x&treeId=no-such-tree"))).status,
    404,
    "unknown scope tree → 404",
  );
});

test("nav api: tree search paginates the deterministic order (ids and titles)", async () => {
  const nav = await runningNav();
  const collected: string[] = [];
  let cursor: string | null = null;
  for (;;) {
    const query = new URLSearchParams({ text: "b9-", mode: "prefix", limit: "60" });
    if (cursor !== null) query.set("cursor", cursor);
    const outcome = await call(nav.url(`/api/nav/search/trees?${query.toString()}`));
    assert.equal(outcome.status, 200);
    collected.push(...outcome.body.hits.map((hit: any) => hit.treeId));
    cursor = outcome.body.nextCursor;
    if (cursor === null) break;
    assert.ok(collected.length <= 200, "pagination must terminate");
  }
  assert.equal(collected.length, 100, "all dataset trees match the 'b9-' id prefix");
  assert.equal(new Set(collected).size, 100, "no duplicates across tree-search pages");
});

test("nav api: empty tree stays honestly usable", async () => {
  const nav = await runningNav();
  const empty = treeOf(nav.dataset, B9_EMPTY_TREE_ID);
  const children = await call(
    nav.url(`/api/nav/trees/${B9_EMPTY_TREE_ID}/branches/${empty.trunkBranchId}/children`),
  );
  assert.equal(children.status, 200);
  assert.deepEqual(children.body, {
    treeId: B9_EMPTY_TREE_ID,
    parentBranchId: empty.trunkBranchId,
    nodes: [],
    nextCursor: null,
    totalChildren: 0,
  });
  const subtree = await call(
    nav.url(`/api/nav/trees/${B9_EMPTY_TREE_ID}/branches/${empty.trunkBranchId}/subtree?maxDepth=2`),
  );
  assert.equal(subtree.status, 200);
  assert.equal(subtree.body.nodes.length, 1, "only the trunk itself");
  const path = await call(nav.url(`/api/nav/trees/${B9_EMPTY_TREE_ID}/branches/${empty.trunkBranchId}/path`));
  assert.equal(path.status, 200);
  assert.equal(path.body.path.length, 1);
});

test("nav api: expand-state round trip, validation, and survival across a simulated restart", async () => {
  const nav = await runningNav();
  const deep = treeOf(nav.dataset, B9_DEEP_TREE_ID);
  const expandIds = [deep.trunkBranchId, "b9-deep-c001", "b9-deep-c010", "b9-deep-c100"];

  // 未知树：GET/PUT 均 404（不把「树不存在」伪装成「无状态」）
  assert.equal((await call(nav.url("/api/nav/trees/no-such-tree/expand-state"))).status, 404);
  assert.equal(
    (
      await call(nav.url("/api/nav/trees/no-such-tree/expand-state"), "PUT", {
        expandedBranchIds: [],
        selectedBranchId: null,
      })
    ).status,
    404,
  );
  // 未知树但无状态 → null 诚实空态
  const noState = await call(nav.url(`/api/nav/trees/${B9_WIDE_TREE_ID}/expand-state`));
  assert.equal(noState.status, 200);
  assert.deepEqual(noState.body, { expandState: null });

  // 写入 → 204 → 回读一致
  const put = await call(nav.url(`/api/nav/trees/${B9_DEEP_TREE_ID}/expand-state`), "PUT", {
    expandedBranchIds: expandIds,
    selectedBranchId: "b9-deep-c010",
  });
  assert.equal(put.status, 204);
  const read = await call(nav.url(`/api/nav/trees/${B9_DEEP_TREE_ID}/expand-state`));
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.expandState.expandedBranchIds, expandIds);
  assert.equal(read.body.expandState.selectedBranchId, "b9-deep-c010");

  // 校验面：幽灵 id 404 / 跨树 id 400 / 非数组 400 / 空 body 400
  assert.equal(
    (
      await call(nav.url(`/api/nav/trees/${B9_DEEP_TREE_ID}/expand-state`), "PUT", {
        expandedBranchIds: ["ghost"],
      })
    ).status,
    404,
  );
  const big = treeOf(nav.dataset, B9_BIG_TREE_ID);
  assert.equal(
    (
      await call(nav.url(`/api/nav/trees/${B9_DEEP_TREE_ID}/expand-state`), "PUT", {
        expandedBranchIds: [big.nodes[1]!.id],
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call(nav.url(`/api/nav/trees/${B9_DEEP_TREE_ID}/expand-state`), "PUT", {
        expandedBranchIds: "not-an-array",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call(nav.url(`/api/nav/trees/${B9_DEEP_TREE_ID}/expand-state`), "PUT", {
        selectedBranchId: "b9-deep-c001",
      })
    ).status,
    400,
    "missing expandedBranchIds is rejected (explicit full-set semantics)",
  );
  // 拒绝后状态不被破坏
  const afterRejects = await call(nav.url(`/api/nav/trees/${B9_DEEP_TREE_ID}/expand-state`));
  assert.deepEqual(afterRejects.body.expandState.expandedBranchIds, expandIds, "rejected writes never mutate state");

  // —— 模拟重启：关闭全部连接与服务 → 同一数据目录重新装配 ——
  const beforeRestart = afterRejects.body.expandState;
  const running = shared.running!;
  shared.running = null;
  await running.close();

  const repos = openB9Repositories(nav.dataDir);
  const service = new TreeStudioService({
    repository: repos.repository,
    runtime: createPiRuntimeFromConfig({
      port: new EchoSdkPort(),
      defaultCwd: join(nav.dataDir, "workspace"),
    }),
    model: STUDIO_MODEL,
    sessionDir: join(nav.dataDir, "sessions"),
    cwd: join(nav.dataDir, "workspace"),
  });
  const navService = new NavService({ repository: repos.repository, materialRepository: repos.materialRepository });
  const server = createStudioServer({ service, staticDir, nav: navService });
  const port = await server.listen(0);
  try {
    const afterRestart = await call(`http://127.0.0.1:${String(port)}/api/nav/trees/${B9_DEEP_TREE_ID}/expand-state`);
    assert.equal(afterRestart.status, 200);
    assert.deepEqual(
      afterRestart.body.expandState,
      beforeRestart,
      "expand state and reading position survive the restart (migration 0010)",
    );
  } finally {
    await server.close();
    await service.dispose();
    repos.close();
    rmSync(nav.dataDir, { recursive: true, force: true });
  }
});

test("nav api: product tree ≠ run/session trees — session availability sweep leaves nav byte-identical", async () => {
  const nav = await runningNav();
  const deep = treeOf(nav.dataset, B9_DEEP_TREE_ID);
  const wide = treeOf(nav.dataset, B9_WIDE_TREE_ID);
  const endpoints = [
    "/api/nav/trees?limit=40",
    `/api/nav/branches/b9-deep-c050/locate`,
    `/api/nav/trees/${B9_WIDE_TREE_ID}/branches/${wide.trunkBranchId}/children?limit=50`,
    `/api/nav/search/branches?text=${encodeURIComponent(B9_SAME_NAME_TITLE)}&mode=exact&limit=13`,
    `/api/nav/trees/${B9_DEEP_TREE_ID}/branches/b9-deep-c100/path`,
  ];
  const before = [];
  for (const endpoint of endpoints) {
    const outcome = await call(nav.url(endpoint));
    assert.equal(outcome.status, 200, endpoint);
    before.push(outcome.text);
  }

  // B9 的 session 文件是确定性合成引用（磁盘上不存在）：全量清扫后
  // 全部 run 的 session 可用性降级——导航是产品事实读取，必须逐字节不变。
  const running = shared.running!;
  shared.running = null;
  await running.close();
  const repos = openB9Repositories(nav.dataDir);
  try {
    const sweep = repos.repository.refreshSessionAvailability();
    assert.ok(sweep.length > 0, "b9 references real session rows (synthetic files)");
    for (const entry of sweep) {
      const references = repos.repository.getSessionReferencesByFile(entry.sessionFile);
      assert.ok(references.length > 0);
      for (const { reference } of references) {
        assert.equal(
          reference.availability.status,
          "unavailable",
          `every synthetic session degrades honestly (file ${entry.sessionFile} does not exist)`,
        );
      }
    }
  } finally {
    repos.close();
  }
  // 重新装配（与重启同构）后再测：既证明不变性、又顺带证明导航不依赖
  // 进程内缓存（全新引擎索引在降级库上重建）。
  const restarted = await startSharedOnExisting(nav.dataDir, nav.dataset);
  try {
    for (let i = 0; i < endpoints.length; i += 1) {
      const outcome = await call(restarted.url(endpoints[i]!));
      assert.equal(outcome.status, 200, endpoints[i]!);
      assert.equal(outcome.text, before[i], `${endpoints[i]} is byte-identical after session degradation`);
    }
  } finally {
    await restarted.close();
    rmSync(nav.dataDir, { recursive: true, force: true });
  }
});

test("nav api: 503 when nav is not wired", async () => {
  const dir = mkdtempSync(join(tmpdir(), "treeai-nav-api-unwired-"));
  const studio = makeStudioInstance(dir);
  const server = createStudioServer({ service: studio.service, staticDir });
  const port = await server.listen(0);
  try {
    const outcome = await call(`http://127.0.0.1:${String(port)}/api/nav/trees`);
    assert.equal(outcome.status, 503);
    assert.equal(outcome.body.error.code, "nav-not-wired");
  } finally {
    await server.close();
    await studio.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nav api cleanup: close the shared instance and remove its data dir", async () => {
  const running = shared.running;
  shared.running = null;
  if (running !== null) {
    await running.close();
    rmSync(running.dataDir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* 在既有数据目录上重新装配（重启/降级不变性测试共用）                    */
/* ------------------------------------------------------------------ */

async function startSharedOnExisting(dataDir: string, dataset: B9Dataset): Promise<RunningNav> {
  const repos = openB9Repositories(dataDir);
  const service = new TreeStudioService({
    repository: repos.repository,
    runtime: createPiRuntimeFromConfig({
      port: new EchoSdkPort(),
      defaultCwd: join(dataDir, "workspace"),
    }),
    model: STUDIO_MODEL,
    sessionDir: join(dataDir, "sessions"),
    cwd: join(dataDir, "workspace"),
  });
  const navService = new NavService({ repository: repos.repository, materialRepository: repos.materialRepository });
  const server = createStudioServer({ service, staticDir, nav: navService });
  const port = await server.listen(0);
  return {
    dataset,
    dataDir,
    port,
    url: (path: string) => `http://127.0.0.1:${String(port)}${path}`,
    async close(): Promise<void> {
      await server.close();
      await service.dispose();
      repos.close();
    },
  };
}
