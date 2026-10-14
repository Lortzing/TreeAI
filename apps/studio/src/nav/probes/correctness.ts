/** correctness ownership for b9-probes.ts; compatibility entrypoint remains one level above. */
import {
  B9_BIG_TREE_ID,
  B9_DEEP_TREE_ID,
  B9_EMPTY_TREE_ID,
  B9_LONGTITLE_TREE_ID,
  B9_SAME_NAME_TITLE,
  B9_SAMENAME_TREE_ID,
  B9_WIDE_TREE_ID,
} from "../b9-dataset.ts";
import {
  pageThroughChildren,
  verifyLocation,
} from "./location.ts";
import type {
  B9ProbeOutcome,
  ProbeContext,
} from "./model.ts";
import {
  runProbe,
} from "./observation.ts";
import {
  ancestorsOfTruth,
  locateProbeIds,
  nodeOf,
  treeOf,
  truthChildren,
  truthNode,
} from "./truth.ts";

/* ------------------------------------------------------------------ */
/* 探针集编排                                                           */
/* ------------------------------------------------------------------ */

export function probeLocateCorrectness(context: ProbeContext): B9ProbeOutcome {
  return runProbe("locate-correctness", context, (failures): string => {
    const ids = locateProbeIds(context.dataset);
    for (const branchId of ids) {
      verifyLocation(context, branchId, failures, branchId);
    }
    return `${String(ids.length)}/${String(ids.length)} probe nodes located with 100% correct ancestors/path/title/position/origin`;
  });
}

export function probeOrigins100(context: ProbeContext): B9ProbeOutcome {
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

export function probeWidePagination(context: ProbeContext): B9ProbeOutcome {
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

export function probeDeepPath(context: ProbeContext): B9ProbeOutcome {
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

export function probeSamenameDisambiguation(context: ProbeContext): B9ProbeOutcome {
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

export function probeSearchLocate(context: ProbeContext): B9ProbeOutcome {
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
