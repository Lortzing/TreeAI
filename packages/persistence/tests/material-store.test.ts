/**
 * D4-1 材料存储测试（migration 0008 + MaterialRepository）：
 * - 空库迁移到 schema 版本 8；0008 前（v7）库升级保数据并回填
 *   branches.origin_kind（有 branch_origins 行 → 'turn'，其余 'none'）；
 * - 版本幂等：内容寻址 blob + UNIQUE(material_id, content_hash)——同材料
 *   同字节复用版本，不同字节追加新版本，旧锚点不受影响（ADR-003 §3）；
 * - 材料来源选区纪律：excerpt === canonicalText.slice(start, end)、块存在
 *   且含区间、sourceHash 一致、非 ready 版本拒绝建枝（ADR-003 §2/§5）；
 * - 首问幂等：PRIMARY KEY(tree_id, intent_key) 重放返回既有行
 *   （ADR-003 §4）；
 * - 树链接 / 阅读位置 / origin_kind 一致性辅助。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  BranchId,
  MaterialBlock,
  MaterialId,
  MaterialParseStatus,
  MaterialSelection,
  MaterialVersionId,
  TreeId,
} from "@treeai/contracts";
import {
  EntityNotFoundError,
  InvalidArgumentError,
  LATEST_SCHEMA_VERSION,
  MaterialRepository,
  MIGRATIONS,
  runMigrations,
  TreeRepository,
} from "../src/index.ts";
import { cleanupTempDir, dbPath, makeClock, makeIdGenerator, makeSessionReference, makeTempDir } from "./helpers.ts";

/* ------------------------------ 测试辅助 ------------------------------ */

const ENCODER = new TextEncoder();

function utf8(text: string): Uint8Array {
  return ENCODER.encode(text);
}

/** 与仓储/术语同一纪律的文本 SHA-256（十六进制，UTF-8 口径）。 */
function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** markdown 块化（B1 真值规则：每块以 \n\n 结尾，末块除外）。 */
function markdownBlocks(text: string): MaterialBlock[] {
  if (text.length === 0) return [];
  const parts = text.split("\n\n");
  const blocks: MaterialBlock[] = [];
  let cursor = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const end = i === parts.length - 1 ? cursor + part.length : cursor + part.length + 2;
    blocks.push({ blockId: `blk-${i}`, kind: "markdown-block", start: cursor, end });
    cursor = end;
  }
  return blocks;
}

interface World {
  readonly dir: string;
  readonly path: string;
  readonly tree: TreeRepository;
  readonly mat: MaterialRepository;
  readonly treeId: TreeId;
  readonly trunkId: BranchId;
}

/** 打开同库的双仓储（TreeRepository 建树/枝，MaterialRepository 建材料事实）。 */
function openWorld(): World {
  const dir = makeTempDir();
  const path = dbPath(dir);
  const clock = makeClock();
  const tree = TreeRepository.open({ path, now: clock, generateId: makeIdGenerator("w") });
  const mat = MaterialRepository.open({ path, now: clock, generateId: makeIdGenerator("m") });
  const forest = tree.createForest();
  const treeEntity = tree.createTree(forest.id);
  const trunk = tree.createBranch(treeEntity.id);
  return { dir, path, tree, mat, treeId: treeEntity.id, trunkId: trunk.id };
}

function withWorld(fn: (world: World) => void): void {
  const world = openWorld();
  try {
    fn(world);
  } finally {
    world.mat.close();
    world.tree.close();
    cleanupTempDir(world.dir);
  }
}

/** 导入一个 markdown 版本（默认 ready）；返回版本 id 与 canonicalText 指纹。 */
function importMarkdown(
  mat: MaterialRepository,
  materialId: MaterialId,
  text: string,
  options?: {
    readonly bytes?: Uint8Array;
    readonly parseStatus?: MaterialParseStatus;
    readonly parseError?: string | null;
  },
): { versionId: MaterialVersionId; contentHash: string; sourceHash: string } {
  const version = mat.insertVersion({
    materialId,
    bytes: options?.bytes ?? utf8(text),
    parserKind: "markdown",
    parserVersion: "d4-md-v1",
    parseStatus: options?.parseStatus ?? "ready",
    parseError: options?.parseError ?? null,
    canonicalText: text,
    blocks: markdownBlocks(text),
  });
  return { versionId: version.id, contentHash: version.contentHash, sourceHash: hashText(text) };
}

/* ------------------------------ 迁移 ------------------------------ */

