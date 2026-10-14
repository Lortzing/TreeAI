/** trees ownership for b9-dataset.ts; compatibility entrypoint remains one level above. */
import {
  DeterministicRng,
} from "../deterministic-rng.ts";
import type {
  WorkingNode,
  WorkingTree,
} from "./model.ts";
import {
  B9_BIG_TREE_ID,
  B9_DEEP_TREE_ID,
  B9_EMPTY_TREE_ID,
  B9_LONGTITLE_TREE_ID,
  B9_SAME_NAME_TITLE,
  B9_SAMENAME_TREE_ID,
  B9_SEED,
  B9_TOTAL_NON_TRUNK_BRANCHES,
  B9_WIDE_TREE_ID,
  BIG_TOTAL_NODES,
  DEEP_CHAIN_DEPTH,
  DEEP_SIDE_BRANCHES,
  LONGTITLE_NODES,
  NORMAL_SIZE_MAX,
  NORMAL_SIZE_MIN,
  NORMAL_TREE_COUNT,
  SAMENAME_DECOYS,
  SAMENAME_DEPTH3,
  SAMENAME_PARENTS,
  SAMENAME_PER_PARENT,
  SAMENAME_UNDER_TRUNK,
  WIDE_GRANDCHILDREN_STEP,
  WIDE_ROOT_CHILDREN,
} from "./policy.ts";
import {
  longTitle,
  nodeTitle,
  specialTreeTitle,
} from "./text.ts";

export function workingNode(id: string, parent: WorkingNode | null, title: string | null): WorkingNode {
  return {
    id,
    parentId: parent === null ? null : parent.id,
    title,
    depth: parent === null ? 0 : parent.depth + 1,
    parentPath: parent === null ? [] : [...parent.parentPath, parent.id],
    answerText: null,
    originKind: "none",
    origin: null,
  };
}

export function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/* ------------------------------------------------------------------ */
/* 六棵特殊树                                                           */
/* ------------------------------------------------------------------ */

export function buildBigTree(): WorkingTree {
  const rng = DeterministicRng.forStep(B9_SEED, "b9-big");
  const treeId = B9_BIG_TREE_ID;
  const nodes: WorkingNode[] = [
    workingNode(`${treeId}-trunk`, null, specialTreeTitle("广度优先大树", "Mixed-branching BFS tree")),
  ];
  // 广度优先：nodes 数组即 BFS 队列；逐节点分支因子 2–5，整树截断在 5000。
  let cursor = 0;
  let seq = 0;
  while (nodes.length < BIG_TOTAL_NODES) {
    const parent = nodes[cursor]!;
    const factor = rng.int(2, 5);
    for (let k = 0; k < factor && nodes.length < BIG_TOTAL_NODES; k += 1) {
      seq += 1;
      nodes.push(workingNode(`${treeId}-n${pad(seq, 4)}`, parent, nodeTitle(rng, seq)));
    }
    cursor += 1;
  }
  return { treeId, kind: "special", rule: "单棵 5000 节点树（广度优先生成，分支因子混合 2–5）", nodes };
}

export function buildDeepTree(): WorkingTree {
  const rng = DeterministicRng.forStep(B9_SEED, "b9-deep");
  const treeId = B9_DEEP_TREE_ID;
  const nodes: WorkingNode[] = [
    workingNode(`${treeId}-trunk`, null, specialTreeTitle("一百层深链", "100-level deep chain")),
  ];
  const chain: WorkingNode[] = [nodes[0]!];
  for (let depth = 1; depth <= DEEP_CHAIN_DEPTH; depth += 1) {
    const node = workingNode(`${treeId}-c${pad(depth, 3)}`, chain[depth - 1]!, nodeTitle(rng, depth));
    chain.push(node);
    nodes.push(node);
  }
  // 少量旁枝：挂在链上 depth 5,15,…,95 的节点下（每处 1 条，单节点叶子），
  // 不超过链深 100。
  for (let k = 1; k <= DEEP_SIDE_BRANCHES; k += 1) {
    const chainDepth = k * 10 - 5; // 5, 15, …, 95
    const anchor = chain[chainDepth]!;
    nodes.push(workingNode(`${treeId}-s${pad(k, 2)}`, anchor, nodeTitle(rng, 1000 + k)));
  }
  return { treeId, kind: "special", rule: "100 层深链（一条根到叶 100 层的链，可带少量旁枝）", nodes };
}

