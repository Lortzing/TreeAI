# TreeAI D1 Agent 执行任务书

> 文档状态：可立即执行  
> 适用阶段：D1 技术路线验证  
> 执行主体：Agent A、Agent B、Agent C、Agent D  
> 决策状态：Pi-first 已确定；Pi SDK 直嵌或 Pi RPC、TypeScript/Node.js 或其他宿主语言尚未定案

## 0. 先读这里

你正在为 TreeAI 完成 D1 技术验证。你的任务不是开发产品界面，也不是提前搭建正式工程，而是形成一组可复现、可比较、可审计的技术证据，供负责人决定 TreeAI 首版如何接入 Pi。

所有 Agent 必须遵守以下原则：

1. Pi 是 TreeAI 初版唯一候选 Agent 内核。
2. 不 fork、不修改 Pi 源码。
3. 不把 Pi session 当作 TreeAI 的长期产品数据库。
4. 不把 TypeScript、Node.js、Python、SDK 或 RPC 写成已经批准的最终方案。
5. 使用真实 Pi、真实模型和真实事件完成验证；缺少凭据时可以完成代码、测试和文档，但必须把真实运行标记为 `BLOCKED_CREDENTIALS`，不得伪造通过结果。
6. 任何结论必须附带命令、日志或测试结果路径。
7. 不等待负责人讨论结束；先完成所有不依赖最终决策的工作。

## 1. D1 要回答的问题

D1 只回答以下问题：

> TreeAI 应在 Node.js 进程中直接嵌入 Pi SDK，还是将 Pi 作为独立 RPC 子进程驱动？两种路线能否稳定完成 basic、tool、steer、abort、resume，并形成可恢复、可解释的事件证据？

D1 不负责决定 TreeAI 的完整技术栈。D1 结束后，负责人根据证据批准或否决候选路线。

## 2. D1 范围

### 2.1 必须完成

- 核对 Pi SDK 与 RPC 的当前公开能力和实际安装版本。
- 使用同一 Pi 版本、同一模型、同一 fixture 和同一提示词分别验证 SDK 与 RPC。
- 完成 `basic`、`tool`、`steer`、`abort`、`resume` 五个场景。
- 保存脱敏后的原始事件 JSONL。
- 验证异常退出、超时、资源清理和可信退出码。
- 形成 SDK/RPC 对照矩阵。
- 起草 ADR-001，但不得将草案标记为 Approved。
- 输出可由非作者重复运行的 README 和验收脚本。

### 2.2 明确禁止

- 不做 Web UI、Tree Navigator、三栏布局或视觉设计。
- 不做 Forest、Tree、Branch、Episode、Run 的完整数据库。
- 不做 PDF、Markdown、Anchor、Peek、Return、Context Snapshot。
- 不接入 Pi 之外的第二个 Agent Runtime。
- 不设计“适配所有 Agent”的通用协议。
- 不 fork 或修改 Pi。
- 不访问个人主目录、真实业务仓库或 TreeAI 以外的未授权目录。
- 不在仓库、日志、Issue 或聊天中写入 API Key。
- 不将实验性选型直接合并为正式架构结论。

## 3. 共享工作区

在现有项目中建立语言中立的实验目录；不要先创建正式 monorepo：

```text
d1-spikes/
├── README.md
├── research/
│   ├── pi-capability-inventory.md
│   ├── sdk-vs-rpc-matrix.md
│   └── adr-001-draft.md
├── sdk-node/
│   ├── README.md
│   ├── src/
│   └── tests/
├── rpc-python/
│   ├── README.md
│   ├── src/
│   └── tests/
├── fixtures/
│   ├── README.txt
│   ├── numbers.json
│   └── readonly/
├── schemas/
│   ├── evidence-event.schema.json
│   └── scenario-result.schema.json
├── scripts/
│   ├── verify-d1
│   └── check-secrets
├── evidence/
│   ├── environment.json
│   ├── sdk/
│   ├── rpc/
│   └── verification/
└── reports/
    ├── d1-verification.md
    └── blockers.md
```

如果仓库已经存在同名目录，不得覆盖；先检查内容并在报告中说明冲突。

## 4. 并行协作规则

四个 Agent 可以并行工作，但必须遵守所有权边界：

| Agent | 独占写入范围 | 可读取范围 |
|---|---|---|
| Agent A | `research/` | 整个 `d1-spikes/` |
| Agent B | `sdk-node/`、`evidence/sdk/` | `fixtures/`、`schemas/`、`research/` |
| Agent C | `rpc-python/`、`evidence/rpc/` | `fixtures/`、`schemas/`、`research/` |
| Agent D | `fixtures/`、`schemas/`、`scripts/`、`evidence/verification/`、`reports/` | 整个 `d1-spikes/` |

