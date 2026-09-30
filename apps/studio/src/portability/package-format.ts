/**
 * D4-5 数据可携带 —— 导出包格式的冻结定义（issue #8 D4-5；契约 §5）。
 *
 * 包结构（`treeai-export-1`）：
 *
 * ```
 * <package>/
 *   manifest.json            # 本文件约定的清单（schemaVersion、条目+SHA-256、产品库 schema 版本）
 *   blobs/<content-hash>     # 材料原件（内容寻址；文件名 = 原件字节 SHA-256 十六进制）
 *   facts/<table>.json       # 每张产品事实表一个文件：{table, columns, rows} 确定性序列化
 *   sessions/<basename>      # 仅 --include-sessions：Pi session 原件（敏感；随包显著标注）
 *   SESSIONS-SENSITIVE.txt   # 仅 --include-sessions：敏感内容警示标记
 *   readable/…               # 仅 export --readable：人类可读 Markdown 导出
 * ```
 *
 * 零迁移（charter §5 / 本工作包约束）：导出元信息**全部派生自既有表与 blobs**
 * ——产品库 schema 版本取 `PRAGMA user_version`（= LATEST_SCHEMA_VERSION），
 * 无任何库内导出元数据表（原 0011 预留按弃用处理，不取迁移号）。
 *
 * 事实文件集是**冻结全集**：每次导出都写全全部 facts/<table>.json（空表
 * = 空 rows 数组），恢复时要求集合恰好相等——「多出的文件」与「缺失的
 * 文件」都拒绝（意外文件检测是全量的，不靠清单列举）。
 *
 * 确定性：facts/manifest 的字节由（库内容 + 显式选项）唯一决定——同一库、
 * 同一注入时钟的两次导出逐字节相同（含清单内全部 SHA-256）。
 */

import { LATEST_SCHEMA_VERSION } from "@treeai/persistence";

/* ------------------------------------------------------------------ */
/* 冻结常量                                                             */
/* ------------------------------------------------------------------ */

/** 清单自身的 schema 版本（manifest.json 顶层 schemaVersion 字段）。 */
export const MANIFEST_SCHEMA_VERSION = 1;

/** 导出包格式标识（manifest.json 顶层 packageFormat 字段）。 */
export const EXPORT_PACKAGE_FORMAT = "treeai-export-1";

/**
 * facts 布局对应的产品库 schema 版本。必须与当前 LATEST_SCHEMA_VERSION
 * 一致：仓库新增迁移时此断言在导出/恢复入口如实失败（提示先更新可携带
 * 层的事实表布局），绝不静默导出/恢复错版事实。
 */
export const FACTS_LAYOUT_SCHEMA_VERSION = LATEST_SCHEMA_VERSION;

/** 清单文件名（包根唯一非 entries 文件）。 */
export const MANIFEST_FILENAME = "manifest.json";

/** sessions 显式包含时的敏感内容警示标记文件名（包根）。 */
export const SESSIONS_SENSITIVE_MARKER = "SESSIONS-SENSITIVE.txt";

/** sessions 显式包含时的警示文案（随包显著标注：raw Pi 会话可能含隐私内容）。 */
export const SESSIONS_SENSITIVE_MARKER_TEXT = [
  "SENSITIVE CONTENT — Pi session transcripts are embedded in this package.",
  "",
  "The sessions/ directory contains raw Pi session JSONL files (full model",
  "conversations). They may include personal content and anything that was",
  "discussed during exploration. This package was exported with the explicit",
  "--include-sessions opt-in.",
  "",
  "Handle, store and share this package accordingly.",
  "",
].join("\n");

/* ------------------------------ 规模上限 ------------------------------ */

/** 单个材料原件条目上限 = 产品单文件上限（charter §5：20 MiB；超限即外来/损坏包）。 */
export const MAX_BLOB_ENTRY_BYTES = 20 * 1024 * 1024;

/** 单个 facts 条目上限（charter 规模上限的宽松护栏；真实 facts 远小于此）。 */
export const MAX_FACTS_ENTRY_BYTES = 512 * 1024 * 1024;

/** 单个 session 条目上限（Pi 会话 JSONL 无产品上限，以资源护栏代替）。 */
export const MAX_SESSION_ENTRY_BYTES = 256 * 1024 * 1024;

