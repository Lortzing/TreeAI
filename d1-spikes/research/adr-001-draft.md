# ADR-001：TreeAI 首版接入 Pi 的技术路线（草案）

- **状态：Proposed（草案，未批准）**
- 创建日期：2026-09-18；本次更新：2026-09-20（v1.2）
- 作者：Agent A（D1 调研）
- 决策权：负责人（本草案不包含、也不预示 Go/No-Go 或 Approved 结论）
- 事实基础：`d1-spikes/research/pi-capability-inventory.md`（下称"清单"）；对照与评分：`d1-spikes/research/sdk-vs-rpc-matrix.md`（下称"矩阵"；测量层已于 2026-09-20 回填：五场景两侧 PASS；tree/session navigation 另有场景外补充实测，见矩阵 §3.6；评分与权重仍 PENDING_OWNER）
- 验收依据：`d1-spikes/reports/d1-verification.md`（2026-09-20 收口跟进版）与 `d1-spikes/evidence/verification/verify-20260920T034514083Z.json`（2026-09-20T03:45:14Z，mode=repro，counts PASS=28/FAIL=0/BLOCKED=0/NOT_RUN=0，整体 ALL_PASS、exit 0；该 28 项不含 tree-navigation）
- 修订记录：1.2（2026-09-20）收口收尾：回填 tree/session navigation 场景外补充实测（矩阵 §3.6；RPC 侧运行时证实无 `navigateTree` 等价命令，只能以 fork/switch_session/clone/get_entries 组合）；清除过时状态（`--repro` 已双侧 PASS、共享 `evidence/environment.json` 已由集成人补齐、最新验收单轮全 PASS exit 0）；三候选、边界（§4）、收益/风险/不可逆成本/退出方案全部保留不变，一切决策仍 PENDING_OWNER；1.1（2026-09-20）同步 B/C/D 已提交证据：五场景两侧 PASS、provider parity 满足、适配/协议成本计数（彼时树导航仍待探针、干净复现未执行——历史事实，其后均已解决）；1.0（2026-09-18）初始草案

> **阅读警告**：截至 v1.2，五个统一场景（basic/tool/steer/abort/resume）已在统一基线（pi 0.85.1、provider `tal-token-plan-06c64a09`、model `deepseek-v4.1-flash`、thinking=off）下于两条路线实测**全部 PASS**；`--repro` 干净复现双侧 PASS；共享环境记录已由集成人补齐；最新验收运行单轮 28 项全 PASS（矩阵 §3.1/§3.3；`d1-spikes/evidence/verification/verify-20260920T034514083Z.json`）。tree/session navigation 已有**场景外补充实测**（矩阵 §3.6：SDK 侧 `navigateTree` 真实 PASS——同 session 移动叶指针、上下文按目标分支重建；RPC 侧真实 PASS 且运行时证实**无 `navigateTree` 等价命令**）——但两份证据均在共享契约 scenario 枚举外、未经统一验收，**不是五场景 PASS**；extension UI 嵌入与容器隔离仍未实测（矩阵 §3.5）。矩阵评分规则与权重未获负责人确认；**本 ADR 未获批准**。本草案的目的仍是**框定决策空间**，不是呈现结论。任何以本草案为据的"Pi 已选定 X 路线"表述都是错误的。

---

## 1. 背景与上下文

TreeAI 计划以 Pi（`@earendil-works/pi-coding-agent`，npm latest `0.85.1`，2026-09-18 核对，清单 §2–§3）作为初版唯一候选 Agent 内核（任务书既定前提）。D1 要回答的核心问题（任务书 §1）：

> TreeAI 应在 Node.js 进程中直接嵌入 Pi SDK，还是将 Pi 作为独立 RPC 子进程驱动？两种路线能否稳定完成 basic、tool、steer、abort、resume，并形成可恢复、可解释的事件证据？

已确认的事实基础（均可在清单中溯源）：

