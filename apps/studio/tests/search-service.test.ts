/**
 * D4-4 找回既有思考 —— 搜索装配服务测试（issue #8 工作包 D4-4；离线、
 * 确定性、临时 SQLite 数据目录 + 真实导入流水线）。
 *
 * 覆盖（服务/装配层，HTTP 面见 search-api.test.ts；B4 冻结集执行面由
 * verify:d4 的 b4-cross-material-find 承担——那里与本处共用
 * buildSearchDocuments 的同一代码路径）：
 *  - 材料版本入索引：同材料多版本 = 多文档；oldVersion 由版本链推导
 *    （链尾 = 当前版本；链尾非 ready 时最新 ready 版仍标 old——最新导入
 *    才是材料的当前版本）；versionLabel = 链位（v1/v2）；材料命中带
 *    materialId/versionId/blockId 且 start/end 切片回查版本全文一致；
 *    共享文本当前版排序在前（createdAt 降序）；
 *  - 非 ready 版本诚实缺席（无 canonicalText 可找，不入索引）；
 *  - 批注正文 = explanation+term 拼接序（产品批注无 note 字段）且解释
 *    独有短语可找回；同短语下批注排序在对话之前（来源类型序）；
 *  - Return/Turn 覆盖：return turn 归 return 文档（不重复入 turn 文档）；
 *    展示标题约定（批注：/提问：/回答：/Return：）；
 *  - 只索引已保存产品事实 + 每请求重建（零缓存）：检索后立刻保存的新
 *    事实下一次检索即可找回；检索纯只读（快照不变，零新增产品行）；
 *  - 范围：单树快照不泄漏他树；未知树 → EntityNotFoundError（HTTP 404）；
 *    材料多树链接 ⇒ 每树各一文档；kinds/limit 透传引擎；
 *  - buildSearchDocuments 纯函数：同快照全等装配；空正文诚实跳过；
 *    explanation+term+note 拼接序（合成快照直接验证）；引用快照外的树
 *    fail-fast。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type {
  BranchId,
  IsoTimestamp,
  MaterialId,
  MaterialVersionId,
  SessionReference,
  TerminologyMode,
  TreeId,
} from "@treeai/contracts";
import { EntityNotFoundError, MaterialRepository, TreeRepository } from "@treeai/persistence";
import { MaterialImportService } from "../src/materials/import-service.ts";
import {
  buildSearchDocuments,
  SearchService,
  searchDocumentRefId,
  type SearchSnapshot,
} from "../src/search/search-service.ts";
import { cleanupDir, makeTempDataDir } from "./helpers.ts";

const ENCODER = new TextEncoder();

function utf8(text: string): Uint8Array {
  return ENCODER.encode(text);
}

/** 轮询等待条件成立（解析任务是微任务/近即时，留足余量）。 */
async function until(predicate: () => boolean, what: string, attempts = 200): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/* ------------------------------------------------------------------ */
/* 临时库 + 注入时钟（确定性 createdAt/importedAt 排序）                 */
/* ------------------------------------------------------------------ */

interface Harness {
  readonly dir: string;
  readonly treeRepository: TreeRepository;
  readonly materialRepository: MaterialRepository;
  readonly materials: MaterialImportService;
  readonly search: SearchService;
  shutdown(): void;
}

function makeHarness(): Harness {
  const dir = makeTempDataDir();
  let tick = 0;
  const now = (): IsoTimestamp =>
    new Date(Date.parse("2026-09-20T10:00:00.000Z") + (tick += 1) * 1000).toISOString();
  const treeRepository = TreeRepository.open({ path: join(dir, "treeai.db"), now });
  const materialRepository = MaterialRepository.open({ path: join(dir, "treeai.db"), now });
  const materials = new MaterialImportService({ repository: materialRepository });
  const search = new SearchService({ treeRepository, materialRepository });
  return {
    dir,
    treeRepository,
    materialRepository,
    materials,
    search,
    shutdown(): void {
      materialRepository.close();
      treeRepository.close();
      cleanupDir(dir);
    },
  };
}

