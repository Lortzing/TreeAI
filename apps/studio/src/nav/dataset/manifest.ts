/** manifest ownership for b9-dataset.ts; compatibility entrypoint remains one level above. */
import type {
  B9Dataset,
  B9Manifest,
  B9TreeStats,
} from "./model.ts";
import {
  B9_SET_ID,
} from "./policy.ts";
import {
  createHash,
} from "node:crypto";

/* ------------------------------------------------------------------ */
/* 序列化 + manifest                                                    */
/* ------------------------------------------------------------------ */

/** 结构真值 JSON（紧凑、键序固定——同一数据集字节级恒等）。 */
export function serializeB9Dataset(dataset: B9Dataset): string {
  return JSON.stringify(dataset);
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function buildB9Manifest(dataset: B9Dataset, structureTruthJson: string): B9Manifest {
  const trees: B9TreeStats[] = dataset.trees.map((tree) => {
    let maxDepth = 0;
    let turnOrigins = 0;
    let materialOrigins = 0;
    for (const node of tree.nodes) {
      if (node.depth > maxDepth) maxDepth = node.depth;
      if (node.originKind === "turn") turnOrigins += 1;
      if (node.originKind === "material") materialOrigins += 1;
    }
    return {
      treeId: tree.treeId,
      kind: tree.kind,
      rule: tree.rule,
      nodes: tree.nodes.length,
      nonTrunkBranches: tree.nodes.length - 1,
      maxDepth,
      turnOrigins,
      materialOrigins,
    };
  });
  return {
    version: 1,
    setId: B9_SET_ID,
    seed: dataset.seed,
    structureTruthSha256: sha256Hex(structureTruthJson),
    structureTruthBytes: Buffer.byteLength(structureTruthJson, "utf8"),
    trees,
    totals: dataset.totals,
  };
}

export function serializeB9Manifest(manifest: B9Manifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