/** 单个可读导出条目上限。 */
export const MAX_READABLE_ENTRY_BYTES = 64 * 1024 * 1024;

/** 敏感标记文件上限（内容为冻结常量）。 */
export const MAX_MARKER_ENTRY_BYTES = 64 * 1024;

/** 整包总字节数上限（拒绝超限包——charter §5 / 契约 §5 路径与资源纪律）。 */
export const MAX_TOTAL_PACKAGE_BYTES = 4 * 1024 * 1024 * 1024;

/** 清单条目数上限。 */
export const MAX_ENTRY_COUNT = 200_000;

/* ------------------------------------------------------------------ */
/* 事实表布局（冻结；与 migration 0001–0009 的最终列集一一对应）          */
/* ------------------------------------------------------------------ */

/** 列类型（SQLite 动态类型在本包面的收紧：TEXT/INTEGER 两类 + nullability）。 */
export type FactColumnKind = "text" | "integer";

export interface FactColumnSpec {
  readonly name: string;
  readonly kind: FactColumnKind;
  /** 允许 NULL（由 schema 的 NOT NULL 反推；恢复校验逐格复核）。 */
  readonly nullable: boolean;
}

export interface FactTableSpec {
  /** facts/ 文件基名（= SQL 表名）。 */
  readonly table: string;
  /** 冻结列序（SELECT 列序 = facts 文件 columns 序 = 恢复 INSERT 列序）。 */
  readonly columns: readonly FactColumnSpec[];
  /** 确定性导出序（rowid 保持插入序；恢复按同序 INSERT，rowid 相对序一致）。 */
  readonly orderBy: string;
  /**
   * 引用完整性外键（恢复前的临时区校验；SQL FK/CHECK 在落库时为第二层）。
   * `references: "<table>.<column>"`；`column` 为 null 时按可空外键跳过。
   */
  readonly foreignKeys: ReadonlyArray<{ readonly column: string; readonly references: string }>;
}

function text(name: string, nullable = false): FactColumnSpec {
  return { name, kind: "text", nullable };
}
function integer(name: string, nullable = false): FactColumnSpec {
  return { name, kind: "integer", nullable };
}

/**
 * 冻结事实表全集（顺序即恢复 INSERT 依赖序的参考，但实际插入序由
 * RESTORE_INSERT_ORDER 显式给出）。material_blobs 不在此列——原件字节
 * 走 blobs/ 目录（表行 = blobs/<content_hash> 清单条目）。
 */
