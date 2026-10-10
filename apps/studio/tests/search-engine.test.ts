/**
 * D4-4 找回既有思考 —— 本地确定性搜索引擎的测试面。
 *
 * 两层覆盖：
 *  1. B4 冻结集全量验证（charter §6 B4：固定 ≥40 正向 + ≥10 无结果，
 *     「至少 95% 正向查询在前 5 项找到预先指定目标；无结果不编造匹配」）：
 *     - 语料 = tests/fixtures/d4/b4-search/facts.json 的 35 条种子产品事实
 *       （3 棵树；材料片段事实经 materialKey 钉在 B1 冻结真值 canonicalText 上，
 *       构造性复核 start/end/excerpt 切片全等——与 d4-probes.ts §7 同纪律）；
 *       批注正文按真值拼接序 explanation+term+note（probes 只把
 *       text/explanation/term/note 与 canonicalText 当真值，标题不参与）；
 *     - 55 条正向查询：每条预指定目标 factId 必须出现在引擎前 5 项，且为
 *       phrase 档命中、切片/摘录可机械复核；带 treeId 的查询为当前树范围，
 *       命中不得跨树；
 *     - 12 条无结果查询：全部零命中（语料中确实不存在，不得编造）；
 *     - 附加断言：当前引擎对冻结集 55/55 全部前 5 命中（验收下限 95%，
 *       即 ⌈0.95×55⌉=53 条；任何回退都在此显式失败，不允许静默降级）。
 *  2. 单元语义：中文子串、英文整词边界（"tree" 不得命中 "street"/"trees"）、
 *     当前树/全部树范围、来源类型过滤、旧版本标注（B1 版本对 v1/v2 真值：
 *     v1-only 句子命中 oldVersion=true，v2 文本命中 false，当前版排序在前）、
 *     空查询/纯标点查询的诚实零命中、确定性（重建/序列化往返/乱序输入全等）、
 *     排序全序（phrase 档 → 来源类型 → 命中次数 → 时间 → refId）、
 *     材料命中定位（blockId/start/end/canonicalText 切片全等）、输入校验
 *     fail-fast。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalSearchEngine, SearchEngineError } from "../src/search/search-engine.ts";
import type {
  SearchDocument,
  SearchDocumentKind,
  SearchHit,
  SerializedSearchIndex,
} from "../src/search/search-engine.ts";

const B1_ROOT = fileURLToPath(new URL("../../../tests/fixtures/d4/b1-import/", import.meta.url));
const B4_ROOT = fileURLToPath(new URL("../../../tests/fixtures/d4/b4-search/", import.meta.url));

// --- fixture 装载（镜像 tests/support/verifier/d4-probes.ts 的读取面） ------

interface B1Block {
  readonly blockId: string;
  readonly kind: string;
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

interface B1Expected {
  readonly fixtureId: string;
  readonly kind: string;
  readonly normalizer: string;
  readonly canonicalText: string;
  readonly blocks: readonly B1Block[];
}

interface B1RegistryFixture {
  readonly fixtureId: string;
  readonly file: string;
  readonly expected?: string;
  readonly outcome: string;
}

interface B1Registry {
  readonly kind: string;
  readonly fixtures: readonly B1RegistryFixture[];
  readonly versionPairs?: ReadonlyArray<{
    readonly materialKey: string;
    readonly v1Expected: string;
    readonly v2Expected: string;
  }>;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function loadB1Expected(): Map<string, B1Expected> {
  const byId = new Map<string, B1Expected>();
  for (const name of ["md-registry.json", "pdf-registry.json"] as const) {
    const registry = readJson(join(B1_ROOT, name)) as B1Registry;
    for (const fixture of registry.fixtures) {
      if (fixture.outcome !== "ready" || fixture.expected === undefined) continue;
      byId.set(
        fixture.fixtureId,
        readJson(join(B1_ROOT, fixture.expected)) as B1Expected,
      );
    }
  }
  return byId;
}

function loadVersionPair(): { v1: B1Expected; v2: B1Expected } {
  const registry = readJson(join(B1_ROOT, "md-registry.json")) as B1Registry;
  const pair = registry.versionPairs?.[0];
  assert.ok(pair !== undefined, "B1 md-registry must register the version pair");
  return {
    v1: readJson(join(B1_ROOT, pair.v1Expected)) as B1Expected,
    v2: readJson(join(B1_ROOT, pair.v2Expected)) as B1Expected,
  };
}

// --- B4 语料构造（facts.json → SearchDocument[]） --------------------------

interface B4Fact {
  readonly factId: string;
  readonly kind: "material-fragment" | "annotation" | "return" | "turn";
  readonly treeId: string;
  readonly title: string;
  readonly createdAt: string;
  readonly text?: string;
  readonly explanation?: string;
  readonly term?: string;
  readonly note?: string;
  readonly materialId?: string;
  readonly materialTitle?: string;
  readonly materialKey?: string;
  readonly versionId?: string;
  readonly versionLabel?: string;
  readonly oldVersion?: boolean;
  readonly start?: number;
  readonly end?: number;
  readonly needle?: string;
  readonly excerpt?: string;
}

interface B4Tree {
  readonly treeId: string;
  readonly title: string;
  readonly createdAt: string;
  readonly facts: readonly B4Fact[];
}

interface B4PositiveQuery {
  readonly id: string;
  readonly text: string;
  readonly treeId?: string;
  readonly coverage?: readonly string[];
  readonly expect: ReadonlyArray<{ readonly factId: string }>;
}

interface B4NoResultQuery {
  readonly id: string;
  readonly text: string;
}

interface B4Queries {
  readonly positive: readonly B4PositiveQuery[];
  readonly noResult: readonly B4NoResultQuery[];
}

let b4DocumentsCache: SearchDocument[] | null = null;

/** B4 种子事实 → 引擎文档（材料片段取 B1 冻结真值 canonicalText 全文）。 */
function buildB4Documents(): SearchDocument[] {
  if (b4DocumentsCache !== null) return b4DocumentsCache;
  const expectedById = loadB1Expected();
  const factsFile = readJson(join(B4_ROOT, "facts.json")) as { trees: readonly B4Tree[] };
  const documents: SearchDocument[] = [];
  for (const tree of factsFile.trees) {
    for (const fact of tree.facts) {
      if (fact.kind === "material-fragment") {
        const expected = expectedById.get(fact.materialKey ?? "");
        assert.ok(
          expected !== undefined,
          `b4 fact ${fact.factId}: materialKey ${String(fact.materialKey)} must resolve to a ready B1 truth`,
        );
        // 构造性复核（锚点纪律，同 d4-probes §7）：切片全等，不信任手写偏移。
        assert.equal(
          expected.canonicalText.slice(fact.start ?? -1, fact.end ?? -1),
          fact.excerpt,
          `b4 fact ${fact.factId}: excerpt ≠ canonicalText.slice(start,end)`,
        );
        assert.equal(
          typeof fact.oldVersion,
          "boolean",
          `b4 fact ${fact.factId}: material-fragment must carry a boolean oldVersion`,
        );
        documents.push({
          refId: fact.factId,
          kind: "material",
          treeId: fact.treeId,
          treeTitle: tree.title,
          title: fact.title,
          body: expected.canonicalText,
          createdAt: fact.createdAt,
          materialId: fact.materialId ?? "",
          materialTitle: fact.materialTitle ?? "",
          versionId: fact.versionId ?? "",
          versionLabel: fact.versionLabel ?? "",
          oldVersion: fact.oldVersion === true,
          blocks: expected.blocks.map((b) => ({
            blockId: b.blockId,
            start: b.start,
            end: b.end,
          })),
        });
      } else if (fact.kind === "turn" || fact.kind === "return") {
        documents.push({
          refId: fact.factId,
          kind: fact.kind,
          treeId: fact.treeId,
          treeTitle: tree.title,
          title: fact.title,
          body: fact.text ?? "",
          createdAt: fact.createdAt,
        });
      } else {
        // 批注正文 = 真值拼接序 explanation+term+note（d4-probes §7 的口径）。
        documents.push({
          refId: fact.factId,
          kind: "annotation",
          treeId: fact.treeId,
          treeTitle: tree.title,
          title: fact.title,
          body: `${fact.explanation ?? ""}${fact.term ?? ""}${fact.note ?? ""}`,
          createdAt: fact.createdAt,
        });
      }
    }
  }
  b4DocumentsCache = documents;
  return documents;
}

