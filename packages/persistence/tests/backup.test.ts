/**
 * 备份/恢复测试：createBackup（VACUUM INTO）→ validateBackup →
 * restoreFromBackup 全链路，含明确的失败模式（目标已存在、损坏备份、
 * 外来库备份、事务中备份、内存库恢复、integrity check）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import {
  BackupError,
  DatabaseCorruptError,
  LATEST_SCHEMA_VERSION,
  TreeRepository,
} from "../src/index.ts";
import {
  cleanupTempDir,
  dbPath,
  makeClock,
  makeIdGenerator,
  makeSessionReference,
  makeTempDir,
  modelFailure,
} from "./helpers.ts";

test("backup and restore round-trip restores the snapshot state exactly", () => {
  const dir = makeTempDir();
  try {
    const path = dbPath(dir);
    const backupPath = join(dir, "backup.db");
    const repo = TreeRepository.open({ path, now: makeClock(), generateId: makeIdGenerator("b") });

    // 备份前状态：完整层级 + 一个终态 run + 一个非终态 run
    const forest = repo.createForest();
    const tree = repo.createTree(forest.id);
    const root = repo.createBranch(tree.id);
    const second = repo.createBranch(tree.id, { parentBranchId: root.id });
    const episode = repo.createEpisode(second.id);
    const run1 = repo.createRun(episode.id, makeSessionReference());
    repo.updateRunState(run1.id, "running");
    repo.updateRunState(run1.id, "succeeded");
    const run2 = repo.createRun(episode.id, makeSessionReference({ sessionId: "before-backup" }));

    repo.createBackup(backupPath);
    const validation = TreeRepository.validateBackup(backupPath);
    assert.equal(validation.valid, true);
    assert.equal(validation.schemaVersion, LATEST_SCHEMA_VERSION);
    assert.equal(validation.integrity.ok, true);

    // 备份后继续演进：run2 终态 + 新增 run3
    repo.updateRunState(run2.id, "running");
    repo.updateRunState(run2.id, "failed", { failure: modelFailure() });
    const run3 = repo.createRun(episode.id, makeSessionReference({ sessionId: "after-backup" }));
    repo.updateRunState(run3.id, "running");

    // 恢复：回到备份快照
    repo.restoreFromBackup(backupPath);

    assert.equal(repo.isClosed(), false);
    assert.deepEqual(repo.listForests().map((f) => f.id), [forest.id]);
    assert.deepEqual(repo.listBranches(tree.id).map((b) => b.id), [root.id, second.id]);
    const runs = repo.listRuns(episode.id);
    assert.deepEqual(runs.map((r) => r.id), [run1.id, run2.id]);
    assert.equal(repo.getRun(run1.id).state, "succeeded");
    assert.equal(repo.getRun(run2.id).state, "queued", "run2 must be back to its pre-backup queued state");
    assert.equal(repo.findRun(run3.id), null, "post-backup run must be gone after restore");

    // 恢复后仓储仍可继续写入
    const run4 = repo.createRun(episode.id, makeSessionReference({ sessionId: "post-restore" }));
    assert.equal(repo.getRun(run4.id).state, "queued");
    assert.equal(repo.integrityCheck().ok, true);
    repo.close();
  } finally {
    cleanupTempDir(dir);
  }
});

test("createBackup refuses to overwrite an existing target unless asked", () => {
  const dir = makeTempDir();
  try {
    const path = dbPath(dir);
    const backupPath = join(dir, "backup.db");
    const repo = TreeRepository.open({ path, now: makeClock(), generateId: makeIdGenerator("o") });
    repo.createForest();
    repo.createBackup(backupPath);

    // 默认拒绝覆盖
    assert.throws(
      () => repo.createBackup(backupPath),
      (e: unknown) => e instanceof BackupError && /already exists/.test(e.message),
    );
    // overwrite: true 时成功（内容为新快照）
    repo.createTree(repo.listForests()[0]!.id);
    repo.createBackup(backupPath, { overwrite: true });
    const validation = TreeRepository.validateBackup(backupPath);
    assert.equal(validation.valid, true);

    // 事务中备份被拒绝（VACUUM 不能嵌套在事务里）
    assert.throws(
      () => repo.transaction(() => repo.createBackup(join(dir, "in-tx.db"))),
      (e: unknown) => e instanceof BackupError && /inside a transaction/.test(e.message),
    );
    assert.equal(existsSync(join(dir, "in-tx.db")), false);
    repo.close();
  } finally {
    cleanupTempDir(dir);
  }
});

test("restoreFromBackup can save the current database first (backupCurrentTo)", () => {
  const dir = makeTempDir();
  try {
    const path = dbPath(dir);
    const backupPath = join(dir, "backup.db");
    const currentPath = join(dir, "current-before-restore.db");
    const repo = TreeRepository.open({ path, now: makeClock(), generateId: makeIdGenerator("s") });
    const forest1 = repo.createForest();
    repo.createBackup(backupPath);

    const forest2 = repo.createForest();
    assert.equal(repo.listForests().length, 2);

    repo.restoreFromBackup(backupPath, { backupCurrentTo: currentPath });
    assert.deepEqual(repo.listForests().map((f) => f.id), [forest1.id]);

    // 被保存的当前库可以通过备份文件还原（2 个 forest）
    const saved = TreeRepository.validateBackup(currentPath);
    assert.equal(saved.valid, true);
    const savedRepo = TreeRepository.open({ path: currentPath });
    assert.equal(savedRepo.listForests().length, 2);
    assert.ok(savedRepo.findForest(forest2.id) !== null);
    savedRepo.close();
    repo.close();
  } finally {
    cleanupTempDir(dir);
  }
});

test("restore and validation fail clearly on bad backup files", () => {
  const dir = makeTempDir();
  try {
    const path = dbPath(dir);
    const repo = TreeRepository.open({ path });
    repo.createForest();

    // 垃圾文件（非 SQLite）→ DatabaseCorruptError
    const garbage = join(dir, "garbage.db");
    writeFileSync(garbage, "not a sqlite backup at all");
    assert.throws(() => TreeRepository.validateBackup(garbage), DatabaseCorruptError);
    assert.throws(() => repo.restoreFromBackup(garbage), DatabaseCorruptError);

    // 外来 SQLite 库（无 schema_migrations）→ 校验 invalid / 恢复 BackupError
    const foreign = join(dir, "foreign.db");
    const foreignDb = new DatabaseSync(foreign);
    foreignDb.exec("CREATE TABLE someone_elses (id TEXT PRIMARY KEY)");
    foreignDb.close();
    assert.equal(TreeRepository.validateBackup(foreign).valid, false);
    assert.throws(
      () => repo.restoreFromBackup(foreign),
      (e: unknown) => e instanceof BackupError && /not a valid TreeAI database/.test(e.message),
    );

    // 不存在的备份 → BackupError
    assert.throws(
      () => repo.restoreFromBackup(join(dir, "missing.db")),
      (e: unknown) => e instanceof BackupError && /does not exist|not a valid TreeAI database/.test(e.message),
    );

    // 恢复失败后原库未被破坏
    assert.equal(repo.listForests().length, 1);
    assert.equal(repo.isClosed(), false);
    repo.close();
  } finally {
    cleanupTempDir(dir);
  }
});

test("restoreFromBackup is rejected for in-memory repositories", () => {
  const dir = makeTempDir();
  try {
    const backupPath = join(dir, "backup.db");
    const fileRepo = TreeRepository.open({ path: dbPath(dir) });
    fileRepo.createForest();
    fileRepo.createBackup(backupPath);
    fileRepo.close();

    const memoryRepo = TreeRepository.open({ path: ":memory:" });
    memoryRepo.createForest();
    assert.throws(
      () => memoryRepo.restoreFromBackup(backupPath),
      (e: unknown) => e instanceof BackupError && /in-memory/.test(e.message),
    );
    assert.equal(memoryRepo.isClosed(), false);
    memoryRepo.close();
  } finally {
    cleanupTempDir(dir);
  }
});
