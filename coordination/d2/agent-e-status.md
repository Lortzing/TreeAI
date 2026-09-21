# Agent E 状态文件（D2 Wave 1）

- Agent：E（EventJournal、RunState 投影、脱敏与可观测性）
- 启动时间：2026-09-21
- 本文件仅由 Agent E 维护；Integrator 汇总时只读引用。
- 前置条件确认：Gate 0 已通过（`coordination/d2/CONTRACT-FREEZE-1.md` 状态 PASS，Integrator 2026-09-21 复验签署）；contracts 已冻结，本 Agent 按 `packages/contracts` 冻结面实现，不修改契约。

## 1. 启动记录（按任务书 §12 要求）

### 1.1 已读材料

1. `/Users/tal/Downloads/TreeAI_D2_Agent执行任务书.md` v1.0（2026-09-21）——D2 唯一执行入口；§2 所有权、§3 契约原则、§5 Wave 1 Agent E 职责、§9 交接格式、§12 启动指令。
2. `d1-spikes/research/adr-001-draft.md` 顶部批准记录（2026-09-20 负责人批准 D1 Go、候选 1：TypeScript/Node.js + Pi SDK 进程内嵌入、Pi 0.85.1、授权 D2）与 §4 数据边界（TreeAI DB 是产品事实源；Pi session 仅作引用三元组 sessionFile/sessionId/entryId；写入仅经 Pi 官方 API；凭据归 Pi 管理、不复制不代理）。
3. `d1-spikes/reports/blockers.md`——D1 负责人决定记录（DECISION-001~009 全部关闭）、D2 授权记录（EventJournal 在授权模块边界内）、DELIVERY-005 教训（合成脱敏语料中的秘密必须运行时拼接，否则触发秘密扫描；本 Agent 测试语料沿用该纪律）。
4. `d1-spikes/reports/d1-verification.md`——最终验收 `verify-20260920T124525829Z.json`，30/30 PASS、exit 0；tree-navigation 为正式验收项。
5. `packages/contracts/src/` 全部源文件（events.ts / run-state.ts / errors.ts / identifiers.ts / session-reference.ts / json.ts / branding.ts / pi-runtime.ts / tool-decision.ts / index.ts）与 `packages/contracts/tests/usage-examples.ts`（示例 D 是 Agent E 的编译期消费示例）。
6. `docs/d2/contracts-README.md`（§5 关键设计决定：seq 双层语义、失败语义、`TreeAIEventType` 开放联合）与 `coordination/d2/CONTRACT-FREEZE-1.md`（冻结记录 + §4.6 设计取舍备案：不增设 `interrupted` 第七态，宿主崩溃恢复按 `failed`+`unknown`+中断标注处理）。
7. 参考（只读，不复制为生产代码）：`d1-spikes/sdk-node/src/redact.ts` 与 `tests/redact.test.ts`——D1 已验证的脱敏模式清单与测试思想（任务书 §1.3 允许复用测试思想）。

### 1.2 理解的边界

- **独占写入**：`packages/event-journal/**`、`coordination/d2/agent-e-*.md`。
- **禁止修改**：contracts、persistence migrations、根配置/锁文件、其他 package、`tests/`、`schemas/`、`scripts/`、`.github/`、`d1-spikes/**`（只读证据区）、`apps/runtime-smoke/**`。
- **依赖方向**：只依赖 `@treeai/contracts`（纯类型，`import type`）；不 import Pi、不横向依赖其他 package。runtime-smoke 对本包的既有依赖版本为 `0.0.0`（`apps/runtime-smoke/package.json`），本包版本保持 `0.0.0` 不变。
- **Pi 类型隔离**：event-journal 不 import `@earendil-works/pi-coding-agent`；Pi 原始事件只以契约类型 `PiRuntimeEvent`（归一化、已脱敏）作为输入，转换为 `TreeAIEvent` 时只保留脱敏 payload 与证据引用（source `pi-runtime` + refId），不复制 Pi 原始敏感内容。
- **状态机纪律**：使用冻结六态与 `RunStateTransitions` 迁移表；不新增 domain state；abort→`aborted`（`user-abort`）、模型错误→`failed`（对应 code）、宿主崩溃恢复→`failed`（`unknown` + `hostInterrupted`）、宿主 dispose 在途 run→`aborted`（`user-abort`）——与 run-state.ts I4/I6 和 contracts-README §5.3 一致。
- **脱敏边界（本模块的实现解释，README 详述）**：调用方必须传入已脱敏 payload（契约义务）；journal 在持久化前再做深度脱敏兜底。深度脱敏覆盖：API key 形态（sk-ant-/sk-proj-/sk-/gh_/AIza/xai-）、Bearer/Authorization/x-api-key 头、Cookie/Set-Cookie 值、provider URL 中嵌入的凭据（userinfo 与含 token 的 query 参数；host/path 非秘密、保留供审计）、环境变量式赋值（`*_API_KEY=...` 等）、敏感 JSON 键（token/authorization/cookie/...）、家目录绝对路径（`/Users/<name>`、`/home/<name>`、`C:\Users\<name>`）。
- **脱敏红线**：`TreeAIError.cause` 不持久化（errors.ts 明确 event-journal 承担该义务）；evidence 只存引用不存正文；测试中的秘密一律运行时拼接合成（DELIVERY-005 纪律），任何测试不得把真实秘密写入日志。
- **工具链**：TypeScript 5.9.3（根 devDependencies，已存在）、Node 内置 `node:test` 测试框架与 `node:fs`/`node:crypto`；**不新增任何依赖**，故无需 dependency request。

