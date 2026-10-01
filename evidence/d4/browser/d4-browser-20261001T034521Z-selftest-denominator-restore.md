# TreeAI D4 浏览器证据扩展验收记录【echo driver】（B1 全分母 + 真实连续拖选 + B5 导出/恢复/找回）

> **驱动类别：echo（确定性回声驱动）** —— 本记录是 echo driver 下的真实
> 浏览器检查，**不是真实 Pi 证据**；B3 的真实 Pi 浏览器录制属
> `run:d4-browser --mode real-pi`，待负责人凭据后补。

## 基本信息

- 记录 ID：`d4-browser-20261001T034521Z-selftest-denominator-restore`
- 日期（本地时区）：2026-10-01（UTC 2026-10-01T03:45Z）
- 操作人（编号 / 角色）：scheduled-unattended / agent-J（d4-browser-ev 波，
  issue #8 §8 验收入口——owner 2026-09-30 18:18 增量验收要求的浏览器
  分母扩展：B1 全分母 / 连续拖选 / B5 恢复组合路径）
- commit SHA（运行时工作区 HEAD）：`af517de0d40cbeacfe26e1923ebf13de077f47c3`
  （分支 `wip/d4-browser-ev`，基于 main `bb4180f`）。`gitDirty: false`——
  运行时工作区零未提交改动（本证据目录于运行后另行提交）。
- 记录类别：☑ 浏览器 UI 级操作　☑ 冻结集对照（B1 全分母 / B2 选区 / B5 恢复）　☐ 真实 Pi（本记录为 echo）　☐ 设计对照录屏　☐ 独立试用
- 驱动方式：入仓浏览器面验收器 `scripts/run-d4-browser.mjs` **v0.3.0**
  （`--mode selftest`）spawn 真实 Studio CLI（echo 驱动）+ 本机 Chrome
  headless（CDP over DevTools WebSocket）；页面内操作为真实 DOM/输入事件
  （CDP `Input.dispatchMouseEvent` 真实点击、真实鼠标两击选区
  click + Shift+click、**真实连续拖选 mousePressed → mouseMoved×8 →
  mouseReleased**、CDP `Input.insertText` 真实键入、confirm 对话框经
  `Page.handleJavaScriptDialog` 接受），绝不在页面内 fetch-shim 应用自身
  行为（导入/建枝/首问/批注/Return 走真实 HTTP API——浏览器侧调用同一
  端点；B5 的 export/restore 走真实 `apps/studio` CLI 子进程）。

## 环境

- Node：24.21.0 / npm：11.19.0（与锁基线一致）
- 浏览器：Chrome 153.0.8010.37（headless=new，CDP；127.0.0.1 本地回环，无外网）
- Studio：`--driver echo`（零凭据、零外网），真实子进程；B5 另经 CLI
  子进程 `apps/studio export --out` / `--import-package` 导出/恢复，并在
  恢复目录上启动全新 studio 进程（三进程接力：原进程 → CLI ×2 → 恢复进程）
- OS：macOS 26.6.2（本机 trusted-local）
- 视口：1280×900
- 冻结集绑定：`tests/fixtures/d4/MANIFEST.sha256` 的 SHA-256 =
  `dc4a18f58da9803174c3686c0a66d485c61c64de4fa0c8d021a399bef44f2202`；
  使用 fixture 34 项：md-01…md-12 + pdf-01…pdf-12（B1 ready 全分母）、
  neg-md-empty / neg-md-invalid-utf8 / neg-md-nul-byte / neg-md-whitespace-only /
  neg-pdf-encrypted / neg-pdf-corrupt / neg-pdf-image-only / neg-pdf-zero-text
  （8 文件负例）、md-vpair-v1/v2（搜索探针版本对）；B2 真值
  `markdown-selections.json`；**3 个超限负例按 manifest recipe 确定性生成、
  不入仓**（生成器与 `tests/support/verifier/d4-b1-import.ts` 同源）。
  真值运行时读冻结文件，无内嵌副本。

## 操作步骤（逐条，按验收器 stdout 事实誊录）

