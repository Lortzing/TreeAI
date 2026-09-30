# TreeAI D4 浏览器材料路径验收记录【echo driver】（B1/B2 浏览器面探针波）

> **驱动类别：echo（确定性回声驱动）** —— 本记录是 echo driver 下的真实
> 浏览器检查，**不是真实 Pi 证据**；B3 的真实 Pi 浏览器录制属
> `run:d4-browser --mode real-pi`，待负责人凭据后补。

## 基本信息

- 记录 ID：`d4-browser-20260930T180345Z-selftest-material`
- 日期（本地时区）：2026-10-01（UTC 2026-09-30T18:03Z）
- 操作人（编号 / 角色）：scheduled-unattended / agent-E（d4-browser-probes 波，issue #8 §8 验收入口的 B1/B2 浏览器面）
- commit SHA（运行时工作区 HEAD）：`3d0dbbabae9d5af1291b97e633dec7b43429a6ea`。`gitDirty: true` 的构成如实说明：仅为本波未提交的证据文件（evidence/d4/browser/ 本记录目录与同波 verify:d4 离线运行目录）；**运行时代码（scripts/run-d4-browser.mjs、scripts/d4/browser/material-probes.mjs 及其全部依赖面）与该 SHA 逐字节一致**——本波先提交探针代码（3d0dbba）再行验收跑。
- 记录类别：☑ 浏览器 UI 级操作　☑ 冻结集对照（B1 导入 / B2 选区）　☐ 真实 Pi（本记录为 echo）　☐ 设计对照录屏　☐ 独立试用
- 驱动方式：入仓浏览器面验收器 `scripts/run-d4-browser.mjs` **v0.2.0**（`--mode selftest`）spawn 真实 Studio CLI（echo 驱动）+ 本机 Chrome headless（CDP over DevTools WebSocket）；页面内操作为真实 DOM/输入事件（CDP `Input.dispatchMouseEvent` 真实点击、真实鼠标两击选区 click + Shift+click、DOM Selection 经阅读器自身的 selectionchange 武装路径），绝不在页面内 fetch-shim 应用自身行为。

## 环境

- Node：24.21.0 / npm：11.19.0（与锁基线一致）
- 浏览器：Chrome 153.0.8010.37（headless=new，CDP；127.0.0.1 本地回环，无外网）
- Studio：`--driver echo`（零凭据、零外网），真实子进程 + 同数据目录 SIGTERM/重启（d4-restart-continue）
- OS：macOS 26.6.2（本机 trusted-local）
- 视口：1280×900
- 冻结集绑定：`tests/fixtures/d4/MANIFEST.sha256` 的 SHA-256 =
  `dc4a18f58da9803174c3686c0a66d485c61c64de4fa0c8d021a399bef44f2202`；
  使用 fixture：md-01 / md-06 / md-11（B1）+ `markdown-selections.json`（B2），
  真值运行时读冻结文件，无内嵌副本。

## 操作步骤（逐条，按验收器 stdout 事实誊录）

结果：**7 PASS / 0 FAIL / 0 BLOCKED / 3 NOT_RUN**，退出码 3（NOT_RUN 均为
模式门控 / 归属在册项，见步骤 9）。同一探针代码连续 5 次运行结果一致
（3 次开发验证跑 + 2 次证据跑）。

1. chrome-boot / studio-boot / page-load / console-clean：Chrome CDP 通道
   建立；echo studio `/api/health` ok；空态 shell 渲染、零 console/Log 错误。
2. d4-import-material：真实 UI「＋ New Tree」建树 → B1 冻结 fixture
   （md-01/md-06/md-11 原始字节 + 百分号编码文件名头）经真实 HTTP API
   （`POST /api/trees/:id/materials`，D4-1 契约面）导入 201 → 轮询至
   ready → 页面真实导航刷新 → 侧栏 Materials 三条全部
   「markdown · v1 · ready」，服务端 textUnits 与冻结真值一致
   （1179 / 1032 / 5729）。
