# D3 offline gate record — `d061b5f` (2026-09-29)

绑定提交：`d061b5f`（主线阅读 + 局部支线视觉重构；同 push 含 `8671136`
Return 幂等 P0、`6ff7146` 流式/终态/来源抽屉/降级 P1、`7cfd8ef` Gate 0
文档）。运行环境见 `environment.json`（Node v24.21.0 / npm 11.19.0，与仓库
engines 一致；离线 echo 驱动，无模型凭据、无外部模型调用）。

## 门禁结果

| 门禁 | 结果 | 说明 |
| --- | --- | --- |
| `npm ci` | PASS | 干净安装；`9008cf6` 之前引入的 event-journal workspace 依赖已在 lockfile 登记 |
| `npm run typecheck` | PASS | 全部 7 个含源码 workspace |
| `npm test` | PASS | **367/367**（contracts 51、runtime-pi 54、persistence 58、tool-policy 73、studio 45、event-journal 75、root unit 8、integration 3） |
| `npm run verify:d2` | 20 PASS · 1 FAIL · 0 BLOCKED · 1 NOT_RUN（exit 2） | NOT_RUN = d1-repro（离线按设计不启用，需显式 flag）。**唯一 FAIL 为 `secret-scan-workspace`，6 条 findings 全部指向 2026-09-28 遗留的未跟踪本地目录 `evidence/d2/runs/d2-live-20260928T*`**（改动前基线即如此，见 `evidence/d2/runs/d2-offline-20260929T034851484Z`；本 push 引入 0 条新 finding）。CI（d2-offline workflow）在干净 checkout 上不受影响，`8671136`/`7cfd8ef`/`6ff7146` 均绿 |

完整 verify 日志（本地）：`evidence/d2/runs/d2-offline-20260929T071801940Z/`。

## UI 波次的补充验证

- `node --check apps/studio/public/app.js`：PASS。
- 脚本化 DOM 冒烟探针（仓库外 `/tmp/treeai-dom-probe.mjs`，零依赖；data-URL
  加载真实 app.js + 完整 index.html DOM 桩 + 脚本化 echo 后端/SSE/
  localStorage，含三次模拟页面加载）：**70/70 断言通过**——覆盖流式占位、
  选区建支线（绝对偏移 `{start:6,end:11}`）、面板内续聊、Return 提交（锚点卡
  位置/插入动效/焦点回主线）、deliveredRunId 反查（抽屉定位 + Esc 焦点还原）、
  session 不可用降级（徽标/提示/fail-closed 禁用）、双击提交单飞、失败草稿
  保留 + 同键重试 + 模拟重载恢复、每分支滚动恢复、reduced-motion 滚动行为。

## 边界（如实声明）

- 本记录只覆盖**注入式自动化离线验证**。真实 Pi 操作证据（A1 两支线场景、
  故障注入、送达链路）归 `evidence/d3/real-pi/` 口径——目前仅有 owner 的
  DeepSeek Trunk 冒烟（`9008cf6`）；逐屏录屏对照、窄窗/键盘/读屏器实机检查、
  3–5 人试用归 owner 手动步骤（`docs/d3/W2-frontend-prototype.md` 更新记录）。
- 本记录不声明任何门禁结论；Gate 0–2 与 A1–A7 的 Go/No-Go 均为负责人决策
  （`docs/d3/D3-status.md`）。
