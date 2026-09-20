# Pi 能力清单（pi-capability-inventory）

- 文档版本：1.0
- 日期：2026-09-18
- 作者：Agent A（D1 调研）
- 状态：COMPLETE（本清单范围内；实测场景验证属 Agent B/C/D，见 §10）
- 适用范围：TreeAI D1 技术路线验证的 Pi 能力事实基础
- 审阅对象：负责人、Agent B、Agent C、Agent D

---

## 0. 摘要（给赶时间的负责人）

1. **当前 Pi coding agent 的正确包名是 `@earendil-works/pi-coding-agent`（npm latest = `0.85.1`），CLI 入口 `pi`，Node 要求 `>=22.19.0`。** npm 上的 `@mariozechner/pi`（latest `0.70.6`）是同名作者的另一个产品（vLLM GPU pod 管理工具 `pi-pods`），**不是** Pi coding agent。旧 scope `@mariozechner/pi-ai` 等包停留在旧版本（0.73.1），**不可用于 D1**。〔E1，见 §2、§3〕
2. SDK 与 RPC 两种集成方式都有官方文档，且本机已对两者做过无模型调用的导入/协议冒烟验证，均通过。〔E1，见 §9〕
3. Pi **没有内置权限/沙箱系统**，以启动用户权限运行；官方推荐的隔离手段是操作系统级容器化（Gondolin / Docker / OpenShell / Docker Sandboxes 四种模式）。工具层可做 allowlist/denylist 与扩展 `tool_call` 拦截，但官方明确说明这不是安全边界。〔E2，见 §7〕
4. Session 是 Pi 自有的 JSONL 树结构文件（当前 version 3），提供 `navigateTree`/`get_tree`/`fork`/`clone` 等树导航能力；格式由 Pi 版本演进管理（v1→v2→v3 有迁移），**不应作为 TreeAI 长期产品数据库**。〔E2，见 §6.6、§6.7〕
5. 发布节奏快（2026-08-28 至 2026-09-05 之间发布 0.84.4/0.85.0/0.85.1），且 0.85.0 曾出现 SDK 导入损坏、0.85.1 修复的先例。**D1 必须锁定精确版本并提交 lockfile。**〔E2，见 §8〕

---

## 1. 证据等级定义

本清单中每个事实标注以下等级之一：

| 等级 | 含义 | 来源形式 |
|---|---|---|
| **E1 已验证（本机复现）** | Agent A 于 2026-09-18 在本机实际执行命令并获得输出 | 附可复现命令与实际输出摘录 |
| **E2 已验证（官方文档/registry）** | 来自官方文档站、官方仓库、npm registry 的当前内容 | 附官方 URL（含仓库内文件路径）或 registry 查询命令 |
| **E3 推断** | 基于 E1/E2 事实的合理推断，未实测 | 明确写"推断依据" |
| **E4 未知** | 文档未覆盖且未实测 | 明确列为待验证项（多数转 Agent B/C/D） |

注意：E2 事实的"官方文档声称"不等于"实际行为"。实际行为验证属 Agent B（SDK 探针）与 Agent C（RPC 探针）职责，本清单在 §10 预留其证据路径。文档与实际行为不一致时，按任务书 §14 以原始证据为准并建立最小复现。

---

## 2. 身份澄清：Pi 的包名与历史（关键事实）

### 2.1 当前正确包名

- 包名：`@earendil-works/pi-coding-agent` 〔E2：`npm view @earendil-works/pi-coding-agent`，2026-09-18 执行，见 §3.1〕
- 官方仓库：https://github.com/earendil-works/pi （default branch `main`，MIT License，2026-09-18 仍有 push）〔E2：`curl -s https://api.github.com/repos/earendil-works/pi`〕
- 官方文档站：https://pi.dev/docs/latest 〔E2：`curl -sL https://pi.dev/docs/latest` 返回的页面链接与仓库 `packages/coding-agent/docs/` 一一对应〕
- 官方 README（仓库根）：https://github.com/earendil-works/pi/blob/main/README.md
- 作者：Mario Zechner 〔E2：npm package author 字段〕

### 2.2 易混淆项（D1 危险区）

| 包名 | npm latest（2026-09-18 查询） | 实际身份 | 结论 |
|---|---|---|---|
| `@mariozechner/pi` | 0.70.6 | "CLI tool for managing vLLM deployments on GPU pods"，bin 为 `pi-pods` | **不是 Pi coding agent，禁止安装** 〔E2：`npm view @mariozechner/pi@0.70.6`，description/bin 字段〕 |
| `@mariozechner/pi-ai` | 0.73.1 | 旧 scope 的 pi-ai，版本落后于新 scope 的 0.85.1 | 旧 scope，**不用于 D1** 〔E2：`npm view @mariozechner/pi-ai`〕 |
| `@mariozechner/pi-tui` | 0.73.1 | 同上 | 同上 |
| `@mariozechner/pi-agent` | 0.9.0 | 旧 scope 早期包 | 同上 |
| `@mariozechner/pi-proxy` | 0.30.2 | 旧 scope 早期包 | 同上 |
| `@mariozechner/pi-agent-node` | 不存在 | npm 404 | — 〔E2：`npm view` 返回 E404〕 |

