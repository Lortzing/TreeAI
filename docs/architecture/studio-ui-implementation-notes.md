# Studio UI behavior and historical implementation decisions

This note was mechanically moved from the original header of `apps/studio/public/app.js` to keep routine source reads focused. It captures implementation commentary, **not** a replacement for signed product contracts or runtime tests. Consult code and product authorities for current behavior.

---

交互模型（W2 §1–§2，issue #2 P1「主线阅读 + 局部支线」）：
 - 主阅读面板始终跟随主线（Trunk）：阅读、续聊、Return 卡渲染都在主线；
 - 支线以锚点作用域的局部侧板打开（覆盖层，不做整页 tab 切换）——
   面板开合与转场期间主线布局与阅读位置不动；面板头部固定常驻
   「来源揭示 / 回主干」操作（不随滚动消失）；
 - 分支 tab 保留为切换器：支线 tab = 打开该支线面板；Trunk tab = 收起
   面板回主线。切换仍 POST /switch（服务端对齐 Pi 游标），UI 不再整页换视图；
 - 锚点 Return 卡渲染在主干 targetAnchor 原分叉点附近（W1 §2.2）；降级
   放置（锚点不在当前视图）同样携带 targetAnchor 快照并区分「来源位于
   其他 Branch / 已变化 / 缺失」（issue #7 P1：摘录 + 来源路径在卡面
   可读，长摘录折叠；确认时间取产品 createdAt，首次成功采用时间从采用
   尝试记录反查）；采用状态词汇（signed v3 §3.2）：saved — pending
   adoption（已保存，尚无 Run 组装过）→ adoption attempted（已有 Run
   组装过、其中尚无成功——失败/中止后仍 pending，随下次主干讨论重试）
   → successfully adopted（deliveredRunId 首次成功采用，可反查来源抽屉
   中该 run 的出处条目）；提交后的回程导航失败以「已保存，返回主线失
   败」分开呈现（signed v3 §3.5），绝不把已保存的 Return 伪装成未提交；
 - Return 草稿持久化于 localStorage（key = tree+branch；W1 §2.1：draft
   仅客户端，不落 TreeAI DB、不是模型上下文、未显式提交前永不生效）；
   提交成功 / 响应丢失对账命中（幂等键 + 来源分支 + 文本全同）即清除；
   导航失败不清回「未保存」态（保存已成功，草稿照常清除）；面板打开时
   先对账，已落库的草稿直接丢弃并呈现已保存/已采用卡；同键异容 =
   显式冲突（保留草稿与面板，编辑换新键）；失败保留草稿与幂等键供同键
   重试；
 - 每分支阅读位置恢复（W2 §4）：滚动位置按 tree:branch 记忆，切走再回
   恢复原位；接收新 turn / 流式增量的视图只在用户本就贴底时跟随贴底
   （已向上阅读绝不强制滚底，issue #3 P1；首次打开无记录直接落底）。

