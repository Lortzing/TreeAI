# @treeai/persistence

TreeAI 自有数据库（本地 SQLite）的领域仓储：Forest / Tree / Branch / Episode /
Run / SessionReference 的 schema、migration 与 `TreeRepository` API。

- 驱动：Node 内置 `node:sqlite`（`DatabaseSync`，Node 24.21.0 自带 SQLite 3.53.x）。
  **零新增 npm 依赖**；决策记录见
  `coordination/d2/agent-c-dependency-request.md`（请求编号 agent-c-1）。
- 事实源边界（ADR-001 §4）：TreeAI DB 是产品事实源，不依赖 Pi session
  JSONL 的存在；本包不读取、不写入、不解析任何 Pi session 内容，不保存凭据。

## 快速上手

```ts
import { TreeRepository } from "@treeai/persistence";

const repo = TreeRepository.open({ path: "~/.treeai/treeai.db" }); // 首次打开自动迁移
const forest = repo.createForest();
const tree = repo.createTree(forest.id);
const root = repo.createBranch(tree.id);
const second = repo.createBranch(tree.id, { parentBranchId: root.id }); // 双分支
const episode = repo.createEpisode(second.id);
const run = repo.createRun(episode.id, {
  sessionId, sessionFile, entryId, piVersion,
  availability: { status: "available" },
});
repo.updateRunState(run.id, "running");
repo.updateRunState(run.id, "succeeded");
repo.close();
```

## ER 关系

```
forests 1 ─── n trees 1 ─── n branches ──┐（parent_branch_id 自引用，同树内成父子）
                          │              │
                          └─ n episodes 1 ─── n runs 1 ─── 1 session_references
```

| 表 | 主键 | 关键列 / 约束 |
| --- | --- | --- |
| `forests` | `id` | `created_at` |
| `trees` | `id` | `forest_id → forests.id` |
| `branches` | `id` | `tree_id → trees.id`；`parent_branch_id → branches.id`（NULL = 根分支；CHECK 禁止自父；父分支必须同树——仓储层校验） |
| `episodes` | `id` | `branch_id → branches.id` |
| `runs` | `id` | `episode_id → episodes.id`；`state` 六态 CHECK；`terminal_at`/`terminal_state`/`failure_json` 见下 |
| `session_references` | `run_id → runs.id`（1:1） | `session_id`/`session_file`/`entry_id`/`pi_version`（引用三元组 + 版本，无凭据）；`availability_status`/`availability_reason`/`availability_detail`（available ⇔ reason NULL，CHECK 强制） |

排序约定：所有列表查询按 `created_at, rowid`（追加式写入下为稳定插入序；
本包不删除 run 行）。

### Run 单终态（三层防御，contracts run-state I3）

1. **仓储层**：终态写入使用条件 UPDATE
   `UPDATE runs SET ... WHERE id = ? AND terminal_state IS NULL AND state = ?`；
   0 行命中即并发冲突，重新读取后抛 `RunTerminalConflictError`。
2. **schema CHECK**：`terminal_at ⟺ terminal_state`、`terminal_state = state`（若非空）、
   `failure_json` 仅允许 `terminal_state = 'failed'`。
3. **触发器 `runs_terminal_immutable`**：终态行的 `state` / `terminal_state` /
   `failure_json` 再变更直接 `RAISE(ABORT)`——对绕过本仓储的裸 SQL 同样生效。

状态迁移合法性（I5/I7）在仓储层对照 `@treeai/contracts` 的冻结迁移表校验
（`as const satisfies RunStateTransitions` 保证编译期一致）。

## 事务语义

- 写路径统一走 `repo.transaction(fn)`：
  - 顶层 = `BEGIN IMMEDIATE`（写前取写锁，避免 DEFERRED 读→写升级死锁）… `COMMIT`；
    `fn` 抛错则 `ROLLBACK` 并原样重抛；
  - 嵌套 = `SAVEPOINT`：内层失败只回滚内层，调用方捕获后外层可继续提交。
- 原子单元示例：`createRun`（runs + session_references 两行同事务）；
  `updateRunState`（读-校验-条件写）；`failNonTerminalRuns`（I6 清扫）。
- 并发：文件库默认 `busy_timeout = 5000ms` + WAL + `synchronous = FULL`。
  跨连接/跨线程并发终态写入由条件 UPDATE 保证恰好一胜（测试含
  worker_threads 真并行竞态）。
- `createBackup` / `restoreFromBackup` 不能在事务内调用（`VACUUM` 限制），违例抛
  `BackupError`。

## Migration 体系

- 版本登记：`schema_migrations` 表 + `PRAGMA user_version` 双轨，每次打开时
  交叉校验；不一致按损坏处理。
- `runMigrations(db)`：
  - 已应用版本跳过（重复执行安全 / 幂等）；
  - 版本必须连续前缀，出现空洞视为损坏；
  - 每条 migration 在独立事务中执行（DDL + 登记 + user_version），失败整体
    回滚并抛 `MigrationFailedError`（含版本号与名称）；
  - 空文件 / 空内存库 = 全新数据库，从 v1 开始应用；
  - 有用户表但无 `schema_migrations` / user_version 无登记表 → 外来库，
    `DatabaseCorruptError`（"not a TreeAI database"）；
  - 版本高于当前支持 → `UnsupportedDatabaseVersionError`。

