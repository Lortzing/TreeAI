# D2 Agent B 状态文件（agent-b-status.md）

- 维护者：Agent B（本文件唯一写入者；其他 Agent 不得编辑本文件）
- 创建：2026-09-21（Wave 1 启动记录，写生产代码前先落盘，任务书 §12）
- 阶段：Wave 1（PiRuntime 实现）
- 状态：`DELIVERED`（2026-09-21；handoff 见 `agent-b-handoff.md`，PASS）
- 依据：`TreeAI_D2_Agent执行任务书.md` v1.0；`coordination/d2/CONTRACT-FREEZE-1.md`（PASS）；Gate 0 已由 Integrator 验收通过。

## 1. 已读材料（任务书 §12 启动记录要求）

| # | 材料 | 摘取的关键事实 |
|---|---|---|
| 1 | `/Users/tal/Downloads/TreeAI_D2_Agent执行任务书.md` v1.0 | Agent B 职责：PiRuntime + Pi SDK 生命周期（Wave 1）；独占范围、Pi 治理 L0-L4、退出码约定（0/1/2/3）、§9 交付格式、§12 启动记录先于生产代码。 |
| 2 | `d1-spikes/research/adr-001-draft.md` 顶部批准记录 + §4 数据边界 | ADR-001 Accepted（2026-09-20）。§4：Pi session JSONL 是 Pi 内部格式，TreeAI 只存引用三元组（sessionFile/sessionId/entryId）；写入只经 Pi 官方 API；凭据归 Pi。 |
| 3 | `d1-spikes/reports/blockers.md` D1 关闭记录与 D2 授权 | DECISION-001~009 全部关闭：SDK 直嵌、TS/Node、Pi 0.85.1 精确锁定、最小权限、tree-navigation 纳入正式契约。D2 授权：收敛 D1 已验证逻辑为首版运行时。 |
| 4 | `d1-spikes/reports/d1-verification.md` 最终验收 | 30/30 PASS exit 0。关键实测语义：steer=同一 agent run 新 turn（单 agent_start）；abort 后 isStreaming=false（19ms 内）；navigateTree 同 session 文件、叶移动、上下文重建；裸 ModelRuntime.create() 看不到扩展 provider，必须走 createAgentSessionServices。 |
| 5 | `packages/contracts/src/**`（9 个文件全文）+ `docs/d2/contracts-README.md` | 冻结契约全文：PiRuntime/PiSessionInit/PiPromptResult/SessionReference/PinnedPiVersion="0.85.1"/TreeAIError 8 类/PiRuntimeEvent seq 生命周期严格递增/RunState I1-I7/ToolDecision。调用方契约违规抛平台错误（TypeError）非 TreeAIError。 |
| 6 | `coordination/d2/CONTRACT-FREEZE-1.md` | 冻结记录 PASS；§4.6 设计备案：更细的运行时配置属 runtime-pi 工厂参数，不进冻结面（即 `PiSessionInit` 只有 model/sessionDir/cwd）。 |
| 7 | `coordination/d2/integrator-status.md` + `coordination/d2/README.md` + `agent-a-status.md` | Gate 0 已过；workspace 结构、typecheck 编排（`npm run typecheck` 逐包 tsc）、包级测试惯例（`cd packages/X && npm test`）；退出码无管道直接捕获的纪律。 |
| 8 | Pi SDK 0.85.1 实际源码与类型（`node_modules/@earendil-works/pi-coding-agent/dist/**`，只读） | 已核：`createAgentSessionServices`/`createAgentSessionFromServices`/`SessionManager.{create,open,inMemory}`/`AgentSession.{prompt,steer,abort,dispose,subscribe,navigateTree}`；`prompt()` 对 auth/模型缺失/compaction 同步 throw；`abort()` 等待收敛后 resolve；`navigateTree` 用户消息目标→叶移到 parent 并返回 editorText，非用户目标→叶移到目标自身；`SessionManager.open()` 对**缺失文件不抛错**（会新建 session 并写文件）——restore 必须先自行检查文件存在。ThinkingLevel 七档。 |
| 9 | `d1-spikes/sdk-node/src/**`（只读，API 参考） | D1 已验证的调用模式与事件形状；未复制任何 spike 文件。 |

## 2. 理解并承诺的边界

独占写入范围（任务书原文授权）：

- `packages/runtime-pi/**`
- `coordination/d2/agent-b-status.md`、`coordination/d2/agent-b-handoff.md`（及任务书允许的 `agent-b-*.md`）

不写 / 不做：

- 不改 `packages/contracts/**`（已冻结）、根配置/锁文件（`package.json`/`package-lock.json`/`tsconfig.base.json`）、其他 package（persistence/tool-policy/event-journal、apps/）、`d1-spikes/**`（只读）、`tests/schemas/scripts/.github`、`evidence/**`（只读，证据由验收流程落盘）。
- 不私有 import Pi 内部模块（只用 `@earendil-works/pi-coding-agent` 包根公开导出）；不编辑 node_modules；不直接读写 Pi session JSONL（只经 Pi SessionManager 官方 API）；不升级 Pi 版本（精确 0.85.1）。
- 不新增 npm 依赖（测试用 Node 24 内置 test runner）。
- 不执行 `git commit` / `git push`。
- 需要跨范围修改时只在状态/handoff 提出，不自行改。发现 Pi 公开 API 不足需要私有路径/源码改动时立即停手写 `docs/proposals/PI-CHANGE-<序号>.md`（该目录归 Integrator 流程，如需落盘会在 handoff 申请）。

