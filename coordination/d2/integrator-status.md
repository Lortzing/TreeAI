# D2 Integrator 状态文件（integrator-status.md）

- 维护者：Integrator（本文件唯一写入者；其他 Agent 不得编辑本文件）
- 创建：2026-09-21（Gate 0 启动记录）
- 阶段：Gate 0（脚手架与契约冻结）— 已完成
- 状态：`PASS`（Integrator 独立复验通过；CONTRACT-FREEZE-1 已签署，ADR-002 已 Accepted，见 §6 与冻结记录）
- 依据：`TreeAI_D2_Agent执行任务书.md` v1.0（D2 起点 commit `866406a`）

## 1. 已读材料（任务书 §12 启动记录要求）

| # | 材料 | 摘取的关键事实 |
|---|---|---|
| 1 | `TreeAI_D2_Agent执行任务书.md` v1.0（2026-09-21，Draft 待负责人确认后生效） | D2 唯一执行入口。六个 Agent + Integrator；严格执行 Gate 0 → Wave 1 → Gate 1 → Wave 2 → Gate 2 → Wave 3；Gate 0 通过前除 Agent A 和 Integrator 外只能读材料、写设计说明。Pi 精确锁定 `0.85.1`，禁 `latest`/`*`/范围/Git HEAD。Pi 类型只能进 `packages/runtime-pi`。d1-spikes 只读。 |
| 2 | `d1-spikes/research/adr-001-draft.md` 顶部批准记录 + §4 数据边界 | ADR-001 **Accepted**（2026-09-20 负责人批准）：候选 1 = TypeScript/Node.js + Pi SDK 进程内嵌入；Pi 0.85.1；同进程风险仅在受信任本地模式接受、非沙箱。§4 硬约束：Pi session JSONL 是 Pi 内部格式，TreeAI 只保存引用三元组（sessionFile/sessionId/entryId）；TreeAI 自有 DB 是 Forest/Tree/Branch/Episode/Run 事实源；写入只经 Pi 官方 API；凭据不复制不代理。 |
| 3 | `d1-spikes/reports/blockers.md` D1 关闭记录与 D2 授权记录 | DECISION-001～009 全部关闭（2026-09-20 负责人批准）：SDK 直嵌、TS/Node 宿主、Pi 0.85.1、Node v24.21.0 / npm 11.19.0 / Python 3.9.6 为 D2 复现基线（偏离需显式升级记录）、最小权限、D1 Go、tree-navigation 纳入正式契约与统一验收。D2 授权：收敛 D1 已验证逻辑为首版运行时，不做通用 Agent Runtime。 |
| 4 | `d1-spikes/reports/d1-verification.md` 最终验收 | 最终验收 `verify-20260920T124525829Z.json`：**30/30 检查全 PASS、exit 0（ALL_PASS）**，含 tree-navigation checks 22/23；验收史 16 条中首个 exit 0；`--repro` 干净复现双侧 PASS；秘密扫描零发现。D1 验收层面无遗留 FAIL/BLOCKED/NOT_RUN。 |
| 5 | 参考：`d1-spikes/sdk-node/package.json`、`d1-spikes/sdk-node/tsconfig.json` | D1 已验证的工具链锁定样本：TypeScript `5.9.3`、`@types/node` `24.13.5`、Pi `0.85.1` 精确版；ES2023 + NodeNext；clean repro（npm ci + 80/80 单测）在此组合上通过。 |

## 2. 理解并承诺的边界

可写范围（本次 Gate 0 实际写入）：

- 根配置：`package.json`、`package-lock.json`、`tsconfig.base.json`、`.gitignore`、根 `README.md`；
- `apps/runtime-smoke/**`（Integrator 独占）；
- `evidence/d2/**`（追加式）；
- `coordination/d2/` 中仅 `integrator-status.md`、`README.md`、`dependency-request-template.md`；
- `scripts/` 中 Integrator 自有的脚手架脚本（`typecheck.js`、`gate0-status.js`），不碰 Agent F 独占的 `scripts/verify-d2*`；
- 五个 package 下的最小 `package.json` / `tsconfig.json` 占位（任务书授权的"必要骨架"）。

不写 / 不做：

