# Dependency Request: `agent-c-1`（存储引擎决策确认）

- 提出者：Agent C
- 日期：2026-09-21
- 目标 workspace：`packages/persistence`
- 依赖类型：**无新增依赖**（本请求是任务书 §5 Agent C 节"具体驱动通过 dependency request 交由 Integrator 确认"的决策确认请求；若 Integrator 改选外部驱动，再按本模板追加正式安装请求）
- 依赖名称与精确版本：`node:sqlite`（Node.js 内置模块，随 **Node `24.21.0`** 分发，捆绑 SQLite **3.53.4**；无 npm 包、无版本号、无 lockfile 变更）

## 用途

`packages/persistence` 的全部存储需求：Forest/Tree/Branch/Episode/Run/SessionReference 的 schema、版本化 migration、事务边界、终态约束与备份/恢复（`VACUUM INTO`）。

任务书要求 D2 默认本地 SQLite 且不引入云服务；本请求确认以 Node 内置 `node:sqlite`（`DatabaseSync` 同步 API）作为驱动，从而：

- **零新依赖、零 lockfile 变更**：clean install（`npm ci`）的可复现性与已锁基线 Node `24.21.0` 直接绑定，不增加供应链面；
- 无 native 构建环节（对比 better-sqlite3 的 node-gyp 编译风险）；
- 事务边界完全显式（`BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`/`SAVEPOINT`），满足"事务明确"要求。

本机（Node v24.21.0）已实测以下全部能力，探针未入仓库：

- `new DatabaseSync(path, { enableForeignKeyConstraints: true })` 外键强制生效；
- `BEFORE UPDATE` 触发器 `RAISE(ABORT, ...)` 生效（终态不可变的纵深防御层）；
- `SAVEPOINT`/`ROLLBACK TO`/`RELEASE` 嵌套事务回滚正确；
- 条件 UPDATE 的 `changes` 计数：双连接对同一行竞争写入时恰好一方 `changes=1`、另一方 `changes=0`（单终态竞争的核心机制）；
- `PRAGMA busy_timeout` 生效（写锁等待后明确报 `database is locked`）；
- `VACUUM INTO ?` 参数化在线备份可用，目标已存在时明确报错；
- `PRAGMA integrity_check`、`PRAGMA user_version`、WAL 模式可用；
- 打开非 SQLite 内容的文件报 `file is not a database`（损坏检测入口）。

## 替代方案

| 方案 | 结论 | 理由 |
|---|---|---|
| `node:sqlite`（内置） | **采用** | 见"用途"。Node 24.21.0 基线上无 flag 可用（type stripping 同理，测试直接 `node --test "tests/*.test.ts"`）。已知取舍：同步 API（阻塞式）——对单用户受信任本地运行时可接受且使事务边界更简单；无异步批处理。 |
| `better-sqlite3` | 未采用 | 成熟同步驱动、功能最全，但需 native 编译（node-gyp/预编译二进制），增加 clean install 失败面与供应链面；功能上本模块所需（FK/触发器/savepoint/VACUUM INTO/busy_timeout）内置模块已全覆盖（已实测）。若未来需要其独有能力（如用户自定义函数的高级形态、backup API），走新请求升级。 |
| `@libsql/client` / `libsql` | 未采用 | 引入托管/远程同步语义与更多传递依赖，超出"默认本地 SQLite"边界，云能力为 D2 明确不做。 |
| `sql.js` / `node-sqlite3-wasm` | 未采用 | 纯 WASM 无 native 编译，但性能差、持久化需自行导出文件，事务与备份语义反而更复杂。 |
| `node:sqlite` 走子进程/独立服务 | 未采用 | 违背 D2"不建设通用 Runtime/服务化"的收敛目标，无必要。 |

## 风险

- **Node 版本绑定**：`node:sqlite` 在 Node 22.5.0 引入（实验）、23.4 起 unflagged、24.x 稳定可用。已锁基线 `engines.node = 24.21.0` 使该风险受控；Node 大版本升级时需回归本包全部单测（测试入口自包含：`cd packages/persistence && npm test`）。
- **同步阻塞**：`DatabaseSync` 在 JS 主线程同步执行 SQL。对 D2 单用户本地场景（小库、短事务）无实质影响；已知限制已写入包 README，未来若引入服务化/高并发需重新评估（届时属新决策）。
- **API 面**：`node:sqlite` 尚标记 experimental（文档层面）但 24.x 行为稳定；本模块仅使用已实测原语（上述清单），不使用实验性扩展点（如 `allowExtension`）。SQLite 引擎本体 3.53.4 为稳定版本。
- **与已锁基线冲突**：无——不触 npm 依赖、不触根配置、不触 lockfile；license 为 Node/SQLite 自带（MIT/Public Domain），与仓库 MIT 兼容。
- **对 clean install `npm ci` 的影响**：无（零依赖变更）。

## Integrator 审核结论

- 结论：**批准** `node:sqlite`（Node 24.21.0 内置模块）
- 安装记录：无安装动作；无 npm 依赖、无 lockfile 变更。已复跑 `npm test --workspace=@treeai/persistence`，45/45 PASS，exit 0。
- 日期：2026-09-21
- 约束：Node 基线不得无记录降级；Node 大版本或 SQLite API 变更必须重新执行 persistence 全量测试并更新升级记录。
