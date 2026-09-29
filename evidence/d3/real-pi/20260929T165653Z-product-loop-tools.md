# TreeAI D3 真实 Pi 产品面操作记录【API 跑批器 v1.1.1 · no-context-bleed 路径证明加固后】

> **驱动类别：真实 Pi（DeepSeek `deepseek-flash`）+ 工具策略门（`--pi-tools read`）**
> —— 与 `20260929T124851Z-product-loop-tools.md`（`04db6c2`，跑批器 v1.1.0）同一
> 剧本与断言面的复跑：本轮目的是**验证 no-context-bleed 加固**（真实模型列举措辞
> 方差解耦，session entry 路径机械证明）并刷新同日 API 面证据。浏览器面的同波
> 记录见 `../browser/20260929T164034Z-realpi-product-loop-tools.md`。

## 基本信息

- 记录 ID：`d3-realpi-20260929T165653Z-product-loop-tools`
- 日期（本地时区）：2026-09-30（UTC 2026-09-29T16:56Z 前后）
- 操作人（编号 / 角色）：scheduled-loop / integrator
- commit SHA（运行时绑定，跑批器 stdout 为准）：`2d35b5bd6a0b…`（gitDirty 构成：
  **已跟踪文件零改动**；未跟踪条目为历史运行产物目录与本机配置，运行时代码与
  该 SHA 一致）
- 记录类别：☑ API 面真实 Pi 操作　☑ 故障注入　☑ 幂等测试　☐ 浏览器 UI 级　☐ 独立试用
- 驱动方式：入仓 API 面跑批器 `scripts/run-d3-real-pi.mjs` **v1.1.1**
  （`--mode real-pi --provider deepseek --model deepseek-flash --pi-tools read
  --agent-dir <受控目录> --prompt-timeout-ms 240000`）spawn 真实 Studio CLI
  （`--driver pi`，两段式引导），HTTP API 驱动 + SSE / journal / diagnostics 断言

## 环境

- Node 24.21.0 / npm 11.19.0（锁基线）；Pi（`@earendil-works/pi-coding-agent`）0.85.1
- provider / model：deepseek / deepseek-flash（受控 agent 目录内非秘密 registry，
  与 D2 live 校验器同一受控目录，不入仓）
- 凭据说明：API key 仅经 `TREEAI_STUDIO_API_KEY` 环境注入；值未写入记录、日志、
  数据库或 evidence（跑批器只检查变量名）
- 数据目录：临时（跑批器自建，运行后清理；本记录无 transcript 附件——逐项事实
  以下表誊录为准，与 `124851Z` 产品面记录同规格）
- OS / 目标机器：macOS（arm64），本机 trusted-local

## 操作步骤（逐条）

前提与 `20260929T124851Z-product-loop-tools.md` 完全一致（同一 codeword 剧本、
同一两段式引导、同一 marker/canary 布局约束）。跑批器对 **24 项检查**逐项登记，
本记录按 stdout 事实誊录。结果：**23 PASS / 0 FAIL / 0 BLOCKED / 1 NOT_RUN**，
verdict PASS，退出码 0。

