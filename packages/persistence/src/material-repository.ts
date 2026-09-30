/**
 * MaterialRepository：D4 材料层仓储（材料 / 内容寻址原件 / 不可变版本 /
 * 树链接 / 材料来源 / 阅读状态 / 首问幂等，migration 0008）。
 *
 * 边界（ADR-001 §4、ADR-003 §1）：
 * - TreeAI DB 是产品事实源；本仓储不依赖、不访问 Pi session 文件；
 * - 材料来源永不携带 anchorTurnId/piEntryId（材料没有 Pi 分叉点——
 *   charter §3.2）；Turn 来源（branch_origins）仍归 TreeRepository，
 *   本仓储只经 `getBranchOrigin` 统一读取（ADR-003 §2）。
 *
 * 存储纪律：
 * - 内容寻址：material_blobs 以 content_hash（原件字节 SHA-256）为键，
 *   `storeBlob` 幂等（同字节全局一份）；
 * - 版本不可变：`insertVersion` 以 UNIQUE(material_id, content_hash)
 *   强制——同材料重复导入相同字节**复用既有版本**（返回原行，不重复、
 *   不改写）；内容变化产生新版本，旧摘录/批注/来源锚点不受影响
 *   （charter §3.1）；
 * - 选区纪律（与 branch_origins 的 Turn 来源同一纪律，按材料改写）：
 *   excerpt === canonicalText.slice(start, end)、区间在版本边界内、
 *   blockId 存在于版本 block map 且区间含于该块、sourceHash ===
 *   canonicalText 的 SHA-256（`getMaterialSelection` 校验，schema CHECK
 *   互为防御）；
 * - 仅 parse_status = 'ready' 的版本可建枝（拒绝并说明原因，不把不支持
 *   伪装成成功空文档——charter §3.2）；
 * - 每枝至多一条来源：material_branch_origins 与 branch_origins 各以
 *   branch_id 为主键，写入前显式查两表；「origin_kind 与来源类型一致」
 *   由写入路径同事务维护（`setBranchOriginKind` 做一致性校验）；
 * - 首问幂等：PRIMARY KEY(tree_id, intent_key)——重放同键返回既有行
 *   （ADR-003 §4，与 return idempotencyKey / 术语 promotionKey 同一
 *   树内唯一模式）。
 *
 * 事务：写路径使用 `BEGIN IMMEDIATE`（写前取锁）；嵌套调用以
 * SAVEPOINT 实现内层独立回滚（与 TreeRepository 同一约定）。
 */
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  BranchOrigin,
  BranchId,
  IsoTimestamp,
  Material,
  MaterialBlock,
  MaterialBranchOrigin,
  MaterialId,
  MaterialParseStatus,
  MaterialParserKind,
  MaterialReadingPosition,
  MaterialSelection,
  MaterialVersion,
  MaterialVersionId,
  TreeId,
} from "@treeai/contracts";
import {
  DatabaseCorruptError,
  EntityNotFoundError,
  InvalidArgumentError,
  mapSqliteError,
  RepositoryClosedError,
} from "./errors.ts";
import { openDatabase } from "./database.ts";
import { rowToBranchOrigin, type BranchOriginRow } from "./serialization.ts";

/* ------------------------------------------------------------------ */
/* 词汇表与校验辅助                                                     */
/* ------------------------------------------------------------------ */

const PARSE_STATUSES: readonly MaterialParseStatus[] = [
  "pending",
  "parsing",
  "ready",
  "failed",
  "canceled",
  "unsupported",
  "rejected",
];

const PARSER_KINDS: readonly MaterialParserKind[] = ["markdown", "pdf"];

/** branches.origin_kind 的合法取值（migration 0008 CHECK 同集合）。 */
export type BranchOriginKind = "none" | "turn" | "material";

const ORIGIN_KINDS: readonly BranchOriginKind[] = ["none", "turn", "material"];

/** failed/unsupported/rejected 为导入/解析终态失败，必须携带原因。 */
const FAILURE_STATUSES: readonly MaterialParseStatus[] = ["failed", "unsupported", "rejected"];

function isParseStatus(value: string): value is MaterialParseStatus {
  return (PARSE_STATUSES as readonly string[]).includes(value);
}

function isParserKind(value: string): value is MaterialParserKind {
  return (PARSER_KINDS as readonly string[]).includes(value);
}

function isOriginKind(value: string): value is BranchOriginKind {
  return (ORIGIN_KINDS as readonly string[]).includes(value);
}

function assertNonEmptyString(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidArgumentError(`${field} must be a non-empty string`);
  }
}

/** 原件字节 SHA-256（十六进制；内容寻址键）。 */
function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * 版本 canonicalText 的 SHA-256（十六进制，UTF-8 编码口径）——
 * 与术语批注 hashSourceText 同一纪律（ADR-003 §2 sourceHash）。
 */
function hashCanonicalText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/* ------------------------------------------------------------------ */
/* 选项与输入形状                                                       */
/* ------------------------------------------------------------------ */

export interface MaterialRepositoryOptions {
  /** 数据库文件路径；`":memory:"` 为纯内存库。 */
  readonly path: string;
  /** 时钟注入（默认真实 UTC ISO 8601）。 */
  readonly now?: () => IsoTimestamp;
  /** 原始 id 生成器注入（默认 randomUUID；仓储自动加实体前缀）。 */
  readonly generateId?: () => string;
  /** 写锁等待毫秒数（默认 5000）。 */
  readonly busyTimeoutMs?: number;
}

export interface CreateMaterialInput {
  readonly id?: MaterialId;
  /** 可编辑显示名；不是身份（文件名不是身份——charter §3.1）。 */
  readonly title: string;
}

