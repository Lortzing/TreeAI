/**
 * 领域 CRUD 与双分支关系测试：创建 forest/tree/branch/episode/run、
 * 跨进程（重开）持久化、引用完整性校验。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { BranchId, ForestId, TreeId } from "@treeai/contracts";
import {
  EntityNotFoundError,
  InvalidArgumentError,
  TreeRepository,
} from "../src/index.ts";
import { cleanupTempDir, dbPath, makeClock, makeIdGenerator, makeSessionReference, makeTempDir } from "./helpers.ts";

function setupDomain(repo: TreeRepository): {
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

test("creates the full hierarchy and persists dual-branch relationship across reopen", () => {
  const dir = makeTempDir();
  try {
    const path = dbPath(dir);
    const repo = TreeRepository.open({ path, now: makeClock(), generateId: makeIdGenerator("id") });

    const ids = setupDomain(repo);
    const episode1 = repo.createEpisode(ids.rootBranchId);
    const episode2 = repo.createEpisode(ids.secondBranchId);
    const run1 = repo.createRun(episode1.id, makeSessionReference({ sessionFile: "session-store/a.jsonl" }));
    const run2 = repo.createRun(episode2.id, makeSessionReference({ sessionFile: "session-store/b.jsonl" }));

    // 初始态：run 创建即 queued（I1）
    assert.equal(run1.state, "queued");
    assert.equal(run1.terminalAt, null);
    assert.equal(run1.failure, undefined);

    repo.close();

    // 重开：全部域数据与关系仍在（TreeAI DB 是事实源）
    const repo2 = TreeRepository.open({ path });
    const branches = repo2.listBranches(ids.treeId);
    assert.equal(branches.length, 2);
    const rootAfter = repo2.getBranch(ids.rootBranchId);
    const secondAfter = repo2.getBranch(ids.secondBranchId);
    assert.equal(rootAfter.parentBranchId, null);
    assert.equal(secondAfter.parentBranchId, ids.rootBranchId);
    assert.equal(secondAfter.treeId, ids.treeId);

    assert.deepEqual(repo2.listEpisodes(ids.rootBranchId).map((e) => e.id), [episode1.id]);
    assert.deepEqual(repo2.listEpisodes(ids.secondBranchId).map((e) => e.id), [episode2.id]);

    const runs1 = repo2.listRuns(episode1.id);
    assert.deepEqual(runs1.map((r) => r.id), [run1.id]);
    assert.equal(runs1[0]!.state, "queued");
    assert.equal(runs1[0]!.session.sessionFile, "session-store/a.jsonl");
    assert.equal(runs1[0]!.session.piVersion, "0.85.1");
    assert.deepEqual(repo2.listRuns(episode2.id).map((r) => r.id), [run2.id]);

    assert.deepEqual(repo2.listTrees(ids.forestId).map((t) => t.id), [ids.treeId]);
    assert.deepEqual(repo2.listForests().map((f) => f.id), [ids.forestId]);
    repo2.close();
  } finally {
    cleanupTempDir(dir);
  }
});

test("branch parent validation: missing tree/parent, cross-tree parent, self-parent", () => {
  const repo = TreeRepository.open({ path: ":memory:" });
  const forest = repo.createForest();
  const tree1 = repo.createTree(forest.id);
  const tree2 = repo.createTree(forest.id);
  const branchInTree1 = repo.createBranch(tree1.id);

  assert.throws(() => repo.createBranch("no-such-tree" as TreeId), (e: unknown) => e instanceof EntityNotFoundError);
  assert.throws(
    () => repo.createBranch(tree2.id, { parentBranchId: branchInTree1.id }),
    (e: unknown) => e instanceof InvalidArgumentError && /belongs to tree/.test(e.message),
  );
  assert.throws(
    () => repo.createBranch(tree1.id, { parentBranchId: "no-such-branch" as BranchId }),
    EntityNotFoundError,
  );
  const selfId = branchInTree1.id;
  assert.throws(
    () => repo.createBranch(tree1.id, { id: selfId, parentBranchId: selfId }),
    (e: unknown) => e instanceof InvalidArgumentError && /own parent/.test(e.message),
  );
  // 正常路径不受影响：tree2 的根分支与子分支
  const root2 = repo.createBranch(tree2.id);
  const child2 = repo.createBranch(tree2.id, { parentBranchId: root2.id });
  assert.equal(child2.parentBranchId, root2.id);
  repo.close();
});

test("tree/episode/run parent validation", () => {
  const repo = TreeRepository.open({ path: ":memory:" });
  const forest = repo.createForest();
  const tree = repo.createTree(forest.id);
  const branch = repo.createBranch(tree.id);

  assert.throws(
    () => repo.createTree("no-such-forest" as ForestId),
    (e: unknown) => e instanceof EntityNotFoundError && /forest/.test(e.message),
  );
  assert.throws(() => repo.createEpisode("no-such-branch" as BranchId), EntityNotFoundError);
  assert.throws(
    () => repo.createRun("no-such-episode" as never, makeSessionReference()),
    (e: unknown) => e instanceof EntityNotFoundError && /episode/.test(e.message),
  );
  repo.close();
});

test("duplicate entity ids are rejected as constraint violations without partial state", () => {
  const repo = TreeRepository.open({
    path: ":memory:",
    generateId: makeIdGenerator("dup"),
  });
  const forest = repo.createForest(); // forest_... id 生成于 createForest 内部
  const explicitId = "tree-explicit-1" as TreeId;
  repo.createTree(forest.id, { id: explicitId });
  assert.throws(
    () => repo.createTree(forest.id, { id: explicitId }),
    (e: unknown) => e instanceof Error && /unique|UNIQUE/i.test(e.message),
  );
  // 显式 id 与生成 id 不冲突
  const tree2 = repo.createTree(forest.id);
  assert.notEqual(tree2.id, explicitId);
  repo.close();
});

test("run creation with explicit duplicate id leaves no partial rows", () => {
  const repo = TreeRepository.open({
    path: ":memory:",
    now: makeClock(),
    generateId: makeIdGenerator("gen"),
  });
  const forest = repo.createForest();
  const tree = repo.createTree(forest.id);
  const branch = repo.createBranch(tree.id);
  const episode = repo.createEpisode(branch.id);
  const runId = "run-fixed-1" as never;
  const first = repo.createRun(episode.id, makeSessionReference(), { id: runId });
  assert.equal(first.id, "run-fixed-1");
  assert.throws(
    () => repo.createRun(episode.id, makeSessionReference(), { id: runId }),
    (e: unknown) => e instanceof Error && /unique|UNIQUE/i.test(e.message),
  );
  // 只有一行 run
  assert.equal(repo.listRuns(episode.id).length, 1);
  repo.close();
});

test("session reference validation rejects empty reference fields", () => {
  const repo = TreeRepository.open({ path: ":memory:" });
  const forest = repo.createForest();
  const tree = repo.createTree(forest.id);
  const branch = repo.createBranch(tree.id);
  const episode = repo.createEpisode(branch.id);

  const bad = makeSessionReference();
  assert.throws(
    () => repo.createRun(episode.id, { ...bad, sessionId: "" as never }),
    (e: unknown) => e instanceof InvalidArgumentError && /sessionId/.test(e.message),
  );
  assert.throws(
    () => repo.createRun(episode.id, { ...bad, sessionFile: "  " }),
    (e: unknown) => e instanceof InvalidArgumentError && /sessionFile/.test(e.message),
  );
  assert.throws(
    () => repo.createRun(episode.id, { ...bad, entryId: "" as never }),
    (e: unknown) => e instanceof InvalidArgumentError && /entryId/.test(e.message),
  );
  assert.throws(
    () => repo.createRun(episode.id, { ...bad, piVersion: "" as never }),
    (e: unknown) => e instanceof InvalidArgumentError && /piVersion/.test(e.message),
  );
  assert.equal(repo.listRuns(episode.id).length, 0);
  repo.close();
});

test("get/find semantics: EntityNotFoundError vs null", () => {
  const repo = TreeRepository.open({ path: ":memory:" });
  assert.equal(repo.findForest("missing" as ForestId), null);
  assert.throws(() => repo.getForest("missing" as ForestId), EntityNotFoundError);
  assert.equal(repo.findTree("missing" as TreeId), null);
  assert.equal(repo.findBranch("missing" as BranchId), null);
  assert.equal(repo.findEpisode("missing" as never), null);
  assert.equal(repo.findRun("missing" as never), null);
  assert.throws(() => repo.getRun("missing" as never), EntityNotFoundError);
  repo.close();
});
