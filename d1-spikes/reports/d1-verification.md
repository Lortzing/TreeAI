# TreeAI D1 验收汇总（d1-verification）

- 报告产出：Agent D（独占范围：d1-spikes/fixtures/、d1-spikes/schemas/、d1-spikes/scripts/、d1-spikes/evidence/verification/、d1-spikes/reports/）
- 生成时间（UTC）：2026-09-20T04:10Z 最终收口定稿（发布时点扫描 04:06:33Z 之后，依据下列证据文件中的时间戳）
- 统一验收入口：`d1-spikes/scripts/verify-d1`（干净复现模式：`--repro`）
- 本次引用的详细运行（最终验收）：`evidence/verification/verify-20260920T034514083Z.json`（及同名 .log；**exit 0，verdict ALL_PASS，28/28 检查全 PASS**；03:45:14Z 于主工作区执行，mode=repro，durationMs 69819——验收运行史 16 条中首个 exit 0）
- 运行历史（追加式，未删除/改写任何旧记录）：`evidence/verification/verify-history.jsonl`（当前 16 条，最早 2026-09-18T10:48:57Z，最新 2026-09-20T03:45:14Z）
- 本报告只汇总可验证事实与判定，不替负责人做最终选型，不给出 Go/Conditional Go/No-Go 签字（见 `reports/blockers.md` DECISION-007）。

## 版本沿革

1. **2026-09-18 版**（历史保留）：依据 verify-20260918T123312170Z，彼时 B 五场景
   BLOCKED_CREDENTIALS（403）、comparison-parity BLOCKED（provider/model 不一致），
   counts 为 PASS=19、FAIL=0、BLOCKED=6、NOT_RUN=3，exit 3。
2. **2026-09-20 上午版**（历史保留）：Agent B 以统一基线
   （provider=tal-token-plan-06c64a09、model=deepseek-v4.1-flash、thinking=off）
   完成真实 SDK 重跑，五场景全部 PASS；counts 为 PASS=25、FAIL=0、BLOCKED=0、
   NOT_RUN=3，exit 3（依据 verify-20260920T021547888Z.json）。彼时 --repro 尚未执行。
3. **2026-09-20 收口跟进版**（历史保留）：负责人收口方案下 Agent D 完成三项工作——
   (a) 修复验收器两个缺口（BLOCKED/NOT_RUN 退出码保留、post-write 扫描改判时
   summary 同步，见第 0 节 4/5 项与 selftest T6/T7）；(b) **--repro 干净复现首次
   实际执行**，双侧 PASS（干净临时目录重装依赖 + 重跑单测，见第 2/3 节与
   repro-20260920T032122324Z-*.log）；(c) tree-navigation（第六场景）在收口窗口内
   由 B/C 先后交付实测证据（B PASS run 02:59Z、C 补充探针 03:21Z），但两者均在
   共享契约的 scenario 枚举之外、未经 verify-d1 验收（见第 4b 节与第 8 节）。
   counts 更新为
   **PASS=27、FAIL=0、BLOCKED=0、NOT_RUN=1，exit 3**（唯一 NOT_RUN 为共享
   evidence/environment.json 缺失，属集成人补齐项，见第 8a 节）。
   收口期间的中间状态（C 的 tree-nav 进行中代码曾致 03:12Z 运行 rpc 侧两项
   FAIL，verify-20260920T031204255Z.json 历史保留；C 修复后 03:21Z 复跑全 PASS）
   一并按追加原则保留。
4. **2026-09-20 最终收口版（本版）**：集成人补齐 `d1-spikes/README.md` 与
   `evidence/environment.json`（03:43:15Z / 03:43:25Z 落盘）；03:43:34Z 默认模式
   验收轮（verify-20260920T034334578Z.json）记录 evidence-environment 检查转
   PASS（exit 3，PASS=26/NOT_RUN=2——两条 NOT_RUN 为 --repro 项，默认模式不执行
   它们，属模式语义非遗留缺陷）。随后 Agent D 执行最终
   `verify-d1 --repro`（03:45:14Z）：**28/28 检查全 PASS，counts
   PASS=28、FAIL=0、BLOCKED=0、NOT_RUN=0，exit 0（ALL_PASS）**——验收史 16 条中
   首个 exit 0；五场景双侧 PASS、comparison-parity PASS、evidence-environment
   PASS、--repro 双侧 PASS 在同一轮同时达成。同期配套：check-secrets 全工作区
   零发现（03:47Z 独立复扫 279 文件；发布时点 04:06:33Z 复扫 280 文件）、
   selftest-infra 20/20（03:49Z）、schema-check --selftest 33 例通过。
   tree-navigation 维持第 4b 节定位（两侧真实证据、共享契约外、
   DECISION-009 PENDING_OWNER）；ADR/路线/Go-No-Go 维持 PENDING_OWNER（第 9 节）。

## 0. 验收器修正记录（Agent D，scripts/ 与 schemas/ 内）

1. **支持并严格校验 sdk-node 的追加式 runs 证据布局**（2026-09-18）。Agent B 的证据实际位于
   `evidence/sdk/runs/<run-id>/<scenario>/{result.json,events.jsonl}`，而旧验收器只查扁平
   `evidence/sdk/<scenario>.result.json`，导致 11:59Z 的运行把 5 个 SDK 场景误判为 FAIL
   （verify-20260918T115924248Z.json，历史保留）。新规则（schemas/README.md 第二节）：
   某场景若存在扁平文件则以扁平为准；否则选用 runs/ 下**最新的完整 run**（五场景
   result.json 齐备）；run 内结果引用的 evidenceFiles 必须仍位于同一 run 目录，
   **跨 run 引用判 FAIL**；runs/ 存在但无完整 run 时按交付不完整判 FAIL。
   03:21Z 轮实际选定 run：`2026-09-20T02-12-05-667Z-6220`（6 个 run 中最新完整者；
   完整 run 共 5 个；不完整 1 个：2026-09-18T11-07-09-207Z-77525，缺 steer/abort/resume
   的 result.json，未使用、未混拼）。
2. **rpc-python 单元测试改为 pytest 优先、stdlib unittest 兜底**（2026-09-18）。Agent C 的测试使用标准库
   unittest；本机无 pytest 时旧验收器误记 BLOCKED。新逻辑：pytest 可导入则运行 pytest，
   否则运行 `PYTHONPATH=src python -m unittest discover -s tests`（与 rpc-python/
   requirements.txt 记载的命令一致）；两者均不可用才 BLOCKED；失败仍保持 FAIL/非零退出语义。
3. **新增 comparison-parity 检查**（2026-09-18）：两实现须满足任务书第 5 节"同一 Pi 版本、同一模型、
   同一 thinking"的公平对照前提，否则判 BLOCKED 并指向 PENDING_OWNER（DECISION-008）。
   09-20 起该检查 PASS。另：BLOCKED 场景结果现在也要求证据可追溯
   （任务书 §0.6、§14），schema 对 BLOCKED_CREDENTIALS 的两种编码做了公开修订（见第 3a 节）。