3. d4-read-and-select（md-06，16 块单页）：阅读器 chrome 断言（v1 (current)
   版本标签、markdown · d4-md-v1 解析器版本、1032 text units、版本链单
   chip）；**逐字无损**断言（在场每块 textContent/dataset.start/end 与冻结
   真值字节相等）；5 项冻结选区（🚀 第 2 次出现、👨‍💻 ZWJ 序列、👍🏽 肤色
   变体、1️⃣ 2️⃣ 3️⃣ 键帽、🇨🇳 🇺🇸 旗帜对）在真实 DOM 上按规范偏移建
   Selection → 阅读器自身 selectionchange 路径武装 → 捕获条载荷与冻结
   真值**逐项全等**（quote / payload / copy 按钮 / D4-3 建枝入口禁用）。
4. 字素安全吸附（浏览器面专属）：把选区边界故意放进 👨‍💻 簇内部
   （[834, 837)——代理对之间起、簇内止）→ 捕获条**向外吸附**到整簇
   [833, 838)，与冻结真值 md-sel-30 全等并携带吸附注记。
5. d4-read-and-select（md-01，14 块单页）：**真实鼠标两击选区**（click 置
   caret 于「递」左缘内 1px → Shift+click 于「记」右缘内 1px）→ 原生选区
   即 md-sel-01 [2, 11)「递归与分治学习笔记」，捕获载荷与冻结真值全等；
   重复词第 5 次出现（递归，[116, 118)）与跨行选区（md-sel-22，含 `\n`）
   同样全等。跨块纪律：blk-1 尾部 → blk-2 开头的真实 DOM 选区 → 捕获条
   如实呈「cross-block selection not anchorable」，不产出任何载荷。
6. d4-read-and-select（md-11，59 块 > 50/页）：首页 50 块 + 「Load more
   blocks」→ 真实滚动到底触发应用自身懒加载 → 59 块 + 「end of
   material」；首尾两页逐块无损断言；blk-49（剪枝 第 4 次出现）、blk-56、
   blk-58（长尾 ×2）冻结选区全等。**来源揭示**：每项捕获载荷（utf16-range
   + excerpt + blockId）送真实后端 `resolve-selection` 复核，12/12 通过且
   `selection.sourceHash === SHA-256(冻结 canonicalText)`（服务端规范文本
   与冻结集字节一致的结构性证明）。**复制不变**：点击阅读器自身
   「⧉ Copy quote」（经 `Browser.grantPermissions` 授权后真实剪贴板读回）
   → 剪贴板内容与规范摘录字节相等。
7. d4-restart-continue：md-11 阅读器内真实滚动将 blk-52 顶部对齐 → 真实
   输入点击「× Close」（阅读器自身保存路径：关闭即冲刷 PUT）→ 后端读回
   {versionId, blockId: blk-52, focusStart: null} → studio 子进程 SIGTERM
   优雅停止 → **同数据目录新进程**（新端口）→ 页面重载 → 重开 md-11：
   向前补页到 blk-52、恢复注记「restored to your saved reading position
   (block blk-52)」落位、持久化行在新进程读回一致（59 块）。
8. console 纪律：全程序零页面 console/Log 错误（重启窗口内旧端口连接
   拒绝按预期排除规则处理，实测 0 条）。
9. NOT_RUN ×3（预期）：d4-branch-from-material / d4-return-from-material
   （real-pi 专属用户路径，owner: D4-3 后端波次进行中——selftest echo 下
   模式门控）；d4-search-recover（搜索 UI 未落地，owner: D4-4 前端波次
   进行中；HTTP/引擎面已由离线 b4-cross-material-find 覆盖）。

## 脱敏 ID 清单

- 验收器 stdout 不回显凭据；材料/版本/树 ID 仅出现在 JSON sidecar
  （本目录 03/09/11）与 summary.json 中，均为本机临时数据目录内的随机
  UUID，无秘密。
- studio.log 已按既有纪律脱敏（数据目录以 `<tmp>` 占位符化；echo 模式
  本身零凭据）。

## 注入的故障（如无写"无"）

