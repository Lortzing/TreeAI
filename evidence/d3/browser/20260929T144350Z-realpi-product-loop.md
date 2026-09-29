# TreeAI D3 浏览器 UI 级操作记录【真实 Pi driver】

> **驱动类别：真实 Pi（DeepSeek `deepseek-flash`）** —— 真实模型驱动的
> 真实浏览器 UI 录制。

## 基本信息

- 记录 ID：`d3-browser-20260929T144350Z-realpi-product-loop`
- 日期（本地时区）：2026-09-29
- 操作人（编号 / 角色）：scheduled-loop / integrator
- commit SHA（运行时工作区 HEAD）：`fcfae525cbc091a689c7c9e9a20a609c47a5eb46`（运行代码与该 SHA 一致；`gitDirty: true` 仅由未跟踪文件构成）
- 记录类别：☑ 浏览器 UI 级操作　☑ 真实 Pi 操作　☑ 故障注入　☑ 幂等测试　☐ 设计对照录屏　☐ 独立试用
- 驱动方式：入仓浏览器面跑批器 `scripts/run-d3-browser.mjs` v1.0.0（`--mode real-pi`）spawn 真实 Studio CLI（`--driver pi --provider deepseek --model deepseek-flash --agent-dir <受控目录>`）+ 本机 Chrome headless（CDP），真实输入事件驱动真实 UI

## 环境

- Node：24.21.0 / npm：11.19.0（与锁基线一致）
- Pi（`@earendil-works/pi-coding-agent`）：0.85.1（锁基线）
- 浏览器：Chrome 153.0.8010.37（headless=new，CDP 通道）
- provider / model：deepseek / deepseek-flash（受控 agent 目录内非秘密 registry；目录不入仓）
- 凭据说明：API key 仅经 `TREEAI_STUDIO_API_KEY` 环境注入；值未写入记录、日志、数据库或 evidence（跑批器只检查变量名）
- OS / 目标机器：macOS（arm64），本机 trusted-local；**非目标 Mac 逐屏录屏口径**（真实浏览器渲染与输入管线录制，不替代负责人目标机人工验收）
- 视口：1280×900 与 480×800（窄窗断言）
- prompt 超时：120000ms（真实模型时延余量）

## 操作步骤（逐条）

前提：临时数据目录全新；受控 agent 目录内为非秘密 DeepSeek provider/model registry。结果：**21 PASS / 0 FAIL / 0 BLOCKED / 1 NOT_RUN**。

