/**
 * 恢复查询与 I6 重启恢复测试：
 * - getBranchRecovery / getTreeRecovery 的完整形状（含双分支）；
 * - 恢复信息携带最新 run 的 session 引用与 availability（降级可见）；
 * - listNonTerminalRuns / failNonTerminalRuns 清扫（幂等、不碰已终态 run）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { BranchId, ForestId, TreeId } from "@treeai/contracts";
import { EntityNotFoundError, TreeRepository } from "../src/index.ts";
import {
  cleanupTempDir,
  dbPath,
  hostInterruptedFailure,
  makeClock,
  makeIdGenerator,
  makeSessionReference,
  makeTempDir,
  modelFailure,
} from "./helpers.ts";

function setupDualBranchTree(repo: TreeRepository): {
  forestId: ForestId;
  treeId: TreeId;
  rootBranchId: BranchId;
  secondBranchId: BranchId;
} {
  const forest = repo.createForest();
  const tree = repo.createTree(forest.id);
  const root = repo.createBranch(tree.id);
  const second = repo.createBranch(tree.id, { parentBranchId: root.id });
  return { forestId: forest.id, treeId: tree.id, rootBranchId: root.id, secondBranchId: second.id };
}

test("getBranchRecovery returns the full context for a dual-branch tree", () => {
  const dir = makeTempDir();
  try {
    const repo = TreeRepository.open({ path: dbPath(dir), now: makeClock(), generateId: makeIdGenerator("r") });
    const ids = setupDualBranchTree(repo);

    // root 分支：一个 episode，两个 run（failed → succeeded）
    const rootEpisode = repo.createEpisode(ids.rootBranchId);
    const run1 = repo.createRun(rootEpisode.id, makeSessionReference({ sessionFile: "session-store/r1.jsonl" }));
    repo.updateRunState(run1.id, "running");
    repo.updateRunState(run1.id, "failed", { failure: modelFailure() });
    const run2 = repo.createRun(rootEpisode.id, makeSessionReference({ sessionFile: "session-store/r2.jsonl" }));
    repo.updateRunState(run2.id, "running");
    repo.updateRunState(run2.id, "succeeded");

    // second 分支：一个 episode，一个 queued run
    const secondEpisode = repo.createEpisode(ids.secondBranchId);
    const run3 = repo.createRun(secondEpisode.id, makeSessionReference({ sessionFile: "session-store/r3.jsonl" }));

    const rootRecovery = repo.getBranchRecovery(ids.rootBranchId);
    assert.equal(rootRecovery.forest.id, ids.forestId);
    assert.equal(rootRecovery.tree.id, ids.treeId);
    assert.equal(rootRecovery.branch.id, ids.rootBranchId);
    assert.equal(rootRecovery.branch.parentBranchId, null);
    assert.equal(rootRecovery.parentBranch, null);
    assert.equal(rootRecovery.episodes.length, 1);
    const episodeRecovery = rootRecovery.episodes[0]!;
    assert.equal(episodeRecovery.episode.id, rootEpisode.id);
    assert.deepEqual(episodeRecovery.runs.map((r) => r.id), [run1.id, run2.id]);
    assert.equal(episodeRecovery.latestRun?.id, run2.id);
    assert.equal(rootRecovery.latestRun?.id, run2.id);
    assert.equal(rootRecovery.latestRun?.state, "succeeded");
    assert.equal(rootRecovery.latestRun?.session.sessionFile, "session-store/r2.jsonl");

    const secondRecovery = repo.getBranchRecovery(ids.secondBranchId);
    assert.equal(secondRecovery.branch.parentBranchId, ids.rootBranchId);
    assert.equal(secondRecovery.parentBranch?.id, ids.rootBranchId);
    assert.equal(secondRecovery.latestRun?.id, run3.id);
    assert.equal(secondRecovery.latestRun?.state, "queued");
    repo.close();
  } finally {
    cleanupTempDir(dir);
  }
});

test("recovery info surfaces degraded session availability for the latest run", () => {
  const repo = TreeRepository.open({ path: ":memory:", now: makeClock(), generateId: makeIdGenerator("deg") });
  const ids = setupDualBranchTree(repo);
  const episode = repo.createEpisode(ids.secondBranchId);
  const reference = makeSessionReference();
  const run = repo.createRun(episode.id, reference);
  repo.updateRunState(run.id, "running");

  repo.markSessionFileAvailability(reference.sessionFile, false);

  const recovery = repo.getBranchRecovery(ids.secondBranchId);
  const availability = recovery.latestRun?.session.availability;
  assert.equal(availability?.status, "unavailable");
  if (availability?.status === "unavailable") assert.equal(availability.reason, "missing-file");
  repo.close();
});

test("getTreeRecovery covers every branch of the tree", () => {
  const repo = TreeRepository.open({ path: ":memory:", now: makeClock(), generateId: makeIdGenerator("tr") });
  const ids = setupDualBranchTree(repo);
  // 再派生一条二级分支
  const grandchild = repo.createBranch(ids.treeId, { parentBranchId: ids.secondBranchId });

  const treeRecovery = repo.getTreeRecovery(ids.treeId);
  assert.equal(treeRecovery.forest.id, ids.forestId);
  assert.equal(treeRecovery.tree.id, ids.treeId);
  assert.deepEqual(
    treeRecovery.branches.map((b) => b.branch.id),
    [ids.rootBranchId, ids.secondBranchId, grandchild.id],
  );
  const second = treeRecovery.branches[1]!;
  assert.equal(second.parentBranch?.id, ids.rootBranchId);
  const third = treeRecovery.branches[2]!;
  assert.equal(third.parentBranch?.id, ids.secondBranchId);

  assert.throws(() => repo.getTreeRecovery("missing" as TreeId), EntityNotFoundError);
  assert.throws(() => repo.getBranchRecovery("missing" as BranchId), EntityNotFoundError);
  repo.close();
});

test("empty branch recovery has no episodes and null latest run", () => {
  const repo = TreeRepository.open({ path: ":memory:" });
  const ids = setupDualBranchTree(repo);
  const recovery = repo.getBranchRecovery(ids.rootBranchId);
  assert.deepEqual(recovery.episodes, []);
  assert.equal(recovery.latestRun, null);
  repo.close();
});

test("failNonTerminalRuns sweeps I6 recovery: non-terminal to failed, idempotent, terminals untouched", () => {
  const dir = makeTempDir();
  try {
    const path = dbPath(dir);
    const repo = TreeRepository.open({ path, now: makeClock(), generateId: makeIdGenerator("i6") });
    const ids = setupDualBranchTree(repo);
    const episode = repo.createEpisode(ids.rootBranchId);

    // queued / running / aborting 各一个 + 两个已终态
    const queued = repo.createRun(episode.id, makeSessionReference({ sessionId: "q" }));
    const runningRun = repo.createRun(episode.id, makeSessionReference({ sessionId: "r" }));
    repo.updateRunState(runningRun.id, "running");
    const abortingRun = repo.createRun(episode.id, makeSessionReference({ sessionId: "a" }));
    repo.updateRunState(abortingRun.id, "running");
    repo.updateRunState(abortingRun.id, "aborting");
    const succeededRun = repo.createRun(episode.id, makeSessionReference({ sessionId: "s" }));
    repo.updateRunState(succeededRun.id, "running");
    const succeededAt = repo.updateRunState(succeededRun.id, "succeeded").terminalAt;
    const failedRun = repo.createRun(episode.id, makeSessionReference({ sessionId: "f" }));
    repo.updateRunState(failedRun.id, "running");
    const failedAt = repo.updateRunState(failedRun.id, "failed", { failure: modelFailure() }).terminalAt;

    // 清扫前：3 个非终态
    assert.equal(repo.listNonTerminalRuns().length, 3);

    const swept = repo.failNonTerminalRuns(hostInterruptedFailure());
    assert.deepEqual(
      swept.map((r) => r.id).sort(),
      [queued.id, runningRun.id, abortingRun.id].sort(),
    );
    for (const run of swept) {
      assert.equal(run.state, "failed");
      assert.notEqual(run.terminalAt, null);
      assert.equal(run.failure?.code, "unknown");
      assert.deepEqual(run.failure?.details, { hostInterrupted: true });
    }

    // 已终态的 run 完全不受影响
    assert.equal(repo.getRun(succeededRun.id).state, "succeeded");
    assert.equal(repo.getRun(succeededRun.id).terminalAt, succeededAt);
    assert.equal(repo.getRun(failedRun.id).state, "failed");
    assert.equal(repo.getRun(failedRun.id).terminalAt, failedAt);
    assert.equal(repo.getRun(failedRun.id).failure?.code, "upstream");

    // 清扫后无非终态；重复清扫是 no-op
    assert.deepEqual(repo.listNonTerminalRuns(), []);
    assert.deepEqual(repo.failNonTerminalRuns(hostInterruptedFailure()), []);

    // 落盘后重开仍然成立
    repo.close();
    const repo2 = TreeRepository.open({ path });
    assert.deepEqual(repo2.listNonTerminalRuns(), []);
    assert.equal(repo2.getRun(queued.id).state, "failed");
    repo2.close();
  } finally {
    cleanupTempDir(dir);
  }
});