术语三部分配套前端（issue #7 C ③，消费 ①执行器/②服务语义，不重复实
现服务端）：
 - 正文/操作分层：每个 assistant turn 的正文是自己的层（turn 元素承载
   前导正文区——纯文本节点 + 统一区间覆盖；textContent 恒等于原文，复
   制行为不变），动作/覆盖层（按钮/工具条）在尾部 .turn-actions；turn
   元素按 (turnId, text) 跨重渲复用（reconcileTopLevel 按位调和——结构
   未变的异步刷新零 DOM 变更，不再整容器 replaceChildren）；
 - 统一标注/来源区间：术语批注与来源揭示高亮共用同一覆盖机制（绝对
   UTF-16 偏移，W1 §1.1），覆盖只包裹不改写文本，重渲后按存储偏移重
   算复现；已保存批注在正文上呈常驻下划线（点击重开卡）；
 - 批注锚定联合校验 + 异步写点竞态守卫（issue #7 增量验收 2026-09-30
   P0/P1）：活覆盖渲染前联合校验界内区间 + 摘录切片 + 全文指纹
   （sourceHash——内置与服务端 hashSourceText 同口径的无依赖 SHA-256），
   任一失配绝不把批注挂到当前文本，降级为「保存快照 + source
   changed/missing 说明」（W1 降级 Return 卡同款纪律；抽屉列表与解释卡
   两处降级呈现）；术语读模型与状态类异步写入（保存/推广/偏好/journal/
   SSE 终态刷新/开树）一律先验「请求树 + 世代号」再落 state——迟到的
   响应（切树后到达 / 被更新请求取代）如实丢弃，绝不把 A 树的数据写进
   B 树的共享界面状态；
 - 选择期间不重绘：武装选区（mouseup/双击/触屏 selectionchange）期间
   异步刷新不换走正文层；mousedown→mouseup 拖拽窗口内整树重渲延后，
   mouseup 后 0ms 冲刷（click 先于冲刷，按钮不被换走）；
 - 模式/工具条：选区工具条按服务端模式呈现（点词 term/划线 range），
   含建支线（通用入口，绝不复用已有探索）与批注/推广捷径；执行器
   模式/用量/缓存偏好面在来源抽屉（Terminology 节）；
 - 阅读模式三选一（issue #7 术语①，2026-10-01）：每树 manual-only
   （默认）/ minimal-hints / assisted-reading——抽屉 Terminology 节的
   模式选择器（PUT settings/reading-mode；gate 未过旁注如实：自动建议
   保持关闭，仅手动生效）；回答完成后（SSE run-terminal / prompt 收尾
   双入口刷新读模型）在答案区渲染建议条——pending/ready/partial（「还
   有 N 个候选未显示」）/no-suggestions/budget-paused（可恢复入口：
   Retry + 提示提高预算）/failed/source-invalid（快照展示）各状态如实；
   建议**只展示**：点击 chip 预填该词的解释请求，「⌖ Explain」显式确认
   才发（Esc/Dismiss 解除，焦点还原）；pending 建议集由有界轮询跟随
   （1s×90，切树即停）；绝不自动解释/自动保存批注；
 - 解释卡完整状态：in-flight / 成功（含缓存命中注记）/ 失败（诚实错
   误 + 重试）/ 取消（含迟到丢弃注记）/ 保存幂等命中（显示既有批注）/
   推广成功（同键重放如实）/ 推广冲突（409 如实 + 恢复既有探索的去
   向）；已推广批注呈 resume-or-create 明确二选，绝不跨语境静默复用；
 - 响应式（<720px 工具条/卡片全宽 + 大触点）/ 键盘（Tab 顺序、Esc 分
   层关卡 + 焦点还原）/ 触屏（selectionchange 武装）/ reduced-motion
   （卡进场动效即时化——CSS 全局降级块 + 显式规则）。

D4-2 材料阅读（issue #8 工作包 D4-2「阅读与来源定位」前端增量；charter
§3.2 锚点与材料阅读 / 契约 §3 已落地的材料 HTTP 面）：
 - 侧栏 Materials 段（Forest/Branches/Materials 三段同栏）：当前树关联
   材料的列表——标题、种类、版本标签、解析状态（ready/failed/canceled/
   unsupported/pending/parsing 各自如实呈现；failed 带原因，绝不伪装成
   空文档）；导入 UI 不在本分支（D4-1 的 HTTP 面已就绪，列表按 API 返回
   如实呈现，空态给出指引）；三态纪律（加载中/已载/失败 + 重试）与树列
   表、journal 同款；
 - 阅读器（右列工作面，与支线面板同一可见性契约：hidden + .enter/.exit，
   Esc 关闭 + 焦点还原，z-index 在支线面板之上）：按块渲染 canonicalText
   （?afterBlock= 分页懒加载 + 有界窗口裁剪，DOM 不无界增长），渲染是
   **逐字无损**的——markdown 语法字符全部保留在文本中（标题/强调/行内
   代码/链接语法只加样式不删字符），块 textContent 与 canonicalText 切片
   字节相等，每个块元素携带 blockId 与绝对 UTF-16 区间（charter §3.2
   「渲染必须保留到规范文本的映射」的结构性保证；绝不解析文本为 HTML）；
 - 选区捕获（武装纪律同正文层：mousedown→mouseup 拖拽窗口内不重绘、
   selectionchange 触屏武装）：绝对偏移换算（前缀长度法）+ 块内校验
   （excerpt === 块文本切片）+ 字素安全（Intl.Segmenter 图素簇边界外的
   选区边界向外吸附到整簇，绝不产生劈开代理对/组合字符/emoji 的载荷）；
   跨块选区如实呈「不可锚定」（B2 纪律：markdown 选区必须含于单块），
   不给出错误载荷；捕获载荷（materialId/versionId/blockId/start/end/
   excerpt）如实展示（D4-3 落地后即建枝流程的锚点载荷——见 D4-3 段）；
   「复制摘录」按 canonicalText 切片复制原文；
 - 版本可辨认（charter §3.1）：阅读器头部标明所渲染版本；非最新版本
   显式标注 older + 「切换到最新」的非破坏性入口（旧版本保持可读、随
   版本链可切回；绝不自动迁移锚点）；版本链上每版状态如实；
 - 阅读位置（charter §3.2「原文阅读与分支探索各自保留位置」）：按
   Tree×材料 服务端持久化（PUT reading-position，滚动节流 + 关闭/切版
   本/切树时立即保存），打开时按 detail.readingPosition 恢复（跨页向前
   补载到目标块）；与对话阅读位置（scrollPositions，分支事实）完全
   独立；
 - 诚实状态面：PDF 材料显式「PDF 阅读器随下一个 D4-2 增量落地」（本
   分支只有 Markdown 阅读器，不伪造页面）；非 ready 版本（pending/
   parsing/failed/canceled/unsupported/rejected）各按事实呈现（含原因
   与刷新入口）；网络/API 失败可见可重试，绝不折叠成空态。

