# TreeAI D1 阻塞与待决事项（blockers）

- 维护：Agent D。本文件是汇总登记处；引用他人证据时只读，不修改原始证据。
- 状态标记：`PENDING_OWNER` = 必须由负责人决定，任何 Agent 不得自行定案（任务书第 13 节）。
- 交付阻塞（A 节）不是负责人决策，但阻塞 D1 完成；负责人决策见 B 节。
- 2026-09-20 更新：B 以统一基线重跑后 SDK 五场景 PASS、comparison-parity PASS；验收现状
  exit 3（PASS=25/FAIL=0/BLOCKED=0/NOT_RUN=3，verify-20260920T021547888Z.json）。剩余
  NOT_RUN 仅 --repro 两项与共享 evidence/environment.json。全部 PENDING_OWNER 决定项保持
  待决，Agent D 不代填任何决定。

## A. 交付阻塞（非决策项）

| 编号 | 事项 | 状态 | 影响 | 相关证据 |
|---|---|---|---|---|
| DELIVERY-001 | Agent B 交付 sdk-node/ 与 evidence/sdk/ | 已交付；2026-09-20 统一基线重跑后五场景 PASS（历史行保留：09-18 曾为 BLOCKED_CREDENTIALS） | 曾致 16 项 NOT_RUN；09-18 五场景 BLOCKED_CREDENTIALS；09-20 以 tal-token-plan-06c64a09/deepseek-v4.1-flash/thinking=off 重跑后五场景 PASS（exitCode=0） | evidence/verification/verify-20260920T021547888Z.json checks 6/8/12–16；evidence/sdk/runs/2026-09-20T02-12-05-667Z-6220/（最终）；runs/2026-09-20T01-50-33-164Z-97987/、runs/2026-09-20T02-03-27-035Z-3077/（中间 run，保留）；09-18 BLOCKED 各 run 保留 |
| DELIVERY-002 | Agent C 交付 rpc-python/ 与 evidence/rpc/ | 已交付（2026-09-18，历史行保留） | 曾致 RPC 侧无数据；现五场景 PASS、单测（stdlib unittest）PASS，09-20 复验仍 PASS | verify-20260920T021547888Z.json checks 7/9/17–21；evidence/rpc/*.result.json |
| DELIVERY-003 | Agent A 交付 research/（能力清单、矩阵、ADR 草案） | 已交付（2026-09-18，历史行保留） | DECISION-001/002 现有证据输入；ADR 草案状态 Proposed（未批准） | research/pi-capability-inventory.md、research/sdk-vs-rpc-matrix.md、research/adr-001-draft.md |
| DELIVERY-004 | d1-spikes/README.md 与 evidence/environment.json 的属主未定义 | 待协调（未解决） | 任务书目录树列出这两个文件，但所有权表未划给任何 Agent；B/C 各自写了环境记录（run 内 environment.json、evidence/rpc/environment-rpc-python.json），无共享 schema；comparison-parity 只能防御式解析；evidence-environment 检查保持 NOT_RUN | schemas/README.md 第五节；verify-20260920T021547888Z.json check 23 |
| DELIVERY-005 | sdk-node/tests 合成脱敏语料曾触发秘密扫描 13 处发现 | 已解决（2026-09-18 ~12:10Z，历史行保留） | 曾致 redaction-workspace FAIL（11:59Z 运行）；Agent B 将合成令牌改为运行时拼接后，此后所有轮次（含 09-20）全工作区扫描零发现。D 未修改 B 的文件；selftest-infra 在临时副本中作测试隔离 | verify-20260918T115924248Z.json（FAIL 历史）；verify-20260920T021547888Z.json check 26（PASS，80 文件零发现）；check-secrets d1-spikes 2026-09-20 02:17Z 复扫 234 文件零发现 |
| DELIVERY-006 | --repro 干净复现未执行 | 未执行（真实 NOT_RUN，非阻塞缺陷） | verify-d1 --repro（两实现干净复现重装重测）需要网络且本轮未被请求；checks 10/11 如实记 NOT_RUN | verify-20260920T021547888Z.json checks 10/11 |

## B. 负责人决定事项

## DECISION-001

- 状态：PENDING_OWNER
- 需要决定：TreeAI 首版最终采用 Pi SDK 直嵌（同进程）还是 Pi RPC 子进程路线。
- 为什么阻塞正式方案：这是 D1 的核心问题；决定后才能冻结运行时架构、进程边界、事件接入层与错误传播设计，所有正式工程依赖于此。
- 当前已完成工作：共享证据契约与五场景判定标准（schemas/、fixtures/README.txt）；统一验收入口已用同一输入与同一判定验收两条路线（scripts/verify-d1）；A 的能力矩阵与 ADR 草案已交付（research/，ADR 状态 Proposed）。**2026-09-20 起两条路线均有统一基线（tal-token-plan-06c64a09/deepseek-v4.1-flash/thinking=off，pi 0.85.1）下的五场景 PASS 实测**，对照矩阵的实测输入已齐备。
- 可选项：Node.js/TypeScript + Pi SDK；Node.js/TypeScript + Pi RPC；Python + Pi RPC。
- 各选项证据：research/sdk-vs-rpc-matrix.md、research/adr-001-draft.md（A 交付）；evidence/rpc/（C 五场景 PASS，Pi 0.85.1）；evidence/sdk/runs/2026-09-20T02-12-05-667Z-6220/（B 五场景 PASS，适配代码 302 行/2 文件、探针骨架 1836 行/17 文件，Pi 0.85.1）。provider/model/thinking/Pi 版本已一致（verify-20260920T021547888Z.json check 22 PASS），对照前提满足。
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
- 当前已完成工作：验收已强制锁定要求——sdk-node 需 lockfile、rpc-python 需全量 `==` 锁定或 pyproject+lock，缺失判 FAIL（scripts/verify-d1 deps-repro 检查）；干净复现模式已实现（--repro）。两侧实测均锁定 Pi 0.85.1（sdk-node package.json 依赖与全局 CLI 一致；rpc-python environment-rpc-python.json 记录 0.85.1；09-20 重跑后两侧版本一致性由 check 22 复核）。
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
- 当前已完成工作：Agent A 已交付 adr-001-draft.md（状态 Proposed，三候选保留：Node+SDK、Node+RPC、Python+RPC，各含收益/风险/不可逆成本/退出方案）；Agent D 已核验其引用证据的可追溯链路可用（schema+verify）。**2026-09-20 起对照实验输入已齐备：SDK/RPC 五场景在统一基线下均 PASS（verify-20260920T021547888Z.json，check 22 parity PASS）**；剩余 NOT_RUN 仅 --repro 两项与共享 environment.json。
- 可选项：批准；有条件批准（列条件）；驳回并要求补充证据。
- 各选项证据：research/adr-001-draft.md 及其引用的 research/ 清单/矩阵；verify-20260920T021547888Z.json（SDK/RPC 五场景 PASS、parity PASS、exit 3 仅为 NOT_RUN）。
- 建议最晚决定时间：D1 复现与审查完成后（--repro 与共享 environment.json 属可选补强输入，是否等待由负责人定）。

## DECISION-007

- 状态：PENDING_OWNER
- 需要决定：D1 最终结论：Go / Conditional Go / No Go。
- 为什么阻塞正式方案：这是 D1 阶段的正式出口；在负责人完成真实环境复现、权限审查、ADR 批准与签字前，D1 不能宣告结束（任务书第 16 节）。
- 当前已完成工作：验收机器已就绪并自证（统一入口、退出码语义、失败路径必 FAIL、证据只追加；selftest-infra 2026-09-20 复跑 10/10）；A/B/C 均已交付；当前 exit 3（PASS=25、FAIL=0、BLOCKED=0、NOT_RUN=3），**两侧五场景在统一基线下均 PASS**。Agent D 不给出任何倾向性签字。
- 可选项：Go（全部场景两实现 PASS 且复现一致）；Conditional Go（列明条件与截止）；No Go（记录致命失败证据）。
- 各选项证据：evidence/verification/verify-20260920T021547888Z.json（SDK 五场景 PASS、RPC 五场景 PASS、comparison-parity PASS；NOT_RUN 仅 --repro 两项 + evidence/environment.json）；--repro 干净复现尚未执行；selftest-infra-20260920T021943Z.json（10/10）。
- 建议最晚决定时间：负责人完成真实环境复现与 ADR 批准之后（是否先补 --repro/共享 environment.json 由负责人定）。

## DECISION-008

- 状态：PENDING_OWNER（2026-09-18 新增；**2026-09-20 对照前提已满足，剩余为负责人正式确认/记录**）
- 需要决定：D1 对照实验的统一 provider/model/thinking 基线的正式确认。
- 为什么阻塞正式方案：任务书第 5 节把"同一模型和相同 thinking 配置"列为对照实验的必须条件。2026-09-18 时点两侧不一致（sdk-node=tal-token-plan-copy-copy/claude-fable-5 且 403；rpc-python=tal-token-plan-06c64a09/deepseek-v4.1-flash），verify-d1 判 BLOCKED。**2026-09-20 Agent B 已按 tal-token-plan-06c64a09/deepseek-v4.1-flash/thinking=off 重跑 SDK 五场景并全部 PASS，verify-d1 comparison-parity 检查转 PASS（两侧 pi 0.85.1、provider/model/thinking 一致）**——对照前提在事实层面已满足；本条保持 PENDING_OWNER 仅因负责人尚未正式记录基线决定（Agent D 按记录规则不代填）。
- 当前已完成工作：统一基线重跑完成（evidence/sdk/runs/2026-09-20T02-12-05-667Z-6220/，model source=env-override，五场景 exitCode=0；中间 run 01:50/02:03 保留）；parity 由验收自动复核 PASS（verify-20260920T021547888Z.json check 22，证据含两侧 environment 记录）；B 顺带修正了两处 SDK 侧实现问题并留档（模型发现须经 `createAgentSessionServices()` 加载 `~/.pi/agent` 扩展注册的 provider——裸 `ModelRuntime.create()` 不可见，曾致 01:50 全 BLOCKED；steer 语义检查按 Pi 0.85.1 同一 agent run 新 turn 形态修正，曾致 02:03 steer 误判 FAIL——见 sdk-node/README.md"模型发现路径（2026-09-20 修正）"）。
- 可选项：正式确认 tal-token-plan-06c64a09/deepseek-v4.1-flash/thinking=off 为 D1 基线（与已完成的对照实测一致）；或指定其他基线并要求两侧重跑。
- 各选项证据：verify-20260920T021547888Z.json check 22（PASS 详情）；evidence/sdk/runs/2026-09-20T02-12-05-667Z-6220/{environment.json,run-summary.json}；evidence/rpc/environment-rpc-python.json；evidence/rpc/observation-copycopy-403.json（provider 就绪性判断与实际可用性背离的历史观察）；evidence/sdk/runs/2026-09-20T01-50-33-164Z-97987/ 与 runs/2026-09-20T02-03-27-035Z-3077/（重跑中间轮，保留）。
- 建议最晚决定时间：D1 结论（DECISION-007）签字前确认即可；对照实测已在统一基线完成。

## C. 记录规则

- 每项 PENDING_OWNER 决定后，由负责人（或其授权的 Agent）在对应 DECISION 下追加决定结果与日期；Agent D 不代填。
- 交付阻塞解除时更新 A 节状态并引用新的证据路径，不删除历史行。
