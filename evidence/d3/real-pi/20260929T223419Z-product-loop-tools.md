# TreeAI D3 真实 Pi 产品面操作记录【API 跑批器 v1.2.0 · 视觉重构波（API 面）】

> **驱动类别：真实 Pi（DeepSeek `deepseek-flash`）+ 工具策略门（`--pi-tools read`）**
> —— 与 `20260929T201118Z-product-loop-tools.md`（`0f9df98`，v1.2.0）同一
> 剧本与断言面的复跑：本轮目的是把 API 面证据**绑定到视觉重构波的最终
> SHA `361f528`**（该 SHA 相对 `0f9df98` 增加：Studio 视觉重构——`index.html`
> / `style.css` / `app.js`（顶栏位置路径、`#workspace` 限高骨架、并置支线列、
> 空态直达按钮）/ ui-probe 扩充 5 项、文档同步、以及浏览器面跑批器 v1.3.1
> 安全带修复；API 跑批器驱动路径与 studio 服务/运行时面不涉 UI 静态文件，
> 行为逐字一致），与本波 SDK 面（同波 `20260929T223349Z-tool-policy-sdk.md`）、
> 浏览器面（`../browser/20260929T223539Z-realpi-product-loop-tools.md`）与
> 离线 manifest（`../offline/20260929T223539388Z-evidence-manifest/`）汇合。

## 基本信息

- 记录 ID：`d3-realpi-20260929T223419Z-product-loop-tools`
- 日期（本地时区）：2026-09-30（UTC 2026-09-29T22:33:49–22:34:19Z，全程约 30 秒）
- 操作人（编号 / 角色）：claude-code-treeai-loop / 授权操作者
- commit SHA（运行时绑定，跑批器 stdout 为准）：`361f528fe675`（gitDirty:
  false——运行于该 SHA 的隔离 detached worktree，porcelain 干净）
- 记录类别：☑ API 面真实 Pi 操作　☑ 故障注入　☑ 幂等测试　☐ 浏览器 UI 级　☐ 独立试用
- 驱动方式：入仓 API 面跑批器 `scripts/run-d3-real-pi.mjs` **v1.2.0**
  （`--mode real-pi --provider deepseek --model deepseek-flash --pi-tools read
  --agent-dir <受控目录> --prompt-timeout-ms 240000`）spawn 真实 Studio CLI
  （`--driver pi`，两段式引导 + 模型错误注入引导），HTTP API 驱动 +
  SSE / journal / diagnostics 断言

## 环境

- Node 24.21.0 / npm 11.19.0（锁基线）；Pi（`@earendil-works/pi-coding-agent`）0.85.1
- provider / model：deepseek / deepseek-flash（受控 agent 目录内非秘密 registry，不入仓）
- 凭据说明：API key 仅经 `TREEAI_STUDIO_API_KEY` 环境注入；值未写入记录、日志、
  数据库或 evidence（跑批器只检查变量名）
- 数据目录：临时（跑批器自建，运行后清理；无 transcript 附件——逐项事实以下表
  誊录为准，与 `201118Z` 同规格）
- OS / 目标机器：macOS（arm64），本机 trusted-local（**非**负责人目标 Mac 人工面）

## 操作步骤（逐条）

前提与 `20260929T201118Z-product-loop-tools.md` 完全一致（同一 codeword 剧本、
同一两段式引导 + 模型错误注入引导、同一 marker/canary 布局约束）。跑批器对
**24 项检查**逐项登记，本记录按 stdout 事实誊录。结果：**24 PASS / 0 FAIL /
0 BLOCKED / 0 NOT_RUN**，verdict PASS，退出码 0（零 escape 轮、零重试；全程
约 30 秒——模型响应快的正常量级）。

| # | check | 实测 |
| --- | --- | --- |
| 1–10 | 主剧本（boot / 建树 / 主线两轮 / 双支线各两轮 / 交叉切换 / 无串线 / 锚点揭示） | 全 PASS |
| 11–13 | Return 生命周期（201 / 200 重放 / 409 冲突 / `deliveredRunId` 恰一次置位） | 全 PASS |
| 14–17 | SSE 事件面（run-started / run-terminal / message-delta / abort 计数）与诊断终态 | 全 PASS（sse-event-surface：7 run-started / 7 run-terminal 全 succeeded / 28 message-delta / 0 abort——message-delta 计数随真实模型流式粒度有正常方差） |
| 18–20 | 故障注入（SIGKILL 重启收敛 / 在途 abort / 模型错误注入引导 → 502 → 原配置重启恢复 `failed → succeeded`） | 全 PASS |
| 21–24 | A5 工具门（两段式引导 / marker 读入端到端 / 越权读执行前拒绝 fail-closed / 决策来源 SSE+journal+diagnostics / canary 全目录扫描不出现） | 全 PASS |

## 本波发现

无新产品缺陷、无模型方差 escape 轮。本波 UI 静态文件重构不触 API 面
（跑批器经 HTTP/SSE 驱动服务面），全项与 `0f9df98` 基线逐项一致。