4. **check_exit_codes 显式要求 BLOCKED/NOT_RUN 非零退出码**（2026-09-20 收口缺口 1）。
   旧规则只检查"PASS 必须退出 0、FAIL 必须非零"，BLOCKED/NOT_RUN 结果若声称 exitCode=0
   不会被发现——而 exit 0 必须保留给 PASS，否则"可信退出码"不成立。新规则
   （scripts/verify-d1 check_exit_codes）：PASS 退出码必须为 0；FAIL 与 BLOCKED 必须为
   非零整数（BLOCKED 表示尝试已执行并被阻塞，进程已终止，退出码必须存在且非零）；
   NOT_RUN 不得声称 0（未执行任何命令时 null 可接受）。纵深防御：即使结果文件 schema
   校验失败（其 status/exitCode 摘要仍先进入退出码缓存），该组合仍被本检查覆盖。
   配套 schema 修订见第 3a 节；失败路径回归测试 T6 见第 5 节。
   全部历史 BLOCKED 证据（2026-09-18 与 2026-09-20 各 run，共 17 份 result.json）
   实际 exitCode 均为 2，收紧不使任何已交付证据失效（已逐份用 schema-check 复核 VALID）。
5. **post-write 秘密扫描改判时同步 summary JSON**（2026-09-20 收口缺口 2）。
   旧逻辑：写盘后对本运行自身产物（verify-*.json/.log）做泄露自扫，发现泄密时把进程
   退出码强改为 2，但**已写盘的 summary JSON 仍保留旧 verdict/exitCode/counts**，
   造成记录与真实退出码不一致。新逻辑：改判时同步重写 summary——overall.verdict
   改为 HAS_FAIL、overall.exitCode=2（附 overriddenBy 说明）、追加 post-write-selfscan
   FAIL 行、counts 重算、新增 postWriteScan 小节（脱敏后的发现清单）——并重写 .log
   使其包含 POST-WRITE LEAK DETECTED 通告；随后做一次有界重扫，验证同步改写本身
   未引入新泄露（原始泄露内容按"证据只追加"原则保留在记录中，重扫会再次命中它们，
   属预期；只断言新增发现数为 0）。失败路径回归测试 T7 见第 5 节。
   本次修复后，2026-09-20 各真实运行（03:12Z/03:21Z）的 post-write 自扫均无发现，
   未触发改判路径；改判路径由 T7 在临时副本中以注入泄露验证（8/8 断言通过）。

## 1. 总体状态

| 区域 | 状态 | 依据 |
|---|---|---|
| Agent D 静态基础设施（fixtures/schemas/scripts/扫描/验收门槛） | PASS | verify-20260920T034514083Z.json checks 1–5 |
| Agent D 收口缺口修复（exit-codes 保留 + post-write 同步） | 已修复并以 T6/T7 回归测试覆盖 | selftest-infra-20260920T034959Z.json（20/20）；第 0 节 4/5 项 |
| Agent A（research/：能力清单/矩阵/ADR 草案） | 已交付；ADR 状态 Proposed（未批准）；收口期 A 更新过矩阵/ADR（工作区未提交改动） | research/pi-capability-inventory.md、research/sdk-vs-rpc-matrix.md、research/adr-001-draft.md |
| Agent B（sdk-node/ + evidence/sdk/runs/） | 已交付；统一基线重跑后五场景 PASS（exitCode=0）；单测 80/80；--repro 干净复现 PASS | checks 6/8/10/12–16；repro-20260920T034514083Z-sdk-node.log |
| Agent C（rpc-python/ + evidence/rpc/） | 已交付；五场景 PASS；单测 65/65（收口期 tree-nav 进行中代码曾短暂失败，C 修复后复验 OK）；--repro 干净复现 PASS | checks 7/9/11/17–21；repro-20260920T034514083Z-rpc-python.log |
| SDK/RPC 对照公平性 | PASS（provider/model/thinking 一致） | check 22；DECISION-008 条件已满足 |
| 共享环境记录（evidence/environment.json） | **PASS**（集成人 2026-09-20 03:43:25Z 补齐；有效 JSON，键含 pi/comparisonBaseline/runtime/packageManagers/implementations/evidenceSources/credentialPolicy） | check 23；DELIVERY-004 关闭 |
| --repro 干净复现 | **已执行，双侧 PASS**（干净临时目录重装依赖并重跑单测） | checks 10/11；repro-20260920T034514083Z-{sdk-node,rpc-python}.log |
| tree-navigation（第六场景） | **B/C 已在收口窗口内交付证据（双侧 PASS），但均在共享契约 scenario 枚举之外、未经 verify-d1 验收**；不属于五场景验收范围，契约扩展与后续验收为待决项 | 第 4b 节；blockers.md DECISION-009 |
| 整体验收退出码 | **0 = ALL_PASS（28/28 检查全 PASS）** | verify-20260920T034514083Z.json overall；verify-history.jsonl 第 16 条 |

**counts：PASS=28、FAIL=0、BLOCKED=0、NOT_RUN=0，exit 0（ALL_PASS）。** 验收
运行史 16 条中首个 exit 0；五场景双侧 PASS、comparison-parity PASS、
evidence-environment PASS、--repro 双侧 PASS 于同一轮（03:45:14Z，mode=repro）
达成。验收层面的全部检查已无 FAIL/BLOCKED/NOT_RUN；负责人决策项（第 9 节）
不因此自动关闭。

## 2. 验收入口与退出码约定（不变）

命令：`d1-spikes/scripts/verify-d1`（干净复现模式：`--repro`）。

| 退出码 | 含义 |
|---|---|
| 0 | 全部检查 PASS |
| 2 | 至少一项 FAIL（缺文件/schema 违规/泄密/退出码不可信/残留进程等） |
| 3 | 无 FAIL 但存在 BLOCKED 或 NOT_RUN（交付不完整；默认模式恒含 --repro 两项 NOT_RUN，故 exit 0 仅可能在 --repro 模式达成——03:45:14Z 最终收口轮即为 --repro 模式 exit 0） |
| 1 | 验收工具自身错误 |

每次运行产出 `verify-<时间戳>.json`/`.log` 与两份 `secrets-scan-<时间戳>-{evidence,workspace}.json`，
并向 `verify-history.jsonl` 追加一行；证据只追加，不改写历史（当前共 16 条，最早
2026-09-18T10:48:57Z，最新 2026-09-20T03:45:14Z）。写盘后对本次产物做泄露自扫，
发现泄密强制改判 exit 2 并同步重写 summary（第 0 节第 5 项）。

