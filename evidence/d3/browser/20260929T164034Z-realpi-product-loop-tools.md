# TreeAI D3 浏览器 UI 级操作记录【真实 Pi driver + A5 工具策略门】

> **驱动类别：真实 Pi（DeepSeek `deepseek-flash`）+ 工具策略门（`--pi-tools read`）**
> —— 真实模型驱动的真实浏览器 UI 录制，两段式引导：主剧本全程零工具，
> A5 工具相 SIGKILL 后以工具缝重启同一数据目录。**不是 echo 录制**；
> 同 SHA 的 echo 自检见 `20260929T164034Z` 波次（21 PASS ×3 连续绿，
> 未单独立档——以本记录「与 echo 录制的差异」节与 D3-status 行为准），
> 零工具的真实 Pi 浏览器录制见 `20260929T144350Z-realpi-product-loop.md`。

## 基本信息

- 记录 ID：`d3-browser-20260929T164034Z-realpi-product-loop-tools`
- 日期（本地时区）：2026-09-30（录制时刻 00:40–00:41 本地；UTC 2026-09-29T16:40:34Z）
- 操作人（编号 / 角色）：scheduled-loop / integrator（受控凭据环境，见下）
- commit SHA（运行时工作区 HEAD）：`1c8495927260b67efe486a56d28071c6b9ff173e`
  （跑批器 stdout 首行 `workspace HEAD: …` 为准；gitDirty 构成：**已跟踪文件零改动**，
  未跟踪条目为历史运行产物目录与本机配置，运行时代码与该 SHA 一致）
- 记录类别：☑ 浏览器 UI 级操作　☑ 真实 Pi 操作　☑ 故障注入　☑ 幂等测试　☐ 设计对照录屏　☐ 独立试用
- 驱动方式：入仓浏览器面跑批器 `scripts/run-d3-browser.mjs` **v1.1.3**（`--mode real-pi
  --provider deepseek --model deepseek-flash --pi-tools read --prompt-timeout-ms 240000`）
  spawn 真实 Studio CLI（`--driver pi`，两段式：零工具引导 → 工具缝重启）+ 本机
  Chrome headless（CDP over DevTools WebSocket），以真实输入事件（鼠标点击 / 拖选、
  键盘提交、原生输入管线文本注入）驱动真实 UI

## 环境

- Node：24.21.0 / npm：11.19.0（与锁基线一致）
- Pi（`@earendil-works/pi-coding-agent`）：0.85.1（锁基线）
- 浏览器：Chrome 153.0.8010.37（headless，CDP 通道；127.0.0.1 本地回环）
- provider / model：deepseek / deepseek-flash（受控 agent 目录内非秘密 registry——
  目录为 D2 live 校验器同一受控 `.pi-d2-live/`，models.json 仅含 provider/model 定义；
  目录不入仓，Git 已忽略）
- Studio 启动参数（两段，横幅为准）：
  - 零工具段：`--driver pi --provider deepseek --model deepseek-flash --port <本地>
    --data <临时数据目录> --agent-dir <受控目录>`；横幅 `pi agent-dir=… (controlled;
    ~/.pi is not used)`、`pi api key=TREEAI_STUDIO_API_KEY env, in-memory only`，
    **无任何 tools 行**（零工具基线）。该段内含两次 SIGKILL 重启
    （server-restart-recovery 一次、工具相引导一次），重启后横幅同口径；
    journal 重载计数 645（server-restart 后引导）→ 1016（工具相引导）事件——
    数据目录跨三次引导存续本身即 A4 证据
  - 工具段（tool-policy-boot 内 SIGKILL 后同一数据目录重启）：追加
    `--pi-tools read --policy-read-roots <data>/workspace/policy-allowed`（缺省收窄，
    跑批器显式传入）；横幅 `pi tools=read (allowlist; every tool call is
    policy-gated before execution)`、`pi policy read-roots=<dir>/workspace/policy-allowed
    (--policy-read-roots); writes/shell/network denied (fail closed)`
