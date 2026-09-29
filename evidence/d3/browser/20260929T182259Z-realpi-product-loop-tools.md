# TreeAI D3 浏览器 UI 级操作记录【真实 Pi + 工具门 + A2 深选区阶段 · 同一最终 SHA 汇总波（浏览器面）】

> **驱动类别：真实 Pi（DeepSeek `deepseek-flash`）+ 工具策略门（`--pi-tools read`）**
> —— 与 `20260929T164034Z-realpi-product-loop-tools.md`（`1c84959`，跑批器 v1.1.3）
> 同一主剧本的复跑，外加 v1.2.0 新增的 **A2 深选区阶段**首次真实模型录制。
> 本轮把浏览器面证据**绑定到汇总波的同一最终 SHA `699b2d8`**，与 API 面
> （`../real-pi/20260929T180929Z-product-loop-tools.md`）、SDK 面（同波
> `*-tool-policy-sdk.md`）与离线 manifest 同 SHA 汇合。

## 基本信息

- 记录 ID：`d3-browser-20260929T182259Z-realpi-product-loop-tools`
- 日期（本地时区）：2026-09-30（UTC 2026-09-29T18:21:56Z–18:22:59Z）
- 操作人（编号 / 角色）：scheduled-loop / integrator
- commit SHA（运行时绑定，跑批器 stdout 为准）：`699b2d883e11`（工作区标记
  dirty：构成为**未跟踪的非代码产物**——本波 record:d3 的 manifest 目录、一次
  SDK 驱动失败尝试遗留的 2 字节 stub 注册表目录与启动自检数据目录；**已跟踪
  文件零改动**，运行时代码与该 SHA 一致；运行于该 SHA 的 detached worktree）
- 记录类别：☑ 浏览器 UI 级真实 Pi 操作　☑ 故障注入　☑ 幂等测试　☐ API 面　☐ 独立试用
- 驱动方式：入仓浏览器面跑批器 `scripts/run-d3-browser.mjs` **v1.2.0**
  （`--mode real-pi --provider deepseek --model deepseek-flash --pi-tools read
  --agent-dir <受控目录> --prompt-timeout-ms 480000`，CDP 驱动本机 headless
  Chrome，真实输入事件：鼠标拖选/点击、⌘/Ctrl+Enter、Esc、原生输入管线）

## 环境

- Node 24.21.0 / npm 11.19.0（锁基线）；Pi 0.85.1；Chrome 153.0.8010.37（CDP）
- provider / model：deepseek / deepseek-flash（受控 agent 目录内非秘密 registry）
- 凭据说明：API key 仅经 `TREEAI_STUDIO_API_KEY` 环境注入；值未写入记录、日志、
  数据库或 evidence（跑批器只检查变量名）
- 数据目录：临时（跑批器自建，运行后清理）；截图不入仓（仅归档位置占位），
  脱敏 JSON 快照见同记录 ID 的 sidecar 目录（15 个文件）
- OS / 目标机器：macOS（arm64），本机 trusted-local headless Chromium（**非**
  负责人目标 Mac 人工面）

## 操作步骤（逐条，30 项注册检查）

结果：**29 PASS / 0 FAIL / 0 BLOCKED / 1 NOT_RUN**，verdict PASS，退出码 0。
唯一 NOT_RUN 为 `model-error-convergence`（真实 provider 无安全确定性注入的
既知门控；机制面由 echo `/fail` 覆盖、产品面由 API 跑批器 v1.2.0 的错配
registry 注入在同一 SHA 的 API 记录中覆盖）。

