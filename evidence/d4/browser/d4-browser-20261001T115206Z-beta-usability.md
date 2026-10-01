# TreeAI D4 浏览器证据验收记录【echo driver】（B7 自动部分——beta 可用性探针）

> **驱动类别：echo（确定性回声驱动）** —— 本记录是 echo driver 下的真实
> 浏览器检查（真实 headless Chrome + 真实 Studio 进程；模型回答为确定性
> echo）。它是 issue #8 charter B7 行**自动部分**的机制证据；**Mac 体验
> 签收与 3–5 人逐人试用属负责人 D4-G3 人工序列，本记录的 PASS 不构成
> B7 全过**。

## 基本信息

- 记录 ID：`d4-browser-20261001T115206Z-beta-usability`
  （summary runId `d4-browser-20261001T115206-48042`）
- 日期（本地时区）：2026-10-01（UTC 2026-10-01T11:52Z 起）
- 操作人（编号 / 角色）：scheduled-unattended / 波次会话（issue #8 §8
  验收入口——B7 自动部分波次 `wip/d4-beta-usability`）
- commit SHA（运行时工作区 HEAD）：`26c5d5ac49c0984fca8a04aa11d0ca9e1c7f7dfa`
  （分支 tip；含产品缺陷修复提交 `4aee8a7`）。在 detached worktree 干净
  检出运行，`gitDirty: false`（summary.json 结构化记录）；证据目录经临时
  `--artifacts` 运行后拷入提交（`diff -rq` 逐文件核对字节一致）。
- 记录类别：☑ 浏览器 UI 级操作　☑ README 启动路径对账　☑ 宽窄窗/键盘/
  触屏/reduced-motion/回程机制检查　☐ 真实 Pi（echo；首问/追问语义不
  依赖模型回答内容）　☐ 人工签收（owner D4-G3）　☐ 独立试用（owner）
- 驱动方式：入仓浏览器面验收器 `scripts/run-d4-browser.mjs` **v0.5.0**
  （`--mode selftest` 全量，无 --only）spawn 真实 Studio CLI（echo 驱动）+
  本机 Chrome headless（CDP over DevTools WebSocket）；页面内操作为真实
  DOM/输入事件（鼠标/键盘/触摸/insertText）。

## 环境

- Node：24.21.0 / npm：11.19.0（与锁基线一致）
- 浏览器：HeadlessChrome 153（`--headless=new`，CDP；127.0.0.1 本地回环，
  无外网）；基准视口 1280×900（探针内按场景切换 1600×900 / 390×844
  mobile×2）
- OS：macOS 26.6.0 arm64；CPU 10× Apple M4；总内存 16 GiB；loadavg
  运行始末 1.93→2.55（并行波次可能在本机构建，如实记录）
- 冻结集绑定：`tests/fixtures/d4/MANIFEST.sha256`（summary.json 记录
  manifest SHA-256 与使用 fixture 清单——34 项；本探针使用 md-11 + pdf-01）

## 结果

**15 PASS / 0 FAIL / 0 BLOCKED / 0 NOT_RUN，退出码 0。**

其中 `d4-beta-usability`（本波主体）六组场景逐项：

- **README 干净环境启动（cleanBoot）**：按 README「Studio (D3 MVP) —
  local install & start」文档路径在干净临时数据目录冷启——实际 spawn
  argv（`node apps/studio/src/index.ts --port <free> --data <tmp>`）与
  README 启动命令（`npm run start --workspace @treeai/studio` →
  package.json start = `node src/index.ts`）及文档选项（`--port N` /
  `--data DIR`）逐项对账一致（entry 同一文件、flags 均在文档选项集内，
  sidecar 结构化记录）。首启空状态诚实：空态可见且带建树主操作、
  #tree-view 隐藏、Forest 列表 0 树（含导航面森林列表）、材料段隐藏、
  服务端 0 树；建树流程真实可用（空态按钮点击 → 工作台打开 → 服务端
  恰 1 树）。
- **宽窄窗（wideNarrow）**：宽档 1600×900（≥1440 要求）与窄档
  390×844（mobile 触屏视口，deviceScaleFactor 2）两档：新建树/材料导入/
  搜索输入/树行/分支 tab 关键控件 elementFromPoint 全命中；主内容无横向
  溢出（documentElement scrollWidth−clientWidth = 0，阅读器与面板打开时
  复核）；阅读器两档可用（md-11 首屏 50 块渲染）；捕获条可达（武装选区
  后复制/建枝按钮命中）；支线面板两档可用（tab 点击打开，输入框与
  ⌖ View source 命中）；窄档侧栏抽屉经 #sidebar-toggle 真实开合，选材料/
  选分支后按产品纪律收起。