- 不实现 `packages/contracts` 或任何其他 Agent 独占模块的正式接口、源码、测试；
- 不替任何 Agent 写状态文件（`agent-a-status.md` 等由各 Agent 自建自写，命名约定见 `coordination/d2/README.md`）；
- 不改 `d1-spikes/**`（只读证据区）、不移动 probe 文件、不改写历史证据；
- 不添加 UI 或生产逻辑；不引入 `latest`/`*`/范围版本/Git HEAD 依赖；
- 不执行 `git commit` / `git push` / 破坏性 git 命令；
- 不覆盖用户现有未提交文件（`.DS_Store`、`TreeAI_D1_Agent执行任务书.md`、`.claude/` 等保持原样；`.gitignore` 对 `.DS_Store` 的忽略只影响 git 显示，不删除文件）。

## 3. 计划（Gate 0 Integrator 任务，对应任务书 Gate 0 节第 1–5 项）

1. npm workspaces 骨架：根 `package.json`（workspaces = `packages/*` + `apps/*`）+ `tsconfig.base.json` + `.gitignore`。
2. 五个 package 的最小占位（`contracts`、`runtime-pi`、`persistence`、`tool-policy`、`event-journal`）：各含 `package.json` + `tsconfig.json`，仅允许依赖 `@treeai/contracts`；Pi `@earendil-works/pi-coding-agent@0.85.1` 只列在 `runtime-pi`。
3. `apps/runtime-smoke` 最小占位（含一个 gate-0 骨架标记 `.ts` 文件，使工具链真实可验证，非生产逻辑）。
4. 统一命令占位：`typecheck`、`test`、`test:integration`、`verify:d2`、`verify:d2:live` 全部存在；未实现的命令明确输出 `NOT_IMPLEMENTED` 并以非零退出码失败（不伪装 PASS）。
5. 生成 `package-lock.json`（实际执行 `npm install`），随后以 `npm ci` 验证干净安装。
6. 协作区：`coordination/d2/README.md`（状态文件约定、依赖申请流程）+ `dependency-request-template.md`。
7. 文档：根 `README.md` 与本文件说明 d1-spikes 只读、Pi 类型隔离、Gate 顺序。
8. 确认 `d1-spikes/` 在 D2 中保持只读（本文件记录 + README 声明）。

版本锁定决定（依据 DECISION-003 与 D1 验证过的工具链）：

| 项 | 锁定值 | 理由 |
|---|---|---|
| Node（engines） | `24.21.0` | DECISION-003 复现基线；偏离需显式升级记录 |
| npm（engines + packageManager） | `11.19.0` | 同上 |
| `typescript`（devDependencies，精确） | `5.9.3` | D1 clean repro 验证过的版本；registry 现有 7.x 但未经 Pi 0.85.1 `.d.ts` 验证，升级须显式记录 |
| `@types/node`（devDependencies，精确） | `24.13.5` | 与 D1 锁定一致（匹配 Node 24 大版本） |
| `@earendil-works/pi-coding-agent`（仅 runtime-pi，精确） | `0.85.1` | ADR-001 批准记录与 DECISION-003 |

## 4. 验证命令（计划；真实结果在 §6 回填）

| 命令 | Gate 0 预期 |
|---|---|
| `npm install` | 生成 `package-lock.json`；exit 0 |
| `npm ci` | 从锁文件干净安装；exit 0 |
| `npm run typecheck` | 真实运行 `tsc`；有源码的 workspace（Gate 0 仅 `apps/runtime-smoke` 骨架）实际检查通过；无源码的 package 显式报告 SKIP（等待模块负责人），不冒充已检查；exit 0 |
| `npm test` | `NOT_IMPLEMENTED`（Wave 1 起接入各模块单测）；exit 3 |
| `npm run test:integration` | `NOT_IMPLEMENTED`（Wave 2 / Gate 2 项）；exit 3 |
| `npm run verify:d2` | `NOT_IMPLEMENTED`（Agent F 交付 `scripts/verify-d2`）；exit 3 |
| `npm run verify:d2:live` | `NOT_IMPLEMENTED`（受控凭据环境，Gate 2/负责人门）；exit 3 |
| `npm ls @earendil-works/pi-coding-agent` | 唯一来源 `@treeai/runtime-pi`，解析为 `0.85.1` |

退出码约定（与任务书 §5 Agent F 验收器约定对齐）：`0` 全部通过；`1` 工具自身错误；`2` 至少一项 FAIL；`3` 无 FAIL 但存在 BLOCKED/NOT_RUN（Gate 0 占位命令用 `3` 表示 NOT_IMPLEMENTED，明确失败、不误报 PASS）。