**推断（E3）**：Pi 项目原以 `badlogic/pi-mono` + `@mariozechner/*` scope 发布，后迁移至 `earendil-works` 组织 scope；旧包未下架但停止更新。推断依据：README 中仍提及 `pi-mono` 字样（"I show I how publish my pi-mono sessions"），且新旧 scope 作者相同。**对 D1 的影响**：任何教程或旧文档中的 `npm install @mariozechner/pi` 都是错误安装目标；Agent B/C/D 与负责人核对包名时必须以本节为准。

### 2.3 官方仓库包结构

仓库 `packages/` 目录（2026-09-18）：`agent`、`ai`、`chord`、`client`、`coding-agent`、`evals`、`protocol`、`server`、`session-backends`、`telemetry`、`tui`。〔E2：`curl -s https://api.github.com/repos/earendil-works/pi/contents/packages`〕

注意：`packages/agent/docs/rpc.md` 是**实验性 facet-service RPC（基于 chord）的设计规格文档**，与 coding-agent 的 `--mode rpc` JSONL 协议是**两个不同的东西**。〔E2：https://github.com/earendil-works/pi/blob/main/packages/agent/docs/rpc.md 开头标注 "Status: Design specification for experimental facet-service RPC semantics"〕D1 讨论的 RPC 一律指 `pi --mode rpc` 的 stdio JSONL 协议（见 §6）。

另有独立的 `earendil-works/pi-chat` 仓库（Slack/chat 自动化），不在 D1 范围。〔E2：README "For Slack/chat automation and workflows see earendil-works/pi-chat"〕

---

## 3. 可安装包清单（名称、版本、Node 要求、CLI 入口）

### 3.1 核对命令（可复现）

以下命令均于 2026-09-18 在本机执行成功（registry：`https://registry.npmjs.org/`，`npm config get registry` 验证）：

```bash
npm view @earendil-works/pi-coding-agent --json
npm view @earendil-works/pi-ai --json
npm view @earendil-works/pi-agent-core --json
npm view @earendil-works/pi-tui --json
npm view @earendil-works/chord --json
npm view @earendil-works/pi-telemetry --json
```

### 3.2 核对结果

| 包名 | latest（2026-09-18） | engines.node | bin | 描述（registry） |
|---|---|---|---|---|
| `@earendil-works/pi-coding-agent` | **0.85.1** | `>=22.19.0` | `pi` → `dist/bundle/cli.js` | Coding agent CLI with read, bash, edit, write tools and session management |
| `@earendil-works/pi-ai` | 0.85.1 | `>=22.19.0` | — | Unified LLM API with automatic model discovery and provider configuration |
| `@earendil-works/pi-agent-core` | 0.85.1 | `>=22.19.0` | — | General-purpose agent with transport abstraction, state management, and attachment support |
| `@earendil-works/pi-tui` | 0.85.1 | `>=22.19.0` | — | Terminal User Interface library with differential rendering |
| `@earendil-works/chord` | 0.85.1 | `>=22.19.0` | — | Application composition runtime for services, replicated state, RPC, and plugins |
| `@earendil-works/pi-telemetry` | 0.85.1 | `>=22.19.0` | — | Vendor-neutral telemetry contracts and typed schema utilities for pi |

〔E2：§3.1 命令输出。npm 页面：https://www.npmjs.com/package/@earendil-works/pi-coding-agent 等〕

补充事实：

- `@earendil-works/pi-coding-agent` 已发布 45 个版本，最近更新时间 2026-09-05。〔E2：registry `time.modified` 字段〕
- CLI 包直接依赖（含内部包 range 引用）：`@earendil-works/chord`、`@earendil-works/pi-ai`、`@earendil-works/pi-tui`、`@earendil-works/pi-agent-core`（均为 `^0.85.1`），外部依赖均精确锁版（`diff`、`jiti`、`yaml`、`chalk`、`undici`、`typebox` 等）。〔E2：registry dependencies 字段〕
- 发布包内含 `npm-shrinkwrap.json`（npm 用户锁定传递依赖）。〔E2：仓库 README "Supply-chain hardening" 节 + 本机安装目录确认存在〕
- 官方安装命令：`npm install -g --ignore-scripts @earendil-works/pi-coding-agent`（`--ignore-scripts` 为官方推荐，Pi 正常安装不需要 lifecycle scripts）。〔E2：https://pi.dev/docs/latest/quickstart 与 https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/quickstart.md "Install" 节〕
- GitHub Releases 提供带 SHA256SUMS 的源码包与独立二进制构建脚本（`scripts/build-binaries.sh`）。〔E2：仓库 README "Building standalone binaries from release source" 节〕

### 3.3 本机安装核对

