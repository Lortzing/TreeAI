# Agent A 状态文件（D2 Gate 0）

- Agent：A（架构契约、领域类型、状态机、ADR 与跨模块接口）
- 启动时间：2026-09-21
- 本文件仅由 Agent A 维护；Integrator 汇总时只读引用。

## 1. 启动记录（按任务书 §12 要求）

### 1.1 已读材料

1. `/Users/tal/Downloads/TreeAI_D2_Agent执行任务书.md`（D2 唯一执行入口，文档版本 1.0，2026-09-21）。
2. `d1-spikes/research/adr-001-draft.md`——顶部批准记录（2026-09-20 负责人批准 D1 Go、候选 1：TypeScript/Node.js + Pi SDK 进程内嵌入、锁定 Pi 0.85.1、授权 D2）与 §4 数据边界（TreeAI 数据库为产品事实源；Pi session 仅作引用三元组 sessionFile/sessionId/entryId；删除 Pi session 不得破坏域数据；写入仅经 Pi 官方 API）。
3. `d1-spikes/reports/blockers.md`——D1 负责人决定记录（DECISION-001~009 全部关闭）、D2 授权记录（模块边界：PiRuntime / TreeRepository / SessionReference / EventJournal / ToolPolicy）。
4. `d1-spikes/reports/d1-verification.md`——最终验收 `verify-20260920T124525829Z.json`，30/30 PASS、exit 0；tree-navigation 为正式验收项（checks 22/23）；§13 负责人批准与 D2 授权记录。

已确认上游事实（作为契约设计输入，不再重新验证）：

- ADR-001 **Accepted**（负责人 2026-09-20 批准候选 1）。
- D1 基线：Pi `0.85.1`、Node `v24.21.0`、npm `11.19.0`（与当前本机一致）。
- D1 实测语义（单版本观察）：steer 为同一 agent run 内新 turn（单 `agent_start`）；`navigateTree` 同 session 移动叶指针、上下文按目标分支重建、条目数不变；abort 后 `isStreaming=false`、promise 收敛；session 恢复以 sessionFile+sessionId 跨进程完成。
- RPC 侧无 `navigateTree` 等价命令——已被负责人定为路线选择输入，SDK 路线下 TreeAI 必须保留原生 `navigateTree` 语义。

### 1.2 理解的边界

- **独占写入范围**：`packages/contracts/**`、`docs/adr/**`、`docs/d2/contracts-*`、`coordination/d2/agent-a-*`。任务书 §5 Gate 0 另行指定由 Agent A 发布 `coordination/d2/CONTRACT-FREEZE-1.md`，本任务据此创建该文件（其"通过"结论只能由 Integrator 记录）。
- **禁止修改**：根 `package.json`/`package-lock.json`/`tsconfig*`（尚未存在，也**不得由我创建**——属 Integrator）、`d1-spikes/**`（只读证据区）、其他任何 package。
- **Pi 类型隔离**：contracts 不得 import `@earendil-works/pi-coding-agent` 或任何 Pi 内部路径；只定义 TreeAI 自有类型；原始 Pi 事件只能以受控、脱敏的 payload 形式存在，不得成为领域层必填结构。
- **不做通用 RuntimeAdapter**：`PiRuntime` 是 TreeAI 专属领域接口，不是多 Runtime 适配协议。
- **不引入 runtime 依赖**：contracts 为纯类型包（`export type` / `export interface`），无第三方依赖、无运行时代码。
- **版本策略**：Pi 精确版本 `0.85.1`（ADR-001/DECISION-003）；TypeScript 版本由 Integrator 固定，我不在 package.json 中写死 TypeScript 依赖版本，避免与 Integrator 决策冲突。
- **ADR-002**：初始 `Proposed`，内容与任务书 §4 一致；批准来源与日期只能由 Integrator 在负责人确认任务书后记录，我不代填。
- **状态诚实**：Gate 0 未验收前，所有产出状态均为"Agent A 已交付、待 Integrator 验收"，不冒充通过。

### 1.3 计划修改目录

```text
packages/contracts/            # 新建：可编译的纯类型契约包
├── package.json
├── tsconfig.json
├── src/                       # index + 领域模块（见 §1.4 冻结清单）
└── tests/                     # 编译期类型测试 + 消费方编译示例 + 反例（应编译失败）
docs/adr/ADR-002-pi-modification-governance.md   # 新建：Proposed
docs/d2/contracts-README.md                       # 新建：契约使用说明/依赖方向/破坏性变更流程
coordination/d2/CONTRACT-FREEZE-1.md              # 新建：冻结记录（状态=待 Integrator 验收）
coordination/d2/agent-a-status.md                 # 本文件
coordination/d2/agent-a-handoff.md                # 交付交接（任务书 §9 格式）
```

