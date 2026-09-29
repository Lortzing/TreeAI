/**
 * TreeStudioService — D3 Core MVP 产品服务（studio app 的领域核心）。
 *
 * 职责：把 D2 包（contracts / runtime-pi / persistence）组装成产品行为——
 *   - 创建/打开 Tree（Trunk = 根分支）；
 *   - 在 Trunk/Branch 上对话（Episode + Run + Turn 三层落库）；
 *   - 从“锚定的答案选区”创建 Branch：Pi 会话树内在锚点条目处分叉
 *     （navigateTree，不新建 session 文件——D2 已验证的分叉方式）；
 *   - 继续分支、切回 Trunk（同一 session 文件内移动叶指针）；
 *   - 编辑并显式提交 Return：记录在 Trunk 上（含出处分支与提交时的
 *     分叉锚点快照 targetAnchor），并在下一次 Trunk prompt 时送入 Pi
 *     上下文（可送达、只送达一次）；
 *   - Return 幂等（响应丢失/双击/并发同键安全）：提交方提供稳定
 *     idempotencyKey。同键同内容重试零写入返回既有 Return
 *     （created === false）；同键不同内容（fromBranchId/text）以
 *     ReturnConflictError 拒绝；并发同键由 turns.idempotency_key 部分
 *     唯一索引裁决，判负事务整体回滚（无悬挂 episode）后重读对齐。
 *     Return 状态词汇：draft（客户端草稿，未持久化）/ confirmed
 *     （已落库、deliveredRunId === null）/ delivered（deliveredRunId
 *     !== null）——持久态由 deliveredRunId 派生，无独立状态列；
 *   - 全部产品状态即时写入 TreeAI DB（事实源）；重启后由 DB 重建。
 *
 * 会话连续性模型（全部可从 DB 重建，cursor 只是缓存）：
 *   分支的“续聊点” =
 *     该分支最新 Run 的 SessionReference（Run 落库时更新到该 Run 完成后的叶）；
 *     无 Run 但有 BranchOrigin → 锚点 Run 的引用三元组 + anchorEntryId；
 *     Trunk 且无 Run → 首次 prompt 时新建 session。
 *   进程内活动会话 cursor 与续聊点不一致时：
 *     同 session 文件 → navigateTree（D2 回归能力，同 session 不换文件）；
 *     不同文件/无活动会话 → restoreSession。
 *
 * 诊断面（A5，最小诚实）：getTreeDiagnostics 提供安全投影——运行面状态
 *   （idle/streaming/aborting）、在途 run 定位、DB 全量 run 行
 *   （runId/branchId/episodeId/state/failure code+message/createdAt/
 *   terminalAt）。session 引用（sessionFile/sessionId/entryId/piVersion/
 *   availability）、failure.details、原始 cause、命令、主机与目标路径
 *   一律不外泄。策略决策如实报告：默认装配（prompt 以空工具 allowlist
 *   运行）从未观测 → observed=false；runtime 注入请求时策略门
 *   （issue #5 P0）后观测到的决定以脱敏投影列出（工具名/outcome/
 *   reason/ruleId），绝不伪造 policy 判定，也绝不隐瞒已发生的拒绝。
 *   abort(treeId, runId) 只接受该树当前在途的 run（否则按操作冲突拒绝），
 *   调用 runtime.abort()，由 prompt 的收敛路径把 run 落库为 aborted
 *   （user-abort 绝不改写为 failed）。
 *
 * 事件面（P1）：subscribeStudioEvents 暴露安全 UI 事件
 *   （run-started / message-delta / abort-requested / run-terminal /
 *   tool-activity；SSE 端点见 server.ts）。message-delta 只携带文本增量；
 *   tool-activity 只投影工具名与阶段（never 参数/路径/命令——诊断面
 *   no-leak 纪律同样约束事件面）。事件是瞬态推送；/state 与诊断面仍是
 *   权威读模型（UI 在 run-terminal 后整树刷新）。
 *
 * Journal 面（P1）：可选注入 EventJournal（宿主负责 open/close/重启
 *   恢复之外的写入均由本服务承担；本服务在构造时自动执行 host-crash
 *   恢复，见 journalRecovery）。注入后记录 run 生命周期事件：会话对准
 *   阶段的 session.* / tree.navigated 事件缓冲后归属该 prompt 创建的
 *   run（域归属由消费方补齐——契约语义），运行期事件实时归属在途 run，
 *   外加服务侧的 queued→running 显式迁移与 abort 请求记录。eventId 由
 *   journal 生成（evt-<uuid>）而非沿用 Pi 的 per-instance
 *   pi-runtime-<seq>——单一 journal 文件跨进程重启复用，per-instance
 *   序号会撞 journal 全局 eventId 唯一性（D2 runtime-smoke 已知发现的
 *   规避）；原始事件 id 经 evidence（source "pi-runtime"）保留审计链。
 *   terminal 状态不做服务侧显式迁移（agent.settled / runtime.error 的
 *   派生迁移已与 DB 收敛一致；事后补显式迁移只会产生 out-of-sync
 *   投影异常）。journal 写失败不阻断产品路径（DB 是事实源），静默
 *   丢弃并继续。getTreeJournal 提供按树过滤的保守投影
 *   （{eventId, runId, seq, occurredAt, type, summary}，summary 为
 *   白名单字段构造的人类可读串，绝不透出原始 payload）。
 *   A4 缺失 session 降级：BranchView.sessionAvailability 以续聊点引用
 *   做实时文件存在性探针（只探存在、绝不读内容）修正 DB 缓存评估后
 *   给出——missing-file 且文件已恢复 → available；DB 因其他原因降级
 *   （version-mismatch/corrupt）→ 维持 unavailable；树始终可读（DB 是
 *   事实源），续聊 fail-closed。
 *
 * 已知范围（诚实声明）：并发 prompt 以冲突拒绝不排队（TypeError → 409，
 *   单用户语义）；默认 Studio 装配（空工具 allowlist、无策略注入）无
 *   工具执行，tool-activity / tool.decision 仅在 runtime 配置了工具与
 *   请求时策略门后出现（离线驱动可用 toolCalls 测试钩触发）；非 prompt
 *   期间的运行时事件（如 switchBranch 的导航）无 run 可归属，不进
 *   journal（策略决策观测例外：观测环形独立于 run 归属，越权决定的
 *   provenance 不因事件缓冲而丢失）。
 */