D4-4 找回既有思考 —— 搜索前端（issue #8 工作包 D4-4；charter §5「搜索」
+ §6 B4 的浏览器面；消费已落地的 POST /api/trees/:id/search 与
POST /api/search）：
 - 入口在侧栏（Forest/Branches/Materials/Search 同栏四段——检索是找回
   既有思考的导航面，不另开整页视图）：输入框 + 范围开关（默认当前树，
   显式切全部树——无树打开时「当前树」如实禁用、范围回落全部树）+
   来源类型筛选（材料/批注/Return/对话，按契约 kinds 透传服务端过滤）；
 - 只索引已保存产品事实（服务端契约已裁决）——未提交 Return 草稿、
   术语解释缓存结构性不入索引；本面在空态如实声明，绝不暗示草稿可搜；
   搜索纯只读：浏览/搜索不创建 Turn（charter §3.3），跳转对服务端游标
   无副作用（材料命中不开面板、不 POST /switch——与 D4-2 阅读器同纪律）；
 - 结果按服务端返回序确定性呈现（引擎全序：档位/类型/次数/时间/refId，
   客户端不重排）：来源类型徽标、标题、版本标签（旧版本命中显式标注
   「旧版本」——版本诚实同 D4-2）、含命中的摘录、时间；零命中如实空
   态（不编造、不给近似匹配），请求失败如实呈现可重试；
 - 点击命中跳既有视图（charter §5「结果跳转后可继续原探索」）：
     · 材料命中 → D4-2 阅读器打开该材料的**命中版本**（旧版本命中即
       打开旧版本只读面——版本链/never-migrate 注记复用 D4-2 纪律），
       并定位到命中块（跨页前补到目标块出现，与阅读位置恢复同一循环）；
     · 批注命中 → 定位锚定答案（主线或支线面板）并打开已保存批注卡
       （openSavedAnnotationCard）；锚点答案缺失时退到来源抽屉的
       Terminology 快照列表（保存快照照常可读，不伪造正文定位）；
     · Return / 对话命中 → 定位到该 turn 的既有视图（Return 卡在主线、
       支线 turn 在支线面板——打开面板走既有 switch 语义）；
   命中的事实 id 不在契约 SearchHit 内（HTTP 裁剪面剥离 refId）——
   客户端以 kind+createdAt+标题头（与服务端 headOf 同算法）+ 摘录切片
   反查已加载树态定位事实；查不到时如实说明（不跳到近似位置）；
 - session 不可用（charter §3.2：来源定位与 Pi 续聊分别判断）：命中若
   可解析到当前已加载树态中 session 不可用的分支，行内并排给出显式
   「⑃ 新探索」入口（按命中所在分支路由：支线命中开面板聚焦面板
   composer、主线命中聚焦主线 composer——既有 v3 §4.4 换轨入口承接首
   问，不另造第二条换轨路径）；来源跳转永不因此受阻（跳转只呈现已
   保存事实，不触碰 session）。

