# CONTRACT-FREEZE-1：D2 核心契约冻结记录

- 发布人：Agent A（按任务书 §5 Gate 0 Agent A 任务 5）
- 发布日期：2026-09-21
- **状态：PASS（Integrator 已验收；Gate 0 通过）**
- 验收记录：2026-09-21，Integrator 独立复验 `npm ci`、`npm run typecheck`、contracts 测试和 Pi 类型隔离均 exit 0；负责人已通过本次执行指令确认任务书，ADR-002 已记录 Accepted。

> 本文件记录 Gate 0 冻结的契约内容与验证方式。按任务书 §5 Gate 0 验收标准，
> "Integrator 在本文件上记录'通过'"是 Gate 0 通过的条件之一——在 Integrator
> 记录之前，本文档及所指向的契约包状态均为**待验收**，不得被引用为
> "Gate 0 已通过"或"契约已生效冻结"的依据。

## 1. 冻结范围（任务书 §3.3 七项 → 实现位置）

| # | 冻结内容 | 实现位置（packages/contracts/src/） |
|---|---|---|
| 1 | `PiRuntime`：创建/恢复 session、prompt、steer、abort、navigateTree、subscribe、dispose | `pi-runtime.ts`（含 `PiSessionInit` / `PiSessionSnapshot` / `PiPromptInput` / `PiPromptResult` / `PiSteerInput` / `PiNavigateTreeTarget` / `PiUnsubscribe`） |
| 2 | `SessionReference`：sessionFile、sessionId、entryId、版本信息、可用性 | `session-reference.ts`（含 `PiSessionId` / `PiEntryId` / `PiVersion` / `PinnedPiVersion = "0.85.1"` / `SessionAvailability`） |
| 3 | 领域标识：Forest / Tree / Branch / Episode / Run 的 ID 与关联关系 | `identifiers.ts`（品牌化 ID + 实体形状 + Locator 定位器） |
| 4 | `RunState`：queued / running / aborting / succeeded / failed / aborted + 状态机不变量 | `run-state.ts`（`RunStateTransitions` 迁移表、`AllowedRunStateTransition` 编译期检查、不变量 I1–I7） |
| 5 | `TreeAIEvent`：eventId、runId、严格递增 seq、时间、类型、脱敏 payload、原始证据引用 | `events.ts`（含 `TreeAIEventType` 开放联合、`EvidenceReference`、运行时事件 `PiRuntimeEvent`） |
| 6 | `TreeAIError`：auth / model-unavailable / user-abort / timeout / policy-denied / upstream / session-corrupt / unknown | `errors.ts` |
| 7 | `ToolDecision`：allow / deny / require-approval + 原因 / 规则 / 目录范围 / 风险级别 | `tool-decision.ts`（含 `ToolActionCategory` / `ToolRiskLevel` / `ToolDecisionScope`） |

冻结语义（不变量）的正式文本在各源文件头部注释中；使用方摘详见 `docs/d2/contracts-README.md` §5。

## 2. 破坏性变更规则（自本冻结起生效）

冻结后任何破坏性修改必须走 `CONTRACT-CHANGE-<序号>.md`（Agent A 创建，列调用方、迁移步骤、测试影响，Integrator 批准），流程全文见 `docs/d2/contracts-README.md` §6。非破坏性新增由 Agent A 在状态文件登记。

## 3. 验证命令

> 更新（2026-09-21，Agent A 交付完成前）：Integrator 在 Agent A 工作期间并行交付了根
> workspace 脚手架（根 `package.json`、`package-lock.json`、`tsconfig.base.json`、
> `node_modules`、`scripts/typecheck.js` 等，见 `coordination/d2/integrator-status.md`）。
> contracts 的 `tsconfig.json` 已改为 `extends ../../tsconfig.base.json`（NodeNext 解析，
> 相对导入带 `.js` 扩展名），与 Integrator 的基线配置一致。以下 §3.1 为 Agent A 交付
> 完成后实测的命令与退出码。

### 3.1 Agent A 实测（2026-09-21，contracts 交付完成后）

```bash
# (a) 根统一类型检查（Integrator 的编排器：逐 workspace tsc -p）
npm run typecheck
# 实测退出码：0（checked: @treeai/runtime-smoke、@treeai/contracts；
# runtime-pi/persistence/tool-policy/event-journal 无源码被显式 SKIPPED，不计入已检查）

# (b) contracts 包级测试入口（typecheck + 7 个反例 + Pi 隔离检查）
cd packages/contracts && npm test
# 实测退出码：0（7/7 negatives rejected as expected；no Pi imports）

# (c) 单步等价命令（不依赖 npm 入口时）
./node_modules/.bin/tsc --noEmit -p packages/contracts/tsconfig.json        # 退出码 0
TSC=./node_modules/.bin/tsc bash packages/contracts/scripts/run-negative-type-tests.sh  # 退出码 0
bash packages/contracts/scripts/check-no-pi-imports.sh                      # 退出码 0
```

