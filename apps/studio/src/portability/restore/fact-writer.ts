/** fact-writer ownership for restore-service.ts; compatibility entrypoint remains one level above. */
import { validateGenerativeUiStorage } from "@treeai/persistence";
import {
  FACT_TABLES_BY_NAME,
  type FactsFileShape,
  type FactTableSpec,
  PortabilityError,
  RESTORE_INSERT_ORDER,
} from "../package-format.ts";
import type {
  LoadedBlob,
} from "./model.ts";
import {
  join,
} from "node:path";
import type {
  DatabaseSync,
} from "node:sqlite";

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
export function insertAllFacts(
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
    validateGenerativeUiStorage(db);
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