import { existsSync } from "node:fs";
import type {
  Branch,
  BranchId,
  BranchOrigin,
  EpisodeId,
  EventId,
  Forest,
  IsoTimestamp,
  JsonRecord,
  JsonValue,
  PiModelSelector,
  PiRuntime,
  PiRuntimeEvent,
  ReturnTargetAnchor,
  Run,
  RunId,
  RunState,
  SessionReference,
  Tree,
  TreeAIError,
  TreeAIErrorCode,
  TreeAIEvent,
  TreeAIEventType,
  TreeId,
  Turn,
  TurnId,
  TurnSelection,
} from "@treeai/contracts";
import {
  ConstraintViolationError,
  EntityNotFoundError,
  InvalidArgumentError,
  TreeRepository,
} from "@treeai/persistence";
import type { EventJournal, RecoveryReport } from "@treeai/event-journal";
import { EventRecorder, parseSerializedError, piRuntimeEventKindToType } from "@treeai/event-journal";

/* ------------------------------------------------------------------ */
/* 读模型（服务 → HTTP/UI 的形状）                                      */
/* ------------------------------------------------------------------ */

/**
 * 分支的读模型。sessionAvailability（A4）：该分支续聊点引用的会话可用性
 * 评估——latest run 的 session 引用（无 run 的分支用 origin 锚点 run 的
 * 引用），以实时文件存在性探针修正 DB 缓存（见 #probeSessionAvailability；
 * 只探存在、绝不读内容）。null = 该分支尚无会话（Trunk 从未 prompt）。
 */
export interface BranchView {
  readonly branch: Branch;
  readonly origin: BranchOrigin | null;
  readonly originStatus: AnchorStatus | null;
  readonly sessionAvailability: "available" | "unavailable" | null;
  readonly turns: readonly Turn[];
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

export interface BranchCreation {
  readonly branch: Branch;
  readonly origin: BranchOrigin;
}

export type AnchorStatus = "available" | "changed" | "unavailable";

export interface AnchorLocation {
  readonly sourceBranchId: BranchId;
  readonly anchorTurnId: TurnId;
  readonly status: AnchorStatus;
  readonly selection: TurnSelection;
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

export const NO_POLICY_DECISIONS_REASON =
  "no tool policy decisions observed in this process; the default Studio wiring runs prompts with an empty tool allowlist";

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

/** abort 目标不是该树当前在途的 run（已终态/无在途/另有在途）→ 操作冲突（409）。 */
export class RunNotActiveError extends Error {
  constructor(runId: RunId, state: RunState) {
    super(
      `run ${runId} is not the active in-flight run (state: ${state}); only the active run of a tree can be aborted`,
    );
    this.name = "RunNotActiveError";
  }
}

/**
 * 相同 idempotencyKey 已绑定到内容不同的 Return（fromBranchId 或 text 与
 * 已落库 Return 不一致）→ 重试语义冲突（409）。既有 Return 保持不变；
 * 新的逻辑提交必须携带新键。
 */
export class ReturnConflictError extends Error {
  constructor(idempotencyKey: string, existingTurnId: TurnId, difference: string) {
    super(
      `return idempotency key '${idempotencyKey}' is already bound to return ${existingTurnId} ` +
        `with different content (${difference}); use a new idempotency key for a new submission`,
    );
    this.name = "ReturnConflictError";
  }
}

/** submitReturn 的结果：turn 为新建或幂等重放的 Return；created 标记本次调用是否新建落库。 */
export interface ReturnSubmission {
  readonly turn: Turn;
  /** false = 幂等重放（同键同内容的既有 Return，本次调用零写入）。 */
  readonly created: boolean;
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

interface Cursor {
  readonly treeId: TreeId;
  readonly branchId: BranchId;
  readonly reference: SessionReference;
}

/** 在途 prompt 的服务侧簿记（诊断面与 abort 校验的事实源；进程内即失效）。 */
interface ActiveRunRecord extends ActiveRunInfo {
  readonly treeId: TreeId;
  /** 已通过 abort() 请求中止（运行面状态 → aborting）。 */
  abortRequested: boolean;
}

type Continuation =
  | { readonly kind: "new-session" }
  | { readonly kind: "reference"; readonly reference: SessionReference };

function toTreeAIError(err: unknown): TreeAIError {
  if (err !== null && typeof err === "object" && "code" in err && "message" in err) {
    const candidate = err as { code: unknown; message: unknown };
    if (typeof candidate.code === "string" && typeof candidate.message === "string") {
      return { code: candidate.code as TreeAIError["code"], message: candidate.message };
    }
  }
  return { code: "unknown", message: err instanceof Error ? err.message : String(err) };
}

/** 安全读取事件 payload 上的字符串字段（缺失/非字符串 → undefined）。 */
function payloadString(payload: JsonValue, key: string): string | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

/** 安全读取事件 payload 上的 ruleId 字段（string → 值；否则 → null，null 即默认拒绝）。 */
function payloadRuleId(payload: JsonValue): string | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>)["ruleId"];
  return typeof value === "string" ? value : null;
}

/**
 * journal 事件的保守 summary：只从白名单字段构造（状态/角色/工具名/
 * 错误码等非敏感判别字段），绝不透出原始 payload（参数、路径、命令、
 * 消息正文、session 引用）。未知类型回退为类型字符串本身。
 */
export function summarizeJournalEvent(event: TreeAIEvent): string {
  const payload = event.payload;
  const str = (key: string): string | undefined => payloadString(payload, key);
  switch (event.type) {
    case "run.state-changed": {
      const from = str("from");
      const to = str("to");
      return from === undefined || to === undefined
        ? "run state change recorded"
        : `run state changed: ${from} → ${to}`;
    }
    case "run.abort-requested":
      return "abort requested";
    case "run.steer-enqueued":
      return "steer input enqueued";
    case "agent.started":
      return "agent run started";
    case "agent.settled":
      return `agent run settled${str("status") === undefined ? "" : ` (${str("status")})`}`;
    case "turn.started":
      return "turn started";
    case "turn.completed":
      return `turn completed${str("stopReason") === undefined ? "" : ` (stop: ${str("stopReason")})`}`;
    case "message.started":
      return `message started${str("role") === undefined ? "" : ` (${str("role")})`}`;
    case "message.updated": {
      const delta = str("delta");
      return delta === undefined ? "message update received" : `message delta received (${delta.length} chars)`;
    }
    case "message.completed": {
      const role = str("role");
      const stop = str("stopReason");
      const roleNote = role === undefined ? "" : ` (${role})`;
      const stopNote = stop === undefined ? "" : `, stop: ${stop}`;
      return `message completed${roleNote}${stopNote}`;
    }
    case "tool.execution.started":
      return `tool execution started: ${str("toolName") ?? "unknown tool"}`;
    case "tool.execution.finished": {
      const name = str("toolName") ?? "unknown tool";
      return `tool execution finished: ${name}${payload["isError"] === true ? " (error)" : ""}`;
    }
    case "tool.decision": {
      const tool = str("toolName");
      const decision = str("decision");
      const rawRule = payload["ruleId"];
      const ruleNote =
        typeof rawRule === "string"
          ? ` (rule: ${rawRule})`
          : rawRule === null
            ? " (no rule)"
            : "";
      const toolNote = tool === undefined ? "" : ` on ${tool}`;
      return `tool policy decision${toolNote}${decision === undefined ? "" : `: ${decision}`}${ruleNote}`;
    }
    case "session.created":
      return "session created";
    case "session.restored":
      return "session restored";
    case "session.replaced":
      return "session replaced";
    case "tree.navigated":
      return "session tree navigation";
    case "runtime.error": {
      // 复用投影器的序列化错误解析（code/message 已由上游脱敏；details 不进 summary）。
      const error = parseSerializedError(payload, "error");
      return error === null ? "runtime error" : `runtime error ${error.code}: ${error.message}`;
    }
    case "runtime.recovered": {
      const cause = str("cause");
      const resolved = str("resolvedTo");
      return `run recovered after ${cause ?? "host exit"}${resolved === undefined ? "" : ` (converged to ${resolved})`}`;
    }
    case "pi.unknown":
      return `unknown runtime event${str("rawKind") === undefined ? "" : ` (${str("rawKind")})`}`;
    default:
      return String(event.type);
  }
}

/** 把未送达的 return 拼进下一次 prompt 文本（送入 Pi 上下文的载体）。 */
export function composePromptText(pendingReturns: readonly Turn[], text: string): string {
  if (pendingReturns.length === 0) return text;
  const blocks = pendingReturns.map(
    (turn) => `[Return from branch ${turn.fromBranchId}]\n${turn.text}`,
  );
  return `${blocks.join("\n\n")}\n\n${text}`;
}

export class TreeStudioService {
  readonly repository: TreeRepository;
  readonly runtime: PiRuntime;
  readonly model: PiModelSelector;
  readonly sessionDir: string;
  readonly cwd: string;
  #cursor: Cursor | null = null;
  #forest: Forest | null = null;
  /** 单 prompt 操作锁：同一时刻至多一个 prompt 操作（含会话对准阶段）。 */
  #promptInFlight: boolean = false;
  /** 当前在途的 run（run 落库并置 running 后才有值；收敛即清除）。 */
  #activeRun: ActiveRunRecord | null = null;
  /** prompt 会话对准阶段（activeRun 尚未建立）缓冲的运行时事件，待 run 建立后归属。 */
  #promptPrelude: PiRuntimeEvent[] | null = null;
  /** journal 写入（缺省 null = 不记录）。 */
  readonly #journal: EventJournal | null;
  readonly #recorder: EventRecorder | null;
  /** journal 写入串行链：保序 + prompt 收敛时 await（确定性落盘供测试断言）。 */
  #journalTail: Promise<void> = Promise.resolve();
  /** 构造时的 journal host-crash 恢复（未注入 journal 时为 null；拒绝不挂进程）。 */
  readonly journalRecovery: Promise<RecoveryReport> | null;
  /** UI 事件监听者（SSE 端点订阅）。 */
  readonly #studioListeners = new Set<StudioEventListener>();
  /** 策略决策观测（进程内环形，最新在后；诊断面 observed=true 的数据源）。 */
  readonly #policyObservations: PolicyDecisionView[] = [];
  /** 运行时订阅的退订函数（dispose 时释放）。 */
  readonly #unsubscribeRuntime: () => void;

