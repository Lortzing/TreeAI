/** Studio model ownership; public compatibility exports remain in ../service.ts. */
import type {
  Branch,
  BranchId,
  BranchOrigin,
  EpisodeId,
  EventId,
  IsoTimestamp,
  PiModelSelector,
  PiRuntime,
  Run,
  RunId,
  RunState,
  SessionReference,
  Tree,
  TreeAIErrorCode,
  TreeAIEventType,
  TreeId,
  Turn,
  TurnId,
  TurnSelection,
} from "@treeai/contracts";
import type {
  EventJournal,
} from "@treeai/event-journal";
import type {
  TreeRepository,
} from "@treeai/persistence";

/* ------------------------------------------------------------------ */
/* 读模型（服务 → HTTP/UI 的形状）                                      */
/* ------------------------------------------------------------------ */

/**
 * 分支的读模型。sessionAvailability（A4）：该分支续聊点引用的会话可用性
 * 评估——latest run 的 session 引用（无 run 的分支用 origin 锚点 run 的
 * 引用），以实时文件存在性探针修正 DB 缓存（见 #probeSessionAvailability；
 * 只探存在、绝不读内容）。null = 该分支尚无会话（Trunk 从未 prompt）。
 *
 * returnAttempts（已签署 W1 v3.0 §3.2）：该分支 role === "return" turns 的
 * 采用尝试投影——每次组装该 Return 的主干 Run 一条（Run 结果随附；
 * turns[].deliveredRunId 则只标记首次成功采用）。安全边界与 RunDiagnostics
 * 一致：runId / runState / failure code+message / 时间戳，绝不含 session
 * 引用、路径或 details。
 */
export interface BranchView {
  readonly branch: Branch;
  readonly origin: BranchOrigin | null;
  readonly originStatus: AnchorStatus | null;
  readonly sessionAvailability: "available" | "unavailable" | null;
  readonly turns: readonly Turn[];
  readonly returnAttempts: readonly ReturnAttemptView[];
}

/** 单次 Return 采用尝试的安全投影（Return→Run 关联 + 该 Run 的结果）。 */
export interface ReturnAttemptView {
  readonly turnId: TurnId;
  readonly runId: RunId;
  readonly runState: RunState;
  readonly failure: { readonly code: TreeAIErrorCode; readonly message: string } | null;
  readonly attemptedAt: IsoTimestamp;
  readonly terminalAt: IsoTimestamp | null;
}

export interface SessionCursorInfo {
  readonly treeId: TreeId;
  readonly branchId: BranchId;
  readonly entryId: string;
}

export interface TreeState {
  readonly tree: Tree;
  readonly trunkBranchId: BranchId | null;
  readonly branches: readonly BranchView[];
  readonly cursor: SessionCursorInfo | null;
}

export interface PromptOutcome {
  readonly run: Run;
  readonly userTurn: Turn;
  readonly assistantTurn: Turn;
  /** 本次 prompt 送入 Pi 上下文的未送达 return 数。 */
  readonly deliveredReturns: number;
}

/**
 * prompt 选项。「以保存内容开始新的探索」（signed v3 §4.4）：
 * newExploration === true 时要求该分支续聊点的 session **当前不可用**
 * （可用 → NewExplorationConflictError，应走普通续聊；无历史 session →
 * 同样拒绝，普通 prompt 即会新建），然后创建**全新 session** 作为该分支
 * 的续聊载体：锚点摘录与分支已保存历史作为首问上下文显式带入，并注明
 * 旧运行上下文未恢复（不冒充旧会话恢复——用户 turn 携带显式标记）。
 * 首问成功后分支续聊点 = 新 session（latest run 的引用）；旧历史保持
 * 可读（append-only，来源关系不动）。
 */
export interface PromptOptions {
  readonly newExploration?: boolean;
  /**
   * 服务端生成的组合前缀（模型输入上下文，不落用户 turn；术语推广的
   * 「术语 + 解释 + 摘录」上下文块——与 pending Return 的组合同一纪律：
   * 组合是输入面事实，用户 turn 保持用户原文 + 显式标记）。
   */
  readonly composedPrefix?: string;
  /** 用户 turn 的显式标记前缀（转录可审计；如术语推广的 follow-up 标记）。 */
  readonly turnPrefix?: string;
  /**
   * 材料分支（D4-3，ADR-004）：newExploration 首问时随行的材料来源上下文块
   * （材料标题/版本 + 选区摘录 + 有界邻近窗口——由材料建枝服务持有材料
   * 仓储组合后注入；服务层无材料仓储，不在此重复组合）。仅
   * newExploration === true 时消费，与 #newExplorationContext 的锚点摘录块
   * 互补（材料分支没有 Turn 来源摘录）。
   */
  readonly newExplorationMaterialContext?: string;
}

export interface BranchCreation {
  readonly branch: Branch;
  readonly origin: BranchOrigin;
}

export type AnchorStatus = "available" | "changed" | "unavailable";