- **键盘（keyboard）**：Shift+Tab 回卷到文档起点（焦点越过首个可聚焦
  元素落回 body）后正向 Tab 遍历 **33 步**到达阅读器正文容器
  #mat-blocks——途经新建树/材料导入/搜索输入全部到达，遍历序列全程
  焦点在元素上（无焦点陷阱；序列入 sidecar）。Enter 激活（阅读器关闭
  按钮）与 Space 激活（搜索范围切换 aria-pressed 翻转-还原）均生效。
  Escape 分层关闭：来源抽屉→焦点还原 #source-drawer-toggle；阅读器→
  焦点还原打开它的材料列表按钮；支线面板→焦点还原打开它的分支 tab。
  焦点样式可见：Tab 聚焦的 #mat-blocks 与 #search-input computed outline
  均 solid/2px（:focus-visible 命中）。阅读器方向键滚动：#mat-blocks
  聚焦后 ArrowDown ×6 滚动 1025→1251px、ArrowUp ×3 回至 1159px，焦点
  保持（滚动/懒加载重渲后仍在 #mat-blocks）。
- **触屏模拟（touch，CDP Input.dispatchTouchEvent）**：5 次 tap（开侧栏
  抽屉、开 md-11 阅读、开抽屉、选 pdf-01、tap 捕获条复制按钮）+ 1 次
  swipe（阅读器上滑滚动 **405px**）+ 1 次手势内拖选。PDF 文本层（pdf-01
  第 2 页，文本层先逐字节渲染）上拖选武装捕获条：选区在触摸手势进行中
  经平台 Selection API 置位（**全程零鼠标事件**——app 的触路径是
  selectionchange 武装，断言行使的正是该路径），捕获条武装载荷
  `block page-2 · page 2 · UTF-16 [824, 848) · 24 units` 与摘录全等；
  tap 复制按钮 → 「Copied ✓」+ 剪贴板回读**字节相等**。原生长按实测
  如实入 sidecar（selectionchange 计数 1、终选区空——headless Chrome 153
  不合成持久选区，见限制）。
- **reduced-motion**：`Emulation.setEmulatedMedia` reduce → 页面
  matchMedia 为真（清除后回落为假，复原核验）。定位跳转（面板 ⌖ View
  source → 阅读器开于锚定块 blk-8）：锚定块进入 DOM 的微任务时刻
  scrollTop 已是终位（1025 = 块顶 1025，diff 0px），到位后全部帧无位移。
  贴底跟随（面板追问 → 新内容到达）：reduce 下变更微任务时刻已在终位
  （24281/24281），至多一帧过渡（流式增量写入与跟随滚动分属相邻任务；
  平滑滚动则会呈现连续多帧在途）后稳定贴底（32429/32429）。**对照测量**
  （无 reduce，如实记录不设断言）：变更微任务时刻在途（16032 < 16095），
  且测量窗口内未贴底（settled 16035 vs 24218）——与 reduce 下的即时
  落位形成对照。
- **焦点/滚动/草稿回程（focusScrollDraft，会话内）**：支线面板输入草稿
  问题（不提交）→ 面板会话滚至中段（16214px）→ ⌖ View source（离开，
  阅读器开于锚定块）→ 阅读器下滚数屏（懒加载）→ Esc 回支线：**草稿
  文本保留**（逐字）+ **焦点还原 #panel-view-source** + **面板滚动位置
  保留**（16214→16214）；**阅读器滚动位置保留**——关闭时保存块 blk-29
  （reading-position PUT 落库核验）→ 经材料列表按钮重开 → 「restored to
  your saved reading position (block blk-29)」+ 块顶对齐 diff 0px（应用
  自身的保存/恢复路径；跨进程重启场景归 d4-restart-continue，本探针
  不重复）。

其余 14 项检查与 B2 全分母记录（`d4-browser-20261001T102316Z`）同语义
全绿（B1 全分母 24 ready + 11 负例、B2 45+30 冻结选区、B3 echo 用户
路径、B5 导出恢复、B9 导航面、B6 规模面——逐项以 `summary.json` 与
sidecar JSON 为准）。

## 探针发现的真产品缺陷与修复（`4aee8a7`，本支独立提交）

1. **窄窗分支 tab 不收侧栏抽屉**：分支 tab 是唯一不收抽屉的抽屉内选择
   ——抽屉盖住刚打开的支线面板（elementFromPoint 于面板输入框命中抽屉
   遮罩）。修复：tab 点击补 `closeSidebar()`（与树行/材料按钮/搜索命中
   同一纪律）。
