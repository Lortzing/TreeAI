# SDK vs RPC 对照矩阵（sdk-vs-rpc-matrix）

- 文档版本：1.0
- 日期：2026-09-18
- 作者：Agent A（D1 调研）
- 状态：结构就绪，**测量值全部 NOT_RUN**（等待 Agent B/C 实测），**权重与最终推荐全部 PENDING_OWNER**
- 上游事实来源：`d1-spikes/research/pi-capability-inventory.md`（下称"清单"，事实编号沿用其证据等级 E1/E2/E3/E4）
- 审阅对象：负责人（唯一有权确认权重与推荐的人）、Agent B、Agent C、Agent D

---

## 0. 使用说明（负责人请先读）

1. 本矩阵把**事实、测量、评分、权重**四层物理分离。事实层已完成（来自官方文档与本机核对，逐条可溯源）；测量层为 Agent B（SDK 探针）与 Agent C（RPC 探针）预留路径，当前全部 `NOT_RUN`；评分层依赖测量层；权重层任何数值在负责人确认前都是**非约束示例**。
2. **本矩阵不产出最终推荐。** 汇总公式见 §5，但计算结果与推荐结论必须等测量层填满、负责人确认权重后才有效。负责人未确认前，任何单元格中的 `PENDING_OWNER` 不得被当作默认值使用。
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
| 事实 | `session.navigateTree(targetId, opts)`（原地改叶、可选分支摘要；agent 忙时 reject）；`SessionManager` 树 API：`getTree/getPath/getLeafEntry/getChildren/branch/branchWithSummary/createBranchedSession`；`runtime.fork(entryId,{position:"at"})`（SDK-doc） | `get_tree`（树+leafId）、`get_entries`（append 序全量/游标）、`fork`、`clone`、`switch_session`、`get_fork_messages`（RPC-doc）。**未见与 `navigateTree` 等价的原地树导航命令**（清单 §6.6，E3 推断，待 Agent C 实测确认） |

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

## 3. 第二层：测量矩阵（全部 NOT_RUN，路径已预留）

以下为 Agent B/C 实测数据的**登记位置**。当前状态一律 `NOT_RUN`；B/C 完成后按任务书 §6 的证据格式（原始事件 JSONL + 场景结果 JSON）写入对应路径，并回填本层状态（`PASS`/`FAIL`/`BLOCKED`/`NOT_RUN`）。**本层没有任何预填数值。**

### 3.1 五场景测量（每实现 × 每场景）

| 场景 | SDK（Agent B）证据路径 | RPC-Python（Agent C）证据路径 | SDK 状态 | RPC 状态 |
|---|---|---|---|---|
| basic | `d1-spikes/evidence/sdk/basic/`（`events.jsonl` + `result.json`） | `d1-spikes/evidence/rpc/basic/`（同构） | NOT_RUN | NOT_RUN |
| tool | `d1-spikes/evidence/sdk/tool/` | `d1-spikes/evidence/rpc/tool/` | NOT_RUN | NOT_RUN |
| steer | `d1-spikes/evidence/sdk/steer/` | `d1-spikes/evidence/rpc/steer/` | NOT_RUN | NOT_RUN |
| abort | `d1-spikes/evidence/sdk/abort/` | `d1-spikes/evidence/rpc/abort/` | NOT_RUN | NOT_RUN |
| resume | `d1-spikes/evidence/sdk/resume/` | `d1-spikes/evidence/rpc/resume/` | NOT_RUN | NOT_RUN |

场景判定标准以任务书 §7.1–§7.5 的"必须验证"条目为准（Agent D 的 schema 落地为 `d1-spikes/schemas/scenario-result.schema.json`）。

### 3.2 工程量测量（任务书 §9.6 / §10.6 要求的计数）

| 测量项 | SDK 登记处 | RPC 登记处 | 状态 |
|---|---|---|---|
| 自行维护的适配代码量（LOC + 文件数） | `d1-spikes/sdk-node/README.md`（B 填写） | `d1-spikes/rpc-python/README.md`（C 填写） | NOT_RUN |
| 协议状态机复杂度（framing/ID 关联/异步分发/超时/退出检测的代码行与测试数） | —（SDK 无此层） | 同上 | NOT_RUN |
| 错误传播方式记录 | `d1-spikes/sdk-node/README.md` | `d1-spikes/rpc-python/README.md` | NOT_RUN |
| 资源释放行为（订阅/子进程/孙进程残留计数） | 同上 | 同上 | NOT_RUN |
| 重启恢复所需外部标识清单 | 同上 | 同上 | NOT_RUN |

### 3.3 验收测量（Agent D）

| 测量项 | 登记处 | 状态 |
|---|---|---|
| 依赖可重复安装（干净环境） | `d1-spikes/evidence/verification/` | NOT_RUN |
| schema 校验、脱敏扫描、退出码、残留进程 | 同上 + `d1-spikes/reports/d1-verification.md` | NOT_RUN |

### 3.4 已完成的非场景测量（Agent A，非模型调用）

| 项 | 值 | 证据 |
|---|---|---|
| SDK 模块导出数 | 151 个符号，11 个关键 API 均为 function | 清单 §9.2（E1） |
| RPC `get_state` 冒烟 | success:true，exit 0（stdin EOF） | 清单 §9.1（E1） |
| registry 可用性 | npm view 全通过，无 BLOCKED | 清单 §9.3（E1） |

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

评分表（待测量完成后填写，当前全部空白）：

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

**最终推荐：PENDING_OWNER。** 在以下条件全部满足前，本矩阵不产生、也不应被引用为推荐依据：

1. §3.1 五场景 × 两实现全部为 PASS/FAIL/BLOCKED（不允许留 NOT_RUN）；
2. Agent D 的 `d1-verification.md` 完成验收；
3. 负责人书面确认 §4 评分规则与 §5 权重；
4. 负责人明示是否接受 BLOCKED 项折算规则（当前未定义，属 PENDING_OWNER）。

---

## 6. 更新协议

| 角色 | 允许的更新 |
|---|---|
| Agent B | 填 §3.1 SDK 列状态、§3.2 SDK 列 |
| Agent C | 填 §3.1 RPC 列状态、§3.2 RPC 列 |
| Agent D | 填 §3.3；在 `d1-spikes/reports/d1-verification.md` 汇总，不回写他人原始证据 |
| 负责人 | 确认 §4 评分规则、§5 权重与最终推荐 |
| Agent A | 维护 §2 事实层（收到纠错时更新并注明来源与日期） |

每次更新须在文件头的修订记录追加一行。本版为 1.0 初始版。

---

*本矩阵不包含任何虚构测量结果。截至本文档撰写时，五场景 × 两实现的实测状态均为 NOT_RUN。*
