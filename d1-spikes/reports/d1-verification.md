# TreeAI D1 验收汇总（d1-verification）

- 报告产出：Agent D（独占范围：d1-spikes/fixtures/、d1-spikes/schemas/、d1-spikes/scripts/、d1-spikes/evidence/verification/、d1-spikes/reports/）
- 生成时间（UTC）：2026-09-18T12:36Z 之后，依据下列证据文件中的时间戳
- 统一验收入口：`d1-spikes/scripts/verify-d1`
- 本次引用的详细运行（最终确认）：`evidence/verification/verify-20260918T123312170Z.json`（及同名 .log；exit 3；12:33Z 于主工作区复核执行）
- 前序复核运行：`verify-20260918T123203098Z.json`（D 上一轮，12:32Z，exit 3）与 `verify-20260918T122213821Z.json`（验收器修正完成轮，12:22Z，exit 3）——三轮结果完全一致，均按证据只追加原则保留
- 运行历史（追加式，未删除/改写任何旧记录）：`evidence/verification/verify-history.jsonl`
- 本报告只汇总可验证事实与判定，不替负责人做最终选型，不给出 Go/Conditional Go/No-Go 签字（见 `reports/blockers.md` DECISION-007）。
- 版本说明：上一版报告依据 verify-20260918T105726571Z（彼时 B/C/A 均未交付）；其后 A、B、C 均已交付，验收器完成三项修正（见第 0 节），修正过程与中间运行（含一次被 schema 探针正确揪出的 schema 缺陷）全部保留在 verify-history.jsonl 中。修正完成后 12:22Z、12:32Z、12:33Z 三轮运行结果完全一致（PASS=19、FAIL=0、BLOCKED=6、NOT_RUN=3，exit 3）。本版为最终收尾的一致性更新：仅把引用运行、扫描计数、历史条数与证据索引对齐至最新最终确认运行（12:33Z），未改动任何判定、历史证据或 PENDING_OWNER 事项。

## 0. 验收器修正（Agent D，scripts/ 与 schemas/ 内；12:22Z 轮完成，其后复核未再改动）

1. **支持并严格校验 sdk-node 的追加式 runs 证据布局**。Agent B 的证据实际位于
   `evidence/sdk/runs/<run-id>/<scenario>/{result.json,events.jsonl}`，而旧验收器只查扁平
   `evidence/sdk/<scenario>.result.json`，导致 11:59Z 的运行把 5 个 SDK 场景误判为 FAIL
   （verify-20260918T115924248Z.json，历史保留）。新规则（schemas/README.md 第二节）：
   某场景若存在扁平文件则以扁平为准；否则选用 runs/ 下**最新的完整 run**（五场景
   result.json 齐备）；run 内结果引用的 evidenceFiles 必须仍位于同一 run 目录，
   **跨 run 引用判 FAIL**；runs/ 存在但无完整 run 时按交付不完整判 FAIL。
   本次选定 run：`2026-09-18T11-57-46-510Z-5120`（3 个 run 中最新完整者；
   `2026-09-18T11-09-33-297Z-78785` 亦完整但更旧；`2026-09-18T11-07-09-207Z-77525`
   不完整（缺 steer/abort/resume 的 result.json），未使用、未混拼）。
2. **rpc-python 单元测试改为 pytest 优先、stdlib unittest 兜底**。Agent C 的测试使用标准库
   unittest；本机无 pytest 时旧验收器误记 BLOCKED。新逻辑：pytest 可导入则运行 pytest，
   否则运行 `PYTHONPATH=src python -m unittest discover -s tests`（与 rpc-python/
   requirements.txt 记载的命令一致）；两者均不可用才 BLOCKED；失败仍保持 FAIL/非零退出语义。
3. **新增 comparison-parity 检查**：两实现须满足任务书第 5 节"同一 Pi 版本、同一模型、
   同一 thinking"的公平对照前提，否则判 BLOCKED 并指向 PENDING_OWNER（DECISION-008）。
   另：BLOCKED 场景结果现在也要求证据可追溯（任务书 §0.6、§14），schema 对
   BLOCKED_CREDENTIALS 的两种编码做了公开修订（见第 3 节）。

## 1. 总体状态