function sessionRef(): SessionReference {
  return {
    sessionId: "search-test" as SessionReference["sessionId"],
    sessionFile: "/tmp/search-test-session.jsonl",
    entryId: "entry-1" as SessionReference["entryId"],
    piVersion: "0.85.1" as SessionReference["piVersion"],
    availability: { status: "available" },
  };
}

/** 直写仓储播种 Turn（user/assistant/return；确定性时钟）。 */
function seedTurn(
  repository: TreeRepository,
  input: {
    readonly treeId: TreeId;
    readonly branchId: BranchId;
    readonly role: "user" | "assistant" | "return";
    readonly text: string;
    /** role="return" 时的出处分支。 */
    readonly fromBranchId?: BranchId;
  },
): ReturnType<TreeRepository["getTurn"]> {
  const episode = repository.createEpisode(input.branchId);
  const runId =
    input.role === "return" ? null : repository.createRun(episode.id, sessionRef()).id;
  return repository.createTurn({
    treeId: input.treeId,
    branchId: input.branchId,
    episodeId: episode.id,
    runId,
    role: input.role,
    text: input.text,
    piEntryId: null,
    fromBranchId: input.role === "return" ? (input.fromBranchId ?? null) : null,
    idempotencyKey: input.role === "return" ? `idem-${episode.id}` : null,
  });
}

/** 导入材料并等待 ready（真实解析流水线）。 */
async function importReady(
  harness: Harness,
  treeId: TreeId,
  filename: string,
  bytes: Uint8Array,
): Promise<{ materialId: MaterialId; versionId: MaterialVersionId }> {
  const result = await harness.materials.importMaterial(treeId, { filename, bytes });
  await until(
    () =>
      harness.materials
        .getMaterialDetail(treeId, result.material.id)
        .versions.some((version) => version.id === result.version.id && version.parseStatus === "ready"),
    `the parse of ${filename} to become ready`,
  );
  return { materialId: result.material.id, versionId: result.version.id };
}

/* ------------------------------------------------------------------ */
/* 材料：版本链 → oldVersion / versionLabel / 命中定位                    */
/* ------------------------------------------------------------------ */

const V1_TEXT =
  "记忆化把答案存进缓存。\n\n旧句子只有第一版才有：递归深度超过一百层必然栈溢出。\n\n共享段落两版都保留。";
const V2_TEXT =
  "记忆化把答案存进缓存。\n\n新版句子替换了旧句子：改用显式栈之后不再溢出。\n\n共享段落两版都保留。";

