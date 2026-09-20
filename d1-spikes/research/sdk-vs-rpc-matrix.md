# SDK vs RPC 对照矩阵（sdk-vs-rpc-matrix）

- 文档版本：1.3
- 日期：2026-09-20（v1.3：负责人批准 D1 Go、确定 SDK 路线、tree-navigation 纳入补充统一验收）；v1.2：收口收尾；v1.1：同步测量；v1.0：初始版
- 作者：Agent A（D1 调研）
- 状态：事实层、测量层和补充 tree-navigation 验收均已回填；五场景与 tree-navigation 双侧 PASS，provider parity、`--repro` 和共享环境记录均 PASS；负责人已批准 **TypeScript/Node.js + Pi SDK、Pi 0.85.1** 并授权 D2。评分规则/权重未用于决策，最终推荐列仅作历史分析记录；tree-navigation 现在使用 `tree-navigation` 规范名和 `tree-nav` 兼容别名，通过 verify-d1 独立补充检查。
- 上游事实来源：`d1-spikes/research/pi-capability-inventory.md`（下称"清单"，事实编号沿用其证据等级 E1/E2/E3/E4）
- 审阅对象：负责人（唯一有权确认权重与推荐的人）、Agent B、Agent C、Agent D
- 修订记录：
  - 1.0（2026-09-18）：初始版；事实层完成，测量层全部 NOT_RUN（预留路径）。
  - 1.1（2026-09-20）：按负责人指示，Agent A 依据已提交证据（时点：仓库 commit `5eca1d1`，验收运行 `d1-spikes/evidence/verification/verify-20260920T021547888Z.json`）回填 §3 测量层：五场景 SDK/RPC-Python 双侧 PASS、B 的适配层与直接状态访问计数、C 的协议状态机与隔离成本、D 的验收结果；更正 §3.1 的实际证据路径（v1.0 预留的扁平 SDK 路径已被追加式 runs 布局取代）。§4/§5 状态不变（PENDING_OWNER）。B/C/D 对各自原始证据拥有解释权；本文与原始证据冲突时以原始证据为准，并按 §0.3 登记 `d1-spikes/reports/blockers.md`。
  - 1.2（2026-09-20）：收口收尾更新。(a) 新增 §3.6：tree/session navigation 的**场景外补充架构证据**——B 的 SDK 探针真实 PASS（`navigateTree` 同一 session 内移动叶指针、上下文按目标分支重建）；C 的 RPC 补充探针真实 PASS 且运行时证实 RPC 命令集无 `navigateTree` 等价命令（只能以 fork/switch_session/clone/get_entries 组合）。两份证据的 scenario 值均在共享 schema 枚举外、未经 verify-d1 统一验收，**不计入 §3.1 五场景 PASS**；§2.6 的 E3 推断随之升级为运行时证实。(b) 清除过时状态：`--repro` 干净复现已实际执行且双侧 PASS（03:21:22Z 轮 `verify-20260920T032122324Z.json` checks 10/11；03:45:14Z 轮 `verify-20260920T034514083Z.json` mode=repro 单轮 28 项全 PASS、exit 0）；共享 `evidence/environment.json` 已由集成人补齐（2026-09-20T03:33:45Z），evidence-environment 检查转 PASS；§3.3 锚定最新运行、§3.5 缺口表相应更新（v1.1 时点"树导航未测、`--repro` 未执行、共享 environment 缺失"均为历史事实，沿革保留于 §3.3/§3.5 与本记录）。(c) §4/§5 与最终推荐状态不变；新增待决项"是否扩展共享契约把 tree-nav 纳入统一验收"亦为 PENDING_OWNER（blockers DECISION-009）。
  - 1.3（2026-09-20）：负责人批准 D1 Go 与候选 1，授权 D2；tree-navigation 纳入共享 scenario 契约和 verify-d1 独立补充检查（SDK `tree-nav` 兼容别名、RPC `tree-navigation` 规范名）；评分权重与最终推荐不作为本次决策计算。

---

## 0. 使用说明（负责人请先读）

1. 本矩阵把**事实、测量、评分、权重**四层物理分离。事实层完成（来自官方文档与本机核对，逐条可溯源）；测量层已于 2026-09-20 按已提交证据回填（§3，五场景双侧 PASS；另含 §3.6 场景外补充架构证据，来源与路径逐条可溯源）；评分层依赖测量层与负责人确认的规则；权重层任何数值在负责人确认前都是**非约束示例**。
2. 负责人已直接批准候选 1（TypeScript/Node.js + Pi SDK）并授权 D2，因此本矩阵不再用于决定 D1 路线；评分规则与权重表保留为可审计的历史分析输入，不产生新的架构推荐。
3. Agent B/C/D 不得修改本文件的 §1（候选定义）、§2（事实层）与 §4（权重层）；只能按 §3 的路径约定填充测量层并在 §6 登记更新。发现事实层错误时写入 `d1-spikes/reports/blockers.md` 并通知 Agent A。

---

## 1. 候选定义

| 候选 | 缩写 | 含义 | 探针 Owner |
|---|---|---|---|
| Node.js/TypeScript + Pi SDK | **SDK** | 在 TreeAI 的 Node.js 宿主进程内直接 `import "@earendil-works/pi-coding-agent"`，使用 `createAgentSession`/`AgentSession`/`SessionManager` 等类型化 API | Agent B（`d1-spikes/sdk-node/`） |
| Node.js/TypeScript + Pi RPC | **RPC-Node** | Node.js 宿主以子进程方式 spawn `pi --mode rpc`，走 stdio JSONL 协议 | （D1 未排独立探针；协议事实与 RPC-Python 共享，语言侧仅类型化客户端参考 `rpc-client.ts`） |
| Python + Pi RPC | **RPC-Python** | Python 宿主以子进程方式 spawn `pi --mode rpc`，走 stdio JSONL 协议 | Agent C（`d1-spikes/rpc-python/`） |