1. Pi 同时提供进程内 SDK（`createAgentSession` 等，151 个导出符号，本机 E1 验证）与子进程 RPC 模式（`pi --mode rpc`，stdio JSONL 协议，本机 `get_state` 冒烟 E1 验证通过）。
2. 两条路线的事件族同名同义（`agent_start/end/settled`、`turn_*`、`message_*`、`tool_execution_*`、`queue_update` 等），RPC 侧 `message_update` 为 delta-only（矩阵 §2.1）。
3. Pi 无内置权限/沙箱系统，以启动用户权限运行；隔离需 OS 级容器（清单 §7）。
4. Pi session 是其自有 JSONL 树格式（当前 version 3，历史上有 v1→v2→v3 迁移），由 Pi 版本演进管理（清单 §6、§8）。
5. Pi 发布节奏快且曾有回归先例（0.85.0 SDK 导入损坏、RPC abort 缺陷，0.85.1 修复；清单 §8）。

## 2. 决策驱动因素

按任务书归纳，负责人决策时应权衡：

- D1 五场景（basic/tool/steer/abort/resume）的稳定性与证据质量——**实测输入已齐备**：统一基线下两侧五场景均 PASS（矩阵 §3.1；证据 `d1-spikes/evidence/sdk/runs/2026-09-20T02-12-05-667Z-6220/` 与 `d1-spikes/evidence/rpc/`；验收复核 `d1-spikes/evidence/verification/verify-20260920T034514083Z.json` checks 12–21）。
- 事件证据的可恢复、可解释性——已按任务书 §6 格式两侧落地并通过 schema/seq/退出码校验（同上 check 24/27）。
- 进程隔离与权限风险（同进程 vs 子进程 vs 叠加容器，清单 §7.4；C 的子进程边界与崩溃清理实测见候选 3）。
- 树导航能力差异（SDK `navigateTree` 同 session 原地移动叶指针 vs RPC 侧无等价命令、需 fork/switch_session/clone 组合）——已有场景外补充实测（矩阵 §3.6；事实摘录 `d1-spikes/reports/d1-verification.md` §4b），证据在共享契约枚举外、未经统一验收；该差异的权重与是否否决 RPC 路线属 PENDING_OWNER（PO-A3）。
- TreeAI 宿主技术栈的长期取向（TypeScript/Node.js vs Python）——超出 D1 范围，但本决策与其强耦合，属 PENDING_OWNER。
- 维护成本：适配代码量、协议状态机复杂度、Pi 版本升级的回归面——**实测计数已回填**：SDK 适配层 302 行/2 文件，RPC 协议接入核心 484 行/2 文件（矩阵 §3.2；`d1-spikes/evidence/sdk/runs/2026-09-20T02-12-05-667Z-6220/run-summary.json`、`d1-spikes/rpc-python/` 源码计数）。

## 3. 考虑过的选项

### 已排除的选项（不在候选之列）

| 选项 | 排除原因 |
|---|---|
| fork/修改 Pi 源码 | 任务书原则 2 明确禁止 |
| 接入第二个 Agent Runtime / 通用适配协议 | 任务书 §2.2 明确禁止（D1 不做"适配所有 Agent"的协议） |
| 实验性 facet-service RPC（`packages/agent/docs/rpc.md`，基于 chord） | 官方标注为实验性设计规格（清单 §2.3），非稳定 API，不作为 D1 候选 |
| `pi --mode json`（一次性 JSON 事件流） | 一次性处理模式：无法在同一运行内交互式 steer/abort/追加输入（json.md 用法为单 prompt 处理后退出，清单 §4.3）。若 D1 实测推翻此判断，以证据为准（任务书 §14） |

### 候选 1：Node.js/TypeScript + Pi SDK（进程内嵌入）

TreeAI 后端为 Node.js/TypeScript，直接 `import "@earendil-works/pi-coding-agent"`，以 `createAgentSession()`/`AgentSession`/`AgentSessionRuntime`/`SessionManager` 类型化 API 驱动 Pi。

