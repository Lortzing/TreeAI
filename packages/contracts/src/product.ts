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
 *   fromBranchId/deliveredRunId/idempotencyKey/targetAnchor 为空；
 * - role "return"：用户在分支上编辑后显式提交的回归消息，记录在主干
 *   分支上；runId 为空（不经模型执行）、fromBranchId 非空（出处分支）；
 * - piEntryId：仅 assistant turn 携带（PiPromptResult.reference.entryId，
 *   即该 Run 完成后的叶条目）；user turn 经 PiRuntime 契约拿不到自身
 *   条目 id，固定为 null；
 * - deliveredRunId：仅 return turn 使用——首次成功采用它的那次主干 Run
 *   （见产品服务）；此前/此后可以有失败或中止的采用尝试（记录于
 *   persistence 的 return_adoption_attempts 关联表，migration 0006），
 *   但 deliveredRunId 只记录第一次成功采用；尚未成功采用为 null；
 * - idempotencyKey：仅 return turn 使用——提交方为一次逻辑提交生成的
 *   稳定幂等键（建议 UUID）；提交重试携带同键：同键同内容（fromBranchId
 *   与 text）重放同一条 Return，同键不同内容视为冲突。存储层以每 Tree
 *   部分唯一索引 UNIQUE(tree_id, idempotency_key) 强制同键在同一棵树内
 *   至多一条 Return（不同树可各自使用同键，signed W1 v3.0 §3.4）；
 *   历史 Return（迁移前落库）为 null；
 * - targetAnchor：仅 return turn 使用——提交时对出处分支 BranchOrigin
 *   的快照（sourceBranchId/anchorTurnId/anchorEntryId/selection），
 *   标识该 Return 的原分叉点（"原分叉点附近"的展示锚点）；历史 Return
 *   为 null。
 *
 * Return 状态词汇（signed W1 v3.0 §3.2：draft/saved/adoption attempt/
 * successfully adopted；持久层不新增状态列，saved/attempted/adopted
 * 持久态由 deliveredRunId 与 return_adoption_attempts 派生）：
 * - draft：客户端编辑中的 Return 草稿（含幂等键与文本），未持久化——
 *   仅存在于浏览器本地，不是模型上下文的一部分；
 * - saved：已落库（deliveredRunId === null 且尚无采用尝试）——保存成功
 *   与返回主线导航成功是两件独立的事（保存先于导航，§3.5）：导航失败
 *   时 Return 仍是已保存；
 * - adoption attempted：某个主干 Run 的确定输入已包含该 Return
 *   （return_adoption_attempts 有记录），但尚未成功——失败/中止的尝试
 *   不消耗该 Return，仍在下一次主干 prompt 前重新注入；
 * - successfully adopted：deliveredRunId !== null——首次成功完成的那次
 *   主干 Run 已把它送入 Pi 上下文（恰记录一次，此后不再重复注入）。
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
  /** 首次成功采用该 return 的主干 Run（signed v3 §3.2）；尚未成功采用为 null。失败/中止的采用尝试记录在 return_adoption_attempts，不改变本字段。 */
  readonly deliveredRunId: RunId | null;
  /** role === "return" 时的提交幂等键（同键重试对齐同一条 Return）；其他 role 为 null。 */
  readonly idempotencyKey: string | null;
  /** role === "return" 时的目标锚点快照（原分叉点的展示定位）；其他 role 为 null。 */
  readonly targetAnchor: ReturnTargetAnchor | null;
  readonly createdAt: IsoTimestamp;
}

/**
 * Return 目标锚点：提交时对出处分支 BranchOrigin 的快照。
 * 标识该 Return 所属的原分叉点（锚点答案内的选区）；前端据此把
 * Return 呈现在锚点答案附近。快照只作展示定位，不参与 Pi 导航
 * （导航仍以 BranchOrigin 为准）。
 */
export interface ReturnTargetAnchor {
  readonly sourceBranchId: BranchId;
  readonly anchorTurnId: TurnId;
  readonly anchorEntryId: string;
  readonly selection: TurnSelection;
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
