/**
 * D4-5 数据可携带 —— 导出服务（issue #8 D4-5；契约 §5）。
 *
 * 把一个数据目录的全部已保存产品事实导出为版本化包：
 *  - 只读打开产品库（openDatabaseReadOnly：不迁移、不写入）；
 *  - `facts/`：每张事实表一个确定性 JSON 文件（冻结列序 + 确定序，见
 *    package-format.ts 的 FACT_TABLES）；
 *  - `blobs/`：材料原件（内容寻址，文件名 = 原件字节 SHA-256）；
 *  - `sessions/`：**默认不含**（charter §5：凭据/缓存/原始运行日志与
 *    Pi session 缺省排除）；`--include-sessions` 显式选择时随包复制
 *    （sessions/SESSIONS-SENSITIVE.txt 显著标注敏感）；
 *  - `readable/`（export --readable）：人类可读 Markdown 导出——材料
 *    正文、树/回合/Return/批注，无任何 runtime 亦可阅读；
 *  - `manifest.json`：schemaVersion / packageFormat / productSchemaVersion
 *    / exportedAt / includesSessions / readable / counts / 全部条目
 *    SHA-256。
 *
 * 排除面（结构性）：凭据（从不进产品库——API key 仅内存缝）、临时缓存
 * （术语解释缓存为进程内 Map）、原始运行日志（journal.jsonl 不导出）、
 * workspace/ 与 pi-agent/（非产品事实）、journal、schema_migrations
 * （恢复时由迁移重建）。
 *
 * 落盘纪律：先写同文件系统暂存目录，全部成功后原子改名到 --out；目标
 * 已存在且非空 → 明确拒绝（不混合两个包）。
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDatabaseReadOnly } from "@treeai/persistence";
import {
  EXPORT_PACKAGE_FORMAT,
  FACT_TABLES,
  FACTS_LAYOUT_SCHEMA_VERSION,
  MANIFEST_FILENAME,
  MANIFEST_SCHEMA_VERSION,
  MAX_BLOB_ENTRY_BYTES,
  PortabilityError,
  SESSIONS_SENSITIVE_MARKER,
  SESSIONS_SENSITIVE_MARKER_TEXT,
  assertFactsLayoutCurrent,
  assertSafePackagePath,
  encodeFactsFile,
  encodeManifestFile,
  type ExportManifest,
  type ExportManifestEntry,
  type FactsFileShape,
} from "./package-format.ts";
import { renderReadableFiles, type ReadableRenderInput } from "./readable-export.ts";

/* ------------------------------------------------------------------ */
/* 选项与结果                                                           */
/* ------------------------------------------------------------------ */

export interface ExportPackageOptions {
  /** 产品库文件路径（<data>/treeai.db）。 */
  readonly dbPath: string;
  /** 导出包输出目录。已存在且非空 → 拒绝。 */
  readonly outDir: string;
  /** 显式包含 Pi session 原件（敏感；默认 false）。 */
  readonly includeSessions?: boolean;
  /** 生成可读 Markdown 导出（export --readable）。 */
  readonly readable?: boolean;
  /** 时钟注入（exportedAt；确定性测试可冻结）。 */
  readonly now?: () => string;
}

export interface ExportPackageResult {
  readonly outDir: string;
  readonly manifest: ExportManifest;
  /** facts 文件数 + blobs + sessions + readable 文件数合计（= manifest.entries.length）。 */
  readonly entryCount: number;
  /** 每张事实表的行数。 */
  readonly factCounts: Readonly<Record<string, number>>;
  /** includeSessions 时复制成功的 session 文件（包内相对路径）。 */
  readonly sessionFilesCopied: readonly string[];
  /** includeSessions 时引用了但磁盘上不存在的 session 文件（如实计数，不静默）。 */
  readonly sessionFilesMissing: readonly string[];
}

/* ------------------------------------------------------------------ */
/* 服务                                                                */
/* ------------------------------------------------------------------ */

