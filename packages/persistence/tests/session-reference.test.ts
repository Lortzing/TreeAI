/**
 * SessionReference 持久化测试（ADR-001 §4 数据边界）：
 * - TreeAI DB 是事实源：session 文件不存在/被删除不影响域数据；
 * - session 缺失只降级 availability（unavailable/missing-file），不级联删除；
 * - availability 是缓存评估（探针可注入），可恢复为 available；
 * - 引用三元组 + piVersion 完整往返；entryId 前进用整体替换。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { RunId } from "@treeai/contracts";
import {
  EntityNotFoundError,
  InvalidArgumentError,
  TreeRepository,
} from "../src/index.ts";
import {
  cleanupTempDir,
  dbPath,
  makeClock,
  makeIdGenerator,
  makeSessionReference,
  makeTempDir,
} from "./helpers.ts";

function makeRun(repo: TreeRepository, sessionFile?: string): RunId {
  const forest = repo.createForest();
  const tree = repo.createTree(forest.id);
  const branch = repo.createBranch(tree.id);
  const episode = repo.createEpisode(branch.id);
  const run = repo.createRun(episode.id, makeSessionReference({ sessionFile }));
  return run.id;
}

test("creating a run never requires the Pi session file to exist (TreeAI DB is the fact source)", () => {
  const dir = makeTempDir();
  try {
    const repo = TreeRepository.open({ path: dbPath(dir), now: makeClock(), generateId: makeIdGenerator("s") });
    // sessionFile 指向从未存在过的路径：创建、查询、终态流转全部正常
    const fictional = join(dir, "never-existed", "session-9999.jsonl");
    assert.equal(existsSync(fictional), false);
    const runId = makeRun(repo, fictional);
    assert.equal(repo.getRun(runId).session.sessionFile, fictional);
    repo.updateRunState(runId, "running");
    repo.updateRunState(runId, "succeeded");
    repo.close();
  } finally {
    cleanupTempDir(dir);
  }
});

test("deleting the session file degrades availability but never deletes domain data", () => {
  const dir = makeTempDir();
  try {
    const sessionFile = join(dir, "session-0001.jsonl");
    writeFileSync(sessionFile, "{}"); // 占位：真实 Pi session 内容与本层无关，持久化层不读取

    const repo = TreeRepository.open({ path: dbPath(dir), now: makeClock(), generateId: makeIdGenerator("d") });
    const forest = repo.createForest();
    const tree = repo.createTree(forest.id);
    const root = repo.createBranch(tree.id);
    const second = repo.createBranch(tree.id, { parentBranchId: root.id });
    const episode = repo.createEpisode(second.id);
    const run = repo.createRun(episode.id, makeSessionReference({ sessionFile }));
    repo.updateRunState(run.id, "running");
    repo.updateRunState(run.id, "succeeded");

    // 删除 session 文件后刷新 availability（默认探针 = 仅存在性检查）
    rmSync(sessionFile);
    const sweep = repo.refreshSessionAvailability();
    assert.equal(sweep.length, 1);
    assert.equal(sweep[0]!.sessionFile, sessionFile);
    assert.equal(sweep[0]!.updatedReferences, 1);

    // 引用降级为 unavailable/missing-file
    const degraded = repo.getRun(run.id);
    assert.equal(degraded.session.availability.status, "unavailable");
    assert.equal(degraded.session.availability.status === "unavailable" && degraded.session.availability.reason, "missing-file");
    // 引用三元组与 piVersion 完整保留
    assert.equal(degraded.session.sessionId, "pi-session-0001");
    assert.equal(degraded.session.entryId, "entry-0001");
    assert.equal(degraded.session.piVersion, "0.85.1");

    // 域数据全部完好：不级联删除
    assert.deepEqual(repo.listForests().map((f) => f.id), [forest.id]);
    assert.deepEqual(repo.listTrees(forest.id).map((t) => t.id), [tree.id]);
    const branches = repo.listBranches(tree.id);
    assert.equal(branches.length, 2);
    assert.equal(branches[1]!.parentBranchId, root.id);
    assert.deepEqual(repo.listEpisodes(second.id).map((e) => e.id), [episode.id]);
    const runs = repo.listRuns(episode.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.state, "succeeded");

    // 降级状态持久化（重开仍在），恢复查询可拿到降级信息
    repo.close();
    const repo2 = TreeRepository.open({ path: dbPath(dir) });
    const after = repo2.getRun(run.id);
    assert.equal(after.state, "succeeded");
    assert.equal(after.session.availability.status, "unavailable");
    const recovery = repo2.getBranchRecovery(second.id);
    assert.equal(recovery.latestRun?.id, run.id);
    assert.equal(recovery.latestRun?.session.availability.status, "unavailable");
    repo2.close();
  } finally {
    cleanupTempDir(dir);
  }
});

test("markSessionFileAvailability batches per file in both directions", () => {
  const dir = makeTempDir();
  try {
    const repo = TreeRepository.open({ path: dbPath(dir), now: makeClock(), generateId: makeIdGenerator("m") });
    const forest = repo.createForest();
    const tree = repo.createTree(forest.id);
    const branch = repo.createBranch(tree.id);
    const episode1 = repo.createEpisode(branch.id);
    const episode2 = repo.createEpisode(branch.id);
    const shared = "session-store/shared-0001.jsonl";
    const other = "session-store/other-0002.jsonl";
    const runA = repo.createRun(episode1.id, makeSessionReference({ sessionFile: shared, sessionId: "s-a" }));
    const runB = repo.createRun(episode2.id, makeSessionReference({ sessionFile: shared, sessionId: "s-b" }));
    const runC = repo.createRun(episode1.id, makeSessionReference({ sessionFile: other, sessionId: "s-c" }));

    // 标记缺失：只有指向该文件的引用被更新
    const updated = repo.markSessionFileAvailability(shared, false);
    assert.equal(updated, 2);
    for (const runId of [runA.id, runB.id]) {
      const availability = repo.getRun(runId).session.availability;
      assert.equal(availability.status, "unavailable");
      if (availability.status === "unavailable") {
        assert.equal(availability.reason, "missing-file");
        assert.ok(availability.detail !== undefined);
      }
    }
    assert.equal(repo.getRun(runC.id).session.availability.status, "available");

    // getSessionReferencesByFile 能列出受影响的 run
    const refs = repo.getSessionReferencesByFile(shared);
    assert.deepEqual(refs.map((r) => r.runId).sort(), [runA.id, runB.id].sort());
    assert.equal(refs[0]!.reference.sessionFile, shared);

    // 文件恢复：回到 available
    const restored = repo.markSessionFileAvailability(shared, true);
    assert.equal(restored, 2);
    assert.equal(repo.getRun(runA.id).session.availability.status, "available");
    assert.equal(repo.getRun(runB.id).session.availability.status, "available");
    // 未涉及文件不受影响
    assert.equal(repo.getRun(runC.id).session.availability.status, "available");
    repo.close();
  } finally {
    cleanupTempDir(dir);
  }
});

test("refreshSessionAvailability uses the injected probe and never reads session content", () => {
  const dir = makeTempDir();
  try {
    const repo = TreeRepository.open({ path: dbPath(dir), now: makeClock(), generateId: makeIdGenerator("p") });
    const runId1 = makeRun(repo, "session-store/p1.jsonl");
    const runId2 = makeRun(repo, "session-store/p2.jsonl");

    // 注入探针：只做存在性判断（本测试证明持久化层不触碰文件系统）
    const probed: string[] = [];
    const sweep = repo.refreshSessionAvailability((sessionFile) => {
      probed.push(sessionFile);
      return sessionFile.endsWith("p1.jsonl");
    });
    assert.equal(sweep.length, 2);
    assert.deepEqual(probed.sort(), ["session-store/p1.jsonl", "session-store/p2.jsonl"]);
    assert.equal(repo.getRun(runId1).session.availability.status, "available");
    const degraded = repo.getRun(runId2).session.availability;
    assert.equal(degraded.status, "unavailable");
    if (degraded.status === "unavailable") assert.equal(degraded.reason, "missing-file");
    repo.close();
  } finally {
    cleanupTempDir(dir);
  }
});

test("updateRunSessionReference replaces the whole reference (entryId advance)", () => {
  const dir = makeTempDir();
  try {
    const repo = TreeRepository.open({ path: dbPath(dir), now: makeClock(), generateId: makeIdGenerator("u") });
    const runId = makeRun(repo);
    const advanced = makeSessionReference({
      sessionId: "pi-session-0001",
      sessionFile: "session-store/session-0001.jsonl",
      entryId: "entry-0042",
      piVersion: "0.86.0",
    });
    repo.updateRunSessionReference(runId, advanced);
    const run = repo.getRun(runId);
    assert.equal(run.session.entryId, "entry-0042");
    assert.equal(run.session.piVersion, "0.86.0");
    assert.equal(run.session.availability.status, "available");

    // 空 entryId / 未知 run 被拒绝
    assert.throws(
      () => repo.updateRunSessionReference(runId, { ...advanced, entryId: "" as never }),
      (e: unknown) => e instanceof InvalidArgumentError && /entryId/.test(e.message),
    );
    assert.throws(
      () => repo.updateRunSessionReference("missing" as RunId, advanced),
      EntityNotFoundError,
    );
    repo.close();
  } finally {
    cleanupTempDir(dir);
  }
});

test("updateSessionAvailability validates the unavailable reason", () => {
  const dir = makeTempDir();
  try {
    const repo = TreeRepository.open({ path: dbPath(dir), now: makeClock(), generateId: makeIdGenerator("v") });
    const runId = makeRun(repo);

    repo.updateSessionAvailability(runId, { status: "unavailable", reason: "version-mismatch" });
    const degraded = repo.getRun(runId).session.availability;
    assert.equal(degraded.status, "unavailable");
    if (degraded.status === "unavailable") assert.equal(degraded.reason, "version-mismatch");

    assert.throws(
      () => repo.updateSessionAvailability(runId, { status: "unavailable", reason: "made-up" as never }),
      (e: unknown) => e instanceof InvalidArgumentError && /reason/.test(e.message),
    );
    assert.throws(
      () => repo.updateSessionAvailability("missing" as RunId, { status: "available" }),
      EntityNotFoundError,
    );
    // 回到 available
    repo.updateSessionAvailability(runId, { status: "available" });
    assert.equal(repo.getRun(runId).session.availability.status, "available");
    repo.close();
  } finally {
    cleanupTempDir(dir);
  }
});