2. **阅读器键盘不可滚动**：阅读器内无任何可聚焦子元素，方向键/PageDown
   无法滚动正文（WCAG 2.1 SC 2.1.1）。修复：#mat-blocks 加
   `tabindex="0"`（Tab 停靠点，聚焦后即可键盘滚动）。
3. **/switch 在途时 Esc 被静默吞掉**：切枝的 /switch 在途（guard busy）
   按 Esc → `void guard(() => closePanel())` 被直接丢弃——面板收不起、
   无反馈（同 View source 曾有的缺陷家族）。修复：同款有界等待锁释放
   后执行。
   测试：ui-probe（分支 tab 收抽屉断言 + Esc busy 注入场景 + /switch
   闸门基建 holdSwitch）、ui-material-reader（#mat-blocks tabindex 断言）；
   全仓 769/769。

## 探针侧手势/时序坑（如实披露，非产品缺陷）

- headless Chrome 153 的 CDP 输入管线在 **Space / Escape / 无 text 的
  Enter** 之后不再接受原生 `Input.dispatchTouchEvent`（30s 挂起），且
  rAF 近停（1.6s 约 2 帧）；鼠标/eval/带 text 的键不受影响。处置：触摸
  与 rAF 依赖的相位（touch/reducedMotion）先于键盘相位执行；Enter 激活
  携带 `text: "\r"`。
- 窄档抽屉滑出有 220ms visibility 延迟翻转——类移除后抽屉仍覆盖主区，
  此窗口内命中测试会误中抽屉；探针在每处抽屉收起后等待几何静置
  （visibility: hidden）。
- 触摸长按不合成持久文本选区（实测记录）；拖选场景以平台 Selection
  API 在触摸手势内置位——被测的武装路径（selectionchange、零鼠标事件）
  与真实触屏选区的到达路径一致。
- Tab 遍历的顺序焦点起点依前焦点位置（浏览器顺序焦点导航起点语义）；
  探针以 Shift+Tab 回卷到文档起点后正向遍历，保证确定性。

## 限制与如实声明

- echo 驱动：不构成真实 Pi 行为证据（首问/追问的回答内容不参与断言；
  真实 Pi 模式同一探针代码路径，超时按 promptTimeoutMs 放大）。最终
  候选 SHA 按 D4-status 复验条件重跑。
- **本记录只覆盖 B7 的自动部分**：宽窄窗/键盘/触屏模拟/reduced-motion/
  焦点-滚动-草稿回程的机制性检查。**Mac 体验签收与 3–5 人逐人试用
  （charter B7 行的「人工签收与逐人试用」）属负责人 D4-G3 人工序列，
  本记录的 PASS ≠ B7 全过**——verify:d4 的 b7-beta-usability 行描述
  同步显式披露。
- 键盘驱动的原生 caret/选区在 headless Chrome 153 不可用（既有已知
  限制，非本波引入）；触屏长按选区合成同上（已披露处置）。
- 本地机器工程证据（环境入 sidecar），不跨机器宣称。

## 波次门禁复验（分支 tip `99bbf3f`）

- `npm ci --no-audit --no-fund`：完成（Node 24.21.0 / npm 11.19.0）
- `npm run typecheck`：PASS（7 个有源码 workspace）
- `npm test`：**769/769，0 fail**（基线 767 + 本波 2 项新测试：
  ui-material-reader #mat-blocks tabindex、ui-probe Esc busy 注入）
- `npm run verify:d4`：**19 PASS / 0 FAIL / 0 BLOCKED / 1 NOT_RUN**，exit 3
  （NOT_RUN = b8 负责人目标机门禁；**b7-beta-usability 经证据审计翻
  PASS**，detail 显式披露自动部分 ≠ B7 全过；证据
  `evidence/d4/runs/d4-offline-20261001T120226116Z`）
- `npm run verify:d4:selftest`：控制组 + **9 项**故障注入全部检出（含
  本波新增 inject-stripped-b7-sidecar——b7 审计行不被吞绿；证据
  `evidence/d4/selftest/d4-selftest-20261001T115759687Z`）
- `npm run verify:d2`：**21 PASS / 0 FAIL / 0 BLOCKED / 1 NOT_RUN**，exit 3
  （NOT_RUN = D1 live 显式门控；证据
  `evidence/d2/runs/d2-offline-20261001T115819550Z`）
- `npm run run:d4-browser -- --mode selftest`：**15 PASS / 0 FAIL /
  0 BLOCKED / 0 NOT_RUN**，exit 0（分支 tip 复跑；证据运行见上方
  `26c5d5a` 记录）

