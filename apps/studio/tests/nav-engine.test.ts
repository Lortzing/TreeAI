/**
 * D4-8 大规模树导航 —— TreeNavEngine 引擎单元/集成测试面。
 *
 * 在真实仓储（TreeRepository + MaterialRepository，临时数据目录上的真实
 * SQLite）上以小规模手工树覆盖引擎语义：
 *  - 子节点分页不变量（多种页大小翻完全程：无重复/无空洞/末页游标 null/
 *    totalChildren 恒定/游标越界诚实空页）；
 *  - 参数与游标防御（limit/mode 校验、非法游标、失效后的过期游标显式报错）；
 *  - 深度受限子树展开（maxDepth=0 仅根、深度边界、limit 截断 + 游标续页、
 *    truncated 标记）；
 *  - 定位（跨树按 id、祖先链、兄弟位次、Turn/Material 来源视图）；
 *  - 按标题搜索（exact/prefix/substring、大小写折算、标题/标识双命中面、
 *    树范围、空查询诚实零命中、同输入恒同输出的确定性序）；
 *  - 同名消歧（同名不同父 → 每条命中携带可区分完整路径）；
 *  - 空树诚实（仅 trunk 的树：空页/单节点展开/空路径/无标题概览）；
 *  - 深链无栈溢出（12,000 层链的父路径与定位——迭代实现的结构性证明）；
 *  - 索引失效语义（写入方 invalidate 后新分支可见；未失效前按快照读）。
 *
 * B9 冻结数据集的全量验证在 b9-nav.test.ts（本文件只测引擎语义）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { MaterialRepository, TreeRepository } from "@treeai/persistence";
import type {
  BranchId,
  EpisodeId,
  ForestId,
  MaterialId,
  MaterialVersionId,
  PiEntryId,
  PiSessionId,
  PiVersion,
  RunId,
  TreeId,
  TurnId,
} from "@treeai/contracts";
import { TreeNavEngine, NavEngineError } from "../src/nav/nav-engine.ts";

/* ------------------------------------------------------------------ */
/* 测试环境（真实仓储；临时目录）                                        */
/* ------------------------------------------------------------------ */

