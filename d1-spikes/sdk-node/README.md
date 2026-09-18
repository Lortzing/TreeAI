# TreeAI D1 Spike — Node.js/TypeScript Pi SDK 探针（sdk-node）

Agent B 的 D1 技术验证产物：一个**最小、独立、可整体删除**的 Node.js/TypeScript 探针，
用进程内 SDK 方式验证 Pi（`@earendil-works/pi-coding-agent`）是否满足 TreeAI D1 的六项
核心问题（会话生命周期、事件流、工具、steer、abort、跨进程 resume）。

这不是生产代码。不包含 RuntimeAdapter、TreeAI 领域模型、前端或 SQLite（tests/static.test.ts
以声明级正则持续检查这一点）。整个目录删除即回滚。

写入范围：本目录（代码）+ `../evidence/sdk/`（证据）。证据只追加（每次运行新建
`runs/<时间戳>-<pid>/` 目录），从不改写历史失败记录。

## 固定版本（全部精确锁定，lockfile 已提交）

| 组件 | 版本 | 说明 |
|---|---|---|
| Node | v24.21.0 | fnm 管理；`engines: ">=24.21.0 <25"`；Pi 要求 Node >= 22.19.0 |
| npm | 11.19.0 | 装锁文件用 `npm ci`；esbuild postinstall 在本机被 npm 11 拦截，tsx 使用预编译二进制不受影响 |
| @earendil-works/pi-coding-agent | 0.85.1 | 唯一运行时依赖（对应 earendil-works/pi 仓库；`@mariozechner/pi` 是同名无关项目，勿混用） |
| typescript | 5.9.3 | devDependency |
| tsx | 4.23.13 | devDependency，测试与探测运行器 |
| @types/node | 24.13.5 | devDependency |

无 `latest`、`*`、`^`、`~` 或未记录范围（tests/static.test.ts 校验）。

## 安装 → 全量探测

```bash
cd d1-spikes/sdk-node
npm ci                 # 按 package-lock.json 精确安装
npm run typecheck      # tsc --noEmit（strict + noUncheckedIndexedAccess）
npm test               # 全部单测/静态测试（无网络、无凭据即可运行）
npm run probe:all      # 真实探测：basic + tool + steer + abort + resume
# 单场景：
npm run probe:basic
npm run probe:tool
npm run probe:steer
npm run probe:abort
npm run probe:resume
```

环境变量（只列名称，本探针从不打印值）：`PI_PROBE_EVIDENCE_DIR`（证据输出目录覆盖）、
`PI_PROBE_MODEL`（`provider/modelId` 覆盖默认模型选择）、`PI_PROBE_CHILD_TIMEOUT_MS`
（resume 子进程超时，默认 150000）。API key 只从既有环境变量或 Pi 已配置的凭据读取。

## 五个场景（src/scenarios/）

| 场景 | 验证点 | 关键判据 |
|---|---|---|
| basic | 连续 3 个子回合；delta 拼接一致性；stopReason | delta 串 === 最终文本；答案含 `42`；sessionId 跨子回合不变 |
| tool | 只读白名单（`read`）；fixture 真值校验；错误路径 | 工具路径被限制在 fixture 临时副本内；答案含 `MARKER=TREEAI-D1-FIXTURE-7f3a`/`SUM=42`；读不存在文件 → `isError: true` |
| steer | 流中转向 | `queue_update`(steering 非空)；第二个 `agent_start`；最终输出含 `STEERED-OK`；sessionId 不变 |
| abort | 流中中止 + 资源释放 | 中止后 ≤60s 内 settle；`isStreaming=false`；stopReason=aborted；中止后**新会话**仍可正常作答（`5`） |
| resume | 跨进程恢复 | 两个独立 OS 进程（phase A/B）；只有 sessionFile 路径跨边界；B 读回 A 的历史（u≥2 且 a≥2）；答案回忆口令 `TREEAI-RESUME-9c4e`；A/B 子进程事件以全局 seq 合并进场景事件流 |

每个场景：总超时（默认 180s）内完成；`finally` 中逆序执行 cleanup（unsubscribe/abort/
dispose/临时目录删除）；超时/失败也**必须**留下完整证据。

## 证据格式（任务书第 6 节）

- `<scenario>/events.jsonl`：每行一个事件，字段
  `seq`（严格递增，tests/recorder.test.ts + runner 自校验）、`observedAt`（ISO）、
  `implementation:"sdk-node"`、`scenario`、`sessionId`、`piEventType`、`runState`、`payload`、
  `redactionVersion:"d1-v1"`；resume 场景额外带 `probePhase:"A"|"B"`。
- `<scenario>/result.json`：`status`（PASS/FAIL/BLOCKED/NOT_RUN）、`startedAt/endedAt/durationMs`、
  `command`、`exitCode`、`evidenceFiles`、`observations`、`limitations`、`error`（结构化）、
  额外 `blockedReason`/`failedChecks`/`environment`。