- 凭据说明：API key 仅经 `TREEAI_STUDIO_API_KEY` 环境注入；值未写入记录、日志、
  数据库或 evidence（跑批器只检查变量名；两段引导横幅均已核对，只出现变量名）
- OS / 目标机器：macOS（arm64），本机 trusted-local；**非目标 Mac 逐屏录屏口径**
  （真实浏览器渲染与输入管线录制，不替代负责人目标机人工验收）
- 视口：1280×900 与 480×800（窄窗断言）
- prompt 超时：240000 ms（真实模型时延余量；本轮实测全部回合秒级收敛，
  允许 read run 00:40:56 → 00:40:58（2s）、deny run 00:40:59 → 00:41:00（1s），
  全程 26 秒）

## 操作步骤（逐条）

前提：临时数据目录全新；受控 agent 目录内为非秘密 DeepSeek provider/model registry。
跑批器对 **27 项检查**逐项登记，本记录按其 stdout 事实誊录（状态词 PASS / FAIL /
BLOCKED / NOT_RUN 沿用 D2 约定）。结果：**26 PASS / 0 FAIL / 0 BLOCKED / 1 NOT_RUN**，
退出码 0；期望口径一致（唯一 NOT_RUN 为 model-error-convergence 模式门控）。

### 第一段：零工具引导上的产品闭环与故障矩阵（21 项检查）

1. chrome-boot / studio-boot / page-boot：CDP 通道建立；pi studio `/api/health` ok；
   页面渲染、空态、启动焦点「新建」。
2. tree-create：真实点击建树 → 树视图、Trunk 页签。
3. trunk-main-line：两轮真实模型主干 prompt（第 2 轮 **⌘+Enter**）→ 4 turns 渲染；
   API `/state` 一致（4 turns 服务端）。真实模型按指令逐字回短语。
4. selection-anchoring：第 1 轮真实答案上**真实拖选**（24–52 区间）→ `.has-selection`
   + 「⑃ Branch from selection」。
5. branch-a-create：点击 → 支线 A 建立（面板「Branch 1」、锚点摘录 = 拖选文本）。
6. branch-a-followups：两轮追问（第 2 轮 Ctrl+Enter）→ 面板 4 turns；a2 列举答案
   **「maple, cedar」**（真实模型如实列出本支线可见词）。
7. switch-navigation：面板⇄主线往返（真实点击）；主线回合不受支线影响。
8. branch-b-create：第 2 轮答案不同子区间（30–61）拖选建支线 B（「Branch 2」）。
9. branch-b-followups：两轮追问 → 面板 4 turns；b2 列举答案 **「birch」**（真实模型
   只列了本支线暗号——列举措辞方差，非串扰；见下一步）。
10. no-context-bleed（渲染面 + session 路径双侧）：B 面板含 birch、无 cedar；
    **正向可见性经 session entry 树的 parentId 路径机械证明**（跑批器 v1.1.2 起）：
    B 的 turn-two 用户 entry 走到根的路径含 maple + 4127 + birch、绝不含 cedar；
    A 的路径含 maple + cedar、绝不含锚点后的 4127 与 birch。切回 A 面板经标题证实
    真切换（v1.1.3 起），A 面板含 cedar、无 birch。
11. return-flow：支线 A 面板（源支线经面板标题断言，v1.1.3 起）Return 草稿
    （预填上一答案 → 全选覆盖）→ 提交 → 主干 anchored 卡待送达；抽屉
    「not yet delivered」；服务端 `deliveredRunId: null`；**经抽屉头部 `#drawer-close`
    真实点击收起**（附-4 落地路径；Esc 路径覆盖在 a11y-semantics）。
12. return-delivery：主干第 3 轮 prompt → 真实模型逐字引用 aspen 标记；卡片徽标
    → delivered；服务端核对 `deliveredRunId` === 该轮 run。
13. NOT_RUN（预期）：model-error-convergence —— 见下方「NOT_RUN 口径」。
14. server-restart-recovery：**SIGKILL** → 页面下一动作诚实错误横幅；同数据目录重启 +
    整页刷新 → 树 / 3 分支 / 回合完整；主干续聊（真实模型）可用。