export function buildWideTree(): WorkingTree {
  const rng = DeterministicRng.forStep(B9_SEED, "b9-wide");
  const treeId = B9_WIDE_TREE_ID;
  const trunk = workingNode(`${treeId}-trunk`, null, specialTreeTitle("宽树", "Wide tree"));
  const nodes: WorkingNode[] = [trunk];
  const rootChildren: WorkingNode[] = [];
  for (let i = 1; i <= WIDE_ROOT_CHILDREN; i += 1) {
    const node = workingNode(`${treeId}-w${pad(i, 3)}`, trunk, nodeTitle(rng, i));
    rootChildren.push(node);
    nodes.push(node);
  }
  for (let i = WIDE_GRANDCHILDREN_STEP; i <= WIDE_ROOT_CHILDREN; i += WIDE_GRANDCHILDREN_STEP) {
    const parent = rootChildren[i - 1]!;
    nodes.push(workingNode(`${treeId}-g${pad(i / WIDE_GRANDCHILDREN_STEP, 2)}`, parent, nodeTitle(rng, 500 + i)));
  }
  return {
    treeId,
    kind: "special",
    rule: "宽树：根下 ≥200 个直接子枝",
    nodes,
  };
}

export function buildEmptyTree(): WorkingTree {
  const treeId = B9_EMPTY_TREE_ID;
  // 空树：仅 trunk，且无任何 Turn——标题为 null（诚实呈现，不伪造标题）。
  const nodes: WorkingNode[] = [workingNode(`${treeId}-trunk`, null, null)];
  return { treeId, kind: "special", rule: "空树（仅 trunk）", nodes };
}

export function buildSamenameTree(): WorkingTree {
  const rng = DeterministicRng.forStep(B9_SEED, "b9-samename");
  const treeId = B9_SAMENAME_TREE_ID;
  const trunk = workingNode(`${treeId}-trunk`, null, specialTreeTitle("同名节点树", "Same-name branches"));
  const nodes: WorkingNode[] = [trunk];
  const parents: WorkingNode[] = [];
  for (let p = 1; p <= SAMENAME_PARENTS; p += 1) {
    const node = workingNode(`${treeId}-p${pad(p, 2)}`, trunk, nodeTitle(rng, p));
    parents.push(node);
    nodes.push(node);
  }
  // trunk 下的直接同名子枝（父 = trunk）。
  for (let k = 1; k <= SAMENAME_UNDER_TRUNK; k += 1) {
    nodes.push(workingNode(`${treeId}-same-root-${k}`, trunk, B9_SAME_NAME_TITLE));
  }
  // 每个父下 2 个同名子枝（depth 2）。
  const depth2: WorkingNode[] = [];
  for (const parent of parents) {
    for (let k = 1; k <= SAMENAME_PER_PARENT; k += 1) {
      const node = workingNode(`${treeId}-same-${parent.id.slice(-2)}-${k}`, parent, B9_SAME_NAME_TITLE);
      depth2.push(node);
      nodes.push(node);
    }
  }
  // 4 个 depth-3 同名孙枝（挂在同名节点之下——同名节点自身也可作父）。
  for (let k = 1; k <= SAMENAME_DEPTH3; k += 1) {
    const anchor = depth2[(k - 1) * SAMENAME_PER_PARENT]!;
    nodes.push(workingNode(`${treeId}-same-d3-${k}`, anchor, B9_SAME_NAME_TITLE));
  }
  // 4 个诱饵：同名标题 + 「（续）」——exact 不得命中，substring 命中。
  for (let k = 1; k <= SAMENAME_DECOYS; k += 1) {
    const anchor = parents[SAMENAME_PARENTS - SAMENAME_DECOYS + k - 1]!;
    nodes.push(workingNode(`${treeId}-decoy-${k}`, anchor, `${B9_SAME_NAME_TITLE}（续）`));
  }
  return { treeId, kind: "special", rule: "同名节点树：≥50 个同名 Branch 分布在不同父下", nodes };
}