**--repro 干净复现（2026-09-20 收口版首次实际执行）**：`d1-spikes/scripts/verify-d1 --repro`
把已交付的 sdk-node/ 与 rpc-python/ 分别复制到系统临时目录（排除 node_modules/venv/
__pycache__ 等派生产物），执行 `npm ci` + `npm test`（sdk-node）或
`pip install -r requirements.txt` + 单元测试（rpc-python；pytest 优先，缺失时
`PYTHONPATH=src python -m unittest discover -s tests`），日志写入
`evidence/verification/repro-<时间戳>-<实现>.log`。该模式需要网络（npm registry）。
**最终结果（03:45:14Z 最终收口轮）：双侧 PASS，且该轮 28/28 全 PASS
（exit 0，ALL_PASS）**——sdk-node 侧 npm ci 退出 0（真实重装，含依赖解析警告
原样留档）+ npm test 80/80 通过；rpc-python 侧 pip install 退出 0（零第三方依赖，
requirements.txt 即最强锁定）+ stdlib unittest 65/65 通过。
历史轮次（均按追加原则保留，未删改）：03:21:22Z 运行双侧 PASS（当时唯一 NOT_RUN
为共享 environment.json，exit 3）；03:12:04Z 收口期中间轮 rpc-python 侧曾 FAIL
（unit-tests-rpc-python 与 repro-rpc-python 两行，根因为 Agent C 进行中的
tree-nav 代码缺陷 `_append_file_atomically` FileNotFoundError，堆栈完整保留于
repro-20260920T031204255Z-rpc-python.log）；C 修复（src/pi_rpc_probe/tree_nav.py，
~03:18Z）后 03:21Z 复跑全 PASS。

## 3. 检查明细（28 项，与 verify-20260920T034514083Z.json 一一对应）

| # | 检查项 | 状态 | 说明/证据 |
|---|---|---|---|
| 1 | fixtures-integrity | PASS | 5 个 fixture 文件对 MANIFEST.sha256 校验通过；tool 场景聚合与 README.txt 一致 |
| 2 | schemas-valid | PASS | 两个 schema 可解析；19 个正/反例探针按预期接受/拒绝（含 BLOCKED_CREDENTIALS 两种编码、BLOCKED 非零退出码正反例、NOT_RUN 退出码边界正反例） |
| 3 | schema-validator-selftest | PASS | schema-check 自检 33 例通过 |
| 4 | secrets-scanner-selftest | PASS | 23 条规则全部命中合成语料、干净语料零误报、报告脱敏 |
| 5 | run-dir-generator-selftest | PASS | make-run-dir 自检通过（临时副本已清理） |
| 6 | deps-repro-sdk-node | PASS | package.json + package-lock.json 在位（Pi 依赖精确锁 0.85.1） |
| 7 | deps-repro-rpc-python | PASS | requirements.txt 全部 `==` 锁定（实为零第三方依赖） |
| 8 | unit-tests-sdk-node | PASS | npm test 退出 0（80/80） |
| 9 | unit-tests-rpc-python | PASS | stdlib unittest 通过（65/65；runner：`PYTHONPATH=src python3 -m unittest discover -s tests`） |
| 10 | repro-sdk-node | **PASS** | 干净临时目录 npm ci（退出 0，依赖真实重装）+ npm test 退出 0；日志 repro-20260920T034514083Z-sdk-node.log |
| 11 | repro-rpc-python | **PASS** | 干净临时目录 pip install -r requirements.txt（退出 0）+ stdlib unittest 通过；日志 repro-20260920T034514083Z-rpc-python.log |
| 12–16 | scenario-sdk-node-{basic,tool,steer,abort,resume} | PASS | claimed PASS verified：exitCode=0、evidenceFiles 存在、事件 schema 合法且 seq 严格递增；source: runs/2026-09-20T02-12-05-667Z-6220/<scenario>/result.json（6 个 run 中最新完整者，5 个完整） |
| 17–21 | scenario-rpc-python-{basic,tool,steer,abort,resume} | PASS | exitCode=0、evidenceFiles 存在、事件 schema 合法且 seq 严格递增；source: 扁平布局 evidence/rpc/ |
| 22 | comparison-parity | PASS | 两侧均为 pi 0.85.1 + tal-token-plan-06c64a09/deepseek-v4.1-flash + thinking=off；证据：evidence/rpc/environment-rpc-python.json、runs/2026-09-20T02-12-05-667Z-6220/{environment.json,run-summary.json} |
| 23 | evidence-environment | **PASS** | evidence/environment.json（集成人 2026-09-20 03:43:25Z 补齐）为有效 JSON；顶层键：comparisonBaseline, credentialPolicy, evidenceSources, generatedAt, implementations, packageManagers, pi, purpose, runtime, schemaVersion（尚无强制 schema）。B 每个 run 目录内有 environment.json，C 有 evidence/rpc/environment-rpc-python.json，仍无共享 schema |
| 24 | schema-validation | PASS | 10 个结果文件全部通过共享 schema（事件 JSONL 在各场景行内校验） |
| 25 | redaction-evidence | PASS | evidence/ 树 189 文件零发现（运行时点计数，不含该运行自身随后写盘的产物） |
| 26 | redaction-workspace | PASS | evidence/ 以外 86 文件零发现 |
| 27 | exit-codes | PASS | 10 个结果文件（PASS=10）：exit 0 仅出现于 PASS；FAIL/BLOCKED 须非零整数、NOT_RUN 不得为 0（2026-09-20 收口后的完整规则） |
| 28 | residual-processes | PASS | 无本工作区相关残留进程 |

## 4. 五场景结果矩阵（统一基线：tal-token-plan-06c64a09 / deepseek-v4.1-flash / thinking=off / pi 0.85.1）

| 场景 | sdk-node（Agent B） | rpc-python（Agent C） |
|---|---|---|
| basic | PASS（4087ms） | PASS |
| tool | PASS（6073ms） | PASS |
| steer | PASS（3481ms） | PASS |
| abort | PASS（2538ms） | PASS |
| resume | PASS（3908ms） | PASS |

- **两侧 provider/model/thinking/Pi 版本一致，对照前提已满足**（check 22 PASS）。
- B 侧证据：`evidence/sdk/runs/2026-09-20T02-12-05-667Z-6220/<scenario>/{result.json,events.jsonl}`；
  model 解析 source=env-override；Node v24.21.0、npm 11.19.0、Pi 包 0.85.1（全局 CLI 亦 0.85.1），
  五场景 exitCode=0。关键通过性观察（result.json observations）：
  - basic：连续 3 轮子运行各观察到 text_delta、stopReason=stop、流式增量与最终文本拼接一致、
    答案含期望值 42（耗时 1036/894/1152ms）；
  - tool：fixture 地面真值一致、观察到 tool_execution_start/end、工具名 read、isError=false；
  - steer：流中发送（至少一个 delta 之后）、queue_update 非空 steering 队列、队列被消费清空、
    同 session 内产出 steer 后助手消息、sessionId 不变（Pi 0.85.1 同一 agent run 新 turn 形态）；
  - abort：流中（1 个 delta 后）中止、abort() 19ms 内收口（<60000ms）、prompt promise 中止后
    settle、session.isStreaming=false；
  - resume：phase A 子进程退出 0、持久化 session 文件、以 sessionFile+sessionId 跨进程恢复、
    phase B 不引用 phase A 任何内存对象。