说明：任务书 §8 要求矩阵覆盖三个候选。RPC-Node 与 RPC-Python 共享同一协议与同一 Pi 子进程行为（事实层相同），差异集中在宿主语言侧（类型安全、协议实现成本、生态）。D1 的实测资源分配给 SDK（Agent B）与 RPC-Python（Agent C）；RPC-Node 的语言侧差异在 §2.9 单列讨论，不虚构实测数据。

---

## 2. 第一层：事实矩阵（已完成，逐条可溯源）

以下每个单元格只陈述**官方文档或本机核对过的事实**（清单 §5–§8），不包含任何实测性能/行为结论。来源缩写：`SDK-doc`=https://pi.dev/docs/latest/sdk；`RPC-doc`=https://pi.dev/docs/latest/rpc；`SEC-doc`=https://pi.dev/docs/latest/security；`CONT-doc`=https://pi.dev/docs/latest/containerization；`SF-doc`=https://pi.dev/docs/latest/session-format；`EXT-doc`=https://pi.dev/docs/latest/extensions。全部为清单 E2/E1 级证据，细节与原文见清单对应章节。

### 2.1 streaming（流式文本/思考输出）

| | SDK | RPC（Node 与 Python 共享） |
|---|---|---|
| 事实 | `session.subscribe` 收 `message_update`，`assistantMessageEvent` 含 `text_start/text_delta/text_end`、`thinking_*` 系列；`message_end.message` 为权威完成消息（SDK-doc "Events"） | 同一事件族以 JSONL 行流到 stdout；`message_update` **delta-only**（无累计快照），客户端须用 `contentIndex` 自行拼装，`message_end` 为准（RPC-doc "message_update"） |
| 完成状态 | `turn_end`/`agent_end`/`agent_settled` + `stopReason`（`stop/length/toolUse/error/aborted/deferred`，SF-doc） | 同左（RPC-doc Events 表） |

### 2.2 tool events（工具事件）

| | SDK | RPC |
|---|---|---|
| 事实 | `tool_execution_start`（toolCallId/toolName/args）、`tool_execution_update`、`tool_execution_end`（result/isError）（SDK-doc "Events"） | 同名事件 JSONL 化；`tool_execution_update.partialResult` 是**累计**非增量；`bash_execution_update` 仅用于直接 `bash` RPC 命令（RPC-doc） |

### 2.3 steer / follow-up（转向与追加）

| | SDK | RPC |
|---|---|---|
| 事实 | `session.steer(text)` / `session.followUp(text)`；或 `prompt(text, {streamingBehavior})`；流式中不带 streamingBehavior 的 `prompt()` 抛错；steer=本轮工具调用完后、下次 LLM 调用前投递；followUp=agent 停止后投递（SDK-doc "Prompting and Message Queueing"） | 命令 `steer` / `follow_up` / `prompt`+`streamingBehavior`；`set_steering_mode`/`set_follow_up_mode`（`all`/`one-at-a-time`，默认 one-at-a-time）；`queue_update` 事件；`clear_queue` 取回并清除队列（RPC-doc） |

### 2.4 abort（中止）

| | SDK | RPC |
|---|---|---|
| 事实 | `session.abort(): Promise<void>`；`abortCompaction()`；扩展侧 `ctx.signal`（AbortSignal）与 `ctx.abort()`；助手消息 `stopReason: "aborted"`（SDK-doc、EXT-doc `ctx.signal`、SF-doc） | `abort` 命令——中止当前操作并**等 session 空闲后**才应答；`abort_bash`、`abort_retry`；`compaction_end.aborted` 区分中止/失败（RPC-doc）。CHANGELOG：0.85.1 修复 abort 不中止手动 compaction 的缺陷（#8920，清单 §8） |

### 2.5 resume / session persistence（恢复与会话持久化）

| | SDK | RPC |
|---|---|---|
| 事实 | `SessionManager.create/open/continueRecent/inMemory(cwd,opts,entries)`（可从外部存储恢复）；session JSONL 自动落盘于 `~/.pi/agent/sessions/`；`--session/--session-id/--fork/--session-dir`；跨进程恢复靠文件，无仅存内存的必需状态（SDK-doc "Session Management"、SF-doc） | `switch_session`/`new_session`/`fork`/`clone`；`get_entries` 支持 `since` 条目游标（设计上**跨客户端重启**有效）；`--session-dir`/`--no-session`（RPC-doc "Session" 命令族） |

### 2.6 tree / session navigation（树与会话导航）

| | SDK | RPC |
|---|---|---|
| 事实 | `session.navigateTree(targetId, opts)`（原地改叶、可选分支摘要；agent 忙时 reject）；`SessionManager` 树 API：`getTree/getPath/getLeafEntry/getChildren/branch/branchWithSummary/createBranchedSession`；`runtime.fork(entryId,{position:"at"})`（SDK-doc） | `get_tree`（树+leafId）、`get_entries`（append 序全量/游标）、`fork`、`clone`、`switch_session`、`get_fork_messages`（RPC-doc）。**未见与 `navigateTree` 等价的原地树导航命令**（清单 §6.6，E3 推断；**2026-09-20 已由 C 的补充探针运行时证实**——`navigate_tree`/`navigateTree` 均返回 "Unknown command"，实测与替代原语组合见 §3.6，事实摘录见 `d1-spikes/reports/d1-verification.md` §4b） |

### 2.7 extension UI（扩展界面）

| | SDK | RPC |
|---|---|---|
| 事实 | `InteractiveMode`（完整 TUI）可整体嵌入；扩展经 `ctx.ui` 全量方法（`select/confirm/input/editor/custom/...`）；`ctx.mode==="tui"` 时 TUI 专属方法可用（SDK-doc "Run Modes"、EXT-doc `ctx.ui`/`ctx.mode`） | `extension_ui_request`/`extension_ui_response` 子协议：对话框方法（select/confirm/input/editor）阻塞等待 stdin 应答（带 timeout 自动默认）；即发即弃方法（notify/setStatus/setWidget/setTitle/set_editor_text）；部分 TUI 方法降级为 no-op（RPC-doc "Extension UI Protocol"）。本机冒烟已见 `setStatus` 事件真实出现（清单 §9.1，E1） |