interface Harness {
  readonly dir: string;
  readonly repository: TreeRepository;
  readonly materialRepository: MaterialRepository;
  readonly engine: TreeNavEngine;
  close(): void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "treeai-nav-engine-"));
  const repository = TreeRepository.open({ path: join(dir, "treeai.db") });
  const materialRepository = MaterialRepository.open({ path: join(dir, "treeai.db") });
  const engine = new TreeNavEngine({ repository, materialRepository });
  return {
    dir,
    repository,
    materialRepository,
    engine,
    close(): void {
      materialRepository.close();
      repository.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 建一棵树（森林+树+trunk），返回 treeId/trunk id。 */
function makeTree(h: Harness, treeId: string): { treeId: string; trunk: string } {
  const forestId = `forest-${treeId}` as ForestId;
  h.repository.createForest({ id: forestId });
  const tree = h.repository.createTree(forestId, { id: treeId as TreeId });
  const trunk = h.repository.createBranch(tree.id);
  return { treeId: tree.id, trunk: trunk.id };
}

/** 建一个带标题（首个 user Turn）的分支；返回分支 id。 */
function makeTitledBranch(
  h: Harness,
  treeId: string,
  parentBranchId: string | null,
  title: string,
  branchId?: string,
): string {
  const branch = h.repository.createBranch(treeId as TreeId, {
    id: branchId === undefined ? undefined : (branchId as BranchId),
    parentBranchId: parentBranchId === null ? null : (parentBranchId as BranchId),
  });
  const episode = h.repository.createEpisode(branch.id, { id: `${branch.id}-ep` as EpisodeId });
  h.repository.createRun(
    episode.id,
    {
      sessionId: `s-${branch.id}` as PiSessionId,
      sessionFile: `${treeId}/${branch.id}.jsonl`,
      entryId: `e-${branch.id}` as PiEntryId,
      piVersion: "test-1" as PiVersion,
      availability: { status: "available" },
    },
    { id: `${branch.id}-run` as RunId },
  );
  h.repository.createTurn({
    id: `${branch.id}-q` as TurnId,
    treeId: treeId as TreeId,
    branchId: branch.id,
    episodeId: episode.id,
    runId: `${branch.id}-run` as RunId,
    role: "user",
    text: title,
  });
  return branch.id;
}

/** 建一个含 markdown 版本的材料（ready），返回 selection 输入所需的全部定位信息。 */
function makeMaterial(h: Harness, materialId: string): {
  materialId: string;
  versionId: string;
  canonicalText: string;
  blockId: string;
  start: number;
  end: number;
  excerpt: string;
  sourceHash: string;
} {
  const canonicalText = "第一块：学习路径的起点是主干问题，而不是细节的堆叠。\n\nSecond block: spaced repetition schedules reviews before forgetting.";
  const firstBlockEnd = "第一块：学习路径的起点是主干问题，而不是细节的堆叠。\n\n".length;
  h.materialRepository.createMaterial({ id: materialId as MaterialId, title: `材料 ${materialId}` });
  const version = h.materialRepository.insertVersion({
    id: `${materialId}-v1` as MaterialVersionId,
    materialId: materialId as MaterialId,
    bytes: new TextEncoder().encode(canonicalText),
    parserKind: "markdown",
    parserVersion: "d4-md-v1",
    parseStatus: "ready",
    canonicalText,
    blocks: [
      { blockId: "blk-1", kind: "markdown-block", start: 0, end: firstBlockEnd },
      { blockId: "blk-2", kind: "markdown-block", start: firstBlockEnd, end: canonicalText.length },
    ],
  });
  const start = "第一块：".length;
  const end = start + 12;
  return {
    materialId,
    versionId: version.id,
    canonicalText,
    blockId: "blk-1",
    start,
    end,
    excerpt: canonicalText.slice(start, end),
    sourceHash: createHash("sha256").update(canonicalText, "utf8").digest("hex"),
  };
}

/* ------------------------------------------------------------------ */
/* 子节点分页                                                           */
/* ------------------------------------------------------------------ */

test("children pagination: page through 300 children at multiple page sizes without duplicates or gaps", () => {
  const h = makeHarness();
  try {
    const { treeId, trunk } = makeTree(h, "t-page");
    for (let i = 1; i <= 300; i += 1) {
      makeTitledBranch(h, treeId, trunk, `第${String(i)}个问题 question ${String(i)}`, `page-n${String(i).padStart(3, "0")}`);
    }
    for (const limit of [1, 7, 25, 300, 500]) {
      const collected: string[] = [];
      let cursor: string | undefined;
      let lastNextCursor: string | null = "sentinel";
      let pages = 0;
      for (;;) {
        const page = h.engine.listChildren(treeId, trunk, { limit, cursor });
        assert.equal(page.totalChildren, 300, "totalChildren must be stable across pages");
        assert.equal(page.parentBranchId, trunk);
        collected.push(...page.nodes.map((node) => node.id));
        lastNextCursor = page.nextCursor;
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
        pages += 1;
        assert.ok(pages < 400, "pagination must terminate");
      }
      assert.equal(lastNextCursor, null, "final page must have null nextCursor");
      assert.equal(collected.length, 300, `limit=${String(limit)}: total collected`);
      assert.equal(new Set(collected).size, 300, `limit=${String(limit)}: no duplicates`);
      for (let i = 0; i < 300; i += 1) {
        assert.equal(collected[i], `page-n${String(i + 1).padStart(3, "0")}`, `limit=${String(limit)}: order preserved (no gaps) at ${String(i)}`);
      }
    }
    // 游标恰好落在末端：诚实空页
    const full = h.engine.listChildren(treeId, trunk, { limit: 300 });
    assert.equal(full.nextCursor, null);
  } finally {
    h.close();
  }
});

test("children pagination: parameter validation and cursor discipline", () => {
  const h = makeHarness();
  try {
    const { treeId, trunk } = makeTree(h, "t-args");
    makeTitledBranch(h, treeId, trunk, "问题一");
    makeTitledBranch(h, treeId, trunk, "问题二");
    assert.throws(() => h.engine.listChildren(treeId, trunk, { limit: 0 }), NavEngineError);
    assert.throws(() => h.engine.listChildren(treeId, trunk, { limit: -1 }), NavEngineError);
    assert.throws(() => h.engine.listChildren(treeId, trunk, { limit: 501 }), NavEngineError);
    assert.throws(() => h.engine.listChildren(treeId, trunk, { limit: 1.5 }), NavEngineError);
    assert.throws(() => h.engine.listChildren(treeId, trunk, { cursor: "not-a-cursor!!" }), NavEngineError);
    assert.throws(() => h.engine.listChildren("no-such-tree", trunk), NavEngineError);
    assert.throws(() => h.engine.listChildren(treeId, "no-such-branch"), NavEngineError);
    assert.throws(() => h.engine.searchBranches("x", { mode: "fuzzy" as never }), NavEngineError);

    // 过期游标：invalidate 之后旧游标必须显式报错（不静默跳页）
    const page1 = h.engine.listChildren(treeId, trunk, { limit: 1 });
    assert.ok(page1.nextCursor !== null);
    h.repository.createBranch(treeId as TreeId, { parentBranchId: trunk as BranchId });
    h.engine.invalidate(treeId);
    assert.throws(() => h.engine.listChildren(treeId, trunk, { cursor: page1.nextCursor! }), NavEngineError);
  } finally {
    h.close();
  }
});

test("index invalidation: new branch invisible until invalidate, visible after", () => {
  const h = makeHarness();
  try {
    const { treeId, trunk } = makeTree(h, "t-invalidate");
    makeTitledBranch(h, treeId, trunk, "既有问题");
    const before = h.engine.listChildren(treeId, trunk, { limit: 50 });
    assert.equal(before.totalChildren, 1);
    // 写入方新增分支：未失效前引擎按快照读（文档化语义）
    const added = makeTitledBranch(h, treeId, trunk, "新问题");
    const stillSnapshot = h.engine.listChildren(treeId, trunk, { limit: 50 });
    assert.equal(stillSnapshot.totalChildren, 1, "engine reads a snapshot until invalidate() is called");
    h.engine.invalidate(treeId);
    const after = h.engine.listChildren(treeId, trunk, { limit: 50 });
    assert.equal(after.totalChildren, 2);
    assert.ok(after.nodes.some((node) => node.id === added));
  } finally {
    h.close();
  }
});

/* ------------------------------------------------------------------ */
/* 子树展开                                                             */
/* ------------------------------------------------------------------ */

test("subtree expansion: depth limits, node limit truncation and cursor continuation", () => {
  const h = makeHarness();
  try {
    const { treeId, trunk } = makeTree(h, "t-subtree");
    // trunk -> a1..a3 -> (a1: b1,b2) (a2: b3) ；a1 的 b1 再挂 c1
    const a1 = makeTitledBranch(h, treeId, trunk, "A1");
    const a2 = makeTitledBranch(h, treeId, trunk, "A2");
    const a3 = makeTitledBranch(h, treeId, trunk, "A3");
    const b1 = makeTitledBranch(h, treeId, a1, "B1");
    makeTitledBranch(h, treeId, a1, "B2");
    makeTitledBranch(h, treeId, a2, "B3");
    makeTitledBranch(h, treeId, b1, "C1");

    const depth0 = h.engine.expandSubtree(treeId, trunk, { maxDepth: 0 });
    assert.deepEqual(depth0.nodes.map((n) => n.id), [trunk]);
    assert.equal(depth0.totalNodes, 1);

    const depth1 = h.engine.expandSubtree(treeId, trunk, { maxDepth: 1 });
    assert.equal(depth1.totalNodes, 4);
    assert.equal(depth1.nodes[0]?.id, trunk);

    const depth2 = h.engine.expandSubtree(treeId, trunk, { maxDepth: 2 });
    assert.equal(depth2.totalNodes, 7); // trunk + a1..a3 + b1..b3

    const all = h.engine.expandSubtree(treeId, trunk, { maxDepth: 10 });
    assert.equal(all.totalNodes, 8); // + c1

    // 截断 + 续页：limit 3 翻完全部，无重复/无空洞（BFS 序）
    const collected: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = h.engine.expandSubtree(treeId, trunk, { maxDepth: 10, limit: 3, cursor });
      collected.push(...page.nodes.map((n) => n.id));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    assert.equal(collected.length, 8);
    assert.equal(new Set(collected).size, 8);
    assert.deepEqual(collected, all.nodes.map((n) => n.id), "paged traversal must equal the single-page BFS order");

    // 从中间节点展开：相对深度 0 = 仅自身
    const fromB1 = h.engine.expandSubtree(treeId, b1, { maxDepth: 0 });
    assert.deepEqual(fromB1.nodes.map((n) => n.id), [b1]);
    const fromB1d1 = h.engine.expandSubtree(treeId, b1, { maxDepth: 1 });
    assert.equal(fromB1d1.totalNodes, 2);

    assert.throws(() => h.engine.expandSubtree(treeId, trunk, { maxDepth: -1 }), NavEngineError);
    assert.throws(() => h.engine.expandSubtree(treeId, trunk, { limit: 0 }), NavEngineError);
  } finally {
    h.close();
  }
});

/* ------------------------------------------------------------------ */
/* 定位与来源                                                           */
/* ------------------------------------------------------------------ */

test("locate: cross-tree identity, ancestors, sibling position, turn and material origins", () => {
  const h = makeHarness();
  try {
    const { treeId, trunk } = makeTree(h, "t-locate");
    const other = makeTree(h, "t-other");
    const a1 = makeTitledBranch(h, treeId, trunk, "A1 标题");
    const b1 = makeTitledBranch(h, treeId, a1, "B1 标题");
    const b2 = makeTitledBranch(h, treeId, a1, "B2 标题");

    // Turn 来源：a1 上先有 assistant 回答，b1 锚到它的选区
    const episode = h.repository.createEpisode(a1 as BranchId, { id: `${a1}-ep2` as EpisodeId });
    h.repository.createRun(
      episode.id,
      {
        sessionId: `s-${a1}-2` as PiSessionId,
        sessionFile: `t-locate/${a1}-2.jsonl`,
        entryId: `e-${a1}-2` as PiEntryId,
        piVersion: "test-1" as PiVersion,
        availability: { status: "available" },
      },
      { id: `${a1}-run2` as RunId },
    );
    const answer = "回答的全文：先界定范围，再列证据，最后回到问题本身。";
    h.repository.createTurn({
      id: `${a1}-a` as TurnId,
      treeId: treeId as TreeId,
      branchId: a1 as BranchId,
      episodeId: episode.id,
      runId: `${a1}-run2` as RunId,
      role: "assistant",
      text: answer,
      piEntryId: `${a1}-a-entry`,
    });
    h.repository.setBranchOrigin({
      branchId: b1 as BranchId,
      sourceBranchId: a1 as BranchId,
      anchorTurnId: `${a1}-a` as TurnId,
      anchorEntryId: `${a1}-a-entry`,
      selection: { start: 0, end: 6, text: answer.slice(0, 6) },
    });
    h.materialRepository.setBranchOriginKind(b1 as BranchId, "turn");

    // Material 来源：b2 锚到材料选区
    const material = makeMaterial(h, "mat-locate");
    h.materialRepository.linkTreeMaterial(treeId as TreeId, material.materialId as MaterialId);
    h.materialRepository.insertMaterialBranchOrigin({
      branchId: b2 as BranchId,
      treeId: treeId as TreeId,
      selection: {
        materialId: material.materialId as MaterialId,
        versionId: material.versionId as MaterialVersionId,
        blockId: material.blockId,
        start: material.start,
        end: material.end,
        excerpt: material.excerpt,
        sourceHash: material.sourceHash,
      },
    });

    const location = h.engine.locateBranch(b1);
    assert.equal(location.treeId, treeId);
    assert.equal(location.treeTitle, null, "tree title = trunk first user turn (trunk untitled here)");
    assert.deepEqual(location.ancestors.map((a) => a.id), [trunk, a1]);
    assert.deepEqual(location.path.map((a) => a.id), [trunk, a1, b1]);
    assert.deepEqual(location.siblingPosition, { index: 0, total: 2 });
    assert.equal(location.node.originKind, "turn");
    assert.equal(location.origin?.kind, "turn");
    if (location.origin?.kind === "turn") {
      assert.equal(location.origin.sourceBranchId, a1);
      assert.deepEqual(location.origin.selection, { start: 0, end: 6, text: answer.slice(0, 6) });
    }

    const materialLocation = h.engine.locateBranch(b2);
    assert.equal(materialLocation.node.originKind, "material");
    assert.equal(materialLocation.origin?.kind, "material");
    if (materialLocation.origin?.kind === "material") {
      assert.equal(materialLocation.origin.materialId, "mat-locate");
      assert.equal(materialLocation.origin.excerpt, material.excerpt);
    }

    // trunk 定位：无祖先/无位次/无来源
    const trunkLocation = h.engine.locateBranch(trunk);
    assert.equal(trunkLocation.ancestors.length, 0);
    assert.equal(trunkLocation.siblingPosition, null);
    assert.equal(trunkLocation.origin, null);

    // 跨树：另一棵树的分支按 id 定位到正确的树
    const otherChild = makeTitledBranch(h, other.treeId, other.trunk, "另一棵树");
    assert.equal(h.engine.locateBranch(otherChild).treeId, other.treeId);

    assert.throws(() => h.engine.locateBranch("no-such-branch"), NavEngineError);
  } finally {
    h.close();
  }
});

/* ------------------------------------------------------------------ */
/* 搜索                                                                 */
/* ------------------------------------------------------------------ */

test("branch search: exact/prefix/substring, case folding, matchedOn, tree scope, honest zero", () => {
  const h = makeHarness();
  try {
    const { treeId, trunk } = makeTree(h, "t-search");
    const other = makeTree(h, "t-search-other");
    makeTitledBranch(h, treeId, trunk, "Bayesian inference 笔记");
    makeTitledBranch(h, treeId, trunk, "bayesian 更新规则");
    makeTitledBranch(h, treeId, trunk, "关于贝叶斯的实践笔记");
    makeTitledBranch(h, other.treeId, other.trunk, "Bayesian inference 笔记");

    // exact（大小写折算）
    const exact = h.engine.searchBranches("bayesian inference 笔记", { mode: "exact" });
    assert.equal(exact.length, 2, "exact matches across trees, case-folded");
    assert.ok(exact.every((hit) => hit.matchedOn === "title"));

    // prefix（折算）：两棵树里的两条英文标题命中（中文标题不以 bayesian 开头）
    const prefix = h.engine.searchBranches("BAYESIAN", { mode: "prefix" });
    assert.equal(prefix.length, 3);

    // substring
    const substring = h.engine.searchBranches("贝叶斯", { mode: "substring" });
    assert.equal(substring.length, 1);

    // 树范围：不跨树
    const scoped = h.engine.searchBranches("bayesian", { mode: "prefix", treeId: treeId });
    assert.equal(scoped.length, 2);
    assert.ok(scoped.every((hit) => hit.treeId === treeId));
    assert.throws(() => h.engine.searchBranches("x", { treeId: "no-such-tree" }), NavEngineError);

    // 标识命中面：按分支 id 搜索（matchedOn=id）
    const all = h.engine.searchBranches("", { mode: "substring" });
    assert.equal(all.length, 0, "empty query is an honest zero");
    const byBlank = h.engine.searchBranches("   ", { mode: "substring" });
    assert.equal(byBlank.length, 0, "whitespace-only query is an honest zero");
    const firstBranch = scoped[0]!;
    const byId = h.engine.searchBranches(firstBranch.branchId, { mode: "exact", limit: 10 });
    assert.equal(byId.length, 1);
    assert.equal(byId[0]?.matchedOn, "id");

    // 无结果不编造
    assert.equal(h.engine.searchBranches("完全不存在的查询词", { mode: "substring" }).length, 0);

    // 确定性序：同输入两次搜索恒同输出
    const again = h.engine.searchBranches("bayesian", { mode: "prefix", treeId: treeId });
    assert.deepEqual(again.map((hit) => hit.branchId), scoped.map((hit) => hit.branchId));

    // 树搜索
    const trees = h.engine.searchTrees("t-search", { mode: "prefix" });
    assert.equal(trees.length, 2, "tree ids are searchable identifiers");
    assert.ok(trees.every((hit) => hit.matchedOn === "id"));
    assert.equal(h.engine.searchTrees("不存在", { mode: "exact" }).length, 0);
  } finally {
    h.close();
  }
});

test("search pagination: deterministic pages without duplicates or gaps; cursor discipline", () => {
  const h = makeHarness();
  try {
    const { treeId, trunk } = makeTree(h, "t-page");
    const other = makeTree(h, "t-page-other");
    // 7 条命中（本树 4 + 他树 3），页大小 3 → 3 页（3/3/1）
    for (let i = 1; i <= 4; i += 1) {
      makeTitledBranch(h, treeId, trunk, `分页笔记 第${String(i)}条`);
    }
    for (let i = 1; i <= 3; i += 1) {
      makeTitledBranch(h, other.treeId, other.trunk, `分页笔记 别树${String(i)}`);
    }

    const collected: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page = h.engine.searchBranchesPage("分页笔记", { mode: "substring", limit: 3, cursor });
      pages += 1;
      assert.ok(page.hits.length <= 3, "page size is bounded by the limit");
      collected.push(...page.hits.map((hit) => hit.branchId));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
      assert.ok(pages <= 10, "pagination must terminate");
    }
    assert.equal(collected.length, 7, "all 7 hits collected across pages");
    assert.equal(new Set(collected).size, 7, "no duplicates across pages");
    assert.equal(pages, 3, "7 hits at limit 3 must paginate as 3 pages (3/3/1)");

    // 分页序 === 不分页全量序（确定性全序）
    const unpaginated = h.engine.searchBranches("分页笔记", { mode: "substring", limit: 100 });
    assert.deepEqual(collected, unpaginated.map((hit) => hit.branchId));

    // 树范围 + 分页：不泄漏他树
    const scopedFirst = h.engine.searchBranchesPage("分页笔记", { mode: "substring", treeId: treeId, limit: 2 });
    assert.equal(scopedFirst.hits.length, 2);
    assert.ok(scopedFirst.hits.every((hit) => hit.treeId === treeId));
    assert.ok(scopedFirst.nextCursor !== null);
    const scopedSecond = h.engine.searchBranchesPage("分页笔记", {
      mode: "substring",
      treeId: treeId,
      limit: 2,
      cursor: scopedFirst.nextCursor,
    });
    assert.equal(scopedSecond.hits.length, 2);
    assert.equal(scopedSecond.nextCursor, null, "scoped search ends after its own hits");
    assert.ok(scopedSecond.hits.every((hit) => hit.treeId === treeId));

    // 树搜索分页：t-page 前缀命中 2 棵树
    const treePage = h.engine.searchTreesPage("t-page", { mode: "prefix", limit: 1 });
    assert.equal(treePage.hits.length, 1);
    assert.ok(treePage.nextCursor !== null);
    const treePage2 = h.engine.searchTreesPage("t-page", { mode: "prefix", limit: 1, cursor: treePage.nextCursor });
    assert.equal(treePage2.hits.length, 1);
    assert.equal(treePage2.nextCursor, null);

    // 空查询：诚实空页（游标 null）
    const empty = h.engine.searchBranchesPage("   ", { mode: "substring" });
    assert.deepEqual(empty, { hits: [], nextCursor: null });

    // 非法游标显式报错（invalid-cursor）；invalidate 后游标过期（stale-cursor）
    assert.throws(
      () => h.engine.searchBranchesPage("分页笔记", { cursor: "not-a-cursor" }),
      (e: unknown) => e instanceof NavEngineError && e.code === "invalid-cursor",
    );
    const staleSeed = h.engine.searchBranchesPage("分页笔记", { mode: "substring", limit: 2 });
    assert.ok(staleSeed.nextCursor !== null);
    h.engine.invalidate(other.treeId);
    assert.throws(
      () =>
        h.engine.searchBranchesPage("分页笔记", {
          mode: "substring",
          limit: 2,
          cursor: staleSeed.nextCursor!,
        }),
      (e: unknown) => e instanceof NavEngineError && e.code === "stale-cursor",
    );
    // 未知树（scoped）：unknown-tree
    assert.throws(
      () => h.engine.searchBranchesPage("x", { treeId: "no-such-tree" }),
      (e: unknown) => e instanceof NavEngineError && e.code === "unknown-tree",
    );
  } finally {
    h.close();
  }
});

test("same-name disambiguation: identical titles under different parents carry distinct full paths", () => {
  const h = makeHarness();
  try {
    const { treeId, trunk } = makeTree(h, "t-samename");
    const sameTitle = "完全相同的标题";
    const parentA = makeTitledBranch(h, treeId, trunk, "父 A");
    const parentB = makeTitledBranch(h, treeId, trunk, "父 B");
    const childA = makeTitledBranch(h, treeId, parentA, sameTitle);
    const childB = makeTitledBranch(h, treeId, parentB, sameTitle);
    const grandChild = makeTitledBranch(h, treeId, childA, sameTitle);

    const hits = h.engine.searchBranches(sameTitle, { mode: "exact" });
    assert.equal(hits.length, 3);
    const paths = new Set(hits.map((hit) => hit.path.map((step) => step.id).join(">")));
    assert.equal(paths.size, 3, "every same-name hit carries a distinct full path");
    const hitA = hits.find((hit) => hit.branchId === childA)!;
    assert.deepEqual(hitA.path.map((step) => step.id), [trunk, parentA, childA]);
    const hitGrand = hits.find((hit) => hit.branchId === grandChild)!;
    assert.equal(hitGrand.depth, 3);
    assert.deepEqual(hitGrand.path.map((step) => step.title), [null, "父 A", sameTitle, sameTitle]);
  } finally {
    h.close();
  }
});

/* ------------------------------------------------------------------ */
/* 空树                                                                 */
/* ------------------------------------------------------------------ */

test("empty tree: honest empty pages, single-node expansion, null title overview", () => {
  const h = makeHarness();
  try {
    const { treeId, trunk } = makeTree(h, "t-empty");
    const children = h.engine.listChildren(treeId, trunk, { limit: 25 });
    assert.equal(children.nodes.length, 0);
    assert.equal(children.nextCursor, null);
    assert.equal(children.totalChildren, 0);

    const expansion = h.engine.expandSubtree(treeId, trunk, { maxDepth: 5 });
    assert.deepEqual(expansion.nodes.map((n) => n.id), [trunk]);
    assert.equal(expansion.totalNodes, 1);

    assert.equal(h.engine.parentPath(treeId, trunk).length, 0);
    const location = h.engine.locateBranch(trunk);
    assert.equal(location.node.title, null);
    assert.equal(location.node.originKind, "none");
    const overview = h.engine.getTreeOverview(treeId);
    assert.equal(overview.nodeCount, 1);
    assert.equal(overview.maxDepth, 0);
    assert.equal(overview.title, null);
  } finally {
    h.close();
  }
});

/* ------------------------------------------------------------------ */
/* 深链（迭代结构性证明：12,000 层不触栈溢出）                            */
/* ------------------------------------------------------------------ */

test("deep chain: 12000-level parent path and locate computed iteratively (no stack overflow)", () => {
  const h = makeHarness();
  try {
    const { treeId, trunk } = makeTree(h, "t-deep");
    // 纯分支链（无 Turn——路径计算不依赖标题）
    let parent = trunk;
    const depth = 12000;
    for (let i = 1; i <= depth; i += 1) {
      parent = h.repository.createBranch(treeId as TreeId, {
        id: `deep-c${String(i).padStart(5, "0")}` as BranchId,
        parentBranchId: parent as BranchId,
      }).id;
    }
    const deepest = `deep-c${String(depth).padStart(5, "0")}`;
    const ancestors = h.engine.parentPath(treeId, deepest);
    assert.equal(ancestors.length, depth);
    assert.equal(ancestors[0]?.id, trunk);
    assert.equal(ancestors[ancestors.length - 1]?.id, `deep-c${String(depth - 1).padStart(5, "0")}`);

    const location = h.engine.locateBranch(deepest);
    assert.equal(location.path.length, depth + 1);
    assert.deepEqual(location.siblingPosition, { index: 0, total: 1 });

    // 深度受限展开：链上第 11998 层向下 2 层
    const expansion = h.engine.expandSubtree(treeId, `deep-c${String(depth - 2).padStart(5, "0")}`, { maxDepth: 2 });
    assert.equal(expansion.totalNodes, 3);
  } finally {
    h.close();
  }
});

/* ------------------------------------------------------------------ */
/* 树列表分页                                                           */
/* ------------------------------------------------------------------ */

test("tree list: paginated across forests without duplicates or gaps", () => {
  const h = makeHarness();
  try {
    const created: string[] = [];
    for (let i = 1; i <= 7; i += 1) {
      created.push(makeTree(h, `t-list-${String(i).padStart(2, "0")}`).treeId);
    }
    const collected: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = h.engine.listTrees({ limit: 3, cursor });
      assert.ok(page.trees.length <= 3);
      collected.push(...page.trees.map((tree) => tree.treeId));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    assert.equal(collected.length, 7);
    assert.equal(new Set(collected).size, 7);
    assert.deepEqual(collected, created, "tree order follows forest creation order (stable)");
    const total = h.engine.listTrees({ limit: 500 });
    assert.equal(total.totalTrees, 7);
  } finally {
    h.close();
  }
});