**实测状态（2026-09-20，统一基线 pi 0.85.1 / `tal-token-plan-06c64a09` / `deepseek-v4.1-flash` / thinking=off）**：五场景全部 PASS（basic 4087ms / tool 6073ms / steer 3481ms / abort 2538ms / resume 3908ms，单次运行）。证据：`d1-spikes/evidence/sdk/runs/2026-09-20T02-12-05-667Z-6220/`（每场景 result.json+events.jsonl，含 run-summary.json 审计）；验收复核 `d1-spikes/evidence/verification/verify-20260920T034514083Z.json` checks 12–16。适配层实测 302 行代码/2 文件；直接 Pi 状态/类型访问点 12 个入口、实际使用 10 个（矩阵 §3.2）。场景外补充实测：`navigateTree` 探针真实 PASS（矩阵 §3.6；`d1-spikes/evidence/sdk/tree-nav/runs/2026-09-20T02-59-39-706Z-27995/`——同一 session 内移动叶指针、上下文按目标分支重建、追加式树保留被放弃分支；该证据在共享契约 scenario 枚举外、未经统一验收）；`InteractiveMode` 嵌入等仍未实测（矩阵 §3.5）。

**收益**

- 类型安全端到端：编译期消费 Pi 的 `.d.ts`（`AgentMessage`/`AgentEvent`/session 条目类型联合），`defineTool`+typebox 参数推断（清单 §5.7）。
- 直接状态访问：`session.agent.state`、`messages`、`isStreaming`；无协议翻译层（清单 §5.2）——实测确认 10 个访问点直接可用并已形成审计清单（`d1-spikes/sdk-node/src/audit.ts` `DIRECT_PI_ACCESS`）。
- 全量能力面：`navigateTree`（原地树导航——**已有场景外补充实测 PASS**，见矩阵 §3.6）、`InteractiveMode`（完整 TUI 可嵌入——仍未实测）、compaction 控制、凭据注入（`InMemoryCredentialStore`/`setRuntimeApiKey` 不落盘）（清单 §5）。
- 无 framing/子进程管理复杂度；steer/abort 是直接方法调用——实测 abort() 19ms 内收口、`isStreaming=false`（`d1-spikes/evidence/sdk/runs/2026-09-20T02-12-05-667Z-6220/abort/result.json` observations）。
- 官方文档明确将"同 Node 进程、要类型安全、要直接状态访问"列为 SDK 首选场景（清单 §4.3 引原文）。

**风险**

- 同进程故障耦合：Pi 内未捕获异常、内存问题直接影响 TreeAI 宿主（架构性质风险，仍为 E3 推断；B 的错误传播实测显示 `prompt()` 后经 `agent.state.errorMessage` 可结构化分类错误——认证类→BLOCKED、其余→FAIL，见 `d1-spikes/sdk-node/README.md` "错误传播"节——但单次探针不能排除宿主被打翻的架构性风险）。
- 权限模型：TreeAI 宿主进程与 Pi 工具同权限运行；工具白名单与 `tool_call` 拦截是进程内机制，官方明确非安全边界（清单 §7.1–§7.2）。若负责人要求强隔离，必须叠加容器（PENDING_OWNER）。
- 版本升级回归面大：直接依赖 151 个导出符号的编译期 surface；0.85.0 SDK 导入损坏先例（清单 §8）。
- 模型发现的隐性耦合：自定义 provider（扩展注册）须经 `createAgentSessionServices()` 加载 `~/.pi/agent` 扩展后才可见，裸 `ModelRuntime.create()` 看不到（B 于 2026-09-20 实测发现并修正，曾致整轮 BLOCKED；`d1-spikes/sdk-node/README.md` "模型发现路径（2026-09-20 修正）"、中间 run `d1-spikes/evidence/sdk/runs/2026-09-20T01-50-33-164Z-97987/`）。
- 绑定 Node.js 宿主：若 TreeAI 后端未来转向其他语言，此路线的宿主代码不可移植（需重写为 RPC 客户端）。
- 会话替换语义陷阱：`runtime.session` 替换后必须重新订阅（文档警告，清单 §5.1）；需工程纪律。

**不可逆成本（投入后难以回收的部分）**

