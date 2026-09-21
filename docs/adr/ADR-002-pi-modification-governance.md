# ADR-002：Pi 改造治理（Pi Modification Governance）

- **状态：Accepted（2026-09-21）**
- 创建日期：2026-09-21
- 作者：Agent A（D2 Gate 0）
- 决策权：负责人
- 负责人确认来源：2026-09-21 本次会话中负责人要求按本任务书调用子 Agent 完成 D2；Integrator 据此记录批准。
- 上游已批准事实：ADR-001（Accepted，2026-09-20 负责人批准候选 1：TypeScript/Node.js + Pi SDK 进程内嵌入，Pi 精确版本 0.85.1）及其 §4 数据边界；D1 Go 与 D2 授权记录（`d1-spikes/reports/blockers.md`）

> **状态说明（不可移除）**：本 ADR 的治理内容与《TreeAI D2 Agent 执行任务书》（文档版本 1.0，2026-09-21）第 4 节一致；任务书 §5 Gate 0 指定由 Agent A 创建本 ADR 并初始标记为 Proposed。负责人已在 2026-09-21 本次会话中要求按任务书调用子 Agent 完成 D2，Integrator 据此记录批准来源与日期，本 ADR 现为 Accepted。

## 1. 背景与上下文

ADR-001 已批准 TreeAI 首版以 TypeScript/Node.js 进程内嵌入 Pi SDK（精确版本 0.85.1）。D1 的关键教训：

- Pi 发布节奏快且有回归先例（0.85.0 SDK 导入损坏、RPC abort 缺陷，0.85.1 修复；ADR-001 §1）。
- 扩展注册的 provider 须经 `createAgentSessionServices()` 加载后才可见——实现路径选择直接影响行为（D1 BLOCKED 教训）。
- TreeAI 依赖 Pi 的原生 `navigateTree`、steer（同一 agent run 新 turn）、abort 与 session 恢复语义，这些语义是 D2 正式回归能力（DECISION-009）。

因此，D2 期间对 Pi 的任何"超出公开 SDK 用法"的改造都必须被治理：既不能让 Agent 为通过测试而随意改 Pi，也不能在真正需要升级/修补时无据可查。

**适用范围**：本 ADR 治理的是"对 Pi 的改造与依赖方式"。TreeAI 自有契约的破坏性变更走另一条流程（`CONTRACT-CHANGE-xxx`，由 Agent A 发起、Integrator 批准，见 `docs/d2/contracts-README.md`）；两者不可混用。

## 2. 决策：分级治理（L0–L4）

| 层级 | 做法 | Agent 权限 |
|---|---|---|
| L0 | 使用 Pi 公开 SDK | 可直接实施 |
| L1 | 使用 Pi extension、custom tool、事件钩子和受支持配置 | 可实施，但须记录依赖的公开 API |
| L2 | 在 `PiRuntime` 内建立兼容 shim、错误归一化和状态补偿 | 可实施，不得改变 Pi 持久化格式 |
| L3 | 向 Pi 上游提交 issue/PR | 先提交提案，负责人决定是否进行外部动作 |
| L4 | 临时补丁、vendor commit 或受控 fork | 必须单独 ADR，Agent 不得自行实施 |

补充约束：

- L1 记录义务：使用 extension/custom tool/事件钩子的模块必须在交付物中列出所依赖的公开 API 面（Agent B 的"Pi API surface 清单"即此义务）。
- L2 边界：shim 只做归一化与补偿，**不得**改变 Pi 持久化格式（session JSONL）或伪造 Pi 语义（如用多 session 模拟原生 `navigateTree` 的同 session 语义来"通过"测试）。

## 3. 必须暂停并升级的条件

出现以下任一情况，相关 Agent 必须**停止该功能实现**并创建 `docs/proposals/PI-CHANGE-<序号>.md`（模板见附录 A）：

