/** plan ownership for nav-probes.mjs; compatibility entrypoint remains one level above. */
import {
  B9_BIG_TREE_ID,
  B9_DEEP_TREE_ID,
  B9_WIDE_TREE_ID,
} from "../../../../apps/studio/src/nav/b9-dataset.ts";

/* ------------------------------------------------------------------ */
/* 操作计划（全部由结构真值派生——确定性，无随机）                        */
/* ------------------------------------------------------------------ */

export function buildOpPlan(dataset) {
  const treeOf = (treeId) => {
    const tree = dataset.trees.find((candidate) => candidate.treeId === treeId);
    if (tree === undefined) throw new Error(`nav probe: tree ${treeId} missing from the dataset`);
    return tree;
  };
  const childrenOf = (tree, parentId) => tree.nodes.filter((node) => node.parentId === parentId);
  const ops = [];

  /* —— 相 A：b9-big（BFS 展开 + 选中 + 收起/缓存重展开）—— */
  const big = treeOf(B9_BIG_TREE_ID);
  ops.push({ kind: "treeOpen", tree: B9_BIG_TREE_ID });
  ops.push({ kind: "expand", tree: B9_BIG_TREE_ID, node: big.trunkBranchId, firstChild: childrenOf(big, big.trunkBranchId)[0]?.id ?? null });
  const bfsQueue = [...childrenOf(big, big.trunkBranchId)];
  const expandTargets = [];
  while (expandTargets.length < 12 && bfsQueue.length > 0) {
    const node = bfsQueue.shift();
    const children = childrenOf(big, node.id);
    if (children.length > 0) expandTargets.push(node);
    for (const child of children) bfsQueue.push(child);
  }
  for (const [index, node] of expandTargets.slice(0, 8).entries()) {
    ops.push({ kind: "expand", tree: B9_BIG_TREE_ID, node: node.id, firstChild: childrenOf(big, node.id)[0]?.id ?? null });
    ops.push({ kind: "select", tree: B9_BIG_TREE_ID, node: node.id, sampleRowAssert: index % 3 === 0 });
  }
  for (const node of expandTargets.slice(0, 5)) {
    ops.push({ kind: "collapse", tree: B9_BIG_TREE_ID, node: node.id, firstChild: childrenOf(big, node.id)[0]?.id ?? null });
    ops.push({ kind: "expand", tree: B9_BIG_TREE_ID, node: node.id, firstChild: childrenOf(big, node.id)[0]?.id ?? null, note: "cached reload (already-stored local nodes)" });
  }
  ops.push({ kind: "select", tree: B9_BIG_TREE_ID, node: big.trunkBranchId });

  /* —— 相 B：跨树切换（b9-deep 打开 + 首层）—— */
  const deep = treeOf(B9_DEEP_TREE_ID);
  const deepFirstChild = childrenOf(deep, deep.trunkBranchId)[0];
  ops.push({ kind: "treeOpen", tree: B9_DEEP_TREE_ID });
  ops.push({ kind: "expand", tree: B9_DEEP_TREE_ID, node: deep.trunkBranchId, firstChild: deepFirstChild?.id ?? null });
  ops.push({ kind: "select", tree: B9_DEEP_TREE_ID, node: deepFirstChild?.id ?? deep.trunkBranchId });

  /* —— 相 C：b9-wide（220 根子枝：选中 + 显式 More 翻页）—— */
  const wide = treeOf(B9_WIDE_TREE_ID);
  const wideChildren = childrenOf(wide, wide.trunkBranchId);
  ops.push({ kind: "treeOpen", tree: B9_WIDE_TREE_ID });
  ops.push({ kind: "expand", tree: B9_WIDE_TREE_ID, node: wide.trunkBranchId, firstChild: wideChildren[0]?.id ?? null });
  for (const [index, childIndex] of [0, 8, 20, 37, 49].entries()) {
    ops.push({ kind: "select", tree: B9_WIDE_TREE_ID, node: wideChildren[childIndex].id, sampleRowAssert: index === 2 });
  }
  ops.push({ kind: "more", tree: B9_WIDE_TREE_ID, parent: wide.trunkBranchId, total: wideChildren.length, targetLoaded: 100 });
  for (const index of [52, 75, 99]) {
    ops.push({ kind: "select", tree: B9_WIDE_TREE_ID, node: wideChildren[index].id });
  }
  ops.push({ kind: "more", tree: B9_WIDE_TREE_ID, parent: wide.trunkBranchId, total: wideChildren.length, targetLoaded: 150 });
  ops.push({ kind: "select", tree: B9_WIDE_TREE_ID, node: wideChildren[149].id });
  ops.push({ kind: "collapse", tree: B9_WIDE_TREE_ID, node: wide.trunkBranchId, firstChild: wideChildren[0].id });
  ops.push({ kind: "expand", tree: B9_WIDE_TREE_ID, node: wide.trunkBranchId, firstChild: wideChildren[0].id, note: "cached reload after collapse (220 already-stored children)" });

  /* —— 相 D：b9-deep 重开 + 搜索揭示（深链 reveal 是最重的切换操作）—— */
  ops.push({ kind: "treeOpen", tree: B9_DEEP_TREE_ID });
  ops.push({ kind: "search", tree: B9_DEEP_TREE_ID, query: "b9-deep-c050", target: "b9-deep-c050" });
  ops.push({ kind: "reveal", tree: B9_DEEP_TREE_ID, node: "b9-deep-c050" });
  ops.push({ kind: "search", tree: B9_DEEP_TREE_ID, query: "b9-deep-c100", target: "b9-deep-c100" });
  ops.push({ kind: "reveal", tree: B9_DEEP_TREE_ID, node: "b9-deep-c100" });
  ops.push({ kind: "select", tree: B9_DEEP_TREE_ID, node: "b9-deep-c010", sampleRowAssert: true });
  ops.push({ kind: "select", tree: B9_DEEP_TREE_ID, node: "b9-deep-c001" });
  ops.push({ kind: "select", tree: B9_DEEP_TREE_ID, node: "b9-deep-c075" });
  ops.push({ kind: "select", tree: B9_DEEP_TREE_ID, node: "b9-deep-c100" });
  ops.push({ kind: "select", tree: B9_DEEP_TREE_ID, node: deep.trunkBranchId });

  return { ops, wide, big, deep, wideChildren };
}

