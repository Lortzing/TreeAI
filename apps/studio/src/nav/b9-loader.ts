/**
 * D4-8 大规模树导航 —— B9 数据集装载器（结构真值 → 真实产品库）。
 *
 * 装载纪律（任务书 D4-8 引擎增量）：
 *  - 只经真实仓储 API（TreeRepository / MaterialRepository）写入——不写
 *    裸 SQL、不发明表、不加迁移（0010 号属协调资源，本增量不碰）；
 *  - 分支标题落为该分支**首个 user Turn** 的文本（产品事实；Tree/Branch
 *    无标题列——歧义解决记录随 D4-8 报告回写）；
 *  - Turn 来源经 `setBranchOrigin`（锚点=父分支 assistant Turn + 选区切片
 *    一致性由仓储校验）；Material 来源经 `insertMaterialBranchOrigin`
 *    （材料=内置最小 md fixture，经真实 d4-md-v1 解析器落为 ready 版本；
 *    选区纪律/来源哈希由仓储再校验一遍）；
 *  - 确定性时钟：两仓储共享同一注入 `now`（B9_EPOCH 起每调用 +1s）——
 *    created_at 严格随创建序递增，装载后的行序（created_at, rowid）与
 *    结构真值的创建序一致；无真实时间戳进入产品库；
 *  - SessionReference 是确定性合成引用（b9 离线数据集）：文件不存在，
 *    availability 记为 available（产品事实只存引用三元组，不校验文件
 *    存在性——ADR-001 §4；运行期探针/清扫属接线增量）。
 *
 * 装载非目标（诚实边界）：跨仓储原子性（两连接各自事务；装载目标是
 * 全新临时库，失败即弃目录，不需要跨库回滚）；真实 Pi 会话文件。
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { MaterialRepository, TreeRepository } from "@treeai/persistence";
import type {
  BranchId,
  EpisodeId,
  ForestId,
  IsoTimestamp,
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
import { MARKDOWN_PARSER_VERSION, parseMarkdownMaterial } from "../materials/markdown-parser.ts";
import { sha256Hex, type B9Dataset, type B9Tree } from "./b9-dataset.ts";

/* ------------------------------------------------------------------ */
/* 确定时钟                                                             */
/* ------------------------------------------------------------------ */

const B9_EPOCH_MS = Date.parse("2026-09-30T00:00:00.000Z");

export interface B9Clock {
  now: () => IsoTimestamp;
  ticks: () => number;
}

/** B9 确定时钟：2026-09-30T00:00:00Z 起，每调用 +1 秒（两仓储共享）。 */
export function createB9Clock(): B9Clock {
  let tick = 0;
  return {
    now: (): IsoTimestamp => new Date(B9_EPOCH_MS + tick++ * 1000).toISOString() as IsoTimestamp,
    ticks: (): number => tick,
  };
}

/* ------------------------------------------------------------------ */
/* 仓储对（同一数据目录上的两个真实连接 + 共享时钟）                       */
/* ------------------------------------------------------------------ */

export interface B9Repositories {
  readonly repository: TreeRepository;
  readonly materialRepository: MaterialRepository;
  readonly clock: B9Clock;
  /** 关闭两个连接（不删数据——目录由调用方管理）。 */
  close(): void;
}

