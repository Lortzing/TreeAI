# Agent F 状态文件（agent-f-status.md）

- 维护者：Agent F（本文件唯一写入者）
- 创建：2026-09-21
- 阶段：Wave 1（Gate 0 已通过、contracts 已冻结，按任务书 §5 进入并行实现）
- 角色职责：验收器、端到端测试、CI、证据 Schema 与回归门禁（任务书 §5 Agent F）

## 1. 已读材料（任务书 §12 启动记录要求）

| # | 材料 | 摘取的关键事实 |
|---|---|---|
| 1 | `TreeAI_D2_Agent执行任务书.md` v1.0 | 六 Agent + Integrator；Agent F 独占 `tests/**`、`schemas/d2/**`、`scripts/verify-d2*`、`.github/workflows/**`、`coordination/d2/agent-f-*`；退出码 0/1/2/3 语义；证据布局 `evidence/d2/runs/<UTC-run-id>/{environment.json,result.json,events.jsonl,checks.json,logs/}`；只追加不覆盖；写盘前后秘密扫描；D1 `verify-d1 --repro` 为版本升级回归入口；失败路径自测必须证明注入缺陷时门禁失败。 |
| 2 | `d1-spikes/research/adr-001-draft.md` 顶部批准记录 + §4 | ADR-001 Accepted（2026-09-20）：候选 1 TS/Node + Pi SDK 进嵌；Pi 0.85.1；同进程非沙箱；Pi session 只存引用三元组；凭据不复制不代理。 |
| 3 | `d1-spikes/reports/blockers.md` | DECISION-001~009 全部关闭；D1 Go；D2 授权记录在案；tree-navigation 为正式回归能力（规范名 `tree-navigation`）；Node v24.21.0/npm 11.19.0 为复现基线。 |
| 4 | `d1-spikes/reports/d1-verification.md` | D1 最终 30/30 PASS、exit 0（verify-20260920T124525829Z.json）；D1 验收器修过的两类缺口（BLOCKED/NOT_RUN 非零退出码保留、post-write 改判同步 summary）——D2 验收器必须从第一天就具备；秘密扫描盲区（目录名、模式匹配边界）的先例。 |
| 5 | `packages/contracts/src/**`（全部 10 个源文件） | 冻结契约：`TreeAIEvent`（eventId/runId/seq 严格递增/occurredAt/payload/evidence）、`PiRuntimeEvent`、`TreeAIError` 8 类、`RunState` 六态 + I1–I7、`SessionReference` + `PinnedPiVersion="0.85.1"`、`ToolDecision`、`PiRuntime` 接口（单活跃会话、steer 同 run 新 turn、navigateTree 同 session 叶指针、dispose 幂等）。纯类型包（`import type` 消费，无运行时导出）。 |
| 6 | `docs/d2/contracts-README.md` | 消费方式 `import type`；seq 两层语义（TreeAIEvent 按 runId、PiRuntimeEvent 按 runtime 实例生命周期）；破坏性变更走 CONTRACT-CHANGE。 |
| 7 | `coordination/d2/CONTRACT-FREEZE-1.md` | Gate 0 PASS（Integrator 已签署）；各模块包（runtime-pi/persistence/tool-policy/event-journal）Gate 0 时仅占位无源码——Agent F 的验收器必须把"模块未交付"如实记为 NOT_RUN（exit 3），不得误报 PASS 也不得误报 FAIL。 |
| 8 | `coordination/d2/integrator-status.md`、`coordination/d2/README.md`、`evidence/d2/README.md` | 根命令占位（gate0-status.js，exit 3）由 Integrator 在 Agent F 交付后接线；`evidence/d2/runs/**` 明确由 Agent F 的 verify-d2 写入（追加式）；依赖锁定基线与申请流程。 |
| 9 | 参考：`d1-spikes/scripts/{verify-d1,check-secrets,schema-check,selftest-infra}`、`d1-spikes/schemas/*.json` | 只读学习其验收器结构、秘密扫描规则集（15 条内容规则 + 8 条文件名规则）、schema 自检探针模式、失败路径注入自测模式——测试思想复用，代码不复制（D2 全部重写为 Node/TS）。 |
| 10 | 环境 | Node v24.21.0 / npm 11.19.0（与 DECISION-003 基线一致）；本机实验确认：`.ts` 直接执行（type stripping）与 `import type` 消除均可用、`node --test` 接受 glob 模式——零新依赖的 TS 测试可行。 |