- C 侧证据：`evidence/rpc/<scenario>.{result.json,events.jsonl}`；pi 0.85.1、python 3.9.6，
  exitCode=0，每场景含子进程退出码记录。
- 适配层规模（B 的 run-summary.json 审计口径）：适配层 302 行代码/2 文件
  （src/pi-bridge.ts 204 + src/scenarios/resume-child.ts 98）；探针骨架 1836 行代码/17 文件；
  直接 Pi API surface 12 个入口、实际使用的状态/类型访问点 10 个。
- --repro 干净复现对本矩阵的补强：两侧实现可在无既有构建产物的干净目录中从锁定依赖
  重新安装并通过全部单测（checks 10/11，最终收口轮 03:45:14Z 双侧 PASS），命令可由
  第三方原样重放（repro 日志含完整安装与测试输出）。

### 4a. B 的 09-20 重跑时间线（全部证据按追加原则保留，未删未改）

| run | 结果 | 说明 |
|---|---|---|
| `2026-09-20T01-50-33-164Z-97987` | 五场景 BLOCKED（exitCode=2） | 统一基线首跑：`Configured model tal-token-plan-06c64a09/deepseek-v4.1-flash could not be resolved`。根因（B 的 README"模型发现路径（2026-09-20 修正）"）：自定义 provider 由 `~/.pi/agent` 扩展注册，裸 `ModelRuntime.create()` 看不到，必须经 `createAgentSessionServices()` 加载扩展并刷入 ModelRuntime 后才可见 |
| `2026-09-20T02-03-27-035Z-3077` | basic/tool/abort/resume PASS；steer FAIL（exitCode=1） | `createAgentSessionServices()` 修复后首次真实运行；steer 检查原要求"第二个 agent run 启动"，而 Pi 0.85.1 的 steer 语义是同一 agent run 内新 turn（单 agent_start），四项 check-FAIL 属检查器语义不符，非 Pi 能力缺失 |
| `2026-09-20T02-12-05-667Z-6220` | 五场景 PASS（exitCode=0） | B 修正 steer 语义检查（同 run 新 turn 形态亦接受）后完成；本报告引用的最终 run |

另：01:48Z 的验收运行（verify-20260920T014804084Z.json，exit 3，PASS=19/BLOCKED=6）发生于
B 重跑完成之前，结果与 09-18 最终轮一致，历史保留。

PASS 的追溯要求（脚本强制）：exitCode=0、evidenceFiles 存在、至少一个 .jsonl 事件文件、
每行符合 evidence-event schema、seq 从 1 起严格递增、事件 implementation/scenario 与
文件位置一致；runs 布局下另加单 run 约束（跨 run 引用判 FAIL）。FAIL 必须非零退出码且
error 非 null（schema 强制）。BLOCKED 场景的证据校验规则（BLOCKED 亦须可追溯证据）
继续有效，09-18 的 BLOCKED 证据全部原样保留；BLOCKED 结果另须非零整数退出码
（2026-09-20 schema 修订，历史 BLOCKED 证据均使用 exitCode=2，无一失效）。

### 4b. tree-navigation（第六场景）：B/C 已在收口窗口内交付证据，但在共享契约之外、未经统一验收

tree-navigation 不属于 D1 五统一场景（任务书第 7 节仅定义 basic/tool/steer/abort/resume），
verify-d1 的 28 项检查不覆盖它。收口窗口内两侧先后交付了实测证据，以下为事实性摘录
（本报告不为其给出验收判定）：

- **Agent B（已交付，PASS）**：run `evidence/sdk/tree-nav/runs/2026-09-20T02-59-39-706Z-27995/`
  （含 environment.json、run-summary.json、tree-nav/{result.json,events.jsonl}、session-store/）。
  result.json：status=PASS、exitCode=0、统一基线（tal-token-plan-06c64a09/deepseek-v4.1-flash、
  thinking=off）。check-pass 序列（result.json observations）：session 持久化、两轮对话恰产生
  2 user + 2 assistant 条目、navigateTree 前 isStreaming=false、导航前上下文含全部 4 条消息、
  navigateTree(targetId) resolved cancelled=false、**叶指针移动到目标条目（entryId
  3f7ed6ae -> f22507c8）**、sessionId 保持（无新 session）、导航停留在同一 session 文件
  （区别于 fork）、**追加式树：条目数不变（6 条，仅指针移动）**、**上下文从目标分支重建
  （4 -> 2 条消息，turn-2 分支不再在上下文中）**。该 run 独立于五场景的 evidence/sdk/runs/
  布局（B 的静态测试专门约束两者分离），故 runs/ 目录数保持 6。适配层规模相应增长
  （该 result.json limitations 记录）：适配层 302 -> 336 行、探针骨架 1836 -> 2260 行、
  Pi API surface 12 -> 14 入口。
- **Agent C（已交付补充探针，PASS，含关键差异发现）**：`evidence/rpc/tree-navigation.result.jsonl`
  （单行 JSON；注意扩展名非 *.result.json 约定）与 `evidence/rpc/tree-navigation.events.jsonl`
  （110 行）。result：status=PASS、exitCode=0、03:21:32–38Z、统一基线（pi 0.85.1、python 3.9.6）。
  关键发现：**RPC 侧不存在树导航命令**——`navigate_tree` 与 `navigateTree` 两种命名的探针均
  返回 "Unknown command"；C 记录了可用的替代原语：fork（sessionId 与 session 文件均变、
  fork 后丢弃原历史）、switch_session(sessionPath)（可回切并恢复主干历史与叶指针）、
  clone（历史保留）、get_entries(since=...)（游标增量读取）。即 SDK 侧 navigateTree 的
  "同 session 内移动叶指针、上下文按目标分支重建"在 RPC 侧需以 fork/switch_session/clone
  组合达成，语义差异显著——这是五场景之外的一条实质性能力差异实证。
- **两侧证据均在共享契约之外**（双方各自在 limitations 中如实声明，非隐藏）：共享
  scenario-result.schema.json 的 scenario 枚举仅含五个统一场景，B 的 result.json
  （scenario="tree-nav"）与 C 的补充结果在当前契约下 schema-check 判 INVALID
  （Agent D 以 schema-check 复核 B 的 result.json：唯一违规点即 scenario 枚举）。这是契约覆盖范围问题，不是证据质量
  问题；是否扩展共享契约属 PENDING_OWNER（blockers.md）。后续统一验收还应覆盖：C 的
  .result.jsonl 命名、两侧事件文件的 schema/seq 校验、退出码保留规则。
