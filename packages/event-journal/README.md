# @treeai/event-journal

TreeAI D2 Agent E 交付：TreeAIEvent 的追加式 journal、RunState 投影、统一脱敏（d2-v1）、宿主退出恢复收敛与可观测性审计记录。

- 依赖：仅 `@treeai/contracts`（类型）与 Node 内置模块；不引入 Pi 类型。
- 契约依据：`packages/contracts/src`（CONTRACT-FREEZE-1 冻结面）、ADR-001 §4 数据边界。

## 1. 快速上手

```ts
import {
  EventRecorder, JsonlEventJournal, MemoryEventJournal, buildRunAudit,
} from "@treeai/event-journal";

const journal = await JsonlEventJournal.open("/var/lib/treeai/journal.jsonl");
const recorder = new EventRecorder(journal);

// 类型化写入：seq/eventId/occurredAt 在串行临界区内自动分配。
await recorder.recordAgentStarted(runId);
await recorder.recordPiRuntimeEvent(runId, piRuntimeEvent); // 归一化运行时事件
await recorder.recordAgentSettled(runId, { status: "succeeded" });
await journal.close();

// 重放 / 投影 / 审计（close 后查询仍可用）。
const events = journal.getRunEvents(runId);
const state = journal.projectRunState(runId);
const audit = buildRunAudit(runId, events);
```

核心 API 面（`src/index.ts`）：

| 导出 | 用途 |
| --- | --- |
| `MemoryEventJournal` / `JsonlEventJournal` | 内存 / JSONL 文件两种存储（共享校验、脱敏、投影逻辑） |
| `EventJournal.append / appendNext` | 完整事件写入（调用方给 seq）/ 草稿写入（journal 自动分配 seq） |
| `getRunEvents / listEvents / getRunIds` | 回放与查询（runId / type / types / afterSeq / limit 过滤） |
| `projectRunState / projectRunEvents` | RunState 投影（含迁移历史与异常记录） |
| `recoverInterruptedRuns` | 宿主退出后非终态 run 的收敛（host-crash / host-dispose） |
| `EventRecorder` | 类型化写入（错误 / 耗时 / session 变化 / 树导航 / Pi 事件转换） |
| `buildRunAudit` | 可观测性读模型（四类审计记录汇总） |
| `deepRedact / redactString / findRemainingSecrets` | d2-v1 脱敏与自检工具（供 Agent F 验收器复用） |

## 2. 事件兼容（前向兼容）

- `TreeAIEventType` 是开放联合。未知 Pi 版本引入的新事件经 `recordPiRuntimeEvent`
  记录为类型 `pi.unknown`，payload 保留 `rawKind`（原始 kind 字符串）与原 payload
  （经兜底脱敏）；查询、回放、投影均不因未知类型崩溃或丢弃事件。
- 模块自有事件类型（开放联合内、未进入 contracts 冻结面）：
  - `duration.recorded`：`{ phase, timing: { startedAt, endedAt, durationMs? }, attributes? }`
    ——独立耗时记录；
  - `run.episode-linked`：`{ episodeId }` ——run 与 episode 的归属辅助记录。
- payload 约定（`EventRecorder` 遵循；直接使用 `append` 的调用方也应遵循）：

  | 事件 | payload 约定 |
  | --- | --- |
  | `run.state-changed` | `{ from, to, reason?, failure?, timing? }`（from/to 为 RunState） |
  | `agent.settled` | `{ status: succeeded\|failed\|aborted, error?, timing? }` |
  | `runtime.error` / `runtime.recovered` | `{ error: { code, message, details? } }` |
  | `session.created/restored/replaced` | `{ reference, previous? }`（SessionReference 序列化） |
  | `tree.navigated` | `{ fromEntryId, toEntryId, sessionId, context? }` |
  | 任意事件 | 可选 `timing: { startedAt, endedAt, durationMs? }`（audit 据此提取耗时） |
- `TreeAIError` 的 `cause` **永不入库**：`EventRecorder.recordError` /
  `recordStateChange` / `recordAgentSettled` 只持久化 `code/message/details`
  （contracts errors.ts 义务）。诊断信息需要保留时应先脱敏再放入 message/details。
