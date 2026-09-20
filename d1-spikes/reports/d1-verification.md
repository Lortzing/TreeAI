# TreeAI D1 验收汇总（d1-verification）

- 报告产出：Agent D（独占范围：d1-spikes/fixtures/、d1-spikes/schemas/、d1-spikes/scripts/、d1-spikes/evidence/verification/、d1-spikes/reports/）
- 生成时间（UTC）：2026-09-20T02:15Z 验收运行之后，依据下列证据文件中的时间戳
- 统一验收入口：`d1-spikes/scripts/verify-d1`
- 本次引用的详细运行（最终确认）：`evidence/verification/verify-20260920T021547888Z.json`（及同名 .log；exit 3；02:15:47Z 于主工作区执行，durationMs 31288）
- 运行历史（追加式，未删除/改写任何旧记录）：`evidence/verification/verify-history.jsonl`（当前 12 条，最早 2026-09-18T10:48:57Z）
- 本报告只汇总可验证事实与判定，不替负责人做最终选型，不给出 Go/Conditional Go/No-Go 签字（见 `reports/blockers.md` DECISION-007）。

## 版本沿革

1. **2026-09-18 版**（历史保留）：依据 verify-20260918T123312170Z，彼时 B 五场景
   BLOCKED_CREDENTIALS（403）、comparison-parity BLOCKED（provider/model 不一致），
   counts 为 PASS=19、FAIL=0、BLOCKED=6、NOT_RUN=3，exit 3。
2. **2026-09-20 版（本版）**：Agent B 以统一基线
   （provider=tal-token-plan-06c64a09、model=deepseek-v4.1-flash、thinking=off）
   在主工作区完成真实 SDK 重跑，五场景全部 PASS（exitCode=0）；验收器本轮**未改动**
   （修正仅发生在 09-18，见第 0 节），verify-d1 自动选中最新完整 run
   `2026-09-20T02-12-05-667Z-6220` 并判定 comparison-parity PASS。counts 更新为
   **PASS=25、FAIL=0、BLOCKED=0、NOT_RUN=3，exit 3**（不完整仅来自 3 个真实 NOT_RUN：
   两项 --repro 未请求 + 共享 evidence/environment.json 缺失）。B 的 09-20 中间 run
   （01:50 全 BLOCKED、02:03 steer FAIL）全部按追加原则保留（见第 4 节）。

## 0. 验收器修正记录（Agent D，scripts/ 与 schemas/ 内；2026-09-18 完成，其后未再改动）

1. **支持并严格校验 sdk-node 的追加式 runs 证据布局**。Agent B 的证据实际位于
   `evidence/sdk/runs/<run-id>/<scenario>/{result.json,events.jsonl}`，而旧验收器只查扁平
   `evidence/sdk/<scenario>.result.json`，导致 11:59Z 的运行把 5 个 SDK 场景误判为 FAIL
   （verify-20260918T115924248Z.json，历史保留）。新规则（schemas/README.md 第二节）：
   某场景若存在扁平文件则以扁平为准；否则选用 runs/ 下**最新的完整 run**（五场景
   result.json 齐备）；run 内结果引用的 evidenceFiles 必须仍位于同一 run 目录，
   **跨 run 引用判 FAIL**；runs/ 存在但无完整 run 时按交付不完整判 FAIL。
   09-20 轮实际选定 run：`2026-09-20T02-12-05-667Z-6220`（6 个 run 中最新完整者；
   完整 run 共 5 个：2026-09-18T11-09-33-297Z-78785、2026-09-18T11-57-46-510Z-5120、
   2026-09-20T01-50-33-164Z-97987、2026-09-20T02-03-27-035Z-3077、2026-09-20T02-12-05-667Z-6220；
   不完整 1 个：2026-09-18T11-07-09-207Z-77525，缺 steer/abort/resume 的 result.json，
   未使用、未混拼）。
