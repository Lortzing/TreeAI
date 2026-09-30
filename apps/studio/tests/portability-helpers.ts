/**
 * D4-5 portability 测试/验收集共用辅助（apps/studio 测试与
 * tests/support/verifier/d4-b5-restore.ts 共用；本文件不是 .test.ts，
 * 不随 node --test 自动执行）。
 *
 *  1. buildRepresentativeDataset：在给定数据目录构建**全类别**代表性
 *     产品事实（材料含版本对、树/分支/回合、Turn 来源与材料来源、Run
 *     （succeeded/failed）、session 引用（存在/缺失两种）、Return 及采用
 *     记录、术语批注/推广/派发账本、术语状态 kv、活动导航、阅读位置、
 *     材料首问幂等）——经**真实导入流水线**（MaterialImportService）与
 *     真实仓储写入（b1 同款纪律：被测的是产品装配路径本身）。
 *  2. readTableRows：按 FACT_TABLES 冻结列序读表（比较用）。
 *  3. compareProductDatabases：两个库的全部事实表逐行比较（含 blobs、
 *     校验和交叉复核），session_file 列按恢复策略（保持原值 / 改写到
 *     新 sessions 目录）期望后比较。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { MaterialRepository, TreeRepository, openDatabaseReadOnly } from "@treeai/persistence";
import type {
  BranchId,
  MaterialId,
  MaterialVersionId,
  PiEntryId,
  PiSessionId,
  PiVersion,
  SessionAvailability,
  SessionReference,
  TreeAIError,
  TreeId,
  TurnId,
} from "@treeai/contracts";
import { MaterialImportService } from "../src/materials/import-service.ts";
import { FACT_TABLES } from "../src/portability/package-format.ts";

/* ------------------------------------------------------------------ */
/* 代表性数据集                                                          */
/* ------------------------------------------------------------------ */

export interface RepresentativeDataset {
  readonly dir: string;
  readonly treeRepository: TreeRepository;
  readonly materialRepository: MaterialRepository;
  readonly importService: MaterialImportService;
  readonly treeId: TreeId;
  readonly secondTreeId: TreeId;
  readonly trunkBranchId: BranchId;
  readonly turnOriginBranchId: BranchId;
  readonly materialBranchId: BranchId;
  readonly materialId: MaterialId;
  readonly materialV1: MaterialVersionId;
  readonly materialV2: MaterialVersionId;
  readonly anchorTurnId: TurnId;
  /** 主干 Run（succeeded）的 session 文件（真实存在，供 --include-sessions）。 */
  readonly existingSessionFile: string;
  /** failed Run 指向的缺失 session 文件（导出时应如实记 missing）。 */
  readonly missingSessionFile: string;
  dispose(): void;
}

const MARKDOWN_V1 = [
  "# 聚类笔记（v1）",
  "",
  "聚类是把相似对象分组的无监督学习任务。",
  "",
  "K-means 以质心为中心迭代划分；DBSCAN 以密度连通定义簇。",
  "",
  "## 评估",
  "",
  "轮廓系数同时考虑内聚与分离，取值范围 -1 到 1。",
  "",
].join("\n");

const MARKDOWN_V2 = [
  "# 聚类笔记（v2 改版）",
  "",
  "聚类是把相似对象分组的无监督学习任务。",
  "",
  "K-means 以质心为中心迭代划分；DBSCAN 以密度连通定义簇；层次聚类逐层合并。",
  "",
  "## 评估",
  "",
  "轮廓系数同时考虑内聚与分离，取值范围 -1 到 1。",
  "",
].join("\n");

