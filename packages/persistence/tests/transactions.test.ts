/**
 * 事务测试（任务书要求：事务中途失败回滚）：
 * - 顶层事务中途抛错 → 全部回滚（含 createRun 的嵌套 savepoint）；
 * - 嵌套 savepoint：内层失败被捕获 → 只回滚内层，外层提交；
 * - 嵌套失败未被捕获 → 外层一并回滚；
 * - 回滚真正落盘（重开后仍干净）；
 * - 关闭后的仓储 → RepositoryClosedError。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { RepositoryClosedError, TreeRepository } from "../src/index.ts";
import { cleanupTempDir, dbPath, makeClock, makeIdGenerator, makeSessionReference, makeTempDir } from "./helpers.ts";

test("mid-transaction failure rolls back every write in the transaction", () => {
  const dir = makeTempDir();
  try {
    const path = dbPath(dir);
    const repo = TreeRepository.open({ path, now: makeClock(), generateId: makeIdGenerator("tx") });

    assert.throws(
      () =>
        repo.transaction(() => {
          const forest = repo.createForest();
          const tree = repo.createTree(forest.id);
          const branch = repo.createBranch(tree.id);
          const episode = repo.createEpisode(branch.id);
          repo.createRun(episode.id, makeSessionReference()); // 自带嵌套 savepoint
          throw new Error("boom mid-transaction");
        }),
      /boom mid-transaction/,
    );

    // 内存视图：一个实体都不剩
    assert.deepEqual(repo.listForests(), []);
    // 状态机写入同样回滚：外层失败时 queued→running 不残留
    const forest = repo.createForest();
    const tree = repo.createTree(forest.id);
    const branch = repo.createBranch(tree.id);
    const episode = repo.createEpisode(branch.id);
    const run = repo.createRun(episode.id, makeSessionReference());
    assert.throws(
      () =>
        repo.transaction(() => {
          repo.updateRunState(run.id, "running");
          throw new Error("boom after transition");
        }),
      /boom after transition/,
    );
    assert.equal(repo.getRun(run.id).state, "queued");
    repo.close();

    // 落盘视图：重开后仍然干净（回滚持久生效，非仅内存）
    const repo2 = TreeRepository.open({ path });
    assert.deepEqual(repo2.listForests().map((f) => f.id), [forest.id]);
    assert.equal(repo2.getRun(run.id).state, "queued");
    repo2.close();
  } finally {
    cleanupTempDir(dir);
  }
});

test("nested savepoint: inner failure caught by caller rolls back only the inner scope", () => {
  const repo = TreeRepository.open({ path: ":memory:", now: makeClock(), generateId: makeIdGenerator("sp") });

  const kept = repo.transaction(() => {
    const outer = repo.createForest();
    try {
      repo.transaction(() => {
        repo.createForest(); // 内层写入
        throw new Error("inner boom");
      });
    } catch (error) {
      assert.ok(error instanceof Error && /inner boom/.test(error.message));
    }
    // 内层回滚后外层继续写
    const after = repo.createForest();
    return [outer, after];
  });

  // 外层两条都在；内层那条不存在
  const forests = repo.listForests();
  assert.equal(forests.length, 2);
  assert.deepEqual(forests.map((f) => f.id).sort(), kept.map((f) => f.id).sort());
  repo.close();
});

test("nested failure that propagates rolls back the outer transaction too", () => {
  const repo = TreeRepository.open({ path: ":memory:", now: makeClock(), generateId: makeIdGenerator("np") });

  assert.throws(
    () =>
      repo.transaction(() => {
        repo.createForest();
        repo.transaction(() => {
          repo.createForest();
          throw new Error("uncaught inner");
        });
      }),
    /uncaught inner/,
  );
  assert.deepEqual(repo.listForests(), []);
  // 仓储仍可用（事务状态已复位）
  const forest = repo.createForest();
  assert.equal(repo.listForests().length, 1);
  assert.ok(forest.id.length > 0);
  repo.close();
});

test("closed repository rejects operations and close is idempotent", () => {
  const repo = TreeRepository.open({ path: ":memory:" });
  repo.close();
  assert.equal(repo.isClosed(), true);
  repo.close(); // 幂等
  assert.equal(repo.isClosed(), true);

  assert.throws(() => repo.listForests(), RepositoryClosedError);
  assert.throws(() => repo.createForest(), RepositoryClosedError);
  assert.throws(() => repo.transaction(() => 1), RepositoryClosedError);
  assert.throws(() => repo.listNonTerminalRuns(), RepositoryClosedError);
  assert.throws(() => repo.refreshSessionAvailability(), RepositoryClosedError);
  assert.throws(() => repo.createBackup("/tmp/should-not-be-created.db"), RepositoryClosedError);
});