export class ExportService {
  readonly #db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /**
   * 只读打开产品库（不迁移、不写入）。库缺失/非 TreeAI 库/schema 过旧或
   * 过新均明确失败；schema 必须与 facts 布局一致（assertFactsLayoutCurrent）。
   */
  static open(dbPath: string): ExportService {
    assertFactsLayoutCurrent();
    if (!existsSync(dbPath)) {
      throw new PortabilityError(
        "db-not-found",
        `no TreeAI database at '${dbPath}' (export reads <data>/treeai.db; pass the studio --data directory's database)`,
      );
    }
    let db: DatabaseSync;
    try {
      db = openDatabaseReadOnly(dbPath);
    } catch (error) {
      if (error instanceof PortabilityError) throw error;
      throw new PortabilityError(
        "db-unreadable",
        `cannot open '${dbPath}' as a TreeAI database: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    const versionRow = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
    const version = Number(versionRow?.user_version ?? 0);
    if (version !== FACTS_LAYOUT_SCHEMA_VERSION) {
      db.close();
      throw new PortabilityError(
        "schema-unsupported",
        `database schema version ${version} does not match the export facts layout ${FACTS_LAYOUT_SCHEMA_VERSION}; ` +
          "open the data directory once with the current studio (migrations are applied on open), then export",
      );
    }
    return new ExportService(db);
  }

  close(): void {
    this.#db.close();
  }

  /** 读取全部事实表（冻结列序 + 确定序；导出与可读导出共用同一快照）。 */
  readFactsSnapshot(): ReadonlyMap<string, FactsFileShape> {
    const snapshot = new Map<string, FactsFileShape>();
    for (const spec of FACT_TABLES) {
      const columns = spec.columns.map((column) => column.name);
      /* node:sqlite 的 .all() 返回按列名键的对象行——按冻结列序转数组，
         使 facts 文件/可读导出/比较层共享同一确定形状。 */
      const objectRows = this.#db
        .prepare(`SELECT ${columns.join(", ")} FROM ${spec.table} ORDER BY ${spec.orderBy}`)
        .all() as unknown as ReadonlyArray<Record<string, string | number | null>>;
      const rows = objectRows.map((row) => columns.map((column) => row[column] ?? null));
      snapshot.set(spec.table, { table: spec.table, columns, rows });
    }
    return snapshot;
  }

  /** material_blobs 行（content_hash → 原件字节）。 */
  readBlobs(): ReadonlyMap<string, Uint8Array> {
    const rows = this.#db
      .prepare("SELECT content_hash, bytes FROM material_blobs ORDER BY content_hash")
      .all() as unknown as Array<{ content_hash: string; bytes: Uint8Array }>;
    return new Map(rows.map((row) => [row.content_hash, row.bytes]));
  }

  /**
   * 引用的 session 文件（session_references + tree_active_navigation 的
   * DISTINCT session_file）。仅 --include-sessions 时被消费。
   */
  referencedSessionFiles(): string[] {
    const rows = this.#db
      .prepare(
        "SELECT DISTINCT session_file FROM session_references " +
          "UNION SELECT DISTINCT session_file FROM tree_active_navigation " +
          "ORDER BY session_file",
      )
      .all() as unknown as Array<{ session_file: string }>;
    return rows.map((row) => row.session_file);
  }

  /**
   * 导出为包目录（staging 构建 → 原子改名到 outDir）。
   * outDir 已存在且非空 → PortabilityError("out-dir-not-empty")。
   */
  export(options: Omit<ExportPackageOptions, "dbPath">): ExportPackageResult {
    const includeSessions = options.includeSessions === true;
    const readable = options.readable === true;
    const now = options.now ?? ((): string => new Date().toISOString());
    const outDir = options.outDir;
    if (typeof outDir !== "string" || outDir.trim().length === 0) {
      throw new PortabilityError("out-dir-invalid", "the export --out directory must be a non-empty path");
    }

    /* 目标护栏（早失败）：已存在且非空 → 拒绝（不混合两个包）。 */
    if (existsSync(outDir)) {
      const existing = readdirSync(outDir);
      if (existing.length > 0) {
        throw new PortabilityError(
          "out-dir-not-empty",
          `the export --out directory '${outDir}' already exists and is not empty ` +
            `(${existing.length} entr${existing.length === 1 ? "y" : "ies"}); exports never mix into an existing package`,
        );
      }
    }

    const snapshot = this.readFactsSnapshot();
    const blobs = this.readBlobs();
    const sessions = includeSessions ? this.referencedSessionFiles() : [];

    /* session 收集（仅显式包含）：存在 → 复制；缺失 → 如实记录；同名冲突 → 拒绝。 */
    const sessionCopied: string[] = [];
    const sessionMissing: string[] = [];
    const sessionBasenames = new Set<string>();
    if (includeSessions) {
      for (const sessionFile of sessions) {
        let isFile = false;
        try {
          isFile = statSync(sessionFile).isFile();
        } catch {
          isFile = false;
        }
        if (!isFile) {
          sessionMissing.push(sessionFile);
          continue;
        }
        const basename = posix.basename(sessionFile.replaceAll("\\", "/"));
        assertSafePackagePath(`sessions/${basename}`, "session file");
        if (sessionBasenames.has(basename)) {
          throw new PortabilityError(
            "session-name-collision",
            `two distinct referenced session files share the basename '${basename}' ` +
              "(the package layout requires unique session basenames); refusing to silently overwrite either",
          );
        }
        sessionBasenames.add(basename);
        sessionCopied.push(sessionFile);
      }
    }

    /* blob 上限复核（与产品单文件上限一致；超限即库内异常数据，如实拒绝）。 */
    for (const [hash, bytes] of blobs) {
      if (bytes.byteLength > MAX_BLOB_ENTRY_BYTES) {
        throw new PortabilityError(
          "oversized-entry",
          `material blob ${hash} is ${bytes.byteLength} bytes, exceeding the ${MAX_BLOB_ENTRY_BYTES}-byte ` +
            "single-file limit (charter D4 §5); the database holds material larger than the product ever accepts",
        );
      }
    }

    /* 暂存目录（与 outDir 同文件系统，便于原子改名）。 */
    const parent = dirname(outDir);
    mkdirSync(parent, { recursive: true });
    const staging = mkdtempSync(join(parent, ".treeai-export-"));
    const entries: ExportManifestEntry[] = [];
    const counts: Record<string, number> = {};
    try {
      /* facts/（冻结全集：空表也写文件——恢复端要求集合恰好相等）。 */
      mkdirSync(join(staging, "facts"), { recursive: true });
      for (const spec of FACT_TABLES) {
        const shape = snapshot.get(spec.table)!;
        const relPath = `facts/${spec.table}.json`;
        const bytes = Buffer.from(encodeFactsFile(shape), "utf8");
        writeFileSync(join(staging, "facts", `${spec.table}.json`), bytes);
        entries.push({ kind: "facts", path: relPath, bytes: bytes.byteLength, sha256: sha256Hex(bytes) });
        counts[spec.table] = shape.rows.length;
      }

      /* blobs/（材料原件，内容寻址）。 */
      mkdirSync(join(staging, "blobs"), { recursive: true });
      for (const [hash, bytes] of blobs) {
        const relPath = `blobs/${hash}`;
        writeFileSync(join(staging, "blobs", hash), bytes);
        entries.push({ kind: "blob", path: relPath, bytes: bytes.byteLength, sha256: sha256Hex(bytes) });
      }
      counts["blobs"] = blobs.size;

      /* sessions/（仅显式包含；敏感内容显著标注）。 */
      if (includeSessions) {
        mkdirSync(join(staging, "sessions"), { recursive: true });
        for (const sessionFile of sessionCopied) {
          const basename = posix.basename(sessionFile.replaceAll("\\", "/"));
          const relPath = `sessions/${basename}`;
          copyFileSync(sessionFile, join(staging, "sessions", basename));
          const bytes = readBytes(join(staging, "sessions", basename));
          entries.push({ kind: "session", path: relPath, bytes: bytes.byteLength, sha256: sha256Hex(bytes) });
        }
        const markerBytes = Buffer.from(SESSIONS_SENSITIVE_MARKER_TEXT, "utf8");
        writeFileSync(join(staging, SESSIONS_SENSITIVE_MARKER), markerBytes);
        entries.push({
          kind: "marker",
          path: SESSIONS_SENSITIVE_MARKER,
          bytes: markerBytes.byteLength,
          sha256: sha256Hex(markerBytes),
        });
        counts["sessions"] = sessionCopied.length;
        counts["sessionFilesMissing"] = sessionMissing.length;
      }

      /* readable/（可读 Markdown 导出）。
         路径安全护栏：文件名来自库内 id（treeId/materialId）——经恢复的
         库可能携带任意字符串；含穿越段的 id 在此如实拒绝（绝不写出暂存
         区之外）。 */
      if (readable) {
        const input: ReadableRenderInput = { facts: snapshot, blobs };
        for (const file of renderReadableFiles(input)) {
          assertSafePackagePath(file.path, "readable export");
          const bytes = Buffer.from(file.content, "utf8");
          const absPath = join(staging, ...file.path.split("/"));
          mkdirSync(dirname(absPath), { recursive: true });
          writeFileSync(absPath, bytes);
          entries.push({ kind: "readable", path: file.path, bytes: bytes.byteLength, sha256: sha256Hex(bytes) });
        }
        counts["readableFiles"] = entries.filter((entry) => entry.kind === "readable").length;
      }

      /* manifest.json（条目按 path 排序 → 确定性）。 */
      entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      const manifest: ExportManifest = {
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        packageFormat: EXPORT_PACKAGE_FORMAT,
        productSchemaVersion: FACTS_LAYOUT_SCHEMA_VERSION,
        exportedAt: now(),
        includesSessions: includeSessions,
        readable,
        counts,
        entries,
      };
      writeFileSync(
        join(staging, MANIFEST_FILENAME),
        Buffer.from(encodeManifestFile(manifest), "utf8"),
      );

      /* 原子落位：空 outDir 先移除（rmdir 仅空目录可成功），再改名。 */
      if (existsSync(outDir)) {
        rmdirSync(outDir);
      }
      renameSync(staging, outDir);
      return {
        outDir,
        manifest,
        entryCount: entries.length,
        factCounts: counts,
        sessionFilesCopied: sessionCopied.map((file) => posix.basename(file.replaceAll("\\", "/"))),
        sessionFilesMissing: sessionMissing,
      };
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }
}

/** 一次性导出（打开 → 导出 → 关闭）。 */
export function exportPackage(options: ExportPackageOptions): ExportPackageResult {
  const service = ExportService.open(options.dbPath);
  try {
    return service.export(options);
  } finally {
    service.close();
  }
}

/* ------------------------------------------------------------------ */
/* 内部辅助                                                             */
/* ------------------------------------------------------------------ */

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readBytes(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}
