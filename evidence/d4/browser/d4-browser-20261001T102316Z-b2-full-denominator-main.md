# TreeAI D4 浏览器证据验收记录【echo driver】（B2 选区全分母——合并主 SHA 复跑）

> **驱动类别：echo（确定性回声驱动）** —— 本记录是 echo driver 下的真实
> 浏览器检查，**不是真实 Pi 证据**（B2 选区语义不依赖模型回答）。它是
> B2 全分母波的**合并主 SHA 复跑**：分支证据与逐项细节见
> [`d4-browser-20261001T100925Z-b2-full-denominator.md`](./d4-browser-20261001T100925Z-b2-full-denominator.md)，
> 本记录只登记主 SHA 全量结果与合并复验。

## 基本信息

- 记录 ID：`d4-browser-20261001T102316Z-b2-full-denominator-main`
  （summary runId `d4-browser-20261001T102316-89618`）
- 日期（本地时区）：2026-10-01（UTC 2026-10-01T10:23Z 起）
- 操作人（编号 / 角色）：scheduled-unattended / 协调会话（issue #8 §8
  验收入口——B2 浏览器选区全分母波的合并复验）
- commit SHA（运行时工作区 HEAD）：
  `d7419ec40d400eabad01638752747e236067f26a`（**main 合并提交**——
  `wip/d4-browser-b2-full`（tip `a64f560`）并入 `e4b7445` 的 no-ff 合并；
  相对分支代码 tip `ba53562` 的差异仅为证据/文档）。在 detached worktree
  干净检出运行，`gitDirty: false`（summary.json 结构化记录）；证据目录经
  临时 `--artifacts` 运行后拷入提交（`diff -rq` 逐文件核对字节一致）。
- 记录类别：☑ 浏览器 UI 级操作　☑ 冻结集对照（B1/B2 复跑铺满）　☐ 真实
  Pi（echo；B2 语义不涉模型）　☐ 设计对照录屏　☐ 独立试用
- 驱动方式：入仓浏览器面验收器 `scripts/run-d4-browser.mjs` **v0.4.0**
  （`--mode selftest` 全量，无 --only）spawn 真实 Studio CLI（echo 驱动）+
  本机 Chrome headless（CDP over DevTools WebSocket）；页面内操作为真实
  DOM/输入事件。

## 环境

- Node：24.21.0 / npm：11.19.0（与锁基线一致）
- 浏览器：HeadlessChrome 153.0.8010.37（`--headless=new`，CDP；127.0.0.1
  本地回环，无外网）；视口 1280×900
- OS：macOS 26.6.2 arm64；CPU 10× Apple M4；总内存 16 GiB
- 冻结集绑定：`tests/fixtures/d4/MANIFEST.sha256`（summary.json 记录
  manifest SHA-256 与使用 fixture 清单——34 项，B1 全分母 + 负例 + 版本对
  + B2 三份真值）

## 结果

**14 PASS / 0 FAIL / 0 BLOCKED / 0 NOT_RUN，退出码 0。**

其中 `d4-read-and-select`（本次扩分母主体）：

- **45/45 markdown + 30/30 PDF 冻结选区**在真实阅读器逐个精确捕获
  （数据驱动、唯一 id 计数差一即失败）；类别覆盖 markdown
  code/combining/cross-line/emoji/en/links/long-tail/repeat-word-2nd/
  unicode/zh（md-01..md-12）与 PDF code/cross-line/en/fonts/footer/header/
  long-tail/multipage/repeat-word-2nd/two-column-left/two-column-right/
  unicode/zh（pdf-01..pdf-12；30 页 pdf-11 全部分页到场）；
- 每个目标 PDF 页的已渲染文本层与冻结页块**逐字节无损**后才捕获；
- **3 个真实鼠标手势**：md 两击（md-sel-01）、md 连续拖选（md-sel-02）、
  **pdf 连续拖选（pdf-sel-01，页文本层上）**；
- 字素分裂外吸附；跨块拒绝（markdown）；**跨页拒绝（PDF，冻结负例
  inv-08/inv-09——零载荷、绝不静默截断）**；
- 全部选区经真实后端 resolve-selection 复核（含 sourceHash = 冻结
  canonicalText 的 SHA-256）；复制摘录剪贴板回读字节相等。

其余 13 项检查与终波记录（`d4-browser-20261001T063316Z`）同语义全绿
（B1 全分母 24 ready + 11 负例、B3 echo 用户路径、B5 导出恢复组合路径、
B9 导航面 p95 50.3ms、B6 规模面 opens p95 29.1ms 等——逐项以
`summary.json` 与 sidecar JSON 为准）。

## 合并复验（同 SHA `d7419ec`，主检出串行执行）

- `npm run typecheck`：PASS（7 个有源码 workspace）
- `npm test`：**767/767，0 fail**（58+73+58+73+382+112+8+3）
- `npm run verify:d4`：**18 PASS / 0 FAIL / 0 BLOCKED / 2 NOT_RUN**，exit 3
  （NOT_RUN = b7/b8 负责人门禁；证据 `evidence/d4/runs/d4-offline-20261001T102017805Z`）
- `npm run verify:d4:selftest`：控制组 + 7 项故障注入全部检出
- `npm run verify:d2`：**21 PASS / 0 FAIL / 0 BLOCKED / 1 NOT_RUN**，exit 3
  （NOT_RUN = D1 live 显式门控；证据 `evidence/d2/runs/d2-offline-20261001T102130913Z`）
- 基线对照：合并前基线（`e4b7445`，独立 worktree）同样全绿
  （767/767、18-0-2、8/8、21-0-0-1）——本波零回归。

## 限制与如实声明

- echo 驱动：不构成 B3 真实 Pi 证据（B3 的真实 Pi 记录为
  `d4-browser-20261001T081056-32568-realpi-b3` @ `c169745`；最终候选 SHA
  按 D4-status 复验条件重跑）。
- 键盘驱动选区在 headless Chrome 153 不可用（`Input.dispatchKeyEvent`
  不驱动原生 caret/选区——既有已知限制，非本波引入）。
- 结构性观察（未改产品）：从顶部到达 >10 页 PDF 的末页需要多次滚动
  （可见页渲染契约成立）。