- 需要修改 Pi 源码；
- 需要 import Pi 未公开的内部路径；
- 需要 monkey patch、覆盖原型或编辑 `node_modules`；
- 需要直接写 Pi session JSONL；
- 需要改变 `navigateTree`、steer、abort 或 session 恢复语义；
- 需要提高 Pi 版本或使用未固定版本；
- SDK 缺陷会迫使 TreeAI 改变已批准的产品语义。

提案必须包含：最小复现、用户影响、公开 API 为何不足、L0–L2 方案为何失败、拟修改位置、测试方案、升级/回滚成本、是否可上游贡献。**未获负责人批准前只允许写提案和失败测试。**

## 4. 明确禁止

- 静默编辑 `node_modules`；
- 将补丁隐藏在安装脚本中；
- 未固定上游 commit 的 Git 依赖；
- 为通过测试而读取或改写用户真实 Pi 配置；
- 将临时 fork 描述成官方 Pi；
- 在证据中隐藏 fork、补丁或私有 API 使用情况。

## 5. 后果

- **正向**：Pi 依赖方式全程可审计；版本升级（含未来 0.85.1 → 更高版本）有明确的升级路径（L3/L4 + D1 五场景与 tree-navigation 回归门禁 `./d1-spikes/scripts/verify-d1 --repro`）；SDK 行为与 TreeAI 期望的偏差有登记处（PI-CHANGE 提案），不会散落在各 Agent 的临时 workaround 里。
- **负向/成本**：遇到 SDK 缺陷时交付速度受影响（只能写提案与失败测试，不能立即修补）；上游 PR 的周期不可控。
- **风险**：若治理过严导致 Wave 1/2 大量功能停在提案状态，应升级到负责人重新权衡（那本身是合法的治理输出，不是流程失败）。

## 6. 与其他流程的关系

| 场景 | 走哪条流程 | 发起人 | 批准人 |
|---|---|---|---|
| TreeAI 契约破坏性变更（本包类型/接口） | `CONTRACT-CHANGE-xxx`（`docs/d2/contracts-README.md`） | Agent A | Integrator |
| Pi 改造/版本/私有 API（本 ADR §3） | `PI-CHANGE-<序号>` 提案 → 负责人 | 任一 Agent（停手后） | 负责人 |
| 跨 Agent 写入范围的修改 | 状态文件提出 → `agent-<id>-dependency-request` 等登记 | 需求方 Agent | Integrator |

## 附录 A：PI-CHANGE 提案模板

> 正式落盘位置：`docs/proposals/PI-CHANGE-template.md`（已由 Integrator 于 2026-09-21 落盘，
> 内容覆盖本附录所列全部必填节）。复制为 `docs/proposals/PI-CHANGE-<序号>.md` 使用。
> 以下保留等价内容作为本 ADR 的自包含附录；两者如有出入，以落盘模板为准并在此同步。

```markdown
# PI-CHANGE-<序号>：<一句话标题>

- 提出人 / 日期：
- 触发层级：L3 | L4（如为源码修改/私有路径/版本变更，注明对应 §3 条款）
- 状态：Proposed（负责人批准前不得实施）

## 1. 最小复现
（可独立重放的复现步骤或失败测试路径）

## 2. 用户影响
（不改的情况下，TreeAI 用户会遇到什么）

## 3. 公开 API 为何不足
（列出已尝试的公开 API 及其失败证据）

## 4. L0–L2 方案为何失败
（逐层说明）

## 5. 拟修改位置
（上游文件/版本/commit；如为 L4，说明 fork 与补丁形态）

## 6. 测试方案
（如何证明修改有效且不引入回归，含 D1 回归门禁）

## 7. 升级/回滚成本
（依赖面、锁定策略、退出路径）

## 8. 是否可上游贡献
（是/否/待定，理由）

## 9. 负责人决定记录
（负责人批准/驳回后由 Integrator 追加；Agent 不得代填）
```