### 1.3 计划修改目录

```text
packages/event-journal/
├── package.json          # 仅更新 scripts（typecheck/build:test/test）；依赖不变
├── tsconfig.json         # include src+tests（typecheck 用，extends 根基线）
├── tsconfig.build.json   # 测试构建（emit 到 dist/，根 .gitignore 已忽略 dist/）
├── README.md             # 事件兼容、脱敏边界、恢复语义、限制
├── src/
│   ├── index.ts          # 公开 API
│   ├── errors.ts         # EventJournalError（模块内部基础设施错误）
│   ├── redact.ts         # 深度脱敏 d2-v1（含 findRemainingSecrets 自检）
│   ├── journal.ts        # EventJournal 核心 + Memory/Jsonl 两种存储
│   ├── projector.ts      # RunState 投影（非法迁移/双终态拒绝 + 审计异常记录）
│   ├── recovery.ts       # 宿主退出后非终态 run 的收敛（host-crash/host-dispose）
│   ├── recorder.ts       # 类型化写入 API（含 PiRuntimeEvent 转换、错误/耗时/session 变化/tree navigation 记录）
│   └── audit.ts          # 可观测性读模型（错误/耗时/session 引用变化/导航记录汇总）
└── tests/                # node:test 单测（seq、投影、恢复、脱敏语料、未知事件、审计）
```

### 1.4 关键设计决定（实现前登记，供 Integrator/Agent A 知悉）

1. **journal 存储**：JSONL 追加文件（`JsonlEventJournal`）+ 内存实现（`MemoryEventJournal`，供测试/Agent F mock）。文件是 event-journal 自有的审计日志；不写 TreeAI 产品数据库（那是 persistence/Agent C 的职责），不写 Pi session 文件。
2. **seq 语义**：`append`（调用方给 seq）负责校验——同 run 内 seq 严格递增、重复 seq（`duplicate-seq`）、低于当前最大值的新 seq（`seq-below-max`）、重复 eventId（`duplicate-event-id`）均可检测并拒绝；拒绝以结果对象返回（可审计、不静默）。`appendNext`（recorder 使用）在序列化临界区内自动分配 `maxSeq+1`，杜绝并发双写。
3. **显式 vs 派生迁移**：`run.state-changed{from,to}` 为显式迁移记录（projector 校验 from 同步 + 迁移表合法性）；`agent.started`/`run.abort-requested`/`runtime.error`/`agent.settled`/`runtime.recovered` 为派生收敛信号（projector 按冻结迁移表推导，`running`→`aborted` 的 user-abort 收敛按 I4 经过 `aborting` 两步）。非法迁移不应用到状态，但作为异常记录在投影结果中（journal 本身保留事件）。
4. **恢复语义**：`recoverInterruptedRuns("host-crash" | "host-dispose")` 对每个非终态 run 追加 `runtime.recovered` 事件（evidence source `treeai-journal`）：host-crash → `failed`（code `unknown`、details `{hostInterrupted:true}`）；host-dispose 且在途（running/aborting）→ `aborted`（code `user-abort`）；host-dispose 且仍为 `queued`（从未在途）→ `failed`（code `unknown`、`{hostInterrupted:true, neverStarted:true}`）——因冻结迁移表不允许 `queued→aborted`，且 I6 的 dispose 条款限定"在途的 Run"（此解释已在 README 与 handoff 记录；若负责人希望 queued 也能收敛为 aborted，需 CONTRACT-CHANGE 修改迁移表）。
5. **崩溃后可重开**：JSONL 尾部不完整行（无换行结尾的 torn write）在 open 时截断修复并报告（WAL 标准做法，只截掉从未提交完成的部分行，不触碰任何完整事件行）；文件中部损坏行则显式报错拒绝打开，不静默跳过。
6. **event-journal 自有事件类型**：`duration.recorded`（耗时审计记录）。`TreeAIEventType` 是开放联合（contracts events.ts），此类型不进入 contracts 冻结面；若 Agent A 认为应冻结，属非破坏性新增，可后续登记。
7. **payload 约定（本模块读写两侧 + 投影器消费）**：`runtime.error{error}`、`agent.settled{status?,error?,timing?}`、`runtime.recovered{cause,from,resolvedTo,error}`、`session.created/restored/replaced{reference,previous?}`、`tree.navigated{fromEntryId,toEntryId,sessionId,context?}`、任意事件可带 `timing{startedAt,endedAt,durationMs?}`。与 Agent B 的对齐需求见 §1.6。

