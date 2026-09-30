/**
 * D4-5 数据可携带与可恢复 —— 可携带层测试（issue #8 D4-5；契约 §5）。
 *
 * 纪律（charter §5「导出恢复」）逐条落到断言：
 *  - 导出包：版本化（manifest schemaVersion/packageFormat/productSchemaVersion）
 *    + 冻结事实表全集 + 内容寻址 blobs + 逐条目 SHA-256；默认排除凭据/
 *    缓存/运行日志/Pi session；--include-sessions 显式包含并显著标注；
 *    --readable 附带人类可读 Markdown；同一库同一注入时钟逐字节确定；
 *    导出只读，源库逐字节不变。
 *  - 恢复：只允许空数据目录；全部验证在暂存区完成（schema/校验和/引用
 *    完整性/路径安全/超限）；原子落位；失败目标原样（含现有文件逐字节
 *    不变、无暂存残留）；随包 session 落位并改写引用、未随包引用保持
 *    原路径（不编造）。
 *  - 对抗性重签清单（校验和自洽但内容违规）：路径穿越/符号链接/多出
 *    文件/缺失条目/超限声明/伪造 schema 版本/列集漂移/NOT NULL 违例/
 *    悬空外键/主键重复/未知表/标注不匹配——全部必须拒绝且不落位。
 *  - CLI 解析面（export 子命令 / --import-package 互斥与错误）在
 *    cli.test.ts；真实进程级 CLI 走通（index.ts 模式接线）在
 *    tests/support/verifier/d4-b5-restore.ts（verify:d4 b5 行）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PiEntryId, PiSessionId, PiVersion } from "@treeai/contracts";
import { openDatabaseReadOnly } from "@treeai/persistence";
import {
  FACT_TABLES,
  MANIFEST_FILENAME,
  PortabilityError,
  SESSIONS_SENSITIVE_MARKER,
  SESSIONS_SENSITIVE_MARKER_TEXT,
  assertRestoreTargetEmpty,
  encodeFactsFile,
  encodeManifestFile,
  exportPackage,
  restorePackage,
  type ExportManifest,
  type FactsFileShape,
} from "../src/portability/index.ts";
import {
  buildRepresentativeDataset,
  compareProductDatabases,
  readTableRows,
  type RepresentativeDataset,
} from "./portability-helpers.ts";

/* ------------------------------------------------------------------ */
/* 测试辅助                                                             */
/* ------------------------------------------------------------------ */

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "treeai-portability-"));
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** 目录树字节快照（relPath → sha256；确定性比较的基础）。 */
function snapshotTree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (abs: string, rel: string): void => {
    for (const name of readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel === "" ? name.name : `${rel}/${name.name}`;
      const childAbs = join(abs, name.name);
      if (name.isDirectory()) walk(childAbs, childRel);
      else out.set(childRel, createHash("sha256").update(readFileSync(childAbs)).digest("hex"));
    }
  };
  walk(dir, "");
  return out;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** 构建代表性数据集并立即 dispose（磁盘保留，供导出消费）。 */
async function buildDataset(dir: string): Promise<RepresentativeDataset> {
  mkdirSync(dir, { recursive: true });
  const dataset = await buildRepresentativeDataset(dir);
  dataset.dispose();
  return dataset;
}

/** 读包清单（测试断言用；假定包合法）。 */
function readManifest(pkg: string): ExportManifest {
  return JSON.parse(readFileSync(join(pkg, MANIFEST_FILENAME), "utf8")) as ExportManifest;
}

/** 期待 PortabilityError(code)（同步路径）。 */
function assertPortabilityError(fn: () => unknown, code: string, context: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof PortabilityError, `${context}: expected PortabilityError, got ${String(caught)}`);
  assert.equal((caught as PortabilityError).code, code, `${context}: reason code`);
}

/** 递归拷贝整个包目录（破坏性试验不污染原件）。 */
function copyPackage(pkg: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  const walk = (source: string, target: string): void => {
    for (const name of readdirSync(source, { withFileTypes: true })) {
      const sourceChild = join(source, name.name);
      const targetChild = join(target, name.name);
      if (name.isDirectory()) {
        mkdirSync(targetChild, { recursive: true });
        walk(sourceChild, targetChild);
      } else {
        copyFileSync(sourceChild, targetChild);
      }
    }
  };
  walk(pkg, dest);
}

/**
 * 重签清单（对抗性辅助）：按包内实际文件重算全部条目 bytes/sha256，并按
 * facts 文件实际行数刷新 counts——用于让「篡改后校验和一致」的包到达更
 * 深层的校验层（形状/引用完整性/布局规则），而不是死在第一层校验和。
 */