/**
 * 揭示后的 Pi 游标对齐结果（signed v3 §1.2：来源定位与游标对齐分离，
 * 游标对齐**独立可失败**——失败不降格来源状态，数据库原文仍可定位高亮）。
 * - navigated：活动 Pi 会话已对准锚点条目（游标落在出处分支）；
 * - failed：对齐尝试失败（锚点 session 缺失/损坏或运行期错误；code +
 *   message 如实携带）。来源状态不受影响——揭示返回的产品定位（分支/
 *   turn/绝对偏移/摘录）仍然准确。
 */
export type AnchorNavigationOutcome =
  | { readonly status: "navigated" }
  | { readonly status: "failed"; readonly code: TreeAIErrorCode; readonly message: string };

/**
 * 锚点揭示结果：sourceBranchId/anchorTurnId/status/selection 为**纯产品
 * 定位**（读数据库原文、版本/切片与身份判定，与 session 可用性无关，
 * signed v3 §1.2）；navigation 为 status === "available" 时对 Pi 游标的
 * 对齐尝试结果（null = 未尝试，即来源本身已降级）。
 */
export interface AnchorLocation {
  readonly sourceBranchId: BranchId;
  readonly anchorTurnId: TurnId;
  readonly status: AnchorStatus;
  readonly selection: TurnSelection;
  readonly navigation: AnchorNavigationOutcome | null;
}

/* ------------------------------------------------------------------ */
/* 诊断读模型（A5：安全投影，只含可安全外泄的字段）                     */
/* ------------------------------------------------------------------ */

/** 运行面状态：idle（无在途 prompt）/ streaming（在途）/ aborting（已请求中止）。 */
export type StudioRuntimeState = "idle" | "streaming" | "aborting";

/** 在途 run 的定位（不含任何 Pi 会话细节）。 */
export interface ActiveRunInfo {
  readonly runId: RunId;
  readonly branchId: BranchId;
  readonly episodeId: EpisodeId;
}

/**
 * Run 行的诊断投影。刻意只保留定位 + 状态 + 失败码与消息 + 时间戳；
 * session 引用、failure.details、原始 cause、命令、主机与目标路径
 * 一律不进入本形状（防字段外泄回归由测试锁定键集合）。
 */
export interface RunDiagnostics {
  readonly runId: RunId;
  readonly branchId: BranchId;
  readonly episodeId: EpisodeId;
  readonly state: RunState;
  readonly failure: { readonly code: TreeAIErrorCode; readonly message: string } | null;
  readonly createdAt: IsoTimestamp;
  readonly terminalAt: IsoTimestamp | null;
}

/**
 * 策略决策观测（诚实边界）：默认 Studio 装配的 prompt 以空工具 allowlist
 * 运行（runtime-pi 默认零工具），没有工具执行——也就没有策略决策可观测，
 * 诊断面如实报告 observed=false。runtime 注入了工具策略（P0 请求时门）
 * 且实际发生决策时，observed=true 并给出**脱敏投影**的决定列表
 * （工具名/outcome/category/risk/reason/ruleId；参数、路径、命令、主机
 * 绝不进入）。诊断面绝不伪造 policy 判定。
 */
export type PolicyDecisionView = {
  readonly tool: string | null;
  readonly outcome: "allow" | "deny" | "require-approval";
  readonly category: string;
  readonly risk: string;
  readonly reason: string;
  readonly ruleId: string | null;
  readonly occurredAt: IsoTimestamp;
};

export type PolicyDiagnostics =
  | { readonly observed: false; readonly reason: string }
  | { readonly observed: true; readonly decisions: readonly PolicyDecisionView[] };

/** 一棵树的诊断读模型（只读、安全投影）。 */
export interface TreeDiagnostics {
  readonly treeId: TreeId;
  readonly runtimeState: StudioRuntimeState;
  readonly activeRun: ActiveRunInfo | null;
  readonly runs: readonly RunDiagnostics[];
  readonly policyDecisions: PolicyDiagnostics;
}

/* ------------------------------------------------------------------ */
/* 事件面（P1：安全 UI 事件；SSE 端点转发，见 server.ts）              */
/* ------------------------------------------------------------------ */

/**
 * Studio UI 事件（瞬态推送）。安全边界：message-delta 只含文本增量；
 * tool-activity 只投影工具名与阶段（参数/路径/命令绝不进入事件面——
 * 诊断面的 no-leak 纪律同样约束这里）。phase "denied" 携带策略决定
 * provenance（outcome/reason/ruleId，固定模板 reason，无用户可控内容）；
 * 事件不是权威读模型：run-terminal 后 UI 必须从 /state 整树刷新。
 */