- **收口期并行开发时间线（全部证据按追加原则保留）**：B 的 tree-nav 单测曾在 ~02:55Z
  失败 3 项（静态分离检查 TypeError、README 未提及 probe:tree-nav、fake navigateTree
  语义断言），03:21Z 验收轮已 80/80 通过；B 的 tree-nav run 于 02:59:39Z 执行完毕（早于
  D 的收口验收运行，其证据文件已被 03:21Z/03:22:59Z 两轮扫描覆盖）。C 的 tree_nav 代码
  缺陷（`_append_file_atomically` FileNotFoundError）曾致 03:12Z 验收轮 rpc 侧两项 FAIL，
  ~03:18Z 修复，03:21Z 复跑 PASS（65/65），其补充探针随即于 03:21:32–38Z 执行——与 D 的
  收口验收运行（03:21:22Z 起，历时约 66 秒）时间上重叠；comparison-parity 所读的
  environment-rpc-python.json 于 03:21:31Z 被 C 更新，但 parity 所查字段
  piVersion/provider/model/thinking 前后一致，该检查结果不受影响。C 的 tree-nav
  收尾（README 更新，第 7 节记载 tree-nav 子命令与追加式证据布局）现已交付
  （rpc-python/README.md，工作区未提交改动），03:45:14Z 最终收口轮的
  unit-tests-rpc-python（65/65）与 repro-rpc-python 亦包含其 tree-nav 测试。

### 3a. schema 修订记录（公开，非静默；历史保留）

- 2026-09-18：scenario-result.schema.json 接受 BLOCKED 原因的两种等价编码——顶层
  `blockedReason="CREDENTIALS"`（schema 原生）或 `error.blockedReason="BLOCKED_CREDENTIALS"`
  （任务书 §14 字面编码，sdk-node 交付证据实际采用）。任务书第 14 节原文即使用
  "BLOCKED_CREDENTIALS" 字样，B 按任务书字面编码；修订使契约与任务书一致，两种编码
  均有效、至少具备其一。修订同步记录于 schema description 与 schemas/README.md 第四节。
  修订过程中的缺陷（anyOf 分支对 `error: null` 空匹配）被验收器自己的探针当场
  揪出（verify-20260918T122033623Z.json，schemas-valid FAIL，历史保留），修复后
  verify-20260918T122213821Z.json 通过。
- **2026-09-20（收口）**：可信退出码保留——exit 0 仅保留给 PASS。FAIL 与 BLOCKED 必须
  携带非零整数 exitCode（BLOCKED 表示尝试已执行并被阻塞，进程已终止，退出码必须存在
  且非零）；NOT_RUN 不得声明 exitCode=0（未执行任何命令时 null 可接受）。与
  check_exit_codes 的独立强制互为纵深防御。修订前已用修订后 schema 逐份复核全部
  历史结果文件（evidence/rpc/ 5 份 + evidence/sdk/runs/ 各 run 27 份，含全部 BLOCKED
  证据）：全部 VALID，无一失效。修订同步记录于 schema description、schemas/README.md
  第四节 4a 条与 verify-d1 的 19 例探针（新增 BLOCKED/NOT_RUN 退出码正反例）。

## 5. 验收门槛失败路径自证

`d1-spikes/scripts/selftest-infra` 在系统临时目录复制 d1-spikes 后注入缺陷（不动真实文件；
复制使用 APFS clonefile 加速；副本中移除 B 的两个合成脱敏语料测试文件作测试隔离，
真实扫描仍以真实文件为准）：

| 用例 | 注入缺陷 | 期望 | 结果 |
|---|---|---|---|
| T1 | 篡改 fixtures/numbers.json | fixtures-integrity FAIL，exit 2 | 通过 |
| T2 | 伪造不可追溯的 PASS（引用不存在的 events 文件） | 场景行 FAIL，exit 2 | 通过 |
| T3 | 证据文件注入 Bearer 头与用户主目录路径 | redaction-evidence FAIL，exit 2 | 通过 |
| T4 | 合法 PASS（真实事件文件、seq 严格递增） | 场景行 PASS，整体 exit 3 | 通过 |
| T5 | 事件 seq 乱序（1,3,2） | 场景行 FAIL，exit 2 | 通过 |
| **T6**（2026-09-20 新增） | BLOCKED 结果声称 exitCode=0 | exit-codes 行 FAIL，exit 2 | 通过 |
| **T7**（2026-09-20 新增） | 泄露字符串藏于不完整 run **目录名**（预先扫描只扫文件内容与文件名，目录名不可见；该名字流入 verify 自身产出的 summary/log） | post-write 自扫强制 exit 2，且 summary JSON 的 overall.exitCode/verdict/counts 与真实退出码同步（改写后无新增泄露） | 通过（8/8 断言） |

最新证据：`evidence/verification/selftest-infra-20260920T034959Z.json`（**20/20 断言通过**，
2026-09-20 03:49Z 最终收口轮；同日 03:18Z、03:09Z 亦 20/20；此前各轮记录——含更早的
失败记录——按追加原则保留，未删不改）。
另对 runs 布局的单 run 约束做过对抗性验证：跨 run 引用、扁平结果引用 run 内文件均被
正确判 FAIL（同 run 引用无问题）。
T7 的设计说明：泄露经由目录名进入 verify 的 run 选择说明（"newer incomplete run(s)
not used: <run 名>"）与 summary 的 evidenceLayout——这正是 post-write 自扫存在的意义
（预先扫描的盲区由它兜底）；T7 同时断言改判后 summary 重写未引入新泄露
（postWriteScan.newFindingsFromRewrite=0）。
测试隔离说明（2026-09-20）：收口期 B/C 并行开发 tree-nav，其进行中单测的通过性曾
随时间变化；T4/T7 断言的是 verify 的确定性行为（exit 3 / 3→2 改判），故这两个用例的
**临时副本**把两侧单测入口替换为确定性通过（npm test 改为 no-op、rpc tests/ 替换为
stub），与既有 KNOWN_SCAN_NOISE 隔离同一先例；真实工作区的单测状态由真实 verify
运行如实记录（03:12Z 记录到 rpc FAIL，03:21Z/03:45Z 记录到双侧 PASS，各轮均保留）。

## 6. 已确认事实（每条附证据）

1. 五个确定性 fixture 文件与 MANIFEST.sha256 一致（verify-20260920T034514083Z.json check 1）。
2. 两个共享 schema 通过 19 个正反例探针，含 BLOCKED 两种编码、`error:null` 边界与
   2026-09-20 退出码保留正反例（check 2）。