### 2.8 process isolation（进程隔离）

| | SDK | RPC |
|---|---|---|
| 事实 | 同进程：共享权限、内存、事件循环；**Pi 无内置权限系统/沙箱**，以启动用户权限运行（SEC-doc）；进程级隔离只能靠外部容器（CONT-doc 四模式：Gondolin / Plain Docker / OpenShell / Docker Sandboxes） | 子进程边界：宿主可独立 kill/限权启动 pi 进程；stderr 与 stdout 分离；但工具仍在 pi 子进程用户权限下运行，文件/网络级隔离同样需要容器（SEC-doc/CONT-doc）。协议要求客户端自行处理 framing、超时、子进程退出检测（RPC-doc，含 Node `readline` 不合规警告） |

### 2.9 type safety（类型安全）

| | SDK | RPC-Node | RPC-Python |
|---|---|---|---|
| 事实 | 包发布 `.d.ts`（本机 E1 验证 151 个导出）；`AgentMessage`/`AgentEvent`/session 条目类型联合来自 `pi-ai`/`pi-agent-core`；`defineTool`+typebox 参数类型推断；`isToolCallEventType` 事件收窄（SDK-doc、EXT-doc） | 协议本身是 JSON；官方提供 TypeScript 参考客户端 `packages/coding-agent/src/modes/rpc/rpc-client.ts`（RPC-doc 引用），类型定义在 `src/modes/rpc/rpc-types.ts` | 官方文档含 Python 示例但**无官方 Python 客户端包**；类型需自建（pydantic 或等价）；协议 schema 以 RPC-doc + rpc-types.ts 为准（E2，是否存在第三方维护的 Python 客户端未核查，E4） |

### 2.10 补充事实行（D1 关切）

| 维度 | 事实（SDK / RPC 共享或分列） |
|---|---|
| 工具白名单 | 两侧同源：CLI `--tools/--exclude-tools/--no-tools/--no-builtin-tools`、settings `defaultTools`、SDK `tools` 选项、只读集 `read/grep/find/ls`（`pi --help` E1 + SDK-doc + settings-doc） |
| 工具拦截 | 扩展 `tool_call` 可阻塞/改参（改后不校验），`tool_result` 可改结果——进程内机制，非安全边界（EXT-doc、SEC-doc） |
| 项目信任 | 非交互模式（`-p`/json/rpc）不弹信任提示；无已存决策时 `ask`/`never` 忽略项目资源（SEC-doc）——对 RPC 探针默认环境有直接影响 |
| 事件证据质量 | 两侧事件族同名同义（RPC JSON 化、delta-only 差异见 §2.1/§2.2）；`agent_settled` 语义（无自动重试/压缩/排队继续）两侧均有 |
| 版本漂移暴露 | 两侧同版本发布（0.85.1 同步）；0.85.0 SDK 导入损坏 / RPC abort 缺陷均在 0.85.1 修复（CHANGELOG，清单 §8）——SDK 直依赖符号 surface 更大（151 导出），RPC 依赖协议 surface（命令+事件清单） |

---

## 3. 第二层：测量矩阵（2026-09-20 已按交付证据回填）

以下为 Agent B/C/D 实测数据的登记。v1.1 回填依据：Agent B 的 `d1-spikes/sdk-node/README.md` 与其 run 内审计文件、Agent C 的 `d1-spikes/rpc-python/README.md` 与 `d1-spikes/evidence/rpc/`、Agent D 的 `d1-spikes/reports/d1-verification.md` 与 `d1-spikes/evidence/verification/verify-20260920T021547888Z.json`。v1.2 增补：§3.3 锚定最新验收运行 `d1-spikes/evidence/verification/verify-20260920T034514083Z.json`；新增 §3.6 登记 B/C 于收口窗口交付的 tree/session navigation 场景外补充证据。统一判定状态词仍为 `PASS`/`FAIL`/`BLOCKED`/`NOT_RUN`；**本层所有数值均可溯源到上述证据路径，无预填、无推断值。**

### 3.1 五场景测量（每实现 × 每场景）

统一基线（两侧一致，2026-09-20 验收复核）：Pi `0.85.1`、provider `tal-token-plan-06c64a09`、model `deepseek-v4.1-flash`、thinking `off`（证据：`d1-spikes/evidence/verification/verify-20260920T034514083Z.json` check 22 `comparison-parity` PASS；`d1-spikes/evidence/sdk/runs/2026-09-20T02-12-05-667Z-6220/environment.json`；`d1-spikes/evidence/rpc/environment-rpc-python.json`；共享记录 `d1-spikes/evidence/environment.json`，集成人补齐）。

| 场景 | SDK（Agent B）证据路径 | RPC-Python（Agent C）证据路径 | SDK 状态 | RPC 状态 |
|---|---|---|---|---|
| basic | `d1-spikes/evidence/sdk/runs/2026-09-20T02-12-05-667Z-6220/basic/{result.json,events.jsonl}` | `d1-spikes/evidence/rpc/basic.{result.json,events.jsonl}` | PASS | PASS |
| tool | `d1-spikes/evidence/sdk/runs/2026-09-20T02-12-05-667Z-6220/tool/{result.json,events.jsonl}` | `d1-spikes/evidence/rpc/tool.{result.json,events.jsonl}` | PASS | PASS |
| steer | `d1-spikes/evidence/sdk/runs/2026-09-20T02-12-05-667Z-6220/steer/{result.json,events.jsonl}` | `d1-spikes/evidence/rpc/steer.{result.json,events.jsonl}` | PASS | PASS |
| abort | `d1-spikes/evidence/sdk/runs/2026-09-20T02-12-05-667Z-6220/abort/{result.json,events.jsonl}` | `d1-spikes/evidence/rpc/abort.{result.json,events.jsonl}` | PASS | PASS |
| resume | `d1-spikes/evidence/sdk/runs/2026-09-20T02-12-05-667Z-6220/resume/{result.json,events.jsonl}` | `d1-spikes/evidence/rpc/resume.{result.json,events.jsonl}` | PASS | PASS |

