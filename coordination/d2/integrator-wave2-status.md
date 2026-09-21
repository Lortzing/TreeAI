# Integrator Wave 2 Status

- 执行人：Integrator（Wave 2 集成 + Gate 1/Gate 2 离线收口）
- 开始：2026-09-21（本文档先于任何代码修改创建，按任务书要求记录已读材料、边界与计划；执行结果在文末追加）
- 完成：2026-09-21 —— Wave 2 全部七项必做完成；离线门禁诚实终态 `verify:d2` = 20 PASS / 0 FAIL / 0 BLOCKED / 1 NOT_RUN（仅 d1-repro，exit 3）。live 未冒充、未越界、未提交 git。

## 一、已读材料

1. 任务书 `~/Downloads/TreeAI_D2_Agent执行任务书.md`（Wave 2 §6.1 十一步流程、Gate 1/Gate 2 命令、Integrator 交付物、退出码约定、所有权规则）
2. `coordination/d2/agent-{a,b,c,d,e,f}-handoff.md` 全部六份 + 各自 status 追踪
3. `packages/contracts/src`（全部冻结契约：session-reference、run-state、pi-runtime-events、tool-policy、event-journal 等）
4. 所有 package README（contracts/runtime-pi/persistence/tool-policy/event-journal）
5. `apps/runtime-smoke` Gate 0 骨架（package.json/tsconfig.json/src/gate0-skeleton.ts）
6. `scripts/verify-d2.js`、`scripts/verify-d2-selftest.js`、`scripts/verify-d2-live.js`、`scripts/typecheck.js`、`tests/support/verifier/{verdict,secret-scanner,evidence}.ts`、`tests/live/framework.ts`、`tests/support/fake-pi-runtime.ts`、`tests/support/harness.ts`
7. `packages/runtime-pi/src/{index,pi-runtime,pi-sdk-port,events,errors,redact}.ts`、`packages/runtime-pi/tests/helpers.ts`（fake port 参考语义）
8. `packages/persistence/src/tree-repository.ts`、`packages/event-journal/src/{journal,recorder,projector,recovery,redact}.ts`、`packages/tool-policy/src/{engine,config,authorization,audit,paths}.ts`
9. `.gitignore`、根 `package.json`（当前 gate0 占位脚本）
10. d1-spikes：确认为只读参照，本阶段不触碰（`--d1-repro` 需要 d1-spikes 写授权 + 网络，属负责人动作）

## 二、集成边界（可写 / 不可写）

可写：
- 根 `package.json` / `package-lock.json` / 根 `tsconfig`（无根 tsconfig，typecheck 由 scripts/typecheck.js 逐 workspace 执行）
- `apps/runtime-smoke/**`
- `evidence/d2/**`（追加，不覆盖）
- `docs/d2/**`、最终 README/报告
- `coordination/d2/integrator-*.md`（本文件）

**显式集成动作（Agent F 请求，经任务书授权）**：`packages/runtime-pi/package.json` 增加 `main`/`exports`/`types` 入口（指向 `src/index.ts`，Node 24 type-stripping 直接解析）。只加入口字段，不改 scripts、不改 `src/index.ts` 公开工厂、不改 Pi 0.85.1 依赖、不改 B 的任何业务逻辑。

不可写：contracts、persistence、tool-policy、event-journal 的任何文件；tests/、schemas/、scripts/verify-d2*、.github/、d1-spikes、其他 Agent 状态文件。发现生产模块问题只记录阻塞，不越界代修。

## 三、计划

1. **runtime-pi 包入口**：加 `main`/`exports`/`types`；验证 `npm test --workspace=@treeai/runtime-pi` 仍 exit 0；live framework 的 import 探测（node -e 动态 import 断言 createPiRuntime 为 function；不运行任何真实 Pi 调用、不读 ~/.pi）。
2. **apps/runtime-smoke 真实实现**（替换 Gate 0 skeleton）：
   - `src/fake-pi-port.ts`：本 app 自有的确定性 fake PiSdkPort（独立实现；以 B 的 tests/helpers.ts 为 0.85.1 语义参考，不复制到生产模块）
   - `src/scenario.ts`：§6.1 十一步离线全流程（Forest/Tree/双分支、两轮 prompt、Episode/Run/SessionReference/事件、navigateTree 同 session/file/leaf、双分支重启恢复、abort 终态、session 缺失降级、ToolPolicy 越权拒绝、journal 严格 seq + 脱敏审计）
   - 测试用 `node --test`，fake port 只出现在 app 目录内，仅离线
   - tool-policy 包无 main 入口（Agent D 边界内未交付，Integrator 不可改其 package.json）：经 Node `#subpath-imports` 别名指向 app 本地编译产物（dist/ 已被根 .gitignore 忽略），tsconfig `paths` 指向源码做 typecheck；event-journal 经其已声明 main（dist）消费，测试前先跑其 `build:test`
