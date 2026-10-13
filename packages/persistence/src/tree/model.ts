/** model ownership for tree-repository.ts; compatibility entrypoint remains one level above. */
import type {
  Branch,
  BranchId,
  Episode,
  EpisodeId,
  Forest,
  IsoTimestamp,
  ReturnTargetAnchor,
  Run,
  RunId,
  SessionReference,
  TerminologyMode,
  Tree,
  TreeAIError,
  TreeId,
  TurnId,
  TurnRole,
  TurnSelection,
} from "@treeai/contracts";

/* ------------------------------------------------------------------ */
/* 选项与恢复查询类型                                                    */
/* ------------------------------------------------------------------ */

export interface TreeRepositoryOptions {
  /** 数据库文件路径；`":memory:"` 为纯内存库。 */
  readonly path: string;
  /** 时钟注入（默认真实 UTC ISO 8601）。 */
  readonly now?: () => IsoTimestamp;
  /** 原始 id 生成器注入（默认 randomUUID；仓储自动加实体前缀）。 */
  readonly generateId?: () => string;
  /** 写锁等待毫秒数（默认 5000）。 */
  readonly busyTimeoutMs?: number;
}

export interface CreateBranchInput {
  readonly id?: BranchId;
  /** 父分支；null/缺省 = 根分支。必须属于同一 Tree。 */
  readonly parentBranchId?: BranchId | null;
}

export interface UpdateRunStateOptions {
  /** state === "failed" 时必填；其他终态/非终态必须缺省（contracts：failure iff failed）。 */
  readonly failure?: TreeAIError;
}

/** 创建 Turn 的输入（contracts product.ts 不变量的仓储层校验）。 */
export interface CreateTurnInput {
  readonly id?: TurnId;
  readonly treeId: TreeId;
  readonly branchId: BranchId;
  readonly episodeId: EpisodeId;
  /** role "user"/"assistant" 必填；role "return" 必须为 null/缺省。 */
  readonly runId?: RunId | null;
  readonly role: TurnRole;
  readonly text: string;
  /** assistant turn 的 Pi 叶条目锚点；user/return turn 为 null。 */
  readonly piEntryId?: string | null;
  /** role "return" 必填（出处分支）；其他 role 必须为 null/缺省。 */
  readonly fromBranchId?: BranchId | null;
  /** role "return" 专属提交幂等键（非空；树内唯一索引 UNIQUE(tree_id, idempotency_key) 强制每 Tree 至多一条）；其他 role 必须为 null/缺省。 */
  readonly idempotencyKey?: string | null;
  /** role "return" 专属目标锚点快照（提交时 BranchOrigin 的拷贝）；其他 role 必须为 null/缺省。 */
  readonly targetAnchor?: ReturnTargetAnchor | null;
}

/** 保存术语批注的输入（contracts product.ts TerminologyAnnotation 不变量的仓储层校验）。 */
export interface CreateTerminologyAnnotationInput {
  readonly treeId: TreeId;
  readonly branchId: BranchId;
  readonly anchorTurnId: TurnId;
  readonly selection: TurnSelection;
  /** 锚点答案全文的 SHA-256 指纹（批注时刻）。 */
  readonly sourceHash: string;
  readonly term: string;
  readonly explanation: string;
  readonly mode: TerminologyMode;
}

/**
 * 登记术语推广首问派发意图（migration 0009 派发账本；issue #7 P0 整改）。
 * 与推广绑定同一事务调用（见 bindTerminologyPromotion 的调用方契约）。
 */
export interface CreateTerminologyDispatchInput {
  readonly annotationId: string;
  readonly treeId: TreeId;
  readonly promotionKey: string;
  readonly branchId: BranchId;
  /** 首问不可变 payload（组合上下文 + 问题全文）的 SHA-256。 */
  readonly firstQuestionHash: string;
}

/** 派发账本终局结算输入：成功（带 Run 引用）或明确失败。 */
export type SettleTerminologyDispatchInput =
  | { readonly state: "succeeded"; readonly runId: RunId }
  | { readonly state: "failed"; readonly failure: TreeAIError };

/** 设置 Branch 出处锚点（每分支至多一条）。 */
export interface SetBranchOriginInput {
  readonly branchId: BranchId;
  readonly sourceBranchId: BranchId;
  readonly anchorTurnId: TurnId;
  /** 必须等于 anchorTurn.piEntryId。 */
  readonly anchorEntryId: string;
  readonly selection: TurnSelection;
}

export interface ActiveNavigation {
  readonly treeId: TreeId;
  readonly branchId: BranchId;
  readonly reference: SessionReference;
  readonly updatedAt: IsoTimestamp;
}

/** 一次 Return 采用尝试（Return→Run 关联 + 尝试时刻；Run 结果由 runs 行携带）。 */
export interface ReturnAdoptionAttempt {
  readonly runId: RunId;
  readonly attemptedAt: IsoTimestamp;
}

export interface EpisodeRecovery {
  readonly episode: Episode;
  /** 按创建顺序（created_at, rowid）。 */
  readonly runs: readonly Run[];
  readonly latestRun: Run | null;
}

export interface BranchRecovery {
  readonly forest: Forest;
  readonly tree: Tree;
  readonly branch: Branch;
  readonly parentBranch: Branch | null;
  readonly episodes: readonly EpisodeRecovery[];
  /** 该分支全部 episode 中最新的 run。 */
  readonly latestRun: Run | null;
}

export interface TreeRecovery {
  readonly forest: Forest;
  readonly tree: Tree;
  readonly branches: readonly BranchRecovery[];
}

export interface CreateBackupOptions {
  /** 目标已存在时先删除（默认 false：拒绝覆盖）。 */
  readonly overwrite?: boolean;
}

export interface RestoreOptions {
  /** 恢复前把当前库另存到该路径（不覆盖已存在文件）。 */
  readonly backupCurrentTo?: string;
}

export interface SessionFileSweepResult {
  readonly sessionFile: string;
  readonly updatedReferences: number;
}

export interface AvailabilityColumns {
  status: "available" | "unavailable";
  reason: string | null;
  detail: string | null;
}
