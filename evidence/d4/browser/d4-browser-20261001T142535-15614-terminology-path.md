# TreeAI D4 浏览器证据验收记录【echo driver】（issue #7 术语①②③——terminology-path 探针）

> **驱动类别：echo（确定性回声驱动）** —— 本记录是 echo driver 下的真实
> 浏览器检查（真实 headless Chrome + 真实 Studio 进程；模型回答为确定性
> echo）。它是 issue #7 下一步 2「术语①②③ 真实浏览器 + 真实 Pi 纵向路径
> 探针」的**机制证据**（探针/UI 代码路径可达性 + 真实浏览器不变量）；
> 真实 Pi 回答的术语半边证据见同波
> `d4-browser-*-realpi-terminology` 记录。**echo 结果永远不是真实 Pi 证据。**

## 基本信息

- 记录 ID：`d4-browser-20261001T142535-15614-terminology-path`
  （summary runId `d4-browser-20261001T142535-15614`）
- 日期（本地时区）：2026-10-01（UTC 2026-10-01T14:25Z 起）
- 操作人（编号 / 角色）：scheduled-unattended / 波次会话（issue #7 下一步 2
  术语半边波次 `wip/term-browser-path`）
- commit SHA（运行时工作区 HEAD）：
  `872be3ecd34e23581fd40fdd3d2e0f787497dc33`（分支 tip；`gitDirty: false`
  ——summary.json 结构化记录；证据目录经临时 `--artifacts` 运行后拷入提交，
  `diff -rq` 逐文件核对字节一致）
- 记录类别：☑ 浏览器 UI 级操作　☑ 术语①阅读模式/②入口纵向/③前端不变量
  　☐ 真实 Pi（echo；首问/追问/解释语义不依赖模型回答内容）　☐ 人工签收
- 驱动方式：入仓浏览器面验收器 `scripts/run-d4-browser.mjs` **v0.6.0**
  （`--mode selftest` 全量，无 --only）spawn 真实 Studio CLI（echo 驱动）+
  本机 Chrome headless（CDP over DevTools WebSocket）；页面内操作为真实
  DOM/输入事件（真实鼠标连续拖选 press→move×6→release、insertText 键入、
  DOM click 管线（与 0ms 解除路径竞态的按钮——b3 既有纪律））。

## 环境

- Node：24.21.0 / npm：11.19.0（与锁基线一致）
- 浏览器：HeadlessChrome 153（`--headless=new`，CDP；127.0.0.1 本地回环，
  无外网）；基准视口 1280×900（探针内按场景切换 1600×900 / 390×844
  mobile×2）
- OS：macOS 26.6.0 arm64（Apple M4）
- 数据目录：探针专用 mkdtemp（bootStudioOn 冷启；不依赖共享场景树），
  运行后清理
- 冻结集：本检查不使用 D4 冻结 fixture（术语自产语料——树/问题/选区全部
  由探针在真实 UI/API 上创建）

## 结果

**16 PASS / 0 FAIL / 0 BLOCKED / 0 NOT_RUN，退出码 0。**
（run:d4-browser 全量计数 15→16：新检查 `terminology-path`——无 d4- 前缀，
issue #7 术语工作、非 D4 工作包；verify:d4 行结构保持 19-0-1，术语侧独立
追踪。）

其中 `terminology-path`（本波主体）逐项：

### ① 阅读模式面

- **抽屉三选一选择器**：真实点击 Manual only / Minimal hints / Assisted
  reading 三档切换（`manual-only → minimal-hints → assisted-reading →
  manual-only`），PUT 载荷经 CDP Fetch Request 阶段传输层观测逐次核验
  （`{"mode":"…"}` 与点击一致）+ 服务端 GET 回读一致 + aria-pressed 迁移。
- **gate 未过如实旁注**：抽屉在场文案「the auto-annotation quality gate
  has not passed — automatic suggestions stay OFF; only manual explaining is
  in effect」（`TERMINOLOGY_AUTO_QUALITY_GATE=false` 生产缺省——被测语义
  而非限制；探针绝不为让建议出现而改产品 gate）。