3. sdk-node 交付完整：package.json + package-lock.json（Pi 0.85.1 精确锁）+ npm test 80/80（checks 6、8）。
4. rpc-python 交付完整：requirements.txt 全 `==` 锁定（零第三方依赖）+ stdlib unittest 65/65（checks 7、9）。
5. **--repro 干净复现双侧 PASS**：sdk-node 在干净临时目录 npm ci 退出 0（依赖真实重装）
   + npm test 退出 0；rpc-python pip install 退出 0 + stdlib unittest 通过
   （checks 10、11；repro-20260920T034514083Z-{sdk-node,rpc-python}.log，安装与测试
   输出原样留档；历史轮 03:21Z/03:12Z 日志一并保留）。
6. Agent B 以统一基线重跑后五场景全部 PASS、exitCode=0，证据通过 schema/seq/字段一致性校验
   （checks 12–16；runs/2026-09-20T02-12-05-667Z-6220/）。此前 09-18 的 BLOCKED_CREDENTIALS
   结果与 09-20 两次中间 run 全部历史保留。
7. Agent C 五场景结果均为 PASS、exitCode=0、事件可追溯且 schema 合法（checks 17–21；evidence/rpc/）。
8. 两侧对照前提满足：Pi 版本一致（0.85.1）、provider 一致（tal-token-plan-06c64a09）、
   model 一致（deepseek-v4.1-flash）、thinking 一致（off）（check 22 PASS）。
9. **最终收口轮 28/28 全 PASS、exit 0（ALL_PASS）**：五场景双侧 PASS、comparison-parity
   PASS、evidence-environment PASS、--repro 双侧 PASS 于 03:45:14Z 同一轮达成，为验收
   运行史 16 条中首个 exit 0（verify-20260920T034514083Z.json overall）。
10. **集成人已补齐共享文件**：`d1-spikes/README.md`（03:43:15Z）与
    `evidence/environment.json`（03:43:25Z）；environment.json 为有效 JSON，键含
    pi/comparisonBaseline/runtime/packageManagers/implementations/evidenceSources/
    credentialPolicy（check 23 PASS；03:43:34Z 默认模式轮已先行记录该转绿）。
11. 全部 d1-spikes 秘密/脱敏扫描零发现：03:45Z 最终收口轮 evidence/ 189 文件 + 其余
    86 文件（checks 25/26）；`check-secrets` 独立复扫零发现（03:47Z 时点 279 文件）；
    历史各轮（03:22:59Z 264 文件、03:33:45Z 265 文件）零发现记录一并保留。
12. 无残留探针进程（check 28）。
13. 验收门槛失败路径自证 20/20（T1–T7，含 2026-09-20 新增的两个缺口回归测试）：
    selftest-infra-20260920T034959Z.json（03:49Z）；历史各轮保留。
14. schema-check --selftest 33 例通过（最终收口时独立执行，exit 0；亦见 check 3
    于 03:45:14Z 轮的记录）。
15. A 已交付 research/ 三件：pi-capability-inventory.md、sdk-vs-rpc-matrix.md、
    adr-001-draft.md（状态 Proposed，未批准）。
16. 收口期并行开发是真实发生的：03:12Z 验收轮记录到 rpc 侧 unit-tests 与 --repro 两行
    FAIL（C 进行中 tree-nav 代码缺陷，堆栈留档），C 修复后 03:21Z 轮同一两行 PASS、
    03:45Z 最终收口轮亦 PASS；B 侧 tree-nav 测试在收口窗口内从 3 项失败变为 80/80 通过。
    各轮验收记录与 repro 日志均按追加原则保留，可对照时间线复核
    （verify-20260920T031204255Z.json、verify-20260920T032122324Z.json、
    verify-20260920T034514083Z.json、repro-20260920T031204255Z-rpc-python.log、
    repro-20260920T032122324Z-rpc-python.log、repro-20260920T034514083Z-rpc-python.log）。
17. 本机为 macOS（darwin）、Python 3.9.6（CommandLineTools，无 pytest）、Node v24.21.0；
    仓库 commit 5eca1d1（"Unblock SDK probe with Pi extension discovery"），工作区含
    未提交改动（A 的矩阵/ADR 更新、B/C 的 tree-nav 交付、集成人的 README/environment.json
    与 D 的收口修改；verify JSON environment/git 字段如实记录 dirty=true）。
18. B/C 在收口窗口内先后交付 tree-navigation 实测证据（B：
    evidence/sdk/tree-nav/runs/2026-09-20T02-59-39-706Z-27995/，PASS、exitCode=0；
    C：evidence/rpc/tree-navigation.{result.jsonl,events.jsonl}，PASS、exitCode=0，含
    "RPC 无 navigate 命令"的关键差异发现），两者均在共享 scenario 枚举之外（第 4b 节），
    不在本轮 28 项验收范围内，本报告仅作事实摘录；A 亦于收口期更新了矩阵/ADR
    （research/ 内，工作区未提交改动）。

## 7. 推断（非事实，需复核）

1. 两侧五场景在统一基线下全部 PASS 且 --repro 干净复现通过，为 DECISION-001/002 的
   对照矩阵提供了同基线、可第三方重放的实测输入；但"哪条路线更优"的结论属于负责人
   决策，本报告不作倾向性推断（A 的矩阵与 ADR 草案为输入）。
2. C 的 liveCheck 与 `pi auth check` 结果背离（一个 provider 报 not_ready 却正常服务、
   另一个报 ready 却 403）说明凭据就绪性判断应以真实最小调用为准——该观察由 C 的
   证据支持（observation-copycopy-403.json），推广为一般规则属于推断。B 09-20 的经历
   （README：扩展注册的 provider 须经 createAgentSessionServices() 才可见）是该推断的
   SDK 侧佐证：模型可见性同样取决于发现路径，而非仅凭配置存在。
3. 五场景之外的能力差异（tree/session navigation、extension UI、类型安全等）以 A 的
   调研矩阵为参考输入；tree-navigation 现已有双侧实测数据点（第 4b 节：SDK 侧
   navigateTree 同 session 移动叶指针并按目标分支重建上下文；RPC 侧无 navigate
   命令，以 fork/switch_session/clone 组合达成），可对照矩阵核验，但该证据未经
   统一验收，定位仍是参考输入。
4. 02:03 run 的 steer FAIL 是 B 检查器语义与 Pi 0.85.1 实际行为不符，修正检查器后 02:12
   全 PASS；据此推断 Pi 0.85.1 的 steer 在同一 agent run 内以新 turn 生效（单 agent_start），
   该行为以 B 的 result.json 观察为证，但属单实现单版本观察。
5. --repro 的 rpc-python 侧因零第三方依赖，其"重装"只验证了 requirements.txt 可解析执行，
   未验证任何第三方包的锁定安装（没有包可装）；sdk-node 侧则完整验证了 lockfile 重装。
   两侧复现强度不对等，属实现本身的属性，非遗收缺陷。

## 8. 未决问题