1. chrome-boot / studio-boot / page-boot：CDP 通道建立；pi studio `/api/health` ok；页面渲染、空态、启动焦点「新建」。
2. tree-create：真实点击建树 → 树视图、Trunk 页签。
3. trunk-main-line：两轮真实模型主干 prompt（第 2 轮 **⌘+Enter**）→ 4 turns 渲染；API `/state` 一致。真实模型按指令逐字回短语（「understood — the trunk topic is apples and the codeword is maple.」）。
4. selection-anchoring：第 1 轮真实答案上**真实拖选**（24–52 区间）→ `.has-selection` + 「⑃ Branch from selection」。
5. branch-a-create：点击 → 支线 A 建立（面板「Branch 1」、锚点摘录 = 拖选文本）。
6. branch-a-followups：两轮追问（第 2 轮 Ctrl+Enter）→ 面板 4 turns；a2 让模型列举可见暗号——真实模型如实列出本支线可见词（cedar、maple），见下一步探针。
7. switch-navigation：面板⇄主线往返（真实点击）；主线回合不受支线影响。
8. branch-b-create：第 2 轮答案不同子区间（30–61）拖选建支线 B（「Branch 2」）。
9. branch-b-followups：两轮追问 → 面板 4 turns。
10. no-context-bleed（渲染面 + 真实模型）：B 面板含 birch 与主干可见词（maple）、无 cedar；A 面板含 cedar 与 maple、无 birch——真实模型在渲染面上的上下文隔离如实呈现。
11. return-flow：支线 A 的 Return 草稿（预填上一答案 → 全选覆盖）→ 提交 → 主干 anchored 卡待送达（「confirmed — …」）；抽屉「not yet delivered」；服务端 `deliveredRunId: null`；Esc 关闭抽屉后继续。
12. return-delivery：主干第 3 轮 prompt（「Did any branch return a delivery marker?」）→ 真实模型逐字引用 aspen 标记；卡片徽标 → delivered；服务端核对 `deliveredRunId` === 该轮 run。
13. NOT_RUN（预期）：model-error-convergence——真实 provider 无安全确定性模型错误注入（echo `/fail` 钩子为 selftest 专属）；按口径由负责人错误配置注入一次；收敛机制已由 echo 录制覆盖。
14. server-restart-recovery：**SIGKILL** → 页面下一动作诚实错误横幅；同数据目录重启 + 整页刷新 → 树 / 3 分支 / 回合完整；主干续聊（真实模型）可用。
15. missing-session-degradation：移走 session 文件 → 刷新 → 横幅 + fail-closed composer + 恢复动作（禁用并给出原因）；还原 → 刷新完全恢复。
16. response-loss-midstream（**真实模型时延窗口下的在途整页刷新**——本记录新增覆盖的故障类）：发送「write a short paragraph about tides」后 ~0.7s 流式进行中**整页刷新** → 刷新后页面以权威状态对账：流式占位清除、run-status 回 idle、run 终态 succeeded、答案完整落库渲染（无悬空占位/无中间态停滞）。
17. a11y-semantics：`#error-banner` role=alert + tabIndex 0；抽屉 `aria-expanded` 双向 + Esc 关闭（焦点还原）；`#panel-anchor-context` tabindex=-1。
18. narrow-window-layout：480px——开关可见、`#run-detail` 隐藏、侧栏开合 aria 语义；抽屉底部上滑（`drawer-up-in`、全宽 480px）vs 宽窗右侧 360px。
19. reduced-motion：reduce 仿真 → 计算样式 0.01ms 折叠；复位 0s。
20. console-clean：全程零意外页面错误。

## 脱敏 ID 清单

- 跑批器 stdout 不回显 Tree / Branch / Return / Run ID（与 API 面跑批器同一纪律）；附件 JSON 已脱敏（本地路径占位符化、无凭据）。
- 真实模型回答全文不入库（附件 DOM 摘要仅含脱敏后的结构化状态与回合文本截断）。

## 注入的故障（如无写"无"）

- 故障类别：宿主重启（SIGKILL + 同数据目录重启）／缺失 session（移走后还原）／**响应丢失（在途整页刷新）**
- 注入方式：跑批器对 studio 子进程 SIGKILL；数据目录 session 文件改名移走/还原；发送 prompt 后 0.7s 内 `Page.navigate` 整页刷新
- 观察到的行为：见步骤 14–16（全部收敛、对账与恢复符合 W1/W2 契约；在途刷新后无中间态停滞）

## 与 echo 录制的差异（如实）

- model-error-convergence 在本模式 NOT_RUN（无安全确定性注入），收敛机制由 echo 录制覆盖；
- response-loss-midstream 仅在本模式执行（echo 无在途窗口）——两份记录互补构成完整故障矩阵的浏览器面；
- 真实模型的回答内容由模型生成（逐字短语按指令执行），上下文隔离经渲染面 codeword 探针验证（与 API 面跑批器同法）。

## 本波发现（如实记录）

与 echo 录制相同（同 SHA、同一 UI 代码）：见 `20260929T144428Z-echo-product-loop.md`「本波发现」（aria 陈旧已修复；抽屉覆盖 Send 按钮/自身开关待 owner 裁决）。

## 复验命令

```bash
git clone https://github.com/Lortzing/TreeAI.git && cd TreeAI
git checkout fcfae525cbc091a689c7c9e9a20a609c47a5eb46
node --version && npm --version   # 24.21.0 / 11.19.0
npm ci
# 受控 agent 目录内放非秘密 provider/model registry（deepseek/deepseek-flash）
TREEAI_STUDIO_API_KEY=… node scripts/run-d3-browser.mjs --mode real-pi \
  --provider deepseek --model deepseek-flash --agent-dir <受控目录> \
  --prompt-timeout-ms 120000
```
