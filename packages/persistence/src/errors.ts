/**
 * persistence 专属错误分类。
 *
 * 定位说明（相对 `@treeai/contracts` 的 `TreeAIError`）：
 * - `TreeAIError` 按其冻结语义表达 **Run 运行期失败**（模型、凭据、中止、上游等），
 *   且规定 `cause` 持久化前必须脱敏；
 * - 本模块的错误是 **宿主侧基础设施/数据完整性失败**（数据库损坏、迁移失败、
 *   约束冲突、状态机违规等），不混入运行期失败分类。
 * 将 persistence 错误映射为 `TreeAIError`（如 code `unknown`）是调用方
 * （runtime-smoke / event-journal）的职责，本包不做隐式映射。
 *
 * 约定：
 * - 所有错误 message 均为脱敏的人类可读文本：不含凭据、token、
 *   文件正文；可包含调用方提供的标识符与数据库路径（路径由调用方
 *   选择，通常是相对路径或专用目录）。
 * - `cause` 保留原始错误对象（如 SQLite 驱动错误）用于诊断，
 *   不将其文本并入 message（驱动 message 可能携带表名等内部细节，
 *   并入时逐条评估）。
 */

/** persistence 错误编码（封闭集合）。 */
export type PersistenceErrorCode =
  /** 数据库文件损坏、不是 SQLite 数据库、schema 状态无法辨认。 */
  | "database-corrupt"
  /** 数据库由更新版本的 TreeAI 写入，当前代码无法安全打开。 */
  | "unsupported-database-version"
  /** migration 执行失败（已回滚该条 migration）。 */
  | "migration-failed"
  /** 备份创建/校验/恢复失败。 */
  | "backup-failed"
  /** 实体不存在（按 id 查询/引用）。 */
  | "not-found"
  /** Run 状态迁移违反冻结状态机（contracts run-state.ts I5/I7）。 */
  | "invalid-transition"
  /** Run 已处于终态，拒绝再次写入另一终态（contracts run-state.ts I3）。 */
  | "terminal-conflict"
  /** 数据库约束冲突（外键、唯一、CHECK）。 */
  | "constraint-violation"
  /** 调用方传入的参数/数据无效。 */
  | "invalid-argument"
  /** 仓库已关闭（或底层连接不可用）。 */
  | "closed"
  /** SQLite 驱动抛出的未归类错误（cause 保留原始错误）。 */
  | "sqlite-error";

/** persistence 错误基类。 */
export class PersistenceError extends Error {
  readonly code: PersistenceErrorCode;

  constructor(code: PersistenceErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PersistenceError";
    this.code = code;
  }
}

/** 数据库文件损坏 / 不是 SQLite 数据库 / schema 状态无法辨认。 */
export class DatabaseCorruptError extends PersistenceError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("database-corrupt", message, options);
    this.name = "DatabaseCorruptError";
  }
}

/** 数据库由更新版本的 TreeAI 写入。 */
export class UnsupportedDatabaseVersionError extends PersistenceError {
  /** 数据库实际报告的 schema 版本（若可得，否则 -1）。 */
  readonly databaseSchemaVersion: number;
  /** 当前代码支持的最高 schema 版本。 */
  readonly maxSupportedVersion: number;

  constructor(
    message: string,
    databaseSchemaVersion: number,
    maxSupportedVersion: number,
    options?: { cause?: unknown },
  ) {
    super("unsupported-database-version", message, options);
    this.name = "UnsupportedDatabaseVersionError";
    this.databaseSchemaVersion = databaseSchemaVersion;
    this.maxSupportedVersion = maxSupportedVersion;
  }
}

/** migration 执行失败；该条 migration 已整体回滚，库保持其前一版本。 */
export class MigrationFailedError extends PersistenceError {
  /** 失败的 migration 版本号。 */
  readonly version: number;
  /** 失败的 migration 名称。 */
  readonly migrationName: string;

