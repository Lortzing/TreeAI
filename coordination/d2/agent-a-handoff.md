# Agent A Handoff

- Agent：A（架构契约、领域类型、状态机、ADR 与跨模块接口）
- 日期：2026-09-21
- 对应任务：任务书 §5 Gate 0 Agent A 任务 1–5

## 状态

PASS

（含义：Agent A 范围内的 Gate 0 任务全部执行完毕且局部验证通过。
**这不等于 Gate 0 通过**——Gate 0 验收仍需 Integrator 复验并签署
`CONTRACT-FREEZE-1.md`、负责人确认任务书后在 ADR-002 记录批准来源与日期。）

## 完成内容

1. 创建 `packages/contracts`（纯类型包：仅 `export type`/`export interface`，
   无运行时代码、无第三方依赖、无 Pi import），定义任务书 §3.3 全部七项冻结契约：
   - `PiRuntime` 领域接口（createSession/restoreSession/prompt/steer/abort/
     navigateTree/subscribe/dispose，含单活跃会话模型、幂等 abort/dispose、
     会话替换重订阅、失败语义与前置条件边界）；
   - `SessionReference`（sessionFile/sessionId/entryId/piVersion/availability，
     引用而非内嵌，附 ADR-001 §4 边界为不变量）与 `PinnedPiVersion = "0.85.1"`；
   - Forest/Tree/Branch/Episode/Run 品牌化标识、实体关系形状与 Locator 定位器；
   - `RunState` 六态 + `RunStateTransitions` 迁移表 +
     `AllowedRunStateTransition` 编译期检查 + 不变量 I1–I7（含重启恢复规则）；
   - `TreeAIEvent`（eventId/runId/严格递增 seq/时间/开放类型联合/脱敏 payload/
     证据引用）与运行时事件 `PiRuntimeEvent`（前向兼容未知事件）；
   - `TreeAIError` 8 类封闭分类 + 分类边界（编程错误走平台 TypeError）；
   - `ToolDecision`（allow/deny/require-approval + category/risk/reason/ruleId/
     目录范围），默认拒绝与"非安全边界"表述入文。
2. 为 B–F 与 runtime-smoke 提供消费方编译示例（`tests/usage-examples.ts`：
   B 实现 fake PiRuntime、C 域数据/引用分离与 degraded 引用、D 三类决定构造、
   E 事件转换与状态投影 helper、smoke 编排流程）与正向类型断言
   （`tests/type-tests.ts`：迁移表、枚举封闭性、品牌不可互换、接口签名形状）。
3. 7 个反例类型测试（`tests/negatives/`，每例独立 tsconfig，必须编译失败）：
   品牌互换、非法终态迁移（直接与经 helper）、错误码越界、决定 outcome 越界、
   SessionReference 缺 entryId、Pi 版本漂移。
4. `docs/adr/ADR-002-pi-modification-governance.md`：初始 Proposed；内容与
   任务书 §4 一致（L0–L4 分级、升级条件、明确禁止、与 CONTRACT-CHANGE 的分界）；
   附 PI-CHANGE 提案模板附录（正式模板已由 Integrator 落盘
   `docs/proposals/PI-CHANGE-template.md`，ADR 附录指向之）。
   **未伪造任何负责人批准**；批准来源与日期待负责人确认任务书后由 Integrator 记录。
5. `docs/d2/contracts-README.md`：契约使用说明、依赖方向与 Pi 类型隔离规则、
   关键设计决定、CONTRACT-CHANGE 破坏性变更流程。
6. `coordination/d2/CONTRACT-FREEZE-1.md`：冻结记录（七项→文件映射、变更规则、
   实测验证命令与退出码、待 Integrator 验收清单、设计取舍备案）；
   状态为"Agent A 已发布，待 Integrator 验收"。
7. `coordination/d2/agent-a-status.md`：启动记录（已读材料、边界、计划、验证命令、
   阻塞）与执行结果回填。

## 修改文件

```text
packages/contracts/package.json                                   # 新建（替换 Integrator 占位，属 Agent A 独占范围）
packages/contracts/tsconfig.json                                  # 新建；extends ../../tsconfig.base.json
packages/contracts/src/{index,branding,json,identifiers,session-reference,run-state,errors,events,tool-decision,pi-runtime}.ts
packages/contracts/tests/{type-test-utils,type-tests,usage-examples}.ts
packages/contracts/tests/negatives/{7 用例目录}/…                 # 每例 tsconfig.json + index.must-fail.ts
packages/contracts/scripts/run-negative-type-tests.sh             # 反例编排（TSC 可覆盖）
packages/contracts/scripts/check-no-pi-imports.sh                 # Pi 隔离检查
docs/adr/ADR-002-pi-modification-governance.md                    # 新建
docs/d2/contracts-README.md                                       # 新建
coordination/d2/CONTRACT-FREEZE-1.md                              # 新建（任务书 §5 Gate 0 Agent A 任务 5 指定）
coordination/d2/agent-a-status.md                                 # 新建
coordination/d2/agent-a-handoff.md                                # 本文件
```

未修改：根 `package.json`/`package-lock.json`/`tsconfig.base.json`（Integrator 独占，
本次仅只读引用）、`d1-spikes/**`（只读；曾只读执行其已安装的 tsc 二进制）、
其他 package、其他 Agent 的协调文件、根 README。

## 验证命令与退出码

工作期间根 workspace 由 Integrator 并行交付（TypeScript 5.9.3 已固定并安装）。
以下为 Agent A 交付完成后的最终实测（2026-09-21，均无管道直接捕获退出码）：

