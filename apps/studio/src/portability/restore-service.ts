/**
 * D4-5 数据可携带 —— 恢复服务（issue #8 D4-5；契约 §5）。
 *
 * `--import-package <dir>`：把导出包恢复到**空数据目录**。
 *
 * 纪律（charter §5 / 契约 §5「导入流程」）：
 *  1. 目标只允许空数据目录（不存在或零条目；非空 → 明确拒绝）；
 *  2. 全部验证先在**暂存区**完成（与目标同文件系统的临时目录），任何
 *     失败目标原封不动：
 *     - 清单 schema/格式/产品 schema 版本（facts 布局必须与本构建一致）；
 *     - 条目完整性：包内文件与清单**双向全量比对**（多出的文件、缺失的
 *       文件、字节大小、SHA-256 校验和逐项复核）；
 *     - 路径安全：拒绝路径穿越/绝对路径/反斜杠/控制字符/命名违规与
 *       超限条目/超限包；拒绝符号链接；
 *     - facts 形状：列集与冻结布局逐列相等、行/格类型与 nullability 复核；
 *     - 引用完整性：全外键闭包 + 主键唯一性（跨文件校验；落库时 SQL
 *       FK/CHECK/触发器为第二层防御）；
 *     - 落库后 `PRAGMA foreign_key_check` + `PRAGMA integrity_check`；
 *  3. 验证全部通过后**原子落位**（暂存目录 rename 为目标数据目录——
 *     目标不存在或为空目录时才执行；rename 前再复核一次空目录）；
 *  4. 含 session 的包（显式导出选项）：session 原件落到 <data>/sessions/，
 *     session 引用行改写为恢复后的新路径（可续聊）；未含 session 的包
 *     保持原引用路径——指向不存在的旧位置，可用性探针如实判
 *     missing-file（fail-closed + 显式新探索，charter §1 路径 6）。
 *
 * 恢复承诺边界（charter §5）：产品事实可读 + 可显式新探索；不承诺旧 Pi
 * 上下文可续。恢复到非空目录/合并两个已使用库**明确不在**首版范围。
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, rmdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "@treeai/persistence";
import {
  EXPORT_PACKAGE_FORMAT,
  FACT_TABLES,
  FACT_TABLES_BY_NAME,
  FACTS_LAYOUT_SCHEMA_VERSION,
  MANIFEST_FILENAME,
  MANIFEST_SCHEMA_VERSION,
  MAX_ENTRY_COUNT,
  MAX_TOTAL_PACKAGE_BYTES,
  PortabilityError,
  RESTORE_INSERT_ORDER,
  SESSIONS_SENSITIVE_MARKER,
  TABLE_PRIMARY_KEYS,
  assertBlobFileName,
  assertFactsLayoutCurrent,
  assertSafePackagePath,
  assertSessionFileName,
  maxEntryBytesForKind,
  type ExportManifest,
  type ExportManifestEntry,
  type FactTableSpec,
  type FactsFileShape,
  type ManifestEntryKind,
} from "./package-format.ts";

/* ------------------------------------------------------------------ */
/* 选项与结果                                                           */
/* ------------------------------------------------------------------ */

export interface RestorePackageOptions {
  /** 导出包目录（含 manifest.json）。 */
  readonly packageDir: string;
  /** 恢复目标数据目录：必须为空（不存在或零条目）。 */
  readonly dataDir: string;
}

export interface RestorePackageResult {
  readonly dataDir: string;
  readonly manifest: ExportManifest;
  /** 恢复的事实行数（全表合计）。 */
  readonly rowsRestored: number;
  /** 恢复的材料原件数。 */
  readonly blobsRestored: number;
  /** 恢复的 session 文件数（未含 session 的包为 0）。 */
  readonly sessionsRestored: number;
  /** session 引用改写数（指向 <data>/sessions/ 的行数）。 */
  readonly sessionReferencesRewritten: number;
}

/* ------------------------------------------------------------------ */
/* 主入口                                                               */
/* ------------------------------------------------------------------ */

