/**
 * TreeRepository：TreeAI 自有数据库的领域仓储
 * （Forest / Tree / Branch / Episode / Run / SessionReference）。
 *
 * 边界（ADR-001 §4 硬约束）：
 * - TreeAI DB 是产品事实源；本仓储不依赖、不校验 Pi session 文件的存在性
 *   （availability 是缓存评估，由调用方探针结果或恢复流程更新）。
 * - SessionReference 只保存 sessionFile/sessionId/entryId/piVersion/availability；
 *   不复制凭据、不解析 Pi session 内容、不写 Pi session JSONL。
 * - Pi session 丢失只降级 availability（unavailable），**绝不**级联删除域数据。
 *
 * 单终态保证（contracts run-state.ts I3，三层防御）：
 * 1. 仓储层：终态写入使用条件 UPDATE（`WHERE terminal_state IS NULL`），
 *    0 行命中即判定终态冲突；
 * 2. schema CHECK：terminal_at/terminal_state 一致、failure 仅 failed；
 * 3. 触发器 runs_terminal_immutable：终态行的状态再变更直接 ABORT
 *    （对绕过本仓储的裸 SQL 同样生效）。
 *
 * 事务：写路径使用 `BEGIN IMMEDIATE`（写前取锁，避免 DEFERRED 读→写
 * 升级死锁）；嵌套调用以 SAVEPOINT 实现内层独立回滚。
 */
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, rmSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type {
  Branch,
  BranchId,
  BranchOrigin,
  Episode,
  EpisodeId,
  Forest,
  ForestId,
  IsoTimestamp,
  ReturnTargetAnchor,
  Run,
  RunId,
  RunState,
  RunStateTransitions,
  SessionAvailability,
  SessionReference,
  Tree,
  TreeAIError,
  TreeId,
  Turn,
  TurnId,
  TurnRole,
  TurnSelection,
} from "@treeai/contracts";
import {
  BackupError,
  DatabaseCorruptError,
  EntityNotFoundError,
  InvalidArgumentError,
  InvalidRunStateTransitionError,
  mapSqliteError,
  RepositoryClosedError,
  RunTerminalConflictError,
} from "./errors.ts";
import {
  checkIntegrity,
  openDatabase,
  validateDatabaseFile,
  vacuumInto,
  type BackupValidation,
  type IntegrityReport,
} from "./database.ts";
import {
  encodeFailure,
  encodeTargetAnchor,
  rowToActiveNavigation,
  rowToBranch,
  rowToBranchOrigin,
  rowToEpisode,
  rowToForest,
  rowToReturnAdoptionAttempt,
  rowToRun,
  rowToSessionReference,
  rowToTree,
  rowToTurn,
  type ActiveNavigationRow,
  type BranchOriginRow,
  type BranchRow,
  type EpisodeRow,
  type ForestRow,
  type ReturnAdoptionAttemptRow,
  type RunRow,
  type SessionReferenceRow,
  type TreeRow,
  type TurnRow,
} from "./serialization.ts";

/* ------------------------------------------------------------------ */
/* 冻结迁移表的运行时副本（编译期以 satisfies 与 contracts 对齐）        */
/* ------------------------------------------------------------------ */

const RUN_STATE_TRANSITIONS = {
  queued: ["running", "failed"],
  running: ["aborting", "succeeded", "failed"],
  aborting: ["aborted", "failed"],
  succeeded: [],
  failed: [],
  aborted: [],
} as const satisfies RunStateTransitions;

const TERMINAL_STATES: readonly RunState[] = ["succeeded", "failed", "aborted"];

function isTerminalRunState(state: RunState): boolean {
  return TERMINAL_STATES.includes(state);
}

function isAllowedRunTransition(from: RunState, to: RunState): boolean {
  return (RUN_STATE_TRANSITIONS[from] as readonly RunState[]).includes(to);
}

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

/* --------------------- D3 产品层（turns / branch_origins） --------------------- */

const TURN_ROLES: readonly TurnRole[] = ["user", "assistant", "return"];

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

/* ------------------------------------------------------------------ */
/* 校验辅助                                                             */
/* ------------------------------------------------------------------ */

function assertNonEmptyString(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidArgumentError(`${field} must be a non-empty string`);
  }
}

/** 校验 Return 目标锚点快照形状（定位字段非空 + 选区整数偏移有序）。 */
function assertValidTargetAnchor(anchor: ReturnTargetAnchor): void {
  assertNonEmptyString(anchor.sourceBranchId, "targetAnchor.sourceBranchId");
  assertNonEmptyString(anchor.anchorTurnId, "targetAnchor.anchorTurnId");
  assertNonEmptyString(anchor.anchorEntryId, "targetAnchor.anchorEntryId");
  const selection = anchor.selection;
  if (
    typeof selection !== "object" ||
    selection === null ||
    !Number.isInteger(selection.start) ||
    !Number.isInteger(selection.end) ||
    selection.start < 0 ||
    selection.end < selection.start ||
    typeof selection.text !== "string"
  ) {
    throw new InvalidArgumentError("targetAnchor.selection must be a TurnSelection {start, end, text}");
  }
}

const UNAVAILABLE_REASONS: readonly string[] = ["missing-file", "version-mismatch", "corrupt", "unknown"];

/** 校验 SessionReference 形状（引用三元组 + 版本 + availability 一致性）。 */
function assertValidSessionReference(reference: SessionReference, context: string): void {
  assertNonEmptyString(reference.sessionId, `${context}.sessionId`);
  assertNonEmptyString(reference.sessionFile, `${context}.sessionFile`);
  assertNonEmptyString(reference.entryId, `${context}.entryId`);
  assertNonEmptyString(reference.piVersion, `${context}.piVersion`);
  assertValidAvailability(reference.availability, `${context}.availability`);
}

function assertValidAvailability(availability: SessionAvailability, context: string): void {
  if (availability.status === "available") {
    // available 变体在类型层不存在 reason 字段（contracts）；
    // 存储层一致性由 schema CHECK 保证。
    return;
  }
  if (typeof availability.reason !== "string" || !UNAVAILABLE_REASONS.includes(availability.reason)) {
    throw new InvalidArgumentError(
      `${context}: unavailable reference requires a reason in {${UNAVAILABLE_REASONS.join(", ")}}`,
    );
  }
}

interface AvailabilityColumns {
  status: "available" | "unavailable";
  reason: string | null;
  detail: string | null;
}

