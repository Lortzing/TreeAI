/** serialization ownership for material-repository.ts; compatibility entrypoint remains one level above. */
import type {
  FirstQuestionRow,
  MaterialBranchOriginRow,
  MaterialFirstQuestion,
  MaterialRow,
  MaterialVersionRow,
  ReadingPositionRow,
} from "./model.ts";
import {
  assertParserKind,
  assertParseStatus,
} from "./validation.ts";
import type {
  BranchId,
  IsoTimestamp,
  Material,
  MaterialBranchOrigin,
  MaterialId,
  MaterialReadingPosition,
  MaterialVersion,
  MaterialVersionId,
  TreeId,
} from "@treeai/contracts";

export function rowToMaterial(row: MaterialRow): Material {
  return { id: row.material_id as MaterialId, title: row.title, createdAt: row.created_at as IsoTimestamp };
}

/** canonicalText 与 block map 不进 MaterialVersion（按块分页读取归 D4-2 API）。 */
export function rowToMaterialVersion(row: MaterialVersionRow): MaterialVersion {
  return {
    id: row.version_id as MaterialVersionId,
    materialId: row.material_id as MaterialId,
    contentHash: row.content_hash,
    parserKind: assertParserKind(row.parser_kind, `material version ${row.version_id}`),
    parserVersion: row.parser_version,
    importedAt: row.imported_at as IsoTimestamp,
    sizeBytes: Number(row.size_bytes),
    parseStatus: assertParseStatus(row.parse_status, `material version ${row.version_id}`),
    parseError: row.parse_error ?? null,
    textUnits: Number(row.text_units),
  };
}

export function rowToMaterialBranchOrigin(row: MaterialBranchOriginRow): MaterialBranchOrigin {
  return {
    branchId: row.branch_id as BranchId,
    treeId: row.tree_id as TreeId,
    selection: {
      materialId: row.material_id as MaterialId,
      versionId: row.version_id as MaterialVersionId,
      blockId: row.block_id,
      start: Number(row.start),
      end: Number(row.end),
      excerpt: row.excerpt,
      sourceHash: row.source_hash,
    },
    sourceHash: row.source_hash,
    createdAt: row.created_at as IsoTimestamp,
  };
}

export function rowToReadingPosition(row: ReadingPositionRow): MaterialReadingPosition {
  return {
    treeId: row.tree_id as TreeId,
    materialId: row.material_id as MaterialId,
    versionId: row.version_id as MaterialVersionId,
    blockId: row.block_id ?? null,
    focusStart: row.focus_start === null ? null : Number(row.focus_start),
    updatedAt: row.updated_at as IsoTimestamp,
  };
}

export function rowToFirstQuestion(row: FirstQuestionRow): MaterialFirstQuestion {
  return {
    treeId: row.tree_id as TreeId,
    intentKey: row.intent_key,
    branchId: row.branch_id as BranchId,
    createdAt: row.created_at as IsoTimestamp,
  };
}
