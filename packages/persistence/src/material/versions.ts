/** versions SQL/domain operations. The owning repository retains connection and transaction lifecycle. */

import {
  DatabaseCorruptError,
  EntityNotFoundError,
  InvalidArgumentError,
  mapSqliteError,
} from "../errors.ts";

import type {
  InsertMaterialVersionInput,
  MaterialParseTransitionStatus,
  MaterialRow,
  MaterialVersionBlob,
  MaterialVersionContent,
  MaterialVersionRow,
  UpdateVersionParseResultInput,
} from "./model.ts";
import {
  FAILURE_STATUSES,
  MATERIAL_COLUMNS,
  MATERIAL_VERSION_COLUMNS,
  PARSE_STATUSES,
} from "./policy.ts";
import {
  rowToMaterialVersion,
} from "./serialization.ts";
import {
  assertNonEmptyString,
  assertParserKind,
  assertValidBlockCoverage,
  decodeBlockMap,
  isParserKind,
  isParseStatus,
  sha256Hex,
} from "./validation.ts";
import type {
  MaterialId,
  MaterialParserKind,
  MaterialVersion,
  MaterialVersionId,
} from "@treeai/contracts";


import type {
  MaterialDomainContext,
} from "./context.ts";

export class MaterialVersionsRepository {
  readonly #context: MaterialDomainContext;
  constructor(context: MaterialDomainContext) { this.#context = context; }


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
    this.#context.assertOpen();
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

    return this.#context.repository.transaction((): MaterialVersion => {
      const db = this.#context.database()!;
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

      const id = input.id ?? (this.#context.newId("matver") as MaterialVersionId);
      assertNonEmptyString(id, "material version id");
      const importedAt = this.#context.now();
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
    this.#context.assertOpen();
    assertNonEmptyString(materialId, "material id");
    const rows = this.#context.database()!
      .prepare(
        `SELECT ${MATERIAL_VERSION_COLUMNS} FROM material_versions WHERE material_id = ? ORDER BY imported_at, rowid`,
      )
      .all(materialId) as unknown as MaterialVersionRow[];
    return rows.map(rowToMaterialVersion);
  }


  /** 单版本读取（无则 null）。 */
  findVersion(versionId: MaterialVersionId): MaterialVersion | null {
    this.#context.assertOpen();
    assertNonEmptyString(versionId, "material version id");
    const row = this.#context.findVersionRow(versionId);
    return row === undefined ? null : rowToMaterialVersion(row);
  }


  /**
   * 解析流水线的状态迁移（D4-1 导入服务专用）：
   * pending/parsing → parsing | ready | failed | canceled。
   *
   * **迟到结果结构性拒绝**（charter §3.2「迟到结果不挂靠」的存储层守卫）：
   * UPDATE 以 `WHERE parse_status IN ('pending','parsing')` 为条件——版本一旦
   * 到达任一终态（ready/failed/canceled/unsupported/rejected），任何后续
   * 迁移请求都改零行。本方法此时返回 **null**（不抛错、不改写、不复活）；
   * 调用方（导入服务）据此丢弃迟到结果。取消与解析完成之间的竞争由此由
   * 数据库行本身仲裁：先落库者赢，后者必然收到 null。
   *
   * ready：canonicalText/blocks 落库（块覆盖校验同 insertVersion，
   * text_units 重算）；failed：parseError 必填、canonicalText 必须为空
   * （超限/失败文本不存储——「在耗尽资源前明确拒绝」的存储面）；parsing/
   * canceled：canonicalText 必须为空。未知版本抛 EntityNotFoundError。
   */
  updateVersionParseResult(input: UpdateVersionParseResultInput): MaterialVersion | null {
    this.#context.assertOpen();
    assertNonEmptyString(input.versionId, "material version id");
    const allowed: readonly MaterialParseTransitionStatus[] = ["parsing", "ready", "failed", "canceled"];
    if (!allowed.includes(input.parseStatus)) {
      throw new InvalidArgumentError(
        `parse transition status must be one of {${allowed.join(", ")}} (got '${String(input.parseStatus)}')`,
      );
    }
    const isFailure = input.parseStatus === "failed";
    const parseError = input.parseError ?? null;
    if (isFailure && (typeof parseError !== "string" || parseError.trim().length === 0)) {
      throw new InvalidArgumentError("parse transition to 'failed' requires a parseError (reason code + note)");
    }
    if (!isFailure && parseError !== null) {
      throw new InvalidArgumentError(`parseError must not be provided for parse transition '${input.parseStatus}'`);
    }
    if (typeof input.canonicalText !== "string") {
      throw new InvalidArgumentError("canonicalText must be a string");
    }
    if (input.parseStatus !== "ready" && input.canonicalText.length > 0) {
      throw new InvalidArgumentError(
        `canonicalText must be empty for parse transition '${input.parseStatus}' ` +
          "(canonical text is stored only with the ready state)",
      );
    }
    if (!Array.isArray(input.blocks)) {
      throw new InvalidArgumentError("blocks must be an array of MaterialBlock");
    }
    if (input.parseStatus === "ready") {
      assertValidBlockCoverage(input.blocks, input.canonicalText.length, this.#parserKindOf(input.versionId));
    } else if (input.blocks.length > 0) {
      throw new InvalidArgumentError(
        `blocks must be empty for parse transition '${input.parseStatus}' (blocks are stored only with the ready state)`,
      );
    }
    return this.#context.repository.transaction((): MaterialVersion | null => {
      const db = this.#context.database()!;
      let changes: { changes: number | bigint };
      try {
        changes = db
          .prepare(
            `UPDATE material_versions
               SET parse_status = ?, parse_error = ?, text_units = ?, canonical_text = ?, block_map_json = ?
             WHERE version_id = ? AND parse_status IN ('pending', 'parsing')`,
          )
          .run(
            input.parseStatus,
            parseError,
            input.canonicalText.length,
            input.canonicalText,
            JSON.stringify(input.blocks),
            input.versionId,
          ) as unknown as { changes: number | bigint };
      } catch (error) {
        throw mapSqliteError(error, "updating material version parse result");
      }
      if (Number(changes.changes) === 0) {
        const row = db
          .prepare(`SELECT version_id FROM material_versions WHERE version_id = ?`)
          .get(input.versionId);
        if (row === undefined) throw new EntityNotFoundError("material version", input.versionId);
        return null; // 版本已终态：迟到迁移结构性拒绝（不复活、不改写）。
      }
      const updated = db
        .prepare(`SELECT ${MATERIAL_VERSION_COLUMNS} FROM material_versions WHERE version_id = ?`)
        .get(input.versionId) as MaterialVersionRow | undefined;
      if (updated === undefined) {
        throw new DatabaseCorruptError(
          `material version ${input.versionId} not readable after parse-result update (schema integrity violation)`,
        );
      }
      return rowToMaterialVersion(updated);
    });
  }