function loadB4Queries(): B4Queries {
  return readJson(join(B4_ROOT, "queries.json")) as B4Queries;
}

// --- B4 冻结集：语料形状 ---------------------------------------------------

test("B4 corpus shape: 3 trees, 35 saved-fact documents (12 material / 11 annotation / 6 return / 6 turn)", () => {
  const documents = buildB4Documents();
  assert.equal(documents.length, 35, "frozen facts.json carries 35 facts");
  const byKind = new Map<SearchDocumentKind, number>();
  for (const doc of documents) {
    byKind.set(doc.kind, (byKind.get(doc.kind) ?? 0) + 1);
    assert.ok(doc.body.length > 0, `${doc.refId}: body must be non-empty`);
    assert.ok(doc.title.length > 0 && doc.treeId.length > 0 && doc.treeTitle.length > 0);
  }
  assert.equal(byKind.get("material"), 12);
  assert.equal(byKind.get("annotation"), 11);
  assert.equal(byKind.get("return"), 6);
  assert.equal(byKind.get("turn"), 6);
  assert.equal(new Set(documents.map((d) => d.treeId)).size, 3, "3 trees");

  const queries = loadB4Queries();
  assert.ok(queries.positive.length >= 40, "B4 frozen floor: >= 40 positives");
  assert.ok(queries.noResult.length >= 10, "B4 frozen floor: >= 10 no-result queries");
  assert.equal(queries.positive.length, 55, "currently frozen positive count");
  assert.equal(queries.noResult.length, 12, "currently frozen no-result count");
});