D4-3 原文探索闭环前端（issue #8 工作包 D4-3 / charter §3.3 / ADR-004；
消费已落地的四个 HTTP 端点——服务 apps/studio/src/materials/branching.ts）：
 - 建枝入口（规则一）：阅读器武装选区的捕获条给出「⑃ Branch from
   material」。提交前先经 D4-2 resolve-selection 把捕获载荷换成**规范
   MaterialSelection**（服务端复核切片/块/sourceHash——阅读器窗口可能被
   裁剪，客户端不自行伪造 sourceHash），再 POST from-material
   {selection, intentKey, mode:"resume-or-create"}。intentKey 标识一次
   逻辑提交（建枝+首问），跨失败重试/页面刷新经 localStorage 稳定复用
   （同键重放同枝零新行——服务端原子绑定）；显式另开换新键。
 - 提交前的材料范围声明（规则三，charter「UI 在提交前说明本次使用的材
   料范围」）：from-material 响应的组合上下文视图（选区摘录 + 有界邻近
   块窗口 + 标题/版本 + 上限/截断标记 + 组合文本预览）在首问输入旁完整
   呈现——截断时显式标注（truncationNote 原文）；组合文本与派发时逐字
   节相同（服务端确定性），<details> 内可全文核对。建枝本身零 Run/Turn
   （浏览/搜索不创建 Turn）；首问是独立的显式提交。
 - 幂等首问（规则四/五，先对账后行动）：submitting 在途锁杜绝双发（双
   击/响应丢失不重发）；dispatch succeeded（outcome null = 同键重放，
   不重复派发——如实注记）；failed = 明确失败可同键重试（显式新尝试）；
   unknown = 在途对账不决——**不盲发**，如实呈现并等用户处置。409
   material-first-question-conflict（同分支首问不可变）如实呈现，并给出
   「改问走普通续聊」的去向（开面板预填问题，用户显式发送）。
 - 恢复 vs 另开（规则五/六，同来源可恢复已有探索也可显式另开）：
   resume-or-create 命中恢复 → 明确二选（打开既有分支续聊 / 显式另开
   新枝——新键新提交）；恢复分支零 turn 时如实注明「续聊是普通 prompt、
   不带组合材料上下文」，另开才有完整首问流。挂起的 intentKey（建枝后
   未问）在重进同一选区时复用——恢复响应 + 已存键直达声明面（刷新/重
   启后的诚实续走）。导航/会话可用性结果分离携带（失败如实，恢复本身
   不被掩盖）。
 - 材料 Return（规则七）：材料分支的面板 Return 走 material-return（响
   应携带来源卡）；幂等键纪律与 Turn 来源 Return 完全共用（草稿持久化/
   同键重放/响应丢失对账）。主线 Return 卡按 targetAnchor null（材料来
   源没有主线对话锚点，绝不伪造）+ 来源分支无 turn origin 识别材料
   Return，渲染材料来源卡：材料标题/版本/解析器/块·页/摘录/确认时间/
   采用记录（树态实时）+ 原文跳转（sourceJump → 阅读器按版本+块定位，
   复用 D4-4 搜索跳转的定位机制）。卡片数据（来源卡字段）从提交响应
   缓存（localStorage，按 tree:turn），缓存缺失时如实注明（Return 本身
   完好，绝不伪造来源细节）。
 - 缺 session 显式新探索（规则八）：材料分支的「⑃ Start new exploration」
   走 material-new-exploration（材料上下文随行）——可见性/确认流/收尾
   与 Turn 来源分支的换轨入口完全一致（v3 §4.4 既有语义）。
 - 材料分支的可辨认：分支 tab 标记 · material；面板头部呈材料来源上下
   文（标题/版本/块/摘录——来源缓存自建枝/恢复响应，缺失时如实注明）；
   「⌖ View source」对材料分支跳原文（对 Turn 来源分支仍是锚点揭示）。