test("material versions enter the index per version: chain-derived oldVersion/labels, positioned hits, current version ranks first on shared text", async () => {
  const harness = makeHarness();
  try {
    const forest = harness.treeRepository.createForest();
    const tree = harness.treeRepository.createTree(forest.id);
    const branch = harness.treeRepository.createBranch(tree.id);

    const v1 = await importReady(harness, tree.id, "笔记.md", utf8(V1_TEXT));
    const second = await harness.materials.addMaterialVersion(tree.id, v1.materialId, {
      filename: "笔记.md",
      bytes: utf8(V2_TEXT),
    });
    await until(
      () =>
        harness.materials
          .getMaterialDetail(tree.id, second.material.id)
          .versions.some((version) => version.id === second.version.id && version.parseStatus === "ready"),
      "the second version to become ready",
    );

    /* 快照：两版各一文档；链位标签 v1/v2；链尾（v2）为当前版本。 */
    const snapshot = harness.search.readSnapshot(tree.id);
    const versions = snapshot.materialVersions.filter((entry) => entry.materialId === v1.materialId);
    assert.equal(versions.length, 2, "one document per (tree, ready version)");
    assert.deepEqual(
      versions.map((entry) => entry.versionLabel),
      ["v1", "v2"],
      "versionLabel is the 1-based chain position",
    );
    assert.deepEqual(
      versions.map((entry) => entry.oldVersion),
      [true, false],
      "oldVersion is derived from the version chain (non-tail = old)",
    );
    assert.equal(snapshot.trees.length, 1);
    assert.equal(snapshot.trees[0]!.title, tree.id, "product trees carry no display name — the tree id is the title");

    /* v1-only 句子：命中标注 oldVersion=true，定位回 v1 全文。 */
    const stale = harness.search.search("递归深度超过一百层必然栈溢出", { treeId: tree.id });
    assert.equal(stale.length, 1);
    const staleHit = stale[0]!;
    assert.equal(staleHit.kind, "material");
    assert.equal(staleHit.oldVersion, true);
    assert.equal(staleHit.versionLabel, "v1");
    assert.equal(staleHit.versionId, v1.versionId);
    assert.equal(staleHit.materialId, v1.materialId);
    assert.equal(staleHit.blockId, "blk-1", "the hit is positioned in the block containing the sentence");
    assert.equal(staleHit.refId, searchDocumentRefId(tree.id, "material", v1.versionId));
    assert.equal(
      harness.materialRepository.getVersionContent(v1.versionId).canonicalText.slice(staleHit.start, staleHit.end),
      "递归深度超过一百层必然栈溢出",
      "start/end slice back to the query inside the v1 canonical text",
    );

    /* v2-only 句子：当前版本命中 oldVersion=false。 */
    const current = harness.search.search("改用显式栈之后不再溢出", { treeId: tree.id });
    assert.equal(current.length, 1);
    assert.equal(current[0]!.oldVersion, false);
    assert.equal(current[0]!.versionLabel, "v2");
    assert.equal(current[0]!.versionId, second.version.id);

    /* 共享文本：两版都命中，当前版（新导入）排在前。 */
    const shared = harness.search.search("共享段落两版都保留", { treeId: tree.id });
    assert.equal(shared.length, 2);
    assert.deepEqual(
      shared.map((hit) => hit.versionLabel),
      ["v2", "v1"],
      "shared text hits both versions with the current one first (createdAt descending)",
    );
    assert.equal(shared[0]!.oldVersion, false);
    assert.equal(shared[1]!.oldVersion, true);

    /* 树内检索不创建任何产品事实（浏览/搜索不创建 Turn，项目书 §4）。 */
    assert.equal(harness.treeRepository.listTurns(branch.id).length, 0);
  } finally {
    harness.shutdown();
  }
});

test("non-ready versions are honestly absent from the index; a failed chain tail still marks the last ready version old", async () => {
  const harness = makeHarness();
  try {
    const forest = harness.treeRepository.createForest();
    const tree = harness.treeRepository.createTree(forest.id);

    const v1 = await importReady(harness, tree.id, "正文.md", utf8(V1_TEXT));
    // 第二版导入非法 UTF-8 → 解析 failed（无 canonicalText 落库）。
    const failed = await harness.materials.addMaterialVersion(tree.id, v1.materialId, {
      filename: "正文.md",
      bytes: new Uint8Array([0xff, 0xfe, 0x41]),
    });
    await until(
      () =>
        harness.materials
          .getMaterialDetail(tree.id, failed.material.id)
          .versions.some((version) => version.id === failed.version.id && version.parseStatus === "failed"),
      "the invalid-utf8 version to fail",
    );

    const snapshot = harness.search.readSnapshot(tree.id);
    const versions = snapshot.materialVersions.filter((entry) => entry.materialId === v1.materialId);
    assert.equal(versions.length, 1, "only the ready version is indexed (the failed one has no canonical text)");
    assert.equal(versions[0]!.versionId, v1.versionId);
    // 链尾 = 最新导入（failed v2）——它才是材料的当前版本；v1 非链尾 ⇒ old。
    assert.equal(versions[0]!.oldVersion, true);

    const hits = harness.search.search("记忆化把答案存进缓存", { treeId: tree.id });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.oldVersion, true);
  } finally {
    harness.shutdown();
  }
});

