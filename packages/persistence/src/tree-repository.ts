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
/** Stable public repository entrypoint. */
export {
  NAV_EXPAND_STATE_MAX_BRANCHES,
} from "./tree/policy.ts";
export type {
  TreeRepositoryOptions,
  CreateBranchInput,
  UpdateRunStateOptions,
  CreateTurnInput,
  CreateTerminologyAnnotationInput,
  CreateTerminologyDispatchInput,
  SettleTerminologyDispatchInput,
  SetBranchOriginInput,
  ActiveNavigation,
  ReturnAdoptionAttempt,
  EpisodeRecovery,
  BranchRecovery,
  TreeRecovery,
  CreateBackupOptions,
  RestoreOptions,
  SessionFileSweepResult,
} from "./tree/model.ts";
export {
  TreeRepository,
} from "./tree/repository.ts";