## 5. 阻塞

- Gate 0 无阻塞。Wave 1 已解锁：Agent B–F 可按任务书独占范围实现；Integrator 负责后续 Gate 1 汇总和根级接线。
- 负责人已通过 2026-09-21 本次会话中的执行指令确认任务书；ADR-002 的 Accepted 记录和 CONTRACT-FREEZE-1 的 PASS 记录已由 Integrator 追加。

### 5.1 Gate 0 验收清单（2026-09-21 复验后）

| 验收项（任务书 Gate 0 节） | 状态 |
|---|---|
| 根目录 `npm ci` 成功 | **已达成**（exit 0，多次验证含最终快照） |
| `npm run typecheck` 成功 | **已达成**——Integrator 复验 exit 0（contracts + runtime-smoke 通过；四模块包无源码被显式 SKIPPED） |
| contracts 测试成功 | **已达成**——`cd packages/contracts && npm test` exit 0（7/7 反例按预期拒绝，Pi 隔离检查通过） |
| 所有 package 可只依赖 contracts 建立空实现 | **已达成**（workspace 链接与依赖声明就位；四个模块尚无源码，属预期） |
| Pi 类型没有泄漏到 contracts | **已达成**（grep 核验，见 §6；Agent A 另有自己的 check-no-pi-imports 脚本） |
| ADR-002 与 Pi 改造升级模板在位 | **已达成**——模板在位，ADR-002 已由 Integrator 记录 Accepted 及负责人确认来源 |
| 负责人确认任务书 + Integrator 在 ADR-002 记录批准来源与日期 | **已达成**——依据 2026-09-21 本次执行指令记录 |
| Integrator 在 CONTRACT-FREEZE-1.md 记录“通过” | **已达成**——2026-09-21 独立复验后签署 |

## 6. 验证结果（2026-09-21T08:15–08:20Z 实际执行；详细记录见 `evidence/d2/gate-0/scaffold-verification-20260921.md`）

| 命令 | 真实退出码 | 摘要 |
|---|---|---|
| `npm install`（生成锁文件） | 0 | 见 §6.1 过程记录 |
| `npm ci` | 0 | 从锁文件干净安装（版本对齐前后及最终快照共三次验证，均 exit 0） |
| `npm run typecheck`（08:20Z 快照） | 0 | 真实运行 `tsc 5.9.3`；checked：`@treeai/runtime-smoke`、`@treeai/contracts`（Agent A 该时点 9 个 src 文件编译通过）；skipped（显式、不计入已检查）：`runtime-pi`/`persistence`/`tool-policy`/`event-journal`（无源码，等待负责人） |
| `npm run typecheck`（最终快照，08:2xZ） | **1** | Agent A 正在并行写入 `packages/contracts/tests/type-tests.ts`，处于中间态（`TS1128: Declaration or statement expected`，194 行 47 列——其独占范围内的在制品，Integrator 不代修）。`@treeai/runtime-smoke` 检查通过；编排器如实将 `@treeai/contracts` 判 FAIL。**该 exit 1 属 Agent A 交付进行中的真实状态，非脚手架缺陷；待其完成后必须复验** |
| `npm test` | 3 | NOT_IMPLEMENTED 占位（明确失败，不误报 PASS） |
| `npm run test:integration` | 3 | 同上 |
| `npm run verify:d2` | 3 | 同上（Agent F 交付前占位） |
| `npm run verify:d2:live` | 3 | 同上 |
| `npm ls @earendil-works/pi-coding-agent` | 0 | 唯一依赖方 `@treeai/runtime-pi`，精确 `0.85.1` |
| Pi 隔离 grep（packages/apps/scripts 源码） | 0 发现 | Pi 依赖只出现在 `packages/runtime-pi/package.json`；其余命中均为文档政策声明 |
| `git status -- d1-spikes/` | 无改动 | d1-spikes 只读完整性保持 |

### 6.1 过程记录（集成事件）