/* ------------------------------------------------------------------ */
/* 批注 / Return / Turn                                                 */
/* ------------------------------------------------------------------ */

test("annotations are indexed as explanation+term bodies; explanation-only phrases are findable and annotations outrank turns", async () => {
  const harness = makeHarness();
  try {
    const forest = harness.treeRepository.createForest();
    const tree = harness.treeRepository.createTree(forest.id);
    const branch = harness.treeRepository.createBranch(tree.id);

    const answer = seedTurn(harness.treeRepository, {
      treeId: tree.id,
      branchId: branch.id,
      role: "assistant",
      text: "基线条件是递归函数的出口：输入小到可以直接给出答案时就不再分解。",
    });
    const annotation = harness.treeRepository.createTerminologyAnnotation({
      treeId: tree.id,
      branchId: branch.id,
      anchorTurnId: answer.id,
      selection: { start: 0, end: 4, text: "基线条件" },
      sourceHash: "test-source-hash",
      term: "基线条件",
      explanation: "基线条件（base case）是出口：输入小到直接给答案时不再分解，直接返回结果。",
      mode: "term" as TerminologyMode,
    });

    /* 解释独有短语可找回（正文含 explanation）。 */
    const byExplanation = harness.search.search("直接返回结果", { treeId: tree.id });
    assert.equal(byExplanation.length, 1);
    assert.equal(byExplanation[0]!.kind, "annotation");
    assert.equal(byExplanation[0]!.refId, searchDocumentRefId(tree.id, "annotation", annotation.id));
    assert.equal(byExplanation[0]!.title, `批注：${annotation.term}`);
    assert.equal(byExplanation[0]!.oldVersion, false);
    assert.equal(byExplanation[0]!.blockId, null);
    assert.equal(byExplanation[0]!.materialId, null);
    assert.equal(byExplanation[0]!.treeTitle, tree.id);

    /* 产品批注正文 = explanation+term（无 note 字段）。 */
    const documents = buildSearchDocuments(harness.search.readSnapshot(tree.id));
    const annotationDoc = documents.find((doc) => doc.kind === "annotation")!;
    assert.equal(annotationDoc.body, `${annotation.explanation}${annotation.term}`);

    /* 同短语的 phrase 档命中：批注（来源类型序 0）排在对话 Turn（序 2）之前。 */
    const both = harness.search.search("基线条件", { treeId: tree.id });
    assert.ok(both.length >= 2);
    assert.equal(both[0]!.kind, "annotation");
    assert.ok(both.some((hit) => hit.kind === "turn"));
  } finally {
    harness.shutdown();
  }
});

