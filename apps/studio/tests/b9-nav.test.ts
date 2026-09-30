/**
 * D4-8 大规模树导航 —— B9 冻结数据集 + 真实装载 + 引擎探针全量测试面。
 *
 * 三层覆盖（对应任务书 D4-8 引擎增量的验证义务）：
 *  1. 生成器确定性：同一 seed 两次生成，结构真值 JSON 字节级恒等，
 *     manifest 哈希恒等（spec.determinism：禁 Math.random()/时间戳）；
 *  2. 结构真值不变量：checkB9Invariants 零问题（总量 100 树 / 10000 非
 *     根 Branch / 六棵特殊树形状规则 / 深度-父子-路径一致 / 来源纪律）；
 *  3. 装载 + 查询正确性：全量装载进真实持久化库（临时数据目录，真实
 *     仓储 API），冻结探针集 100% 对照结构真值（定位/祖先/路径/兄弟
 *     位次/来源、宽树分页无重复无空洞、100 层深链、同名消歧、搜索、
 *     空树诚实、大树形状、树列表），引擎级性能冒烟（65 次预热后操作
 *     p95 ≤ 300ms；5000 节点树冷打开 ≤ 2s——引擎级证据，非浏览器
 *     verdict，B9 不得据此宣称通过）。
 *
 * 本文件不覆盖（诚实边界）：HTTP 接线、前端树 UI/虚拟化/键盘导航、
 * 重启状态持久化（展开/阅读状态）——属 D4-8 接线/前端增量。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TreeId } from "@treeai/contracts";
import {
  B9_BIG_TREE_ID,
  B9_DEEP_TREE_ID,
  B9_EMPTY_TREE_ID,
  B9_LONGTITLE_TREE_ID,
  B9_SAMENAME_TREE_ID,
  B9_SAME_NAME_TITLE,
  B9_WIDE_TREE_ID,
  buildB9Manifest,
  checkB9Invariants,
  generateB9Dataset,
  serializeB9Dataset,
  sha256Hex,
} from "../src/nav/b9-dataset.ts";
import { loadB9IntoFreshDir, type B9LoadedInstance } from "../src/nav/b9-loader.ts";
import { TreeNavEngine } from "../src/nav/nav-engine.ts";
import { runB9EngineChecks } from "../src/nav/b9-probes.ts";

/* ------------------------------------------------------------------ */
/* 1+2) 生成器确定性与结构真值不变量（纯生成，快）                        */
/* ------------------------------------------------------------------ */

test("b9 dataset: two generations are byte-identical (determinism) with equal manifest hashes", () => {
  const first = generateB9Dataset();
  const firstJson = serializeB9Dataset(first);
  const second = generateB9Dataset();
  const secondJson = serializeB9Dataset(second);
  assert.equal(secondJson, firstJson, "structure truth must be byte-identical across runs");
  const firstManifest = buildB9Manifest(first, firstJson);
  const secondManifest = buildB9Manifest(second, secondJson);
  assert.equal(secondManifest.structureTruthSha256, firstManifest.structureTruthSha256);
  assert.equal(firstManifest.structureTruthSha256, sha256Hex(firstJson));
  // 两次独立运行不是同一对象（浅拷贝陷阱防御）
  assert.notEqual(first, second);
});

test("b9 dataset: structure-truth invariants all hold (totals, six special-tree rules, origin discipline)", () => {
  const dataset = generateB9Dataset();
  const problems = checkB9Invariants(dataset);
  assert.deepEqual(problems, [], "invariant checker must report zero problems");

  // 规格总量的直接断言（防止不变量检查器本身与规格漂移）
  assert.equal(dataset.trees.length, 100);
  assert.equal(dataset.totals.nonTrunkBranches, 10000);
  assert.equal(dataset.totals.branchRows, 10100);
  assert.equal(dataset.totals.maxDepth, 100);
  const specialIds = [B9_BIG_TREE_ID, B9_DEEP_TREE_ID, B9_WIDE_TREE_ID, B9_EMPTY_TREE_ID, B9_SAMENAME_TREE_ID, B9_LONGTITLE_TREE_ID];
  for (const treeId of specialIds) {
    assert.ok(dataset.trees.some((tree) => tree.treeId === treeId), `special tree ${treeId} present`);
  }
  const big = dataset.trees.find((tree) => tree.treeId === B9_BIG_TREE_ID)!;
  assert.equal(big.nodes.length, 5000, "b9-big must be exactly 5000 nodes");
  const wide = dataset.trees.find((tree) => tree.treeId === B9_WIDE_TREE_ID)!;
  assert.ok(wide.nodes.filter((node) => node.parentId === wide.trunkBranchId).length >= 200);
  const empty = dataset.trees.find((tree) => tree.treeId === B9_EMPTY_TREE_ID)!;
  assert.equal(empty.nodes.length, 1);
  assert.equal(empty.nodes[0]!.title, null, "b9-empty trunk must have no title (no turns)");
  const samename = dataset.trees.find((tree) => tree.treeId === B9_SAMENAME_TREE_ID)!;
  assert.ok(samename.nodes.filter((node) => node.title === B9_SAME_NAME_TITLE).length >= 50);
  const longtitle = dataset.trees.find((tree) => tree.treeId === B9_LONGTITLE_TREE_ID)!;
  assert.ok(longtitle.nodes.filter((node) => node.title !== null && node.title.length >= 200).length >= 100);
  // 来源混合：两种来源都非零，且分布覆盖特殊树（b9-empty 除外——它没有非根节点）
  assert.ok(dataset.totals.turnOrigins > 0);
  assert.ok(dataset.totals.materialOrigins > 0);
  for (const tree of dataset.trees) {
    if (tree.kind !== "special" || tree.treeId === B9_EMPTY_TREE_ID) continue;
    assert.ok(tree.nodes.some((node) => node.originKind === "turn"), `${tree.treeId} has turn origins`);
    assert.ok(tree.nodes.some((node) => node.originKind === "material"), `${tree.treeId} has material origins`);
  }
});

