# TreeAI 契约使用说明（contracts-README）

- 适用范围：`packages/contracts`（`@treeai/contracts`）——D2 Gate 0 冻结的领域契约包。
- 冻结记录：`coordination/d2/CONTRACT-FREEZE-1.md`。
- 维护人：Agent A（独占 `packages/contracts/**`）；破坏性变更由 Integrator 批准。

## 1. 这个包是什么、不是什么

**是**：TreeAI 各生产模块之间共享的**纯类型契约**——领域标识、关系、状态机、事件、错误分类、工具策略决定和 `PiRuntime` 领域接口。只导出 TypeScript 类型/接口（`export type` / `export interface`），**无运行时代码、无第三方依赖**。

**不是**：
- 不是通用多 Runtime 适配协议（D2 明确不做，ADR-001 批准记录）；
- 不是 Pi SDK 的类型镜像——**本包不 import Pi**，Pi 类型只允许出现在 `packages/runtime-pi` 内部（Pi 类型隔离，任务书 §3.2）；
- 不是存储 schema——persistence（Agent C）拥有数据库 schema、迁移与事务；本包提供的是跨模块交换域数据时的公共形状。

## 2. 模块地图

| 源文件 | 冻结内容（任务书 §3.3 对应项） |
|---|---|
| `src/branding.ts` | 品牌类型工具（编译期防混用，无运行时成本） |
| `src/json.ts` | `JsonValue` / `JsonRecord`（payload 表示基础） |
| `src/identifiers.ts` | 第 3 项：Forest/Tree/Branch/Episode/Run 标识与关系；`Run` 实体；定位器（Locator）类型 |
| `src/session-reference.ts` | 第 2 项：`SessionReference`（sessionFile/sessionId/entryId/Pi 版本/可用性）；`PinnedPiVersion = "0.85.1"` |
| `src/run-state.ts` | 第 4 项：`RunState` 六态 + `RunStateTransitions` 迁移表 + `AllowedRunStateTransition` 编译期检查 + 不变量 I1–I7 |
| `src/errors.ts` | 第 6 项：`TreeAIError` 8 类封闭分类 |
| `src/events.ts` | 第 5 项：`TreeAIEvent`（eventId/runId/seq/时间/类型/脱敏 payload/证据引用）与 `PiRuntimeEvent`（运行时事件包络） |
| `src/tool-decision.ts` | 第 7 项：`ToolDecision`（allow/deny/require-approval + 原因/规则/目录范围/风险级别） |
| `src/pi-runtime.ts` | 第 1 项：`PiRuntime`（createSession/restoreSession/prompt/steer/abort/navigateTree/subscribe/dispose） |
| `src/index.ts` | 汇总再导出 |

每个文件头部的注释是该契约**不变量的正式文本**（如 `run-state.ts` 的 I1–I7、`events.ts` 的 seq/脱敏/追加纪律）。实现方的测试必须覆盖自己负责的不变量，不得以 TODO 隐藏失败。

## 3. 依赖方向（任务书 §3.1）

```text
apps/runtime-smoke
  ├── runtime-pi ───────┐
  ├── persistence ──────┤
  ├── tool-policy ──────┼──> contracts
  └── event-journal ────┘
```

规则：

1. 四个生产 package 与 runtime-smoke **只**依赖 `@treeai/contracts`，不得横向直接依赖。
2. `@earendil-works/pi-coding-agent` 只能被 `packages/runtime-pi` 直接依赖；contracts/persistence/tool-policy/event-journal 不得 import Pi 类型（`packages/contracts/scripts/check-no-pi-imports.sh` 对 contracts 强制这一点）。
3. 需要横向协作时，把共享形状放进 contracts（经 Agent A）；确需横向依赖必须由 Agent A 记录原因、Integrator 批准。
4. TreeAI 对外只暴露自己的 session reference、event、error 和 run-state 类型；原始 Pi 事件只能作为受控、脱敏的审计 payload 存在（`PiRuntimeEvent`），不得成为领域层必填结构。

## 4. 如何消费

