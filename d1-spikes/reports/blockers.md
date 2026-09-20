# TreeAI D1 阻塞与待决事项（blockers）

- 维护：Agent D。本文件是汇总登记处；引用他人证据时只读，不修改原始证据。
- 状态标记：`PENDING_OWNER` = 必须由负责人决定，任何 Agent 不得自行定案（任务书第 13 节）。
- 交付阻塞（A 节）不是负责人决策，但阻塞 D1 完成；负责人决策见 B 节。
- 2026-09-20 更新：B 以统一基线重跑后 SDK 五场景 PASS、comparison-parity PASS；验收现状
  exit 3（PASS=25/FAIL=0/BLOCKED=0/NOT_RUN=3，verify-20260920T021547888Z.json）。剩余
  NOT_RUN 仅 --repro 两项与共享 evidence/environment.json。全部 PENDING_OWNER 决定项保持
  待决，Agent D 不代填任何决定。
- 2026-09-20 收口跟进（Agent D）：验收器两个缺口已修复（BLOCKED/NOT_RUN 退出码保留、
  post-write 扫描改判时 summary 同步；schema 修订 2026-09-20；selftest-infra 20/20 含
  T6/T7 回归）；**--repro 干净复现已执行，双侧 PASS**（DELIVERY-006 解除）；最新验收
  exit 3（**PASS=27/FAIL=0/BLOCKED=0/NOT_RUN=1**，verify-20260920T032122324Z.json，
  唯一 NOT_RUN 为共享 evidence/environment.json，DELIVERY-004）；B/C 在收口窗口交付
  tree-navigation 证据（双侧 PASS）但在共享契约枚举之外、未经统一验收
  （DELIVERY-007 / DECISION-009）。全部 PENDING_OWNER 保持待决。
- **2026-09-20 最终收口（Agent D）**：集成人补齐 `d1-spikes/README.md` 与
  `evidence/environment.json`（03:43Z，**DELIVERY-004 关闭**）；最终
  `verify-d1 --repro`（03:45:14Z，verify-20260920T034514083Z.json）**28/28 检查全
  PASS、exit 0（ALL_PASS，验收运行史 16 条中首个）**：五场景双侧 PASS、
  comparison-parity PASS、evidence-environment PASS、--repro 双侧 PASS。同轮配套：
  check-secrets 独立复扫零发现（279 文件；发布时点 04:06:33Z 全工作区 280 文件
  亦零发现，secrets-scan-20260920T040633Z-full-workspace.json）、selftest-infra
  20/20（03:49Z）、schema-check --selftest 33 例。验收层面已无任何
  FAIL/BLOCKED/NOT_RUN；**全部 PENDING_OWNER 决定项保持待决**（含 DECISION-009
  tree-nav 契约扩展、DECISION-006 ADR 批准、DECISION-007 Go/No-Go、
  DECISION-008 基线正式确认）。秘密扫描发布时点（04:06:33Z 280 文件、04:08:16Z
  定稿确认 281 文件）全工作区零发现（secrets-scan-20260920T040633Z-full-workspace.json、
  secrets-scan-20260920T040816Z-full-workspace.json）。

## A. 交付阻塞（非决策项）