- 本机 `pi` 解析路径：`<HOME>/.local/share/fnm/node-versions/v24.21.0/installation/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`（`<HOME>` 为本机用户主目录占位符，即 `readlink -f $(which pi)` 实际输出中的绝对主目录前缀；全局 npm 安装于 fnm 管理的 Node v24.21.0）。〔E1：`readlink -f $(which pi)`〕
- 本机 `pi --version` = `0.85.1`，与 npm latest 一致。〔E1：`pi --version`〕
- 本机 Node = `v24.21.0`，满足 `>=22.19.0`。〔E1：`node --version`〕
- 本机安装的包 `package.json`：`types: ./dist/index.d.ts`，`main: ./dist/index.js`，exports 含 `.`（types+import）、`./rpc-entry`（import）、`./client` 与 `./experimental/plugin`（source-only）。〔E1：读取上述路径 package.json〕

**PENDING_OWNER**：D1 正式基线应锁定哪个精确版本（当前最新 0.85.1 与本机一致，是自然候选，但按任务书 §13 版本基线由负责人定案）。在定案前，Agent B/C 的探针建议统一使用 `0.85.1` 并提交 lockfile。

---

## 4. CLI 入口与运行模式

来源：〔E1：`pi --help` 全文输出，2026-09-18〕＋〔E2：https://pi.dev/docs/latest/usage〕

### 4.1 顶层用法

```
pi [options] [--] [@files...] [messages...]
```

子命令：`pi install|remove|uninstall|update|list|config|auth`（扩展包管理与凭据管理）。

### 4.2 与 D1 直接相关的选项（`pi --help` 原文摘录）

- `--mode <mode>`：输出模式 `text`（默认）、`json`、`rpc`
- `--print, -p`：非交互模式，处理 prompt 后退出
- `--continue, -c` / `--resume, -r`：继续/选择恢复会话
- `--session <path|id>` / `--session-id <id>` / `--fork <path|id>` / `--session-dir <dir>` / `--no-session`
- `--name, -n`：会话显示名
- `--tools, -t <tools>`（白名单）/ `--exclude-tools, -xt`（黑名单）/ `--no-tools` / `--no-builtin-tools`
- `--thinking <level>`：`off, minimal, low, medium, high, xhigh, max`
- `--extension, -e <path>` / `--no-extensions`；`--skill` / `--no-skills`
- `--provider <name>` / `--model <pattern>` / `--api-key <key>`（默认读环境变量）
- `--approve, -a` / `--no-approve, -na`（单次运行的项目信任覆盖）
- `--offline`（禁用启动网络操作，等价 `PI_OFFLINE=1`）
- `--export <file>`（导出 session 为 HTML 后退出）
- 扩展可注册额外 flag（如 `--plan` 来自 plan-mode 扩展）

### 4.3 三种集成入口（D1 相关）

| 入口 | 命令 | 官方文档 |
|---|---|---|
| SDK（进程内） | `npm install @earendil-works/pi-coding-agent` 后 `import { createAgentSession } from "@earendil-works/pi-coding-agent"` | https://pi.dev/docs/latest/sdk |
| JSON 事件流（一次性） | `pi --mode json "prompt"` | https://pi.dev/docs/latest/json |
| RPC（子进程、长连接） | `pi --mode rpc [options]` | https://pi.dev/docs/latest/rpc |

SDK 文档明确给出两者取舍建议原文："The SDK is preferred when: You want type safety / You're in the same Node.js process / You need direct access to agent state / You want to customize tools/extensions programmatically. RPC mode is preferred when: You're integrating from another language / You want process isolation / You're building a language-agnostic client."〔E2：sdk.md "RPC Mode Alternative" 节〕

**注意（E4→转 Agent C）**：RPC 文档同时警告 Node `readline` 不符合协议（会在 U+2028/U+2029 处错误分行，见 §6.2），Python 客户端需自行保证按 `\n` 切分。此为文档级事实，实际行为由 Agent C 验证。

---

## 5. SDK 能力明细

来源（除单独标注外）：〔E2：https://pi.dev/docs/latest/sdk（=仓库 `packages/coding-agent/docs/sdk.md`）〕；类型签名另经本机安装包 `dist/core/agent-session.d.ts` 核对〔E1〕。SDK 示例目录：仓库 `packages/coding-agent/examples/sdk/`（01-minimal 至 13-session-runtime 共 14 个示例）〔E2：GitHub API 列目录〕。

### 5.1 会话创建与工厂

- `createAgentSession(options)` → `{ session, extensionsResult, modelFallbackMessage? }`。可传 `cwd`、`agentDir`（默认 `~/.pi/agent`）、`model`、`thinkingLevel`、`tools`、`customTools`、`sessionManager`、`settingsManager`、`modelRuntime`、`resourceLoader`。
- `SessionManager` 静态工厂：`inMemory()`（不落盘）、`create(cwd)`（新建持久会话）、`continueRecent(cwd)`、`open(path)`、`forkFrom(...)`；`inMemory(cwd, options, entries)` 可从外部存储的 entries 恢复（0.85.0 新增，CHANGELOG #8980）。
- `AgentSessionRuntime`（`createAgentSessionRuntime()`）：负责会话替换类操作 `newSession()` / `switchSession(path)` / `fork(entryId, {position:"at"})` / `importFromJsonl()`。**替换后 `runtime.session` 指向新对象，事件订阅绑定在具体 AgentSession 上，必须重新订阅**（文档原文警告）。
- 运行模式工具导出：`InteractiveMode`（完整 TUI）、`runPrintMode`、`runRpcMode`（SDK 自己也能起 RPC 模式）。

