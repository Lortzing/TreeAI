# D2 Agent C 状态文件（agent-c-status.md）

- 维护者：Agent C（本文件唯一写入者）
- 创建：2026-09-21（Wave 1 启动记录，任务书 §12）
- 角色：`TreeRepository`、数据库迁移与 `SessionReference` 持久化（任务书 §2/§5 Agent C）
- 状态：已完成（生产代码 + 测试 + README 交付；验证结果见 §6 执行记录与 `agent-c-handoff.md`）
- 依据：《TreeAI_D2_Agent执行任务书.md》v1.0；Gate 0 已通过（`coordination/d2/CONTRACT-FREEZE-1.md` 状态 PASS，2026-09-21 Integrator 签署）

## 1. 已读材料（按任务书 §12 顺序）

| # | 材料 | 摘取的关键事实 |
|---|---|---|
| 1 | 《TreeAI_D2_Agent执行任务书.md》v1.0 | Agent C 独占 `packages/persistence/**`（含 migrations）与 `coordination/d2/agent-c-*`；禁改 contracts、根 package.json/package-lock/tsconfig、其他 package、tests/schemas/scripts/.github、d1-spikes。存储引擎规则（§5 Agent C 节）：D2 默认本地 SQLite，可比较 Node 内置与成熟驱动，不得引入云服务，优先 clean install 简单、事务明确、目标设备可复现；驱动经 dependency request 交 Integrator 确认。必须测试七项：空库 migration、重复 migration、双分支、session 缺失不删域数据、unavailable 不级联、中途失败事务回滚、并发更新不产生双终态。 |
| 2 | `d1-spikes/research/adr-001-draft.md` 顶部批准记录 + §4 数据边界 | ADR-001 Accepted（2026-09-20）：TS/Node.js + Pi SDK 进程内直嵌，Pi 0.85.1。§4 硬约束（不随候选变化）：TreeAI 自有 DB 是 Forest/Tree/Branch/Episode/Run 事实源；只保存 Pi 引用三元组 sessionFile/sessionId/entryId；写入仅经 Pi 官方 API；删除 Pi session 不得破坏 TreeAI 域数据，允许降级为失去回放来源；凭据不复制不代理；不得把 Pi session schema 当稳定契约。 |
| 3 | `d1-spikes/reports/blockers.md` D1 关闭记录与 D2 授权记录 | DECISION-001~009 全部关闭：SDK 直嵌、TS 宿主、Pi 精确 0.85.1、Node v24.21.0/npm 11.19.0/TS 5.9.3 为复现基线（偏离需显式升级记录）、D1 Go、D2 授权进入正式工程化（模块边界含 TreeRepository 与 SessionReference）。 |
| 4 | `d1-spikes/reports/d1-verification.md` 最终验收 | 最终验收 `verify-20260920T124525829Z.json`：30/30 检查全 PASS、exit 0（ALL_PASS），含 tree-navigation checks 22/23；`--repro` 干净复现双侧 PASS；秘密扫描零发现。本机环境 macOS/darwin、Node v24.21.0。 |
| 5 | `packages/contracts/src/`（全部 9 个源文件） | Gate 0 冻结契约：`identifiers.ts`（Forest→Tree→Branch→Episode→Run 层级 + `Run.session: SessionReference` + Locator）；`session-reference.ts`（引用三元组 + `piVersion` + `SessionAvailability` 缓存评估语义，`PinnedPiVersion = "0.85.1"`）；`run-state.ts`（六态 + 迁移表 + 不变量 I1–I7，含 I3 单终态、I6 重启恢复）；`errors.ts`（TreeAIError 8 类，`cause` 持久化前必须脱敏）；`events.ts`/`pi-runtime.ts`/`tool-decision.ts`/`branding.ts`/`json.ts`。全部纯类型（`import type` 消费）。 |
| 6 | `docs/d2/contracts-README.md` | 契约消费规则：一律 `import type`；品牌 ID 构造用显式断言；破坏性变更走 CONTRACT-CHANGE；persistence 拥有存储 schema/迁移/事务，不得 import Pi；seq 双层语义；调用方违反前置条件抛平台标准错误而非 TreeAIError。 |
| 7 | `coordination/d2/CONTRACT-FREEZE-1.md` | 状态 PASS（Integrator 2026-09-21 签署，Gate 0 通过）。七项冻结内容与实现位置对照；设计取舍备案（六态精确冻结、无 interrupted 第七态；I6 崩溃恢复按 failed+unknown+hostInterrupted 处理）。 |
| 8 | 参考：`coordination/d2/integrator-status.md`、`coordination/d2/README.md`、根 `package.json`/`tsconfig.base.json`、`packages/persistence/{package.json,tsconfig.json}`、`scripts/typecheck.js` | 工具链基线：TS 5.9.3 精确、@types/node 24.13.5、Node 24.21.0 engines、ES2023+NodeNext+strict+noEmit+verbatimModuleSyntax；根 typecheck 编排器对有 src 的包跑 `tsc -p`；依赖申请流程（模板 + Integrator 审核）；状态/交接文件格式。 |