test("returns and turns are indexed (return turns are not double-indexed as turns); display titles follow the frozen convention", async () => {
  const harness = makeHarness();
  try {
    const forest = harness.treeRepository.createForest();
    const tree = harness.treeRepository.createTree(forest.id);
    const trunk = harness.treeRepository.createBranch(tree.id);
    const side = harness.treeRepository.createBranch(tree.id, { parentBranchId: trunk.id });

    const question = seedTurn(harness.treeRepository, {
      treeId: tree.id,
      branchId: side.id,
      role: "user",
      text: "为什么闭包会捕获外层变量？",
    });
    const answer = seedTurn(harness.treeRepository, {
      treeId: tree.id,
      branchId: side.id,
      role: "assistant",
      text: "闭包捕获定义点处的词法环境组合体，组合体随定义点固定。",
    });
    const returnTurn = seedTurn(harness.treeRepository, {
      treeId: tree.id,
      branchId: trunk.id,
      role: "return",
      text: "闭包组合体的三步检查：定义点、捕获表、生命周期。",
      fromBranchId: side.id,
    });

    const snapshot = harness.search.readSnapshot(tree.id);
    assert.deepEqual(
      new Set(snapshot.turns.map((turn) => turn.id)),
      new Set([question.id, answer.id]),
      "turn documents cover user/assistant turns only",
    );
    assert.deepEqual(
      snapshot.returns.map((item) => item.id),
      [returnTurn.id],
      "return documents cover the persisted role='return' turn (saved/attempted/adopted are all saved facts)",
    );
    assert.ok(snapshot.turns.find((turn) => turn.id === question.id)!.title.startsWith("提问："));
    assert.ok(snapshot.turns.find((turn) => turn.id === answer.id)!.title.startsWith("回答："));
    assert.ok(snapshot.returns[0]!.title.startsWith("Return："));

    /* 检索面：return 命中（来源类型序 1）排在 turn 命中（序 2）之前。 */
    const hits = harness.search.search("组合体", { treeId: tree.id });
    assert.deepEqual(
      hits.map((hit) => hit.kind),
      ["return", "turn"],
    );
    assert.equal(hits[0]!.refId, searchDocumentRefId(tree.id, "return", returnTurn.id));
    assert.equal(hits[0]!.oldVersion, false);
    assert.equal(hits[0]!.blockId, null);
    const returnDoc = buildSearchDocuments(snapshot).find((doc) => doc.kind === "return")!;
    assert.equal(returnDoc.body.slice(hits[0]!.start, hits[0]!.end), "组合体");
  } finally {
    harness.shutdown();
  }
});

/* ------------------------------------------------------------------ */
/* 只索引已保存产品事实 + 每请求重建（零缓存）                            */
/* ------------------------------------------------------------------ */

test("per-request rebuild (no caching): facts saved after a search are found by the next one; searching is read-only", async () => {
  const harness = makeHarness();
  try {
    const forest = harness.treeRepository.createForest();
    const tree = harness.treeRepository.createTree(forest.id);
    const branch = harness.treeRepository.createBranch(tree.id);

    assert.deepEqual(
      harness.search.search("全新批注术语的独有解释", { treeId: tree.id }),
      [],
      "nothing is fabricated before the fact exists",
    );

    const answer = seedTurn(harness.treeRepository, {
      treeId: tree.id,
      branchId: branch.id,
      role: "assistant",
      text: "全新批注术语的独有解释出现在这个回答里。",
    });
    harness.treeRepository.createTerminologyAnnotation({
      treeId: tree.id,
      branchId: branch.id,
      anchorTurnId: answer.id,
      selection: { start: 0, end: 8, text: "全新批注术语的独" },
      sourceHash: "test-source-hash",
      term: "全新批注术语",
      explanation: "全新批注术语的独有解释：下一次检索必须立刻找回（零缓存）。",
      mode: "term" as TerminologyMode,
    });

    const hits = harness.search.search("全新批注术语的独有解释", { treeId: tree.id });
    assert.equal(hits.length, 2, "the freshly saved annotation and turn are both found on the very next request");

    /* 检索纯只读：快照逐字节不变（不创建 Turn/批注/材料行）。 */
    const before = harness.search.readSnapshot(tree.id);
    harness.search.search("全新批注术语", { treeId: tree.id });
    harness.search.search("独有解释", { treeId: null });
    const after = harness.search.readSnapshot(tree.id);
    assert.deepEqual(after, before, "searching creates no product facts");
  } finally {
    harness.shutdown();
  }
});

/* ------------------------------------------------------------------ */
/* 范围：单树 / 全部树 / 未知树 / 多树链接 / kinds / limit                */
/* ------------------------------------------------------------------ */