  constructor(
    message: string,
    version: number,
    migrationName: string,
    options?: { cause?: unknown },
  ) {
    super("migration-failed", message, options);
    this.name = "MigrationFailedError";
    this.version = version;
    this.migrationName = migrationName;
  }
}

/** 备份创建/校验/恢复失败。 */
export class BackupError extends PersistenceError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("backup-failed", message, options);
    this.name = "BackupError";
  }
}

/** 实体不存在。 */
export class EntityNotFoundError extends PersistenceError {
  /** 实体种类（"forest" / "tree" / "branch" / "episode" / "run"）。 */
  readonly entity: string;
  /** 未找到的 id。 */
  readonly id: string;

  constructor(entity: string, id: string) {
    super("not-found", `${entity} not found: ${id}`);
    this.name = "EntityNotFoundError";
    this.entity = entity;
    this.id = id;
  }
}

/** Run 状态迁移非法（对照 contracts 冻结迁移表）。 */
export class InvalidRunStateTransitionError extends PersistenceError {
  readonly runId: string;
  readonly fromState: string;
  readonly toState: string;

  constructor(runId: string, fromState: string, toState: string) {
    super(
      "invalid-transition",
      `illegal run state transition for run ${runId}: ${fromState} -> ${toState} ` +
        `(allowed from ${fromState}: see frozen RunStateTransitions)`,
    );
    this.name = "InvalidRunStateTransitionError";
    this.runId = runId;
    this.fromState = fromState;
    this.toState = toState;
  }
}

/**
 * Run 已终态，拒绝再次进入（另一）终态。
 * 对应 contracts run-state.ts I3（单终态）：一个 Run 至多进入一个终态，
 * 并发下也不得产生双终态。
 */
export class RunTerminalConflictError extends PersistenceError {
  readonly runId: string;
  /** 冲突时 run 已处于的终态。 */
  readonly currentTerminalState: string;

  constructor(runId: string, currentTerminalState: string) {
    super(
      "terminal-conflict",
      `run ${runId} is already in terminal state '${currentTerminalState}'; ` +
        `a run may enter at most one terminal state (contracts run-state I3)`,
    );
    this.name = "RunTerminalConflictError";
    this.runId = runId;
    this.currentTerminalState = currentTerminalState;
  }
}

/** 数据库约束冲突（外键、唯一、CHECK）。 */
export class ConstraintViolationError extends PersistenceError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("constraint-violation", message, options);
    this.name = "ConstraintViolationError";
  }
}

/** 调用方参数无效。 */
export class InvalidArgumentError extends PersistenceError {
  constructor(message: string) {
    super("invalid-argument", message);
    this.name = "InvalidArgumentError";
  }
}

/** 仓库已关闭。 */
export class RepositoryClosedError extends PersistenceError {
  constructor() {
    super("closed", "TreeRepository is closed");
    this.name = "RepositoryClosedError";
  }
}

/**
 * 将 SQLite 驱动错误映射为 persistence 错误。
 * 未识别的驱动错误包装为 `PersistenceError`（code `sqlite-error`），cause 保留原错误。
 */
export function mapSqliteError(error: unknown, context: string): PersistenceError {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("FOREIGN KEY constraint failed")) {
    return new ConstraintViolationError(`${context}: foreign key constraint failed`, {
      cause: error,
    });
  }
  if (message.includes("UNIQUE constraint failed")) {
    return new ConstraintViolationError(`${context}: unique constraint failed`, { cause: error });
  }
  if (message.includes("CHECK constraint failed")) {
    return new ConstraintViolationError(`${context}: check constraint failed`, { cause: error });
  }
  if (message.includes("file is not a database") || message.includes("database disk image is malformed")) {
    return new DatabaseCorruptError(`${context}: file is not a valid SQLite database`, {
      cause: error,
    });
  }
  if (message.includes("output file already exists")) {
    return new BackupError(`${context}: backup target already exists`, { cause: error });
  }
  return new PersistenceError("sqlite-error", `${context}: ${message}`, { cause: error });
}