function remintManifest(pkg: string): void {
  const manifest = readManifest(pkg);
  const counts: Record<string, number> = { ...manifest.counts };
  const entries = manifest.entries.map((entry) => {
    const bytes = readFileSync(join(pkg, ...entry.path.split("/")));
    if (entry.kind === "facts") {
      const table = entry.path.slice("facts/".length, -".json".length);
      counts[table] = (JSON.parse(bytes.toString("utf8")) as FactsFileShape).rows.length;
    }
    return {
      ...entry,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const reminted: ExportManifest = { ...manifest, counts, entries };
  writeFileSync(join(pkg, MANIFEST_FILENAME), encodeManifestFile(reminted), "utf8");
}

/** 篡改某个 facts 文件（parse → mutate → 稳定编码写回）。 */
function tamperFacts(pkg: string, table: string, mutate: (shape: FactsFileShape) => FactsFileShape): void {
  const path = join(pkg, "facts", `${table}.json`);
  const shape = JSON.parse(readFileSync(path, "utf8")) as FactsFileShape;
  writeFileSync(path, encodeFactsFile(mutate(shape)), "utf8");
}

/** 从恢复库读 session_references 的 (session_file → availability) 映射。 */
function readSessionReferences(dbPath: string): Map<string, string> {
  const db = openDatabaseReadOnly(dbPath);
  try {
    const rows = readTableRows(db, "session_references");
    const fileIndex = rows.length === 0 ? -1 : readTableColumns(db, "session_references").indexOf("session_file");
    const out = new Map<string, string>();
    for (const row of rows) {
      out.set(String(row[fileIndex]), "row");
    }
    return out;
  } finally {
    db.close();
  }
}

function readTableColumns(db: ReturnType<typeof openDatabaseReadOnly>, table: string): string[] {
  const spec = FACT_TABLES.find((candidate) => candidate.table === table);
  if (spec === undefined) throw new Error(`unknown fact table '${table}'`);
  return spec.columns.map((column) => column.name);
}

/* ------------------------------------------------------------------ */
/* 导出                                                                */
/* ------------------------------------------------------------------ */

test("export default: versioned package with frozen facts set, content-addressed blobs and per-entry checksums; sessions/credentials/logs excluded", async () => {
  const base = makeTempDir();
  try {
    const dataDir = join(base, "data");
    await buildDataset(dataDir);
    const pkg = join(base, "pkg");
    const sourceDbHash = sha256File(join(dataDir, "treeai.db"));

    const result = exportPackage({ dbPath: join(dataDir, "treeai.db"), outDir: pkg });

    /* 清单形状：版本化三件套 + 排序条目 + 逐条目校验和。 */
    const manifest = readManifest(pkg);
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.packageFormat, "treeai-export-1");
    assert.equal(manifest.productSchemaVersion, result.manifest.productSchemaVersion);
    assert.equal(manifest.includesSessions, false);
    assert.equal(manifest.readable, false);
    assert.ok(manifest.exportedAt.length > 0);
    const paths = manifest.entries.map((entry) => entry.path);
    assert.deepEqual([...paths], [...paths].slice().sort(), "manifest entries are sorted by path");
    for (const entry of manifest.entries) {
      assert.match(entry.sha256, /^[0-9a-f]{64}$/, `entry ${entry.path} checksum shape`);
      assert.equal(entry.bytes, readFileSync(join(pkg, ...entry.path.split("/"))).byteLength, `entry ${entry.path} byte count`);
    }

    /* 冻结事实表全集：每张表一个文件，行数与 counts 一致。 */
    const factPaths = new Set(paths.filter((path) => path.startsWith("facts/")));
    assert.equal(factPaths.size, FACT_TABLES.length, "every frozen fact table has a file");
    for (const spec of FACT_TABLES) {
      assert.ok(factPaths.has(`facts/${spec.table}.json`), `facts/${spec.table}.json present`);
      const shape = JSON.parse(readFileSync(join(pkg, "facts", `${spec.table}.json`), "utf8")) as FactsFileShape;
      assert.deepEqual(shape.columns, spec.columns.map((column) => column.name));
      assert.equal(shape.rows.length, manifest.counts[spec.table]);
    }

    /* blobs：内容寻址（文件名 = 原件 sha256），清单条目数 = 库内原件数。 */
    const blobEntries = manifest.entries.filter((entry) => entry.kind === "blob");
    assert.equal(blobEntries.length, 2, "two material originals (v1 + v2)");
    for (const entry of blobEntries) {
      assert.equal(entry.path.slice("blobs/".length), entry.sha256, "blob filename = content hash");
    }

    /* 默认排除面：无 session 条目、无敏感标注、无 readable；包根之外无杂物。 */
    assert.equal(manifest.entries.some((entry) => entry.kind === "session" || entry.kind === "marker"), false);
    assert.equal(existsSync(join(pkg, "sessions")), false);
    assert.equal(existsSync(join(pkg, SESSIONS_SENSITIVE_MARKER)), false);
    assert.equal(existsSync(join(pkg, "readable")), false);
    assert.deepEqual(
      readdirSync(pkg).sort(),
      ["blobs", "facts", "manifest.json"],
      "the default package carries only facts/blobs/manifest",
    );
    const manifestText = readFileSync(join(pkg, MANIFEST_FILENAME), "utf8");
    assert.equal(manifestText.includes("sess-main-0001"), false, "no session identifiers leak into the default manifest");

    /* 导出只读：源库逐字节不变（导出绝不写产品库）。 */
    assert.equal(sha256File(join(dataDir, "treeai.db")), sourceDbHash, "export never writes the source database");
  } finally {
    cleanup(base);
  }
});

test("export is byte-deterministic for the same database under an injected clock", async () => {
  const base = makeTempDir();
  try {
    const dataDir = join(base, "data");
    await buildDataset(dataDir);
    const frozenClock = (): string => "2026-10-01T00:00:00.000Z";
    const first = join(base, "pkg-a");
    const second = join(base, "pkg-b");
    exportPackage({ dbPath: join(dataDir, "treeai.db"), outDir: first, now: frozenClock });
    exportPackage({ dbPath: join(dataDir, "treeai.db"), outDir: second, now: frozenClock });
    assert.deepEqual(snapshotTree(first), snapshotTree(second), "same db + same clock → byte-identical package");
  } finally {
    cleanup(base);
  }
});

test("export --include-sessions: explicit opt-in copies referenced session files, marks the package sensitive and reports missing files honestly", async () => {
  const base = makeTempDir();
  try {
    const dataDir = join(base, "data");
    const dataset = await buildDataset(dataDir);
    const pkg = join(base, "pkg");
    const result = exportPackage({
      dbPath: join(dataDir, "treeai.db"),
      outDir: pkg,
      includeSessions: true,
    });

    assert.deepEqual(result.sessionFilesCopied, ["sess-main-0001.jsonl"], "the existing session is copied by basename");
    assert.deepEqual(
      result.sessionFilesMissing,
      [dataset.missingSessionFile],
      "the referenced-but-missing session is reported, never fabricated",
    );

    const manifest = readManifest(pkg);
    assert.equal(manifest.includesSessions, true);
    const sessionEntries = manifest.entries.filter((entry) => entry.kind === "session");
    assert.deepEqual(sessionEntries.map((entry) => entry.path), ["sessions/sess-main-0001.jsonl"]);
    assert.equal(manifest.counts["sessions"], 1);
    assert.equal(manifest.counts["sessionFilesMissing"], 1);

    /* 敏感内容显著标注：包根标记文件 + 原件逐字节一致。 */
    const markerBytes = readFileSync(join(pkg, SESSIONS_SENSITIVE_MARKER));
    assert.ok(markerBytes.byteLength > 0 && markerBytes.toString("utf8").includes("SENSITIVE"));
    assert.equal(
      readFileSync(join(pkg, "sessions", "sess-main-0001.jsonl"), "utf8"),
      readFileSync(dataset.existingSessionFile, "utf8"),
      "the copied session is byte-identical to the original",
    );
  } finally {
    cleanup(base);
  }
});

test("export --include-sessions refuses colliding session basenames instead of silently overwriting either file", async () => {
  const base = makeTempDir();
  try {
    const dataDir = join(base, "data");
    mkdirSync(dataDir, { recursive: true });
    const dataset = await buildRepresentativeDataset(dataDir);
    /* 追加第二条引用：不同目录、同名 basename（包布局要求唯一）。 */
    mkdirSync(join(dataDir, "elsewhere"), { recursive: true });
    const collidePath = join(dataDir, "elsewhere", "sess-main-0001.jsonl");
    writeFileSync(collidePath, "{}\n", "utf8");
    const episode = dataset.treeRepository.createEpisode(dataset.trunkBranchId);
    dataset.treeRepository.createRun(episode.id, {
      sessionId: "sess-collide" as PiSessionId,
      sessionFile: collidePath,
      entryId: "entry-x" as PiEntryId,
      piVersion: "pi-test-1" as PiVersion,
      availability: { status: "available" },
    });
    dataset.dispose();
    assertPortabilityError(
      () =>
        exportPackage({
          dbPath: join(dataDir, "treeai.db"),
          outDir: join(base, "pkg"),
          includeSessions: true,
        }),
      "session-name-collision",
      "colliding session basenames",
    );
    assert.equal(existsSync(join(base, "pkg")), false, "no half-written package remains");
  } finally {
    cleanup(base);
  }
});

test("export --readable renders human-readable markdown alongside the data package", async () => {
  const base = makeTempDir();
  try {
    const dataDir = join(base, "data");
    await buildDataset(dataDir);
    const pkg = join(base, "pkg");
    const result = exportPackage({ dbPath: join(dataDir, "treeai.db"), outDir: pkg, readable: true });

    const manifest = readManifest(pkg);
    assert.equal(manifest.readable, true);
    const readablePaths = manifest.entries.filter((entry) => entry.kind === "readable").map((entry) => entry.path);
    assert.ok(readablePaths.includes("readable/README.md"), "index present");
    assert.equal(manifest.counts["readableFiles"], readablePaths.length);

    /* 索引列出树与材料；树文件包含回合/Return/来源与术语批注。 */
    const readme = readFileSync(join(pkg, "readable", "README.md"), "utf8");
    assert.ok(readme.includes("## Trees") && readme.includes("## Materials"));
    const treePaths = readablePaths.filter((path) => path.startsWith("readable/trees/"));
    assert.equal(treePaths.length, 2, "both trees render a file");
    const treesText = treePaths.map((path) => readFileSync(join(pkg, ...path.split("/")), "utf8")).join("\n");
    assert.ok(treesText.includes("**return**"), "the Return turn is rendered");
    assert.ok(treesText.includes("Origin (material)"), "the material origin excerpt is rendered");
    assert.ok(treesText.includes("Origin (turn)"), "the turn origin excerpt is rendered");
    assert.ok(treesText.includes("轮廓系数"), "the terminology annotation text is rendered");
    assert.ok(treesText.includes("missing-file"), "the missing-session run is rendered honestly");
    const materialFile = readablePaths.find((path) => path.startsWith("readable/materials/"))!;
    const materialText = readFileSync(join(pkg, ...materialFile.split("/")), "utf8");
    assert.ok(materialText.includes("### v1 — ready") && materialText.includes("### v2 — ready"), "both versions listed");
    assert.ok(materialText.includes("K-means"), "canonical text of the ready versions is embedded for offline reading");
    assert.equal(result.entryCount, manifest.entries.length);
  } finally {
    cleanup(base);
  }
});

test("export guards: refuses a non-empty --out directory and a missing database", async () => {
  const base = makeTempDir();
  try {
    const dataDir = join(base, "data");
    await buildDataset(dataDir);

    /* 已存在且非空 → 拒绝（绝不混合两个包）。 */
    const occupied = join(base, "occupied");
    mkdirSync(occupied, { recursive: true });
    writeFileSync(join(occupied, "stale.txt"), "old package remains", "utf8");
    assertPortabilityError(
      () => exportPackage({ dbPath: join(dataDir, "treeai.db"), outDir: occupied }),
      "out-dir-not-empty",
      "non-empty out dir",
    );
    assert.equal(readFileSync(join(occupied, "stale.txt"), "utf8"), "old package remains", "the existing dir is untouched");

    /* 已存在的空目录 → 允许（清空目录后原子落位）。 */
    const emptyTarget = join(base, "empty-out");
    mkdirSync(emptyTarget, { recursive: true });
    exportPackage({ dbPath: join(dataDir, "treeai.db"), outDir: emptyTarget });
    assert.ok(existsSync(join(emptyTarget, MANIFEST_FILENAME)));

    /* 库缺失 → 明确失败；暂存区不留残留。 */
    assertPortabilityError(
      () => exportPackage({ dbPath: join(base, "no-such", "treeai.db"), outDir: join(base, "pkg2") }),
      "db-not-found",
      "missing database",
    );
    assert.equal(readdirSync(base).some((name) => name.startsWith(".treeai-export-")), false, "no staging residue");
  } finally {
    cleanup(base);
  }
});

/* ------------------------------------------------------------------ */
/* 恢复：正常路径                                                        */
/* ------------------------------------------------------------------ */

test("restore into an empty data directory rebuilds every fact table and blob byte-identically; saved excerpts survive", async () => {
  const base = makeTempDir();
  try {
    const dataDir = join(base, "data");
    const dataset = await buildDataset(dataDir);
    const pkg = join(base, "pkg");
    exportPackage({ dbPath: join(dataDir, "treeai.db"), outDir: pkg, readable: true });

    /* 目标不存在（全新目录）→ 恢复成功。 */
    const target = join(base, "restored");
    const result = restorePackage({ packageDir: pkg, dataDir: target });
    const expectedRows = FACT_TABLES.reduce((sum, spec) => sum + (result.manifest.counts[spec.table] ?? 0), 0);
    assert.equal(result.rowsRestored, expectedRows, "rows restored = manifest fact rows");
    assert.equal(result.blobsRestored, 2);
    assert.equal(result.sessionsRestored, 0, "the default package carries no sessions");

    /* 恢复目标只含产品面（treeai.db；journal/缓存/凭据不属于恢复面）。
       紧接恢复断言——本测试后续的只读连接会留下 WAL/SHM 伴生文件。 */
    assert.deepEqual(readdirSync(target).sort(), ["treeai.db"]);

    /* 全表逐行比较 + blobs 逐字节一致；session_file 保持原值（未随包）。 */
    const problems = compareProductDatabases(join(dataDir, "treeai.db"), join(target, "treeai.db"));
    assert.deepEqual(problems, [], "every fact table row and blob survives the round trip");

    /* 已保存摘录存活：恢复库上，材料来源锚点的 excerpt 仍是 v1 规范文本的真实切片。 */
    const { MaterialRepository } = await import("@treeai/persistence");
    const materials = MaterialRepository.open({ path: join(target, "treeai.db") });
    const v1Content = materials.getVersionContent(dataset.materialV1);
    materials.close();
    const targetDb = openDatabaseReadOnly(join(target, "treeai.db"));
    try {
      const origins = readTableRows(targetDb, "material_branch_origins");
      const originColumns = readTableColumns(targetDb, "material_branch_origins");
      const excerpt = String(origins[0]![originColumns.indexOf("excerpt")]);
      const start = Number(origins[0]![originColumns.indexOf("start")]);
      const end = Number(origins[0]![originColumns.indexOf("end")]);
      assert.equal(v1Content.canonicalText.slice(start, end), excerpt, "the saved excerpt still slices from the restored v1 text");
    } finally {
      targetDb.close();
    }
  } finally {
    cleanup(base);
  }
});

test("restore into an existing-but-empty directory works; carried sessions are placed, their references rewritten, missing references kept verbatim", async () => {
  const base = makeTempDir();
  try {
    const dataDir = join(base, "data");
    const dataset = await buildDataset(dataDir);
    dataset.dispose();
    const pkg = join(base, "pkg");
    exportPackage({ dbPath: join(dataDir, "treeai.db"), outDir: pkg, includeSessions: true });

    const target = join(base, "restored");
    mkdirSync(target, { recursive: true }); // 存在但为空 → 允许
    const result = restorePackage({ packageDir: pkg, dataDir: target });
    assert.equal(result.sessionsRestored, 1);
    assert.equal(result.sessionReferencesRewritten, 2, "session_references + tree_active_navigation rewritten");

    /* session 原件落位且逐字节一致；引用改写到恢复目录。 */
    assert.equal(
      readFileSync(join(target, "sessions", "sess-main-0001.jsonl"), "utf8"),
      readFileSync(dataset.existingSessionFile, "utf8"),
    );
    const problems = compareProductDatabases(join(dataDir, "treeai.db"), join(target, "treeai.db"), {
      expectedSessionsDir: join(target, "sessions"),
    });
    assert.deepEqual(problems, [], "all facts survive; carried session references point into the restored sessions dir");

    /* 未随包的引用（sess-gone-0002）保持原路径——绝不改写、绝不编造。 */
    const sessionFiles = readSessionReferences(join(target, "treeai.db"));
    const goneRow = [...sessionFiles.keys()].find((file) => file.includes("sess-gone-0002"));
    assert.ok(goneRow !== undefined, "the missing-session reference row exists");
    assert.equal(goneRow, dataset.missingSessionFile, "the missing-session reference keeps its original path");
    const carriedRow = [...sessionFiles.keys()].find((file) => file.includes("sess-main-0001"));
    assert.equal(carriedRow, join(target, "sessions", "sess-main-0001.jsonl"), "the carried reference is rewritten");
  } finally {
    cleanup(base);
  }
});

/* ------------------------------------------------------------------ */
/* 恢复：拒绝面（损坏/对抗/目标保护）                                     */
/* ------------------------------------------------------------------ */

test("a corrupted package is rejected before anything is placed: checksum mismatch, empty target stays empty, source untouched, no staging residue", async () => {
  const base = makeTempDir();
  try {
    const dataDir = join(base, "data");
    await buildDataset(dataDir);
    const pkg = join(base, "pkg");
    exportPackage({ dbPath: join(dataDir, "treeai.db"), outDir: pkg });

    /* 拷贝并翻转一个字节（facts/turns.json 中段）——现实损坏形态。 */
    const corrupt = join(base, "corrupt");
    copyPackage(pkg, corrupt);
    const turnsPath = join(corrupt, "facts", "turns.json");
    const bytes = readFileSync(turnsPath);
    bytes[Math.floor(bytes.byteLength / 2)] ^= 0x01;
    writeFileSync(turnsPath, bytes);

    const target = join(base, "restored");
    const sourceDbHash = sha256File(join(dataDir, "treeai.db"));
    assertPortabilityError(() => restorePackage({ packageDir: corrupt, dataDir: target }), "checksum-mismatch", "flipped byte");
    assert.equal(existsSync(target), false, "nothing is placed into the target on failure");
    assert.equal(sha256File(join(dataDir, "treeai.db")), sourceDbHash, "the source data stays untouched");
    assert.equal(
      readdirSync(base).some((name) => name.startsWith(".treeai-restore-")),
      false,
      "no staging residue is left behind",
    );
  } finally {
    cleanup(base);
  }
});

test("restore refuses a non-empty target and leaves the existing files byte-identical", async () => {
  const base = makeTempDir();
  try {
    const dataDir = join(base, "data");
    await buildDataset(dataDir);
    const pkg = join(base, "pkg");
    exportPackage({ dbPath: join(dataDir, "treeai.db"), outDir: pkg });

    const target = join(base, "occupied-target");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "precious.db"), "existing user data", "utf8");
    const before = snapshotTree(target);
    assertPortabilityError(
      () => restorePackage({ packageDir: pkg, dataDir: target }),
      "target-not-empty",
      "non-empty restore target",
    );
    assert.deepEqual(snapshotTree(target), before, "existing data is byte-identical after the refusal");

    /* 文件目标（非目录）同样拒绝。 */
    const fileTarget = join(base, "file-target");
    writeFileSync(fileTarget, "x", "utf8");
    assertPortabilityError(
      () => restorePackage({ packageDir: pkg, dataDir: fileTarget }),
      "target-not-a-directory",
      "file as restore target",
    );

    /* assertRestoreTargetEmpty 是恢复入口的独立护栏（供调用方预检）。 */
    assert.doesNotThrow(() => assertRestoreTargetEmpty(join(base, "not-created-yet")));
    assert.throws(
      () => assertRestoreTargetEmpty(target),
      (error: unknown) => error instanceof PortabilityError && error.code === "target-not-empty",
    );
  } finally {
    cleanup(base);
  }
});