- TreeAI 后端语言选型与 Node.js 强绑定（越深入越难换）。
- 与 Pi 内部类型结构的编译期耦合（类型级重构会传导到 TreeAI 代码）。
- 进程内架构假设（单事件循环、共享内存）会渗入 TreeAI 的并发/可靠性设计。

**退出方案**

- 会话落盘是文件（JSONL）：退出 SDK 路线时，历史会话仍可被 RPC 模式 `switch_session`/`get_entries` 读取（清单 §6.7），对话资产不丢失。
- 建议 TreeAI 在宿主内用一层薄的会话端口（session port）封装对 `AgentSession` 的直接调用（仅接口隔离，非通用 RuntimeAdapter——任务书 §9 禁止提前抽象正式适配层；此处指退出成本控制的最小边界，是否采纳 PENDING_OWNER）。
- 事件订阅逻辑可平移：RPC 事件族同名（矩阵 §2），翻译层薄。

### 候选 2：Node.js/TypeScript + Pi RPC（子进程，Node 宿主）

TreeAI 后端为 Node.js/TypeScript，spawn `pi --mode rpc` 子进程，走 stdio JSONL 协议；可参考官方 TypeScript 客户端 `rpc-client.ts` 与 `rpc-types.ts`（清单 §2.9）。

**实测状态（2026-09-20）**：D1 未为本候选排独立探针；协议行为与子进程生命周期由 RPC-Python 探针（Agent C）在同一 Pi 版本（0.85.1）与统一基线下实测——五场景 PASS（`d1-spikes/evidence/rpc/`；验收 checks 17–21）。C 的 tree/navigation 补充探针（RPC 无 `navigateTree` 等价命令）属协议层事实，对本候选同样成立（矩阵 §3.6）。Node 语言侧差异（官方类型化客户端参考实现的可用性、Node 事件循环下的协议实现）仍为文档级事实（矩阵 §2.9），未实测。本候选的实测输入=RPC 协议共享证据＋语言侧文档事实。

**收益**

- 保持 Node.js 宿主的同时获得进程边界：pi 可独立 kill、监控、限权启动（清单 §7.4）——子进程边界的清理行为已由 C 的崩溃探针实测（见候选 3）。
- 官方类型化客户端参考实现存在，Node 侧类型安全可接近 SDK 路线（协议 surface 而非全 API surface）。
- 版本升级回归面较小：只依赖命令+事件协议（比 151 个导出符号窄）。
- 与候选 3 共享全部协议事实，未来换宿主语言时协议知识完全保留。

**风险**

- Node `readline` 不符合协议（U+2028/U+2029 分行问题），须用官方示例的自定义 JSONL reader（清单 §6.2）——协议实现有官方文档明示的坑；C 已在 Python 侧实测证明严格 LF framing 是必要且可行的（`d1-spikes/rpc-python/README.md` §6.9），Node 侧坑位相同。
- 需自建协议状态机：framing、请求 ID 关联、异步事件分发、超时、子进程退出检测（任务书 §10.4 要求验证的正是这些）——C 的实现计数：协议接入核心 484 行代码/2 文件＋28 个协议专项单测（矩阵 §3.2），Node 侧工程量同量级。
- `message_update` delta-only：客户端自行拼装流式文本，错误拼装会造成证据失真（矩阵 §2.1）——C 的实测证明拼装可正确完成（basic 场景 3 轮 `assembledInFinal=true`，`d1-spikes/evidence/rpc/basic.result.json`）；B 侧同类校验（流式增量与最终文本拼接一致、无重复丢失）同样通过（`d1-spikes/evidence/sdk/runs/2026-09-20T02-12-05-667Z-6220/basic/result.json`）。
- RPC 侧无 `navigateTree` 等价命令——已由 C 的补充探针**运行时证实**（`navigate_tree`/`navigateTree` 均返回 "Unknown command"，清单 §6.6 的 E3 推断就此证实；矩阵 §3.6；`d1-spikes/evidence/rpc/tree-navigation.result.jsonl`）：TreeAI 的树导航在本候选下需以 `fork`/`switch_session`/`clone`（+`get_entries` 游标）组合达成，且伴随新 session/新文件与上下文重建的语义差异（验收汇总 §4b 定性为实质性能力差异）；该缺口是否否决本候选属 PENDING_OWNER（PO-A3）。
- 子进程生命周期管理（崩溃重启、僵尸进程、宿主退出清理）成为 TreeAI 责任——C 的崩溃探针实测：宿主 SIGKILL 后 pi 子进程依赖 stdin EOF 在约 0.26s 内自行退出、无残留（`d1-spikes/evidence/rpc/crash-probe.json`；macOS 无 PDEATHSIG，见该文件 limitations）。

