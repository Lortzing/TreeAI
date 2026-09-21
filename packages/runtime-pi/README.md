# @treeai/runtime-pi

`contracts.PiRuntime` 的唯一实现：基于公开 SDK
`@earendil-works/pi-coding-agent@0.85.1`（**精确钉扎**，构造期校验）
驱动 Pi 会话生命周期——创建/恢复、prompt（流式事件 + 最终结果归一）、
steer、abort、navigateTree、subscribe、幂等 dispose。

本包是 workspace 中唯一允许依赖 Pi SDK 的包；Pi 具体类型不流出本包
（见「端口隔离」）。

## 运行

```bash
cd packages/runtime-pi
npm test          # typecheck + 单测（fake port）+ 真实端口离线测试
npm run typecheck # 仅 tsc --noEmit
```

- 单测不加载真实 SDK（`tests/unit/` 的 import 图只触 `src/pi-runtime.ts`
  与结构端口类型；`tests/real-port/offline.test.ts` 有结构性断言守住这一点）。
- 真实端口测试在**沙箱子进程**中运行（最小 env + 沙箱 HOME + 临时
  agentDir/models.json），零网络请求、不读取测试目录之外的用户数据。

## 使用公开 Pi API 清单（API surface inventory）

`src/pi-real-port.ts` 是**唯一** import `@earendil-works/pi-coding-agent`
的文件，只使用包根公开导出（无子路径/私有 import、不编辑 node_modules、
不直接写 session JSONL——所有写入都经 SessionManager 公开方法）：

| 公开 API | 用途 |
| --- | --- |
| `Pi.VERSION` | 版本钉扎校验（`PiVersionMismatchError`） |
| `Pi.createAgentSessionServices({cwd, agentDir?})` | provider/扩展发现**唯一入口**（D1 已证明裸 `ModelRuntime.create()` 看不到扩展注册的 provider） |
| `services.modelRuntime.getModel(providerId, modelId)` | 模型句柄解析（服务对象上的公开成员） |
| `Pi.createAgentSessionFromServices({services, sessionManager, model?, thinkingLevel?, tools?})` | AgentSession 工厂（创建与恢复共用）；消费 `modelFallbackMessage` 判定恢复失败 |
| `Pi.SessionManager.create(cwd, sessionDir)` | 新建持久化会话管理器（自动创建目录） |
| `Pi.SessionManager.inMemory(cwd)` | 内存会话管理器 |
| `Pi.SessionManager.open(path)` | 打开既有会话文件（恢复路径） |
| `SessionManager` 实例方法 | `getCwd/getSessionId/getSessionFile/getLeafId/getEntry/getEntries/branch/resetLeaf`（读 + 叶移动）；测试另用公开 `appendMessage/appendModelChange` 构造真实文件 |
| `AgentSession` 实例成员 | `sessionId/sessionFile/isStreaming/state/messages/model/sessionManager/prompt/steer/abort/dispose/subscribe/navigateTree/getLastAssistantText` |

## 架构

```
src/index.ts          公开入口：createPiRuntime()（默认装配真实端口）
src/pi-runtime.ts     核心实现（不 import Pi；实现 contracts.PiRuntime）
src/pi-sdk-port.ts    Pi SDK 的最小结构端口（结构类型，无 Pi import）
src/pi-real-port.ts   真实端口适配器（唯一 import Pi 的文件）
src/errors.ts         TreeAIError 实现 + classifyPiFailure（8 类归一）
src/redact.ts         脱敏（消息/详情构造期脱敏；家目录 → ~）
src/events.ts         Pi 事件 → PiRuntimeEvent 归一（白名单字段提取）
tests/helpers.ts      Fake Pi 端口（镜像 D1 实测语义）
tests/unit/           fake 单测（49 项）
tests/real-port/      真实 SDK 离线测试（沙箱子进程，2 项）
```

### 端口隔离（Pi 类型红线）

`pi-sdk-port.ts` 声明我们消费的结构子集；`pi-real-port.ts` 适配真实 SDK
并持有推导类型（`Parameters<>`/`Awaited<ReturnType<>>`，不 import 内部
模块）。核心逻辑与单测只依赖结构端口，因此：

- fake 单测的 import 图完全不加载真实 SDK；
- Pi 类型不越过本包边界（contracts 侧只有领域类型）。

### 关键设计

1. **settle-once prompt**：`prompt()` 返回**本运行时自有** promise，不透传
   Pi 的 promise。abort / dispose / 会话替换直接以 `TreeAIError("user-abort")`
   收敛；abort 后有安全计时器兜底（`abortConvergenceMs`，默认 10s）——
   即使 Pi 的 abort 永不收敛，promise 也必然 settle 且运行时回到非
   streaming。