  /**
   * 版本内容读取（canonicalText + 块图；分块分页归服务层，本方法整版返回
   * ——本地单用户规模下的直接读取面）。未知版本抛 EntityNotFoundError。
   */
  getVersionContent(versionId: MaterialVersionId): MaterialVersionContent {
    this.#context.assertOpen();
    assertNonEmptyString(versionId, "material version id");
    const row = this.#context.findVersionRow(versionId);
    if (row === undefined) throw new EntityNotFoundError("material version", versionId);
    return {
      version: rowToMaterialVersion(row),
      canonicalText: row.canonical_text,
      blocks: decodeBlockMap(row.version_id, row.block_map_json),
    };
  }


  /** Read the immutable original bytes referenced by a material version. */
  getVersionBlob(versionId: MaterialVersionId): MaterialVersionBlob {
    this.#context.assertOpen();
    assertNonEmptyString(versionId, "material version id");
    const row = this.#context.database()!
      .prepare(
        `SELECT v.${MATERIAL_VERSION_COLUMNS.replaceAll(", ", ", v.")}, b.bytes AS blob_bytes
         FROM material_versions v
         JOIN material_blobs b ON b.content_hash = v.content_hash
         WHERE v.version_id = ?`,
      )
      .get(versionId) as (MaterialVersionRow & { blob_bytes: Uint8Array }) | undefined;
    if (row === undefined) throw new EntityNotFoundError("material version", versionId);
    if (!(row.blob_bytes instanceof Uint8Array)) {
      throw new DatabaseCorruptError(`material version ${versionId} has no readable original blob`);
    }
    return { version: rowToMaterialVersion(row), bytes: new Uint8Array(row.blob_bytes) };
  }


  /**
   * 宿主中断恢复（与 TreeRepository.failNonTerminalRuns 同一纪律）：把库中
   * 仍处 pending/parsing 的版本收敛为 failed（parseError 给出原因）。解析
   * 任务是进程内状态，重启后不可续——与其永远悬置，不如如实失败。
   * 返回收敛行数。
   */
  failNonTerminalParseVersions(parseError: string): number {
    this.#context.assertOpen();
    if (typeof parseError !== "string" || parseError.trim().length === 0) {
      throw new InvalidArgumentError("parseError must be a non-empty string");
    }
    try {
      const result = this.#context.database()!
        .prepare(
          `UPDATE material_versions
             SET parse_status = 'failed', parse_error = ?
           WHERE parse_status IN ('pending', 'parsing')`,
        )
        .run(parseError);
      return Number(result.changes);
    } catch (error) {
      throw mapSqliteError(error, "failing non-terminal material versions");
    }
  }


  /** 版本的 parser_kind（迁移校验用；未知版本抛 EntityNotFoundError）。 */
  #parserKindOf(versionId: MaterialVersionId): MaterialParserKind {
    const row = this.#context.findVersionRow(versionId);
    if (row === undefined) throw new EntityNotFoundError("material version", versionId);
    return assertParserKind(row.parser_kind, `material version ${versionId}`);
  }
}
