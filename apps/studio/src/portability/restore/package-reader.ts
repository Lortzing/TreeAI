/** package-reader ownership for restore-service.ts; compatibility entrypoint remains one level above. */
import {
  assertBlobFileName,
  assertSafePackagePath,
  assertSessionFileName,
  EXPORT_PACKAGE_FORMAT,
  type ExportManifest,
  type ExportManifestEntry,
  FACT_TABLES,
  FACTS_LAYOUT_SCHEMA_VERSION,
  type FactsFileShape,
  MANIFEST_FILENAME,
  MANIFEST_SCHEMA_VERSION,
  type ManifestEntryKind,
  MAX_ENTRY_COUNT,
  MAX_TOTAL_PACKAGE_BYTES,
  maxEntryBytesForKind,
  PortabilityError,
  SESSIONS_SENSITIVE_MARKER,
} from "../package-format.ts";
import type {
  LoadedBlob,
  LoadedPackage,
  LoadedSession,
  WalkedFile,
} from "./model.ts";
import {
  createHash,
} from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import {
  join,
} from "node:path";

/* ------------------------------------------------------------------ */
/* 阶段 1：清单 / 目录遍历 / 条目校验                                   */
/* ------------------------------------------------------------------ */

export function readAndValidateManifest(packageDir: string): ExportManifest {
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

/** 全量遍历包目录（拒绝符号链接；返回全部文件）。 */
export function walkPackageFiles(packageDir: string): WalkedFile[] {
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

/**
 * 条目与包目录双向全量比对 + 校验和复核 + 逐种类命名/布局规则。
 * 读取阶段顺带把 blobs/facts/sessions 装入内存（后续校验与落库共用）。
 */
export function validateEntriesAndRead(
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

export function assertFactsEntryPath(path: string): void {
  const match = /^facts\/([a-z_]+)\.json$/.exec(path);
  if (match === null) {
    throw new PortabilityError("path-unsafe", `facts entry '${path}' must be 'facts/<table>.json'`);
  }
}

/** 解析单个 facts 文件（JSON 形状初步校验；列/类型校验见 validateFactsShapes）。 */
export function parseFactsFile(table: string, packageDir: string): FactsFileShape {
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
