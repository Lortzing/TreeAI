/** invariants owner; frozen probe bodies and order preserved. */


import { type B6Dataset, type B6Branch, type B6QaPair } from './models.ts';
import { B6_MATERIAL_COUNT, B6_MARKDOWN_COUNT, B6_PDF_COUNT, B6_TOTAL_TEXT_UNITS, B6_PER_MATERIAL_MAX_UNITS, B6_PER_MATERIAL_MAX_PAGES, B6_TREE_COUNT, B6_NON_TRUNK_BRANCHES_PER_TREE, B6_NON_TRUNK_BRANCH_COUNT, B6_QA_PAIR_COUNT, B6_TURN_COUNT, B6_ANNOTATION_COUNT, B6_RETURN_COUNT, B6_FROZEN_QUERY_COUNT, B6_SAMPLE_PAGES } from './policy.ts';
import { b6MaterialCanonicalText, sha256Hex, deriveB6FrozenQueries, generateB6ImportSamplePlan } from './dataset.ts';
import { branchIdToTreeId } from './facts.ts';


/* ------------------------------------------------------------------ */
/* 不变量（机械复核；返回问题清单，空 = 全部通过）                        */
/* ------------------------------------------------------------------ */

export function checkB6Invariants(dataset: B6Dataset): string[] {
  const problems: string[] = [];
  const push = (message: string): void => {
    problems.push(message);
  };

  // —— 材料总量与构成（spec.dataset.materials）——
  if (dataset.materials.length !== B6_MATERIAL_COUNT) {
    push(`materials: expected ${String(B6_MATERIAL_COUNT)}, got ${String(dataset.materials.length)}`);
  }
  const md = dataset.materials.filter((m) => m.kind === "markdown");
  const pdf = dataset.materials.filter((m) => m.kind === "pdf");
  if (md.length !== B6_MARKDOWN_COUNT) push(`markdown materials: ${String(md.length)} != ${String(B6_MARKDOWN_COUNT)}`);
  if (pdf.length !== B6_PDF_COUNT) push(`pdf materials: ${String(pdf.length)} != ${String(B6_PDF_COUNT)}`);
  if (dataset.totals.totalTextUnits !== B6_TOTAL_TEXT_UNITS) {
    push(`totalTextUnits: ${String(dataset.totals.totalTextUnits)} != ${String(B6_TOTAL_TEXT_UNITS)} (must be EXACT)`);
  }
  let unitsSeen = 0;
  for (const material of dataset.materials) {
    unitsSeen += material.units;
    if (material.units > B6_PER_MATERIAL_MAX_UNITS) {
      push(`material ${material.materialId}: ${String(material.units)} units > per-material cap`);
    }
    if (material.kind === "pdf" && material.pages.length > B6_PER_MATERIAL_MAX_PAGES) {
      push(`material ${material.materialId}: ${String(material.pages.length)} pages > 200-page cap`);
    }
    const canonical = b6MaterialCanonicalText(material);
    if (canonical.length !== material.units) {
      push(
        `material ${material.materialId}: canonical length ${String(canonical.length)} != plan ${String(material.units)}`,
      );
    }
    if (canonical.indexOf(material.needle) !== material.needleIndex || material.needleIndex < 0) {
      push(`material ${material.materialId}: needle index diverges from canonical text`);
    }
    if (canonical.indexOf(material.needle, material.needleIndex + 1) >= 0) {
      push(`material ${material.materialId}: needle appears more than once`);
    }
    for (const ch of material.needle) {
      if (ch.codePointAt(0)! > 0xffff) {
        push(`material ${material.materialId}: needle contains astral characters (needleIndex is UTF-16)`);
      }
    }
  }
  if (unitsSeen !== B6_TOTAL_TEXT_UNITS) {
    push(`summed units ${String(unitsSeen)} != ${String(B6_TOTAL_TEXT_UNITS)}`);
  }
  const long = dataset.materials.filter((m) => m.units >= 50_000);
  if (long.length < 10) {
    push(`long materials (>=50k units): ${String(long.length)} < 10`);
  }

  // —— needle 跨语料唯一 ——
  const needleCounts = new Map<string, number>();
  for (const material of dataset.materials) {
    needleCounts.set(material.needle, (needleCounts.get(material.needle) ?? 0) + 1);
  }
  for (const [needle, count] of needleCounts) {
    if (count > 1) push(`needle ${needle} used by ${String(count)} materials (must be unique)`);
  }
  // 事实文本不得包含任何 needle（否则查询集的期望命中被污染）。
  const allNeedles = dataset.materials.map((m) => m.needle);
  const factTexts = [
    ...dataset.qaPairs.flatMap((pair) => [pair.question, pair.answer]),
    ...dataset.annotations.map((a) => `${a.term}${a.explanation}${a.selText}`),
    ...dataset.returns.map((r) => r.text),
  ];
  for (let i = 0; i < factTexts.length; i += 1) {
    for (const needle of allNeedles) {
      if (factTexts[i]!.includes(needle)) {
        push(`fact #${String(i)} contains a material needle (query expectations polluted)`);
      }
    }
  }

  // —— 树/分支结构 ——
  if (dataset.trees.length !== B6_TREE_COUNT) push(`trees: ${String(dataset.trees.length)} != ${String(B6_TREE_COUNT)}`);
  const branchIds = new Set<string>();
  let nonTrunk = 0;
  for (const tree of dataset.trees) {
    if (tree.branches.length !== 1 + B6_NON_TRUNK_BRANCHES_PER_TREE) {
      push(`tree ${tree.treeId}: ${String(tree.branches.length)} branch rows`);
    }
    const localById = new Map<string, B6Branch>();
    for (const branch of tree.branches) {
      if (branchIds.has(branch.id)) push(`duplicate branch id ${branch.id}`);
      branchIds.add(branch.id);
      localById.set(branch.id, branch);
      if (branch.parentId === null) {
        if (branch.id !== tree.trunkBranchId) push(`tree ${tree.treeId}: non-trunk root ${branch.id}`);
      } else {
        nonTrunk += 1;
        const parent = localById.get(branch.parentId);
        if (parent === undefined) {
          push(`branch ${branch.id}: parent ${branch.parentId} not created before child`);
        } else if (branch.depth !== parent.depth + 1) {
          push(`branch ${branch.id}: depth ${String(branch.depth)} != parent depth + 1`);
        }
      }
    }
  }
  if (nonTrunk !== B6_NON_TRUNK_BRANCH_COUNT) {
    push(`non-trunk branches: ${String(nonTrunk)} != ${String(B6_NON_TRUNK_BRANCH_COUNT)}`);
  }
  if (dataset.totals.branchRows !== branchIds.size) {
    push(`totals.branchRows ${String(dataset.totals.branchRows)} != ${String(branchIds.size)}`);
  }

  // —— 保存事实（spec.dataset.savedFacts）——
  if (dataset.qaPairs.length !== B6_QA_PAIR_COUNT) {
    push(`qa pairs: ${String(dataset.qaPairs.length)} != ${String(B6_QA_PAIR_COUNT)}`);
  }
  if (dataset.totals.turnFacts !== B6_TURN_COUNT) {
    push(`turn facts: ${String(dataset.totals.turnFacts)} != ${String(B6_TURN_COUNT)}`);
  }
  if (dataset.annotations.length !== B6_ANNOTATION_COUNT) {
    push(`annotations: ${String(dataset.annotations.length)} != ${String(B6_ANNOTATION_COUNT)}`);
  }
  if (dataset.returns.length !== B6_RETURN_COUNT) {
    push(`returns: ${String(dataset.returns.length)} != ${String(B6_RETURN_COUNT)}`);
  }
  if (dataset.totals.savedFacts !== 10_000) {
    push(`saved facts: ${String(dataset.totals.savedFacts)} != 10000`);
  }
  const turnIds = new Set<string>();
  for (const pair of dataset.qaPairs) {
    turnIds.add(pair.userTurnId);
    turnIds.add(pair.assistantTurnId);
    if (!branchIds.has(pair.branchId)) push(`qa pair ${String(pair.pairIndex)} references unknown branch ${pair.branchId}`);
    if (pair.userTurnId.slice(-4) !== pair.assistantTurnId.slice(-4)) {
      push(`qa pair ${String(pair.pairIndex)} user/assistant turn ids diverge`);
    }
    if (pair.answer.length === 0 || pair.question.length === 0) {
      push(`qa pair ${String(pair.pairIndex)} has empty text`);
    }
  }
  if (turnIds.size !== B6_TURN_COUNT) push(`turn ids: ${String(turnIds.size)} distinct != ${String(B6_TURN_COUNT)}`);

  const answersByTurnId = new Map<string, string>(
    dataset.qaPairs.map((pair) => [pair.assistantTurnId, pair.answer] as const),
  );
  const pairByBranch = new Map<string, B6QaPair[]>();
  for (const pair of dataset.qaPairs) {
    const list = pairByBranch.get(pair.branchId) ?? [];
    list.push(pair);
    pairByBranch.set(pair.branchId, list);
  }
  for (let j = 0; j < dataset.annotations.length; j += 1) {
    const annotation = dataset.annotations[j]!;
    if (!branchIds.has(annotation.branchId)) {
      push(`annotation ${String(j)} references unknown branch ${annotation.branchId}`);
      continue;
    }
    const answer = answersByTurnId.get(annotation.anchorTurnId);
    if (answer === undefined) {
      push(`annotation ${String(j)} anchors unknown assistant turn ${annotation.anchorTurnId}`);
      continue;
    }
    const anchorPair = dataset.qaPairs.find((pair) => pair.assistantTurnId === annotation.anchorTurnId);
    if (anchorPair === undefined || anchorPair.branchId !== annotation.branchId) {
      push(`annotation ${String(j)} anchor turn is not on the annotation's branch`);
      continue;
    }
    if (answer.slice(annotation.selStart, annotation.selEnd) !== annotation.selText) {
      push(`annotation ${String(j)} selection does not slice-match the anchor answer`);
    }
    if (annotation.sourceHash !== sha256Hex(answer)) {
      push(`annotation ${String(j)} sourceHash != sha256(anchor answer)`);
    }
    if (annotation.selText.length === 0 || annotation.term.length === 0) {
      push(`annotation ${String(j)} has empty selection/term`);
    }
  }
  const idempotencyKeys = new Set<string>();
  for (let r = 0; r < dataset.returns.length; r += 1) {
    const item = dataset.returns[r]!;
    if (!branchIds.has(item.branchId) || !branchIds.has(item.fromBranchId)) {
      push(`return ${String(r)} references unknown branch`);
      continue;
    }
    if (item.branchId === item.fromBranchId) {
      push(`return ${String(r)} from-branch equals its landing branch`);
    }
    if (branchIdToTreeId(item.branchId) !== branchIdToTreeId(item.fromBranchId)) {
      // 产品语义：Return 落回同树主线（from 分支在同一树内探索）。
      push(`return ${String(r)} crosses trees (from ${item.fromBranchId} to ${item.branchId})`);
    }
    if (idempotencyKeys.has(item.idempotencyKey)) {
      push(`return ${String(r)} duplicate idempotency key ${item.idempotencyKey}`);
    }
    idempotencyKeys.add(item.idempotencyKey);
    const answer = answersByTurnId.get(item.anchorTurnId);
    if (answer === undefined) {
      push(`return ${String(r)} target anchor turn unknown`);
      continue;
    }
    const anchorPair = dataset.qaPairs.find((pair) => pair.assistantTurnId === item.anchorTurnId);
    if (anchorPair === undefined || anchorPair.branchId !== item.branchId) {
      push(`return ${String(r)} target anchor is not on the landing branch`);
      continue;
    }
    if (answer.slice(item.selStart, item.selEnd) !== item.selText) {
      push(`return ${String(r)} target selection does not slice-match the anchor answer`);
    }
  }

  // —— 冻结查询集 ——
  const queries = deriveB6FrozenQueries(dataset);
  if (queries.length !== B6_FROZEN_QUERY_COUNT) {
    push(`frozen queries: ${String(queries.length)} != ${String(B6_FROZEN_QUERY_COUNT)}`);
  }
  const queryTexts = new Set(queries.map((query) => query.text));
  if (queryTexts.size !== queries.length) push("frozen queries contain duplicates");

  // —— 导入样例（冻结配方边界）——
  const sample = generateB6ImportSamplePlan();
  if (sample.expectedPages !== B6_SAMPLE_PAGES) {
    push(`import sample pages: ${String(sample.expectedPages)} != ${String(B6_SAMPLE_PAGES)}`);
  }
  if (sample.expectedUnits > B6_PER_MATERIAL_MAX_UNITS) {
    push(`import sample units ${String(sample.expectedUnits)} > per-material cap`);
  }
  return problems;
}