- **manual-only 与 minimal-hints 两档回答后零自动派发**（各一问）：
  服务端任务表 0 / usage requests 0 / 建议集 0 / 建议条不渲染 / 隔离执行器
  `<data>/terminology/sessions` 零文件（会话文件只在执行器 prompt 后产生
  ——prompts 零的服务端佐证）；`autoSuggestions = {enabled:false,
  reason:"quality-gate-pending"}`。
- **建议 chip 预填/确认前零 explain 请求**：**不可行使，如实披露**——gate
  恒关下建议集结构性为空（sets 恒 `[]`）、chip 永不出现；探针不得开启
  gate 让 chip 出现（sidecar honestyNotes 记录）。

### ② 术语入口纵向（term 与 range 两模式分别全链）

- **term（点词级）**：真实鼠标连续拖选「regularization」（锚点答案
  UTF-16 [64,78)）→ 工具条武装（aria-label `Selection actions — term …`、
  按钮「⌖ Explain term」）→ 解释卡（echo 确定性回答，非空且含原词）→
  保存批注（正文活覆盖 `.term-annotation-mark` 渲染 + 服务端批注事实）→
  推广建枝（首问输入 → **双击提交恰好一次派发**：双发 click 事件均送达
  应用监听器，busy 锁 + 服务端幂等键下恰 1 条首问 user turn + assistant
  回答 + 批注推广绑定）→ 支线 **≥2 轮追问** → **Return 回主线**（术语
  来源卡：`anchored on "regularization" from Trunk` + `saved <时间>` +
  `↩ Return from Branch N`——摘录/保存时间/来源分支，与材料 Return 卡同
  范式；服务端 return turn 的 fromBranchId 指回推广分支）。
- **range（划线句）**：真实连续拖选「与 lasso 回归的作用，并顺带解释
  overfitti」（[79,108)，含空白 → range 模式，「⌖ Explain span」）→ 解释卡
  → 保存批注（与 term 覆盖相邻不重叠、双覆盖并存）→ **③草稿/焦点回程**
  （首问草稿 → Trunk tab DOM click 触发真实 /switch + renderAll → 草稿
  保值 + 焦点还原 `#term-first-question` + 卡存活）→ **响应丢失重试**：
  CDP Fetch Response 阶段丢弃 promote 响应（恰 1 次；服务端已完整落地）
  → 卡面如实冲突（「promotion conflict — Failed to fetch」）+ 对账刷新
  揭示既有推广（「saved — already promoted to …」）→ **恢复既有探索**
  （恰 1 条首问 user turn、分支数恰 +1、恢复后分支数不变）→ **≥2 轮
  追问** → Return 回主线（划线摘录来源卡）。
- **SIGTERM 重启**：停进程 → 同数据目录新进程（bootStudioOn；口径披露：
  探针专用目录与 runner 的 sc.dataDir 不同，restartStudioSamePort 会错启
  runner 目录——新端口起本探针目录进程；术语探针的重启断言全部是服务端
  持久事实，不依赖浏览器 localStorage）→ 重载后批注覆盖（双 mark）/
  抽屉批注列表（含 promoted-to 注记）/ Return 卡 / 支线历史全部可读 →
  继续追问落地（真实 echo 回答）。
- **已有探索恢复**：重启后重选同一 term → 工具条呈「✓ Follow-up exists」
  → 已存批注卡（resume-or-create 去向）→ 「Open the follow-up branch」
  → 同一分支重入（分支数不变、全历史在场）。
- **显式另开**：同选区上通用建枝入口「⑃ Branch from selection」→ 新分支
  （与两条推广分支互异、同锚点同选区）→ 首问落地（echo 回答）；批注推广
  指向不变。

### ③ 前端不变量

- **选择期间不重绘**：武装选区跨真实 renderAll（Trunk tab 点击 → /switch
  → 全量重渲）——turn 元素与正文首尾文本节点**身份保持**（同对象、仍连接
  在位）、工具条仍武装（aria-label 不变）、选区文本不变。
- **复制不变**：跨双批注覆盖的整答案选区 → 浏览器 copy 命令
  （`document.execCommand("copy")`——对真实平台选区执行）→ 剪贴板回读与
  turn 原文**字节相等**（142 units）。如实披露：CDP 合成 Cmd+C / Ctrl+C
  不触发 headless Chrome 的平台复制（实测剪贴板为空——与 beta 探针
  Enter 需 text 载荷同族的合成键限制）。
