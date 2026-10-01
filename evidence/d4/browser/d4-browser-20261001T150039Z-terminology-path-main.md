# TreeAI 术语纵向路径浏览器证据验收记录【echo driver】（术语半边——合并主 SHA 复跑）

> **驱动类别：echo（确定性回声驱动）** —— 本记录是 echo driver 下的真实
> 浏览器检查，**不是真实 Pi 证据**（术语半边的真实 Pi 记录为
> `d4-browser-20261001T144617-20806-realpi-terminology` @ `450b9d7`，
> deepseek/deepseek-flash，13 次真实模型调用）。它是术语纵向路径波的
> **合并主 SHA 复跑**：分支证据（①②③逐项、四项真缺陷修复披露、探针侧
> 适配）见
> [`d4-browser-20261001T142535-15614-terminology-path.md`](./d4-browser-20261001T142535-15614-terminology-path.md)。
> **本记录属 issue #7 术语工作（搭乘 D4 浏览器 harness），不计 D4 进度。**

## 基本信息

- 记录 ID：`d4-browser-20261001T150039Z-terminology-path-main`
  （summary runId `d4-browser-20261001T150039-28891`）
- 日期（本地时区）：2026-10-01（UTC 2026-10-01T15:00Z 起）
- 操作人（编号 / 角色）：scheduled-unattended / 协调会话（issue #7 下一步 2
  术语半边的合并复验）
- commit SHA（运行时工作区 HEAD）：`23ee8f6df3be…`（**main 合并提交**——
  `wip/term-browser-path`（tip `d031698`）并入 `3810056` 的 no-ff 合并；
  树内容与分支 tip 一致）。detached worktree 干净检出（`npm ci` +
  `build:deps`），`gitDirty: false`；证据经显式 `--artifacts` 运行后拷入
  提交（`diff -rq` 逐文件核对字节一致）。
- 驱动方式：`scripts/run-d4-browser.mjs` **v0.6.0**（`--mode selftest`
  全量，无 --only）spawn 真实 Studio CLI（echo 驱动）+ 本机 Chrome
  headless（CDP）。

## 结果

**16 PASS / 0 FAIL / 0 BLOCKED / 0 NOT_RUN，退出码 0。**

`terminology-path`（本波主体，与分支证据同语义全绿）：

- **① 阅读模式**：三选一真实切换（PUT 载荷观测 + 服务端回读）；gate 未过
  如实旁注；manual-only 与 minimal-hints 回答后零自动派发（任务/usage/
  建议集/建议条零 + 隔离执行器 sessions 零文件）；chip 预填路径不可行使
  （gate 恒关，如实披露）。
- **② 入口纵向（term/range 双覆盖）**：拖选武装 → 解释卡 → 批注保存 →
  推广（term=双击恰一次派发；range=响应丢失→冲突→恢复，恰 1 条首问、
  分支恰 +1）→ 各 ≥2 轮追问 → Return 术语来源卡（服务端对账）→ SIGTERM
  重启 → 历史/批注可读 + 续走 → 已有探索恢复 + 显式另开。
- **③ 不变量**：选择期间不重绘、复制剪贴板回读字节相等、宽 1600/窄 390
  命中、草稿+焦点回程、Esc 焦点回 composer、不强制滚底。

其余 15 项 D4 检查同 SHA 全绿（B1/B2 全分母、B3 echo、B5 组合路径、
B9 导航面、B6 规模面、B7 beta 可用性）——本波 app.js 四处焦点/竞态修复
未破坏任何既有浏览器面语义。逐项以 `summary.json` 与各 sidecar 为准。

## 合并复验（同 SHA `23ee8f6`，主检出串行执行）

- `npm run typecheck`：PASS
- `npm test`：**792/792，0 fail**
- `npm run verify:d4`：**19 PASS / 0 FAIL / 1 NOT_RUN**，exit 3（NOT_RUN =
  b8 负责人目标机门禁）
- `npm run verify:d2`：**21 PASS / 0 FAIL / 1 NOT_RUN**，exit 3

## 限制与如实声明

- echo 驱动不构成真实 Pi 证据（真实 Pi 记录见上）；① 建议 chip 预填/确认
  路径在 gate 生产恒关下不可行使（产品语义如此，非探针缺陷）。
- 精确滚动位置恢复跨 renderAll 不断言（瞬态内容滚动事件时序不可确定性
  观测）；断言收敛为「不强制滚底」+ reconcileTopLevel 整改，根因线索留
  负责人跟进。
- 本地机器工程证据，不跨机器宣称。
