# Agent E Handoff

## 状态

PASS

## 完成内容

任务书 §5 Agent E 全部 8 项必须完成项：

1. **追加式 journal API**（`src/journal.ts`）：`EventJournal` 接口 + `MemoryEventJournal` / `JsonlEventJournal` 两实现。`append`（调用方给 seq）检测并拒绝重复 eventId（`duplicate-event-id`）、重复 seq（`duplicate-seq`）、低于当前最大值的新 seq（`seq-below-max`）与全部结构违规；`appendNext` 在 promise 队列串行化的临界区内自动分配 seq/eventId/occurredAt。查询/回放 API：`getRunEvents`（seq 升序）/ `listEvents`（runId/type/types/afterSeq/limit）/ `getRunIds`。不复制 Pi 原始敏感内容：Pi 证据只以 `EvidenceReference{source:"pi-runtime", refId}` 引用（ADR-001 §4）。
2. **RunState 投影**（`src/projector.ts`）：迁移表以契约类型 `RunStateTransitions` 直接注解（编译期互检）；显式迁移 `run.state-changed{from,to}` 校验 from 对账（`out-of-sync`）与表内合法性（`illegal-transition`）；双终态/离开终态（`double-terminal`）；派生收敛（`agent.started`/`run.abort-requested`/`runtime.error`/`agent.settled`/`runtime.recovered`），running→aborted 的 user-abort 收敛按 I4 经 aborting 两步；非法迁移不改状态但以 `ProjectionAnomaly` 留下可审计记录。只使用冻结六态与 TreeAIError 8 类。
3. **宿主退出恢复**（`src/recovery.ts` + journal.recoverInterruptedRuns）：host-crash → `failed(unknown, {hostInterrupted:true})`；host-dispose 在途 → `aborted(user-abort)`；实现方式为追加 `runtime.recovered` 事件（幂等，不改写既有事件）。
4. **脱敏与证据边界**（`src/redact.ts`）：d2-v1 深度脱敏兜底（token 形态、Bearer/Authorization/x-api-key、Cookie/Set-Cookie 值 + 属性保留、provider URL 内嵌凭据、env 式赋值、敏感 JSON 键、家目录路径、深度/循环/不可序列化防御）；未知 Pi 事件以 `pi.unknown` + `payload.rawKind` 保留（前向兼容不崩溃）。README 说明"调用方必须先脱敏 + 模块兜底"的双层义务。
5. **可观测性**（`src/recorder.ts` + `src/audit.ts`）：EventRecorder 类型化写入（错误/耗时/abort/steer/session 变化/tree navigation/Pi 事件转换）；`buildRunAudit` 从事件流提取错误、耗时、session reference 变化、tree navigation 四类审计记录 + 内嵌投影。
6. **测试**（tests/ 6 文件，73 项全过）：seq 单调/重复/below-max、36 对状态空间穷举（全部合法边 + 全部非法边含异常种类）、双终态/失步/畸形 payload、恢复决策表 + 文件持久化幂等、secret corpus 全脱敏 + clean corpus 不破坏 + `findRemainingSecrets` 残留自检 + 负对照、未知事件记录/回放。测试秘密全部运行时拼接合成（DELIVERY-005），输出日志经 grep 验证无秘密模式。
7. **依赖纪律**：只用 `@treeai/contracts`（纯类型）与 Node 内置模块（crypto/fs/promises/test/os/path）；无新增依赖、无 dependency request。
8. **文档**：README（事件兼容、脱敏边界、恢复语义、限制）+ 本 handoff。

实现过程中发现并修复一个真实缺陷：`COOKIE_HEADER_RE` 会命中 "Set-Cookie:" 内的 "Cookie:" 子串从而破坏 Set-Cookie 属性保留；已加 `(?<!Set-)` 修复。

## 修改文件

全部在本 Agent 独占写入范围内（`packages/event-journal/**`、`coordination/d2/agent-e-*.md`）：