// --- B4 冻结集：正向查询（验收主断言） --------------------------------------

test("B4 frozen positives (55): every pre-specified target lands in the engine's top-5", () => {
  const engine = LocalSearchEngine.build(buildB4Documents());
  const docById = new Map(buildB4Documents().map((d) => [d.refId, d] as const));
  const queries = loadB4Queries();

  let inTop5 = 0;
  const misses: string[] = [];
  for (const q of queries.positive) {
    assert.ok(q.expect.length > 0, `${q.id}: expect must be non-empty`);
    const hits = engine.search(q.text, { treeId: q.treeId ?? null });
    assert.ok(hits.length > 0, `${q.id} "${q.text}" must return at least one hit`);
    if (q.treeId !== undefined) {
      for (const hit of hits) {
        assert.equal(hit.treeId, q.treeId, `${q.id}: current-tree query must not leak other trees`);
      }
    }
    const top5 = hits.slice(0, 5);
    for (const expected of q.expect) {
      const target = expected.factId;
      const rank = top5.findIndex((h) => h.refId === target);
      if (rank === -1) {
        misses.push(
          `${q.id}(target=${target}, top5=[${top5.map((h) => h.refId).join(",")}])`,
        );
        continue;
      }
      inTop5 += 1;
      const hit = top5[rank]!;
      assert.equal(
        hit.matchType,
        "phrase",
        `${q.id}: target ${target} must be a phrase-tier hit (frozen truth guarantees the substring)`,
      );
      // 切片纪律：命中区间在目标正文内逐字等于查询（大小写折算后）。
      const doc = docById.get(target)!;
      assert.equal(
        doc.body.slice(hit.start, hit.end).toLowerCase(),
        q.text.trim().toLowerCase(),
        `${q.id}: hit span must slice to the query text in ${target}`,
      );
      assert.ok(
        hit.excerpt.toLowerCase().includes(q.text.trim().toLowerCase()),
        `${q.id}: excerpt must contain the matched text`,
      );
      assert.ok(hit.title.length > 0 && hit.excerpt.length > 0 && hit.treeTitle.length > 0);
      if (hit.kind === "material") {
        assert.ok(hit.materialId !== null && hit.materialTitle !== null, `${q.id}: material hit carries material metadata`);
        assert.ok(hit.versionId !== null && hit.versionLabel !== null, `${q.id}: material hit carries version metadata`);
        assert.ok(hit.blockId !== null, `${q.id}: material hit carries blockId (B4 fragments provide block coverage)`);
      }
    }
  }

  // charter B4 下限：≥95% 正向查询前 5 命中（55 条 ⇒ ≥53）。
  assert.ok(
    inTop5 / queries.positive.length >= 0.95,
    `charter B4 floor (95%) violated: only ${String(inTop5)}/${String(queries.positive.length)} in top-5`,
  );
  // 冻结集 + 确定性引擎 ⇒ 当前实测 55/55；任何回退都应在此显式失败并回写说明。
  assert.equal(
    inTop5,
    queries.positive.length,
    `engine regressed on frozen B4 (expected 55/55 in top-5): ${misses.join("; ")}`,
  );
});

// --- B4 冻结集：无结果查询 --------------------------------------------------