- 导入统一从包入口：`import type { RunState, SessionReference, TreeAIEvent } from "@treeai/contracts";`（workspace 名称解析待 Integrator 接线，见 §7）。
- 一律 `import type`：本包没有运行时导出。
- 品牌标识（`RunId` 等）底层是 string，构造用显式断言（`"run-1" as RunId`）；混用不同标识在编译期报错。
- 编译期示例与类型测试位于 `packages/contracts/tests/`：
  - `type-tests.ts`——正向断言（迁移表、枚举封闭性、方法签名形状）；
  - `usage-examples.ts`——B（实现 PiRuntime）、C（域数据与引用分离）、D（ToolDecision 构造）、E（事件转换与状态投影）、runtime-smoke（编排流程）的最小编译示例；
  - `negatives/`——**必须编译失败**的反例（7 个用例，每个一目录）。

## 5. 关键设计决定（供实现方对照）

1. **`PiRuntime` 是"单活跃会话"模型**：create/restore 替换活跃会话后订阅保持有效（实现须自动重订阅）；prompt/steer/abort/navigateTree 作用于活跃会话。
2. **steer 语义以 Pi 0.85.1 实测为准**：同一 agent run 内新 turn（单 `agent_start`）。若实现发现行为不符，触发 PI-CHANGE（ADR-002 §3），不得改检查器迁就。
3. **失败语义**：Promise 拒绝统一 `TreeAIError`；被中止的 prompt 以 `user-abort` 拒绝并收敛为 `aborted`；宿主 dispose 时在途 run 同按 `aborted` 收敛；宿主崩溃后恢复时非终态 run 置 `failed`（code `unknown` + 中断标注，见 `run-state.ts` I6）。调用方违反前置条件属编程错误，抛平台标准错误（如 `TypeError`），不是 `TreeAIError`。
4. **`TreeAIEventType` 是开放联合**：已知类型保证一致性，未知 Pi 事件以原始 kind 记录（`pi.unknown`），journal 不得崩溃或丢弃（前向兼容）。
5. **seq 语义分两层**：`TreeAIEvent.seq` 在同一 `runId` 内从 1 严格递增（journal 持久层）；`PiRuntimeEvent.seq` 在单个 runtime 实例生命周期内严格递增（跨会话替换连续）。
6. **`PinnedPiVersion` 是字面量类型 `"0.85.1"`**：编译期即钉住版本；实现还须在运行时校验实际版本。

## 6. 破坏性变更流程（CONTRACT-CHANGE）

冻结（CONTRACT-FREEZE-1）之后，任何破坏性修改（改字段名/类型、删导出、收紧或放宽语义、修改状态机迁移表、修改事件/错误/决定枚举）必须：

1. 由 **Agent A** 创建 `coordination/d2/CONTRACT-CHANGE-<序号>.md`，内容：
   - 变更摘要与动机；
   - 受影响的调用方清单（逐 package、逐接口点名）；
   - 迁移步骤（可执行的先后顺序）；
   - 测试影响（哪些测试需要改、哪些行为必须新增回归）。
2. 由 **Integrator** 批准后实施；未经批准不得先改契约再补文档。
3. 非破坏性新增（新可选字段、新导出类型）不触发本流程，但 Agent A 必须在状态文件登记，避免与其他 Agent 的并行工作冲突。

与 PI-CHANGE 的区别：改 **TreeAI 自己的契约**走 CONTRACT-CHANGE（Integrator 批准）；改 **Pi 的依赖方式/源码/版本**走 PI-CHANGE（负责人批准，ADR-002）。

## 7. 当前状态与待办（诚实记录）

- 根 workspace 已由 Integrator 于 2026-09-21 交付（npm workspaces、`tsconfig.base.json`、TypeScript 5.9.3 固定、统一命令入口）；contracts 的 `tsconfig.json` extends 该基线（NodeNext 解析，相对导入带 `.js` 扩展名）。
- 实测验证（2026-09-21，Agent A）：根 `npm run typecheck` exit 0；`cd packages/contracts && npm test` exit 0（typecheck + 7 个反例 + Pi 隔离检查）。根 `npm test` 当前为 Integrator 的 NOT_IMPLEMENTED 占位（exit 3，模块测试套件待 Wave 1 接入）——这不是 contracts 的失败。
- **Gate 0 尚未验收**：本文档与契约包的状态是"Agent A 已交付、待 Integrator 验收"，不是"Gate 0 已通过"。尚待：负责人确认任务书、Integrator 在 ADR-002 记录批准来源与日期、Integrator 在 `CONTRACT-FREEZE-1.md` 记录"通过"。