### 5.2 AgentSession 接口（对 D1 五场景最关键）

```typescript
interface AgentSession {
  prompt(text, options?: PromptOptions): Promise<void>;
  steer(text): Promise<void>;          // 流式期间排队转向消息
  followUp(text): Promise<void>;       // 流式期间排队后续消息
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;  // 返回退订函数
  sessionFile: string | undefined;
  sessionId: string;
  abort(): Promise<void>;
  dispose(): void;
  navigateTree(targetId, options?): Promise<{ editorText?; cancelled }>;
  compact(customInstructions?): Promise<CompactionResult>;
  abortCompaction(): void;
  // 状态访问
  agent: Agent; model; thinkingLevel; messages: AgentMessage[]; isStreaming: boolean;
}
```

〔E2：sdk.md "AgentSession" 节；E1：`dist/core/agent-session.d.ts` 中 `steer(text, images?)`、`abort()`、`navigateTree(targetId, options?)` 等签名逐一存在〕

行为要点（文档原文）：

- 流式期间直接 `prompt()` 不带 `streamingBehavior` 会抛错；必须 `steer()`/`followUp()` 或带 `{ streamingBehavior: "steer" | "followUp" }`。
- `steer` 语义：当前 assistant turn 的工具调用执行完后、下一次 LLM 调用前投递。`followUp` 语义：agent 完全停止后才投递。
- `navigateTree()` 在 agent 响应、compaction 或另一次树导航进行中会 **reject**（不排队、不返回 cancelled），需先 `waitForIdle()` 再重试。
- `PromptOptions.preflightResult(success)` 在 prompt 被接受/拒绝时回调一次；接受后的失败走正常事件流，不再有第二个 response。

### 5.3 事件模型（SDK 订阅）

事件类型（`session.subscribe` 可见）：`agent_start`、`agent_end`（`willRetry` 字段）、`agent_settled`（完全收口，无自动重试/压缩/排队继续）、`turn_start`、`turn_end`、`message_start`、`message_update`（`assistantMessageEvent`: `text_start/text_delta/text_end/thinking_start/thinking_delta/thinking_end/toolcall_start/toolcall_delta/toolcall_end`）、`message_end`、`tool_execution_start/update/end`、`queue_update`、`compaction_start/end`、`auto_retry_start/end`、`summarization_retry_scheduled/attempt_start/finished`。〔E2：sdk.md "Events" 节；事件联合类型定义在仓库 `packages/coding-agent/src/core/agent-session.ts` 与 `packages/agent/src/types.ts`（json.md 引用）〕

### 5.4 模型、凭据与设置

- `ModelRuntime.create()`：恢复本地缓存的模型目录（默认不发网络请求；可 `allowModelNetwork: true` + `modelRefreshTimeoutMs` 限量刷新）。目录持久化于 `~/.pi/agent/models-store.json`；刷新每 provider 4 小时节流；`PI_OFFLINE` 禁用网络。
- 凭据解析优先级：运行时覆盖（`setRuntimeApiKey`，不落盘）→ `auth.json`（`~/.pi/agent/auth.json`）→ 环境变量（`ANTHROPIC_API_KEY` 等）→ 自定义 provider fallback。可注入 `InMemoryCredentialStore`。
- `SettingsManager.create() / inMemory()`；全局 `~/.pi/agent/settings.json` 与项目 `<cwd>/.pi/settings.json` 合并，项目覆盖全局。

### 5.5 工具与自定义工具

- 内置工具名：`read`、`bash`、`powershell`、`edit`、`write`、`grep`、`find`、`ls`；默认启用 `read/bash/edit/write`。
- 只读组合：`tools: ["read","grep","find","ls"]` 或导出的 `createReadOnlyTools`。
- 自定义工具：`defineTool({ name, parameters: Type.Object(...), execute })`（typebox schema，参数类型推断）；`customTools: [...]` 传入。
- 传入 `tools` 白名单时须包含要启用的自定义/扩展工具名。
- 工具工厂导出：`createCodingTools`、`createReadOnlyTools`、`createReadTool/createBashTool/...`（SDK 可为自定义 cwd 构建工具）。

### 5.6 扩展加载

`DefaultResourceLoader` 发现路径：全局 `~/.pi/agent/extensions/`、项目 `.pi/extensions/`、settings.json 扩展源；SDK 可用 `extensionFactories` 内联注入、`additionalExtensionPaths` 指定路径、`eventBus` 共享事件总线。扩展通过 `pi.on(...)`、`pi.registerTool(...)` 等参与（完整 API 见 https://pi.dev/docs/latest/extensions）。

