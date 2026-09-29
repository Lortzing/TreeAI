/**
 * D3 产品层存储测试：product migrations（turns / branch_origins / active navigation）、
 * Turn 判别式校验、BranchOrigin 锚点完整性、return 送达标记、
 * 跨重开持久化。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { BranchId, TreeId, TurnId } from "@treeai/contracts";
import {
  ConstraintViolationError,
  EntityNotFoundError,
  InvalidArgumentError,
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  TreeRepository,
  runMigrations,
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
      [1, 2, 3, 4],
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

test("return turns persist idempotency key and target anchor; keyed returns are unique", () => {
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
      text: "an anchored answer",
      piEntryId: "entry-0031",
    });
    const origin = repo.setBranchOrigin({
      branchId: ids.secondBranchId,
      sourceBranchId: ids.rootBranchId,
      anchorTurnId: assistantTurn.id,
      anchorEntryId: "entry-0031",
      selection: { start: 3, end: 11, text: "anchored" },
    });

    const trunkEpisode = repo.createEpisode(ids.rootBranchId);
    const anchorSnapshot = {
      sourceBranchId: origin.sourceBranchId,
      anchorTurnId: origin.anchorTurnId,
      anchorEntryId: origin.anchorEntryId,
      selection: origin.selection,
    };
    const keyed = repo.createTurn({
      treeId: ids.treeId,
      branchId: ids.rootBranchId,
      episodeId: trunkEpisode.id,
      role: "return",
      text: "branch conclusion with a key",
      fromBranchId: ids.secondBranchId,
      idempotencyKey: "key-0001",
      targetAnchor: anchorSnapshot,
    });
    assert.equal(keyed.idempotencyKey, "key-0001");
    assert.deepEqual(keyed.targetAnchor, anchorSnapshot);

    // 按键查找（树内定位；未知树/未知键为 null）。
    assert.equal(repo.findReturnByIdempotencyKey(ids.treeId, "key-0001")?.id, keyed.id);
    assert.equal(repo.findReturnByIdempotencyKey(ids.treeId, "key-missing"), null);
    assert.equal(repo.findReturnByIdempotencyKey("tree-missing" as TreeId, "key-0001"), null);

    // 同键第二条 return → 唯一索引判负（ConstraintViolationError）。
    const anotherEpisode = repo.createEpisode(ids.rootBranchId);
    assert.throws(
      () =>
        repo.createTurn({
          treeId: ids.treeId,
          branchId: ids.rootBranchId,
          episodeId: anotherEpisode.id,
          role: "return",
          text: "duplicate key",
          fromBranchId: ids.secondBranchId,
          idempotencyKey: "key-0001",
        }),
      ConstraintViolationError,
    );

    // 无键（历史形状）仍可落库，且多行无键 return 共存（部分唯一索引豁免 NULL）。
    const legacy = repo.createTurn({
      treeId: ids.treeId,
      branchId: ids.rootBranchId,
      episodeId: anotherEpisode.id,
      role: "return",
      text: "legacy return without a key",
      fromBranchId: ids.secondBranchId,
    });
    assert.equal(legacy.idempotencyKey, null);
    assert.equal(legacy.targetAnchor, null);

    // 非返回 turn 携带幂等键/锚点 → 拒绝；return 携带空白键 → 拒绝。
    assert.throws(
      () =>
        repo.createTurn({
          treeId: ids.treeId,
          branchId: ids.rootBranchId,
          episodeId: ids.episodeId,
          runId: ids.runId,
          role: "user",
          text: "user turn with a key",
          idempotencyKey: "key-0002",
        }),
      InvalidArgumentError,
    );
    assert.throws(
      () =>
        repo.createTurn({
          treeId: ids.treeId,
          branchId: ids.rootBranchId,
          episodeId: ids.episodeId,
          runId: ids.runId,
          role: "assistant",
          text: "assistant turn with an anchor",
          targetAnchor: anchorSnapshot,
        }),
      InvalidArgumentError,
    );
    assert.throws(
      () =>
        repo.createTurn({
          treeId: ids.treeId,
          branchId: ids.rootBranchId,
          episodeId: anotherEpisode.id,
          role: "return",
          text: "blank key",
          fromBranchId: ids.secondBranchId,
          idempotencyKey: "   ",
        }),
      InvalidArgumentError,
    );

    repo.close();

    // 重开 round-trip：键与锚点快照完整还原。
    const repo2 = TreeRepository.open({ path: dbPath(dir) });
    const reread = repo2.findReturnByIdempotencyKey(ids.treeId, "key-0001");
    assert.ok(reread !== null);
    assert.equal(reread.id, keyed.id);
    assert.deepEqual(reread.targetAnchor, anchorSnapshot);
    const legacyReread = repo2.getTurn(legacy.id);
    assert.equal(legacyReread.idempotencyKey, null);
    assert.equal(legacyReread.targetAnchor, null);
    repo2.close();
  } finally {
    cleanupTempDir(dir);
  }
});

test("migration 0004 upgrades a v3 database in place; legacy return rows keep NULL key/anchor", () => {
  const dir = makeTempDir();
  try {
    const path = dbPath(dir);
    const at = "2026-09-28T00:00:00.000Z";

    // 构造 v3 库并直接写入一条历史 return turn（无键、无锚点）。
    const raw = new DatabaseSync(path);
    runMigrations(raw, MIGRATIONS.slice(0, 3));
    raw
      .prepare("INSERT INTO forests (id, created_at) VALUES ('forest-1', ?)")
      .run(at);
    raw.prepare("INSERT INTO trees (id, forest_id, created_at) VALUES ('tree-1', 'forest-1', ?)").run(at);
    raw
      .prepare("INSERT INTO branches (id, tree_id, parent_branch_id, created_at) VALUES ('branch-1', 'tree-1', NULL, ?)")
      .run(at);
    raw
      .prepare(
        "INSERT INTO branches (id, tree_id, parent_branch_id, created_at) VALUES ('branch-2', 'tree-1', 'branch-1', ?)",
      )
      .run(at);
    raw.prepare("INSERT INTO episodes (id, branch_id, created_at) VALUES ('episode-1', 'branch-1', ?)").run(at);
    raw
      .prepare(
        `INSERT INTO turns (id, tree_id, branch_id, episode_id, run_id, role, text, pi_entry_id,
                            from_branch_id, delivered_run_id, created_at)
         VALUES ('turn-legacy', 'tree-1', 'branch-1', 'episode-1', NULL, 'return', 'legacy return',
                 NULL, 'branch-2', NULL, ?)`,
      )
      .run(at);
    raw.close();

    // 正常打开：0004 前向增量应用，历史行两列保持 NULL。
    const repo = TreeRepository.open({ path });
    assert.equal(repo.schemaVersion, LATEST_SCHEMA_VERSION);
    assert.equal(repo.schemaVersion, 4);
    const legacy = repo.getTurn("turn-legacy" as TurnId);
    assert.equal(legacy.role, "return");
    assert.equal(legacy.idempotencyKey, null, "legacy return keeps a NULL idempotency key");
    assert.equal(legacy.targetAnchor, null, "legacy return keeps a NULL target anchor");
    assert.equal(repo.findReturnByIdempotencyKey("tree-1" as TreeId, "any-key"), null);

    // 升级后的库接受带键 return，且唯一索引对新行生效。
    const episode = repo.createEpisode("branch-1" as BranchId);
    repo.createTurn({
      treeId: "tree-1" as TreeId,
      branchId: "branch-1" as BranchId,
      episodeId: episode.id,
      role: "return",
      text: "keyed return after upgrade",
      fromBranchId: "branch-2" as BranchId,
      idempotencyKey: "key-upgraded",
    });
    assert.equal(repo.findReturnByIdempotencyKey("tree-1" as TreeId, "key-upgraded")?.text, "keyed return after upgrade");
    const secondEpisode = repo.createEpisode("branch-1" as BranchId);
    assert.throws(
      () =>
        repo.createTurn({
          treeId: "tree-1" as TreeId,
          branchId: "branch-1" as BranchId,
          episodeId: secondEpisode.id,
          role: "return",
          text: "same key again",
          fromBranchId: "branch-2" as BranchId,
          idempotencyKey: "key-upgraded",
        }),
      ConstraintViolationError,
    );
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
