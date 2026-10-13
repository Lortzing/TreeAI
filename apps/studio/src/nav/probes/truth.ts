/** truth ownership for b9-probes.ts; compatibility entrypoint remains one level above. */
import {
  B9_BIG_TREE_ID,
  B9_DEEP_TREE_ID,
  B9_EMPTY_TREE_ID,
  B9_LONGTITLE_TREE_ID,
  B9_SAMENAME_TREE_ID,
  B9_WIDE_TREE_ID,
  type B9Dataset,
  type B9Node,
  type B9Tree,
} from "../b9-dataset.ts";

/* ------------------------------------------------------------------ */
/* 真值侧辅助                                                           */
/* ------------------------------------------------------------------ */

export function treeOf(dataset: B9Dataset, treeId: string): B9Tree {
  const tree = dataset.trees.find((candidate) => candidate.treeId === treeId);
  if (tree === undefined) throw new Error(`b9-probes: tree ${treeId} missing from dataset`);
  return tree;
}

export function nodeOf(dataset: B9Dataset, branchId: string): { readonly tree: B9Tree; readonly node: B9Node } {
  for (const tree of dataset.trees) {
    const node = tree.nodes.find((candidate) => candidate.id === branchId);
    if (node !== undefined) return { tree, node };
  }
  throw new Error(`b9-probes: node ${branchId} missing from dataset`);
}

/** 真值子序（创建序）。 */
export function truthChildren(tree: B9Tree, parentId: string): B9Node[] {
  return tree.nodes.filter((node) => node.parentId === parentId);
}

export function truthNode(tree: B9Tree, branchId: string): B9Node {
  const node = tree.nodes.find((candidate) => candidate.id === branchId);
  if (node === undefined) throw new Error(`b9-probes: node ${branchId} missing from tree ${tree.treeId}`);
  return node;
}

export function firstNodeWithOrigin(tree: B9Tree, kind: "turn" | "material"): B9Node | null {
  return tree.nodes.find((node) => node.originKind === kind) ?? null;
}

export function ancestorsOfTruth(dataset: B9Dataset, node: B9Node): Array<{ id: string; title: string | null; depth: number }> {
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