结果：**10 PASS / 0 FAIL / 0 BLOCKED / 2 NOT_RUN，退出码 0**（NOT_RUN 均为
模式门控的 real-pi 专有检查）。同一探针代码（af517de）连续 2 次运行结果
一致（1 次开发验证跑 + 1 次本证据跑）；此前 4 轮迭代跑的失败均如实留痕于
开发过程（见「本波发现」前的探针修复记录）。

1. chrome-boot / studio-boot / page-load / console-clean：Chrome CDP 通道
   建立；echo studio `/api/health` ok；空态 shell 渲染、零 console/Log 错误。
2. d4-import-material：真实 UI「＋ New Tree」建树 → md-01/md-06/md-11 经
   真实 HTTP API 导入 201 → ready → 侧栏 Materials 三条全部
   「markdown · v1 · ready」，textUnits 与冻结真值一致（1179/1032/5729）。
3. **d4-import-denominator（B1 全分母，新增）**：真实 UI「＋ New Tree」
   建专用树 → **12 markdown + 12 文字层 PDF 全部 24 个 ready fixture**
   经真实导入 API 逐个 201 → ready → textUnits 与冻结真值一致 → 分页
   块读取面（`GET …/versions/:id?afterBlock=`）读尽后与冻结
   canonicalText + 块图（blockId/kind/start/end/page）**逐字节全等**；
   **11 个负例全部如实拒绝**：neg-md-empty 400 invalid-argument 与
   >20MiB 413 material-too-large 均发生在导入门（材料计数前后不变，
   零持久化），invalid-utf8 / nul-byte / whitespace-only / encrypted /
   corrupt / no-text-layer×2 / >200 页 pages-exceeded / >1M 单元
   text-units-exceeded 共 9 例为终态 failed 版本（parseError 携冻结
   原因码、textUnits 0、分块读取 409 material-not-ready）；页面真实
   导航刷新 → 真实侧栏（树列表行真实输入点击切换）**33 条逐条对账**
   （24 ready + 9 failed，failed 条目状态文本 `failed: <原因>:` 前缀 +
   title 属性携完整 parseError）；收尾真实切回场景树。
4. **d4-read-and-select（真实连续拖选，扩展）**：md-06 / md-01 / md-11
   三材料的 **13/13 冻结 B2 选区**捕获载荷逐项全等（emoji/ZWJ/旗帜/
   键帽、重复词第 2/4/5 次出现、跨行、长尾过懒加载）；其中 **2 项为
   真实鼠标手势**：click + Shift+click 两击（md-sel-01），以及**真实连续
   拖选**（mousePressed 置锚「分」左缘 → mouseMoved×8 携按压键跨文本
   推进 → mouseReleased 落「术」右缘；md-sel-02「分治不是另一种技术」
   [448, 457)，此前未覆盖的冻结选区）——拖拽窗口内捕获条冻结（main
   bb4180f 修复），拖中原生选区已核 === 冻结摘录；字素吸附、跨块拒绝、
   resolve-selection 全量复核（sourceHash === SHA-256(冻结 canonicalText)）、
   复制剪贴板读回字节相等，与既有 8 项检查同纪律。
5. d4-restart-continue：blk-52 阅读位置经阅读器自身关闭冲刷落库 →
   SIGTERM → 同数据目录新进程 → 重开恢复（59 块、注记落位、持久行
   跨进程复核、视觉滚动对齐 ≤2px：scrollTop 7207 vs 块顶 7208）。
6. d4-search-recover：5 类命中 + 无结果诚实 + 当前树/全部树范围
   （md-01 + md-vpair + tree-2 md-02 语料），既有检查照旧全绿。