3. **runtime-smoke 脚本**：`build:deps`/`typecheck`/`test`；`npm test -w @treeai/runtime-smoke` 必须 exit 0
4. **根 package.json 接线**：保留 `typecheck`；`test` = 五包 npm test + `tests/unit/*.test.ts`（+ tests/integration、tests/live，耗时合理则含）；`test:integration` = runtime-smoke + `tests/integration/*.test.ts`；`verify:d2`/`verify:d2:live`/`verify:d2:selftest` 接到 F 的脚本。缺凭据时 live 永远不冒充 PASS。
5. **实跑并记录真实退出码**：`npm run typecheck`、`npm test`、`npm run test:integration`、`npm run verify:d2`、`npm test -w @treeai/runtime-smoke`、`node scripts/verify-d2-selftest.js`。预期：verify:d2 接线 runtime-smoke 后 d1-repro 仍 NOT_RUN（未显式 `--d1-repro`，F 冻结语义，不改）→ exit 3 属诚实状态。
6. **证据 + 文档**：追加 `evidence/d2/runs/`；创建 `docs/d2/D2-verification.md`、`docs/d2/D2-known-limitations.md`、`docs/d2/D2-owner-checklist.md`（区分 D1 事实 / D2 新增 / 离线 / live / 人工 / 生产未批准）。
7. **Gate 1 检查**：逐包 test/typecheck、无私有 Pi import / 无 latest / 无源码补丁 / 无 session JSONL 直写、依赖请求结论（agent-c-1 等）、handoff 完整性、secret scan 无发现。

## 四、设计决定（集成层）

- **journal 按进程代际分文件**：event-journal 的 eventId 唯一性是 journal 全局 Set；B 的运行时事件 eventId 为实例生命周期内 `pi-runtime-<seq>`。若同一 journal 跨进程重启复用，两次 `pi-runtime-1` 会触发 duplicate-event-id。集成层决定：每次"进程代际"（scenario 内一个 runtime 实例周期）使用独立 journal 文件（`journal-gen-1.jsonl` / `journal-gen-2.jsonl`）。这是集成设计选择，非模块缺陷；已知限制中记录。
- **ToolPolicy 消费机制**：tool-policy 包无 main 入口（Agent D 范围）且内部 import 用 `.js` 后缀（Node type-stripping 不重写），无法从源码直接加载。app 的 package.json `imports` 字段把 `#tool-policy` 解析到 app 本地编译产物；tsconfig `paths` 把同一 specifier 映射到源码供 typecheck。机制已在 scratch 目录实证。
- **测试 stdout 卫生**：F 的 secret-scanner 会扫描 evidence（含 verify-d2 捕获的 runtime-smoke 测试 stdout）。所有断言消息使用静态文本；测试输出只打印布尔值/计数/相对标记，不打印绝对路径（home-path 规则）、不打印任何 Bearer/API-key 形态字符串。脱敏探针 token 只写入临时目录文件，永不回显。
- **live framework 工厂签名不匹配（记录，不修）**：`tests/live/framework.ts` 以 `factory({piVersion, model, sessionDir, apiKey})` 调用工厂，而 B 的 `createPiRuntime(options?)` 实际接受 `PiRuntimeConfig{port, agentDir, defaultCwd, thinkingLevel, tools, abortConvergenceMs}`。接通入口后真实凭据 live run 仍会因结构不匹配而失败——这是 F 侧测试框架与 B 侧工厂签名的接口偏离，超出 Integrator 可写范围（双方文件均不可改）。记录为已知限制 + 负责人决策项。

## 五、执行记录（实际命令与退出码）

环境：Node 24.21.0 / npm 11.19.0 / TS 5.9.3 / Pi 0.85.1（exact）。全部命令在仓库根执行；脱敏日志存 `evidence/d2/runs/integrator-wave2-20260921T104955Z/`。

### 5.1 代码交付（先于门禁运行）