15. missing-session-degradation：移走 session 文件（1 个）→ 刷新 → 横幅 + fail-closed
    composer + 恢复动作（禁用并给出原因）；还原 → 刷新完全恢复。
16. response-loss-midstream（真实模型时延窗口下的在途整页刷新）：发送 prompt 后
    流式进行中**整页刷新** → 刷新后页面以权威状态对账：流式占位清除、run-status
    回 idle、run 终态 succeeded、答案完整落库渲染（无悬空占位/无中间态停滞）。
17. a11y-semantics：`#error-banner` role=alert + Tab 可达；抽屉 `aria-expanded` 双向 +
    Esc 关闭（焦点还原）；`#panel-anchor-context` tabindex=-1。
18. narrow-window-layout：480px——开关可见、`#run-detail` 隐藏、侧栏开合 aria 语义；
    抽屉底部上滑（`drawer-up-in`、全宽 480px）vs 宽窗右侧 360px。
19. reduced-motion：reduce 仿真 → 计算样式 0.01ms 折叠；复位 0s。
20. console-clean：全程（含工具相）零意外页面 console/Log 错误。

**第一段检查表（逐项誊录 stdout）**

| # | check | 期望 | 实测 |
| --- | --- | --- | --- |
| 1–20 | chrome-boot → console-clean（除 13） | PASS | 全部 PASS |
| 13 | model-error-convergence | NOT_RUN（模式门控，预期） | NOT_RUN |

（逐项明细与 stdout 原文见跑批器日志誊录于「复验命令」——本表按序号区间合并，
逐项状态词无一处与期望不符。）

### 第二段：A5 浏览器面 ToolPolicy（5 项检查，工具缝重启后）

> 与 API 面记录 `evidence/d3/real-pi/20260929T124851Z-product-loop-tools.md` 的
> 第二段同法，断言面抬到渲染 DOM。

- `tool-policy-boot`：SIGKILL 零工具 studio → 同一数据目录以 `--pi-tools read`
  引导重启（横幅三处 provenance：tools allowlist、生效读取根、受控 agent 目录）。
  场景布局以 realpath 两侧包含性证明兜底：marker 位于读取根内，canary 位于
  workspace 内、所有读取根之外。真实 `#new-tree` 点击开**全新探针树**（干净
  session；主树计数恒为无工具基线）。
- `tool-policy-allow-read`：真实 composer 发 allow 提示（读取根内 marker 文件）→
  真实模型调用 read → 回答含 marker token（run `run_c9b16049…`，2 秒收敛）；
  渲染抽屉 Tool activity 呈现 `· read started`；API 交叉核对探针 session 文件
  含 marker 首行（read 真实执行的机械证明）；`#drawer-close` 收起。**零逃逸轮**
  （模型首次即读取）。
- `tool-policy-deny-fail-closed`：overreach 核心——提示读取 canary（workspace 内、
  所有读取根之外）→ **执行前拦截**（run `run_0d701d61…`，1 秒收敛）：常驻失败面板
  「Run run_0d701d61… failed — policy-denied: tool execution was blocked by tool
  policy: read target resolves outside every configured read root; no rule allows it」、
  composer 复位、页面与服务器两侧**零回合落库**、`/diagnostics` runtimeState 回
  idle 且存在 failed(code `policy-denied`) run。**零逃逸轮**（模型首次即发起越权
  读取并被拒）。
- `tool-policy-deny-provenance`：拒绝 provenance 经**渲染抽屉**（用户实际看到的
  文本）：Runs 区 `run … failed · failure policy-denied`、Journal 区
  `tool.decision — tool policy decision on read: deny (no rule)` +
  `runtime.error — runtime error policy-denied` 行；API 交叉核对 journal 行与
  `/diagnostics` policyDecisions（allow ruleId = `allow-read-configured-roots`，
  deny ruleId = null）；渲染文本与诊断投影均不含 canary/marker 文件名、canary
  目录、读取根、两个 token。
