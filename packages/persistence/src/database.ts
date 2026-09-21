/**
 * 底层数据库操作：打开（PRAGMA 配置）、损坏检测、integrity check、
 * 在线备份（VACUUM INTO）与备份校验。
 *
 * 驱动：Node 内置 `node:sqlite`（`DatabaseSync`）。决策记录见
 * `coordination/d2/agent-c-dependency-request.md`（零新增 npm 依赖）。
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import {
  BackupError,
  DatabaseCorruptError,
  mapSqliteError,
  PersistenceError,
  UnsupportedDatabaseVersionError,
} from "./errors.ts";
import { LATEST_SCHEMA_VERSION, runMigrations } from "./migrations/index.ts";

export interface OpenDatabaseOptions {
  /** 数据库文件路径；`":memory:"` 为纯内存库。 */
  readonly path: string;
  /** 写锁等待毫秒数（默认 5000）。 */
  readonly busyTimeoutMs?: number;
  /** 文件库是否启用 WAL（默认 true；内存库忽略）。 */
  readonly wal?: boolean;
}

export interface OpenedDatabase {
  readonly db: DatabaseSync;
  /** 本次打开实际应用的 migration 版本。 */
  readonly appliedMigrations: readonly number[];
  /** 打开后的 schema 版本。 */
  readonly schemaVersion: number;
}

function isMemoryPath(path: string): boolean {
  return path === ":memory:" || path.startsWith("file::memory:");
}

/**
 * 打开数据库并执行 migration。
 *
 * 明确失败模式（均以 persistence 错误抛出）：
 * - 文件存在但不是 SQLite 数据库 / 磁盘映像损坏 → `DatabaseCorruptError`；
 * - 有用户表但无 schema_migrations（外来库）→ `DatabaseCorruptError`；
 * - schema 版本高于当前支持 → `UnsupportedDatabaseVersionError`；
 * - migration 执行失败 → `MigrationFailedError`（该条已回滚）。
 */
export function openDatabase(options: OpenDatabaseOptions): OpenedDatabase {
  const { path } = options;
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  } catch (error) {
    throw new DatabaseCorruptError(
      `failed to open database at '${path}': file is not a valid SQLite database or cannot be opened`,
      { cause: error },
    );
  }

  try {
    const busyTimeoutMs = options.busyTimeoutMs ?? 5000;
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    if (!isMemoryPath(path) && (options.wal ?? true)) {
      db.exec("PRAGMA journal_mode = WAL");
    }
    // FULL 同步：提交落盘优先于吞吐（本地单用户场景开销可接受）。
    db.exec("PRAGMA synchronous = FULL");
    // 触发损坏/外来库检测，随后按需应用 migration。
    const result = runMigrations(db);
    return {
      db,
      appliedMigrations: result.applied,
      schemaVersion: result.schemaVersion,
    };
  } catch (error) {
    try {
      db.close();
    } catch {
      // 打开失败的清理失败不掩盖原始错误。
    }
    // 已分类的 persistence 错误原样上抛；裸驱动错误（如垃圾文件在
    // journal_mode PRAGMA 处暴露的 "file is not a database"）统一映射。
    if (error instanceof PersistenceError) {
      throw error;
    }
    throw mapSqliteError(error, "initializing database");
  }
}

/** 只读打开一个数据库文件（用于备份校验；不执行 migration、不写入）。 */
export function openDatabaseReadOnly(path: string): DatabaseSync {
  if (!existsSync(path)) {
    throw new BackupError(`backup file does not exist: ${path}`);
  }
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch (error) {
    throw new DatabaseCorruptError(
      `failed to open database read-only at '${path}': file is not a valid SQLite database`,
      { cause: error },
    );
  }
  try {
    db.exec("PRAGMA busy_timeout = 5000");
  } catch (error) {
    try {
      db.close();
    } catch {
      // 忽略清理失败。
    }
    throw mapSqliteError(error, "configuring read-only database");
  }
  return db;
}

export interface IntegrityReport {
  readonly ok: boolean;
  /** integrity_check 的输出行（ok 时为 ["ok"]）。 */
  readonly log: readonly string[];
}

/** 执行 `PRAGMA integrity_check`。 */
export function checkIntegrity(db: DatabaseSync): IntegrityReport {
  try {
    const rows = db.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
    const log = rows.map((r) => r.integrity_check);
    return { ok: log.length === 1 && log[0] === "ok", log };
  } catch (error) {
    throw mapSqliteError(error, "integrity check");
  }
}

/** 当前 schema 版本（user_version；未初始化的库为 0）。 */
export function currentSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
}

export interface BackupValidation {
  /** 备份是否为可被当前代码打开的 TreeAI 数据库。 */
  readonly valid: boolean;
  /** 备份的 schema 版本。 */
  readonly schemaVersion: number;
  /** integrity_check 报告。 */
  readonly integrity: IntegrityReport;
}

/**
 * 校验一个备份文件：可读、完整、且 schema 版本不高于当前支持。
 * 返回校验结果；文件不存在或不可读时抛 `BackupError`/`DatabaseCorruptError`。
 */
export function validateDatabaseFile(path: string): BackupValidation {
  const db = openDatabaseReadOnly(path);
  try {
    const integrity = checkIntegrity(db);
    const version = currentSchemaVersion(db);
    if (version > LATEST_SCHEMA_VERSION) {
      throw new UnsupportedDatabaseVersionError(
        `backup schema version ${version} is newer than supported ${LATEST_SCHEMA_VERSION}`,
        version,
        LATEST_SCHEMA_VERSION,
      );
    }
    // version 0：是 SQLite 文件但非 TreeAI 库（空库或外来库）。
    const hasMigrationsTable = (
      db
        .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
        .get() as { n?: number }
    ).n ?? 0;
    const valid = integrity.ok && version > 0 && hasMigrationsTable > 0;
    return { valid, schemaVersion: version, integrity };
  } finally {
    db.close();
  }
}

/**
 * 在线备份：`VACUUM INTO`。
 * 目标已存在时 SQLite 拒绝（防覆盖）；调用方需要覆盖时先自行删除。
 */
export function vacuumInto(db: DatabaseSync, destination: string): void {
  try {
    db.prepare("VACUUM INTO ?").run(destination);
  } catch (error) {
    throw mapSqliteError(error, "creating backup");
  }
}