回填说明：

1. **证据路径更正**：v1.0 为 SDK 预留的是扁平路径 `d1-spikes/evidence/sdk/<scenario>/`；B 实际采用追加式 runs 布局（每次运行新建 `runs/<时间戳>-<pid>/`，证据只追加、不改写历史）。Agent D 的验收器已于 2026-09-18 修正为兼容两种布局（扁平优先，否则取 runs 下最新完整 run，跨 run 引用判 FAIL），规则见 `d1-spikes/schemas/README.md` 第二节与 `d1-spikes/reports/d1-verification.md` §0.1。上表登记的是验收器实际选定的 run `2026-09-20T02-12-05-667Z-6220`（6 个 run 中最新完整者）。
2. **历史 run 保留（追加原则）**：B 的 09-18 各 run（五场景 BLOCKED_CREDENTIALS，403）与 09-20 两个中间 run（`runs/2026-09-20T01-50-33-164Z-97987/` 全 BLOCKED——自定义 provider 须经 `createAgentSessionServices()` 发现；`runs/2026-09-20T02-03-27-035Z-3077/` steer FAIL——检查器语义与 Pi 0.85.1 实际行为不符）全部原样保留，时间线见 `d1-spikes/reports/d1-verification.md` §4a。
3. **验收复核**：上表 10 个 PASS 均经 Agent D 的 `verify-d1` 复核（exitCode=0、evidenceFiles 存在、事件 schema 合法且 seq 严格递增），对应 `verify-20260920T034514083Z.json` checks 12–21（v1.1 时点为 `verify-20260920T021547888Z.json`，结论相同）。
4. **单次运行耗时**（同一工作区、同基线、各一次运行，**非基准测试，不构成性能结论**；数值来自两侧 result.json 的 `durationMs`）——SDK：basic 4087ms / tool 6073ms / steer 3481ms / abort 2538ms / resume 3908ms；RPC-Python：basic 4656ms / tool 6760ms / steer 3170ms / abort 3149ms / resume 3318ms。
5. **场景外的能力未随五场景测得**：tree/session navigation 已有场景外补充实测（§3.6，双侧真实 PASS，但 scenario 值在共享契约枚举外、未经统一验收）；extension UI 嵌入、容器隔离（PO-A4）等仍无实测，见 §3.5。

场景判定标准以任务书 §7.1–§7.5 的"必须验证"条目为准（Agent D 的 schema 落地为 `d1-spikes/schemas/scenario-result.schema.json`）。

#### 3.1.1 两侧关键通过性观察（摘自已提交证据，供评分溯源）

- **SDK（B，`runs/2026-09-20T02-12-05-667Z-6220/`）**：basic 连续 3 子回合、流式增量与最终文本拼接一致、答案含期望值；tool 白名单 `read`、fixture 地面真值校验、读不存在文件 `isError=true`；steer 流中发送、`queue_update` 队列被消费清空、同 session 产出后续输出、Pi 0.85.1 呈同一 agent run 内新 turn 形态（单个 `agent_start`）；abort 流中 1 个 delta 后中止、abort() 19ms 内收口、`isStreaming=false`、中止后新会话可正常作答；resume 两个独立 OS 进程、跨进程仅 sessionFile+sessionId、phase B 读回历史并答对口令。（逐条见各 `<scenario>/result.json` 的 observations；汇总引述见 `d1-spikes/reports/d1-verification.md` §4。）
- **RPC-Python（C，`evidence/rpc/`）**：basic 3 轮 delta 拼装与最终消息一致（`assembledInFinal=true`）；tool `--tools read` 限定、工具路径在 fixture 临时副本内、答案与 fixture 真值一致、失败路径 `isError=true`；steer `deltasBeforeSteer=3`、queue_update 时间线完整、输出反映新指令、sessionId 不变；abort 响应延迟 14ms、`stopReason=aborted`、中止后同进程新会话可用、pi 子进程退出码 `[0]`；resume `--session-dir`+`--session-id` 跨宿主进程恢复、phase A/B sessionId 一致、历史含口令、pi 子进程退出码 `[0,0]`。（逐条见各 `<scenario>.result.json` 的 observations。）

### 3.2 工程量测量（任务书 §9.6 / §10.6 要求的计数；2026-09-20 回填）