- `tool-policy-canary-never-read`：受控 agent 目录 + 数据目录全树（12 个文件：
  sessions / journal / DB）逐文件扫描，canary 内容仅存在于其自身文件；渲染页
  两道扫描（结构化摘要含打开的抽屉 + `document.body.textContent`）无 canary token。

## 脱敏 ID 清单

- Tree / Branch / Return：跑批器 stdout 不回显这些 ID（只登记状态与计数），本记录
  如实按无 ID 登记；如需逐 ID 对照，可由负责人以同命令在同 SHA 复跑核对。
- Run（工具相两项，stdout 呈现前 12 位）：allow `run_c9b16049…`、deny
  `run_0d701d61…`。
- 附件 JSON（本目录）中的页面 DOM 摘要已按区域规则脱敏（本地路径 / HOME 占位符化，
  启动横幅中 agent 目录呈现为 `~/…` 相对形式）；摘要经 `data-turn-text` 携带完整
  回合文本（含真实模型回答与剧本提示词——剧本 codeword 为设计内探针词，非凭据）。

## 注入的故障（如无写"无"）

- 故障类别：宿主重启（SIGKILL + 同数据目录重启 ×2，含零工具→有工具二次引导）／
  缺失 session（移走后还原）／响应丢失（在途整页刷新）／**策略拒绝（overreach
  read 执行前拦截）**
- 注入方式：跑批器对 studio 子进程 SIGKILL（server-restart-recovery 与
  tool-policy-boot 各一次）；session 文件改名移走/还原；发送 prompt 后流式进行中
  `Page.navigate` 整页刷新；canary 文件置于 workspace 内、所有读取根之外
- 观察到的行为：见第一段步骤 14/15/16 与第二段全相（全部收敛、对账与恢复符合
  W1/W2 契约）

## 样式 / 布局抽查（真实浏览器计算样式）

| 抽查 | 期望 | 实测 |
| --- | --- | --- |
| 窄窗断点 @480px（`max-width: 719px`） | 命中 | 命中 |
| `#sidebar-toggle` 可见 / `#run-detail` 隐藏 @480px | 是 | 是 |
| 抽屉滑入方向：窄窗底部上滑（`drawer-up-in`、全宽）vs 宽窗右侧 360px | 是 | 是 |
| reduced-motion 仿真下计算 `animation-duration`/`transition-duration` | ≤0.01ms | 0.01ms 折叠，复位 0s |
| `#error-banner` role/tabIndex | alert / 0 | alert / 0（deny 相横幅真实呈现） |
| 抽屉开关 `aria-expanded` 双向 | 开 true / 关后立即 false | 是 |
| 附-4 `#drawer-close` 覆盖层下真实可点（elementFromPoint 防护） | 是 | 是（return-flow 与工具相均经此关闭） |
| 工具相：常驻失败面板含 `policy-denied` / composer 复位 | 是 | 是 |
| 工具相：抽屉拒绝 provenance 文本（tool.decision / runtime.error 行） | 是 | 是 |

## 与 echo 录制的差异（如实）

- model-error-convergence 在本模式 NOT_RUN（无安全确定性注入），收敛机制由 echo
  录制（`20260929T154300Z` 及此前各波）覆盖；
- response-loss-midstream 仅在本模式执行（echo 无在途窗口）；
- 本记录的 5 项工具面检查在 echo 模式整相 NOT_RUN（echo 驱动无工具执行器、
  `--pi-tools` 被拒），三者互补构成完整矩阵的浏览器面；
- echo 模式的 no-context-bleed 维持面板文本断言（回声语义确定）；真实模型模式
  的正向可见性经 session entry 路径机械证明（v1.1.2 起）——本轮 b2 模型只回
  「birch」，若仍依赖列举措辞该检查会再次假阴性。

## 本波发现（如实记录）