/* ------------------------------------------------------------------ */
/* 探针侧导航状态镜像（结构真值派生：展开集合 + 已载子页 → 行索引）        */
/* ------------------------------------------------------------------ */

export function createNavMirror(dataset) {
  const treesById = new Map(dataset.trees.map((tree) => [tree.treeId, tree]));
  const childrenCache = new Map();
  const stateByTree = new Map();
  const stateOf = (treeId) => {
    let entry = stateByTree.get(treeId);
    if (entry === undefined) {
      entry = { expanded: new Set(), loaded: new Map() };
      stateByTree.set(treeId, entry);
    }
    return entry;
  };
  const childrenOf = (treeId, parentId) => {
    const key = `${treeId}::${parentId}`;
    let children = childrenCache.get(key);
    if (children === undefined) {
      const tree = treesById.get(treeId);
      children = tree === undefined ? [] : tree.nodes.filter((node) => node.parentId === parentId);
      childrenCache.set(key, children);
    }
    return children;
  };
  const loadedCount = (treeId, parentId) => {
    const state = stateOf(treeId);
    return Math.min(state.loaded.get(parentId) ?? childrenOf(treeId, parentId).length, childrenOf(treeId, parentId).length);
  };
  const expand = (treeId, nodeId) => {
    const state = stateOf(treeId);
    state.expanded.add(nodeId);
    const children = childrenOf(treeId, nodeId);
    if (!state.loaded.has(nodeId)) state.loaded.set(nodeId, Math.min(50, children.length));
  };
  const expandAncestors = (treeId, nodeId) => {
    const tree = treesById.get(treeId);
    const node = tree?.nodes.find((candidate) => candidate.id === nodeId);
    if (tree === undefined || node === undefined) return;
    for (const ancestorId of node.parentPath) expand(treeId, ancestorId);
    expand(treeId, nodeId);
  };
  const rowIndex = (treeId, target) => {
    const tree = treesById.get(treeId);
    if (tree === undefined) return null;
    if (target.type === "node" && target.id === tree.trunkBranchId) return 0;
    const state = stateOf(treeId);
    let index = 0;
    let found = null;
    const walk = (parentId) => {
      if (found !== null) return;
      if (!state.expanded.has(parentId)) return;
      const children = childrenOf(treeId, parentId);
      const loaded = loadedCount(treeId, parentId);
      if (loaded === 0) {
        index += 1; /* loading 占位行 */
        return;
      }
      for (const child of children.slice(0, loaded)) {
        index += 1;
        if (target.type === "node" && child.id === target.id) {
          found = index;
          return;
        }
        walk(child.id);
        if (found !== null) return;
      }
      if (loaded < children.length) {
        index += 1; /* more 行 */
        if (target.type === "more" && parentId === target.parentId) found = index;
      }
    };
    walk(tree.trunkBranchId);
    return found;
  };
  return {
    treeOf: (treeId) => treesById.get(treeId),
    childrenOf,
    expand,
    expandAncestors,
    collapse: (treeId, nodeId) => stateOf(treeId).expanded.delete(nodeId),
    markLoaded: (treeId, parentId, count) => {
      const state = stateOf(treeId);
      state.loaded.set(parentId, Math.max(state.loaded.get(parentId) ?? 0, count));
    },
    rowIndex,
  };
}