| # | check | 实测 | 备注 |
| --- | --- | --- | --- |
| 1 | chrome-boot | PASS | Chrome 153，CDP 连通 |
| 2 | studio-boot | PASS | driver pi，/api/health ok |
| 3 | page-boot | PASS | 空态可见，初始焦点落「新建」 |
| 4 | tree-create | PASS | 真实点击建树 |
| 5 | trunk-main-line | PASS | 两轮主干 prompt（t2 走 ⌘+Enter），4 turns，页面与 API 一致 |
| 6 | selection-anchoring | PASS | 真实鼠标拖选出原生选区，affordance 切换 |
| 7 | branch-a-create | PASS | 从真实选区建枝 A，面板带锚点摘录 |
| 8 | branch-a-followups | PASS | 两轮追问（a2 走 Ctrl+Enter），面板 4 turns |
| 9 | switch-navigation | PASS | 面板↔主干真实点击切换，互不串扰 |
| 10 | branch-b-create | PASS | 第二个主干答案上的不同锚点建枝 B |
| 11 | branch-b-followups | PASS | 两轮追问，面板 6 turns |
| 12 | no-context-bleed | PASS | 渲染面板无跨枝 codeword；session entry 路径（parentId 链）双向证明 |
| 13 | return-flow | PASS | 草稿预填 → 全选覆写 → 提交；主干 anchored 卡 confirmed；抽屉「未送达」；服务端一致 |
| 14 | return-delivery | PASS | 下一主干 run 采纳；卡徽标 → delivered；deliveredRunId === t3 run（服务端核实） |
| 15 | model-error-convergence | NOT_RUN | 既知门控（见上） |
| 16 | server-restart-recovery | PASS | SIGKILL → 下一动作诚实报错横幅；同数据重启 + 重载保全部 turns 与 3 枝，可续 |
| 17 | missing-session-degradation | PASS | session 文件移走 → 横幅 + fail-closed composer + 恢复入口；还原 → 重载全恢复 |
| 18 | response-loss-midstream | PASS | 流中重载收敛到权威态（占位清除、idle、答案在页） |
| 19 | a11y-semantics | PASS | 横幅 role=alert 可 Tab；抽屉 aria-expanded 双向 + Esc；锚点上下文可编程聚焦 |
| 20 | narrow-window-layout | PASS | 480px：toggle 可见、run-detail 隐藏、抽屉全幅 drawer-up-in（宽窗右侧 360px 对照） |
| 21 | reduced-motion | PASS | prefers-reduced-motion 计算样式坍缩 0.01ms，复位 0s |
| 22 | selection-deep-long | PASS | **13997 字符答案**尾部选区，精确偏移 13971–13996（深度 0.998，摘录 25 字符 ≪ 答案——无整答案回退）：浏览器选区 === 面板摘录 === 服务端 origin.selection；揭示切片精确；锚点枝可续答；**布局注记**：该答案长度下页面在文档层级滚动（#conversation 内部滚动器不激活——阅读位置记忆与 stick-to-bottom 绑定于它；产品发现，待负责人裁决，见决策单附-5） |
| 23 | selection-deep-duplicate | PASS | "alpha" **第二处**出现锚定于精确偏移 12853–12858（第一处在 4731——无首次匹配替换）：三面一致 + 揭示精确 + 可续答 |
| 24 | selection-deep-cross-line | PASS | 跨行选区精确偏移 7788–7891（恰含 1 个换行、摘录保留换行；原生多 rect 选区、端点在不同渲染行）：三面一致 + 揭示精确 + 可续答；**相末遏制核查**：深选区阶段前后主剧本树 3 枝 / 主干 11 turns 不变 |
| 25 | tool-policy-boot | PASS | 产品 CLI 工具引导：tools=read、1 个 read root；marker 在 roots[0] 内、canary 物理在所有 read root 之外；真实 new-tree 点击开新鲜探针树（干净 session） |
| 26 | tool-policy-allow-read | PASS | 真实 composer 走完放行读取（run `run_c29164c5…`）：答案含 marker、抽屉显示读取活动、marker 内容进入探针 session 文件 |
| 27 | tool-policy-deny-fail-closed | PASS | 越权读**执行前**被拒（run `run_dd8df5e4…` 收敛 failed(policy-denied) fail-closed），页 + 服务端零 turns，composer 复启，持久失败面板 |
| 28 | tool-policy-deny-provenance | PASS | 用户所见来源：抽屉「read denied — outside every configured read root [no rule]」+ journal tool.decision/runtime.error 行；API 交叉核实（allow 规则 allow-read-configured-roots、deny no-rule）；无路径/参数/token 泄漏 |
| 29 | tool-policy-canary-never-read | PASS | 15 文件扫描（受控 agent 目录 + 数据目录含 sessions/journal/DB）：canary 内容未出现；渲染页（含开着的抽屉）无 canary token |
| 30 | console-clean | PASS | 全程零非预期页面 console/Log 错误 |

## 本波发现

- **A2 深选区阶段（issue #6 P1）首次真实模型录制**：三场景（长答案尾部偏移 /
  重复词第二处 / 跨行）在真实 Chromium + 真实 deepseek-flash 生成的 13997 字符
  答案上以真实鼠标拖选完成，浏览器选区、面板摘录与服务端 origin.selection
  三面逐字节一致，无整答案回退、无首次匹配替换；相末遏制核查证明探针树阶段
  未扰动主剧本树计数。真实模型一次命中（零 escape 轮）。
- **产品发现（待负责人裁决，决策单附-5）**：约 1.4 万字符答案下页面在文档
  层级滚动——`#app` 为 `min-height`（非 `height`），`#conversation` 的
  `overflow-y: auto` 内部滚动器在真实浏览器中不激活（clientHeight ===
  scrollHeight），绑定于 `#conversation` 滚动事件的阅读位置记忆与
  stick-to-bottom 语义在该长度下不生效（scripted-DOM 测试直接操作
  scrollTop，不受布局影响，故此前未暴露）。跑批器如实将其记入
  selection-deep-long 的布局注记；修复方向（#app 限高让内部滚动器激活 /
  语义改绑文档滚动 / 接受现状）属产品契约变更，交由负责人裁决。
- 工具面零 escape 轮：allow 与 overreach 两个探针 prompt 均一次命中预期行为
  （对照 `164034Z` 记录三次尝试才全绿的模型方差窗口，本轮模型响应极快——
  全程 63 秒）。

## 结论（仅事实，不声明门禁）

- 同一最终 SHA `699b2d8` 上，浏览器面 29/30 项检查 PASS（唯一 NOT_RUN 为既知
  门控，其产品面已在同 SHA 的 API 记录覆盖），退出码 0；A2 的三深选区场景
  自此具备真实浏览器 + 真实模型证据（此前仅 scripted-DOM）。
- 剩余负责人侧事项不变：目标 Mac 逐屏人工对照（含屏幕阅读器）、W1 签署、
  3–5 人试用。