| # | check | 实测 | 备注 |
| --- | --- | --- | --- |
| 1 | studio-boot | PASS | driver pi，/api/health ok |
| 2 | tree-create | PASS | |
| 3 | trunk-main-line | PASS | 两轮真实模型主干 prompt |
| 4 | branch-a-create | PASS | 锚点 = 主干第 1 轮答案选区 |
| 5 | branch-a-followups | PASS | 两轮追问，4 turns |
| 6 | switch-navigation | PASS | 显式 switch 回主干 |
| 7 | branch-b-create | PASS | 不同锚点（第 2 轮答案选区） |
| 8 | branch-b-followups | PASS | 两轮追问，4 turns |
| 9 | no-context-bleed | PASS | **session entry 路径证明**（A 路径 cedar+maple、无 4127/birch；B 路径 birch+maple+4127、无 cedar——与模型列举措辞解耦，v1.1.1 起） |
| 10 | anchor-reveal | PASS | origin available、selection 完整 |
| 11 | return-submit | PASS | 201，targetAnchor 快照 |
| 12 | return-idempotency | PASS | 200 重放 / 409 冲突 |
| 13 | return-delivery | PASS | deliveredRunId 置位恰一次 |
| 14 | model-error-convergence | NOT_RUN | 真实 provider 无安全确定性注入（既知门控，echo /fail 覆盖收敛机制；负责人侧按 README 注入一次） |
| 15 | sse-event-surface | PASS | |
| 16 | diagnostics-projection | PASS | |
| 17 | journal-no-leak | PASS | journal 投影无路径/参数/命令 |
| 18 | restart-persistence | PASS | |
| 19 | mid-flight-abort | PASS | |
| 20 | A5-product-tool-policy | PASS | 两段式工具引导 + 场景布局 |
| 21 | A5-product-tool-policy-allow-read | PASS | allow 真实执行端到端（run `run_f2055dfd…`），marker 内容进入会话与 session 文件；**零逃逸轮** |
| 22 | A5-product-tool-policy-deny-fail-closed | PASS | 越权读取执行前拦截（run `run_9edbdfec…`），policy-denied fail-closed 收敛，零回合落库；**零逃逸轮** |
| 23 | A5-product-tool-policy-deny-provenance | PASS | SSE denied 相位（键集锁定）+ journal tool.decision/runtime.error + diagnostics observed decisions；无路径/参数外泄 |
| 24 | A5-product-tool-policy-canary-never-read | PASS | 12 文件全树扫描，canary 零物化 |

## 脱敏 ID 清单

- Tree / Branch / Return：跑批器 stdout 不回显（按无 ID 登记）。
- Run（工具相两项，stdout 呈现前 12 位）：allow `run_f2055dfd…`、deny
  `run_9edbdfec…`。

## 注入的故障（如无写"无"）

在途中止（mid-flight abort）；策略拒绝（overreach read 执行前拦截）。
其余故障类别（重启/缺失 session/模型错）为既知门控或负责人侧口径，与
`124851Z` 记录一致。

## 本波发现（如实记录）

1. **产品缺陷：无**。全部 23 项适用检查 PASS。
2. 本记录同时是跑批器 v1.1.1 加固（`2d35b5b`）的真实模型验证：真实模式
   no-context-bleed 的正向断言改为 session entry 树 parentId 路径（本轮实测
   生效——此前同晚的浏览器波记录取证表明模型 b2 列举约半数概率只回
   "birch"，措辞方差不构成串扰证据）。加固前的同命令试跑（绑定 `d3ab006`，
   gitDirty 含本修复）同样 23/0/0/1 通过，本记录为绑定修复 SHA 的正式复跑。
3. 真实模型本轮全部回合秒级收敛，240 秒超时余量未触及。

## 结果

- 结论：**PASS**（23/24 适用检查 PASS；1 项既知门控 NOT_RUN；退出码 0）
- 与预期的偏差：无。

## 证据附件

- 无独立附件（临时数据目录已清理；逐项事实以本记录誊录为准，与
  `124851Z` 产品面记录同规格）。跑批器 stdout 全文留存于运行机
  `/tmp/d3-realpi-run5.log`（不入仓）。
- 同 SHA echo 自检：`run-d3-real-pi.mjs` v1.1.1 三连续绿
  （18 PASS / 0 FAIL / 0 BLOCKED / 6 NOT_RUN ×3，退出码 0）。

## 复验命令

```bash
git clone https://github.com/Lortzing/TreeAI.git && cd TreeAI
git checkout 2d35b5bd6a0b
node --version && npm --version   # 24.21.0 / 11.19.0
npm ci
# 受控 agent 目录内放非秘密 provider/model registry（deepseek/deepseek-flash）
TREEAI_STUDIO_API_KEY=… node scripts/run-d3-real-pi.mjs --mode real-pi \
  --provider deepseek --model deepseek-flash --pi-tools read \
  --agent-dir <受控目录> --prompt-timeout-ms 240000
# 期望 23 PASS / 0 FAIL / 0 BLOCKED / 1 NOT_RUN（model-error-convergence 门控），退出码 0
```

## 复测（仅阻断问题修复后追加；不改写上方原始记录）

- 对应修复 commit SHA：不适用
- 复测日期 / 操作人：不适用
- 复测结论与残余问题：不适用