export const FACT_TABLES: readonly FactTableSpec[] = [
  {
    table: "forests",
    columns: [text("id"), text("created_at")],
    orderBy: "created_at, rowid",
    foreignKeys: [],
  },
  {
    table: "trees",
    columns: [text("id"), text("forest_id"), text("created_at")],
    orderBy: "created_at, rowid",
    foreignKeys: [{ column: "forest_id", references: "forests.id" }],
  },
  {
    table: "branches",
    columns: [text("id"), text("tree_id"), text("parent_branch_id", true), text("created_at"), text("origin_kind")],
    orderBy: "created_at, rowid",
    foreignKeys: [
      { column: "tree_id", references: "trees.id" },
      { column: "parent_branch_id", references: "branches.id" },
    ],
  },
  {
    table: "episodes",
    columns: [text("id"), text("branch_id"), text("created_at")],
    orderBy: "created_at, rowid",
    foreignKeys: [{ column: "branch_id", references: "branches.id" }],
  },
  {
    table: "runs",
    columns: [
      text("id"),
      text("episode_id"),
      text("state"),
      text("created_at"),
      text("terminal_at", true),
      text("terminal_state", true),
      text("failure_json", true),
    ],
    orderBy: "created_at, rowid",
    foreignKeys: [{ column: "episode_id", references: "episodes.id" }],
  },
  {
    table: "session_references",
    columns: [
      text("run_id"),
      text("session_id"),
      text("session_file"),
      text("entry_id"),
      text("pi_version"),
      text("availability_status"),
      text("availability_reason", true),
      text("availability_detail", true),
      text("created_at"),
      text("updated_at"),
    ],
    orderBy: "created_at, rowid",
    foreignKeys: [{ column: "run_id", references: "runs.id" }],
  },
  {
    table: "turns",
    columns: [
      text("id"),
      text("tree_id"),
      text("branch_id"),
      text("episode_id"),
      text("run_id", true),
      text("role"),
      text("text"),
      text("pi_entry_id", true),
      text("from_branch_id", true),
      text("delivered_run_id", true),
      text("created_at"),
      text("idempotency_key", true),
      text("target_anchor", true),
    ],
    orderBy: "created_at, rowid",
    foreignKeys: [
      { column: "tree_id", references: "trees.id" },
      { column: "branch_id", references: "branches.id" },
      { column: "episode_id", references: "episodes.id" },
      { column: "run_id", references: "runs.id" },
      { column: "from_branch_id", references: "branches.id" },
      { column: "delivered_run_id", references: "runs.id" },
    ],
  },
  {
    table: "branch_origins",
    columns: [
      text("branch_id"),
      text("source_branch_id"),
      text("anchor_turn_id"),
      text("anchor_entry_id"),
      integer("sel_start"),
      integer("sel_end"),
      text("sel_text"),
      text("created_at"),
    ],
    orderBy: "created_at, rowid",
    foreignKeys: [
      { column: "branch_id", references: "branches.id" },
      { column: "source_branch_id", references: "branches.id" },
      { column: "anchor_turn_id", references: "turns.id" },
    ],
  },
  {
    table: "tree_active_navigation",
    columns: [
      text("tree_id"),
      text("branch_id"),
      text("session_id"),
      text("session_file"),
      text("entry_id"),
      text("pi_version"),
      text("availability_status"),
      text("availability_reason", true),
      text("availability_detail", true),
      text("updated_at"),
    ],
    orderBy: "tree_id",
    foreignKeys: [
      { column: "tree_id", references: "trees.id" },
      { column: "branch_id", references: "branches.id" },
    ],
  },
  {
    table: "return_adoption_attempts",
    columns: [text("return_turn_id"), text("run_id"), text("attempted_at")],
    orderBy: "attempted_at, rowid",
    foreignKeys: [
      { column: "return_turn_id", references: "turns.id" },
      { column: "run_id", references: "runs.id" },
    ],
  },
  {
    table: "terminology_annotations",
    columns: [
      text("id"),
      text("tree_id"),
      text("branch_id"),
      text("anchor_turn_id"),
      integer("sel_start"),
      integer("sel_end"),
      text("sel_text"),
      text("source_hash"),
      text("term"),
      text("explanation"),
      text("mode"),
      text("promoted_branch_id", true),
      text("promotion_key", true),
      text("created_at"),
    ],
    orderBy: "created_at, rowid",
    foreignKeys: [
      { column: "tree_id", references: "trees.id" },
      { column: "branch_id", references: "branches.id" },
      { column: "anchor_turn_id", references: "turns.id" },
      { column: "promoted_branch_id", references: "branches.id" },
    ],
  },
  {
    table: "terminology_promotion_dispatches",
    columns: [
      text("id"),
      text("annotation_id"),
      text("tree_id"),
      text("promotion_key"),
      text("branch_id"),
      text("first_question_hash"),
      text("dispatch_state"),
      integer("attempts"),
      text("run_id", true),
      text("failure_json", true),
      text("created_at"),
      text("updated_at"),
    ],
    orderBy: "created_at, rowid",
    foreignKeys: [
      { column: "annotation_id", references: "terminology_annotations.id" },
      { column: "tree_id", references: "trees.id" },
      { column: "branch_id", references: "branches.id" },
      { column: "run_id", references: "runs.id" },
    ],
  },
  {
    table: "terminology_state",
    columns: [text("key"), text("value")],
    orderBy: "key",
    foreignKeys: [],
  },
  {
    table: "materials",
    columns: [text("material_id"), text("title"), text("created_at")],
    orderBy: "created_at, rowid",
    foreignKeys: [],
  },
  {
    table: "material_versions",
    columns: [
      text("version_id"),
      text("material_id"),
      text("content_hash"),
      text("parser_kind"),
      text("parser_version"),
      text("imported_at"),
      integer("size_bytes"),
      text("parse_status"),
      text("parse_error", true),
      integer("text_units"),
      text("canonical_text"),
      text("block_map_json"),
    ],
    orderBy: "imported_at, rowid",
    foreignKeys: [{ column: "material_id", references: "materials.material_id" }],
  },
  {
    table: "tree_material_links",
    columns: [text("tree_id"), text("material_id"), text("linked_at")],
    orderBy: "tree_id, material_id",
    foreignKeys: [
      { column: "tree_id", references: "trees.id" },
      { column: "material_id", references: "materials.material_id" },
    ],
  },
  {
    table: "material_branch_origins",
    columns: [
      text("branch_id"),
      text("tree_id"),
      text("material_id"),
      text("version_id"),
      text("block_id"),
      integer("start"),
      integer("end"),
      text("excerpt"),
      text("source_hash"),
      text("created_at"),
    ],
    orderBy: "created_at, rowid",
    foreignKeys: [
      { column: "branch_id", references: "branches.id" },
      { column: "tree_id", references: "trees.id" },
      { column: "material_id", references: "materials.material_id" },
      { column: "version_id", references: "material_versions.version_id" },
    ],
  },
  {
    table: "tree_material_reading_state",
    columns: [text("tree_id"), text("material_id"), text("version_id"), text("block_id", true), integer("focus_start", true), text("updated_at")],
    orderBy: "tree_id, material_id",
    foreignKeys: [
      { column: "tree_id", references: "trees.id" },
      { column: "material_id", references: "materials.material_id" },
      { column: "version_id", references: "material_versions.version_id" },
    ],
  },
  {
    table: "material_first_questions",
    columns: [text("intent_key"), text("tree_id"), text("branch_id"), text("created_at")],
    orderBy: "tree_id, intent_key",
    foreignKeys: [
      { column: "tree_id", references: "trees.id" },
      { column: "branch_id", references: "branches.id" },
    ],
  },
];