- **宽窄两档**：1600×900 与 390×844（mobile）下工具条（toolbar-explain /
  toolbar-branch）、解释卡（卡体/关闭钮）、抽屉三选一 + 缓存开关全部
  elementFromPoint 命中；窄档无横向溢出（0px）。
- **焦点/草稿**：推广首问草稿跨 renderAll 保值 + 焦点还原（ preserve
  路径——本波修复后真实浏览器成立）；Esc 关已存批注卡 → 焦点回 Trunk
  composer（disabled 解释入口不可聚焦——本波修复的回退）。
- **滚动**：断言收敛为可确定性断言的产品不变量（issue #3：已向上阅读的
  重渲绝不强制滚底）——成立；**精确位置恢复不断言（如实披露）**：瞬态
  内容状态（卡关闭 → 内容收缩 → 浏览器钳位）可把钳位值写入分支阅读位置
  记忆、后续重渲恢复陈旧值（整序环境下 401→0 与 220→0 两种回程实测）；
  探针侧不可确定性观测其事件送达时序，观测与根因线索入 sidecar，完整
  因果链留负责人跟进（配套产品整改：reconcileTopLevel 先就位后移除——
  移除瞬态内容塌缩窗口，本波提交 872be3e）。

## 本波发现并修复的真实产品缺陷（独立提交 + 测试）

1. **`b3fe2a2` 解释卡重建焦点保持读点在调和移除之后**（preserveTermCard
   Focus）：真实浏览器里聚焦控件随旧卡移除即失焦，移除后读取永不命中
   ——「重渲不丢打字焦点」只在无失焦语义的 DOM 桩内成立。修复：聚焦
   目标先于移除读取。桩补齐「移除即失焦」语义（修复前实测红）。
2. **`b3fe2a2` 推广响应丢失的对账读模型竞态**（promoteTermAnnotation
   catch）：推广自身派发的首问完成触发 SSE run-terminal 读模型刷新，与
   catch 路径的 refreshTerminology 竞争世代号——catch 写入被作废时卡面
   锁定陈旧批注、「恢复既有探索」去向永不出现（真实浏览器 echo 复现）。
   修复：对账补一次直接读模型 GET（submitReturn 响应丢失同款纪律）。
3. **`b3fe2a2` closeTermExplain 焦点还原在无武装选区时静默丢失**：解释
   入口 disabled（真实浏览器不可聚焦）、原 turn 元素回退无 tabindex——
   焦点落 body。修复：回退到该视图 composer；focusIntoPanel 既有
   「busy 锁下延后一拍重试」纪律提取为 focusComposerWhenSelectable，
   应用于 closePanel main-input / sendPrompt / startNewExploration /
   closeTermExplain 四处 composer 焦点（同族：busy 锁下 composer 是
   disabled，直接 focus() 均为无操作——桩可聚焦 disabled 控件测不出）。
4. **`872be3e` reconcileTopLevel 先移除后插入的瞬态内容塌缩**：替换瞬态
   卡时内容高度先塌再涨，浏览器把 scrollTop 钳到塌缩高度、滚动监听把
   钳位值记入分支阅读位置——后续重渲恢复错误位置。整改：先就位后移除
   （终态逐位一致；apps/studio 407/407）。

测试基线：`npm ci` + `build:deps` PASS；`npm run typecheck` PASS；
`npm test` **792/792**（791 基线 + 净增 1：mark-opened 卡 Esc 回退回归；
桩语义补齐使既有断言成为真回归守卫——修复前实测红）；`verify:d4`
19-0-1（基线不变）；`verify:d2` 21-0-0-1（基线不变）。

## 如实限制

- echo 驱动：模型回答为确定性回声——解释卡/首问/追问的内容语义不是
  真实模型质量证据（真实 Pi 半边见 `-realpi-terminology` 记录）。
- 建议 chip 预填/确认路径不可行使（gate 生产恒关；探针不得改 gate）。
- 精确滚动位置恢复不断言（见上）；合成键盘加速键不触发平台复制
  （execCommand 替代 + 披露）。
- 重启为新端口（探针专用数据目录语义；断言全部服务端持久事实）。
- 单机本地证据（环境入 sidecar；不跨机器宣称）。