test("restore rejects path traversal, symlinks, unexpected files, missing entries and oversized declarations", async () => {
  const base = makeTempDir();
  try {
    const dataDir = join(base, "data");
    await buildDataset(dataDir);
    const goodPkg = join(base, "pkg");
    exportPackage({ dbPath: join(dataDir, "treeai.db"), outDir: goodPkg });
    const targetFor = (name: string): string => join(base, `t-${name}`);

    /* 1) 清单条目路径穿越（../evil）——清单层即拒绝。 */
    {
      const pkg = join(base, "traversal");
      copyPackage(goodPkg, pkg);
      const manifest = readManifest(pkg);
      const [first, ...rest] = manifest.entries;
      const tampered: ExportManifest = {
        ...manifest,
        entries: [{ ...first!, path: "../evil.json" }, ...rest],
      };
      writeFileSync(join(pkg, MANIFEST_FILENAME), encodeManifestFile(tampered), "utf8");
      assertPortabilityError(
        () => restorePackage({ packageDir: pkg, dataDir: targetFor("traversal") }),
        "path-unsafe",
        "manifest path traversal",
      );
    }

    /* 2) 包内符号链接 → 拒绝（只允许常规文件）。 */
    {
      const pkg = join(base, "symlink");
      copyPackage(goodPkg, pkg);
      symlinkSync(join(pkg, MANIFEST_FILENAME), join(pkg, "facts", "link.json"));
      let caught: PortabilityError | null = null;
      try {
        restorePackage({ packageDir: pkg, dataDir: targetFor("symlink") });
      } catch (error) {
        caught = error as PortabilityError;
      }
      assert.ok(caught instanceof PortabilityError);
      assert.ok(caught.code === "path-unsafe" || caught.code === "unexpected-file", `symlink rejected (${caught.code})`);
    }

    /* 3) 包内多出的文件（清单未列）→ unexpected-file。 */
    {
      const pkg = join(base, "extra-file");
      copyPackage(goodPkg, pkg);
      writeFileSync(join(pkg, "facts", "zz-extra.json"), "{}\n", "utf8");
      assertPortabilityError(
        () => restorePackage({ packageDir: pkg, dataDir: targetFor("extra") }),
        "unexpected-file",
        "unlisted package file",
      );
    }

    /* 4) 清单列了但包内缺失 → missing-entry。 */
    {
      const pkg = join(base, "missing-entry");
      copyPackage(goodPkg, pkg);
      const blobFile = readdirSync(join(pkg, "blobs"))[0]!;
      rmSync(join(pkg, "blobs", blobFile));
      assertPortabilityError(
        () => restorePackage({ packageDir: pkg, dataDir: targetFor("missing") }),
        "missing-entry",
        "missing manifest entry",
      );
    }

    /* 5) 清单声明超限条目 → oversized-entry（读取前即拒绝）。 */
    {
      const pkg = join(base, "oversized");
      copyPackage(goodPkg, pkg);
      const manifest = readManifest(pkg);
      const [first, ...rest] = manifest.entries;
      const tampered: ExportManifest = {
        ...manifest,
        entries: [{ ...first!, bytes: 21 * 1024 * 1024 + 1 }, ...rest],
      };
      writeFileSync(join(pkg, MANIFEST_FILENAME), encodeManifestFile(tampered), "utf8");
      assertPortabilityError(
        () => restorePackage({ packageDir: pkg, dataDir: targetFor("oversized") }),
        "oversized-entry",
        "oversized declaration",
      );
    }

    /* 6) manifest.json 本身缺失/损坏 JSON → manifest-missing / manifest-invalid。 */
    {
      const pkg = join(base, "no-manifest");
      copyPackage(goodPkg, pkg);
      rmSync(join(pkg, MANIFEST_FILENAME));
      assertPortabilityError(
        () => restorePackage({ packageDir: pkg, dataDir: targetFor("no-manifest") }),
        "manifest-missing",
        "missing manifest",
      );
      writeFileSync(join(pkg, MANIFEST_FILENAME), "{ truncated", "utf8");
      assertPortabilityError(
        () => restorePackage({ packageDir: pkg, dataDir: targetFor("no-manifest") }),
        "manifest-invalid",
        "invalid manifest JSON",
      );
    }

    /* 7) 全部拒绝路径都没有落位任何目标。 */
    for (const name of ["traversal", "symlink", "extra", "missing", "oversized", "no-manifest"]) {
      assert.equal(existsSync(targetFor(name)), false, `target ${name} stays empty`);
    }
  } finally {
    cleanup(base);
  }
});

