# TreeAI D3 真实 Pi 操作记录

## 基本信息

- 记录 ID：`d3-real-pi-20260929T124851Z-product-loop-tools`
- 日期（本地时区）：2026-09-29
- 操作人（编号 / 角色）：scheduled-loop / integrator
- commit SHA（运行时工作区 HEAD）：`04db6c2936e0fa1e320b729d1aee9b1df5a822a9`（运行代码与该 SHA 一致；`gitDirty: true` 仅由未跟踪文件构成——历史遗留的运行产物目录与本机配置，无任何已跟踪文件改动）
- 记录类别：☑ 真实 Pi 操作　☑ 故障注入　☑ 幂等测试　☐ 设计对照录屏　☐ 独立试用

## 环境

- Node：24.21.0（与锁基线一致）
- npm：11.19.0（与锁基线一致）
- Pi（`@earendil-works/pi-coding-agent`）：0.85.1
- OS / 目标机器：macOS（arm64），本机 trusted-local；非目标 Mac 逐屏录屏口径
- 驱动方式：入仓跑批器 `scripts/run-d3-real-pi.mjs` v1.1.0（两段式结构）spawn 真实 Studio CLI（`apps/studio/src/index.ts`），经 HTTP API 驱动：
  - 第一段（零工具引导）：`--driver pi --provider deepseek --model deepseek-flash --port <本地> --data <临时数据目录> --agent-dir <仓库本地受控目录>`；未读取 `~/.pi`；启动横幅无任何 tools 行（零工具基线）
  - 第二段（A5 工具引导）：主剧本全部检查完成后 SIGKILL 当前 studio，同一数据目录以 `--pi-tools read` 引导重启；横幅报告 `pi tools=read` 与生效读取根（缺省收窄为数据目录 workspace 下的受控子目录；横幅为准）
- 凭据说明：已通过 `TREEAI_STUDIO_API_KEY` 注入；值未写入记录、日志、数据库或 evidence（启动 banner 仅含变量名，已核对两段引导的横幅）

## 操作步骤（逐条）

前提：临时数据目录全新；受控 agent 目录内为非秘密 DeepSeek provider/model registry。跑批器对 24 项检查逐项登记，本记录按其 stdout 事实誊录（状态词 PASS / FAIL / BLOCKED / NOT_RUN 沿用 D2 约定）。

**第一段：零工具引导上的产品闭环与故障矩阵（18 PASS / 1 NOT_RUN）**

1. Studio 启动（/api/health ok）→ 建树 + Trunk；SSE 在任何 prompt 前接入。
2. Trunk 两轮真实模型 prompt → Run 全部 succeeded，4 turns 落库，cursor 在主干。
3. 从主干第 1 轮答案锚点建支线 A（origin + selection 落库）；A 两轮追问 succeeded；显式 switch 回主干（session leaf 重导航）；从第 2 轮答案锚点建支线 B（不同锚点）；B 两轮追问 succeeded。
4. 无串扰断言：A 上下文只见 cedar+maple，B 只见 birch+maple+4127，无跨支线/锚点后主干泄漏。
5. 锚点揭示：A 的 origin available、selection 完整、cursor 对齐。
6. Return 幂等三态：提交 201（targetAnchor 快照，deliveredRunId null）；同键同内容重放 200（同一 returnTurn）；同键异容 409 return-conflict；恰好一行 return 记录。
7. Return 送达：下一次主干 prompt 后 deliveredRunId 置位（恰一次送达）。
8. SSE 事件面：7 run-started / 7 run-terminal（全部 succeeded）/ 28 message-delta / 0 abort；快照恰一帧。
9. 诊断面安全投影：7 runs，键集锁定，无 session 引用/路径外泄；policyDecisions.observed 如实为 false（零工具引导）。
10. Journal：500 事件，键集精确，剧本 canary 词不外泄。
11. 宿主重启（SIGKILL → 同数据目录重启）：树/分支/回合/cursor 完整，主干续聊可用。
12. 在途中止：在途 Run 以 409 user-abort 停止、零回合落库，主干随后可用。
13. NOT_RUN（预期）：model-error-convergence——对真实 provider 无安全的确定性模型错误注入，按口径由负责人错误配置注入一次；收敛机制已由 echo /fail 离线覆盖。