| 测量项 | SDK（Agent B） | RPC-Python（Agent C） |
|---|---|---|
| 自行维护的适配/协议代码量 | **302 行代码 / 2 文件**（`src/pi-bridge.ts` 204 行 + `src/scenarios/resume-child.ts` 98 行；不含注释/空行）。探针骨架另计 1836 行 / 17 文件（录制/校验/脱敏/运行器，与 Pi 无关） | **协议接入核心 484 行代码 / 2 文件**（`src/pi_rpc_probe/transport.py` 224 行：子进程+严格 JSONL framing；`client.py` 260 行：请求关联+事件分发+派生运行状态机；不含注释/空行）。探针骨架另计（scenarios 962 行、evidence 219 行、envcheck 251 行、crash 探针 218 行、cli 329 行等，零第三方依赖） |
| 协议状态机复杂度 | 无此层（进程内直接方法调用与订阅） | 需自建：LF-only framing（U+2028/U+2029 在 JSON 字符串内合法，不能按通用换行切分）、逐请求 id 关联（`type=="response"` 才是响应，`bash_execution_update` 等事件也回显 id）、派生运行状态机（`agent_start`→running、`compaction_start`→compacting、`agent_settled`→idle；`agent_end` 不回 idle）、stdin/stdout/stderr 三通道线程模型、超时 SIGKILL 回收、子进程退出检测（stdout EOF→pending 请求回收为 ProcessExitedError）。协议专项单测 28 个（test_transport 17 + test_client 11） |
| 错误传播方式 | `prompt()` resolve 后读 `agent.state.errorMessage` 分类：认证类（401/invalid api key/auth）→ `BLOCKED_CREDENTIALS`；其余 → 结构化 FAIL（name/message/stack）；resume 子进程经 stdout JSON summary + 退出码（0/1/2）传回 | 失败命令返回 `success:false`+`error`；超时为有类型的 `RpcTimeoutError`；子进程先死 → `ProcessExitedError`（带退出码与 stderr tail）；stderr 独立落盘、脱敏后折叠为 `probe_note` 事件，不混入 stdout 解析通道 |
| 资源释放行为 | `subscribe()` 返回退订函数；场景结束 `dispose()`；abort 场景实测 `abort()` 19ms 收口、`isStreaming=false`、`getActiveResourcesInfo` 前后对比；resume 子进程独立退出、超时 SIGKILL、fixture 临时副本 finally 删除 | `close()` 幂等（关 stdin→等待→terminate→kill）；看门狗线程 deadline+5s SIGKILL；崩溃探针实测：宿主 SIGKILL 后 pi 子进程 idle 261ms / streaming 262ms 内自行退出（stdin EOF），无残留、无需强制回收（macOS 无 PDEATHSIG 等价物） |
| 重启恢复所需外部标识 | 跨进程**仅** sessionFile 路径 + sessionId（身份校验）；不传任何内存对象 | `--session-dir <dir>` + `--session-id <uuid>`（同 cwd）；`switch_session(sessionPath)` 为显式兜底（两条路径均实现并记录于 resume 证据） |

证据路径：

- B 侧全部计数：`d1-spikes/sdk-node/README.md`（"审计记录"节）＋每次运行自动写入的 `d1-spikes/evidence/sdk/runs/2026-09-20T02-12-05-667Z-6220/run-summary.json`（`adapterMetrics` 字段：adapter 302/2 文件、harness 1836/17 文件）与各 `<scenario>/result.json` 的 limitations/observations（"direct Pi API surface: 12 entry points"、"access points used by the adapter: 10"）；直接状态访问清单见 `d1-spikes/sdk-node/src/audit.ts` 的 `DIRECT_PI_ACCESS`（session.sessionId / sessionFile / isStreaming / messages / agent.state.errorMessage / model+thinkingLevel / SessionManager.getEntries() / AgentSessionEvent / AssistantMessage.stopReason / ModelRuntime.getAvailable()）。
- C 侧定性事实：`d1-spikes/rpc-python/README.md` §6（九条协议观察）、§7（子进程清理矩阵）；C 侧隔离/清理实测：`d1-spikes/evidence/rpc/crash-probe.json`、`d1-spikes/evidence/rpc/abort.result.json`、`d1-spikes/evidence/rpc/resume.result.json`。
- C 侧 LOC 计数为 Agent A 2026-09-20 按已提交代码（commit `5eca1d1`）统计，口径与 B 的 adapterMetrics 一致（剔除注释行与空行）；单测计数来自各 test 文件的 `def test_` 方法数（v1.1 时点 17+11+14+15+2=59；C 收口期追加 tree-nav 探针与测试后总数为 65，`d1-spikes/reports/d1-verification.md` 收口跟进版 check 9 记录 65/65）。若 C 交付自计数值，以 C 的原始记录为准。

#### 3.2.1 B/C 实测中的工程性发现（对成本评估有直接影响）

1. **SDK 侧模型发现路径**：自定义 provider（扩展注册）只有经 `createAgentSessionServices()` 加载 `~/.pi/agent` 扩展后才可见，裸 `ModelRuntime.create()` 看不到——曾致 09-20 01:50 run 全 BLOCKED，B 修正后统一经 services 路径创建会话（`d1-spikes/sdk-node/README.md` "模型发现路径（2026-09-20 修正）"；中间 run `d1-spikes/evidence/sdk/runs/2026-09-20T01-50-33-164Z-97987/`）。这是 SDK 路线的一处隐性耦合成本。
2. **Pi 0.85.1 steer 语义**：steer 在同一 agent run 内以新 turn 生效（单个 `agent_start`），而非启动第二个 agent run——B 的 02:03 run 曾因检查器预期后者而 steer FAIL，修正检查器语义后 02:12 全 PASS（`d1-spikes/evidence/sdk/runs/2026-09-20T02-03-27-035Z-3077/`；`d1-spikes/reports/d1-verification.md` §7.4 标注为单实现单版本观察，RPC 侧证据与此一致：steer 后 sessionId 不变）。
3. **RPC 侧无推送式运行状态**：`get_state` 为纯拉取，客户端必须自建派生状态机（C 已实现并测试；`d1-spikes/rpc-python/README.md` §6.1）。
4. **RPC 侧启动噪声**：本地扩展会主动发无请求的 `extension_ui_request`（如 `setStatus`），客户端必须容忍（清单 §9.1 E1 冒烟已见；C 的探针处理见 README §6.6）。
5. **RPC 侧凭据就绪性判断**：`pi auth check` 报 `not_ready` 的 provider 实际可服务（liveCheck 通过）、报 `ready` 的 provider 在 `--mode rpc` 下 403——就绪性应以真实最小调用为准（`d1-spikes/evidence/rpc/environment-rpc-python.json` 的 authCheck/liveCheck 字段；`d1-spikes/evidence/rpc/observation-copycopy-403.json`；`d1-spikes/reports/d1-verification.md` §7.2）。

### 3.3 验收测量（Agent D；2026-09-20 回填，v1.2 锚定最新运行）

统一验收入口：`d1-spikes/scripts/verify-d1`。最新验收运行：`d1-spikes/evidence/verification/verify-20260920T034514083Z.json`（2026-09-20T03:45:14Z，mode=repro，durationMs 69819，**28 项检查单轮全 PASS、overall=ALL_PASS、exit 0**）；汇总报告 `d1-spikes/reports/d1-verification.md`（2026-09-20 收口跟进版，锚定 03:21:22Z 轮）。注意：28 项检查只覆盖五场景与基础设施，**不覆盖 tree-navigation**（§3.6）。