test("scoping: a tree snapshot never leaks other trees; unknown trees throw; materials linked to several trees yield one document per tree", async () => {
  const harness = makeHarness();
  try {
    const forest = harness.treeRepository.createForest();
    const treeA = harness.treeRepository.createTree(forest.id);
    const treeB = harness.treeRepository.createTree(forest.id);

    const material = await importReady(harness, treeA.id, "共享材料.md", utf8(V1_TEXT));

    const branchB = harness.treeRepository.createBranch(treeB.id);
    const answerB = seedTurn(harness.treeRepository, {
      treeId: treeB.id,
      branchId: branchB.id,
      role: "assistant",
      text: "跨树批注的独有短语：分代回收的写屏障。",
    });
    harness.treeRepository.createTerminologyAnnotation({
      treeId: treeB.id,
      branchId: branchB.id,
      anchorTurnId: answerB.id,
      selection: { start: 0, end: 6, text: "跨树批注的独" },
      sourceHash: "test-source-hash",
      term: "写屏障",
      explanation: "分代回收的写屏障记录老年代指向新生代的引用。",
      mode: "term" as TerminologyMode,
    });

    /* 单树范围：材料只挂在 treeA——treeB 的检索找不到它。 */
    assert.deepEqual(
      harness.search.search("记忆化把答案存进缓存", { treeId: treeB.id }),
      [],
      "a scoped search never leaks another tree's material",
    );
    assert.equal(
      harness.search.search("记忆化把答案存进缓存", { treeId: treeA.id }).length,
      1,
    );

    /* 全部树范围：材料与批注都可见（「写屏障」同时命中批注解释与锚点回答，
       解释独有短语单独验证批注文档）。 */
    const all = harness.search.search("记忆化把答案存进缓存", { treeId: null });
    assert.equal(all.length, 1);
    const barrier = harness.search.search("写屏障", { treeId: null });
    assert.equal(barrier.length, 2);
    assert.ok(barrier.every((hit) => hit.treeId === treeB.id));
    assert.equal(
      harness.search.search("老年代指向新生代", { treeId: null }).length,
      1,
      "the treeB annotation is visible in the all-trees search",
    );

    /* 未知树：EntityNotFoundError（HTTP 404）。 */
    assert.throws(
      () => harness.search.search("任意", { treeId: "tree-does-not-exist" as TreeId }),
      EntityNotFoundError,
    );

    /* 材料链接到第二棵树：每树各一文档（refId 按树隔离）。 */
    harness.materialRepository.linkTreeMaterial(treeB.id, material.materialId);
    const inB = harness.search.search("记忆化把答案存进缓存", { treeId: treeB.id });
    assert.equal(inB.length, 1);
    assert.equal(inB[0]!.treeId, treeB.id);
    const bothTrees = harness.search.search("记忆化把答案存进缓存", { treeId: null });
    assert.equal(bothTrees.length, 2);
    assert.deepEqual(
      new Set(bothTrees.map((hit) => hit.treeId)),
      new Set([treeA.id, treeB.id]),
    );
    assert.deepEqual(
      new Set(bothTrees.map((hit) => hit.refId)),
      new Set([
        searchDocumentRefId(treeA.id, "material", material.versionId),
        searchDocumentRefId(treeB.id, "material", material.versionId),
      ]),
    );
  } finally {
    harness.shutdown();
  }
});

test("kinds filter and limit pass through to the engine", async () => {
  const harness = makeHarness();
  try {
    const forest = harness.treeRepository.createForest();
    const tree = harness.treeRepository.createTree(forest.id);
    const branch = harness.treeRepository.createBranch(tree.id);

    await importReady(harness, tree.id, "材料.md", utf8("组合体出现在材料正文里。\n\n第二段。"));
    const answer = seedTurn(harness.treeRepository, {
      treeId: tree.id,
      branchId: branch.id,
      role: "assistant",
      text: "组合体出现在回答正文里。",
    });
    harness.treeRepository.createTerminologyAnnotation({
      treeId: tree.id,
      branchId: branch.id,
      anchorTurnId: answer.id,
      selection: { start: 0, end: 4, text: "组合体出" },
      sourceHash: "test-source-hash",
      term: "组合体",
      explanation: "组合体出现在批注解释里。",
      mode: "term" as TerminologyMode,
    });

    const all = harness.search.search("组合体", { treeId: tree.id });
    assert.deepEqual(
      all.map((hit) => hit.kind),
      ["annotation", "turn", "material"],
    );
    assert.deepEqual(
      harness.search.search("组合体", { treeId: tree.id, kinds: ["annotation"] }).map((hit) => hit.kind),
      ["annotation"],
    );
    assert.deepEqual(
      harness.search.search("组合体", { treeId: tree.id, kinds: ["material", "turn"] }).map((hit) => hit.kind),
      ["turn", "material"],
    );
    assert.equal(harness.search.search("组合体", { treeId: tree.id, limit: 1 }).length, 1);
    assert.equal(harness.search.search("组合体", { treeId: tree.id, limit: 0 }).length, 0);
  } finally {
    harness.shutdown();
  }
});

