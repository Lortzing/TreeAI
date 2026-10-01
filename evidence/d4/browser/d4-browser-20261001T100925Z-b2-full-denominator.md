# TreeAI D4 浏览器证据验收记录【echo driver】（B2 选区全分母浏览器面：45 markdown + 30 PDF）

> **驱动类别：echo（确定性回声驱动）** —— 本记录是 echo driver 下的真实
> 浏览器检查，**不是真实 Pi 证据**（B2 选区语义本就不依赖模型回答；
> 真实 Pi 面属于 B3 等检查的 `--mode real-pi` 运行）。本记录补齐的是
> issue #8 增量验收中 owner 明确点名的缺口：「B2 的 PDF ≥30 浏览器选区
> 没有执行」——本次起 `d4-read-and-select` 在真实 Chrome 里铺满冻结
> 分母：**45/45 markdown + 30/30 PDF**。

## 基本信息

- 记录 ID：`d4-browser-20261001T100925Z-b2-full-denominator`（summary
  runId `d4-browser-20261001T100925-82400`）
- 日期（本地时区）：2026-10-01（UTC 2026-10-01T10:09Z 起，全程约 2 分钟）
- 操作人（编号 / 角色）：agent（issue #8 §8 验收入口——B2 浏览器选区
  全分母波：`wip/d4-browser-b2-full` 分支）
- commit SHA（运行时工作区 HEAD）：`ba53562dc7b49d69a82453cd8be450dacc38ebd0`
  （分支 `wip/d4-browser-b2-full`，基于 main `e4b7445`，两个提交：
  `b8a37fe` 探针扩分母 + `ba53562` B3/搜索探针配套适配）。`gitDirty:
  false`——运行时工作区零未提交改动（代码先行提交，证据目录经临时
  --artifacts 运行后另行拷入提交，与既有记录同款纪律；拷入经 diff -rq
  逐文件核对字节一致）。
- 记录类别：☑ 浏览器 UI 级操作　☑ 冻结集对照（B1/B2 复跑铺满）　☐ 真实
  Pi（echo；B2 语义不涉模型）　☐ 设计对照录屏　☐ 独立试用
- 驱动方式：入仓浏览器面验收器 `scripts/run-d4-browser.mjs` **v0.4.0**
  （`--mode selftest` 全量，无 --only）spawn 真实 Studio CLI（echo 驱动）+
  本机 Chrome headless（CDP over DevTools WebSocket）；页面内操作为真实
  DOM/输入事件（CDP `Input.dispatchMouseEvent` 真实点击 / 真实两击选区 /
  真实连续拖选 press→move×8→release；阅读/选区/复制/懒加载全部走 app.js
  自身路径；导入走真实 HTTP API——D4-1 契约面）。

## 环境

- Node：24.21.0 / npm：11.19.0（与锁基线一致）
- 浏览器：HeadlessChrome 153.0.8010.37（`--headless=new`，CDP；127.0.0.1
  本地回环，无外网）；视口 1280×900
- OS：macOS 26.6.2 arm64；CPU 10× Apple M4；总内存 16 GiB
- 并发披露：运行窗口本机 loadavg 约 [1.52, 1.68, 1.71]（无并行 D4 波）
- 冻结集绑定：`tests/fixtures/d4/MANIFEST.sha256` 的 SHA-256 =
  `dc4a18f58da9803174c3686c0a66d485c61c64de4fa0c8d021a399bef44f2202`；
  使用 fixture 34 项（B1 全分母 + 负例 + 版本对；B2 三份真值：
  markdown-selections / pdf-selections / invalid-selections）

## 结果

**14 PASS / 0 FAIL / 0 BLOCKED / 0 NOT_RUN，退出码 0。**（对照
20261001T063316Z 终波记录同为 14/0/0/0——`d4-read-and-select` 的语义
从「13 个 markdown 选区」升级为「45 markdown + 30 PDF 全分母」。）