### 5.7 类型安全（SDK 侧）

- 包发布含完整 `.d.ts`：本机安装目录 `dist/index.d.ts`、`dist/core/agent-session.d.ts` 等。〔E1〕
- 本机导入验证：`import('.../dist/index.js')` 成功，导出 151 个符号，`createAgentSession`、`createAgentSessionRuntime`、`SessionManager`、`SettingsManager`、`ModelRuntime`、`DefaultResourceLoader`、`defineTool`、`runRpcMode`、`runPrintMode`、`InteractiveMode`、`createReadOnlyTools` 均为 function。〔E1，见 §9.2〕
- 消息/事件类型联合（`AgentMessage`、`AgentEvent`）定义于 `@earendil-works/pi-ai`（`packages/ai/src/types.ts`）与 `@earendil-works/pi-agent-core`（`packages/agent/src/types.ts`），session 条目类型在 `packages/coding-agent/src/core/session-manager.ts`。〔E2：session-format.md "Source Files" 节〕

---

## 6. RPC 模式能力明细

来源（除单独标注外）：〔E2：https://pi.dev/docs/latest/rpc（=仓库 `packages/coding-agent/docs/rpc.md`）〕。官方类型化 Node 客户端参考实现：仓库 `packages/coding-agent/src/modes/rpc/rpc-client.ts`；交互示例：`packages/coding-agent/test/rpc-example.ts`；扩展 UI 协议示例：`examples/rpc-extension-ui.ts`。

### 6.1 启动与协议总则

- 启动：`pi --mode rpc [options]`（常用：`--provider`、`--model`、`--name/-n`、`--no-session`、`--session-dir`）。
- 协议：stdin 逐行 JSON 命令；stdout 逐行 JSON（`type: "response"` 应答 + 异步事件流）。命令可带 `id` 做请求关联，`bash_execution_update` 事件回带其 `bash` 命令的 `id`。
- 官方 Python 最小客户端示例直接给出（`subprocess.Popen(["pi","--mode","rpc","--no-session"], stdin=PIPE, stdout=PIPE)`）。〔E2：rpc.md "Example: Basic Client (Python)"〕

### 6.2 Framing 严格性（对 Agent C 重要）

文档原文要点：严格 JSONL，LF (`\n`) 是唯一记录分隔符；客户端只按 `\n` 切分；可接受 `\r\n`（剥掉尾部 `\r`）；**Node `readline` 不合规**（它还会在 U+2028/U+2029 分行，而这两个字符在 JSON 字符串内合法）。Node 官方示例因此自带 `attachJsonlReader`（StringDecoder + 手动找 `\n`）。〔E2：rpc.md "Framing" 节与 Node 示例〕

### 6.3 命令集（完整清单，来自 rpc.md）

- **提示/队列**：`prompt`（流式期间必须带 `streamingBehavior: "steer"|"followUp"`，否则报错）、`steer`、`follow_up`、`abort`、`clear_queue`（返回被清除的 steering/followUp 文本）
- **会话**：`new_session`（可带 `parentSession`）、`switch_session`、`fork`（从先前 user 消息分叉，返回原消息文本）、`clone`（复制当前活动分支为新 session）、`get_fork_messages`、`get_entries`（append 顺序全部条目；带 `since` 游标增量获取，条目 id 是**跨客户端重启的持久游标**）、`get_tree`（树形结构 + `leafId`）、`get_last_assistant_text`、`set_session_name`、`get_session_stats`（token/成本/上下文占用）、`export_html`
- **状态**：`get_state`（model/thinkingLevel/isStreaming/isCompacting/steeringMode/followUpMode/sessionFile/sessionId/messageCount/pendingMessageCount 等）、`get_messages`
- **模型/思考**：`set_model`、`cycle_model`、`get_available_models`、`set_thinking_level`、`cycle_thinking_level`、`get_available_thinking_levels`
- **队列模式**：`set_steering_mode`（`all` / `one-at-a-time`）、`set_follow_up_mode`（同）
- **压缩/重试**：`compact`、`set_auto_compaction`、`set_auto_retry`、`abort_retry`
- **Bash 直通道**：`bash`（结果进入会话上下文，下一次 `prompt` 才发给 LLM；输出截断时给 `fullOutputPath`）、`abort_bash`
- **命令发现**：`get_commands`（扩展命令/prompt 模板/skills）
- 错误处理：失败命令返回 `success: false` + `error`；解析错误返回 `command: "parse"` 的失败响应。

### 6.4 事件集（stdout 流）

`agent_start`、`agent_end`（含 `messages`、`willRetry`）、`agent_settled`、`turn_start`、`turn_end`（`message` + `toolResults`）、`message_start`、`message_update`（**delta-only**：不带累计 message 快照，需用 `contentIndex` 自行拼装；`message_end.message` 为权威结果）、`message_end`、`bash_execution_update`（直接 bash 命令的流式输出块，带命令 `id`）、`tool_execution_start`（`toolCallId`/`toolName`/`args`）、`tool_execution_update`（`partialResult` 为**累计**结果，非增量）、`tool_execution_end`（`result` + `isError`）、`queue_update`（steering/followUp 队列全文）、`compaction_start/end`（`reason: manual|threshold|overflow`；`aborted`/`willRetry`/`errorMessage` 区分中止与失败）、`auto_retry_start/end`、`summarization_retry_scheduled/attempt_start/finished`、`extension_error`。