/** 在数据目录上打开 B9 装载用的一对真实仓储（treeai.db，共享确定性时钟）。 */
export function openB9Repositories(dataDir: string): B9Repositories {
  mkdirSync(dataDir, { recursive: true });
  const clock = createB9Clock();
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
/* 装载                                                                */
/* ------------------------------------------------------------------ */

export interface B9LoadStats {
  readonly forests: number;
  readonly trees: number;
  readonly branches: number;
  readonly episodes: number;
  readonly runs: number;
  readonly userTurns: number;
  readonly assistantTurns: number;
  readonly materials: number;
  readonly materialVersions: number;
  readonly treeMaterialLinks: number;
  readonly turnOrigins: number;
  readonly materialOrigins: number;
  readonly elapsedMs: number;
  readonly clockTicks: number;
}

function sessionReferenceFor(nodeId: string, treeId: string): SessionReference {
  return {
    sessionId: `b9-session-${nodeId}` as PiSessionId,
    sessionFile: `${treeId}/sessions/${nodeId}.jsonl`,
    entryId: `${nodeId}-run1-entry` as PiEntryId,
    piVersion: "b9-offline-1" as PiVersion,
    availability: { status: "available" },
  };
}

function loadTreeStructure(repository: TreeRepository, forestId: string, tree: B9Tree, stats: LoadCounters): void {
  repository.createTree(forestId as ForestId, { id: tree.treeId as TreeId });
  for (const node of tree.nodes) {
    repository.createBranch(tree.treeId as TreeId, {
      id: node.id as BranchId,
      parentBranchId: node.parentId === null ? null : (node.parentId as BranchId),
    });
    stats.branches += 1;
    const title = node.title;
    if (title === null) continue; // 空树 trunk：无 Turn（诚实空树）
    const episode = repository.createEpisode(node.id as BranchId, { id: `${node.id}-ep1` as EpisodeId });
    stats.episodes += 1;
    repository.createRun(episode.id, sessionReferenceFor(node.id, tree.treeId), {
      id: `${node.id}-run1` as RunId,
    });
    stats.runs += 1;
    repository.createTurn({
      id: `${node.id}-q1` as TurnId,
      treeId: tree.treeId as TreeId,
      branchId: node.id as BranchId,
      episodeId: episode.id,
      runId: `${node.id}-run1` as RunId,
      role: "user",
      text: title,
    });
    stats.userTurns += 1;
    if (node.answerText !== null) {
      // Turn 来源锚点：作为 source 的分支需要一条带 piEntryId 的 assistant Turn。
      repository.createTurn({
        id: `${node.id}-a1` as TurnId,
        treeId: tree.treeId as TreeId,
        branchId: node.id as BranchId,
        episodeId: episode.id,
        runId: `${node.id}-run1` as RunId,
        role: "assistant",
        text: node.answerText,
        piEntryId: `${node.id}-a1-entry`,
      });
      stats.assistantTurns += 1;
    }
  }
}

interface LoadCounters {
  branches: number;
  episodes: number;
  runs: number;
  userTurns: number;
  assistantTurns: number;
}

/**
 * 把 B9 数据集装载进一对真实仓储（材料 → 树结构 → 链接 → 来源）。
 *
 * 分相提交：材料与树结构各自在仓储事务内成批落库（SQLite 单事务批量写，
 * 万级行秒级完成）；来源逐条写入（仓储自带校验，失败即抛——装载目标
 * 是全新临时库，无部分失败续跑语义）。
 */
export function loadB9Dataset(dataset: B9Dataset, repos: B9Repositories): B9LoadStats {
  const startedAt = performance.now();
  const { repository, materialRepository } = repos;
  const stats: LoadCounters = { branches: 0, episodes: 0, runs: 0, userTurns: 0, assistantTurns: 0 };
  let materialVersions = 0;
  let treeMaterialLinks = 0;
  let turnOrigins = 0;
  let materialOrigins = 0;

  // —— 第 1 相：材料（真实 d4-md-v1 解析 → ready 版本） ——
  for (const material of dataset.materials) {
    const bytes = new TextEncoder().encode(material.markdown);
    const parsed = parseMarkdownMaterial(bytes);
    if (!parsed.ok) {
      throw new Error(`b9-loader: material ${material.materialId} failed to parse (${parsed.reason})`);
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
        parserKind: "markdown",
        parserVersion: MARKDOWN_PARSER_VERSION,
        parseStatus: "ready",
        canonicalText: parsed.canonicalText,
        blocks: parsed.blocks.map((block) => ({
          blockId: block.blockId,
          kind: block.kind,
          start: block.start,
          end: block.end,
        })),
      });
    });
    materialVersions += 1;
  }

  // —— 第 2 相：森林 + 全部树结构（单事务批量写） ——
  repository.transaction((): void => {
    repository.createForest({ id: dataset.forestId as ForestId });
    for (const tree of dataset.trees) {
      loadTreeStructure(repository, dataset.forestId, tree, stats);
    }
  });

  // —— 第 3 相：树×材料链接（只链真实使用的组合） ——
  const links = new Set<string>();
  for (const tree of dataset.trees) {
    for (const node of tree.nodes) {
      if (node.origin?.kind !== "material") continue;
      const key = `${tree.treeId}::${node.origin.materialId}`;
      if (links.has(key)) continue;
      links.add(key);
      materialRepository.linkTreeMaterial(tree.treeId as TreeId, node.origin.materialId as MaterialId);
      treeMaterialLinks += 1;
    }
  }

  // —— 第 4 相：来源（Turn 走 TreeRepository；Material 走 MaterialRepository） ——
  for (const tree of dataset.trees) {
    for (const node of tree.nodes) {
      if (node.origin?.kind === "turn") {
        const origin = node.origin;
        repository.setBranchOrigin({
          branchId: node.id as BranchId,
          sourceBranchId: origin.sourceBranchId as BranchId,
          anchorTurnId: origin.anchorTurnId as TurnId,
          anchorEntryId: origin.anchorEntryId,
          selection: { start: origin.selStart, end: origin.selEnd, text: origin.selText },
        });
        // TreeRepository.setBranchOrigin 不维护 branches.origin_kind（0008 判别列
        // 的回填只覆盖迁移前的既有行）；类型标记经 setBranchOriginKind 落库
        // （其内部校验 turn ⇔ branch_origins 行且无材料来源——双重防御）。
        materialRepository.setBranchOriginKind(node.id as BranchId, "turn");
        turnOrigins += 1;
      } else if (node.origin?.kind === "material") {
        const origin = node.origin;
        const content = materialRepository.getVersionContent(origin.versionId as MaterialVersionId);
        const sourceHash = sha256Hex(content.canonicalText);
        materialRepository.insertMaterialBranchOrigin({
          branchId: node.id as BranchId,
          treeId: tree.treeId as TreeId,
          selection: {
            materialId: origin.materialId as MaterialId,
            versionId: origin.versionId as MaterialVersionId,
            blockId: origin.blockId,
            start: origin.start,
            end: origin.end,
            excerpt: origin.excerpt,
            sourceHash,
          },
        });
        materialOrigins += 1;
      }
    }
  }

  return {
    forests: 1,
    trees: dataset.trees.length,
    branches: stats.branches,
    episodes: stats.episodes,
    runs: stats.runs,
    userTurns: stats.userTurns,
    assistantTurns: stats.assistantTurns,
    materials: dataset.materials.length,
    materialVersions,
    treeMaterialLinks,
    turnOrigins,
    materialOrigins,
    elapsedMs: performance.now() - startedAt,
    clockTicks: repos.clock.ticks(),
  };
}

/** 便捷入口：临时数据目录 + 装载 + 校验装载行数与结构真值一致。 */
export interface B9LoadedInstance extends B9Repositories {
  readonly dataset: B9Dataset;
  readonly loadStats: B9LoadStats;
  readonly dataDir: string;
}

export function loadB9IntoFreshDir(dataset: B9Dataset, dataDir: string): B9LoadedInstance {
  const repos = openB9Repositories(dataDir);
  let loadStats: B9LoadStats;
  try {
    loadStats = loadB9Dataset(dataset, repos);
  } catch (error) {
    repos.close();
    throw error;
  }
  if (loadStats.branches !== dataset.totals.branchRows) {
    repos.close();
    throw new Error(
      `b9-loader: branch row count ${String(loadStats.branches)} !== dataset totals ${String(dataset.totals.branchRows)}`,
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
