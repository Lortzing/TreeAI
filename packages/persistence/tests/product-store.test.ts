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
import { cleanupTempDir, dbPath, makeClock, makeIdGenerator, makeSessionReference, makeTempDir, modelFailure } from "./helpers.ts";

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
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN " +
          "('turns', 'branch_origins', 'tree_active_navigation', 'return_adoption_attempts', " +
          "'terminology_annotations', 'terminology_state', 'terminology_promotion_dispatches')",
      )
      .all() as Array<{ name: string }>;
    assert.deepEqual(
      tables.map((t) => t.name).sort(),
      [
        "branch_origins",
        "return_adoption_attempts",
        "terminology_annotations",
        "terminology_promotion_dispatches",
        "terminology_state",
        "tree_active_navigation",
        "turns",
      ],
      "product migrations must create the product, navigation, adoption-attempt, terminology and terminology-dispatch tables",
    );
    const versions = raw.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{
      version: number;
    }>;
    assert.deepEqual(
      versions.map((v) => Number(v.version)),
      Array.from({ length: LATEST_SCHEMA_VERSION }, (_, i) => i + 1),
      "all registered migrations must be applied on a fresh database (1..LATEST, contiguous)",
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

    // 正常打开：0004 起前向增量应用（当前注册到 0006），历史行两列保持 NULL。
    const repo = TreeRepository.open({ path });
    assert.equal(repo.schemaVersion, LATEST_SCHEMA_VERSION);
    assert.ok(repo.schemaVersion >= 4, "migration 0004 must be applied");
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

test("the same idempotency key is usable independently in two trees (signed v3 §3.4)", () => {
  const dir = makeTempDir();
  try {
    const repo = TreeRepository.open({ path: dbPath(dir), now: makeClock(), generateId: makeIdGenerator("t") });
    const forest = repo.createForest();
    const tree1 = repo.createTree(forest.id);
    const tree2 = repo.createTree(forest.id);
    const trunk1 = repo.createBranch(tree1.id);
    const branch1 = repo.createBranch(tree1.id, { parentBranchId: trunk1.id });
    const trunk2 = repo.createBranch(tree2.id);
    const branch2 = repo.createBranch(tree2.id, { parentBranchId: trunk2.id });
    const episode1 = repo.createEpisode(trunk1.id);
    const episode2 = repo.createEpisode(trunk2.id);

    // 同一逻辑键在两棵树内各自落库——UNIQUE(tree_id, idempotency_key)。
    const inTree1 = repo.createTurn({
      treeId: tree1.id,
      branchId: trunk1.id,
      episodeId: episode1.id,
      role: "return",
      text: "return in tree one",
      fromBranchId: branch1.id,
      idempotencyKey: "key-shared",
    });
    const inTree2 = repo.createTurn({
      treeId: tree2.id,
      branchId: trunk2.id,
      episodeId: episode2.id,
      role: "return",
      text: "return in tree two",
      fromBranchId: branch2.id,
      idempotencyKey: "key-shared",
    });
    assert.notEqual(inTree1.id, inTree2.id);

    // 按键查找以树为命名空间：各树定位各自的 Return。
    assert.equal(repo.findReturnByIdempotencyKey(tree1.id, "key-shared")?.id, inTree1.id);
    assert.equal(repo.findReturnByIdempotencyKey(tree2.id, "key-shared")?.id, inTree2.id);
    assert.equal(repo.findReturnByIdempotencyKey(tree1.id, "key-shared")?.text, "return in tree one");
    assert.equal(repo.findReturnByIdempotencyKey(tree2.id, "key-shared")?.text, "return in tree two");

    // 树内同键仍然至多一条。
    const anotherEpisode = repo.createEpisode(trunk1.id);
    assert.throws(
      () =>
        repo.createTurn({
          treeId: tree1.id,
          branchId: trunk1.id,
          episodeId: anotherEpisode.id,
          role: "return",
          text: "same tree, same key",
          fromBranchId: branch1.id,
          idempotencyKey: "key-shared",
        }),
      ConstraintViolationError,
    );

    repo.close();

    // 重开 round-trip：两棵树的同键各自还原。
    const repo2 = TreeRepository.open({ path: dbPath(dir) });
    assert.equal(repo2.findReturnByIdempotencyKey(tree1.id, "key-shared")?.id, inTree1.id);
    assert.equal(repo2.findReturnByIdempotencyKey(tree2.id, "key-shared")?.id, inTree2.id);
    repo2.close();
  } finally {
    cleanupTempDir(dir);
  }
});

test("migrations 0005/0006 upgrade a v4 database in place; idempotency scope narrows to per-tree", () => {
  const dir = makeTempDir();
  try {
    const path = dbPath(dir);
    const at = "2026-09-28T00:00:00.000Z";

    // 构造 v4 库：tree-1 已有一条带键 return（0004 全局唯一索引下落库）。
    const raw = new DatabaseSync(path);
    runMigrations(raw, MIGRATIONS.slice(0, 4));
    raw.prepare("INSERT INTO forests (id, created_at) VALUES ('forest-1', ?)").run(at);
    for (const treeId of ["tree-1", "tree-2"]) {
      raw.prepare("INSERT INTO trees (id, forest_id, created_at) VALUES (?, 'forest-1', ?)").run(treeId, at);
      raw
        .prepare(
          `INSERT INTO branches (id, tree_id, parent_branch_id, created_at) VALUES ('${treeId}-trunk', ?, NULL, ?)`,
        )
        .run(treeId, at);
      raw
        .prepare(
          `INSERT INTO branches (id, tree_id, parent_branch_id, created_at) VALUES ('${treeId}-branch', ?, '${treeId}-trunk', ?)`,
        )
        .run(treeId, at);
      raw.prepare(`INSERT INTO episodes (id, branch_id, created_at) VALUES ('${treeId}-episode', '${treeId}-trunk', ?)`).run(at);
    }
    raw
      .prepare(
        `INSERT INTO turns (id, tree_id, branch_id, episode_id, run_id, role, text, pi_entry_id,
                            from_branch_id, delivered_run_id, created_at, idempotency_key)
         VALUES ('turn-keyed', 'tree-1', 'tree-1-trunk', 'tree-1-episode', NULL, 'return', 'keyed under v4',
                 NULL, 'tree-1-branch', NULL, ?, 'key-upg')`,
      )
      .run(at);
    raw.close();

    // 正常打开：0005/0006 前向增量应用；v4 带键行原样保留。
    const repo = TreeRepository.open({ path });
    assert.equal(repo.schemaVersion, LATEST_SCHEMA_VERSION);
    assert.ok(repo.schemaVersion >= 6, "migrations 0005 and 0006 must be applied");
    const keyed = repo.getTurn("turn-keyed" as TurnId);
    assert.equal(keyed.idempotencyKey, "key-upg", "v4 keyed return keeps its key across the upgrade");

    // 作用域收窄生效：同一键在另一棵树内可独立落库；原树内仍唯一。
    const inTree2 = repo.createTurn({
      treeId: "tree-2" as TreeId,
      branchId: "tree-2-trunk" as BranchId,
      episodeId: "tree-2-episode" as never,
      role: "return",
      text: "same key, different tree",
      fromBranchId: "tree-2-branch" as BranchId,
      idempotencyKey: "key-upg",
    });
    assert.equal(repo.findReturnByIdempotencyKey("tree-1" as TreeId, "key-upg")?.id, "turn-keyed");
    assert.equal(repo.findReturnByIdempotencyKey("tree-2" as TreeId, "key-upg")?.id, inTree2.id);
    const anotherEpisode = repo.createEpisode("tree-1-trunk" as BranchId);
    assert.throws(
      () =>
        repo.createTurn({
          treeId: "tree-1" as TreeId,
          branchId: "tree-1-trunk" as BranchId,
          episodeId: anotherEpisode.id,
          role: "return",
          text: "same tree, same key after upgrade",
          fromBranchId: "tree-1-branch" as BranchId,
          idempotencyKey: "key-upg",
        }),
      ConstraintViolationError,
    );
    repo.close();
  } finally {
    cleanupTempDir(dir);
  }
});

test("return adoption attempts record per-run associations and survive reopen (signed v3 §3.2)", () => {
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
      text: "a conclusion to adopt",
      fromBranchId: ids.secondBranchId,
      idempotencyKey: "key-attempt",
    });

    // 两次主干 Run（第一次失败、第二次成功）都构成采用尝试。
    const failingRun = repo.createRun(trunkEpisode.id, makeSessionReference());
    repo.updateRunState(failingRun.id, "running");
    repo.updateRunState(failingRun.id, "failed", { failure: modelFailure() });
    const succeedingRun = repo.createRun(trunkEpisode.id, makeSessionReference());
    repo.updateRunState(succeedingRun.id, "running");

    assert.deepEqual(repo.listReturnAdoptionAttempts(returnTurn.id), [], "no attempts recorded before any run composes the return");
    repo.recordReturnAdoptionAttempt(returnTurn.id, failingRun.id);
    repo.recordReturnAdoptionAttempt(returnTurn.id, succeedingRun.id);

    // 关联按尝试时刻排序；Run 结局留在 runs 行（读取面联合投影）。
    const attempts = repo.listReturnAdoptionAttempts(returnTurn.id);
    assert.deepEqual(
      attempts.map((a) => a.runId),
      [failingRun.id, succeedingRun.id],
    );
    assert.ok(attempts[0]!.attemptedAt <= attempts[1]!.attemptedAt);

    // 复合主键：同一 (return, run) 只记录一次。
    assert.throws(() => repo.recordReturnAdoptionAttempt(returnTurn.id, failingRun.id), ConstraintViolationError);

    // 首-次-成-功 语义：markReturnDelivered 记录成功 Run；尝试关联不受影响。
    repo.updateRunState(succeedingRun.id, "succeeded");
    repo.markReturnDelivered(returnTurn.id, succeedingRun.id);
    assert.equal(repo.getTurn(returnTurn.id).deliveredRunId, succeedingRun.id);
    assert.equal(repo.listReturnAdoptionAttempts(returnTurn.id).length, 2, "attempts survive the first successful adoption");

    // 校验：非 return turn / 未知 turn / 未知 run。
    const plainTurn = repo.createTurn({
      treeId: ids.treeId,
      branchId: ids.rootBranchId,
      episodeId: ids.episodeId,
      runId: ids.runId,
      role: "user",
      text: "plain question",
    });
    assert.throws(() => repo.recordReturnAdoptionAttempt(plainTurn.id, succeedingRun.id), InvalidArgumentError);
    assert.throws(() => repo.recordReturnAdoptionAttempt("turn-missing" as TurnId, succeedingRun.id), EntityNotFoundError);
    assert.throws(() => repo.recordReturnAdoptionAttempt(returnTurn.id, "run-missing" as never), EntityNotFoundError);
    assert.deepEqual(repo.listReturnAdoptionAttempts(plainTurn.id), [], "non-return turns list no attempts");

    repo.close();

    // 重开 round-trip：尝试关联完整还原。
    const repo2 = TreeRepository.open({ path: dbPath(dir) });
    const reread = repo2.listReturnAdoptionAttempts(returnTurn.id);
    assert.deepEqual(
      reread.map((a) => a.runId),
      [failingRun.id, succeedingRun.id],
    );
    repo2.close();
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

test("terminology annotations round-trip with anchor integrity, range dedup, at-most-one promotion binding, and kv state", () => {
  const dir = makeTempDir();
  try {
    const repo = TreeRepository.open({ path: dbPath(dir), now: makeClock(), generateId: makeIdGenerator("t") });
    const ids = setupDomainWithRun(repo);
    const answer = repo.createTurn({
      treeId: ids.treeId,
      branchId: ids.rootBranchId,
      episodeId: ids.episodeId,
      runId: ids.runId,
      role: "assistant",
      text: "The entropy of a distribution measures uncertainty.",
      piEntryId: "entry-0042",
    });

    /* 保存 + 往返：切片一致、sourceHash/term/explanation/mode 原样。 */
    const created = repo.createTerminologyAnnotation({
      treeId: ids.treeId,
      branchId: ids.rootBranchId,
      anchorTurnId: answer.id,
      selection: { start: 4, end: 11, text: "entropy" },
      sourceHash: "a".repeat(64),
      term: "entropy",
      explanation: "A measure of uncertainty.",
      mode: "term",
    });
    assert.equal(created.term, "entropy");
    assert.equal(created.mode, "term");
    assert.equal(created.promotedBranchId, null);
    assert.deepEqual(repo.listTerminologyAnnotations(ids.treeId).map((a) => a.id), [created.id]);
    assert.deepEqual(
      repo.findTerminologyAnnotationByRange(ids.treeId, answer.id, 4, 11)?.id,
      created.id,
      "the range lookup finds the annotation",
    );

    /* 锚定完整性：切片失配 / 越界 / 非答案锚点 → InvalidArgumentError。 */
    assert.throws(
      () =>
        repo.createTerminologyAnnotation({
          treeId: ids.treeId,
          branchId: ids.rootBranchId,
          anchorTurnId: answer.id,
          selection: { start: 4, end: 11, text: "ENTROPY" },
          sourceHash: "a".repeat(64),
          term: "x",
          explanation: "y",
          mode: "term",
        }),
      InvalidArgumentError,
    );
    assert.throws(
      () =>
        repo.createTerminologyAnnotation({
          treeId: ids.treeId,
          branchId: ids.secondBranchId,
          anchorTurnId: answer.id,
          selection: { start: 0, end: 3, text: "The" },
          sourceHash: "a".repeat(64),
          term: "x",
          explanation: "y",
          mode: "range",
        }),
      InvalidArgumentError,
    );

    /* 同选区去重：唯一索引判负 → ConstraintViolationError。 */
    assert.throws(
      () =>
        repo.createTerminologyAnnotation({
          treeId: ids.treeId,
          branchId: ids.rootBranchId,
          anchorTurnId: answer.id,
          selection: { start: 4, end: 11, text: "entropy" },
          sourceHash: "a".repeat(64),
          term: "entropy",
          explanation: "different",
          mode: "range",
        }),
      ConstraintViolationError,
    );

    /* 幂等推广绑定：首次生效；再绑（同键重放读路径）返回 false。 */
    const promotedBranch = repo.createBranch(ids.treeId, { parentBranchId: ids.rootBranchId });
    assert.equal(repo.bindTerminologyPromotion(created.id, "promo-key", promotedBranch.id), true);
    assert.equal(repo.bindTerminologyPromotion(created.id, "promo-key-2", ids.secondBranchId), false);
    const bound = repo.getTerminologyAnnotation(created.id);
    assert.equal(bound.promotedBranchId, promotedBranch.id);
    assert.equal(bound.promotionKey, "promo-key");
    assert.equal(
      repo.findTerminologyAnnotationByPromotionKey(ids.treeId, "promo-key")?.id,
      created.id,
      "the promotion key replays to the annotation",
    );

    /* kv 状态往返。 */
    assert.equal(repo.getTerminologyState("usage"), null);
    repo.setTerminologyState("usage", '{"total":{"requests":1}}');
    assert.equal(repo.getTerminologyState("usage"), '{"total":{"requests":1}}');
    repo.setTerminologyState("usage", '{"total":{"requests":2}}');
    assert.equal(repo.getTerminologyState("usage"), '{"total":{"requests":2}}', "UPSERT overwrites");

    /* 跨重开持久化。 */
    repo.close();
    const repo2 = TreeRepository.open({ path: dbPath(dir) });
    const reloaded = repo2.listTerminologyAnnotations(ids.treeId);
    assert.equal(reloaded.length, 1);
    assert.equal(reloaded[0]!.explanation, "A measure of uncertainty.");
    assert.equal(reloaded[0]!.promotedBranchId, promotedBranch.id);
    assert.equal(repo2.getTerminologyState("usage"), '{"total":{"requests":2}}');
    repo2.close();
  } finally {
    cleanupTempDir(dir);
  }
});

test("terminology dispatch ledger (migration 0009): intent registration follows the promotion binding, one row per annotation, sent/settle state machine with attempt counting, and durable replay", () => {
  const dir = makeTempDir();
  try {
    const repo = TreeRepository.open({ path: dbPath(dir), now: makeClock(), generateId: makeIdGenerator("d") });
    const ids = setupDomainWithRun(repo);
    const answer = repo.createTurn({
      treeId: ids.treeId,
      branchId: ids.rootBranchId,
      episodeId: ids.episodeId,
      runId: ids.runId,
      role: "assistant",
      text: "The entropy of a distribution measures uncertainty.",
      piEntryId: "entry-0042",
    });
    const annotation = repo.createTerminologyAnnotation({
      treeId: ids.treeId,
      branchId: ids.rootBranchId,
      anchorTurnId: answer.id,
      selection: { start: 4, end: 11, text: "entropy" },
      sourceHash: "a".repeat(64),
      term: "entropy",
      explanation: "A measure of uncertainty.",
      mode: "term",
    });
    const promotedBranch = repo.createBranch(ids.treeId, { parentBranchId: ids.rootBranchId });
    const firstQuestionHash = "f".repeat(64);

    /* 顺序纪律：绑定先行——未绑定时登记意图 → InvalidArgumentError。 */
    assert.throws(
      () =>
        repo.createTerminologyDispatch({
          annotationId: annotation.id,
          treeId: ids.treeId,
          promotionKey: "ledger-key",
          branchId: promotedBranch.id,
          firstQuestionHash,
        }),
      (error: unknown) => error instanceof InvalidArgumentError && /not bound to a promotion/.test(error.message),
    );

    /* 绑定后登记：pending / attempts 0；重复登记（annotation 唯一）→
       ConstraintViolationError。 */
    assert.equal(repo.bindTerminologyPromotion(annotation.id, "ledger-key", promotedBranch.id), true);
    const intent = repo.createTerminologyDispatch({
      annotationId: annotation.id,
      treeId: ids.treeId,
      promotionKey: "ledger-key",
      branchId: promotedBranch.id,
      firstQuestionHash,
    });
    assert.equal(intent.dispatchState, "pending");
    assert.equal(intent.attempts, 0);
    assert.equal(intent.firstQuestionHash, firstQuestionHash);
    assert.equal(intent.runId, null);
    assert.equal(intent.failure, null);
    assert.equal(repo.findTerminologyDispatchByAnnotation(annotation.id)?.id, intent.id);
    assert.throws(
      () =>
        repo.createTerminologyDispatch({
          annotationId: annotation.id,
          treeId: ids.treeId,
          promotionKey: "ledger-key",
          branchId: promotedBranch.id,
          firstQuestionHash,
        }),
      ConstraintViolationError,
    );

    /* 意图与绑定不匹配（异键/异枝）→ InvalidArgumentError。 */
    assert.throws(
      () =>
        repo.createTerminologyDispatch({
          annotationId: annotation.id,
          treeId: ids.treeId,
          promotionKey: "another-key",
          branchId: promotedBranch.id,
          firstQuestionHash,
        }),
      InvalidArgumentError,
    );

    /* 结算前置：pending 不能直接结算。 */
    assert.throws(
      () => repo.settleTerminologyDispatch(annotation.id, { state: "failed", failure: { code: "upstream", message: "no" } }),
      InvalidArgumentError,
    );

    /* markSent：pending → dispatched，attempts 1；再 markSent（结果未知/
       已在途）→ InvalidArgumentError（调用方须先对账）。 */
    const sent = repo.markTerminologyDispatchSent(annotation.id);
    assert.equal(sent.dispatchState, "dispatched");
    assert.equal(sent.attempts, 1);
    assert.throws(
      () => repo.markTerminologyDispatchSent(annotation.id),
      (error: unknown) => error instanceof InvalidArgumentError && /reconcile/.test(error.message),
    );

    /* 结算 succeeded：携带 Run 引用；重复结算 → InvalidArgumentError。 */
    const episode = repo.createEpisode(promotedBranch.id);
    const dispatchRun = repo.createRun(episode.id, makeSessionReference());
    const settled = repo.settleTerminologyDispatch(annotation.id, { state: "succeeded", runId: dispatchRun.id });
    assert.equal(settled.dispatchState, "succeeded");
    assert.equal(settled.runId, dispatchRun.id);
    assert.equal(settled.attempts, 1);
    assert.throws(
      () => repo.settleTerminologyDispatch(annotation.id, { state: "failed", failure: { code: "upstream", message: "no" } }),
      InvalidArgumentError,
    );
    /* succeeded 后 markSent（不可再发）→ InvalidArgumentError。 */
    assert.throws(
      () => repo.markTerminologyDispatchSent(annotation.id),
      (error: unknown) => error instanceof InvalidArgumentError && /already landed/.test(error.message),
    );

    /* failed 路线（第二条批注）：markSent → settle failed（failure 往返）
       → failed → markSent（重试，attempts 2）→ settle succeeded。 */
    const answer2 = repo.createTurn({
      treeId: ids.treeId,
      branchId: ids.rootBranchId,
      episodeId: ids.episodeId,
      runId: ids.runId,
      role: "assistant",
      text: "Latency is the delay before a transfer begins.",
      piEntryId: "entry-0043",
    });
    const annotation2 = repo.createTerminologyAnnotation({
      treeId: ids.treeId,
      branchId: ids.rootBranchId,
      anchorTurnId: answer2.id,
      selection: { start: 0, end: 7, text: "Latency" },
      sourceHash: "b".repeat(64),
      term: "Latency",
      explanation: "Delay.",
      mode: "term",
    });
    const branch2 = repo.createBranch(ids.treeId, { parentBranchId: ids.rootBranchId });
    assert.equal(repo.bindTerminologyPromotion(annotation2.id, "ledger-key-2", branch2.id), true);
    repo.createTerminologyDispatch({
      annotationId: annotation2.id,
      treeId: ids.treeId,
      promotionKey: "ledger-key-2",
      branchId: branch2.id,
      firstQuestionHash: "e".repeat(64),
    });
    repo.markTerminologyDispatchSent(annotation2.id);
    const failedSettle = repo.settleTerminologyDispatch(annotation2.id, {
      state: "failed",
      failure: { code: "upstream", message: "simulated upstream failure" },
    });
    assert.equal(failedSettle.dispatchState, "failed");
    assert.deepEqual(failedSettle.failure, { code: "upstream", message: "simulated upstream failure" });
    assert.equal(failedSettle.runId, null);
    const retried = repo.markTerminologyDispatchSent(annotation2.id);
    assert.equal(retried.dispatchState, "dispatched", "failed → dispatched is the explicit retry transition");
    assert.equal(retried.attempts, 2, "attempts counts every real dispatch");
    const episode2 = repo.createEpisode(branch2.id);
    const run2 = repo.createRun(episode2.id, makeSessionReference());
    const retriedSettled = repo.settleTerminologyDispatch(annotation2.id, { state: "succeeded", runId: run2.id });
    assert.equal(retriedSettled.dispatchState, "succeeded");
    assert.equal(retriedSettled.runId, run2.id);

    /* succeeded 引用不存在的 Run → EntityNotFoundError。 */
    const answer3 = repo.createTurn({
      treeId: ids.treeId,
      branchId: ids.rootBranchId,
      episodeId: ids.episodeId,
      runId: ids.runId,
      role: "assistant",
      text: "Throughput measures completed work per unit time.",
      piEntryId: "entry-0044",
    });
    const annotation3 = repo.createTerminologyAnnotation({
      treeId: ids.treeId,
      branchId: ids.rootBranchId,
      anchorTurnId: answer3.id,
      selection: { start: 0, end: 10, text: "Throughput" },
      sourceHash: "c".repeat(64),
      term: "Throughput",
      explanation: "Rate.",
      mode: "term",
    });
    const branch3 = repo.createBranch(ids.treeId, { parentBranchId: ids.rootBranchId });
    repo.bindTerminologyPromotion(annotation3.id, "ledger-key-3", branch3.id);
    repo.createTerminologyDispatch({
      annotationId: annotation3.id,
      treeId: ids.treeId,
      promotionKey: "ledger-key-3",
      branchId: branch3.id,
      firstQuestionHash: "9".repeat(64),
    });
    repo.markTerminologyDispatchSent(annotation3.id);
    assert.throws(
      () => repo.settleTerminologyDispatch(annotation3.id, { state: "succeeded", runId: "run_missing" as never }),
      EntityNotFoundError,
    );

    /* 跨重开持久化：账本行与终态原样。 */
    repo.close();
    const repo2 = TreeRepository.open({ path: dbPath(dir) });
    const reloaded = repo2.findTerminologyDispatchByAnnotation(annotation.id);
    assert.equal(reloaded?.dispatchState, "succeeded");
    assert.equal(reloaded?.runId, dispatchRun.id);
    const reloaded2 = repo2.findTerminologyDispatchByAnnotation(annotation2.id);
    assert.equal(reloaded2?.dispatchState, "succeeded");
    assert.equal(reloaded2?.attempts, 2);
    assert.equal(repo2.findTerminologyDispatchByAnnotation("term_missing"), null);
    repo2.close();
  } finally {
    cleanupTempDir(dir);
  }
});
