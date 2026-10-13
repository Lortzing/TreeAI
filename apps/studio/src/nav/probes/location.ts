/** location ownership for b9-probes.ts; compatibility entrypoint remains one level above. */
import type {
  ProbeContext,
} from "./model.ts";
import {
  ancestorsOfTruth,
  nodeOf,
  truthChildren,
} from "./truth.ts";

export function verifyLocation(context: ProbeContext, branchId: string, failures: string[], label: string): void {
  const { dataset, engine } = context;
  const { tree, node } = nodeOf(dataset, branchId);
  const location = engine.locateBranch(branchId);
  if (location.treeId !== tree.treeId) {
    failures.push(`${label}: treeId ${location.treeId} !== truth ${tree.treeId}`);
  }
  if (location.node.id !== node.id || location.node.parentBranchId !== node.parentId) {
    failures.push(`${label}: node identity mismatch`);
  }
  if (location.node.depth !== node.depth) {
    failures.push(`${label}: depth ${String(location.node.depth)} !== ${String(node.depth)}`);
  }
  if (location.node.title !== node.title) {
    failures.push(`${label}: title mismatch (engine ${JSON.stringify(location.node.title)} / truth ${JSON.stringify(node.title)})`);
  }
  const truthAncestors = ancestorsOfTruth(dataset, node);
  if (location.ancestors.length !== truthAncestors.length) {
    failures.push(`${label}: ancestors length ${String(location.ancestors.length)} !== ${String(truthAncestors.length)}`);
  } else {
    for (let i = 0; i < truthAncestors.length; i += 1) {
      const got = location.ancestors[i]!;
      const want = truthAncestors[i]!;
      if (got.id !== want.id || got.title !== want.title || got.depth !== want.depth) {
        failures.push(`${label}: ancestor[${String(i)}] ${got.id} mismatch (want ${want.id})`);
      }
    }
  }
  if (location.path.length !== truthAncestors.length + 1 || location.path[location.path.length - 1]?.id !== node.id) {
    failures.push(`${label}: full path must end at the node itself`);
  }
  // 兄弟位次
  if (node.parentId === null) {
    if (location.siblingPosition !== null) failures.push(`${label}: trunk must have null siblingPosition`);
  } else {
    const siblings = truthChildren(tree, node.parentId).map((child) => child.id);
    const position = siblings.indexOf(node.id);
    if (
      location.siblingPosition === null ||
      location.siblingPosition.index !== position ||
      location.siblingPosition.total !== siblings.length
    ) {
      failures.push(
        `${label}: siblingPosition ${JSON.stringify(location.siblingPosition)} !== truth {index:${String(position)}, total:${String(siblings.length)}}`,
      );
    }
  }
  // 来源类型标记 + 来源引用
  if (location.node.originKind !== node.originKind) {
    failures.push(`${label}: originKind ${location.node.originKind} !== ${node.originKind}`);
  }
  if (node.origin === null) {
    if (location.origin !== null) failures.push(`${label}: origin should be null`);
  } else if (location.origin === null) {
    failures.push(`${label}: origin missing`);
  } else if (node.origin.kind === "turn" && location.origin.kind === "turn") {
    if (
      location.origin.sourceBranchId !== node.origin.sourceBranchId ||
      location.origin.anchorTurnId !== node.origin.anchorTurnId ||
      location.origin.anchorEntryId !== node.origin.anchorEntryId ||
      location.origin.selection.start !== node.origin.selStart ||
      location.origin.selection.end !== node.origin.selEnd ||
      location.origin.selection.text !== node.origin.selText
    ) {
      failures.push(`${label}: turn origin ref mismatch`);
    }
  } else if (node.origin.kind === "material" && location.origin.kind === "material") {
    if (
      location.origin.materialId !== node.origin.materialId ||
      location.origin.versionId !== node.origin.versionId ||
      location.origin.blockId !== node.origin.blockId ||
      location.origin.start !== node.origin.start ||
      location.origin.end !== node.origin.end ||
      location.origin.excerpt !== node.origin.excerpt
    ) {
      failures.push(`${label}: material origin ref mismatch`);
    }
  } else {
    failures.push(`${label}: origin kind mismatch (${location.origin.kind} / ${node.origin.kind})`);
  }
}

export function pageThroughChildren(
  context: ProbeContext,
  treeId: string,
  parentId: string,
  limit: number,
  failures: string[],
  label: string,
): string[] {
  const collected: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    const page = context.engine.listChildren(treeId, parentId, { limit, cursor });
    pages += 1;
    if (pages > 200) {
      failures.push(`${label}: exceeded 200 pages (pagination runaway)`);
      break;
    }
    collected.push(...page.nodes.map((node) => node.id));
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  const unique = new Set(collected);
  if (unique.size !== collected.length) {
    failures.push(`${label}: duplicates across pages (${String(collected.length - unique.size)} dup entries)`);
  }
  return collected;
}