2. **rpc-python 单元测试改为 pytest 优先、stdlib unittest 兜底**。Agent C 的测试使用标准库
   unittest；本机无 pytest 时旧验收器误记 BLOCKED。新逻辑：pytest 可导入则运行 pytest，
   否则运行 `PYTHONPATH=src python -m unittest discover -s tests`（与 rpc-python/
   requirements.txt 记载的命令一致）；两者均不可用才 BLOCKED；失败仍保持 FAIL/非零退出语义。
3. **新增 comparison-parity 检查**：两实现须满足任务书第 5 节"同一 Pi 版本、同一模型、
   同一 thinking"的公平对照前提，否则判 BLOCKED 并指向 PENDING_OWNER（DECISION-008）。
   09-20 轮该检查首次 PASS（见 check 22）。另：BLOCKED 场景结果现在也要求证据可追溯
   （任务书 §0.6、§14），schema 对 BLOCKED_CREDENTIALS 的两种编码做了公开修订（见第 3a 节）。

## 1. 总体状态

| 区域 | 状态 | 依据 |
|---|---|---|
| Agent D 静态基础设施（fixtures/schemas/scripts/扫描/验收门槛） | PASS | verify-20260920T021547888Z.json checks 1–5 |
| Agent A（research/：能力清单/矩阵/ADR 草案） | 已交付；ADR 状态 Proposed（未批准） | research/pi-capability-inventory.md（423 行）、research/sdk-vs-rpc-matrix.md（226 行）、research/adr-001-draft.md（188 行，状态行："Proposed（草案，未批准）"） |
| Agent B（sdk-node/ + evidence/sdk/runs/） | 已交付；统一基线重跑后五场景 PASS（exitCode=0） | checks 6/8/12–16；evidence/sdk/runs/2026-09-20T02-12-05-667Z-6220/ |
| Agent C（rpc-python/ + evidence/rpc/） | 已交付；五场景 PASS | checks 7/9/17–21；evidence/rpc/*.result.json |
| SDK/RPC 对照公平性 | PASS（provider/model/thinking 一致） | check 22；DECISION-008 条件已满足 |
| 整体验收退出码 | 3 = INCOMPLETE（无 FAIL/BLOCKED，存在 NOT_RUN） | verify-20260920T021547888Z.json overall；verify-history.jsonl 第 12 条 |

**counts：PASS=25、FAIL=0、BLOCKED=0、NOT_RUN=3，exit 3。** 无 FAIL、无 BLOCKED；
不完整仅来自 3 个 NOT_RUN：repro-sdk-node 与 repro-rpc-python（--repro 未请求）
和 evidence-environment（共享 evidence/environment.json 缺失，属主未定 DELIVERY-004）。

## 2. 验收入口与退出码约定（不变）

命令：`d1-spikes/scripts/verify-d1`（干净复现模式：`--repro`）。

| 退出码 | 含义 |
|---|---|
| 0 | 全部检查 PASS |
| 2 | 至少一项 FAIL（缺文件/schema 违规/泄密/退出码不可信/残留进程等） |
| 3 | 无 FAIL 但存在 BLOCKED 或 NOT_RUN（交付不完整，当前状态） |
| 1 | 验收工具自身错误 |

每次运行产出 `verify-<时间戳>.json`/`.log` 与两份 `secrets-scan-<时间戳>-{evidence,workspace}.json`，
并向 `verify-history.jsonl` 追加一行；证据只追加，不改写历史（当前共 12 条，最早
2026-09-18T10:48:57Z，最新 2026-09-20T02:15:47Z）。写盘后对本次产物做泄露自扫，
发现泄密强制改判 exit 2。

**--repro 干净复现说明（保持有效）**：`d1-spikes/scripts/verify-d1 --repro` 会把已交付的
sdk-node/ 或 rpc-python/ 复制到系统临时目录（排除 node_modules/venv 等派生产物），
执行 `npm ci` + `npm test`（sdk-node）或 `pip install -r requirements.txt` + 单元测试
（rpc-python；pytest 优先，缺失时 `PYTHONPATH=src python -m unittest discover -s tests`），
日志写入 `evidence/verification/repro-<时间戳>-<实现>.log`。该模式需要网络；本次运行
未请求，两行如实记 NOT_RUN，未伪造执行。

## 3. 检查明细（28 项，与 verify-20260920T021547888Z.json 一一对应）

| # | 检查项 | 状态 | 说明/证据 |
|---|---|---|---|
| 1 | fixtures-integrity | PASS | 5 个 fixture 文件对 MANIFEST.sha256 校验通过；tool 场景聚合与 README.txt 一致 |
| 2 | schemas-valid | PASS | 两个 schema 可解析；14 个正/反例探针按预期接受/拒绝（含 BLOCKED_CREDENTIALS 两种编码的正反例） |
| 3 | schema-validator-selftest | PASS | schema-check 自检 33 例通过 |
| 4 | secrets-scanner-selftest | PASS | 23 条规则全部命中合成语料、干净语料零误报、报告脱敏 |
| 5 | run-dir-generator-selftest | PASS | make-run-dir 自检通过（临时副本已清理） |
| 6 | deps-repro-sdk-node | PASS | package.json + package-lock.json 在位（Pi 依赖精确锁 0.85.1） |
| 7 | deps-repro-rpc-python | PASS | requirements.txt 全部 `==` 锁定（实为零第三方依赖） |
| 8 | unit-tests-sdk-node | PASS | npm test 退出 0 |
| 9 | unit-tests-rpc-python | PASS | stdlib unittest 通过（runner：`PYTHONPATH=src python3 -m unittest discover -s tests`；本机 CommandLineTools python3 无 pytest） |
| 10 | repro-sdk-node | NOT_RUN | 未请求 --repro；命令已登记 |
| 11 | repro-rpc-python | NOT_RUN | 同上 |
| 12–16 | scenario-sdk-node-{basic,tool,steer,abort,resume} | PASS | claimed PASS verified：exitCode=0、evidenceFiles 存在、事件 schema 合法且 seq 严格递增；source: runs/2026-09-20T02-12-05-667Z-6220/<scenario>/result.json（6 个 run 中最新完整者，5 个完整） |
| 17–21 | scenario-rpc-python-{basic,tool,steer,abort,resume} | PASS | exitCode=0、evidenceFiles 存在、事件 schema 合法且 seq 严格递增；source: 扁平布局 evidence/rpc/ |
| 22 | comparison-parity | PASS | 两侧均为 pi 0.85.1 + tal-token-plan-06c64a09/deepseek-v4.1-flash + thinking=off；证据：evidence/rpc/environment-rpc-python.json、runs/2026-09-20T02-12-05-667Z-6220/{environment.json,run-summary.json} |
| 23 | evidence-environment | NOT_RUN | evidence/environment.json 不存在；属主未定（DELIVERY-004）。B 每个 run 目录内有 environment.json，C 有 evidence/rpc/environment-rpc-python.json，均无共享 schema |
| 24 | schema-validation | PASS | 10 个结果文件全部通过共享 schema（事件 JSONL 在各场景行内校验） |
| 25 | redaction-evidence | PASS | evidence/ 树 150 文件零发现（运行时点计数，不含该运行自身随后写盘的产物） |
| 26 | redaction-workspace | PASS | evidence/ 以外 80 文件零发现 |
| 27 | exit-codes | PASS | 10 个结果文件：PASS 退出码为 0，FAIL 非零 |
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
error 非 null（schema 强制）。此前 BLOCKED 场景的证据校验规则（BLOCKED 亦须可追溯证据）
继续有效，09-18 的 BLOCKED 证据全部原样保留。

### 3a. schema 修订记录（公开，非静默；2026-09-18，历史保留）

- 2026-09-18：scenario-result.schema.json 接受 BLOCKED 原因的两种等价编码——顶层
  `blockedReason="CREDENTIALS"`（schema 原生）或 `error.blockedReason="BLOCKED_CREDENTIALS"`
  （任务书 §14 字面编码，sdk-node 交付证据实际采用）。任务书第 14 节原文即使用
  "BLOCKED_CREDENTIALS" 字样，B 按任务书字面编码；修订使契约与任务书一致，两种编码
  均有效、至少具备其一。修订同步记录于 schema description 与 schemas/README.md 第四节。
  修订过程中的缺陷（anyOf 分支对 `error: null` 空匹配）被验收器自己的 14 例探针当场
  揪出（verify-20260918T122033623Z.json，schemas-valid FAIL，历史保留），修复后
  verify-20260918T122213821Z.json 通过。

## 5. 验收门槛失败路径自证

`d1-spikes/scripts/selftest-infra` 在系统临时目录复制 d1-spikes 后注入缺陷（不动真实文件；
复制使用 APFS clonefile 加速；副本中移除 B 的两个合成脱敏语料测试文件作测试隔离，
真实扫描仍以真实文件为准）：

| 用例 | 注入缺陷 | 期望 | 结果 |
|---|---|---|---|
| T1 | 篮改 fixtures/numbers.json | fixtures-integrity FAIL，exit 2 | 通过 |
| T2 | 伪造不可追溯的 PASS（引用不存在的 events 文件） | 场景行 FAIL，exit 2 | 通过 |
| T3 | 证据文件注入 Bearer 头与用户主目录路径 | redaction-evidence FAIL，exit 2 | 通过 |
| T4 | 合法 PASS（真实事件文件、seq 严格递增） | 场景行 PASS，整体 exit 3 | 通过 |
| T5 | 事件 seq 乱序（1,3,2） | 场景行 FAIL，exit 2 | 通过 |

最新证据：`evidence/verification/selftest-infra-20260920T021943Z.json`（10/10 断言通过，
2026-09-20 02:19Z 复跑确认；此前各轮记录——含更早的失败记录——按追加原则保留，未删不改）。
另对 runs 布局的单 run 约束做过对抗性验证：跨 run 引用、扁平结果引用 run 内文件均被
正确判 FAIL（同 run 引用无问题）。

## 6. 已确认事实（每条附证据）

1. 五个确定性 fixture 文件与 MANIFEST.sha256 一致（verify-20260920T021547888Z.json check 1）。
2. 两个共享 schema 通过 14 个正反例探针，含 BLOCKED 两种编码与 `error:null` 边界（check 2）。
3. sdk-node 交付完整：package.json + package-lock.json（Pi 0.85.1 精确锁）+ npm test 退出 0（checks 6、8）。
4. rpc-python 交付完整：requirements.txt 全 `==` 锁定（零第三方依赖）+ stdlib unittest 通过（checks 7、9）。
5. Agent B 以统一基线重跑后五场景全部 PASS、exitCode=0，证据通过 schema/seq/字段一致性校验
   （checks 12–16；runs/2026-09-20T02-12-05-667Z-6220/）。此前 09-18 的 BLOCKED_CREDENTIALS
   结果与 09-20 两次中间 run 全部历史保留。
6. Agent C 五场景结果均为 PASS、exitCode=0、事件可追溯且 schema 合法（checks 17–21；evidence/rpc/）。
7. 两侧对照前提满足：Pi 版本一致（0.85.1）、provider 一致（tal-token-plan-06c64a09）、
   model 一致（deepseek-v4.1-flash）、thinking 一致（off）（check 22 PASS）。
8. 全部 d1-spikes 秘密/脱敏扫描零发现：verify 运行时点 evidence/ 150 文件 + 其余 80 文件
   （checks 25/26）；`check-secrets d1-spikes` 于 02:17Z 复扫 234 文件（含验收新产物）exit 0 零发现。
9. 无残留探针进程（check 28）。
10. A 已交付 research/ 三件：pi-capability-inventory.md、sdk-vs-rpc-matrix.md、adr-001-draft.md
    （状态 Proposed，未批准）。
11. B 曾在 sdk-node/tests 遗留 13 处合成秘密样式字符串（11:59Z 运行 redaction-workspace FAIL，
    verify-20260918T115924248Z.json 历史保留）；B 于 ~12:10Z 改为运行时拼接后消除，其后所有
    扫描干净（协调过程见 blockers.md DELIVERY-005）。
12. 本机为 macOS（darwin）、Python 3.9.6（CommandLineTools，无 pytest）、Node v24.21.0；
    仓库 commit af94d56（"Complete TreeAI D1 SDK and RPC validation spikes"），工作区含未提交
    改动（B 的 09-20 修复文件与三个新 run 目录；verify JSON environment/git 字段如实记录）。

## 7. 推断（非事实，需复核）

1. 两侧五场景在统一基线下全部 PASS，为 DECISION-001/002 的对照矩阵提供了同基线实测输入；
   但"哪条路线更优"的结论属于负责人决策，本报告不作倾向性推断（A 的矩阵与 ADR 草案为输入）。
2. C 的 liveCheck 与 `pi auth check` 结果背离（一个 provider 报 not_ready 却正常服务、
   另一个报 ready 却 403）说明凭据就绪性判断应以真实最小调用为准——该观察由 C 的
   证据支持（observation-copycopy-403.json），推广为一般规则属于推断。B 09-20 的经历
   （README：扩展注册的 provider 须经 createAgentSessionServices() 才可见）是该推断的
   SDK 侧佐证：模型可见性同样取决于发现路径，而非仅凭配置存在。
3. 五场景之外的能力差异（tree/session navigation、extension UI、类型安全等）以 A 的
   调研矩阵为参考输入，实测覆盖度以 B/C 证据为限。
4. 02:03 run 的 steer FAIL 是 B 检查器语义与 Pi 0.85.1 实际行为不符，修正检查器后 02:12
   全 PASS；据此推断 Pi 0.85.1 的 steer 在同一 agent run 内以新 turn 生效（单 agent_start），
   该行为以 B 的 result.json 观察为证，但属单实现单版本观察。

## 8. 未决问题

1. evidence/environment.json 与 d1-spikes/README.md 的属主仍未定义（DELIVERY-004）；
   B/C 各自的环境记录（run 内 environment.json、evidence/rpc/environment-rpc-python.json）
   无共享 schema，comparison-parity 目前按防御式解析读取。
2. `--repro` 干净复现尚未实际执行（NOT_RUN，需网络；命令与语义见第 2 节）。
3. 秘密扫描的已知边界不变：跳过 .git/node_modules/venv/缓存、二进制与 >20MB 文件；
   规则为模式匹配，无法覆盖所有私有令牌格式（声明过的盲区，非隐藏通过）。
4. residual-processes 对以相对路径启动且命令行不含 d1-spikes 路径的探针进程可能漏报；
   对 pi rpc 子进程与临时 run 目录进程必然捕获。
5. B 的 09-20 修复（createAgentSessionServices 发现路径、steer 语义检查）目前为工作区
   未提交改动；commit 与否属负责人/版本管理决策，本报告仅记录现状。

## 9. 需要负责人决定的事项

全部登记于 `reports/blockers.md`，状态 PENDING_OWNER：SDK/RPC 路线（DECISION-001）、
宿主语言（DECISION-002）、版本基线（DECISION-003）、同进程权限（DECISION-004）、
产品工具/目录权限（DECISION-005）、ADR-001 批准（DECISION-006）、D1 Go/Conditional
Go/No-Go（DECISION-007）、统一 provider/model 基线的正式确认（DECISION-008；
对照前提已满足，剩余为负责人正式记录决定）。
本报告不替负责人批准 ADR、不做最终选型、不给出 Go/No-Go。

## 10. 证据索引

- 本次验收详细运行（最终确认，本次引用）：evidence/verification/verify-20260920T021547888Z.json / .log（exit 3，PASS=25/FAIL=0/BLOCKED=0/NOT_RUN=3）
- B 重跑前的复核运行：evidence/verification/verify-20260920T014804084Z.json / .log（exit 3，PASS=19/BLOCKED=6，历史保留）
- 09-18 最终确认轮及中间轮（全部历史保留）：verify-20260918T123312170Z.json、verify-20260918T123203098Z.json、verify-20260918T122213821Z.json（均 exit 3）；verify-20260918T122033623Z.json（exit 2，schema 探针发现缺陷）；verify-20260918T115924248Z.json（exit 2，旧布局误判）；更早 NOT_RUN 各轮见 verify-history.jsonl
- 失败路径自证：evidence/verification/selftest-infra-20260920T021943Z.json（10/10）；此前 selftest-infra-20260918T123637Z.json 等各轮保留
- 秘密扫描报告：evidence/verification/secrets-scan-20260920T021547888Z-{evidence,workspace}.json
- 运行历史（追加式，12 条）：evidence/verification/verify-history.jsonl
- B 场景证据（最终 run）：evidence/sdk/runs/2026-09-20T02-12-05-667Z-6220/（含 run-summary.json、environment.json、resume/session-store/）；09-20 中间 run：runs/2026-09-20T01-50-33-164Z-97987/（全 BLOCKED）、runs/2026-09-20T02-03-27-035Z-3077/（steer FAIL）；09-18 各 run 一并保留
- C 场景证据：evidence/rpc/*.result.json、*.events.jsonl、environment-rpc-python.json、observation-copycopy-403.json、crash-probe.json
- A 调研产物：research/pi-capability-inventory.md、research/sdk-vs-rpc-matrix.md、research/adr-001-draft.md
- 共享契约：schemas/README.md、schemas/evidence-event.schema.json、schemas/scenario-result.schema.json
- 夹具与清单：fixtures/README.txt、fixtures/numbers.json、fixtures/readonly/、fixtures/MANIFEST.sha256

## 11. 可复现命令（在仓库根目录执行）

```bash
d1-spikes/scripts/verify-d1                     # 统一验收（当前 exit 3：PASS=25/FAIL=0/BLOCKED=0/NOT_RUN=3）
d1-spikes/scripts/verify-d1 --repro             # 干净复现（复制到临时目录重装重测；需网络；尚未执行）
d1-spikes/scripts/selftest-infra                # 验收门槛失败路径自证（最新 10/10）
d1-spikes/scripts/make-run-dir                  # 生成 fixtures 临时副本
d1-spikes/scripts/make-run-dir --selftest
d1-spikes/scripts/check-secrets d1-spikes       # 秘密/脱敏扫描（2026-09-20 02:17Z：234 文件 0 发现）
d1-spikes/scripts/check-secrets --selftest
d1-spikes/scripts/schema-check --selftest       # 33 例
d1-spikes/scripts/schema-check d1-spikes/schemas/scenario-result.schema.json <result-file>
cd d1-spikes/rpc-python && PYTHONPATH=src python3 -m unittest discover -s tests   # C 单测
cd d1-spikes/sdk-node && npm test                                                   # B 单测
cd d1-spikes/sdk-node && npm run probe:all                                          # B 五场景（需可用凭据）
cd d1-spikes/fixtures && shasum -a 256 -c MANIFEST.sha256
```

## 12. 声明

- 本报告未删除、未改写任何历史验收记录；09-18 的旧布局误判运行、schema 缺陷中间运行、
  BLOCKED_CREDENTIALS 各轮，以及 09-20 B 的两次中间 run（01:50 全 BLOCKED、02:03 steer FAIL）
  均按"证据只追加"原则原样保留。
- Agent D 未替负责人批准 ADR、未做 SDK/RPC 最终选型、未给出 Go/Conditional Go/No-Go，
  亦未替负责人正式记录 DECISION-008 的基线决定。
- B 的 09-18 BLOCKED_CREDENTIALS 是如实保留的诚实结果；09-20 统一基线重跑后五场景 PASS，
  两段历史并存，均未删改。
- comparison-parity 的 PASS 表示对照前提（同 Pi 版本/provider/model/thinking）已满足，
  是输入条件判定，不是路线选型结论。
