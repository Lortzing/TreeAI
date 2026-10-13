/** performance ownership for b9-probes.ts; compatibility entrypoint remains one level above. */
import {
  B9_BIG_TREE_ID,
  B9_DEEP_TREE_ID,
  B9_SAME_NAME_TITLE,
  B9_WIDE_TREE_ID,
} from "../b9-dataset.ts";
import type {
  PerfOp,
  ProbeContext,
} from "./model.ts";
import {
  treeOf,
} from "./truth.ts";

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

export function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(fraction * sorted.length);
  const index = Math.min(sorted.length, Math.max(1, rank)) - 1;
  return sorted[index]!;
}