1. **`packages/runtime-pi/package.json`（显式授权动作）**：加入 `"main": "./src/index.ts"`、`"types": "./src/index.ts"`、`"exports": { ".": "./src/index.ts" }`。验证：`npm test --workspace=@treeai/runtime-pi` exit 0（51/51）；动态 import 探测 `createPiRuntime` / `createPiRuntimeFromConfig` 均为 function，exit 0；`tests/live/framework.ts` 的 `loadPiDriver()` 现返回 `driver: pi`（发现成功，无真实调用、不读 `~/.pi`）。
2. **`apps/runtime-smoke/**`（Gate 0 skeleton 替换为真实实现）**：
   - `src/fake-pi-port.ts`：结构化确定性 fake PiSdkPort（无 runtime-pi import；兼容性由 createPiRuntimeFromConfig 调用点强校验）。镜像 Pi 0.85.1 语义：append-only entry tree、lazy JSONL 持久化（首个 assistant entry 后）、user-target 导航落到 parent（fork 点）、abort 收敛 synthetic "aborted"、hang 模式模拟在途、openSessionManager 对缺失文件 ENOENT。session id 计数为模块级（跨 port 实例唯一，防止 gen-2 文件名碰撞）。
   - `src/scenario.ts`：§6.1 十一步全流程 + 跨模块一致性终检（8 runs：5 succeeded / 2 failed / 1 aborted；projection === DB === 预期；anomalies 空；seq 1..N 连续；journal 全部 runId 都在 DB）。
   - `src/main.ts`（CLI，仅输出 marker 行）+ `src/index.ts`（re-export）。
   - `tests/smoke.test.ts`（in-process 全流程）+ `tests/sandbox.test.ts`（真实子进程 + 隔离 HOME：exit 0、marker 输出、sandbox HOME 无 `.pi`、stdout 无 Bearer 形态；mkdtemp 用后清理）。
   - 构建：`tsconfig.tool-policy-build.json` 编译 tool-policy 到 app 本地 `dist/`（`.gitignore` 已忽略）；package.json `imports` 把 `#tool-policy` 指到该产物；tsconfig `paths` 指回源码做 typecheck；`build:deps` 先编译 tool-policy 再跑 event-journal `build:test`。
3. **修复（Integrator 范围内）**：spawn 子进程间歇性 exit 13（"unsettled top-level await"）——fake 的 hang 循环原用 unref'd 计时器，主流程等待该 run 收敛时事件循环可能清空。修复：hang 循环改用 ref 计时（在途 run 必须能唤醒进程），崩溃模拟点显式 `dispose()` 回收僵尸（真实进程死亡本会回收一切）。修复后 30/30 spawn 全部 exit 0；完整套件连续 10 轮 exit 0、fail 0。
4. **根 `package.json` 接线**：`typecheck` 保留；`test` = 五包 npm test + `node --test tests/unit` + `tests/integration` + `tests/live`（三套各一次调用，与 F 验证器同构）；`test:integration` = runtime-smoke + F integration；`verify:d2` / `verify:d2:live` / `verify:d2:selftest` 接到 F 脚本原样（无 flag 注入）。

### 5.2 门禁实跑（真实退出码）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run typecheck` | 0 | 六个含源 workspace 全部通过（含 runtime-smoke） |
| `npm test` | 0 | 五包套件 + F unit 75 + integration 8 + live selftest 3 |
| `npm run test:integration` | 0 | runtime-smoke 2/2 + F integration 8/8 |
| `npm test -w @treeai/runtime-smoke` | 0 | 沙箱子进程离线运行 + 十一步全流程（gen1=37 / gen2=45 journal events、1 次恢复、8 项策略决定、session 文件 created=2 persisted=1） |
| live framework `loadPiDriver()` 探测 | 0 | `driver: pi`（工厂可发现；无真实调用） |
| `npm run verify:d2` | **3** | **20 PASS / 0 FAIL / 0 BLOCKED / 1 NOT_RUN**——唯一 NOT_RUN 为 d1-repro（未显式 `--d1-repro`，F 冻结语义，未修改）；runtime-smoke 检查项已 PASS。此为离线运行的诚实终态，非失败 |
| `npm run verify:d2:selftest` | 0 | 4/4（control exit 0；注入 secret / bad-schema / illegal-exit-codes 均被抓为 exit 2） |
| `npm run verify:d2:live`（无凭据） | **3** | 3 PASS（schema/exit-codes/evidence 卫生）+ 6 场景 BLOCKED（缺 `TREEAI_LIVE_PROVIDER_ID` / `TREEAI_LIVE_MODEL_ID` / `TREEAI_LIVE_API_KEY`）——绝不冒充 live PASS |

证据（追加，未覆盖历史）：F 验证器自建 `evidence/d2/runs/d2-offline-20260921T104713263Z/`（接线后首跑）与 `d2-offline-20260921T105411091Z/`（最终树终跑，权威记录：20 PASS / 0 FAIL / 0 BLOCKED / 1 NOT_RUN）、`d2-live-20260921T105025475Z/`、`evidence/d2/selftest/`；Integrator 门禁日志 `evidence/d2/runs/integrator-wave2-20260921T104955Z/`（gate-commands.json + 7 份脱敏日志：绝对路径替换为 `<repo>`/`<userhome>`/`<tmpdir>` 占位符）。

