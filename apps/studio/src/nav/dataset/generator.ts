/** generator ownership for b9-dataset.ts; compatibility entrypoint remains one level above. */
import {
  DeterministicRng,
} from "../deterministic-rng.ts";
import {
  parseMaterialSpec,
} from "./materials.ts";
import type {
  B9Dataset,
  B9Node,
  B9Totals,
  B9Tree,
  ParsedMaterial,
  WorkingNode,
  WorkingTree,
} from "./model.ts";
import {
  B9_FOREST_ID,
  B9_SEED,
  B9_SET_ID,
  MATERIAL_ORIGIN_MOD,
  MATERIAL_ORIGIN_REMAINDER,
  MATERIAL_SPECS,
  TURN_ORIGIN_MOD,
  TURN_ORIGIN_REMAINDER,
} from "./policy.ts";
import {
  answerTextFor,
  codePointSafeRange,
} from "./text.ts";
import {
  buildBigTree,
  buildDeepTree,
  buildEmptyTree,
  buildLongtitleTree,
  buildNormalTree,
  buildSamenameTree,
  buildWideTree,
  planNormalTreeSizes,
} from "./trees.ts";

/* ------------------------------------------------------------------ */
/* 来源分配（Turn / Material；全局序号规则）                             */
/* ------------------------------------------------------------------ */

export function assignOrigins(trees: readonly WorkingTree[], materials: readonly ParsedMaterial[]): void {
  // 回答文本以「seed+实体id」独立派生，与遍历顺序无关（确定性可独立复算）。
  const answerFor = (node: WorkingNode): string => {
    if (node.answerText === null) {
      const rng = DeterministicRng.forStep(B9_SEED, `answer:${node.id}`);
      node.answerText = answerTextFor(rng, node.title ?? node.id);
    }
    return node.answerText;
  };

  let g = 0;
  for (const tree of trees) {
    const byId = new Map<string, WorkingNode>(tree.nodes.map((node) => [node.id, node]));
    for (const node of tree.nodes) {
      if (node.parentId === null) continue; // trunk 无来源
      g += 1;
      if (g % TURN_ORIGIN_MOD === TURN_ORIGIN_REMAINDER) {
        const parent = byId.get(node.parentId)!;
        const answer = answerFor(parent);
        const rng = DeterministicRng.forStep(B9_SEED, `origin-sel:${node.id}`);
        const range = codePointSafeRange(answer, rng.int(0, Math.max(0, answer.length - 32)), 24);
        node.originKind = "turn";
        node.origin = {
          kind: "turn",
          sourceBranchId: parent.id,
          anchorTurnId: `${parent.id}-a1`,
          anchorEntryId: `${parent.id}-a1-entry`,
          selStart: range.start,
          selEnd: range.end,
          selText: answer.slice(range.start, range.end),
        };
      } else if (g % MATERIAL_ORIGIN_MOD === MATERIAL_ORIGIN_REMAINDER) {
        const rng = DeterministicRng.forStep(B9_SEED, `origin-mat:${node.id}`);
        const material = rng.pick(materials);
        const block = rng.pick(material.blocks);
        const blockText = material.canonicalText.slice(block.start, block.end);
        const range = codePointSafeRange(blockText, rng.int(0, Math.max(0, blockText.length - 32)), 24);
        const start = block.start + range.start;
        const end = start + (range.end - range.start);
        node.originKind = "material";
        node.origin = {
          kind: "material",
          materialId: material.spec.materialId,
          versionId: `${material.spec.materialId}-v1`,
          blockId: block.blockId,
          start,
          end,
          excerpt: material.canonicalText.slice(start, end),
        };
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 生成主入口                                                           */
/* ------------------------------------------------------------------ */

export function freezeTree(tree: WorkingTree): B9Tree {
  const nodes: B9Node[] = tree.nodes.map((node) => ({
    id: node.id,
    parentId: node.parentId,
    title: node.title,
    depth: node.depth,
    originKind: node.originKind,
    origin: node.origin,
    parentPath: node.parentPath,
    answerText: node.answerText,
  }));
  return {
    treeId: tree.treeId,
    kind: tree.kind,
    rule: tree.rule,
    title: nodes[0]?.title ?? null,
    trunkBranchId: nodes[0]?.id ?? "",
    nodes,
  };
}

/** 生成完整 B9 数据集（纯函数：无 IO、无随机源、无时间——同 seed 字节级恒等）。 */
export function generateB9Dataset(): B9Dataset {
  const materials = MATERIAL_SPECS.map(parseMaterialSpec);
  const trees: WorkingTree[] = [
    buildBigTree(),
    buildDeepTree(),
    buildWideTree(),
    buildEmptyTree(),
    buildSamenameTree(),
    buildLongtitleTree(),
  ];
  const sizes = planNormalTreeSizes();
  sizes.forEach((size, index) => {
    trees.push(buildNormalTree(index + 1, size));
  });
  assignOrigins(trees, materials);

  const frozenTrees = trees.map(freezeTree);
  let branchRows = 0;
  let maxDepth = 0;
  let turnOrigins = 0;
  let materialOrigins = 0;
  let titledNodes = 0;
  for (const tree of frozenTrees) {
    branchRows += tree.nodes.length;
    for (const node of tree.nodes) {
      if (node.depth > maxDepth) maxDepth = node.depth;
      if (node.originKind === "turn") turnOrigins += 1;
      if (node.originKind === "material") materialOrigins += 1;
      if (node.title !== null) titledNodes += 1;
    }
  }
  const totals: B9Totals = {
    trees: frozenTrees.length,
    specialTrees: frozenTrees.filter((tree) => tree.kind === "special").length,
    normalTrees: frozenTrees.filter((tree) => tree.kind === "normal").length,
    branchRows,
    nonTrunkBranches: branchRows - frozenTrees.length,
    maxDepth,
    turnOrigins,
    materialOrigins,
    titledNodes,
  };
  return {
    version: 1,
    setId: B9_SET_ID,
    seed: B9_SEED,
    forestId: B9_FOREST_ID,
    materials: MATERIAL_SPECS.map((spec) => ({
      materialId: spec.materialId,
      versionId: `${spec.materialId}-v1`,
      title: spec.title,
      filename: spec.filename,
      markdown: spec.markdown,
    })),
    trees: frozenTrees,
    totals,
  };
}