规则：

- 优先使用独立 Git worktree 或独立分支。
- 不修改其他 Agent 的独占文件；发现问题时写入 `reports/blockers.md` 或发送消息。
- 不删除其他 Agent 产物。
- 不运行破坏性 Git 命令。
- 每次提交只包含本 Agent 的职责范围。
- 证据文件只能追加或生成新版本，不得静默改写失败记录。

## 5. 共享实验条件

SDK 与 RPC 对照实验必须满足：

- 使用同一个明确的 Pi 版本。候选版本须先核对实际 registry；记录解析后的精确版本，禁止 `latest`、`*` 或未记录的范围版本。
- 使用同一模型和相同 thinking 配置。
- 使用同一组提示词、fixture 文件和超时设置。
- API Key 只从现有环境变量或 Pi 已配置的凭据中读取。
- 不打印环境变量值，不复制认证文件，不把凭据写入 `.env`。
- 所有运行均在 `d1-spikes/fixtures/` 的临时副本中进行。
- 工具白名单最小化；`tool` 场景默认只读取 fixture 文件。
- 每个场景必须有总超时，并在 `finally` 或等价清理逻辑中释放订阅、session 和子进程。
- 所有结果使用 `PASS`、`FAIL`、`BLOCKED`、`NOT_RUN` 四种状态之一。

## 6. 统一证据格式

### 6.1 原始事件

每行一个 JSON 对象，至少包含：

```json
{
  "seq": 1,
  "observedAt": "2026-09-18T00:00:00.000Z",
  "implementation": "sdk-node",
  "scenario": "basic",
  "sessionId": "redacted-or-test-id",
  "piEventType": "message_update",
  "runState": "running",
  "payload": {},
  "redactionVersion": "d1-v1"
}
```

要求：

- `seq` 在单次运行中严格递增。
- 保留事件结构，不把推测写成事实。
- 删除密钥、认证头、绝对用户路径和非测试正文。
- 场景失败也必须写入最后已知事件和结构化错误。
- 先写临时文件，场景结束后原子完成正式文件。

### 6.2 场景结果

每个场景输出一个结果 JSON：

```json
{
  "implementation": "sdk-node",
  "scenario": "basic",
  "status": "PASS",
  "startedAt": "",
  "endedAt": "",
  "durationMs": 0,
  "command": "",
  "exitCode": 0,
  "evidenceFiles": [],
  "observations": [],
  "limitations": [],
  "error": null
}
```

不得只在 Markdown 中声称成功；`PASS` 必须能追溯到原始事件和退出码。

## 7. 五个统一场景

### 7.1 basic

操作：创建新 session，向固定模型发送固定问题，并完整接收流式回答。

必须验证：

- 能观察 message start、delta、end 或对应事件。
- 流式文本按顺序拼接，无重复和丢失。
- 能观察 finish reason 或等价完成状态。
- 连续运行三次均能结束。

### 7.2 tool

操作：要求 Agent 读取 fixture 中的固定文件并回答校验问题。

必须验证：

- 能观察工具开始、参数、结果和后续助手输出。
- 工具只访问授权 fixture。
- 返回内容与 fixture 一致。
- 工具失败时能形成明确失败状态。

### 7.3 steer

操作：在长回答流式生成期间发送新的转向指令。

必须验证：

- 记录 steer 发出、接收和生效的相对时机。
- 记录当前工具调用是否完成、跳过或继续。
- 最终输出反映新指令。
- 不把 steer 错误表示为新的独立 session。

### 7.4 abort

操作：在流式生成期间主动中止。

必须验证：

- 60 秒内收口，或按更严格的实现超时结束。
- 记录最终状态与最后事件。
- 不残留不可控子进程或运行任务。
- 中止后能够创建或继续一次新会话。

### 7.5 resume

操作：完成一轮持久化对话，退出宿主进程，重新启动并继续同一会话。

必须验证：

- 恢复前后的 session 标识和关联方式可解释。
- 恢复后能读取先前历史。
- 恢复后可以继续发送 prompt。
- 不依赖仅存在于原进程内存中的对象。

## 8. Agent A：能力调研与选型草案

### 目标

产出可核查的 SDK/RPC 能力清单与 ADR 草案，不替负责人做决定。

### 任务

