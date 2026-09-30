/**
 * D4-6 性能 —— B6 数据集装载器（生成工件 → 真实产品库）。
 *
 * 装载纪律（镜像 b9-loader / 结构真值 → 真实产品库的同款纪律）：
 *  - 只经真实仓储 API（TreeRepository / MaterialRepository）写入——不写裸
 *    SQL、不发明表、不加迁移；材料经真实 d4-md-v1 / d4-pdf-v1 解析器落为
 *    ready 版本（canonicalText/块图由解析产出，装载前与结构真值逐字比对）；
 *  - 确定性时钟：两仓储共享同一注入 `now`（B6_EPOCH 起每调用 +1s）——
 *    created_at 严格随创建序递增，真实时间戳不进产品库；
 *  - 事实形态与产品一致：问答对经 episode/run 承载（assistant Turn 带
 *    piEntryId）；批注锚定同分支 assistant Turn（选区切片一致 + sourceHash
 *    由仓储再校验）；Return 以 role="return" Turn 落库（fromBranchId +
 *    树内幂等键 + targetAnchor）；
 *  - SessionReference 为确定性合成引用（b6 离线数据集）：文件不存在，
 *    availability 记为 available（产品事实只存引用三元组——与 b9 同款）。
 *
 * 输入：生成器输出目录（materials/ + b6-truth.json）。非目标：跨仓储原子
 * 性（装载目标是全新临时库，失败即弃目录）。
 */

import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { MaterialRepository, TreeRepository } from "@treeai/persistence";
import type {
  BranchId,
  EpisodeId,
  ForestId,
  IsoTimestamp,
  MaterialBlock,
  MaterialId,
  MaterialVersionId,
  PiEntryId,
  PiSessionId,
  PiVersion,
  RunId,
  SessionReference,
  TreeId,
  TurnId,
} from "@treeai/contracts";

import {
  MARKDOWN_PARSER_VERSION,
  parseMarkdownMaterial,
} from "../../../apps/studio/src/materials/markdown-parser.ts";
import { PDF_PARSER_VERSION, parsePdfMaterial } from "../../../apps/studio/src/materials/pdf-parser.ts";
import {
  B6_EPOCH_MS,
  buildMarkdownSource,
  buildPdfCanonicalText,
  type B6Dataset,
} from "./d4-b6-dataset.ts";

/* ------------------------------------------------------------------ */
/* 确定时钟                                                             */
/* ------------------------------------------------------------------ */

export interface B6Clock {
  now: () => IsoTimestamp;
  ticks: () => number;
}

/** B6 确定时钟：2026-09-30T00:00:00Z 起，每调用 +1 秒（两仓储共享）。 */
export function createB6Clock(): B6Clock {
  let tick = 0;
  return {
    now: (): IsoTimestamp => new Date(B6_EPOCH_MS + tick++ * 1000).toISOString() as IsoTimestamp,
    ticks: (): number => tick,
  };
}

/* ------------------------------------------------------------------ */
/* 仓储对（同一数据目录上的两个真实连接 + 共享时钟）                       */
/* ------------------------------------------------------------------ */

export interface B6Repositories {
  readonly repository: TreeRepository;
  readonly materialRepository: MaterialRepository;
  readonly clock: B6Clock;
  close(): void;
}

/** 在数据目录上打开 B6 装载用的一对真实仓储（treeai.db，共享确定性时钟）。 */
export function openB6Repositories(dataDir: string): B6Repositories {
  mkdirSync(dataDir, { recursive: true });
  const clock = createB6Clock();
  const repository = TreeRepository.open({ path: join(dataDir, "treeai.db"), now: clock.now });
  const materialRepository = MaterialRepository.open({ path: join(dataDir, "treeai.db"), now: clock.now });
  return {
    repository,
    materialRepository,
    clock,
    close(): void {
      materialRepository.close();
      repository.close();
    },
  };
}

