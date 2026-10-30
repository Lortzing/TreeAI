import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { UiGenerationContext } from "@treeai/contracts";
import { InvalidArgumentError } from "./errors.ts";
import { validateUiContext, validateComparisonArtifact } from "./generative-ui-validation.ts";

/** Relational ownership is checked separately from the immutable source snapshot.
 * Changed source text may degrade location; it must never erase a saved card. */
export function validateUiOwnership(db: DatabaseSync, treeId: string, branchId: string, anchorId: string, context: UiGenerationContext): void {
  const anchor = db.prepare("SELECT t.tree_id,t.branch_id,t.role,b.parent_branch_id FROM turns t JOIN branches b ON b.id=t.branch_id WHERE t.id=?").get(anchorId);
  if (!anchor || anchor.tree_id !== treeId || anchor.branch_id !== branchId || anchor.role !== "assistant" || anchor.parent_branch_id === null) throw new InvalidArgumentError("对比卡锚点身份无效。");
  const primary = context.sources[0];
  if (primary?.kind !== "turn" || primary.key !== "s1" || primary.turnId !== anchorId || primary.branchId !== branchId || context.sources.length > 2) throw new InvalidArgumentError("对比卡缺少当前回答来源。");
  for (const source of context.sources) {
    if (source.kind === "turn") {
      const turn = db.prepare("SELECT tree_id,branch_id,role FROM turns WHERE id=?").get(source.turnId);
      if (!turn || turn.tree_id !== treeId || turn.branch_id !== source.branchId || turn.role !== "assistant") throw new InvalidArgumentError("对比卡来源不属于当前树。");
      if (source !== primary) {
        const origin = db.prepare("SELECT * FROM branch_origins WHERE branch_id=?").get(branchId);
        if (source.key !== "s2" || !origin || source.turnId !== origin.anchor_turn_id || source.branchId !== origin.source_branch_id || source.start !== origin.sel_start || source.end !== origin.sel_end || source.text !== origin.sel_text) throw new InvalidArgumentError("对比卡出处与支线原选区不一致。");
      }
    } else {
      const selection = source.selection;
      const version = db.prepare("SELECT v.version_id FROM material_versions v JOIN tree_material_links l ON l.material_id=v.material_id WHERE v.version_id=? AND v.material_id=? AND l.tree_id=?").get(selection.versionId, selection.materialId, treeId);
      if (!version) throw new InvalidArgumentError("对比卡材料版本身份无效。");
      const origin = db.prepare("SELECT * FROM material_branch_origins WHERE branch_id=?").get(branchId);
      if (source.key !== "s2" || !origin || selection.materialId !== origin.material_id || selection.versionId !== origin.version_id || selection.blockId !== origin.block_id || selection.start !== origin.start || selection.end !== origin.end || selection.excerpt !== origin.excerpt || selection.sourceHash !== origin.source_hash) throw new InvalidArgumentError("对比卡材料出处与支线原选区不一致。");
    }
  }
}

/** Used inside the restore transaction, before publishing any imported files. */
export function validateGenerativeUiStorage(db: DatabaseSync): void {
  for (const row of db.prepare("SELECT * FROM generative_ui_tasks").all()) {
    const context = validateUiContext(JSON.parse(String(row.context_json)));
    if (createHash("sha256").update(JSON.stringify(context)).digest("hex") !== row.context_hash) throw new InvalidArgumentError("对比卡来源快照校验失败。");
    validateUiOwnership(db, String(row.tree_id), String(row.branch_id), String(row.anchor_turn_id), context);
    if (row.artifact_json !== null) validateComparisonArtifact(JSON.parse(String(row.artifact_json)), context);
  }
}