| 测量项 | 状态 | 说明与证据 |
|---|---|---|
| 依赖可重复安装（清单级：lockfile/全量 `==` 锁定） | PASS | checks 6（sdk-node：package.json+package-lock.json，Pi 0.85.1 精确锁）、7（rpc-python：requirements.txt 全 `==`，零第三方依赖） |
| 干净环境实际复现（`--repro`：临时目录重装+重测） | **PASS** | 2026-09-20 首次实际执行（03:21:22Z 轮 `d1-spikes/evidence/verification/verify-20260920T032122324Z.json` checks 10/11）并复验（03:45:14Z 轮 checks 10/11）：sdk-node 干净临时目录 npm ci 退出 0 + npm test 80/80；rpc-python pip install 退出 0 + stdlib unittest 65/65（`d1-spikes/evidence/verification/repro-20260920T034514083Z-{sdk-node,rpc-python}.log`）。沿革（历史事实，保留）：v1.1 时点该项为 NOT_RUN（blockers DELIVERY-006 已解除）；中间轮 03:12Z rpc 侧曾因 C 进行中的 tree-nav 代码缺陷 FAIL（`d1-spikes/evidence/verification/repro-20260920T031204255Z-rpc-python.log`），修复后复跑 PASS，两轮均按追加原则保留 |
| 五场景结果（10 项） | PASS | checks 12–21：两侧各五场景 PASS，退出码、evidenceFiles、事件 schema、seq 严格递增均复核通过（03:45Z 轮 source：SDK `d1-spikes/evidence/sdk/runs/2026-09-20T02-12-05-667Z-6220/`、RPC 扁平布局 `d1-spikes/evidence/rpc/`） |
| 对照公平性（同 Pi 版本/provider/model/thinking） | PASS | check 22 `comparison-parity`：两侧均 pi 0.85.1 + `tal-token-plan-06c64a09`/`deepseek-v4.1-flash` + thinking=off。正式基线的确认仍属负责人（blockers DECISION-008） |
| schema 校验 | PASS | check 24：10 个结果文件全部通过共享 schema（check 2 另有 19 个正反例探针） |
| 秘密/脱敏扫描 | PASS | checks 25/26（03:45Z 轮）：evidence/ 189 文件 + 工作区其余 86 文件零发现（`d1-spikes/evidence/verification/secrets-scan-20260920T034514083Z-{evidence,workspace}.json`） |
| 可信退出码 | PASS | check 27：10 个结果文件 PASS 退出码为 0；FAIL/BLOCKED 须非零整数、NOT_RUN 不得声称 0（2026-09-20 收口后的完整规则） |
| 残留进程 | PASS | check 28：无本工作区相关残留探针进程 |
| 共享环境记录 `evidence/environment.json` | **PASS** | 已由集成人补齐（`d1-spikes/evidence/environment.json`，generatedAt 2026-09-20T03:33:45Z：pi 0.85.1、`tal-token-plan-06c64a09`/`deepseek-v4.1-flash`/thinking=off、darwin、Node v24.21.0、Python 3.9.6）。check 23：valid JSON（尚无强制 schema）。沿革（历史事实，保留）：v1.1 时点文件不存在、属主未定（blockers DELIVERY-004，B/C 各自环境记录当时无共享 schema） |
| 单元测试 | PASS | checks 8（sdk-node npm test 退出 0，80/80，含 tree-nav 相关测试）、9（rpc-python stdlib unittest 通过，65/65，含 tree-nav gate 测试）。v1.1 时点为 72/59（tree-nav 交付前，历史事实） |
| 验收门槛失败路径自证 | PASS | `d1-spikes/scripts/selftest-infra` 20/20（`d1-spikes/evidence/verification/selftest-infra-20260920T031856Z.json`：T1–T7 注入缺陷均被正确检出，含 2026-09-20 收口新增的 T6 BLOCKED 退出码保留与 T7 post-write 泄露改判同步）。v1.1 时点为 10/10（T1–T5，历史事实） |
| **整体验收** | **ALL_PASS（exit 0）** | 最新轮 `verify-20260920T034514083Z.json`：**PASS=28、FAIL=0、BLOCKED=0、NOT_RUN=0**。沿革（历史事实，保留）：02:15Z 轮 exit 3（PASS=25/NOT_RUN=3：`--repro` ×2 + 共享 environment.json）→ 03:21Z 轮 exit 3（PASS=27/NOT_RUN=1：`--repro` 双侧已 PASS，余 environment.json）→ 03:43Z 轮 exit 3（PASS=26/NOT_RUN=2：默认模式未请求 `--repro` 检查）→ 03:45Z 轮 exit 0（集成人补齐 environment.json 后，`--repro` 模式单轮全 PASS） |

验收历史为追加式（16 条，最早 2026-09-18T10:48:57Z，见 `d1-spikes/evidence/verification/verify-history.jsonl`）；此前的 BLOCKED/FAIL 轮次（含 09-18 B 侧 BLOCKED_CREDENTIALS、验收器布局误判、schema 探针发现缺陷、03:12Z 收口中间轮各轮）全部原样保留，沿革见 `d1-spikes/reports/d1-verification.md` "版本沿革"节。**整体验收全 PASS 不改变 §4/§5 状态：评分规则、权重与最终推荐仍全部 PENDING_OWNER。**

### 3.4 已完成的非场景测量（Agent A，非模型调用）

| 项 | 值 | 证据 |
|---|---|---|
| SDK 模块导出数 | 151 个符号，11 个关键 API 均为 function | 清单 §9.2（E1） |
| RPC `get_state` 冒烟 | success:true，exit 0（stdin EOF） | 清单 §9.1（E1） |
| registry 可用性 | npm view 全通过，无 BLOCKED | 清单 §9.3（E1） |