/* ------------------------------------------------------------------ */
/* 装载                                                                 */
/* ------------------------------------------------------------------ */

export interface B6LoadStats {
  readonly materials: number;
  readonly materialVersions: number;
  readonly treeMaterialLinks: number;
  readonly forests: number;
  readonly trees: number;
  readonly branches: number;
  readonly episodes: number;
  readonly runs: number;
  readonly userTurns: number;
  readonly assistantTurns: number;
  readonly returnTurns: number;
  readonly annotations: number;
  readonly totalCanonicalUnits: number;
  readonly elapsedMs: number;
  readonly clockTicks: number;
}

function sessionReferenceFor(branchId: string, treeId: string): SessionReference {
  return {
    sessionId: `b6-session-${branchId}` as PiSessionId,
    sessionFile: `${treeId}/sessions/${branchId}.jsonl`,
    entryId: `${branchId}-entry` as PiEntryId,
    piVersion: "b6-offline-1" as PiVersion,
    availability: { status: "available" },
  };
}

/** 读入生成器输出目录的结构真值（b6-truth.json）。 */
export function readB6Truth(dir: string): B6Dataset {
  return JSON.parse(readFileSync(join(dir, "b6-truth.json"), "utf8")) as B6Dataset;
}

/**
 * 把 B6 数据集装载进一对真实仓储（材料 → 树结构 → 事实）。
 *
 * 分相提交：材料逐份事务（解析 → 比对真值 → 落 ready 版本）；树结构与
 * 全部事实按相分组进入仓储事务（SQLite 单事务批量写，万级行秒级完成）。
 * 任何一步与结构真值不符即抛错（装载目标是全新临时库，无部分失败语义）。
 */