test("B4 frozen no-result queries (12): zero hits, nothing fabricated", () => {
  const engine = LocalSearchEngine.build(buildB4Documents());
  for (const q of loadB4Queries().noResult) {
    const hits = engine.search(q.text);
    assert.equal(hits.length, 0, `${q.id} "${q.text}" must return zero hits (absent from the corpus)`);
  }
});

// --- B4 冻结集：跨来源与范围的抽样深检 --------------------------------------

test("B4 sample: current-tree vs all-trees scoping changes the hit set exactly", () => {
  const engine = LocalSearchEngine.build(buildB4Documents());
  // q-pos-05「双栏排版」：语料中只有 tree-b4-01 的 frag-104 含该词——范围不改变命中。
  const scoped = engine.search("双栏排版", { treeId: "tree-b4-01" });
  assert.deepEqual(scoped.map((h) => h.refId), ["frag-104"]);
  // 「词法作用域」无范围 = 跨 3 棵树命中（anno-201/frag-201/frag-105）；
  // 限定 tree-b4-02 只剩该树两条。
  const all = engine.search("词法作用域");
  assert.deepEqual(all.map((h) => h.refId), ["anno-201", "frag-105", "frag-201"]);
  const tree02 = engine.search("词法作用域", { treeId: "tree-b4-02" });
  assert.deepEqual(tree02.map((h) => h.refId), ["anno-201", "frag-201"]);
  for (const hit of all) assert.ok(hit.treeTitle.length > 0);
});

test("B4 material hits are precisely positioned in the frozen canonical text", () => {
  const engine = LocalSearchEngine.build(buildB4Documents());
  const docById = new Map(buildB4Documents().map((d) => [d.refId, d] as const));
  const hits = engine.search("recursive leap of faith");
  const frag102 = hits.find((h) => h.refId === "frag-102");
  assert.ok(frag102 !== undefined, "frag-102 (Recursion Study Notes) must hit");
  const doc = docById.get("frag-102")!;
  assert.equal(frag102.blockId, "page-1");
  assert.equal(doc.body.slice(frag102.start, frag102.end), "recursive leap of faith");
  assert.ok(frag102.excerpt.includes("recursive leap of faith"));
  assert.equal(frag102.oldVersion, false, "B4 fragments pin the current v1");
  assert.equal(frag102.versionLabel, "v1");
  assert.equal(frag102.materialId, "mat-b4-02");

  // 非材料命中：blockId/material 元信息为 null，切片仍逐字可复核。
  const turnHits = engine.search("打印缩进");
  const turn102 = turnHits.find((h) => h.refId === "turn-102");
  assert.ok(turn102 !== undefined);
  assert.equal(turnHits[0]!.refId, "turn-102", "saved turn ranks above the material hit");
  assert.equal(turn102.blockId, null);
  assert.equal(turn102.materialId, null);
  assert.equal(turn102.versionId, null);
  assert.equal(turn102.oldVersion, false);
  const turnDoc = docById.get("turn-102")!;
  assert.equal(turnDoc.body.slice(turn102.start, turn102.end), "打印缩进");
});

// --- 单元语义：中文子串 / 英文整词 ------------------------------------------

test("zh matching is substring-based: a query inside a longer sentence still hits", () => {
  const engine = LocalSearchEngine.build([
    {
      refId: "zh-1",
      kind: "turn",
      treeId: "t1",
      treeTitle: "树一",
      title: "对话",
      body: "我们相信递归假设，而不是逐层展开整个调用过程。",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    {
      refId: "zh-2",
      kind: "turn",
      treeId: "t1",
      treeTitle: "树一",
      title: "对话二",
      body: "栈帧与调用栈深度上限。",
      createdAt: "2026-01-02T00:00:00.000Z",
    },
  ]);
  const hits = engine.search("递归假设");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.refId, "zh-1");
  assert.equal(hits[0]!.matchType, "phrase");
  // 单字中文查询（子串语义，无词边界概念）。
  const single = engine.search("栈");
  assert.equal(single.length, 1);
  assert.equal(single[0]!.refId, "zh-2");
});

