/**
 * Shared B5「恢复与资产完整」executing check (D4-5 wave, issue #8 charter §6 B5).
 *
 * Runs the offline-mechanical slice of B5 end to end against the REAL product
 * surfaces — the CLI entry (apps/studio/src/index.ts export / --import-package
 * mode wiring) as actual subprocesses, the import pipeline, the repositories,
 * the per-request search assembly — in a throwaway temp tree:
 *
 *  1. export → restore to an EMPTY data directory → full fact-table + blob
 *     integrity compare (compareProductDatabases: every saved fact, Return and
 *     excerpt survives byte-identically; session_file keeps its original path
 *     for a default package);
 *  2. index deletion rebuild: search is rebuilt per request from product data
 *     on main (no persisted index); queries over the source and the restored
 *     database return identical hit sequences (B5 索引删除重建) — compared
 *     BEFORE any mutation of the restored database;
 *  3. material NEW version after restore: the old version's saved excerpt
 *     still slices from the restored v1 canonical text (材料新版本仍链接旧摘录);
 *  4. corrupted package (flipped byte) rejected via the CLI with a stable
 *     reason code, NOTHING placed into the target, the source data directory
 *     untouched, no staging residue; a non-empty target is refused and its
 *     existing files stay byte-identical;
 *  5. whole-tree session deletion: after deleting the sessions directory the
 *     product availability sweep marks the references unavailable/missing-file
 *     while every domain fact stays readable (缺 session → 事实可读 + 显式新
 *     探索；旧 Pi 上下文不续——charter §1 path 6 / §5);
 *  6. parse cancel after restore: a gated in-flight parse is canceled, stays
 *     canceled (late result discarded), no ready version appears and the
 *     restored facts are untouched;
 *
 * Honest scope: the BROWSER-path items of charter B5 (restart + resume in a
 * real browser, the explicit-new-exploration UI affordance, source jumps)
 * stay with run:d4-browser / the final candidate-SHA regression and are NOT
 * claimed here.
 *
 * Consumers: scripts/verify-d4.js (check `b5-restore-integrity`). The frozen
 * fixture tree stays read-only — nothing under tests/fixtures is written.
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MaterialRepository, TreeRepository, openDatabaseReadOnly } from "@treeai/persistence";
import type { MaterialBlock } from "@treeai/contracts";

import {
  MaterialImportService,
  type MaterialParser,
  type MaterialParserOutcome,
} from "../../../apps/studio/src/materials/import-service.ts";
import { SearchService } from "../../../apps/studio/src/search/search-service.ts";
import { FACT_TABLES } from "../../../apps/studio/src/portability/package-format.ts";
import {
  buildRepresentativeDataset,
  compareProductDatabases,
} from "../../../apps/studio/tests/portability-helpers.ts";
import { runCommand } from "./util.ts";

export interface B5RestoreCheckOutcome {
  readonly status: "PASS" | "FAIL" | "NOT_RUN";
  readonly exitCode: number | null;
  /** One-line summary for the check matrix. */
  readonly detail: string;
  /** Per-item execution lines (evidence log). */
  readonly lines: readonly string[];
  readonly problems: readonly string[];
}

/* ------------------------------------------------------------------ */
/* 辅助                                                                 */
/* ------------------------------------------------------------------ */

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** 递归拷贝目录（破坏性试验不污染原件）。 */
function copyTree(source: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(source, { withFileTypes: true })) {
    if (name.isDirectory()) copyTree(join(source, name.name), join(dest, name.name));
    else copyFileSync(join(source, name.name), join(dest, name.name));
  }
}

/** 轮询等待条件成立（超时即失败——不静默跳过）。 */
async function until(predicate: () => boolean, what: string, attempts = 400): Promise<boolean> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return predicate();
}

/** 受控门控假解析器：parse() 挂起直到 release()（取消纪律的确定性观测）。 */
class GatedParser implements MaterialParser {
  readonly kind = "markdown" as const;
  readonly parserVersion = "b5-gated-v1";
  #release: (() => void) | null = null;
  readonly #promise: Promise<MaterialParserOutcome>;
  constructor() {
    this.#promise = new Promise<MaterialParserOutcome>((resolve) => {
      this.#release = () =>
        resolve({
          ok: true,
          canonicalText: "Gated head\n\nGated tail",
          blocks: [
            { blockId: "blk-0", kind: "markdown-block", start: 0, end: 12 },
            { blockId: "blk-1", kind: "markdown-block", start: 12, end: 22 },
          ] satisfies MaterialBlock[],
        });
    });
  }
  parse(): Promise<MaterialParserOutcome> {
    return this.#promise;
  }
  release(): void {
    this.#release?.();
  }
}