## 逐检查结果

1. chrome-boot / studio-boot / page-load / console-clean：照旧全绿。
2. d4-import-material / d4-import-denominator：照旧全绿（B1 24 ready +
   11 负例）。
3. **d4-read-and-select（本次扩分母的主体，9.4s）**：
   - **分母铺满**：开卷按需把 12 markdown + 12 PDF 冻结 fixture 全部经
     真实导入 API 铺进场景树（parserKind / parserVersion / textUnits 与
     冻结真值逐项对账；此前只铺 md-01/06/11）；
   - **markdown 45/45**：登记册序 md-01..md-12 每卷打开（md-11 59 块
     懒加载第二页；md-10 42 块）→ 逐块无损 → 该卷全部冻结 md-sel 逐个
     规范捕获（数据驱动，绝不硬编码 id 清单）；唯一 id 计数 45/45 差一
     即失败。md-01 两击 + 连续拖选 + 跨块拒绝、md-06 emoji/字素吸附、
     md-11 复制摘录（剪贴板回读字节相等）三个专属流程原位保留；
   - **PDF 30/30（owner 点名缺口）**：pdf-01..pdf-12 每卷打开
     （`pdfReaderLoadedExpr`：页框数 + 「N page(s) in view」+ 末页/更多
     态；pdf-08 10 页、pdf-11 30 页全部真实滚动逐批预取到场）→ PDF 版
     阅读器 chrome 断言（`v1 (current)` / `pdf · d4-pdf-v1` / textUnits /
     `v1 · pdf` 版本链 / 单页纪律注记）→ 每个冻结 pdf-sel 目标页先滚入
     懒渲染窗口（data-rendered=true、无占位、非空），**已渲染文本层与
     冻结页块逐字节无损**后再捕获；捕获载荷含页标识（`· page N`）；
     唯一 id 计数 30/30。类别覆盖 zh/en/code/repeat-word/two-column
     left+right/header/footer/multipage/long-tail/unicode/fonts/cross-line；
   - **真实手势 PDF 镜像**：pdf-sel-01（page-1 文本层「递归」）真实连续
     拖选（press → move×8 → release；拖拽窗口内捕获条冻结；释放后原生
     高亮存活）——与 markdown 面同款 owner P1 #3 纪律；
   - **跨页拒绝镜像（charter §3.2 单页纪律）**：冻结负例 inv-08
     （pdf-01 [817,819) 跨 page-1/page-2）与 inv-09（pdf-08 [3678,3680)
     跨 page-4/page-5）数据驱动执行——两页文本层都渲染后放置跨页真实
     DOM 选区，断言 invalidNote 含 cross-page、零载荷零摘录；
   - **来源揭示**：全部 75+ 选区经真实后端 resolve-selection 复核逐项
     全等（含 sourceHash === SHA-256(冻结 canonicalText)）；
   - sidecar `read-select-cases`：markdownFrozenExact 45/45、
     pdfFrozenExact 30/30、*CapturedIds 全量清单、类别清单、跨页拒绝
     记录（inv-08/inv-09 的页对与区间）、pdfMouseGesture、copyQuote、
     pageErrors 0；页面 console 零错误。
4. d4-branch-from-material / d4-return-from-material（B3，echo 冒烟——
   非 B3 证据）：照旧全绿。**配套适配**：pdf-01 已被分母铺进场景树，
   ensureB3Corpus 改为复用既有条目（导入 API 对树内同字节 contentHash
   去重回 200/created=false——import-service 的重导幂等语义），不再
   重复导入；B3 浏览器面与 B2 选区证据同源。
5. d4-restart-continue：照旧全绿（md-11 位置保存/恢复 + ≤2px 视觉对齐）。
   配套适配：md-11 流程收尾滚回顶部，重开的位置恢复确定性落在第一页
   （消除「留在大滚动位 → 恢复向前补页到 59 块」与首页就位断言的既有
   潜伏竞态）。