/* ------------------------------------------------------------------ */
/* buildSearchDocuments 纯函数语义                                       */
/* ------------------------------------------------------------------ */

test("buildSearchDocuments is pure: identical snapshots assemble identically, empty bodies are skipped, note concatenation order holds, unknown trees fail fast", () => {
  const snapshot: SearchSnapshot = {
    trees: [{ treeId: "t1", title: "树一" }],
    materialVersions: [
      {
        treeId: "t1",
        materialId: "m1",
        materialTitle: "材料一",
        versionId: "mv1",
        versionLabel: "v1",
        oldVersion: false,
        canonicalText: "",
        blocks: [],
        title: "材料一",
        importedAt: "2026-09-20T10:00:00.000Z",
      },
      {
        treeId: "t1",
        materialId: "m1",
        materialTitle: "材料一",
        versionId: "mv2",
        versionLabel: "v2",
        oldVersion: true,
        canonicalText: "旧版本正文可找回。",
        blocks: [{ blockId: "blk-0", start: 0, end: 9 }],
        title: "材料一",
        importedAt: "2026-09-19T10:00:00.000Z",
      },
    ],
    annotations: [
      {
        id: "anno-1",
        treeId: "t1",
        branchId: "branch-1",
        title: "批注：术语",
        term: "术语",
        explanation: "解释在前。",
        note: "备注在后。",
        createdAt: "2026-09-21T10:00:00.000Z",
      },
    ],
    returns: [{ id: "ret-1", treeId: "t1", branchId: "branch-1", title: "Return：x", text: "Return 正文。", createdAt: "2026-09-21T11:00:00.000Z" }],
    turns: [{ id: "turn-1", treeId: "t1", branchId: "branch-1", title: "提问：x", text: "Turn 正文。", createdAt: "2026-09-21T12:00:00.000Z" }],
  };

  const documents = buildSearchDocuments(snapshot);
  assert.deepEqual(buildSearchDocuments(snapshot), documents, "the same snapshot assembles identically (pure function)");

  assert.equal(documents.length, 4, "the empty-canonicalText version is honestly skipped");
  const materialDoc = documents.find((doc) => doc.kind === "material")!;
  assert.equal(materialDoc.refId, "t1:material:mv2");
  assert.equal(materialDoc.body, "旧版本正文可找回。");
  assert.deepEqual(materialDoc.blocks, [{ blockId: "blk-0", start: 0, end: 9 }]);

  const annotationDoc = documents.find((doc) => doc.kind === "annotation")!;
  assert.equal(annotationDoc.body, "解释在前。术语备注在后。", "annotation body is explanation+term+note in the frozen truth order");

  assert.equal(documents.find((doc) => doc.kind === "return")!.refId, "t1:return:ret-1");
  assert.equal(documents.find((doc) => doc.kind === "turn")!.refId, "t1:turn:turn-1");

  /* 事实引用快照外的树 → fail-fast（调用方编程错误）。 */
  assert.throws(
    () =>
      buildSearchDocuments({
        ...snapshot,
        turns: [{ id: "orphan", treeId: "t-unknown", branchId: "branch-unknown", title: "x", text: "y", createdAt: "2026-09-21T13:00:00.000Z" }],
      }),
    /unknown or untitled tree/,
  );
});
