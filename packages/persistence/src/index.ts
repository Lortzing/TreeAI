/**
 * @treeai/persistence —— TreeAI 自有数据库（SQLite）持久化包。
 *
 * 内容：Forest/Tree/Branch/Episode/Run/SessionReference 的 schema、
 * 版本化 migration、事务边界与 `TreeRepository` 仓储。
 *
 * 边界（ADR-001 §4）：
 * - TreeAI DB 是产品事实源；不依赖 Pi session 文件存在；
 * - SessionReference 仅保存引用三元组与 Pi 版本，不复制凭据；
 * - 不 import Pi SDK 类型（只 `import type` 消费 `@treeai/contracts`）；
 * - 不读写 Pi session JSONL。
 *
 * 运行时依赖：仅 Node 内置模块（`node:sqlite`，Node 24.21.0 基线；
 * 决策记录见 `coordination/d2/agent-c-dependency-request.md`）。
 */

export {
  TreeRepository,
  type CreateBackupOptions,
  type CreateBranchInput,
  type EpisodeRecovery,
  type BranchRecovery,
  type RestoreOptions,
  type SessionFileSweepResult,
  type TreeRecovery,
  type TreeRepositoryOptions,
  type UpdateRunStateOptions,
} from "./tree-repository.ts";

export {
  MIGRATIONS,
  LATEST_SCHEMA_VERSION,
  runMigrations,
  type Migration,
  type MigrationResult,
} from "./migrations/index.ts";

export {
  checkIntegrity,
  currentSchemaVersion,
  openDatabase,
  openDatabaseReadOnly,
  validateDatabaseFile,
  vacuumInto,
  type BackupValidation,
  type IntegrityReport,
  type OpenDatabaseOptions,
  type OpenedDatabase,
} from "./database.ts";

export {
  BackupError,
  ConstraintViolationError,
  DatabaseCorruptError,
  EntityNotFoundError,
  InvalidArgumentError,
  InvalidRunStateTransitionError,
  mapSqliteError,
  MigrationFailedError,
  PersistenceError,
  RepositoryClosedError,
  RunTerminalConflictError,
  UnsupportedDatabaseVersionError,
  type PersistenceErrorCode,
} from "./errors.ts";