1. **（已解决，2026-09-20 03:43Z）** evidence/environment.json 与 d1-spikes/README.md
   已由集成人补齐（DELIVERY-004 关闭）：environment.json 为有效 JSON（check 23 PASS，
   键清单见第 3 节）；README 覆盖目录索引、固定基线、可复现命令、证据规则与负责人
   待决事项。遗留跟进（非阻塞）：该文件尚无强制 schema（schemas/README.md 第五节），
   B/C 各自的环境记录（run 内 environment.json、evidence/rpc/environment-rpc-python.json）
   亦无共享 schema，comparison-parity 仍按防御式解析读取——是否为其定 schema 属后续
   跟进项。
2. tree-navigation 证据已由 B/C 在收口窗口内交付（第 4b 节）但未经统一验收：共享
   scenario-result schema 的 scenario 枚举是否扩展以覆盖 'tree-nav'/'tree-navigation'
   属 PENDING_OWNER（blockers.md DECISION-009）；扩展后需对两侧证据补跑 schema/退出码/事件/seq
   校验（C 的结果文件扩展名 .result.jsonl 亦不符合 *.result.json 约定，验收时需定夺；
   两侧事件文件的 scenario 字段同样在枚举外）。
3. 秘密扫描的已知边界不变：跳过 .git/node_modules/venv/缓存、二进制与 >20MB 文件；
   规则为模式匹配，无法覆盖所有私有令牌格式（声明过的盲区，非隐藏通过）；另
   pre-write 扫描不覆盖目录名（T7 即利用此盲区注入），由 post-write 自扫对 verify
   自身产物兜底，但其他消费目录名的路径仍属盲区。
4. residual-processes 对以相对路径启动且命令行不含 d1-spikes 路径的探针进程可能漏报；
   对 pi rpc 子进程与临时 run 目录进程必然捕获。
5. A/B/C 与集成人的收口期改动（A 的矩阵/ADR 更新、B/C 的 tree-nav 代码、集成人的
   README/environment.json、D 的收口修改与报告更新）目前均为工作区未提交改动；
   commit 与否属负责人/版本管理决策，本报告仅记录现状（verify JSON git 字段
   dirty=true）。
6. --repro 干净复现 ≠ 目标设备人工复现（任务书 §11 禁止等同）；负责人真实环境复现
   仍是 DECISION-007 的前置。

### 8a. 集成人补齐项（已于 2026-09-20 03:43Z 交付；下文保留原登记与实际交付对照）

**已于 2026-09-20 03:43Z 由集成人补齐（DELIVERY-004 关闭）。本节保留原登记内容作为
历史记录，并附实际交付与建议的对应关系；Agent D 未创建/修改这两个文件。**

1. **`d1-spikes/README.md`**（任务书 §3 目录树与 §2.1"可由非作者重复运行的 README"）。
   原建议内容与来源（实际交付已覆盖下列各项）：
   - 工作区结构与所有权边界（来源：任务书 §4 所有权表；本报告头部）；
   - 从安装到全套探针的命令（来源：`sdk-node/README.md`、`rpc-python/README.md`、
     本报告第 11 节命令清单）；
   - 五场景定义与判定标准（来源：`fixtures/README.txt`、任务书 §7）；
   - 证据布局与写入规则（来源：`schemas/README.md` 第二节、第三节）;
   - 验收入口与退出码语义（来源：本报告第 2 节；`scripts/verify-d1 --help`）；
   - 秘密扫描边界声明（来源：本报告第 8 节第 3 条）。
2. **`d1-spikes/evidence/environment.json`**（共享环境记录）。原建议字段
   （来源：schemas/README.md 第五节，尚无强制 schema）：
   `piVersion`、`provider`、`model`、`thinking`、`node`、`python`、`packageManager`、
   `generatedAt`。数据来源：SDK 侧 `evidence/sdk/runs/2026-09-20T02-12-05-667Z-6220/
   environment.json` 与同目录 `run-summary.json`（含 node/npm/pi 版本与 model 块）；
   RPC 侧 `evidence/rpc/environment-rpc-python.json`（含 pi 0.85.1、python 版本）。
   **实际交付对应关系**：piVersion→`pi.version`（0.85.1，另含 packageName/cliVersion）、
   provider/model/thinking→`comparisonBaseline.{providerId,modelId,thinkingLevel}`、
   node/python→`runtime.{node,python}`（另含 platform=darwin）、packageManager→
   `packageManagers.{sdkNode,rpcPython}`、generatedAt→`generatedAt`（2026-09-20T03:33:45Z）；
   另含 purpose/implementations/evidenceSources/credentialPolicy。补齐后 verify-d1 的
   evidence-environment 检查已按预期从 NOT_RUN 转为 JSON 解析检查并 PASS
   （scripts/verify-d1 check_environment_file；03:43:34Z 默认模式轮与 03:45:14Z
   最终收口轮均记录）。

## 9. 需要负责人决定的事项

验收层面已全部通过（28/28、exit 0），但以下决定**不因此自动关闭**，全部登记于
`reports/blockers.md`，状态 PENDING_OWNER：SDK/RPC 路线（DECISION-001）、
宿主语言（DECISION-002）、版本基线（DECISION-003）、同进程权限（DECISION-004）、
产品工具/目录权限（DECISION-005）、ADR-001 批准（DECISION-006）、D1 Go/Conditional
Go/No-Go（DECISION-007）、统一 provider/model 基线的正式确认（DECISION-008；
对照前提已满足，剩余为负责人正式记录决定）。收口期新增待决项：共享 scenario-result
schema 的 scenario 枚举是否扩展以覆盖 tree-nav/tree-navigation（两侧证据已交付但
在契约外，见第 4b/8 节；DECISION-009）。
交付阻塞已全部关闭（DELIVERY-001 至 007，其中 004 于 03:43Z 由集成人补齐关闭、
006 于 03:21Z 首次执行双侧 PASS、007 证据交付但契约扩展待 DECISION-009）。
本报告不替负责人批准 ADR、不做最终选型、不给出 Go/No-Go。

## 10. 证据索引