**不可逆成本**

- 协议客户端代码的持续维护投入（随 Pi 版本演进更新命令/事件 surface）。
- 进程监督基础设施一旦建立，TreeAI 运维形态围绕子进程模型成型。

**退出方案**

- 迁往候选 1：协议客户端已编码全部语义，剥离 framing 层后核心逻辑可复用；会话文件两侧通用。
- 迁往候选 3：协议层知识全量保留，宿主语言重写。
- 官方 `rpc-client.ts` 可作为对照实现降低维护风险（但其许可与更新节奏遵循上游仓库，E2）。

### 候选 3：Python + Pi RPC（子进程，Python 宿主）

TreeAI 后端为 Python，以 `subprocess.Popen(["pi","--mode","rpc",...])` 驱动 Pi 子进程；官方 RPC 文档自带 Python 最小示例（清单 §6.1 引原文）。

**实测状态（2026-09-20，统一基线 pi 0.85.1 / `tal-token-plan-06c64a09` / `deepseek-v4.1-flash` / thinking=off）**：五场景全部 PASS（basic 4656ms / tool 6760ms / steer 3170ms / abort 3149ms / resume 3318ms，单次运行）。证据：`d1-spikes/evidence/rpc/`（每场景 result.json+events.jsonl）；验收复核 `d1-spikes/evidence/verification/verify-20260920T034514083Z.json` checks 17–21。协议接入核心 484 行代码/2 文件＋28 个协议专项单测（矩阵 §3.2）；崩溃清理矩阵七情形全覆盖并有崩溃探针实测（`d1-spikes/evidence/rpc/crash-probe.json`）。场景外补充实测：tree/navigation 探针真实 PASS 且证实 RPC 无 `navigateTree` 等价命令（矩阵 §3.6；`d1-spikes/evidence/rpc/tree-navigation.{result.jsonl,events.jsonl}`——替代组合与语义差异见候选 2 对应风险项；证据在共享契约枚举外、未经统一验收）。

**收益**

- 宿主语言自由：TreeAI 若以 Python 为主栈（数据分析/AI 生态），无需引入 Node 运行时即可集成 Pi——已由 C 以纯 CPython 标准库（零第三方运行时依赖）完成全部协议实现与五场景实测证明可行（`d1-spikes/rpc-python/requirements.txt`、`d1-spikes/reports/d1-verification.md` check 7）。
- 进程边界收益同候选 2——且已实测：pi 子进程可独立退出（各场景退出码 `[0]`/`[0,0]`）、宿主 SIGKILL 后子进程约 0.26s 自行退出无残留（`d1-spikes/evidence/rpc/crash-probe.json`）、abort 后同进程可开新会话（`d1-spikes/evidence/rpc/abort.result.json`）。
- 协议是语言中立的 JSONL：Python 侧可用 pydantic 等重建类型层（需自建，清单 §2.9；C 的探针未建类型层，以纯 stdlib dict 处理）。

**风险**