6. d4-search-recover：照旧全绿。**配套适配**：md-02 已被分母铺进场景树
   （「md-02 只在第二棵树」不再成立），跨树范围判别语料改为探针自产
   唯一短语材料（只进第二棵树）——当前树范围零命中、全部树范围命中的
   判别语义不变。
7. d4-export-restore-recover / d4-nav-browser / d4-b6-scale-browser：
   照旧全绿（B5 恢复链、B9 导航 p95 49.0ms、B6 打开 p95 29.2ms 等）。

## 探针缺陷（真浏览器实测发现并修复——全部探针侧；产品零改动）

1. **手势落点命中裁剪区外的正文**：块级 `scrollIntoView(center)` 对高于
   滚动视口的块把目标行滚进裁剪区——`getClientRects` 不受裁剪，落点
   坐标照常返回（实测 PDF 页文本层 1180px vs 435px 视口，拖选落点命中
   阅读器标题行，选出标题文字「f-01」）。修复：按目标行矩形对齐视口
   中心后再量落点。
2. **进场动画平移度量坐标**：阅读器 panel-in（translateX(24px)→0，
   180ms）进行中量落点，caret 实测落后一字（md-sel-01 首开即量）。
   修复：手势前有界等待 `.enter` 播完。
3. **一次滚动到不了未渲染的远页**：未渲染页是 ~68px 占位——内容偏短使
   scrollIntoView 被钳制在短内容的最大滚动位；按序渲染级联又把目标页
   推出渲染窗（实测 pdf-08 page-10：一次滚动后 4-6 页渲染、7-10 仍占位；
   几何诊断入错误路径）。产品契约「可见页渲染」始终成立（真实用户继续
   滚动即可）——探针按用户同款**迭代滚入**（有界 14 次，超时附帧位/
   窗口几何诊断）。**结构性观察（如实记录，未改产品）**：>10 页 PDF
   从顶部一次滚动到不了末页（占位高度 + 渲染级联），需要多次滚动；
   渲染过的页卸载保几何（min-height），不受此影响。
4. **下游探针的场景树假设**：B3 的 pdf-01 重复导入与搜索探针的 md-02
   跨树判别（见上）。均按新事实适配，断言强度不降。
5. 拖选 during-drag 失败路径附落点 elementFromPoint 诊断（失败可定位）。

## 截图（本证据目录，编号序）

- B2 新增 PDF 面 5 张：`11-reader-pdf01`（PDF 阅读面 + 单页纪律注记）、
  `12-selection-pdf01-armed`（page-1 文本层上武装选区：载荷含
  `· page 1`）、`13-selection-pdf01-crosspage-refused`（跨页拒绝——
  invalidNote 在场、无载荷）、`14-reader-pdf06-twocolumn`（双栏语料的
  规范文本阅读面）、`15-selection-pdf11-longtail`（30 页长文的 page-30
  长尾选区）。
- markdown 面既有 5 张照旧（md01-crossline / md06 / md06-emoji /
  md11-lazyloaded / md11-longtail）；其余检查截图与终波记录同款。

## 计时口径（诚实披露）

- d4-read-and-select 全分母 9.4s（75+ 选区 × 规范放置 + 捕获条轮询 +
  resolve-selection 复核 + PDF 页渲染等待）；逐选区无独立计时面（本
  检查是正确性检查，非性能预算——B6 的计时面归 d4-b6-scale-browser）。
- 全程约 2 分钟（14 检查含 B9/B6 数据集生成与装载）。

## 复验条件

`node scripts/run-d4-browser.mjs --mode selftest`（同 commit `ba53562`、
同机器）；真实 Pi 面（B3 等）仍归 `--mode real-pi`（待负责人凭据后在
最终候选 SHA 执行）。本分支未合并 main、未推送、未发 GitHub 评论；
D4-status/协调文件归 owner 合并后更新。