export function loadB6Dataset(dataset: B6Dataset, outDir: string, repos: B6Repositories): B6LoadStats {
  const startedAt = performance.now();
  const { repository, materialRepository } = repos;
  const materialsDir = join(outDir, "materials");
  let materialVersions = 0;
  let treeMaterialLinks = 0;
  let totalCanonicalUnits = 0;

  // —— 第 1 相：材料（真实解析 → 真值比对 → ready 版本；链接在第 3 相，
  //    树结构之后——linkTreeMaterial 校验树存在） ——
  for (const material of dataset.materials) {
    const bytes = new Uint8Array(readFileSync(join(materialsDir, material.filename)));
    let canonicalText: string;
    let blocks: readonly MaterialBlock[];
    if (material.kind === "markdown") {
      const parsed = parseMarkdownMaterial(bytes);
      if (!parsed.ok) {
        throw new Error(`b6-loader: material ${material.materialId} failed d4-md-v1 parse (${parsed.reason})`);
      }
      canonicalText = parsed.canonicalText;
      blocks = parsed.blocks.map(
        (block): MaterialBlock => ({
          blockId: block.blockId,
          kind: block.kind,
          start: block.start,
          end: block.end,
        }),
      );
      const expected = buildMarkdownSource(material.paragraphs);
      if (canonicalText !== expected) {
        throw new Error(`b6-loader: markdown ${material.materialId} canonical text diverges from the truth`);
      }
      if (canonicalText.length !== material.units) {
        throw new Error(
          `b6-loader: markdown ${material.materialId} units ${String(canonicalText.length)} != plan ${String(material.units)}`,
        );
      }
    } else {
      const parsed = parsePdfMaterial(bytes);
      if (!parsed.ok) {
        throw new Error(`b6-loader: material ${material.materialId} failed d4-pdf-v1 parse (${parsed.reason}): ${parsed.message}`);
      }
      canonicalText = parsed.canonicalText;
      blocks = parsed.blocks.map(
        (block): MaterialBlock => ({
          blockId: block.blockId,
          kind: block.kind,
          start: block.start,
          end: block.end,
          page: block.page,
        }),
      );
      const expected = buildPdfCanonicalText(material.pages);
      if (canonicalText !== expected) {
        throw new Error(
          `b6-loader: pdf ${material.materialId} canonical text diverges from the truth (parsed ${String(canonicalText.length)} units, expected ${String(expected.length)})`,
        );
      }
      if (parsed.pages !== material.pages.length) {
        throw new Error(
          `b6-loader: pdf ${material.materialId} pages ${String(parsed.pages)} != plan ${String(material.pages.length)}`,
        );
      }
    }
    if (canonicalText.slice(material.needleIndex, material.needleIndex + material.needle.length) !== material.needle) {
      throw new Error(`b6-loader: material ${material.materialId} needle not at the truth offset`);
    }
    materialRepository.transaction((): void => {
      materialRepository.createMaterial({
        id: material.materialId as MaterialId,
        title: material.title,
      });
      materialRepository.insertVersion({
        id: material.versionId as MaterialVersionId,
        materialId: material.materialId as MaterialId,
        bytes,
        parserKind: material.kind,
        parserVersion: material.kind === "markdown" ? MARKDOWN_PARSER_VERSION : PDF_PARSER_VERSION,
        parseStatus: "ready",
        canonicalText,
        blocks,
      });
    });
    materialVersions += 1;
    totalCanonicalUnits += canonicalText.length;
  }

  // —— 第 2 相：森林 + 树结构（单事务） ——
  repository.transaction((): void => {
    repository.createForest({ id: dataset.forestId as ForestId });
    for (const tree of dataset.trees) {
      repository.createTree(dataset.forestId as ForestId, { id: tree.treeId as TreeId });
      for (const branch of tree.branches) {
        repository.createBranch(tree.treeId as TreeId, {
          id: branch.id as BranchId,
          parentBranchId: branch.parentId === null ? null : (branch.parentId as BranchId),
        });
      }
    }
  });

  // —— 第 3 相：树×材料链接 ——
  materialRepository.transaction((): void => {
    for (const material of dataset.materials) {
      materialRepository.linkTreeMaterial(material.treeId as TreeId, material.materialId as MaterialId);
      treeMaterialLinks += 1;
    }
  });

  // —— 第 4 相：episode/run + Turn（问答对） ——
  const branchesWithPairs = new Map<string, { treeId: string; episodeId: string; runId: string }>();
  for (const pair of dataset.qaPairs) {
    if (!branchesWithPairs.has(pair.branchId)) {
      branchesWithPairs.set(pair.branchId, {
        treeId: pair.treeId,
        episodeId: pair.episodeId,
        runId: pair.runId,
      });
    }
  }
  repository.transaction((): void => {
    for (const [branchId, info] of branchesWithPairs) {
      repository.createEpisode(branchId as BranchId, { id: info.episodeId as EpisodeId });
      repository.createRun(info.episodeId as EpisodeId, sessionReferenceFor(branchId, info.treeId), {
        id: info.runId as RunId,
      });
    }
  });
  let userTurns = 0;
  let assistantTurns = 0;
  repository.transaction((): void => {
    for (const pair of dataset.qaPairs) {
      repository.createTurn({
        id: pair.userTurnId as TurnId,
        treeId: pair.treeId as TreeId,
        branchId: pair.branchId as BranchId,
        episodeId: pair.episodeId as EpisodeId,
        runId: pair.runId as RunId,
        role: "user",
        text: pair.question,
      });
      userTurns += 1;
      repository.createTurn({
        id: pair.assistantTurnId as TurnId,
        treeId: pair.treeId as TreeId,
        branchId: pair.branchId as BranchId,
        episodeId: pair.episodeId as EpisodeId,
        runId: pair.runId as RunId,
        role: "assistant",
        text: pair.answer,
        piEntryId: `${pair.assistantTurnId}-entry`,
      });
      assistantTurns += 1;
    }
  });

  // —— 第 5 相：术语批注（锚点/选区/sourceHash 由仓储校验） ——
  repository.transaction((): void => {
    for (const annotation of dataset.annotations) {
      repository.createTerminologyAnnotation({
        treeId: annotation.treeId as TreeId,
        branchId: annotation.branchId as BranchId,
        anchorTurnId: annotation.anchorTurnId as TurnId,
        selection: { start: annotation.selStart, end: annotation.selEnd, text: annotation.selText },
        sourceHash: annotation.sourceHash,
        term: annotation.term,
        explanation: annotation.explanation,
        mode: "term",
      });
    }
  });

  // —— 第 6 相：Return（role="return" Turn） ——
  let returnTurns = 0;
  repository.transaction((): void => {
    for (const item of dataset.returns) {
      repository.createTurn({
        id: item.returnTurnId as TurnId,
        treeId: item.treeId as TreeId,
        branchId: item.branchId as BranchId,
        episodeId: branchesWithPairs.get(item.branchId)!.episodeId as EpisodeId,
        role: "return",
        text: item.text,
        fromBranchId: item.fromBranchId as BranchId,
        idempotencyKey: item.idempotencyKey,
        targetAnchor: {
          sourceBranchId: item.branchId as BranchId,
          anchorTurnId: item.anchorTurnId as TurnId,
          anchorEntryId: item.anchorEntryId,
          selection: { start: item.selStart, end: item.selEnd, text: item.selText },
        },
      });
      returnTurns += 1;
    }
  });

  const trees = dataset.trees.length;
  const branches = dataset.trees.reduce((sum, tree) => sum + tree.branches.length, 0);
  const annotations = dataset.annotations.length;
  return {
    materials: dataset.materials.length,
    materialVersions,
    treeMaterialLinks,
    forests: 1,
    trees,
    branches,
    episodes: branchesWithPairs.size,
    runs: branchesWithPairs.size,
    userTurns,
    assistantTurns,
    returnTurns,
    annotations,
    totalCanonicalUnits,
    elapsedMs: performance.now() - startedAt,
    clockTicks: repos.clock.ticks(),
  };
}