- **无官方 Python 客户端包**（清单 §2.9，E2；是否存在可用的第三方客户端未核查，E4——列 PENDING_OWNER 决定是否安排核查）：全部协议代码自建自维护——C 的 484 行协议核心＋28 个专项单测即为此成本的下界实测样本（探针规模；产品化还需错误恢复/重连等）。
- 类型安全为三候选中最弱：Pi 类型定义只在 TypeScript 世界（`.d.ts`/`rpc-types.ts`），Python 侧类型是二次描述，可能漂移。
- 协议状态机 + 子进程管理的全部复杂度（同候选 2）叠加 Python 侧 asyncio/subprocess 工程细节——C 的实测确认：无推送式运行状态须自建派生状态机、带 id 的事件不一定是响应、startup 噪声须容忍、stderr 须独立通道（`d1-spikes/rpc-python/README.md` §6，细节以 `d1-spikes/evidence/rpc/*.events.jsonl` 为准）。
- TreeAI 若前端/工具链是 TS 系，跨语言团队成本与类型重复维护。
- 同样受 RPC 侧树导航缺口影响——C 的补充探针已运行时证实无 `navigateTree` 等价命令（矩阵 §3.6），树导航需以 fork/switch_session/clone 组合达成并接受其语义差异（同候选 2 对应风险项）；该缺口是否构成本候选的否决项属 PENDING_OWNER（PO-A3）。

**不可逆成本**

- Python 宿主选型本身就是方向性投入（团队技能、部署形态、依赖管理）。
- Python 侧协议与类型描述的维护（每次 Pi 升级需人工比对 rpc-types.ts）。

**退出方案**

- 迁往候选 1/2：协议知识保留；Python 业务逻辑需语言迁移（这是本候选最大的退出成本，负责人应显式评估）。
- 会话文件与证据 JSONL 均为语言中立格式，历史资产可迁移。

---

## 4. TreeAI 数据与 Pi session 的边界（本 ADR 的硬约束，不随候选变化）

依据任务书原则 3（"不把 Pi session 当作 TreeAI 的长期产品数据库"）与清单事实，边界规定如下：

1. **所有权**：Pi session JSONL 文件（`~/.pi/agent/sessions/` 或 `--session-dir` 指定目录）是 **Pi 的内部持久化格式**，其 schema 由 Pi 版本管理（v1→v2→v3 历史迁移，清单 §8）。TreeAI 不得将其 schema 当作稳定契约，不得在 Pi session 文件中存储 TreeAI 域模型（Forest/Tree/Branch/Episode/Run、文档、锚点等）的**唯一副本**。
2. **引用而非内嵌**：TreeAI 自有数据库保存对 Pi 会话的**引用**三元组（session 文件路径、sessionId、entryId——三者均为 Pi 稳定暴露的标识：`get_state`/`sessionFile`/`sessionId`，条目 id 为"跨重启持久游标"，清单 §6.7）。
3. **读取用于回放**：TreeAI 可读取 Pi session/`get_entries`/`get_messages` 用于对话回放与审计展示，但展示层应容忍 Pi 格式演进（解析逻辑跟随 Pi 版本升级）。
4. **写入仅限 API**：TreeAI 对会话的全部写入只经 Pi 官方 API（prompt/steer/followUp/fork/clone/switch_session 等），不直接改写 session JSONL 文件。
5. **可弃性**：删除一个 Pi session 不得破坏 TreeAI 域数据完整性；允许的降级是失去该会话的回放来源。反向地，TreeAI 数据库的迁移/升级不依赖 Pi session 的存在。
6. **凭据边界**：Pi 凭据（`auth.json`/环境变量）归 Pi 管理；TreeAI 不复制、不代理存储凭据（任务书 §5；SDK 侧可用 `setRuntimeApiKey`/`InMemoryCredentialStore` 注入而不落盘，清单 §5.4）。
7. **扩展状态**：Pi 的 `custom`/`custom_message` 条目（扩展状态持久化，清单 §6 引 session-format）**可**被 TreeAI 扩展用于附加元数据，但这增加对 Pi 格式的耦合，**不作为 TreeAI 域数据的必需存储**。是否利用此机制：PENDING_OWNER。

此边界对三个候选同等生效；候选选择不改变边界本身，只改变 TreeAI 访问 Pi API 的方式。

## 5. 后果分析（若任一候选被批准，共同的）