export function restorePackage(options: RestorePackageOptions): RestorePackageResult {
  assertFactsLayoutCurrent();
  const { packageDir, dataDir } = options;
  if (typeof packageDir !== "string" || packageDir.trim().length === 0) {
    throw new PortabilityError("package-invalid", "the --import-package directory must be a non-empty path");
  }
  if (typeof dataDir !== "string" || dataDir.trim().length === 0) {
    throw new PortabilityError("data-dir-invalid", "the --data directory must be a non-empty path");
  }
  if (!existsSync(packageDir) || !statSync(packageDir).isDirectory()) {
    throw new PortabilityError("package-not-found", `the package directory '${packageDir}' does not exist or is not a directory`);
  }

  /* 目标早检查（快速失败；落位前会再复核）。 */
  assertRestoreTargetEmpty(dataDir);

  /* ---- 阶段 1：清单与条目完整性（只读包目录） ---- */
  const manifest = readAndValidateManifest(packageDir);
  const packageFiles = walkPackageFiles(packageDir);
  const { blobs, facts, sessions, readableCount } = validateEntriesAndRead(packageDir, manifest, packageFiles);

  /* ---- 阶段 2：facts 形状 + 引用完整性（纯内存） ---- */
  validateFactsShapes(facts);
  validateReferentialIntegrity(facts, blobs);

  /* ---- 阶段 3：暂存区构建 + 落库 + 库级校验 ---- */
  const parent = dirname(dataDir);
  mkdirSync(parent, { recursive: true });
  const staging = mkdtempSync(join(parent, ".treeai-restore-"));
  try {
    const opened = openDatabase({ path: join(staging, "treeai.db"), wal: false });
    let rowsRestored = 0;
    let sessionReferencesRewritten = 0;
    try {
      const sessionBasenames = new Set(sessions.map((session) => session.basename));
      sessionReferencesRewritten = insertAllFacts(opened.db, facts, blobs, dataDir, sessionBasenames);
      rowsRestored = RESTORE_INSERT_ORDER.reduce((sum, table) => sum + (facts.get(table)?.rows.length ?? 0), 0);
      const fkProblems = opened.db.prepare("PRAGMA foreign_key_check").all() as unknown[];
      if (fkProblems.length > 0) {
        throw new PortabilityError(
          "integrity-failed",
          `restored database reports ${fkProblems.length} foreign key violation(s) (foreign_key_check)`,
        );
      }
      const integrity = opened.db.prepare("PRAGMA integrity_check").all() as unknown as Array<{ integrity_check: string }>;
      if (!(integrity.length === 1 && integrity[0]!.integrity_check === "ok")) {
        throw new PortabilityError(
          "integrity-failed",
          `restored database fails integrity_check: ${integrity.map((row) => row.integrity_check).join("; ")}`,
        );
      }
    } finally {
      opened.db.close();
    }
    if (readdirSync(staging).some((name) => name.startsWith("treeai.db-"))) {
      throw new PortabilityError("integrity-failed", "the staged database left WAL/SHM sidecar files behind");
    }

    /* sessions 原件落位（<data>/sessions/）。 */
    for (const session of sessions) {
      mkdirSync(join(staging, "sessions"), { recursive: true });
      copyFileSync(join(packageDir, "sessions", session.basename), join(staging, "sessions", session.basename));
    }

    /* ---- 阶段 4：原子落位（rename 前复核空目录） ---- */
    assertRestoreTargetEmpty(dataDir);
    if (existsSync(dataDir)) {
      rmdirSync(dataDir); // 仅空目录可成功——非空即失败且目标原样保留。
    }
    renameSync(staging, dataDir);
    return {
      dataDir,
      manifest,
      rowsRestored,
      blobsRestored: blobs.length,
      sessionsRestored: sessions.length,
      sessionReferencesRewritten,
    };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* 阶段 1：清单 / 目录遍历 / 条目校验                                   */
/* ------------------------------------------------------------------ */

function readAndValidateManifest(packageDir: string): ExportManifest {
  const manifestPath = join(packageDir, MANIFEST_FILENAME);
  if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) {
    throw new PortabilityError("manifest-missing", `the package has no ${MANIFEST_FILENAME} at '${manifestPath}'`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new PortabilityError(
      "manifest-invalid",
      `${MANIFEST_FILENAME} is not valid JSON (truncated or corrupted package): ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const manifest = parsed as Partial<ExportManifest>;
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new PortabilityError(
      "schema-unsupported",
      `package manifest schemaVersion ${String(manifest.schemaVersion)} is not supported (expected ${MANIFEST_SCHEMA_VERSION})`,
    );
  }
  if (manifest.packageFormat !== EXPORT_PACKAGE_FORMAT) {
    throw new PortabilityError(
      "schema-unsupported",
      `package format '${String(manifest.packageFormat)}' is not '${EXPORT_PACKAGE_FORMAT}'`,
    );
  }
  if (manifest.productSchemaVersion !== FACTS_LAYOUT_SCHEMA_VERSION) {
    throw new PortabilityError(
      "schema-unsupported",
      `package product schema version ${String(manifest.productSchemaVersion)} does not match this build's facts layout ` +
        `${FACTS_LAYOUT_SCHEMA_VERSION}; packages are only portable between identical fact layouts ` +
        "(re-export from an up-to-date studio)",
    );
  }
  if (typeof manifest.exportedAt !== "string" || manifest.exportedAt.length === 0) {
    throw new PortabilityError("manifest-invalid", "manifest.exportedAt must be a non-empty string");
  }
  if (typeof manifest.includesSessions !== "boolean") {
    throw new PortabilityError("manifest-invalid", "manifest.includesSessions must be a boolean");
  }
  if (typeof manifest.readable !== "boolean") {
    throw new PortabilityError("manifest-invalid", "manifest.readable must be a boolean");
  }
  if (!Array.isArray(manifest.entries)) {
    throw new PortabilityError("manifest-invalid", "manifest.entries must be an array");
  }
  if (manifest.entries.length > MAX_ENTRY_COUNT) {
    throw new PortabilityError(
      "oversized-package",
      `package lists ${manifest.entries.length} entries, exceeding the ${MAX_ENTRY_COUNT}-entry limit`,
    );
  }
  const seenPaths = new Set<string>();
  let totalBytes = 0;
  for (const entry of manifest.entries as readonly ExportManifestEntry[]) {
    if (entry === null || typeof entry !== "object") {
      throw new PortabilityError("manifest-invalid", "manifest.entries contains a non-object entry");
    }
    if (typeof entry.path !== "string" || typeof entry.bytes !== "number" || typeof entry.sha256 !== "string") {
      throw new PortabilityError(
        "manifest-invalid",
        `manifest entry needs string path / number bytes / string sha256 (got '${String(entry.path)}')`,
      );
    }
    assertSafePackagePath(entry.path, "manifest entry");
    if (entry.path === MANIFEST_FILENAME) {
      throw new PortabilityError("manifest-invalid", `the manifest must not list itself ('${MANIFEST_FILENAME}')`);
    }
    if (seenPaths.has(entry.path)) {
      throw new PortabilityError("manifest-invalid", `manifest lists duplicate entry path '${entry.path}'`);
    }
    seenPaths.add(entry.path);
    if (!/^[0-9a-f]{64}$/.test(entry.sha256)) {
      throw new PortabilityError("manifest-invalid", `manifest entry '${entry.path}' has a malformed sha256`);
    }
    if (!Number.isInteger(entry.bytes) || entry.bytes < 0) {
      throw new PortabilityError("manifest-invalid", `manifest entry '${entry.path}' has a malformed byte count`);
    }
    if (entry.bytes > maxEntryBytesForKind(entry.kind as ManifestEntryKind)) {
      throw new PortabilityError(
        "oversized-entry",
        `manifest entry '${entry.path}' declares ${entry.bytes} bytes, exceeding the ${entry.kind} per-entry limit`,
      );
    }
    totalBytes += entry.bytes;
  }
  if (totalBytes > MAX_TOTAL_PACKAGE_BYTES) {
    throw new PortabilityError(
      "oversized-package",
      `package declares ${totalBytes} bytes total, exceeding the ${MAX_TOTAL_PACKAGE_BYTES}-byte package limit`,
    );
  }
  return {
    schemaVersion: manifest.schemaVersion,
    packageFormat: manifest.packageFormat,
    productSchemaVersion: manifest.productSchemaVersion,
    exportedAt: manifest.exportedAt,
    includesSessions: manifest.includesSessions,
    readable: manifest.readable,
    counts: manifest.counts ?? {},
    entries: manifest.entries as readonly ExportManifestEntry[],
  };
}

interface WalkedFile {
  readonly relPath: string;
  readonly absPath: string;
}

/** 全量遍历包目录（拒绝符号链接；返回全部文件）。 */
function walkPackageFiles(packageDir: string): WalkedFile[] {
  const files: WalkedFile[] = [];
  const walk = (absDir: string, relDir: string): void => {
    let names: string[];
    try {
      names = readdirSync(absDir);
    } catch (error) {
      throw new PortabilityError(
        "package-invalid",
        `cannot read package directory '${absDir}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    for (const name of names) {
      const absPath = join(absDir, name);
      const relPath = relDir === "" ? name : `${relDir}/${name}`;
      let stats;
      try {
        stats = lstatSync(absPath);
      } catch (error) {
        throw new PortabilityError(
          "package-invalid",
          `cannot stat package entry '${relPath}': ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (stats.isSymbolicLink()) {
        throw new PortabilityError(
          "path-unsafe",
          `package entry '${relPath}' is a symbolic link; packages must contain regular files only`,
        );
      }
      if (stats.isDirectory()) {
        walk(absPath, relPath);
        continue;
      }
      if (!stats.isFile()) {
        throw new PortabilityError(
          "path-unsafe",
          `package entry '${relPath}' is not a regular file (fifo/socket/device)`,
        );
      }
      assertSafePackagePath(relPath, "package file");
      files.push({ relPath, absPath });
    }
  };
  walk(packageDir, "");
  return files;
}

interface LoadedBlob {
  readonly hash: string;
  readonly bytes: Uint8Array;
}

interface LoadedSession {
  readonly basename: string;
  readonly bytes: Uint8Array;
}

interface LoadedPackage {
  readonly blobs: readonly LoadedBlob[];
  readonly facts: ReadonlyMap<string, FactsFileShape>;
  readonly sessions: readonly LoadedSession[];
  readonly readableCount: number;
}

/**
 * 条目与包目录双向全量比对 + 校验和复核 + 逐种类命名/布局规则。
 * 读取阶段顺带把 blobs/facts/sessions 装入内存（后续校验与落库共用）。
 */
function validateEntriesAndRead(
  packageDir: string,
  manifest: ExportManifest,
  packageFiles: readonly WalkedFile[],
): LoadedPackage {
  const manifestPaths = new Set(manifest.entries.map((entry) => entry.path));
  const actualPaths = new Set(packageFiles.map((file) => file.relPath));

  /* 包内每个文件（除 manifest.json）必须在清单里。 */
  for (const file of packageFiles) {
    if (file.relPath === MANIFEST_FILENAME) continue;
    if (!manifestPaths.has(file.relPath)) {
      throw new PortabilityError(
        "unexpected-file",
        `package contains a file that the manifest does not list: '${file.relPath}' ` +
          "(unexpected files are rejected — the manifest is the complete entry list)",
      );
    }
  }
  /* 清单每个条目必须是包内真实存在的文件。 */
  for (const path of manifestPaths) {
    if (!actualPaths.has(path)) {
      throw new PortabilityError("missing-entry", `manifest lists '${path}' but the package has no such file`);
    }
  }
  if (!actualPaths.has(MANIFEST_FILENAME)) {
    throw new PortabilityError("manifest-missing", `the package has no ${MANIFEST_FILENAME}`);
  }

  const factsByPath = new Map<string, ExportManifestEntry>();
  const blobs: LoadedBlob[] = [];
  const sessions: LoadedSession[] = [];
  let readableCount = 0;
  let sawSensitiveMarker = false;
  const filesByPath = new Map(packageFiles.map((file) => [file.relPath, file]));
  const hashOf = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

  for (const entry of manifest.entries) {
    const file = filesByPath.get(entry.path);
    if (file === undefined) {
      throw new PortabilityError("missing-entry", `manifest lists '${entry.path}' but the package has no such file`);
    }
    const bytes = new Uint8Array(readFileSync(file.absPath));
    if (bytes.byteLength !== entry.bytes) {
      throw new PortabilityError(
        "checksum-mismatch",
        `entry '${entry.path}' is ${bytes.byteLength} bytes but the manifest declares ${entry.bytes}`,
      );
    }
    if (bytes.byteLength > maxEntryBytesForKind(entry.kind)) {
      throw new PortabilityError(
        "oversized-entry",
        `entry '${entry.path}' is ${bytes.byteLength} bytes, exceeding the ${entry.kind} per-entry limit`,
      );
    }
    const sha256 = hashOf(bytes);
    if (sha256 !== entry.sha256) {
      throw new PortabilityError(
        "checksum-mismatch",
        `entry '${entry.path}' fails its SHA-256 checksum (package tampered or corrupted)`,
      );
    }
    switch (entry.kind) {
      case "facts": {
        assertFactsEntryPath(entry.path);
        const table = entry.path.slice("facts/".length, -".json".length);
        if (factsByPath.has(table)) {
          throw new PortabilityError("manifest-invalid", `manifest lists facts table '${table}' twice`);
        }
        factsByPath.set(table, entry);
        break;
      }
      case "blob": {
        assertBlobFileName(entry.path, "blob entry");
        const hash = entry.path.slice("blobs/".length);
        if (hash !== sha256) {
          throw new PortabilityError(
            "checksum-mismatch",
            `blob entry '${entry.path}' content hash ${sha256} does not match its content-addressed filename`,
          );
        }
        blobs.push({ hash, bytes });
        break;
      }
      case "session": {
        assertSessionFileName(entry.path, "session entry");
        if (!manifest.includesSessions) {
          throw new PortabilityError(
            "unexpected-file",
            `session entry '${entry.path}' present while manifest.includesSessions is false`,
          );
        }
        sessions.push({ basename: entry.path.slice("sessions/".length), bytes });
        break;
      }
      case "readable": {
        if (!entry.path.startsWith("readable/")) {
          throw new PortabilityError("path-unsafe", `readable entry '${entry.path}' must live under readable/`);
        }
        if (!manifest.readable) {
          throw new PortabilityError("unexpected-file", `readable entry '${entry.path}' present while manifest.readable is false`);
        }
        readableCount += 1;
        break;
      }
      case "marker": {
        if (entry.path !== SESSIONS_SENSITIVE_MARKER) {
          throw new PortabilityError("unexpected-file", `unknown marker entry '${entry.path}'`);
        }
        sawSensitiveMarker = true;
        break;
      }
      default:
        throw new PortabilityError("manifest-invalid", `entry '${entry.path}' has unknown kind '${String(entry.kind)}'`);
    }
  }

  /* facts 文件集必须是冻结全集（多/少都拒绝）。 */
  const expectedTables = new Set(FACT_TABLES.map((spec) => spec.table));
  const actualTables = new Set(factsByPath.keys());
  for (const table of expectedTables) {
    if (!actualTables.has(table)) {
      throw new PortabilityError(
        "manifest-invalid",
        `package facts set is missing 'facts/${table}.json' (the frozen fact-table set must be complete)`,
      );
    }
  }
  for (const table of actualTables) {
    if (!expectedTables.has(table)) {
      throw new PortabilityError(
        "unexpected-file",
        `package facts set contains unknown table 'facts/${table}.json'`,
      );
    }
  }

  /* session 包必须携带敏感标注；无 session 的包不得携带标注。 */
  if (manifest.includesSessions && !sawSensitiveMarker) {
    throw new PortabilityError(
      "manifest-invalid",
      `a package with sessions must carry the sensitive-content marker '${SESSIONS_SENSITIVE_MARKER}'`,
    );
  }
  if (!manifest.includesSessions && sawSensitiveMarker) {
    throw new PortabilityError("unexpected-file", `the sensitive marker '${SESSIONS_SENSITIVE_MARKER}' appears without sessions`);
  }

  /* 解析全部 facts 文件 + 清单 counts 与实际行数交叉复核（篡改清单即失败）。 */
  const facts = new Map<string, FactsFileShape>();
  for (const spec of FACT_TABLES) {
    facts.set(spec.table, parseFactsFile(spec.table, packageDir));
  }
  for (const table of expectedTables) {
    const declared = manifest.counts[table];
    if (declared !== undefined && declared !== facts.get(table)!.rows.length) {
      throw new PortabilityError(
        "manifest-invalid",
        `manifest counts['${table}'] = ${String(declared)} but facts/${table}.json carries ${facts.get(table)!.rows.length} rows`,
      );
    }
  }
  const declaredBlobs = manifest.counts["blobs"];
  if (declaredBlobs !== undefined && declaredBlobs !== blobs.length) {
    throw new PortabilityError(
      "manifest-invalid",
      `manifest counts.blobs = ${String(declaredBlobs)} but the package carries ${blobs.length} blob files`,
    );
  }

  return { blobs, facts, sessions, readableCount };
}

function assertFactsEntryPath(path: string): void {
  const match = /^facts\/([a-z_]+)\.json$/.exec(path);
  if (match === null) {
    throw new PortabilityError("path-unsafe", `facts entry '${path}' must be 'facts/<table>.json'`);
  }
}

/** 解析单个 facts 文件（JSON 形状初步校验；列/类型校验见 validateFactsShapes）。 */
function parseFactsFile(table: string, packageDir: string): FactsFileShape {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(packageDir, "facts", `${table}.json`), "utf8"));
  } catch (error) {
    throw new PortabilityError(
      "facts-invalid",
      `facts/${table}.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const shape = parsed as Partial<FactsFileShape>;
  if (shape.table !== table || !Array.isArray(shape.columns) || !Array.isArray(shape.rows)) {
    throw new PortabilityError(
      "facts-invalid",
      `facts/${table}.json must be {table: "${table}", columns: [...], rows: [...]}`,
    );
  }
  return { table, columns: shape.columns, rows: shape.rows as FactsFileShape["rows"] };
}

/* ------------------------------------------------------------------ */
/* 阶段 2：facts 形状 + 引用完整性                                       */
/* ------------------------------------------------------------------ */

function validateFactsShapes(facts: ReadonlyMap<string, FactsFileShape>): void {
  for (const spec of FACT_TABLES) {
    const shape = facts.get(spec.table);
    if (shape === undefined) {
      throw new PortabilityError("facts-invalid", `facts snapshot is missing table '${spec.table}'`);
    }
    const expected = spec.columns.map((column) => column.name).join(",");
    const actual = shape.columns.join(",");
    if (expected !== actual) {
      throw new PortabilityError(
        "facts-invalid",
        `facts/${spec.table}.json columns [${actual}] do not match the frozen layout [${expected}]`,
      );
    }
    for (let rowIndex = 0; rowIndex < shape.rows.length; rowIndex += 1) {
      const row = shape.rows[rowIndex]!;
      if (!Array.isArray(row) || row.length !== spec.columns.length) {
        throw new PortabilityError(
          "facts-invalid",
          `facts/${spec.table}.json row ${rowIndex} has ${String(Array.isArray(row) ? row.length : "non-array")} cells (expected ${spec.columns.length})`,
        );
      }
      for (let cellIndex = 0; cellIndex < spec.columns.length; cellIndex += 1) {
        const column = spec.columns[cellIndex]!;
        const cell = row[cellIndex];
        if (cell === null) {
          if (!column.nullable) {
            throw new PortabilityError(
              "facts-invalid",
              `facts/${spec.table}.json row ${rowIndex}: column '${column.name}' is NOT NULL but carries null`,
            );
          }
          continue;
        }
        if (column.kind === "text" && typeof cell !== "string") {
          throw new PortabilityError(
            "facts-invalid",
            `facts/${spec.table}.json row ${rowIndex}: column '${column.name}' must be a string (got '${typeof cell}')`,
          );
        }
        if (column.kind === "integer" && (!Number.isInteger(cell) || typeof cell !== "number")) {
          throw new PortabilityError(
            "facts-invalid",
            `facts/${spec.table}.json row ${rowIndex}: column '${column.name}' must be an integer`,
          );
        }
      }
    }
  }
}

/** 引用完整性：全外键闭包 + 主键唯一性（blobs 以内容寻址集合参与）。 */
function validateReferentialIntegrity(
  facts: ReadonlyMap<string, FactsFileShape>,
  blobs: readonly LoadedBlob[],
): void {
  /* 主键值集合（表 → 键串集合）。 */
  const keysByTable = new Map<string, Set<string>>();
  for (const spec of FACT_TABLES) {
    const shape = facts.get(spec.table)!;
    const pk = TABLE_PRIMARY_KEYS[spec.table]!;
    const pkIndexes = pk.map((column) => shape.columns.indexOf(column));
    const set = new Set<string>();
    for (const row of shape.rows) {
      const key = pkIndexes.map((index) => encodeKeyCell(row[index] ?? null)).join(" ");
      if (set.has(key)) {
        throw new PortabilityError(
          "integrity-failed",
          `facts/${spec.table}.json has duplicate primary key [${pk.join(", ")}] = [${key.replaceAll(" ", ", ")}]`,
        );
      }
      set.add(key);
    }
    keysByTable.set(spec.table, set);
  }
  const blobHashes = new Set(blobs.map((blob) => blob.hash));

  /* 外键闭包（FK 目标列恒为各表首主键列——见 TABLE_PRIMARY_KEYS/FK 声明）。 */
  for (const spec of FACT_TABLES) {
    const shape = facts.get(spec.table)!;
    for (const foreignKey of spec.foreignKeys) {
      const columnIndex = shape.columns.indexOf(foreignKey.column);
      if (columnIndex < 0) {
        throw new PortabilityError("facts-layout-invalid", `table '${spec.table}' has no FK column '${foreignKey.column}'`);
      }
      const [refTable = "", refColumn = ""] = foreignKey.references.split(".");
      let target: Set<string>;
      if (refTable === "material_blobs") {
        if (refColumn !== "content_hash") {
          throw new PortabilityError("facts-layout-invalid", `unexpected blob FK target '${foreignKey.references}'`);
        }
        target = blobHashes;
      } else {
        const refSpec = FACT_TABLES_BY_NAME.get(refTable);
        if (refSpec === undefined) {
          throw new PortabilityError("facts-layout-invalid", `FK references unknown table '${refTable}'`);
        }
        const refPk = TABLE_PRIMARY_KEYS[refTable] ?? [];
        if (refPk[0] !== refColumn) {
          throw new PortabilityError(
            "facts-layout-invalid",
            `FK target '${foreignKey.references}' must be the referenced table's primary key`,
          );
        }
        target = keysByTable.get(refTable)!;
      }
      for (let rowIndex = 0; rowIndex < shape.rows.length; rowIndex += 1) {
        const cell = shape.rows[rowIndex]![columnIndex]!;
        if (cell === null) continue; // 可空外键（nullability 已在形状校验复核）。
        const encoded = encodeKeyCell(cell);
        if (!target.has(encoded)) {
          throw new PortabilityError(
            "integrity-failed",
            `facts/${spec.table}.json row ${rowIndex}: '${foreignKey.column}' references missing ` +
              `${foreignKey.references} '${String(cell)}' (referential integrity violation)`,
          );
        }
      }
    }
  }
}