## 2. 理解并承诺的边界

独占写入（本次全部交付物所在）：

- `tests/**`（unit / integration / live 框架 / fixtures / support / tsconfig）
- `schemas/d2/**`（event / result / environment JSON Schema + README）
- `scripts/verify-d2.js`、`scripts/verify-d2-live.js`、`scripts/verify-d2-selftest.js`（`scripts/verify-d2*` 前缀内；不改根 scripts 声明）
- `.github/workflows/**`（离线默认门禁 + live 受控触发）
- `coordination/d2/agent-f-status.md`、`coordination/d2/agent-f-handoff.md`
- `evidence/d2/runs/**`（按 `evidence/d2/README.md` 第 2 条，验收运行产物由 verify-d2 写入；只追加）

不写 / 不做：

- 不修改任何生产 package（contracts/runtime-pi/persistence/tool-policy/event-journal 的 src 与配置）、根 `package.json`/`package-lock.json`/`tsconfig.base.json`；
- 不改其他 Agent 状态文件、不改 `d1-spikes/**`（含不执行会向 d1-spikes/evidence 追加写盘的 `verify-d1 --repro`——该命令作为 `--d1-repro` 入口实现并留给 Integrator/Gate 2 在授权环境执行，见 §5 阻塞）；
- 不在 fixture/schema/log 写任何秘密；不读取用户真实 Pi 配置（`~/.pi/`）作为测试捷径；live 凭据只经环境变量注入、不落盘；
- 不引入新依赖（零 dependency request：验收器、scanner、schema 校验器、测试全部用 Node 内置 `node:test`/`node:assert`/标准库实现）；
- 不 git commit / push。

## 3. 计划

1. `schemas/d2/`：`event.schema.json`（TreeAIEvent 形状：eventId/runId/seq≥1/UTC occurredAt/点分 type/payload/evidence 引用）、`result.schema.json`（status/exitCode 一致性：PASS→0、FAIL/BLOCKED→非零、NOT_RUN→null 或非零；evidenceFiles；FAIL/BLOCKED 必带 error；NOT_RUN 必带 reason）、`environment.schema.json`（`pinnedVersion` const "0.85.1"、runtime、credentialPolicy 枚举 offline/controlled-env-injection/none）+ README（修订规则）。
2. `tests/support/verifier/`（TS，零依赖）：JSON Schema 子集校验器（含 if 语义以 anyOf 分支表达）、秘密扫描器（内容规则 + 文件名规则 + 自检语料运行时生成）、verdict 计算、evidence run-dir 管理（UTC run-id、只追加、写盘前脱敏+扫描、写盘后复扫）。
3. `tests/support/`：`FakePiRuntime`（忠实实现 contracts PiRuntime 语义：同 session navigateTree、steer 同 run 新 turn、abort→user-abort、会话替换自动重订阅、dispose 幂等、seq 跨替换连续）+ e2e harness（journal 严格 seq/重复检测、RunState 投影与非法迁移拒绝、I6 重启收敛、SessionReference 可用性降级）——全部标注为测试基础设施，非生产代码。
4. `tests/unit/`：validator 关键字正反例、scanner 规则集、fixtures 完整性（MANIFEST.sha256）、fake runtime 行为、harness journal 语义。
5. `tests/integration/`：六类 e2e fixture 场景（双分支、回切、重启恢复、session 缺失降级、权限越界默认拒绝、错误收敛不遗留 running）——全部离线、不依赖真实模型/用户 home/凭据。
6. `scripts/verify-d2.js`：离线验收器（typecheck、五模块单测、集成测试、schema 校验、秘密扫描、退出码、残留资源、Pi 版本钉死检查、fixtures 完整性；`--d1-repro` 显式入口；exit 0/1/2/3 严格语义；未接线/未交付一律 NOT_RUN 不误报）。
7. `scripts/verify-d2-live.js`：六场景（basic/tool-policy/steer/abort/resume/tree-navigation）可执行框架；凭据仅经 `TREEAI_LIVE_*` 环境变量；缺失→BLOCKED exit 3 安全跳过；runtime-pi 未交付→NOT_RUN；`--driver=fake` 供离线框架自证。
8. `scripts/verify-d2-selftest.js`：失败路径自测（临时副本注入坏 schema/秘密/非法退出码/坏测试，断言门禁 exit 2；干净副本断言 exit 3 NOT_RUN 语义）。
9. `.github/workflows/`：`d2-offline.yml`（默认 PR/push 门禁，无 secrets）、`d2-live.yml`（仅 workflow_dispatch + 受保护 environment，secrets 只进 verify 步骤 env、不回显）。
10. `tests/README.md`（verifier/测试架构与用法说明）+ 实际执行全部入口并记录真实退出码 + `agent-f-handoff.md`。