### 3.5 测量覆盖缺口（截至 2026-09-20 v1.2，评分时须注意）

以下为**未被五场景或统一验收覆盖**的能力/证据缺口（tree/session navigation 的补充实测单列于 §3.6，此处仅登记其统一验收缺口）：

| 能力 | 现状 | 影响 |
|---|---|---|
| tree/session navigation 的统一验收 | 已纳入补充契约并通过 verify-d1 checks 22/23；SDK 同 session `navigateTree` 与 RPC fork/switch_session/clone 语义差异已形成事实输入 | `verify-20260920T124525829Z.json`；是否在 D2 将 RPC 组合语义提升为产品约束，按 D2 完成定义执行 |
| extension UI（SDK 侧 TUI 嵌入 / RPC 侧对话框子协议） | 仅 E1 冒烟见过 RPC `setStatus` 事件（清单 §9.1）与 C 对启动噪声的容忍处理；`InteractiveMode` 嵌入、对话框阻塞应答等未实测 | 评分只能依据 §2 文档事实（E2 封顶） |
| 容器隔离（§2.8 / 清单 §7.3 四模式） | 未纳入 D1（PO-A4）；两侧实测的"隔离"仅到子进程边界（C 的 kill/terminate/崩溃清理） | process isolation 维度的实测输入仅覆盖子进程层，不含 OS 级容器 |
| 长时运行/并发会话压力 | 未测量（不在 D1 五场景范围） | 稳定性结论限于单次运行 |

（历史沿革，保留：v1.1 时点 tree/session navigation 整体未测、`--repro` 干净复现未执行；两者已分别于 2026-09-20 收口窗口由 B/C 的补充探针与 03:21Z/03:45Z 验收运行解决，见 §3.3/§3.6。）

### 3.6 补充架构证据：tree/session navigation（2026-09-20，已纳入补充统一验收）

**定位**：tree/session navigation 是 D1 五统一场景之外的补充架构场景；负责人已决定将其纳入共享契约和 `verify-d1` 独立补充检查。规范 scenario 名称为 `tree-navigation`，现有 SDK 证据的 `tree-nav` 作为兼容别名保留。最新验收运行 `d1-spikes/evidence/verification/verify-20260920T124525829Z.json` 的 checks 22/23 已分别验证 SDK/RPC 证据、事件、seq、退出码和 RPC canonical snapshot/journal 一致性。

**B（SDK，真实 PASS，2026-09-20T02:59:39Z）**：证据 `d1-spikes/evidence/sdk/tree-nav/runs/2026-09-20T02-59-39-706Z-27995/`（`tree-nav/{result.json,events.jsonl}`，另含 environment.json、run-summary.json、session-store/）。统一基线（pi 0.85.1、`tal-token-plan-06c64a09`/`deepseek-v4.1-flash`、thinking=off）；exitCode=0、durationMs 3847。关键观察（result.json observations）：

- `navigateTree(targetId)` resolved（cancelled=false），**叶指针在同一 session 内移动**（entryId `3f7ed6ae` → `f22507c8`）；sessionId 保持、session 文件不变（区别于 fork）。
- **追加式树**：导航仅移动指针，条目数不变（6 条）；被放弃的 turn-2 分支全部保留在文件中。
- **LLM 上下文按目标分支重建**（4 → 2 条消息，turn-2 分支不再在上下文）；导航后在新分支上 prompt 成功且答对 turn-1 口令；历史（含被放弃分支）完整保留，树分叉可见（turn-2 用户条目与新 prompt 条目为目标条目的兄弟节点）。
- 限制：仅验证 idle 态导航（文档的忙时 reject 未测；`summarize`/`label` 选项未行使——会触发额外 summarizer 模型调用，是否纳入范围属 PENDING_OWNER）；`navigateTree` 不向 `subscribe()` 事件流发事件（Pi 0.85.1 仅向扩展发 `session_tree`），宿主须从返回值或 SessionManager 读树状态。
- 规模联动：该 run 的 limitations 记录适配层 302 → 336 行、探针骨架 1836 → 2260 行、Pi API surface 12 → 14 入口（§3.2 的计数仍为五场景最终 run 口径，未随之改动）。

**C（RPC-Python，真实 PASS，2026-09-20T03:21:32Z；含关键差异发现）**：证据 `d1-spikes/evidence/rpc/tree-navigation.result.jsonl`（单行 JSON；**命名不符合 *.result.json 约定**，属验收定夺项）与 `d1-spikes/evidence/rpc/tree-navigation.events.jsonl`。统一基线；exitCode=0、durationMs 6319。关键发现：

- **RPC 侧不存在 `navigateTree` 等价命令（运行时证实）**：`navigate_tree` 与 `navigateTree` 两种命名的探针均返回 "Unknown command"——§2.6/清单 §6.6 的 E3 推断就此从"文档未见"升级为"运行时证实"。
- 可用替代原语（C 实测）：`fork`（新 sessionId + 新 session 文件；分支上下文不含原主干口令，preForkHistoryKept=false、postForkHistoryDropped=true；分支上 prompt 正常 settle）、`switch_session(sessionPath)`（回切原 session 并恢复主干历史与叶指针，回切后 prompt 正常作答）、`clone`（新 sessionId、历史保留）、`get_entries(since=...)`（游标增量读取，严格返回其后条目）。
- 语义差异（`d1-spikes/reports/d1-verification.md` §4b 的定性）：SDK `navigateTree` 的"同 session 内移动叶指针、上下文按目标分支重建"，在 RPC 侧只能以 fork/switch_session/clone 组合达成，且 fork 伴随新 session/新文件与上下文变化——这是五场景之外的一条**实质性能力差异实证**。

**对评分层的意义（事实性说明，非评分）**：§4 评分表的 tree/session navigation 维度现有双侧实测输入；但两份证据均在共享契约枚举外且未经统一验收，其证据等级如何在 §4 规则下计分（是否受封顶、是否先扩展契约补验收）属 PENDING_OWNER，随评分规则一并确认。PO-A3（RPC 树导航缺口是否否决项）的事实输入已由本节提供，结论仍属负责人。

