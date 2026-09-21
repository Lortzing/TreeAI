# Agent C Handoff

- 交付人：Agent C（`TreeRepository` / SQLite migration / `SessionReference` 持久化）
- 日期：2026-09-21
- 状态文件：`coordination/d2/agent-c-status.md`；依赖决策：`coordination/d2/agent-c-dependency-request.md`（请求 `agent-c-1`）
- 未执行任何 `git commit` / `git push`（遵任务书指示；全部变更留在工作区）

## 状态
PASS

（本模块全部必做项 1–7 已实现并通过验证。唯一的根级验证失败——`npm run typecheck` exit 1——失败点全部位于 `packages/runtime-pi`，属其他 Agent 范围，见「需要 Integrator 处理」第 4 条；`@treeai/persistence` 本身零报错。）

## 完成内容

1. **存储引擎（必做 1）**：选用 Node 24.21.0 内置 `node:sqlite`（`DatabaseSync`，随 Node 携带 SQLite 3.53.x）。**零新增 npm 依赖、零 lockfile 变更**，clean install 复现性与 Node 基线绑定。决策、替代方案（better-sqlite3 / @libsql/client / sql.js 等）与风险已写入 `agent-c-dependency-request.md`（请求 `agent-c-1`），待 Integrator 确认。
2. **Schema / Migration / Repository（必做 2）**：
   - Migration v1 `initial-schema`：`forests` / `trees` / `branches`（自引用 parent，双分支）/ `episodes` / `runs` / `session_references`（1:1 on run）+ 索引 + 显式外键（连接时 `foreign_keys = ON`）+ CHECK 约束；
   - 版本化 migration 注册表（`schema_migrations` 表 + `PRAGMA user_version` 双轨交叉校验）：已应用即跳过（重复执行安全）、版本必须连续前缀、外来库（有表无登记）/ 损坏库（非 SQLite、登记不一致）明确拒绝、每条 migration 独立原子事务（失败回滚该条并抛 `MigrationFailedError` 含版本与名称）、过新版本抛 `UnsupportedDatabaseVersionError`；
   - `TreeRepository`：`createForest/createTree/createBranch/createEpisode/createRun`（含父存在性、跨树父分支、自父拒绝；run 初始 `queued`）、`updateRunState`（对照冻结迁移表）、`listRuns/listBranches/listEpisodes/listTrees/listForests`、`get*/find*`；
   - TreeAI DB 是事实源：创建/查询 run **不要求** Pi session 文件存在；`SessionReference` 只保存 `sessionFile/sessionId/entryId/piVersion/availability`，schema 无凭据列，本包不读不写不解析 Pi session 内容。
3. **终态与恢复（必做 3）**：
   - 单终态三层防御（I3）：①仓储条件 UPDATE（`WHERE terminal_state IS NULL AND state = ?`，0 行命中重新读取分类冲突）；②表级 CHECK（terminal_at⟺terminal_state、terminal_state=NULL 或 =state、failure_json 仅 failed）；③触发器 `runs_terminal_immutable`（终态行的 state/terminal_state/failure_json 再变更直接 ABORT，对裸 SQL 生效）；
   - 恢复查询：`getBranchRecovery`（forest/tree/branch/parentBranch/episodes/runs/latestRun）、`getTreeRecovery`、`listNonTerminalRuns`、`failNonTerminalRuns`（I6 清扫：非终态→failed，幂等，不碰已终态）；
   - 明确错误：备份/恢复（`BackupError`）、损坏（`DatabaseCorruptError`）、migration 失败（`MigrationFailedError`）、版本过新（`UnsupportedDatabaseVersionError`）、非法迁移（`InvalidRunStateTransitionError`）、终态冲突（`RunTerminalConflictError`）等完整层级（`src/errors.ts`）。
4. **Session 丢失降级（必做 4）**：`markSessionFileAvailability(file, exists)` 批量降级/恢复、`refreshSessionAvailability(exists?)`（探针注入，默认 `fs.existsSync` 仅存在性检查）、`updateRunSessionReference`（entryId 前进整体替换）、`updateSessionAvailability`、`getSessionReferencesByFile`。session 删除/移动后域数据完整保留，引用变为 `unavailable/missing-file`，**不级联删除**；恢复查询可见降级状态。
5. **测试（必做 5）**：Node 内置 test runner，8 个文件 45 个测试，全绿；无云服务、无网络、只用系统临时目录与内存库。覆盖任务书全部七项：空库 migration（文件/内存）、重复 migration（二次打开 + 直接重跑，登记无重复）、双分支（含重开后关系仍在）、session 缺失不删域数据（含重开后降级持久）、事务中途失败回滚（顶层 + 嵌套 savepoint + 落盘后重开验证）、并发终态更新不双终态（双连接顺序冲突 + **worker_threads 真并行竞态 5 轮** + 并行 I6 清扫 + 裸 SQL 触发器防御）。另含状态机全迁移矩阵、failure iff failed、cause 不入库、备份/恢复全链路与全部失败模式。
6. **README（必做 6）**：`packages/persistence/README.md`——ER 关系与约束、事务语义（BEGIN IMMEDIATE + SAVEPOINT）、migration 体系、备份/恢复流程、SessionReference 数据边界、错误分类、已知限制。Pi 类型零泄漏：`@treeai/contracts` 全部 `import type` 消费，无 Pi 包导入。

