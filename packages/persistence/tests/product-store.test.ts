/**
 * D3 产品层存储测试：product migrations（turns / branch_origins / active navigation）、
 * Turn 判别式校验、BranchOrigin 锚点完整性、return 送达标记、
 * 跨重开持久化。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { BranchId, TurnId } from "@treeai/contracts";
import {
  EntityNotFoundError,
  InvalidArgumentError,
  LATEST_SCHEMA_VERSION,
  TreeRepository,
} from "../src/index.ts";
import { cleanupTempDir, dbPath, makeClock, makeIdGenerator, makeSessionReference, makeTempDir } from "./helpers.ts";

interface Domain {
  readonly treeId: ReturnType<TreeRepository["createTree"]>["id"];
  readonly rootBranchId: BranchId;
  readonly secondBranchId: BranchId;
  readonly episodeId: ReturnType<TreeRepository["createEpisode"]>["id"];
  readonly runId: ReturnType<TreeRepository["createRun"]>["id"];
}

function setupDomainWithRun(repo: TreeRepository): Domain {
  const forest = repo.createForest();
  const tree = repo.createTree(forest.id);
  const root = repo.createBranch(tree.id);
  const second = repo.createBranch(tree.id, { parentBranchId: root.id });
  const episode = repo.createEpisode(root.id);
  const run = repo.createRun(episode.id, makeSessionReference());
  return { treeId: tree.id, rootBranchId: root.id, secondBranchId: second.id, episodeId: episode.id, runId: run.id };
}

test("migrations bring a fresh database to the current product schema", () => {
  const dir = makeTempDir();
  try {
    const path = dbPath(dir);
    const repo = TreeRepository.open({ path });
    assert.equal(repo.schemaVersion, LATEST_SCHEMA_VERSION);
    assert.ok(LATEST_SCHEMA_VERSION >= 2, "product-state migration must be registered");
    repo.close();

    const raw = new DatabaseSync(path);
    const tables = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('turns', 'branch_origins', 'tree_active_navigation')")
      .all() as Array<{ name: string }>;
    assert.deepEqual(
      tables.map((t) => t.name).sort(),
      ["branch_origins", "tree_active_navigation", "turns"],
      "product migrations must create the product and navigation tables",
    );
    const versions = raw.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{
      version: number;
    }>;
    assert.deepEqual(
      versions.map((v) => Number(v.version)),
      [1, 2, 3],
      "all product migrations must be registered on a fresh database",
    );
    raw.close();
  } finally {
    cleanupTempDir(dir);
  }
});

test("an existing v1 database is upgraded in place to the current schema without data loss", () => {
  const dir = makeTempDir();
  try {
    const path = dbPath(dir);
    const repo1 = TreeRepository.open({ path });
    const ids = setupDomainWithRun(repo1);
    const before = repo1.listBranches(ids.treeId).length;
    repo1.close();

    const repo2 = TreeRepository.open({ path });
    assert.equal(repo2.schemaVersion, LATEST_SCHEMA_VERSION);
    assert.equal(repo2.listBranches(ids.treeId).length, before, "v1 domain data must survive the upgrade");
    const episode = repo2.createEpisode(ids.rootBranchId);
    const run = repo2.createRun(episode.id, makeSessionReference());
    const turn = repo2.createTurn({
      treeId: ids.treeId,
      branchId: ids.rootBranchId,
      episodeId: episode.id,
      runId: run.id,
      role: "user",
      text: "hello after upgrade",
    });
    assert.equal(turn.text, "hello after upgrade");
    repo2.close();
  } finally {
    cleanupTempDir(dir);
  }
});

test("turns round-trip and list in append order; roles are discriminated", () => {
  const dir = makeTempDir();
  try {
    const repo = TreeRepository.open({ path: dbPath(dir), now: makeClock(), generateId: makeIdGenerator("t") });
    const ids = setupDomainWithRun(repo);

    const userTurn = repo.createTurn({
      treeId: ids.treeId,
      branchId: ids.rootBranchId,
      episodeId: ids.episodeId,
      runId: ids.runId,
      role: "user",
      text: "what is a tree?",
    });
    const assistantTurn = repo.createTurn({
      treeId: ids.treeId,
      branchId: ids.rootBranchId,
      episodeId: ids.episodeId,
      runId: ids.runId,
      role: "assistant",
      text: "a tree is a connected acyclic graph",
      piEntryId: "entry-0009",
    });

    assert.equal(userTurn.role, "user");
    assert.equal(userTurn.piEntryId, null);
    assert.equal(userTurn.fromBranchId, null);
    assert.equal(userTurn.runId, ids.runId);
    assert.equal(assistantTurn.piEntryId, "entry-0009");

    const turns = repo.listTurns(ids.rootBranchId);
    assert.deepEqual(
      turns.map((t) => t.role),
      ["user", "assistant"],
      "turns list in append order (created_at, rowid)",
    );
    assert.deepEqual(repo.listTurns(ids.secondBranchId), [], "other branches see no turns");

    const found = repo.findTurn(userTurn.id);
    assert.ok(found !== null);
    assert.equal(found.text, "what is a tree?");
    assert.throws(() => repo.getTurn("turn-does-not-exist" as TurnId), EntityNotFoundError);
    repo.close();
  } finally {
    cleanupTempDir(dir);
  }
});

test("turn role invariants are rejected with InvalidArgumentError", () => {
  const dir = makeTempDir();
  try {
    const repo = TreeRepository.open({ path: dbPath(dir), now: makeClock(), generateId: makeIdGenerator("t") });
    const ids = setupDomainWithRun(repo);

    // user/assistant turns must reference a run
    assert.throws(
      () =>
        repo.createTurn({
          treeId: ids.treeId,
          branchId: ids.rootBranchId,
          episodeId: ids.episodeId,
          runId: null,
          role: "user",
          text: "orphan",
        }),
      InvalidArgumentError,
    );
    // return turns must NOT reference a run and must name the source branch
    assert.throws(
      () =>
        repo.createTurn({
          treeId: ids.treeId,
          branchId: ids.rootBranchId,
          episodeId: ids.episodeId,
          runId: ids.runId,
          role: "return",
          text: "illegal",
        }),
      InvalidArgumentError,
    );
    assert.throws(
      () =>
        repo.createTurn({
          treeId: ids.treeId,
          branchId: ids.rootBranchId,
          episodeId: ids.episodeId,
          role: "return",
          text: "no source branch",
        }),
      InvalidArgumentError,
    );
    // episode must belong to the branch
    const otherEpisode = repo.createEpisode(ids.secondBranchId);
    assert.throws(
      () =>
        repo.createTurn({
          treeId: ids.treeId,
          branchId: ids.rootBranchId,
          episodeId: otherEpisode.id,
          runId: ids.runId,
          role: "user",
          text: "cross-branch episode",
        }),
      InvalidArgumentError,
    );
    // empty user text is rejected (assistant may be empty, e.g. aborted runs)
    assert.throws(
      () =>
        repo.createTurn({
          treeId: ids.treeId,
          branchId: ids.rootBranchId,
          episodeId: ids.episodeId,
          runId: ids.runId,
          role: "user",
          text: "   ",
        }),
      InvalidArgumentError,
    );
    // nothing was written
    assert.equal(repo.listTurns(ids.rootBranchId).length, 0);
    repo.close();
  } finally {
    cleanupTempDir(dir);
  }
});

test("return turns persist provenance and delivery state", () => {
  const dir = makeTempDir();
  try {
    const repo = TreeRepository.open({ path: dbPath(dir), now: makeClock(), generateId: makeIdGenerator("t") });
    const ids = setupDomainWithRun(repo);

    const trunkEpisode = repo.createEpisode(ids.rootBranchId);
    const returnTurn = repo.createTurn({
      treeId: ids.treeId,
      branchId: ids.rootBranchId,
      episodeId: trunkEpisode.id,
      role: "return",
      text: "branch conclusion: use a spanning tree",
      fromBranchId: ids.secondBranchId,
    });
    assert.equal(returnTurn.runId, null);
    assert.equal(returnTurn.fromBranchId, ids.secondBranchId);
    assert.equal(returnTurn.deliveredRunId, null);

    // delivery is marked once, onto an existing run
    repo.markReturnDelivered(returnTurn.id, ids.runId);
    const delivered = repo.getTurn(returnTurn.id);
    assert.equal(delivered.deliveredRunId, ids.runId);

    // double delivery is rejected
    assert.throws(() => repo.markReturnDelivered(returnTurn.id, ids.runId), InvalidArgumentError);
    // non-return turns cannot be marked delivered
    const plainTurn = repo.createTurn({
      treeId: ids.treeId,
      branchId: ids.rootBranchId,
      episodeId: ids.episodeId,
      runId: ids.runId,
      role: "user",
      text: "plain question",
    });
    assert.throws(() => repo.markReturnDelivered(plainTurn.id, ids.runId), InvalidArgumentError);
    // unknown turn / run ids are rejected
    assert.throws(() => repo.markReturnDelivered("turn-missing" as TurnId, ids.runId), EntityNotFoundError);
    assert.throws(() => repo.markReturnDelivered(returnTurn.id, "run-missing" as never), EntityNotFoundError);
    repo.close();
  } finally {
    cleanupTempDir(dir);
  }
});

function deleliveredNonexistent(repo: TreeRepository): TurnId {
  // a non-return turn cannot be marked delivered
  const ids = setupDomainWithRun(repo);
  const turn = repo.createTurn({
    treeId: ids.treeId,
    branchId: ids.rootBranchId,
    episodeId: ids.episodeId,
    runId: ids.runId,
    role: "user",
    text: "plain question",
  });
  return turn.id;
}

test("branch origins enforce anchor integrity (slice match, assistant role, entry id match)", () => {
  const dir = makeTempDir();
  try {
    const repo = TreeRepository.open({ path: dbPath(dir), now: makeClock(), generateId: makeIdGenerator("t") });
    const ids = setupDomainWithRun(repo);

    const assistantTurn = repo.createTurn({
      treeId: ids.treeId,
      branchId: ids.rootBranchId,
      episodeId: ids.episodeId,
      runId: ids.runId,
      role: "assistant",
      text: "an anchor lives on an answer",
      piEntryId: "entry-0042",
    });

    const origin = repo.setBranchOrigin({
      branchId: ids.secondBranchId,
      sourceBranchId: ids.rootBranchId,
      anchorTurnId: assistantTurn.id,
      anchorEntryId: "entry-0042",
      selection: { start: 3, end: 9, text: "anchor" },
    });
    assert.equal(origin.branchId, ids.secondBranchId);
    assert.equal(origin.anchorTurnId, assistantTurn.id);
    assert.deepEqual(origin.selection, { start: 3, end: 9, text: "anchor" });

    // a third branch: mismatched selection text is rejected
    const third = repo.createBranch(ids.treeId, { parentBranchId: ids.rootBranchId });
    assert.throws(
      () =>
        repo.setBranchOrigin({
          branchId: third.id,
          sourceBranchId: ids.rootBranchId,
          anchorTurnId: assistantTurn.id,
          anchorEntryId: "entry-0042",
          selection: { start: 0, end: 8, text: "WRONG!!" },
        }),
      InvalidArgumentError,
    );
    // out-of-bounds offsets are rejected
    assert.throws(
      () =>
        repo.setBranchOrigin({
          branchId: third.id,
          sourceBranchId: ids.rootBranchId,
          anchorTurnId: assistantTurn.id,
          anchorEntryId: "entry-0042",
          selection: { start: 0, end: 999, text: "an anchor lives on an answer and more" },
        }),
      InvalidArgumentError,
    );
    // anchorEntryId must equal the turn's piEntryId
    assert.throws(
      () =>
        repo.setBranchOrigin({
          branchId: third.id,
          sourceBranchId: ids.rootBranchId,
          anchorTurnId: assistantTurn.id,
          anchorEntryId: "entry-9999",
          selection: { start: 0, end: 2, text: "an" },
        }),
      InvalidArgumentError,
    );
    // user turns cannot anchor a branch
    const userTurn = repo.createTurn({
      treeId: ids.treeId,
      branchId: ids.rootBranchId,
      episodeId: ids.episodeId,
      runId: ids.runId,
      role: "user",
      text: "question",
    });
    assert.throws(
      () =>
        repo.setBranchOrigin({
          branchId: third.id,
          sourceBranchId: ids.rootBranchId,
          anchorTurnId: userTurn.id,
          anchorEntryId: "",
          selection: { start: 0, end: 0, text: "" },
        }),
      InvalidArgumentError,
    );
    // one origin per branch
    assert.throws(
      () =>
        repo.setBranchOrigin({
          branchId: ids.secondBranchId,
          sourceBranchId: ids.rootBranchId,
          anchorTurnId: assistantTurn.id,
          anchorEntryId: "entry-0042",
          selection: { start: 0, end: 2, text: "an" },
        }),
      InvalidArgumentError,
    );
    // nothing partial was written for the third branch
    assert.equal(repo.findBranchOrigin(third.id), null);
    repo.close();
  } finally {
    cleanupTempDir(dir);
  }
});

test("product state survives repository reopen (fact-source persistence)", () => {
  const dir = makeTempDir();
  try {
    const path = dbPath(dir);
    const repo = TreeRepository.open({ path, now: makeClock(), generateId: makeIdGenerator("t") });
    const ids = setupDomainWithRun(repo);
    const assistantTurn = repo.createTurn({
      treeId: ids.treeId,
      branchId: ids.rootBranchId,
      episodeId: ids.episodeId,
      runId: ids.runId,
      role: "assistant",
      text: "persisted answer",
      piEntryId: "entry-0007",
    });
    repo.setBranchOrigin({
      branchId: ids.secondBranchId,
      sourceBranchId: ids.rootBranchId,
      anchorTurnId: assistantTurn.id,
      anchorEntryId: "entry-0007",
      selection: { start: 0, end: 9, text: "persisted" },
    });
    repo.saveActiveNavigation(ids.treeId, ids.secondBranchId, makeSessionReference());
    repo.close();

    const repo2 = TreeRepository.open({ path });
    const turns = repo2.listTurns(ids.rootBranchId);
    assert.equal(turns.length, 1);
    assert.equal(turns[0]!.text, "persisted answer");
    const origin = repo2.findBranchOrigin(ids.secondBranchId);
    assert.ok(origin !== null);
    assert.equal(origin.selection.text, "persisted");
    assert.equal(origin.anchorEntryId, "entry-0007");
    const active = repo2.findActiveNavigation(ids.treeId);
    assert.ok(active !== null);
    assert.equal(active.branchId, ids.secondBranchId);
    assert.equal(active.reference.entryId, "entry-0001");
    repo2.close();
  } finally {
    cleanupTempDir(dir);
  }
});