- 写入管线：redact（`d1-v1`：key 模式、Bearer、`/Users/<name>/` 家目录路径、敏感字段名）
  → slim（message_update 摘要化、thinking 只留长度、文本上限 16KB、payload 上限 64KB）
  → 逐行 JSON（U+2028/U+2029 转义）→ tmp 文件 → fsync → 原子 rename。
- 子进程 stderr 落盘前同样过 redactString。
- 本地 JSON Schema 回退在 `schemas-local/`（与任务书字段一致）；共享 `schemas/`（Agent D）
  一旦存在则以其为准（src/validate.ts detectSharedSchemas 会报告）。

退出码契约：PASS=0，FAIL=1，BLOCKED=2，NOT_RUN=3；聚合时 FAIL > BLOCKED > NOT_RUN > PASS。
任何失败/阻塞都以非零退出码结束，绝不伪造 PASS。

## 审计记录（任务书第 9 节）

### 适配层代码规模
`src/audit.ts` 在每次运行时统计并写入 `run-summary.json` 的 limitations。当前计数
（`npm run probe` 输出为准）：
- **适配层**（直接绑定 Pi SDK、若选 SDK 路线需要长期维护的部分）：
  `src/pi-bridge.ts`（252 行）+ `src/scenarios/resume-child.ts`（131 行），共 298 行代码
  （不含注释/空行；以 `npm run probe` 每次输出的统计为准）。
- **探针骨架**（录制/校验/脱敏/运行器，与 Pi 无关）：18 个文件、1781 行代码。

### 直接可访问的 Pi 状态/类型（进程内 SDK 路线的实际可得面）
`session.sessionId`、`session.sessionFile`、`session.isStreaming`、`session.messages`、
`session.agent.state.errorMessage`、`session.model`/`thinkingLevel`、
`SessionManager.getEntries()`、`AgentSessionEvent`（带判别的类型联合）、
`AssistantMessage.stopReason`、`ModelRuntime.getAvailable()`。
完整清单（含用途）见 `src/audit.ts` 的 `DIRECT_PI_ACCESS`；每次运行的 result.json 亦引用。

### 错误传播
`prompt()` resolve 后读取 `agent.state.errorMessage` 并分类：认证类错误（401/invalid
api key/auth 等）→ `BlockedError("BLOCKED_CREDENTIALS")`；其余 → 普通 FAIL，结构化 error
带 name/message/stack。resume 子进程经 stdout JSON summary + 退出码（0/1/2）传回
`blockedReason`，场景层据此 markBlocked 或 FAIL。

### 资源释放
`subscribe()` 返回 unsubscribe；场景结束 `dispose()`；abort 场景显式验证
`getActiveResourcesInfo` 前后对比与 settle 时长；resume 子进程各自独立退出；
子进程超时 SIGKILL；fixture 临时副本在 finally 删除。

### 重启恢复的外部标识
跨进程边界**只有**：sessionFile 路径（由 A 产出、B 打开）+ sessionId（校验身份延续）。
phase A 不向 B 传递任何内存对象；Pi 自身配置之外无其他共享状态。Pi 会话文件不是产品 DB
（任务书第 12 节）。

## 运行环境与限制

- **无凭据时的预期结果**：本机 `~/.pi/agent/auth.json` 为空（2 字节）且无相关环境变量
  key，五个真实场景将全部产生结构化的 `BLOCKED_CREDENTIALS` 结果（退出码 2）并保留完整
  证据链。这是诚实结果，不是缺陷；提供凭据后重跑 `npm run probe:all` 即可得到真实
  PASS/FAIL。
- 全部 72 个测试（redact/recorder/validate/runner/scenarios/static/pi-bridge）在无网络、
  无凭据环境下通过；场景逻辑用脚本化 FakeProbeSession（src/fake-session.ts）驱动，
  真实入口 `src/run.ts` 不导入 fake（static 测试强制）。
- 共享 `fixtures/`、`schemas/`（Agent D 产物）当前未出现时，回退到本目录
  `fixtures-local/`、`schemas-local/`；共享目录就绪后自动优先使用（src/paths.ts），
  并在 result limitations 中注明回退状态。
- 脱敏版本 `d1-v1`：保留 key 前缀便于辨识，替换凭据本体；探针自身内容
  （prompt、marker、口令）不属于敏感串，测试验证了边界。
- 不 fork、不修改 Pi；仅作为依赖使用。

## PENDING_OWNER（需负责人决定，本探针不定案）

1. **最终宿主语言/技术路线**：进程内 SDK（本探针验证）vs RPC 隔离进程（Agent C 探针
   验证）。本目录结果仅证明 Node/TS 内嵌可行性与成本，不构成选型结论。
2. **正式版本基线**：Node 大版本、包管理器（npm vs pnpm 等）、Pi SDK 版本升级策略。
3. **权限策略**：tool 场景目前固定最小只读白名单（`read`），生产环境的工具白名单与
   批准流程未定。
4. **凭据供给方式**：当前依赖 Pi 已配置的凭据或既有环境变量；正式的密钥管理方案未定。