1. **产品缺陷：无新增**。三次录制尝试（`20260929T160209Z` 20/6、`161646Z` 25/1、
   `162759Z` 24/2）的全部 FAIL 经取证均为**跑批器检测竞态或真实模型措辞方差**，
   非产品行为问题；三轮中产品侧行为一致正确：越权读取执行前拦截（502
   policy-denied + 常驻失败面板 + 服务器零回合落库）、canary 零物化、
   marker 读取端到端（含 session 文件机械证明）。
2. 跑批器三轮加固（均在本次录制的 SHA 链上，逐项带取证）：
   - `09cc1b8`（v1.1.1）探针结局检测排除流式占位——占位一挂载即满足「新回答」，
     空占位被误读为逃逸回答（首轮三次 allow 全被误判，而渲染记录证明模型每次
     都真实读取了 marker）；
   - `13ae78d`（v1.1.2）真实模式 no-context-bleed 正向断言改为 session entry 树
     parentId 路径（列举措辞方差解耦；离线经合成 SDK 形状 entry 树验证）；
   - `1c84959`（v1.1.3）`waitForAnswerMarkers` 同样只数已完成回合（标记词在流式
     部分文本中提前出现即返回的竞态——第二轮后 b2 答案流式至 "birch" 一词时
     等待提前返回；第三轮还暴露了 prompt 响应重渲窗口吞掉 tab 点击的连锁）、
     支线 A 重开等待以面板标题证实真切换、return-flow 增加源支线断言。
3. 已知仪表行为（非本波引入）：`summary.json` 自 v1.0.0 起在 console-clean 检查
   体内写盘，故 stdout 27 行登记 vs summary.json 26 行（25 PASS + 1 NOT_RUN）；
   stdout 计数为权威口径。
4. 真实模型本轮全部回合秒级收敛（全程 26 秒），240 秒超时余量未触及；上一波
   （`218f9ca` 记录环境）的「凭据缺失 BLOCKED」不再存在——受控凭据经环境注入
   完成（见环境节）。

## 结果

- 结论：**PASS**（26/27 适用检查 PASS；1 项模式门控 NOT_RUN 如实登记；退出码 0）
- 与预期的偏差：无。

## 证据附件

- 录屏 / 截图归档位置（不入仓）：本机 `/tmp/treeai-d3-browser-tools-artifacts-20260929T164034Z/`
  （截图 .jpg 与完整逐检查 JSON 留存于运行机；含 studio.log / studio-tools.log
  两段引导横幅）
- 脱敏 JSON sidecar：`evidence/d3/browser/20260929T164034Z-realpi-product-loop-tools/`
  —— `summary.json`（26 行机器可读判定）+ 精选快照：`04-selection-anchoring`、
  `10-no-context-bleed`、`12-return-flow-drawer`、`18-response-loss-midstream`、
  `20-narrow-window`、`21-reduced-motion`、`22-tool-policy-allow-read`、
  `23-tool-policy-deny`、`24-tool-policy-deny-provenance`、
  `25-tool-policy-canary-never-read`
- 同 SHA echo 自检：`scripts/run-d3-browser.mjs` v1.1.3 三连续绿
  （21 PASS / 0 FAIL / 0 BLOCKED / 6 NOT_RUN ×3，退出码 0）

## 复验命令

```bash
git clone https://github.com/Lortzing/TreeAI.git && cd TreeAI
git checkout 1c8495927260b67efe486a56d28071c6b9ff173e
node --version && npm --version   # 24.21.0 / 11.19.0
npm ci
# 受控 agent 目录内放非秘密 provider/model registry（deepseek/deepseek-flash）
TREEAI_STUDIO_API_KEY=… node scripts/run-d3-browser.mjs --mode real-pi \
  --provider deepseek --model deepseek-flash --pi-tools read \
  --agent-dir <受控目录> --prompt-timeout-ms 240000
# 期望 26 PASS / 0 FAIL / 0 BLOCKED / 1 NOT_RUN（model-error-convergence 模式门控），退出码 0
```

## 复测（仅阻断问题修复后追加；不改写上方原始记录）

- 对应修复 commit SHA：不适用
- 复测日期 / 操作人：不适用
- 复测结论与残余问题：不适用