function availabilityToColumns(availability: SessionAvailability): AvailabilityColumns {
  assertValidAvailability(availability, "availability");
  if (availability.status === "available") {
    return { status: "available", reason: null, detail: null };
  }
  return {
    status: "unavailable",
    reason: availability.reason,
    detail: availability.detail ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* TreeRepository                                                       */
/* ------------------------------------------------------------------ */

const MISSING_FILE_DETAIL = "session file not found (deleted or moved)";

export class TreeRepository {
  readonly path: string;
  readonly now: () => IsoTimestamp;
  readonly #generateId: () => string;
  readonly #busyTimeoutMs: number;
  #db: DatabaseSync | null;
  #txDepth: number;

  private constructor(options: TreeRepositoryOptions, db: DatabaseSync) {
    this.path = options.path;
    this.now = options.now ?? (() => new Date().toISOString());
    this.#generateId = options.generateId ?? (() => randomUUID());
    this.#busyTimeoutMs = options.busyTimeoutMs ?? 5000;
    this.#db = db;
    this.#txDepth = 0;
  }

  /**
   * 打开（必要时迁移）数据库并返回仓储实例。
   * 失败语义见 `openDatabase`（损坏/外来库/版本过新/migration 失败均明确抛错）。
   */
  static open(options: TreeRepositoryOptions): TreeRepository {
    const opened = openDatabase({
      path: options.path,
      busyTimeoutMs: options.busyTimeoutMs,
    });
    return new TreeRepository(options, opened.db);
  }

  /** 当前 schema 版本（user_version）。 */
  get schemaVersion(): number {
    this.#assertOpen();
    const row = this.#db!.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
    return Number(row?.user_version ?? 0);
  }

  isClosed(): boolean {
    return this.#db === null;
  }

  close(): void {
    const db = this.#db;
    if (db === null) return;
    this.#db = null;
    this.#txDepth = 0;
    db.close();
  }

  #assertOpen(): void {
    if (this.#db === null) throw new RepositoryClosedError();
  }

  #newId(prefix: string): string {
    return `${prefix}_${this.#generateId()}`;
  }

  /* ------------------------------ 事务 ------------------------------ */

  /**
   * 在事务中执行 `fn`。
   * - 顶层：`BEGIN IMMEDIATE` … `COMMIT`；`fn` 抛错则 `ROLLBACK` 并原样重抛；
   * - 嵌套：`SAVEPOINT`，内层失败只回滚内层（调用方捕获后外层可继续）。
   */
  transaction<T>(fn: () => T): T {
    this.#assertOpen();
    const db = this.#db!;
    if (this.#txDepth === 0) {
      db.exec("BEGIN IMMEDIATE");
      this.#txDepth = 1;
      try {
        const result = fn();
        db.exec("COMMIT");
        this.#txDepth = 0;
        return result;
      } catch (error) {
        this.#txDepth = 0;
        try {
          db.exec("ROLLBACK");
        } catch {
          // 事务已不存在（驱动已自动回滚）——保留原始错误。
        }
        throw error;
      }
    }
    const depth = this.#txDepth;
    const sp = `treeai_sp_${depth}`;
    db.exec(`SAVEPOINT ${sp}`);
    this.#txDepth = depth + 1;
    try {
      const result = fn();
      db.exec(`RELEASE ${sp}`);
      this.#txDepth = depth;
      return result;
    } catch (error) {
      this.#txDepth = depth;
      try {
        db.exec(`ROLLBACK TO ${sp}`);
        db.exec(`RELEASE ${sp}`);
      } catch {
        // savepoint 已不存在——保留原始错误。
      }
      throw error;
    }
  }

  #assertNoTransaction(context: string): void {
    if (this.#txDepth !== 0) {
      throw new BackupError(`${context} cannot run inside a transaction`);
    }
  }

  /* ------------------------------ Forest ------------------------------ */

  createForest(input?: { id?: ForestId }): Forest {
    this.#assertOpen();
    const id = input?.id ?? (this.#newId("forest") as ForestId);
    assertNonEmptyString(id, "forest id");
    const createdAt = this.now();
    try {
      this.#db!.prepare("INSERT INTO forests (id, created_at) VALUES (?, ?)").run(id, createdAt);
    } catch (error) {
      throw mapSqliteError(error, "creating forest");
    }
    return { id, createdAt };
  }

  getForest(id: ForestId): Forest {
    const found = this.findForest(id);
    if (found === null) throw new EntityNotFoundError("forest", id);
    return found;
  }

  findForest(id: ForestId): Forest | null {
    this.#assertOpen();
    assertNonEmptyString(id, "forest id");
    const row = this.#db!.prepare("SELECT id, created_at FROM forests WHERE id = ?").get(id) as
      | ForestRow
      | undefined;
    return row ? rowToForest(row) : null;
  }

  listForests(): Forest[] {
    this.#assertOpen();
    const rows = this.#db!.prepare("SELECT id, created_at FROM forests ORDER BY created_at, rowid").all() as unknown as ForestRow[];
    return rows.map(rowToForest);
  }

  /* ------------------------------ Tree ------------------------------ */

  createTree(forestId: ForestId, input?: { id?: TreeId }): Tree {
    this.#assertOpen();
    assertNonEmptyString(forestId, "forest id");
    const forest = this.findForest(forestId);
    if (forest === null) throw new EntityNotFoundError("forest", forestId);
    const id = input?.id ?? (this.#newId("tree") as TreeId);
    assertNonEmptyString(id, "tree id");
    const createdAt = this.now();
    try {
      this.#db!.prepare("INSERT INTO trees (id, forest_id, created_at) VALUES (?, ?, ?)").run(
        id,
        forestId,
        createdAt,
      );
    } catch (error) {
      throw mapSqliteError(error, "creating tree");
    }
    return { id, forestId, createdAt };
  }

  getTree(id: TreeId): Tree {
    const found = this.findTree(id);
    if (found === null) throw new EntityNotFoundError("tree", id);
    return found;
  }

  findTree(id: TreeId): Tree | null {
    this.#assertOpen();
    assertNonEmptyString(id, "tree id");
    const row = this.#db!.prepare("SELECT id, forest_id, created_at FROM trees WHERE id = ?").get(id) as
      | TreeRow
      | undefined;
    return row ? rowToTree(row) : null;
  }

  listTrees(forestId: ForestId): Tree[] {
    this.#assertOpen();
    assertNonEmptyString(forestId, "forest id");
    const rows = this.#db!
      .prepare("SELECT id, forest_id, created_at FROM trees WHERE forest_id = ? ORDER BY created_at, rowid")
      .all(forestId) as unknown as TreeRow[];
    return rows.map(rowToTree);
  }

  /* ------------------------------ Branch ------------------------------ */

  /**
   * 创建分支。`parentBranchId` 缺省/null = 根分支；给出时必须属于同一 Tree
   * 且不得是自身（双分支场景：从既有分支派生第二分支时指向来源分支）。
   */
  createBranch(treeId: TreeId, input?: CreateBranchInput): Branch {
    this.#assertOpen();
    assertNonEmptyString(treeId, "tree id");
    const tree = this.findTree(treeId);
    if (tree === null) throw new EntityNotFoundError("tree", treeId);
    const parentBranchId = input?.parentBranchId ?? null;
    if (parentBranchId !== null) {
      assertNonEmptyString(parentBranchId, "parent branch id");
      const parent = this.findBranch(parentBranchId);
      if (parent === null) throw new EntityNotFoundError("branch", parentBranchId);
      if (parent.treeId !== treeId) {
        throw new InvalidArgumentError(
          `parent branch ${parentBranchId} belongs to tree ${parent.treeId}, not ${treeId}`,
        );
      }
    }
    const id = input?.id ?? (this.#newId("branch") as BranchId);
    assertNonEmptyString(id, "branch id");
    if (id === parentBranchId) {
      throw new InvalidArgumentError(`branch ${id} cannot be its own parent`);
    }
    const createdAt = this.now();
    try {
      this.#db!
        .prepare("INSERT INTO branches (id, tree_id, parent_branch_id, created_at) VALUES (?, ?, ?, ?)")
        .run(id, treeId, parentBranchId, createdAt);
    } catch (error) {
      throw mapSqliteError(error, "creating branch");
    }
    return { id, treeId, parentBranchId, createdAt };
  }

  getBranch(id: BranchId): Branch {
    const found = this.findBranch(id);
    if (found === null) throw new EntityNotFoundError("branch", id);
    return found;
  }

  findBranch(id: BranchId): Branch | null {
    this.#assertOpen();
    assertNonEmptyString(id, "branch id");
    const row = this.#db!
      .prepare("SELECT id, tree_id, parent_branch_id, created_at FROM branches WHERE id = ?")
      .get(id) as BranchRow | undefined;
    return row ? rowToBranch(row) : null;
  }

  listBranches(treeId: TreeId): Branch[] {
    this.#assertOpen();
    assertNonEmptyString(treeId, "tree id");
    const rows = this.#db!
      .prepare(
        "SELECT id, tree_id, parent_branch_id, created_at FROM branches WHERE tree_id = ? ORDER BY created_at, rowid",
      )
      .all(treeId) as unknown as BranchRow[];
    return rows.map(rowToBranch);
  }

  /* ------------------------------ Episode ------------------------------ */

  createEpisode(branchId: BranchId, input?: { id?: EpisodeId }): Episode {
    this.#assertOpen();
    assertNonEmptyString(branchId, "branch id");
    const branch = this.findBranch(branchId);
    if (branch === null) throw new EntityNotFoundError("branch", branchId);
    const id = input?.id ?? (this.#newId("episode") as EpisodeId);
    assertNonEmptyString(id, "episode id");
    const createdAt = this.now();
    try {
      this.#db!.prepare("INSERT INTO episodes (id, branch_id, created_at) VALUES (?, ?, ?)").run(
        id,
        branchId,
        createdAt,
      );
    } catch (error) {
      throw mapSqliteError(error, "creating episode");
    }
    return { id, branchId, createdAt };
  }

  getEpisode(id: EpisodeId): Episode {
    const found = this.findEpisode(id);
    if (found === null) throw new EntityNotFoundError("episode", id);
    return found;
  }

  findEpisode(id: EpisodeId): Episode | null {
    this.#assertOpen();
    assertNonEmptyString(id, "episode id");
    const row = this.#db!.prepare("SELECT id, branch_id, created_at FROM episodes WHERE id = ?").get(id) as
      | EpisodeRow
      | undefined;
    return row ? rowToEpisode(row) : null;
  }

  listEpisodes(branchId: BranchId): Episode[] {
    this.#assertOpen();
    assertNonEmptyString(branchId, "branch id");
    const rows = this.#db!
      .prepare("SELECT id, branch_id, created_at FROM episodes WHERE branch_id = ? ORDER BY created_at, rowid")
      .all(branchId) as unknown as EpisodeRow[];
    return rows.map(rowToEpisode);
  }

  /* ------------------------------ Run ------------------------------ */

  /** 创建 Run（初始态 `queued`，contracts run-state I1）并保存其 session 引用。 */
  createRun(episodeId: EpisodeId, session: SessionReference, input?: { id?: RunId }): Run {
    this.#assertOpen();
    assertNonEmptyString(episodeId, "episode id");
    const episode = this.findEpisode(episodeId);
    if (episode === null) throw new EntityNotFoundError("episode", episodeId);
    assertValidSessionReference(session, "session reference");
    const id = input?.id ?? (this.#newId("run") as RunId);
    assertNonEmptyString(id, "run id");
    const createdAt = this.now();
    const availability = availabilityToColumns(session.availability);

    const insert = (): void => {
      try {
        this.#db!
          .prepare(
            `INSERT INTO runs (id, episode_id, state, created_at, terminal_at, terminal_state, failure_json)
             VALUES (?, ?, 'queued', ?, NULL, NULL, NULL)`,
          )
          .run(id, episodeId, createdAt);
        this.#db!
          .prepare(
            `INSERT INTO session_references
               (run_id, session_id, session_file, entry_id, pi_version,
                availability_status, availability_reason, availability_detail, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            session.sessionId,
            session.sessionFile,
            session.entryId,
            session.piVersion,
            availability.status,
            availability.reason,
            availability.detail,
            createdAt,
            createdAt,
          );
      } catch (error) {
        throw mapSqliteError(error, "creating run");
      }
    };
    this.transaction(insert);

    const created = this.findRun(id);
    if (created === null) {
      throw new DatabaseCorruptError(`run ${id} not readable after insert (schema integrity violation)`);
    }
    return created;
  }

  getRun(id: RunId): Run {
    const found = this.findRun(id);
    if (found === null) throw new EntityNotFoundError("run", id);
    return found;
  }

  findRun(id: RunId): Run | null {
    this.#assertOpen();
    assertNonEmptyString(id, "run id");
    const runRow = this.#runRow(id);
    if (runRow === undefined) return null;
    return this.#hydrateRun(runRow);
  }

  listRuns(episodeId: EpisodeId): Run[] {
    this.#assertOpen();
    assertNonEmptyString(episodeId, "episode id");
    const rows = this.#db!
      .prepare(
        `SELECT id, episode_id, state, created_at, terminal_at, terminal_state, failure_json
         FROM runs WHERE episode_id = ? ORDER BY created_at, rowid`,
      )
      .all(episodeId) as unknown as RunRow[];
    return rows.map((r) => this.#hydrateRun(r));
  }

  /**
   * 更新 Run 状态。
   *
   * - 迁移合法性对照冻结迁移表（I5/I7）：非法迁移抛 `InvalidRunStateTransitionError`；
   * - 终态互斥（I3）：目标为终态时，若 run 已终态抛 `RunTerminalConflictError`
   *   （跨连接并发下条件 UPDATE 保证恰好一胜）；
   * - `failure` 当且仅当目标态为 `failed`（contracts identifiers.ts Run 不变量）；
   * - 终态写入后该 run 不可再变更（I2 吸收性）。
   */
  updateRunState(runId: RunId, to: RunState, options?: UpdateRunStateOptions): Run {
    this.#assertOpen();
    assertNonEmptyString(runId, "run id");
    const failure = options?.failure;
    if (isTerminalRunState(to)) {
      if (to === "failed") {
        if (failure === undefined) {
          throw new InvalidArgumentError(`transition to 'failed' requires a failure (contracts: failure iff failed)`);
        }
      } else if (failure !== undefined) {
        throw new InvalidArgumentError(`failure must not be provided for terminal state '${to}'`);
      }
    } else if (failure !== undefined) {
      throw new InvalidArgumentError(`failure must not be provided for non-terminal state '${to}'`);
    }

    const updated = this.transaction((): Run => this.#updateRunStateUnchecked(runId, to, failure));
    return updated;
  }

  #updateRunStateUnchecked(runId: RunId, to: RunState, failure: TreeAIError | undefined): Run {
    const db = this.#db!;
    const current = db
      .prepare("SELECT id, episode_id, state, created_at, terminal_at, terminal_state, failure_json FROM runs WHERE id = ?")
      .get(runId) as RunRow | undefined;
    if (current === undefined) throw new EntityNotFoundError("run", runId);
    if (current.terminal_state !== null) {
      throw new RunTerminalConflictError(runId, current.terminal_state);
    }
    if (!isAllowedRunTransition(current.state as RunState, to)) {
      throw new InvalidRunStateTransitionError(runId, current.state, to);
    }

    const terminal = isTerminalRunState(to);
    const terminalAt = terminal ? this.now() : null;
    const failureJson = to === "failed" && failure !== undefined ? encodeFailure(failure) : null;

    const result = db
      .prepare(
        `UPDATE runs
         SET state = ?, terminal_at = ?, terminal_state = ?, failure_json = ?
         WHERE id = ? AND terminal_state IS NULL AND state = ?`,
      )
      .run(to, terminalAt, terminal ? to : null, failureJson, runId, current.state);
    if (Number(result.changes) === 0) {
      // 并发竞争：另一写入方已改变该 run。重新读取判定冲突种类。
      const after = db
        .prepare(
          "SELECT id, episode_id, state, created_at, terminal_at, terminal_state, failure_json FROM runs WHERE id = ?",
        )
        .get(runId) as RunRow | undefined;
      if (after === undefined) throw new EntityNotFoundError("run", runId);
      if (after.terminal_state !== null) {
        throw new RunTerminalConflictError(runId, after.terminal_state);
      }
      throw new InvalidRunStateTransitionError(runId, after.state, to);
    }

    const updated = this.findRun(runId);
    if (updated === null) {
      throw new DatabaseCorruptError(`run ${runId} not readable after update (schema integrity violation)`);
    }
    return updated;
  }

  /** 全部非终态 run（重启恢复 I6 清扫的输入）。 */
  listNonTerminalRuns(): Run[] {
    this.#assertOpen();
    const rows = this.#db!
      .prepare(
        `SELECT id, episode_id, state, created_at, terminal_at, terminal_state, failure_json
         FROM runs WHERE terminal_state IS NULL ORDER BY created_at, rowid`,
      )
      .all() as unknown as RunRow[];
    return rows.map((r) => this.#hydrateRun(r));
  }

  /**
   * I6 重启恢复清扫：把所有非终态（queued/running/aborting）run 置为
   * `failed` 并记录 failure（宿主崩溃语义：code "unknown" + 建议携带
   * `{ hostInterrupted: true }`——由调用方构造）。返回被收敛的 run。
   * 已终态的 run 不受影响（条件 UPDATE 保证）。
   */
  failNonTerminalRuns(failure: TreeAIError): Run[] {
    this.#assertOpen();
    return this.transaction((): Run[] => {
      const before = this.listNonTerminalRuns();
      if (before.length === 0) return [];
      const terminalAt = this.now();
      const failureJson = encodeFailure(failure);
      this.#db!
        .prepare(
          `UPDATE runs
           SET state = 'failed', terminal_at = ?, terminal_state = 'failed', failure_json = ?
           WHERE terminal_state IS NULL`,
        )
        .run(terminalAt, failureJson);
      return before.map((r) => this.getRun(r.id));
    });
  }

  /* ------------------------------ SessionReference ------------------------------ */

  /**
   * 更新 run 的 session 引用（prompt/navigateTree 之后 entryId 前进；
   * contracts：以新引用更新，不就地修改——本方法整体替换）。
   */
  updateRunSessionReference(runId: RunId, reference: SessionReference): void {
    this.#assertOpen();
    assertNonEmptyString(runId, "run id");
    assertValidSessionReference(reference, "session reference");
    const existing = this.#runRow(runId);
    if (existing === undefined) throw new EntityNotFoundError("run", runId);
    const availability = availabilityToColumns(reference.availability);
    const updated = this.now();
    const result = this.#db!
      .prepare(
        `UPDATE session_references
         SET session_id = ?, session_file = ?, entry_id = ?, pi_version = ?,
             availability_status = ?, availability_reason = ?, availability_detail = ?, updated_at = ?
         WHERE run_id = ?`,
      )
      .run(
        reference.sessionId,
        reference.sessionFile,
        reference.entryId,
        reference.piVersion,
        availability.status,
        availability.reason,
        availability.detail,
        updated,
        runId,
      );
    if (Number(result.changes) === 0) {
      throw new DatabaseCorruptError(
        `session reference row missing for run ${runId} (schema integrity violation)`,
      );
    }
  }

  /** 更新单个 run 的 availability（缓存评估；运行时恢复时自行实时校验）。 */
  updateSessionAvailability(runId: RunId, availability: SessionAvailability): void {
    this.#assertOpen();
    assertNonEmptyString(runId, "run id");
    const existing = this.#runRow(runId);
    if (existing === undefined) throw new EntityNotFoundError("run", runId);
    const columns = availabilityToColumns(availability);
    const updated = this.now();
    const result = this.#db!
      .prepare(
        `UPDATE session_references
         SET availability_status = ?, availability_reason = ?, availability_detail = ?, updated_at = ?
         WHERE run_id = ?`,
      )
      .run(columns.status, columns.reason, columns.detail, updated, runId);
    if (Number(result.changes) === 0) {
      throw new DatabaseCorruptError(
        `session reference row missing for run ${runId} (schema integrity violation)`,
      );
    }
  }

  /**
   * 按 session 文件批量更新 availability。
   * `exists=false` → 全部指向该文件的引用标记 `unavailable/missing-file`
   * （域数据不受影响——不级联删除）；`exists=true` → 恢复为 available。
   * 返回更新的引用行数。
   */
  markSessionFileAvailability(sessionFile: string, exists: boolean): number {
    this.#assertOpen();
    assertNonEmptyString(sessionFile, "session file");
    const updated = this.now();
    const result = exists
      ? this.#db!
          .prepare(
            `UPDATE session_references
             SET availability_status = 'available', availability_reason = NULL, availability_detail = NULL,
                 updated_at = ?
             WHERE session_file = ?`,
          )
          .run(updated, sessionFile)
      : this.#db!
          .prepare(
            `UPDATE session_references
             SET availability_status = 'unavailable', availability_reason = 'missing-file',
                 availability_detail = ?, updated_at = ?
             WHERE session_file = ?`,
          )
          .run(MISSING_FILE_DETAIL, updated, sessionFile);
    return Number(result.changes);
  }

  /**
   * 扫描全部去重 session 文件并刷新 availability。
   * `exists` 探针由调用方注入（默认 `fs.existsSync`——仅存在性检查，
   * **不读取 Pi session 内容**）。返回每个文件更新的引用数。
   */
  refreshSessionAvailability(
    exists: (sessionFile: string) => boolean = (f) => existsSync(f),
  ): SessionFileSweepResult[] {
    this.#assertOpen();
    const files = this.#db!.prepare("SELECT DISTINCT session_file FROM session_references").all() as unknown as Array<{
      session_file: string;
    }>;
    const results: SessionFileSweepResult[] = [];
    for (const row of files) {
      const file = row.session_file;
      const updated = this.markSessionFileAvailability(file, exists(file));
      results.push({ sessionFile: file, updatedReferences: updated });
    }
    return results;
  }

  /** 指向给定 session 文件的全部引用（含 run id）。 */
  getSessionReferencesByFile(sessionFile: string): Array<{ runId: RunId; reference: SessionReference }> {
    this.#assertOpen();
    assertNonEmptyString(sessionFile, "session file");
    const rows = this.#db!
      .prepare("SELECT * FROM session_references WHERE session_file = ? ORDER BY created_at, rowid")
      .all(sessionFile) as unknown as SessionReferenceRow[];
    return rows.map((row) => ({ runId: row.run_id as RunId, reference: rowToSessionReference(row) }));
  }

  /* --------------------- D3 产品层：Turn（turns 表） --------------------- */

  /**
   * 创建 Turn（contracts product.ts 不变量的仓储层防御；
   * schema CHECK 为第二层）。分支/回合/Run 的存在性与归属先显式校验，
   * 给出可定位的错误而非裸外键失败。
   */
  createTurn(input: CreateTurnInput): Turn {
    this.#assertOpen();
    assertNonEmptyString(input.treeId, "tree id");
    assertNonEmptyString(input.branchId, "branch id");
    assertNonEmptyString(input.episodeId, "episode id");
    if (typeof input.text !== "string" || (input.role !== "assistant" && input.text.trim().length === 0)) {
      throw new InvalidArgumentError(`turn text must be a non-empty string for role '${input.role}'`);
    }
    if (!TURN_ROLES.includes(input.role)) {
      throw new InvalidArgumentError(`turn role must be one of {${TURN_ROLES.join(", ")}}`);
    }
    const branch = this.findBranch(input.branchId);
    if (branch === null) throw new EntityNotFoundError("branch", input.branchId);
    if (branch.treeId !== input.treeId) {
      throw new InvalidArgumentError(
        `branch ${input.branchId} belongs to tree ${branch.treeId}, not ${input.treeId}`,
      );
    }
    const episode = this.findEpisode(input.episodeId);
    if (episode === null) throw new EntityNotFoundError("episode", input.episodeId);
    if (episode.branchId !== input.branchId) {
      throw new InvalidArgumentError(
        `episode ${input.episodeId} belongs to branch ${episode.branchId}, not ${input.branchId}`,
      );
    }
    const runId = input.runId ?? null;
    const fromBranchId = input.fromBranchId ?? null;
    const piEntryId = input.piEntryId ?? null;
    const idempotencyKey = input.idempotencyKey ?? null;
    const targetAnchor = input.targetAnchor ?? null;
    if (input.role === "return") {
      if (runId !== null) {
        throw new InvalidArgumentError("a return turn must not reference a run (returns are not model-executed)");
      }
      if (fromBranchId === null) {
        throw new InvalidArgumentError("a return turn requires fromBranchId (its originating branch)");
      }
      if (piEntryId !== null) {
        throw new InvalidArgumentError("a return turn carries no Pi entry anchor");
      }
      if (idempotencyKey !== null) {
        assertNonEmptyString(idempotencyKey, "idempotency key");
      }
      if (targetAnchor !== null) {
        assertValidTargetAnchor(targetAnchor);
      }
    } else {
      if (runId === null) {
        throw new InvalidArgumentError(`a '${input.role}' turn requires runId`);
      }
      if (fromBranchId !== null) {
        throw new InvalidArgumentError("fromBranchId is only valid for return turns");
      }
      if (idempotencyKey !== null) {
        throw new InvalidArgumentError("idempotencyKey is only valid for return turns");
      }
      if (targetAnchor !== null) {
        throw new InvalidArgumentError("targetAnchor is only valid for return turns");
      }
      if (this.findRun(runId) === null) throw new EntityNotFoundError("run", runId);
    }
    if (fromBranchId !== null && this.findBranch(fromBranchId) === null) {
      throw new EntityNotFoundError("branch", fromBranchId);
    }
    const id = input.id ?? (this.#newId("turn") as TurnId);
    assertNonEmptyString(id, "turn id");
    const createdAt = this.now();
    try {
      this.#db!
        .prepare(
          `INSERT INTO turns
             (id, tree_id, branch_id, episode_id, run_id, role, text, pi_entry_id, from_branch_id,
              delivered_run_id, idempotency_key, target_anchor, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        )
        .run(
          id,
          input.treeId,
          input.branchId,
          input.episodeId,
          runId,
          input.role,
          input.text,
          piEntryId,
          fromBranchId,
          idempotencyKey,
          encodeTargetAnchor(targetAnchor),
          createdAt,
        );
    } catch (error) {
      throw mapSqliteError(error, "creating turn");
    }
    return this.getTurn(id);
  }

  getTurn(id: TurnId): Turn {
    const found = this.findTurn(id);
    if (found === null) throw new EntityNotFoundError("turn", id);
    return found;
  }

  findTurn(id: TurnId): Turn | null {
    this.#assertOpen();
    assertNonEmptyString(id, "turn id");
    const row = this.#db!
      .prepare(
        `SELECT id, tree_id, branch_id, episode_id, run_id, role, text, pi_entry_id, from_branch_id,
                delivered_run_id, idempotency_key, target_anchor, created_at
         FROM turns WHERE id = ?`,
      )
      .get(id) as TurnRow | undefined;
    return row ? rowToTurn(row) : null;
  }

  /** 分支上的全部 Turn，按追加序（created_at, rowid）。 */
  listTurns(branchId: BranchId): Turn[] {
    this.#assertOpen();
    assertNonEmptyString(branchId, "branch id");
    const rows = this.#db!
      .prepare(
        `SELECT id, tree_id, branch_id, episode_id, run_id, role, text, pi_entry_id, from_branch_id,
                delivered_run_id, idempotency_key, target_anchor, created_at
         FROM turns WHERE branch_id = ? ORDER BY created_at, rowid`,
      )
      .all(branchId) as unknown as TurnRow[];
    return rows.map(rowToTurn);
  }

  /**
   * 按幂等键查找 return turn（树内定位；无键/无匹配为 null）。
   * 同键唯一由树内部分唯一索引保证（idx_turns_idempotency_key_tree，
   * UNIQUE(tree_id, idempotency_key)——已签署 W1 v3.0 §3.4：幂等键是
   * Tree 内命名空间，跨 Tree 同键各自有效），本查询是幂等重放与并发
   * 竞争后对齐的读取路径。
   */
  findReturnByIdempotencyKey(treeId: TreeId, idempotencyKey: string): Turn | null {
    this.#assertOpen();
    assertNonEmptyString(treeId, "tree id");
    assertNonEmptyString(idempotencyKey, "idempotency key");
    const row = this.#db!
      .prepare(
        `SELECT id, tree_id, branch_id, episode_id, run_id, role, text, pi_entry_id, from_branch_id,
                delivered_run_id, idempotency_key, target_anchor, created_at
         FROM turns WHERE tree_id = ? AND idempotency_key = ? AND role = 'return'`,
      )
      .get(treeId, idempotencyKey) as TurnRow | undefined;
    return row ? rowToTurn(row) : null;
  }

  /* --------------------- D3 产品层：BranchOrigin（branch_origins 表） --------------------- */

  /**
   * 设置分支出处锚点。锚点完整性（选区切片一致、anchorEntryId 与
   * anchor turn 的 piEntryId 相等）在此校验；每分支至多一条。
   */
  setBranchOrigin(input: SetBranchOriginInput): BranchOrigin {
    this.#assertOpen();
    assertNonEmptyString(input.branchId, "branch id");
    assertNonEmptyString(input.sourceBranchId, "source branch id");
    assertNonEmptyString(input.anchorTurnId, "anchor turn id");
    assertNonEmptyString(input.anchorEntryId, "anchor entry id");
    const branch = this.findBranch(input.branchId);
    if (branch === null) throw new EntityNotFoundError("branch", input.branchId);
    const source = this.findBranch(input.sourceBranchId);
    if (source === null) throw new EntityNotFoundError("branch", input.sourceBranchId);
    if (source.treeId !== branch.treeId) {
      throw new InvalidArgumentError(
        `source branch ${input.sourceBranchId} belongs to tree ${source.treeId}, not ${branch.treeId}`,
      );
    }
    if (source.id === branch.id) {
      throw new InvalidArgumentError(`branch ${input.branchId} cannot anchor to itself`);
    }
    const anchorTurn = this.findTurn(input.anchorTurnId);
    if (anchorTurn === null) throw new EntityNotFoundError("turn", input.anchorTurnId);
    if (anchorTurn.branchId !== input.sourceBranchId) {
      throw new InvalidArgumentError(
        `anchor turn ${input.anchorTurnId} belongs to branch ${anchorTurn.branchId}, not source branch ${input.sourceBranchId}`,
      );
    }
    if (anchorTurn.role !== "assistant") {
      throw new InvalidArgumentError("branch anchors must reference an assistant turn (an answer)");
    }
    if (anchorTurn.piEntryId === null) {
      throw new InvalidArgumentError(`anchor turn ${input.anchorTurnId} has no Pi entry id`);
    }
    if (anchorTurn.piEntryId !== input.anchorEntryId) {
      throw new InvalidArgumentError("anchorEntryId must equal the anchor turn's piEntryId");
    }
    const selection = input.selection;
    if (
      typeof selection !== "object" ||
      selection === null ||
      !Number.isInteger(selection.start) ||
      !Number.isInteger(selection.end) ||
      selection.start < 0 ||
      selection.end < selection.start ||
      selection.end > anchorTurn.text.length
    ) {
      throw new InvalidArgumentError(
        `selection [${String(selection?.start)}, ${String(selection?.end)}) is out of bounds for the anchor answer (${anchorTurn.text.length} chars)`,
      );
    }
    if (anchorTurn.text.slice(selection.start, selection.end) !== selection.text) {
      throw new InvalidArgumentError(
        "selection text does not match the anchor answer at the given offsets (anchor integrity violation)",
      );
    }
    if (this.findBranchOrigin(input.branchId) !== null) {
      throw new InvalidArgumentError(`branch ${input.branchId} already has an origin`);
    }
    const createdAt = this.now();
    try {
      this.#db!
        .prepare(
          `INSERT INTO branch_origins
             (branch_id, source_branch_id, anchor_turn_id, anchor_entry_id, sel_start, sel_end, sel_text, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.branchId,
          input.sourceBranchId,
          input.anchorTurnId,
          input.anchorEntryId,
          selection.start,
          selection.end,
          selection.text,
          createdAt,
        );
    } catch (error) {
      throw mapSqliteError(error, "setting branch origin");
    }
    return this.getBranchOrigin(input.branchId);
  }

  getBranchOrigin(branchId: BranchId): BranchOrigin {
    const found = this.findBranchOrigin(branchId);
    if (found === null) throw new EntityNotFoundError("branch origin", branchId);
    return found;
  }

  findBranchOrigin(branchId: BranchId): BranchOrigin | null {
    this.#assertOpen();
    assertNonEmptyString(branchId, "branch id");
    const row = this.#db!
      .prepare(
        `SELECT branch_id, source_branch_id, anchor_turn_id, anchor_entry_id, sel_start, sel_end, sel_text, created_at
         FROM branch_origins WHERE branch_id = ?`,
      )
      .get(branchId) as BranchOriginRow | undefined;
    return row ? rowToBranchOrigin(row) : null;
  }

  /**
   * 标记 return turn 已由某次主干 Run 成功采用（deliveredRunId 只记录
   * **首次成功采用**的 Run——条件 UPDATE 保证至多写一次；不可二次送达，
   * 成功之后的 Run 不再重复注入）。采用尝试的完整历史（含失败/中止的
   * Run）由 return_adoption_attempts 记录，与本标记互补。
   */
  markReturnDelivered(turnId: TurnId, runId: RunId): void {
    this.#assertOpen();
    assertNonEmptyString(turnId, "turn id");
    assertNonEmptyString(runId, "run id");
    const turn = this.findTurn(turnId);
    if (turn === null) throw new EntityNotFoundError("turn", turnId);
    if (turn.role !== "return") {
      throw new InvalidArgumentError(`turn ${turnId} is not a return`);
    }
    if (this.findRun(runId) === null) throw new EntityNotFoundError("run", runId);
    const result = this.#db!
      .prepare(
        `UPDATE turns SET delivered_run_id = ? WHERE id = ? AND delivered_run_id IS NULL AND role = 'return'`,
      )
      .run(runId, turnId);
    if (Number(result.changes) === 0) {
      if (turn.deliveredRunId !== null) {
        throw new InvalidArgumentError(
          `return ${turnId} was already delivered by run ${turn.deliveredRunId}`,
        );
      }
      throw new DatabaseCorruptError(`turn ${turnId} not updatable (schema integrity violation)`);
    }
  }

  /* --------------------- D3 产品层：Return 采用尝试（return_adoption_attempts 表） --------------------- */

  /**
   * 记录一次 Return 采用尝试：组装该 Return 的主干 Run 与它的关联
   * （已签署 W1 v3.0 §3.2——Run 的确定输入已包含该 Return 即为一次尝试，
   * 与该 Run 最终 succeeded/failed/aborted 无关；Run 结果由 runs 行记录）。
   * 复合主键 (return_turn_id, run_id)：同一 Return 在同一 Run 至多一条；
   * 重复记录（编程错误）以 ConstraintViolationError 拒绝，不静默去重。
   */
  recordReturnAdoptionAttempt(turnId: TurnId, runId: RunId): void {
    this.#assertOpen();
    assertNonEmptyString(turnId, "turn id");
    assertNonEmptyString(runId, "run id");
    const turn = this.findTurn(turnId);
    if (turn === null) throw new EntityNotFoundError("turn", turnId);
    if (turn.role !== "return") {
      throw new InvalidArgumentError(`turn ${turnId} is not a return`);
    }
    if (this.findRun(runId) === null) throw new EntityNotFoundError("run", runId);
    const attemptedAt = this.now();
    try {
      this.#db!
        .prepare(
          "INSERT INTO return_adoption_attempts (return_turn_id, run_id, attempted_at) VALUES (?, ?, ?)",
        )
        .run(turnId, runId, attemptedAt);
    } catch (error) {
      throw mapSqliteError(error, "recording return adoption attempt");
    }
  }

  /** 某 return turn 的全部采用尝试（追加序；Run 结果经 runId 关联 runs 读取）。 */
  listReturnAdoptionAttempts(turnId: TurnId): ReturnAdoptionAttempt[] {
    this.#assertOpen();
    assertNonEmptyString(turnId, "turn id");
    const rows = this.#db!
      .prepare(
        `SELECT return_turn_id, run_id, attempted_at
         FROM return_adoption_attempts WHERE return_turn_id = ? ORDER BY attempted_at, rowid`,
      )
      .all(turnId) as unknown as ReturnAdoptionAttemptRow[];
    return rows.map(rowToReturnAdoptionAttempt);
  }

  saveActiveNavigation(treeId: TreeId, branchId: BranchId, reference: SessionReference): ActiveNavigation {
    this.#assertOpen();
    assertNonEmptyString(treeId, "tree id");
    assertNonEmptyString(branchId, "branch id");
    assertValidSessionReference(reference, "active navigation reference");
    const tree = this.findTree(treeId);
    if (tree === null) throw new EntityNotFoundError("tree", treeId);
    const branch = this.findBranch(branchId);
    if (branch === null) throw new EntityNotFoundError("branch", branchId);
    if (branch.treeId !== tree.id) {
      throw new InvalidArgumentError(`branch ${branchId} belongs to tree ${branch.treeId}, not ${treeId}`);
    }
    const availability = availabilityToColumns(reference.availability);
    const updatedAt = this.now();
    try {
      this.#db!
        .prepare(
          `INSERT INTO tree_active_navigation
             (tree_id, branch_id, session_id, session_file, entry_id, pi_version,
              availability_status, availability_reason, availability_detail, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(tree_id) DO UPDATE SET
             branch_id = excluded.branch_id,
             session_id = excluded.session_id,
             session_file = excluded.session_file,
             entry_id = excluded.entry_id,
             pi_version = excluded.pi_version,
             availability_status = excluded.availability_status,
             availability_reason = excluded.availability_reason,
             availability_detail = excluded.availability_detail,
             updated_at = excluded.updated_at`,
        )
        .run(
          treeId,
          branchId,
          reference.sessionId,
          reference.sessionFile,
          reference.entryId,
          reference.piVersion,
          availability.status,
          availability.reason,
          availability.detail,
          updatedAt,
        );
    } catch (error) {
      throw mapSqliteError(error, "saving active navigation");
    }
    return this.findActiveNavigation(treeId)!;
  }

  findActiveNavigation(treeId: TreeId): ActiveNavigation | null {
    this.#assertOpen();
    assertNonEmptyString(treeId, "tree id");
    const row = this.#db!
      .prepare(
        `SELECT tree_id, branch_id, session_id, session_file, entry_id, pi_version,
                availability_status, availability_reason, availability_detail, updated_at
         FROM tree_active_navigation WHERE tree_id = ?`,
      )
      .get(treeId) as ActiveNavigationRow | undefined;
    return row ? rowToActiveNavigation(row) : null;
  }

  /* ------------------------------ 恢复查询 ------------------------------ */

  /** 分支恢复信息：树/森林定位、父分支、全部 episode 与 run（含最新 run 的 session 引用与 availability）。 */
  getBranchRecovery(branchId: BranchId): BranchRecovery {
    this.#assertOpen();
    assertNonEmptyString(branchId, "branch id");
    const branch = this.findBranch(branchId);
    if (branch === null) throw new EntityNotFoundError("branch", branchId);
    const tree = this.getTree(branch.treeId);
    const forest = this.getForest(tree.forestId);
    const parent = branch.parentBranchId !== null ? this.findBranch(branch.parentBranchId) : null;

    const episodes = this.listEpisodes(branchId);
    const episodeRecoveries: EpisodeRecovery[] = episodes.map((episode) => {
      const runs = this.listRuns(episode.id);
      return { episode, runs, latestRun: runs.length > 0 ? runs[runs.length - 1]! : null };
    });
    const latestRun =
      episodeRecoveries.length > 0
        ? episodeRecoveries[episodeRecoveries.length - 1]!.latestRun
        : null;
    return { forest, tree, branch, parentBranch: parent, episodes: episodeRecoveries, latestRun };
  }

  /** 树恢复信息：全部分支的恢复信息（Wave 2 双分支恢复场景的输入）。 */
  getTreeRecovery(treeId: TreeId): TreeRecovery {
    this.#assertOpen();
    assertNonEmptyString(treeId, "tree id");
    const tree = this.getTree(treeId);
    const forest = this.getForest(tree.forestId);
    const branches = this.listBranches(treeId);
    const branchRecoveries = branches.map((b) => this.getBranchRecovery(b.id));
    return { forest, tree, branches: branchRecoveries };
  }

  /* ------------------------------ 备份 / 完整性 ------------------------------ */

  /** 在线备份（`VACUUM INTO`，生成自包含快照；不能在事务中调用）。 */
  createBackup(destination: string, options?: CreateBackupOptions): void {
    this.#assertOpen();
    this.#assertNoTransaction("createBackup");
    assertNonEmptyString(destination, "backup destination");
    if (options?.overwrite === true && existsSync(destination)) {
      rmSync(destination);
    }
    vacuumInto(this.#db!, destination);
  }

  /** 校验备份文件（可读、完整、schema 版本不高于当前支持）。 */
  static validateBackup(path: string): BackupValidation {
    return validateDatabaseFile(path);
  }

  /** `PRAGMA integrity_check`。 */
  integrityCheck(): IntegrityReport {
    this.#assertOpen();
    return checkIntegrity(this.#db!);
  }

  /**
   * 从备份恢复：校验备份 →（可选）把当前库另存 → 关闭连接 →
   * 备份覆盖当前库文件 → 重新打开（旧备份版本更低时自动前向迁移）。
   * 内存库不支持（无文件可覆盖）。
   */
  restoreFromBackup(backupPath: string, options?: RestoreOptions): void {
    this.#assertOpen();
    this.#assertNoTransaction("restoreFromBackup");
    assertNonEmptyString(backupPath, "backup path");
    const validation = validateDatabaseFile(backupPath);
    if (!validation.valid) {
      throw new BackupError(
        `backup file is not a valid TreeAI database: ${backupPath} ` +
          `(schema version ${validation.schemaVersion}, integrity ok=${validation.integrity.ok})`,
      );
    }
    if (this.path === ":memory:" || this.path.startsWith("file::memory:")) {
      throw new BackupError("restoreFromBackup is not supported for in-memory repositories");
    }
    if (options?.backupCurrentTo !== undefined) {
      assertNonEmptyString(options.backupCurrentTo, "backupCurrentTo");
      vacuumInto(this.#db!, options.backupCurrentTo);
    }

    this.close();
    try {
      copyFileSync(backupPath, this.path);
      // 移除旧 WAL/SHM 侧车文件，防止陈旧 WAL 与新主文件组合。
      rmSync(`${this.path}-wal`, { force: true });
      rmSync(`${this.path}-shm`, { force: true });
    } catch (error) {
      throw new BackupError(`failed to copy backup '${backupPath}' over '${this.path}'`, { cause: error });
    }
    const reopened = openDatabase({ path: this.path, busyTimeoutMs: this.#busyTimeoutMs });
    this.#db = reopened.db;
  }

  /* ------------------------------ 内部读取辅助 ------------------------------ */

  #runRow(runId: string): RunRow | undefined {
    return this.#db!.prepare(
      "SELECT id, episode_id, state, created_at, terminal_at, terminal_state, failure_json FROM runs WHERE id = ?",
    ).get(runId) as RunRow | undefined;
  }

  #sessionRow(runId: string): SessionReferenceRow | undefined {
    return this.#db!.prepare("SELECT * FROM session_references WHERE run_id = ?").get(runId) as
      | SessionReferenceRow
      | undefined;
  }

  #hydrateRun(runRow: RunRow): Run {
    return rowToRun(runRow, this.#sessionRow(runRow.id));
  }
}