1. 核对 Pi 官方 SDK、RPC、session、事件和权限说明。
2. 记录当前可安装 Pi 包名称、版本、Node 要求和 CLI 入口。
3. 列出 SDK 与 RPC 对以下能力的支持方式：
   - streaming
   - tool events
   - steer/follow-up
   - abort
   - resume/session persistence
   - tree/session navigation
   - extension UI
   - process isolation
   - type safety
4. 每项事实附上官方来源 URL、文件路径或可复现命令。
5. 建立比较矩阵，但将评分与权重分开记录；负责人尚未确认的权重标记为 `PENDING_OWNER`。
6. 起草 ADR-001，状态必须为 `Proposed`。
7. ADR 必须至少保留三个候选：
   - Node.js/TypeScript + Pi SDK
   - Node.js/TypeScript + Pi RPC
   - Python + Pi RPC
8. 写出每个候选的收益、风险、不可逆成本和退出方案。

### 完成标准

- 所有事实有来源。
- 未将推荐写成批准结果。
- 矩阵能接收 Agent B、C、D 的实测数据。
- ADR 中明确 TreeAI 数据与 Pi session 的边界。

## 9. Agent B：Node.js + Pi SDK 探针

### 目标

验证在 Node.js 进程内直接使用 Pi SDK 的能力和工程复杂度。

### 任务

1. 建立最小、独立、可删除的 Node.js/TypeScript spike。
2. 固定 Node、包管理器和 Pi SDK 精确版本，提交 lockfile。
3. 实现 session 创建、事件订阅、prompt、steer、abort、dispose 和 session 恢复。
4. 实现统一证据记录器或接入 Agent D 提供的 schema。
5. 完成五个场景及自动化入口。
6. 对以下内容计数或记录：
   - 需要自行维护的适配代码量
   - 直接可访问的 Pi 状态和类型
   - 错误传播方式
   - 资源释放行为
   - 重启恢复所需外部标识
7. 对无法稳定复现的行为建立最小复现。
8. README 中提供从安装到全套探针的命令。

### 禁止

- 不抽象正式 `RuntimeAdapter`。
- 不实现 TreeAI 领域模型。
- 不依赖前端或 SQLite。
- 不为了绕过问题修改 Pi 源码。

### 完成标准

- 五个场景都有结构化结果；无法运行时有明确 `BLOCKED` 证据。
- 连续运行不会残留订阅或未结束任务。
- 任一失败都产生非零退出码。
- 原始事件和摘要结论可以相互追溯。

## 10. Agent C：Python + Pi RPC 对照探针

### 目标

验证将 Pi 作为独立 RPC 子进程时的能力、隔离收益和协议成本。

### 任务

1. 建立最小、独立、可删除的 Python spike。
2. 使用与 Agent B 相同的 Pi CLI 精确版本和模型配置。
3. 启动 `pi --mode rpc` 或当前版本等价入口。
4. 实现严格 JSONL stdin/stdout 通信：
   - 逐行 framing
   - 请求 ID 关联
   - 异步事件分发
   - stderr 独立记录
   - 超时
   - 子进程退出检测
5. 完成五个统一场景。
6. 记录 RPC 相比 SDK 的能力缺失、事件差异和额外状态机。
7. 验证正常退出、超时、abort 和宿主崩溃后的子进程清理。
8. README 中提供从环境准备到全套探针的命令。

### 禁止

- 不把 Python 方案写成最终后端。
- 不为追求统一而丢弃 Pi 原始字段。
- 不把 stderr 混入 JSONL stdout 解析。
- 不用 mock 结果替代真实 Pi 证据。

### 完成标准

- 五个场景与 SDK 使用相同输入和通过条件。
- 协议错误、超时和子进程退出可区分。
- 任一失败都产生非零退出码。
- 能明确说明 RPC 带来的隔离收益及新增复杂度。

## 11. Agent D：夹具、安全、验收与汇总

### 目标

保证 SDK 与 RPC 的对照公平、证据可信，并形成负责人可以直接审阅的报告。

### 任务

1. 创建确定性 fixture 和临时运行目录生成器。
2. 编写共享 JSON Schema。
3. 编写日志脱敏与秘密扫描规则，至少检查：
   - 常见 API Key 形式
   - Authorization/Bearer
   - 用户主目录绝对路径
   - `.env` 与认证文件内容
4. 建立统一验收入口，依次检查：
   - 依赖是否可重复安装
   - 单元测试
   - 五个场景结果文件
   - JSON Schema
   - 日志脱敏
   - 可信退出码
   - 残留进程
