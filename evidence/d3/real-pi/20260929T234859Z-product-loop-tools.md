# TreeAI D3 真实 Pi 产品面操作记录【API 跑批器 v1.2.0 · 维护波重绑（API 面）】

> **驱动类别：真实 Pi（DeepSeek `deepseek-flash`）+ 工具策略门（`--pi-tools read`）**
> —— 与 `20260929T223419Z-product-loop-tools.md`（`361f528`，v1.2.0）同一
> 剧本与断言面的复跑：本轮目的是把 API 面证据**绑定到维护波终点 SHA
> `a88ace5`**（`a88ace54c8e5a0895a78a755d16ce3563cd1516f`；该 SHA 相对
> `361f528` 增加：`@treeai/tool-policy` 包入口与 `#tool-policy` 编译工作法
> 退役（`7e8dcdd`，D2 限制 #7 关闭——studio 侧 `loadPiToolPolicy` 导入由
> 编译产物改指包源，行为不变）、W1 §6-3/§6-7 直接服务测试（`81f7d5a`）、
> 跑批器硬化（`ae5912b`：SDK 驱动 `--agent-dir` 旗标 + 浏览器面 summary
> 写盘修复），以及 evidence 文档——API 跑批器脚本自身相对 `361f528`
> **逐字未变**，仍为 v1.2.0），与本波 SDK 面（同波
> `20260929T234756Z-tool-policy-sdk.md`）、浏览器面（`../browser/20260929T235116Z-realpi-product-loop-tools.md`）
> 汇合。

## 基本信息

- 记录 ID：`d3-realpi-20260929T234859Z-product-loop-tools`
- 日期（本地时区）：2026-09-30（UTC 2026-09-29T23:48:31–23:48:59Z，全程约 28 秒）
- 操作人（编号 / 角色）：claude-code-treeai-loop / 授权操作者
- commit SHA（运行时绑定，跑批器 stdout 为准）：`a88ace54c8e5`（gitDirty:
  false——运行于该 SHA 的隔离 worktree 分支 `rec-realpi-a88ace5`，porcelain
  干净）
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
  誊录为准，与 `223419Z` 同规格）
- OS / 目标机器：macOS（arm64），本机 trusted-local（**非**负责人目标 Mac 人工面）

## 操作步骤（逐条）

前提与 `20260929T223419Z-product-loop-tools.md` 完全一致（同一 codeword 剧本、
同一两段式引导 + 模型错误注入引导、同一 marker/canary 布局约束；worktree 内
先 `npm ci` 与 `npm run --workspace @treeai/event-journal build:test` 前置）。
跑批器对 **24 项检查**逐项登记，本记录按 stdout 事实誊录。结果：**24 PASS /
0 FAIL / 0 BLOCKED / 0 NOT_RUN**，verdict PASS，退出码 0（零 escape 轮、
零重试；全程约 28 秒——模型响应快的正常量级）。

| # | check | 实测 |
| --- | --- | --- |
| 1–10 | 主剧本（boot / 建树 / 主线两轮 / 双支线各两轮 / 交叉切换 / 无串线 / 锚点揭示） | 全 PASS（无串线：branch A 仅见 cedar+maple、branch B 仅见 birch+maple+4127，session entry 路径证明、模型措辞解耦） |
| 11–13 | Return 生命周期（201 / 200 重放 / 409 冲突 / `deliveredRunId` 恰一次置位） | 全 PASS |
| 14–16 | SSE / 诊断 / journal 面（run-started / run-terminal / message-delta / abort 计数、安全投影、白名单键集） | 全 PASS（sse-event-surface：7 run-started / 7 run-terminal 全 succeeded / 30 message-delta / 0 abort——message-delta 计数随真实模型流式粒度有正常方差，`223419Z` 基线为 28；journal-no-leak：500 事件、白名单键集精确、无剧本 canary 泄漏） |
| 17–19 | 故障注入（SIGKILL 重启收敛 / 在途 abort（run `run_e786bc0d…`，409 user-abort、零回合落库）/ 模型错误注入引导（不可路由 baseUrl）→ 502 `unknown` → 原配置重启恢复 `failed → succeeded`） | 全 PASS |
| 20–24 | A5 工具门（伞项 + 两段式引导 / marker 读入端到端（run `run_bddefdb7…`）/ 越权读执行前拒绝 fail-closed（run `run_77589984…`，converged failed(policy-denied)、零回合落库）/ 决策来源 SSE+journal+diagnostics / canary 13 文件全目录扫描不出现） | 全 PASS |

## 本波发现

无新产品缺陷、无模型方差 escape 轮。维护波注记：(1) 本跑为 studio 以
`@treeai/tool-policy` **包源直载**引擎（`7e8dcdd` 重接线后零 `#tool-policy`
编译前置——本 worktree 全程无任何 tool-policy 编译产物）完成 A5 工具门的
**首次 API 面真实模型实录**，A5 四项与 `361f528` 基线（经编译产物装载）
逐项一致；(2) API 跑批器脚本相对 `361f528` 逐字未变，全项行为面与基线
一致；(3) 唯一计数方差为 message-delta 30（`361f528` 基线 28，真实模型
流式粒度正常方差，如实登记）。本跑后 API 面绑定 `a88ace5`。