- TreeAI 必须建立 Pi 版本升级的回归流程（五场景最小回归集），因上游节奏快且有回归先例（清单 §8）。D1 已留下可复用的雏形：两侧探针的五场景入口 + 统一验收 `d1-spikes/scripts/verify-d1`（schema/seq/退出码/残留进程校验），可在新 Pi 版本上复跑（命令见 `d1-spikes/reports/d1-verification.md` §11）。
- 事件证据管道（任务书 §6 格式）成为 TreeAI 的核心资产，与候选无关——两侧已同构落地并通过校验（`d1-spikes/evidence/verification/verify-20260920T034514083Z.json` checks 24/27）。
- 权限决策独立于路线存在：同进程或子进程都不构成沙箱；若产品要求强隔离，需叠加容器模式（清单 §7.3），届时属新的架构决策。
- Pi 0.85.1 的 steer 实测呈同一 agent run 内新 turn 形态（单 `agent_start`，两侧证据一致）——若 TreeAI 依赖"steer 触发独立 agent run"的假设，须以实际版本行为为准并纳入回归（`d1-spikes/reports/d1-verification.md` §7.4，单实现单版本观察）。
- 树导航语义随路线分化：SDK `navigateTree` 在同一 session 内移动叶指针并按目标分支重建上下文（场景外补充实测 PASS）；RPC 侧无等价命令，需以 fork/switch_session/clone 组合并接受新 session/新文件与上下文重建的语义差异（双侧场景外实测，矩阵 §3.6；验收汇总 §4b）。若 TreeAI 产品依赖"原地树导航"，这一差异是路线选择的关键输入；该证据尚未纳入统一验收，是否扩展共享契约属 PENDING_OWNER（DECISION-009）。
- D1 之后的正式工程（数据库、UI、导航产品化）均不受本 ADR 约束，另行决策。

## 6. 未决问题（全部 PENDING_OWNER，负责人定案前不推进为结论）

| ID | 问题 | 关联 |
|---|---|---|
| PO-A1 | D1 锁定的 Pi 精确版本基线（候选 0.85.1；D1 对照实验已在 0.85.1 完成且两侧一致） | 清单 §3.3；blockers DECISION-003 |
| PO-A2 | D1 对照基线 provider/凭据来源的正式确认（实测统一使用 `tal-token-plan-06c64a09`/`deepseek-v4.1-flash`/thinking=off，parity 已由验收复核 PASS；正式确认/记录待负责人） | `d1-spikes/evidence/verification/verify-20260920T034514083Z.json` check 22；blockers DECISION-008 |
| PO-A3 | RPC 树导航缺口是否否决项——已由 C 的补充探针**运行时证实** RPC 无 `navigateTree` 等价命令（只能以 fork/switch_session/clone/get_entries 组合，语义差异显著）；待决：该缺口/语义差异是否否决 RPC 路线，还是接受组合方案 | 清单 §6.6（E3，已运行时证实）；矩阵 §3.6；`d1-spikes/reports/d1-verification.md` §4b；blockers DECISION-009 |
| PO-A4 | 是否纳入容器隔离对照 | 清单 §7.3 |
| PO-A5 | 负责人真实环境/目标设备复现的安排（`--repro` 已实际执行且双侧 PASS、共享 `evidence/environment.json` 已由集成人补齐——v1.1 时点的两项待补均已解决，历史沿革见矩阵 §3.3；任务书 §11 仍禁止把干净目录复现等同于目标设备人工复现） | `d1-spikes/evidence/verification/verify-20260920T034514083Z.json`；`d1-spikes/evidence/environment.json`；`d1-spikes/reports/d1-verification.md` §8 |
| PO-B1 | TreeAI 后端宿主语言长期取向（TS vs Python） | §2 驱动因素；blockers DECISION-002 |
| PO-B2 | 是否接受同进程权限风险 | 清单 §7.1；blockers DECISION-004 |
| PO-B3 | 矩阵评分规则与权重确认（测量层已就绪，规则与权重仍待确认） | 矩阵 §4/§5 |
| PO-B4 | 本 ADR 是否批准（以及后续 Go/No-Go） | 任务书 §13；blockers DECISION-006/007 |

