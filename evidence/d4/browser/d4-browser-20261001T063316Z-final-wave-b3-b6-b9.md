# TreeAI D4 浏览器证据终波验收记录【echo driver】（B3 探针实现 + B9 导航面 + B6 规模面）

> **驱动类别：echo（确定性回声驱动）** —— 本记录是 echo driver 下的真实
> 浏览器检查，**不是真实 Pi 证据**；B3 的真实 Pi 浏览器录制属
> `run:d4-browser --mode real-pi`（探针代码已就位——同一路径两种模式共用，
> selftest 为机制冒烟并如实标注），待负责人凭据后在最终候选 SHA 执行。

## 基本信息

- 记录 ID：`d4-browser-20261001T063316Z-final-wave-b3-b6-b9`（summary runId
  `d4-browser-20261001T063316-86183`）
- 日期（本地时区）：2026-10-01（UTC 2026-10-01T06:30Z 起，全程约 8 分钟）
- 操作人（编号 / 角色）：scheduled-unattended / agent-K（d4-browser-face 波，
  issue #8 §8 验收入口——终波浏览器证据：B3 探针实现 / B9 导航面 / B6 规模面）
- commit SHA（运行时工作区 HEAD）：`3527387e7ca2e54de63e619dc0d7a4cec62c6f3e`
  （分支 `wip/d4-browser-face`，基于 main `f0e2fbf`）。`gitDirty: false`——
  运行时工作区零未提交改动（证据目录经临时 --artifacts 运行后另行拷入提交，
  与既有记录同款纪律）。
- 记录类别：☑ 浏览器 UI 级操作　☑ 冻结集对照（B1/B2 复跑）　☑ 生成器语料
  对照（B9/B6 结构真值）　☐ 真实 Pi（本记录为 echo；B3 real-pi 探针已实现）
  　☐ 设计对照录屏　☐ 独立试用
- 驱动方式：入仓浏览器面验收器 `scripts/run-d4-browser.mjs` **v0.4.0**
  （`--mode selftest`）spawn 真实 Studio CLI（echo 驱动）+ 本机 Chrome
  headless（CDP over DevTools WebSocket）；页面内操作为真实 DOM/输入事件
  （CDP `Input.dispatchMouseEvent` 真实点击 / `Input.insertText` 真实键入 /
  `Input.dispatchKeyEvent` 真实方向键 / `DOM.setFileInputFiles` 真实文件
  选择）；已知布局缺陷覆盖区的点击按既有 DOM click 约定兜底（见「前端缺陷」）；
  B3 响应丢失注入经 CDP Fetch 域 **Response 阶段** failRequest（请求已到
  服务端并完整落地，仅响应被丢弃——真实传输层模拟）。

## 环境

- Node：24.21.0 / npm：11.19.0（与锁基线一致）
- 浏览器：HeadlessChrome 153.0.8010.37（`--headless=new`，CDP；127.0.0.1
  本地回环，无外网）
- OS：macOS 26.6.2 arm64；CPU 10× Apple M4；总内存 16 GiB；视口 1280×900
- 并发披露：并行 D4 波代理可能在本机构建——各计时面 loadavg 已入 sidecar
  （nav 起 [2.42, 2.24, 2.19] → 终 [1.89, 2.11, 2.14]；b6 起 [1.89, 2.11,
  2.14] → 终 [2.06, 2.11, 2.14]）；p95 落入限额 80% 带内的计时探针按纪律
  复测一次、两次都记录（本次 nav/b6 的 p95 均远离带内——未触发复测）
- 冻结集绑定：`tests/fixtures/d4/MANIFEST.sha256` 的 SHA-256 =
  `dc4a18f58da9803174c3686c36a66d485c61c64de4fa0c8d021a399bef44f2202`；
  使用 fixture 34 项（B1 全分母 + 负例 + 版本对；B2 真值）；**B9 数据集
  （种子 d4-b9-2026-09-30，100 树 / 10100 分支行，生成+装载 1392ms）与
  B6 特产（种子 d4-b6-2026-09-30，100 材料 / 恰 1,000,000 单元 / 1010 分支
  / 10000 保存事实，生成 16520ms + 装载 649ms）按冻结 spec 确定性生成、
  不入仓**；B3 的 pdf 语料为 B1 冻结集 pdf-01。

