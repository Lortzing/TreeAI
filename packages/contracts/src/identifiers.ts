/**
 * TreeAI 领域标识与关系（任务书 §3.3 第 3 项冻结内容）。
 *
 * 层级：Forest → Tree → Branch → Episode → Run。
 * Run 通过 SessionReference 关联 Pi 会话（Pi 侧的树导航在同一 session 内
 * 移动 entryId 叶指针，Branch/Episode 与 entryId 的映射由调用方维护）。
 *
 * 说明：本文件冻结的是**标识与关联关系的共享形状**。存储 schema、索引、
 * 迁移与事务由 persistence（Agent C）拥有；这些接口是各模块交换
 * 域数据时的公共语言，不是存储定义。
 */
import type { Brand } from "./branding.js";
import type { TreeAIError } from "./errors.js";
import type { SessionReference } from "./session-reference.js";
import type { RunState } from "./run-state.js";

/** UTC ISO 8601 时间戳字符串（如 "2026-09-21T00:00:00.000Z"）。 */
export type IsoTimestamp = string;

export type ForestId = Brand<string, "ForestId">;
export type TreeId = Brand<string, "TreeId">;
export type BranchId = Brand<string, "BranchId">;
export type EpisodeId = Brand<string, "EpisodeId">;
export type RunId = Brand<string, "RunId">;

/** 事件标识（TreeAIEvent 与 PiRuntimeEvent 共用的不透明唯一 id 空间）。 */
export type EventId = Brand<string, "EventId">;

/** Forest：最外层容器（一个受信任本地库通常单 Forest）。 */
export interface Forest {
  readonly id: ForestId;
  readonly createdAt: IsoTimestamp;
}

/** Tree：属于一个 Forest 的会话树。 */
export interface Tree {
  readonly id: TreeId;
  readonly forestId: ForestId;
  readonly createdAt: IsoTimestamp;
}

/**
 * Branch：Tree 内的分支。`parentBranchId === null` 表示根分支；
 * 从既有分支创建第二分支时 parentBranchId 指向来源分支。
 */
export interface Branch {
  readonly id: BranchId;
  readonly treeId: TreeId;
  readonly parentBranchId: BranchId | null;
  readonly createdAt: IsoTimestamp;
}

/** Episode：Branch 上的一次对话单元（含一或多个 Run）。 */
export interface Episode {
  readonly id: EpisodeId;
  readonly branchId: BranchId;
  readonly createdAt: IsoTimestamp;
}

/**
 * Run：一次 agent 执行（一次 prompt 及其 steer 派生 turn）。
 *
 * 不变量：
 * - Run 创建时 state 为 `queued`（run-state.ts I1）。
 * - `terminalAt` 非空当且仅当 state 为终态。
 * - `failure` 存在当且仅当 state === "failed"（已脱敏）。
 * - `session` 是该 Run 时刻的 Pi 会话引用快照；prompt/navigateTree 后
 *   由调用方以新引用更新，不就地修改。
 * - Run 终态后不再变更（run-state.ts I2/I3）。
 */
export interface Run {
  readonly id: RunId;
  readonly episodeId: EpisodeId;
  readonly state: RunState;
  readonly session: SessionReference;
  readonly createdAt: IsoTimestamp;
  readonly terminalAt: IsoTimestamp | null;
  readonly failure?: TreeAIError;
}

/** 便捷关系引用（用于跨模块传"定位"而不传完整实体）。 */
export interface TreeLocator {
  readonly forestId: ForestId;
  readonly treeId: TreeId;
}

export interface BranchLocator {
  readonly forestId: ForestId;
  readonly treeId: TreeId;
  readonly branchId: BranchId;
}

export interface EpisodeLocator {
  readonly forestId: ForestId;
  readonly treeId: TreeId;
  readonly branchId: BranchId;
  readonly episodeId: EpisodeId;
}

export interface RunLocator {
  readonly forestId: ForestId;
  readonly treeId: TreeId;
  readonly branchId: BranchId;
  readonly episodeId: EpisodeId;
  readonly runId: RunId;
}