## 7. 决策流程（下一步）

1. ~~Agent B/C 完成五场景实测，填充矩阵 §3~~——**已完成**（2026-09-20：统一基线两侧五场景 PASS，矩阵 §3 已回填；`d1-spikes/evidence/verification/verify-20260920T034514083Z.json` checks 12–22）。
2. ~~Agent D 完成 `d1-verification.md` 验收汇总~~——**已交付**（2026-09-20 收口跟进版；最新验收运行 `verify-20260920T034514083Z.json`：counts PASS=28/FAIL=0/BLOCKED=0/NOT_RUN=0，整体 ALL_PASS、exit 0。沿革：02:15Z 轮 exit 3 时 `--repro` ×2 与共享 `evidence/environment.json` 尚为 NOT_RUN，其后分别由实际执行（双侧 PASS）与集成人补齐解决——历史事实保留于矩阵 §3.3 与报告"版本沿革"节）。
3. **（可选，负责人定）tree/navigation 证据的统一验收**：B/C 已交付场景外补充实测（矩阵 §3.6），但其 scenario 值在共享契约枚举外、未经 verify-d1 验收；是否扩展 scenario 枚举并补跑统一验收（含 C 的 `.result.jsonl` 命名定夺）属 PENDING_OWNER（blockers DECISION-009）。是否作为决策前置由负责人决定。
4. 负责人确认矩阵评分规则与权重（PO-B3）后，矩阵产出量化对比。
5. 负责人在本 ADR 上做出决策（批准/修改/否决任一候选，PO-B4）。
6. ADR 状态从 `Proposed` 变更为负责人签署的终态——**在此之前，本文件不构成任何形式的批准。**

**干净复现与人工目标机条件（不可由 Agent 代劳）**：`--repro` 干净复现已实际执行且双侧 PASS（03:21:22Z 首次执行、03:45:14Z 复验，均 mode=repro），但任务书 §11 明确**不将容器/干净目录复现等同于目标设备人工复现**；按任务书 §16，D1 正式结束还需负责人完成**真实环境复现、权限审查、ADR 批准与 Go/No-Go 签字**。当前全部实测均来自单一工作区（macOS/darwin、Node v24.21.0、Python 3.9.6，`d1-spikes/evidence/verification/verify-20260920T034514083Z.json` environment 字段）——换机器/目标设备的复现结果以负责人侧记录为准，本草案不预设其结论。

## 8. 参考

- 任务书：`TreeAI_D1_Agent执行任务书.md`（仓库根）
- 事实清单：`d1-spikes/research/pi-capability-inventory.md`
- 对照矩阵：`d1-spikes/research/sdk-vs-rpc-matrix.md`
- 验收汇总（2026-09-20 收口跟进版）：`d1-spikes/reports/d1-verification.md`
- 验收详细运行（最新，单轮全 PASS）：`d1-spikes/evidence/verification/verify-20260920T034514083Z.json`（及同名 .log）；`--repro` 干净复现日志 `d1-spikes/evidence/verification/repro-20260920T034514083Z-{sdk-node,rpc-python}.log`；共享环境记录 `d1-spikes/evidence/environment.json`（集成人补齐）
- tree/session navigation 场景外补充证据（共享契约枚举外、未经统一验收；事实摘录见验收汇总 §4b）：`d1-spikes/evidence/sdk/tree-nav/runs/2026-09-20T02-59-39-706Z-27995/`（SDK）、`d1-spikes/evidence/rpc/tree-navigation.{result.jsonl,events.jsonl}`（RPC-Python）
- 待决/阻塞登记：`d1-spikes/reports/blockers.md`
- 两侧场景证据：`d1-spikes/evidence/sdk/runs/2026-09-20T02-12-05-667Z-6220/`（SDK）、`d1-spikes/evidence/rpc/`（RPC-Python）
- 官方文档入口：https://pi.dev/docs/latest （SDK/RPC/sessions/security/containerization 各页见清单 §11）