/** facts 文件基名 → 表规格（恢复校验用）。 */
export const FACT_TABLES_BY_NAME: ReadonlyMap<string, FactTableSpec> = new Map(
  FACT_TABLES.map((spec) => [spec.table, spec]),
);

/** 表 → 主键列（PK 唯一性校验 + 引用完整性集合构造）。 */
export const TABLE_PRIMARY_KEYS: Readonly<Record<string, readonly string[]>> = {
  forests: ["id"],
  trees: ["id"],
  branches: ["id"],
  episodes: ["id"],
  runs: ["id"],
  session_references: ["run_id"],
  turns: ["id"],
  branch_origins: ["branch_id"],
  tree_active_navigation: ["tree_id"],
  return_adoption_attempts: ["return_turn_id", "run_id"],
  terminology_annotations: ["id"],
  terminology_promotion_dispatches: ["id"],
  terminology_state: ["key"],
  materials: ["material_id"],
  material_versions: ["version_id"],
  tree_material_links: ["tree_id", "material_id"],
  material_branch_origins: ["branch_id"],
  tree_material_reading_state: ["tree_id", "material_id"],
  material_first_questions: ["tree_id", "intent_key"],
};

/**
 * 恢复 INSERT 序（外键依赖先行；blobs 最先——material_versions 引用
 * material_blobs.content_hash，而 blobs 不走 facts 文件）。
 */
export const RESTORE_INSERT_ORDER: readonly string[] = [
  "forests",
  "trees",
  "branches",
  "episodes",
  "materials",
  "material_versions",
  "runs",
  "session_references",
  "turns",
  "branch_origins",
  "material_branch_origins",
  "tree_material_links",
  "tree_material_reading_state",
  "material_first_questions",
  "return_adoption_attempts",
  "terminology_annotations",
  "terminology_promotion_dispatches",
  "terminology_state",
  "tree_active_navigation",
];

/* ------------------------------------------------------------------ */
/* 清单形状                                                             */
/* ------------------------------------------------------------------ */

export type ManifestEntryKind = "facts" | "blob" | "session" | "readable" | "marker";

export interface ExportManifestEntry {
  readonly kind: ManifestEntryKind;
  /** 包内 POSIX 相对路径（安全规则见 assertSafePackagePath）。 */
  readonly path: string;
  readonly bytes: number;
  /** 文件字节 SHA-256（十六进制）。 */
  readonly sha256: string;
}

