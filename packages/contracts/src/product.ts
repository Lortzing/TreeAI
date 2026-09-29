/**
 * D3 产品层共享形状（Core MVP，2026-09-28）。
 *
 * 定位：D2 冻结的是运行时契约（Forest/Tree/Branch/Episode/Run 标识、
 * SessionReference、RunState、事件、错误、PiRuntime 接口）。D3 的产品
 * 行为——对话 Turn（Trunk/Branch 会话内容）、Branch 锚点（从 Trunk
 * 答案选区创建分支的出处）、Return（分支显式回归主干）——需要跨包
 * 交换的实体形状，按 contracts-README §3 规则 3 以**纯新增**方式放入
 * 本包（不修改任何 D2 冻结文件的内容与语义）。
 *
 * 与 D2 契约的关系：
 * - Turn/BranchOrigin 复用 D2 标识（BranchId/EpisodeId/RunId/PiEntryId），
 *   不引入新的运行时语义；
 * - 存储实现归 persistence（migration 0002）；本文件只定义共享形状，
 *   与 identifiers.ts 的分工一致；
 * - Pi 会话仍只经 SessionReference 引用（ADR-001 §4）：Turn 持有的
 *   piEntryId 是导航锚点，不是 Pi 内容的复制品。
 *
 * Turn 不变量：
 * - role "user"/"assistant"：一次 Run 的两侧文本；runId 非空、
 *   fromBranchId/deliveredRunId 为空；
 * - role "return"：用户在分支上编辑后显式提交的回归消息，记录在主干
 *   分支上；runId 为空（不经模型执行）、fromBranchId 非空（出处分支）；
 * - piEntryId：仅 assistant turn 携带（PiPromptResult.reference.entryId，
 *   即该 Run 完成后的叶条目）；user turn 经 PiRuntime 契约拿不到自身
 *   条目 id，固定为 null；
 * - deliveredRunId：仅 return turn 使用——把它送入主干 Pi 上下文的
 *   那次主干 Run（见产品服务）；未送达为 null。
 *
 * BranchOrigin 不变量：
 * - 每个非根分支至多一条 origin 记录（根分支/无锚点分支没有）；
 * - anchorTurnId 必须指向 sourceBranchId 分支上的 assistant turn；
 * - selection 是 anchor 答案文本内的连续选区，满足
 *   0 <= start <= end <= anchor.text.length 且
 *   anchor.text.slice(start, end) === selection.text（锚点完整性）；
 * - anchorEntryId === anchorTurn.piEntryId（分支在 Pi 会话树内的分叉点）。
 */
import type { Brand } from "./branding.js";
import type {
  BranchId,
  EpisodeId,
  IsoTimestamp,
  RunId,
  TreeId,
} from "./identifiers.js";
import type { PiEntryId } from "./session-reference.js";

/** Turn 标识。 */
export type TurnId = Brand<string, "TurnId">;

/** Turn 角色。 */
export type TurnRole = "user" | "assistant" | "return";

/** 答案文本内的连续选区（锚点）。 */
export interface TurnSelection {
  /** 相对 turn 文本起点的字符偏移（含）。 */
  readonly start: number;
  /** 相对 turn 文本起点的字符偏移（不含）。 */
  readonly end: number;
  /** 选中的原文（与 text.slice(start, end) 一致）。 */
  readonly text: string;
}

/** 会话 Turn：产品层的一条可见消息。 */
export interface Turn {
  readonly id: TurnId;
  readonly treeId: TreeId;
  readonly branchId: BranchId;
  readonly episodeId: EpisodeId;
  readonly runId: RunId | null;
  readonly role: TurnRole;
  readonly text: string;
  readonly piEntryId: PiEntryId | null;
  /** role === "return" 时的出处分支；其他 role 为 null。 */
  readonly fromBranchId: BranchId | null;
  /** 把该 return 送入主干 Pi 上下文的 Run；未送达为 null。 */
  readonly deliveredRunId: RunId | null;
  readonly createdAt: IsoTimestamp;
}

/** Branch 出处：从哪条分支的哪个答案选区创建。 */
export interface BranchOrigin {
  readonly branchId: BranchId;
  readonly sourceBranchId: BranchId;
  readonly anchorTurnId: TurnId;
  readonly anchorEntryId: PiEntryId;
  readonly selection: TurnSelection;
  readonly createdAt: IsoTimestamp;
}