### 6.5 Extension UI 子协议

- 对话方法（`select`/`confirm`/`input`/`editor`）：stdout 发 `extension_ui_request`（含唯一 `id`），**阻塞**直到 stdin 收到匹配 `id` 的 `extension_ui_response`；带 `timeout` 时 agent 侧超时自动取默认值。
- 即发即弃方法（`notify`/`setStatus`/`setWidget`/`setTitle`/`set_editor_text`）：只发请求不期待应答。
- RPC 模式下降级/无效的 TUI 方法清单（`custom()` 返回 undefined、`setFooter()` 等 no-op、`getTheme()` 等）见 rpc.md "Extension UI Protocol" 节。`ctx.mode === "rpc"` 且 `ctx.hasUI === true`。〔E2：rpc.md + extensions.md `ctx.mode`/`ctx.hasUI` 节〕

### 6.6 会话/树导航（RPC 侧）

- `get_entries` / `get_tree` 提供完整树与持久游标；`fork` / `clone` / `switch_session` / `new_session` 提供会话级操作；`get_fork_messages` 列可分叉点。
- 对比 SDK 的 `navigateTree()`（原地改叶节点、不产生新文件）：**RPC 命令集中未见与 `navigateTree` 等价的原地树导航命令**。〔E3 推断：基于 rpc.md §Commands 全量清单核对；"未见"指 0.85.1 文档。若 D1 需要经 RPC 做原地树导航，属于能力缺口，需 Agent C 实测确认并以原始证据记录（任务书 §14：文档与行为不一致时以证据为准）〕

### 6.7 会话持久化与恢复（RPC 侧）

- session 自动保存（除非 `--no-session`）；`--session-dir` 自定义目录；重启宿主后 `pi --mode rpc --session <path|id>` 或 `switch_session` 恢复。
- `get_entries` 的 `since` 游标设计目标即"跨客户端重启"的增量同步（rpc.md 原文："an entry id works as a durable cursor … even across client restarts"）。

---

## 7. 权限、安全与进程隔离

来源：〔E2：https://pi.dev/docs/latest/security 与 https://pi.dev/docs/latest/containerization〕

### 7.1 官方安全模型（原文要点）

- "Pi does not include a built-in permission system for restricting filesystem, process, network, or credential access. By default, it runs with the permissions of the user and process that launched it."（README + security.md）
- **Project trust 不是沙箱**：只控制是否加载项目本地资源（`.pi/settings.json`、`.pi/extensions` 等），不限制模型指示工具做什么。保存的信任决策在 `~/.pi/agent/trust.json`；`defaultProjectTrust` 默认 `"ask"`。
- **非交互模式（`-p`、`--mode json`、`--mode rpc`）不弹信任提示**：无已存决策时，`"ask"`/`"never"` 忽略此类项目资源，`"always"` 信任；可用 `--approve`/`--no-approve` 单次覆盖。（对 D1 RPC 探针的含义：默认不加载项目本地扩展，除非显式 `-e` 或 `--approve`。）
- 扩展是 TypeScript 模块，与 pi 进程同权限运行。
- 官方明确：真正的隔离必须来自操作系统或虚拟化/容器边界；进程内部分沙箱会被误解为安全边界。

### 7.2 工具层限制（非安全边界）

- CLI/SDK 白名单/黑名单：`--tools`、`--exclude-tools`、`--no-tools`、`--no-builtin-tools`、settings `defaultTools`。〔E2：`pi --help` + settings.md "Tools" 节〕
- 扩展 `tool_call` 事件：工具执行前触发，**可阻塞**（`return { block: true, reason, terminate }`）、可原地改参数（`event.input` 可变，改后不再校验）。可用 `isToolCallEventType` 做类型收窄。〔E2：extensions.md "tool_call" 节〕这是自建权限/审计层的官方挂载点，但属进程内机制，受 §7.1 约束。
- `tool_result` 事件可在结果落地前修改（middleware 链式）。〔E2：extensions.md "tool_result" 节〕

### 7.3 进程隔离选项（官方 containerization.md，四种模式）

| 模式 | 隔离对象 | 要点 | 额外要求 |
|---|---|---|---|
| Gondolin 扩展 | 内置工具与 `!` 命令（pi 留在宿主） | 微 VM 内执行 read/write/edit/bash/grep/find/ls；宿主 cwd 挂载 `/workspace` | Node >= 23.6.0 + QEMU |
| Plain Docker | 整个 pi 进程 | 官方 Dockerfile 示例（node:24-bookworm-slim）；API key 需进容器 | Docker |
| OpenShell | 整个 pi 进程 | 策略控制沙箱（文件/进程/网络/凭据/推理）；凭据可留在网关侧 | OpenShell gateway |
| Docker Sandboxes (sbx) | 整个 pi 进程 | 凭据以哨兵值进沙箱、egress 时代理替换；宿主存真实凭据 | Docker sbx + 预置凭据 |