早期（根 workspace 就位前）Agent A 曾以 `d1-spikes/sdk-node/node_modules/.bin/tsc`
（TypeScript 5.9.3，只读执行 D1 已装依赖，不修改 d1-spikes）完成等价验证，结果一致
（typecheck 0 / negatives 0 / isolation 0）；根 workspace 就位后改用根 `node_modules`
的同一版本 tsc（5.9.3，与 Integrator 固定版本一致）复验。

### 3.2 根级命令现状（占位与待接线，Gate 0 验收时以 Integrator 复验为准）

```bash
npm ci      # Integrator 已实测 exit 0（2026-09-21，见 integrator-status.md §6；
            # 含将各包 @treeai/contracts 对齐 0.1.0 后的锁文件重生成与复装）
npm test    # 当前为 NOT_IMPLEMENTED 占位（scripts/gate0-status.js），实测 exit 3——
            # 这是 Integrator 的诚实"未接线"信号，不是 contracts 失败；
            # contracts 层测试以 §3.1(b) 为准，待 Integrator 在 Wave 1 把模块测试
            # 套件接入根入口
```

## 4. 已知待 Integrator 验收/处理事项

1. **workspace 接线**：~~待建立~~ 已由 Integrator 于 2026-09-21 交付（根 `package.json`/`package-lock.json`/`tsconfig.base.json`/统一 scripts；各包 `@treeai/contracts` 已对齐 `0.1.0`）。contracts 的 `tsconfig.json` 已 extends 基线；`package.json` 的 `"types": "./src/index.ts"` 指向源码（纯类型包，无构建产物），Integrator 验收时可自行决定是否改用 project references 或路径映射。
2. **统一命令占位**：§3.2 三个命令当前不可执行（根配置不存在），需 Integrator 建立后在 Gate 0 验收时实际运行并记录退出码。
3. ~~`docs/proposals/PI-CHANGE-<序号>.md` 模板落盘~~ **已解决**：Integrator 已于 2026-09-21 落盘 `docs/proposals/PI-CHANGE-template.md`（内容覆盖 ADR-002 附录 A 的全部必填节）；ADR-002 附录 A 已改为指向该正式模板。
4. **ADR-002 批准记录**：ADR-002 状态为 Proposed（内容与任务书 §4 一致）。负责人确认任务书后，由 Integrator 在 ADR-002 记录批准来源与日期（Gate 0 验收条件之一）。
5. **Gate 0 其余验收项**（以 Integrator 复验为准）：`npm ci` 成功（Integrator 已实测 exit 0）；`npm run typecheck` 成功（Agent A 交付完成后实测 exit 0，contracts + runtime-smoke 通过、四模块包无源码显式 SKIPPED）；contracts 测试成功（§3.1(b) exit 0）；各 package 可只依赖 contracts 建立空实现（Integrator 记录为已达成）；Pi 类型未泄漏进 contracts（§3.1(c) exit 0）；PI-CHANGE 模板在位（Integrator 已落盘）；**仍待**：负责人确认任务书、Integrator 在 ADR-002 记录批准来源与日期、Integrator 在本文件记录"通过"。
6. **设计取舍备案**（非阻塞，供 Integrator/负责人知悉）：
   - `RunState` 未增设 `interrupted` 第七态（任务书 §3.3 为"至少包含"六态，Agent A 按精确六态冻结）；宿主崩溃后的恢复按 `failed` + `unknown` + 中断标注处理（`run-state.ts` I6），宿主 dispose 的在途 run 按 `aborted` 处理。若负责人希望 `interrupted` 独立成态，走 CONTRACT-CHANGE。
   - `TreeAIError` 未增设"invalid-state"类编程错误码：调用方契约违规按平台标准错误（TypeError）处理，保持 8 类分类专用于运行期失败（`errors.ts` 分类边界说明）。
   - `PiSessionInit` 仅含 model/sessionDir/cwd 三字段并明确禁止携带凭据；更细的运行时配置属 runtime-pi（Agent B）工厂参数，不进冻结面。

## 5. 冻结基线引用

- 上游决策：ADR-001 Accepted（2026-09-20）；D1 Go；D2 授权（`d1-spikes/reports/blockers.md` D1 负责人决定记录与 D2 授权记录）。
- D1 验收基线：`verify-20260920T124525829Z.json`，30/30 PASS，exit 0。
- Pi 精确版本：`0.85.1`（`PinnedPiVersion` 字面量类型）。
- 任务书：《TreeAI D2 Agent 执行任务书》v1.0（2026-09-21）§3.3、§5 Gate 0。