- command: `npm run typecheck`（仓库根）
  exit: 0
  （checked：`@treeai/runtime-smoke`、`@treeai/contracts`；runtime-pi/persistence/
  tool-policy/event-journal 无源码被显式 SKIPPED——编排器如实报告，不计入已检查）
- command: `cd packages/contracts && npm test`
  exit: 0
  （= `tsc --noEmit -p tsconfig.json` + 7/7 negatives rejected as expected +
  no Pi imports in src+tests）
- command: `bash packages/contracts/scripts/check-no-pi-imports.sh`
  exit: 0
- command: `npm test`（仓库根）
  exit: 3
  （Integrator 的 NOT_IMPLEMENTED 占位，诚实"未接线"信号，非 contracts 失败；
  contracts 层测试以上一条为准）

历史过程记录：早期（根 workspace 就位前）以
`d1-spikes/sdk-node/node_modules/.bin/tsc`（5.9.3，只读执行）完成等价验证
（typecheck 0 / negatives 0 / isolation 0）；期间一次中间态语法错误
（type-tests.ts TS1128）被 Integrator 的并行 typecheck 如实捕获为 exit 1，
已修复并在最终态复验为 exit 0。开发中一次反例误通过（never 返回类型不产生
赋值错误）与一次隔离检查误报（文档注释含包名）均已修复并有对应反例覆盖。

## 证据

- 契约不变量的正式文本：`packages/contracts/src/*.ts` 文件头注释
  （`run-state.ts` I1–I7、`events.ts` seq/脱敏/追加纪律、`errors.ts` 分类边界、
  `session-reference.ts` ADR-001 §4 边界、`tool-decision.ts` 默认拒绝与非安全边界表述）。
- 类型级测试：`packages/contracts/tests/`（正向断言 + 消费方示例 + 7 反例）。
- 冻结记录与验收清单：`coordination/d2/CONTRACT-FREEZE-1.md`。
- 本任务未产生运行时证据（纯类型工作，无模型调用、无凭据、无 Pi session）。

## 已知限制

1. **类型测试 ≠ 运行时测试**：contracts 的"测试"是编译期断言（任务书 Gate 0
   Agent A 任务 4 明确要求"编译期类型测试"）。不变量的运行时强制（非法迁移拒绝、
   双终态拒绝、seq 重复检测、脱敏实效）属 Wave 1 各实现方（C/E/F）的单测职责，
   契约只提供类型面与不变量文本。
2. `TreeAIEvent.payload` / `TreeAIError.details` 的"已脱敏"是文档化不变量，
   类型系统无法强制；由 event-journal/runtime-pi 的实现与测试兜底。
3. `Run.failure`（存在 iff failed）、`terminalAt`（非空 iff 终态）等一致性
   约束是文档化不变量，编译期不可判定。
4. 根 `npm test` 尚未接入 contracts 测试（Integrator 占位 exit 3）；
   Wave 1 接线前，contracts 测试入口为 `cd packages/contracts && npm test`。
5. `docs/proposals/` 的 PI-CHANGE 模板已由 Integrator 落盘；ADR-002 附录 A
   与其内容等价，如两者出现分歧以落盘模板为准（ADR 内已声明该规则）。
6. 反例脚本默认 `TSC=tsc`（PATH 解析）；在 workspace 依赖安装就位的当前仓库
   环境可直接运行，干净环境需先 `npm ci`。

## 接口偏离

- 无 CONTRACT-CHANGE（冻结即首次发布，尚无既有调用方）。
- 设计取舍已备案于 `CONTRACT-FREEZE-1.md` §4.6（不增设 `interrupted` 第七态、
  不增设编程错误码、`PiSessionInit` 最小字段集），如负责人/Integrator 不同意，
  走 CONTRACT-CHANGE 流程修订。

## Pi 改造需求

- 无 PI-CHANGE。contracts 未触碰 Pi 包、未 import Pi 类型、未使用私有路径。
  （对实现方的提醒已写入契约文档：steer/navigateTree/session 恢复语义以
  Pi 0.85.1 实测为准，实现发现偏差应触发 ADR-002 §3 的 PI-CHANGE 流程，
  不得改检查器迁就。）

## 需要 Integrator 处理

1. **Gate 0 复验与签署**：按 `CONTRACT-FREEZE-1.md` §3.1 复跑验证；
   若通过，在该文件记录"通过"与日期（Agent A 不代签）。
2. **ADR-002 批准记录**：负责人确认任务书后，在 ADR-002 状态区记录批准来源
   与日期（Gate 0 验收条件之一；Agent A 不代填）。
3. **根 `npm test` 接线**（Wave 1）：把 contracts 的 `npm test`
  （typecheck + 反例 + Pi 隔离检查）纳入根测试入口。
4. **`"types": "./src/index.ts"` 接线确认**：纯类型包无构建产物，Integrator
   如改用 project references / 路径映射 / 发布产物，自行调整并保持
   `@treeai/contracts` 可解析（当前各包依赖声明已对齐 0.1.0）。
5. **契约审查**：请对照 `CONTRACT-FREEZE-1.md` §1 的冻结映射与 §4.6 取舍备案
   审查；B–F 对契约的任何不满走 CONTRACT-CHANGE，不要各自另建平行类型。
6. 无 dependency request（contracts 零依赖；TypeScript 5.9.3 已由 Integrator
   在根固定，与本地验证版本一致）。