export interface InsertMaterialVersionInput {
  readonly id?: MaterialVersionId;
  readonly materialId: MaterialId;
  /** 原件字节（先经内容寻址入库；同材料同字节复用既有版本）。 */
  readonly bytes: Uint8Array;
  readonly parserKind: MaterialParserKind;
  /** 解析器版本（如 "d4-md-v1" / "d4-pdf-v1"）。 */
  readonly parserVersion: string;
  readonly parseStatus: MaterialParseStatus;
  /** failed/unsupported/rejected 必填（原因码+说明）；其他状态必须为 null/缺省。 */
  readonly parseError?: string | null;
  /** 版本 canonicalText（解析器产出；未解析状态可为空串）。 */
  readonly canonicalText: string;
  /** canonicalText 的有序连续块覆盖（MaterialBlock[]）。 */
  readonly blocks: readonly MaterialBlock[];
}

export interface TreeMaterialLink {
  readonly treeId: TreeId;
  readonly materialId: MaterialId;
  readonly linkedAt: IsoTimestamp;
}

export interface UpsertReadingPositionInput {
  readonly treeId: TreeId;
  readonly materialId: MaterialId;
  readonly versionId: MaterialVersionId;
  /** 最后阅读块；null = 未开始。给出时必须存在于版本 block map。 */
  readonly blockId?: string | null;
  /** 可选：块内关注偏移；要求 blockId 同时给出且落在该块区间内。 */
  readonly focusStart?: number | null;
}

export interface MaterialFirstQuestion {
  readonly treeId: TreeId;
  readonly intentKey: string;
  readonly branchId: BranchId;
  readonly createdAt: IsoTimestamp;
}

export interface InsertFirstQuestionInput {
  readonly treeId: TreeId;
  readonly branchId: BranchId;
  /** 提交意图身份（树内唯一；双击/重试/重启重放同键返回同一 Branch）。 */
  readonly intentKey: string;
}

export interface InsertFirstQuestionResult {
  readonly question: MaterialFirstQuestion;
  /** true = 幂等重放（既有行原样返回，不重复建枝、不重复派发首问）。 */
  readonly replayed: boolean;
}

export interface InsertMaterialBranchOriginInput {
  readonly branchId: BranchId;
  readonly treeId: TreeId;
  readonly selection: MaterialSelection;
}

/** getMaterialSelection 的校验结果：选区 + 锚定所需的材料与版本上下文。 */
export interface MaterialSelectionContext {
  /** 已校验的选区（切片/摘录/块/sourceHash 一致性全部通过）。 */
  readonly selection: MaterialSelection;
  readonly material: Material;
  readonly version: MaterialVersion;
}

/**
 * 统一来源读取（ADR-003 §2）：Turn 来源或 Material 来源或 null。
 * 判别以两张来源表的实际行为准（各自 branch_id 主键结构性保证每枝
 * 至多一条；两表同时有行按库损坏处理）。
 */
export type BranchOriginRef =
  | { readonly kind: "turn"; readonly origin: BranchOrigin }
  | { readonly kind: "material"; readonly origin: MaterialBranchOrigin };

/* ------------------------------------------------------------------ */
/* 行形状与领域还原（本仓储私有；canonicalText/block map 不外泄到契约形状） */
/* ------------------------------------------------------------------ */

interface MaterialRow {
  material_id: string;
  title: string;
  created_at: string;
}

interface MaterialVersionRow {
  version_id: string;
  material_id: string;
  content_hash: string;
  parser_kind: string;
  parser_version: string;
  imported_at: string;
  size_bytes: number;
  parse_status: string;
  parse_error: string | null;
  text_units: number;
  canonical_text: string;
  block_map_json: string;
}

interface MaterialBranchOriginRow {
  branch_id: string;
  tree_id: string;
  material_id: string;
  version_id: string;
  block_id: string;
  start: number;
  end: number;
  excerpt: string;
  source_hash: string;
  created_at: string;
}

interface ReadingPositionRow {
  tree_id: string;
  material_id: string;
  version_id: string;
  block_id: string | null;
  focus_start: number | null;
  updated_at: string;
}

interface FirstQuestionRow {
  intent_key: string;
  tree_id: string;
  branch_id: string;
  created_at: string;
}

const MATERIAL_COLUMNS = "material_id, title, created_at";
const MATERIAL_VERSION_COLUMNS =
  "version_id, material_id, content_hash, parser_kind, parser_version, imported_at, " +
  "size_bytes, parse_status, parse_error, text_units, canonical_text, block_map_json";

/** 断言行内 parse_status 合法（schema CHECK 之外的双保险）。 */
function assertParseStatus(status: string, context: string): MaterialParseStatus {
  if (!isParseStatus(status)) {
    throw new DatabaseCorruptError(`invalid parse status '${status}' in database (${context})`);
  }
  return status;
}

/** 断言行内 parser_kind 合法。 */
function assertParserKind(kind: string, context: string): MaterialParserKind {
  if (!isParserKind(kind)) {
    throw new DatabaseCorruptError(`invalid parser kind '${kind}' in database (${context})`);
  }
  return kind;
}

function rowToMaterial(row: MaterialRow): Material {
  return { id: row.material_id as MaterialId, title: row.title, createdAt: row.created_at as IsoTimestamp };
}

/** canonicalText 与 block map 不进 MaterialVersion（按块分页读取归 D4-2 API）。 */
function rowToMaterialVersion(row: MaterialVersionRow): MaterialVersion {
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

function rowToMaterialBranchOrigin(row: MaterialBranchOriginRow): MaterialBranchOrigin {
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

function rowToReadingPosition(row: ReadingPositionRow): MaterialReadingPosition {
  return {
    treeId: row.tree_id as TreeId,
    materialId: row.material_id as MaterialId,
    versionId: row.version_id as MaterialVersionId,
    blockId: row.block_id ?? null,
    focusStart: row.focus_start === null ? null : Number(row.focus_start),
    updatedAt: row.updated_at as IsoTimestamp,
  };
}

function rowToFirstQuestion(row: FirstQuestionRow): MaterialFirstQuestion {
  return {
    treeId: row.tree_id as TreeId,
    intentKey: row.intent_key,
    branchId: row.branch_id as BranchId,
    createdAt: row.created_at as IsoTimestamp,
  };
}

/** 反序列化版本 block map（损坏 JSON/形状按库损坏处理）。 */
function decodeBlockMap(versionId: string, json: string): MaterialBlock[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new DatabaseCorruptError(`stored block_map_json is not valid JSON (material version ${versionId})`, {
      cause: error,
    });
  }
  if (!Array.isArray(parsed)) {
    throw new DatabaseCorruptError(`stored block_map_json is not an array (material version ${versionId})`);
  }
  for (const block of parsed) {
    const candidate = block as Partial<MaterialBlock>;
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      typeof candidate.blockId !== "string" ||
      (candidate.kind !== "markdown-block" && candidate.kind !== "pdf-page") ||
      !Number.isInteger(candidate.start) ||
      !Number.isInteger(candidate.end)
    ) {
      throw new DatabaseCorruptError(
        `stored block_map_json entry lacks the MaterialBlock shape (material version ${versionId})`,
      );
    }
  }
  return parsed as MaterialBlock[];
}