| 区域 | 状态 | 依据 |
|---|---|---|
| Agent D 静态基础设施（fixtures/schemas/scripts/扫描/验收门槛） | PASS | verify-20260918T123312170Z.json checks 1–5 |
| Agent A（research/：能力清单/矩阵/ADR 草案） | 已交付；ADR 状态 Proposed（未批准） | research/pi-capability-inventory.md（423 行）、research/sdk-vs-rpc-matrix.md（226 行）、research/adr-001-draft.md（188 行，状态行："Proposed（草案，未批准）"） |
| Agent B（sdk-node/ + evidence/sdk/runs/） | 已交付；五场景 BLOCKED_CREDENTIALS | checks 6/8/12–16；evidence/sdk/runs/2026-09-18T11-57-46-510Z-5120/ |
| Agent C（rpc-python/ + evidence/rpc/） | 已交付；五场景 PASS | checks 7/9/17–21；evidence/rpc/*.result.json |
| SDK/RPC 对照公平性 | BLOCKED（provider/model 不一致） | check 22；DECISION-008 |
| 整体验收退出码 | 3 = INCOMPLETE（无 FAIL，存在 BLOCKED/NOT_RUN） | verify-20260918T123312170Z.json overall；verify-history.jsonl 第 10 条（最终确认轮） |

**counts：PASS=19、FAIL=0、BLOCKED=6、NOT_RUN=3，exit 3。** 没有任何 FAIL；不完整来自
6 个 BLOCKED（5 个 SDK 场景 BLOCKED_CREDENTIALS + 1 个 comparison-parity）与 3 个
NOT_RUN（2 个 --repro 未请求 + 1 个 evidence/environment.json 缺失）。

## 2. 验收入口与退出码约定（不变）

命令：`d1-spikes/scripts/verify-d1`（干净复现模式：`--repro`）。

| 退出码 | 含义 |
|---|---|
| 0 | 全部检查 PASS |
| 2 | 至少一项 FAIL（缺文件/schema 违规/泄密/退出码不可信/残留进程等） |
| 3 | 无 FAIL 但存在 BLOCKED 或 NOT_RUN（交付不完整，当前状态） |
| 1 | 验收工具自身错误 |

每次运行产出 `verify-<时间戳>.json`/`.log` 与两份 `secrets-scan-<时间戳>-{evidence,workspace}.json`，
并向 `verify-history.jsonl` 追加一行；证据只追加，不改写历史（当前共 10 条，最早
10:48:57Z）。写盘后对本次产物做泄露自扫，发现泄密强制改判 exit 2。

**--repro 干净复现说明（保持有效）**：`d1-spikes/scripts/verify-d1 --repro` 会把已交付的
sdk-node/ 或 rpc-python/ 复制到系统临时目录（排除 node_modules/venv 等派生产物），
执行 `npm ci` + `npm test`（sdk-node）或 `pip install -r requirements.txt` + 单元测试
（rpc-python；pytest 优先，缺失时 `PYTHONPATH=src python -m unittest discover -s tests`），
日志写入 `evidence/verification/repro-<时间戳>-<实现>.log`。该模式需要网络；本次运行
未请求，两行如实记 NOT_RUN，未伪造执行。

## 3. 检查明细（28 项，与 verify-20260918T123312170Z.json 一一对应）

| # | 检查项 | 状态 | 说明/证据 |
|---|---|---|---|
| 1 | fixtures-integrity | PASS | 5 个 fixture 文件对 MANIFEST.sha256 校验通过 |
| 2 | schemas-valid | PASS | 两个 schema 可解析；14 个正/反例探针按预期接受/拒绝（含 BLOCKED_CREDENTIALS 两种编码的正反例） |
| 3 | schema-validator-selftest | PASS | schema-check 自检 33 例通过 |
| 4 | secrets-scanner-selftest | PASS | 23 条规则全部命中合成语料、干净语料零误报、报告脱敏 |
| 5 | run-dir-generator-selftest | PASS | make-run-dir 自检通过 |
| 6 | deps-repro-sdk-node | PASS | package.json + package-lock.json 在位（Pi 依赖精确锁 0.85.1） |
| 7 | deps-repro-rpc-python | PASS | requirements.txt 全部 `==` 锁定（实为零第三方依赖） |
| 8 | unit-tests-sdk-node | PASS | npm test 退出 0 |
| 9 | unit-tests-rpc-python | PASS | stdlib unittest 通过（runner：`PYTHONPATH=src python3 -m unittest discover -s tests`；本机 /usr/bin/python3 无 pytest） |
| 10 | repro-sdk-node | NOT_RUN | 未请求 --repro；命令已登记 |
| 11 | repro-rpc-python | NOT_RUN | 同上 |
| 12–16 | scenario-sdk-node-{basic,tool,steer,abort,resume} | BLOCKED | blockedReason=BLOCKED_CREDENTIALS；403 Access denied；证据存在且通过 schema/seq/implementation/scenario 校验；source: runs/2026-09-18T11-57-46-510Z-5120 |
| 17–21 | scenario-rpc-python-{basic,tool,steer,abort,resume} | PASS | exitCode=0、evidenceFiles 存在、事件 schema 合法且 seq 严格递增；source: 扁平布局 evidence/rpc/ |
| 22 | comparison-parity | BLOCKED | provider：sdk=tal-token-plan-copy-copy vs rpc=tal-token-plan-06c64a09；model：claude-fable-5 vs deepseek-v4.1-flash（pi 0.85.1 与 thinking=off 一致）；对照不可直接比较，统一基线 PENDING_OWNER（DECISION-008） |
| 23 | evidence-environment | NOT_RUN | evidence/environment.json 不存在；属主未定（DELIVERY-004）。B 每个 run 目录内有 environment.json，C 有 evidence/rpc/environment-rpc-python.json，均无共享 schema |
| 24 | schema-validation | PASS | 10 个结果文件全部通过共享 schema（CLI 逐文件复核亦 10/10 VALID） |
| 25 | redaction-evidence | PASS | evidence/ 树 93 文件零发现（运行时点计数，不含该运行自身随后写盘的产物） |
| 26 | redaction-workspace | PASS | evidence/ 以外 80 文件零发现 |
| 27 | exit-codes | PASS | 10 个结果文件：PASS 退出码为 0，FAIL 非零（BLOCKED 场景退出码=2，一并留档） |
| 28 | residual-processes | PASS | 无本工作区相关残留进程 |

## 4. 五场景结果矩阵

| 场景 | sdk-node（Agent B） | rpc-python（Agent C） |
|---|---|---|
| basic | BLOCKED（BLOCKED_CREDENTIALS，403） | PASS |
| tool | BLOCKED（BLOCKED_CREDENTIALS，403） | PASS |
| steer | BLOCKED（BLOCKED_CREDENTIALS，403） | PASS |
| abort | BLOCKED（BLOCKED_CREDENTIALS，403） | PASS |
| resume | BLOCKED（BLOCKED_CREDENTIALS，phase A 子进程被阻） | PASS |

- B 侧证据：`evidence/sdk/runs/2026-09-18T11-57-46-510Z-5120/<scenario>/{result.json,events.jsonl}`；
  model=tal-token-plan-copy-copy/claude-fable-5（thinking=off，source=first-available），
  Pi 包 0.85.1，Node v24.21.0，exitCode=2。B 的 README 声明：提供凭据后重跑
  `npm run probe:all` 即可得到真实结果（诚实结果，非缺陷）。
- C 侧证据：`evidence/rpc/<scenario>.{result.json,events.jsonl}`；
  provider=tal-token-plan-06c64a09、model=deepseek-v4.1-flash、thinking=off，
  pi 0.85.1，python 3.9.6，exitCode=0，每场景含子进程退出码记录。
- **两侧 provider/model 不一致 → 五场景结果不可直接对照**（任务书 §5 前提未满足；
  check 22 BLOCKED；DECISION-008）。另注意 C 的 environment-rpc-python.json 记录了
  `pi auth check` 返回 not_ready 但 liveCheck 正常、而 B 的 provider 报 ready 却 403 的
  观察（`evidence/rpc/observation-copycopy-403.json`）。

PASS 的追溯要求（脚本强制）：exitCode=0、evidenceFiles 存在、至少一个 .jsonl 事件文件、
每行符合 evidence-event schema、seq 从 1 起严格递增、事件 implementation/scenario 与
文件位置一致；runs 布局下另加单 run 约束（跨 run 引用判 FAIL）。BLOCKED 亦须引用存在
且合法的证据（任务书 §0.6：任何结论必须附带证据路径）。FAIL 必须非零退出码且 error
非 null（schema 强制）。

### schema 修订记录（公开，非静默）

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

证据：`evidence/verification/selftest-infra-20260918T123637Z.json`（10/10 断言通过；
此前各轮记录——含更早的失败记录——按追加原则保留，未删不改）。另对 runs 布局的单 run
约束做了对抗性验证：跨 run
引用、扁平结果引用 run 内文件均被正确判 FAIL（同 run 引用无问题）。

## 6. 已确认事实（每条附证据）

1. 五个确定性 fixture 文件与 MANIFEST.sha256 一致（verify-20260918T123312170Z.json check 1）。
2. 两个共享 schema 通过 14 个正反例探针，含 BLOCKED 两种编码与 `error:null` 边界（check 2）。
3. sdk-node 交付完整：package.json + package-lock.json（Pi 0.85.1 精确锁）+ npm test 退出 0（checks 6、8）。
4. rpc-python 交付完整：requirements.txt 全 `==` 锁定（零第三方依赖）+ stdlib unittest 通过（checks 7、9）。
5. Agent B 五场景结果均为 BLOCKED + BLOCKED_CREDENTIALS（403 Access denied），证据文件存在且通过 schema/seq/字段一致性校验（checks 12–16；runs/2026-09-18T11-57-46-510Z-5120/）。
6. Agent C 五场景结果均为 PASS、exitCode=0、事件可追溯且 schema 合法（checks 17–21；evidence/rpc/）。
7. 两实现 Pi 版本一致（0.85.1，npm 全局 CLI 与 sdk-node 依赖均为 0.85.1）、thinking 一致（off），但 provider/model 不一致（check 22）。
8. 全部 d1-spikes（报告更新时 178 文件，含两套脱敏原始事件与全部验收产物）秘密/脱敏扫描零发现（check 25/26：运行时点 evidence/ 93 + 其余 80；`check-secrets d1-spikes` 复核 exit 0）。
9. 无残留探针进程（check 28）。
10. A 已交付 research/ 三件：pi-capability-inventory.md、sdk-vs-rpc-matrix.md、adr-001-draft.md（状态 Proposed，未批准）。
11. B 曾在 sdk-node/tests 中遗留 13 处合成秘密样式字符串（11:59Z 运行 redaction-workspace FAIL，verify-20260918T115924248Z.json 历史保留）；B 于 ~12:10Z 改为运行时拼接后消除，12:20Z 起扫描干净（协调过程见 blockers.md DELIVERY-005）。
12. 本机为 macOS（darwin）、Python 3.9.6（/usr/bin/python3，无 pytest）、Node v24.21.0；仓库 commit 334f4fd，工作区含未提交改动（verify-…json environment/git 字段）。

## 7. 推断（非事实，需复核）

1. 若负责人为两实现统一 provider/model 且 B 获得可用凭据，B 重跑 `npm run probe:all` 后
   comparison-parity 与五场景有望转为可判定（依据：C 在 tal-token-plan-06c64a09 上全部
   PASS；B 的失败全部归类为 403 BLOCKED_CREDENTIALS，非能力性失败）。此为推断，
   非结论。
2. C 的 liveCheck 与 `pi auth check` 结果背离（一个 provider 报 not_ready 却正常服务、
   另一个报 ready 却 403）说明凭据就绪性判断应以真实最小 RPC 调用为准——该观察由 C 的
   证据支持，推广为一般规则属于推断。
3. 五场景之外的能力差异（tree/session navigation、extension UI、类型安全等）以 A 的
   调研矩阵为参考输入，实测覆盖度以 B/C 证据为限。

## 8. 未决问题

1. evidence/environment.json 与 d1-spikes/README.md 的属主仍未定义（DELIVERY-004）；
   B/C 各自的环境记录（run 内 environment.json、evidence/rpc/environment-rpc-python.json）
   无共享 schema，comparison-parity 目前按防御式解析读取。
2. D1 对照实验的统一 provider/model 基线（DECISION-008）：B=copy-copy/claude-fable-5
   （403）、C=06c64a09/deepseek-v4.1-flash（可用）。
3. B 的 BLOCKED_CREDENTIALS：需负责人提供/授权可用凭据后重跑（任务书 §14）。
4. 秘密扫描的已知边界不变：跳过 .git/node_modules/venv/缓存、二进制与 >20MB 文件；
   规则为模式匹配，无法覆盖所有私有令牌格式（声明过的盲区，非隐藏通过）。
5. residual-processes 对以相对路径启动且命令行不含 d1-spikes 路径的探针进程可能漏报；
   对 pi rpc 子进程与临时 run 目录进程必然捕获。
6. `--repro` 干净复现尚未实际执行（NOT_RUN，需网络；命令与语义见第 2 节）。

## 9. 需要负责人决定的事项

全部登记于 `reports/blockers.md`，状态 PENDING_OWNER：SDK/RPC 路线（DECISION-001）、
宿主语言（DECISION-002）、版本基线（DECISION-003）、同进程权限（DECISION-004）、
产品工具/目录权限（DECISION-005）、ADR-001 批准（DECISION-006）、D1 Go/Conditional
Go/No-Go（DECISION-007）、**D1 对照统一 provider/model 基线（DECISION-008，本轮新增）**。
本报告不替负责人批准 ADR、不做最终选型、不给出 Go/No-Go。

## 10. 证据索引

- 本次验收详细运行（最终确认，本次引用）：evidence/verification/verify-20260918T123312170Z.json / .log（exit 3，PASS=19/FAIL=0/BLOCKED=6/NOT_RUN=3）
- D 上一轮复核运行：evidence/verification/verify-20260918T123203098Z.json / .log（exit 3，结果与最终确认一致，历史保留）
- 验收器修正完成轮运行：evidence/verification/verify-20260918T122213821Z.json / .log（exit 3，历史保留）
- 中间运行（schema 探针发现缺陷）：evidence/verification/verify-20260918T122033623Z.json / .log（exit 2，历史保留）
- 11:59Z 旧布局误判运行：evidence/verification/verify-20260918T115924248Z.json / .log（历史保留，不删不改）
- 失败路径自证：evidence/verification/selftest-infra-20260918T123637Z.json（10/10）
- 秘密扫描报告：evidence/verification/secrets-scan-20260918T123312170Z-{evidence,workspace}.json
- 运行历史（追加式，10 条）：evidence/verification/verify-history.jsonl
- B 场景证据：evidence/sdk/runs/2026-09-18T11-57-46-510Z-5120/（含 run-summary.json、environment.json；更早 run 一并保留）
- C 场景证据：evidence/rpc/*.result.json、*.events.jsonl、environment-rpc-python.json、observation-copycopy-403.json、crash-probe.json
- A 调研产物：research/pi-capability-inventory.md、research/sdk-vs-rpc-matrix.md、research/adr-001-draft.md
- 共享契约：schemas/README.md、schemas/evidence-event.schema.json、schemas/scenario-result.schema.json
- 夹具与清单：fixtures/README.txt、fixtures/numbers.json、fixtures/readonly/、fixtures/MANIFEST.sha256

## 11. 可复现命令（在仓库根目录执行）

```bash
d1-spikes/scripts/verify-d1                     # 统一验收（当前 exit 3）
d1-spikes/scripts/verify-d1 --repro             # 干净复现（复制到临时目录重装重测；需网络）
d1-spikes/scripts/selftest-infra                # 验收门槛失败路径自证
d1-spikes/scripts/make-run-dir                  # 生成 fixtures 临时副本
d1-spikes/scripts/make-run-dir --selftest
d1-spikes/scripts/check-secrets d1-spikes       # 秘密/脱敏扫描（报告更新时 178 文件 0 发现）
d1-spikes/scripts/check-secrets --selftest
d1-spikes/scripts/schema-check --selftest       # 33 例
d1-spikes/scripts/schema-check d1-spikes/schemas/scenario-result.schema.json <result-file>
cd d1-spikes/rpc-python && PYTHONPATH=src python3 -m unittest discover -s tests   # C 单测
cd d1-spikes/fixtures && shasum -a 256 -c MANIFEST.sha256
```

## 12. 声明

- 本报告未删除、未改写任何历史验收记录；11:59Z 的旧布局误判运行与 12:20Z 的中间失败
  运行均按"证据只追加"原则原样保留。
- Agent D 未替负责人批准 ADR、未做 SDK/RPC 最终选型、未给出 Go/Conditional Go/No-Go。
- B 的 BLOCKED_CREDENTIALS 是如实保留的诚实结果，不是缺陷；提供凭据后重跑即可。
- comparison-parity 的 BLOCKED 表示对照前提未满足，不代表任一实现的证据无效。