D4-8 大规模树导航前端（issue #8 工作包 D4-8 / charter §5 + §6 B9；消费
已落地的 /api/nav/* 只读产品事实面——服务 apps/studio/src/nav/*）：
 - 侧栏 Navigate 段（Forest/Branches/Navigate/Materials/Search 同栏五段
   ——层级导航是树的结构事实面，不另开整页视图）：树查找（空输入 = 分页
   森林列表 /api/nav/trees + More 翻页；有输入 = /api/nav/search/trees
   标题/标识确定性搜索），点击在导航面打开该树（单树概览 + 根子节点首页
   + 展开状态恢复）；导航会话与工作台当前树相互独立（跨树浏览不打断主
   线阅读）；
 - 层级树视图（charter「不能一次渲染全部节点」）：子节点按需经游标分页
   加载（children 端点 limit 50 + More 行 + 窗口内自动续页），折叠/展开
   逐节点；展开状态与选中节点经 PUT expand-state 整组持久化（重启后
   GET 恢复——迁移 0010 的事实面），恢复按世代守卫串行续页到目标节点；
 - 虚拟化纪律（B9「虚拟化 DOM 随可视区域增长而非全量节点增长」）：
   可见行序（展开集合的先序走行）按滚动窗口渲染——窗口 = scrollTop/
   固定行高 ± overscan，窗口外仅留高度占位（spacer）行；状态行如实
   呈现「rendering N/M visible rows」的窗口口径；
 - 同名消歧（charter §5）：行内携带分支 id 与子数徽标（id 即身份），
   长标题 CSS 截断 + title 属性全文；当前节点的完整父路径单列呈现
   （path 端点 100 层完整返回；>6 层可收拢但「show full path」展开后
   完整在场——收拢是显示态不是数据截断）；分支搜索命中各携带完整路径；
 - 键盘（charter「键盘可逐层移动与展开」）：↑/↓ 沿可见行序逐行移动，
   → 展开（或入首子）、← 收起（或回父）、Enter 选中、Home/End 首末行；
   焦点行采用 roving tabindex——窗口重划后焦点行必在 DOM（超出窗口的
   移动先滚动再渲染再落焦，焦点不因虚拟化消失）；
 - 定位与来源：⌖ Locate current branch 跨树定位工作台当前分支（locate
   端点；异树即切换导航树）并展开祖先链续页至目标可见；⌖ Source of
   selected 跳回所选节点的来源——turn 来源走既有 revealOrigin（/source
   揭示 + 降级纪律），material 来源走既有阅读器按版本+块定位
   （sourceJump 语义）；目标树不在工作台时先 openTree 进入（工作台自身
   的既有行为），trunk/无来源如实说明、绝不伪造近似位置；
 - 诚实状态面：加载中/失败 + 重试、stale-cursor 409 从首页重拉（索引
   失效后旧游标不自愈）、503 nav-not-wired 如实说明（该进程未装配导航
   服务）、空树指引（只有主干时说明如何长出分支）。产品树 ≠ 运行
   session 树：导航面从不读取/渲染 session 可用性。

范围（诚实声明）：对话 turn 无 Markdown 渲染、无自动摘要（材料阅读器
  的 markdown 渲染是**无损字面渲染**——见 D4-2 段，与 turn 渲染无关）。
  其余既有事实面：
 - 在 assistant 答案内选中文本 → “Branch from here”（无选区 = 整条答案）；
 - 诊断/状态条：当前 run 状态、失败码与消息（失败面板不自动消失）、
   在途时 Abort、“未观测策略决策”的如实呈现（Studio 无工具执行器
   ——绝不声称未接入的策略执行）；
 - 来源抽屉：per-run 出处、Return 出处与 journal 尾部的保守摘要（工具
   活动如实空态——Studio 离线以空工具 allowlist 运行）；journal 拉取
   三态呈现——加载中 / 已载（含如实空态）/ 加载失败 + 重试（失败绝不
   伪装成“无事件”，W2 §2.7 打开-加载失败、issue #3 P1）；
 - 缺失 session 降级（A4/W2 §2.8 + v3 §4.4）：分支徽标 + 横幅（树保持
   可读、续聊发送 fail-closed 且入口禁用并说明原因），恢复方式是可直接
   执行的按钮（从 session 仍可用的最新 assistant 答案整条建支线——近似
   说明见 findSessionRecoveryAnchor）**加上**「以保存内容开始新的探索」
   （v3 §4.4：session 不可用分支的显式换轨入口——输入框保持可输入以
   键入首问，「⑃ Start new exploration」提交经 confirm 二次确认，服务
   端新建 session 并把锚点摘录 + 已保存历史作为首问上下文带入；绝不
   冒充旧会话恢复）；session-corrupt 失败时同样提示。横幅
   dismiss 为页面级持久状态（重渲不复活；主干恢复可用或执行恢复动作
   时清除）。prompt 失败（含 session-corrupt）的终局渲染是硬保证：
   流式占位清除、恢复横幅/降级提示、最终树态与诊断面都在错误上抛前
   落位（不依赖 SSE 事件收尾）。
 - W2 §2.1/§2.4/§2.6/§2.7 补齐（issue #6 P1 偏差修复，向源设计靠拢）：
   启动初始焦点编程设定到“新建”（仅启动一次，重渲不夺焦点）；树列表
   加载失败呈侧栏常驻重试面（错误 + Retry——在途禁用明示，持久失败
   保持可用，不整页刷新；无树打开时恢复后补齐启动语义）；错误横幅
   role="alert" + tabindex="0"（可 Tab 触达并朗读）；锚点揭示降级时
   焦点移到面板头部锚点上下文（持久说明区，取舍见 revealOrigin 注释）；
   窄窗抽屉自底向上为纯 CSS 变更（见 style.css 窄窗 @media）。

动效分镜（W2 §3，M1–M7）：全部短促、无循环装饰；streaming 指示为静态
caret（不闪烁）；每个动效在 prefers-reduced-motion 下即时化（CSS 全局
降级 + JS 侧 matchMedia 控制滚动 behavior）。

事件流：EventSource 订阅 /api/trees/:id/events（snapshot 后推送
run-started / message-delta / abort-requested / run-terminal /
tool-activity）。SSE 不可用时降级为 prompt 在途时轮询诊断面（既有
行为）；/diagnostics 仍用于初始加载。