---

## 4. 第三层：评分规则（草案，PENDING_OWNER 确认）

> **本节整体状态：PENDING_OWNER。** 评分刻度与判定规则是 Agent A 提出的**草案**，负责人未确认前不得用于计算。

提议的刻度（0–3）：

| 分值 | 含义 |
|---|---|
| 3 | 能力原生可用，实测通过且无需适配代码 |
| 2 | 能力可用，需少量适配/有文档化限制 |
| 1 | 能力可用但需显著适配、或有实测缺口 |
| 0 | 能力缺失或实测失败 |

提议的判定来源约束：**任何评分必须能追溯到 §3 的一条 PASS/FAIL/BLOCKED 证据或 §2 的文档事实**；BLOCKED 场景对应维度不得给分（记 `N/A-BLOCKED`）。文档声称但未实测的能力最高给 1 分（E2 封顶），实测通过后可到 2–3 分。

> v1.2 就绪度说明（事实性，非评分）：截至 2026-09-20，§3.1 已提供 streaming、tool events、steer/follow-up、abort、resume/persistence 五个维度在两侧实现（SDK 与 RPC，协议同源）的 PASS 实测输入（§3.1.1）；tree/session navigation 有场景外补充实测输入（§3.6：SDK `navigateTree` 真实 PASS；RPC 侧运行时证实无等价命令——注意两份证据在共享契约枚举外、未经统一验收，计分方式随评分规则由负责人定夺）；type safety 与 process isolation 有部分实测输入（SDK `.d.ts` E1 验证、C 的子进程边界/崩溃清理实测）；extension UI 仍无实测输入（§3.5）。RPC-Node 候选无独立探针，其评分输入沿用 RPC 协议共享证据 + §2.9 语言侧文档事实。**本说明不改变任何刻度或分数，评分表继续留空待负责人确认规则后填写。**

评分表（测量输入已就绪（§3），待负责人确认 §4 规则后填写，当前全部空白）：

| 维度 | SDK | RPC-Node | RPC-Python |
|---|---|---|---|
| streaming | — | — | — |
| tool events | — | — | — |
| steer/follow-up | — | — | — |
| abort | — | — | — |
| resume/persistence | — | — | — |
| tree/session navigation | — | — | — |
| extension UI | — | — | — |
| process isolation | — | — | — |
| type safety | — | — | — |
| （负责人可增删维度） | — | — | — |

---

## 5. 第四层：权重与汇总（全部 PENDING_OWNER）

> **本节整体状态：PENDING_OWNER。** 权重决定权属负责人（任务书 §8.5、§13）。下表的"示例值"仅用于演示汇总公式的形状，**不是建议、不是默认值、不得参与任何计算或叙述**。

| 维度 | 示例值（非约束） | 负责人确认值 | 状态 |
|---|---|---|---|
| streaming | （演示用空位，不填数值） | ____ | PENDING_OWNER |
| tool events | （同上） | ____ | PENDING_OWNER |
| steer/follow-up | （同上） | ____ | PENDING_OWNER |
| abort | （同上） | ____ | PENDING_OWNER |
| resume/persistence | （同上） | ____ | PENDING_OWNER |
| tree/session navigation | （同上） | ____ | PENDING_OWNER |
| extension UI | （同上） | ____ | PENDING_OWNER |
| process isolation | （同上） | ____ | PENDING_OWNER |
| type safety | （同上） | ____ | PENDING_OWNER |
| 工程量/维护成本 | （同上） | ____ | PENDING_OWNER |

（Agent A 刻意不在示例列填任何数字，避免锚定负责人。）

汇总公式（形状演示）：

```
候选总分 = Σ（维度评分 × 负责人确认权重）   // 仅当 §3 全部证据就位且 §4/§5 获负责人确认后执行
```

**D1 路线结论：负责人已批准 TypeScript/Node.js + Pi SDK。** §4/§5 的评分表与权重保留为历史分析工具，未用于替代负责人决定；后续评分不应反向覆盖 ADR-001 的 Accepted 状态。D2 应继续验证 RPC 树导航组合语义、权限策略和生产工程边界。

---

## 6. 更新协议

| 角色 | 允许的更新 |
|---|---|
| Agent B | 填 §3.1 SDK 列状态、§3.2 SDK 列 |
| Agent C | 填 §3.1 RPC 列状态、§3.2 RPC 列 |
| Agent D | 填 §3.3；在 `d1-spikes/reports/d1-verification.md` 汇总，不回写他人原始证据 |
| 负责人 | 确认 §4 评分规则、§5 权重与最终推荐（D1 路线已由 ADR-001 直接决定；D2 可继续使用本矩阵作风险输入） |
| Agent A | 维护 §2 事实层（收到纠错时更新并注明来源与日期）；经负责人指示可代为回填 §3（v1.1 即属此情形：依据 B/C/D 已提交证据回填，并逐条注明来源；B/C/D 对各自原始证据拥有解释权，冲突时以原始证据为准） |

每次更新须在文件头的修订记录追加一行。当前版本 1.3（2026-09-20）。

---

*本矩阵不包含任何虚构测量结果。截至 v1.3（2026-09-20）：五场景 × 两实现均为 PASS，tree-navigation 双侧补充验收 PASS，`--repro` 干净复现双侧 PASS，共享环境记录 PASS，最新验收运行 `d1-spikes/evidence/verification/verify-20260920T124525829Z.json` 为 30/30 PASS（统一基线 pi 0.85.1 / `tal-token-plan-06c64a09` / `deepseek-v4.1-flash` / thinking=off）；负责人已批准 D1 Go 与 TypeScript/Node.js + Pi SDK，并授权 D2。§3.5 所列 extension UI、容器隔离等仍是 D2 风险输入；评分表保留为历史分析工具，未用于替代负责人决策。*