function sha256Of(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * 构建代表性数据集（真实导入流水线 + 真实仓储写入）。返回值携带断言用
 * id；dispose 关闭连接（磁盘保留，供导出/恢复消费）。
 */
export async function buildRepresentativeDataset(
  dir: string,
  options: { readonly fixedClock?: () => string } = {},
): Promise<RepresentativeDataset> {
  const dbPath = join(dir, "treeai.db");
  const treeRepository = TreeRepository.open({
    path: dbPath,
    ...(options.fixedClock !== undefined ? { now: options.fixedClock } : {}),
  });
  const materialRepository = MaterialRepository.open({
    path: dbPath,
    ...(options.fixedClock !== undefined ? { now: options.fixedClock } : {}),
  });
  const importService = new MaterialImportService({
    repository: materialRepository,
    ...(options.fixedClock !== undefined ? { now: options.fixedClock } : {}),
  });

  /* —— session 文件：一个真实存在（导出可复制），一个缺失（如实 missing）。 —— */
  mkdirSync(join(dir, "sessions"), { recursive: true });
  const existingSessionFile = join(dir, "sessions", "sess-main-0001.jsonl");
  writeFileSync(
    existingSessionFile,
    ["{\"role\":\"user\",\"text\":\"聚类怎么评估？\"}", "{\"role\":\"assistant\",\"text\":\"轮廓系数…\"}"].join("\n") + "\n",
    "utf8",
  );
  const missingSessionFile = join(dir, "sessions", "sess-gone-0002.jsonl");

  /* —— 森林/树/分支 —— */
  const forest = treeRepository.createForest();
  const tree = treeRepository.createTree(forest.id);
  const secondTree = treeRepository.createTree(forest.id);
  const trunk = treeRepository.createBranch(tree.id);
  const turnOriginBranch = treeRepository.createBranch(tree.id, { parentBranchId: trunk.id });
  const materialBranch = treeRepository.createBranch(tree.id, { parentBranchId: trunk.id });

  /* —— 材料（真实导入流水线 + 版本对）—— */
  const first = await importService.importMaterial(tree.id, {
    filename: "聚类笔记.md",
    bytes: new TextEncoder().encode(MARKDOWN_V1),
  });
  const v1Terminal = await untilVersionTerminal(importService, tree.id, first.material.id, first.version.id);
  if (v1Terminal === null || v1Terminal.parseStatus !== "ready") {
    throw new Error(`representative dataset: v1 did not reach ready (${String(v1Terminal?.parseStatus)})`);
  }
  const materialId = first.material.id;
  const materialV1 = first.version.id;
  const second = await importService.addMaterialVersion(tree.id, materialId, {
    filename: "聚类笔记-v2.md",
    bytes: new TextEncoder().encode(MARKDOWN_V2),
  });
  const v2Terminal = await untilVersionTerminal(importService, tree.id, materialId, second.version.id);
  if (v2Terminal === null || v2Terminal.parseStatus !== "ready") {
    throw new Error(`representative dataset: v2 did not reach ready (${String(v2Terminal?.parseStatus)})`);
  }
  const materialV2 = second.version.id;
  /* 第二棵树链接同一材料（跨树链接事实）。 */
  materialRepository.linkTreeMaterial(secondTree.id, materialId);

  /* —— 主干 Run（succeeded）+ user/assistant 回合 —— */
  const trunkEpisode = treeRepository.createEpisode(trunk.id);
  const available: SessionAvailability = { status: "available" };
  const mainRunSession: SessionReference = {
    sessionId: "sess-main-0001" as PiSessionId,
    sessionFile: existingSessionFile,
    entryId: "entry-0001" as PiEntryId,
    piVersion: "pi-test-1" as PiVersion,
    availability: available,
  };
  const mainRun = treeRepository.createRun(trunkEpisode.id, mainRunSession);
  treeRepository.updateRunState(mainRun.id, "running");
  treeRepository.updateRunState(mainRun.id, "succeeded");
  const userTurn = treeRepository.createTurn({
    treeId: tree.id,
    branchId: trunk.id,
    episodeId: trunkEpisode.id,
    runId: mainRun.id,
    role: "user",
    text: "聚类算法怎么评估好坏？",
  });
  const anchorTurn = treeRepository.createTurn({
    treeId: tree.id,
    branchId: trunk.id,
    episodeId: trunkEpisode.id,
    runId: mainRun.id,
    role: "assistant",
    text: "轮廓系数同时考虑簇内内聚与簇间分离，取值范围 -1 到 1，越接近 1 越好。",
    piEntryId: "entry-0001",
  });

  /* —— Turn 来源分支（branch_origins）—— */
  treeRepository.setBranchOrigin({
    branchId: turnOriginBranch.id,
    sourceBranchId: trunk.id,
    anchorTurnId: anchorTurn.id,
    anchorEntryId: "entry-0001",
    selection: { start: 0, end: 3, text: "轮廓系数同时考" },
  });

  /* —— 失败 Run（failed + failure_json + 缺失 session 引用）—— */
  const failingEpisode = treeRepository.createEpisode(turnOriginBranch.id);
  const missingRef: SessionReference = {
    sessionId: "sess-gone-0002" as PiSessionId,
    sessionFile: missingSessionFile,
    entryId: "entry-0002" as PiEntryId,
    piVersion: "pi-test-1" as PiVersion,
    availability: { status: "unavailable", reason: "missing-file", detail: "session file not found (deleted or moved)" },
  };
  const failedRun = treeRepository.createRun(failingEpisode.id, missingRef);
  const failure: TreeAIError = { code: "unknown", message: "model connection lost", details: { hostInterrupted: false } };
  treeRepository.updateRunState(failedRun.id, "failed", { failure });

  /* —— 材料建枝来源（material_branch_origins）：锚定 v1 的选区 —— */
  const v1Content = materialRepository.getVersionContent(materialV1);
  const firstBlock = v1Content.blocks[0];
  if (firstBlock === undefined) throw new Error("representative dataset: v1 has no blocks");
  const mStart = v1Content.canonicalText.indexOf("K-means");
  const mEnd = mStart + "K-means".length;
  materialRepository.insertMaterialBranchOrigin({
    branchId: materialBranch.id,
    treeId: tree.id,
    selection: {
      materialId,
      versionId: materialV1,
      blockId: firstBlock.blockId,
      start: mStart,
      end: mEnd,
      excerpt: v1Content.canonicalText.slice(mStart, mEnd),
      sourceHash: sha256Of(v1Content.canonicalText),
    },
  });

  /* —— 材料首问幂等（material_first_questions）—— */
  materialRepository.insertFirstQuestion({
    treeId: tree.id,
    branchId: materialBranch.id,
    intentKey: "intent-material-first-question-1",
  });

  /* —— 阅读位置（tree_material_reading_state）—— */
  materialRepository.upsertReadingPosition({
    treeId: tree.id,
    materialId,
    versionId: materialV2,
    blockId: firstBlock.blockId,
    focusStart: 0,
  });

  /* —— Return + 采用记录（turns role=return + delivered + attempts）—— */
  const adoptedReturn = treeRepository.createTurn({
    treeId: tree.id,
    branchId: trunk.id,
    episodeId: trunkEpisode.id,
    role: "return",
    text: "收获：轮廓系数取值 -1..1，兼顾内聚与分离。",
    fromBranchId: turnOriginBranch.id,
    idempotencyKey: "return-key-1",
    targetAnchor: {
      sourceBranchId: trunk.id,
      anchorTurnId: anchorTurn.id,
      anchorEntryId: "entry-0001",
      selection: { start: 0, end: 3, text: "轮廓系数同时考" },
    },
  });
  treeRepository.recordReturnAdoptionAttempt(adoptedReturn.id, mainRun.id);
  treeRepository.markReturnDelivered(adoptedReturn.id, mainRun.id);

  /* —— 术语批注 + 推广 + 派发账本（0007/0009）—— */
  const annotation = treeRepository.createTerminologyAnnotation({
    treeId: tree.id,
    branchId: trunk.id,
    anchorTurnId: anchorTurn.id,
    selection: { start: 0, end: 4, text: "轮廓系数同时" },
    sourceHash: sha256Of(anchorTurn.text),
    term: "轮廓系数",
    explanation: "轮廓系数（silhouette coefficient）衡量簇内内聚与簇间分离，取值 -1..1。",
    mode: "term",
  });
  treeRepository.bindTerminologyPromotion(annotation.id, "promo-key-1", materialBranch.id);
  treeRepository.createTerminologyDispatch({
    annotationId: annotation.id,
    treeId: tree.id,
    promotionKey: "promo-key-1",
    branchId: materialBranch.id,
    firstQuestionHash: sha256Of("什么是轮廓系数？"),
  });
  treeRepository.markTerminologyDispatchSent(annotation.id);
  treeRepository.settleTerminologyDispatch(annotation.id, { state: "succeeded", runId: mainRun.id });

  /* —— 术语执行器状态 kv（terminology_state）—— */
  treeRepository.setTerminologyState("usage", JSON.stringify({ estimatedTokens: 1234, calls: 7 }));

  /* —— 活动导航（tree_active_navigation）—— */
  treeRepository.saveActiveNavigation(tree.id, trunk.id, mainRunSession);

  return {
    dir,
    treeRepository,
    materialRepository,
    importService,
    treeId: tree.id,
    secondTreeId: secondTree.id,
    trunkBranchId: trunk.id,
    turnOriginBranchId: turnOriginBranch.id,
    materialBranchId: materialBranch.id,
    materialId,
    materialV1,
    materialV2,
    anchorTurnId: anchorTurn.id,
    existingSessionFile,
    missingSessionFile,
    dispose(): void {
      materialRepository.close();
      treeRepository.close();
    },
  };
}

/** 轮询版本至终态（b1 的 untilTerminal 同款；超时抛错）。 */
export async function untilVersionTerminal(
  service: MaterialImportService,
  treeId: TreeId,
  materialId: MaterialId,
  versionId: MaterialVersionId,
  timeoutMs = 30_000,
): Promise<{ readonly parseStatus: string } | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const detail = service.getMaterialDetail(treeId, materialId);
    const version = detail.versions.find((candidate) => candidate.id === versionId);
    if (version !== undefined && version.parseStatus !== "pending" && version.parseStatus !== "parsing") {
      return { parseStatus: version.parseStatus };
    }
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/* ------------------------------------------------------------------ */
/* 事实比较                                                             */
/* ------------------------------------------------------------------ */

/** 按 FACT_TABLES 冻结列序读取整表（确定性序）。 */
export function readTableRows(db: DatabaseSync, table: string): (string | number | null)[][] {
  const spec = FACT_TABLES.find((candidate) => candidate.table === table);
  if (spec === undefined) throw new Error(`unknown fact table '${table}'`);
  const columns = spec.columns.map((column) => column.name);
  return db
    .prepare(`SELECT ${columns.join(", ")} FROM ${table} ORDER BY ${spec.orderBy}`)
    .all() as unknown as (string | number | null)[][];
}

export interface ComparisonOptions {
  /**
   * 恢复策略下 session_file 列的期望值：
   * - null：保持原值（默认导出——未含 session）；
   * - 目录路径：改写为 <dir>/<basename>（--include-sessions 恢复）。
   */
  readonly expectedSessionsDir?: string | null;
}

export interface ComparisonProblem {
  readonly table: string;
  readonly message: string;
}

/** 材料原件字节（content_hash → bytes）。 */
export function readBlobMap(db: DatabaseSync): Map<string, Uint8Array> {
  const rows = db
    .prepare("SELECT content_hash, bytes FROM material_blobs ORDER BY content_hash")
    .all() as unknown as Array<{ content_hash: string; bytes: Uint8Array }>;
  return new Map(rows.map((row) => [row.content_hash, row.bytes]));
}

/**
 * 两个产品库的全部事实表逐行比较 + blobs 比较。
 * 返回问题列表（空 = 完全一致）。session_file 按恢复策略期望后比较。
 */
export function compareProductDatabases(
  sourceDbPath: string,
  restoredDbPath: string,
  options: ComparisonOptions = {},
): ComparisonProblem[] {
  const problems: ComparisonProblem[] = [];
  const source = openDatabaseReadOnly(sourceDbPath);
  const restored = openDatabaseReadOnly(restoredDbPath);
  try {
    for (const spec of FACT_TABLES) {
      const sessionColumnIndex = spec.columns.findIndex((column) => column.name === "session_file");
      const left = readTableRows(source, spec.table);
      const right = readTableRows(restored, spec.table);
      if (left.length !== right.length) {
        problems.push({ table: spec.table, message: `row count ${left.length} -> ${right.length}` });
        continue;
      }
      for (let rowIndex = 0; rowIndex < left.length; rowIndex += 1) {
        const a = left[rowIndex]!;
        const b = right[rowIndex]!;
        let equal = JSON.stringify(a) === JSON.stringify(b);
        /* session_file 列的合法期望有两种：保持原值（未随包的引用）或
           改写到新 sessions 目录（随包引用被恢复改写）——两者都可接受。 */
        if (
          !equal &&
          sessionColumnIndex >= 0 &&
          options.expectedSessionsDir !== undefined &&
          options.expectedSessionsDir !== null
        ) {
          const sourceSession = a[sessionColumnIndex];
          const restoredSession = b[sessionColumnIndex];
          if (typeof sourceSession === "string" && typeof restoredSession === "string") {
            const basename = sourceSession.split("/").pop() ?? sourceSession;
            equal = restoredSession === join(options.expectedSessionsDir, basename) || restoredSession === sourceSession;
          }
        }
        if (!equal) {
          problems.push({
            table: spec.table,
            message: `row ${rowIndex} differs: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`,
          });
        }
      }
    }
    const sourceBlobs = readBlobMap(source);
    const restoredBlobs = readBlobMap(restored);
    if (sourceBlobs.size !== restoredBlobs.size) {
      problems.push({ table: "material_blobs", message: `count ${sourceBlobs.size} -> ${restoredBlobs.size}` });
    }
    for (const [hash, bytes] of sourceBlobs) {
      const other = restoredBlobs.get(hash);
      if (other === undefined) {
        problems.push({ table: "material_blobs", message: `blob ${hash} missing after restore` });
        continue;
      }
      if (Buffer.compare(Buffer.from(bytes), Buffer.from(other)) !== 0) {
        problems.push({ table: "material_blobs", message: `blob ${hash} bytes differ` });
      }
    }
  } finally {
    restored.close();
    source.close();
  }
  return problems;
}



export function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function removeDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

export function fileExists(path: string): boolean {
  return existsSync(path);
}

export function readTextFile(path: string): string {
  return readFileSync(path, "utf8");
}
