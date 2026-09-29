# TreeAI D3 真实 Pi 产品面操作记录【API 跑批器 v1.2.0 · 模型错误注入产品面化后的首个全检查记录】

> **驱动类别：真实 Pi（DeepSeek `deepseek-flash`）+ 工具策略门（`--pi-tools read`）**
> —— 与 `20260929T165653Z-product-loop-tools.md`（`2d35b5b`，跑批器 v1.1.1）同一
> 剧本与断言面的复跑：本轮目的是**验证 v1.2.0 的模型错误注入产品面化**
> （model-error-convergence 在真实模式下首次真实执行）并刷新同日 API 面证据。
> 这是首份 **0 NOT_RUN** 的真实 Pi 产品面记录——`--pi-tools read` 下 24 项检查
> 全部适用且全部 PASS。

## 基本信息

- 记录 ID：`d3-realpi-20260929T180220Z-product-loop-tools`
- 日期（本地时区）：2026-09-30（UTC 2026-09-29T18:02Z 前后）
- 操作人（编号 / 角色）：scheduled-loop / integrator
- commit SHA（运行时绑定，跑批器 stdout 为准）：`4f29e6c3f686`（gitDirty 构成：
  **已跟踪文件零改动**；未跟踪条目为历史运行产物目录与本机配置，运行时代码与
  该 SHA 一致）
- 记录类别：☑ API 面真实 Pi 操作　☑ 故障注入　☑ 幂等测试　☐ 浏览器 UI 级　☐ 独立试用
- 驱动方式：入仓 API 面跑批器 `scripts/run-d3-real-pi.mjs` **v1.2.0**
  （`--mode real-pi --provider deepseek --model deepseek-flash --pi-tools read
  --agent-dir <受控目录> --prompt-timeout-ms 240000`）spawn 真实 Studio CLI
  （`--driver pi`，两段式引导 + 模型错误注入引导），HTTP API 驱动 +
  SSE / journal / diagnostics 断言

## 环境

- Node 24.21.0 / npm 11.19.0（锁基线）；Pi（`@earendil-works/pi-coding-agent`）0.85.1
- provider / model：deepseek / deepseek-flash（受控 agent 目录内非秘密 registry，
  与 D2 live 校验器同一受控目录，不入仓）
- 凭据说明：API key 仅经 `TREEAI_STUDIO_API_KEY` 环境注入；值未写入记录、日志、
  数据库或 evidence（跑批器只检查变量名）
- 数据目录：临时（跑批器自建，运行后清理；本记录无 transcript 附件——逐项事实
  以下表誊录为准，与 `124851Z` / `165653Z` 产品面记录同规格）
- OS / 目标机器：macOS（arm64），本机 trusted-local

## 操作步骤（逐条）

前提与 `20260929T165653Z-product-loop-tools.md` 完全一致（同一 codeword 剧本、
同一两段式引导、同一 marker/canary 布局约束）；新增一段**模型错误注入引导**
（phaseAbort 之后）：受控 agent 目录副本仅改 provider `baseUrl` 为不可路由回环
地址（`http://127.0.0.1:9/`，绝不产生真实 provider 请求；凭据全程环境注入且
不变），SIGKILL 后以该副本引导同一数据目录，全新探针树上发一次 prompt，随后
SIGKILL 换回原目录重启同一数据目录、同一探针树续聊。跑批器对 **24 项检查**
逐项登记，本记录按 stdout 事实誊录。结果：**24 PASS / 0 FAIL / 0 BLOCKED /
0 NOT_RUN**，verdict PASS，退出码 0。

| # | check | 实测 | 备注 |
| --- | --- | --- | --- |
| 1 | studio-boot | PASS | driver pi，/api/health ok，横幅报告受控 agent 目录与环境凭据缝 |
| 2 | tree-create | PASS | |
| 3 | trunk-main-line | PASS | 两轮真实模型主干 prompt |
| 4 | branch-a-create | PASS | 锚点 = 主干第 1 轮答案选区 |
| 5 | branch-a-followups | PASS | 两轮追问，4 turns |
| 6 | switch-navigation | PASS | 显式 switch 回主干 |
| 7 | branch-b-create | PASS | 不同锚点（第 2 轮答案选区） |
| 8 | branch-b-followups | PASS | 两轮追问，4 turns |
| 9 | no-context-bleed | PASS | session entry 路径证明（A 路径 cedar+maple、无 4127/birch；B 路径 birch+maple+4127、无 cedar——与模型列举措辞解耦） |
| 10 | anchor-reveal | PASS | origin available、selection 完整 |
| 11 | return-submit | PASS | 201，targetAnchor 快照 |
| 12 | return-idempotency | PASS | 200 重放 / 409 冲突 |
| 13 | return-delivery | PASS | deliveredRunId 置位恰一次 |
| 14 | sse-event-surface | PASS | 主树 7 run-started / 7 run-terminal（mix succeeded:7）/ 23 message-delta |
| 15 | diagnostics-projection | PASS | |
| 16 | journal-no-leak | PASS | journal 投影无路径/参数/命令 |
| 17 | restart-persistence | PASS | SIGKILL + 同数据重启，树/分支/回合/cursor 完整 |
| 18 | mid-flight-abort | PASS | 在途 run `run_f063a2a6…` 中止（409 user-abort，零回合），主干续用 |
| 19 | model-error-convergence | PASS | **真实模型错误注入（错误配置一次）**：错误配置副本引导 → 探针树 prompt **502**、错误码 `unknown`（现行分类器将连接错误如实归为 unknown，与 `104445Z` 手工记录一致；HTTP 错误码与诊断面 Run failure 码一致）、**零回合落库**、runtimeState 回 idle；换回原目录重启同一数据目录后**同树恢复续聊**（200 succeeded，failed → succeeded 序列）。注入引导横幅如实报告副本目录；journal 1352 events 重载（数据目录跨第三次 SIGKILL 存续，A4 侧证） |
| 20 | A5-product-tool-policy | PASS | 两段式工具引导 + 场景布局 |
| 21 | A5-product-tool-policy-allow-read | PASS | allow 真实执行端到端（run `run_2e2796be…`），marker 内容进入会话与 session 文件；**零逃逸轮** |
| 22 | A5-product-tool-policy-deny-fail-closed | PASS | 越权读取执行前拦截（run `run_c0a65031…`），policy-denied fail-closed 收敛，零回合落库；**零逃逸轮** |
| 23 | A5-product-tool-policy-deny-provenance | PASS | SSE denied 相位（键集锁定）+ journal tool.decision/runtime.error + diagnostics observed decisions；无路径/参数外泄 |
| 24 | A5-product-tool-policy-canary-never-read | PASS | 13 文件全树扫描（受控 agent 目录 + 数据目录含 sessions/journal/DB），canary 零物化 |