export function buildLongtitleTree(): WorkingTree {
  const rng = DeterministicRng.forStep(B9_SEED, "b9-longtitle");
  const treeId = B9_LONGTITLE_TREE_ID;
  const trunk = workingNode(`${treeId}-trunk`, null, specialTreeTitle("长标题树", "Long titles"));
  const nodes: WorkingNode[] = [trunk];
  let seq = 0;
  const spine: WorkingNode[] = [];
  let spineParent: WorkingNode = trunk;
  for (let k = 1; k <= 20; k += 1) {
    seq += 1;
    const node = workingNode(`${treeId}-spine-${pad(k, 2)}`, spineParent, longTitle(rng, treeId, seq));
    spine.push(node);
    nodes.push(node);
    spineParent = node;
  }
  // trunk 的 20 个直接子枝（depth 1）。
  for (let k = 1; k <= 20; k += 1) {
    seq += 1;
    nodes.push(workingNode(`${treeId}-bush-${pad(k, 2)}`, trunk, longTitle(rng, treeId, seq)));
  }
  // 每个脊柱节点 4 个子枝（depth 2..21）。
  for (const parent of spine) {
    for (let k = 1; k <= 4; k += 1) {
      seq += 1;
      nodes.push(workingNode(`${treeId}-leaf-${parent.id.slice(-2)}-${k}`, parent, longTitle(rng, treeId, seq)));
    }
  }
  const nonTrunk = nodes.length - 1;
  if (nonTrunk !== LONGTITLE_NODES) {
    throw new Error(`b9-dataset: b9-longtitle built ${String(nonTrunk)} non-trunk nodes, expected ${String(LONGTITLE_NODES)}`);
  }
  return { treeId, kind: "special", rule: "长标题树：≥100 个标题长度 ≥200 字符的节点", nodes };
}

/* ------------------------------------------------------------------ */
/* 94 棵普通树（规模合计把非根节点补足到 10000）                         */
/* ------------------------------------------------------------------ */

export function planNormalTreeSizes(): number[] {
  const rng = DeterministicRng.forStep(B9_SEED, "normal-sizes");
  // 基线：4407 ÷ 94 → 83 棵 47 + 11 棵 46（由特殊树规模反推，见 buildDataset）。
  const specialNonTrunk =
    (BIG_TOTAL_NODES - 1) +
    (DEEP_CHAIN_DEPTH + DEEP_SIDE_BRANCHES) +
    (WIDE_ROOT_CHILDREN + WIDE_ROOT_CHILDREN / WIDE_GRANDCHILDREN_STEP) +
    0 +
    (SAMENAME_PARENTS + SAMENAME_UNDER_TRUNK + SAMENAME_PARENTS * SAMENAME_PER_PARENT + SAMENAME_DEPTH3 + SAMENAME_DECOYS) +
    LONGTITLE_NODES;
  const remaining = B9_TOTAL_NON_TRUNK_BRANCHES - specialNonTrunk;
  const base = Math.floor(remaining / NORMAL_TREE_COUNT);
  let extra = remaining - base * NORMAL_TREE_COUNT;
  const sizes: number[] = [];
  for (let i = 0; i < NORMAL_TREE_COUNT; i += 1) {
    let size = base;
    if (extra > 0) {
      size += 1;
      extra -= 1;
    }
    sizes.push(size);
  }
  // 确定性抖动：在 [12,110] 界内成对搬运，总量不变。
  for (let step = 0; step < 220; step += 1) {
    const i = rng.int(0, sizes.length - 1);
    const j = rng.int(0, sizes.length - 1);
    if (i === j) continue;
    const move = rng.int(1, 15);
    if (sizes[i]! - move >= NORMAL_SIZE_MIN && sizes[j]! + move <= NORMAL_SIZE_MAX) {
      sizes[i]! -= move;
      sizes[j]! += move;
    }
  }
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total !== remaining) {
    throw new Error(`b9-dataset: normal tree sizes sum to ${String(total)}, expected ${String(remaining)}`);
  }
  return sizes;
}

export function buildNormalTree(index: number, size: number): WorkingTree {
  const treeId = `b9-tree-${pad(index, 2)}`;
  const rng = DeterministicRng.forStep(B9_SEED, `normal-tree-${treeId}`);
  const maxAllowedDepth = rng.int(3, 8);
  const nodes: WorkingNode[] = [workingNode(`${treeId}-trunk`, null, nodeTitle(rng, 0))];
  let seq = 0;
  while (nodes.length - 1 < size) {
    seq += 1;
    // 在深度上限内的节点中均匀选父；确定性重试 + 兜底（首个可行节点）。
    let parent: WorkingNode | null = null;
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const candidate = nodes[rng.int(0, nodes.length - 1)]!;
      if (candidate.depth < maxAllowedDepth) {
        parent = candidate;
        break;
      }
    }
    if (parent === null) {
      for (const candidate of nodes) {
        if (candidate.depth < maxAllowedDepth) {
          parent = candidate;
          break;
        }
      }
    }
    if (parent === null) {
      throw new Error(`b9-dataset: ${treeId} has no node below maxAllowedDepth ${String(maxAllowedDepth)}`);
    }
    nodes.push(workingNode(`${treeId}-n${pad(seq, 3)}`, parent, nodeTitle(rng, seq)));
  }
  return { treeId, kind: "normal", rule: null, nodes };
}