export type StudioEvent =
  | {
      readonly type: "run-started";
      readonly treeId: TreeId;
      readonly branchId: BranchId;
      readonly episodeId: EpisodeId;
      readonly runId: RunId;
    }
  | {
      readonly type: "message-delta";
      readonly treeId: TreeId;
      readonly runId: RunId;
      readonly delta: string;
    }
  | {
      readonly type: "abort-requested";
      readonly treeId: TreeId;
      readonly runId: RunId;
    }
  | {
      readonly type: "run-terminal";
      readonly treeId: TreeId;
      readonly runId: RunId;
      readonly state: "succeeded" | "failed" | "aborted";
      readonly failure: { readonly code: TreeAIErrorCode; readonly message: string } | null;
    }
  | {
      readonly type: "tool-activity";
      readonly treeId: TreeId;
      readonly runId: RunId;
      /** 工具名（runtime-pi 归一化白名单字段）；缺失时为 null。绝不携带参数。 */
      readonly tool: string | null;
      /**
       * started/finished = 实际执行的生命周期；denied = 请求时策略拒绝
       * （工具未执行；require-approval 同样按拒绝呈现——fail closed）。
       */
      readonly phase: "started" | "finished" | "denied";
      /**
       * 策略决定 provenance（仅 phase "denied" 携带）：outcome + 固定模板
       * reason + 决定来源 ruleId（null = 默认拒绝）。绝不携带参数/路径/命令。
       */
      readonly decision?: {
        readonly outcome: "deny" | "require-approval";
        readonly reason: string;
        readonly ruleId: string | null;
      };
    };

export type StudioEventListener = (event: StudioEvent) => void;

/* ------------------------------------------------------------------ */
/* Journal 读模型（P1：按树过滤的保守投影）                            */
/* ------------------------------------------------------------------ */

/**
 * journal 事件的安全投影。summary 由白名单字段构造（工具名/状态码/
 * 角色等非敏感判别字段），绝不透出原始 payload（参数、路径、命令、
 * 消息正文、session 引用一律不进入投影）。
 */
export interface JournalEventView {
  readonly eventId: EventId;
  readonly runId: RunId;
  readonly seq: number;
  readonly occurredAt: IsoTimestamp;
  readonly type: TreeAIEventType;
  readonly summary: string;
}

/**
 * Return 提交后的回程导航结果（已签署 W1 v3.0 §3.5：保存成功与导航结果
 * 分离呈现——导航失败不回滚、不抛错，如实随响应/状态返回）。
 * - navigated：游标已对准 Trunk 续聊点；
 * - no-session：Trunk 尚无 session（new-session 续聊点，无可导航对象；
 *   首次 Trunk prompt 时建立 session——Return 照常保存）；
 * - failed：导航尝试失败（运行期错误，如 session 文件缺失 →
 *   session-corrupt）。Return 已保存，失败如实携带 code/message。
 */
export type ReturnNavigationOutcome =
  | { readonly status: "navigated" }
  | { readonly status: "no-session" }
  | { readonly status: "failed"; readonly code: TreeAIErrorCode; readonly message: string };

/** submitReturn 的结果：turn 为新建或幂等重放的 Return；created 标记本次调用是否新建落库；navigation 为保存后的回程导航结果（与保存结果分离）。 */
export interface ReturnSubmission {
  readonly turn: Turn;
  /** false = 幂等重放（同键同内容的既有 Return，本次调用零写入）。 */
  readonly created: boolean;
  /** 先保存后导航（signed v3 §3.5）：保存成功后对 Trunk 的导航尝试结果。 */
  readonly navigation: ReturnNavigationOutcome;
}

/* ------------------------------------------------------------------ */
/* 服务                                                                */
/* ------------------------------------------------------------------ */

export interface TreeStudioServiceOptions {
  readonly repository: TreeRepository;
  readonly runtime: PiRuntime;
  readonly model: PiModelSelector;
  /** Pi session 存储目录（由宿主创建与拥有；测试/CLI 用专用目录）。 */
  readonly sessionDir: string;
  /** 工具执行工作目录（trusted-local 工作区）。 */
  readonly cwd: string;
  /**
   * 可选审计 journal（P1）：注入后服务记录 run 生命周期事件并暴露
   * getTreeJournal。选择注入 EventJournal（而非 recorder）作为缝：
   * journal 是存储/生命周期对象（open/close 由宿主拥有），recorder 是
   * 无状态写入糖——服务内部自建 recorder。缺省不注入时零 journal 行为
   * （既有测试面不变）。注入方注意：journal 文件应跨重启复用（eventId
   * 由 journal 生成，无 per-instance 撞号问题）；close 由宿主负责
   * （close 会排空内部写入队列，保证落盘）。
   */
  readonly journal?: EventJournal;
}

export interface Cursor {
  readonly treeId: TreeId;
  readonly branchId: BranchId;
  readonly reference: SessionReference;
}

/** 在途 prompt 的服务侧簿记（诊断面与 abort 校验的事实源；进程内即失效）。 */
export interface ActiveRunRecord extends ActiveRunInfo {
  readonly treeId: TreeId;
  /** 已通过 abort() 请求中止（运行面状态 → aborting）。 */
  abortRequested: boolean;
}

export type Continuation =
  | { readonly kind: "new-session" }
  | { readonly kind: "reference"; readonly reference: SessionReference };