〔E2：containerization.md 全文；README "Permissions & Containerization" 节〕

### 7.4 对 D1 的直接推论（E3，供矩阵引用）

- **SDK 路线 = 同进程**：TreeAI 宿主与 Pi 共享权限、内存与事件循环；Pi 内未捕获异常可能直接打翻宿主；权限边界只能靠工具白名单 + `tool_call` 拦截（非安全边界）+ 外部容器。
- **RPC 路线 = 子进程**：天然获得 OS 级进程边界（可 kill、可限权启动）；但工具仍在 pi 子进程的权限下运行，真正的文件系统/网络隔离仍需容器化；代价是 JSONL 协议状态机、事件差异与延迟。
- 两条路线都不是沙箱；**安全等价性取决于是否叠加 §7.3 的容器模式**（这是 PENDING_OWNER 的架构决策输入）。

---

## 8. 版本漂移与供应链事实

- 发布节奏：0.84.4（2026-08-28）→ 0.85.0（2026-09-04）→ 0.85.1（2026-09-05）。〔E2：本机安装包 CHANGELOG.md〕
- 先例：0.85.0 曾意外发布内部实验代码导致 **SDK 导入失败**，0.85.1 修复（issue #9132）；同版本修复 "RPC abort reporting success without cancelling an in-progress manual compaction"（issue #8920）。〔E2：CHANGELOG 0.85.1 节〕——两个先例分别命中 D1 的 SDK 与 RPC 主验证路径，说明锁定版本 + 升级回归测试必要。
- 官方供应链措施：直接外部依赖精确锁版、`.npmrc` `save-exact=true` + `min-release-age=2`、发布包含 shrinkwrap、`--ignore-scripts` 安装、CI `npm audit`。〔E2：README "Supply-chain hardening" 节〕
- 长期规划公开于 RFC：https://rfc.earendil.com/keyword/pi/ 〔E2：README "Contributing" 节〕——**未审计**（Agent A 未逐篇阅读 RFC，列为 E4/待办，负责人如需以 RFC 作为路线图输入应另行安排）。
- session 格式历史迁移：v1（线性）→ v2（树）→ v3（custom 角色），加载时自动迁移。〔E2：session-format.md "Session Version"〕——TreeAI 若直接解析 session 文件需跟随 Pi 版本演进（详见 ADR 边界章节）。

---

## 9. 本机无模型调用验证记录（Agent A 执行）

### 9.1 RPC 协议冒烟（get_state）

命令（在 `/tmp/pi-rpc-smoke` 下执行，`--no-session` 不落盘、`--offline` 禁启动网络）：

```bash
echo '{"type":"get_state"}' | pi --mode rpc --no-session --offline > stdout.log 2> stderr.log
```

结果：**EXIT_CODE=0**。stdout 依次输出：

1. 两条 `extension_ui_request`（`setStatus`，来自本机已装的全局扩展 `pi-switch`，报告 9 个 providers）；
2. `{"type":"response","command":"get_state","success":true,"data":{...}}`，`data` 含 `model`（本机解析到的默认模型为自定义 provider 下的 `deepseek-v4.1-flash`）、`thinkingLevel:"medium"`、`isStreaming:false`、`steeringMode:"one-at-a-time"`、`followUpMode:"one-at-a-time"`、`sessionId`（ephemeral UUID）、`messageCount:0`、`pendingMessageCount:0`。stderr 为空。

结论（E1）：`pi --mode rpc` 入口、JSONL 应答、请求关联、extension UI fire-and-forget 事件均按文档工作；stdin EOF 后进程以 0 退出。**未验证**（转 Agent C）：真实 LLM 流式、steer/abort/resume 场景、子进程清理行为。

**环境注意（影响 B/C/D 复现）**：本机全局装有 `pi-switch` 扩展与多个自定义 provider（含内网 baseUrl），RPC stdout 会混入该扩展的 `extension_ui_request` 事件，且默认模型解析结果取决于本机配置。Agent C 的解析器必须按协议容忍任意 `extension_ui_request` 插入；Agent D 的复现环境如需对齐，应记录本机扩展清单（不复制凭据）。

### 9.2 SDK 导入冒烟

命令（绝对 file URL 直接导入本机全局安装的 dist；`<HOME>` 为主目录占位符，复现时替换为本机实际主目录）：

```bash
node --input-type=module -e "import('file://<HOME>/.local/share/fnm/node-versions/v24.21.0/installation/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js').then(m => { ... })"
```

结果：**成功**，导出 151 个符号；§5.7 列出的 11 个关键 API 均为 `function`。〔E1〕

注意：本验证通过 file URL 导入绕过了 npm 解析（全局包不在 Node 默认解析路径）。Agent B 的 spike 应在自己的 `node_modules` 中以正常 `import "@earendil-works/pi-coding-agent"` 方式安装并验证。**未验证**（转 Agent B）：`createAgentSession` 实际建会话、订阅、steer/abort/resume 场景。