## 修改文件

全部位于独占范围内（`packages/persistence/**`、`coordination/d2/agent-c-*.md`）；未触碰 contracts、根配置、其他 package、d1-spikes。

新增（生产代码）：
- `packages/persistence/src/errors.ts`
- `packages/persistence/src/database.ts`
- `packages/persistence/src/serialization.ts`
- `packages/persistence/src/tree-repository.ts`
- `packages/persistence/src/index.ts`
- `packages/persistence/src/migrations/0001-initial-schema.ts`
- `packages/persistence/src/migrations/index.ts`

新增（测试）：
- `packages/persistence/tests/helpers.ts`
- `packages/persistence/tests/migration.test.ts`
- `packages/persistence/tests/repository-crud.test.ts`
- `packages/persistence/tests/run-state.test.ts`
- `packages/persistence/tests/concurrency.test.ts`
- `packages/persistence/tests/concurrency-worker.ts`（worker_threads 竞态 worker，非测试文件，不被 `node --test` 收集）
- `packages/persistence/tests/session-reference.test.ts`
- `packages/persistence/tests/transactions.test.ts`
- `packages/persistence/tests/recovery.test.ts`
- `packages/persistence/tests/backup.test.ts`

新增（文档/协调）：
- `packages/persistence/README.md`
- `coordination/d2/agent-c-status.md`
- `coordination/d2/agent-c-dependency-request.md`
- `coordination/d2/agent-c-handoff.md`（本文件）

修改：
- `packages/persistence/package.json`（增加 `main`/`types` 指向 `src/index.ts`；`scripts.test` = typecheck + `node --test "tests/*.test.ts"`；`scripts.typecheck`）
- `packages/persistence/tsconfig.json`（在 base 之上覆写 `allowImportingTsExtensions: true`，include 增加 tests）

## 验证命令与退出码

```text
command: cd packages/persistence && npx tsc --noEmit -p tsconfig.json
exit: 0

command: cd packages/persistence && node --test "tests/*.test.ts"
exit: 0
输出摘要: tests 45 / pass 45 / fail 0 / cancelled 0 / skipped 0（duration ≈ 460ms）

command: cd packages/persistence && npm test        # = typecheck + node --test
exit: 0

command: （稳定性）cd packages/persistence && node --test "tests/*.test.ts"（连跑 5 次）
exit: 0 × 5（每次 45/45，worker_threads 竞态无 flake）

command: （根级，只读验证）npm run typecheck
exit: 1
说明: @treeai/persistence 已进入 checked 集合且零报错；失败全部在 packages/runtime-pi
     （errors.ts(29) override 修饰符、events.ts 8 处 JsonRecord 只读索引赋值、
     pi-real-port.ts(41) 私有构造器约束，共 9 处 tsc 报错——该包属其他 Agent 范围）

command: （根级，只读验证）npm test
exit: 3
说明: scripts/gate0-status.js 的 NOT_IMPLEMENTED 占位（"deliberate, explicit failure"），
     与本模块无关；persistence 的测试入口尚未接线（见「需要 Integrator 处理」第 2 条）
```

## 证据

- 测试输出（节选，完整输出可由上述命令复现）：
  - `✔ migration applies to an empty file database` / `✔ repeated migration execution is safe (idempotent)`
  - `✔ creates the full hierarchy and persists dual-branch relationship across reopen`
  - `✔ deleting the session file degrades availability but never deletes domain data`
  - `✔ mid-transaction failure rolls back every write in the transaction`
  - `✔ parallel terminal updates from two worker threads produce exactly one terminal state`（5 轮，每轮恰好一胜、败者 `RunTerminalConflictError`）
  - `✔ parallel restart sweeps converge all runs to failed exactly once`
  - `✔ direct SQL mutation of a terminal run is blocked by the trigger (third defense layer)`
  - `ℹ tests 45 / ℹ pass 45 / ℹ fail 0`