## 脱敏 ID 清单

- Tree / Branch / Return：跑批器 stdout 不回显（按无 ID 登记）。
- Run（stdout 呈现前 12 位）：中止 `run_f063a2a6…`；工具相 allow
  `run_2e2796be…`、deny `run_c0a65031…`；模型错误相 failed/recovery Run 见
  探针树诊断序列（failed(unknown) → succeeded，无独立 stdout ID）。

## 注入的故障（如无写"无"）

**模型错误（错误配置一次）**——issue #6 P0-2 清单第 4 项的模型错误腿首次经
产品面跑批器注入：受控 agent 目录副本内 provider baseUrl 指向不可路由回环地址
（一次）；修复 = 换回正常受控目录并重启（`20260929T104445Z-faults-model-error.md`
已证手法的产品面化）。凭据全程经环境变量注入且不变。此外：在途中止
（mid-flight abort）、策略拒绝（overreach read 执行前拦截）、宿主重启
（SIGKILL ×4：重启检查、注入引导、恢复引导、工具引导）。

## 本波发现（如实记录）

1. **产品缺陷：无**。24 项适用检查全部 PASS——首份 0 NOT_RUN 的真实 Pi
   产品面记录（此前 `165653Z` 的唯一 NOT_RUN 即模型错误腿）。
2. 模型错误注入的错误码实测为 `unknown`（SDK 错误文本 "Connection error."
   不匹配现行分类器任何模式）——与 `104445Z` 手工记录的现行分类行为一致；
   是否需要更细的连接级错误码属 owner 契约决定（W1 §6 开放项口径）。
   HTTP 错误码与诊断面 Run failure 码一致性已由检查断言。
3. 注入引导与恢复引导的横幅均如实报告各自 agent 目录（副本 / 原目录），
   供记录反查；错误配置副本位于系统临时目录（数据目录之外），绿色运行后
   由 cleanup 删除。
4. 真实模型本轮全部回合秒级收敛（含 502 收敛约 14 秒的 SDK 内部重试窗），
   240 秒超时余量未触及。

## 结果

- 结论：**PASS**（24/24 适用检查 PASS；0 NOT_RUN；退出码 0）
- 与预期的偏差：无。

## 证据附件

- 无独立附件（临时数据目录已清理；逐项事实以本记录誊录为准，与
  `124851Z` / `165653Z` 产品面记录同规格）。跑批器 stdout 全文留存于运行机
  `/tmp/treeai-realpi-4f29e6c.log`（不入仓）。
- 同 SHA echo 自检：`run-d3-real-pi.mjs` v1.2.0 三连续绿
  （18 PASS / 0 FAIL / 0 BLOCKED / 6 NOT_RUN ×3，退出码 0）；浏览器面
  `run-d3-browser.mjs`（v1.2.0，含并行会话的 A2 深选区相）同 SHA 三连续绿
  （24 PASS / 0 FAIL / 0 BLOCKED / 6 NOT_RUN ×3，退出码 0）。

## 复验命令

```bash
git clone https://github.com/Lortzing/TreeAI.git && cd TreeAI
git checkout 4f29e6c3f686
node --version && npm --version   # 24.21.0 / 11.19.0
npm ci
# 受控 agent 目录内放非秘密 provider/model registry（deepseek/deepseek-flash）
TREEAI_STUDIO_API_KEY=… node scripts/run-d3-real-pi.mjs --mode real-pi \
  --provider deepseek --model deepseek-flash --pi-tools read \
  --agent-dir <受控目录> --prompt-timeout-ms 240000
# 期望 24 PASS / 0 FAIL / 0 BLOCKED / 0 NOT_RUN（model-error-convergence 已产品面化），退出码 0
```

## 复测（仅阻断问题修复后追加；不改写上方原始记录）

- 对应修复 commit SHA：不适用
- 复测日期 / 操作人：不适用
- 复测结论与残余问题：不适用