### 9.3 npm registry 可用性

`npm view` 全部成功（§3.1），registry 为官方 `https://registry.npmjs.org/`，无需特殊凭据。〔E1〕本调研**无 BLOCKED 项**。

---

## 10. 未决与移交项

### 10.1 转 Agent B（SDK 探针）验证

- 五场景（basic/tool/steer/abort/resume）实际事件序列与文档 §5.3 的一致性。
- `navigateTree` 拒绝/重试语义、`dispose()` 资源释放、`waitForIdle`。
- 会话替换后重新订阅的实际必要性。
- 预留证据路径：`d1-spikes/evidence/sdk/{basic,tool,steer,abort,resume}/`（结构由 Agent D 的 schema 定义）。

### 10.2 转 Agent C（RPC 探针）验证

- 五场景同条件对照；`\n` 严格 framing 的 Python 实现与 U+2028/U+2029 行为。
- `abort` 后 60 秒收口、子进程/孙进程清理、宿主崩溃后 pi 子进程行为。
- `message_update` delta-only 拼装正确性（无重复/丢失）。
- RPC 侧**是否存在**等价于 SDK `navigateTree` 的能力（§6.6 推断为缺口，需实测）。
- 预留证据路径：`d1-spikes/evidence/rpc/{basic,tool,steer,abort,resume}/`。

### 10.3 转 Agent D（验收）

- 本清单 E2 事实与 B/C 实测不一致项的仲裁记录。
- 秘密扫描对本机 `pi-switch`/自定义 provider 环境的处理。

### 10.4 PENDING_OWNER 事项（本清单产生）

| ID | 事项 | 说明 |
|---|---|---|
| PO-A1 | D1 锁定的 Pi 精确版本基线 | 建议候选 0.85.1（=npm latest=本机版本），定案权在负责人（任务书 §13） |
| PO-A2 | D1 是否使用本机已有 provider/凭据跑真实场景 | 本机存在 `pi-switch` 与自定义 provider；是否直接复用或改用标准 env var 凭据由负责人定 |
| PO-A3 | RPC 原地树导航缺口是否为 D1 否决项 | §6.6 推断 RPC 无 `navigateTree` 等价命令；是否影响 TreeAI 首版由负责人评估 |
| PO-A4 | 是否在 D1 就引入容器隔离对照 | §7.3 四种模式超出 D1 最小范围；若纳入需扩权限，按任务书 §14 登记 |

---

## 11. 来源索引（去重汇总）

官方文档（pi.dev 与仓库 `packages/coding-agent/docs/` 内容一致，2026-09-18 核对）：

- SDK：https://pi.dev/docs/latest/sdk ｜ https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md
- RPC：https://pi.dev/docs/latest/rpc ｜ https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md
- Sessions：https://pi.dev/docs/latest/sessions ｜ .../docs/sessions.md
- Session Format：https://pi.dev/docs/latest/session-format ｜ .../docs/session-format.md
- JSON 模式：https://pi.dev/docs/latest/json ｜ .../docs/json.md
- Extensions：https://pi.dev/docs/latest/extensions ｜ .../docs/extensions.md
- Security：https://pi.dev/docs/latest/security ｜ .../docs/security.md
- Containerization：https://pi.dev/docs/latest/containerization ｜ .../docs/containerization.md
- Settings：https://pi.dev/docs/latest/settings ｜ .../docs/settings.md
- Quickstart：https://pi.dev/docs/latest/quickstart ｜ .../docs/quickstart.md
- 仓库根 README：https://github.com/earendil-works/pi/blob/main/README.md
- 实验性 facet RPC（勿与 coding-agent RPC 混淆）：https://github.com/earendil-works/pi/blob/main/packages/agent/docs/rpc.md
- npm：https://www.npmjs.com/package/@earendil-works/pi-coding-agent

本机文件（E1 证据）：

- `<HOME>/.local/share/fnm/node-versions/v24.21.0/installation/lib/node_modules/@earendil-works/pi-coding-agent/package.json`
- `.../pi-coding-agent/dist/index.d.ts`、`.../dist/core/agent-session.d.ts`
- `.../pi-coding-agent/CHANGELOG.md`
- 冒烟输出：`/tmp/pi-rpc-smoke/stdout.log`、`/tmp/pi-rpc-smoke/stderr.log`（临时目录，不含密钥）

本机执行的命令：§3.1（npm view × 6 + 旧 scope × 6）、§9.1（RPC 冒烟）、§9.2（SDK 导入）、`pi --help`、`pi --version`、`node --version`、`npm config get registry`、`curl` GitHub API（repo 元数据与目录列表）。

---

*本清单只陈述事实与来源，不构成选型建议。比较与评分见 `sdk-vs-rpc-matrix.md`（评分与权重均为 PENDING_OWNER），决策草案见 `adr-001-draft.md`（状态 Proposed，未批准）。*