## 4. 预计验证命令（真实结果在 handoff 回填）

```bash
node scripts/verify-d2.js                 # 离线验收（预期当前 Wave 1 状态 exit 3：四模块 NOT_RUN）
node scripts/verify-d2.js --d1-repro      # 版本回归显式入口（本次不执行，见阻塞）
node scripts/verify-d2-live.js            # 无凭据（预期 BLOCKED exit 3）
node scripts/verify-d2-live.js --driver=fake   # 框架离线自证
node scripts/verify-d2-selftest.js        # 失败路径自测（预期全过）
node --test 'tests/unit/**/*.test.js' 'tests/unit/**/*.test.ts'   # 直接单测入口
node --test 'tests/integration/**/*.test.ts'                      # 集成入口
node_modules/.bin/tsc --noEmit -p tests/tsconfig.json             # tests 自身类型检查
```

## 5. 阻塞

- **`verify-d1 --repro` 执行权**：该命令按 D1 设计会向 `d1-spikes/evidence/verification/` 追加写盘，而本 Agent 的写入边界明确禁止修改 d1-spikes。已实现 `--d1-repro` 显式入口并写入 CI live 工作流；实际执行留给 Integrator/Gate 2（需网络 + 写 d1-spikes 授权）。本次验收中该检查不出现在默认离线运行（模式语义与 D1 一致：默认模式不含 --repro 行）。
- **runtime-pi 真实驱动**：Agent B 尚未交付 `packages/runtime-pi` 源码，live 六场景的真实驱动不可用。live 框架按契约接口实现并以 `--driver=fake` 离线自证；真实驱动接入点（`@treeai/runtime-pi` 工厂函数命名）已在 handoff 列为 Integrator/Agent B 待办。
- 其余无阻塞。新依赖：无（零申请）。

## 6. 进行中状态

- [x] 启动记录（本文件）
- [x] schemas/d2 三 schema + README
- [x] tests/support（verifier 库、FakePiRuntime、harness）
- [x] tests/unit、tests/integration、tests/fixtures（含 MANIFEST.sha256 与 schema-probe 语料）
- [x] scripts/verify-d2{,-live,-selftest}.js（全部可执行，退出码实测见 handoff）
- [x] .github/workflows（d2-offline.yml 默认门禁 + d2-live.yml 受控触发）
- [x] tests/README.md（verifier 用法与架构说明）
- [x] 真实执行与证据落盘（终态：离线门禁 19 PASS / 0 FAIL / 2 NOT_RUN → exit 3——两个 NOT_RUN 均为设计内未接线项；live fake exit 0；live 缺凭据 exit 3；selftest exit 0；75+8+3 测试全绿且稳定性复验）
- [x] agent-f-handoff.md（已按 §9 交付）

### 2026-09-21 实现期补记

- secret-scanner 的 `credentials-json-file` 文件名规则改为**精确词干匹配**（`credentials.json`/`creds.json`/`secrets.prod.json` 触发；`missing-credential-policy.json`、`live-fake-no-creds.json` 等描述性探针名不触发——本项目 fixture 合法测试 credentialPolicy，子串匹配会产生持续误报）。规则收紧有单测回归保护；scanner 版本升至 `d2-v1.1`。
- 发现并修复 `tests/unit/fake-runtime.test.ts` 的真实资源泄漏：missing-file 用例为构造不存在的路径而 `mkdtempSync` 却从不清理（每次套件运行泄漏一个空 temp 目录，被 residual-resources 检查当场抓获）。
- live tool-policy 场景的提示词原样嵌入了 fixture 绝对路径，会被运行时写进 session 转录并触发 post-write home-path 扫描（该纪律按设计工作：改判 HAS_FAIL/exit 2）。已改为仓库相对路径；该次开发期运行整体移入 `evidence/d2-quarantine/`（扫描根之外，附 README 说明，未删改任何字节）。