/** 便捷入口：读入生成器输出目录 → 装载 → 行数与结构真值核对。 */
export interface B6LoadedInstance extends B6Repositories {
  readonly dataset: B6Dataset;
  readonly loadStats: B6LoadStats;
  readonly dataDir: string;
}

export function loadB6IntoFreshDir(outDir: string, dataDir: string): B6LoadedInstance {
  const dataset = readB6Truth(outDir);
  const repos = openB6Repositories(dataDir);
  let loadStats: B6LoadStats;
  try {
    loadStats = loadB6Dataset(dataset, outDir, repos);
  } catch (error) {
    repos.close();
    throw error;
  }
  const expected = dataset.totals;
  const ok =
    loadStats.materialVersions === expected.materials &&
    loadStats.branches === expected.branchRows &&
    loadStats.trees === expected.trees &&
    loadStats.userTurns + loadStats.assistantTurns === expected.turnFacts &&
    loadStats.returnTurns === expected.returnFacts &&
    loadStats.annotations === expected.annotationFacts &&
    loadStats.totalCanonicalUnits === expected.totalTextUnits &&
    repos.repository.integrityCheck().ok;
  if (!ok) {
    repos.close();
    throw new Error(
      `b6-loader: load stats diverge from truth (versions ${String(loadStats.materialVersions)}/${String(expected.materials)}, ` +
        `branches ${String(loadStats.branches)}/${String(expected.branchRows)}, turns ${String(loadStats.userTurns + loadStats.assistantTurns)}/${String(expected.turnFacts)}, ` +
        `returns ${String(loadStats.returnTurns)}/${String(expected.returnFacts)}, annotations ${String(loadStats.annotations)}/${String(expected.annotationFacts)}, ` +
        `units ${String(loadStats.totalCanonicalUnits)}/${String(expected.totalTextUnits)})`,
    );
  }
  return {
    ...repos,
    dataset,
    loadStats,
    dataDir,
    close: repos.close,
  };
}