export interface ExportManifest {
  /** 清单 schema 版本（本文件约定，与产品库 schema 版本相互独立）。 */
  readonly schemaVersion: number;
  /** 包格式标识。 */
  readonly packageFormat: string;
  /** 被导出产品库的 schema 版本（PRAGMA user_version）。 */
  readonly productSchemaVersion: number;
  /** 导出时刻（ISO 8601；注入时钟决定——确定性测试可冻结）。 */
  readonly exportedAt: string;
  /** 是否显式包含 Pi session 原件（--include-sessions）。 */
  readonly includesSessions: boolean;
  /** 是否含可读 Markdown 导出（export --readable）。 */
  readonly readable: boolean;
  /** 事实行数（表名 → 行数）+ { blobs, sessions, sessionFilesMissing }。 */
  readonly counts: Readonly<Record<string, number>>;
  /** 全部包文件（manifest.json 自身除外；按 path 排序）。 */
  readonly entries: readonly ExportManifestEntry[];
}

/** 单个 facts 文件的形状：{table, columns, rows}（rows 为列序值数组）。 */
export interface FactsFileShape {
  readonly table: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly (string | number | null)[])[];
}

/* ------------------------------------------------------------------ */
/* 错误（稳定原因码；测试与 CLI 按码断言）                                */
/* ------------------------------------------------------------------ */

/** D4-5 可携带层错误：code 是稳定原因码，message 面向用户。 */
export class PortabilityError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "PortabilityError";
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* 路径安全（契约 §5：拒绝路径穿越）                                     */
/* ------------------------------------------------------------------ */

const MAX_PATH_TOTAL = 1024;
const MAX_SEGMENT_LENGTH = 200;

/**
 * 包内相对路径安全规则：POSIX 相对路径、无 `..`/绝对/反斜杠/空段/控制
 * 字符、长度护栏。违反 → PortabilityError("path-unsafe")。
 */
export function assertSafePackagePath(relPath: string, context: string): void {
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new PortabilityError("path-unsafe", `${context}: package path must be a non-empty string`);
  }
  if (relPath.length > MAX_PATH_TOTAL) {
    throw new PortabilityError("path-unsafe", `${context}: package path exceeds ${MAX_PATH_TOTAL} characters`);
  }
  if (relPath.includes("\\")) {
    throw new PortabilityError("path-unsafe", `${context}: package path must use '/' separators (got '${relPath}')`);
  }
  if (relPath.startsWith("/") || /^[A-Za-z]:/.test(relPath)) {
    throw new PortabilityError("path-unsafe", `${context}: package path must be relative (got '${relPath}')`);
  }
  const segments = relPath.split("/");
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new PortabilityError("path-unsafe", `${context}: package path has an empty segment ('${relPath}')`);
    }
    if (segment === "." || segment === "..") {
      throw new PortabilityError(
        "path-unsafe",
        `${context}: package path must not traverse ('${relPath}' contains '${segment}')`,
      );
    }
    if (segment.length > MAX_SEGMENT_LENGTH) {
      throw new PortabilityError("path-unsafe", `${context}: package path segment exceeds ${MAX_SEGMENT_LENGTH} characters`);
    }
    if (/[\u0000-\u001f\u007f]/.test(segment)) {
      throw new PortabilityError("path-unsafe", `${context}: package path contains control characters`);
    }
  }
}

/** blobs/<content-hash> 的文件名规则：64 位十六进制小写。 */
export function assertBlobFileName(path: string, context: string): void {
  const match = /^blobs\/([0-9a-f]{64})$/.exec(path);
  if (match === null) {
    throw new PortabilityError(
      "path-unsafe",
      `${context}: blob entries must be 'blobs/<64-hex lowercase sha256>' (got '${path}')`,
    );
  }
}

/** sessions/<basename> 的文件名规则：单段安全名。 */
export function assertSessionFileName(path: string, context: string): void {
  const match = /^sessions\/([^/]+)$/.exec(path);
  if (match === null) {
    throw new PortabilityError(
      "path-unsafe",
      `${context}: session entries must be 'sessions/<basename>' with no further directories (got '${path}')`,
    );
  }
}

