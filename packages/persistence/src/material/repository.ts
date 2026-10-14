import type {
  MaterialDomainContext,
} from "./context.ts";
import {
  MaterialCatalogRepository,
} from "./catalog.ts";
import {
  MaterialVersionsRepository,
} from "./versions.ts";
import {
  MaterialSourcesRepository,
} from "./sources.ts";
import {
  MaterialIntentsRepository,
} from "./intents.ts";
/** repository ownership for material-repository.ts; compatibility entrypoint remains one level above. */
import {
  openDatabase,
} from "../database.ts";
import {
  EntityNotFoundError,
  InvalidArgumentError,
  RepositoryClosedError,
} from "../errors.ts";

import type {
  BranchOriginKind,
  BranchOriginRef,
  CreateMaterialBranchInput,
  CreateMaterialBranchResult,
  CreateMaterialInput,
  InsertFirstQuestionInput,
  InsertFirstQuestionResult,
  InsertMaterialBranchOriginInput,
  InsertMaterialVersionInput,
  MaterialFirstQuestion,
  MaterialRepositoryOptions,
  MaterialRow,
  MaterialSelectionContext,
  MaterialVersionBlob,
  MaterialVersionContent,
  MaterialVersionRow,
  TreeMaterialLink,
  UpdateVersionParseResultInput,
  UpsertReadingPositionInput,
} from "./model.ts";
import {
  MATERIAL_COLUMNS,
  MATERIAL_VERSION_COLUMNS,
} from "./policy.ts";

import {
  decodeBlockMap,
  hashCanonicalText,
} from "./validation.ts";
import type {
  BranchId,
  IsoTimestamp,
  Material,
  MaterialBranchOrigin,
  MaterialId,
  MaterialReadingPosition,
  MaterialSelection,
  MaterialVersion,
  MaterialVersionId,
  TreeId,
} from "@treeai/contracts";
import {
  randomUUID,
} from "node:crypto";
import type {
  DatabaseSync,
} from "node:sqlite";

/* ------------------------------------------------------------------ */
/* MaterialRepository                                                   */
/* ------------------------------------------------------------------ */

export class MaterialRepository {
  readonly path: string;
  readonly now: () => IsoTimestamp;
  readonly #generateId: () => string;
  #db: DatabaseSync | null;
  #txDepth: number;
  readonly #catalog: MaterialCatalogRepository;
  readonly #versions: MaterialVersionsRepository;
  readonly #sources: MaterialSourcesRepository;
  readonly #intents: MaterialIntentsRepository;

  private constructor(options: MaterialRepositoryOptions, db: DatabaseSync) {
    this.path = options.path;
    this.now = options.now ?? (() => new Date().toISOString());
    this.#generateId = options.generateId ?? (() => randomUUID());
    this.#db = db;
    this.#txDepth = 0;
    const domainContext: MaterialDomainContext = {
      database: () => { this.#assertOpen(); return this.#db!; },
      assertOpen: () => this.#assertOpen(),
      now: () => this.now(),
      newId: (prefix) => this.#newId(prefix),
      repository: this,
      findTreeRow: (treeId) => this.#findTreeRow(treeId),
      findMaterialRow: (materialId) => this.#findMaterialRow(materialId),
      findVersionRow: (versionId) => this.#findVersionRow(versionId),
      loadSelectionContext: (selection) => this.#loadSelectionContext(selection),
      validateSelectionDiscipline: (selection, version) => this.#validateSelectionDiscipline(selection, version),
    };
    this.#catalog = new MaterialCatalogRepository(domainContext);
    this.#versions = new MaterialVersionsRepository(domainContext);
    this.#sources = new MaterialSourcesRepository(domainContext);
    this.#intents = new MaterialIntentsRepository(domainContext);
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
  createMaterial(input: CreateMaterialInput): Material {
    return this.#catalog.createMaterial(input);
  }

  listMaterials(): Material[] {
    return this.#catalog.listMaterials();
  }

  listTreeMaterials(treeId: TreeId): Material[] {
    return this.#catalog.listTreeMaterials(treeId);
  }

  hasTree(treeId: TreeId): boolean {
    return this.#catalog.hasTree(treeId);
  }

  storeBlob(bytes: Uint8Array): string {
    return this.#catalog.storeBlob(bytes);
  }

  insertVersion(input: InsertMaterialVersionInput): MaterialVersion {
    return this.#versions.insertVersion(input);
  }

  listVersions(materialId: MaterialId): MaterialVersion[] {
    return this.#versions.listVersions(materialId);
  }

  findVersion(versionId: MaterialVersionId): MaterialVersion | null {
    return this.#versions.findVersion(versionId);
  }

  updateVersionParseResult(input: UpdateVersionParseResultInput): MaterialVersion | null {
    return this.#versions.updateVersionParseResult(input);
  }

  getVersionContent(versionId: MaterialVersionId): MaterialVersionContent {
    return this.#versions.getVersionContent(versionId);
  }

  getVersionBlob(versionId: MaterialVersionId): MaterialVersionBlob {
    return this.#versions.getVersionBlob(versionId);
  }

  failNonTerminalParseVersions(parseError: string): number {
    return this.#versions.failNonTerminalParseVersions(parseError);
  }

  linkTreeMaterial(treeId: TreeId, materialId: MaterialId): TreeMaterialLink {
    return this.#catalog.linkTreeMaterial(treeId, materialId);
  }

  unlinkTreeMaterial(treeId: TreeId, materialId: MaterialId): boolean {
    return this.#catalog.unlinkTreeMaterial(treeId, materialId);
  }

  getMaterialSelection(selection: MaterialSelection): MaterialSelectionContext {
    return this.#sources.getMaterialSelection(selection);
  }

  insertMaterialBranchOrigin(input: InsertMaterialBranchOriginInput): MaterialBranchOrigin {
    return this.#sources.insertMaterialBranchOrigin(input);
  }

  getBranchOrigin(branchId: BranchId): BranchOriginRef | null {
    return this.#sources.getBranchOrigin(branchId);
  }

  getBranchOriginKind(branchId: BranchId): BranchOriginKind {
    return this.#sources.getBranchOriginKind(branchId);
  }

  setBranchOriginKind(branchId: BranchId, kind: BranchOriginKind): void {
    return this.#sources.setBranchOriginKind(branchId, kind);
  }

  upsertReadingPosition(input: UpsertReadingPositionInput): MaterialReadingPosition {
    return this.#sources.upsertReadingPosition(input);
  }

  findReadingPosition(treeId: TreeId, materialId: MaterialId): MaterialReadingPosition | null {
    return this.#sources.findReadingPosition(treeId, materialId);
  }

  insertFirstQuestion(input: InsertFirstQuestionInput): InsertFirstQuestionResult {
    return this.#intents.insertFirstQuestion(input);
  }

  findFirstQuestion(treeId: TreeId, intentKey: string): MaterialFirstQuestion | null {
    return this.#intents.findFirstQuestion(treeId, intentKey);
  }

  createMaterialBranch(input: CreateMaterialBranchInput): CreateMaterialBranchResult {
    return this.#intents.createMaterialBranch(input);
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