- Pi 原始证据以 `EvidenceReference { source: "pi-runtime", refId }` 引用，
  **不复制 Pi 原始敏感内容**（ADR-001 §4：引用而非内嵌）。

## 3. 脱敏边界（REDACTION_VERSION = "d2-v1"）

**调用方先脱敏，模块兜底。** 进入 payload / `evidence.locator` 的值按契约必须已由
生产者（runtime-pi 等）脱敏；journal 在持久化临界区内再做一次深度脱敏作为纵深防御，
并在 `AppendSuccess.redactionApplied` 报告命中的规则类别（非空即说明调用方义务未尽）。

覆盖面（详见 `src/redact.ts` 头注释）：

- token 形态：`sk-ant-` / `sk-proj-` / `sk-` / `gh[pousr]_` / `AIza` / `xai-`；
- 认证头：`Bearer`、`Authorization:`、`x-api-key:`（保留头名前缀）；
- cookie：`Cookie:` / `Set-Cookie:` 中的 cookie 值一律视为凭据；Set-Cookie 保留
  Path/Domain/Expires/Max-Age/SameSite/Secure/HttpOnly 等非凭据属性；
- provider URL：脱敏其中嵌入的凭据——userinfo（`https://user:pass@host`）与名称敏感
  的 query 参数（`?key=`、`&token=` 等）。**URL 的 host/path 不是秘密**，保留供审计
  （"provider URL 脱敏"的实现边界 = 只脱敏嵌入凭据，不整体抹除）；
- 环境变量式赋值：`<...>_API_KEY=` / `_TOKEN=` / `_SECRET=` / `_PASSWORD=` /
  `_PASSPHRASE=`（值 ≥ 8）；
- 敏感 JSON 键（规范化匹配 token/authorization/cookie/password/secret/...）：值整体替换；
- 敏感路径：家目录绝对路径（`/Users/<n>`、`/home/<n>`、`C:\Users\<n>`）规约为 `~/`；
- 结构防御：嵌套深度 > 32、循环引用、不可序列化值分别以标记替换，不抛错。

不在脱敏范围内（受控领域标识，非秘密）：`eventId` / `runId` / `type` / `occurredAt`，
以及 `SessionReference` 的 `sessionId` / `entryId`（Pi 稳定暴露的标识，ADR-001 §4）。

**权衡**：规则是启发式的、宁可过脱敏——部分无害内容也会被替换（如以敏感名命名的
query 参数）。`findRemainingSecrets` 提供残留自检（对标记不误报）供测试与 Agent F
验收器复用；它不构成完整安全扫描。

## 4. RunState 投影与恢复语义

### 4.1 投影（`projector.ts`）

- journal 与投影分离：journal 追加式保留一切事件（含非法迁移尝试）；投影器决定
  "是否应用到状态"。非法迁移**不改状态**，但以 `ProjectionAnomaly` 留下可审计记录。
- 显式迁移 `run.state-changed{from,to}`：from 与投影当前状态对账（不符 →
  `out-of-sync`），from→to 必须在冻结迁移表内（表外 → `illegal-transition` /
  离开终态 → `double-terminal`）。
- 派生迁移：`agent.started`→running；`run.abort-requested`→aborting；
  `runtime.error`（code=user-abort→aborted，否则→failed 并记录 failure）；
  `agent.settled{status}`（缺省按当前状态推导）；`runtime.recovered`→resolvedTo。
  从 running 直接收敛为 aborted 时按 I4 经 aborting 两步。
- 异常种类：`illegal-transition` / `double-terminal` / `out-of-sync` /
  `illegal-convergence` / `invalid-payload`。
- 迁移表以契约类型 `RunStateTransitions` 直接注解（编译期互检，零运行时依赖）。

### 4.2 恢复（`recovery.ts`，run-state.ts I6）

| 场景 | run 处于 | 收敛结果 |
| --- | --- | --- |
| host-crash（崩溃，未 dispose） | queued / running / aborting | `failed`，code `unknown`，`{hostInterrupted: true}` |
| host-dispose（主动退出） | running / aborting | `aborted`，code `user-abort` |
| host-dispose | queued（从未在途） | `failed`，code `unknown`，`{hostInterrupted: true, neverStarted: true}` |