## 结果

**14 PASS / 0 FAIL / 0 BLOCKED / 0 NOT_RUN，退出码 0。**（v0.3.0 基线为
10 PASS / 2 NOT_RUN——本次 +4：B3 branch/return 两检查执行 + B9 nav-browser
+ B6 scale-browser 两检查新增。）

## 逐检查结果

1. chrome-boot / studio-boot / page-load / console-clean：照旧全绿。
2. d4-import-material / d4-import-denominator / d4-read-and-select：复跑
   照旧全绿（B1 24 ready + 11 负例、B2 13 选区、真实鼠标手势）。
3. **d4-branch-from-material（B3 探针实现，echo 冒烟——非 B3 证据）**：
   md-01 + pdf-01 武装选区 → 建枝 → 提交前材料范围声明（标题/版本/块/
   UTF-16 区间/摘录逐项断言）→ 首问（md：真实双击 submit → 恰 1 条
   user turn + assistant 回答；pdf：**注入响应丢失**（1 条 material-first-
   question 响应被 Fetch 域丢弃，服务端已落地）→ 同键重试 → 幂等重放注记
   + 恰 1 条首问）→ 每枝 2 轮追问 → 跨枝隔离（md 6 turns / pdf 6 turns，
   标记零泄漏）→ 同端口 SIGTERM 重启续走（历史可读 + 新追问落地）。
4. **d4-return-from-material（B3 探针实现，echo 冒烟——非 B3 证据）**：
   两枝面板 ⌖ View source 回原文（锚定版本 + 块定位 + 精确摘录在场；
   pdf 页文本层选区）→ Return 经真实 UI 提交（草稿预填按真实用户路径
   全选替换）→ 主线材料 Return 卡（来源字段 + 精确摘录 + View material
   source 跳转）→ Return 卡再跳原文 → 重启后 Return 卡与支线历史可读。
5. d4-restart-continue / d4-search-recover / d4-export-restore-recover：
   复跑照旧全绿（材料计数改按 API 实况——B3 探针在场景树合法追加 pdf-01）。
6. **d4-nav-browser（B9 浏览器面）**：B9 数据集真实生成（不变量 0 问题）
   → 真实装载器入专用数据目录 → 真实 studio 进程。度量（本地机器工程
   证据）：
   - b9-big（5000 节点）初次打开至可操作 **63.7ms ≤ 2s**；
   - **54 次计时展开/切换操作**（真值派生确定性顺序：expand/collapse/
     select/tree-switch/more-page/search-reveal；3 次 more 翻页被应用自身
     按需续页泵抢先——如实记 pump-preempted）**p95 40.2ms ≤ 300ms**
     （median 20.1ms / max 107.2ms）；
   - 虚拟化：滚动偏移采样 DOM 行 ≤34（窗口行高 34px 口径），而 b9-wide
     221 行全量在场；b9-big 5000 节点对 14 DOM 行；
   - 键盘：9 步（Home/→/↓×4/End/Home/←/→）焦点全程保持在焦点行
     （.focused + activeElement），End/Home 大跳与收起/重展开后焦点不丢；
   - 展开状态跨真实 SIGTERM 进程重启：GET expand-state 逐字节恒等
     （选中 b9-deep-c020 + 展开 100 节点），UI 重开恢复（路径行 + 选中行
     滚入后 .active）；
   - 结构真值抽样对照 11 项（命中行完整路径/深度/来源、完整路径行父链、
     材料来源节点 ⌖Source of selected 跳转开阅读器于锚定块 + 摘录）。
