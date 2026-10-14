/** invariants ownership for b9-dataset.ts; compatibility entrypoint remains one level above. */
import {
  parseMaterialSpec,
} from "./materials.ts";
import type {
  B9Dataset,
  B9Node,
  B9Tree,
} from "./model.ts";
import {
  B9_BIG_TREE_ID,
  B9_DEEP_TREE_ID,
  B9_EMPTY_TREE_ID,
  B9_LONGTITLE_TREE_ID,
  B9_SAME_NAME_TITLE,
  B9_SAMENAME_TREE_ID,
  B9_TOTAL_NON_TRUNK_BRANCHES,
  B9_TREE_COUNT,
  B9_WIDE_TREE_ID,
  BIG_TOTAL_NODES,
  DEEP_CHAIN_DEPTH,
  DEEP_SIDE_BRANCHES,
  LONGTITLE_MIN_UTF16,
} from "./policy.ts";

/* ------------------------------------------------------------------ */
/* 结构真值不变量（机械复核；返回问题清单，空 = 全部通过）                */
/* ------------------------------------------------------------------ */

export function checkB9Invariants(dataset: B9Dataset): string[] {
  const problems: string[] = [];
  const push = (message: string): void => {
    problems.push(message);
  };

  // —— 总量与树数 ——
  if (dataset.trees.length !== B9_TREE_COUNT) {
    push(`trees: expected ${String(B9_TREE_COUNT)}, got ${String(dataset.trees.length)}`);
  }
  if (dataset.totals.nonTrunkBranches !== B9_TOTAL_NON_TRUNK_BRANCHES) {
    push(`totals.nonTrunkBranches: expected ${String(B9_TOTAL_NON_TRUNK_BRANCHES)}, got ${String(dataset.totals.nonTrunkBranches)}`);
  }
  if (dataset.totals.branchRows !== B9_TREE_COUNT + B9_TOTAL_NON_TRUNK_BRANCHES) {
    push(`totals.branchRows: expected ${String(B9_TREE_COUNT + B9_TOTAL_NON_TRUNK_BRANCHES)}, got ${String(dataset.totals.branchRows)}`);
  }

  const treeIds = new Set<string>();
  const branchIds = new Set<string>();
  const byId = new Map<string, B9Node>();
  let nonTrunkSeen = 0;
  let sameNameNodes = 0;
  const sameNameParents = new Set<string>();
  let longTitleNodes = 0;

  for (const tree of dataset.trees) {
    if (treeIds.has(tree.treeId)) push(`duplicate tree id ${tree.treeId}`);
    treeIds.add(tree.treeId);
    if (tree.nodes.length === 0) {
      push(`tree ${tree.treeId} has no nodes`);
      continue;
    }
    const trunk = tree.nodes[0]!;
    if (trunk.parentId !== null) push(`tree ${tree.treeId}: nodes[0] (${trunk.id}) is not the trunk (parentId=${trunk.parentId})`);
    if (trunk.id !== tree.trunkBranchId) push(`tree ${tree.treeId}: trunkBranchId mismatch`);
    const roots = tree.nodes.filter((node) => node.parentId === null);
    if (roots.length !== 1) push(`tree ${tree.treeId}: expected exactly 1 root, got ${String(roots.length)}`);

    // 同树内 parent/深度/路径一致性 + id 全局唯一。
    const localById = new Map<string, B9Node>();
    for (const node of tree.nodes) {
      if (branchIds.has(node.id)) push(`duplicate branch id ${node.id}`);
      branchIds.add(node.id);
      localById.set(node.id, node);
      byId.set(node.id, node);
      if (node.parentId === null) {
        if (node.depth !== 0) push(`node ${node.id}: root with depth ${String(node.depth)}`);
        if (node.parentPath.length !== 0) push(`node ${node.id}: root with non-empty parentPath`);
      } else {
        nonTrunkSeen += 1;
        const parent = localById.get(node.parentId);
        if (parent === undefined) {
          push(`node ${node.id}: parent ${node.parentId} not found (or not created before child)`);
        } else {
          if (node.depth !== parent.depth + 1) {
            push(`node ${node.id}: depth ${String(node.depth)} !== parent depth + 1 (${String(parent.depth + 1)})`);
          }
          const expectedPath = [...parent.parentPath, parent.id];
          if (node.parentPath.length !== expectedPath.length || node.parentPath.some((id, i) => id !== expectedPath[i])) {
            push(`node ${node.id}: parentPath mismatch (expected ${expectedPath.join(">")})`);
          }
        }
      }
      if (node.originKind === "none" && node.origin !== null) {
        push(`node ${node.id}: originKind none but origin set`);
      }
      if (node.originKind !== "none" && node.origin === null) {
        push(`node ${node.id}: originKind ${node.originKind} but origin missing`);
      }
      if (node.origin?.kind === "turn") {
        const origin = node.origin;
        if (origin.sourceBranchId !== node.parentId) {
          push(`node ${node.id}: turn origin source ${origin.sourceBranchId} !== parent ${String(node.parentId)}`);
        }
        const source = byId.get(origin.sourceBranchId);
        if (source === undefined) {
          push(`node ${node.id}: turn origin source ${origin.sourceBranchId} unknown`);
        } else if (source.answerText === null) {
          push(`node ${node.id}: turn origin source ${origin.sourceBranchId} has no answerText`);
        } else if (
          origin.selStart < 0 || origin.selEnd > source.answerText.length || origin.selEnd <= origin.selStart ||
          source.answerText.slice(origin.selStart, origin.selEnd) !== origin.selText
        ) {
          push(`node ${node.id}: turn origin selection does not slice-match source answer`);
        }
      }
      if (node.origin?.kind === "material") {
        const origin = node.origin;
        const material = dataset.materials.find((m) => m.materialId === origin.materialId);
        if (material === undefined) {
          push(`node ${node.id}: material origin references unknown material ${origin.materialId}`);
        } else if (origin.versionId !== material.versionId) {
          push(`node ${node.id}: material origin version ${origin.versionId} !== ${material.versionId}`);
        } else {
          const parsed = parseMaterialSpec({
            materialId: material.materialId,
            title: material.title,
            filename: material.filename,
            markdown: material.markdown,
          });
          const block = parsed.blocks.find((b) => b.blockId === origin.blockId);
          if (block === undefined) {
            push(`node ${node.id}: material origin block ${origin.blockId} not in ${material.materialId}`);
          } else if (origin.start < block.start || origin.end > block.end) {
            push(`node ${node.id}: material origin range outside block ${origin.blockId}`);
          } else if (parsed.canonicalText.slice(origin.start, origin.end) !== origin.excerpt) {
            push(`node ${node.id}: material origin excerpt does not slice-match canonicalText`);
          }
        }
      }
      if (node.title === null && tree.treeId !== B9_EMPTY_TREE_ID) {
        push(`node ${node.id}: null title outside b9-empty`);
      }
      if (node.title === B9_SAME_NAME_TITLE) {
        sameNameNodes += 1;
        sameNameParents.add(node.parentId ?? "");
      }
      if (node.title !== null && node.title.length >= LONGTITLE_MIN_UTF16) {
        longTitleNodes += 1;
      }
    }
  }

  // —— 特殊树形状规则（spec.specialTrees 逐条） ——
  const special = (treeId: string): B9Tree | undefined => dataset.trees.find((tree) => tree.treeId === treeId);
  const requireTree = (treeId: string): B9Tree => {
    const tree = special(treeId);
    if (tree === undefined) push(`special tree ${treeId} missing`);
    return tree ?? { treeId, kind: "special", rule: null, title: null, trunkBranchId: "", nodes: [] };
  };

  const big = requireTree(B9_BIG_TREE_ID);
  if (big.nodes.length !== BIG_TOTAL_NODES) {
    push(`b9-big: expected ${String(BIG_TOTAL_NODES)} nodes, got ${String(big.nodes.length)}`);
  }
  const bigChildCounts = new Map<string, number>();
  for (const node of big.nodes) {
    if (node.parentId !== null) bigChildCounts.set(node.parentId, (bigChildCounts.get(node.parentId) ?? 0) + 1);
  }
  for (const [parentId, count] of bigChildCounts) {
    if (count > 5) push(`b9-big: node ${parentId} has ${String(count)} children (branching factor must be 2–5)`);
  }
  const oneChildCount = [...bigChildCounts.entries()].filter(([, count]) => count === 1).length;
  if (oneChildCount > 1) {
    push(`b9-big: ${String(oneChildCount)} nodes with exactly 1 child (only the truncated tail may have 1)`);
  }
  let previousDepth = 0;
  for (const node of big.nodes) {
    if (node.depth < previousDepth) push(`b9-big: creation order is not breadth-first (depth regression at ${node.id})`);
    previousDepth = node.depth;
  }

  const deep = requireTree(B9_DEEP_TREE_ID);
  let deepest = 0;
  for (const node of deep.nodes) {
    if (node.depth > deepest) deepest = node.depth;
  }
  if (deepest !== DEEP_CHAIN_DEPTH) {
    push(`b9-deep: max depth ${String(deepest)} !== ${String(DEEP_CHAIN_DEPTH)}`);
  }
  // 深链存在性：从最深节点沿 parentPath 走回 trunk 必须恰好 100 步。
  {
    const deepestNode = deep.nodes.find((node) => node.depth === DEEP_CHAIN_DEPTH);
    if (deepestNode === undefined) {
      push("b9-deep: no node at depth 100");
    } else if (deepestNode.parentPath.length !== DEEP_CHAIN_DEPTH) {
      push(`b9-deep: deepest node parentPath length ${String(deepestNode.parentPath.length)} !== 100`);
    }
    const sideBranches = deep.nodes.filter((node) => node.id.includes("-s"));
    if (sideBranches.length !== DEEP_SIDE_BRANCHES) {
      push(`b9-deep: expected ${String(DEEP_SIDE_BRANCHES)} side branches, got ${String(sideBranches.length)}`);
    }
  }

  const wide = requireTree(B9_WIDE_TREE_ID);
  const trunkChildren = wide.nodes.filter((node) => node.parentId === wide.trunkBranchId);
  if (trunkChildren.length < 200) {
    push(`b9-wide: trunk has ${String(trunkChildren.length)} direct children (< 200)`);
  }

  const empty = requireTree(B9_EMPTY_TREE_ID);
  if (empty.nodes.length !== 1) {
    push(`b9-empty: expected exactly 1 node, got ${String(empty.nodes.length)}`);
  }
  if (empty.nodes[0]?.title !== null) push("b9-empty: trunk must have no title (no turns)");

  const samename = requireTree(B9_SAMENAME_TREE_ID);
  const treeSameName = samename.nodes.filter((node) => node.title === B9_SAME_NAME_TITLE);
  if (treeSameName.length < 50) {
    push(`b9-samename: ${String(treeSameName.length)} same-titled nodes (< 50)`);
  }
  if (sameNameParents.size < 30) {
    push(`b9-samename: same-titled nodes spread over only ${String(sameNameParents.size)} distinct parents (< 30)`);
  }

  const longtitle = requireTree(B9_LONGTITLE_TREE_ID);
  const treeLongTitles = longtitle.nodes.filter((node) => node.title !== null && node.title.length >= LONGTITLE_MIN_UTF16);
  if (treeLongTitles.length < 100) {
    push(`b9-longtitle: ${String(treeLongTitles.length)} nodes with titles ≥200 chars (< 100)`);
  }
  if (longTitleNodes < 100) {
    push(`totals: long-title nodes across dataset = ${String(longTitleNodes)} (< 100)`);
  }

  // —— 来源混合（sourceMix）：除 b9-empty 外每棵特殊树都应两种来源兼备 ——
  for (const tree of dataset.trees) {
    if (tree.kind !== "special" || tree.treeId === B9_EMPTY_TREE_ID) continue;
    const hasTurn = tree.nodes.some((node) => node.originKind === "turn");
    const hasMaterial = tree.nodes.some((node) => node.originKind === "material");
    if (!hasTurn || !hasMaterial) {
      push(`special tree ${tree.treeId}: source mix incomplete (turn=${String(hasTurn)}, material=${String(hasMaterial)})`);
    }
  }
  if (dataset.totals.turnOrigins === 0 || dataset.totals.materialOrigins === 0) {
    push("totals: source mix must contain both turn and material origins");
  }

  if (nonTrunkSeen !== dataset.totals.nonTrunkBranches) {
    push(`internal: non-trunk count ${String(nonTrunkSeen)} !== totals.nonTrunkBranches`);
  }
  if (dataset.totals.maxDepth !== DEEP_CHAIN_DEPTH) {
    push(`totals: global max depth ${String(dataset.totals.maxDepth)} !== ${String(DEEP_CHAIN_DEPTH)} (b9-deep must be the deepest)`);
  }
  return problems;
}
