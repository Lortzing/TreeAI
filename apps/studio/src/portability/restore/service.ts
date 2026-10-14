/** service ownership for restore-service.ts; compatibility entrypoint remains one level above. */
import {
  assertFactsLayoutCurrent,
  PortabilityError,
  RESTORE_INSERT_ORDER,
} from "../package-format.ts";
import {
  validateFactsShapes,
  validateReferentialIntegrity,
} from "./fact-validation.ts";
import {
  insertAllFacts,
} from "./fact-writer.ts";
import type {
  RestorePackageOptions,
  RestorePackageResult,
} from "./model.ts";
import {
  readAndValidateManifest,
  validateEntriesAndRead,
  walkPackageFiles,
} from "./package-reader.ts";
import {
  openDatabase,
} from "@treeai/persistence";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
} from "node:fs";
import {
  dirname,
  join,
} from "node:path";

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