## 备份 / 恢复

```ts
repo.createBackup("/path/to/backup.db");              // VACUUM INTO：在线、自包含快照
TreeRepository.validateBackup("/path/to/backup.db");  // 可读 + integrity_check + 版本
repo.restoreFromBackup("/path/to/backup.db");         // 校验 → 关闭 → 覆盖 → 重开
```

- `createBackup` 默认拒绝覆盖已存在目标（`BackupError`）；`{ overwrite: true }` 先删后备。
- `restoreFromBackup` 先校验备份（垃圾文件 → `DatabaseCorruptError`；外来 SQLite →
  `BackupError`），可选 `{ backupCurrentTo }` 把当前库另存后再覆盖；覆盖后清除陈旧
  `-wal`/`-shm` 并重新打开（自动前向迁移）。内存库不支持恢复（无文件可覆盖）。
- `repo.integrityCheck()`：`PRAGMA integrity_check`。

## 恢复查询

- `getBranchRecovery(branchId)`：森林/树/父分支定位 + 全部 episode（含各自 runs
  与 latestRun）。`getTreeRecovery(treeId)`：树内全部分支的恢复信息。
- `listNonTerminalRuns()` + `failNonTerminalRuns(failure)`：I6 重启恢复——宿主崩溃后
  把所有非终态（queued/running/aborting）run 收敛为 `failed`（建议 failure 取
  `code: "unknown"` + `details: { hostInterrupted: true }`，由调用方构造）；
  已终态 run 不受影响，重复执行是 no-op。

## SessionReference 与数据边界

- `createRun` 起 run 即持有 1:1 的 session 引用；引用只含
  `sessionFile/sessionId/entryId/piVersion/availability`，**永不**包含凭据或
  Pi 私有数据（schema 无相应列）。
- `sessionFile` 只是字符串引用：本包从不打开、读取或校验该文件的内容；
  创建 run 不要求文件存在。
- `availability` 是**缓存评估**（运行时恢复时应实时复核）：
  - `markSessionFileAvailability(file, false)`：文件丢失/移动后批量降级为
    `unavailable/missing-file`——域数据**不级联删除**；
  - `refreshSessionAvailability(exists?)`：全量扫描（探针可注入，默认
    `fs.existsSync`，仅存在性检查）；
  - `updateRunSessionReference`：prompt/navigateTree 后 entryId 前进时**整体替换**引用。
- Pi 类型不泄漏进本包：`@treeai/contracts` 仅以 `import type` 消费。

## 错误分类

`PersistenceError` 及其子类（`DatabaseCorruptError`、`UnsupportedDatabaseVersionError`、
`MigrationFailedError`、`BackupError`、`EntityNotFoundError`、
`InvalidRunStateTransitionError`、`RunTerminalConflictError`、
`ConstraintViolationError`、`InvalidArgumentError`、`RepositoryClosedError`）。

注意：persistence 错误**不是** `TreeAIError`。`TreeAIError` 按 contracts 语义表达
Run 运行期失败；基础设施/数据完整性失败属于本分类，映射到 `TreeAIError`
（如 code `unknown`）是调用方（runtime-smoke / event-journal）的职责。
`failure_json` 只持久化 `code/message/details`；`cause` 永不入库。

## 测试

```bash
cd packages/persistence && npm test   # tsc --noEmit + node --test "tests/*.test.ts"
```

Node 内置 test runner，无云服务、无网络。覆盖：空库/内存库 migration、重复
migration、损坏/外来/过新库、migration 失败回滚、领域 CRUD 与双分支、
状态机全迁移矩阵与非法迁移、单终态（同连接 + 双连接 + worker_threads 真并行 +
裸 SQL 触发器）、I6 清扫（含并行清扫）、session 缺失不删域数据、事务中途失败
回滚、嵌套 savepoint、备份/恢复全链路与失败模式。45 个测试。

## 已知限制

1. **Node 版本绑定**：`node:sqlite` 要求 Node ≥ 22.5（本项目固定 24.21.0）；
   Node 文档标注该模块 experimental，但 API 表面（`DatabaseSync`、参数化
   `VACUUM INTO`、触发器、savepoint）已在 24.21.0 上验证。
2. **同步 API**：`DatabaseSync` 为同步接口；适合本地单用户场景。高并发服务器
   场景需要引入异步驱动（超出 D2 范围）。
3. **单进程多连接并发**：依赖 `BEGIN IMMEDIATE` + `busy_timeout`（默认 5s）；
   超时表现为 `SQLITE_BUSY` 类错误。跨机器/网络文件系统（NFS 等）不受支持。
4. **`restoreFromBackup` 是文件级覆盖**：恢复期间该库的其他打开连接会看到旧句柄；
   调用方应保证恢复时独占访问。
5. **`rowid` 排序依赖追加式纪律**：本包不删除 run 行；如果未来引入删除/归档，
   列表排序需要显式序列列。
6. **schema 演进**：当前仅 v1（initial-schema）；新增表/列必须走新增 migration
   文件（`src/migrations/00NN-*.ts` + 注册），禁止就地修改已发布 migration。
