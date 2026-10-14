/** policy ownership for material-repository.ts; compatibility entrypoint remains one level above. */
import type {
  BranchOriginKind,
} from "./model.ts";
import type {
  MaterialParserKind,
  MaterialParseStatus,
} from "@treeai/contracts";

/* ------------------------------------------------------------------ */
/* 词汇表与校验辅助                                                     */
/* ------------------------------------------------------------------ */

export const PARSE_STATUSES: readonly MaterialParseStatus[] = [
  "pending",
  "parsing",
  "ready",
  "failed",
  "canceled",
  "unsupported",
  "rejected",
];

export const PARSER_KINDS: readonly MaterialParserKind[] = ["markdown", "pdf"];

export const ORIGIN_KINDS: readonly BranchOriginKind[] = ["none", "turn", "material"];

/** failed/unsupported/rejected 为导入/解析终态失败，必须携带原因。 */
export const FAILURE_STATUSES: readonly MaterialParseStatus[] = ["failed", "unsupported", "rejected"];

export const MATERIAL_COLUMNS = "material_id, title, created_at";


export const MATERIAL_VERSION_COLUMNS =
  "version_id, material_id, content_hash, parser_kind, parser_version, imported_at, " +
  "size_bytes, parse_status, parse_error, text_units, canonical_text, block_map_json";
