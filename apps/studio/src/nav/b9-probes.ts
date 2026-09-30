/**
 * D4-8 大规模树导航 —— B9 冻结探针集 + 引擎级校验 + 性能序列（离线、确定性）。
 *
 * 覆盖（对照 tests/fixtures/d4/b9-nav/spec.json functionalProbes 的引擎侧
 * 可执行子集；DOM/虚拟化/键盘/重启状态属接线与前端增量，不在本模块）：
 *  - locate-correctness：固定探针集（六棵特殊树 + 普通树抽样）的定位/
 *    祖先链/路径/标题/兄弟位次/来源 100% 对照结构真值；
 *  - origins-100：全部 Turn/Material 来源节点逐一对照（来源定位正确率
 *    100%——失败样例保留在分母，绝不以近似节点替代）；
 *  - wide-pagination：b9-wide 根下 220 直接子枝按页翻完（无重复/无空洞/
 *    末页 nextCursor=null）；b9-big/b9-empty 分页对照；
 *  - deep-path：b9-deep 最深节点（depth 100）完整父路径迭代计算（100
 *    祖先），无栈溢出；
 *  - samename-disambiguation：66 同名节点按完整路径消歧——exact 全集
 *    恰好等于真值同名集（诱饵不混入），substring 覆盖诱饵；
 *  - search-locate：树/分支按标题与标识搜索（exact/prefix/substring、
 *    大小写折算、树范围、诚实零命中）对照真值独立复算；
 *  - empty-tree：b9-empty 诚实空页；
 *  - big-tree-shape：5000 节点树概览与深度受限展开对照真值（BFS 序）；
 *  - tree-list：100 棵树分页无重复/无空洞；
 *  - nav-p95-engine：预热后 60 次展开/切换/搜索操作（脚本化确定性顺序，
 *    覆盖 b9-big/b9-deep/b9-wide 与跨树搜索），p95 ≤ 300ms（引擎级证据，
 *    非浏览器 verdict）；
 *  - big-tree-first-open：初次打开 b9-big（索引冷构建）到可查询 ≤ 2s
 *    （引擎级；浏览器侧另测）。
 *
 * 确定性：探针集与操作序列完全由数据集派生（无随机、无时间依赖——
 * 计时不影响结果集合，只影响性能读数）。
 */

import { performance } from "node:perf_hooks";
import type { TreeNavEngine } from "./nav-engine.ts";
import {
  B9_BIG_TREE_ID,
  B9_DEEP_TREE_ID,
  B9_EMPTY_TREE_ID,
  B9_LONGTITLE_TREE_ID,
  B9_SAMENAME_TREE_ID,
  B9_SAME_NAME_TITLE,
  B9_WIDE_TREE_ID,
  type B9Dataset,
  type B9Node,
  type B9Tree,
} from "./b9-dataset.ts";

/* ------------------------------------------------------------------ */
/* 结果形状                                                             */
/* ------------------------------------------------------------------ */

export interface B9ProbeOutcome {
  readonly id: string;
  readonly status: "PASS" | "FAIL";
  readonly detail: string;
  readonly durationMs: number;
  readonly failures: readonly string[];
}

export interface B9PerfOpTiming {
  readonly opId: string;
  readonly kind: "expand" | "switch" | "page" | "search";
  readonly durationMs: number;
}

export interface B9PerfReport {
  readonly warmupMs: number;
  readonly firstOpenMs: number;
  readonly ops: readonly B9PerfOpTiming[];
  readonly opCount: number;
  readonly p95Ms: number;
  readonly medianMs: number;
  readonly maxMs: number;
}

export interface B9EngineCheckResult {
  readonly probes: readonly B9ProbeOutcome[];
  readonly perf: B9PerfReport;
  readonly pass: boolean;
  readonly passedCount: number;
  readonly failedCount: number;
}

export const B9_NAV_P95_LIMIT_MS = 300;
export const B9_BIG_FIRST_OPEN_LIMIT_MS = 2000;

/* ------------------------------------------------------------------ */
/* 真值侧辅助                                                           */
/* ------------------------------------------------------------------ */

function treeOf(dataset: B9Dataset, treeId: string): B9Tree {
  const tree = dataset.trees.find((candidate) => candidate.treeId === treeId);
  if (tree === undefined) throw new Error(`b9-probes: tree ${treeId} missing from dataset`);
  return tree;
}

function nodeOf(dataset: B9Dataset, branchId: string): { readonly tree: B9Tree; readonly node: B9Node } {
  for (const tree of dataset.trees) {
    const node = tree.nodes.find((candidate) => candidate.id === branchId);
    if (node !== undefined) return { tree, node };
  }
  throw new Error(`b9-probes: node ${branchId} missing from dataset`);
}

/** 真值子序（创建序）。 */
function truthChildren(tree: B9Tree, parentId: string): B9Node[] {
  return tree.nodes.filter((node) => node.parentId === parentId);
}

function truthNode(tree: B9Tree, branchId: string): B9Node {
  const node = tree.nodes.find((candidate) => candidate.id === branchId);
  if (node === undefined) throw new Error(`b9-probes: node ${branchId} missing from tree ${tree.treeId}`);
  return node;
}

function firstNodeWithOrigin(tree: B9Tree, kind: "turn" | "material"): B9Node | null {
  return tree.nodes.find((node) => node.originKind === kind) ?? null;
}

