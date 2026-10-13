/** facts owner; frozen probe bodies and order preserved. */

import { DeterministicRng } from "../../../../apps/studio/src/nav/deterministic-rng.ts";
import { type B6Tree, type B6Branch, type B6QaPair, type B6Annotation, type B6Return } from './models.ts';
import { B6_TREE_COUNT, B6_SEED, B6_NON_TRUNK_BRANCHES_PER_TREE, B6_QA_PAIR_COUNT, B6_ANNOTATION_COUNT, B6_RETURN_COUNT } from './policy.ts';
import { pad, TOPICS_ZH, TOPICS_EN, ASPECTS_ZH, OBJECTS_ZH } from './text.ts';
import { sha256Hex } from './dataset.ts';


/* ------------------------------------------------------------------ */
/* 树结构（10 棵 × trunk + 100 非根；确定性形状）                        */
/* ------------------------------------------------------------------ */

export function buildTrees(): B6Tree[] {
  const trees: B6Tree[] = [];
  for (let t = 1; t <= B6_TREE_COUNT; t += 1) {
    const treeId = `b6-t${pad(t, 2)}`;
    const trunkId = `${treeId}-trunk`;
    const rng = DeterministicRng.forStep(B6_SEED, `tree:${treeId}`);
    const branches: B6Branch[] = [{ id: trunkId, parentId: null, depth: 0 }];
    // 主脊柱：长度 6..10（t 决定），其余节点在深度上限内确定性挂靠。
    const spineLength = 6 + (t % 5);
    const maxDepth = 4 + (t % 4); // 4..7
    const byId = new Map<string, B6Branch>([[trunkId, branches[0]!]]);
    let spineParent = trunkId;
    for (let s = 1; s <= spineLength; s += 1) {
      const id = `${treeId}-n${pad(s, 3)}`;
      const parent = byId.get(spineParent)!;
      const branch: B6Branch = { id, parentId: spineParent, depth: parent.depth + 1 };
      branches.push(branch);
      byId.set(id, branch);
      spineParent = id;
    }
    let seq = branches.length;
    while (branches.length < 1 + B6_NON_TRUNK_BRANCHES_PER_TREE) {
      // 在深度上限内的节点中确定性选父（重试 + 兜底，与 b9 普通树同款）。
      let parent: B6Branch | undefined;
      for (let attempt = 0; attempt < 16; attempt += 1) {
        const candidate = branches[rng.int(0, branches.length - 1)]!;
        if (candidate.depth < maxDepth) {
          parent = candidate;
          break;
        }
      }
      if (parent === undefined) {
        parent = branches.find((candidate) => candidate.depth < maxDepth);
      }
      if (parent === undefined) {
        throw new Error(`b6-dataset: ${treeId} exhausted parents below depth ${String(maxDepth)}`);
      }
      seq += 1;
      const id = `${treeId}-n${pad(seq, 3)}`;
      const branch: B6Branch = { id, parentId: parent.id, depth: parent.depth + 1 };
      branches.push(branch);
      byId.set(id, branch);
    }
    trees.push({ treeId, trunkBranchId: trunkId, branches });
  }
  return trees;
}


/** 展平的分支序（trunk 在首；事实分配的全局确定性顺序）。 */
export function flattenBranches(trees: readonly B6Tree[]): B6Branch[] {
  const out: B6Branch[] = [];
  for (const tree of trees) out.push(...tree.branches);
  return out;
}


/* ------------------------------------------------------------------ */
/* 事实生成（3,000 问答对 + 2,500 批注 + 1,500 Return）                  */
/* ------------------------------------------------------------------ */