## 2. 理解并承诺的边界

可写（独占）：

- `packages/persistence/**`（src、tests、migrations、package.json、tsconfig.json、README）；
- `coordination/d2/agent-c-*.md`（status、dependency-request、handoff）。

不写 / 不做：

- 不改 `packages/contracts/**`、其他 package（runtime-pi/tool-policy/event-journal）、`apps/**`、根 `package.json`/`package-lock.json`/`tsconfig.base.json`、根级 `tests/`/`schemas/`/`scripts/`/`.github/`、`d1-spikes/**`（只读证据区）；
- 不引入云服务；**不引入任何新依赖**（存储引擎选用 Node 24.21.0 内置 `node:sqlite`，零 lockfile 变更，clean install 天然可复现；决策记录见 `agent-c-dependency-request.md`，请 Integrator 确认）；
- 不 import 任何 Pi 类型/包（persistence 只 `import type` 消费 `@treeai/contracts`）；
- 不读写 Pi session JSONL；`SessionReference` 只存 sessionFile/sessionId/entryId/piVersion/availability，不存凭据、不解析 Pi 私有数据；
- 不把 Pi session 存在性当作 TreeAI 域数据的存储前提；session 丢失只降级 availability，不级联删除；
- 不执行 `git commit`/`git push`/破坏性 git 命令；不覆盖他人未提交变更；
- 测试只用 Node 内置 `node:test` + 临时目录，不触真实用户 Pi 配置/session 目录。

## 3. 计划（对应任务书 §5 Agent C 必须完成 1–7 项）

存储引擎决策（本节为设计结论，细节与替代方案见 dependency request）：

- **选用 Node 内置 `node:sqlite`（`DatabaseSync`，Node 24.21.0 携带 SQLite 3.53.4）**。已在本机以探针实测：FK 强制、触发器、savepoint、条件 UPDATE 的 changes 计数、参数化 `VACUUM INTO`、双连接并发下条件更新恰好一胜、busy_timeout、非 SQLite 文件打开报 `file is not a database`。零新依赖 → `npm ci` 复现性与 Node 基线绑定，符合"优先 Node 24.21.0 可复现"的任务书要求。

模块设计：

1. **migrations**（`src/migrations/`）：版本化有序注册表（v1 = 初始 schema：forests/trees/branches/episodes/runs/session_references + 索引 + 约束 + 终态不可变触发器）。每条 migration 独立事务（BEGIN IMMEDIATE→DDL→登记 schema_migrations→PRAGMA user_version→COMMIT）；失败回滚该条并抛 `MigrationFailedError`；重复执行安全（已应用即跳过）；user_version 与 schema_migrations 交叉校验，发现外来/损坏 schema 明确报错。
2. **database.ts**：打开（FK ON、busy_timeout、文件库 WAL + synchronous FULL）、损坏检测（非 SQLite 文件、有表但无 schema_migrations、版本高于支持）、integrity_check、`VACUUM INTO` 备份、备份校验/恢复。
3. **tree-repository.ts**（`TreeRepository`）：
   - 创建 forest/tree/branch（含双分支 parent 关系校验）/episode/run（初始 `queued`，含 session 引用）；
   - `updateRunState`：对照 contracts 冻结迁移表（运行时副本以 `satisfies RunStateTransitions` 与冻结表编译期对齐）校验合法迁移；终态写入用条件 UPDATE（`WHERE terminal_state IS NULL`）+ DB CHECK 约束 + 触发器三层防御，杜绝单 Run 双终态（含跨连接并发）；
   - `failNonTerminalRuns`（I6 重启恢复清扫：非终态→failed+hostInterrupted）；
   - SessionReference：更新引用（prompt/navigateTree 后 entryId 前进）、按 run 更新 availability、按 session 文件批量标记缺失（`exists` 由调用方传入，repo 不读 Pi session 内容）、全量扫描（注入式 exists 探针，默认 `fs.existsSync` 仅做存在性检查）；
   - 恢复查询：`getBranchRecovery`/`getTreeRecovery`（branch+tree+forest+episodes+runs+最新 run 的 session 引用与 availability）；
   - `transaction(fn)`：BEGIN IMMEDIATE + 嵌套 SAVEPOINT，中途失败回滚；
   - 备份：`createBackup`（VACUUM INTO，目标存在默认拒绝）、`validateBackup`、`restoreFromBackup`（可选先把当前库另存）。