- 本次验收详细运行（最终收口，--repro 模式，ALL_PASS）：evidence/verification/verify-20260920T034514083Z.json / .log（**exit 0，PASS=28/FAIL=0/BLOCKED=0/NOT_RUN=0**，验收史首个 exit 0）
- --repro 干净复现日志（最终轮）：evidence/verification/repro-20260920T034514083Z-sdk-node.log、repro-20260920T034514083Z-rpc-python.log
- 集成人补齐后默认模式轮（03:43:34Z，evidence-environment 转 PASS，--repro 两项 NOT_RUN 属模式语义）：evidence/verification/verify-20260920T034334578Z.json / .log（exit 3，PASS=26/NOT_RUN=2）
- 收口期 --repro 轮（03:21:22Z，双侧 PASS，唯一 NOT_RUN 为 environment.json）：evidence/verification/verify-20260920T032122324Z.json / .log（exit 3，PASS=27/NOT_RUN=1）；repro-20260920T032122324Z-{sdk-node,rpc-python}.log
- 收口期中间轮（rpc 侧因 C 进行中代码 FAIL，历史保留）：evidence/verification/verify-20260920T031204255Z.json / .log（exit 2，PASS=25/FAIL=2）；repro-20260920T031204255Z-{sdk-node,rpc-python}.log
- 失败路径自证：evidence/verification/selftest-infra-20260920T034959Z.json（20/20，T1–T7，03:49Z）；selftest-infra-20260920T031856Z.json、selftest-infra-20260920T030958Z.json（同日 20/20）；此前 selftest-infra-20260920T021943Z.json（10/10）及更早各轮保留
- 秘密扫描报告：evidence/verification/secrets-scan-20260920T034514083Z-{evidence,workspace}.json（随最终收口验收，189+86 文件零发现）；发布时点（2026-09-20T04:06:33Z）全工作区复扫 280 文件零发现（secrets-scan-20260920T040633Z-full-workspace.json，覆盖集成人补齐文件、B/C tree-navigation 证据与全部最终收口产物）；定稿确认复扫（04:08:16Z）281 文件零发现（secrets-scan-20260920T040816Z-full-workspace.json）；此后对报告仅追加本类扫描文件名的引用行。历史各轮（secrets-scan-20260920T032259Z-full-workspace.json 264 文件、secrets-scan-20260920T033343Z-full-workspace.json 265 文件）零发现记录保留
- 运行历史（追加式，16 条）：evidence/verification/verify-history.jsonl
- B 场景证据（最终 run）：evidence/sdk/runs/2026-09-20T02-12-05-667Z-6220/（含 run-summary.json、environment.json、resume/session-store/）；09-20 中间 run：runs/2026-09-20T01-50-33-164Z-97987/（全 BLOCKED）、runs/2026-09-20T02-03-27-035Z-3077/（steer FAIL）；09-18 各 run 一并保留
- C 场景证据：evidence/rpc/*.result.json、*.events.jsonl、environment-rpc-python.json、observation-copycopy-403.json、crash-probe.json
- B tree-navigation 证据（收口窗口交付，共享契约枚举外，未经统一验收）：evidence/sdk/tree-nav/runs/2026-09-20T02-59-39-706Z-27995/（PASS，exitCode=0）
- C tree-navigation 补充探针（收口窗口交付，共享契约枚举外，未经统一验收）：evidence/rpc/tree-navigation.result.jsonl、evidence/rpc/tree-navigation.events.jsonl（PASS，exitCode=0）
- A 调研产物：research/pi-capability-inventory.md、research/sdk-vs-rpc-matrix.md、research/adr-001-draft.md
- 共享环境记录与工作区 README（集成人 2026-09-20 03:43Z 补齐）：evidence/environment.json、d1-spikes/README.md
- 共享契约：schemas/README.md（2026-09-20 修订见第四节 4a 条）、schemas/evidence-event.schema.json、schemas/scenario-result.schema.json
- 夹具与清单：fixtures/README.txt、fixtures/numbers.json、fixtures/readonly/、fixtures/MANIFEST.sha256

## 11. 可复现命令（在仓库根目录执行）

```bash
d1-spikes/scripts/verify-d1                     # 统一验收（默认模式恒含 --repro 两项 NOT_RUN，故 exit 3；五场景等 26 项检查 PASS）
d1-spikes/scripts/verify-d1 --repro             # 干净复现（临时目录重装重测；需网络；2026-09-20 03:45:14Z 轮 28/28 全 PASS，exit 0）
d1-spikes/scripts/selftest-infra                # 验收门槛失败路径自证（最新 20/20，T1–T7）
d1-spikes/scripts/make-run-dir                  # 生成 fixtures 临时副本
d1-spikes/scripts/make-run-dir --selftest
d1-spikes/scripts/check-secrets d1-spikes       # 秘密/脱敏扫描（最终收口时点独立复扫零发现；--json OUT 可落盘报告）
d1-spikes/scripts/check-secrets --selftest
d1-spikes/scripts/schema-check --selftest       # 33 例
d1-spikes/scripts/schema-check d1-spikes/schemas/scenario-result.schema.json <result-file>
cd d1-spikes/rpc-python && PYTHONPATH=src python3 -m unittest discover -s tests   # C 单测（65 例）
cd d1-spikes/sdk-node && npm test                                                   # B 单测（80 例）
cd d1-spikes/sdk-node && npm run probe:all                                          # B 五场景（需可用凭据）
cd d1-spikes/fixtures && shasum -a 256 -c MANIFEST.sha256
```

## 12. 声明

- 本报告未删除、未改写任何历史验收记录；09-18 的旧布局误判运行、schema 缺陷中间运行、
  BLOCKED_CREDENTIALS 各轮，09-20 B 的两次中间 run（01:50 全 BLOCKED、02:03 steer FAIL），
  以及收口期的 03:12Z 中间轮（rpc 侧两项 FAIL，源于 C 进行中的 tree-nav 代码）均按
  "证据只追加"原则原样保留；03:21Z/03:43:34Z/03:45:14Z 各轮依次追加，未删改。
- Agent D 未替负责人批准 ADR、未做 SDK/RPC 最终选型、未给出 Go/Conditional Go/No-Go，
  亦未替负责人正式记录 DECISION-008 的基线决定、未替负责人定夺 DECISION-009 的
  tree-nav 契约扩展。
- B 的 09-18 BLOCKED_CREDENTIALS 是如实保留的诚实结果；09-20 统一基线重跑后五场景 PASS，
  两段历史并存，均未删改。
- --repro 的 PASS 表示锁定依赖可在干净目录重装并通过单测，是可复现性判定，不等同于
  目标设备人工复现（任务书 §11）。
- comparison-parity 的 PASS 表示对照前提（同 Pi 版本/provider/model/thinking）已满足，
  是输入条件判定，不是路线选型结论。
- 03:45:14Z 最终收口轮的 28/28 全 PASS 与 exit 0 是**验收层面**结论：表示按本验收器
  的 28 项检查未发现任何 FAIL/BLOCKED/NOT_RUN；负责人决策项（第 9 节，全部
  PENDING_OWNER）不因此自动关闭。
- Agent D 未修改集成人补齐的 d1-spikes/README.md 与 evidence/environment.json（只读
  引用）；亦未修改 A/B/C 的代码与证据。
- 本报告与全部新证据不含绝对用户路径（系统临时目录 /var/folders/ 属 macOS 系统路径，
  非用户主目录）与任何密钥；03:45:14Z 最终收口轮自扫（evidence 189 文件 + 工作区
  86 文件）与 03:47Z 独立复扫（279 文件）均零发现；发布时点（04:06:33Z）全工作区
  280 文件、定稿确认（04:08:16Z）281 文件复扫均零发现（见第 10 节证据索引）。