export function questionText(pairIndex: number): string {
  const rng = DeterministicRng.forStep(B6_SEED, `q:${pad(pairIndex, 4)}`);
  const zh = rng.pick(TOPICS_ZH);
  const en = rng.pick(TOPICS_EN);
  const aspect = rng.pick(ASPECTS_ZH);
  switch (rng.int(0, 4)) {
    case 0:
      return `${zh}的${aspect}应该从哪个问题入手？`;
    case 1:
      return `帮我用三句话讲清${zh}里${aspect}的要点。`;
    case 2:
      return `${en} 与${zh}在${aspect}上的说法矛盾吗？`;
    case 3:
      return `复习${zh}时，${aspect}最容易错的地方是什么？`;
    default:
      return `把${zh}的${aspect}整理成一张自查清单，可以吗？`;
  }
}


export function answerTextOf(pairIndex: number): string {
  const rng = DeterministicRng.forStep(B6_SEED, `a:${pad(pairIndex, 4)}`);
  const zh = rng.pick(TOPICS_ZH);
  const en = rng.pick(TOPICS_EN);
  const aspect = rng.pick(ASPECTS_ZH);
  return (
    `关于${zh}的${aspect}：先给结论的适用边界，再列证据与反例，最后回到原问题的表述检验是否已经回答完整。` +
    `${zh}与${en}的文献在这一点上结论一致——先建立主干，细节随后归位。` +
    `补充：${aspect}最常见的错误是把相关当因果；复习时应专门准备至少一个反例，并写清它推翻的是推理链的哪一步。` +
    `如果时间只够做一件事，就把${rng.pick(OBJECTS_ZH)}重写一遍——写不下去的地方就是没懂的地方。`
  );
}


export function annotationText(index: number): { term: string; explanation: string } {
  const rng = DeterministicRng.forStep(B6_SEED, `anno:${pad(index, 4)}`);
  const zh = rng.pick(TOPICS_ZH);
  const aspect = rng.pick(ASPECTS_ZH);
  const term = `${zh}·${aspect}`;
  return {
    term,
    explanation: `批注「${term}」：在${zh}的语境里，${aspect}指先立主干再收细节的路径；与近义表述的差别在于它显式要求写出适用边界。`,
  };
}


export function returnTextOf(index: number): string {
  const rng = DeterministicRng.forStep(B6_SEED, `ret:${pad(index, 4)}`);
  const zh = rng.pick(TOPICS_ZH);
  return `收获：${zh}的${rng.pick(ASPECTS_ZH)}要先写边界再列证据，反例至少备一个——写不下去处即未懂处。`;
}


/** 码点安全区间（选区不落在代理对中间；语料为 BMP，防御性保留）。 */
export function codePointSafeRange(text: string, start: number, length: number): { start: number; end: number } {
  const maxStart = Math.max(0, text.length - length - 1);
  let s = Math.min(Math.max(0, start), maxStart);
  let e = Math.min(text.length, s + length);
  while (s > 0 && text.charCodeAt(s) >= 0xdc00 && text.charCodeAt(s) <= 0xdfff) s += 1;
  while (e < text.length && text.charCodeAt(e) >= 0xdc00 && text.charCodeAt(e) <= 0xdfff) e += 1;
  return { start: s, end: e };
}