/**
 * 校验块覆盖（B1 真值规则的存储侧防御）：blocks 对 canonicalText 有序
 * 连续覆盖——首块 start=0、blocks[i].end === blocks[i+1].start、末块
 * end=textLength；块 kind 与 parserKind 一致；空 canonicalText 时块为空。
 */
function assertValidBlockCoverage(
  blocks: readonly MaterialBlock[],
  textLength: number,
  parserKind: MaterialParserKind,
): void {
  const expectedKind = parserKind === "markdown" ? "markdown-block" : "pdf-page";
  if (blocks.length === 0) {
    if (textLength !== 0) {
      throw new InvalidArgumentError(
        `blocks must continuously cover canonicalText (got 0 blocks for ${textLength} units)`,
      );
    }
    return;
  }
  let cursor = 0;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    assertNonEmptyString(block.blockId, `blocks[${i}].blockId`);
    if (block.kind !== expectedKind) {
      throw new InvalidArgumentError(
        `blocks[${i}].kind must be '${expectedKind}' for parser kind '${parserKind}' (got '${String(block.kind)}')`,
      );
    }
    if (!Number.isInteger(block.start) || !Number.isInteger(block.end) || block.end <= block.start) {
      throw new InvalidArgumentError(
        `blocks[${i}] must have integer offsets with end > start ` +
          `(got start=${String(block.start)}, end=${String(block.end)})`,
      );
    }
    if (block.start !== cursor) {
      throw new InvalidArgumentError(
        `blocks must continuously cover canonicalText: blocks[${i}] starts at ${String(block.start)}, ` +
          `expected ${cursor} (previous block ends at ${cursor})`,
      );
    }
    cursor = block.end;
  }
  if (cursor !== textLength) {
    throw new InvalidArgumentError(
      `blocks must continuously cover canonicalText: last block ends at ${cursor}, expected ${textLength}`,
    );
  }
}

/** 校验材料选区形状（字段类型/区间整数序）。 */
function assertValidSelectionShape(selection: MaterialSelection): void {
  assertNonEmptyString(selection.materialId, "selection.materialId");
  assertNonEmptyString(selection.versionId, "selection.versionId");
  assertNonEmptyString(selection.blockId, "selection.blockId");
  assertNonEmptyString(selection.sourceHash, "selection.sourceHash");
  if (typeof selection.excerpt !== "string") {
    throw new InvalidArgumentError("selection.excerpt must be a string");
  }
  if (
    !Number.isInteger(selection.start) ||
    !Number.isInteger(selection.end)
  ) {
    throw new InvalidArgumentError("selection.start/end must be integers");
  }
}

/* ------------------------------------------------------------------ */
/* MaterialRepository                                                   */
/* ------------------------------------------------------------------ */

export class MaterialRepository {
  readonly path: string;
  readonly now: () => IsoTimestamp;
  readonly #generateId: () => string;
  #db: DatabaseSync | null;
  #txDepth: number;

  private constructor(options: MaterialRepositoryOptions, db: DatabaseSync) {
    this.path = options.path;
    this.now = options.now ?? (() => new Date().toISOString());
    this.#generateId = options.generateId ?? (() => randomUUID());
    this.#db = db;
    this.#txDepth = 0;
  }

  /**
   * 打开（必要时迁移）数据库并返回仓储实例。
   * 失败语义见 `openDatabase`（损坏/外来库/版本过新/migration 失败均明确抛错）。
   */
  static open(options: MaterialRepositoryOptions): MaterialRepository {
    const opened = openDatabase({
      path: options.path,
      busyTimeoutMs: options.busyTimeoutMs,
    });
    return new MaterialRepository(options, opened.db);
  }

  /** 当前 schema 版本（user_version）。 */
  get schemaVersion(): number {
    this.#assertOpen();
    const row = this.#db!.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
    return Number(row?.user_version ?? 0);
  }

  isClosed(): boolean {
    return this.#db === null;
  }

  close(): void {
    const db = this.#db;
    if (db === null) return;
    this.#db = null;
    this.#txDepth = 0;
    db.close();
  }

  #assertOpen(): void {
    if (this.#db === null) throw new RepositoryClosedError();
  }