/* ------------------------------------------------------------------ */
/* 3) 全量装载 + 引擎探针（重装载只做一次，多个断言面共享）               */
/* ------------------------------------------------------------------ */

const loaded: { instance: B9LoadedInstance | null } = { instance: null };

function loadedInstance(): B9LoadedInstance {
  if (loaded.instance === null) {
    const dataset = generateB9Dataset();
    const dir = mkdtempSync(join(tmpdir(), "treeai-b9-nav-"));
    loaded.instance = loadB9IntoFreshDir(dataset, dir);
  }
  return loaded.instance;
}

test("b9 dataset: loads into a real persistence database with row counts matching the structure truth", () => {
  const instance = loadedInstance();
  try {
    const stats = instance.loadStats;
    assert.equal(stats.trees, 100);
    assert.equal(stats.branches, instance.dataset.totals.branchRows);
    assert.equal(stats.episodes, instance.dataset.totals.titledNodes, "one episode per titled branch");
    assert.equal(stats.turnOrigins, instance.dataset.totals.turnOrigins);
    assert.equal(stats.materialOrigins, instance.dataset.totals.materialOrigins);
    assert.equal(stats.materials, instance.dataset.materials.length);
    // 真实库完整性
    assert.equal(instance.repository.integrityCheck().ok, true);
    // 装载后 Branch 行数与 listBranches 一致（抽查三棵树）
    for (const treeId of [B9_BIG_TREE_ID, B9_DEEP_TREE_ID, B9_EMPTY_TREE_ID]) {
      const tree = instance.dataset.trees.find((candidate) => candidate.treeId === treeId)!;
      assert.equal(instance.repository.listBranches(treeId as TreeId).length, tree.nodes.length);
    }
  } finally {
    // 保留实例供后续测试（进程内共享）；目录由最后一个测试清理
  }
});

test("b9 engine probes: all frozen probes pass 100% against the structure truth (locate/origins/pagination/deep/samename/search/empty/shape/tree-list/p95)", () => {
  const instance = loadedInstance();
  const engine = new TreeNavEngine({
    repository: instance.repository,
    materialRepository: instance.materialRepository,
  });
  const result = runB9EngineChecks({ dataset: instance.dataset, engine });
  const failed = result.probes.filter((probe) => probe.status === "FAIL");
  for (const probe of result.probes) {
    assert.equal(probe.status, "PASS", `${probe.id}: ${probe.detail}\n${probe.failures.join("\n")}`);
  }
  assert.equal(failed.length, 0);
  assert.ok(result.pass);
  // 性能冒烟的规格下限：探针数与操作数（引擎级；浏览器另测）
  assert.ok(result.perf.opCount >= 50, `perf sequence must be >= 50 ops (got ${String(result.perf.opCount)})`);
  assert.ok(result.perf.p95Ms <= 300, `engine p95 ${String(result.perf.p95Ms)}ms must be <= 300ms`);
  assert.ok(result.perf.firstOpenMs <= 2000, `cold first open ${String(result.perf.firstOpenMs)}ms must be <= 2000ms`);
});

test("b9 engine: cross-tree locate spot-checks (switch trees by branch id alone)", () => {
  const instance = loadedInstance();
  const engine = new TreeNavEngine({
    repository: instance.repository,
    materialRepository: instance.materialRepository,
  });
  const byId = new Map<string, { treeId: string; depth: number; title: string | null }>();
  for (const tree of instance.dataset.trees) {
    for (const node of tree.nodes) {
      byId.set(node.id, { treeId: tree.treeId, depth: node.depth, title: node.title });
    }
  }
  // 确定性抽样：每第 973 个节点（覆盖全部 100 棵树的散布样本）
  const all = [...byId.keys()];
  const sampled = all.filter((_, index) => index % 973 === 0);
  assert.ok(sampled.length >= 10);
  for (const branchId of sampled) {
    const truth = byId.get(branchId)!;
    const location = engine.locateBranch(branchId);
    assert.equal(location.treeId, truth.treeId, branchId);
    assert.equal(location.node.depth, truth.depth, branchId);
    assert.equal(location.node.title, truth.title, branchId);
    assert.equal(location.ancestors.length, truth.depth, `ancestor count must equal depth for ${branchId}`);
  }
});

test("b9 cleanup: close repositories and remove the temp data dir", () => {
  const instance = loaded.instance;
  loaded.instance = null;
  if (instance === null) return;
  instance.close();
  rmSync(instance.dataDir, { recursive: true, force: true });
});