test("fresh database migrates to schema version 8 (material core)", () => {
  assert.equal(LATEST_SCHEMA_VERSION, 8, "migration 0008 must be registered as the latest");
  const dir = makeTempDir();
  try {
    const path = dbPath(dir);
    const mat = MaterialRepository.open({ path });
    assert.equal(mat.schemaVersion, 8);
    mat.close();
    const mem = MaterialRepository.open({ path: ":memory:" });
    assert.equal(mem.schemaVersion, 8);
    mem.close();

    const raw = new DatabaseSync(path, { readOnly: true });
    const registered = raw
      .prepare("SELECT version, name FROM schema_migrations WHERE version = 8")
      .get() as { version: number; name: string } | undefined;
    assert.ok(registered !== undefined, "migration 8 must be registered");
    assert.equal(Number(registered.version), 8);
    assert.equal(registered.name, "material-core");
    const uv = raw.prepare("PRAGMA user_version").get() as { user_version: number };
    assert.equal(Number(uv.user_version), 8);
    const tables = raw
      .prepare(
        `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN
           ('materials','material_blobs','material_versions','tree_material_links',
            'material_branch_origins','tree_material_reading_state','material_first_questions')`,
      )
      .get() as { n: number };
    assert.equal(Number(tables.n), 7, "all seven material tables must exist");
    const branchColumns = (
      raw.prepare("PRAGMA table_info(branches)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    assert.ok(branchColumns.includes("origin_kind"), "branches.origin_kind column must exist");
    raw.close();
  } finally {
    cleanupTempDir(dir);
  }
});

test("pre-0008 database upgrades: rows preserved, origin_kind backfilled (turn/none)", () => {
  const dir = makeTempDir();
  try {
    const path = dbPath(dir);
    assert.equal(MIGRATIONS[6]!.version, 7, "MIGRATIONS[6] must be 0007 (pre-0008 slice)");
    assert.equal(MIGRATIONS[7]!.version, 8, "MIGRATIONS[7] must be 0008");

    // 构造 v7 库并种入 0008 之前的产品事实（森林/树/三分支/回合/turn 来源）。
    const raw = new DatabaseSync(path);
    runMigrations(raw, MIGRATIONS.slice(0, 7));
    raw
      .prepare("INSERT INTO forests (id, created_at) VALUES (?, ?)")
      .run("forest-1", "2026-09-01T00:00:00.000Z");
    raw
      .prepare("INSERT INTO trees (id, forest_id, created_at) VALUES (?, ?, ?)")
      .run("tree-1", "forest-1", "2026-09-01T00:00:01.000Z");
    raw
      .prepare("INSERT INTO branches (id, tree_id, parent_branch_id, created_at) VALUES (?, ?, ?, ?)")
      .run("branch-trunk", "tree-1", null, "2026-09-01T00:00:02.000Z");
    raw
      .prepare("INSERT INTO branches (id, tree_id, parent_branch_id, created_at) VALUES (?, ?, ?, ?)")
      .run("branch-a", "tree-1", "branch-trunk", "2026-09-01T00:00:03.000Z");
    raw
      .prepare("INSERT INTO branches (id, tree_id, parent_branch_id, created_at) VALUES (?, ?, ?, ?)")
      .run("branch-b", "tree-1", "branch-trunk", "2026-09-01T00:00:04.000Z");
    raw
      .prepare("INSERT INTO episodes (id, branch_id, created_at) VALUES (?, ?, ?)")
      .run("episode-1", "branch-trunk", "2026-09-01T00:00:05.000Z");
    raw
      .prepare(
        "INSERT INTO runs (id, episode_id, state, created_at, terminal_at, terminal_state, failure_json) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("run-1", "episode-1", "succeeded", "2026-09-01T00:00:06.000Z", "2026-09-01T00:00:07.000Z", "succeeded", null);
    raw
      .prepare(
        "INSERT INTO turns (id, tree_id, branch_id, episode_id, run_id, role, text, pi_entry_id, " +
          "from_branch_id, delivered_run_id, idempotency_key, target_anchor, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "turn-1",
        "tree-1",
        "branch-trunk",
        "episode-1",
        "run-1",
        "assistant",
        "这是主干上的回答，用于锚点测试。",
        "entry-1",
        null,
        null,
        null,
        null,
        "2026-09-01T00:00:08.000Z",
      );
    raw
      .prepare(
        "INSERT INTO branch_origins (branch_id, source_branch_id, anchor_turn_id, anchor_entry_id, " +
          "sel_start, sel_end, sel_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run("branch-a", "branch-trunk", "turn-1", "entry-1", 0, 5, "这是主干上的", "2026-09-01T00:00:09.000Z");
    raw.close();

    // 打开（应用 0008）：版本 8，数据保留，origin_kind 回填。
    const mat = MaterialRepository.open({ path });
    assert.equal(mat.schemaVersion, 8);
    assert.equal(mat.getBranchOriginKind("branch-a" as BranchId), "turn", "origin branch backfilled to 'turn'");
    assert.equal(mat.getBranchOriginKind("branch-b" as BranchId), "none", "branch without origin stays 'none'");
    assert.equal(mat.getBranchOriginKind("branch-trunk" as BranchId), "none", "trunk stays 'none'");
    const turnOrigin = mat.getBranchOrigin("branch-a" as BranchId);
    assert.ok(turnOrigin !== null && turnOrigin.kind === "turn");
    assert.equal(turnOrigin.origin.selection.text, "这是主干上的");
    assert.equal(mat.getBranchOrigin("branch-b" as BranchId), null);
    mat.close();

    const raw2 = new DatabaseSync(path, { readOnly: true });
    const kinds = raw2
      .prepare("SELECT id, origin_kind FROM branches ORDER BY id")
      .all() as Array<{ id: string; origin_kind: string }>;
    assert.deepEqual(
      kinds.map((k) => `${k.id}:${k.origin_kind}`),
      ["branch-a:turn", "branch-b:none", "branch-trunk:none"],
    );
    const turnCount = raw2.prepare("SELECT COUNT(*) AS n FROM turns").get() as { n: number };
    assert.equal(Number(turnCount.n), 1, "seeded turns preserved");
    const originCount = raw2.prepare("SELECT COUNT(*) AS n FROM branch_origins").get() as { n: number };
    assert.equal(Number(originCount.n), 1, "seeded branch_origins preserved");
    const versions = raw2
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as Array<{ version: number }>;
    assert.deepEqual(
      versions.map((v) => Number(v.version)),
      Array.from({ length: 8 }, (_, i) => i + 1),
    );
    raw2.close();
  } finally {
    cleanupTempDir(dir);
  }
});

/* ------------------------------ 原件与版本 ------------------------------ */

test("storeBlob is content-addressed and idempotent by hash", () => {
  const dir = makeTempDir();
  try {
    const path = dbPath(dir);
    const mat = MaterialRepository.open({ path });
    const bytes = utf8("任意原件字节（未解析的原始文件内容）");
    const h1 = mat.storeBlob(bytes);
    const h2 = mat.storeBlob(bytes); // 同字节再存：全局一份，不报错不重写
    assert.equal(h1, h2);
    assert.equal(h1, sha256Hex(bytes));
    const other = mat.storeBlob(utf8("另一份原件"));
    assert.notEqual(other, h1);
    assert.throws(
      () => mat.storeBlob(new Uint8Array(0)),
      (e: unknown) => e instanceof InvalidArgumentError && /non-empty/.test(e.message),
    );
    mat.close();
    const raw = new DatabaseSync(path, { readOnly: true });
    const blobs = raw.prepare("SELECT content_hash, bytes FROM material_blobs").all() as Array<{
      content_hash: string;
      bytes: Uint8Array;
    }>;
    assert.equal(blobs.length, 2, "distinct byte contents stored once each");
    const roundtrip = blobs.find((b) => b.content_hash === h1);
    assert.ok(roundtrip !== undefined);
    assert.deepEqual(new Uint8Array(roundtrip.bytes), bytes, "blob bytes round-trip exactly");
    raw.close();
  } finally {
    cleanupTempDir(dir);
  }
});

test("re-importing identical bytes reuses the version row; different bytes create a new version", () => {
  withWorld((w) => {
    const material = w.mat.createMaterial({ title: "研究笔记" });
    const textV1 = "第一段内容。\n\n第二段内容。";
    const v1 = w.mat.insertVersion({
      materialId: material.id,
      bytes: utf8(textV1),
      parserKind: "markdown",
      parserVersion: "d4-md-v1",
      parseStatus: "ready",
      canonicalText: textV1,
      blocks: markdownBlocks(textV1),
    });
    assert.equal(v1.materialId, material.id);
    assert.equal(v1.parserVersion, "d4-md-v1");
    assert.equal(v1.parseStatus, "ready");
    assert.equal(v1.parseError, null);
    assert.equal(v1.contentHash, sha256Hex(utf8(textV1)));
    assert.equal(v1.sizeBytes, utf8(textV1).byteLength);
    assert.equal(v1.textUnits, textV1.length);

    // 同材料同字节重导：复用既有版本（同 id、同导入时刻，不重复）。
    const replay = w.mat.insertVersion({
      materialId: material.id,
      bytes: utf8(textV1),
      parserKind: "markdown",
      parserVersion: "d4-md-v1",
      parseStatus: "ready",
      canonicalText: textV1,
      blocks: markdownBlocks(textV1),
    });
    assert.equal(replay.id, v1.id, "identical bytes must reuse the existing version");
    assert.equal(replay.importedAt, v1.importedAt, "version reuse must not rewrite importedAt");
    assert.equal(w.mat.listVersions(material.id).length, 1);

    // 内容变化：新版本追加，不覆盖。
    const textV2 = "第一段内容（修订版）。\n\n第二段内容。";
    const v2 = w.mat.insertVersion({
      materialId: material.id,
      bytes: utf8(textV2),
      parserKind: "markdown",
      parserVersion: "d4-md-v1",
      parseStatus: "ready",
      canonicalText: textV2,
      blocks: markdownBlocks(textV2),
    });
    assert.notEqual(v2.id, v1.id);
    assert.notEqual(v2.contentHash, v1.contentHash);
    const chain = w.mat.listVersions(material.id);
    assert.equal(chain.length, 2);
    assert.deepEqual(
      chain.map((v) => v.id),
      [v1.id, v2.id],
      "version chain ordered by import time",
    );

    // 内容寻址：跨材料同字节共享 blob，但版本按材料独立（UNIQUE 是
    // (material_id, content_hash)，不是全局 content_hash）。
    const other = w.mat.createMaterial({ title: "另一份材料（同字节）" });
    const v3 = w.mat.insertVersion({
      materialId: other.id,
      bytes: utf8(textV1),
      parserKind: "markdown",
      parserVersion: "d4-md-v1",
      parseStatus: "ready",
      canonicalText: textV1,
      blocks: markdownBlocks(textV1),
    });
    assert.notEqual(v3.id, v1.id, "same bytes under another material is a distinct version");
    assert.equal(v3.contentHash, v1.contentHash, "content addressing shared across materials");

    const raw = new DatabaseSync(w.path, { readOnly: true });
    const blobCount = raw.prepare("SELECT COUNT(*) AS n FROM material_blobs").get() as { n: number };
    assert.equal(Number(blobCount.n), 2, "two distinct byte contents → two blob rows (v1/v3 share one)");
    raw.close();
  });
});

test("insertVersion validates parse status, block coverage and failure reasons", () => {
  withWorld((w) => {
    const material = w.mat.createMaterial({ title: "校验用材料" });
    const text = "甲段落。\n\n乙段落。";
    const base = {
      materialId: material.id,
      parserKind: "markdown" as const,
      parserVersion: "d4-md-v1",
      canonicalText: text,
    };
    // 块覆盖错位（第二块起点不接第一块终点）
    const gap = markdownBlocks(text);
    gap[1] = { ...gap[1]!, start: gap[1]!.start + 1 };
    assert.throws(
      () =>
        w.mat.insertVersion({
          ...base,
          bytes: utf8(text),
          parseStatus: "ready",
          blocks: gap,
        }),
      (e: unknown) => e instanceof InvalidArgumentError && /continuously cover/.test(e.message),
    );
    // 末块不达 canonicalText 终点
    assert.throws(
      () =>
        w.mat.insertVersion({
          ...base,
          bytes: utf8(text),
          parseStatus: "ready",
          blocks: [{ blockId: "blk-0", kind: "markdown-block", start: 0, end: 1 }],
        }),
      (e: unknown) => e instanceof InvalidArgumentError && /continuously cover/.test(e.message),
    );
    // 空 canonicalText 不允许携带块
    assert.throws(
      () =>
        w.mat.insertVersion({
          ...base,
          canonicalText: "",
          bytes: utf8("x"),
          parseStatus: "pending",
          blocks: [{ blockId: "blk-0", kind: "markdown-block", start: 0, end: 1 }],
        }),
      (e: unknown) => e instanceof InvalidArgumentError && /continuously cover/.test(e.message),
    );
    // parseError 当且仅当失败终态
    assert.throws(
      () =>
        w.mat.insertVersion({
          ...base,
          bytes: utf8(text),
          parseStatus: "ready",
          parseError: "spurious",
          blocks: markdownBlocks(text),
        }),
      (e: unknown) => e instanceof InvalidArgumentError && /parseError must not be provided/.test(e.message),
    );
    assert.throws(
      () =>
        w.mat.insertVersion({
          ...base,
          bytes: utf8(text),
          parseStatus: "failed",
          blocks: markdownBlocks(text),
        }),
      (e: unknown) => e instanceof InvalidArgumentError && /requires a parseError/.test(e.message),
    );
    // 块 kind 与 parserKind 不一致
    assert.throws(
      () =>
        w.mat.insertVersion({
          materialId: material.id,
          parserKind: "pdf",
          parserVersion: "d4-pdf-v1",
          bytes: utf8(text),
          parseStatus: "ready",
          canonicalText: text,
          blocks: markdownBlocks(text),
        }),
      (e: unknown) => e instanceof InvalidArgumentError && /pdf-page/.test(e.message),
    );
    assert.equal(w.mat.listVersions(material.id).length, 0, "no version rows written by rejected inserts");
  });
});

/* ------------------------------ 材料来源 ------------------------------ */

test("material branch origin enforces the slice/excerpt/sourceHash discipline", () => {
  withWorld((w) => {
    const material = w.mat.createMaterial({ title: "材料 A" });
    const text = "第一段落讲甲事。\n\n第二段落讲乙事。";
    const { versionId, sourceHash } = importMarkdown(w.mat, material.id, text);
    const selectionOf = (overrides?: Partial<MaterialSelection>): MaterialSelection => ({
      materialId: material.id,
      versionId,
      blockId: "blk-0",
      start: 0,
      end: 5,
      excerpt: text.slice(0, 5),
      sourceHash,
      ...overrides,
    });

    // 校验辅助的正路径
    const context = w.mat.getMaterialSelection(selectionOf());
    assert.equal(context.material.id, material.id);
    assert.equal(context.version.id, versionId);
    assert.equal(context.version.parseStatus, "ready");

    // 有效选区建枝成功 + origin_kind 同事务置 'material'
    const branch = w.tree.createBranch(w.treeId, { parentBranchId: w.trunkId });
    const origin = w.mat.insertMaterialBranchOrigin({
      branchId: branch.id,
      treeId: w.treeId,
      selection: selectionOf(),
    });
    assert.equal(origin.branchId, branch.id);
    assert.equal(origin.sourceHash, sourceHash);
    assert.equal(origin.selection.excerpt, text.slice(0, 5));
    assert.equal(w.mat.getBranchOriginKind(branch.id), "material");
    const read = w.mat.getBranchOrigin(branch.id);
    assert.ok(read !== null && read.kind === "material");
    assert.equal(read.origin.selection.versionId, versionId);

    // 每枝至多一条来源：重复建枝拒绝
    assert.throws(
      () =>
        w.mat.insertMaterialBranchOrigin({
          branchId: branch.id,
          treeId: w.treeId,
          selection: selectionOf(),
        }),
      (e: unknown) => e instanceof InvalidArgumentError && /already has a material origin/.test(e.message),
    );

    // excerpt ≠ canonicalText.slice(start, end)
    const branchE = w.tree.createBranch(w.treeId, { parentBranchId: w.trunkId });
    assert.throws(
      () =>
        w.mat.insertMaterialBranchOrigin({
          branchId: branchE.id,
          treeId: w.treeId,
          selection: selectionOf({ excerpt: text.slice(5, 10) }),
        }),
      (e: unknown) => e instanceof InvalidArgumentError && /excerpt does not match/.test(e.message),
    );
    // 未知/过期 sourceHash
    assert.throws(
      () =>
        w.mat.insertMaterialBranchOrigin({
          branchId: branchE.id,
          treeId: w.treeId,
          selection: selectionOf({ sourceHash: hashText("不是这份 canonicalText") }),
        }),
      (e: unknown) => e instanceof InvalidArgumentError && /sourceHash does not match/.test(e.message),
    );
    // 块不存在
    assert.throws(
      () =>
        w.mat.insertMaterialBranchOrigin({
          branchId: branchE.id,
          treeId: w.treeId,
          selection: selectionOf({ blockId: "blk-99" }),
        }),
      (e: unknown) => e instanceof InvalidArgumentError && /does not exist/.test(e.message),
    );
    // 区间越界（超出 canonicalText 长度）
    assert.throws(
      () =>
        w.mat.insertMaterialBranchOrigin({
          branchId: branchE.id,
          treeId: w.treeId,
          selection: selectionOf({ start: 0, end: text.length + 1, excerpt: text }),
        }),
      (e: unknown) => e instanceof InvalidArgumentError && /out of bounds/.test(e.message),
    );
    // 区间跨块（不含于单一块）
    assert.throws(
      () =>
        w.mat.insertMaterialBranchOrigin({
          branchId: branchE.id,
          treeId: w.treeId,
          selection: selectionOf({
            start: 0,
            end: text.length,
            excerpt: text,
          }),
        }),
      (e: unknown) => e instanceof InvalidArgumentError && /not contained in block/.test(e.message),
    );
    // 空/逆序区间拒绝（schema CHECK end > start 的仓储层镜像）
    assert.throws(
      () =>
        w.mat.insertMaterialBranchOrigin({
          branchId: branchE.id,
          treeId: w.treeId,
          selection: selectionOf({ start: 3, end: 3, excerpt: "" }),
        }),
      (e: unknown) => e instanceof InvalidArgumentError && /out of bounds/.test(e.message),
    );
    // 分支不属于该树
    const forest2 = w.tree.createForest();
    const tree2 = w.tree.createTree(forest2.id);
    const foreignBranch = w.tree.createBranch(tree2.id, { parentBranchId: null });
    assert.throws(
      () =>
        w.mat.insertMaterialBranchOrigin({
          branchId: foreignBranch.id,
          treeId: w.treeId,
          selection: selectionOf(),
        }),
      (e: unknown) =>
        e instanceof InvalidArgumentError && /belongs to tree/.test(e.message),
    );

    // 非 ready 版本拒绝建枝（拒绝并给原因，不伪装成功）
    const failedMaterial = w.mat.createMaterial({ title: "加密 PDF" });
    const failed = importMarkdown(w.mat, failedMaterial.id, "", {
      bytes: utf8("%PDF-encrypted-payload"),
      parseStatus: "failed",
      parseError: "encrypted-pdf: no extractable text layer",
    });
    const failedBranch = w.tree.createBranch(w.treeId, { parentBranchId: w.trunkId });
    assert.throws(
      () =>
        w.mat.insertMaterialBranchOrigin({
          branchId: failedBranch.id,
          treeId: w.treeId,
          selection: {
            materialId: failedMaterial.id,
            versionId: failed.versionId,
            blockId: "blk-0",
            start: 0,
            end: 1,
            excerpt: "x",
            sourceHash: failed.sourceHash,
          },
        }),
      (e: unknown) =>
        e instanceof InvalidArgumentError && /not ready/.test(e.message) && /failed/.test(e.message),
    );
  });
});

test("old anchors stay readable after a new version is imported (immutable versions)", () => {
  withWorld((w) => {
    const material = w.mat.createMaterial({ title: "会改版的材料" });
    const textV1 = "旧版第一段。\n\n旧版第二段。";
    const v1 = importMarkdown(w.mat, material.id, textV1);
    const branch = w.tree.createBranch(w.treeId, { parentBranchId: w.trunkId });
    w.mat.insertMaterialBranchOrigin({
      branchId: branch.id,
      treeId: w.treeId,
      selection: {
        materialId: material.id,
        versionId: v1.versionId,
        blockId: "blk-0",
        start: 0,
        end: 6,
        excerpt: textV1.slice(0, 6),
        sourceHash: v1.sourceHash,
      },
    });

    // 内容变化 → 新版本；旧锚点原样可读（不迁移到相似文字）
    const textV2 = "新版第一段完全不同。\n\n新版第二段也变了。";
    const v2 = importMarkdown(w.mat, material.id, textV2);
    assert.notEqual(v2.versionId, v1.versionId);
    const origin = w.mat.getBranchOrigin(branch.id);
    assert.ok(origin !== null && origin.kind === "material");
    assert.equal(origin.origin.selection.versionId, v1.versionId, "anchor stays bound to the imported version");
    assert.equal(origin.origin.selection.excerpt, textV1.slice(0, 6));
    assert.equal(origin.origin.sourceHash, v1.sourceHash);
    assert.equal(w.mat.listVersions(material.id).length, 2);
  });
});

test("a branch cannot carry both a turn origin and a material origin; origin_kind stays consistent", () => {
  withWorld((w) => {
    // 既有 Turn 来源路径（TreeRepository.setBranchOrigin）
    const episode = w.tree.createEpisode(w.trunkId);
    const run = w.tree.createRun(episode.id, makeSessionReference());
    const answer = w.tree.createTurn({
      treeId: w.treeId,
      branchId: w.trunkId,
      episodeId: episode.id,
      runId: run.id,
      role: "assistant",
      text: "一条足以锚定的回答文本。",
      piEntryId: "entry-turn-1",
    });
    const child = w.tree.createBranch(w.treeId, { parentBranchId: w.trunkId });
    w.tree.setBranchOrigin({
      branchId: child.id,
      sourceBranchId: w.trunkId,
      anchorTurnId: answer.id,
      anchorEntryId: "entry-turn-1",
      selection: { start: 0, end: 4, text: "一条足以" },
    });

    // 材料来源拒绝（每枝至多一条来源，跨两张来源表）
    const material = w.mat.createMaterial({ title: "材料 B" });
    const { versionId, sourceHash } = importMarkdown(w.mat, material.id, "段落一。\n\n段落二。");
    assert.throws(
      () =>
        w.mat.insertMaterialBranchOrigin({
          branchId: child.id,
          treeId: w.treeId,
          selection: {
            materialId: material.id,
            versionId,
            blockId: "blk-0",
            start: 0,
            end: 4,
            excerpt: "段落一。",
            sourceHash,
          },
        }),
      (e: unknown) => e instanceof InvalidArgumentError && /already has a turn origin/.test(e.message),
    );

    // TreeRepository.setBranchOrigin 不写 origin_kind（0008 之前的既有 API）；
    // 对齐动作由 setBranchOriginKind 承担，且必须与来源表一致。
    assert.equal(w.mat.getBranchOriginKind(child.id), "none");
    w.mat.setBranchOriginKind(child.id, "turn");
    assert.equal(w.mat.getBranchOriginKind(child.id), "turn");
    // 与来源表不一致的设置拒绝（不静默改写）
    assert.throws(
      () => w.mat.setBranchOriginKind(child.id, "material"),
      (e: unknown) => e instanceof InvalidArgumentError && /origin kind 'material' requires/.test(e.message),
    );
    assert.throws(
      () => w.mat.setBranchOriginKind(child.id, "none"),
      (e: unknown) => e instanceof InvalidArgumentError && /origin kind 'none' requires/.test(e.message),
    );
    assert.throws(
      () => w.mat.setBranchOriginKind(w.trunkId, "turn"),
      (e: unknown) => e instanceof InvalidArgumentError && /origin kind 'turn' requires/.test(e.message),
    );
    assert.throws(
      () => w.mat.getBranchOriginKind("branch-missing" as BranchId),
      (e: unknown) => e instanceof EntityNotFoundError,
    );
  });
});

/* ------------------------------ 首问幂等 ------------------------------ */

test("material first questions are idempotent by (tree_id, intent_key)", () => {
  withWorld((w) => {
    const b1 = w.tree.createBranch(w.treeId, { parentBranchId: w.trunkId });
    const b2 = w.tree.createBranch(w.treeId, { parentBranchId: w.trunkId });

    const first = w.mat.insertFirstQuestion({ treeId: w.treeId, branchId: b1.id, intentKey: "intent-001" });
    assert.equal(first.replayed, false);
    assert.equal(first.question.branchId, b1.id);
    assert.equal(first.question.treeId, w.treeId);

    // 双击/响应丢失重试：同键同分支 → 同一行
    const retry = w.mat.insertFirstQuestion({ treeId: w.treeId, branchId: b1.id, intentKey: "intent-001" });
    assert.equal(retry.replayed, true);
    assert.equal(retry.question.branchId, b1.id);
    assert.equal(retry.question.createdAt, first.question.createdAt);

    // 进程重启后同键异分支重放：仍返回既有行（不重复建枝、不指向新分支）
    const stray = w.mat.insertFirstQuestion({ treeId: w.treeId, branchId: b2.id, intentKey: "intent-001" });
    assert.equal(stray.replayed, true);
    assert.equal(stray.question.branchId, b1.id, "replay returns the existing branch, not the stray one");

    // 不同键 → 新行
    const second = w.mat.insertFirstQuestion({ treeId: w.treeId, branchId: b2.id, intentKey: "intent-002" });
    assert.equal(second.replayed, false);
    assert.equal(second.question.branchId, b2.id);

    // 读路径
    assert.equal(w.mat.findFirstQuestion(w.treeId, "intent-001")?.branchId, b1.id);
    assert.equal(w.mat.findFirstQuestion(w.treeId, "intent-002")?.branchId, b2.id);
    assert.equal(w.mat.findFirstQuestion(w.treeId, "never-seen"), null);

    // 树/分支归属校验
    const forest2 = w.tree.createForest();
    const tree2 = w.tree.createTree(forest2.id);
    const branch2 = w.tree.createBranch(tree2.id, { parentBranchId: null });
    assert.throws(
      () => w.mat.insertFirstQuestion({ treeId: tree2.id, branchId: b1.id, intentKey: "intent-003" }),
      (e: unknown) => e instanceof InvalidArgumentError && /belongs to tree/.test(e.message),
    );
    assert.throws(
      () => w.mat.insertFirstQuestion({ treeId: tree2.id, branchId: branch2.id, intentKey: "" }),
      (e: unknown) => e instanceof InvalidArgumentError && /intent key/.test(e.message),
    );

    // 幂等键的树内作用域：另一棵树同键各自有效
    const otherTreeFirst = w.mat.insertFirstQuestion({ treeId: tree2.id, branchId: branch2.id, intentKey: "intent-001" });
    assert.equal(otherTreeFirst.replayed, false);

    const raw = new DatabaseSync(w.path, { readOnly: true });
    const rows = raw
      .prepare("SELECT tree_id, intent_key, branch_id FROM material_first_questions ORDER BY created_at, rowid")
      .all() as Array<{ tree_id: string; intent_key: string; branch_id: string }>;
    assert.equal(rows.length, 3, "two keys in tree 1, one key in tree 2");
    raw.close();
  });
});

/* ------------------------------ 树链接与阅读位置 ------------------------------ */

test("tree material links: link, idempotent re-link preserves linked_at, unlink", () => {
  withWorld((w) => {
    const m1 = w.mat.createMaterial({ title: "材料一" });
    const m2 = w.mat.createMaterial({ title: "材料二" });

    const link = w.mat.linkTreeMaterial(w.treeId, m1.id);
    assert.equal(link.materialId, m1.id);
    assert.deepEqual(w.mat.listTreeMaterials(w.treeId).map((m) => m.id), [m1.id]);
    assert.deepEqual(w.mat.listMaterials().map((m) => m.id), [m1.id, m2.id]);

    // 重链：返回既有链接（linked_at 保留首次时刻，不重写）
    assert.equal(w.mat.linkTreeMaterial(w.treeId, m1.id).linkedAt, link.linkedAt);

    w.mat.linkTreeMaterial(w.treeId, m2.id);
    assert.deepEqual(w.mat.listTreeMaterials(w.treeId).map((m) => m.id), [m1.id, m2.id]);

    // 一材料多树：第二棵树独立链接
    const forest2 = w.tree.createForest();
    const tree2 = w.tree.createTree(forest2.id);
    w.mat.linkTreeMaterial(tree2.id, m1.id);
    assert.deepEqual(w.mat.listTreeMaterials(tree2.id).map((m) => m.id), [m1.id]);

    // 未知树/材料拒绝
    assert.throws(() => w.mat.linkTreeMaterial("tree-none" as TreeId, m1.id), EntityNotFoundError);
    assert.throws(() => w.mat.linkTreeMaterial(w.treeId, "mat-none" as MaterialId), EntityNotFoundError);

    // 解除链接：幂等，只删链接行（阅读状态等产品事实不受影响）
    const { versionId } = importMarkdown(w.mat, m1.id, "内容一。\n\n内容二。");
    w.mat.upsertReadingPosition({ treeId: w.treeId, materialId: m1.id, versionId, blockId: "blk-0" });
    assert.equal(w.mat.unlinkTreeMaterial(w.treeId, m1.id), true);
    assert.equal(w.mat.unlinkTreeMaterial(w.treeId, m1.id), false);
    assert.deepEqual(w.mat.listTreeMaterials(w.treeId).map((m) => m.id), [m2.id]);
    const position = w.mat.findReadingPosition(w.treeId, m1.id);
    assert.ok(position !== null, "reading state survives unlink (product facts are not cascaded)");
    assert.equal(position?.blockId, "blk-0");
  });
});

test("reading positions upsert by (tree_id, material_id) with block discipline", () => {
  withWorld((w) => {
    const material = w.mat.createMaterial({ title: "阅读材料" });
    const text = "甲段落的内容。\n\n乙段落的内容。";
    const { versionId } = importMarkdown(w.mat, material.id, text);
    const blocks = markdownBlocks(text);
    const block1 = blocks[1]!;

    assert.equal(w.mat.findReadingPosition(w.treeId, material.id), null);

    const p1 = w.mat.upsertReadingPosition({ treeId: w.treeId, materialId: material.id, versionId, blockId: "blk-0" });
    assert.equal(p1.blockId, "blk-0");
    assert.equal(p1.focusStart, null);

    const p2 = w.mat.upsertReadingPosition({
      treeId: w.treeId,
      materialId: material.id,
      versionId,
      blockId: "blk-1",
      focusStart: block1.start,
    });
    const found = w.mat.findReadingPosition(w.treeId, material.id);
    assert.ok(found !== null);
    assert.equal(found?.versionId, versionId);
    assert.equal(found?.blockId, "blk-1");
    assert.equal(found?.focusStart, block1.start);
    assert.equal(found?.updatedAt, p2.updatedAt);

    // PK (tree_id, material_id)：整体替换而非追加
    const raw = new DatabaseSync(w.path, { readOnly: true });
    const count = raw
      .prepare("SELECT COUNT(*) AS n FROM tree_material_reading_state")
      .get() as { n: number };
    assert.equal(Number(count.n), 1);
    raw.close();

    // 块纪律
    assert.throws(
      () => w.mat.upsertReadingPosition({ treeId: w.treeId, materialId: material.id, versionId, blockId: "blk-9" }),
      (e: unknown) => e instanceof InvalidArgumentError && /does not exist/.test(e.message),
    );
    assert.throws(
      () =>
        w.mat.upsertReadingPosition({ treeId: w.treeId, materialId: material.id, versionId, focusStart: 1 }),
      (e: unknown) => e instanceof InvalidArgumentError && /focusStart requires blockId/.test(e.message),
    );
    assert.throws(
      () =>
        w.mat.upsertReadingPosition({
          treeId: w.treeId,
          materialId: material.id,
          versionId,
          blockId: "blk-0",
          focusStart: block1.end,
        }),
      (e: unknown) => e instanceof InvalidArgumentError && /outside block/.test(e.message),
    );
    // 版本必须属于该材料
    const other = w.mat.createMaterial({ title: "另一材料" });
    const otherVersion = importMarkdown(w.mat, other.id, "别的文本。");
    assert.throws(
      () =>
        w.mat.upsertReadingPosition({
          treeId: w.treeId,
          materialId: material.id,
          versionId: otherVersion.versionId,
        }),
      (e: unknown) => e instanceof InvalidArgumentError && /belongs to material/.test(e.message),
    );
  });
});