4. **errors.ts**：persistence 专属错误层级（`PersistenceError` 基类 + DatabaseCorrupt/UnsupportedDatabaseVersion/MigrationFailed/Backup/NotFound/InvalidTransition/TerminalConflict/ConstraintViolation/InvalidArgument/Closed 等具名子类）。不使用 TreeAIError：契约定位其为"运行期失败"分类，DB 基础设施错误映射为 TreeAIError 是调用方（runtime-smoke/journal）的职责——此偏离在 handoff 中登记。
5. **tests/**（Node 内置 test runner）：空库 migration、重复/二次打开 migration 幂等、双分支关系（含重启后仍在）、session 文件缺失→域数据完整+引用 unavailable 不级联、事务中途失败回滚（含嵌套 savepoint）、并发终态更新不双终态（双连接 + worker_threads 真并发）、状态机全迁移矩阵（合法/非法）、I6 清扫、备份/校验/恢复、损坏文件与外来 DB 明确报错、migration 失败回滚。

运行方式：Node 24 原生 TS type stripping（`node --test "tests/*.test.ts"`，显式 `.ts` 扩展名导入）；包 tsconfig 在 base 之上仅覆写 `allowImportingTsExtensions: true`（base 的 `noEmit: true` 前提下合法），避免任何构建产物。此偏离（与 contracts 内部 `.js` 扩展名约定不同）在 handoff 登记，由 Integrator 决定是否统一。

## 4. 验证命令

```bash
cd packages/persistence
npm test          # 实测 exit 0：tsc --noEmit + node --test（45/45 pass）
npm run typecheck # 实测 exit 0
# 根级（只读验证，不改根配置）：
npm run typecheck # 实测 exit 1：失败全部位于 packages/runtime-pi（非本 Agent 范围）；
                  # @treeai/persistence 已进入 checked 集合且零报错
```

## 5. 阻塞

- 无凭据/环境阻塞（本模块离线可测，全部验证已执行）。
- 跨范围发现（只登记不修改）：根 `npm run typecheck` 当前 exit 1，失败全部在 `packages/runtime-pi`（errors.ts/events.ts/pi-real-port.ts 共 9 处 tsc 报错，属该包维护者范围）。
- 待 Integrator 事项（不阻塞本模块，已随交付登记）：①确认 `node:sqlite` 存储引擎决策（`agent-c-dependency-request.md`，零新依赖）；②Wave 1 接线根 `npm test` 时纳入 `packages/persistence` 的测试入口；③确认包内 `.ts` 扩展名导入约定（无构建产物路线）或指示改为构建路线。

## 6. 执行过程记录（追加；只记录已实际发生的事件）

- 2026-09-21：启动记录落盘（本文件 §1–§5）。随后开始生产代码实现。
- 2026-09-21：`node:sqlite` 关键能力探针在系统临时目录实测通过（FK 强制、触发器、savepoint、条件 UPDATE changes 计数、参数化 `VACUUM INTO`、双连接并发恰好一胜、busy_timeout 生效、非 SQLite 文件报 `file is not a database`、`node --test` 对 `.ts` 测试文件的 glob 形式可用）。探针在 /tmp，未进入仓库。
- 2026-09-21：生产代码完成：`src/errors.ts`、`src/database.ts`、`src/serialization.ts`、`src/tree-repository.ts`、`src/index.ts`、`src/migrations/{0001-initial-schema.ts,index.ts}`；`package.json`（main/types/scripts）与 `tsconfig.json`（allowImportingTsExtensions）更新。期间修复 9 处 tsc 报错（SQLOutputValue 行类型需 `as unknown as` 中转、readonly 赋值、联合变体收窄），修复 `openDatabase` 中垃圾文件在 `PRAGMA journal_mode` 处抛裸驱动错误未映射的问题（现统一 `mapSqliteError` → `DatabaseCorruptError`）。
- 2026-09-21：测试完成：`tests/helpers.ts` + 8 个测试文件（migration、repository-crud、run-state、concurrency+concurrency-worker、session-reference、transactions、recovery、backup）。
- 2026-09-21 验证（真实退出码）：
  - `cd packages/persistence && npx tsc --noEmit -p tsconfig.json` → **exit 0**；
  - `cd packages/persistence && node --test "tests/*.test.ts"` → **exit 0**，45 tests / 45 pass / 0 fail；连跑 5 次全部 45/45、exit 0（含 worker_threads 真并行竞态，无 flake）；
  - `cd packages/persistence && npm test`（typecheck + node --test）→ **exit 0**；
  - 根 `npm run typecheck` → **exit 1**，但失败全部在 `packages/runtime-pi`（9 处 tsc 报错，另一 Agent 范围）；`@treeai/persistence` 已进入 checked 集合且零报错。已按边界只登记不修改。
- 2026-09-21：`packages/persistence/README.md` 完成（ER、事务、migration、备份/恢复、边界、已知限制）。`agent-c-handoff.md` 按 §9 交付。未执行任何 git commit。