7. **d4-export-restore-recover（B5 恢复组合路径，新增）**：真实 API 建
   事实（md-01 材料 + 材料 Branch「显式另开」mode:"new" + echo 首问 +
   批注 + Return + 主线 turn）→ 导出前该分支 session available、turns=2
   → studio 优雅停止 → **CLI `apps/studio export --out`**（stdout 如实
   声明 sessions excluded by default；facts：trees=3, branches=5, runs=3,
   turns=8, materials=38, material_versions=39, blobs=35）→ **CLI
   `--import-package` 恢复到全新空数据目录**（155 fact rows / 35 blobs；
   stdout 如实声明 no Pi sessions in the package）→ 恢复目录上启动**全新
   studio 进程** → 真实浏览器：
   - 服务端读模型如实：该分支 sessionAvailability **unavailable**、
     旧 turns=2 完整可读（标记在位）；
   - **恢复材料阅读**：侧栏点击 md-01 → 14 块逐字无损 + resolve-selection
     sourceHash 复核 === SHA-256(冻结 canonicalText)；
   - **侧栏 Search 找回**：主线 turn 命中 → 主对话区来源跳转；Return
     命中 → 主线 Return 卡；材料命中（冻结首块短语）→ 恢复阅读器定位；
     **支线 turn 命中行如实携带** session-unavailable 注记 + 「⑃ 新探索」
     显式换轨入口（行级呈现，不依赖面板）；
   - **session 未存活分支的面板打开（D4-3 恢复流）**：阅读器内重建同一
     选区 → 捕获条 → 「⑃ Branch from material」（DOM click，同复制按钮
     管线）→ 恢复二选面（「the session at this branch's continuation
     point is unavailable」如实注记）→「↩ Open the existing exploration」
     → 阅读器退出动画落定后**面板以 alignCursor:false 打开**（不重放
     注定失败的 /switch）：常驻降级注记「Session missing on this
     branch」+ 显式「⑃ Start new exploration」入口在场可用 + 续聊发送
     fail-closed 禁用 + 旧首问 turn 在面板可读；
   - **显式新探索换轨**：composer 真实键入首问（输入值核验）→ 真实
     输入点击「⑃ Start new exploration」→ confirm 二次确认经 CDP 接受
     → 新探索首问落地（服务端 4 turns：旧 2 + 新问/新答对）、composer
     清空、session 注记/换轨入口随新 session 下线、sessionAvailability
     恢复 available、旧历史保持可读。
8. console 纪律：全程序页面 console/Log 错误仅 1 条且属预期排除项——
   B5 停进程窗口内旧端口 `/diagnostics` 的 502（`pageErrorsExcluded: 1`，
   与 d4-restart-continue 同款排除规则；summary.json pageErrors 如实
   全量留存）。

## 脱敏 ID 清单

- 验收器 stdout / sidecar 不含凭据；材料/版本/树/分支 ID 均为本机临时
  数据目录内的随机 UUID，无秘密。studio.log 与 studio-cli.log 已按既有
  纪律脱敏（数据目录以 `<tmp>` 占位符化；echo 模式本身零凭据）。
- B5 的包目录与恢复数据目录为运行机临时目录（`<tmp>`），不入仓、运行后
  留存于运行机 tmp（与 artifacts 目录同生命周期）。

## 注入的故障（如实入证）

- **宿主重启 ×3**：d4-restart-continue 的 studio SIGTERM + 同数据目录
  新进程；B5 的原进程优雅停止 + CLI 导出/恢复 + 恢复目录新进程。
- **session 文件缺失（B5）**：导出后将原数据目录 `sessions/` 移开——
  同机模拟「包缺省不含 session（charter §5）→ 换机后引用文件不存在」；
  恢复进程的实时存在性探针由此如实报告 unavailable。探针结束移回
  （原目录保持原样）。这是**产品语义的忠实模拟**而非破坏：包内本就
  无 session，恢复 CLI 的 stdout 如实声明了这一点。
- **超限输入 ×3**（d4-import-denominator）：>20MiB markdown /
  201 页 PDF / >1M UTF-16 单元 markdown，按 manifest recipe 确定性生成。

## 本波发现（如实记录，均未在本分支修复——apps/studio 前端不属本波文件面）