- 故障类别：宿主重启（studio SIGTERM + 同数据目录新进程——探针自身步骤，
  非产品缺陷注入）
- 观察到的行为：见步骤 7——阅读位置行跨进程持久、重开恢复注记落位；
  **另发现真实浏览器缺陷/观察 3 项（见下，均未在本分支修复）**。

## 本波发现（如实记录，均未在本分支修复——apps/studio 前端不属本波文件面）

1. **阅读位置恢复的视觉滚动对齐在真实 Chrome 中失效**（产品缺陷）：
   `apps/studio/public/app.js` 的 `renderMaterialReader()`（约 L4269 起）以
   `root.replaceChildren()` 摘下 `#mat-blocks` 再移回——Chrome 在元素脱离
   文档时丢弃其滚动位置，重挂后 `scrollTop` 回 0（实测：先 scrollIntoView
   到 5464px 再 detach/reattach → 0）。恢复路径（`loadMaterialFirstPage`，
   约 L4134–L4142：scrollIntoView 到保存块后立即再调 `renderMaterialReader()`
   落恢复注记）因此把恢复滚动重置——用户看到「restored to your saved
   reading position (block blk-52)」注记但视口在文档顶部（实测 scrollTop
   0 vs 目标块 7208px）。DOM 桩套件（ui-material-reader.test.ts）的
   scrollTop 是跨脱离存续的普通属性，语义上不可复现该行为。同一机制也
   影响阅读中途的 chrome 重渲（如 pending 版本 Refresh）。探针按产品事实
   断言（注记/补页/持久行），并在 sidecar `11-restart-continue.json` 的
   `scrollAlignmentObserved` 如实记录该现象。
2. **阅读器捕获条为文档流内元素，选区武装瞬间布局位移**（交互观察）：
   `#mat-selection-bar`（flex 列内）从提示行（实测 54px）长高为武装态
   （实测 169px）会把整个 `#mat-blocks` 下推 115px。真实连续鼠标拖选中，
   选区一旦跨块还会经 invalid 态再变一次高度——释放点坐标随之失真
   （实测拖选逃出目标块）。真实用户因视觉跟随可自适应，但这是「选择期
   间不重绘」纪律在阅读器捕获条上的一个缺口（正文层工具条同族问题在
   D3 由绝对定位规避）。探针的鼠标选区因此改用两击手势（click 置
   caret + Shift+click 扩展——两次命中判定都发生在各自 mousedown 时刻，
   天然免疫位移），DOM 选区路径不受影响。
3. CDP 备注（工具事实，非产品缺陷）：本机 headless Chrome 153 的
   `Input.dispatchKeyEvent` 不驱动原生 caret 移动/选区扩展（ArrowRight /
   Shift+Arrow / `commands` 编辑命令均无效），键盘选区路径在本环境不可
   用——探针因此未采用键盘选区。

## 复验命令

```bash
git clone https://github.com/Lortzing/TreeAI.git && cd TreeAI
git checkout 3d0dbbabae9d5af1291b97e633dec7b43429a6ea
node --version && npm --version   # 24.21.0 / 11.19.0
npm ci
npm run --workspace @treeai/event-journal build:test   # studio 运行需要 dist（npm test 亦会构建）
node scripts/run-d4-browser.mjs --mode selftest        # 需本机 Chrome/Chromium；期望 7 PASS / 0 FAIL / 0 BLOCKED / 3 NOT_RUN（exit 3）
npm test                                               # 646 tests / 646 pass / 0 fail（exit 0）
npm run verify:d4                                      # 11 PASS / 0 FAIL / 0 BLOCKED / 6 NOT_RUN（exit 3，既有 D4 矩阵状态，无回归）
```

截图（01/02/04/05/06/07/08/10-*.jpg）为该次运行的真实 CDP 截屏，按仓库
惯例（evidence 无二进制先例，见 evidence/d3/browser 记录）不入仓，留存于
运行机 `/tmp/d4br-evidence2/d4-browser-20260930T180345Z-selftest-material/`。