2. **原子会话替换**：create/restore 先完整建好新会话，成功后才替换
   （失败不动旧会话）；替换时旧订阅退订、在途 run 以 user-abort 收敛、
   旧会话后台清理（abort + dispose，超时兜底）、新会话自动重订阅。
   listener 依次收到 `session.replaced` → `session.created|restored`，
   seq 跨替换连续递增。
3. **恢复的严格模型固定**：restore 不依赖 Pi 的隐式模型恢复（其对
   无消息条目的会话会改用 `findInitialModel`，可能静默替换模型），而是
   沿分支找最近的 `model_change` 显式传入；解析失败 → `model-unavailable`。
4. **失败归一**：所有拒绝是 `TreeAIError`（8 类封闭编码）；调用方前置
   违规抛 `TypeError`。分类顺序：timeout > auth > model-unavailable >
   abort > upstream > session-corrupt > unknown；policy 标记
   （`Symbol.for("treeai.policyDenied")`）优先于文本分类。非 user-abort
   失败在拒绝前推送 `runtime.error`（code + 脱敏 message）。
5. **最小权限默认**：`tools: []`（零工具）、`thinkingLevel: "off"`、
   `abortConvergenceMs: 10000`（均可配置）。

## 已知限制（Pi 0.85.1 实证行为）

1. **懒 flush**：持久化会话在首条 assistant 消息前**不落盘**（创建期的
   `model_change`/`thinking_level_change` 只驻内存）。因此「从未完成过
   一轮 prompt」的持久化会话引用不可恢复（restore 以 `missing-file`
   拒绝——真实语义，非缺陷）。运行时产出的引用在完成首轮 prompt 后
   即可恢复。
2. **`agent_end` 事件被丢弃**：归一化只保留 `agent_start`/`agent_settled`
   作为 run 边界（契约事件集没有对应 agent 结束语义；settled 已表达
   run 收敛）。
3. **恢复无消息条目的会话会追加条目**（Pi 新会话路径），叶指针会移动；
   运行时把叶指针移回（`branch` 回位），返回引用的 entryId 与输入一致。
   该场景实际仅在恢复「有落盘文件但无 assistant/user 消息」的手写文件
   时出现（见限制 1）。
4. **`SessionManager.open()` 对缺失文件不抛错**（静默新建空会话并占用
   该路径）：restore 前自行 `existsSync` 预检，杜绝在用户文件系统留下
   垃圾文件。
5. **navigateTree 的 user 消息目标落在父节点**（Pi 语义：准备重写该
   turn），且 Pi 返回的 `editorText` 不进契约面（契约只承诺叶位置）。
6. **`steer.enqueued` 在调用 Pi `steer()` resolve 后推送**：Pi 自身的
   `queue_update` 事件只以 `raw` 透传计数；不保证 steer 文本何时被
   消费（同 agent run 内排队，Pi 0.85.1 语义）。
7. **`message.updated` 只透出文本增量**（`text_delta`）；工具调用参数
   增量不透出。`message.completed.hasError` 只表达 Pi 的 stopReason
   error 形态。
8. **abort 语义**：Pi abort 收敛时 prompt 以合成 assistant 消息
   （stopReason "aborted"）+ `state.errorMessage` 结束；运行时把
   abortRequested / "aborted" 判定放在 errorMessage 之前，避免误分类。
9. **恢复后的 cwd 使用会话文件 header 的 cwd**（保证工具执行工作区
   一致），不是 `defaultCwd`。
10. **内存会话**：`SessionReference.sessionFile` 为 `""`（哨兵值），
    不可恢复（restore 以 `missing-file` 拒绝）。
11. **dispose 的清理是尽力而为**：后台 abort + dispose，`abortConvergenceMs`
    超时兜底，绝不 reject；Pi 若在 dispose 后仍持有资源句柄，公开 API
    无进一步手段（未观察到此问题，防御性记录）。
12. **`bash_execution_update` 等未识别事件**以 `raw` 事件透传（kind
    `raw.<type>`，白名单字段），不携带内容载荷。

## 与 fake 的刻意差异（测试透明度）

- 落盘用整体重写代替 Pi 的 wx-建文件+追加（磁盘内容等价）。
- fake 的 `openSessionManager` 对缺失文件抛 ENOENT（真实 Pi 静默新建）。
  运行时的 existsSync 预检使其不可达；保留更严的 fake 以捕获预检回归。

## 治理记录

- 无需修改 Pi SDK 源码/私有路径：公开 API 足够（无 PI-CHANGE 提案）。
- 未新增任何依赖（Node 内置 test runner）。
- 独占写入范围遵守：`packages/runtime-pi/**`、`coordination/d2/agent-b-*.md`。
