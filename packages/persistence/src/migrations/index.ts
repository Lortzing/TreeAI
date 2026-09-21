/**
 * 版本化 migration 注册表与执行器。
 *
 * 纪律：
 * - migration 一经交付**不可修改**（历史库已应用同版本内容）；修正走新版本号。
 * - 版本号从 1 起连续递增；注册表校验连续性，缺口视为本包缺陷（启动即抛）。
 * - 每条 migration 在独立事务中执行（BEGIN IMMEDIATE → DDL → 登记 →
 *   PRAGMA user_version → COMMIT）；失败整体回滚该条并抛 `MigrationFailedError`，
 *   已提交的前序 migration 保持有效（逐条原子，非全量原子——见 README）。
 * - 重复执行安全：已应用版本跳过；对空库按序全量应用。
 * - schema_migrations 与 PRAGMA user_version 交叉校验，两者矛盾按损坏处理。
 */
import type { DatabaseSync } from "node:sqlite";
import { DatabaseCorruptError, MigrationFailedError, UnsupportedDatabaseVersionError } from "../errors.ts";
import { initialSchemaMigration } from "./0001-initial-schema.ts";

/** 一条版本化 migration。`up` 必须只含幂等性不要求的 DDL（事务保护下执行一次）。 */
export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: (db: DatabaseSync) => void;
}

/** 已交付的 migration 注册表（有序）。 */
export const MIGRATIONS: readonly Migration[] = [initialSchemaMigration];

/** 当前代码支持的最高 schema 版本。 */
export const LATEST_SCHEMA_VERSION: number = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

function assertContiguous(migrations: readonly Migration[]): void {
  for (let i = 0; i < migrations.length; i++) {
    const m = migrations[i]!;
    if (m.version !== i + 1) {
      throw new Error(
        `migration registry is not contiguous: expected version ${i + 1} at index ${i}, got ${m.version} (${m.name})`,
      );
    }
  }
}

/** 系统登记表 DDL（与 user_version 一起构成版本状态）。 */
const SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY NOT NULL,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
`;

interface Row {
  [column: string]: unknown;
}

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as Row | undefined;
  return Number(row?.n ?? 0) > 0;
}

function userVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as Row | undefined;
  return Number(row?.user_version ?? 0);
}

function nonInternalTableCount(db: DatabaseSync): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .get() as Row | undefined;
  return Number(row?.n ?? 0);
}

function appliedVersions(db: DatabaseSync): number[] {
  const rows = db
    .prepare("SELECT version FROM schema_migrations ORDER BY version")
    .all() as Array<{ version: number }>;
  return rows.map((r) => Number(r.version));
}

export interface MigrationResult {
  /** 本次执行实际应用的版本（按序）。 */
  readonly applied: readonly number[];
  /** 已存在而跳过的版本。 */
  readonly skipped: readonly number[];
  /** 执行后的 schema 版本。 */
  readonly schemaVersion: number;
}

/**
 * 执行 migration（幂等）。
 *
 * 损坏/外来库判定（打开后、写入前）：
 * - 有用户表但无 schema_migrations → DatabaseCorruptError（不是 TreeAI 库或状态无法辨认）；
 * - user_version > 0 但无 schema_migrations → DatabaseCorruptError；
 * - 已应用版本存在缺口或未知低位版本 → DatabaseCorruptError；
 * - 存在高于当前支持上限的版本 → UnsupportedDatabaseVersionError。
 */
export function runMigrations(
  db: DatabaseSync,
  migrations: readonly Migration[] = MIGRATIONS,
  now: () => string = () => new Date().toISOString(),
): MigrationResult {
  assertContiguous(migrations);
  const maxSupported = migrations[migrations.length - 1]?.version ?? 0;

  const hasMigrationsTable = tableExists(db, "schema_migrations");
  const tableCount = nonInternalTableCount(db);
  const uv = userVersion(db);

  if (!hasMigrationsTable) {
    if (tableCount > 0) {
      throw new DatabaseCorruptError(
        `database has ${tableCount} user table(s) but no schema_migrations table; ` +
          `not a TreeAI database or schema state is unrecognizable`,
      );
    }
    if (uv > 0) {
      throw new DatabaseCorruptError(
        `PRAGMA user_version is ${uv} but no schema_migrations table exists; ` +
          `schema state is inconsistent (possible corruption or foreign database)`,
      );
    }
  }

  // 建立登记表（空库时这是首条用户表；已有库时 IF NOT EXISTS 无操作）。
  db.exec(SCHEMA_MIGRATIONS_DDL);

  const existing = hasMigrationsTable ? appliedVersions(db) : [];
  if (existing.length > 0) {
    const known = new Set(migrations.map((m) => m.version));
    for (const v of existing) {
      if (v > maxSupported) {
        throw new UnsupportedDatabaseVersionError(
          `database schema version ${v} is newer than supported version ${maxSupported}; ` +
            `upgrade TreeAI before opening this database`,
          v,
          maxSupported,
        );
      }
      if (!known.has(v)) {
        throw new DatabaseCorruptError(
          `schema_migrations contains unknown version ${v} (supported: 1..${maxSupported}); ` +
            `possible corruption or foreign database`,
        );
      }
    }
    for (let i = 0; i < existing.length; i++) {
      if (existing[i] !== i + 1) {
        throw new DatabaseCorruptError(
          `applied migration versions are not a contiguous prefix starting at 1: ` +
            `[${existing.join(", ")}]`,
        );
      }
    }
    // user_version 与登记表交叉校验（登记表为准，允许偏低并重同步——
    // 例如旧版本写入路径未及设置 user_version 即崩溃）。
    if (uv > existing[existing.length - 1]!) {
      throw new DatabaseCorruptError(
        `PRAGMA user_version (${uv}) exceeds applied migration versions ` +
          `(latest applied: ${existing[existing.length - 1]}); inconsistent schema state`,
      );
    }
  }

  const applied: number[] = [];
  const skipped = [...existing];
  const nextVersion = existing.length + 1;

  for (const migration of migrations) {
    if (migration.version < nextVersion) continue;
    try {
      db.exec("BEGIN IMMEDIATE");
      migration.up(db);
      db
        .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
        .run(migration.version, migration.name, now());
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec("COMMIT");
      applied.push(migration.version);
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // 事务已不存在（例如驱动在 ABORT 时自动回滚）——继续抛原始失败。
      }
      throw new MigrationFailedError(
        `migration ${migration.version} ('${migration.name}') failed and was rolled back; ` +
          `database remains at its previous schema version`,
        migration.version,
        migration.name,
        { cause: error },
      );
    }
  }

  // 重同步 user_version（覆盖"登记表已有但 user_version 落后"的情况）。
  if (applied.length > 0) {
    db.exec(`PRAGMA user_version = ${applied[applied.length - 1]}`);
  } else if (existing.length > 0 && uv !== existing[existing.length - 1]) {
    db.exec(`PRAGMA user_version = ${existing[existing.length - 1]}`);
  }

  const schemaVersion = userVersion(db);
  return { applied, skipped, schemaVersion };
}