### 1.5 验证命令（计划）

```bash
# 包级（Agent E 自验，Wave 1 期间的可执行入口）
cd packages/event-journal && npm test          # typecheck + 构建 + node --test
# 根统一类型检查（Integrator 入口，覆盖本包 src+tests）
npm run typecheck
# 单步等价
./node_modules/.bin/tsc --noEmit -p packages/event-journal/tsconfig.json
cd packages/event-journal && ../../node_modules/.bin/tsc -p tsconfig.build.json && node --test 'dist/tests/*.test.js'
```

### 1.6 横向对齐请求（只登记，不直接改他人范围）

- **Agent B（runtime-pi）**：归一化事件的 payload 约定若与本模块投影器消费的约定（§1.4 第 7 条）不一致，请以 `coordination/d2/agent-b-status.md` 或直接联系 Integrator 对齐；投影器对未知 payload 形态的行为是"记录异常、不改状态"，不会崩溃。`PiRuntimeEvent` 的 `agent.settled` 事件建议带 `status`（缺省时投影器按当前状态推导：aborting→aborted、running→succeeded）。
- **Agent C（persistence）**：Run 实体状态与 journal 投影的一致性由调用方（runtime-smoke/Integrator）编排；本模块提供 `projectRunState` 作为从事件流推导状态的唯一实现。若 persistence 需要订阅投影结果，通过 Integrator 协调接口。
- **Agent F（verify:d2）**：本模块导出 `findRemainingSecrets`（自检用秘密探测）与 `REDACTION_VERSION = "d2-v1"`，可供验收器/秘密扫描复用；是否接入由 Agent F 决定。
- **Agent A**：`duration.recorded` 类型与 §1.4 第 7 条 payload 约定的登记（非破坏性，不改契约文件本身）。

### 1.7 阻塞与依赖

- 无凭据、无环境阻塞（纯本地实现 + 单测，无模型调用）。
- 无新增依赖需求（TypeScript/node:test/fs/crypto 均已在基线内）。
- 待 Integrator：Wave 1 结束后把 `packages/event-journal` 的 `npm test` 接入根 `npm test`（根 script 现为占位 exit 3，不属本 Agent 修改范围）。

## 2. 执行结果（2026-09-21 实测回填）

- 状态：PASS（Agent E 范围内；详见 `coordination/d2/agent-e-handoff.md`）。
- 实测命令与退出码：
  - `cd packages/event-journal && npm test`：**0**（typecheck 0 + 构建 0 + node --test 73/73 通过，含文件 journal 的重开/恢复/torn-tail 用例）
  - `npm run typecheck`（仓库根）：**0**（@treeai/event-journal 计入 checked；期间观察到 runtime-pi 一次瞬时编译错误，系 Agent B 并行写入的中间态，复跑时已消失，最终全绿）
  - `bash packages/contracts/scripts/check-no-pi-imports.sh`（contracts 侧隔离检查，顺带确认未受影响）：**0**
  - `npm test`（仓库根，Integrator 占位）：3（NOT_IMPLEMENTED，非本模块失败）
- 交付文件：src 9 个文件（index/errors/redact/journal/projector/recovery/recorder/audit/util）、tests 6 个文件、README、tsconfig.build.json、package.json scripts 更新；明细见 handoff。
- 修复记录：实现过程发现并修复了 d2-v1 的一个真实缺陷——`COOKIE_HEADER_RE`（大小写不敏感 + 词边界）会命中 "Set-Cookie:" 中的 "Cookie:" 子串，先行破坏 Set-Cookie 属性保留逻辑；已加 `(?<!Set-)` 负向后行断言修复并被测试覆盖。