7. **d4-b6-scale-browser（B6 浏览器面）**：B6 特产真实生成（CLI 子进程）
   → 真实装载器 → 真实 studio 进程。度量（本地机器工程证据）：
   - **30 次现有材料打开至可读（真实侧栏点击）p95 28.8ms ≤ 2s**（median
     22.4ms / max 30.4ms；长 PDF 首页文本层渲染完成才算可读——可见页先行）；
   - 翻页响应：长 PDF（59 页）+ 长 md（221 块）逐页翻阅 **无 >200ms 主线
     程段**（longtask 0 条；步延迟 = 滚动写入→下一帧 p95 9.7ms / 76 步）；
   - 输入响应：翻阅进行中 Search 输入框真实键入（keydown→落值→下一帧）
     **keystroke-to-render p95 20.3ms ≤ 200ms**（38 键；产品搜索为显式
     提交制——输入回显路径如实度量）；
   - 取消响应：**结构性发现（如实记录）**——单线程 studio + 同步解析器下
     解析任务持有事件循环，取消 POST 排队其后（409）；10MiB/100 页样例
     在本机解析仅数百毫秒，连页内 MutationObserver 反射点击都错过窗口。
     浏览器侧保留导入至 ready 实测 **615ms ≤ 30s**（真实导入 UI：CDP 文件
     注入 + 应用自身上传/解析/状态管线）；取消响应性裁决归离线
     b6-scale-performance 的门控解析器测量（其用门控的原因正在于此）；
   - 搜索命中渲染（证据记录）：10 条冻结 needle 查询 p50 195.2ms /
     p95 223.7ms（服务端 p95 归离线行）；冷启动 DCL 20.6ms。

## 前端缺陷（本波发现，报告不修——owner 裁决；证据见 sidecar frontendBugs）

1. **#branch-section 塌缩**（b3 探针，elementFromPoint 证据）：侧栏唯一
   flex:1 区块 #branch-section（min-height:0）在其余区块（Forest/Navigate/
   Materials/Search，均 flex-shrink:0）合计高度逼近视口时被压到 height 0
   ——分支 tab 全部被裁剪不可点击（实测 1280×900；1b48ef0 只修了
   tree-list/material-list 的内部滚动）。探针以 DOM click 兜底继续行使
   面板路径。
2. **#nav-section 溢出被覆盖**（nav 探针，区块几何 + elementFromPoint 证据）：
   #nav-section（flex:1.2 1 0 + min-height:220px）内容（finder + 树视图，
   min-content ~500px）超出分配高度时溢出区块盒，溢出的树滚动器按绘制序被
   后继 #materials-section 覆盖。**1280×900/1400/2000/2200 视口全部复现**
   （视口越高 forest 22vh 上限与 branch-tabs 越吃空间）——工作台开着带
   材料的树时（常态）导航树在任何常见窗口尺寸不可点击。探针以 DOM click
   兜底（虚拟化窗口内的行仍在 DOM；计时不含输入命中测试 ~1-5ms，方向
   乐观，sidecar 声明）。
3. **选中行可在虚拟化窗口外**（nav 探针）：应用自身选中流偶发把选中行留
   在渲染窗口外（路径行正确而树内无 li.nav-item.active——焦点滚动与窗口
   重划竞态；滚回窗口后 .active 在场，抽样断言）。

## 计时口径（诚实披露）

- 逐操作计时 = 页内 MutationObserver 结算探针（t0 于安装时刻，距真实
  点击 1-2 次 CDP 往返 ~1-5ms 计入，方向保守）；结算条件在页内 20ms tick
  + DOM 变更时求值，无轮询量化误差。
- B9/B6 的 p95 为本地机器工程证据（环境全记录于 sidecar），不跨机器宣称；
  最终候选 SHA 回归将重跑 run:d4-browser。

## 复验条件

`node scripts/run-d4-browser.mjs --mode selftest`（同 commit、同机器）；
`npm run verify:d4` 的 b6-browser-face / b9-nav-browser-face 审计行绑定
本证据目录（runId / gitCommit / 度量齐全性校验）。