1. 首次 `npm install` 使用 `workspace:*` 内部依赖协议失败（npm `EUNSUPPORTEDPROTOCOL`——该协议属 pnpm/yarn）。修正为 npm 原生的精确版本匹配（依赖方声明 `@treeai/contracts` 精确版本号，npm 据此链接本地 workspace），保持"无 `*`/范围版本"纪律。
2. 验证期间 Agent A 并行交付 `packages/contracts` 并将版本升至 `0.1.0`（其独占范围内的正当动作，Integrator 未改动其文件内容）。Integrator 执行了版本对齐集成动作：将 `runtime-pi`/`persistence`/`tool-policy`/`event-journal`/`runtime-smoke` 五处 `@treeai/contracts` 声明从 `0.0.0` 对齐为 `0.1.0`（均为 Integrator 创建的占位 package.json，属根 workspace 接线职责），随后重新生成锁文件并复跑 `npm ci`（exit 0）。
3. npm 11 install-scripts 提示（非阻塞）：Pi 传递依赖 `esbuild@0.28.1`、`protobufjs@7.6.5` 的 postinstall 与 `@google/genai@1.52.0` 的 preinstall 未获 allowScripts 批准、未执行。Gate 0 仅类型检查不受影响；Agent B 进入运行时实测前需按 dependency request 流程决定是否批准。
4. 退出码测量注意：任何经管道（`| grep`/`| tail`）的测量取到的是管道末命令的退出码；本文件所有退出码均为无管道直接捕获（第一次占位命令验证曾因此显示假 EXIT=0，已重测修正——占位命令真实退出码为 3）。
5. 并行交付快照效应：Agent A 在 Integrator 验证期间持续写入 contracts（src 9 文件 → 含 index.ts 与 tests/ 的更完整形态）。`npm run typecheck` 的两次快照（exit 0 → exit 1）均为真实测量；exit 1 直接源于其写入中间态的语法错误，不构成对脚手架或 Agent A 最终交付的判定。Gate 0 的 typecheck 验收以 Agent A 交付完成后的复验为准。

## 7. 修改文件清单（本次 Gate 0 Integrator 写入）

```text
package.json                          # 根 workspace 配置（engines/workspaces/scripts/devDeps）
package-lock.json                     # npm install 生成（lockfileVersion 3）
tsconfig.base.json                    # 共享 TS 基线（ES2023/NodeNext/strict/noEmit）
.gitignore                            # node_modules/构建产物/凭据形态文件/.DS_Store
README.md                             # 根 README（d1-spikes 只读、Pi 隔离、Gate 顺序、命令表）
scripts/typecheck.js                  # Integrator 工具：workspace typecheck 编排（跳过无源码包并明示）
scripts/gate0-status.js               # Integrator 工具：未实现命令的 NOT_IMPLEMENTED 占位（exit 3）
packages/contracts/package.json       # 最小占位（后被 Agent A 替换为其正式 v0.1.0——Agent A 独占）
packages/contracts/tsconfig.json      # 最小占位（后被 Agent A 替换——Agent A 独占）
packages/runtime-pi/package.json      # 最小占位；Pi 0.85.1 精确版仅列于此
packages/runtime-pi/tsconfig.json     # 最小占位（extends tsconfig.base.json）
packages/persistence/package.json    # 最小占位；仅依赖 @treeai/contracts
packages/persistence/tsconfig.json   # 同上模式
packages/tool-policy/package.json    # 同上模式
packages/tool-policy/tsconfig.json   # 同上模式
packages/event-journal/package.json  # 同上模式
packages/event-journal/tsconfig.json # 同上模式
apps/runtime-smoke/package.json      # 最小占位；依赖五个 workspace 包
apps/runtime-smoke/tsconfig.json     # 最小占位
apps/runtime-smoke/src/gate0-skeleton.ts  # 骨架标记文件（无产品逻辑，Wave 2 替换）
coordination/d2/README.md            # 协作区约定（状态文件/依赖流程/退出码/秘密纪律）
coordination/d2/dependency-request-template.md
coordination/d2/integrator-status.md # 本文件
evidence/d2/README.md                # 证据区规则（追加式）
evidence/d2/gate-0/scaffold-verification-20260921.md  # 本次验证的命令与退出码记录
docs/proposals/PI-CHANGE-template.md # Pi 改造升级提案模板（任务书 §4.2；应 Agent A 请求由 Integrator 落盘）
```

未改动：`d1-spikes/**`（只读）、用户未跟踪文件（`.DS_Store`、`TreeAI_D1_Agent执行任务书.md`、`.claude/`——`.gitignore` 仅忽略 git 显示，不删文件）、Agent 独占模块的生产内容（contracts 正式内容由 Agent A 自行替换，Integrator 只创建了初始占位）。未执行 `git commit`/`git push`。