function encodeKeyCell(cell: string | number | null): string {
  return cell === null ? "null" : `${typeof cell}:${String(cell)}`;
}

/* ------------------------------------------------------------------ */
/* 阶段 3：落库                                                          */
/* ------------------------------------------------------------------ */

/**
 * 按 RESTORE_INSERT_ORDER 把全部 facts 写入已迁移的空库（单事务）。
 * blob 先行（material_versions 的内容寻址外键目标）；含 session 的包把
 * session_references / tree_active_navigation 的 session_file 改写为
 * <dataDir>/sessions/<basename>（未随包的引用保持原路径——如实 missing）。
 * 返回改写的引用行数。
 */
function insertAllFacts(
  db: DatabaseSync,
  facts: ReadonlyMap<string, FactsFileShape>,
  blobs: readonly LoadedBlob[],
  dataDir: string,
  sessionBasenames: ReadonlySet<string>,
): number {
  const rewriteTargets: ReadonlySet<string> = new Set(["session_references", "tree_active_navigation"]);
  const rewriteColumn = "session_file";
  let rewritten = 0;

  db.exec("BEGIN IMMEDIATE");
  try {
    const blobInsert = db.prepare("INSERT INTO material_blobs (content_hash, bytes) VALUES (?, ?)");
    for (const blob of blobs) {
      blobInsert.run(blob.hash, blob.bytes);
    }
    for (const table of RESTORE_INSERT_ORDER) {
      const spec: FactTableSpec = FACT_TABLES_BY_NAME.get(table)!;
      const shape = facts.get(table)!;
      const insert = db.prepare(
        `INSERT INTO ${table} (${spec.columns.map((column) => column.name).join(", ")}) ` +
          `VALUES (${spec.columns.map(() => "?").join(", ")})`,
      );
      const rewriteIndex = rewriteTargets.has(table) ? shape.columns.indexOf(rewriteColumn) : -1;
      for (const row of shape.rows) {
        const values = [...row];
        if (rewriteIndex >= 0) {
          const sessionFile = values[rewriteIndex];
          if (typeof sessionFile === "string") {
            /* 与导出侧同款 basename 归一（Windows 反斜杠路径按 POSIX 观）。 */
            const basename = sessionFile.replaceAll("\\", "/").split("/").pop() ?? sessionFile;
            if (sessionBasenames.has(basename)) {
              values[rewriteIndex] = join(dataDir, "sessions", basename);
              rewritten += 1;
            }
          }
        }
        insert.run(...values);
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* 事务已不存在——保留原始错误。 */
    }
    throw new PortabilityError(
      "integrity-failed",
      `the package failed database integrity on restore (constraint violation: ` +
        `${error instanceof Error ? error.message : String(error)}); nothing was placed into the target`,
      { cause: error },
    );
  }
  return rewritten;
}

/* ------------------------------------------------------------------ */
/* 目标目录规则                                                          */
/* ------------------------------------------------------------------ */

/** 恢复目标必须是空数据目录（不存在或零条目）；否则明确拒绝。 */
export function assertRestoreTargetEmpty(dataDir: string): void {
  if (!existsSync(dataDir)) return;
  let stats;
  try {
    stats = statSync(dataDir);
  } catch (error) {
    throw new PortabilityError(
      "target-not-a-directory",
      `cannot inspect the restore target '${dataDir}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!stats.isDirectory()) {
    throw new PortabilityError(
      "target-not-a-directory",
      `the restore target '${dataDir}' exists and is not a directory; restore targets a data directory`,
    );
  }
  let entries: string[];
  try {
    entries = readdirSync(dataDir);
  } catch (error) {
    throw new PortabilityError(
      "target-not-a-directory",
      `cannot read the restore target '${dataDir}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (entries.length > 0) {
    throw new PortabilityError(
      "target-not-empty",
      `the restore target '${dataDir}' is not empty (${entries.length} entr${entries.length === 1 ? "y" : "ies"}: ` +
        `${entries.slice(0, 5).join(", ")}${entries.length > 5 ? ", …" : ""}); ` +
        "first-version restore only targets an EMPTY data directory and never merges or overwrites existing data " +
        "(charter D4 §5)",
    );
  }
}