| 编号 | 事项 | 状态 | 影响 | 相关证据 |
|---|---|---|---|---|
| DELIVERY-001 | Agent B 交付 sdk-node/ 与 evidence/sdk/ | 已交付；2026-09-20 统一基线重跑后五场景 PASS（历史行保留：09-18 曾为 BLOCKED_CREDENTIALS） | 曾致 16 项 NOT_RUN；09-18 五场景 BLOCKED_CREDENTIALS；09-20 以 tal-token-plan-06c64a09/deepseek-v4.1-flash/thinking=off 重跑后五场景 PASS（exitCode=0） | evidence/verification/verify-20260920T021547888Z.json checks 6/8/12–16；evidence/sdk/runs/2026-09-20T02-12-05-667Z-6220/（最终）；runs/2026-09-20T01-50-33-164Z-97987/、runs/2026-09-20T02-03-27-035Z-3077/（中间 run，保留）；09-18 BLOCKED 各 run 保留 |
| DELIVERY-002 | Agent C 交付 rpc-python/ 与 evidence/rpc/ | 已交付（2026-09-18，历史行保留） | 曾致 RPC 侧无数据；现五场景 PASS、单测（stdlib unittest）PASS，09-20 复验仍 PASS | verify-20260920T021547888Z.json checks 7/9/17–21；evidence/rpc/*.result.json |
| DELIVERY-003 | Agent A 交付 research/（能力清单、矩阵、ADR 草案） | 已交付（2026-09-18，历史行保留） | DECISION-001/002 现有证据输入；ADR 草案状态 Proposed（未批准） | research/pi-capability-inventory.md、research/sdk-vs-rpc-matrix.md、research/adr-001-draft.md |
| DELIVERY-004 | d1-spikes/README.md 与 evidence/environment.json 的属主未定义 | **已解决（2026-09-20 03:43Z 集成人补齐；历史行保留：曾为唯一剩余 NOT_RUN）** | 曾致 evidence-environment 检查 NOT_RUN（03:43Z 前各轮）。集成人补齐后：environment.json 为有效 JSON（含 pi/comparisonBaseline/runtime/packageManagers/implementations/evidenceSources/credentialPolicy），03:43:34Z 默认模式轮即转 PASS，03:45:14Z 最终收口轮复核 PASS（check 23）；README 覆盖目录索引/固定基线/可复现命令/证据规则/待决事项。遗留跟进（非阻塞）：共享环境记录尚无强制 schema，B/C 各自环境记录仍无共享 schema，comparison-parity 仍防御式解析 | evidence/environment.json；d1-spikes/README.md；verify-20260920T034334578Z.json check 23；verify-20260920T034514083Z.json check 23（PASS）；字段登记与实际交付对照见 reports/d1-verification.md 第 8a 节 |
| DELIVERY-005 | sdk-node/tests 合成脱敏语料曾触发秘密扫描 13 处发现 | 已解决（2026-09-18 ~12:10Z，历史行保留） | 曾致 redaction-workspace FAIL（11:59Z 运行）；Agent B 将合成令牌改为运行时拼接后，此后所有轮次（含 09-20）全工作区扫描零发现。D 未修改 B 的文件；selftest-infra 在临时副本中作测试隔离 | verify-20260918T115924248Z.json（FAIL 历史）；verify-20260920T021547888Z.json check 26（PASS，80 文件零发现）；check-secrets d1-spikes 2026-09-20 02:17Z 复扫 234 文件零发现；收口后 03:22:59Z 264 文件、03:33:45Z 265 文件（含 B/C tree-nav 新证据与全部收口产物）均零发现 |
| DELIVERY-006 | --repro 干净复现 | **已执行（2026-09-20 收口，双侧 PASS；03:45:14Z 最终收口轮复核双侧 PASS；历史行保留：收口前未执行）** | 收口前 checks 10/11 如实记 NOT_RUN。2026-09-20 03:21Z 收口运行中 --repro 首次实际执行：sdk-node 侧干净临时目录 npm ci 退出 0 + npm test 80/80；rpc-python 侧 pip install 退出 0 + stdlib unittest 65/65；checks 10/11 转 PASS。03:45:14Z 最终收口轮（verify-20260920T034514083Z.json）复核双侧 PASS 且 28/28 全 PASS（exit 0）。中间轮（03:12Z）rpc 侧曾 FAIL（C 进行中 tree-nav 代码缺陷，堆栈留档），C 修复后复跑 PASS，各轮均保留 | verify-20260920T034514083Z.json checks 10/11（PASS，ALL_PASS）；repro-20260920T034514083Z-{sdk-node,rpc-python}.log；历史：verify-20260920T032122324Z.json checks 10/11（首次执行 PASS）、verify-20260920T021547888Z.json checks 10/11（NOT_RUN）、repro-20260920T031204255Z-rpc-python.log（中间轮 FAIL，保留） |
| DELIVERY-007 | tree-navigation（第六场景）证据已交付但未经统一验收 | 已交付、待后续验收（2026-09-20 收口窗口） | 不属于 D1 五统一场景（任务书第 7 节），verify-d1 的 28 项检查不覆盖。B 交付 PASS run（evidence/sdk/tree-nav/runs/2026-09-20T02-59-39-706Z-27995/，navigateTree 同 session 移动叶指针、上下文按目标分支重建）；C 交付补充探针（evidence/rpc/tree-navigation.{result.jsonl,events.jsonl}，PASS，关键发现：RPC 无 navigate_tree/navigateTree 命令，以 fork/switch_session/clone 组合达成）。两侧证据的 scenario 值均在共享 schema 枚举外（双方各自在 limitations 声明），当前契约下 schema-check 判 INVALID；是否扩展契约见 DECISION-009；扩展后的统一验收（含 C 的 .result.jsonl 命名）为跟进项 | reports/d1-verification.md 第 4b 节（事实摘录）；B/C 上述证据路径；schema-check 复核记录（唯一违规点为 scenario 枚举） |

## B. 负责人决定事项

## DECISION-001

- 状态：PENDING_OWNER
- 需要决定：TreeAI 首版最终采用 Pi SDK 直嵌（同进程）还是 Pi RPC 子进程路线。
- 为什么阻塞正式方案：这是 D1 的核心问题；决定后才能冻结运行时架构、进程边界、事件接入层与错误传播设计，所有正式工程依赖于此。
- 当前已完成工作：共享证据契约与五场景判定标准（schemas/、fixtures/README.txt）；统一验收入口已用同一输入与同一判定验收两条路线（scripts/verify-d1）；A 的能力矩阵与 ADR 草案已交付（research/，ADR 状态 Proposed）。**2026-09-20 起两条路线均有统一基线（tal-token-plan-06c64a09/deepseek-v4.1-flash/thinking=off，pi 0.85.1）下的五场景 PASS 实测**，对照矩阵的实测输入已齐备；**收口时 --repro 干净复现双侧 PASS**（锁定依赖可在干净目录重装并通过全部单测，命令可第三方重放）。
- 可选项：Node.js/TypeScript + Pi SDK；Node.js/TypeScript + Pi RPC；Python + Pi RPC。
- 各选项证据：research/sdk-vs-rpc-matrix.md、research/adr-001-draft.md（A 交付）；evidence/rpc/（C 五场景 PASS，Pi 0.85.1）；evidence/sdk/runs/2026-09-20T02-12-05-667Z-6220/（B 五场景 PASS，适配代码 302 行/2 文件、探针骨架 1836 行/17 文件，Pi 0.85.1）。provider/model/thinking/Pi 版本已一致（verify-20260920T034514083Z.json check 22 PASS），对照前提满足；--repro 干净复现双侧 PASS（同文件 checks 10/11；repro-20260920T034514083Z-{sdk-node,rpc-python}.log；历史轮 032122324Z 保留）。
- 建议最晚决定时间：负责人完成 ADR 批准（DECISION-006）与 D1 复现/审查后、正式工程启动前。

## DECISION-002

- 状态：PENDING_OWNER
- 需要决定：宿主语言最终选型（TypeScript/Node.js、Python 或其他）。
- 为什么阻塞正式方案：决定代码库、招聘/维护栈、类型体系与 Pi 官方支持面的对齐方式；更换成本随代码量增长。
- 当前已完成工作：验收基础设施语言中立（fixture/schema/扫描/验收不依赖宿主语言）；B/C 探针目录契约已就绪并均按约交付（sdk-node/TypeScript、rpc-python/Python，均含 README/测试/锁定依赖），且两侧均已产出统一基线下的五场景 PASS 证据。
- 可选项：TypeScript/Node.js（可直嵌 SDK 或走 RPC）；Python（仅 RPC 路线，按当前任务书范围）；其他语言（需重新立项验证）。
- 各选项证据：research/sdk-vs-rpc-matrix.md 与 research/adr-001-draft.md（A 交付，含各候选收益/风险/不可逆成本/退出方案）；evidence/sdk/runs/2026-09-20T02-12-05-667Z-6220/ 与 evidence/rpc/ 的同基线实测记录。
- 建议最晚决定时间：与 DECISION-001 同批。

## DECISION-003

- 状态：PENDING_OWNER
- 需要决定：正式版本基线：Node、Python、包管理器与 Pi 精确版本。
- 为什么阻塞正式方案：D1 要求 SDK 与 RPC 用同一 Pi 精确版本对照（禁止 latest/*）；正式工程需锁版本基线才能保证可重复安装与升级策略。
- 当前已完成工作：验收已强制锁定要求——sdk-node 需 lockfile、rpc-python 需全量 `==` 锁定或 pyproject+lock，缺失判 FAIL（scripts/verify-d1 deps-repro 检查）；**干净复现已实现并于 2026-09-20 收口实际执行，双侧 PASS**（sdk-node 干净目录 npm ci + npm test 80/80；rpc-python pip install + stdlib unittest 65/65；03:45:14Z 最终收口轮复核双侧 PASS）。两侧实测均锁定 Pi 0.85.1（sdk-node package.json 依赖与全局 CLI 一致；rpc-python environment-rpc-python.json 记录 0.85.1；09-20 重跑后两侧版本一致性由 check 22 复核）。
- 可选项：A 已核对当前 registry 实际可用精确版本（research/pi-capability-inventory.md），负责人据此定基线。
- 各选项证据：research/pi-capability-inventory.md（本机 pi 0.85.1 与 npm latest 一致、Node v24.21.0 满足 >=22.19.0）；verify-20260920T021547888Z.json checks 6/7；B/C 环境记录。本机环境仅作参考，不构成基线。
- 建议最晚决定时间：正式工程依赖安装前（D1 对照实验已在 0.85.1 上完成，不阻塞 D1 结论本身）。

## DECISION-004

- 状态：PENDING_OWNER
- 需要决定：是否接受 SDK 直嵌带来的同进程权限风险（Pi 与宿主同权限、同生命周期、故障域合并）。
- 为什么阻塞正式方案：这是 SDK 路线相对 RPC 路线的核心风险差异；不接受则 SDK 路线出局，DECISION-001 的选项集随之变化。
- 当前已完成工作：验收侧已建立最小权限验证手段——tool 场景固定只读 fixture、临时副本强制 readonly/ 只读、任何对授权范围的写出会被秘密扫描与验收捕捉。A 的 process isolation 分析已交付（research/pi-capability-inventory.md）；**B 的 abort/资源清理实测已获得真实流式数据**（2026-09-20 统一基线 run：abort 发生于流中 1 个 delta 后、abort() 19ms 内收口、prompt promise 中止后 settle、session.isStreaming=false——见 evidence/sdk/runs/2026-09-20T02-12-05-667Z-6220/abort/result.json observations；09-18 仅在 403 之后收口的观察一并保留）。
- 可选项：接受（以工具白名单+只读沙盒缓解）；不接受（限 RPC 路线）；条件接受（定义接受的边界并写入 ADR）。
- 各选项证据：research/pi-capability-inventory.md（进程隔离分析）；evidence/rpc/（RPC 侧隔离与子进程退出码实测：pi 子进程退出码 [0]/[0,0]，crash-probe.json）；evidence/sdk/runs/2026-09-20T02-12-05-667Z-6220/（SDK 侧五场景真实流式实测）。
- 建议最晚决定时间：DECISION-001 之前或同时（它是其前置风险判断）。

## DECISION-005

- 状态：PENDING_OWNER
- 需要决定：真实产品中允许 Agent 使用的工具集合与目录读写权限范围。
- 为什么阻塞正式方案：D1 的 tool 场景只验证"最小只读 fixture"这一最低安全线；产品权限模型（哪些目录可读/写、是否允许 shell）是正式架构的一部分，超出 D1 范围，负责人未确认前不得由探针擅自扩大。
- 当前已完成工作：D1 内工具白名单最小化已固化为 fixture 契约（fixtures/README.txt 二、四节；readonly/ 只读强制）；验收对越界写有检出能力（selftest-infra T1）；B/C 的 tool 场景均已在真实调用中通过（read 工具、isError=false，09-20 run 亦有 SDK 侧实测）。
- 可选项：待负责人定义（例如：仅读固定输入目录；读+限写工作目录；允许白名单 shell 等）。
- 各选项证据：无正式产品权限证据；D1 仅证明最小只读形态可验证。
- 建议最晚决定时间：正式工程工具层设计前。

## DECISION-006

- 状态：PENDING_OWNER
- 需要决定：是否批准 ADR-001（Pi 接入路线架构决策）。
- 为什么阻塞正式方案：ADR 批准是 D1 结论进入正式架构的关口；任务书明确草案只能保持 Proposed，Agent 不得代批。
- 当前已完成工作：Agent A 已交付 adr-001-draft.md（状态 Proposed，三候选保留：Node+SDK、Node+RPC、Python+RPC，各含收益/风险/不可逆成本/退出方案）；Agent D 已核验其引用证据的可追溯链路可用（schema+verify）。**2026-09-20 起对照实验输入已齐备：SDK/RPC 五场景在统一基线下均 PASS，--repro 干净复现双侧 PASS（03:45:14Z 最终收口轮 28/28 全 PASS、exit 0：check 22 parity PASS、checks 10/11 PASS、evidence-environment PASS）**；交付阻塞（DELIVERY-001 至 007）已全部关闭。
- 可选项：批准；有条件批准（列条件）；驳回并要求补充证据。
- 各选项证据：research/adr-001-draft.md 及其引用的 research/ 清单/矩阵；verify-20260920T034514083Z.json（**ALL_PASS exit 0**：SDK/RPC 五场景 PASS、parity PASS、--repro 双侧 PASS、evidence-environment PASS）。
- 建议最晚决定时间：D1 复现与审查完成后（--repro 已执行；共享 environment.json 已由集成人补齐并通过检查）。

## DECISION-007

- 状态：PENDING_OWNER
- 需要决定：D1 最终结论：Go / Conditional Go / No Go。
- 为什么阻塞正式方案：这是 D1 阶段的正式出口；在负责人完成真实环境复现、权限审查、ADR 批准与签字前，D1 不能宣告结束（任务书第 16 节）。
- 当前已完成工作：验收机器已就绪并自证（统一入口、退出码语义、失败路径必 FAIL、证据只追加；selftest-infra 最新 20/20，含 2026-09-20 收口新增的 T6/T7 缺口回归测试，03:49Z 复验仍 20/20）；A/B/C 均已交付，集成人已补齐共享 README/environment.json；**当前最终验收 exit 0（ALL_PASS，PASS=28、FAIL=0、BLOCKED=0、NOT_RUN=0，verify-20260920T034514083Z.json——验收运行史 16 条中首个）**：两侧五场景在统一基线下均 PASS、comparison-parity PASS、evidence-environment PASS、--repro 干净复现双侧 PASS；验收器收口缺口（BLOCKED/NOT_RUN 退出码保留、post-write 改判同步）已修复并有回归测试覆盖。Agent D 不给出任何倾向性签字。
- 可选项：Go（全部场景两实现 PASS 且复现一致）；Conditional Go（列明条件与截止）；No Go（记录致命失败证据）。
- 各选项证据：evidence/verification/verify-20260920T034514083Z.json（**exit 0 ALL_PASS**：SDK 五场景 PASS、RPC 五场景 PASS、comparison-parity PASS、evidence-environment PASS、--repro 双侧 PASS）；repro-20260920T034514083Z-{sdk-node,rpc-python}.log；selftest-infra-20260920T034959Z.json（20/20）；secrets-scan-20260920T034514083Z-{evidence,workspace}.json（189+86 文件零发现）与发布时点/定稿确认全工作区复扫（secrets-scan-20260920T040633Z-full-workspace.json 280 文件、secrets-scan-20260920T040816Z-full-workspace.json 281 文件，均零发现）。
- 建议最晚决定时间：负责人完成真实环境复现与 ADR 批准之后（--repro 已执行；共享 environment.json 已补齐并通过检查）。

## DECISION-008

- 状态：PENDING_OWNER（2026-09-18 新增；**2026-09-20 对照前提已满足，剩余为负责人正式确认/记录**）
- 需要决定：D1 对照实验的统一 provider/model/thinking 基线的正式确认。
- 为什么阻塞正式方案：任务书第 5 节把"同一模型和相同 thinking 配置"列为对照实验的必须条件。2026-09-18 时点两侧不一致（sdk-node=tal-token-plan-copy-copy/claude-fable-5 且 403；rpc-python=tal-token-plan-06c64a09/deepseek-v4.1-flash），verify-d1 判 BLOCKED。**2026-09-20 Agent B 已按 tal-token-plan-06c64a09/deepseek-v4.1-flash/thinking=off 重跑 SDK 五场景并全部 PASS，verify-d1 comparison-parity 检查转 PASS（两侧 pi 0.85.1、provider/model/thinking 一致）**——对照前提在事实层面已满足；本条保持 PENDING_OWNER 仅因负责人尚未正式记录基线决定（Agent D 按记录规则不代填）。
- 当前已完成工作：统一基线重跑完成（evidence/sdk/runs/2026-09-20T02-12-05-667Z-6220/，model source=env-override，五场景 exitCode=0；中间 run 01:50/02:03 保留）；parity 由验收自动复核 PASS（verify-20260920T021547888Z.json、verify-20260920T032122324Z.json、verify-20260920T034514083Z.json（最终收口轮）check 22，证据含两侧 environment 记录；集成人补齐的共享 evidence/environment.json 之 comparisonBaseline 亦与实测基线一致）；B 顺带修正了两处 SDK 侧实现问题并留档（模型发现须经 `createAgentSessionServices()` 加载 `~/.pi/agent` 扩展注册的 provider——裸 `ModelRuntime.create()` 不可见，曾致 01:50 全 BLOCKED；steer 语义检查按 Pi 0.85.1 同一 agent run 新 turn 形态修正，曾致 02:03 steer 误判 FAIL——见 sdk-node/README.md"模型发现路径（2026-09-20 修正）"）。
- 可选项：正式确认 tal-token-plan-06c64a09/deepseek-v4.1-flash/thinking=off 为 D1 基线（与已完成的对照实测一致）；或指定其他基线并要求两侧重跑。
- 各选项证据：verify-20260920T034514083Z.json（最终收口轮 ALL_PASS，check 22 PASS 详情）与 verify-20260920T021547888Z.json、verify-20260920T032122324Z.json check 22（历史轮，保留）；evidence/sdk/runs/2026-09-20T02-12-05-667Z-6220/{environment.json,run-summary.json}；evidence/rpc/environment-rpc-python.json；evidence/environment.json（集成人补齐的共享记录，comparisonBaseline 与实测基线一致）；evidence/rpc/observation-copycopy-403.json（provider 就绪性判断与实际可用性背离的历史观察）；evidence/sdk/runs/2026-09-20T01-50-33-164Z-97987/ 与 runs/2026-09-20T02-03-27-035Z-3077/（重跑中间轮，保留）。
- 建议最晚决定时间：D1 结论（DECISION-007）签字前确认即可；对照实测已在统一基线完成。

## DECISION-009

- 状态：PENDING_OWNER（2026-09-20 收口新增）
- 需要决定：共享 scenario-result/evidence-event schema 的 scenario 枚举是否扩展以覆盖 tree-nav（第六场景），使 tree-navigation 证据纳入统一验收。
- 为什么阻塞正式方案：B/C 已在收口窗口交付 tree-navigation 实测证据（DELIVERY-007：B PASS run、C 补充探针 PASS 且发现 RPC 无 navigate 命令的实质差异），但两侧证据的 scenario 值均在共享契约枚举外，当前契约下 schema-check 判 INVALID（双方各自在 limitations 中如实声明）。是否把第六场景纳入 D1 契约与验收范围是范围决定，属负责人；Agent D 不自行扩大契约。
- 当前已完成工作：D 已复核 B 的 tree-nav result.json 在当前 schema 下的唯一违规点即 scenario 枚举（其余字段合规），并在 reports/d1-verification.md 第 4b 节作事实性摘录（含 SDK navigateTree 与 RPC fork/switch_session/clone 的语义差异）；03:45:14Z 最终收口验收（28/28、exit 0）亦按当前契约执行、不含 tree-nav 项；若负责人决定扩展，D 将按公开修订流程更新 schema（schema description + schemas/README.md + 探针正反例）并对两侧证据补跑统一验收（含 C 的 .result.jsonl 命名定夺）。
- 可选项：扩展枚举纳入 tree-nav 并补验收（tree-navigation 成为准正式第六场景）；维持契约现状、tree-nav 证据仅作参考输入（A 矩阵的补充实测数据点）；指定其他处理方式。
- 各选项证据：evidence/sdk/tree-nav/runs/2026-09-20T02-59-39-706Z-27995/（B，PASS）；evidence/rpc/tree-navigation.{result.jsonl,events.jsonl}（C，PASS）；B/C result 的 limitations 声明；reports/d1-verification.md 第 4b 节；schema-check 复核记录。
- 建议最晚决定时间：DECISION-001（路线选型）评估树导航能力权重时一并定夺；不阻塞五场景 D1 结论。

## C. 记录规则

- 每项 PENDING_OWNER 决定后，由负责人（或其授权的 Agent）在对应 DECISION 下追加决定结果与日期；Agent D 不代填。
- 交付阻塞解除时更新 A 节状态并引用新的证据路径，不删除历史行。

## D1 负责人决定记录（2026-09-20）

以下记录由负责人批准后追加，关闭对应历史 `PENDING_OWNER` 状态；历史条目与原始证据保留不变。

### DECISION-001 关闭

- 决定：TreeAI 首版采用 **TypeScript/Node.js + Pi SDK 进程内直嵌**（候选 1）。
- 依据：统一基线下 SDK/RPC 五场景均 PASS，tree-navigation 证据显示 SDK 保留原生同 session 导航语义；D1 最终验收与 clean-room 已通过。

### DECISION-002 关闭

- 决定：首版宿主语言为 **TypeScript/Node.js**。

### DECISION-003 关闭

- 决定：Pi 精确版本锁定 **0.85.1**。Node.js `v24.21.0`、npm `11.19.0` 和 Python `3.9.6` 作为 D2 当前复现环境基线；后续偏离必须通过显式升级记录和回归验收。

### DECISION-004 关闭

- 决定：接受受信任本地模式下的 SDK 同进程风险。该模式不构成沙箱或安全边界；出现强隔离要求时另立架构决策。

### DECISION-005 关闭

- 决定：实施最小权限策略：工具仅可读 fixtures 与负责人明确授权的目录；shell 与网络默认拒绝；写入和其他高风险操作逐次授权。正式产品目录清单由 D2 按该边界落定，不由 D1 推测扩大。

### DECISION-006 关闭

- 决定：批准 ADR-001，批准对象为 TypeScript/Node.js + Pi SDK 候选 1；TreeAI 数据与 Pi session 边界仍为 ADR §4 的硬约束。

### DECISION-007 关闭

- 决定：**D1 Go**。该决定只表示 D1 证据、复现和验收达到阶段门槛，不表示生产发布已批准。

### DECISION-008 关闭

- 决定：正式记录 D1 对照基线为 `tal-token-plan-06c64a09/deepseek-v4.1-flash/thinking=off`，Pi `0.85.1`；D2 或生产环境如更换 provider/model，必须两侧同步重跑。

### DECISION-009 关闭

- 决定：将 tree-navigation 纳入共享 scenario 契约和统一验收；规范值为 `tree-navigation`，现有 SDK `tree-nav` 作为兼容别名；新增验收证据见最新 `verify-d1 --repro`。

## D2 授权记录（2026-09-20）

负责人授权进入 D2。D2 目标是把 D1 spike 收敛为可维护的首版运行时，不建设通用 Agent Runtime。

授权模块边界：PiRuntime、TreeRepository、SessionReference、EventJournal、ToolPolicy。首批工作包为运行时工程化、树模型接入、TreeAI 自有数据库持久化、最小权限策略、可观测性和 CI 门禁；完成定义为完整树的双分支切换/重启恢复、Pi session 删除不破坏域数据、异常不留下脏运行状态、默认权限拒绝越权、Pi 升级回归可重复、tree-navigation 进入正式门禁、至少一次目标设备人工验收。

明确不做：复制 D1 probe 为生产代码、建设多 Runtime 通用适配层、把 Pi session 当 TreeAI 数据库、牺牲原生树导航语义换取未经批准的隔离方案，或使用 `latest` 依赖版本。

## DELIVERY-007 收口记录（2026-09-20）

- tree-navigation 已纳入共享 schema（`tree-navigation` 规范名、`tree-nav` 兼容别名）和 `verify-d1` 补充检查。
- SDK/RPC tree-navigation 结果与事件均通过最新 30 项验收（checks 22/23）；RPC canonical `.result.json` 与追加 journal 最后一行一致。
- 原始契约外状态和中间验证历史保留；该交付阻塞关闭。DECISION-009 的范围决定记录仍保留在上方，供 D2 回顾。


- 状态：`PENDING_TOOLING`
- `gh` CLI 当前不可用（未安装），因此本次未创建 milestone/issue，也不伪造 URL。
- 待创建资源：milestone `D2`；issue 标题建议为 `D2: Formalize trusted-local TreeAI runtime with Pi SDK`。
- issue 正文应使用负责人批准的 D2 目标、PiRuntime/TreeRepository/SessionReference/EventJournal/ToolPolicy 边界、六个首批工作包、完成门槛和“不建议做的事”；前置条件为本节 DECISION-001、006、007 已关闭，tree-navigation 已纳入契约。

### D2 milestone / issue 可粘贴材料（gh 安装并认证后创建）

**Milestone title**：`D2`

**Milestone description**：

> Formalize the trusted-local TreeAI runtime after D1 approval. D2 is engineering convergence, not production release approval.

**Issue title**：`D2: Formalize trusted-local TreeAI runtime with Pi SDK`

**Issue body**：

> ## Goal
>
> 收敛 D1 已验证逻辑，形成可维护的首版运行时，不扩大为通用 Agent Runtime。
>
> ## Approved boundary
>
> - TypeScript/Node.js + Pi SDK process embedding
> - Pi 0.85.1
> - Trusted-local same-process mode accepted; this is not a sandbox/security boundary
> - Minimum permissions: fixtures and owner-authorized directories readable; shell/network denied by default; high-risk operations require per-operation authorization
> - TreeAI-owned database is the product fact source; Pi session is only a runtime recovery/replay reference
>
> ## Module boundaries
>
> - **PiRuntime**: create/restore session, prompt, steer, abort, navigateTree, event subscription
> - **TreeRepository**: Forest/Tree/Branch/Episode/Run data
> - **SessionReference**: sessionFile + sessionId + entryId references only
> - **EventJournal**: auditable TreeAI events with raw Pi evidence references
> - **ToolPolicy**: tool allowlist, directory scope, writes and high-risk authorization
>
> ## First work packages
>
> 1. Runtime engineering: formal TypeScript package, pinned dependencies, error classification; basic/steer/abort/resume tests
> 2. Tree model integration: TreeAI branch to Pi entry/session references; in-place switch, fork, return, restart recovery
> 3. Persistence: TreeAI-owned database schema; deleting Pi sessions must not break domain facts
> 4. Permission policy: default policy and per-operation authorization; overreach tests for reads/writes/shell/network
> 5. Observability: run state, event journal, errors and duration with no credential leakage
> 6. CI gates: unit tests, schema, secret scan and D1 regression; live suite in credentialed environments
>
> ## Definition of done
>
> - One complete TreeAI tree can create two branches, switch between them and recover after restart
> - TreeAI/Pi ownership boundary passes delete/recovery tests
> - abort, process exit and model errors never leave a stale running state
> - default tool policy rejects unauthorized access
> - Pi upgrade regression command is reproducible and tree-navigation is a formal gate
> - at least one target-device manual acceptance is complete
>
> ## Explicit non-goals
>
> - Do not copy the D1 probe directory into production
> - Do not build a multi-runtime generic adapter
> - Do not use Pi session JSONL as the TreeAI database
> - Do not sacrifice native tree-navigation semantics only for RPC isolation
> - Do not use `latest` as a Pi dependency version
> - D2 completion is not production release approval

`gh` 当前不可用，因此 milestone/issue 尚未创建；以上内容是唯一真实的待创建材料，不含伪造 URL。