### 5.3 Gate 1 检查结果

| 项 | 结果 |
|---|---|
| 逐包 test/typecheck | PASS（§5.2 前两行；contracts 为脚本门禁：negative-type-tests + no-pi-imports） |
| 无私有 Pi import | PASS——生产代码唯一 Pi 引用是公开包根 `import * as Pi from "@earendil-works/pi-coding-agent"`（`packages/runtime-pi/src/pi-real-port.ts`，授权 seam）；全 packages/src 无 `#imports`/子路径/dist 穿透 |
| 无 latest / 源码补丁 | PASS——Pi 精确 0.85.1（声明、安装、lockfile 一致）；无补丁文件 |
| 无生产包 session JSONL 直写 | PASS——packages/*/src 无 `.jsonl`/`writeFileSync`/`appendFile`；唯一会话文件写入者是 app 本地 fake |
| 依赖请求有结论 | PASS——`agent-c-1`（node:sqlite，零 npm 依赖）已批准并附复跑记录（45/45）；无其他请求 |
| handoff 完整 | PASS——`agent-{a..f}-handoff.md` 六份齐全 |
| secret scan | PASS——F 门禁扫描区（tests/、schemas/d2/、.github/workflows、evidence/d2/、scripts/verify-d2*）0 发现；Integrator 自有区（apps/runtime-smoke、docs/d2、coordination/d2/integrator-*）经 F scanner 复扫 0 发现（本文件绝对路径已改写为 `~` 相对形式） |

Gate 1 备注（范围外、仅记录）：F scanner 另在四份 Wave 1 agent status 文件（agent-{a,b,d,e}-status.md）标记绝对 home 路径（home-path 规则）。这些文件不在官方门禁扫描范围、也非 Integrator 可写；是否规整由负责人决定（已写入 owner-checklist §3）。

### 5.4 集成发现（跨模块，host 层已绕开，未越界修改任何包）

1. **runtime.error 载荷形状不匹配**：runtime-pi 顶层 `{code,message}` vs event-journal projector 期望 `{error:{code,message}}`——host EventForwarder 适配后经 recordCustom 落账（保 pi-runtime 证据链）。
2. **restoreSession 缺文件 precheck 不发 runtime.error**：只有 prompt 路径失败会发事件；host 需自行 `recorder.recordError`。
3. **journal 全局 eventId 唯一性 × 实例级 `pi-runtime-<seq>`**：跨进程代际复用同一 journal 会 duplicate-event-id（场景内已实证该拒绝）；集成层决定每代际一个 journal 文件。
4. **live framework 工厂形状不匹配**（F 侧 `factory({piVersion, model, sessionDir, apiKey})` vs B 侧 `PiRuntimeConfig`）：接通入口后真实凭据 live 仍会失败；双方文件均不可写，记录待负责人决策。
5. **unref'd 计时器事件循环饿死**（app 内已修复）：在途 run 的 pacing 必须 ref 计数；被弃 run 必须显式回收。生产 host 嵌入应遵循同一纪律。
6. **tool-policy 无包入口**：经 `#subpath-imports` + app 本地编译消费（§四）；生产消费者需要包主交付入口。

## 六、阻塞与待负责人事项

以下事项 Integrator 无权决定或执行，全部保留给负责人（详见 `docs/d2/D2-owner-checklist.md`）：

1. **live 凭据**：提供 `TREEAI_LIVE_PROVIDER_ID` / `TREEAI_LIVE_MODEL_ID` / `TREEAI_LIVE_API_KEY` 后运行 `npm run verify:d2:live`；当前 6 场景 BLOCKED（exit 3，诚实态）。
2. **live 工厂形状不匹配**（§5.4.4）：需指派 F 侧或 B 侧修改其一；凭据齐备前该问题独立阻断真实 live run。
3. **d1-repro**：需显式 `--d1-repro` + 网络 + d1-spikes 写授权；未获授权前 `verify:d2` 保持 exit 3（唯一 NOT_RUN）。F 冻结语义未动。
4. **跨模块归一化决策**（§5.4.1–3、6）：runtime.error 载荷、precheck 事件可见性、journal eventId 命名空间、tool-policy 包入口——每项均可在 host 层继续绕开（runtime-smoke 即参照实现），或由负责人指派对应包修改。
5. **生产发布**：未批准。离线证据 ≠ 真实 SDK 行为、时序与故障面；发布前置条件见 owner-checklist §4。
6. **Wave 1 agent status 文件中的绝对 home 路径**（§5.3 备注）：范围外，待负责人定夺。