1. **/switch 对 session 不可用分支返回 502，阻断「重放 /switch」的
   面板打开路径**（产品缺陷，浏览器实测发现）：
   `apps/studio/public/app.js` 的 `openBranchPanel()`（约 L2792）在
   `alignCursor !== false` 时先 `POST /api/trees/:id/switch` 再显示面板；
   服务端 `switchBranch → #ensureSessionAt → restoreSession` 对缺失的
   session 文件抛 session-corrupt（`server.ts` sendError 映射 502）。
   受影响路径（恢复/换机后 session 未存活的支线）：① 搜索命中（对话/
   批注）点击跳转 `jumpToTurnFactHit` / `jumpToAnnotationHit` → 主线
   横幅报错、面板不开（charter §3.2「来源定位不因 session 缺失受阻」
   的意图落空）；② 搜索命中行的「⑃ 新探索」并排入口
   （`searchHitSessionNote`，约 L6714）点击后同样失败；③ 分支 tab 点击
   （renderBranchTabs，约 L816）。ui 套件（ui-search.test.ts L1536 起）
   mock 了 /switch 响应，故从未捕获。**不受影响**：D4-3 材料建枝/恢复
   流（`materialBranchResumeExisting` 以 alignCursor:false 开面板，恢复
   响应的 navigation 字段已如实分离携带对齐失败）与主线命中（不开
   面板）。建议修复方向：openBranchPanel 对 /switch 失败降级为
   「面板照开 + 游标未对齐如实注记」（或服务端对 missing-file 降级
   返回 null cursor）。
2. **连续拖选释放后原生选区高亮被应用的 mouseup 冲刷销毁**（交互
   观察，浏览器实测发现）：`updateMatSelectionBar()` 的拖拽窗口冻结
   （main bb4180f 修复）置 `materialPendingUpdate`；mouseup 时
   `flushPendingRerender → renderMaterialReader()` 以
   `root.replaceChildren()` 摘挂 `#mat-blocks`——Chrome 对被 detach 的
   选区**静默销毁**（无 selectionchange 事件，事件序实测
   mousedown → selectionchange×10 → mouseup:9 → click:9 → 选区空）。
   捕获条在冲刷前已同步武装（armFromEvent 先 armMaterialSelection 再
   排队冲刷），载荷精确、可复制、可建枝——**捕获语义完好**，但用户
   拖选后正文高亮立即消失（视觉反馈缺失）。建议修复方向：mouseup
   冲刷路径保持 #mat-blocks 不脱离文档（或冲刷后按武装载荷重放选区）。
3. **CDP 工具事实**（非产品缺陷，入档供后续探针复用）：①
   `Input.dispatchMouseEvent` mouseMoved 若不带按压键（button:"none"），
   本机 headless Chrome 153 不扩展原生选区（裸页四变体实测：none×2
   空、left×2 选中）——连续拖选的 move 必须携带 `button:"left",
   buttons:1`（Puppeteer 同款管线）；② 阅读器为支线列覆盖层
   （z-index 高于面板）且退出动画 170ms——覆盖层未落定前对面板的
   输入点击会落在阅读器上（探针已按真实用户节奏等待 hidden）。

## 复验命令

```bash
git clone https://github.com/Lortzing/TreeAI.git && cd TreeAI
git checkout af517de0d40cbeacfe26e1923ebf13de077f47c3   # 分支 wip/d4-browser-ev
node --version && npm --version   # 24.21.0 / 11.19.0
npm ci
npm run --workspace @treeai/event-journal build:test   # studio 运行需要 dist（npm test 亦会构建）
node scripts/run-d4-browser.mjs --mode selftest        # 需本机 Chrome/Chromium；期望 10 PASS / 0 FAIL / 0 BLOCKED / 2 NOT_RUN（exit 0）
npm test                                               # 751 tests / 751 pass / 0 fail（exit 0，与 main 基线一致）
npm run verify:d4                                      # 15 PASS / 0 FAIL / 0 BLOCKED / 5 NOT_RUN（既有 D4 矩阵状态，无回归）
```

截图（01/02/04/06–10/12/14–22-*.jpg，含分母侧栏 33 条、恢复阅读器、
session-unavailable 面板、新探索落位）为该次运行的真实 CDP 截屏，按仓库
惯例（evidence 无二进制先例）不入仓，留存于运行机
`/tmp/d4br-evidence-final/`。文本证据（JSON sidecar ×6 + stdout.log +
studio.log + studio-cli.log + summary.json）入仓于本目录。
