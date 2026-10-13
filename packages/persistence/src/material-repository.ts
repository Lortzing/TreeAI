/**
 * MaterialRepository：D4 材料层仓储（材料 / 内容寻址原件 / 不可变版本 /
 * 树链接 / 材料来源 / 阅读状态 / 首问幂等 / 材料建枝原子落库，migration
 * 0008；D4-3 增 createMaterialBranch，ADR-004）。
 *
 * 边界（ADR-001 §4、ADR-003 §1）：
 * - TreeAI DB 是产品事实源；本仓储不依赖、不访问 Pi session 文件；
 * - 材料来源永不携带 anchorTurnId/piEntryId（材料没有 Pi 分叉点——
 *   charter §3.2）；Turn 来源（branch_origins）仍归 TreeRepository，
 *   本仓储只经 `getBranchOrigin` 统一读取（ADR-003 §2）。
 *
 * 存储纪律：
 * - 内容寻址：material_blobs 以 content_hash（原件字节 SHA-256）为键，
 *   `storeBlob` 幂等（同字节全局一份）；
 * - 版本不可变：`insertVersion` 以 UNIQUE(material_id, content_hash)
 *   强制——同材料重复导入相同字节**复用既有版本**（返回原行，不重复、
 *   不改写）；内容变化产生新版本，旧摘录/批注/来源锚点不受影响
 *   （charter §3.1）；
 * - 选区纪律（与 branch_origins 的 Turn 来源同一纪律，按材料改写）：
 *   excerpt === canonicalText.slice(start, end)、区间在版本边界内、
 *   blockId 存在于版本 block map 且区间含于该块、sourceHash ===
 *   canonicalText 的 SHA-256（`getMaterialSelection` 校验，schema CHECK
 *   互为防御）；
 * - 仅 parse_status = 'ready' 的版本可建枝（拒绝并说明原因，不把不支持
 *   伪装成成功空文档——charter §3.2）；
 * - 每枝至多一条来源：material_branch_origins 与 branch_origins 各以
 *   branch_id 为主键，写入前显式查两表；「origin_kind 与来源类型一致」
 *   由写入路径同事务维护（`setBranchOriginKind` 做一致性校验）；
 * - 首问幂等：PRIMARY KEY(tree_id, intent_key)——重放同键返回既有行
 *   （ADR-003 §4，与 return idempotencyKey / 术语 promotionKey 同一
 *   树内唯一模式）。
 *
 * 事务：写路径使用 `BEGIN IMMEDIATE`（写前取锁）；嵌套调用以
 * SAVEPOINT 实现内层独立回滚（与 TreeRepository 同一约定）。
 */
/** Stable public repository entrypoint. */
export type {
  BranchOriginKind,
  MaterialRepositoryOptions,
  CreateMaterialInput,
  InsertMaterialVersionInput,
  MaterialParseTransitionStatus,
  UpdateVersionParseResultInput,
  MaterialVersionContent,
  MaterialVersionBlob,
  TreeMaterialLink,
  UpsertReadingPositionInput,
  MaterialFirstQuestion,
  InsertFirstQuestionInput,
  InsertFirstQuestionResult,
  InsertMaterialBranchOriginInput,
  CreateMaterialBranchInput,
  CreateMaterialBranchResult,
  MaterialSelectionContext,
  BranchOriginRef,
} from "./material/model.ts";
export {
  MaterialRepository,
} from "./material/repository.ts";