test("en matching is whole-word: 'tree' must not match 'street' or 'trees'", () => {
  const engine = LocalSearchEngine.build([
    {
      refId: "en-1",
      kind: "turn",
      treeId: "t1",
      treeTitle: "树一",
      title: "conversation",
      body: "The street is quiet and the trees line the road, but the tree at the corner is old.",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ]);
  assert.equal(engine.search("tree").length, 1, "whole-word 'tree' hits exactly the standalone occurrence");
  assert.equal(engine.search("tree")[0]!.start, "The street is quiet and the trees line the road, but the ".length);
  assert.equal(engine.search("street").length, 1);
  assert.equal(engine.search("trees").length, 1, "plural 'trees' is a different word, still findable as itself");
  assert.equal(engine.search("tre").length, 0, "word-internal substring is not a hit");
  assert.equal(engine.search("stree").length, 0, "substring of a present word is not a hit either");
  // 大小写折算（确定性 toLowerCase，无区域依赖）。
  const caseEngine = LocalSearchEngine.build([
    {
      refId: "en-2",
      kind: "turn",
      treeId: "t1",
      treeTitle: "树一",
      title: "Recursion",
      body: "Recursion is a way of thinking.",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ]);
  assert.equal(caseEngine.search("recursion").length, 1);
  assert.equal(caseEngine.search("RECURSION").length, 1);
  assert.equal(caseEngine.search("Recursion").length, 1);
});

// --- 单元语义：范围与类型过滤 ----------------------------------------------

test("scoping: treeId restricts to one tree; kinds filter restricts source types", () => {
  const doc = (
    refId: string,
    treeId: string,
    kind: "annotation" | "return" | "turn",
    body: string,
  ): SearchDocument => ({
    refId,
    kind,
    treeId,
    treeTitle: treeId === "t1" ? "树一" : "树二",
    title: refId,
    body,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const engine = LocalSearchEngine.build([
    doc("t1-anno", "t1", "annotation", "记忆化把答案存进缓存"),
    {
      refId: "t1-mat", kind: "material", treeId: "t1", treeTitle: "树一",
      title: "材料一", body: "记忆化的材料原文", createdAt: "2026-01-01T00:00:00.000Z",
      materialId: "m1", materialTitle: "材料一", versionId: "v1", versionLabel: "v1", oldVersion: false,
    },
    doc("t2-turn", "t2", "turn", "我们聊过记忆化"),
    doc("t2-ret", "t2", "return", "Return：记忆化的取舍"),
  ]);
  const all = engine.search("记忆化");
  assert.equal(all.length, 4);
  const t1 = engine.search("记忆化", { treeId: "t1" });
  assert.deepEqual(t1.map((h) => h.refId), ["t1-anno", "t1-mat"]);
  const t2 = engine.search("记忆化", { treeId: "t2" });
  assert.deepEqual(t2.map((h) => h.refId), ["t2-ret", "t2-turn"]);
  const annotationsOnly = engine.search("记忆化", { kinds: ["annotation"] });
  assert.deepEqual(annotationsOnly.map((h) => h.refId), ["t1-anno"]);
  const t2Returns = engine.search("记忆化", { treeId: "t2", kinds: ["return"] });
  assert.deepEqual(t2Returns.map((h) => h.refId), ["t2-ret"]);
  // limit 只截断不改序。
  assert.equal(engine.search("记忆化", { limit: 2 }).length, 2);
  assert.equal(engine.search("记忆化", { limit: 0 }).length, 0);
  assert.equal(engine.search("记忆化", { limit: 99 }).length, 4);
});

// --- 单元语义：旧版本标注（B1 版本对真值） ----------------------------------

test("old-version labeling: v1-only sentences hit with oldVersion=true; current v2 ranks first on shared text", () => {
  const { v1, v2 } = loadVersionPair();
  // 机械前置（同 d4-probes §7）：旧句在 v1 真值且 v2 已改写；v2 新文本 v1 不含。
  assert.ok(v1.canonicalText.includes("递归深度超过一百层必然栈溢出"));
  assert.ok(!v2.canonicalText.includes("递归深度超过一百层必然栈溢出"));
  assert.ok(v1.canonicalText.includes("基准数据尚未测量"));
  assert.ok(!v2.canonicalText.includes("基准数据尚未测量"));
  assert.ok(v2.canonicalText.includes("after_id=1077"));
  assert.ok(!v1.canonicalText.includes("after_id=1077"));

  const mkMaterial = (refId: string, expected: B1Expected, label: string, oldVersion: boolean, createdAt: string): SearchDocument => ({
    refId,
    kind: "material",
    treeId: "tree-vpair",
    treeTitle: "版本对照树",
    title: `API 分页设计笔记（${label}）`,
    body: expected.canonicalText,
    createdAt,
    materialId: "mat-vpair",
    materialTitle: "API 分页设计笔记",
    versionId: `mv-vpair-${label}`,
    versionLabel: label,
    oldVersion,
    blocks: expected.blocks.map((b) => ({ blockId: b.blockId, start: b.start, end: b.end })),
  });
  const engine = LocalSearchEngine.build([
    mkMaterial("vpair-v1", v1, "v1", true, "2026-09-20T00:00:00.000Z"),
    mkMaterial("vpair-v2", v2, "v2", false, "2026-09-21T00:00:00.000Z"),
  ]);

  const stale = engine.search("递归深度超过一百层必然栈溢出");
  assert.equal(stale.length, 1, "stale sentence exists only in the v1 document");
  assert.equal(stale[0]!.refId, "vpair-v1");
  assert.equal(stale[0]!.oldVersion, true, "hit on a non-current version is labeled oldVersion");
  assert.equal(stale[0]!.versionLabel, "v1");
  assert.equal(stale[0]!.versionId, "mv-vpair-v1");
  assert.ok(stale[0]!.blockId !== null, "material hit is positioned in a block");
  assert.equal(v1.canonicalText.slice(stale[0]!.start, stale[0]!.end), "递归深度超过一百层必然栈溢出");
  assert.equal(stale[0]!.excerpt.includes("递归深度超过一百层必然栈溢出"), true);

  const stale2 = engine.search("基准数据尚未测量");
  assert.equal(stale2.length, 1);
  assert.equal(stale2[0]!.oldVersion, true);

  const current = engine.search("after_id=1077");
  assert.equal(current.length, 1, "v2-only text exists only in the current version document");
  assert.equal(current[0]!.refId, "vpair-v2");
  assert.equal(current[0]!.oldVersion, false);
  assert.equal(current[0]!.versionLabel, "v2");

  // 两版共享段落：同为 phrase/material/次数一致 ⇒ createdAt 新者优先（v2 当前版）。
  const shared = engine.search("列表接口的数据量在一年内涨了两个数量级");
  assert.equal(shared.length, 2);
  assert.deepEqual(shared.map((h) => h.refId), ["vpair-v2", "vpair-v1"]);
  assert.equal(shared[0]!.oldVersion, false);
  assert.equal(shared[1]!.oldVersion, true);
});

// --- 单元语义：诚实空结果 ---------------------------------------------------

test("empty and punctuation-only queries return zero hits honestly", () => {
  const engine = LocalSearchEngine.build(buildB4Documents());
  assert.deepEqual(engine.search(""), []);
  assert.deepEqual(engine.search("   "), []);
  assert.deepEqual(engine.search("、、、"), [], "punctuation-only query has no searchable unit");
  assert.deepEqual(engine.search("？？？"), []);
  assert.deepEqual(engine.search("马卡龙烘焙温度"), [], "absent text never fabricates a match");
  assert.deepEqual(engine.search("defenestration"), []);
});

// --- 单元语义：确定性 -------------------------------------------------------

test("determinism: rebuild, serialize/restore round-trip, and reversed input order all yield identical results", () => {
  const documents = buildB4Documents();
  const queries = loadB4Queries();
  const runBattery = (engine: LocalSearchEngine): string[] => {
    const out: string[] = [];
    for (const q of queries.positive) {
      out.push(JSON.stringify(engine.search(q.text, { treeId: q.treeId ?? null })));
    }
    for (const q of queries.noResult) {
      out.push(JSON.stringify(engine.search(q.text)));
    }
    return out;
  };

  const baseline = LocalSearchEngine.build(documents);
  const rebuilt = LocalSearchEngine.build(documents);
  assert.deepEqual(runBattery(rebuilt), runBattery(baseline), "rebuilding from the same documents is bit-identical");

  // 序列化面 = 文档快照；往返（含真实 JSON 文本化）后检索全等。
  const serialized = JSON.parse(JSON.stringify(baseline.serialize())) as SerializedSearchIndex;
  const restored = LocalSearchEngine.restore(serialized);
  assert.deepEqual(restored.serialize(), baseline.serialize());
  assert.deepEqual(runBattery(restored), runBattery(baseline));

  // 输入顺序不影响结果序（排序末位 refId 全序兜底）：逆序重建全等。
  const reversed = LocalSearchEngine.build([...documents].reverse());
  assert.deepEqual(runBattery(reversed), runBattery(baseline));
});

// --- 单元语义：排序全序 -----------------------------------------------------

test("ranking: phrase tier beats kind; kind order annotation<return<turn<material; then matchCount, recency, refId", () => {
  const turn = (refId: string, body: string, createdAt: string): SearchDocument => ({
    refId, kind: "turn", treeId: "t1", treeTitle: "树一", title: refId, body, createdAt,
  });
  // phrase 档优先于来源类型：material 的整串命中排在 annotation 的分段命中之前。
  const tierEngine = LocalSearchEngine.build([
    {
      refId: "mat-phrase", kind: "material", treeId: "t1", treeTitle: "树一",
      title: "材料", body: "the recursive leap of faith is the core habit",
      createdAt: "2026-01-01T00:00:00.000Z",
      materialId: "m1", materialTitle: "材料一", versionId: "v1", versionLabel: "v1", oldVersion: false,
    },
    {
      refId: "anno-segments", kind: "annotation", treeId: "t1", treeTitle: "树一",
      title: "批注", body: "recursive tools help; a leap of faith in tests means trusting the helper.",
      createdAt: "2026-01-02T00:00:00.000Z",
    },
  ]);
  const tierHits = tierEngine.search("recursive leap of faith");
  assert.deepEqual(
    tierHits.map((h) => h.refId),
    ["mat-phrase", "anno-segments"],
    "exact-phrase presence outranks the targeted kind",
  );
  assert.equal(tierHits[0]!.matchType, "phrase");
  assert.equal(tierHits[1]!.matchType, "segments");

  // 同为 phrase：annotation < return < turn < material。
  const kindEngine = LocalSearchEngine.build([
    turn("k-turn", "打印缩进是调试递归的技巧", "2026-01-04T00:00:00.000Z"),
    {
      refId: "k-mat", kind: "material", treeId: "t1", treeTitle: "树一",
      title: "材料", body: "打印缩进：进入函数时输出前缀",
      createdAt: "2026-01-05T00:00:00.000Z",
      materialId: "m1", materialTitle: "材料一", versionId: "v1", versionLabel: "v1", oldVersion: false,
    },
    {
      refId: "k-anno", kind: "annotation", treeId: "t1", treeTitle: "树一",
      title: "批注", body: "打印缩进，观察进出节奏",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    {
      refId: "k-ret", kind: "return", treeId: "t1", treeTitle: "树一",
      title: "Return", body: "Return：打印缩进调试法",
      createdAt: "2026-01-02T00:00:00.000Z",
    },
  ]);
  assert.deepEqual(
    kindEngine.search("打印缩进").map((h) => h.refId),
    ["k-anno", "k-ret", "k-turn", "k-mat"],
  );

  // 同档同类型：命中次数多者优先，其次新者优先，最后 refId 升序兜底。
  const tieEngine = LocalSearchEngine.build([
    turn("count-1", "缩进一次", "2026-01-01T00:00:00.000Z"),
    turn("count-2", "缩进两次：先缩进再缩进", "2026-01-01T00:00:00.000Z"),
    turn("old-doc", "折返点在缩进处", "2026-01-01T00:00:00.000Z"),
    turn("new-doc", "折返点在缩进处", "2026-06-01T00:00:00.000Z"),
    turn("zzz-tie", "锚定在缩进处", "2026-06-01T00:00:00.000Z"),
    turn("aaa-tie", "锚定在缩进处", "2026-06-01T00:00:00.000Z"),
  ]);
  assert.deepEqual(
    tieEngine.search("缩进").map((h) => h.refId),
    // count-2 三次命中居首；其余同为一次 ⇒ 新时间在前（06-01 组），组内 refId 升序。
    ["count-2", "aaa-tie", "new-doc", "zzz-tie", "count-1", "old-doc"],
    "matchCount, then recency, then refId",
  );
  assert.deepEqual(
    tieEngine.search("折返点在缩进处").map((h) => h.refId),
    ["new-doc", "old-doc"],
    "recency breaks count ties (later createdAt first)",
  );
  assert.deepEqual(
    tieEngine.search("锚定在缩进处").map((h) => h.refId),
    ["aaa-tie", "zzz-tie"],
    "refId ascending is the final deterministic anchor",
  );
});

// --- 单元语义：混合查询的分段召回 ------------------------------------------

test("mixed zh/latin query: contiguous phrase ranks above scattered segment hits, both are returned", () => {
  const engine = LocalSearchEngine.build([
    {
      refId: "mixed-contig", kind: "turn", treeId: "t1", treeTitle: "树一",
      title: "contiguous", body: "UTF-16 里高代理 D840 打头、低代理收尾，合称代理对。",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    {
      refId: "mixed-scatter", kind: "turn", treeId: "t1", treeTitle: "树一",
      title: "scattered", body: "高代理区的字符很罕见；而 D840 是它的高代理前缀。",
      createdAt: "2026-01-02T00:00:00.000Z",
    },
  ]);
  const hits = engine.search("高代理 D840");
  assert.equal(hits.length, 2);
  assert.equal(hits[0]!.refId, "mixed-contig");
  assert.equal(hits[0]!.matchType, "phrase");
  assert.equal(hits[1]!.refId, "mixed-scatter");
  assert.equal(hits[1]!.matchType, "segments");
});

// --- 输入校验（fail-fast） --------------------------------------------------

test("invalid documents and query options fail fast with SearchEngineError", () => {
  const searchError = (re: RegExp): ((err: unknown) => boolean) => (err) =>
    err instanceof SearchEngineError && re.test(err.message);
  const turn = (refId: string, body: string): SearchDocument => ({
    refId, kind: "turn", treeId: "t1", treeTitle: "树一", title: refId, body,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  assert.throws(
    () => LocalSearchEngine.build([turn("dup", "甲"), turn("dup", "乙")]),
    searchError(/duplicate refId/),
  );
  assert.throws(
    () =>
      LocalSearchEngine.build([
        {
          refId: "bad-mat", kind: "material", treeId: "t1", treeTitle: "树一",
          title: "材料", body: "正文", createdAt: "2026-01-01T00:00:00.000Z",
          materialId: "m1", materialTitle: "材料", versionLabel: "v1", oldVersion: false,
        } as unknown as SearchDocument, // 校验路径：故意缺 versionId 的非法输入
      ]),
    searchError(/requires non-empty versionId/),
  );
  assert.throws(
    () =>
      LocalSearchEngine.build([
        {
          refId: "bad-block", kind: "material", treeId: "t1", treeTitle: "树一",
          title: "材料", body: "正文", createdAt: "2026-01-01T00:00:00.000Z",
          materialId: "m1", materialTitle: "材料", versionId: "v1", versionLabel: "v1", oldVersion: false,
          blocks: [{ blockId: "blk-0", start: 0, end: 999 }],
        },
      ]),
    searchError(/out of body bounds/),
  );
  assert.throws(
    () => LocalSearchEngine.build([turn("empty-body", "")]),
    searchError(/body must be a non-empty string/),
  );
  assert.throws(
    () => LocalSearchEngine.restore({ version: 2 as never, documents: [] }),
    searchError(/version: 1/),
  );

  const engine = LocalSearchEngine.build([turn("ok", "正文内容")]);
  assert.throws(() => engine.search("正文", { kinds: [] }), searchError(/non-empty/));
  assert.throws(
    () => engine.search("正文", { kinds: ["bogus" as unknown as SearchDocumentKind] }),
    searchError(/unknown kind/),
  );
  assert.throws(() => engine.search("正文", { limit: -1 }), searchError(/limit/));
  assert.throws(
    () => engine.search(42 as unknown as string),
    searchError(/query text must be a string/),
  );
});

// B6 rebuild optimization must not turn posting deduplication into hit-count deduplication.
test("repeated CJK grams and Latin words keep original hit offsets and match counts", () => {
  const docs: SearchDocument[] = [
    {
      refId: "many", kind: "turn", treeId: "t1", treeTitle: "Tree",
      title: "Repeated", body: "回归回归回归 tree tree tree",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    {
      refId: "once", kind: "turn", treeId: "t1", treeTitle: "Tree",
      title: "Single", body: "回归 tree",
      createdAt: "2026-01-02T00:00:00.000Z",
    },
  ];
  const engine = LocalSearchEngine.build(docs);
  for (const query of ["回归", "tree"]) {
    const hits = engine.search(query);
    assert.deepEqual(hits.map((hit) => hit.refId), ["many", "once"]);
    assert.deepEqual(hits.map((hit) => hit.matchCount), [3, 1]);
    assert.deepEqual(hits.map((hit) => hit.start), [query === "回归" ? 0 : 7, query === "回归" ? 0 : 3]);
    assert.deepEqual(
      LocalSearchEngine.restore(engine.serialize()).search(query),
      hits,
      "fresh rebuild and serialization round-trip must preserve exact results",
    );
  }
});