**第二段：A5 产品面 ToolPolicy（5 PASS）**

14. SIGKILL 第一段 studio → 同一数据目录以 `--pi-tools read` 引导重启（journal 688 事件重新载入——数据目录跨零工具/有工具两次引导存续本身即 A4 证据）；横幅证读取根收窄为 workspace 下受控子目录，写入/shell/网络一律拒绝（fail closed）。
15. 独立探针树（全新 session）：allow 对照——读取根内标记文件真实执行（标记内容进入回答与会话文件；SSE tool-activity started + journal tool.execution 行）。
16. overreach 核心——读取根外 canary（位于模型工作目录之内、所有读取根之外，realpath 两侧逐根证明）**执行前拦截**：502 policy-denied，Run 以 policy-denied fail-closed 收敛（首次尝试即拒绝，无逃逸轮），零回合落库。
17. 拒绝 provenance 经产品面：SSE tool-activity denied 相位（键集锁定：tool/outcome/reason/ruleId；无路径/参数）、journal tool.decision + runtime.error(policy-denied) 行、诊断面 policyDecisions.observed（allow + deny 视图）。
18. canary 内容绝不落库：受控 agent 目录 + 数据目录全树（sessions/journal/DB，12 个文件）扫描，canary 内容仅存在于其自身文件。

## 脱敏 ID 清单

- Run（跑批器 stdout 呈现的）：中止 `run_4d78f2fd…`、A5 allow `run_37d19a21…`、A5 deny `run_d9b4962b…`
- Tree / Branch / Return：跑批器 stdout 不回显这些 ID（只登记状态与计数），本记录如实按无 ID 登记；如需逐 ID 对照，可由负责人以同命令在同 SHA 复跑核对

## 注入的故障（如无写"无"）

- 故障类别：宿主重启（SIGKILL）／在途中止
- 注入方式：跑批器对 studio 子进程 SIGKILL 后同数据目录重启；在途 Run 期间 POST /abort
- 观察到的行为：重启后树/分支/回合/cursor 完整、续聊可用；中止 409 user-abort、run `aborted`、零回合、后续 prompt 正常。A5 工具引导的重启横幅显示 688 条 journal 事件完整重载

## 结果

- 结论：PASS（24 项适用检查 23 PASS / 0 FAIL / 0 BLOCKED；1 NOT_RUN 为预期门控项）
- 与预期的偏差：
  - 本记录为最终通过运行。开发预运行（同日，`24fb49b`/`c437ed9`/`4d4b8bf`/`13f2f5f` 上的中间 SHA）发现两类**真实模型行为方差**并驱动了跑批器结构修正，均如实记录：其一，主剧本长上下文上模型偶发不发起工具调用即作答（「逃逸」）；其二，模型明确拒读其工作目录之外的绝对路径（原话 "outside my working directory"）。修正为：A5 移至独立探针树（全新 session）、canary 置于模型工作目录之内但所有读取根之外、两段式引导（主剧本零工具、A5 专属工具引导）。最终运行首次尝试即拒绝，零逃逸。
  - 本记录经 HTTP API 驱动，不含浏览器 UI 录屏——目标 Mac 浏览器逐屏录屏与读屏器实机核查仍为 owner 侧待办（A2/A7 口径）。
  - model-error-convergence 在真实 provider 上无安全确定性注入，按口径 NOT_RUN，留负责人错误配置注入一次。

## 证据附件

- 录屏 / 截图归档位置：不适用（API 驱动；浏览器录屏归 owner 侧）
- 相关自动化日志：无独立附件（跑批器不写 evidence/；本记录即其 stdout 事实的誊录，复跑命令见下）

## 复测

- 对应修复 commit SHA：不适用
- 复测日期 / 操作人：不适用
- 复测结论与残余问题：不适用。复跑命令（凭据经环境变量注入）：
  `TREEAI_STUDIO_API_KEY=… node scripts/run-d3-real-pi.mjs --mode real-pi --provider deepseek --model deepseek-flash --agent-dir <受控目录> --pi-tools read`