test("restore rejects adversarial packages whose checksums were re-minted: schema lies, shape drift, dangling foreign keys, duplicate keys, unknown tables, marker mismatches", async () => {
  const base = makeTempDir();
  try {
    const dataDir = join(base, "data");
    await buildDataset(dataDir);
    const goodPkg = join(base, "pkg");
    exportPackage({ dbPath: join(dataDir, "treeai.db"), outDir: goodPkg });
    const targetFor = (name: string): string => join(base, `t-${name}`);

    /* 伪造产品 schema 版本（包未重导出，版本对不上本构建布局）。 */
    {
      const pkg = join(base, "schema-lie");
      copyPackage(goodPkg, pkg);
      const manifest = readManifest(pkg);
      writeFileSync(
        join(pkg, MANIFEST_FILENAME),
        encodeManifestFile({ ...manifest, productSchemaVersion: manifest.productSchemaVersion + 1 }),
        "utf8",
      );
      assertPortabilityError(
        () => restorePackage({ packageDir: pkg, dataDir: targetFor("schema-lie") }),
        "schema-unsupported",
        "product schema lie",
      );
    }

    /* 列集漂移：facts 文件的 columns 与冻结布局不一致（重签后到达形状层）。 */
    {
      const pkg = join(base, "columns");
      copyPackage(goodPkg, pkg);
      tamperFacts(pkg, "terminology_state", (shape) => ({ ...shape, columns: ["key", "value", "extra"] }));
      remintManifest(pkg);
      assertPortabilityError(
        () => restorePackage({ packageDir: pkg, dataDir: targetFor("columns") }),
        "facts-invalid",
        "column drift",
      );
    }

    /* NOT NULL 违例：把必填格写成 null。 */
    {
      const pkg = join(base, "nullability");
      copyPackage(goodPkg, pkg);
      tamperFacts(pkg, "trees", (shape) => {
        const rows = shape.rows.map((row, index) => (index === 0 ? row.map((cell, i) => (i === 0 ? null : cell)) : row));
        return { ...shape, rows };
      });
      remintManifest(pkg);
      assertPortabilityError(
        () => restorePackage({ packageDir: pkg, dataDir: targetFor("nullability") }),
        "facts-invalid",
        "NOT NULL violation",
      );
    }

    /* 悬空外键：turns 行引用不存在的 tree。 */
    {
      const pkg = join(base, "dangling-fk");
      copyPackage(goodPkg, pkg);
      tamperFacts(pkg, "turns", (shape) => {
        const treeIndex = shape.columns.indexOf("tree_id");
        const rows = shape.rows.map((row, index) =>
          index === 0 ? row.map((cell, i) => (i === treeIndex ? "tree-no-such" : cell)) : row,
        );
        return { ...shape, rows };
      });
      remintManifest(pkg);
      assertPortabilityError(
        () => restorePackage({ packageDir: pkg, dataDir: targetFor("dangling-fk") }),
        "integrity-failed",
        "dangling foreign key",
      );
    }

    /* 主键重复：两行同 id。 */
    {
      const pkg = join(base, "dup-pk");
      copyPackage(goodPkg, pkg);
      tamperFacts(pkg, "materials", (shape) => {
        const rows = [...shape.rows];
        if (rows.length > 0) rows.push(rows[0]!);
        return { ...shape, rows };
      });
      remintManifest(pkg);
      assertPortabilityError(
        () => restorePackage({ packageDir: pkg, dataDir: targetFor("dup-pk") }),
        "integrity-failed",
        "duplicate primary key",
      );
    }

    /* 未知事实表文件（冻结全集之外的表，清单一致化后）→ unexpected-file。 */
    {
      const pkg = join(base, "unknown-table");
      copyPackage(goodPkg, pkg);
      const fakeShape: FactsFileShape = { table: "evil_table", columns: ["id"], rows: [] };
      writeFileSync(join(pkg, "facts", "evil_table.json"), encodeFactsFile(fakeShape), "utf8");
      const bytes = readFileSync(join(pkg, "facts", "evil_table.json"));
      const manifest = readManifest(pkg);
      const entries = [
        ...manifest.entries,
        { kind: "facts" as const, path: "facts/evil_table.json", bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") },
      ].sort((a, b) => (a.path < b.path ? -1 : 1));
      writeFileSync(
        join(pkg, MANIFEST_FILENAME),
        encodeManifestFile({ ...manifest, entries, counts: { ...manifest.counts, evil_table: 0 } }),
        "utf8",
      );
      assertPortabilityError(
        () => restorePackage({ packageDir: pkg, dataDir: targetFor("unknown-table") }),
        "unexpected-file",
        "unknown fact table",
      );
    }

    /* 无 session 的包携带敏感标注 → unexpected-file（标注双向一致）。 */
    {
      const pkg = join(base, "marker-lie");
      copyPackage(goodPkg, pkg);
      const markerBytes = Buffer.from(SESSIONS_SENSITIVE_MARKER_TEXT, "utf8");
      writeFileSync(join(pkg, SESSIONS_SENSITIVE_MARKER), markerBytes);
      const manifest = readManifest(pkg);
      const entries = [
        ...manifest.entries,
        {
          kind: "marker" as const,
          path: SESSIONS_SENSITIVE_MARKER,
          bytes: markerBytes.byteLength,
          sha256: createHash("sha256").update(markerBytes).digest("hex"),
        },
      ].sort((a, b) => (a.path < b.path ? -1 : 1));
      writeFileSync(join(pkg, MANIFEST_FILENAME), encodeManifestFile({ ...manifest, entries }), "utf8");
      assertPortabilityError(
        () => restorePackage({ packageDir: pkg, dataDir: targetFor("marker-lie") }),
        "unexpected-file",
        "sensitive marker without sessions",
      );
    }

    for (const name of ["schema-lie", "columns", "nullability", "dangling-fk", "dup-pk", "unknown-table", "marker-lie"]) {
      assert.equal(existsSync(targetFor(name)), false, `target ${name} stays empty`);
    }
  } finally {
    cleanup(base);
  }
});

test("restore of a sessions package refuses when a session file was dropped after export (checksum honesty)", async () => {
  const base = makeTempDir();
  try {
    const dataDir = join(base, "data");
    await buildDataset(dataDir);
    const pkg = join(base, "pkg");
    exportPackage({ dbPath: join(dataDir, "treeai.db"), outDir: pkg, includeSessions: true });

    const tampered = join(base, "dropped-session");
    copyPackage(pkg, tampered);
    rmSync(join(tampered, "sessions", "sess-main-0001.jsonl"));
    assertPortabilityError(
      () => restorePackage({ packageDir: tampered, dataDir: join(base, "t-dropped") }),
      "missing-entry",
      "session dropped after export",
    );
    assert.equal(existsSync(join(base, "t-dropped")), false);
  } finally {
    cleanup(base);
  }
});