export function buildFacts(trees: readonly B6Tree[]): {
  qaPairs: B6QaPair[];
  annotations: B6Annotation[];
  returns: B6Return[];
} {
  const flat = flattenBranches(trees);

  // —— 问答对（3,000 组；branchIndex = pairIndex mod 分支总数）——
  const qaPairs: B6QaPair[] = [];
  for (let p = 0; p < B6_QA_PAIR_COUNT; p += 1) {
    const branch = flat[p % flat.length]!;
    qaPairs.push({
      pairIndex: p,
      treeId: branchIdToTreeId(branch.id),
      branchId: branch.id,
      episodeId: `b6-ep-${branch.id}`,
      runId: `b6-run-${branch.id}`,
      userTurnId: `b6-turn-u${pad(p, 4)}`,
      assistantTurnId: `b6-turn-a${pad(p, 4)}`,
      question: questionText(p),
      answer: answerTextOf(p),
    });
  }

  // 每分支一组 episode/run（承载其全部问答；会话引用为确定性合成——
  // 离线数据集，可用性按 available 记账，与 b9 装载纪律一致）。
  // —— 批注（2,500；锚定同分支 assistant Turn、选区切片一致）——
  const annotations: B6Annotation[] = [];
  for (let j = 0; j < B6_ANNOTATION_COUNT; j += 1) {
    const branch = flat[j % flat.length]!;
    const treeId = branchIdToTreeId(branch.id);
    const anchors = qaPairs
      .filter((pair) => pair.branchId === branch.id)
      .sort((a, b) => a.pairIndex - b.pairIndex);
    const round = Math.floor(j / flat.length);
    const anchor = anchors[round % anchors.length]!;
    const rng = DeterministicRng.forStep(B6_SEED, `anno-sel:${pad(j, 4)}`);
    const range = codePointSafeRange(
      anchor.answer,
      rng.int(0, Math.max(0, anchor.answer.length - 40)),
      rng.int(8, 24),
    );
    const { term, explanation } = annotationText(j);
    annotations.push({
      treeId,
      branchId: branch.id,
      anchorTurnId: anchor.assistantTurnId,
      selStart: range.start,
      selEnd: range.end,
      selText: anchor.answer.slice(range.start, range.end),
      sourceHash: sha256Hex(anchor.answer),
      term,
      explanation,
    });
  }

  // —— Return（1,500；落点分支 + fromBranch（同树内）+ 幂等键 + targetAnchor）——
  const returns: B6Return[] = [];
  const perTree = 1 + B6_NON_TRUNK_BRANCHES_PER_TREE;
  for (let r = 0; r < B6_RETURN_COUNT; r += 1) {
    const branchIndex = r % flat.length;
    const branch = flat[branchIndex]!;
    const treeId = branchIdToTreeId(branch.id);
    // from 分支与落点同树（产品语义：材料/子分支探索在同树内进行）；
    // 树内偏移确定性派生，避开落点自身。
    const treeStart = Math.floor(branchIndex / perTree) * perTree;
    const branchOffset = branchIndex - treeStart;
    let fromOffset = (r * 7 + 3) % perTree;
    if (fromOffset === branchOffset) fromOffset = (fromOffset + 1) % perTree;
    const fromBranch = flat[treeStart + fromOffset]!;
    const anchors = qaPairs
      .filter((pair) => pair.branchId === branch.id)
      .sort((a, b) => a.pairIndex - b.pairIndex);
    const round = Math.floor(r / flat.length);
    const anchor = anchors[round % anchors.length]!;
    const rng = DeterministicRng.forStep(B6_SEED, `ret-sel:${pad(r, 4)}`);
    const range = codePointSafeRange(
      anchor.answer,
      rng.int(0, Math.max(0, anchor.answer.length - 40)),
      rng.int(8, 24),
    );
    returns.push({
      treeId,
      branchId: branch.id,
      returnTurnId: `b6-turn-r${pad(r, 4)}`,
      fromBranchId: fromBranch.id,
      idempotencyKey: `b6-ret-${pad(r, 4)}`,
      text: returnTextOf(r),
      anchorTurnId: anchor.assistantTurnId,
      anchorEntryId: `${anchor.assistantTurnId}-entry`,
      selStart: range.start,
      selEnd: range.end,
      selText: anchor.answer.slice(range.start, range.end),
    });
  }

  return { qaPairs, annotations, returns };
}


/** 分支 id → 树 id（b6-tNN-nnnn → b6-tNN；构造性成立，防御性校验）。 */
export function branchIdToTreeId(branchId: string): string {
  const match = /^(b6-t\d{2})-/.exec(branchId);
  if (match === null) {
    throw new Error(`b6-dataset: branch id ${branchId} does not follow the b6-tNN-* shape`);
  }
  return match[1]!;
}