/** 真实 CLI 子进程（index.ts 模式接线——非函数直调）。 */
function cli(root: string, args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const res = runCommand(process.execPath, [join("apps", "studio", "src", "index.ts"), ...args], {
    cwd: root,
    timeoutMs: 120_000,
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

/** 全部事实表行数（session 删除前后域事实零丢失比较）。 */
function readAllFactCounts(dbPath: string): Record<string, number> {
  const db = openDatabaseReadOnly(dbPath);
  const counts: Record<string, number> = {};
  try {
    for (const spec of FACT_TABLES) {
      const columns = spec.columns.map((column) => column.name);
      const objectRows = db
        .prepare(`SELECT ${columns.join(", ")} FROM ${spec.table} ORDER BY ${spec.orderBy}`)
        .all() as unknown as ReadonlyArray<Record<string, string | number | null>>;
      counts[spec.table] = objectRows.length;
    }
    return counts;
  } finally {
    db.close();
  }
}

/* ------------------------------------------------------------------ */
/* The check                                                            */
/* ------------------------------------------------------------------ */

export async function runB5RestoreCheck(root: string): Promise<B5RestoreCheckOutcome> {
  const problems: string[] = [];
  const lines: string[] = [];
  const base = mkdtempSync(join(tmpdir(), "treeai-b5-restore-"));

  try {
    /* ---- 代表性数据集（真实导入流水线 + 真实仓储写入） ---- */
    const dataDir = join(base, "source-data");
    mkdirSync(dataDir, { recursive: true });
    const dataset = await buildRepresentativeDataset(dataDir);
    dataset.dispose();
    lines.push(
      "dataset: representative facts built through the real import pipeline + repositories " +
        "(2 trees, 3 branches, 2 runs, 3 turns incl. a return, material v1+v2, terminology annotation+dispatch)",
    );

    /* ---- 1) CLI export（真实子进程） ---- */
    const pkg = join(base, "pkg");
    const exported = cli(root, ["export", "--out", pkg, "--data", dataDir, "--readable"]);
    lines.push(`cli export: exit ${String(exported.status)} → ${pkg}`);
    if (exported.status !== 0 || !existsSync(join(pkg, "manifest.json"))) {
      problems.push(`cli export failed (exit ${String(exported.status)}): ${exported.stderr.slice(0, 400)}`);
      return { status: "FAIL", exitCode: 2, detail: "b5 export step failed", lines, problems };
    }

    /* ---- 2) CLI restore 到空数据目录 + 完整性比对 ---- */
    const sourceDb = join(dataDir, "treeai.db");
    const sourceDbHashBefore = sha256File(sourceDb);
    const restored = join(base, "restored");
    const restoreRun = cli(root, ["--import-package", pkg, "--data", restored]);
    lines.push(`cli restore: exit ${String(restoreRun.status)} → ${restored}`);
    if (restoreRun.status !== 0 || !existsSync(join(restored, "treeai.db"))) {
      problems.push(`cli restore failed (exit ${String(restoreRun.status)}): ${restoreRun.stderr.slice(0, 400)}`);
      return { status: "FAIL", exitCode: 2, detail: "b5 restore step failed", lines, problems };
    }
    const diff = compareProductDatabases(sourceDb, join(restored, "treeai.db"));
    if (diff.length > 0) {
      problems.push(`restore integrity compare found ${String(diff.length)} problem(s): ${JSON.stringify(diff.slice(0, 3))}`);
    } else {
      lines.push("integrity compare: every fact table row and material blob survives the round trip (0 problems)");
    }
    /* 已保存事实/摘录存活（恢复库真值复核，不信任包内容）。 */
    {
      const materials = MaterialRepository.open({ path: join(restored, "treeai.db") });
      const trees = TreeRepository.open({ path: join(restored, "treeai.db") });
      try {
        const trunkTurns = trees.listTurns(dataset.trunkBranchId);
        const returns = trunkTurns.filter((turn) => turn.role === "return");
        if (trunkTurns.length !== 3 || returns.length !== 1) {
          problems.push(
            `restored trunk turns lost (expected 3 turns incl. 1 return, got ${String(trunkTurns.length)}/${String(returns.length)})`,
          );
        }
        const originRef = materials.getBranchOrigin(dataset.materialBranchId);
        if (originRef === null || originRef.kind !== "material") {
          problems.push("the material branch origin did not survive the restore");
        } else {
          const selection = originRef.origin.selection;
          const v1 = materials.getVersionContent(selection.versionId);
          if (v1.canonicalText.slice(selection.start, selection.end) !== selection.excerpt) {
            problems.push("the restored material origin excerpt no longer slices from its version's canonical text");
          } else {
            lines.push(
              `saved facts: ${String(trunkTurns.length)} trunk turns incl. ${String(returns.length)} return; ` +
                "material origin excerpt still slices exactly from the restored v1 text",
            );
          }
        }
      } finally {
        trees.close();
        materials.close();
      }
    }

    /* ---- 3) 索引删除重建（每请求确定性重建 → 恢复后逐字一致） ----
       先于对恢复库的一切变更（后续步骤会加 v3/门控材料，命中集本就应变）。 */
    {
      const sourceTrees = TreeRepository.open({ path: sourceDb });
      const sourceMaterials = MaterialRepository.open({ path: sourceDb });
      const restoredTrees = TreeRepository.open({ path: join(restored, "treeai.db") });
      const restoredMaterials = MaterialRepository.open({ path: join(restored, "treeai.db") });
      try {
        const sourceSearch = new SearchService({ treeRepository: sourceTrees, materialRepository: sourceMaterials });
        const restoredSearch = new SearchService({ treeRepository: restoredTrees, materialRepository: restoredMaterials });
        for (const query of ["轮廓系数", "K-means", "DBSCAN"]) {
          /* 「索引删除」在每请求重建的架构下 = 全新装配一次；源库与恢复库
             各自独立装配，命中序必须逐字一致（B5 索引删除重建的结构性证据）。 */
          const a = sourceSearch.search(query).map((hit) => `${hit.kind}:${hit.refId}`);
          const b = restoredSearch.search(query).map((hit) => `${hit.kind}:${hit.refId}`);
          if (a.length === 0) {
            problems.push(`search rebuilt over the source found nothing for '${query}' (corpus regression)`);
          } else if (JSON.stringify(a) !== JSON.stringify(b)) {
            problems.push(`post-restore search rebuild diverges for '${query}': ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
          } else {
            lines.push(`index rebuild: '${query}' → ${String(a.length)} hit(s), identical sequence over source and restored databases`);
          }
        }
      } finally {
        restoredMaterials.close();
        restoredTrees.close();
        sourceMaterials.close();
        sourceTrees.close();
      }
    }

    /* ---- 4) 材料新版本仍链接旧摘录 ---- */
    {
      const materials = MaterialRepository.open({ path: join(restored, "treeai.db") });
      const importService = new MaterialImportService({ repository: materials });
      try {
        const v3 = await importService.addMaterialVersion(dataset.treeId, dataset.materialId, {
          filename: "聚类笔记-v3.md",
          bytes: new TextEncoder().encode(
            ["# 聚类笔记（v3 改版）", "", "K-means 以质心为中心迭代划分；新增高斯混合模型一节。", ""].join("\n"),
          ),
        });
        const ready = await until(
          () =>
            importService
              .getMaterialDetail(dataset.treeId, dataset.materialId)
              .versions.find((version) => version.id === v3.version.id)?.parseStatus === "ready",
          "v3 to become ready",
        );
        if (!ready) {
          problems.push("material v3 never became ready after restore (new version path broken)");
        } else {
          const detail = importService.getMaterialDetail(dataset.treeId, dataset.materialId);
          lines.push(`material new version: v3 ready; version chain now ${String(detail.versions.length)} versions (old versions kept)`);
        }
        /* 旧摘录仍锚定 v1（新版本不漂移旧来源）。 */
        const originRef = materials.getBranchOrigin(dataset.materialBranchId);
        if (originRef === null || originRef.kind !== "material") {
          problems.push("material origin vanished after adding the new version");
        } else {
          const selection = originRef.origin.selection;
          const v1 = materials.getVersionContent(selection.versionId);
          if (v1.canonicalText.slice(selection.start, selection.end) !== selection.excerpt) {
            problems.push("old excerpt linkage drifted after the new version");
          } else {
            lines.push(
              "old excerpt linkage: the v1-anchored origin still resolves against the unchanged v1 canonical text",
            );
          }
        }
      } finally {
        materials.close();
      }
    }

    /* ---- 5) 损坏包拒绝 + 现有数据不变 ---- */
    {
      const corrupt = join(base, "pkg-corrupt");
      copyTree(pkg, corrupt);
      /* 翻转 facts/turns.json 中段一个字节——现实损坏形态。 */
      const turnsPath = join(corrupt, "facts", "turns.json");
      const bytes = readFileSync(turnsPath);
      bytes[Math.floor(bytes.byteLength / 2)]! ^= 0x01;
      writeFileSync(turnsPath, bytes);

      const corruptTarget = join(base, "restored-corrupt");
      const refused = cli(root, ["--import-package", corrupt, "--data", corruptTarget]);
      if (refused.status !== 2 || !refused.stderr.includes("checksum-mismatch")) {
        problems.push(
          `corrupted package was NOT rejected with checksum-mismatch by the CLI (exit ${String(refused.status)}): ${refused.stderr.slice(0, 300)}`,
        );
      } else {
        lines.push(`corrupted package: CLI refused with exit 2 (${refused.stderr.split("\n")[0]?.slice(0, 160) ?? ""})`);
      }
      if (existsSync(corruptTarget)) {
        problems.push("corrupted package left something in the target directory");
      }
      if (sha256File(sourceDb) !== sourceDbHashBefore) {
        problems.push("the source data directory was modified during the refused restore");
      } else {
        lines.push("existing data unchanged: source database byte-identical; the empty target stays empty");
      }
      /* 非空目标：既有文件逐字节不变。 */
      const occupied = join(base, "occupied");
      mkdirSync(occupied, { recursive: true });
      writeFileSync(join(occupied, "precious.db"), "pre-existing user data", "utf8");
      const occupiedRun = cli(root, ["--import-package", pkg, "--data", occupied]);
      if (occupiedRun.status === 2 && occupiedRun.stderr.includes("target-not-empty")) {
        lines.push("non-empty target: refused (target-not-empty)");
      } else {
        problems.push(`restore into a non-empty target was not refused (exit ${String(occupiedRun.status)})`);
      }
      if (readFileSync(join(occupied, "precious.db"), "utf8") !== "pre-existing user data") {
        problems.push("existing files in the refused target were modified");
      }
    }

    /* ---- 6) 整 Tree session 删除 → 事实可读 + 显式新探索 ---- */
    {
      const pkgSessions = join(base, "pkg-sessions");
      const exportSessions = cli(root, ["export", "--out", pkgSessions, "--data", dataDir, "--include-sessions"]);
      if (exportSessions.status !== 0 || !existsSync(join(pkgSessions, "sessions"))) {
        problems.push(`sessions export failed (exit ${String(exportSessions.status)}): ${exportSessions.stderr.slice(0, 300)}`);
      } else {
        const restoredSessions = join(base, "restored-sessions");
        const restoreSessions = cli(root, ["--import-package", pkgSessions, "--data", restoredSessions]);
        if (restoreSessions.status !== 0 || !existsSync(join(restoredSessions, "sessions", "sess-main-0001.jsonl"))) {
          problems.push(`sessions restore failed (exit ${String(restoreSessions.status)}): ${restoreSessions.stderr.slice(0, 300)}`);
        } else {
          const sessionsDiff = compareProductDatabases(sourceDb, join(restoredSessions, "treeai.db"), {
            expectedSessionsDir: join(restoredSessions, "sessions"),
          });
          if (sessionsDiff.length > 0) {
            problems.push(`sessions-package integrity compare found ${String(sessionsDiff.length)} problem(s)`);
          } else {
            lines.push("sessions package: export → restore → integrity compare 0 problems (carried references rewritten)");
          }
          /* 删除全部 session 文件（整 Tree session 消失）→ 探针如实降级。 */
          const beforeCounts = readAllFactCounts(join(restoredSessions, "treeai.db"));
          rmSync(join(restoredSessions, "sessions"), { recursive: true, force: true });
          const trees = TreeRepository.open({ path: join(restoredSessions, "treeai.db") });
          try {
            const sweep = trees.refreshSessionAvailability();
            const missingSweeps = sweep.filter((entry) => !existsSync(entry.sessionFile));
            lines.push(
              `session deletion sweep: ${String(sweep.length)} distinct session file(s) referenced; ` +
                `${String(missingSweeps.length)} now missing on disk → availability honestly degraded`,
            );
            const trunkTurns = trees.listTurns(dataset.trunkBranchId);
            if (trunkTurns.length === 0) problems.push("turns unreadable after session deletion");
            const materials = MaterialRepository.open({ path: join(restoredSessions, "treeai.db") });
            try {
              const listed = materials.listTreeMaterials(dataset.treeId);
              if (listed.length !== 1) problems.push(`materials unreadable after session deletion (${String(listed.length)})`);
              const readable = materials.getVersionContent(dataset.materialV2);
              if (!readable.canonicalText.includes("轮廓系数")) {
                problems.push("material v2 canonical text unreadable after session deletion");
              }
            } finally {
              materials.close();
            }
            /* 域事实零丢失：行数全部不变（session 删除只降级引用可用性列）。 */
            const afterCounts = readAllFactCounts(join(restoredSessions, "treeai.db"));
            for (const table of Object.keys(beforeCounts)) {
              if (beforeCounts[table] !== afterCounts[table]) {
                problems.push(
                  `fact rows changed after session deletion: ${table} ${String(beforeCounts[table])} → ${String(afterCounts[table])}`,
                );
              }
            }
            lines.push(
              `facts readable after session deletion: ${String(trunkTurns.length)} trunk turns, material v2 readable, ` +
                "all fact row counts unchanged (session loss never cascades — new exploration is the explicit product path, charter §1 path 6)",
            );
          } finally {
            trees.close();
          }
        }
      }
    }

    /* ---- 7) 恢复后解析取消（gated parser，迟到结果丢弃） ---- */
    {
      const materials = MaterialRepository.open({ path: join(restored, "treeai.db") });
      const gated = new GatedParser();
      const importService = new MaterialImportService({ repository: materials, parsers: { markdown: gated } });
      try {
        const result = await importService.importMaterial(dataset.secondTreeId, {
          filename: "b5-gated.md",
          bytes: new TextEncoder().encode("gated bytes"),
        });
        const taskId = result.parseTaskId;
        if (taskId === null) {
          problems.push("gated import produced no parse task id");
        } else {
          const parsing = await until(() => importService.getParseTask(taskId)?.state === "parsing", "task to enter parsing");
          if (!parsing) {
            problems.push("gated parse task never entered parsing");
          } else {
            const canceled = importService.cancelParseTask(dataset.secondTreeId, taskId);
            if (canceled.state !== "canceled") {
              problems.push(`cancelParseTask after restore returned ${String(canceled.state)}`);
            } else {
              gated.release();
              const discarded = await until(
                () => importService.getParseTask(taskId)?.lateResultDiscarded === true,
                "late result to be discarded",
              );
              const detail = importService.getMaterialDetail(dataset.secondTreeId, result.material.id);
              if (!discarded) {
                problems.push("late parse result was not observed as discarded");
              } else if (detail.versions.some((version) => version.parseStatus === "ready")) {
                problems.push("a canceled parse produced a ready version after restore");
              } else {
                lines.push(
                  "parse cancel after restore: canceled state holds, late result discarded, " +
                    `${String(detail.versions.length)} version(s) none ready; restored facts untouched`,
                );
              }
            }
          }
        }
      } finally {
        materials.close();
      }
    }

  } catch (error) {
    problems.push(`check crashed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }

  const passed = problems.length === 0;
  const detail =
    "export→empty-dir restore→integrity compare clean (facts/returns/excerpts survive); corrupted package refused " +
    "(target stays empty, source byte-identical); material new version keeps old excerpt linkage; whole-session " +
    "deletion degrades availability honestly with all fact rows readable and unchanged; parse cancel holds after " +
    "restore; per-request search rebuild identical over source and restored databases; browser-path items stay with " +
    "run:d4-browser (not claimed here)";
  return {
    status: passed ? "PASS" : "FAIL",
    exitCode: passed ? 0 : 2,
    detail,
    lines,
    problems,
  };
}
