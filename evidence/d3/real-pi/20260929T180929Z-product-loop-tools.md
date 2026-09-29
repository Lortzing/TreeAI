# TreeAI D3 真实 Pi 产品面操作记录【API 跑批器 v1.2.0 · 同一最终 SHA 汇总波（API 面）】

> **驱动类别：真实 Pi（DeepSeek `deepseek-flash`）+ 工具策略门（`--pi-tools read`）**
> —— 与 `20260929T180220Z-product-loop-tools.md`（`4f29e6c`，跑批器 v1.2.0 首份
> 0-NOT_RUN 记录，并行会话录制）同一剧本与断言面的复跑：本轮目的是把 API 面
> 证据**绑定到汇总波的同一最终 SHA `699b2d8`**（该 SHA 在 `4f29e6c` 之上仅含
> 证据/文档提交，运行时代码逐字一致），与本波浏览器面
> （`../browser/20260929T182259Z-realpi-product-loop-tools.md`，含新 A2 深选区
> 阶段）、SDK 面（同波 `*-tool-policy-sdk.md`）与离线 manifest 同 SHA 汇合。

## 基本信息

- 记录 ID：`d3-realpi-20260929T180929Z-product-loop-tools`
- 日期（本地时区）：2026-09-30（UTC 2026-09-29T18:09Z 结束）
- 操作人（编号 / 角色）：scheduled-loop / integrator
- commit SHA（运行时绑定，跑批器 stdout 为准）：`699b2d883e11`（gitDirty 构成：
  **已跟踪文件零改动**——运行窗口 18:06:47Z（该 SHA 提交时刻）至 18:09:29Z
  （结束）内无并行提交；未跟踪条目为历史运行产物目录与本机配置，运行时代码与
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
- 数据目录：临时（跑批器自建，运行后清理；无 transcript 附件——逐项事实以下表
  誊录为准，与 `180220Z` 同规格）
- OS / 目标机器：macOS（arm64），本机 trusted-local（**非**负责人目标 Mac 人工面）

## 操作步骤（逐条）

前提与 `20260929T180220Z-product-loop-tools.md` 完全一致（同一 codeword 剧本、
同一两段式引导 + 模型错误注入引导、同一 marker/canary 布局约束）。跑批器对
**24 项检查**逐项登记，本记录按 stdout 事实誊录。结果：**24 PASS / 0 FAIL /
0 BLOCKED / 0 NOT_RUN**，verdict PASS，退出码 0。

| # | check | 实测 | 备注 |
| --- | --- | --- | --- |
| 1 | studio-boot | PASS | driver pi，/api/health ok；banner 如实报告受控 agent 目录与 env 注入 |
| 2 | tree-create | PASS | SSE 流先于首个 prompt 挂接 |
| 3 | trunk-main-line | PASS | 两轮真实模型主干 prompt，4 turns |
| 4 | branch-a-create | PASS | 锚点 = 主干第 1 轮答案选区 |
| 5 | branch-a-followups | PASS | 两轮追问 |
| 6 | switch-navigation | PASS | 显式 switch 回主干 |
| 7 | branch-b-create | PASS | 不同锚点（第 2 轮答案选区） |
| 8 | branch-b-followups | PASS | 两轮追问 |
| 9 | no-context-bleed | PASS | session entry 路径证明（A 路径 cedar+maple、无 4127/birch；B 路径 birch+maple+4127、无 cedar） |
| 10 | anchor-reveal | PASS | origin available、selection 完整、光标回正 |
| 11 | return-submit | PASS | 201，targetAnchor 快照，deliveredRunId null |
| 12 | return-idempotency | PASS | 200 重放 / 409 冲突 / 恰一行 |
| 13 | return-delivery | PASS | deliveredRunId 置位恰一次 |
| 14 | sse-event-surface | PASS | 7 run-started / 7 run-terminal（全 succeeded）/ 26 message-delta / 0 abort |
| 15 | diagnostics-projection | PASS | 7 runs 安全投影 |
| 16 | journal-no-leak | PASS | 500 events，白名单键集精确，无 canary 泄漏 |
| 17 | restart-persistence | PASS | SIGKILL + 同数据重启：tree/branches/turns/cursor 完整，主干可续 |
| 18 | mid-flight-abort | PASS | 在途 run `run_38874d80…` 中止（409 user-abort，零 turns），主干随后可用 |
| 19 | model-error-convergence | PASS | 不可达 baseUrl 的错配 registry 在新鲜探针树上收敛 failed（502 unknown，零 turns）；原 registry 重启恢复同一树（failed → succeeded）；错配引导加载 1962 events，工具引导加载 2005 events（同数据目录跨三次引导存活本身即 A4 证据） |
| 20 | A5-product-tool-policy | PASS | 工具引导 banner：tools=read、read-roots=<data>/workspace/policy-allowed、writes/shell/network denied（fail closed） |
| 21 | A5-product-tool-policy-allow-read | PASS | run `run_13539e5b…`：marker 内容到达对话与 session 文件 |
| 22 | A5-product-tool-policy-deny-fail-closed | PASS | run `run_3c13f16f…`：越权读在执行前被拒，收敛 failed(policy-denied)，零 turns |
| 23 | A5-product-tool-policy-deny-provenance | PASS | SSE denied 相位（锁定键集）+ journal tool.decision/runtime.error + diagnostics observed；无路径/参数泄漏 |
| 24 | A5-product-tool-policy-canary-never-read | PASS | 13 个文件扫描（受控 agent 目录 + 数据目录含 sessions/journal/DB）：canary 内容未出现 |

## 结论（仅事实，不声明门禁）

- 同一最终 SHA `699b2d8` 上，API 面全 24 项检查 PASS、零 NOT_RUN、退出码 0，
  与并行会话在 `4f29e6c`（运行时等价代码）的 `180220Z` 记录相互印证。
- 剩余负责人侧事项与 `180220Z` 记录一致：目标 Mac 人工面、逐屏设计签收、
  3–5 人试用与 W1 签署不在本记录范围。