- `packages/event-journal/package.json`（scripts：typecheck/build:test/test；description 更新；main/types；依赖与版本 0.0.0 不变）
- `packages/event-journal/tsconfig.json`（include src+tests）
- `packages/event-journal/tsconfig.build.json`（新增；emit 到 dist/ 供 node --test）
- `packages/event-journal/README.md`（新增）
- `packages/event-journal/src/index.ts`、`errors.ts`、`redact.ts`、`journal.ts`、`projector.ts`、`recovery.ts`、`recorder.ts`、`audit.ts`、`util.ts`（全部新增）
- `packages/event-journal/tests/helpers.ts`、`redact.test.ts`、`journal.test.ts`、`projector.test.ts`、`recovery.test.ts`、`recorder.test.ts`（全部新增）
- `coordination/d2/agent-e-status.md`（启动记录 + 实测结果回填）

## 验证命令与退出码

- command: `cd packages/event-journal && npm test`
  exit: **0**（typecheck 0 + tsc 构建 0 + node --test 73/73 pass；输出经 grep 验证无秘密模式泄漏）
- command: `npm run typecheck`（仓库根）
  exit: **0**（@treeai/event-journal 计入 checked；期间观察到 runtime-pi 一次瞬时编译错误，系 Agent B 并行写入中间态，复跑消失，最终全绿）
- command: `bash packages/contracts/scripts/check-no-pi-imports.sh`
  exit: **0**
- command: `npm test`（仓库根）
  exit: 3（Gate 0 占位 NOT_IMPLEMENTED，非本模块失败）

## 证据

- 73 项单测全过（`cd packages/event-journal && npm test` 的 node --test 汇总：tests 73 / pass 73 / fail 0）。
- 测试输出日志（`/tmp/event-journal-test-output.log`）grep `sk-ant|ghp_|AIza|xai-|sk-proj` 命中 0——真实/合成秘密未进入日志。
- 状态空间穷举：36 对 (from,to) 中 7 条合法边全部生效、3 条终态自确认为幂等容忍、其余 26 对全部按预期拒绝并产出正确异常种类。
- 文件 journal 生命周期证据：重开重载（eventsLoaded=2）→ 恢复收敛 → 重开（eventsLoaded=3、状态 failed、terminalAt 精确）→ 二次恢复 no-op。
- torn-tail：追加无换行的半行 JSON 后重开，`tornTailRepaired=true`、`tornTailBytes` 精确、完整事件未受影响。

## 已知限制

（详见 README §6）单写者假设（无跨进程文件锁）；无逐事件 fsync（掉电可能丢尾部事件或留 torn tail，后者由 open 修复）；打开时整文件读入内存（D2 规模审计日志定位，非长期高吞吐存储；产品事实源是 persistence/Agent C）；脱敏是启发式兜底、宁可过脱敏，不替代调用方先行脱敏义务与 Agent F 正式 secret scan；`findRemainingSecrets` 为 best-effort 自检；查询非快照（无事务隔离）。

## 接口偏离

- 无 CONTRACT-CHANGE 请求。两处**解释性决定**已备案（不改契约文件）：
  1. **queued-at-dispose 收敛为 `failed`**（而非 `aborted`）：I6 dispose 分支限定"在途的 Run"，冻结迁移表不允许 queued→aborted（I7 表外非法），故实现为 `failed(unknown, {hostInterrupted:true, neverStarted:true})`。若负责人希望该场景产出 `aborted`，需 CONTRACT-CHANGE 修改迁移表。
  2. **模块自有事件类型 `duration.recorded`、`run.episode-linked`**：`TreeAIEventType` 开放联合内、未进 contracts 冻结面（README §2）。
- 模块基础设施错误使用 `EventJournalError`（corrupt/io/closed）而非 TreeAIError（8 类码是运行期失败的领域分类，只出现在事件 payload 中）。

## Pi 改造需求

- 无。Pi 类型零引入；Pi 原始事件只以契约类型 `PiRuntimeEvent`（归一化、已脱敏）作为输入。

## 需要 Integrator 处理

1. Wave 1 结束后把 `packages/event-journal` 的 `npm test` 接入根测试入口（根 `npm test` 现为 Gate 0 占位 exit 3；不属本 Agent 修改范围）。
2. 横向对齐（已在 agent-e-status.md §1.6 登记）：Agent B 的归一化事件 payload 约定（`agent.settled` 建议带 `status`；投影器对未知 payload 形态记录异常不改状态、不崩溃）；Agent F 可复用 `findRemainingSecrets` / `REDACTION_VERSION`；Agent A 登记 `duration.recorded` 等模块自有类型。
3. 上述"queued-at-dispose"解释如需变更，走 CONTRACT-CHANGE 流程定夺。
