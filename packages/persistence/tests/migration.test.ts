/**
 * Migration 测试：空库迁移、重复执行安全、外来/损坏库、版本过新、
 * migration 失败回滚。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Migration } from "../src/index.ts";
import {
  DatabaseCorruptError,
  LATEST_SCHEMA_VERSION,
  MigrationFailedError,
  MIGRATIONS,
  runMigrations,
  TreeRepository,
  UnsupportedDatabaseVersionError,
} from "../src/index.ts";
import { cleanupTempDir, dbPath, makeTempDir } from "./helpers.ts";

test("migration applies to an empty file database", () => {
  const dir = makeTempDir();
  try {
    const path = dbPath(dir);
    const repo = TreeRepository.open({ path });
    assert.equal(repo.schemaVersion, LATEST_SCHEMA_VERSION);
    // schema 可用性：一次完整的领域写入
    const forest = repo.createForest();
    assert.ok(forest.id.startsWith("forest_"));
    repo.close();

    // 登记表与 user_version 均到位
    const raw = new DatabaseSync(path, { readOnly: true });
    const versions = raw.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{
      version: number;
    }>;
    assert.deepEqual(
      versions.map((v) => Number(v.version)),
      Array.from({ length: LATEST_SCHEMA_VERSION }, (_, i) => i + 1),
    );
    const uv = raw.prepare("PRAGMA user_version").get() as { user_version: number };
    assert.equal(Number(uv.user_version), LATEST_SCHEMA_VERSION);
    raw.close();
  } finally {
    cleanupTempDir(dir);
  }
});

test("migration applies to an empty in-memory database", () => {
  const repo = TreeRepository.open({ path: ":memory:" });
  assert.equal(repo.schemaVersion, LATEST_SCHEMA_VERSION);
  const forest = repo.createForest();
  assert.deepEqual(repo.listForests().map((f) => f.id), [forest.id]);
  repo.close();
});

test("repeated migration execution is safe (idempotent)", () => {
  const dir = makeTempDir();
  try {
    const path = dbPath(dir);
    const repo = TreeRepository.open({ path });
    const forest = repo.createForest();
    repo.close();

    // 二次打开：已应用即跳过，数据保留
    const repo2 = TreeRepository.open({ path });
    assert.equal(repo2.schemaVersion, LATEST_SCHEMA_VERSION);
    assert.deepEqual(repo2.listForests().map((f) => f.id), [forest.id]);
    repo2.close();

    // 直接重复执行 runMigrations（同连接）：no-op
    const raw = new DatabaseSync(path);
    const result1 = runMigrations(raw);
    assert.deepEqual(result1.applied, []);
    assert.equal(result1.schemaVersion, LATEST_SCHEMA_VERSION);
    const result2 = runMigrations(raw);
    assert.deepEqual(result2.applied, []);
    // 登记表无重复行
    const rows = raw.prepare("SELECT version, COUNT(*) AS c FROM schema_migrations GROUP BY version").all() as Array<{
      version: number;
      c: number;
    }>;
    for (const row of rows) {
      assert.equal(Number(row.c), 1, `version ${row.version} registered exactly once`);
    }
    raw.close();
  } finally {
    cleanupTempDir(dir);
  }
});

test("corrupt file (not SQLite) fails with DatabaseCorruptError", () => {
  const dir = makeTempDir();
  try {
    const path = dbPath(dir, "garbage.db");
    writeFileSync(path, "this is definitely not a sqlite database file");
    assert.throws(() => TreeRepository.open({ path }), DatabaseCorruptError);
  } finally {
    cleanupTempDir(dir);
  }
});

test("foreign SQLite database (tables but no schema_migrations) is rejected", () => {
  const dir = makeTempDir();
  try {
    const path = dbPath(dir, "foreign.db");
    const raw = new DatabaseSync(path);
    raw.exec("CREATE TABLE other_app (id TEXT PRIMARY KEY)");
    raw.close();
    assert.throws(
      () => TreeRepository.open({ path }),
      (e: unknown) => e instanceof DatabaseCorruptError && /not a TreeAI database/.test(e.message),
    );
  } finally {
    cleanupTempDir(dir);
  }
});

test("user_version set but schema_migrations missing is treated as corrupt", () => {
  const dir = makeTempDir();
  try {
    const path = dbPath(dir, "inconsistent.db");
    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA user_version = 1");
    raw.close();
    assert.throws(() => TreeRepository.open({ path }), DatabaseCorruptError);
  } finally {
    cleanupTempDir(dir);
  }
});

test("database from a newer TreeAI version fails with UnsupportedDatabaseVersionError", () => {
  const dir = makeTempDir();
  try {
    const path = dbPath(dir);
    const repo = TreeRepository.open({ path });
    repo.close();
    const raw = new DatabaseSync(path);
    raw.exec(
      `INSERT INTO schema_migrations (version, name, applied_at) VALUES (${LATEST_SCHEMA_VERSION + 1}, 'future', '2027-01-01T00:00:00.000Z')`,
    );
    raw.exec(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION + 1}`);
    raw.close();
    assert.throws(() => TreeRepository.open({ path }), UnsupportedDatabaseVersionError);
  } finally {
    cleanupTempDir(dir);
  }
});

test("failed migration rolls back atomically and reports version", () => {
  const dir = makeTempDir();
  try {
    const path = dbPath(dir, "failing.db");
    const raw = new DatabaseSync(path);

    const badSecond: Migration = {
      version: 2,
      name: "deliberately-broken",
      up: (db) => {
        db.exec("CREATE TABLE partial_table (id TEXT PRIMARY KEY)");
        db.exec("THIS IS NOT VALID SQL ;;;");
      },
    };
    const list: Migration[] = [MIGRATIONS[0]!, badSecond];

    assert.throws(
      () => runMigrations(raw, list),
      (e: unknown) =>
        e instanceof MigrationFailedError && e.version === 2 && e.migrationName === "deliberately-broken",
    );

    // v1 已提交；v2 的表已回滚；版本停在 1
    const count = raw
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='partial_table'")
      .get() as { n: number };
    assert.equal(Number(count.n), 0, "partially-created table must be rolled back");
    const versions = raw.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>;
    assert.deepEqual(versions.map((v) => Number(v.version)), [1]);
    const uv = raw.prepare("PRAGMA user_version").get() as { user_version: number };
    assert.equal(Number(uv.user_version), 1);
    raw.close();
  } finally {
    cleanupTempDir(dir);
  }
});