- 实现方式：对每个非终态 run **追加** `runtime.recovered` 事件（evidence
  `treeai-journal`），由投影收敛——不改写、不删除既有事件。
- 幂等：已终态的 run 不再处理；`RecoveryReport` 区分 `recovered` /
  `alreadyTerminal` / `unknownRuns`。

**解释记录（可能需要 CONTRACT-CHANGE）**：I6 的 dispose 分支限定"在途的 Run"，而
冻结迁移表不允许 queued→aborted（I7 表外非法），故 queued-at-dispose 收敛为
`failed{hostInterrupted, neverStarted}`。若负责人希望该场景也产出 `aborted`，
需修改迁移表——已在 handoff 登记。

### 4.3 JSONL 文件打开语义（`JsonlEventJournal.open`）

- 文件不存在则创建；存在则整文件读入重建索引（重复 eventId / seq 非递增按
  `corrupt` 错误显式抛出，含行号，不静默跳过）。
- **torn-tail 修复**：崩溃留下的尾部不完整行（无换行结尾）视为未提交完成的写，
  截断至最后一个完整行并在 `openReport` 披露（`tornTailRepaired` /
  `tornTailBytes`）。这是 WAL 标准恢复做法，不触碰任何完整事件行。

## 5. 可观测性（`audit.ts` + `recorder.ts`）

`buildRunAudit(runId, events)` 从事件流提取四类审计记录（不额外存储状态、不回查
Pi、不读文件系统）：

1. **错误**：`runtime.error`、`agent.settled(failed)`、`runtime.recovered` 的
   error payload；
2. **耗时**：`duration.recorded` 事件与任意事件的 `payload.timing` 约定字段
   （durationMs 缺失时由时间戳推导）；
3. **session reference 变化**：`session.created/restored/replaced`（含 previous 快照）；
4. **tree navigation**：`tree.navigated` 的 entry 指针移动。

报告同时内嵌 `projectRunEvents` 的投影（状态、迁移历史、异常）。

## 6. 限制

- **单写者**：D2 的 journal 假定单一宿主进程串行写入（append 经内部 promise 队列
  串行化）；无文件锁，不支持多进程并发写同一文件。
- **无 fsync**：每次 append 只保证写入 OS（`FileHandle.write`），不逐事件 fsync；
  极端掉电可能丢失尾部若干事件或留下 torn tail（后者由 open 修复）。
- **全内存索引**：打开时整文件读入；适合 D2 规模（单宿主、可审计生命周期日志），
  不是长期高吞吐存储。产品事实源是 persistence（Agent C），本模块是审计日志。
- **查询非快照**：查询方法读取当前内存索引，不提供事务隔离。
- **脱敏是启发式兜底**：best-effort 规则 + 深度遍历；不做加密，不替代调用方的
  先行脱敏义务与 Agent F 的正式 secret scan 门禁。
- **错误分类边界**：模块基础设施错误用 `EventJournalError`（corrupt/io/closed），
  不是 TreeAIError——8 类错误码表达"运行期失败"，属于事件 payload 中的领域数据。
- `duration.recorded` / `run.episode-linked` 是本模块定义的事件类型（开放联合内），
  未进入 contracts 冻结面；上游如需纳入请走 CONTRACT-CHANGE。

## 7. 验证

```bash
cd packages/event-journal
npm test          # typecheck + build + node --test（当前 73 项全过）
```

测试覆盖：seq 单调/重复/below-max/跨 run、重复 event（含跨重开）、结构校验全
reason、并发 append 串行化、全部合法迁移边、全部非法边（36 对状态空间穷举）、
双终态/失步/畸形 payload、恢复决策表与文件持久化幂等、secret corpus 全脱敏 +
clean corpus 不破坏 + 残留自检、未知事件记录/回放。

测试纪律：合成秘密在运行时拼接（源码无完整秘密字面量），家目录用虚构用户名，
断言消息不内插秘密值。
