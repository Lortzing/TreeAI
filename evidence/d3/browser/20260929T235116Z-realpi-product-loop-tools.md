# TreeAI D3 浏览器 UI 级操作记录【真实 Pi + 工具门 · 维护波重绑（浏览器面）】

> **驱动类别：真实 Pi（DeepSeek `deepseek-flash`）+ 工具策略门（`--pi-tools
> read`）+ 模型错误注入引导** —— 跑批器 `run-d3-browser.mjs` **v1.3.2**
> （维护波跑批器硬化：`--agent-dir` 旗标 + summary 写盘 off-by-one 修复）
> 在维护波终点 SHA `a88ace5` 上的全检查录制：本轮目的是把浏览器面真实
> 模型证据从 `361f528`（`20260929T223539Z-realpi-product-loop-tools.md`，
> v1.3.1）**重绑到 `a88ace5`**（该 SHA 相对 `361f528` 增加 tool-policy 包
> 入口、W1 服务测试、跑批器硬化与 SDK 驱动包源重接线及 evidence 文档；
> UI 静态文件零变化）。同一剧本与断言面，与本波 SDK 面 / API 面（同波
> `../real-pi/20260929T234756Z-tool-policy-sdk.md`、
> `../real-pi/20260929T234859Z-product-loop-tools.md`）汇合。

## 基本信息

- 记录 ID：`d3-browser-20260929T235116Z-realpi-product-loop-tools`
- 日期（本地时区）：2026-09-30（UTC 2026-09-29T23:49:55–23:51:16Z，全程约 81 秒）
- 操作人（编号 / 角色）：claude-code-treeai-loop / 授权操作者
- commit SHA（运行时绑定，跑批器 stdout 为准）：
  `a88ace54c8e5a0895a78a755d16ce3563cd1516f`（workspace HEAD；运行于该
  SHA 的隔离 worktree 分支 `rec-realpi-a88ace5`，porcelain 干净；
  summary.json `git.dirty=false`）
- 记录类别：☑ 浏览器 UI 级真实 Pi 操作　☑ 故障注入　☑ 权限拒绝路径　☐ 独立试用
- 驱动方式：`node scripts/run-d3-browser.mjs --mode real-pi --provider
  deepseek --model deepseek-flash --pi-tools read --agent-dir <受控目录>
  --prompt-timeout-ms 480000`（真实 Chromium/CDP + 真实输入事件：拖选、
  ⌘/Ctrl+Enter、Esc 分层、原生输入管线；两段式引导 + 模型错误注入引导；
  前置 `npm ci` + `npm run --workspace @treeai/event-journal build:test`）

## 环境

- Node 24.21.0 / npm 11.19.0（锁基线）；Pi（`@earendil-works/pi-coding-agent`）0.85.1
- Chrome headless（CDP，本地回环）：Chromium `Chrome/153.0.8010.37`
- 视口 1280×900——**≥1180px：全程真实运行于并置支线列布局**（支线面板
  打开恰好覆盖常驻列、主干阅读宽度不随开合变化；`#conversation` 为真实
  内部滚动器——附-5 选项 A 骨架）；窄窗检查项以 480px 媒查真实命中
- 凭据说明：API key 仅经 `TREEAI_STUDIO_API_KEY` 环境注入；值未入记录/
  日志/evidence（跑批器只检查变量名）
- OS / 目标机器：macOS（arm64），本机 trusted-local（**非**负责人目标 Mac 人工逐屏录屏口径）

## 结果

**30 PASS / 0 FAIL / 0 BLOCKED / 0 NOT_RUN**（退出码 0；零 escape 轮、
零重试）。逐面事实：

| 面 | 实测 |
| --- | --- |
| 主剧本（boot / 建树 / 主线两轮（⌘+Enter 键路径）/ 双支线各两轮（Ctrl+Enter）/ 交叉切换 / 无串线（含 session entry parentId 路径证明）/ Return 草稿→确认→`deliveredRunId` 送达反查（t3 run 服务器验证）） | 全 PASS（主干全程语义保持） |
| 故障注入（SIGKILL 重启收敛（3 分支/干线全保）/ 缺失 session 降级+恢复 / 真实模型流中整页重载响应丢失（对账收敛、状态 succeeded）/ 错误配置 registry（不可路由 baseUrl）经产品 CLI 引导 → 502 `unknown` 失败呈现（banner role=alert、持久失败面板、composer 复能、零回合）→ 原配置重启+重载重建失败呈现后同树 `failed(unknown) → succeeded`） | 全 PASS |
| a11y / 窄窗 480px（媒查真实命中、抽屉自底向上 `drawer-up-in` 全宽、`#run-detail` 收起）/ reduced-motion 计算样式坍缩（0.01ms） | 全 PASS |
| A2 三深选区（真实拖选，动态期望） | 长答案后段 **13971–13996**（13997 字符答案、深度 0.998，25 字符摘录 ≪ 答案、无整答回退）；重复词**第二处** **12853–12858**（首处 4731）；跨行 **7788–7891**（恰一个换行、原生多 rect、两端不同渲染行）——三面全等（浏览器 === 面板摘录 === 服务器 `origin.selection`）、揭示切片恰切、锚定支线可续聊、相末主树计数不变（3 分支 / 11 干线回合）——偏移与 `361f528`/`0f9df98`/`699b2d8`/`6bddec5` 四波**逐字节一致** |
| A5 工具门（两段式引导 / marker 读入端到端（run `run_edd6a610…`，答案携带 marker、抽屉呈现读活动、marker 内容到达探针 session 文件）/ 越权读**执行前拒绝** fail-closed（run `run_e67d0b16…`，converged failed(policy-denied)、零回合落库、页面与服务一致、composer 复能）/ 拒绝来源三面呈现（抽屉 + journal + API 交叉核（allow 规则 `allow-read-configured-roots`、deny 无规则）、无路径/参数外泄）/ canary 16 文件扫描不出现（渲染页面含打开的抽屉无 canary） | 全 PASS |

另：console-clean 全程零非预期页面 console/Log 错误。summary 快照见同记录
ID sidecar 目录 `summary.json`（v1.3.2 修复后写盘时点与 stdout 一致：
checks 数组 30 项全 PASS，含最后一项 `console-clean`——`361f528` 记录中
「29 PASS 早于 console-clean 登记、stdout 30 为准」的已知诚实口径已消除）。
截图等二进制不入仓（artifacts 目录仅本地留档，占位 `<dir>`）。

## 本波发现

无失败尝试、无模型方差 escape 轮。维护波注记：(1) 本跑为跑批器 v1.3.2
（`ae5912b`：`--agent-dir` 旗标 + summary 写盘 off-by-one 修复）的**首次
真实模型全检查实录**——summary.json checks 数组 30 项与 stdout 完全一致，
修复在真实模型面得到验证；(2) studio 工具门引擎经 `@treeai/tool-policy`
**包源直载**（`7e8dcdd` 重接线后零 `#tool-policy` 编译前置——本 worktree
全程无任何 tool-policy 编译产物）完成 A5 浏览器面真实模型实录属首次，
A5 各项与 `361f528` 基线逐项一致；(3) 维护波产品代码变更不涉 UI 静态
文件，全项与 `361f528` 基线逐项一致，三深选区偏移连续第五波逐字节
不变；(4) worktree 内经 `--agent-dir` 旗标全程指向主检出受控 agent 目录
（`~/.pi` 未使用，misconfig 副本照常由跑批器自建临时目录隔离）。本跑后
浏览器面绑定 `a88ace5`，三面真实模型证据同 SHA 汇合。