- 命令行稳定性：同套件连续 5 次执行全部 45/45、exit 0。
- 根 typecheck 失败明细见上方「验证命令与退出码」第 5 条（`packages/runtime-pi`，9 处报错原文已核对）。
- git 状态：本 Agent 未执行任何 commit；全部交付物为工作区新增/修改文件（`git status` 中 `packages/`、`coordination/` 为未跟踪目录，包含其他 Agent 的并行工作）。
- `node:sqlite` 能力探针（FK/触发器/savepoint/条件 UPDATE/参数化 VACUUM INTO/双连接竞态/busy_timeout/损坏检测）在系统临时目录实测通过，未进入仓库。

## 已知限制

1. **Node 版本绑定**：`node:sqlite` 需 Node ≥ 22.5（本项目基线 24.21.0）；Node 官方文档对该模块标注 experimental，但本项目用到的能力面（`DatabaseSync`、参数化 `VACUUM INTO ?`、触发器、SAVEPOINT、busy_timeout、WAL）已在 24.21.0 实测验证。
2. **同步 API**：`DatabaseSync` 为同步接口，适合本地单用户 CLI 场景；未来若需服务端高并发需换异步驱动（超出 D2 范围）。
3. **并发模型**：单机多连接，依赖 `BEGIN IMMEDIATE` + `busy_timeout`（默认 5000ms，可注入）；超时表现为 SQLITE_BUSY 类错误。不支持 NFS 等网络文件系统。
4. **`restoreFromBackup` 为文件级覆盖**：恢复期间同库其他打开连接仍持旧句柄；调用方应保证恢复时独占访问。
5. **排序依赖追加式纪律**：列表按 `created_at, rowid` 排序成立的前提是本包不删除 run 行；未来引入删除/归档需显式序列列。
6. **schema 当前仅 v1**：后续演进必须新增 migration 文件（`00NN-*.ts` + 注册表登记），禁止修改已发布的 `0001`。
7. **`availability` 是缓存评估**：本包只维护缓存值与扫描 API，运行时恢复的实时校验是 runtime 侧职责（contracts session-reference.ts 语义）。

## 接口偏离

- **无 CONTRACT-CHANGE**：未修改任何冻结契约；`@treeai/contracts` 仅 `import type` 消费。
- 设计/约定偏离（已在状态文件登记，请 Integrator 知悉）：
  1. **persistence 错误不是 `TreeAIError`**：`PersistenceError` 层级表达宿主侧基础设施/数据完整性失败；按 contracts 语义 `TreeAIError` 是 Run 运行期失败分类。映射（如 code `unknown`）是调用方（runtime-smoke / event-journal）职责，本包不做隐式映射。
  2. **`.ts` 扩展名导入 + `allowImportingTsExtensions: true`**：走 Node 24 原生 type stripping、零构建产物路线，与 contracts 包内部 `.js` 扩展名（tsc NodeNext 发射）约定不同。根 tsconfig 未动，仅包级覆写。
  3. **`main`/`types` 指向 `src/index.ts`**：无构建产物路线的直接消费方式（workspace 内 `import "@treeai/persistence"` 可用）。
  4. `failure_json` 只持久化 `code/message/details`（contracts 规定 `cause` 脱敏，本包直接不存）。

## Pi 改造需求

- 无。persistence 不 import Pi 包/类型、不读写 Pi session JSONL、不保存凭据；对 Pi 侧零改造需求（无 PI-CHANGE）。Pi session 生命周期变化通过调用方传入的 availability 评估/探针结果反映。

## 需要 Integrator 处理

1. **确认依赖决策 `agent-c-1`**（`agent-c-dependency-request.md`）：`node:sqlite` 作为存储引擎，零新增 npm 依赖。审核栏已留空待签。
2. **接线根 `npm test`**：当前根 `npm test` 仍是 Gate 0 占位（exit 3）。Wave 1 接线时把 `packages/persistence` 的 `npm test`（typecheck + `node --test "tests/*.test.ts"`）纳入聚合入口；注意目录形式 `node --test tests/` 不可用，需保持引号 glob 形式。
3. **确认 `.ts` 扩展名/零构建路线**（或指示改为构建路线，届时需要调整包 tsconfig 与 import 说明）。
4. **根 `npm run typecheck` exit 1**：失败全部在 `packages/runtime-pi`（9 处 tsc 报错，详见上）；请转交该包维护者。`@treeai/persistence` 在 checked 集合中零报错。
5. （提醒）runtime-smoke / event-journal 消费本包时：负责把 `PersistenceError` 映射为合适的 `TreeAIError`/宿主错误；I6 恢复时用 `failNonTerminalRuns` 并自建 `code:"unknown"` + `details:{hostInterrupted:true}` 的 failure。
