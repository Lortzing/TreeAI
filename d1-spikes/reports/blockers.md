# TreeAI D1 阻塞与待决事项（blockers）

- 维护：Agent D。本文件是汇总登记处；引用他人证据时只读，不修改原始证据。
- 状态标记：`PENDING_OWNER` = 必须由负责人决定，任何 Agent 不得自行定案（任务书第 13 节）。
- 交付阻塞（A 节）不是负责人决策，但阻塞 D1 完成；负责人决策见 B 节。

## A. 交付阻塞（非决策项）

| 编号 | 事项 | 状态 | 影响 | 相关证据 |
|---|---|---|---|---|
| DELIVERY-001 | Agent B 交付 sdk-node/ 与 evidence/sdk/ | 已交付（2026-09-18，历史行保留） | 曾致 16 项 NOT_RUN；现五场景 BLOCKED_CREDENTIALS、单测/依赖锁定 PASS | evidence/verification/verify-20260918T123312170Z.json checks 6/8/12–16；evidence/sdk/runs/2026-09-18T11-57-46-510Z-5120/ |
| DELIVERY-002 | Agent C 交付 rpc-python/ 与 evidence/rpc/ | 已交付（2026-09-18，历史行保留） | 曾致 RPC 侧无数据；现五场景 PASS、单测（stdlib unittest）PASS | 同上 checks 7/9/17–21；evidence/rpc/*.result.json |
| DELIVERY-003 | Agent A 交付 research/（能力清单、矩阵、ADR 草案） | 已交付（2026-09-18，历史行保留） | DECISION-001/002 现有证据输入；ADR 草案状态 Proposed（未批准） | research/pi-capability-inventory.md、research/sdk-vs-rpc-matrix.md、research/adr-001-draft.md |
| DELIVERY-004 | d1-spikes/README.md 与 evidence/environment.json 的属主未定义 | 待协调（未解决） | 任务书目录树列出这两个文件，但所有权表未划给任何 Agent；B/C 各自写了环境记录（run 内 environment.json、evidence/rpc/environment-rpc-python.json），无共享 schema；comparison-parity 只能防御式解析 | schemas/README.md 第五节；verify-20260918T123312170Z.json check 23 |
| DELIVERY-005 | sdk-node/tests 合成脱敏语料曾触发秘密扫描 13 处发现 | 已解决（2026-09-18 ~12:10Z，历史行保留） | 曾致 redaction-workspace FAIL（11:59Z 运行）；Agent B 将合成令牌改为运行时拼接后，12:20Z 起全工作区扫描零发现。D 未修改 B 的文件；selftest-infra 在临时副本中作测试隔离 | verify-20260918T115924248Z.json（FAIL 历史）；verify-20260918T123312170Z.json check 26（PASS） |

## B. 负责人决定事项

## DECISION-001

- 状态：PENDING_OWNER
- 需要决定：TreeAI 首版最终采用 Pi SDK 直嵌（同进程）还是 Pi RPC 子进程路线。
- 为什么阻塞正式方案：这是 D1 的核心问题；决定后才能冻结运行时架构、进程边界、事件接入层与错误传播设计，所有正式工程依赖于此。
- 当前已完成工作：共享证据契约与五场景判定标准（schemas/、fixtures/README.txt）；统一验收入口已用同一输入与同一判定验收两条路线（scripts/verify-d1，exit 3：C 五场景 PASS、B 五场景 BLOCKED_CREDENTIALS、对照公平性 BLOCKED）；A 的能力矩阵与 ADR 草案已交付（research/，ADR 状态 Proposed）。
- 可选项：Node.js/TypeScript + Pi SDK；Node.js/TypeScript + Pi RPC；Python + Pi RPC。
- 各选项证据：research/sdk-vs-rpc-matrix.md、research/adr-001-draft.md（A 交付）；evidence/rpc/（C 五场景 PASS，Pi 0.85.1）；evidence/sdk/runs/2026-09-18T11-57-46-510Z-5120/（B 五场景 BLOCKED_CREDENTIALS，适配代码 298 行/2 文件、探针 1815 行，Pi 0.85.1）。注意：SDK 与 RPC 目前 provider/model 不一致（DECISION-008），对照矩阵暂不可下结论。
- 建议最晚决定时间：统一 provider/model 基线（DECISION-008）解决、B 以可用凭据重跑五场景并经 verify-d1 校验后、正式工程启动前。

## DECISION-002

- 状态：PENDING_OWNER
- 需要决定：宿主语言最终选型（TypeScript/Node.js、Python 或其他）。
- 为什么阻塞正式方案：决定代码库、招聘/维护栈、类型体系与 Pi 官方支持面的对齐方式；更换成本随代码量增长。
- 当前已完成工作：验收基础设施语言中立（fixture/schema/扫描/验收不依赖宿主语言）；B/C 探针目录契约已就绪并均按约交付（sdk-node/TypeScript、rpc-python/Python，均含 README/测试/锁定依赖）。
- 可选项：TypeScript/Node.js（可直嵌 SDK 或走 RPC）；Python（仅 RPC 路线，按当前任务书范围）；其他语言（需重新立项验证）。
- 各选项证据：research/sdk-vs-rpc-matrix.md 与 research/adr-001-draft.md（A 交付，含各候选收益/风险/不可逆成本/退出方案）；evidence/sdk/runs/ 与 evidence/rpc/ 的实测记录（注意 provider/model 未统一，DECISION-008）。
- 建议最晚决定时间：与 DECISION-001 同批。

## DECISION-003

- 状态：PENDING_OWNER
- 需要决定：正式版本基线：Node、Python、包管理器与 Pi 精确版本。
- 为什么阻塞正式方案：D1 要求 SDK 与 RPC 用同一 Pi 精确版本对照（禁止 latest/*）；正式工程需锁版本基线才能保证可重复安装与升级策略。
- 当前已完成工作：验收已强制锁定要求——sdk-node 需 lockfile、rpc-python 需全量 `==` 锁定或 pyproject+lock，缺失判 FAIL（scripts/verify-d1 deps-repro 检查）；干净复现模式已实现（--repro）。两侧实测均锁定 Pi 0.85.1（sdk-node package.json 依赖与全局 CLI 一致；rpc-python environment-rpc-python.json 记录 0.85.1）。
- 可选项：A 已核对当前 registry 实际可用精确版本（research/pi-capability-inventory.md），负责人据此定基线。
- 各选项证据：research/pi-capability-inventory.md（本机 pi 0.85.1 与 npm latest 一致、Node v24.21.0 满足 >=22.19.0）；verify-20260918T123312170Z.json checks 6/7；B/C 环境记录。本机环境仅作参考，不构成基线。
- 建议最晚决定时间：B/C 探针开始安装依赖前（否则对照实验需返工）。

## DECISION-004

- 状态：PENDING_OWNER
- 需要决定：是否接受 SDK 直嵌带来的同进程权限风险（Pi 与宿主同权限、同生命周期、故障域合并）。
- 为什么阻塞正式方案：这是 SDK 路线相对 RPC 路线的核心风险差异；不接受则 SDK 路线出局，DECISION-001 的选项集随之变化。
- 当前已完成工作：验收侧已建立最小权限验证手段——tool 场景固定只读 fixture、临时副本强制 readonly/ 只读、任何对授权范围的写出会被秘密扫描与验收捕捉。A 的 process isolation 分析已交付（research/pi-capability-inventory.md）；B 的 abort/资源清理实测已交付但因 BLOCKED_CREDENTIALS 未获得真实流式数据（abort 场景记录：abort() 0ms 内收口、isStreaming=false、资源前后一致，但发生在 403 之后而非流式中——见 evidence/sdk/runs/2026-09-18T11-57-46-510Z-5120/abort/result.json failedChecks）。
- 可选项：接受（以工具白名单+只读沙盒缓解）；不接受（限 RPC 路线）；条件接受（定义接受的边界并写入 ADR）。
- 各选项证据：research/pi-capability-inventory.md（进程隔离分析）；evidence/rpc/（RPC 侧隔离与子进程退出码实测：pi 子进程退出码 [0]/[0,0]，crash-probe.json）；evidence/sdk/runs/（SDK 侧 BLOCKED_CREDENTIALS，待凭据后补真实数据）。
- 建议最晚决定时间：DECISION-001 之前或同时（它是其前置风险判断）。

## DECISION-005

- 状态：PENDING_OWNER
- 需要决定：真实产品中允许 Agent 使用的工具集合与目录读写权限范围。
- 为什么阻塞正式方案：D1 的 tool 场景只验证"最小只读 fixture"这一最低安全线；产品权限模型（哪些目录可读/写、是否允许 shell）是正式架构的一部分，超出 D1 范围，负责人未确认前不得由探针擅自扩大。
- 当前已完成工作：D1 内工具白名单最小化已固化为 fixture 契约（fixtures/README.txt 二、四节；readonly/ 只读强制）；验收对越界写有检出能力（selftest-infra T1）。
- 可选项：待负责人定义（例如：仅读固定输入目录；读+限写工作目录；允许白名单 shell 等）。
- 各选项证据：无正式产品权限证据；D1 仅证明最小只读形态可验证。
- 建议最晚决定时间：正式工程工具层设计前。

## DECISION-006

- 状态：PENDING_OWNER
- 需要决定：是否批准 ADR-001（Pi 接入路线架构决策）。
- 为什么阻塞正式方案：ADR 批准是 D1 结论进入正式架构的关口；任务书明确草案只能保持 Proposed，Agent 不得代批。
- 当前已完成工作：Agent A 已交付 adr-001-draft.md（状态 Proposed，三候选保留：Node+SDK、Node+RPC、Python+RPC，各含收益/风险/不可逆成本/退出方案）；Agent D 已核验其引用证据的可追溯链路可用（schema+verify）。
- 可选项：批准；有条件批准（列条件）；驳回并要求补充证据。
- 各选项证据：research/adr-001-draft.md 及其引用的 research/ 清单/矩阵；verify-20260918T123312170Z.json（当前输入仍不完整：B 五场景 BLOCKED_CREDENTIALS、provider/model 基线未统一 DECISION-008）。
- 建议最晚决定时间：D1 复现与审查完成后。

## DECISION-007

- 状态：PENDING_OWNER
- 需要决定：D1 最终结论：Go / Conditional Go / No Go。
- 为什么阻塞正式方案：这是 D1 阶段的正式出口；在负责人完成真实环境复现、权限审查、ADR 批准与签字前，D1 不能宣告结束（任务书第 16 节）。
- 当前已完成工作：验收机器已就绪并自证（统一入口、退出码语义、失败路径必 FAIL、证据只追加）；A/B/C 均已交付；当前 exit 3（PASS=19、FAIL=0、BLOCKED=6、NOT_RUN=3）。Agent D 不给出任何倾向性签字。
- 可选项：Go（全部场景两实现 PASS 且复现一致）；Conditional Go（列明条件与截止）；No Go（记录致命失败证据）。
- 各选项证据：evidence/verification/verify-20260918T123312170Z.json（当前：C 五场景 PASS、B 五场景 BLOCKED_CREDENTIALS、comparison-parity BLOCKED）；--repro 干净复现尚未执行。
- 建议最晚决定时间：B/C/A 全部交付且负责人完成真实环境复现之后（当前 B 侧需先解决凭据与统一基线）。

## DECISION-008

- 状态：PENDING_OWNER（2026-09-18 新增）
- 需要决定：D1 对照实验的统一 provider/model/thinking 基线：SDK 与 RPC 必须用同一 provider、同一 model 与相同 thinking 配置重跑五场景（任务书第 5 节），当前两侧不一致。
- 为什么阻塞正式方案：任务书第 5 节把"同一模型和相同 thinking 配置"列为对照实验的必须条件；当前 sdk-node 用 tal-token-plan-copy-copy/claude-fable-5（403 BLOCKED_CREDENTIALS），rpc-python 用 tal-token-plan-06c64a09/deepseek-v4.1-flash（五场景 PASS）。Pi 版本（0.85.1）与 thinking（off）一致，但 provider/model 不同，五场景结果不可直接对照；verify-d1 的 comparison-parity 检查如实判 BLOCKED（verify-20260918T123312170Z.json check 22）。
- 当前已完成工作：两侧环境记录完整可查（evidence/sdk/runs/2026-09-18T11-57-46-510Z-5120/environment.json + run-summary.json；evidence/rpc/environment-rpc-python.json，含 `pi --list-models` 输出与 liveCheck）；C 记录了 provider 凭据就绪性与实际可用性背离的观察（observation-copycopy-403.json：一个 provider 报 ready 却 403，另一个报 not_ready 却正常服务）；验收器已自动检测该不一致。
- 可选项：a) 指定 tal-token-plan-06c64a09/deepseek-v4.1-flash 为 D1 统一基线（C 已证明可用，B 需按该 provider 配置并重跑）；b) 指定 tal-token-plan-copy-copy/claude-fable-5（需先为 B 解决 403 凭据问题，C 侧同步切换）；c) 指定其他负责人认可的 provider/model；d) 明确接受非对称对照并降级 D1 结论（不推荐，违反任务书第 5 节）。
- 各选项证据：verify-20260918T123312170Z.json check 22（BLOCKED 详情）；evidence/rpc/environment-rpc-python.json（modelList、liveCheck、authCheck）；evidence/rpc/observation-copycopy-403.json；evidence/sdk/runs/2026-09-18T11-57-46-510Z-5120/（B 全部 403）。
- 建议最晚决定时间：B 以可用凭据重跑五场景之前（否则 SDK 侧证据无法用于对照）。

## C. 记录规则

- 每项 PENDING_OWNER 决定后，由负责人（或其授权的 Agent）在对应 DECISION 下追加决定结果与日期；Agent D 不代填。
- 交付阻塞解除时更新 A 节状态并引用新的证据路径，不删除历史行。