### 1.4 计划冻结的契约（任务书 §3.3 七项）

1. `PiRuntime`：createSession / restoreSession / prompt / steer / abort / navigateTree / subscribe / dispose。
2. `SessionReference`：sessionFile / sessionId / entryId / Pi 版本信息 / 可用性。
3. 领域标识：Forest / Tree / Branch / Episode / Run 的 ID（品牌化类型）与关联关系。
4. `RunState`：queued / running / aborting / succeeded / failed / aborted + 迁移表与不变量。
5. `TreeAIEvent`：eventId / runId / 严格递增 seq / 时间 / 类型 / 脱敏 payload / 原始证据引用。
6. `TreeAIError`：auth / model-unavailable / user-abort / timeout / policy-denied / upstream / session-corrupt / unknown。
7. `ToolDecision`：allow / deny / require-approval + 原因 / 规则 / 目录范围 / 风险级别。

### 1.5 验证命令（实际执行情况见 §2）

> 更新：Agent A 工作期间，Integrator 并行交付了根 workspace 脚手架
> （根 `package.json`、锁文件、`tsconfig.base.json`、TypeScript 5.9.3、
> `scripts/typecheck.js` 等）。contracts 的 `tsconfig.json` 据此改为
> `extends ../../tsconfig.base.json`（NodeNext 解析，相对导入带 `.js` 扩展名），
> 最终验证以根/包级 npm 入口为准（§2）。

交付完成后的验证入口：

```bash
# 根统一类型检查
npm run typecheck
# contracts 包级测试（typecheck + 反例 + Pi 隔离）
cd packages/contracts && npm test
# 单步等价命令
./node_modules/.bin/tsc --noEmit -p packages/contracts/tsconfig.json
TSC=./node_modules/.bin/tsc bash packages/contracts/scripts/run-negative-type-tests.sh
bash packages/contracts/scripts/check-no-pi-imports.sh
```

历史说明：根 workspace 就位前，曾以 `d1-spikes/sdk-node/node_modules/.bin/tsc`
（TypeScript 5.9.3，只读执行 D1 已安装依赖，不修改 d1-spikes、不安装新依赖）
完成等价验证；根就位后改用根 `node_modules` 的同版本 tsc 复验，结果一致。

### 1.6 阻塞与依赖

- ~~根 workspace 阻塞~~：Integrator 已于 2026-09-21 并行交付脚手架（见 §1.5 更新），
  contracts 已对齐（extends tsconfig.base.json、版本 0.1.0 与各包依赖声明一致）。
- **仍待 Integrator**：Gate 0 复验与 `CONTRACT-FREEZE-1.md` 签署；负责人确认
  任务书后在 ADR-002 记录批准来源与日期；Wave 1 将 contracts 测试接入根 `npm test`。
- 无凭据、无环境阻塞（纯类型工作，无模型调用）。

## 2. 执行结果（2026-09-21 回填）

- **状态：PASS（Agent A 范围内；Gate 0 整体验收仍待 Integrator，详见 handoff）。**
- 交付与验证明细见 `coordination/d2/agent-a-handoff.md`（任务书 §9 格式）。
- 最终实测退出码（无管道直接捕获）：
  - `npm run typecheck`（仓库根）：**0**
  - `cd packages/contracts && npm test`：**0**（含 7/7 反例如预期被拒绝、Pi 隔离检查通过）
  - `bash packages/contracts/scripts/check-no-pi-imports.sh`：**0**
  - `npm test`（仓库根，Integrator 占位）：**3**（NOT_IMPLEMENTED，非 contracts 失败）
- 过程中修复的问题：type-tests 一处语法错误（TS1128，曾被 Integrator 并行
  typecheck 捕获为 exit 1，已修复）；反例 helper 的 never 返回类型不产生赋值
  错误（改为错误标记元组）；隔离检查误报文档注释中的包名（改写注释）。
- 文档同步：`CONTRACT-FREEZE-1.md`、`contracts-README.md` 已更新为
  "根 workspace 已交付" 的当前事实；ADR-002 附录指向 Integrator 落盘的
  `docs/proposals/PI-CHANGE-template.md`。
