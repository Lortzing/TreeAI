/** sources SQL/domain operations. The owning repository retains connection and transaction lifecycle. */

import {
  DatabaseCorruptError,
  EntityNotFoundError,
  InvalidArgumentError,
  mapSqliteError,
} from "../errors.ts";
import {
  type BranchOriginRow,
  rowToBranchOrigin,
} from "../serialization.ts";
import type {
  BranchOriginKind,
  BranchOriginRef,
  InsertMaterialBranchOriginInput,
  MaterialBranchOriginRow,
  MaterialSelectionContext,
  ReadingPositionRow,
  UpsertReadingPositionInput,
} from "./model.ts";
import {
  ORIGIN_KINDS,
} from "./policy.ts";
import {
  rowToMaterial,
  rowToMaterialBranchOrigin,
  rowToMaterialVersion,
  rowToReadingPosition,
} from "./serialization.ts";
import {
  assertNonEmptyString,
  assertValidSelectionShape,
  decodeBlockMap,
  isOriginKind,
} from "./validation.ts";
import type {
  BranchId,
  MaterialBranchOrigin,
  MaterialId,
  MaterialReadingPosition,
  MaterialSelection,
  TreeId,
} from "@treeai/contracts";


import type {
  MaterialDomainContext,
} from "./context.ts";

export class MaterialSourcesRepository {
  readonly #context: MaterialDomainContext;
  constructor(context: MaterialDomainContext) { this.#context = context; }


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
    this.#context.assertOpen();
    assertValidSelectionShape(selection);
    const { material, version } = this.#context.loadSelectionContext(selection);
    this.#context.validateSelectionDiscipline(selection, version);
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
    this.#context.assertOpen();
    assertNonEmptyString(input.branchId, "branch id");
    assertNonEmptyString(input.treeId, "tree id");
    assertValidSelectionShape(input.selection);
    return this.#context.repository.transaction((): MaterialBranchOrigin => {
      const db = this.#context.database()!;
      const branch = db
        .prepare("SELECT id, tree_id, parent_branch_id, created_at FROM branches WHERE id = ?")
        .get(input.branchId) as { id: string; tree_id: string } | undefined;
      if (branch === undefined) throw new EntityNotFoundError("branch", input.branchId);
      if (branch.tree_id !== input.treeId) {
        throw new InvalidArgumentError(
          `branch ${input.branchId} belongs to tree ${branch.tree_id}, not ${input.treeId}`,
        );
      }
      const { version } = this.#context.loadSelectionContext(input.selection);
      if (version.parse_status !== "ready") {
        throw new InvalidArgumentError(
          `material version ${input.selection.versionId} is not ready for precise branching ` +
            `(parse status '${version.parse_status}'${version.parse_error === null ? "" : `: ${version.parse_error}`})`,
        );
      }
      this.#context.validateSelectionDiscipline(input.selection, version);

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

      const createdAt = this.#context.now();
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
    this.#context.assertOpen();
    assertNonEmptyString(branchId, "branch id");
    const db = this.#context.database()!;
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
    this.#context.assertOpen();
    assertNonEmptyString(branchId, "branch id");
    const row = this.#context.database()!.prepare("SELECT origin_kind FROM branches WHERE id = ?").get(branchId) as
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
    this.#context.assertOpen();
    assertNonEmptyString(branchId, "branch id");
    if (!isOriginKind(kind)) {
      throw new InvalidArgumentError(`origin kind must be one of {${ORIGIN_KINDS.join(", ")}} (got '${String(kind)}')`);
    }
    this.#context.repository.transaction((): void => {
      const db = this.#context.database()!;
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
    this.#context.assertOpen();
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
    if (this.#context.findTreeRow(input.treeId) === undefined) throw new EntityNotFoundError("tree", input.treeId);
    if (this.#context.findMaterialRow(input.materialId) === undefined) {
      throw new EntityNotFoundError("material", input.materialId);
    }
    const version = this.#context.findVersionRow(input.versionId);
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
    const updatedAt = this.#context.now();
    try {
      this.#context.database()!
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
    this.#context.assertOpen();
    assertNonEmptyString(treeId, "tree id");
    assertNonEmptyString(materialId, "material id");
    const row = this.#context.database()!
      .prepare(
        `SELECT tree_id, material_id, version_id, block_id, focus_start, updated_at
         FROM tree_material_reading_state WHERE tree_id = ? AND material_id = ?`,
      )
      .get(treeId, materialId) as ReadingPositionRow | undefined;
    return row ? rowToReadingPosition(row) : null;
  }
}