/** 条目种类 → 单条目字节上限。 */
export function maxEntryBytesForKind(kind: ManifestEntryKind): number {
  switch (kind) {
    case "blob":
      return MAX_BLOB_ENTRY_BYTES;
    case "facts":
      return MAX_FACTS_ENTRY_BYTES;
    case "session":
      return MAX_SESSION_ENTRY_BYTES;
    case "readable":
      return MAX_READABLE_ENTRY_BYTES;
    case "marker":
      return MAX_MARKER_ENTRY_BYTES;
  }
}

/* ------------------------------------------------------------------ */
/* 确定性 JSON                                                          */
/* ------------------------------------------------------------------ */

/**
 * 稳定 JSON 序列化：对象键递归排序（数组保序）、无空白（compact）。
 * 同一数据结构 → 唯一字节序列（导出/清单确定性的基础）。
 */
export function stableStringify(value: unknown): string {
  return serializeStable(value);
}

function serializeStable(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => serializeStable(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${serializeStable(v)}`).join(",")}}`;
  }
  throw new PortabilityError("serialize-invalid", `cannot serialize value of type '${typeof value}'`);
}

/** facts 文件字节：stableStringify(shape) + 换行。 */
export function encodeFactsFile(shape: FactsFileShape): string {
  return `${stableStringify(shape)}\n`;
}

/** 清单字节：稳定键序 + 2 空格缩进（人类可读）+ 换行。 */
export function encodeManifestFile(manifest: ExportManifest): string {
  return `${stringifyStablePretty(manifest)}\n`;
}

function stringifyStablePretty(value: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  const innerPad = "  ".repeat(indent + 1);
  if (value === null || typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[\n${value.map((item) => `${innerPad}${stringifyStablePretty(item, indent + 1)}`).join(",\n")}\n${pad}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (entries.length === 0) return "{}";
    return `{\n${entries
      .map(([k, v]) => `${innerPad}${JSON.stringify(k)}: ${stringifyStablePretty(v, indent + 1)}`)
      .join(",\n")}\n${pad}}`;
  }
  throw new PortabilityError("serialize-invalid", `cannot serialize value of type '${typeof value}'`);
}

/* ------------------------------------------------------------------ */
/* 布局守卫（模块加载时静态自检：facts 布局必须与迁移注册表同步演进）       */
/* ------------------------------------------------------------------ */

/** facts 布局 ↔ 迁移注册表一致性守卫（导出/恢复入口调用；失配即如实失败）。 */
export function assertFactsLayoutCurrent(): void {
  if (FACTS_LAYOUT_SCHEMA_VERSION !== LATEST_SCHEMA_VERSION) {
    throw new PortabilityError(
      "facts-layout-stale",
      `the export/restore facts layout targets product schema ${FACTS_LAYOUT_SCHEMA_VERSION}, but this build ` +
        `supports schema ${LATEST_SCHEMA_VERSION}; update the portability layer (FACT_TABLES) before exporting or ` +
        "restoring (packages are only portable between identical fact layouts)",
    );
  }
  const factNames = new Set(FACT_TABLES.map((spec) => spec.table));
  if (factNames.size !== FACT_TABLES.length) {
    throw new PortabilityError("facts-layout-invalid", "FACT_TABLES contains duplicate table names");
  }
  const insertNames = new Set(RESTORE_INSERT_ORDER);
  for (const name of factNames) {
    if (!insertNames.has(name)) {
      throw new PortabilityError("facts-layout-invalid", `RESTORE_INSERT_ORDER is missing table '${name}'`);
    }
  }
  for (const name of insertNames) {
    if (!factNames.has(name)) {
      throw new PortabilityError("facts-layout-invalid", `RESTORE_INSERT_ORDER references unknown table '${name}'`);
    }
  }
  for (const name of factNames) {
    const pk = TABLE_PRIMARY_KEYS[name];
    if (pk === undefined || pk.length === 0) {
      throw new PortabilityError("facts-layout-invalid", `TABLE_PRIMARY_KEYS is missing table '${name}'`);
    }
    const columns = new Set(FACT_TABLES_BY_NAME.get(name)!.columns.map((column) => column.name));
    for (const column of pk) {
      if (!columns.has(column)) {
        throw new PortabilityError("facts-layout-invalid", `TABLE_PRIMARY_KEYS['${name}'] references unknown column '${column}'`);
      }
    }
  }
}