  constructor(options: TreeStudioServiceOptions) {
    this.repository = options.repository;
    this.runtime = options.runtime;
    this.model = options.model;
    this.sessionDir = options.sessionDir;
    this.cwd = options.cwd;
    this.#journal = options.journal ?? null;
    this.#recorder = this.#journal === null ? null : new EventRecorder(this.#journal);
    if (this.#journal !== null) {
      // I6 重启恢复（journal 面）：构造时把 journal 中仍非终态的 run 收敛为
      // failed（host-crash 语义，与下方 DB 恢复一致）。失败不挂进程；测试
      // 与宿主可经 journalRecovery await 确定性观测。
      const recovery = this.#journal.recoverInterruptedRuns("host-crash");
      recovery.catch(() => undefined);
      this.journalRecovery = recovery;
    } else {
      this.journalRecovery = null;
    }
    // 事件面：订阅运行时事件（会话替换后保持有效——契约保证）。
    this.#unsubscribeRuntime = this.runtime.subscribe((event) => {
      this.#handleRuntimeEvent(event);
    });
    this.recoverInterruptedRuns();
  }

  /**
   * I6 重启恢复：宿主退出时仍非终态的 Run 收敛为 failed
   * （宿主中断语义）。DB 是事实源，重复调用安全（无则空转）。
   */
  recoverInterruptedRuns(): readonly Run[] {
    return this.repository.failNonTerminalRuns({
      code: "unknown",
      message: "host process interrupted before the run reached a terminal state",
      details: { hostInterrupted: true },
    });
  }

  /* ------------------------------ 事件面 / journal（P1） ------------------------------ */

  /**
   * 订阅安全 UI 事件（run-started / message-delta / abort-requested /
   * run-terminal / tool-activity）。可多订阅；返回退订函数（幂等）。
   * dispose 后不再推送。
   */
  subscribeStudioEvents(listener: StudioEventListener): () => void {
    this.#studioListeners.add(listener);
    return () => {
      this.#studioListeners.delete(listener);
    };
  }

  #emitStudio(event: StudioEvent): void {
    for (const listener of [...this.#studioListeners]) {
      try {
        listener(event);
      } catch {
        // 监听器异常不得影响服务（与 runtime 的监听纪律一致）。
      }
    }
  }

  /**
   * 运行时事件入口：journal 归属（在途 run 实时归属；会话对准阶段缓冲）
   * + 事件面投影（message-delta / tool-activity，仅在途 run）。
   * 绝不向事件面搬运 payload 原文（工具参数/路径/命令不出境）。
   * tool.decision（P0 请求时策略门）：记入诊断观测（脱敏投影）；
   * 拒绝类决定（deny / require-approval）以 tool-activity(phase "denied")
   * + 决定 provenance 推送（allow 的执行生命周期由后续
   * tool.execution.started/finished 事件表达）。
   */
  #handleRuntimeEvent(event: PiRuntimeEvent): void {
    const active = this.#activeRun;
    if (active !== null) {
      this.#journalRuntimeEvent(active.runId, event);
    } else if (this.#promptPrelude !== null) {
      this.#promptPrelude.push(event);
    }
    if (event.kind === "tool.decision") {
      this.#observePolicyDecision(event);
    }
    if (active === null) return;
    switch (event.kind) {
      case "message.updated": {
        const delta = payloadString(event.payload, "delta");
        if (delta !== undefined) {
          this.#emitStudio({ type: "message-delta", treeId: active.treeId, runId: active.runId, delta });
        }
        return;
      }
      case "tool.execution.started":
      case "tool.execution.finished": {
        this.#emitStudio({
          type: "tool-activity",
          treeId: active.treeId,
          runId: active.runId,
          tool: payloadString(event.payload, "toolName") ?? null,
          phase: event.kind === "tool.execution.started" ? "started" : "finished",
        });
        return;
      }
      case "tool.decision": {
        const outcome = payloadString(event.payload, "decision");
        if (outcome === "deny" || outcome === "require-approval") {
          this.#emitStudio({
            type: "tool-activity",
            treeId: active.treeId,
            runId: active.runId,
            tool: payloadString(event.payload, "toolName") ?? null,
            phase: "denied",
            decision: {
              outcome,
              reason: payloadString(event.payload, "reason") ?? "tool policy decision",
              ruleId: payloadRuleId(event.payload),
            },
          });
        }
        return;
      }
      default:
        return;
    }
  }

  /**
   * 记录一条策略决策观测（白名单字段；参数/路径/命令/主机绝不进入）。
   * 形状不符的事件按诚实边界忽略（不伪造观测）；环形上限 20 条。
   */
  #observePolicyDecision(event: PiRuntimeEvent): void {
    const outcome = payloadString(event.payload, "decision");
    if (outcome !== "allow" && outcome !== "deny" && outcome !== "require-approval") {
      return;
    }
    const view: PolicyDecisionView = {
      tool: payloadString(event.payload, "toolName") ?? null,
      outcome,
      category: payloadString(event.payload, "category") ?? "unknown",
      risk: payloadString(event.payload, "risk") ?? "unknown",
      reason: payloadString(event.payload, "reason") ?? "tool policy decision",
      ruleId: payloadRuleId(event.payload),
      occurredAt: event.occurredAt,
    };
    this.#policyObservations.push(view);
    if (this.#policyObservations.length > 20) {
      this.#policyObservations.splice(0, this.#policyObservations.length - 20);
    }
  }

  /**
   * 归一化运行时事件 → journal 追加（保序串行链）。
   * eventId 由 journal 生成（evt-<uuid>）：journal 文件跨重启复用，而
   * runtime 的 per-instance pi-runtime-<seq> 会撞 journal 全局 eventId
   * 唯一性；原始事件 id 经 evidence 保留审计链。runtime.error 做载荷
   * 形状适配（顶层 {code,message} → 投影器期望的 {error:{code,message}}，
   * D2 runtime-smoke 集成发现的同一适配）。写失败静默丢弃（DB 是事实源）。
   */
  #journalRuntimeEvent(runId: RunId, event: PiRuntimeEvent): void {
    const recorder = this.#recorder;
    if (recorder === null) return;
    const type = piRuntimeEventKindToType(event.kind);
    let payload: JsonRecord;
    if (event.kind === "runtime.error") {
      payload = {
        error: {
          code: payloadString(event.payload, "code") ?? "unknown",
          message: payloadString(event.payload, "message") ?? "runtime error",
        },
      };
    } else if (event.payload !== null && typeof event.payload === "object" && !Array.isArray(event.payload)) {
      payload = { ...(event.payload as JsonRecord) };
    } else {
      payload = { value: event.payload };
    }
    this.#journalTail = this.#journalTail.then(() =>
      recorder
        .recordCustom(runId, type, payload, {
          occurredAt: event.occurredAt,
          evidence: [{ source: "pi-runtime", refId: event.eventId }],
        })
        .then(() => undefined, () => undefined),
    );
  }

  /**
   * journal 记录服务侧显式状态迁移（queued→running；agent.started 随后为幂等 no-op）。
   * occurredAt 取**调用时刻**而非 append 时刻：append 在异步临界区内执行，
   * 可能晚于随后运行时事件的发射时间戳，破坏 journal 插入序的时序单调性。
   */
  #journalStateChange(runId: RunId, from: RunState, to: RunState): void {
    const recorder = this.#recorder;
    if (recorder === null) return;
    const occurredAt = new Date().toISOString();
    this.#journalTail = this.#journalTail.then(() =>
      recorder.recordStateChange(runId, from, to, { occurredAt }).then(() => undefined, () => undefined),
    );
  }

  /** journal 记录服务侧中止请求（运行时自身的事件随后为幂等 no-op；调用时刻戳）。 */
  #journalAbortRequested(runId: RunId): void {
    const recorder = this.#recorder;
    if (recorder === null) return;
    const occurredAt = new Date().toISOString();
    this.#journalTail = this.#journalTail.then(() =>
      recorder.recordAbortRequested(runId, { occurredAt }).then(() => undefined, () => undefined),
    );
  }

  /* ------------------------------ Forest / Tree ------------------------------ */

  /** 受信任本地库：单 Forest，首次访问时创建。 */
  ensureForest(): Forest {
    if (this.#forest !== null) return this.#forest;
    const existing = this.repository.listForests();
    this.#forest = existing.length > 0 ? existing[0]! : this.repository.createForest();
    return this.#forest;
  }

  listTrees(): readonly Tree[] {
    return this.repository.listTrees(this.ensureForest().id);
  }

  /** 创建 Tree（自动建 Trunk 根分支）。 */
  createTree(): { tree: Tree; trunkBranch: Branch } {
    const forest = this.ensureForest();
    return this.repository.transaction(() => {
      const tree = this.repository.createTree(forest.id);
      const trunkBranch = this.repository.createBranch(tree.id);
      return { tree, trunkBranch };
    });
  }

  getTreeState(treeId: TreeId): TreeState {
    const tree = this.repository.getTree(treeId); // EntityNotFoundError → 404
    const branches = this.repository.listBranches(tree.id);
    const trunk = branches.find((b) => b.parentBranchId === null) ?? null;
    const views: BranchView[] = branches.map((branch) => {
      const origin = this.repository.findBranchOrigin(branch.id);
      return {
        branch,
        origin,
        originStatus: origin === null ? null : this.#anchorStatus(origin),
        sessionAvailability: this.#branchSessionAvailability(branch),
        turns: this.repository.listTurns(branch.id),
      };
    });
    return {
      tree,
      trunkBranchId: trunk !== null ? trunk.id : null,
      branches: views,
      cursor: this.#cursorInfo(tree.id),
    };
  }

  #cursorInfo(treeId: TreeId): SessionCursorInfo | null {
    const cursor = this.#cursor;
    if (cursor !== null && cursor.treeId === treeId) {
      return { treeId, branchId: cursor.branchId, entryId: cursor.reference.entryId };
    }
    const persisted = this.repository.findActiveNavigation(treeId);
    return persisted === null
      ? null
      : { treeId, branchId: persisted.branchId, entryId: persisted.reference.entryId };
  }

  #setCursor(treeId: TreeId, branchId: BranchId, reference: SessionReference): void {
    this.#cursor = { treeId, branchId, reference };
    this.repository.saveActiveNavigation(treeId, branchId, reference);
  }

  #anchorStatus(origin: BranchOrigin): AnchorStatus {
    const sourceBranch = this.repository.findBranch(origin.sourceBranchId);
    const anchorTurn = this.repository.findTurn(origin.anchorTurnId);
    if (sourceBranch === null || anchorTurn === null) return "unavailable";
    if (anchorTurn.branchId !== sourceBranch.id || anchorTurn.role !== "assistant" || anchorTurn.piEntryId !== origin.anchorEntryId) {
      return "changed";
    }
    if (
      origin.selection.start < 0 ||
      origin.selection.end < origin.selection.start ||
      origin.selection.end > anchorTurn.text.length ||
      anchorTurn.text.slice(origin.selection.start, origin.selection.end) !== origin.selection.text
    ) {
      return "changed";
    }
    if (anchorTurn.runId === null) return "changed";
    const run = this.repository.findRun(anchorTurn.runId);
    return run === null || run.session.availability.status === "unavailable" ? "unavailable" : "available";
  }

  /**
   * 分支续聊点的会话引用（只读推导；与 #resolveContinuation 同源但不抛错，
   * 供 A4 可用性展示用）：latest run 的引用；无 run 的分支用 origin 锚点
   * run 的引用 + anchorEntryId。返回 null = 尚无会话（或锚点退化不可读）。
   */
  #continuationReference(branch: Branch): SessionReference | null {
    const episodes = this.repository.listEpisodes(branch.id);
    let latestRun: Run | null = null;
    for (const episode of episodes) {
      const runs = this.repository.listRuns(episode.id);
      if (runs.length > 0) latestRun = runs[runs.length - 1]!;
    }
    if (latestRun !== null) return latestRun.session;
    const origin = this.repository.findBranchOrigin(branch.id);
    if (origin === null) return null;
    const anchorTurn = this.repository.findTurn(origin.anchorTurnId);
    if (anchorTurn === null || anchorTurn.runId === null) return null;
    const anchorRun = this.repository.findRun(anchorTurn.runId);
    if (anchorRun === null) return null;
    return { ...anchorRun.session, entryId: origin.anchorEntryId };
  }

  /**
   * A4 会话可用性评估：以实时文件存在性探针（只探存在，**绝不读取
   * session 内容**——与 persistence 默认探针同纪律）修正 DB 缓存评估：
   * - DB available 且文件在 → available；DB available 但文件缺 → unavailable；
   * - DB 因 missing-file 降级且文件已恢复 → available（降级可修复）；
   * - DB 因其他原因（version-mismatch/corrupt）降级 → 维持 unavailable
   *   （存在性探针看不见这些原因，不谎报恢复）；
   * - 内存会话（无 sessionFile）→ unavailable（不可恢复）。
   */
  #probeSessionAvailability(reference: SessionReference): "available" | "unavailable" {
    if (reference.sessionFile === "") return "unavailable";
    if (reference.availability.status === "available") {
      return existsSync(reference.sessionFile) ? "available" : "unavailable";
    }
    return reference.availability.reason === "missing-file" && existsSync(reference.sessionFile)
      ? "available"
      : "unavailable";
  }

  #branchSessionAvailability(branch: Branch): "available" | "unavailable" | null {
    const reference = this.#continuationReference(branch);
    return reference === null ? null : this.#probeSessionAvailability(reference);
  }


  /** 分支的续聊点（全部可从 DB 重建）。 */
  #resolveContinuation(branch: Branch): Continuation {
    const episodes = this.repository.listEpisodes(branch.id);
    let latestRun: Run | null = null;
    for (const episode of episodes) {
      const runs = this.repository.listRuns(episode.id);
      if (runs.length > 0) latestRun = runs[runs.length - 1]!;
    }
    if (latestRun !== null) {
      return { kind: "reference", reference: latestRun.session };
    }
    const origin = this.repository.findBranchOrigin(branch.id);
    if (origin !== null) {
      const anchorTurn = this.repository.getTurn(origin.anchorTurnId);
      if (anchorTurn.runId === null) {
        throw new InvalidArgumentError(
          `anchor turn ${origin.anchorTurnId} has no run (schema integrity violation)`,
        );
      }
      const anchorRun = this.repository.getRun(anchorTurn.runId);
      return {
        kind: "reference",
        reference: {
          sessionId: anchorRun.session.sessionId,
          sessionFile: anchorRun.session.sessionFile,
          entryId: origin.anchorEntryId,
          piVersion: anchorRun.session.piVersion,
          availability: anchorRun.session.availability,
        },
      };
    }
    if (branch.parentBranchId === null) {
      return { kind: "new-session" };
    }
    throw new InvalidArgumentError(
      `branch ${branch.id} has no continuation point (no runs and no origin)`,
    );
  }

  /** 把活动 Pi 会话对准续聊点（cursor 只是缓存，真实位置以 DB 为准）。 */
  async #ensureSessionAt(treeId: TreeId, branchId: BranchId, continuation: Continuation): Promise<SessionReference> {
    if (continuation.kind === "new-session") {
      const snapshot = await this.runtime.createSession({
        model: this.model,
        cwd: this.cwd,
        sessionDir: this.sessionDir,
      });
      this.#setCursor(treeId, branchId, snapshot.reference);
      return snapshot.reference;
    }
    const target = continuation.reference;
    const cursor = this.#cursor;
    if (
      cursor !== null &&
      cursor.reference.sessionFile === target.sessionFile &&
      cursor.reference.entryId === target.entryId
    ) {
      // 已在该位置（可能只是分支视图不同）：更新分支归属即可。
      this.#setCursor(treeId, branchId, cursor.reference);
      return cursor.reference;
    }
    let reference: SessionReference;
    if (cursor !== null && cursor.reference.sessionFile === target.sessionFile) {
      // 同一 session 文件：navigateTree 移动叶指针（不换 session、不换文件）。
      reference = await this.runtime.navigateTree({ entryId: target.entryId });
    } else {
      reference = (await this.runtime.restoreSession(target)).reference;
    }
    this.#setCursor(treeId, branchId, reference);
    return reference;
  }

  /* ------------------------------ 对话 ------------------------------ */

  /**
   * 在分支上执行一轮 prompt（Episode + Run + user/assistant Turn 落库）。
   *
   * 单用户冲突语义：同一时刻至多一个在途 prompt 操作（与 PiRuntime 契约
   * 一致）；冲突的第二个 prompt 以 TypeError 拒绝（HTTP 层映射 409），
   * 且不产生任何 run/turn 写入。
   *
   * 中止收敛：prompt 被中止（runtime TreeAIError code "user-abort"）时，
   * run 以单事务 running → aborting → aborted 收敛（run-state I4），
   * 绝不改写为 failed；其他失败仍按既有语义收敛 failed 并记录 failure。
   *
   * 事件面（P1）：run 落库后推送 run-started；收敛（成功/失败/中止）推送
   * run-terminal。会话对准失败（如 session-corrupt）发生在 run 创建之前
   * ——无部分写入，也无事件（HTTP 错误与 sessionAvailability 展示降级）。
   *
   * Journal 面（P1，注入 journal 时）：对准阶段事件（session.* /
   * tree.navigated）缓冲后归属本次创建的 run；run 落库记录显式
   * queued→running；运行期事件实时归属。收敛由运行时事件派生（见文件头）。
   */
  async prompt(treeId: TreeId, branchId: BranchId, text: string): Promise<PromptOutcome> {
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new InvalidArgumentError("prompt text must be a non-empty string");
    }
    const tree = this.repository.getTree(treeId);
    const branch = this.repository.getBranch(branchId);
    if (branch.treeId !== tree.id) {
      throw new InvalidArgumentError(`branch ${branchId} belongs to tree ${branch.treeId}, not ${tree.id}`);
    }
    if (this.#promptInFlight) {
      throw new TypeError("a prompt is already in flight on this service; wait for it to settle or abort it first");
    }
    this.#promptInFlight = true;
    const prelude: PiRuntimeEvent[] = [];
    this.#promptPrelude = prelude;
    try {
      const continuation = this.#resolveContinuation(branch);
      const preRef = await this.#ensureSessionAt(tree.id, branch.id, continuation);

      // 未送达的 return 在这次 prompt 送入 Pi 上下文。
      const pendingReturns = this.repository
        .listTurns(branch.id)
        .filter((turn) => turn.role === "return" && turn.deliveredRunId === null);
      const composedText = composePromptText(pendingReturns, text);

      const episode = this.repository.createEpisode(branch.id);
      const run = this.repository.createRun(episode.id, preRef);
      this.repository.updateRunState(run.id, "running");
      this.#activeRun = {
        treeId: tree.id,
        branchId: branch.id,
        episodeId: episode.id,
        runId: run.id,
        abortRequested: false,
      };
      this.#promptPrelude = null;
      // journal：对准阶段事件归属本 run + 显式 queued→running（域归属在此补齐）。
      for (const event of prelude) {
        this.#journalRuntimeEvent(run.id, event);
      }
      this.#journalStateChange(run.id, "queued", "running");
      this.#emitStudio({
        type: "run-started",
        treeId: tree.id,
        branchId: branch.id,
        episodeId: episode.id,
        runId: run.id,
      });

      let result: Awaited<ReturnType<PiRuntime["prompt"]>>;
      try {
        result = await this.runtime.prompt({ text: composedText });
      } catch (err) {
        const error = toTreeAIError(err);
        const record = this.#activeRun;
        this.#activeRun = null;
        if (error.code === "user-abort") {
          // 用户/宿主主动中止（abort、会话替换、dispose）：收敛为 aborted。
          this.repository.transaction(() => {
            this.repository.updateRunState(run.id, "aborting");
            this.repository.updateRunState(run.id, "aborted");
          });
          this.#emitStudio({ type: "run-terminal", treeId: tree.id, runId: run.id, state: "aborted", failure: null });
          if (record !== null && record.abortRequested && preRef.entryId !== "") {
            // 会话叶指针回位到本次 prompt 的续聊点（append-only 树不删条目），
            // 保证中止后同进程续聊与重启后语义一致；尽力而为，失败时清空
            // 内存 cursor，让下一次 prompt 走 restoreSession 自愈。
            try {
              await this.runtime.navigateTree({ entryId: preRef.entryId });
            } catch {
              this.#cursor = null;
            }
          }
        } else {
          this.repository.updateRunState(run.id, "failed", { failure: error });
          this.#emitStudio({
            type: "run-terminal",
            treeId: tree.id,
            runId: run.id,
            state: "failed",
            failure: { code: error.code, message: error.message },
          });
        }
        throw err;
      }
      this.#activeRun = null;

      const outcome = this.repository.transaction(() => {
        this.repository.updateRunState(run.id, "succeeded");
        this.repository.updateRunSessionReference(run.id, result.reference);
        const userTurn = this.repository.createTurn({
          treeId: tree.id,
          branchId: branch.id,
          episodeId: episode.id,
          runId: run.id,
          role: "user",
          text,
        });
        const assistantTurn = this.repository.createTurn({
          treeId: tree.id,
          branchId: branch.id,
          episodeId: episode.id,
          runId: run.id,
          role: "assistant",
          text: result.message,
          piEntryId: result.reference.entryId,
        });
        for (const pending of pendingReturns) {
          this.repository.markReturnDelivered(pending.id, run.id);
        }
        return { userTurn, assistantTurn };
      });

      this.#setCursor(tree.id, branch.id, result.reference);
      this.#emitStudio({ type: "run-terminal", treeId: tree.id, runId: run.id, state: "succeeded", failure: null });
      return {
        run: this.repository.getRun(run.id),
        userTurn: outcome.userTurn,
        assistantTurn: outcome.assistantTurn,
        deliveredReturns: pendingReturns.length,
      };
    } finally {
      this.#promptPrelude = null;
      this.#promptInFlight = false;
      // journal 落盘排空（确定性：prompt settle 时该 run 的全部 journal 事件已写入）。
      await this.#journalTail;
    }
  }

  /* ------------------------------ 中止 ------------------------------ */

  /**
   * 请求中止该树当前在途的 run。校验目标确为该树的活动 run（未知树/run →
   * EntityNotFoundError；空 id/跨树 run → InvalidArgumentError；非活动 run
   * → RunNotActiveError，均为操作冲突语义），然后调用 runtime.abort()；
   * 在途 prompt 随后以 TreeAIError（code "user-abort"）收敛，run 落库为
   * aborted（见 prompt 的收敛路径）。幂等；若 prompt 已先一步 settle，
   * 本次请求不产生效果（不撒谎、不改写结果）。
   *
   * 事件面：校验通过即推送 abort-requested（诊断面同步可见 aborting）。
   */
  async abort(treeId: TreeId, runId: RunId): Promise<void> {
    const tree = this.repository.getTree(treeId); // EntityNotFoundError → 404
    const run = this.repository.getRun(runId); // 空 id → InvalidArgumentError；未知 → 404
    const episode = this.repository.getEpisode(run.episodeId);
    const branch = this.repository.getBranch(episode.branchId);
    if (branch.treeId !== tree.id) {
      throw new InvalidArgumentError(`run ${runId} belongs to tree ${branch.treeId}, not ${tree.id}`);
    }
    const active = this.#activeRun;
    if (active === null || active.runId !== run.id) {
      throw new RunNotActiveError(runId, run.state);
    }
    // 同步置位：abort() 返回前，诊断面即可观测到 aborting。
    active.abortRequested = true;
    this.#emitStudio({ type: "abort-requested", treeId: tree.id, runId: run.id });
    this.#journalAbortRequested(run.id);
    await this.runtime.abort();
  }

  /* ------------------------------ 诊断（A5 安全投影） ------------------------------ */

  /**
   * 一棵树的诊断读模型：运行面状态（idle/streaming/aborting）、在途 run
   * 定位、DB 全量 run 的安全投影。刻意排除 session 引用（sessionFile/
   * sessionId/entryId/piVersion/availability）、failure.details、原始
   * cause、命令、主机与目标路径。策略决策如实报告：默认装配（空工具
   * allowlist）下从未观测 → observed=false；注入请求时策略门后观测到的
   * 决定以脱敏投影列出（绝不伪造，也绝不隐瞒已发生的拒绝）。
   */
  getTreeDiagnostics(treeId: TreeId): TreeDiagnostics {
    const tree = this.repository.getTree(treeId); // EntityNotFoundError → 404
    const runs: RunDiagnostics[] = [];
    for (const branch of this.repository.listBranches(tree.id)) {
      for (const episode of this.repository.listEpisodes(branch.id)) {
        for (const run of this.repository.listRuns(episode.id)) {
          runs.push({
            runId: run.id,
            branchId: branch.id,
            episodeId: episode.id,
            state: run.state,
            failure:
              run.failure === undefined ? null : { code: run.failure.code, message: run.failure.message },
            createdAt: run.createdAt,
            terminalAt: run.terminalAt,
          });
        }
      }
    }
    // 跨 episode/branch 的稳定全序（createdAt 同毫秒时以 runId 决胜）。
    runs.sort((a, b) =>
      a.createdAt === b.createdAt ? (a.runId < b.runId ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1,
    );
    const active = this.#activeRun;
    const activeForTree = active !== null && active.treeId === tree.id ? active : null;
    return {
      treeId: tree.id,
      runtimeState:
        activeForTree === null ? "idle" : activeForTree.abortRequested ? "aborting" : "streaming",
      activeRun:
        activeForTree === null
          ? null
          : { runId: activeForTree.runId, branchId: activeForTree.branchId, episodeId: activeForTree.episodeId },
      runs,
      policyDecisions:
        this.#policyObservations.length > 0
          ? { observed: true, decisions: [...this.#policyObservations] }
          : { observed: false, reason: NO_POLICY_DECISIONS_REASON },
    };
  }

  /**
   * 一棵树的 journal 保守投影（P1 来源抽屉的数据面）：该树全部 run 的
   * journal 事件，按写入顺序（全局时序）排列、最新在后；limit 截尾保留
   * 最新 N 条（默认 50，钳制 1..500）。未知树 → EntityNotFoundError
   * （HTTP 404）。未注入 journal 或该树无事件 → 空数组。summary 为
   * 白名单构造的人类可读串（见 summarizeJournalEvent），绝不透出
   * 原始 payload。
   */
  getTreeJournal(treeId: TreeId, limit = 50): readonly JournalEventView[] {
    const tree = this.repository.getTree(treeId); // EntityNotFoundError → 404
    const journal = this.#journal;
    if (journal === null) return [];
    const runIds = this.#treeRunIds(tree.id);
    if (runIds.size === 0) return [];
    const bounded = Math.min(Math.max(Math.floor(limit), 1), 500);
    const events = journal
      .listEvents()
      .filter((event) => runIds.has(event.runId as string))
      .slice(-bounded);
    return events.map((event) => ({
      eventId: event.eventId,
      runId: event.runId,
      seq: event.seq,
      occurredAt: event.occurredAt,
      type: event.type,
      summary: summarizeJournalEvent(event),
    }));
  }

  /** 一棵树全部 run 的 id 集合（journal 过滤用）。 */
  #treeRunIds(treeId: TreeId): Set<string> {
    const runIds = new Set<string>();
    for (const branch of this.repository.listBranches(treeId)) {
      for (const episode of this.repository.listEpisodes(branch.id)) {
        for (const run of this.repository.listRuns(episode.id)) {
          runIds.add(run.id as string);
        }
      }
    }
    return runIds;
  }

  /* ------------------------------ 分支 ------------------------------ */

  /** 从“锚定的答案选区”创建分支（出处与选区完整落库；分叉发生在首次续聊）。 */
  createBranchFromSelection(
    treeId: TreeId,
    sourceBranchId: BranchId,
    anchorTurnId: string,
    selection: TurnSelection,
  ): BranchCreation {
    const tree = this.repository.getTree(treeId);
    const source = this.repository.getBranch(sourceBranchId);
    if (source.treeId !== tree.id) {
      throw new InvalidArgumentError(`branch ${sourceBranchId} belongs to tree ${source.treeId}, not ${tree.id}`);
    }
    const anchorTurn = this.repository.getTurn(anchorTurnId as TurnId);
    if (anchorTurn.treeId !== tree.id) {
      throw new InvalidArgumentError(`turn ${anchorTurnId} belongs to tree ${anchorTurn.treeId}, not ${tree.id}`);
    }
    if (typeof selection !== "object" || selection === null) {
      throw new InvalidArgumentError("selection must be a TurnSelection object");
    }
    return this.repository.transaction(() => {
      const branch = this.repository.createBranch(tree.id, { parentBranchId: source.id });
      const origin = this.repository.setBranchOrigin({
        branchId: branch.id,
        sourceBranchId: source.id,
        anchorTurnId: anchorTurn.id,
        anchorEntryId: anchorTurn.piEntryId === null ? "" : anchorTurn.piEntryId,
        selection,
      });
      return { branch, origin };
    });
  }

  /** 切换分支视图并把活动会话对准该分支续聊点（“导航回 Trunk”）。 */
  async switchBranch(treeId: TreeId, branchId: BranchId): Promise<SessionCursorInfo | null> {
    const tree = this.repository.getTree(treeId);
    const branch = this.repository.getBranch(branchId);
    if (branch.treeId !== tree.id) {
      throw new InvalidArgumentError(`branch ${branchId} belongs to tree ${branch.treeId}, not ${tree.id}`);
    }
    const continuation = this.#resolveContinuation(branch);
    if (continuation.kind === "new-session") {
      // 尚无 session：切换只改变视图，首次 prompt 时再新建。
      return null;
    }
    await this.#ensureSessionAt(tree.id, branch.id, continuation);
    return this.#cursorInfo(treeId);
  }

  async revealBranchOrigin(treeId: TreeId, branchId: BranchId): Promise<AnchorLocation> {
    const tree = this.repository.getTree(treeId);
    const branch = this.repository.getBranch(branchId);
    if (branch.treeId !== tree.id) {
      throw new InvalidArgumentError(`branch ${branchId} belongs to tree ${branch.treeId}, not ${treeId}`);
    }
    const origin = this.repository.findBranchOrigin(branch.id);
    if (origin === null) {
      throw new InvalidArgumentError(`branch ${branchId} has no anchor origin`);
    }
    const source = this.repository.findBranch(origin.sourceBranchId);
    let status = this.#anchorStatus(origin);
    if (status === "available" && source !== null) {
      const anchorTurn = this.repository.findTurn(origin.anchorTurnId);
      if (anchorTurn !== null && anchorTurn.runId !== null) {
        const anchorRun = this.repository.getRun(anchorTurn.runId);
        const target: SessionReference = { ...anchorRun.session, entryId: origin.anchorEntryId };
        try {
          const cursor = this.#cursor;
          const reference =
            cursor !== null && cursor.reference.sessionFile === target.sessionFile
              ? await this.runtime.navigateTree({ entryId: target.entryId })
              : (await this.runtime.restoreSession(target)).reference;
          this.#setCursor(tree.id, source.id, reference);
        } catch {
          status = "unavailable";
        }
      } else {
        status = "unavailable";
      }
    }
    return {
      sourceBranchId: origin.sourceBranchId,
      anchorTurnId: origin.anchorTurnId,
      status,
      selection: origin.selection,
    };
  }

  /* ------------------------------ Return ------------------------------ */

  /**
   * 编辑后显式提交 Return（幂等）：idempotencyKey 标识一次逻辑提交
   * （客户端生成，跨失败重试保持稳定），targetAnchor 为提交时出处分支
   * origin 的快照（原分叉点的展示定位）。
   *
   * 写入顺序即契约（先导航后落库的既有次序不变）：
   * 1. 幂等重放检查（先于导航、零写入）：同键同内容（fromBranchId +
   *    text）→ 直接返回既有 Return（created === false）；同键不同内容
   *    → ReturnConflictError。响应丢失后的客户端重试因此不会产生第二条
   *    Return；
   * 2. 导航回 Trunk 续聊点：导航失败（如 Pi session 文件缺失 →
   *    session-corrupt）在任何 Return 落库之前抛出 → 同键重试不重复；
   * 3. 单事务落库（episode + return turn）。并发同键竞争由
   *    turns.idempotency_key 部分唯一索引裁决：判负方事务整体回滚
   *    （无悬挂 episode），按键重读——同内容返回既有 Return
   *    （created === false），不同内容 ReturnConflictError。
   *
   * Trunk 尚无 session（new-session）时不导航、不建 session（与
   * switchBranch 语义一致），Return 直接落库，待首次 Trunk prompt 时建
   * session 并送达（送达恰一次，见 prompt / markReturnDelivered）。
   */
  async submitReturn(
    treeId: TreeId,
    fromBranchId: BranchId,
    text: string,
    idempotencyKey: string,
  ): Promise<ReturnSubmission> {
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new InvalidArgumentError("return text must be a non-empty string");
    }
    if (typeof idempotencyKey !== "string" || idempotencyKey.trim().length === 0) {
      throw new InvalidArgumentError("return idempotencyKey must be a non-empty string");
    }
    const tree = this.repository.getTree(treeId);
    const branch = this.repository.getBranch(fromBranchId);
    if (branch.treeId !== tree.id) {
      throw new InvalidArgumentError(`branch ${fromBranchId} belongs to tree ${branch.treeId}, not ${tree.id}`);
    }
    // 幂等重放（先于导航与任何写入）：同键同内容 → 既有 Return；同键异容 → 冲突。
    const replay = this.repository.findReturnByIdempotencyKey(tree.id, idempotencyKey);
    if (replay !== null) {
      return { turn: this.#alignWithExistingReturn(idempotencyKey, replay, branch.id, text), created: false };
    }
    const origin = this.repository.findBranchOrigin(branch.id);
    if (origin === null) {
      throw new InvalidArgumentError(
        `branch ${fromBranchId} has no origin; only anchored branches can submit a return`,
      );
    }
    const branches = this.repository.listBranches(tree.id);
    const trunk = branches.find((b) => b.parentBranchId === null);
    if (trunk === undefined) {
      throw new InvalidArgumentError(`tree ${tree.id} has no trunk (root) branch`);
    }
    // 先导航后写入：导航失败（运行期 TreeAIError，如 session 文件缺失）
    // 在任何 Return 持久化之前抛出 → 重试不产生重复 Return。
    await this.switchBranch(tree.id, trunk.id);
    const targetAnchor: ReturnTargetAnchor = {
      sourceBranchId: origin.sourceBranchId,
      anchorTurnId: origin.anchorTurnId,
      anchorEntryId: origin.anchorEntryId,
      selection: origin.selection,
    };
    try {
      // 单事务：唯一索引判负时 episode 随 return 一并回滚，不留悬挂回合。
      const turn = this.repository.transaction(() => {
        const episode = this.repository.createEpisode(trunk.id);
        return this.repository.createTurn({
          treeId: tree.id,
          branchId: trunk.id,
          episodeId: episode.id,
          role: "return",
          text,
          fromBranchId: branch.id,
          idempotencyKey,
          targetAnchor,
        });
      });
      return { turn, created: true };
    } catch (error) {
      // 并发同键竞争：唯一索引判负 → 事务已回滚，按键重读并按内容对齐；
      // 非同键竞争的约束失败（重读为空）原样上抛。
      if (error instanceof ConstraintViolationError) {
        const raced = this.repository.findReturnByIdempotencyKey(tree.id, idempotencyKey);
        if (raced !== null) {
          return { turn: this.#alignWithExistingReturn(idempotencyKey, raced, branch.id, text), created: false };
        }
      }
      throw error;
    }
  }

  /** 同键内容比对：与既有 Return 一致则返回它，否则抛 ReturnConflictError（差异定位进消息）。 */
  #alignWithExistingReturn(
    idempotencyKey: string,
    existing: Turn,
    fromBranchId: BranchId,
    text: string,
  ): Turn {
    if (existing.fromBranchId === fromBranchId && existing.text === text) {
      return existing;
    }
    const differences: string[] = [];
    if (existing.fromBranchId !== fromBranchId) {
      differences.push(`fromBranchId ${fromBranchId} does not match ${existing.fromBranchId}`);
    }
    if (existing.text !== text) {
      differences.push("text differs");
    }
    throw new ReturnConflictError(idempotencyKey, existing.id, differences.join("; "));
  }

  /* ------------------------------ 生命周期 ------------------------------ */

  /**
   * 释放服务侧资源：退订运行时事件、清空事件监听者、释放 runtime。
   * journal 的 close 仍由宿主拥有（close 排空内部写入队列，保证剩余
   * journal 事件落盘）——本方法只尽力等待当前已排队的写入。
   */
  async dispose(): Promise<void> {
    this.#cursor = null;
    this.#activeRun = null;
    this.#promptPrelude = null;
    await this.runtime.dispose();
    this.#unsubscribeRuntime();
    this.#studioListeners.clear();
    await this.#journalTail;
  }
}