  #newId(prefix: string): string {
    return `${prefix}_${this.#generateId()}`;
  }

  /* ------------------------------ 事务 ------------------------------ */

  /**
   * 在事务中执行 `fn`。
   * - 顶层：`BEGIN IMMEDIATE` … `COMMIT`；`fn` 抛错则 `ROLLBACK` 并原样重抛；
   * - 嵌套：`SAVEPOINT`，内层失败只回滚内层（调用方捕获后外层可继续）。
   */
  transaction<T>(fn: () => T): T {
    this.#assertOpen();
    const db = this.#db!;
    if (this.#txDepth === 0) {
      db.exec("BEGIN IMMEDIATE");
      this.#txDepth = 1;
      try {
        const result = fn();
        db.exec("COMMIT");
        this.#txDepth = 0;
        return result;
      } catch (error) {
        this.#txDepth = 0;
        try {
          db.exec("ROLLBACK");
        } catch {
          // 事务已不存在（驱动已自动回滚）——保留原始错误。
        }
        throw error;
      }
    }
    const depth = this.#txDepth;
    const sp = `mat_sp_${depth}`;
    db.exec(`SAVEPOINT ${sp}`);
    this.#txDepth = depth + 1;
    try {
      const result = fn();
      db.exec(`RELEASE ${sp}`);
      this.#txDepth = depth;
      return result;
    } catch (error) {
      this.#txDepth = depth;
      try {
        db.exec(`ROLLBACK TO ${sp}`);
        db.exec(`RELEASE ${sp}`);
      } catch {
        // savepoint 已不存在——保留原始错误。
      }
      throw error;
    }
  }

  /* ------------------------------ 材料 ------------------------------ */

  createMaterial(input: CreateMaterialInput): Material {
    this.#assertOpen();
    assertNonEmptyString(input.title, "material title");
    const id = input.id ?? (this.#newId("material") as MaterialId);
    assertNonEmptyString(id, "material id");
    const createdAt = this.now();
    try {
      this.#db!
        .prepare("INSERT INTO materials (material_id, title, created_at) VALUES (?, ?, ?)")
        .run(id, input.title, createdAt);
    } catch (error) {
      throw mapSqliteError(error, "creating material");
    }
    return { id, title: input.title, createdAt };
  }

  /** 全部材料（追加序 created_at, rowid）。 */
  listMaterials(): Material[] {
    this.#assertOpen();
    const rows = this.#db!
      .prepare(`SELECT ${MATERIAL_COLUMNS} FROM materials ORDER BY created_at, rowid`)
      .all() as unknown as MaterialRow[];
    return rows.map(rowToMaterial);
  }

  /** 树内已链接材料（链接序 linked_at, rowid）。 */
  listTreeMaterials(treeId: TreeId): Material[] {
    this.#assertOpen();
    assertNonEmptyString(treeId, "tree id");
    const rows = this.#db!
      .prepare(
        `SELECT m.material_id, m.title, m.created_at
         FROM materials m
         JOIN tree_material_links l ON l.material_id = m.material_id
         WHERE l.tree_id = ?
         ORDER BY l.linked_at, l.rowid`,
      )
      .all(treeId) as unknown as MaterialRow[];
    return rows.map(rowToMaterial);
  }

  /* ------------------------------ 原件（内容寻址） ------------------------------ */

  /**
   * 内容寻址入库：content_hash = 原件字节 SHA-256；同字节全局一份
   * （冲突即已存在，原样保留——不重写、不报错）。返回 content_hash。
   */
  storeBlob(bytes: Uint8Array): string {
    this.#assertOpen();
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
      throw new InvalidArgumentError("material bytes must be a non-empty Uint8Array");
    }
    const contentHash = sha256Hex(bytes);
    try {
      this.#db!
        .prepare("INSERT INTO material_blobs (content_hash, bytes) VALUES (?, ?) ON CONFLICT(content_hash) DO NOTHING")
        .run(contentHash, bytes);
    } catch (error) {
      throw mapSqliteError(error, "storing material blob");
    }
    return contentHash;
  }

  /* ------------------------------ 版本（不可变链） ------------------------------ */

  /**
   * 导入一个材料版本。
   *
   * - 原件字节先经内容寻址入库（`storeBlob` 语义）；
   * - UNIQUE(material_id, content_hash)：同材料重复导入相同字节**返回既有
   *   版本**（复用，不重复、不改写 importedAt/canonicalText）；
   * - 内容变化（不同字节）产生新版本，追加到版本链；
   * - textUnits/sizeBytes 由仓储计算（canonicalText UTF-16 长度 / 字节数），
   *   块覆盖按 B1 真值规则校验（有序连续覆盖）；
   * - parseError 当且仅当 parseStatus ∈ {failed, unsupported, rejected}
   *   （与 run-state「failure iff failed」同一纪律）。
   */
  insertVersion(input: InsertMaterialVersionInput): MaterialVersion {
    this.#assertOpen();
    assertNonEmptyString(input.materialId, "material id");
    if (!isParserKind(input.parserKind)) {
      throw new InvalidArgumentError(`parser kind must be 'markdown' | 'pdf' (got '${String(input.parserKind)}')`);
    }
    assertNonEmptyString(input.parserVersion, "parser version");
    if (!isParseStatus(input.parseStatus)) {
      throw new InvalidArgumentError(
        `parse status must be one of {${PARSE_STATUSES.join(", ")}} (got '${String(input.parseStatus)}')`,
      );
    }
    const isFailure = FAILURE_STATUSES.includes(input.parseStatus);
    const parseError = input.parseError ?? null;
    if (isFailure && (typeof parseError !== "string" || parseError.trim().length === 0)) {
      throw new InvalidArgumentError(`parse status '${input.parseStatus}' requires a parseError (reason code + note)`);
    }
    if (!isFailure && parseError !== null) {
      throw new InvalidArgumentError(`parseError must not be provided for parse status '${input.parseStatus}'`);
    }
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) {
      throw new InvalidArgumentError("material bytes must be a non-empty Uint8Array");
    }
    if (typeof input.canonicalText !== "string") {
      throw new InvalidArgumentError("canonicalText must be a string");
    }
    if (!Array.isArray(input.blocks)) {
      throw new InvalidArgumentError("blocks must be an array of MaterialBlock");
    }
    assertValidBlockCoverage(input.blocks, input.canonicalText.length, input.parserKind);

    return this.transaction((): MaterialVersion => {
      const db = this.#db!;
      const material = db
        .prepare(`SELECT ${MATERIAL_COLUMNS} FROM materials WHERE material_id = ?`)
        .get(input.materialId) as MaterialRow | undefined;
      if (material === undefined) throw new EntityNotFoundError("material", input.materialId);

      const contentHash = sha256Hex(input.bytes);
      // 同材料同字节：复用既有版本（不重复导入）。
      const existing = db
        .prepare(`SELECT ${MATERIAL_VERSION_COLUMNS} FROM material_versions WHERE material_id = ? AND content_hash = ?`)
        .get(input.materialId, contentHash) as MaterialVersionRow | undefined;
      if (existing !== undefined) return rowToMaterialVersion(existing);

      const id = input.id ?? (this.#newId("matver") as MaterialVersionId);
      assertNonEmptyString(id, "material version id");
      const importedAt = this.now();
      try {
        db.prepare("INSERT INTO material_blobs (content_hash, bytes) VALUES (?, ?) ON CONFLICT(content_hash) DO NOTHING")
          .run(contentHash, input.bytes);
        db.prepare(
          `INSERT INTO material_versions
             (version_id, material_id, content_hash, parser_kind, parser_version, imported_at,
              size_bytes, parse_status, parse_error, text_units, canonical_text, block_map_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          input.materialId,
          contentHash,
          input.parserKind,
          input.parserVersion,
          importedAt,
          input.bytes.byteLength,
          input.parseStatus,
          parseError,
          input.canonicalText.length,
          input.canonicalText,
          JSON.stringify(input.blocks),
        );
      } catch (error) {
        throw mapSqliteError(error, "inserting material version");
      }
      const inserted = db
        .prepare(`SELECT ${MATERIAL_VERSION_COLUMNS} FROM material_versions WHERE version_id = ?`)
        .get(id) as MaterialVersionRow | undefined;
      if (inserted === undefined) {
        throw new DatabaseCorruptError(`material version ${id} not readable after insert (schema integrity violation)`);
      }
      return rowToMaterialVersion(inserted);
    });
  }

  /** 材料的版本链（导入序 imported_at, rowid）。 */
  listVersions(materialId: MaterialId): MaterialVersion[] {
    this.#assertOpen();
    assertNonEmptyString(materialId, "material id");
    const rows = this.#db!
      .prepare(
        `SELECT ${MATERIAL_VERSION_COLUMNS} FROM material_versions WHERE material_id = ? ORDER BY imported_at, rowid`,
      )
      .all(materialId) as unknown as MaterialVersionRow[];
    return rows.map(rowToMaterialVersion);
  }

  /* ------------------------------ 树链接 ------------------------------ */

  /**
   * 链接材料到树（一树多材料、一材料多树）。幂等：已链接时返回既有
   * 链接（linked_at 保留首次链接时刻，不重写）。
   */
  linkTreeMaterial(treeId: TreeId, materialId: MaterialId): TreeMaterialLink {
    this.#assertOpen();
    assertNonEmptyString(treeId, "tree id");
    assertNonEmptyString(materialId, "material id");
    if (this.#findTreeRow(treeId) === undefined) throw new EntityNotFoundError("tree", treeId);
    if (this.#findMaterialRow(materialId) === undefined) throw new EntityNotFoundError("material", materialId);
    const linkedAt = this.now();
    return this.transaction((): TreeMaterialLink => {
      const db = this.#db!;
      try {
        db.prepare(
          "INSERT INTO tree_material_links (tree_id, material_id, linked_at) VALUES (?, ?, ?) " +
            "ON CONFLICT(tree_id, material_id) DO NOTHING",
        ).run(treeId, materialId, linkedAt);
      } catch (error) {
        throw mapSqliteError(error, "linking material to tree");
      }
      const row = db
        .prepare("SELECT tree_id, material_id, linked_at FROM tree_material_links WHERE tree_id = ? AND material_id = ?")
        .get(treeId, materialId) as { tree_id: string; material_id: string; linked_at: string } | undefined;
      if (row === undefined) {
        throw new DatabaseCorruptError(
          `tree material link (${treeId}, ${materialId}) not readable after upsert (schema integrity violation)`,
        );
      }
      return {
        treeId: row.tree_id as TreeId,
        materialId: row.material_id as MaterialId,
        linkedAt: row.linked_at as IsoTimestamp,
      };
    });
  }

  /**
   * 解除树与材料的链接。返回是否确实删除了链接行（false = 本未链接）。
   * 只删链接行：材料、版本、来源锚点与阅读状态均为产品事实，不受影响。
   */
  unlinkTreeMaterial(treeId: TreeId, materialId: MaterialId): boolean {
    this.#assertOpen();
    assertNonEmptyString(treeId, "tree id");
    assertNonEmptyString(materialId, "material id");
    try {
      const result = this.#db!
        .prepare("DELETE FROM tree_material_links WHERE tree_id = ? AND material_id = ?")
        .run(treeId, materialId);
      return Number(result.changes) > 0;
    } catch (error) {
      throw mapSqliteError(error, "unlinking material from tree");
    }
  }

  /* ------------------------------ 选区校验 ------------------------------ */

  /**
   * 校验材料选区（切片 vs 摘录 vs sourceHash 纪律，与 branch_origins 的
   * Turn 来源锚点同一纪律）并返回锚定上下文：
   * - excerpt === 版本 canonicalText.slice(start, end)；区间在边界内；
   * - blockId 存在于版本 block map 且区间含于该块；
   * - sourceHash === 版本 canonicalText 的 SHA-256（锚点身份）。
   * 校验失败抛 `InvalidArgumentError`（含可定位原因）；材料/版本缺失抛
   * `EntityNotFoundError`。**不**判定 parse_status（ready 门槛归建枝路径）。
   */
  getMaterialSelection(selection: MaterialSelection): MaterialSelectionContext {
    this.#assertOpen();
    assertValidSelectionShape(selection);
    const { material, version } = this.#loadSelectionContext(selection);
    this.#validateSelectionDiscipline(selection, version);
    return { selection, material: rowToMaterial(material), version: rowToMaterialVersion(version) };
  }

  /* ------------------------------ 材料来源 ------------------------------ */

  /**
   * 记录材料来源（材料建枝的出处锚点）。每分支至多一条来源：写入前
   * 显式查 branch_origins（Turn 来源）与 material_branch_origins。
   *
   * 校验（事务内）：
   * - branch 存在且属于 treeId；
   * - 版本存在、属于 selection.materialId，且 parse_status = 'ready'
   *   （非 ready 拒绝建枝并说明原因——charter §3.2）；
   * - 选区纪律（见 getMaterialSelection）；
   * - 同事务把 branches.origin_kind 置 'material'（条件 UPDATE，
   *   非 'none' 即库不一致，按损坏处理）。
   */
  insertMaterialBranchOrigin(input: InsertMaterialBranchOriginInput): MaterialBranchOrigin {
    this.#assertOpen();
    assertNonEmptyString(input.branchId, "branch id");
    assertNonEmptyString(input.treeId, "tree id");
    assertValidSelectionShape(input.selection);
    return this.transaction((): MaterialBranchOrigin => {
      const db = this.#db!;
      const branch = db
        .prepare("SELECT id, tree_id, parent_branch_id, created_at FROM branches WHERE id = ?")
        .get(input.branchId) as { id: string; tree_id: string } | undefined;
      if (branch === undefined) throw new EntityNotFoundError("branch", input.branchId);
      if (branch.tree_id !== input.treeId) {
        throw new InvalidArgumentError(
          `branch ${input.branchId} belongs to tree ${branch.tree_id}, not ${input.treeId}`,
        );
      }
      const { version } = this.#loadSelectionContext(input.selection);
      if (version.parse_status !== "ready") {
        throw new InvalidArgumentError(
          `material version ${input.selection.versionId} is not ready for precise branching ` +
            `(parse status '${version.parse_status}'${version.parse_error === null ? "" : `: ${version.parse_error}`})`,
        );
      }
      this.#validateSelectionDiscipline(input.selection, version);

      const turnOrigin = db
        .prepare("SELECT branch_id FROM branch_origins WHERE branch_id = ?")
        .get(input.branchId) as { branch_id: string } | undefined;
      if (turnOrigin !== undefined) {
        throw new InvalidArgumentError(`branch ${input.branchId} already has a turn origin`);
      }
      const materialOrigin = db
        .prepare("SELECT branch_id FROM material_branch_origins WHERE branch_id = ?")
        .get(input.branchId) as { branch_id: string } | undefined;
      if (materialOrigin !== undefined) {
        throw new InvalidArgumentError(`branch ${input.branchId} already has a material origin`);
      }

      const createdAt = this.now();
      try {
        db.prepare(
          `INSERT INTO material_branch_origins
             (branch_id, tree_id, material_id, version_id, block_id, start, end, excerpt, source_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          input.branchId,
          input.treeId,
          input.selection.materialId,
          input.selection.versionId,
          input.selection.blockId,
          input.selection.start,
          input.selection.end,
          input.selection.excerpt,
          input.selection.sourceHash,
          createdAt,
        );
      } catch (error) {
        throw mapSqliteError(error, "inserting material branch origin");
      }
      const kindUpdate = db
        .prepare("UPDATE branches SET origin_kind = 'material' WHERE id = ? AND origin_kind = 'none'")
        .run(input.branchId);
      if (Number(kindUpdate.changes) === 0) {
        throw new DatabaseCorruptError(
          `branch ${input.branchId} origin_kind is not 'none' while having no origin row ` +
            `(schema integrity violation)`,
        );
      }
      return rowToMaterialBranchOrigin({
        branch_id: input.branchId,
        tree_id: input.treeId,
        material_id: input.selection.materialId,
        version_id: input.selection.versionId,
        block_id: input.selection.blockId,
        start: input.selection.start,
        end: input.selection.end,
        excerpt: input.selection.excerpt,
        source_hash: input.selection.sourceHash,
        created_at: createdAt,
      });
    });
  }

  /**
   * 统一来源读取（ADR-003 §2）：Turn 来源或 Material 来源或 null。
   * 以两张来源表的实际行为准（各以 branch_id 为主键）；两表同时有行
   * 属于库不一致，按 `DatabaseCorruptError` 处理（不静默择一）。
   */
  getBranchOrigin(branchId: BranchId): BranchOriginRef | null {
    this.#assertOpen();
    assertNonEmptyString(branchId, "branch id");
    const db = this.#db!;
    const materialRow = db
      .prepare(
        `SELECT branch_id, tree_id, material_id, version_id, block_id, start, end, excerpt, source_hash, created_at
         FROM material_branch_origins WHERE branch_id = ?`,
      )
      .get(branchId) as MaterialBranchOriginRow | undefined;
    const turnRow = db
      .prepare(
        `SELECT branch_id, source_branch_id, anchor_turn_id, anchor_entry_id, sel_start, sel_end, sel_text, created_at
         FROM branch_origins WHERE branch_id = ?`,
      )
      .get(branchId) as BranchOriginRow | undefined;
    if (materialRow !== undefined && turnRow !== undefined) {
      throw new DatabaseCorruptError(
        `branch ${branchId} has both a turn origin and a material origin (schema integrity violation)`,
      );
    }
    if (materialRow !== undefined) {
      return { kind: "material", origin: rowToMaterialBranchOrigin(materialRow) };
    }
    if (turnRow !== undefined) {
      return { kind: "turn", origin: rowToBranchOrigin(turnRow) };
    }
    return null;
  }

  /* ------------------------------ origin_kind ------------------------------ */

  /** 读取 branches.origin_kind（'none' | 'turn' | 'material'）。 */
  getBranchOriginKind(branchId: BranchId): BranchOriginKind {
    this.#assertOpen();
    assertNonEmptyString(branchId, "branch id");
    const row = this.#db!.prepare("SELECT origin_kind FROM branches WHERE id = ?").get(branchId) as
      | { origin_kind?: string }
      | undefined;
    if (row === undefined) throw new EntityNotFoundError("branch", branchId);
    const kind = row.origin_kind ?? "";
    if (!isOriginKind(kind)) {
      throw new DatabaseCorruptError(`invalid origin_kind '${kind}' for branch ${branchId}`);
    }
    return kind;
  }

  /**
   * 设置 branches.origin_kind。与来源表的一致性（ADR-003 §2「类型与
   * origin_kind 一致」）在此校验：'turn' 要求 branch_origins 行且无材料
   * 来源；'material' 要求 material_branch_origins 行且无 Turn 来源；
   * 'none' 要求两表皆无。不一致以 `InvalidArgumentError` 拒绝（不静默
   * 改写）。
   */
  setBranchOriginKind(branchId: BranchId, kind: BranchOriginKind): void {
    this.#assertOpen();
    assertNonEmptyString(branchId, "branch id");
    if (!isOriginKind(kind)) {
      throw new InvalidArgumentError(`origin kind must be one of {${ORIGIN_KINDS.join(", ")}} (got '${String(kind)}')`);
    }
    this.transaction((): void => {
      const db = this.#db!;
      const branch = db.prepare("SELECT id FROM branches WHERE id = ?").get(branchId);
      if (branch === undefined) throw new EntityNotFoundError("branch", branchId);
      const hasTurn =
        db.prepare("SELECT 1 AS hit FROM branch_origins WHERE branch_id = ?").get(branchId) !== undefined;
      const hasMaterial =
        db.prepare("SELECT 1 AS hit FROM material_branch_origins WHERE branch_id = ?").get(branchId) !== undefined;
      if (kind === "turn" && (!hasTurn || hasMaterial)) {
        throw new InvalidArgumentError(
          `origin kind 'turn' requires a branch_origins row and no material origin for branch ${branchId} ` +
            `(turn=${hasTurn}, material=${hasMaterial})`,
        );
      }
      if (kind === "material" && (!hasMaterial || hasTurn)) {
        throw new InvalidArgumentError(
          `origin kind 'material' requires a material_branch_origins row and no turn origin for branch ${branchId} ` +
            `(turn=${hasTurn}, material=${hasMaterial})`,
        );
      }
      if (kind === "none" && (hasTurn || hasMaterial)) {
        throw new InvalidArgumentError(
          `origin kind 'none' requires no origin rows for branch ${branchId} (turn=${hasTurn}, material=${hasMaterial})`,
        );
      }
      try {
        const result = db.prepare("UPDATE branches SET origin_kind = ? WHERE id = ?").run(kind, branchId);
        if (Number(result.changes) === 0) {
          throw new DatabaseCorruptError(`branch ${branchId} not updatable (schema integrity violation)`);
        }
      } catch (error) {
        if (error instanceof DatabaseCorruptError) throw error;
        throw mapSqliteError(error, "setting branch origin kind");
      }
    });
  }

  /* ------------------------------ 阅读位置 ------------------------------ */

  /**
   * 持久化阅读位置（PK tree_id+material_id，UPSERT 整体替换；阅读与探索
   * 各自保留位置——charter §3.2）。blockId 给出时必须存在于版本 block
   * map；focusStart 给出时要求 blockId 且落在该块区间内。
   */
  upsertReadingPosition(input: UpsertReadingPositionInput): MaterialReadingPosition {
    this.#assertOpen();
    assertNonEmptyString(input.treeId, "tree id");
    assertNonEmptyString(input.materialId, "material id");
    assertNonEmptyString(input.versionId, "material version id");
    const blockId = input.blockId ?? null;
    const focusStart = input.focusStart ?? null;
    if (blockId !== null) assertNonEmptyString(blockId, "blockId");
    if (focusStart !== null && !Number.isInteger(focusStart)) {
      throw new InvalidArgumentError("focusStart must be an integer");
    }
    if (focusStart !== null && blockId === null) {
      throw new InvalidArgumentError("focusStart requires blockId (a focus inside the last-read block)");
    }
    if (this.#findTreeRow(input.treeId) === undefined) throw new EntityNotFoundError("tree", input.treeId);
    if (this.#findMaterialRow(input.materialId) === undefined) {
      throw new EntityNotFoundError("material", input.materialId);
    }
    const version = this.#findVersionRow(input.versionId);
    if (version === undefined) throw new EntityNotFoundError("material version", input.versionId);
    if (version.material_id !== input.materialId) {
      throw new InvalidArgumentError(
        `material version ${input.versionId} belongs to material ${version.material_id}, not ${input.materialId}`,
      );
    }
    if (blockId !== null) {
      const block = decodeBlockMap(version.version_id, version.block_map_json).find(
        (b) => b.blockId === blockId,
      );
      if (block === undefined) {
        throw new InvalidArgumentError(`blockId '${blockId}' does not exist in material version ${input.versionId}`);
      }
      if (focusStart !== null && (focusStart < block.start || focusStart > block.end)) {
        throw new InvalidArgumentError(
          `focusStart ${focusStart} is outside block '${blockId}' [${block.start}, ${block.end}]`,
        );
      }
    }
    const updatedAt = this.now();
    try {
      this.#db!
        .prepare(
          `INSERT INTO tree_material_reading_state
             (tree_id, material_id, version_id, block_id, focus_start, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(tree_id, material_id) DO UPDATE SET
             version_id = excluded.version_id,
             block_id = excluded.block_id,
             focus_start = excluded.focus_start,
             updated_at = excluded.updated_at`,
        )
        .run(input.treeId, input.materialId, input.versionId, blockId, focusStart, updatedAt);
    } catch (error) {
      throw mapSqliteError(error, "upserting reading position");
    }
    return {
      treeId: input.treeId,
      materialId: input.materialId,
      versionId: input.versionId,
      blockId,
      focusStart,
      updatedAt,
    };
  }

  /** 读取阅读位置（PK tree_id+material_id；无则 null）。 */
  findReadingPosition(treeId: TreeId, materialId: MaterialId): MaterialReadingPosition | null {
    this.#assertOpen();
    assertNonEmptyString(treeId, "tree id");
    assertNonEmptyString(materialId, "material id");
    const row = this.#db!
      .prepare(
        `SELECT tree_id, material_id, version_id, block_id, focus_start, updated_at
         FROM tree_material_reading_state WHERE tree_id = ? AND material_id = ?`,
      )
      .get(treeId, materialId) as ReadingPositionRow | undefined;
    return row ? rowToReadingPosition(row) : null;
  }

  /* ------------------------------ 首问幂等 ------------------------------ */

  /**
   * 记录材料首问的提交意图（ADR-003 §4：树内幂等键）。
   * PRIMARY KEY(tree_id, intent_key)：双击、响应丢失重试、进程重启重放
   * 同一键 → 返回既有行（replayed=true，同一 Branch，至多派发一次首问）。
   */
  insertFirstQuestion(input: InsertFirstQuestionInput): InsertFirstQuestionResult {
    this.#assertOpen();
    assertNonEmptyString(input.treeId, "tree id");
    assertNonEmptyString(input.branchId, "branch id");
    assertNonEmptyString(input.intentKey, "intent key");
    return this.transaction((): InsertFirstQuestionResult => {
      const db = this.#db!;
      const tree = db.prepare("SELECT id FROM trees WHERE id = ?").get(input.treeId);
      if (tree === undefined) throw new EntityNotFoundError("tree", input.treeId);
      const branch = db
        .prepare("SELECT id, tree_id, parent_branch_id, created_at FROM branches WHERE id = ?")
        .get(input.branchId) as { id: string; tree_id: string } | undefined;
      if (branch === undefined) throw new EntityNotFoundError("branch", input.branchId);
      if (branch.tree_id !== input.treeId) {
        throw new InvalidArgumentError(
          `branch ${input.branchId} belongs to tree ${branch.tree_id}, not ${input.treeId}`,
        );
      }
      const existing = db
        .prepare("SELECT intent_key, tree_id, branch_id, created_at FROM material_first_questions WHERE tree_id = ? AND intent_key = ?")
        .get(input.treeId, input.intentKey) as FirstQuestionRow | undefined;
      if (existing !== undefined) {
        return { question: rowToFirstQuestion(existing), replayed: true };
      }
      const createdAt = this.now();
      try {
        db.prepare(
          "INSERT INTO material_first_questions (intent_key, tree_id, branch_id, created_at) VALUES (?, ?, ?, ?)",
        ).run(input.intentKey, input.treeId, input.branchId, createdAt);
      } catch (error) {
        throw mapSqliteError(error, "inserting material first question");
      }
      return {
        question: {
          treeId: input.treeId,
          intentKey: input.intentKey,
          branchId: input.branchId,
          createdAt,
        },
        replayed: false,
      };
    });
  }

  /** 按幂等键查找首问记录（重放对齐路径；无则 null）。 */
  findFirstQuestion(treeId: TreeId, intentKey: string): MaterialFirstQuestion | null {
    this.#assertOpen();
    assertNonEmptyString(treeId, "tree id");
    assertNonEmptyString(intentKey, "intent key");
    const row = this.#db!
      .prepare(
        "SELECT intent_key, tree_id, branch_id, created_at FROM material_first_questions WHERE tree_id = ? AND intent_key = ?",
      )
      .get(treeId, intentKey) as FirstQuestionRow | undefined;
    return row ? rowToFirstQuestion(row) : null;
  }

  /* ------------------------------ 内部读取辅助 ------------------------------ */

  #findTreeRow(treeId: string): { id: string } | undefined {
    return this.#db!.prepare("SELECT id FROM trees WHERE id = ?").get(treeId) as
      | { id: string }
      | undefined;
  }

  #findMaterialRow(materialId: string): MaterialRow | undefined {
    return this.#db!
      .prepare(`SELECT ${MATERIAL_COLUMNS} FROM materials WHERE material_id = ?`)
      .get(materialId) as MaterialRow | undefined;
  }

  #findVersionRow(versionId: string): MaterialVersionRow | undefined {
    return this.#db!
      .prepare(`SELECT ${MATERIAL_VERSION_COLUMNS} FROM material_versions WHERE version_id = ?`)
      .get(versionId) as MaterialVersionRow | undefined;
  }

  /** 加载选区锚定的材料与版本（含 canonicalText/block map），并交叉校验归属。 */
  #loadSelectionContext(selection: MaterialSelection): {
    material: MaterialRow;
    version: MaterialVersionRow;
  } {
    const material = this.#findMaterialRow(selection.materialId);
    if (material === undefined) throw new EntityNotFoundError("material", selection.materialId);
    const version = this.#findVersionRow(selection.versionId);
    if (version === undefined) throw new EntityNotFoundError("material version", selection.versionId);
    if (version.material_id !== selection.materialId) {
      throw new InvalidArgumentError(
        `material version ${selection.versionId} belongs to material ${version.material_id}, not ${selection.materialId}`,
      );
    }
    return { material, version };
  }

  /** 选区纪律：区间边界 + 切片一致 + 块存在且含区间 + sourceHash 一致。 */
  #validateSelectionDiscipline(selection: MaterialSelection, version: MaterialVersionRow): void {
    const text = version.canonical_text;
    if (selection.start < 0 || selection.end <= selection.start || selection.end > text.length) {
      throw new InvalidArgumentError(
        `selection [${selection.start}, ${selection.end}) is out of bounds for the version canonicalText ` +
          `(${text.length} units)`,
      );
    }
    if (text.slice(selection.start, selection.end) !== selection.excerpt) {
      throw new InvalidArgumentError(
        "selection excerpt does not match the version canonicalText at the given offsets " +
          "(anchor integrity violation)",
      );
    }
    const blocks = decodeBlockMap(version.version_id, version.block_map_json);
    const block = blocks.find((b) => b.blockId === selection.blockId);
    if (block === undefined) {
      throw new InvalidArgumentError(
        `blockId '${selection.blockId}' does not exist in material version ${version.version_id}`,
      );
    }
    if (block.start > selection.start || selection.end > block.end) {
      throw new InvalidArgumentError(
        `selection [${selection.start}, ${selection.end}) is not contained in block '${selection.blockId}' ` +
          `[${block.start}, ${block.end})`,
      );
    }
    if (hashCanonicalText(text) !== selection.sourceHash) {
      throw new InvalidArgumentError(
        "selection sourceHash does not match the version canonicalText hash " +
          "(stale or unknown anchor identity)",
      );
    }
  }
}