## 3. 计划（Wave 1 Agent B 任务，对应任务书 §5 Wave 1 第 2 项）

设计要点（详见交付后本文件 §5 与 README）：

1. **SDK 端口隔离（port seam）**：`src/pi-sdk-port.ts` 用纯结构类型定义 Pi SDK 的最小表面（服务发现/会话工厂/会话操作/事件）。`src/pi-real-port.ts` 是唯一 import Pi SDK 的文件，负责把公开 SDK 适配到端口。单测注入 fake port，不触真实 SDK 发现路径。Pi 具体类型不流出本包。
2. **provider 发现走正确路径**：只用公开 `createAgentSessionServices()`（内部加载扩展注册的 provider/models.json/auth.json），不用 D1 已证明看不见扩展 provider 的裸模型发现路径。
3. **核心实现 `src/pi-runtime.ts`**：实现冻结的 `contracts.PiRuntime`。prompt 返回 runtime 自有 settle-once promise（不透传 Pi promise），保证 abort/dispose/会话替换时收敛；abort 即时 resolve + 安全计时器兜底；navigateTree 委托 Pi 原生（同 session/同文件/叶移动/上下文重建）；dispose 幂等；会话替换时旧订阅失效、自动重订阅、seq 跨替换连续递增。
4. **错误归一 `src/errors.ts` + 脱敏 `src/redact.ts`**：8 类 TreeAIError 映射；message/details 脱敏（Authorization/Cookie/Bearer/sk- key/凭据字段名/家目录路径）；cause 保留原始对象（不落盘义务在 journal）。
5. **默认最小权限**：工厂参数提供 thinkingLevel（默认 "off"，D1 基线）与 tools allowlist（默认空=零工具启用）；凭据不经契约、不落日志。
6. **测试**：fake-port 单测（创建/恢复/订阅/错误映射/abort 与 dispose 重复/替换/树导航不建新会话/版本不一致/输入前置条件/脱敏）+ 真实端口离线测试（临时目录 + 沙箱 HOME，不读用户真实数据、不出网）。
7. **交付**：README（Pi API surface 清单 + 已知限制）、`agent-b-handoff.md`（§9 格式，真实命令与退出码）。

## 4. 验证命令（计划；真实结果在 §5 回填）

| 命令 | 预期 |
|---|---|
| `npm run typecheck`（仓库根，Integrator 编排器） | exit 0（含 `@treeai/runtime-pi` 实际检查通过；注：若其他 Agent 并行在制品导致其他包 FAIL，按编排器输出如实记录，不代修） |
| `cd packages/runtime-pi && npm test` | exit 0（typecheck + 全部单测通过） |
| `npm ls @earendil-works/pi-coding-agent` | 唯一来源 `@treeai/runtime-pi`，精确 `0.85.1` |

退出码约定：0 全过；1 工具错误；2 FAIL；3 BLOCKED/NOT_RUN。所有退出码无管道直接捕获。

## 5. 验证结果（2026-09-21 实测回填，退出码均无管道直接捕获）

| 命令 | 结果 | exit |
|---|---|---|
| `cd packages/runtime-pi && npm test` | tsc --noEmit 通过；node --test：tests 51 / pass 51 / fail 0（unit 49 + real-port 2） | 0 |
| `npm run typecheck`（仓库根） | 全部含源 workspace 通过（runtime-smoke/contracts/event-journal/persistence/runtime-pi/tool-policy） | 0 |
| `cd packages/runtime-pi && npm ls --depth 0` | `@earendil-works/pi-coding-agent@0.85.1` + `@treeai/contracts@0.1.0`，无新增依赖 | 0 |

补充实测发现（实现期新验证的 Pi 0.85.1 行为，已入 README 已知限制）：

- **懒 flush**：持久化会话在首条 assistant 消息前不落盘（`_persist` 对无
  assistant 的追加不写文件；`newSession` 只计算路径）。真实端口离线测试
  已实证（`lazy-file-before-assistant` / `file-flushed-after-assistant`），
  fake 已镜像。推论：从未完成一轮 prompt 的持久化会话引用不可恢复
  （`missing-file`）。
- `agentDir` 显式传入时完全取代 `~/.pi/agent` 派生路径（源码
  agent-session-services.js:55），沙箱隔离可靠。
- 单测-真实分歧修正：fake 曾对缺失文件抛 ENOENT（真实 Pi 静默新建），
  保留该更严差异并文档化；fake 曾急切落盘，已改为镜像懒 flush。

## 6. 阻塞

- 无阻塞。Wave 1 交付完成（PASS，见 `agent-b-handoff.md`）。
- 备忘（非阻塞）：Integrator Gate 0 记录中提到 Pi 传递依赖 `esbuild@0.28.1`、`protobufjs@7.6.5` 的 postinstall 与 `@google/genai@1.52.0` 的 preinstall 未获 install-scripts 批准、未执行。本次交付的 typecheck 与离线测试均不需要这些构建脚本（实测 exit 0）；若后续 live 验证需要，将按依赖申请流程提出，不自行改根配置。