5. 在干净临时目录或容器中分别复现 SDK 与 RPC。
6. 汇总 Agent B、C 实测结果，不修改它们的原始证据。
7. 输出 `d1-verification.md`，逐项标明 `PASS/FAIL/BLOCKED/NOT_RUN`。
8. 在报告中单列：
   - 已确认事实
   - 推断
   - 未决问题
   - 需要负责人决定的事项

### 禁止

- 不为使结果好看而删除失败样例。
- 不替负责人批准 ADR。
- 不自行给出 Go、Conditional Go 或 No Go 最终签字。
- 不将容器复现等同于目标设备人工复现。

### 完成标准

- 相同场景使用相同输入与判定。
- 报告中的每个结论都有证据路径。
- 缺文件、schema 错误或泄密扫描失败时，验收入口非零退出。
- SDK 与 RPC 的失败均如实保留。

## 12. 不需要等待负责人的事项

以下工作可以立即开始：

- 官方文档与包信息核对。
- 工作区、fixture、schema 和日志格式建立。
- SDK 与 RPC 最小代码编写。
- 静态测试、单元测试和错误路径测试。
- 使用已有本地 Pi 配置进行真实探针。
- 脱敏、秘密扫描和干净环境复现。
- 比较矩阵与 ADR 草案。
- 阻塞项、风险与未决问题整理。

## 13. 必须留给负责人的事项

遇到以下事项时，不要停下其他工作，但不得自行定案：

- 最终选择 SDK 还是 RPC。
- 最终选择 TypeScript/Node.js、Python 或其他宿主语言。
- 正式 Node、Python、包管理器和 Pi 版本基线。
- 是否接受同进程权限风险。
- 真实产品允许的工具和目录权限。
- 是否批准 ADR-001。
- D1 最终的 Go、Conditional Go 或 No Go。

将这些事项统一写入 `reports/blockers.md`，格式如下：

```markdown
## DECISION-001

- 状态：PENDING_OWNER
- 需要决定：
- 为什么阻塞正式方案：
- 当前已完成工作：
- 可选项：
- 各选项证据：
- 建议最晚决定时间：
```

## 14. 阻塞处理规则

| 阻塞 | Agent 应采取的动作 |
|---|---|
| 没有模型凭据 | 完成实现、单元测试和命令；真实场景标记 `BLOCKED_CREDENTIALS` |
| Pi 候选版本不可安装 | 保存安装输出；查询当前可用精确版本；不得静默切换 |
| SDK 与 RPC 版本不一致 | 停止性能/能力对比，先统一版本 |
| 事件行为与文档不一致 | 以原始证据记录实际行为，建立最小复现 |
| 需要扩大文件或 Shell 权限 | 不执行；登记 `PENDING_OWNER` |
| 发现密钥进入日志 | 立即停止共享该证据，修复脱敏器并重新生成 |
| 其他 Agent 尚未交付 | 使用 schema 和 fixture 继续本职责，不越界修改对方目录 |

## 15. 汇报格式

每个 Agent 完成后提交一份不超过一页的状态报告：

```markdown
# Agent X D1 报告

- 状态：COMPLETE / PARTIAL / BLOCKED
- Commit：
- 完成任务：
- 运行环境：
- 执行命令：
- 通过项：
- 失败项：
- 证据路径：
- 已知限制：
- 需要负责人决定：
- 建议下一步：
```

禁止使用“基本可用”“应该没问题”“大概支持”等无法验证的表述。

## 16. Agent 阶段的完成定义

当以下项目全部存在时，Agent 阶段完成，可以交给负责人继续讨论和决策：

- `pi-capability-inventory.md`
- `sdk-vs-rpc-matrix.md`
- 状态为 `Proposed` 的 `adr-001-draft.md`
- SDK 探针代码、README、测试和五场景结果
- RPC 探针代码、README、测试和五场景结果
- 两套脱敏原始事件
- 统一 schema 与验收脚本
- 秘密扫描结果
- 干净环境自动复现记录
- `d1-verification.md`
- `blockers.md`

Agent 阶段完成不等于 D1 已通过。只有负责人完成真实环境复现、权限审查、ADR 批准和 Go/No-Go 签字后，D1 才能正式结束。

## 17. 立即开始指令

收到本任务书后：

1. 确认自己的 Agent 编号和独占写入目录。
2. 检查目录是否已有内容，禁止覆盖未知文件。
3. 创建自己的工作分支或 worktree。
4. 先提交最小执行计划和预期产物路径。
5. 立即开始实现或调研，不等待负责人讨论最终技术路线。
6. 每发现一个需要拍板的问题，登记 `PENDING_OWNER`，然后继续其他不受影响的任务。
7. 最终提交代码、证据、状态报告和可复现命令。

