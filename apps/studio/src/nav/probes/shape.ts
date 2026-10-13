/** shape ownership for b9-probes.ts; compatibility entrypoint remains one level above. */
import {
  B9_BIG_TREE_ID,
  B9_EMPTY_TREE_ID,
} from "../b9-dataset.ts";
import type {
  B9ProbeOutcome,
  ProbeContext,
} from "./model.ts";
import {
  runProbe,
} from "./observation.ts";
import {
  treeOf,
} from "./truth.ts";

export function probeEmptyTree(context: ProbeContext): B9ProbeOutcome {
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

export function probeBigTreeShape(context: ProbeContext): B9ProbeOutcome {
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

export function probeTreeList(context: ProbeContext): B9ProbeOutcome {
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
