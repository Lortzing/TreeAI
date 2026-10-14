/** fact-validation ownership for restore-service.ts; compatibility entrypoint remains one level above. */
import {
  FACT_TABLES,
  FACT_TABLES_BY_NAME,
  type FactsFileShape,
  PortabilityError,
  TABLE_PRIMARY_KEYS,
} from "../package-format.ts";
import type {
  LoadedBlob,
} from "./model.ts";

/* ------------------------------------------------------------------ */
/* 阶段 2：facts 形状 + 引用完整性                                       */
/* ------------------------------------------------------------------ */

export function validateFactsShapes(facts: ReadonlyMap<string, FactsFileShape>): void {
  for (const spec of FACT_TABLES) {
    const shape = facts.get(spec.table);
    if (shape === undefined) {
      throw new PortabilityError("facts-invalid", `facts snapshot is missing table '${spec.table}'`);
    }
    const expected = spec.columns.map((column) => column.name).join(",");
    const actual = shape.columns.join(",");
    if (expected !== actual) {
      throw new PortabilityError(
        "facts-invalid",
        `facts/${spec.table}.json columns [${actual}] do not match the frozen layout [${expected}]`,
      );
    }
    for (let rowIndex = 0; rowIndex < shape.rows.length; rowIndex += 1) {
      const row = shape.rows[rowIndex]!;
      if (!Array.isArray(row) || row.length !== spec.columns.length) {
        throw new PortabilityError(
          "facts-invalid",
          `facts/${spec.table}.json row ${rowIndex} has ${String(Array.isArray(row) ? row.length : "non-array")} cells (expected ${spec.columns.length})`,
        );
      }
      for (let cellIndex = 0; cellIndex < spec.columns.length; cellIndex += 1) {
        const column = spec.columns[cellIndex]!;
        const cell = row[cellIndex];
        if (cell === null) {
          if (!column.nullable) {
            throw new PortabilityError(
              "facts-invalid",
              `facts/${spec.table}.json row ${rowIndex}: column '${column.name}' is NOT NULL but carries null`,
            );
          }
          continue;
        }
        if (column.kind === "text" && typeof cell !== "string") {
          throw new PortabilityError(
            "facts-invalid",
            `facts/${spec.table}.json row ${rowIndex}: column '${column.name}' must be a string (got '${typeof cell}')`,
          );
        }
        if (column.kind === "integer" && (!Number.isInteger(cell) || typeof cell !== "number")) {
          throw new PortabilityError(
            "facts-invalid",
            `facts/${spec.table}.json row ${rowIndex}: column '${column.name}' must be an integer`,
          );
        }
      }
    }
  }
}

/** 引用完整性：全外键闭包 + 主键唯一性（blobs 以内容寻址集合参与）。 */
export function validateReferentialIntegrity(
  facts: ReadonlyMap<string, FactsFileShape>,
  blobs: readonly LoadedBlob[],
): void {
  /* 主键值集合（表 → 键串集合）。 */
  const keysByTable = new Map<string, Set<string>>();
  for (const spec of FACT_TABLES) {
    const shape = facts.get(spec.table)!;
    const pk = TABLE_PRIMARY_KEYS[spec.table]!;
    const pkIndexes = pk.map((column) => shape.columns.indexOf(column));
    const set = new Set<string>();
    for (const row of shape.rows) {
      const key = pkIndexes.map((index) => encodeKeyCell(row[index] ?? null)).join(" ");
      if (set.has(key)) {
        throw new PortabilityError(
          "integrity-failed",
          `facts/${spec.table}.json has duplicate primary key [${pk.join(", ")}] = [${key.replaceAll(" ", ", ")}]`,
        );
      }
      set.add(key);
    }
    keysByTable.set(spec.table, set);
  }
  const blobHashes = new Set(blobs.map((blob) => blob.hash));

  /* 外键闭包（FK 目标列恒为各表首主键列——见 TABLE_PRIMARY_KEYS/FK 声明）。 */
  for (const spec of FACT_TABLES) {
    const shape = facts.get(spec.table)!;
    for (const foreignKey of spec.foreignKeys) {
      const columnIndex = shape.columns.indexOf(foreignKey.column);
      if (columnIndex < 0) {
        throw new PortabilityError("facts-layout-invalid", `table '${spec.table}' has no FK column '${foreignKey.column}'`);
      }
      const [refTable = "", refColumn = ""] = foreignKey.references.split(".");
      let target: Set<string>;
      if (refTable === "material_blobs") {
        if (refColumn !== "content_hash") {
          throw new PortabilityError("facts-layout-invalid", `unexpected blob FK target '${foreignKey.references}'`);
        }
        target = blobHashes;
      } else {
        const refSpec = FACT_TABLES_BY_NAME.get(refTable);
        if (refSpec === undefined) {
          throw new PortabilityError("facts-layout-invalid", `FK references unknown table '${refTable}'`);
        }
        const refPk = TABLE_PRIMARY_KEYS[refTable] ?? [];
        if (refPk[0] !== refColumn) {
          throw new PortabilityError(
            "facts-layout-invalid",
            `FK target '${foreignKey.references}' must be the referenced table's primary key`,
          );
        }
        target = keysByTable.get(refTable)!;
      }
      for (let rowIndex = 0; rowIndex < shape.rows.length; rowIndex += 1) {
        const cell = shape.rows[rowIndex]![columnIndex]!;
        if (cell === null) continue; // 可空外键（nullability 已在形状校验复核）。
        const encoded = encodeKeyCell(cell);
        if (!target.has(encoded)) {
          throw new PortabilityError(
            "integrity-failed",
            `facts/${spec.table}.json row ${rowIndex}: '${foreignKey.column}' references missing ` +
              `${foreignKey.references} '${String(cell)}' (referential integrity violation)`,
          );
        }
      }
    }
  }
}

export function encodeKeyCell(cell: string | number | null): string {
  return cell === null ? "null" : `${typeof cell}:${String(cell)}`;
}