function ancestorsOfTruth(dataset: B9Dataset, node: B9Node): Array<{ id: string; title: string | null; depth: number }> {
  const result: Array<{ id: string; title: string | null; depth: number }> = [];
  for (const ancestorId of node.parentPath) {
    const { node: ancestor } = nodeOf(dataset, ancestorId);
    result.push({ id: ancestor.id, title: ancestor.title, depth: ancestor.depth });
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* 固定探针集（locate-correctness 的被测节点；完全由数据集派生）           */
/* ------------------------------------------------------------------ */

export function locateProbeIds(dataset: B9Dataset): string[] {
  const big = treeOf(dataset, B9_BIG_TREE_ID);
  const deep = treeOf(dataset, B9_DEEP_TREE_ID);
  const wide = treeOf(dataset, B9_WIDE_TREE_ID);
  const samename = treeOf(dataset, B9_SAMENAME_TREE_ID);
  const longtitle = treeOf(dataset, B9_LONGTITLE_TREE_ID);
  const ids: string[] = [
    // b9-big：BFS 各段 + 两种来源各一
    big.nodes[1]!.id,
    big.nodes[1000]!.id,
    big.nodes[2500]!.id,
    big.nodes[4999]!.id,
    ...(firstNodeWithOrigin(big, "turn") !== null ? [firstNodeWithOrigin(big, "turn")!.id] : []),
    ...(firstNodeWithOrigin(big, "material") !== null ? [firstNodeWithOrigin(big, "material")!.id] : []),
    // b9-deep：trunk、链中段、最深、旁枝
    deep.nodes[0]!.id,
    "b9-deep-c050",
    "b9-deep-c100",
    "b9-deep-s10",
    // b9-wide：首/中/末直接子枝 + 末孙枝
    "b9-wide-w001",
    "b9-wide-w110",
    "b9-wide-w220",
    "b9-wide-g44",
    // b9-empty：trunk
    treeOf(dataset, B9_EMPTY_TREE_ID).nodes[0]!.id,
    // b9-samename：三种深度的同名 + 诱饵
    "b9-samename-same-root-1",
    "b9-samename-same-01-1",
    "b9-samename-same-d3-1",
    "b9-samename-decoy-1",
    // b9-longtitle：脊柱与叶
    "b9-longtitle-spine-01",
    "b9-longtitle-leaf-20-4",
    // 普通树抽样：10 棵树的 trunk 或末节点
    ...["b9-tree-01", "b9-tree-12", "b9-tree-23", "b9-tree-34", "b9-tree-45", "b9-tree-56", "b9-tree-67", "b9-tree-78", "b9-tree-89", "b9-tree-94"].map(
      (treeId) => {
        const tree = treeOf(dataset, treeId);
        return tree.nodes[tree.nodes.length - 1]!.id;
      },
    ),
  ];
  return ids;
}

/* ------------------------------------------------------------------ */
/* 单探针实现                                                           */
/* ------------------------------------------------------------------ */

interface ProbeContext {
  readonly dataset: B9Dataset;
  readonly engine: TreeNavEngine;
}

function runProbe(id: string, context: ProbeContext, body: (failures: string[]) => string): B9ProbeOutcome {
  const startedAt = performance.now();
  const failures: string[] = [];
  let detail = "";
  try {
    detail = body(failures);
  } catch (error) {
    failures.push(`probe threw: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    id,
    status: failures.length === 0 ? "PASS" : "FAIL",
    detail,
    durationMs: performance.now() - startedAt,
    failures,
  };
}

function verifyLocation(context: ProbeContext, branchId: string, failures: string[], label: string): void {
  const { dataset, engine } = context;
  const { tree, node } = nodeOf(dataset, branchId);
  const location = engine.locateBranch(branchId);
  if (location.treeId !== tree.treeId) {
    failures.push(`${label}: treeId ${location.treeId} !== truth ${tree.treeId}`);
  }
  if (location.node.id !== node.id || location.node.parentBranchId !== node.parentId) {
    failures.push(`${label}: node identity mismatch`);
  }
  if (location.node.depth !== node.depth) {
    failures.push(`${label}: depth ${String(location.node.depth)} !== ${String(node.depth)}`);
  }
  if (location.node.title !== node.title) {
    failures.push(`${label}: title mismatch (engine ${JSON.stringify(location.node.title)} / truth ${JSON.stringify(node.title)})`);
  }
  const truthAncestors = ancestorsOfTruth(dataset, node);
  if (location.ancestors.length !== truthAncestors.length) {
    failures.push(`${label}: ancestors length ${String(location.ancestors.length)} !== ${String(truthAncestors.length)}`);
  } else {
    for (let i = 0; i < truthAncestors.length; i += 1) {
      const got = location.ancestors[i]!;
      const want = truthAncestors[i]!;
      if (got.id !== want.id || got.title !== want.title || got.depth !== want.depth) {
        failures.push(`${label}: ancestor[${String(i)}] ${got.id} mismatch (want ${want.id})`);
      }
    }
  }
  if (location.path.length !== truthAncestors.length + 1 || location.path[location.path.length - 1]?.id !== node.id) {
    failures.push(`${label}: full path must end at the node itself`);
  }
  // 兄弟位次
  if (node.parentId === null) {
    if (location.siblingPosition !== null) failures.push(`${label}: trunk must have null siblingPosition`);
  } else {
    const siblings = truthChildren(tree, node.parentId).map((child) => child.id);
    const position = siblings.indexOf(node.id);
    if (
      location.siblingPosition === null ||
      location.siblingPosition.index !== position ||
      location.siblingPosition.total !== siblings.length
    ) {
      failures.push(
        `${label}: siblingPosition ${JSON.stringify(location.siblingPosition)} !== truth {index:${String(position)}, total:${String(siblings.length)}}`,
      );
    }
  }
  // 来源类型标记 + 来源引用
  if (location.node.originKind !== node.originKind) {
    failures.push(`${label}: originKind ${location.node.originKind} !== ${node.originKind}`);
  }
  if (node.origin === null) {
    if (location.origin !== null) failures.push(`${label}: origin should be null`);
  } else if (location.origin === null) {
    failures.push(`${label}: origin missing`);
  } else if (node.origin.kind === "turn" && location.origin.kind === "turn") {
    if (
      location.origin.sourceBranchId !== node.origin.sourceBranchId ||
      location.origin.anchorTurnId !== node.origin.anchorTurnId ||
      location.origin.anchorEntryId !== node.origin.anchorEntryId ||
      location.origin.selection.start !== node.origin.selStart ||
      location.origin.selection.end !== node.origin.selEnd ||
      location.origin.selection.text !== node.origin.selText
    ) {
      failures.push(`${label}: turn origin ref mismatch`);
    }
  } else if (node.origin.kind === "material" && location.origin.kind === "material") {
    if (
      location.origin.materialId !== node.origin.materialId ||
      location.origin.versionId !== node.origin.versionId ||
      location.origin.blockId !== node.origin.blockId ||
      location.origin.start !== node.origin.start ||
      location.origin.end !== node.origin.end ||
      location.origin.excerpt !== node.origin.excerpt
    ) {
      failures.push(`${label}: material origin ref mismatch`);
    }
  } else {
    failures.push(`${label}: origin kind mismatch (${location.origin.kind} / ${node.origin.kind})`);
  }
}

function pageThroughChildren(
  context: ProbeContext,
  treeId: string,
  parentId: string,
  limit: number,
  failures: string[],
  label: string,
): string[] {
  const collected: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    const page = context.engine.listChildren(treeId, parentId, { limit, cursor });
    pages += 1;
    if (pages > 200) {
      failures.push(`${label}: exceeded 200 pages (pagination runaway)`);
      break;
    }
    collected.push(...page.nodes.map((node) => node.id));
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  const unique = new Set(collected);
  if (unique.size !== collected.length) {
    failures.push(`${label}: duplicates across pages (${String(collected.length - unique.size)} dup entries)`);
  }
  return collected;
}

/* ------------------------------------------------------------------ */
/* 探针集编排                                                           */
/* ------------------------------------------------------------------ */

function probeLocateCorrectness(context: ProbeContext): B9ProbeOutcome {
  return runProbe("locate-correctness", context, (failures): string => {
    const ids = locateProbeIds(context.dataset);
    for (const branchId of ids) {
      verifyLocation(context, branchId, failures, branchId);
    }
    return `${String(ids.length)}/${String(ids.length)} probe nodes located with 100% correct ancestors/path/title/position/origin`;
  });
}

function probeOrigins100(context: ProbeContext): B9ProbeOutcome {
  return runProbe("origins-100", context, (failures): string => {
    let turnCount = 0;
    let materialCount = 0;
    let checked = 0;
    for (const tree of context.dataset.trees) {
      for (const node of tree.nodes) {
        if (node.originKind === "none") continue;
        checked += 1;
        if (node.originKind === "turn") turnCount += 1;
        if (node.originKind === "material") materialCount += 1;
        verifyLocation(context, node.id, failures, `origin:${node.id}`);
        if (failures.length > 20) {
          failures.push("…(truncated, >20 origin failures)");
          return `origin verification aborted after ${String(checked)} nodes (failure cap)`;
        }
      }
    }
    return `${String(checked)}/${String(checked)} origin nodes verified 100% (turn ${String(turnCount)} + material ${String(materialCount)})`;
  });
}

function probeWidePagination(context: ProbeContext): B9ProbeOutcome {
  return runProbe("wide-pagination", context, (failures): string => {
    const wide = treeOf(context.dataset, B9_WIDE_TREE_ID);
    const truth = truthChildren(wide, wide.trunkBranchId).map((node) => node.id);
    // 翻页一：limit 25（9 页）
    const collectedA = pageThroughChildren(context, B9_WIDE_TREE_ID, wide.trunkBranchId, 25, failures, "wide/25");
    if (collectedA.length !== truth.length || collectedA.some((id, i) => id !== truth[i])) {
      failures.push(`wide/25: page sequence differs from truth (got ${String(collectedA.length)}, want ${String(truth.length)})`);
    }
    // 翻页二：limit 7（与页大小互质）
    const collectedB = pageThroughChildren(context, B9_WIDE_TREE_ID, wide.trunkBranchId, 7, failures, "wide/7");
    if (collectedB.length !== truth.length || collectedB.some((id, i) => id !== truth[i])) {
      failures.push("wide/7: page sequence differs from truth");
    }
    // 大树 trunk 分页（子数 2–5，limit 2 跨页）
    const big = treeOf(context.dataset, B9_BIG_TREE_ID);
    const bigTruth = truthChildren(big, big.trunkBranchId).map((node) => node.id);
    const bigCollected = pageThroughChildren(context, B9_BIG_TREE_ID, big.trunkBranchId, 2, failures, "big/2");
    if (bigCollected.length !== bigTruth.length || bigCollected.some((id, i) => id !== bigTruth[i])) {
      failures.push("big/2: page sequence differs from truth");
    }
    // 空树：诚实空页
    const empty = treeOf(context.dataset, B9_EMPTY_TREE_ID);
    const emptyPage = context.engine.listChildren(B9_EMPTY_TREE_ID, empty.trunkBranchId, { limit: 25 });
    if (emptyPage.nodes.length !== 0 || emptyPage.nextCursor !== null || emptyPage.totalChildren !== 0) {
      failures.push("empty: trunk children page must be honestly empty");
    }
    return `b9-wide ${String(truth.length)} root children paged at 25 and 7 per page (no dup/gap); b9-big trunk ${String(bigTruth.length)}; b9-empty honest empty page`;
  });
}

function probeDeepPath(context: ProbeContext): B9ProbeOutcome {
  return runProbe("deep-path", context, (failures): string => {
    const deep = treeOf(context.dataset, B9_DEEP_TREE_ID);
    const deepest = truthNode(deep, "b9-deep-c100");
    const ancestors = context.engine.parentPath(B9_DEEP_TREE_ID, deepest.id);
    if (ancestors.length !== 100) {
      failures.push(`deepest node ancestors: ${String(ancestors.length)} !== 100`);
    }
    const truthAncestors = ancestorsOfTruth(context.dataset, deepest);
    for (let i = 0; i < truthAncestors.length; i += 1) {
      const got = ancestors[i]!;
      const want = truthAncestors[i]!;
      if (got.id !== want.id || got.depth !== want.depth) {
        failures.push(`deep ancestor[${String(i)}]: ${got.id} !== ${want.id}`);
        break;
      }
    }
    // 完整路径（含自身）= 101
    const location = context.engine.locateBranch(deepest.id);
    if (location.path.length !== 101) {
      failures.push(`deepest locate path length ${String(location.path.length)} !== 101`);
    }
    // 链中段定位 + 深度受限展开（自链上 depth 98 向下 2 层）
    verifyLocation(context, "b9-deep-c050", failures, "b9-deep-c050");
    const expansion = context.engine.expandSubtree(B9_DEEP_TREE_ID, "b9-deep-c098", { maxDepth: 2, limit: 100 });
    if (expansion.nodes.length !== 3 || expansion.nodes[0]?.id !== "b9-deep-c098") {
      failures.push(`deep expand from c098: expected 3 nodes (c098,c099,c100), got ${String(expansion.nodes.length)}`);
    }
    return "depth-100 chain: 100 ancestors + full path (101) computed iteratively, no stack overflow; mid-chain locate + bounded expansion verified";
  });
}

function probeSamenameDisambiguation(context: ProbeContext): B9ProbeOutcome {
  return runProbe("samename-disambiguation", context, (failures): string => {
    const samename = treeOf(context.dataset, B9_SAMENAME_TREE_ID);
    const truthSame = samename.nodes.filter((node) => node.title === B9_SAME_NAME_TITLE);
    const truthDecoys = samename.nodes.filter((node) => node.title !== null && node.title.startsWith(B9_SAME_NAME_TITLE) && node.title !== B9_SAME_NAME_TITLE);
    if (truthSame.length < 50) {
      failures.push(`truth same-name count ${String(truthSame.length)} < 50 (dataset integrity)`);
    }
    // exact：命中集必须恰好等于真值同名集（不多、不少、无诱饵、无近似的「最近匹配」）
    const exactHits = context.engine.searchBranches(B9_SAME_NAME_TITLE, { mode: "exact", limit: 500 });
    const exactIds = new Set(exactHits.map((hit) => hit.branchId));
    const truthIds = new Set(truthSame.map((node) => node.id));
    if (exactIds.size !== truthIds.size || [...truthIds].some((id) => !exactIds.has(id))) {
      const missing = [...truthIds].filter((id) => !exactIds.has(id)).length;
      const extra = [...exactIds].filter((id) => !truthIds.has(id)).length;
      failures.push(`exact search: ${String(missing)} truth nodes missing, ${String(extra)} non-truth hits`);
    }
    for (const hit of exactHits) {
      if (hit.title !== B9_SAME_NAME_TITLE) {
        failures.push(`exact hit ${hit.branchId} title differs from query title`);
      }
      const { node } = nodeOf(context.dataset, hit.branchId);
      const truthPathIds = [...node.parentPath, node.id];
      if (hit.path.length !== truthPathIds.length || hit.path.some((step, i) => step.id !== truthPathIds[i])) {
        failures.push(`exact hit ${hit.branchId} path does not match truth (disambiguation payload broken)`);
      }
      if (hit.treeId !== B9_SAMENAME_TREE_ID) {
        failures.push(`exact hit ${hit.branchId} claims tree ${hit.treeId}`);
      }
    }
    // 路径两两可区分
    const pathKeys = new Set(exactHits.map((hit) => hit.path.map((step) => step.id).join(">")));
    if (pathKeys.size !== exactHits.length) {
      failures.push("same-name hits are not fully disambiguated by path (duplicate paths)");
    }
    // substring：诱饵进入、exact 集 ⊆ substring 集
    const substringHits = context.engine.searchBranches(B9_SAME_NAME_TITLE, { mode: "substring", limit: 500 });
    const substringIds = new Set(substringHits.map((hit) => hit.branchId));
    for (const decoy of truthDecoys) {
      if (!substringIds.has(decoy.id)) {
        failures.push(`decoy ${decoy.id} missing from substring results`);
      }
      if (exactIds.has(decoy.id)) {
        failures.push(`decoy ${decoy.id} leaked into exact results`);
      }
    }
    for (const id of truthIds) {
      if (!substringIds.has(id)) failures.push(`truth node ${id} missing from substring results`);
    }
    // 树范围内搜索同值
    const scoped = context.engine.searchBranches(B9_SAME_NAME_TITLE, { mode: "exact", treeId: B9_SAMENAME_TREE_ID, limit: 500 });
    if (scoped.length !== truthSame.length) {
      failures.push(`scoped exact search returned ${String(scoped.length)} !== ${String(truthSame.length)}`);
    }
    return `${String(truthSame.length)} same-titled nodes fully disambiguated by (treeId, path); exact ⊆ substring; ${String(truthDecoys.length)} decoys kept out of exact and covered by substring`;
  });
}

function probeSearchLocate(context: ProbeContext): B9ProbeOutcome {
  return runProbe("search-locate", context, (failures): string => {
    const { dataset, engine } = context;
    // —— 树搜索 ——
    const bigTree = treeOf(dataset, B9_BIG_TREE_ID);
    const bigTitleHits = engine.searchTrees(bigTree.title ?? "", { mode: "exact" });
    if (!bigTitleHits.some((hit) => hit.treeId === B9_BIG_TREE_ID && hit.matchedOn === "title")) {
      failures.push("searchTrees exact must find b9-big by its trunk title");
    }
    const prefixIdHits = engine.searchTrees("b9-", { mode: "prefix", limit: 500 });
    if (prefixIdHits.length !== dataset.trees.length) {
      failures.push(`searchTrees prefix 'b9-' found ${String(prefixIdHits.length)} !== ${String(dataset.trees.length)} trees`);
    }
    if (engine.searchTrees("不存在的树", { mode: "exact" }).length !== 0) {
      failures.push("searchTrees must return honest zero hits for unknown tree");
    }
    // 大小写折算：英文标题前缀小写查询可命中（与 search-engine 同约定）。
    // 真值集可能超过引擎单次上限（500）——按引擎的确定性结果序对照
    // 「真值过滤序的前 limit 项」（引擎序=森林序→树创建序→分支创建序，
    // 与真值 flatMap 序同构）。
    const lowerPrefix = "notes on ";
    const truthLower = dataset.trees
      .flatMap((tree) => tree.nodes.filter((node) => node.title !== null && node.title.toLowerCase().startsWith(lowerPrefix)))
      .map((node) => node.id);
    const engineLower = engine.searchBranches(lowerPrefix, { mode: "prefix", limit: 500 });
    const expectedLower = truthLower.slice(0, 500);
    if (
      engineLower.length !== expectedLower.length ||
      engineLower.some((hit, i) => hit.branchId !== expectedLower[i])
    ) {
      failures.push(`case-folded prefix search: engine ${String(engineLower.length)} vs truth prefix-500 ${String(expectedLower.length)} (truth total ${String(truthLower.length)})`);
    }
    // —— 分支搜索：子串（中文）与真值独立复算对照（同样按前 500 项对照序） ——
    const substringQuery = "笔记";
    const truthSubstring = dataset.trees
      .flatMap((tree) => tree.nodes.filter((node) => node.title !== null && node.title.includes(substringQuery)))
      .map((node) => node.id);
    const engineSubstring = engine.searchBranches(substringQuery, { mode: "substring", limit: 500 });
    const expectedSubstring = truthSubstring.slice(0, 500);
    if (
      engineSubstring.length !== expectedSubstring.length ||
      engineSubstring.some((hit, i) => hit.branchId !== expectedSubstring[i])
    ) {
      failures.push(`substring '${substringQuery}': engine ${String(engineSubstring.length)} vs truth prefix-500 ${String(expectedSubstring.length)} (truth total ${String(truthSubstring.length)})`);
    }
    // 小树全量对照（b9-deep 内含「笔记」标题的节点）：全集相等，无截断
    const deepScopedTruth = treeOf(dataset, B9_DEEP_TREE_ID)
      .nodes.filter((node) => node.title !== null && node.title.includes(substringQuery))
      .map((node) => node.id);
    const deepScopedEngine = engine.searchBranches(substringQuery, { mode: "substring", treeId: B9_DEEP_TREE_ID, limit: 500 }).map((hit) => hit.branchId);
    if (deepScopedEngine.length !== deepScopedTruth.length || deepScopedEngine.some((id, i) => id !== deepScopedTruth[i])) {
      failures.push(`deep-scoped substring: engine ${String(deepScopedEngine.length)} vs truth ${String(deepScopedTruth.length)}`);
    }
    // 长标题前缀
    const longPrefix = "长标题节点 b9-longtitle";
    const truthLong = treeOf(dataset, B9_LONGTITLE_TREE_ID).nodes.filter((node) => node.title !== null && node.title.startsWith(longPrefix));
    const engineLong = engine.searchBranches(longPrefix, { mode: "prefix", limit: 500 });
    if (engineLong.length !== truthLong.length) {
      failures.push(`long-title prefix search: ${String(engineLong.length)} !== ${String(truthLong.length)}`);
    }
    // 树范围：b9-empty 内按标题搜索诚实零命中；按 trunk id 精确定位命中
    const emptyScoped = engine.searchBranches("笔记", { mode: "substring", treeId: B9_EMPTY_TREE_ID, limit: 500 });
    if (emptyScoped.length !== 0) {
      failures.push("b9-empty scoped title search must be honest zero (trunk has no title)");
    }
    const emptyTrunk = treeOf(dataset, B9_EMPTY_TREE_ID).trunkBranchId;
    const emptyById = engine.searchBranches(emptyTrunk, { mode: "exact", treeId: B9_EMPTY_TREE_ID, limit: 10 });
    if (emptyById.length !== 1 || emptyById[0]?.matchedOn !== "id") {
      failures.push("b9-empty trunk must be locatable by its branch id");
    }
    // 空查询诚实零命中
    if (engine.searchBranches("   ", { mode: "substring" }).length !== 0) {
      failures.push("blank query must return zero hits");
    }
    return `tree search (exact/prefix/id) + branch search (exact/prefix/substring, case-folded, tree-scoped, honest zero) verified against independent truth recomputation`;
  });
}

function probeEmptyTree(context: ProbeContext): B9ProbeOutcome {
  return runProbe("empty-tree", context, (failures): string => {
    const empty = treeOf(context.dataset, B9_EMPTY_TREE_ID);
    const trunk = empty.trunkBranchId;
    const children = context.engine.listChildren(B9_EMPTY_TREE_ID, trunk, { limit: 25 });
    if (children.nodes.length !== 0 || children.nextCursor !== null || children.totalChildren !== 0) {
      failures.push("children page must be honestly empty");
    }
    const expansion = context.engine.expandSubtree(B9_EMPTY_TREE_ID, trunk, { maxDepth: 5, limit: 50 });
    if (expansion.nodes.length !== 1 || expansion.nodes[0]?.id !== trunk) {
      failures.push("subtree expansion of an empty tree must contain only the trunk");
    }
    const path = context.engine.parentPath(B9_EMPTY_TREE_ID, trunk);
    if (path.length !== 0) failures.push("trunk parent path must be empty");
    const location = context.engine.locateBranch(trunk);
    if (location.ancestors.length !== 0 || location.siblingPosition !== null || location.node.originKind !== "none" || location.node.title !== null) {
      failures.push("empty-tree trunk location must be honest (no ancestors/position/origin/title)");
    }
    const overview = context.engine.getTreeOverview(B9_EMPTY_TREE_ID);
    if (overview.nodeCount !== 1 || overview.maxDepth !== 0 || overview.title !== null) {
      failures.push("empty-tree overview must report 1 node, depth 0, null title");
    }
    return "b9-empty: honest empty children page / single-node subtree / empty path / null title overview";
  });
}

function probeBigTreeShape(context: ProbeContext): B9ProbeOutcome {
  return runProbe("big-tree-shape", context, (failures): string => {
    const big = treeOf(context.dataset, B9_BIG_TREE_ID);
    const overview = context.engine.getTreeOverview(B9_BIG_TREE_ID);
    if (overview.nodeCount !== 5000) {
      failures.push(`overview nodeCount ${String(overview.nodeCount)} !== 5000`);
    }
    const truthMaxDepth = big.nodes.reduce((max, node) => Math.max(max, node.depth), 0);
    if (overview.maxDepth !== truthMaxDepth) {
      failures.push(`overview maxDepth ${String(overview.maxDepth)} !== ${String(truthMaxDepth)}`);
    }
    // 深度受限展开（maxDepth 2，单页上限 1000）：BFS 序对照真值
    const truthSubtree = big.nodes.filter((node) => node.depth <= 2).map((node) => node.id);
    const expansion = context.engine.expandSubtree(B9_BIG_TREE_ID, big.trunkBranchId, { maxDepth: 2, limit: 1000 });
    if (expansion.nodes.length !== truthSubtree.length || expansion.nodes.some((node, i) => node.id !== truthSubtree[i])) {
      failures.push(`depth-2 subtree: engine ${String(expansion.nodes.length)} nodes vs truth ${String(truthSubtree.length)} (order-sensitive)`);
    }
    // 分页展开（maxDepth 3，limit 100）：游标翻完对照真值，无重复/无空洞
    const truthDepth3 = big.nodes.filter((node) => node.depth <= 3).map((node) => node.id);
    const collected: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = context.engine.expandSubtree(B9_BIG_TREE_ID, big.trunkBranchId, { maxDepth: 3, limit: 100, cursor });
      collected.push(...page.nodes.map((node) => node.id));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    if (collected.length !== truthDepth3.length || collected.some((id, i) => id !== truthDepth3[i])) {
      failures.push(`paged depth-3 subtree: ${String(collected.length)} collected vs truth ${String(truthDepth3.length)} (no dup/gap, order-sensitive)`);
    }
    return `b9-big overview (5000 nodes, depth ${String(truthMaxDepth)}); depth-2 subtree ${String(truthSubtree.length)} nodes exact; depth-3 paged ${String(truthDepth3.length)} nodes exact`;
  });
}

function probeTreeList(context: ProbeContext): B9ProbeOutcome {
  return runProbe("tree-list", context, (failures): string => {
    const truthIds = context.dataset.trees.map((tree) => tree.treeId);
    const collected: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = context.engine.listTrees({ limit: 40, cursor });
      collected.push(...page.trees.map((tree) => tree.treeId));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    if (collected.length !== truthIds.length || collected.some((id, i) => id !== truthIds[i])) {
      failures.push(`tree list paging: ${String(collected.length)} collected vs ${String(truthIds.length)} truth (order-sensitive, no dup/gap)`);
    }
    if (new Set(collected).size !== collected.length) {
      failures.push("tree list paging produced duplicates");
    }
    // 概览抽查：每第 10 棵树节点数对照
    for (let i = 0; i < truthIds.length; i += 10) {
      const treeId = truthIds[i]!;
      const overview = context.engine.getTreeOverview(treeId);
      const truth = treeOf(context.dataset, treeId);
      if (overview.nodeCount !== truth.nodes.length) {
        failures.push(`overview ${treeId}: nodeCount ${String(overview.nodeCount)} !== ${String(truth.nodes.length)}`);
      }
      if (overview.title !== truth.title) {
        failures.push(`overview ${treeId}: tree title mismatch`);
      }
    }
    return `100 trees paged at 40/page without dup/gap; overview spot-checks (every 10th tree) match truth`;
  });
}

/* ------------------------------------------------------------------ */
/* 性能序列（脚本化、确定性；预热后计时）                                */
/* ------------------------------------------------------------------ */

interface PerfOp {
  readonly opId: string;
  readonly kind: "expand" | "switch" | "page" | "search";
  readonly run: () => unknown;
}

export function buildPerfOps(context: ProbeContext): PerfOp[] {
  const { dataset, engine } = context;
  const big = treeOf(dataset, B9_BIG_TREE_ID);
  const ops: PerfOp[] = [];
  const add = (opId: string, kind: PerfOp["kind"], run: () => unknown): void => {
    ops.push({ opId, kind, run });
  };
  // —— b9-big：20 ops ——
  for (const index of [1, 100, 1000, 2500, 4999]) {
    const branchId = big.nodes[index]!.id;
    add(`big-children-${String(index)}`, "expand", () => engine.listChildren(B9_BIG_TREE_ID, branchId, { limit: 50 }));
  }
  for (const index of [10, 500, 1500, 3000, 4500]) {
    const branchId = big.nodes[index]!.id;
    add(`big-subtree-${String(index)}`, "expand", () => engine.expandSubtree(B9_BIG_TREE_ID, branchId, { maxDepth: 2, limit: 200 }));
  }
  for (const index of [50, 700, 1200, 2000, 4000]) {
    const branchId = big.nodes[index]!.id;
    add(`big-locate-${String(index)}`, "switch", () => engine.locateBranch(branchId));
  }
  for (const index of [200, 900, 1800, 3500, 4800]) {
    const branchId = big.nodes[index]!.id;
    add(`big-path-${String(index)}`, "switch", () => engine.parentPath(B9_BIG_TREE_ID, branchId));
  }
  // —— b9-deep：15 ops ——
  for (const depth of [25, 50, 75, 100]) {
    add(`deep-path-${String(depth)}`, "switch", () => engine.parentPath(B9_DEEP_TREE_ID, `b9-deep-c${String(depth).padStart(3, "0")}`));
  }
  add("deep-path-side", "switch", (): unknown => engine.parentPath(B9_DEEP_TREE_ID, "b9-deep-s10"));
  for (const depth of [10, 60, 100]) {
    add(`deep-locate-${String(depth)}`, "switch", () => engine.locateBranch(`b9-deep-c${String(depth).padStart(3, "0")}`));
  }
  for (const depth of [5, 25, 50, 75, 95]) {
    add(`deep-children-${String(depth)}`, "expand", () => engine.listChildren(B9_DEEP_TREE_ID, `b9-deep-c${String(depth).padStart(3, "0")}`, { limit: 50 }));
  }
  add("deep-subtree-c001", "expand", () => engine.expandSubtree(B9_DEEP_TREE_ID, "b9-deep-c001", { maxDepth: 3, limit: 100 }));
  add("deep-subtree-c090", "expand", () => engine.expandSubtree(B9_DEEP_TREE_ID, "b9-deep-c090", { maxDepth: 2, limit: 100 }));
  // —— b9-wide：20 ops（9 页逐页翻完 + 5 定位 + 2 展开分页 + 补 4 页小页） ——
  let wideCursor: string | undefined;
  for (let page = 1; page <= 9; page += 1) {
    add(`wide-page-${String(page)}`, "page", (): unknown => {
      const result = engine.listChildren(B9_WIDE_TREE_ID, "b9-wide-trunk", { limit: 25, cursor: wideCursor });
      wideCursor = result.nextCursor ?? undefined;
      return result;
    });
  }
  for (const child of ["w001", "w060", "w120", "w180", "w220"]) {
    add(`wide-locate-${child}`, "switch", () => engine.locateBranch(`b9-wide-${child}`));
  }
  add("wide-subtree-1", "expand", () => engine.expandSubtree(B9_WIDE_TREE_ID, "b9-wide-trunk", { maxDepth: 1, limit: 100 }));
  add("wide-subtree-2", "page", (): unknown => {
    const first = engine.expandSubtree(B9_WIDE_TREE_ID, "b9-wide-trunk", { maxDepth: 1, limit: 100 });
    if (first.nextCursor === null) return first;
    return engine.expandSubtree(B9_WIDE_TREE_ID, "b9-wide-trunk", { maxDepth: 1, limit: 100, cursor: first.nextCursor });
  });
  for (const child of ["w005", "w085", "w155", "w215"]) {
    add(`wide-children-${child}`, "expand", () => engine.listChildren(B9_WIDE_TREE_ID, `b9-wide-${child}`, { limit: 50 }));
  }
  // —— 搜索/切换：10 ops ——
  add("search-samename-exact", "search", () => engine.searchBranches(B9_SAME_NAME_TITLE, { mode: "exact", limit: 500 }));
  add("search-samename-substring", "search", () => engine.searchBranches(B9_SAME_NAME_TITLE, { mode: "substring", limit: 500 }));
  add("search-trees-prefix-id", "search", () => engine.searchTrees("b9-", { mode: "prefix", limit: 500 }));
  add("search-trees-prefix-title", "search", () => engine.searchTrees("B9 特殊树", { mode: "prefix", limit: 500 }));
  add("search-branch-substring-zh", "search", () => engine.searchBranches("笔记", { mode: "substring", limit: 100 }));
  add("search-branch-prefix-en", "search", () => engine.searchBranches("notes on ", { mode: "prefix", limit: 100 }));
  add("search-branch-substring-prob", "search", () => engine.searchBranches("概率", { mode: "substring", limit: 100 }));
  add("search-branch-prefix-samename", "search", () => engine.searchBranches("同名节点", { mode: "prefix", limit: 500 }));
  add("search-trees-substring-deep", "search", () => engine.searchTrees("深链", { mode: "substring", limit: 100 }));
  add("search-branch-scoped-big", "search", () => engine.searchBranches("贝叶斯", { mode: "substring", treeId: B9_BIG_TREE_ID, limit: 100 }));
  return ops;
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(fraction * sorted.length);
  const index = Math.min(sorted.length, Math.max(1, rank)) - 1;
  return sorted[index]!;
}

/* ------------------------------------------------------------------ */
/* 主入口                                                               */
/* ------------------------------------------------------------------ */

/**
 * 运行 B9 引擎级全量检查。`engine` 必须是**冷引擎**（未构建任何索引）——
 * big-tree-first-open 探针需要测量初次打开的索引冷构建。
 */
export function runB9EngineChecks(options: {
  readonly dataset: B9Dataset;
  readonly engine: TreeNavEngine;
}): B9EngineCheckResult {
  const context: ProbeContext = { dataset: options.dataset, engine: options.engine };
  const probes: B9ProbeOutcome[] = [];

  // —— big-tree-first-open：冷引擎初次打开 b9-big（索引构建 + 首页） ——
  const firstOpenStarted = performance.now();
  let firstOpenError: string | null = null;
  try {
    context.engine.listChildren(B9_BIG_TREE_ID, "b9-big-trunk", { limit: 50 });
  } catch (error) {
    firstOpenError = error instanceof Error ? error.message : String(error);
  }
  const firstOpenMs = performance.now() - firstOpenStarted;
  probes.push({
    id: "big-tree-first-open",
    status: firstOpenError === null && firstOpenMs <= B9_BIG_FIRST_OPEN_LIMIT_MS ? "PASS" : "FAIL",
    detail:
      firstOpenError === null
        ? `cold first open of b9-big (index build + first children page): ${firstOpenMs.toFixed(1)}ms (limit ${String(B9_BIG_FIRST_OPEN_LIMIT_MS)}ms, engine-level)`
        : `threw: ${firstOpenError}`,
    durationMs: firstOpenMs,
    failures:
      firstOpenError !== null
        ? [`first open threw: ${firstOpenError}`]
        : firstOpenMs > B9_BIG_FIRST_OPEN_LIMIT_MS
          ? [`first open ${firstOpenMs.toFixed(1)}ms > ${String(B9_BIG_FIRST_OPEN_LIMIT_MS)}ms`]
          : [],
  });

  // —— 正确性探针（会按需构建其余索引） ——
  probes.push(probeLocateCorrectness(context));
  probes.push(probeOrigins100(context));
  probes.push(probeWidePagination(context));
  probes.push(probeDeepPath(context));
  probes.push(probeSamenameDisambiguation(context));
  probes.push(probeSearchLocate(context));
  probes.push(probeEmptyTree(context));
  probes.push(probeBigTreeShape(context));
  probes.push(probeTreeList(context));

  // —— nav-p95-engine：预热（同一序列跑一遍，不计时）+ 正式计时 ——
  const ops = buildPerfOps(context);
  const warmupStarted = performance.now();
  for (const op of ops) {
    try {
      op.run();
    } catch (error) {
      probes.push({
        id: "nav-p95-engine",
        status: "FAIL",
        detail: `warmup op ${op.opId} threw: ${error instanceof Error ? error.message : String(error)}`,
        durationMs: 0,
        failures: [`warmup op ${op.opId} threw`],
      });
      break;
    }
  }
  const warmupMs = performance.now() - warmupStarted;
  const timings: B9PerfOpTiming[] = [];
  for (const op of ops) {
    const startedAt = performance.now();
    op.run();
    timings.push({ opId: op.opId, kind: op.kind, durationMs: performance.now() - startedAt });
  }
  const sorted = timings.map((timing) => timing.durationMs).sort((a, b) => a - b);
  const p95Ms = percentile(sorted, 0.95);
  const medianMs = percentile(sorted, 0.5);
  const maxMs = sorted[sorted.length - 1] ?? 0;
  const alreadyFailed = probes.some((probe) => probe.id === "nav-p95-engine");
  if (!alreadyFailed) {
    probes.push({
      id: "nav-p95-engine",
      status: timings.length >= 50 && p95Ms <= B9_NAV_P95_LIMIT_MS ? "PASS" : "FAIL",
      detail:
        `${String(timings.length)} scripted expand/switch/search ops (warm; b9-big/b9-deep/b9-wide + cross-tree search): ` +
        `p95 ${p95Ms.toFixed(1)}ms ≤ ${String(B9_NAV_P95_LIMIT_MS)}ms (median ${medianMs.toFixed(1)}ms, max ${maxMs.toFixed(1)}ms, warmup ${warmupMs.toFixed(0)}ms; engine-level evidence, not the browser verdict)`,
      durationMs: maxMs,
      failures: timings.length < 50 ? [`only ${String(timings.length)} ops (< 50)`] : p95Ms > B9_NAV_P95_LIMIT_MS ? [`p95 ${p95Ms.toFixed(1)}ms > ${String(B9_NAV_P95_LIMIT_MS)}ms`] : [],
    });
  }

  const passedCount = probes.filter((probe) => probe.status === "PASS").length;
  const failedCount = probes.length - passedCount;
  return {
    probes,
    perf: {
      warmupMs,
      firstOpenMs,
      ops: timings,
      opCount: timings.length,
      p95Ms,
      medianMs,
      maxMs,
    },
    pass: failedCount === 0,
    passedCount,
    failedCount,
  };
}
