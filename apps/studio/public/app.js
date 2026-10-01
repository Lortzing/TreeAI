/* TreeAI Studio — D3 Core MVP 前端（vanilla JS，无构建步骤）。
 *
 * 交互模型（W2 §1–§2，issue #2 P1「主线阅读 + 局部支线」）：
 *  - 主阅读面板始终跟随主线（Trunk）：阅读、续聊、Return 卡渲染都在主线；
 *  - 支线以锚点作用域的局部侧板打开（覆盖层，不做整页 tab 切换）——
 *    面板开合与转场期间主线布局与阅读位置不动；面板头部固定常驻
 *    「来源揭示 / 回主干」操作（不随滚动消失）；
 *  - 分支 tab 保留为切换器：支线 tab = 打开该支线面板；Trunk tab = 收起
 *    面板回主线。切换仍 POST /switch（服务端对齐 Pi 游标），UI 不再整页换视图；
 *  - 锚点 Return 卡渲染在主干 targetAnchor 原分叉点附近（W1 §2.2）；降级
 *    放置（锚点不在当前视图）同样携带 targetAnchor 快照并区分「来源位于
 *    其他 Branch / 已变化 / 缺失」（issue #7 P1：摘录 + 来源路径在卡面
 *    可读，长摘录折叠；确认时间取产品 createdAt，首次成功采用时间从采用
 *    尝试记录反查）；采用状态词汇（signed v3 §3.2）：saved — pending
 *    adoption（已保存，尚无 Run 组装过）→ adoption attempted（已有 Run
 *    组装过、其中尚无成功——失败/中止后仍 pending，随下次主干讨论重试）
 *    → successfully adopted（deliveredRunId 首次成功采用，可反查来源抽屉
 *    中该 run 的出处条目）；提交后的回程导航失败以「已保存，返回主线失
 *    败」分开呈现（signed v3 §3.5），绝不把已保存的 Return 伪装成未提交；
 *  - Return 草稿持久化于 localStorage（key = tree+branch；W1 §2.1：draft
 *    仅客户端，不落 TreeAI DB、不是模型上下文、未显式提交前永不生效）；
 *    提交成功 / 响应丢失对账命中（幂等键 + 来源分支 + 文本全同）即清除；
 *    导航失败不清回「未保存」态（保存已成功，草稿照常清除）；面板打开时
 *    先对账，已落库的草稿直接丢弃并呈现已保存/已采用卡；同键异容 =
 *    显式冲突（保留草稿与面板，编辑换新键）；失败保留草稿与幂等键供同键
 *    重试；
 *  - 每分支阅读位置恢复（W2 §4）：滚动位置按 tree:branch 记忆，切走再回
 *    恢复原位；接收新 turn / 流式增量的视图只在用户本就贴底时跟随贴底
 *    （已向上阅读绝不强制滚底，issue #3 P1；首次打开无记录直接落底）。
 *
 * 术语三部分配套前端（issue #7 C ③，消费 ①执行器/②服务语义，不重复实
 * 现服务端）：
 *  - 正文/操作分层：每个 assistant turn 的正文是自己的层（turn 元素承载
 *    前导正文区——纯文本节点 + 统一区间覆盖；textContent 恒等于原文，复
 *    制行为不变），动作/覆盖层（按钮/工具条）在尾部 .turn-actions；turn
 *    元素按 (turnId, text) 跨重渲复用（reconcileTopLevel 按位调和——结构
 *    未变的异步刷新零 DOM 变更，不再整容器 replaceChildren）；
 *  - 统一标注/来源区间：术语批注与来源揭示高亮共用同一覆盖机制（绝对
 *    UTF-16 偏移，W1 §1.1），覆盖只包裹不改写文本，重渲后按存储偏移重
 *    算复现；已保存批注在正文上呈常驻下划线（点击重开卡）；
 *  - 批注锚定联合校验 + 异步写点竞态守卫（issue #7 增量验收 2026-09-30
 *    P0/P1）：活覆盖渲染前联合校验界内区间 + 摘录切片 + 全文指纹
 *    （sourceHash——内置与服务端 hashSourceText 同口径的无依赖 SHA-256），
 *    任一失配绝不把批注挂到当前文本，降级为「保存快照 + source
 *    changed/missing 说明」（W1 降级 Return 卡同款纪律；抽屉列表与解释卡
 *    两处降级呈现）；术语读模型与状态类异步写入（保存/推广/偏好/journal/
 *    SSE 终态刷新/开树）一律先验「请求树 + 世代号」再落 state——迟到的
 *    响应（切树后到达 / 被更新请求取代）如实丢弃，绝不把 A 树的数据写进
 *    B 树的共享界面状态；
 *  - 选择期间不重绘：武装选区（mouseup/双击/触屏 selectionchange）期间
 *    异步刷新不换走正文层；mousedown→mouseup 拖拽窗口内整树重渲延后，
 *    mouseup 后 0ms 冲刷（click 先于冲刷，按钮不被换走）；
 *  - 模式/工具条：选区工具条按服务端模式呈现（点词 term/划线 range），
 *    含建支线（通用入口，绝不复用已有探索）与批注/推广捷径；执行器
 *    模式/用量/缓存偏好面在来源抽屉（Terminology 节）；
 *  - 阅读模式三选一（issue #7 术语①，2026-10-01）：每树 manual-only
 *    （默认）/ minimal-hints / assisted-reading——抽屉 Terminology 节的
 *    模式选择器（PUT settings/reading-mode；gate 未过旁注如实：自动建议
 *    保持关闭，仅手动生效）；回答完成后（SSE run-terminal / prompt 收尾
 *    双入口刷新读模型）在答案区渲染建议条——pending/ready/partial（「还
 *    有 N 个候选未显示」）/no-suggestions/budget-paused（可恢复入口：
 *    Retry + 提示提高预算）/failed/source-invalid（快照展示）各状态如实；
 *    建议**只展示**：点击 chip 预填该词的解释请求，「⌖ Explain」显式确认
 *    才发（Esc/Dismiss 解除，焦点还原）；pending 建议集由有界轮询跟随
 *    （1s×90，切树即停）；绝不自动解释/自动保存批注；
 *  - 解释卡完整状态：in-flight / 成功（含缓存命中注记）/ 失败（诚实错
 *    误 + 重试）/ 取消（含迟到丢弃注记）/ 保存幂等命中（显示既有批注）/
 *    推广成功（同键重放如实）/ 推广冲突（409 如实 + 恢复既有探索的去
 *    向）；已推广批注呈 resume-or-create 明确二选，绝不跨语境静默复用；
 *  - 响应式（<720px 工具条/卡片全宽 + 大触点）/ 键盘（Tab 顺序、Esc 分
 *    层关卡 + 焦点还原）/ 触屏（selectionchange 武装）/ reduced-motion
 *    （卡进场动效即时化——CSS 全局降级块 + 显式规则）。
 *
 * D4-2 材料阅读（issue #8 工作包 D4-2「阅读与来源定位」前端增量；charter
 * §3.2 锚点与材料阅读 / 契约 §3 已落地的材料 HTTP 面）：
 *  - 侧栏 Materials 段（Forest/Branches/Materials 三段同栏）：当前树关联
 *    材料的列表——标题、种类、版本标签、解析状态（ready/failed/canceled/
 *    unsupported/pending/parsing 各自如实呈现；failed 带原因，绝不伪装成
 *    空文档）；导入 UI 不在本分支（D4-1 的 HTTP 面已就绪，列表按 API 返回
 *    如实呈现，空态给出指引）；三态纪律（加载中/已载/失败 + 重试）与树列
 *    表、journal 同款；
 *  - 阅读器（右列工作面，与支线面板同一可见性契约：hidden + .enter/.exit，
 *    Esc 关闭 + 焦点还原，z-index 在支线面板之上）：按块渲染 canonicalText
 *    （?afterBlock= 分页懒加载 + 有界窗口裁剪，DOM 不无界增长），渲染是
 *    **逐字无损**的——markdown 语法字符全部保留在文本中（标题/强调/行内
 *    代码/链接语法只加样式不删字符），块 textContent 与 canonicalText 切片
 *    字节相等，每个块元素携带 blockId 与绝对 UTF-16 区间（charter §3.2
 *    「渲染必须保留到规范文本的映射」的结构性保证；绝不解析文本为 HTML）；
 *  - 选区捕获（武装纪律同正文层：mousedown→mouseup 拖拽窗口内不重绘、
 *    selectionchange 触屏武装）：绝对偏移换算（前缀长度法）+ 块内校验
 *    （excerpt === 块文本切片）+ 字素安全（Intl.Segmenter 图素簇边界外的
 *    选区边界向外吸附到整簇，绝不产生劈开代理对/组合字符/emoji 的载荷）；
 *    跨块选区如实呈「不可锚定」（B2 纪律：markdown 选区必须含于单块），
 *    不给出错误载荷；捕获载荷（materialId/versionId/blockId/start/end/
 *    excerpt）如实展示（D4-3 落地后即建枝流程的锚点载荷——见 D4-3 段）；
 *    「复制摘录」按 canonicalText 切片复制原文；
 *  - 版本可辨认（charter §3.1）：阅读器头部标明所渲染版本；非最新版本
 *    显式标注 older + 「切换到最新」的非破坏性入口（旧版本保持可读、随
 *    版本链可切回；绝不自动迁移锚点）；版本链上每版状态如实；
 *  - 阅读位置（charter §3.2「原文阅读与分支探索各自保留位置」）：按
 *    Tree×材料 服务端持久化（PUT reading-position，滚动节流 + 关闭/切版
 *    本/切树时立即保存），打开时按 detail.readingPosition 恢复（跨页向前
 *    补载到目标块）；与对话阅读位置（scrollPositions，分支事实）完全
 *    独立；
 *  - 诚实状态面：PDF 材料显式「PDF 阅读器随下一个 D4-2 增量落地」（本
 *    分支只有 Markdown 阅读器，不伪造页面）；非 ready 版本（pending/
 *    parsing/failed/canceled/unsupported/rejected）各按事实呈现（含原因
 *    与刷新入口）；网络/API 失败可见可重试，绝不折叠成空态。
 *
 * D4-4 找回既有思考 —— 搜索前端（issue #8 工作包 D4-4；charter §5「搜索」
 * + §6 B4 的浏览器面；消费已落地的 POST /api/trees/:id/search 与
 * POST /api/search）：
 *  - 入口在侧栏（Forest/Branches/Materials/Search 同栏四段——检索是找回
 *    既有思考的导航面，不另开整页视图）：输入框 + 范围开关（默认当前树，
 *    显式切全部树——无树打开时「当前树」如实禁用、范围回落全部树）+
 *    来源类型筛选（材料/批注/Return/对话，按契约 kinds 透传服务端过滤）；
 *  - 只索引已保存产品事实（服务端契约已裁决）——未提交 Return 草稿、
 *    术语解释缓存结构性不入索引；本面在空态如实声明，绝不暗示草稿可搜；
 *    搜索纯只读：浏览/搜索不创建 Turn（charter §3.3），跳转对服务端游标
 *    无副作用（材料命中不开面板、不 POST /switch——与 D4-2 阅读器同纪律）；
 *  - 结果按服务端返回序确定性呈现（引擎全序：档位/类型/次数/时间/refId，
 *    客户端不重排）：来源类型徽标、标题、版本标签（旧版本命中显式标注
 *    「旧版本」——版本诚实同 D4-2）、含命中的摘录、时间；零命中如实空
 *    态（不编造、不给近似匹配），请求失败如实呈现可重试；
 *  - 点击命中跳既有视图（charter §5「结果跳转后可继续原探索」）：
 *      · 材料命中 → D4-2 阅读器打开该材料的**命中版本**（旧版本命中即
 *        打开旧版本只读面——版本链/never-migrate 注记复用 D4-2 纪律），
 *        并定位到命中块（跨页前补到目标块出现，与阅读位置恢复同一循环）；
 *      · 批注命中 → 定位锚定答案（主线或支线面板）并打开已保存批注卡
 *        （openSavedAnnotationCard）；锚点答案缺失时退到来源抽屉的
 *        Terminology 快照列表（保存快照照常可读，不伪造正文定位）；
 *      · Return / 对话命中 → 定位到该 turn 的既有视图（Return 卡在主线、
 *        支线 turn 在支线面板——打开面板走既有 switch 语义）；
 *    命中的事实 id 不在契约 SearchHit 内（HTTP 裁剪面剥离 refId）——
 *    客户端以 kind+createdAt+标题头（与服务端 headOf 同算法）+ 摘录切片
 *    反查已加载树态定位事实；查不到时如实说明（不跳到近似位置）；
 *  - session 不可用（charter §3.2：来源定位与 Pi 续聊分别判断）：命中若
 *    可解析到当前已加载树态中 session 不可用的分支，行内并排给出显式
 *    「⑃ 新探索」入口（按命中所在分支路由：支线命中开面板聚焦面板
 *    composer、主线命中聚焦主线 composer——既有 v3 §4.4 换轨入口承接首
 *    问，不另造第二条换轨路径）；来源跳转永不因此受阻（跳转只呈现已
 *    保存事实，不触碰 session）。
 *
 * D4-3 原文探索闭环前端（issue #8 工作包 D4-3 / charter §3.3 / ADR-004；
 * 消费已落地的四个 HTTP 端点——服务 apps/studio/src/materials/branching.ts）：
 *  - 建枝入口（规则一）：阅读器武装选区的捕获条给出「⑃ Branch from
 *    material」。提交前先经 D4-2 resolve-selection 把捕获载荷换成**规范
 *    MaterialSelection**（服务端复核切片/块/sourceHash——阅读器窗口可能被
 *    裁剪，客户端不自行伪造 sourceHash），再 POST from-material
 *    {selection, intentKey, mode:"resume-or-create"}。intentKey 标识一次
 *    逻辑提交（建枝+首问），跨失败重试/页面刷新经 localStorage 稳定复用
 *    （同键重放同枝零新行——服务端原子绑定）；显式另开换新键。
 *  - 提交前的材料范围声明（规则三，charter「UI 在提交前说明本次使用的材
 *    料范围」）：from-material 响应的组合上下文视图（选区摘录 + 有界邻近
 *    块窗口 + 标题/版本 + 上限/截断标记 + 组合文本预览）在首问输入旁完整
 *    呈现——截断时显式标注（truncationNote 原文）；组合文本与派发时逐字
 *    节相同（服务端确定性），<details> 内可全文核对。建枝本身零 Run/Turn
 *    （浏览/搜索不创建 Turn）；首问是独立的显式提交。
 *  - 幂等首问（规则四/五，先对账后行动）：submitting 在途锁杜绝双发（双
 *    击/响应丢失不重发）；dispatch succeeded（outcome null = 同键重放，
 *    不重复派发——如实注记）；failed = 明确失败可同键重试（显式新尝试）；
 *    unknown = 在途对账不决——**不盲发**，如实呈现并等用户处置。409
 *    material-first-question-conflict（同分支首问不可变）如实呈现，并给出
 *    「改问走普通续聊」的去向（开面板预填问题，用户显式发送）。
 *  - 恢复 vs 另开（规则五/六，同来源可恢复已有探索也可显式另开）：
 *    resume-or-create 命中恢复 → 明确二选（打开既有分支续聊 / 显式另开
 *    新枝——新键新提交）；恢复分支零 turn 时如实注明「续聊是普通 prompt、
 *    不带组合材料上下文」，另开才有完整首问流。挂起的 intentKey（建枝后
 *    未问）在重进同一选区时复用——恢复响应 + 已存键直达声明面（刷新/重
 *    启后的诚实续走）。导航/会话可用性结果分离携带（失败如实，恢复本身
 *    不被掩盖）。
 *  - 材料 Return（规则七）：材料分支的面板 Return 走 material-return（响
 *    应携带来源卡）；幂等键纪律与 Turn 来源 Return 完全共用（草稿持久化/
 *    同键重放/响应丢失对账）。主线 Return 卡按 targetAnchor null（材料来
 *    源没有主线对话锚点，绝不伪造）+ 来源分支无 turn origin 识别材料
 *    Return，渲染材料来源卡：材料标题/版本/解析器/块·页/摘录/确认时间/
 *    采用记录（树态实时）+ 原文跳转（sourceJump → 阅读器按版本+块定位，
 *    复用 D4-4 搜索跳转的定位机制）。卡片数据（来源卡字段）从提交响应
 *    缓存（localStorage，按 tree:turn），缓存缺失时如实注明（Return 本身
 *    完好，绝不伪造来源细节）。
 *  - 缺 session 显式新探索（规则八）：材料分支的「⑃ Start new exploration」
 *    走 material-new-exploration（材料上下文随行）——可见性/确认流/收尾
 *    与 Turn 来源分支的换轨入口完全一致（v3 §4.4 既有语义）。
 *  - 材料分支的可辨认：分支 tab 标记 · material；面板头部呈材料来源上下
 *    文（标题/版本/块/摘录——来源缓存自建枝/恢复响应，缺失时如实注明）；
 *    「⌖ View source」对材料分支跳原文（对 Turn 来源分支仍是锚点揭示）。
 *
 * D4-8 大规模树导航前端（issue #8 工作包 D4-8 / charter §5 + §6 B9；消费
 * 已落地的 /api/nav/* 只读产品事实面——服务 apps/studio/src/nav/*）：
 *  - 侧栏 Navigate 段（Forest/Branches/Navigate/Materials/Search 同栏五段
 *    ——层级导航是树的结构事实面，不另开整页视图）：树查找（空输入 = 分页
 *    森林列表 /api/nav/trees + More 翻页；有输入 = /api/nav/search/trees
 *    标题/标识确定性搜索），点击在导航面打开该树（单树概览 + 根子节点首页
 *    + 展开状态恢复）；导航会话与工作台当前树相互独立（跨树浏览不打断主
 *    线阅读）；
 *  - 层级树视图（charter「不能一次渲染全部节点」）：子节点按需经游标分页
 *    加载（children 端点 limit 50 + More 行 + 窗口内自动续页），折叠/展开
 *    逐节点；展开状态与选中节点经 PUT expand-state 整组持久化（重启后
 *    GET 恢复——迁移 0010 的事实面），恢复按世代守卫串行续页到目标节点；
 *  - 虚拟化纪律（B9「虚拟化 DOM 随可视区域增长而非全量节点增长」）：
 *    可见行序（展开集合的先序走行）按滚动窗口渲染——窗口 = scrollTop/
 *    固定行高 ± overscan，窗口外仅留高度占位（spacer）行；状态行如实
 *    呈现「rendering N/M visible rows」的窗口口径；
 *  - 同名消歧（charter §5）：行内携带分支 id 与子数徽标（id 即身份），
 *    长标题 CSS 截断 + title 属性全文；当前节点的完整父路径单列呈现
 *    （path 端点 100 层完整返回；>6 层可收拢但「show full path」展开后
 *    完整在场——收拢是显示态不是数据截断）；分支搜索命中各携带完整路径；
 *  - 键盘（charter「键盘可逐层移动与展开」）：↑/↓ 沿可见行序逐行移动，
 *    → 展开（或入首子）、← 收起（或回父）、Enter 选中、Home/End 首末行；
 *    焦点行采用 roving tabindex——窗口重划后焦点行必在 DOM（超出窗口的
 *    移动先滚动再渲染再落焦，焦点不因虚拟化消失）；
 *  - 定位与来源：⌖ Locate current branch 跨树定位工作台当前分支（locate
 *    端点；异树即切换导航树）并展开祖先链续页至目标可见；⌖ Source of
 *    selected 跳回所选节点的来源——turn 来源走既有 revealOrigin（/source
 *    揭示 + 降级纪律），material 来源走既有阅读器按版本+块定位
 *    （sourceJump 语义）；目标树不在工作台时先 openTree 进入（工作台自身
 *    的既有行为），trunk/无来源如实说明、绝不伪造近似位置；
 *  - 诚实状态面：加载中/失败 + 重试、stale-cursor 409 从首页重拉（索引
 *    失效后旧游标不自愈）、503 nav-not-wired 如实说明（该进程未装配导航
 *    服务）、空树指引（只有主干时说明如何长出分支）。产品树 ≠ 运行
 *    session 树：导航面从不读取/渲染 session 可用性。
 *
 * 范围（诚实声明）：对话 turn 无 Markdown 渲染、无自动摘要（材料阅读器
 *   的 markdown 渲染是**无损字面渲染**——见 D4-2 段，与 turn 渲染无关）。
 *   其余既有事实面：
 *  - 在 assistant 答案内选中文本 → “Branch from here”（无选区 = 整条答案）；
 *  - 诊断/状态条：当前 run 状态、失败码与消息（失败面板不自动消失）、
 *    在途时 Abort、“未观测策略决策”的如实呈现（Studio 无工具执行器
 *    ——绝不声称未接入的策略执行）；
 *  - 来源抽屉：per-run 出处、Return 出处与 journal 尾部的保守摘要（工具
 *    活动如实空态——Studio 离线以空工具 allowlist 运行）；journal 拉取
 *    三态呈现——加载中 / 已载（含如实空态）/ 加载失败 + 重试（失败绝不
 *    伪装成“无事件”，W2 §2.7 打开-加载失败、issue #3 P1）；
 *  - 缺失 session 降级（A4/W2 §2.8 + v3 §4.4）：分支徽标 + 横幅（树保持
 *    可读、续聊发送 fail-closed 且入口禁用并说明原因），恢复方式是可直接
 *    执行的按钮（从 session 仍可用的最新 assistant 答案整条建支线——近似
 *    说明见 findSessionRecoveryAnchor）**加上**「以保存内容开始新的探索」
 *    （v3 §4.4：session 不可用分支的显式换轨入口——输入框保持可输入以
 *    键入首问，「⑃ Start new exploration」提交经 confirm 二次确认，服务
 *    端新建 session 并把锚点摘录 + 已保存历史作为首问上下文带入；绝不
 *    冒充旧会话恢复）；session-corrupt 失败时同样提示。横幅
 *    dismiss 为页面级持久状态（重渲不复活；主干恢复可用或执行恢复动作
 *    时清除）。prompt 失败（含 session-corrupt）的终局渲染是硬保证：
 *    流式占位清除、恢复横幅/降级提示、最终树态与诊断面都在错误上抛前
 *    落位（不依赖 SSE 事件收尾）。
 *  - W2 §2.1/§2.4/§2.6/§2.7 补齐（issue #6 P1 偏差修复，向源设计靠拢）：
 *    启动初始焦点编程设定到“新建”（仅启动一次，重渲不夺焦点）；树列表
 *    加载失败呈侧栏常驻重试面（错误 + Retry——在途禁用明示，持久失败
 *    保持可用，不整页刷新；无树打开时恢复后补齐启动语义）；错误横幅
 *    role="alert" + tabindex="0"（可 Tab 触达并朗读）；锚点揭示降级时
 *    焦点移到面板头部锚点上下文（持久说明区，取舍见 revealOrigin 注释）；
 *    窄窗抽屉自底向上为纯 CSS 变更（见 style.css 窄窗 @media）。
 *
 * 动效分镜（W2 §3，M1–M7）：全部短促、无循环装饰；streaming 指示为静态
 * caret（不闪烁）；每个动效在 prefers-reduced-motion 下即时化（CSS 全局
 * 降级 + JS 侧 matchMedia 控制滚动 behavior）。
 *
 * 事件流：EventSource 订阅 /api/trees/:id/events（snapshot 后推送
 * run-started / message-delta / abort-requested / run-terminal /
 * tool-activity）。SSE 不可用时降级为 prompt 在途时轮询诊断面（既有
 * 行为）；/diagnostics 仍用于初始加载。
 */

"use strict";

/** @typedef {{id:string, createdAt:string, forestId:string}} TreeT */
/** @typedef {{id:string, treeId:string, parentBranchId:string|null, createdAt:string}} BranchT */
/** @typedef {{branchId:string, sourceBranchId:string, anchorTurnId:string, anchorEntryId:string, selection:{start:number,end:number,text:string}, createdAt:string}} OriginT */
/** @typedef {{sourceBranchId:string, anchorTurnId:string, anchorEntryId:string, selection:{start:number,end:number,text:string}}} ReturnTargetAnchorT */
/** 单次 Return 采用尝试的安全投影（signed W1 v3.0 §3.2：Return→Run 关联
    + 该 Run 的结果；无 session 引用/路径）。 */
/** @typedef {{turnId:string, runId:string, runState:string, failure:{code:string,message:string}|null, attemptedAt:string, terminalAt:string|null}} ReturnAttemptT */
/** @typedef {{id:string, treeId:string, branchId:string, episodeId:string, runId:string|null, role:"user"|"assistant"|"return", text:string, piEntryId:string|null, fromBranchId:string|null, deliveredRunId:string|null, idempotencyKey:string|null, targetAnchor:ReturnTargetAnchorT|null, createdAt:string}} TurnT */
/** @typedef {{branch:BranchT, origin:OriginT|null, originStatus:"available"|"changed"|"unavailable"|null, sessionAvailability:"available"|"unavailable"|null, turns:TurnT[], returnAttempts:ReturnAttemptT[]}} BranchViewT */
/** @typedef {{tree:TreeT, trunkBranchId:string|null, branches:BranchViewT[], cursor:{treeId:string,branchId:string,entryId:string}|null}} TreeStateT */
/** @typedef {{runId:string, branchId:string, episodeId:string, state:string, failure:{code:string,message:string}|null, createdAt:string, terminalAt:string|null}} RunDiagnosticsT */
/** @typedef {{tool:string|null, outcome:"allow"|"deny"|"require-approval", category:string, risk:string, reason:string, ruleId:string|null, occurredAt:string}} PolicyDecisionViewT */
/** @typedef {{treeId:string, runtimeState:"idle"|"streaming"|"aborting", activeRun:{runId:string,branchId:string,episodeId:string}|null, runs:RunDiagnosticsT[], policyDecisions:({observed:false, reason:string}|{observed:true, decisions:PolicyDecisionViewT[]})}} TreeDiagnosticsT */
/** @typedef {{branchId:string, idempotencyKey:string, text:string, failed:boolean}} ReturnDraftT */
/** @typedef {{eventId:string, runId:string, seq:number, occurredAt:string, type:string, summary:string}} JournalEventT */
/** journal 拉取三态（W2 §2.7）：{ok:true} = 已载（events 可为空——如实
    空态）；{ok:false} = 加载失败（呈现失败 + 重试）；null = 加载中。 */
/** @typedef {{ok:true, events:JournalEventT[]}|{ok:false}} JournalLoadT */
/** @typedef {{runId:string, branchId:string, episodeId:string}} ActiveRunInfoT */
/** @typedef {{runId:string, branchId:string, text:string}} StreamingT */
/** @typedef {{branchId:string, turnId:string, start:number, end:number}} SourceHighlightT */
/** @typedef {{kind:"element", element:object}|{kind:"tab", branchId:string}|{kind:"branch-button", turnId:string}|{kind:"return-card", turnId:string}|{kind:"main-input"}|{kind:"material-button", materialId:string}|{kind:"search-hit", hitKey:string}} FocusReturnRefT */
/** D4-2 材料面类型（契约 §3 的 HTTP 载荷形状；阅读器与侧栏列表消费）。 */
/** @typedef {{id:string, title:string, createdAt:string}} MaterialT */
/** @typedef {{id:string, materialId:string, contentHash:string, parserKind:"markdown"|"pdf", parserVersion:string, importedAt:string, sizeBytes:number, parseStatus:"pending"|"parsing"|"ready"|"failed"|"canceled"|"unsupported"|"rejected", parseError:string|null, textUnits:number}} MaterialVersionT */
/** @typedef {{material:MaterialT, versions:MaterialVersionT[]}} MaterialListItemT */
/** @typedef {{material:MaterialT, versions:MaterialVersionT[], readingPosition:{treeId:string, materialId:string, versionId:string, blockId:string|null, focusStart:number|null, updatedAt:string}|null, parseTasks:object[]}} MaterialDetailT */
/** @typedef {{block:{blockId:string, kind:"markdown-block"|"pdf-page", start:number, end:number, page?:number}, text:string}} MaterialBlockEntryT */
/** D4-4 搜索命中（契约 §3 SearchHit 的 HTTP 裁剪面：可空字段缺省而非
    null——材料命中携带 materialId/materialTitle/versionId/versionLabel/
    blockId，非材料命中全部缺省；引擎附加字段 refId/matchType/matchCount
    已被服务端剥离，客户端不以任何方式假定它们在场）。 */
/** @typedef {{kind:"material"|"annotation"|"return"|"turn", treeId:string, treeTitle:string, materialId?:string, materialTitle?:string, versionId?:string, versionLabel?:string, oldVersion:boolean, blockId?:string, start:number, end:number, excerpt:string, title:string, createdAt:string}} SearchHitT */
/** D4-8 导航面载荷形状（/api/nav/* 的 HTTP 裁剪面，对齐 nav-engine.ts
    公共视图类型——只读产品事实，无 session 字段）。 */
/** @typedef {{id:string, treeId:string, parentBranchId:string|null, depth:number, title:string|null, originKind:"none"|"turn"|"material", childCount:number, createdAt:string}} NavNodeViewT */
/** @typedef {{treeId:string, parentBranchId:string, nodes:NavNodeViewT[], nextCursor:string|null, totalChildren:number}} NavChildrenPageT */
/** @typedef {{treeId:string, forestId:string, createdAt:string, title:string|null, trunkBranchId:string, nodeCount:number, maxDepth:number}} NavTreeOverviewT */
/** @typedef {{treeId:string, forestId:string, createdAt:string, title:string|null, trunkBranchId:string}} NavTreeSummaryT */
/** @typedef {{treeId:string, forestId:string, title:string|null, matchedOn:"title"|"id", createdAt:string}} NavTreeSearchHitT */
/** @typedef {{branchId:string, treeId:string, treeTitle:string|null, title:string|null, matchedOn:"title"|"id", depth:number, path:{id:string, title:string|null, depth:number}[], originKind:"none"|"turn"|"material", createdAt:string}} NavBranchSearchHitT */
/** @typedef {{treeId:string, treeTitle:string|null, node:NavNodeViewT, ancestors:{id:string, title:string|null, depth:number}[], path:{id:string, title:string|null, depth:number}[], siblingPosition:{index:number, total:number}|null, origin:{kind:"turn", sourceBranchId:string, anchorTurnId:string, anchorEntryId:string, selection:{start:number,end:number,text:string}}|{kind:"material", materialId:string, versionId:string, blockId:string, start:number, end:number, excerpt:string, sourceHash:string}|null}} NavLocationT */

const state = {
  /** @type {TreeT[]} */ trees: [],
  /** @type {string|null} */ currentTreeId: null,
  /** @type {TreeStateT|null} */ treeState: null,
  /** @type {TreeDiagnosticsT|null} */ diagnostics: null,
  /**
   * 支线局部面板打开的分支（null = 纯主线阅读）。主阅读面板始终显示
   * Trunk（W2 §2.2）；面板分支切换只换面板内容，主线不动（W2 §2.3）。
   * @type {string|null}
   */
  panelBranchId: null,
  /**
   * 锚点揭示高亮（主线或面板内）：偏移只信任服务端判定的绝对偏移
   * （W1 §1.1——重复词/跨行场景禁用字符串搜索定位）。
   * @type {SourceHighlightT|null}
   */
  sourceHighlight: null,
  /**
   * Return 草稿（draft 态，未持久化到 TreeAI DB）：幂等键标识一次逻辑提交，
   * 跨失败重试保持稳定；失败后编辑文本即视为新的逻辑提交（重新生成键——
   * 旧键可能已被服务端绑定到旧文本）。跨视图切换 / 页面刷新经 localStorage
   * 恢复（W2 §2.4 持久草稿行）。
   * @type {ReturnDraftT|null}
   */
  returnDraft: null,
  busy: false,
  /** 在途 run 定位（SSE run-started；run-terminal 清空）。 */
  activeRunInfo: null,
  /** 流式占位回显（瞬态；run-terminal 后由 /state 权威刷新取代）。 */
  streaming: null,
  /** 失败面板已关闭的 run（dismiss 后不再复显；新失败重新出现）。 */
  dismissedFailureRunIds: new Set(),
  /** 主线 prompt 失败 session-corrupt 后强制显示恢复横幅（下一次成功 trunk prompt 清除）。 */
  forceSessionBanner: false,
  /** 面板分支 prompt 失败 session-corrupt 后强制显示降级提示（成功后清除）。 */
  forcePanelSessionNote: false,
  /**
   * 已被用户 dismiss 的 session 横幅（按 trunk 分支 id 记忆，页面级持久——
   * 不是一次性 DOM hidden，重渲不复活）。仅当该主干 session 恢复可用、或
   * 用户执行了恢复动作时清除记录（届时横幅按最新事实重新呈现）。
   * @type {Set<string>}
   */
  dismissedSessionBannerTrunks: new Set(),
  /** 来源抽屉。 */
  drawerOpen: false,
  /** journal 三态（null = 加载中；W2 §2.7 / issue #3 P1——拉取失败绝不
      折叠成空数组伪装成无事件）。 @type {JournalLoadT|null} */
  journalEvents: null,
  /** 最近工具活动（真实 Pi 驱动才会有；离线如实为空）。 */
  toolActivity: [],
  /** 每分支阅读位置（`${treeId}:${branchId}` → scrollTop；W2 §2.2/§4）。 */
  scrollPositions: new Map(),
  /** 已渲染过的 Return 卡（`${treeId}:${turnId}`）：M3 插入动效只播一次。 */
  knownReturnIds: new Set(),
  /** Return 送达状态观测（`${treeId}:${turnId}` → deliveredRunId|null）：M4 检测变化。 */
  seenDeliveredRunIds: new Map(),
  /** 最近一次脉冲过的锚点（避免重渲重复脉冲）。 */
  pulsedHighlightKey: null,
  /** 面板 / 抽屉关闭时的焦点还原引用（W2 键盘焦点行）。 @type {FocusReturnRefT|null} */
  panelFocusReturn: null,
  /** @type {FocusReturnRefT|null} */ drawerFocusReturn: null,
  /** 打开抽屉时定位到的 run（delivered 卡反查）。 @type {string|null} */
  drawerFocusRunId: null,
  /**
   * 术语解释卡（issue #7 C ③ 完整状态）：当前活跃的解释（瞬态任务结果或
   * 已保存批注）。null = 无卡。单用户语义：同一时刻至多一张解释卡。
   * token 是请求世代号（explainSelection 递增）——迟到的响应（目标卡已被
   * 替换/关闭）如实丢弃并计数（termDiscardedLate），绝不覆盖新状态。
   * @type {{
   *   branchId: string, turnId: string,
   *   selection: {start:number,end:number,text:string},
   *   mode: "term"|"range",
   *   state: "loading"|"explained"|"saved"|"failed"|"cancelled",
   *   explanation: string|null, error: string|null,
   *   cached: boolean,
   *   lateDiscard: boolean,
   *   saveOutcome: "created"|"duplicate"|null,
   *   annotation: {id:string,term:string,explanation:string,promotedBranchId:string|null,selection:Object,mode:string,createdAt:string,branchId:string,anchorTurnId:string,sourceHash:string}|null,
   *   promotionKey: string|null, promoting: boolean,
   *   promotionConflict: string|null,
   *   firstQuestion: string,
   *   focusFirstQuestion: boolean,
   *   token: number
   * }|null}
   */
  termExplain: null,
  /**
   * 已武装的术语建议（issue #7 ①阅读模式）：建议 chip 点击后预填的解释
   * 请求——**用户显式确认（“⌖ Explain”按钮）才发**；Esc/Dismiss 解除。
   * 键 = 建议 chip 的（分支, 锚点 turn, 候选区间）。
   * @type {{branchId:string, turnId:string, anchorTurnId:string, start:number, end:number, term:string}|null}
   */
  termSuggest: null,
  /** 术语读模型（解释卡保存/推广后、抽屉打开时与开树时刷新；批注区间
      高亮与工具条「已有批注」判定的数据面）。 */
  terminology: null,
  /**
   * 已武装的选区（issue #7 C ③）：mouseup/双击/selectionchange（触屏）读
   * 到 assistant 正文内选区时置位——工具条与解释入口据此武装；无选区或
   * 交互结束即清空。正文层（turn 元素的前导文本区）在武装期间绝不被
   * 重渲换走（见 renderTurnsInto 的按元素复用）。
   * @type {{branchId:string, turnId:string, start:number, end:number, text:string, mode:"term"|"range"}|null}
   */
  armedSelection: null,
  /** 选区拖拽窗口（mousedown→mouseup）：窗口内整树重渲延后（选择期间
      不重绘——issue #7 ③）；mouseup 后经 0ms 定时冲刷（click 先于冲刷，
      按钮不被换走）。 */
  selectionDragActive: false,
  /** 拖拽窗口内被延后的 renderAll（mouseup 后冲刷）。 */
  pendingRerender: false,
  /** 客户端迟到丢弃计数（stale 解释响应——目标卡已换/已关）：抽屉用量行
      如实呈现（与服务端迟到丢弃分开计数）。 */
  termDiscardedLate: 0,
  /**
   * D4-2 材料列表读模型（当前树；契约 §3 GET /materials）：三态纪律同
   * journal/术语读模型——null = 加载中；{ok:true, materials} = 已载
   * （可为空——如实空态）；{ok:false, error} = 拉取失败（侧栏常驻错误 +
   * 重试，绝不折叠成空列表伪装成“无材料”）。切树时随 resetTransientView
   * 复位、openTree 后台刷新。
   * @type {null|{ok:true, materials:MaterialListItemT[]}|{ok:false, error:string}}
   */
  materials: null,
  /**
   * D4-2 阅读器会话（null = 关闭）。reader 持有打开面的全部产品事实
   * （detail 载荷）与已载块窗口；渲染元素（#material-reader 的 chrome 与
   * #mat-blocks 的块元素）不随 renderAll 重建——阅读器与树态正交（SSE
   * 终态刷新对已载块零触碰，块元素身份跨刷新稳定）。
   * @type {{
   *   materialId: string,
   *   material: MaterialT,
   *   versions: MaterialVersionT[],
   *   versionId: string,
   *   readingPosition: MaterialDetailT["readingPosition"],
   *   blocks: MaterialBlockEntryT[],
   *   nextAfterBlock: string|null,
   *   textUnits: number,
   *   firstPageState: "loading"|"loaded"|"failed",
   *   firstPageError: string|null,
   *   appendState: "idle"|"loading"|"failed",
   *   appendError: string|null,
   *   fenceOpen: boolean,
   *   trimmedBlocks: number,
   *   restoredToBlockId: string|null,
   *   lastSavedBlockId: string|null,
   *   searchJump: {blockId:string|null, versionId:string|null, fellBackToDefaultVersion:boolean, arrival:"search"|"return-source"}|null
   * }|null}
   */
  materialReader: null,
  /**
   * D4-2 阅读器武装选区（charter §3.2 精确锚点的前端捕获面）：武装纪律
   * 同正文层（mouseup/双击/触屏 selectionchange；拖拽窗口内不重绘）。
   * 有效载荷 = D4-3 建枝的锚点载荷（excerpt 与块文本切片字节相等、边界字
   * 素安全——snapped 表示边界被吸附到完整字素簇）；PDF 页块的有效载荷额
   * 外携带 page（页标识——捕获条如实展示）；invalid 携带如实原因
   * （cross-block：B2 纪律——markdown 选区必须含于单块；cross-page：PDF
   * 选区必须含于单页——绝不静默截断；unmappable：无法映射到规范偏移）。
   * @type {null|
   *   {kind:"valid", materialId:string, versionId:string, blockId:string, start:number, end:number, excerpt:string, snapped:boolean, page?:number}|
   *   {kind:"invalid", materialId:string, versionId:string, reason:"cross-block"|"cross-page"|"unmappable"}}
   */
  materialSelection: null,
  /**
   * D4-3 材料建枝流程状态（null = 无流程；issue #8 charter §3.3 / ADR-004）。
   * 流程面渲染在阅读器内（捕获条之下的建枝面）；selection 属于哪个阅读器
   * 会话由 materialId 判定（切材料后流程面只在原材料重开时可见）。token 是
   * 世代号（迟到响应丢弃——P1 同族规则）。intentKey 标识一次逻辑提交，跨
   * 失败重试稳定（localStorage 持久化，见 materialIntentStorageKey）；首问
   * 落库（dispatch succeeded）即清除挂起键。
   * @type {null|{
   *   phase: "creating"|"declared"|"choice"|"failed",
   *   selection: {materialId:string, versionId:string, blockId:string, start:number, end:number, excerpt:string},
   *   intentKey: string,
   *   branchId: string|null,
   *   context: {
   *     materialId:string, materialTitle:string, versionId:string,
   *     parserKind:string, parserVersion:string,
   *     selection: {materialId:string, versionId:string, blockId:string, start:number, end:number, excerpt:string, sourceHash:string},
   *     window: {start:number, end:number},
   *     contextBlocks: {blockId:string, start:number, end:number}[],
   *     limitUnits: number, composedUnits: number,
   *     truncated: boolean, truncationNote: string|null,
   *     composed: string
   *   }|null,
   *   mode: "created"|"restored"|null,
   *   created: boolean,
   *   restore: {created:boolean, navigation:{status:string, code?:string, message?:string}|null, sessionAvailability:"available"|"unavailable"|null, hasTurns:boolean}|null,
   *   firstQuestion: string,
   *   submitting: boolean,
   *   dispatchNote: string|null,
   *   error: string|null,
   *   conflict: string|null,
   *   token: number
   * }}
   */
  materialBranching: null,
  /**
   * D4-4 搜索面状态（issue #8 工作包 D4-4，charter §5）。scope/kinds 是
   * 用户的筛选选择（静态表单承载，不随 renderAll 重建）；phase/hits 是
   * 最近一次执行的读模型（三态纪律同材料列表/journal：idle = 未搜过 /
   * loading = 在途 / loaded = 已载（含如实零命中）/ failed = 失败 + 错误
   * 事实）。resultScope/resultTreeId 记录结果产生时的范围：树切走后
   * 「当前树」范围的旧结果不再描述当前工作台——诚实清空（全部树范围的
   * 结果是库级事实，保持有效）；resultQuery 仅用于状态行回显。note 是
   * 跳转反馈（如「命中事实已不在当前树态」）——跳转的如实说明面。
   * @type {{
   *   scope: "tree"|"all",
   *   kinds: Array<"material"|"annotation"|"return"|"turn">,
   *   phase: "idle"|"loading"|"loaded"|"failed",
   *   error: string|null,
   *   hits: SearchHitT[],
   *   note: string|null,
   *   resultQuery: string|null,
   *   resultScope: "tree"|"all"|null,
   *   resultTreeId: string|null
   * }}
   */
  search: {
    scope: "tree",
    kinds: ["material", "annotation", "return", "turn"],
    phase: "idle",
    error: null,
    hits: [],
    note: null,
    resultQuery: null,
    resultScope: null,
    resultTreeId: null,
  },
  /**
   * D4-8 导航面状态（issue #8 工作包 D4-8，charter §5）。finder 是树查找
   * 读模型（三态纪律同材料列表：idle = 未载（启动即拉首页）/ loading /
   * loaded（含如实空态）/ failed + 重试；mode 区分森林列表与搜索两种载荷
   * ——两者都按服务端分页翻页，绝不整库拉取）。session 是当前导航树会话
   * （null = 未开）：nodes/childPages 是按需分页加载的结构缓存（不是事实
   * 源——事实在服务端），expanded/selectedBranchId 是导航位置（经
   * PUT expand-state 整组持久化，重启恢复）。导航会话与工作台当前树相互
   * 独立（跨树浏览不打断主线阅读）。
   * @type {{
   *   finder: {
   *     phase: "idle"|"loading"|"loaded"|"failed",
   *     error: string|null,
   *     mode: "listing"|"search",
   *     listing: {trees:NavTreeSummaryT[], nextCursor:string|null, totalTrees:number},
   *     query: string|null,
   *     hits: NavTreeSearchHitT[],
   *     hitCursor: string|null,
   *     moreLoading: boolean,
   *     moreError: string|null
   *   },
   *   session: null|{
   *     treeId: string,
   *     overview: NavTreeOverviewT|null,
   *     overviewState: "loading"|"loaded"|"failed",
   *     overviewError: string|null,
   *     nodes: Map<string, NavNodeViewT>,
   *     childPages: Map<string, {ids:string[], nextCursor:string|null, totalChildren:number, state:"idle"|"loading"|"partial"|"complete"|"failed", error:string|null, inFlight:Promise<void>|null}>,
   *     expanded: Set<string>,
   *     selectedBranchId: string|null,
   *     focusBranchId: string|null,
   *     path: {state:"idle"|"loading"|"loaded"|"failed", steps:{id:string, title:string|null, depth:number}[], error:string|null}|null,
   *     pathShowAll: boolean,
   *     search: {phase:"idle"|"loading"|"loaded"|"failed", error:string|null, query:string|null, hits:NavBranchSearchHitT[], nextCursor:string|null},
   *     persistError: string|null,
   *     locateNote: string|null,
   *     lastCounts: {rendered:number, total:number}|null,
   *     persistQueued: boolean,
   *     persistRunning: boolean
   *   }
   * }}
   */
  nav: {
    finder: {
      phase: "idle",
      error: null,
      mode: "listing",
      listing: { trees: [], nextCursor: null, totalTrees: 0 },
      query: null,
      hits: [],
      hitCursor: null,
      moreLoading: false,
      moreError: null,
    },
    session: null,
  },
};

/** Diagnostics poll timer — fallback while a prompt is active and SSE is down. */
let diagnosticsTimer = null;
const DIAGNOSTICS_POLL_MS = 500;

/** SSE connection for the open tree (null when disconnected). */
let eventSource = null;
let sseHealthy = false;

/** 面板 / 抽屉进出场动画的收尾 timer（M1/M2：退出播完后才真正 hidden）。 */
let panelAnimTimer = null;
let drawerAnimTimer = null;
const PANEL_ENTER_MS = 240; /* CSS 180ms + 收尾余量 */
const PANEL_EXIT_MS = 170;

/* 渲染期元素注册表（renderAll 重建）：焦点还原与锚点定位按 id 取最新 DOM。 */
const tabButtons = new Map();
const branchHereButtons = new Map();
const turnElements = new Map();
const drawerRunItems = new Map();
/**
 * ③ 正文/操作分层注册表：assistant turn 的 {element, turn, branchId}——
 * selectionchange（触屏）的选区定位与武装态的就地动作层刷新都按最新 DOM
 * 取元素（turn 元素经按元素复用跨重渲保持身份，注册表随 renderAll 重建）。
 */
const assistantTurns = new Map();
/** 解释入口按钮注册表（turnId → 按钮）：解释卡 Esc/关闭的焦点还原目标。 */
const termExplainButtons = new Map();

/** 解释请求世代号（迟到响应按 token 丢弃——目标卡已换/已关时不覆盖）。 */
let termExplainSeq = 0;
/** 解释卡进场动效只在新卡打开的那一次渲染播放（重建即止，不重播）。 */
let termCardEnterPending = false;
/** 抽屉内缓存偏好切换的在途/失败态（PUT preferences；失败如实 + 重试）。 */
let termPrefsPending = false;
let termPrefsError = null;
/** 抽屉内阅读模式切换的在途/失败态（PUT settings/reading-mode；issue #7 ①）。 */
let termModePending = false;
let termModeError = null;
/**
 * 术语建议在途跟随（issue #7 ①阅读模式）：回答完成后的读模型刷新若见
 * pending 建议集，则有界轮询至终态（1s 间隔、至多 90 次；切树/无 pending
 * 即停）。进程内瞬态跟随——不是产品事实；建议提取走隔离执行器串行链，
 * 回答完成的 POST /prompt 响应可能先于提取终态到达（诚实呈现 pending）。
 */
let termSuggestFollowActive = false;
const TERM_SUGGEST_FOLLOW_MAX_POLLS = 90;
const TERM_SUGGEST_FOLLOW_INTERVAL_MS = 1000;

const $ = (id) => document.getElementById(id);

/* ------------------------------ 动效辅助（M7 / reduced-motion） ------------------------------ */

/** W2 §3：JS 侧滚动定位尊重 prefers-reduced-motion（reduce → auto 直接跳转）。 */
function prefersReducedMotion() {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
function scrollBehavior() {
  return prefersReducedMotion() ? "auto" : "smooth";
}

/** 贴底阈值（issue #3）：视口底边距内容底部 ≤48px 视为“正在跟随底部”。 */
const AT_BOTTOM_PX = 48;

/** 贴底判定：强制贴底（新内容跟随）只允许发生在用户本就在底部的容器上
    （issue #3 P1：流式增量 / 新 turn 到达时，已向上阅读的视图不得被拉回
    底部）。判定须在写入新内容之前取值——写入本身会增高 scrollHeight。 */
function isAtBottom(container) {
  return container.scrollTop + container.clientHeight >= container.scrollHeight - AT_BOTTOM_PX;
}

async function api(path, method = "GET", body = undefined) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    /* non-JSON error body */
  }
  if (!response.ok) {
    const message = payload && payload.error ? `${payload.error.code}: ${payload.error.message}` : `HTTP ${response.status}`;
    const error = new Error(message);
    if (payload && payload.error && typeof payload.error.code === "string") {
      error.code = payload.error.code;
    }
    throw error;
  }
  return payload;
}

/** 错误横幅按视图落位：面板内动作的失败呈现在面板（W2 §2.3），其余主线。
 *  横幅具朗读语义（W2 §2.4：role="alert" 隐式 aria-live + tabindex="0"
 *  可 Tab 触达）：先置可见再写入文本——内容变化发生在可访问性树内，
 *  朗读触发更可靠；8 秒自动隐藏的既有行为不变。 */
function showError(message, view = "main") {
  const banner = $(view === "panel" ? "panel-error-banner" : "error-banner");
  banner.hidden = false;
  banner.textContent = message;
  window.setTimeout(() => {
    banner.hidden = true;
  }, 8000);
}

async function guard(fn, view = "main") {
  if (state.busy) return;
  state.busy = true;
  updateComposerLocks();
  try {
    await fn();
  } catch (err) {
    showError(String(err && err.message ? err.message : err), view);
  } finally {
    state.busy = false;
    updateComposerLocks();
  }
}

/**
 * 续聊入口锁定（W2 §2.2 在途锁定 + §2.8 fail-closed + v3 §4.4）：
 * busy（单在途 prompt）→ 输入与发送全禁；
 * 目标分支 session 不可用 → **发送 fail-closed 禁用**，但输入保持可输入
 * （v3 §4.4：用户在新探索的首问就是在被禁的普通续聊入口旁输入的——
 * 「⑃ Start new exploration」按钮随可用性显隐，承接显式换轨提交）。
 * 占位文案同步换轨语境（不可用时引导输入新探索首问）。
 */
function updateComposerLocks() {
  const busy = state.busy;
  const trunkView = state.treeState === null ? null : branchView(trunkBranchId());
  const trunkUnavailable = trunkView !== null && trunkView.sessionAvailability === "unavailable";
  const trunkLocked = busy || trunkUnavailable;
  $("prompt-input").disabled = busy;
  $("prompt-input").placeholder = trunkUnavailable
    ? "Session missing on the Trunk — type the first question of a new exploration, then “Start new exploration”…"
    : "Ask on the Trunk…";
  $("send").disabled = trunkLocked;
  $("new-exploration").hidden = !trunkUnavailable;
  $("new-exploration").disabled = busy;
  const panelView = state.panelBranchId === null ? null : branchView(state.panelBranchId);
  const panelUnavailable = panelView !== null && panelView.sessionAvailability === "unavailable";
  const panelLocked = busy || panelUnavailable;
  $("panel-prompt-input").disabled = busy;
  $("panel-prompt-input").placeholder = panelUnavailable
    ? "Session missing on this branch — type the first question of a new exploration, then “Start new exploration”…"
    : "Continue this branch…";
  $("panel-send").disabled = panelLocked;
  $("panel-new-exploration").hidden = !panelUnavailable;
  $("panel-new-exploration").disabled = busy;
  $("submit-return").disabled = busy;
  $("new-tree").disabled = busy;
}

/* ------------------------------ 视图辅助 ------------------------------ */

function trunkBranchId() {
  return state.treeState === null ? null : state.treeState.trunkBranchId;
}

function branchView(branchId) {
  if (state.treeState === null || branchId === null) return null;
  return state.treeState.branches.find((view) => view.branch.id === branchId) ?? null;
}

/** 每分支阅读位置键（W2 §4：切树/切分支后回来恢复原位）。 */
function scrollKey(branchId) {
  return `${state.currentTreeId}:${branchId}`;
}

/** 流式占位 turn 所属的滚动容器（主线 or 面板）。 */
function conversationContainerId(branchId) {
  return branchId === trunkBranchId() ? "conversation" : "panel-conversation";
}

/* ------------------------------ 渲染 ------------------------------ */

function branchLabel(branchId) {
  const st = state.treeState;
  if (st === null) return branchId;
  if (branchId === st.trunkBranchId) return "Trunk";
  const index = st.branches.findIndex((view) => view.branch.id === branchId);
  return `Branch ${index}`;
}

function renderTrees() {
  const list = $("tree-list");
  list.replaceChildren();
  for (const tree of state.trees) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    if (tree.id === state.currentTreeId) button.classList.add("active");
    const name = document.createElement("span");
    name.textContent = tree.id;
    const date = document.createElement("span");
    date.className = "tree-date";
    date.textContent = new Date(tree.createdAt).toLocaleString();
    button.append(name, date);
    button.addEventListener("click", () => {
      closeSidebar(); /* 窄窗：选树后收起侧栏抽屉 */
      guard(() => openTree(tree.id));
    });
    li.append(button);
    list.append(li);
  }
}

function renderBranchTabs() {
  const st = state.treeState;
  const tabs = $("branch-tabs");
  tabs.replaceChildren();
  tabButtons.clear();
  for (const view of st.branches) {
    const isTrunk = view.branch.id === st.trunkBranchId;
    const button = document.createElement("button");
    button.dataset.branchId = view.branch.id;
    /* 主线 tab 恒为 active（主阅读面板）；打开的支线 tab 呈 panel-open。 */
    if (isTrunk) button.classList.add("active");
    else if (view.branch.id === state.panelBranchId) button.classList.add("panel-open");
    const label = document.createElement("span");
    label.textContent = branchLabel(view.branch.id);
    button.append(label);
    if (view.origin !== null) {
      const anchorStatus = view.originStatus ?? "unavailable";
      button.title = `branched from ${branchLabel(view.origin.sourceBranchId)} · “${view.origin.selection.text}” · source ${anchorStatus}`;
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.textContent = " °";
      button.append(dot);
    } else if (!isTrunk) {
      /* D4-3 材料 Branch：无 Turn 来源——可辨认标记（来源细节在面板头部）。 */
      const badge = document.createElement("span");
      badge.className = "material-badge";
      badge.textContent = "· material";
      badge.title = "branched from a material selection (D4-3) — the source context is shown in the branch panel";
      button.append(badge);
    }
    /* A4 缺失 session：分支徽标（续聊将 fail-closed；详情见降级提示）。 */
    if (view.sessionAvailability === "unavailable") {
      const badge = document.createElement("span");
      badge.className = "session-badge";
      badge.textContent = "· session missing";
      badge.title = "the session file for this branch's continuation point is missing; the tree stays readable but continuing here will fail";
      button.append(badge);
    }
    /* 切换语义保留：tab 点击仍 POST /switch（服务端对齐 Pi 游标）；
       UI 层面支线只开局部面板、Trunk tab 收面板回主线（不整页换视图）。
       失败时面板可能未开/已收 → 错误呈现在主线横幅。
       窄窗（<720px）：与 Forest 树行/材料按钮/搜索命中同一纪律——从抽屉
       选中分支即收起侧栏，否则抽屉盖住刚打开的面板（B7 beta 可用性探针
       发现：elementFromPoint 于面板输入框命中抽屉遮罩）。 */
    button.addEventListener("click", () => {
      closeSidebar();
      if (isTrunk) {
        void guard(() => returnToTrunk(view.branch.id));
      } else {
        void guard(() =>
          openBranchPanel(view.branch.id, { trigger: { kind: "tab", branchId: view.branch.id } }),
        );
      }
    });
    tabButtons.set(view.branch.id, button);
    tabs.append(button);
  }
  const cursor = st.cursor;
  $("cursor-note").textContent =
    cursor === null
      ? "session: —"
      : `session @ ${branchLabel(cursor.branchId)} · ${cursor.entryId}`;
}

/* 顶栏位置路径（源设计 §二 顶栏行）：无树 → 空；有树 → `<treeId> / Trunk`；
   支线面板打开 → 追加当前支线标签。树名与列表一致用 tree.id；路径由
   renderAll 统一刷新（面板开合、切树、SSE 终态重渲都经过 renderAll）。 */
function renderTopbarPath() {
  const el = $("topbar-path");
  const st = state.treeState;
  if (st === null || state.currentTreeId === null) {
    el.textContent = "";
    return;
  }
  const segments = [state.currentTreeId, branchLabel(st.trunkBranchId)];
  if (state.panelBranchId !== null) segments.push(branchLabel(state.panelBranchId));
  el.textContent = segments.join(" / ");
}

/**
 * A4 缺失 session 横幅（主线视角，可关闭、不自动消失）：树保持完全可读
 * （数据库是事实源），Trunk 续聊将 fail-closed；可执行恢复方式 = 横幅内
 * 的恢复按钮（sessionRecoveryControls，从 session 仍可用的 turn 建新
 * 分支）或新建 Tree。session-corrupt 的 Trunk prompt 失败同样强制显示
 * （forceSessionBanner，下一次成功 Trunk prompt 清除）。
 *
 * dismiss 是页面级持久状态（dismissedSessionBannerTrunks，按 trunk 分支
 * 记忆）：重渲（SSE 终态刷新 / 面板开合 / 树面动作）不复活已关闭的横幅；
 * 仅当该主干 session 恢复可用（触发条件消失）、或用户执行恢复动作时清除
 * 记录——未来再次不可用时横幅可重新出现。
 */
function renderSessionBanner() {
  const banner = $("session-banner");
  const trunk = trunkBranchId();
  const view = branchView(trunk);
  const unavailable = view !== null && view.sessionAvailability === "unavailable";
  const forced = state.forceSessionBanner;
  if (!unavailable && !forced) {
    /* 触发条件消失（主干恢复可用 / 成功 Trunk prompt 清除 force）：清除该
       主干的 dismiss 记录，横幅回到「可出现」状态。 */
    if (trunk !== null) state.dismissedSessionBannerTrunks.delete(trunk);
    banner.hidden = true;
    return;
  }
  if (trunk !== null && state.dismissedSessionBannerTrunks.has(trunk)) {
    /* 用户已 dismiss：本次条件仍成立也不复活（页面级记忆，非一次性 DOM
       hidden——renderAll 重建 DOM 不会把它带回来）。 */
    banner.hidden = true;
    return;
  }
  banner.replaceChildren();
  const text = document.createElement("span");
  text.className = "session-banner-text";
  text.textContent =
    "Session missing on this branch — the tree stays fully readable (the database is the source of truth), " +
    "but continuing here will fail. Recovery: start a new exploration from saved content (button next to the " +
    "composer below), branch from a turn whose session is still available, or start a fresh Tree.";
  banner.append(text);
  banner.append(sessionRecoveryControls("main"));
  const dismiss = document.createElement("button");
  dismiss.className = "session-banner-dismiss";
  dismiss.textContent = "Dismiss";
  dismiss.addEventListener("click", () => {
    if (trunk !== null) state.dismissedSessionBannerTrunks.add(trunk);
    banner.hidden = true;
  });
  banner.append(dismiss);
  banner.hidden = false;
}

/**
 * 恢复候选（W2 §2.8「可直接执行」的依据）：session 可用分支的最新
 * assistant 答案。近似（诚实边界）：TreeStateT 不提供逐 turn 的 session
 * 判定——BranchViewT.sessionAvailability 是分支续聊点（latest run 的
 * session 引用；无 run 分支为 origin 锚点 run 的引用）的可用性，同分支
 * 各 run 共享会话文件，故以分支视图推断其 turn 的可用性。主线优先，
 * 其次其余分支（读模型顺序，稳定）。残余边界：某分支 prompt 刚以
 * session-corrupt 失败而读模型仍报 available 时可能被选中（服务端对
 * corrupt 会话在读模型中标 unavailable，正常不出现）。
 */
function findSessionRecoveryAnchor() {
  const st = state.treeState;
  if (st === null) return null;
  const ordered = st.trunkBranchId === null ? [] : [st.trunkBranchId];
  for (const view of st.branches) {
    if (view.branch.id !== st.trunkBranchId) ordered.push(view.branch.id);
  }
  for (const branchId of ordered) {
    const view = branchView(branchId);
    if (view === null || view.sessionAvailability !== "available") continue;
    const turn = [...view.turns].reverse().find((t) => t.role === "assistant");
    if (turn !== undefined) return turn;
  }
  return null;
}

/**
 * 恢复按钮（issue #3 P1：恢复说明从纯文字变为可执行操作）：主线横幅与
 * 面板降级提示共用。有候选 → 可点击（title 如实标注来源分支）；无候选 →
 * 禁用并说明原因（新建 Tree / 恢复 session 文件）。不削弱 fail-closed 的
 * 续聊禁用——按钮是旁路恢复动作，不是对被禁入口的解禁。
 */
function sessionRecoveryControls(surface) {
  const wrap = document.createElement("span");
  wrap.className = "session-recovery";
  const button = document.createElement("button");
  button.className = "session-recovery-button";
  button.textContent = "⑃ Branch from latest available answer";
  const anchor = findSessionRecoveryAnchor();
  if (anchor === null) {
    button.disabled = true;
    const reason = document.createElement("span");
    reason.className = "session-recovery-reason";
    reason.textContent =
      "no session currently available — start a new exploration from saved content (composer below), or start a new Tree / restore the session file";
    wrap.append(button, reason);
  } else {
    button.title = `branch from the latest answer on ${branchLabel(anchor.branchId)} (whose session is still available)`;
    wrap.append(button);
  }
  button.addEventListener("click", () => guard(() => branchFromLatestAvailableAnswer(), surface));
  return wrap;
}

function selectionOffsetsWithin(element, text) {
  const selection = window.getSelection();
  if (selection === null || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.commonAncestorContainer)) return null;
  const selected = range.toString();
  if (selected.length === 0) return null;
  const before = range.cloneRange();
  before.selectNodeContents(element);
  before.setEnd(range.startContainer, range.startOffset);
  const start = before.toString().length;
  if (text.slice(start, start + selected.length) !== selected) return null;
  return { start, end: start + selected.length, text: selected };
}

/** 长摘录折叠阈值（P1 降级卡）：超过即以 <details> 折叠（原生键盘可达）。 */
const RETURN_EXCERPT_COLLAPSE_THRESHOLD = 120;

/** 摘录元素（P1）：完整文本始终在卡片内（短摘录内联引用，长摘录折叠——
    <summary> 携带前缀切片 + 省略号，展开后是落库快照原文）。 */
function returnExcerptElement(text) {
  if (text.length <= RETURN_EXCERPT_COLLAPSE_THRESHOLD) return null;
  const details = document.createElement("details");
  details.className = "return-excerpt collapsible";
  const summary = document.createElement("summary");
  summary.textContent = `“${text.slice(0, 100)}…”`;
  const full = document.createElement("span");
  full.className = "return-excerpt-full";
  full.textContent = `“${text}”`;
  details.append(summary, full);
  return details;
}

/**
 * 回退放置的来源判定（P1：区分「来源位于其他 Branch / 已变化 / 缺失」）：
 * 以 targetAnchor 快照在树状态里反查锚点 turn——查不到 → missing；查到但
 * role/切片不再匹配快照 → changed；查到且仍匹配 → 该锚点在其他分支
 * （elsewhere，携带其所在分支）。树状态缺失（极端）按 missing。
 */
function returnFallbackReason(turn) {
  const st = state.treeState;
  const anchor = turn.targetAnchor;
  if (st === null || anchor === null) return { kind: "missing", anchor: null };
  let anchorTurn = null;
  for (const view of st.branches) {
    const found = view.turns.find((t) => t.id === anchor.anchorTurnId);
    if (found !== undefined) {
      anchorTurn = found;
      break;
    }
  }
  if (anchorTurn === null) return { kind: "missing", anchor };
  const stillHolds =
    anchorTurn.role === "assistant" &&
    anchorTurn.text.slice(anchor.selection.start, anchor.selection.end) === anchor.selection.text;
  if (!stillHolds) return { kind: "changed", anchor };
  return { kind: "elsewhere", anchor, anchorBranchId: anchorTurn.branchId };
}

/**
 * Return 卡片（W2 §2.4 + M3/M4 + signed v3 §3.2 + issue #7 P1）：
 * - placement "anchored"：锚点答案在当前视图内 → 紧随其后渲染，meta 携带
 *   摘录与来源分支（短摘录内联；长摘录折叠元素）；
 * - placement "fallback"：锚点不在当前视图 → 按时间顺序原位渲染，meta 以
 *   targetAnchor 快照区分「来源位于其他 Branch / 已变化 / 缺失」，摘录照常
 *   在卡面可读（折叠规则同上）；
 * - 确认时间（P1）：saved <createdAt> 取产品 turn.createdAt；首次成功采用
 *   的送达时间从采用尝试记录反查（deliveredRunId 对应 run 的 terminalAt）。
 * 采用状态词汇（signed v3 §3.2）：saved → attempted → delivered（点击
 * delivered 徽标反查来源抽屉）。草稿（draft）仅浏览器本地。
 *
 * M3/M4 的动效 class 在插入/状态变化后的短观测窗口（MOTION_EPOCH_MS）内
 * 随重渲保持——状态刷新（SSE 终态 + prompt 响应）可能在一个动效周期内
 * 连发两次 renderAll，窗口外不再携带（渲染幂等，不重播）。
 */
const MOTION_EPOCH_MS = 260;
const returnInsertedAt = new Map(); /* `${treeId}:${turnId}` → epoch ms */
const deliveredChangedAt = new Map(); /* `${treeId}:${turnId}` → epoch ms */

/** 该 Return 的采用尝试记录（signed v3 §3.2：save ≠ 尝试 ≠ 首次成功采用）。
    视图字段缺失（旧快照）时按空列表处理——卡片降级回“已保存”语义。 */
function returnAttemptsFor(view, turnId) {
  return (view.returnAttempts ?? []).filter((attempt) => attempt.turnId === turnId);
}

/** 时间戳的产品事实格式化（P1：确认/采用时间都取产品 turn/run 字段）。 */
function formatProductTime(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function returnCard(turn, anchor, attempts, placement) {
  const treeKey = `${state.currentTreeId}:${turn.id}`;
  const nowMs = Date.now();
  const div = document.createElement("div");
  div.className = "turn return";
  div.dataset.turnId = turn.id;
  div.dataset.turnText = turn.text;
  turnElements.set(turn.id, div); /* 供提交后滚动定位 / 反查焦点还原 */
  /* M3：插入动效（高度展开 + 淡入 ≤200ms）只在首次出现的卡上播放。 */
  if (!state.knownReturnIds.has(treeKey)) {
    state.knownReturnIds.add(treeKey);
    returnInsertedAt.set(treeKey, nowMs);
  }
  const insertedAt = returnInsertedAt.get(treeKey);
  if (insertedAt !== undefined && nowMs - insertedAt < MOTION_EPOCH_MS) {
    div.classList.add("insert");
  }

  const meta = document.createElement("span");
  meta.className = "meta";
  const from = branchLabel(turn.fromBranchId ?? "");
  const savedAt = formatProductTime(turn.createdAt);
  /* 锚点注记（P1）：anchored = 摘录 + 来源分支内联；fallback = 以
     targetAnchor 快照区分来源去向（其他 Branch / 已变化 / 缺失），摘录
     随卡面可读（短内联 / 长折叠）。 */
  let anchorNote;
  let excerptElement = null;
  const shortExcerpt = anchor !== null && anchor.selection.text.length <= RETURN_EXCERPT_COLLAPSE_THRESHOLD;
  if (placement === "anchored" && anchor !== null) {
    anchorNote = shortExcerpt
      ? ` · anchored on “${anchor.selection.text}” from ${branchLabel(anchor.sourceBranchId)}`
      : ` · anchored on a long selection from ${branchLabel(anchor.sourceBranchId)}`;
    excerptElement = returnExcerptElement(anchor.selection.text);
  } else if (anchor !== null) {
    const reason = returnFallbackReason(turn);
    const inline = shortExcerpt ? ` (anchored on “${anchor.selection.text}”)` : "";
    if (reason.kind === "elsewhere") {
      anchorNote = ` · source on ${branchLabel(reason.anchor.sourceBranchId)}${inline}`;
    } else if (reason.kind === "changed") {
      anchorNote = ` · source changed${inline}`;
    } else if (reason.anchor !== null) {
      anchorNote = ` · source missing${inline}`;
    } else {
      anchorNote = " · original anchor unavailable";
    }
    excerptElement = returnExcerptElement(anchor.selection.text);
  } else {
    anchorNote = " · original anchor unavailable";
  }
  meta.append(document.createTextNode(`↩ Return from ${from} · saved ${savedAt}${anchorNote}`));

  const delivered = turn.deliveredRunId !== null;
  const delivery = document.createElement(delivered ? "button" : "span");
  delivery.className = `delivery${delivered ? " delivered delivery-link" : ""}`;
  /* M4：pending → delivered 徽标切换（~100ms 颜色/文案过渡；只在已见
     pending 的卡上检测到状态变化时播放；reduced-motion 即时）。
     观测窗口内随重渲保持 class（见函数头注释）。 */
  const seenRun = state.seenDeliveredRunIds.get(treeKey);
  if (delivered && seenRun === null) {
    deliveredChangedAt.set(treeKey, nowMs);
  }
  const changedAt = deliveredChangedAt.get(treeKey);
  if (delivered && changedAt !== undefined && nowMs - changedAt < MOTION_EPOCH_MS) {
    delivery.classList.add("badge-change");
  }
  if (delivered) {
    /* deliveredRunId 只表示首次成功采用的 run（signed v3 §3.2）；
       此前的失败/中止尝试记录在来源抽屉（Sources → Attempts）。
       P1：送达时间从采用尝试记录反查该 run 的 terminalAt（产品事实；
       记录缺失的旧快照如实省略）。 */
    const deliveredAttempt = attempts.find((attempt) => attempt.runId === turn.deliveredRunId);
    const adoptedNote =
      deliveredAttempt !== undefined && deliveredAttempt.terminalAt !== null
        ? `, adopted ${formatProductTime(deliveredAttempt.terminalAt)}`
        : "";
    delivery.textContent = `successfully adopted into Trunk context (run ${turn.deliveredRunId.slice(0, 12)}…${adoptedNote})`;
    delivery.title = `first successfully adopted into Trunk run ${turn.deliveredRunId} — open sources`;
    div.dataset.deliveredRunId = turn.deliveredRunId;
    div.title = `first successfully adopted into Trunk run ${turn.deliveredRunId}`;
    delivery.addEventListener("click", () =>
      void openDrawer({
        focusRunId: turn.deliveredRunId,
        trigger: { kind: "return-card", turnId: turn.id },
      }),
    );
  } else if (attempts.length > 0) {
    /* 已有主支 run 尝试采用但尚未成功（失败/中止后仍待重注入）：如实呈
       “采用尝试过 N 次”，不伪装成已送达，也不丢失已保存事实。 */
    delivery.className = "delivery attempted";
    delivery.textContent = `adoption attempted (${String(attempts.length)}) — still pending, retried on the next Trunk discussion`;
    delivery.title = attempts
      .map((a) => `run ${a.runId.slice(0, 12)}… ${a.runState}${a.failure !== null ? ` (${a.failure.code})` : ""}`)
      .join("\n");
  } else {
    delivery.textContent = "saved — pending adoption on the next Trunk discussion";
  }
  state.seenDeliveredRunIds.set(treeKey, turn.deliveredRunId);
  meta.append(delivery);
  div.append(meta);
  if (excerptElement !== null) div.append(excerptElement);
  div.append(document.createTextNode(turn.text));
  return div;
}

/* ------------------------------ ③ 正文/操作分层（issue #7 C ③） ------------------------------ */

/** 元素节点判定（真实 DOM 与脚本桩共用：文本节点无 classList/dataset）。 */
function isElementNode(node) {
  return (
    node !== null &&
    typeof node === "object" &&
    typeof node.classList === "object" &&
    node.classList !== null &&
    typeof node.dataset === "object"
  );
}

/** 容器内按 (turnId, text) 找可复用的 turn 元素（正文层跨重渲稳定）。 */
function findReusableTurnElement(container, turn) {
  for (const child of container.children) {
    if (!isElementNode(child)) continue;
    if (!child.classList.contains("turn") || child.classList.contains("return")) continue;
    if (child.dataset.turnId !== turn.id) continue;
    if (child.dataset.turnText !== turn.text) continue;
    return child;
  }
  return null;
}

/* -------- 批注锚定联合校验（issue #7 增量验收 2026-09-30 P0） -------- */

/** SHA-256 轮常量（FIPS 180-4）。 */
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** UTF-16 → UTF-8 字节序列（孤立代理按 U+FFFD 替换——与 TextEncoder /
    Node utf8 同口径，保证与锚点 turn 原文（服务端以 utf8 摘要）可对齐）。 */
function utf8BytesOf(text) {
  const bytes = [];
  for (let i = 0; i < text.length; i += 1) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i += 1;
      } else {
        code = 0xfffd;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      code = 0xfffd;
    }
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return bytes;
}

function sha256Rotr(x, n) {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

/**
 * SHA-256（十六进制摘要）——服务端 hashSourceText（src/terminology.ts）同
 * 口径的无依赖 vanilla JS 实现，供批注锚定的全文指纹校验（P0「来源版本
 * 与摘录切片联合校验」的版本半边）。带 text→摘要缓存（渲染路径反复校验
 * 零重算；超限整体清空——重算廉价，绝不无界增长）。
 */
const sha256HexCache = new Map();
function sha256Hex(text) {
  const cached = sha256HexCache.get(text);
  if (cached !== undefined) return cached;
  const bytes = utf8BytesOf(text);
  const bitLength = bytes.length * 8;
  const paddedLength = ((bytes.length + 9 + 63) >> 6) << 6;
  const data = new Uint8Array(paddedLength);
  for (let i = 0; i < bytes.length; i += 1) data[i] = bytes[i];
  data[bytes.length] = 0x80;
  const hi = Math.floor(bitLength / 4294967296);
  const lo = bitLength % 4294967296;
  data[paddedLength - 8] = (hi >>> 24) & 0xff;
  data[paddedLength - 7] = (hi >>> 16) & 0xff;
  data[paddedLength - 6] = (hi >>> 8) & 0xff;
  data[paddedLength - 5] = hi & 0xff;
  data[paddedLength - 4] = (lo >>> 24) & 0xff;
  data[paddedLength - 3] = (lo >>> 16) & 0xff;
  data[paddedLength - 2] = (lo >>> 8) & 0xff;
  data[paddedLength - 1] = lo & 0xff;
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      const j = offset + i * 4;
      w[i] = ((data[j] << 24) | (data[j + 1] << 16) | (data[j + 2] << 8) | data[j + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = sha256Rotr(w[i - 15], 7) ^ sha256Rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = sha256Rotr(w[i - 2], 17) ^ sha256Rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i += 1) {
      const S1 = sha256Rotr(e, 6) ^ sha256Rotr(e, 11) ^ sha256Rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = sha256Rotr(a, 2) ^ sha256Rotr(a, 13) ^ sha256Rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }
  const hex = [h0, h1, h2, h3, h4, h5, h6, h7].map((x) => x.toString(16).padStart(8, "0")).join("");
  if (sha256HexCache.size > 256) sha256HexCache.clear();
  sha256HexCache.set(text, hex);
  return hex;
}

/**
 * 已保存批注对「当前渲染中的锚点 turn」的联合校验（P0）：界内区间、摘录
 * 切片全等、全文指纹（sourceHash）三者同时成立才允许渲染活覆盖——只验
 * 边界会把批注挂到漂移后的错误文本上（等长替换/同词移位/代理对错位在
 * 边界判定下全部伪装成立）。sourceHash 是批注保存时刻锚点答案全文的
 * SHA-256（服务端 hashSourceText）；当前文本指纹失配 = 原文在保存后发生
 * 过变化（含被批注区间之外的编辑）——同样降级，绝不冒充仍锚定在原文上。
 * 字段缺失按失配处理（fail-closed：数据残缺不放宽校验）。
 */
function annotationMatchesTurn(annotation, turn) {
  const start = annotation.selection.start;
  const end = annotation.selection.end;
  if (!(start >= 0 && end > start && end <= turn.text.length)) return false;
  if (turn.text.slice(start, end) !== annotation.selection.text) return false;
  return sha256Hex(turn.text) === annotation.sourceHash;
}

/**
 * 批注锚点三态（W1 降级 Return 卡 available/changed/missing 的锚定语义同
 * 款词汇）：以当前树状态里的锚点 turn 为事实源反查——查不到 → missing
 * （锚点答案已不在树中）；查到但联合校验失败 → changed（原文漂移）；全
 * 部成立 → valid。降级路径只展示保存快照（批注自带的摘录与解释）+ 状态
 * 说明（抽屉列表/解释卡），绝不渲染当前文本上的活覆盖。
 */
function terminologyAnchorStatus(annotation) {
  const st = state.treeState;
  if (st === null) return "missing";
  for (const view of st.branches) {
    const found = view.turns.find(
      (t) => t.id === annotation.anchorTurnId && t.branchId === annotation.branchId,
    );
    if (found !== undefined) {
      return annotationMatchesTurn(annotation, found) ? "valid" : "changed";
    }
  }
  return "missing";
}

/**
 * 统一区间覆盖（issue #7 C ③）：术语批注与来源揭示高亮共用同一机制，一律
 * 由绝对 UTF-16 偏移（W1 §1.1——重复词/跨行禁用字符串搜索定位）计算。
 * 来源揭示带 M6 一次性脉冲标记；与批注区间重叠时来源优先（揭示是即时
 * 定位动作），批注区间不重叠地并存。读模型未载/拉取失败时如实无批注
 * 覆盖（不伪造）。
 * 批注覆盖渲染前过 annotationMatchesTurn 联合校验（P0，issue #7 增量验收
 * 2026-09-30）：界内区间只证明「区间存在」，不证明「批注还挂在原文上」
 * ——等长替换/同词移位/半代理对在界内照样成立。任一失配不渲染活覆盖，
 * 降级呈现见抽屉批注列表与解释卡的 source changed/missing 说明。
 */
function turnOverlaysFor(branchId, turn) {
  const overlays = [];
  const highlight = state.sourceHighlight;
  if (
    highlight !== null &&
    highlight.branchId === branchId &&
    highlight.turnId === turn.id &&
    highlight.start >= 0 &&
    highlight.end > highlight.start &&
    highlight.end <= turn.text.length
  ) {
    /* M6：一次性脉冲（1–2 次）后保持静态高亮；重渲不重复脉冲。 */
    const pulseKey = `${state.currentTreeId}:${highlight.turnId}:${highlight.start}-${highlight.end}`;
    const pulse = state.pulsedHighlightKey !== pulseKey;
    if (pulse) state.pulsedHighlightKey = pulseKey;
    overlays.push({ kind: "source", start: highlight.start, end: highlight.end, pulse, annotation: null });
  }
  const terminology = state.terminology;
  if (terminology !== null && terminology.ok) {
    for (const annotation of terminology.annotations) {
      if (annotation.anchorTurnId !== turn.id || annotation.branchId !== branchId) continue;
      if (!annotationMatchesTurn(annotation, turn)) continue;
      const start = annotation.selection.start;
      const end = annotation.selection.end;
      if (overlays.some((overlay) => start < overlay.end && overlay.start < end)) continue;
      overlays.push({ kind: "term", start, end, pulse: false, annotation });
    }
  }
  overlays.sort((a, b) => a.start - b.start);
  return overlays;
}

/**
 * 把区间覆盖应用到 turn 的正文层：重建前导正文区（turn 元素本身按元素复
 * 用保持身份），包裹节点只包住既有字符——textContent 与复制行为字节不变，
 * 选择偏移计算（selectionOffsetsWithin 的前缀长度法）不受影响。来源揭示
 * 覆盖在场时锚点 turn 携带 tabindex/-1 与 anchor-focus（W2 §2.6 键盘焦
 * 点行），覆盖消失时如数移除（复用元素不残留陈旧态）。
 */
function applyTurnOverlays(element, turn, overlays) {
  element.replaceChildren();
  let cursor = 0;
  for (const overlay of overlays) {
    /* 前缀文本节点恒在场（空切片为空文本节点——与揭示渲染的既有 DOM 形状
       一致：前缀/标记/后缀三段恰切，供按位切片断言）。 */
    element.append(document.createTextNode(turn.text.slice(cursor, overlay.start)));
    if (overlay.kind === "source") {
      const mark = document.createElement("mark");
      mark.className = overlay.pulse ? "source-highlight pulse" : "source-highlight";
      mark.textContent = turn.text.slice(overlay.start, overlay.end);
      element.append(mark);
    } else {
      const span = document.createElement("span");
      span.className = "term-annotation-mark";
      span.title = "saved terminology annotation — select it and use the toolbar to reopen";
      span.textContent = turn.text.slice(overlay.start, overlay.end);
      span.addEventListener("click", () => {
        if (overlay.annotation !== null) {
          openSavedAnnotationCard(overlay.annotation, branchIdOfTurn(turn), turn);
        }
      });
      element.append(span);
    }
    cursor = overlay.end;
  }
  element.append(document.createTextNode(turn.text.slice(cursor)));
  if (overlays.some((overlay) => overlay.kind === "source")) {
    element.setAttribute("tabindex", "-1");
    element.classList.add("anchor-focus");
  } else {
    element.removeAttribute("tabindex");
    element.classList.remove("anchor-focus");
  }
}

/** turn 所属分支（批注覆盖点击重开卡时定位视图用）。 */
function branchIdOfTurn(turn) {
  return turn.branchId;
}

/** 动作层：重建 .turn-actions（按钮 + 武装选区工具条）——正文区不触碰。 */
function renderTurnActions(element, turn, branchId) {
  const old = element.querySelector(".turn-actions");
  if (old !== null) element.removeChild(old);
  element.append(buildTurnActions(turn, branchId));
}

/** 构建动作层（.turn-actions）：常驻入口（建支线/解释）+ 选择提示 +
    武装选区时的工具条（③ 模式/工具条）。 */
function buildTurnActions(turn, branchId) {
  const st = state.treeState;
  const view = branchId === st.trunkBranchId ? "main" : "panel";
  const wrap = document.createElement("span");
  wrap.className = "turn-actions";
  const armed = state.armedSelection;
  const armedHere = armed !== null && armed.branchId === branchId && armed.turnId === turn.id;

  const branchButton = document.createElement("button");
  branchButton.className = "branch-here";
  branchButton.textContent = armedHere ? "⑃ Branch from selection" : "⑃ Branch from here";
  branchHereButtons.set(turn.id, branchButton);
  branchButton.addEventListener("click", () => guard(() => branchFromTurn(turn), view));

  /* 术语解释入口（issue #7 C ③）：选区（点词双击/任意划线/触屏
     selectionchange）即武装；无选区禁用（解释需要明确区间，不做整答案
     回退）。武装态读 state.armedSelection（与工具条同源）。 */
  const explainButton = document.createElement("button");
  explainButton.className = "term-explain";
  explainButton.textContent = "⌖ Explain selection";
  explainButton.disabled = !armedHere;
  explainButton.title =
    "Explain the selected term or span (terminology executor — isolated, no main-session side effects)";
  termExplainButtons.set(turn.id, explainButton);
  explainButton.addEventListener("click", () => {
    const current = state.armedSelection;
    if (current === null || current.branchId !== branchId || current.turnId !== turn.id) return;
    guard(
      () => explainSelection(branchId, turn, { start: current.start, end: current.end, text: current.text }),
      view,
    );
  });

  const hint = document.createElement("span");
  hint.className = "selection-hint";
  hint.textContent = "(select text above to anchor the branch)";
  wrap.append(branchButton, explainButton, hint);
  if (armedHere) wrap.append(buildSelectionToolbar(branchId, turn, armed));
  return wrap;
}

/** 工具条内按（分支, 锚点 turn, 精确区间）找已保存批注（读模型数据面）。
    P0 同源校验：批注摘录必须与当前选区文本全等——同偏移异文（原文漂移后
    的陈旧批注）不是「这个选区的批注」，不给捷径（服务端解释仍会以同选区
    去重如实返回该批注，卡面带 source changed 降级说明）。 */
function findAnnotationForSelection(branchId, turnId, selection) {
  const terminology = state.terminology;
  if (terminology === null || !terminology.ok) return null;
  return (
    terminology.annotations.find(
      (annotation) =>
        annotation.branchId === branchId &&
        annotation.anchorTurnId === turnId &&
        annotation.selection.start === selection.start &&
        annotation.selection.end === selection.end &&
        annotation.selection.text === selection.text,
    ) ?? null
  );
}

/**
 * 选区工具条（③ 模式/工具条）：服务端既有模式的入口——解释（点词 term /
 * 划线 range，按选区文本是否含空白判定）、建支线（通用入口，绝不复用已有
 * 探索）；已有批注时给出「打开已存批注 / 推广」捷径，已推广的批注呈现
 * resume-or-create 明确去向（issue #7 ②③：同锚点恢复或明确另开，绝不跨
 * 语境静默复用）。键盘可达（原生 button）。
 */
function buildSelectionToolbar(branchId, turn, armed) {
  const st = state.treeState;
  const view = branchId === st.trunkBranchId ? "main" : "panel";
  const bar = document.createElement("span");
  bar.className = "selection-toolbar";
  bar.setAttribute("role", "toolbar");
  bar.setAttribute(
    "aria-label",
    `Selection actions — ${armed.mode === "term" ? "term" : "span"} “${armed.text}”`,
  );

  const explain = document.createElement("button");
  explain.className = "toolbar-explain";
  explain.textContent = armed.mode === "term" ? "⌖ Explain term" : "⌖ Explain span";
  explain.title = "Run the isolated terminology executor on this selection (no main-session side effects)";
  explain.addEventListener("click", () => {
    guard(
      () => explainSelection(branchId, turn, { start: armed.start, end: armed.end, text: armed.text }),
      view,
    );
  });
  bar.append(explain);

  const branch = document.createElement("button");
  branch.className = "toolbar-branch";
  branch.textContent = "⑃ Branch from selection";
  branch.title = "Anchor a brand-new branch on this selection (never reuses an existing exploration)";
  branch.addEventListener("click", () => guard(() => branchFromTurn(turn), view));
  bar.append(branch);

  /* 已解释未保存：工具条直达保存（与解释卡同一动作）。 */
  const card = state.termExplain;
  if (
    card !== null &&
    card.branchId === branchId &&
    card.turnId === turn.id &&
    card.state === "explained" &&
    card.selection.start === armed.start &&
    card.selection.end === armed.end
  ) {
    const save = document.createElement("button");
    save.className = "toolbar-save";
    save.textContent = "✓ Save as annotation";
    save.title = "Persist this explanation as a term annotation (product fact)";
    save.addEventListener("click", () => guard(saveTermAnnotation, view));
    bar.append(save);
  }

  const existing = findAnnotationForSelection(branchId, turn.id, armed);
  if (existing !== null) {
    const open = document.createElement("button");
    open.className = "toolbar-annotation";
    open.textContent = existing.promotedBranchId === null ? "✓ Saved annotation" : "✓ Follow-up exists";
    open.title = "Open the saved annotation card for this exact selection";
    open.addEventListener("click", () => openSavedAnnotationCard(existing, branchId, turn));
    bar.append(open);
    if (existing.promotedBranchId === null) {
      const promote = document.createElement("button");
      promote.className = "toolbar-promote";
      promote.textContent = "⑃ Promote to branch";
      promote.title = "Open the annotation card and focus the follow-up first-question field";
      promote.addEventListener("click", () => openSavedAnnotationCard(existing, branchId, turn, { focusFirstQuestion: true }));
      bar.append(promote);
    }
  }
  return bar;
}

/**
 * 就地同步武装态（mouseup/双击/selectionchange 路径）：只改动作层内的既有
 * 按钮/工具条（被捕获的按钮引用与焦点不失效），正文区一字不碰。renderAll
 * 路径由 buildTurnActions 全量重建，两路最终态一致。
 */
function syncTurnActionsArmedState(element, turn, branchId) {
  const actions = element.querySelector(".turn-actions");
  if (actions === null) return;
  const armed = state.armedSelection;
  const armedHere = armed !== null && armed.branchId === branchId && armed.turnId === turn.id;
  const branchButton = actions.querySelector(".branch-here");
  if (branchButton !== null) {
    branchButton.textContent = armedHere ? "⑃ Branch from selection" : "⑃ Branch from here";
  }
  const explainButton = actions.querySelector(".term-explain");
  if (explainButton !== null) explainButton.disabled = !armedHere;
  const toolbar = actions.querySelector(".selection-toolbar");
  if (toolbar !== null && toolbar.parentElement !== null) toolbar.parentElement.removeChild(toolbar);
  if (armedHere) actions.append(buildSelectionToolbar(branchId, turn, armed));
}

/**
 * 武装/解除选区（mouseup、双击与触屏 selectionchange 共用）：读到本 turn
 * 正文内的选区即武装（模式按选区文本判定：含空白 = range，否则 term）；
 * 无选区（或选区在别处）即解除。换武装目标时旧 turn 的动作层按最新状态
 * 重建（工具条随武装走）。selectionOffsetsWithin 的 contains 守卫保证跨
 * turn 选区不误武装。
 */
function armTurnSelection(element, turn, branchId) {
  const selection = selectionOffsetsWithin(element, turn.text);
  const armed =
    selection === null
      ? null
      : {
          branchId,
          turnId: turn.id,
          start: selection.start,
          end: selection.end,
          text: selection.text,
          mode: selection.text.trim().includes(" ") ? "range" : "term",
        };
  const previous = state.armedSelection;
  if (
    armed !== null &&
    previous !== null &&
    previous.branchId === armed.branchId &&
    previous.turnId === armed.turnId &&
    previous.start === armed.start &&
    previous.end === armed.end
  ) {
    state.armedSelection = previous; /* 同一选区重复武装：保持对象身份 */
  } else {
    state.armedSelection = armed;
  }
  const armedHere =
    state.armedSelection !== null &&
    state.armedSelection.branchId === branchId &&
    state.armedSelection.turnId === turn.id;
  element.classList.toggle("has-selection", armedHere);
  syncTurnActionsArmedState(element, turn, branchId);
  if (
    previous !== null &&
    (armed === null || previous.turnId !== armed.turnId || previous.branchId !== armed.branchId)
  ) {
    const entry = assistantTurns.get(previous.turnId);
    if (entry !== undefined) renderTurnActions(entry.element, entry.turn, entry.branchId);
  }
}

/** turn 元素创建时挂接选区事件（复用元素的身份跨重渲保持，监听只挂一次）。 */
function attachTurnSelectionListeners(element, turn, branchId) {
  /* ③ 选择期间不重绘：正文层上的按下开启拖拽窗口——窗口内整树重渲延后
     （renderAll 见 selectionDragActive），mouseup 收尾冲刷。按钮/工具条上
     的按下不是选区拖拽（event.target 非空且在 .turn-actions 内时跳过；
     脚本桩事件无 target，按正文按下处理）。 */
  element.addEventListener("mousedown", (event) => {
    const target = event.target;
    if (
      target !== undefined &&
      target !== null &&
      typeof target.closest === "function" &&
      target.closest(".turn-actions") !== null
    ) {
      return;
    }
    state.selectionDragActive = true;
  });
  const armFromEvent = () => {
    if (state.selectionDragActive) {
      state.selectionDragActive = false;
      /* 冲刷延后一拍：mouseup 与 click 之间不重建按钮（click 仍落在原按钮
         上），0ms 后再补被延后的重渲。 */
      window.setTimeout(flushPendingRerender, 0);
    }
    armTurnSelection(element, turn, branchId);
  };
  element.addEventListener("mouseup", armFromEvent);
  /* 点词（issue #7 ②③）：双击选词与任意划线同一路径武装。 */
  element.addEventListener("dblclick", armFromEvent);
}

/** 触屏/全局选区定位：当前选区落在哪个已渲染 assistant turn 的正文内。 */
function findLiveSelectionTurn() {
  for (const entry of assistantTurns.values()) {
    const selection = selectionOffsetsWithin(entry.element, entry.turn.text);
    if (selection !== null) {
      return { ...entry, selection };
    }
  }
  return null;
}

/** 焦点是否在选区交互面（工具条/解释卡/D4-2 材料捕获条）内——选区解除
    延迟判定用。 */
function withinTerminologySurface(element) {
  let current = element;
  while (current !== null && isElementNode(current)) {
    if (
      current.classList.contains("selection-toolbar") ||
      current.classList.contains("term-explain-card") ||
      current.classList.contains("mat-selection-bar")
    ) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

/** 解除武装（触屏空选区的延迟解除路径）：就地刷新动作层。 */
function disarmArmedSelection() {
  const armed = state.armedSelection;
  if (armed === null) return;
  state.armedSelection = null;
  const entry = assistantTurns.get(armed.turnId);
  if (entry !== undefined) {
    entry.element.classList.remove("has-selection");
    syncTurnActionsArmedState(entry.element, entry.turn, entry.branchId);
  }
}

/** 冲刷拖拽窗口内被延后的整树重渲与阅读器 chrome 重渲（③ 选择期间不重
    绘的收尾；阅读器块追加是纯增量的，不经此路径）。 */
function flushPendingRerender() {
  if (!state.pendingRerender && !materialPendingUpdate && !materialBarPendingUpdate) return;
  const rerenderAll = state.pendingRerender;
  const rerenderMaterial = materialPendingUpdate;
  const rerenderBar = materialBarPendingUpdate;
  state.pendingRerender = false;
  materialPendingUpdate = false;
  materialBarPendingUpdate = false;
  if (rerenderAll) renderAll();
  if (rerenderMaterial && state.materialReader !== null) renderMaterialReader();
  else if (rerenderBar && state.materialReader !== null) updateMatSelectionBar();
}

/** 解释卡聚焦目标的读取（③ 草稿/焦点纪律）：必须在调和移除旧卡**之前**
    读取——真实浏览器里聚焦控件随祖先移除即失焦（activeElement 回落
    body），移除后读取永不命中（DOM 桩无「移除即失焦」语义，原实现只在
    桩内成立；术语真实浏览器探针发现并修复）。 */
function termCardFocusTargetId() {
  const active = document.activeElement;
  if (active === null || !isElementNode(active)) return null;
  if (active.id !== "term-explain-card" && active.id !== "term-first-question") return null;
  return active.id;
}

/** 解释卡重建后的焦点保持（③ 草稿/焦点纪律）：旧卡内聚焦的控件（首问
    输入 / 卡本身）在同 id 新卡上恢复焦点——重渲不丢打字焦点。 */
function preserveTermCardFocus(targetId) {
  if (targetId === null) return;
  const fresh = document.getElementById(targetId);
  if (fresh !== null && document.activeElement !== fresh) fresh.focus();
}

/** 流式占位（M5 静态指示——caret 不闪烁；id/类名词法锁定）。 */
function streamingPlaceholder(text) {
  const placeholder = document.createElement("div");
  placeholder.id = "streaming-turn";
  placeholder.className = "turn assistant streaming-turn";
  placeholder.append(document.createTextNode(text));
  const caret = document.createElement("span");
  caret.className = "streaming-caret";
  caret.textContent = " ▍ streaming…";
  placeholder.append(caret);
  return placeholder;
}

/** 取得 turn 的渲染元素（③：优先复用——同 turnId 且同文本）。复用时只
    更新动作层与区间覆盖（覆盖签名未变则正文文本节点原样保留）；新建时
    挂接选区监听并初始化两层。 */
function ensureTurnElement(container, turn, branchId) {
  const existing = findReusableTurnElement(container, turn);
  if (existing !== null) {
    turnElements.set(turn.id, existing);
    if (turn.role === "assistant") {
      assistantTurns.set(turn.id, { element: existing, turn, branchId });
      updateAssistantTurnLayer(existing, turn, branchId);
    }
    return existing;
  }
  const div = document.createElement("div");
  div.className = `turn ${turn.role}`;
  div.dataset.turnId = turn.id;
  div.dataset.turnText = turn.text;
  turnElements.set(turn.id, div);
  if (turn.role === "assistant") {
    assistantTurns.set(turn.id, { element: div, turn, branchId });
    attachTurnSelectionListeners(div, turn, branchId);
    updateAssistantTurnLayer(div, turn, branchId);
  } else {
    div.textContent = turn.text;
  }
  return div;
}

/** assistant turn 的分层更新：区间覆盖（签名未变不动正文）+ 动作层重建。 */
function updateAssistantTurnLayer(element, turn, branchId) {
  const overlays = turnOverlaysFor(branchId, turn);
  const signature = overlays
    .map((overlay) => `${overlay.kind}:${String(overlay.start)}-${String(overlay.end)}${overlay.pulse ? ":pulse" : ""}`)
    .join("|");
  if (element.dataset.appliedOverlays !== signature) {
    applyTurnOverlays(element, turn, overlays);
    element.dataset.appliedOverlays = signature;
  }
  renderTurnActions(element, turn, branchId);
}

/**
 * 顶层子节点的按位调和（③ 正文/操作分层的核心）：期望序列与现序列逐位
 * 对齐——完全一致时**零 DOM 变更**（异步刷新——SSE 终态/轮询——对未变化
 * 的结构不触碰任何节点，武装选区下的正文层身份与文本节点原样保留，
 * issue #7 ③「选择期间不重绘」）；有差异时只动差异位（insertBefore 定点
 * 插入/移除，不改无关兄弟节点的位置）。turn 元素是复用的稳定层；卡片
 * （Return / 解释卡 / 流式占位 / 空态）每次重建为新鲜节点。
 */
function reconcileTopLevel(container, desired) {
  const current = [...container.children];
  if (current.length === desired.length && current.every((node, index) => node === desired[index])) {
    return; /* 零变更快路径 */
  }
  const keep = new Set(desired);
  /* 先就位、后移除（顺序整改）：新节点先插入到目标位，再摘除非保留的
     旧节点——移除窗口内新旧并存，内容高度不会瞬时塌缩。原先「先移除后
     插入」在替换瞬态卡（解释卡 / Return 卡——每次重渲重建的新鲜节点）
     时，内容高度先塌再涨，浏览器把 scrollTop 钳到塌缩高度（实测塌到 0），
     而滚动监听把该钳位值记成分支的阅读位置——此后每次重渲都恢复到错误
     位置（用户阅读位置无声重置到顶部；W2 §4 纪律被瞬态布局破坏——术语
     真实浏览器探针在整序环境下确定性复现，单独跑时布局时序不触发）。
     就位/移除同属一个同步块，无中间绘制；终态与原实现逐位一致。 */
  for (let index = 0; index < desired.length; index += 1) {
    const node = desired[index];
    const at = container.children[index];
    if (at === node) continue;
    if (at === undefined) {
      container.appendChild(node);
    } else {
      container.insertBefore(node, at);
    }
  }
  for (const node of current) {
    if (!keep.has(node)) container.removeChild(node);
  }
  while (container.children.length > desired.length) {
    container.removeChild(container.children[desired.length]);
  }
}

/**
 * 共享对话渲染（主线 / 面板；issue #7 C ③ 正文/操作分层）：
 *  - 每个 turn 的正文是自己的层（turn 元素承载前导正文区——纯文本节点 +
 *    统一区间覆盖包裹；动作/覆盖层在尾部 .turn-actions）；正文区
 *    textContent 恒等于 turn 原文，复制行为不变；
 *  - turn 元素按 (turnId, text) 复用（reconcileTopLevel）：不再整容器
 *    replaceChildren——只有状态围绕正文变化的重渲对正文层零触碰；
 *  - Return 按目标锚点定位、锚点高亮（M6 一次性脉冲）、流式占位
 *    （M5 静态指示）语义与既有锁定一致；
 * 滚动策略（W2 §2.2/§4 + issue #3）：接收新内容（stick）只在用户本就
 * 贴底时跟随贴底（平滑；reduced-motion 直接定位）——已向上阅读绝不
 * 强制滚底；其余渲染恢复该分支已记忆的阅读位置；无记录（首次打开）
 * 直接落底（自然的阅读起点，非强制拉动）。
 */
function renderTurnsInto(container, view, branchId, stick) {
  const st = state.treeState;
  /* 贴底判定取重渲前实况（结构变更会改变 scrollHeight）。 */
  const wasAtBottom = isAtBottom(container);

  /* Return 按目标锚点定位：targetAnchor.anchorTurnId 命中当前视图内的
     assistant turn → 该锚点之后渲染；锚点不在当前视图（历史 Return 或
     锚点位于其他分支）→ 按时间顺序原位渲染并降级标注。 */
  const turnIds = new Set(view.turns.map((turn) => turn.id));
  const anchoredReturns = new Map();
  for (const turn of view.turns) {
    if (turn.role !== "return" || turn.targetAnchor === null) continue;
    if (!turnIds.has(turn.targetAnchor.anchorTurnId)) continue;
    const list = anchoredReturns.get(turn.targetAnchor.anchorTurnId) ?? [];
    list.push(turn);
    anchoredReturns.set(turn.targetAnchor.anchorTurnId, list);
  }
  const isAnchored = (turn) =>
    turn.role === "return" &&
    turn.targetAnchor !== null &&
    (anchoredReturns.get(turn.targetAnchor.anchorTurnId) ?? []).includes(turn);

  /* 期望的顶层子节点序列：turn 元素（复用层）与卡片（瞬态层）按渲染顺序。 */
  const desired = [];
  if (view.turns.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent =
      branchId === st.trunkBranchId
        ? "Empty Trunk — send the first prompt."
        : "Empty branch — continue it with a prompt.";
    desired.push(empty);
  }
  for (const turn of view.turns) {
    if (turn.role === "return") {
      if (isAnchored(turn)) continue; /* 已随锚点答案渲染 */
      /* 材料 Return（D4-3）：来源分支无 Turn 来源（材料来源）→ 材料来源卡
         （targetAnchor null 是诚实事实——按确认时间放置，原文跳转不伪造
         主线位置）；与 Turn 来源 Return 的降级卡分开呈现。 */
      const fromView = turn.fromBranchId === null ? null : branchView(turn.fromBranchId);
      if (isMaterialBranchView(fromView)) {
        desired.push(materialReturnCard(turn, returnAttemptsFor(view, turn.id)));
        continue;
      }
      /* 降级放置（P1）：锚点不在当前视图——targetAnchor 快照随卡传递，
         区分来源位于其他 Branch / 已变化 / 缺失，摘录照常在卡面可读。 */
      desired.push(returnCard(turn, turn.targetAnchor, returnAttemptsFor(view, turn.id), "fallback"));
      continue;
    }
    desired.push(ensureTurnElement(container, turn, branchId));
    if (turn.role === "assistant") {
      /* 术语建议条（①阅读模式）：渲染在该条答案之后、其 Return 卡之前
         ——建议附着在回答区，正文层（textContent 字节不变）不受影响。 */
      const suggestStrip = termSuggestionStrip(branchId, turn);
      if (suggestStrip !== null) desired.push(suggestStrip);
      for (const returnTurn of anchoredReturns.get(turn.id) ?? []) {
        desired.push(
          returnCard(returnTurn, returnTurn.targetAnchor, returnAttemptsFor(view, returnTurn.id), "anchored"),
        );
      }
      /* 术语解释卡：渲染在对应答案（及其 Return 卡）之后。 */
      if (
        state.termExplain !== null &&
        state.termExplain.branchId === branchId &&
        state.termExplain.turnId === turn.id
      ) {
        const card = termExplainCard();
        if (card !== null) desired.push(card);
      }
    }
  }

  /* P1 流式占位回显：在途 run 位于本视图分支时追加瞬态占位 turn
     （run-terminal 后由 /state 权威刷新取代）。 */
  const streaming = state.streaming;
  if (streaming !== null && streaming.branchId === branchId) {
    desired.push(streamingPlaceholder(streaming.text));
  }

  /* ③ 草稿/焦点纪律：聚焦目标先于调和移除读取（真实浏览器里旧卡移除即
     失焦），重建后在同 id 新节点上恢复。 */
  const termFocusTargetId = termCardFocusTargetId();
  reconcileTopLevel(container, desired);
  preserveTermCardFocus(termFocusTargetId);

  const saved = state.scrollPositions.get(scrollKey(branchId));
  if ((stick && wasAtBottom) || saved === undefined) {
    /* 贴底跟随——仅当用户本就贴底（或首次打开无阅读位置记录，直接落底
       为自然的阅读起点）；已向上阅读（stick 且 !wasAtBottom 且有记录）
       落入恢复分支，阅读位置不动（issue #3：不得强制滚底）。 */
    container.scrollTo({
      top: container.scrollHeight,
      behavior: saved === undefined ? "auto" : scrollBehavior(),
    });
  } else {
    container.scrollTop = Math.min(saved, container.scrollHeight);
  }
}

/** 主线（Trunk）主阅读面板渲染。 */
function renderMainConversation(stick) {
  const container = $("conversation");
  const trunk = trunkBranchId();
  const view = branchView(trunk);
  if (view === null) {
    container.replaceChildren();
    const note = document.createElement("p");
    note.className = "muted";
    note.textContent = "No trunk branch in this tree.";
    container.append(note);
    return;
  }
  renderTurnsInto(container, view, trunk, stick);
}

/** 面板头部：锚点上下文（摘录 + originStatus 徽标；降级不伪造——摘录始终可读）。 */
function renderPanelAnchorContext(view) {
  const el = $("panel-anchor-context");
  el.replaceChildren();
  /* 材料 Branch（D4-3）：无 Turn 来源——材料来源上下文（标题/版本/块/摘录）
     从建枝/恢复响应的缓存读取（树态不含材料来源；缺失时如实注明）。 */
  if (isMaterialBranchView(view)) {
    const origin = recallMaterialBranchOrigin(state.currentTreeId, view.branch.id);
    if (origin === null) {
      el.textContent = "Branched from a material selection (source details not cached in this browser)";
      return;
    }
    const selection = origin.selection;
    el.append(
      document.createTextNode(
        `From material “${String(origin.materialTitle)}” — version ${String(selection.versionId)}, anchored selection: `,
      ),
    );
    const sel = document.createElement("span");
    sel.className = "sel";
    sel.textContent = `“${selection.excerpt}”`;
    const statusSpan = document.createElement("span");
    statusSpan.className = "origin-status available";
    statusSpan.textContent = ` · block ${selection.blockId} · material source`;
    el.append(sel, statusSpan);
    return;
  }
  if (view.origin === null) {
    el.textContent = "no anchor recorded for this branch";
    return;
  }
  const status = view.originStatus ?? "unavailable";
  el.append(
    document.createTextNode(`Branched from ${branchLabel(view.origin.sourceBranchId)} — anchored selection: `),
  );
  const sel = document.createElement("span");
  sel.className = "sel";
  sel.textContent = `“${view.origin.selection.text}”`;
  const statusSpan = document.createElement("span");
  statusSpan.className = `origin-status ${status}`;
  statusSpan.textContent = ` · source ${status}`;
  el.append(sel, statusSpan);
}

/**
 * 支线 session 不可用降级提示（W2 §2.8）：常驻（非 dismissible——它解释
 * 的是被禁用的续聊入口这一事实状态），并作为降级视图的首个焦点。内含
 * 可直接执行的恢复按钮（issue #3 P1）。
 */
function renderPanelSessionNote(view) {
  const note = $("panel-session-note");
  const unavailable = view.sessionAvailability === "unavailable" || state.forcePanelSessionNote;
  if (!unavailable) {
    note.hidden = true;
    return;
  }
  note.replaceChildren();
  note.append(
    document.createTextNode(
      "Session missing on this branch — the branch stays fully readable (the database is the source of truth), " +
        "but continuing here will fail. Recovery: start a new exploration from saved content (button next to the " +
        "composer below), branch from a turn whose session is still available, or start a fresh Tree.",
    ),
  );
  note.append(sessionRecoveryControls("panel"));
  note.hidden = false;
}

/** 支线局部面板渲染（可见性由 showPanel/hidePanel 管理，此处只填内容）。 */
function renderPanel(stick) {
  if (state.panelBranchId === null) return;
  const view = branchView(state.panelBranchId);
  if (view === null) return;
  $("panel-title").textContent = branchLabel(view.branch.id);
  renderPanelAnchorContext(view);
  renderPanelSessionNote(view);
  renderTurnsInto($("panel-conversation"), view, view.branch.id, stick);
  syncReturnDraftForBranch(view.branch.id);
}

function renderAll(opts = {}) {
  /* ③ 选择期间不重绘：选区拖拽窗口（mousedown→mouseup）内整树重渲延后
     （pendingRerender），mouseup 后冲刷——正文层绝不从用户光标下被换走。
     未变化的异步刷新本就零 DOM 变更（reconcileTopLevel 快路径），这里的
     延后覆盖「拖拽期间恰有区间覆盖/结构变化」的窗口。 */
  if (state.selectionDragActive) {
    state.pendingRerender = true;
    return;
  }
  const stickBranch = opts.stick ?? null;
  /* 渲染期注册表重建（焦点还原 / 锚点定位取最新 DOM）。 */
  tabButtons.clear();
  branchHereButtons.clear();
  turnElements.clear();
  assistantTurns.clear();
  termExplainButtons.clear();
  const hasTree = state.treeState !== null;
  $("empty-state").hidden = hasTree;
  $("tree-view").hidden = !hasTree;
  /* 无树打开 → 无源可溯：来源抽屉入口（顶栏）直接隐藏，优于必然为空的
     诚实空态；有树后随 renderAll 恢复。 */
  $("source-drawer-toggle").hidden = !hasTree;
  renderTopbarPath();
  if (hasTree) {
    renderBranchTabs();
    renderSessionBanner();
    renderMainConversation(stickBranch !== null && stickBranch === trunkBranchId());
    renderPanel(stickBranch !== null && stickBranch === state.panelBranchId);
    updateComposerLocks();
  }
  renderTrees();
  /* D4-2 材料列表（侧栏 Materials 段）随 renderAll 渲染（三态幂等；阅读
     器的块容器不在此路径——与树态正交，SSE 刷新对已载块零触碰）。 */
  renderMaterialsSection();
  /* D4-4 搜索面（侧栏 Search 段）：静态表单只同步开关态（焦点/输入值不
     触碰），结果列表按当前读模型重建（注册表随之重建——焦点还原取最新
     DOM，同 materialListButtons 纪律）。 */
  renderSearchSection();
  /* D4-8 导航面（侧栏 Navigate 段）：只同步动作可用性——树查找/树视图/
     路径行/命中列表由 D4-8 函数独占管理（虚拟化窗口与焦点不随整树重渲
     重建）。 */
  renderNavSection();
}

/* ------------------------------ Return 草稿（持久化） ------------------------------ */

const RETURN_DRAFT_STORAGE_PREFIX = "treeai-return-draft:";

function returnDraftStorageKey(treeId, branchId) {
  return `${RETURN_DRAFT_STORAGE_PREFIX}${treeId}:${branchId}`;
}

/**
 * 持久草稿读取（localStorage；W1 §2.1：draft 仅客户端，不进 TreeAI DB）。
 * localStorage 不可用（隐私模式等）时静默降级为会话内草稿。
 */
function readPersistedDraft(treeId, branchId) {
  if (treeId === null) return null;
  try {
    const raw = window.localStorage.getItem(returnDraftStorageKey(treeId, branchId));
    if (raw === null) return null;
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return null;
    if (typeof parsed.idempotencyKey !== "string" || typeof parsed.text !== "string") return null;
    return {
      branchId,
      idempotencyKey: parsed.idempotencyKey,
      text: parsed.text,
      failed: parsed.failed === true,
    };
  } catch {
    return null;
  }
}

function persistReturnDraft() {
  const draft = state.returnDraft;
  if (draft === null) return;
  if (state.currentTreeId === null) return;
  try {
    if (draft.text.trim() === "") {
      window.localStorage.removeItem(returnDraftStorageKey(state.currentTreeId, draft.branchId));
      return;
    }
    window.localStorage.setItem(
      returnDraftStorageKey(state.currentTreeId, draft.branchId),
      JSON.stringify({ idempotencyKey: draft.idempotencyKey, text: draft.text, failed: draft.failed }),
    );
  } catch {
    /* 存储不可用：会话内草稿仍有效（刷新后不恢复，如实如此） */
  }
}

function removePersistedDraft(treeId, branchId) {
  if (treeId === null) return;
  try {
    window.localStorage.removeItem(returnDraftStorageKey(treeId, branchId));
  } catch {
    /* 同上 */
  }
}

/** 分支最近一条 assistant 回答（草稿预填惯例）。 */
function lastAnswerText(branchId) {
  const view = branchView(branchId);
  if (view === null) return null;
  const lastAnswer = [...view.turns].reverse().find((t) => t.role === "assistant");
  return lastAnswer === undefined ? null : lastAnswer.text;
}

/**
 * 面板草稿同步（每次面板渲染调用，幂等）。先对账（W1 §2.5 客户端侧）：
 * 草稿对应的 Return 已按（幂等键 + 来源分支 + 文本）落库（如提交成功但
 * 本地未清账、或另一标签页已提交）→ 草稿使命已完成，丢弃（会话内 +
 * localStorage），树面呈现已提交的 confirmed/delivered 卡，不把陈旧草稿
 * 恢复进输入框——编辑陈旧草稿会换新键，等于把已提交内容重复提交。其余：
 * 1) 该分支已有会话内草稿 → 原样维持；空草稿且分支已有回答 → 预填
 *    （W2 §2.4：空持久草稿不得覆盖“prefill from last answer”惯例）；
 * 2) 无会话草稿但 localStorage 有持久草稿（非空）→ 恢复文本与幂等键
 *    （跨视图切换 / 页面刷新）；
 * 3) 都没有 → 以预填（或空）开一份新草稿。
 */
function syncReturnDraftForBranch(branchId) {
  const input = $("return-input");
  if (state.returnDraft !== null && state.returnDraft.branchId === branchId) {
    if (
      findReconciledReturn(
        state.treeState,
        state.returnDraft.idempotencyKey,
        branchId,
        state.returnDraft.text,
      ) !== null
    ) {
      removePersistedDraft(state.currentTreeId, branchId);
      state.returnDraft = null;
    } else {
      if (state.returnDraft.text.trim() === "" && input.value.trim() === "") {
        const prefill = lastAnswerText(branchId);
        if (prefill !== null && prefill.trim() !== "") {
          state.returnDraft.text = prefill;
          input.value = prefill;
        }
      }
      return;
    }
  }
  const persisted = readPersistedDraft(state.currentTreeId, branchId);
  if (persisted !== null && persisted.text.trim() !== "") {
    if (
      findReconciledReturn(state.treeState, persisted.idempotencyKey, branchId, persisted.text) ===
      null
    ) {
      state.returnDraft = persisted;
      input.value = persisted.text;
      return;
    }
    /* 对账命中：持久草稿已落库 → 丢弃（localStorage 一并清除），走预填。 */
    removePersistedDraft(state.currentTreeId, branchId);
  }
  const prefill = lastAnswerText(branchId) ?? "";
  state.returnDraft = {
    branchId,
    idempotencyKey: crypto.randomUUID(),
    text: prefill,
    failed: false,
  };
  input.value = prefill;
}

/** 提交前兜底：草稿不存在（面板未经同步等边角）时以当前输入开一份。 */
function ensureReturnDraft(branchId) {
  if (state.returnDraft === null || state.returnDraft.branchId !== branchId) {
    state.returnDraft = {
      branchId,
      idempotencyKey: crypto.randomUUID(),
      text: $("return-input").value,
      failed: false,
    };
  }
  return state.returnDraft;
}

/** 提交成功 / 响应丢失对账命中：清空草稿（会话内 + localStorage）。 */
function clearReturnDraft() {
  const draft = state.returnDraft;
  if (draft !== null) removePersistedDraft(state.currentTreeId, draft.branchId);
  state.returnDraft = null;
  $("return-input").value = "";
}

/* 失败后编辑 = 新的逻辑提交：旧键可能已被服务端绑定到旧文本（同键异容
   会被 409 拒绝），故文本一变即换新键；未失败的编辑仍属同一草稿。
   每次编辑落 localStorage（持久草稿）。 */
$("return-input").addEventListener("input", () => {
  const draft = state.returnDraft;
  if (draft === null) return;
  const value = $("return-input").value;
  if (draft.failed && value !== draft.text) {
    draft.idempotencyKey = crypto.randomUUID();
    draft.failed = false;
  }
  draft.text = value;
  persistReturnDraft();
});

/* ------------------------------ 诊断面 ------------------------------ */

function renderDiagnostics() {
  const diag = state.diagnostics;
  const bar = $("diagnostics-bar");
  if (diag === null || state.treeState === null) {
    bar.hidden = true;
    renderFailurePanel(null);
    return;
  }
  bar.hidden = false;

  const status = $("run-status");
  status.textContent = diag.runtimeState;
  status.className = `run-status ${diag.runtimeState}`;

  const parts = [];
  if (diag.activeRun !== null) {
    parts.push(`active run on ${branchLabel(diag.activeRun.branchId)}`);
  }
  const last = diag.runs.length > 0 ? diag.runs[diag.runs.length - 1] : null;
  const detail = $("run-detail");
  detail.replaceChildren();
  if (parts.length > 0) {
    detail.append(document.createTextNode(`${parts.join(" · ")} · `));
  }
  if (last === null) {
    detail.append(document.createTextNode("no runs yet"));
  } else {
    /* 终态呈现可区分：aborted 单独着色（中止是显式用户动作，非失败）。 */
    const stateSpan = document.createElement("span");
    stateSpan.className = `last-run-state ${last.state}`;
    stateSpan.textContent = `last run: ${last.state}`;
    detail.append(stateSpan);
  }

  /* P1 失败面板（持久、不自动消失）：最新失败 run 的 code+消息+定位，
     可手动关闭；dismiss 后该 run 不再复显（新失败会再次出现）。 */
  const lastFailed = [...diag.runs].reverse().find((run) => run.failure !== null) ?? null;
  renderFailurePanel(lastFailed);

  const abortButton = $("abort-run");
  const isActive = diag.activeRun !== null;
  abortButton.hidden = !isActive;
  abortButton.textContent = diag.runtimeState === "aborting" ? "Aborting…" : "Abort run";
  abortButton.disabled = diag.runtimeState === "aborting";

  /* 如实呈现：默认装配未观测任何策略决策；观测到的决定（含拒绝）按
     脱敏 provenance 呈现（工具名/outcome/规则来源——参数/路径/命令
     绝不出现在诊断面）。 */
  const policy = diag.policyDecisions;
  if (policy.observed === false) {
    $("policy-note").textContent = `policy: no decisions observed — ${policy.reason}`;
  } else {
    const latest = policy.decisions[policy.decisions.length - 1];
    const latestNote =
      latest === undefined
        ? ""
        : ` — latest: ${latest.tool ?? "unknown tool"} ${latest.outcome} (${latest.ruleId ?? "no rule"})`;
    $("policy-note").textContent = `policy: ${String(policy.decisions.length)} decision(s) observed${latestNote}`;
  }
}

/** 失败面板渲染（P1）。run 为 null 或已被 dismiss → 隐藏。 */
function renderFailurePanel(run) {
  const panel = $("failure-panel");
  if (run === null || run.failure === null || state.dismissedFailureRunIds.has(run.runId)) {
    panel.hidden = true;
    return;
  }
  panel.replaceChildren();
  const label = document.createElement("span");
  label.className = "failure-panel-label";
  label.textContent = `Run ${run.runId.slice(0, 12)}… failed — ${run.failure.code}: ${run.failure.message}`;
  const dismiss = document.createElement("button");
  dismiss.className = "failure-panel-dismiss";
  dismiss.textContent = "Dismiss";
  dismiss.addEventListener("click", () => {
    state.dismissedFailureRunIds.add(run.runId);
    renderFailurePanel(run);
  });
  panel.append(label, dismiss);
  panel.hidden = false;
}

async function refreshDiagnostics() {
  if (state.currentTreeId === null) {
    state.diagnostics = null;
    renderDiagnostics();
    return;
  }
  const diagnostics = await api(`/api/trees/${encodeURIComponent(state.currentTreeId)}/diagnostics`);
  if (state.currentTreeId !== diagnostics.treeId) return; /* stale after a tree switch */
  state.diagnostics = diagnostics;
  renderDiagnostics();
}

function startDiagnosticsPolling() {
  if (diagnosticsTimer !== null) return;
  diagnosticsTimer = window.setInterval(() => {
    void refreshDiagnostics().catch(() => {
      /* 轮询失败不打断在途 prompt；收尾刷新会呈现最终状态 */
    });
  }, DIAGNOSTICS_POLL_MS);
}

function stopDiagnosticsPolling() {
  if (diagnosticsTimer === null) return;
  window.clearInterval(diagnosticsTimer);
  diagnosticsTimer = null;
}

/* ------------------------------ SSE 事件流（P1） ------------------------------ */

function disconnectEvents() {
  if (eventSource !== null) {
    eventSource.close();
    eventSource = null;
  }
  sseHealthy = false;
}

/**
 * 订阅当前树的事件流。连接即收到 snapshot（诊断面）；随后按事件类型
 * 推送。SSE 出错时降级为轮询（EventSource 会自动重连，重连成功即恢复
 * 事件流并停止轮询）。
 */
function connectEvents(treeId) {
  disconnectEvents();
  if (typeof EventSource === "undefined") return; /* 降级：轮询兜底 */
  const source = new EventSource(`/api/trees/${encodeURIComponent(treeId)}/events`);
  eventSource = source;
  source.onopen = () => {
    sseHealthy = true;
    stopDiagnosticsPolling();
  };
  source.onerror = () => {
    /* 断开/重连中：降级轮询；重连后 onopen 恢复。 */
    sseHealthy = false;
    if (state.currentTreeId === treeId) startDiagnosticsPolling();
  };
  const isCurrent = () => state.currentTreeId === treeId;
  source.addEventListener("snapshot", (event) => {
    if (!isCurrent()) return;
    const diag = JSON.parse(event.data);
    if (diag.treeId !== state.currentTreeId) return;
    state.diagnostics = diag;
    renderDiagnostics();
  });
  source.addEventListener("run-started", (event) => {
    if (!isCurrent()) return;
    const info = JSON.parse(event.data);
    state.activeRunInfo = info;
    if (state.diagnostics !== null) {
      state.diagnostics.runtimeState = "streaming";
      state.diagnostics.activeRun = {
        runId: info.runId,
        branchId: info.branchId,
        episodeId: info.episodeId,
      };
    }
    /* 流式占位：在途 run 位于主线或打开的面板分支时呈现（接收视图贴底）。 */
    if (info.branchId === trunkBranchId() || info.branchId === state.panelBranchId) {
      state.streaming = { runId: info.runId, branchId: info.branchId, text: "" };
      renderAll({ stick: info.branchId });
    }
    renderDiagnostics();
  });
  source.addEventListener("message-delta", (event) => {
    if (!isCurrent()) return;
    const delta = JSON.parse(event.data);
    const active = state.activeRunInfo;
    if (active === null || delta.runId !== active.runId) return;
    if (active.branchId !== trunkBranchId() && active.branchId !== state.panelBranchId) {
      return; /* 在途 run 不在可见视图（如面板已收起）：不呈现占位 */
    }
    if (state.streaming === null || state.streaming.runId !== delta.runId) {
      state.streaming = { runId: delta.runId, branchId: active.branchId, text: "" };
    }
    state.streaming.text += delta.delta;
    updateStreamingPlaceholder();
  });
  source.addEventListener("abort-requested", (event) => {
    if (!isCurrent()) return;
    const payload = JSON.parse(event.data);
    if (state.diagnostics !== null && state.activeRunInfo !== null && payload.runId === state.activeRunInfo.runId) {
      state.diagnostics.runtimeState = "aborting";
    }
    renderDiagnostics();
  });
  source.addEventListener("run-terminal", (event) => {
    if (!isCurrent()) return;
    JSON.parse(event.data);
    const terminalBranchId = state.activeRunInfo === null ? null : state.activeRunInfo.branchId;
    state.activeRunInfo = null;
    state.streaming = null;
    /* /state 是权威读模型：终态后整树刷新（prompt 响应也会刷新，幂等）。
       接收新 turn 的视图贴底；另一视图恢复其阅读位置。P1 同族规则（issue
       #7 增量验收）：刷新期间切树 → 迟到的旧树 state 不写共享树态。
       ①阅读模式：回答完成后同步刷新术语读模型（自动建议集 pending→终态
       的入口——写入点守卫同 refreshTerminology；仍在途则由有界跟随轮询
       收口）。 */
    void (async () => {
      const treeId = state.currentTreeId;
      if (treeId === null) return;
      try {
        const treeState = await api(`/api/trees/${encodeURIComponent(treeId)}/state`);
        if (state.currentTreeId !== treeId) return; /* 迟到丢弃 */
        state.treeState = treeState;
        renderAll({ stick: terminalBranchId });
      } catch {
        /* 刷新失败不打断；sendPrompt 的收尾刷新会重试 */
      }
      await refreshTerminology();
      if (state.currentTreeId === treeId) renderAll();
      await refreshDiagnostics().catch(() => {});
    })();
  });
  source.addEventListener("tool-activity", (event) => {
    if (!isCurrent()) return;
    const activity = JSON.parse(event.data);
    state.toolActivity = [...state.toolActivity.slice(-19), activity];
    if (state.drawerOpen) renderDrawer();
  });
}

/** 流式占位回显：增量到达时只更新占位文本节点（不整树重渲）；用户本就
    贴底时跟随贴底，已向上阅读则完全不动滚动（issue #3 P1）。 */
function updateStreamingPlaceholder() {
  const streaming = state.streaming;
  if (streaming === null) return;
  const visible =
    streaming.branchId === trunkBranchId() || streaming.branchId === state.panelBranchId;
  if (!visible) return;
  let node = document.getElementById("streaming-turn");
  const containerId = conversationContainerId(streaming.branchId);
  if (node === null || node.parentElement === null || node.parentElement.id !== containerId) {
    renderAll({ stick: streaming.branchId });
    return;
  }
  const container = node.parentElement;
  /* 先取增量写入前的贴底实况（写入会增高 scrollHeight，事后再判会把恰在
     底部的用户误判为已上移）。 */
  const follow = isAtBottom(container);
  const textNode = node.firstChild;
  if (textNode !== null && typeof textNode.data === "string") {
    textNode.data = streaming.text;
  }
  if (follow) {
    container.scrollTo({ top: container.scrollHeight, behavior: scrollBehavior() });
  }
}

/* ------------------------------ 面板 / 抽屉进出场（M1/M2） ------------------------------ */

/**
 * M1/M2：面板进入（侧滑 + 淡入 150–200ms ease-out）与对称退出。退出播完
 * 才置 hidden；reduced-motion 下 CSS 全局降级为即时（无位移）。转场期间
 * 主线为覆盖层下的原布局——阅读位置不动。
 */
function showPanel() {
  const panel = $("branch-panel");
  if (panelAnimTimer !== null) {
    window.clearTimeout(panelAnimTimer);
    panelAnimTimer = null;
  }
  panel.classList.remove("exit");
  if (panel.hidden) {
    panel.hidden = false;
    void panel.offsetHeight; /* reflow：确保 enter 动画从初始态播放 */
    panel.classList.add("enter");
    panelAnimTimer = window.setTimeout(() => {
      panel.classList.remove("enter");
      panelAnimTimer = null;
    }, PANEL_ENTER_MS);
  }
}

function hidePanel(opts = {}) {
  const panel = $("branch-panel");
  if (panelAnimTimer !== null) {
    window.clearTimeout(panelAnimTimer);
    panelAnimTimer = null;
  }
  panel.classList.remove("enter");
  if (opts.instant || panel.hidden) {
    panel.hidden = true;
    panel.classList.remove("exit");
    return;
  }
  panel.classList.add("exit");
  panelAnimTimer = window.setTimeout(() => {
    panel.hidden = true;
    panel.classList.remove("exit");
    panelAnimTimer = null;
  }, PANEL_EXIT_MS);
}

function showDrawer() {
  const drawer = $("source-drawer");
  if (drawerAnimTimer !== null) {
    window.clearTimeout(drawerAnimTimer);
    drawerAnimTimer = null;
  }
  drawer.classList.remove("exit");
  if (drawer.hidden) {
    drawer.hidden = false;
    void drawer.offsetHeight;
    drawer.classList.add("enter");
    drawerAnimTimer = window.setTimeout(() => {
      drawer.classList.remove("enter");
      drawerAnimTimer = null;
    }, PANEL_ENTER_MS);
  }
}

function hideDrawer(opts = {}) {
  const drawer = $("source-drawer");
  if (drawerAnimTimer !== null) {
    window.clearTimeout(drawerAnimTimer);
    drawerAnimTimer = null;
  }
  drawer.classList.remove("enter");
  if (opts.instant || drawer.hidden) {
    drawer.hidden = true;
    drawer.classList.remove("exit");
    return;
  }
  drawer.classList.add("exit");
  drawerAnimTimer = window.setTimeout(() => {
    drawer.hidden = true;
    drawer.classList.remove("exit");
    drawerAnimTimer = null;
  }, PANEL_EXIT_MS);
}

/* ------------------------------ 焦点管理（W2 键盘焦点行） ------------------------------ */

/** 按语义引用解析焦点还原目标（注册表随 renderAll 重建，取最新 DOM）。 */
function resolveFocusRef(ref) {
  if (ref === null || ref === undefined) return null;
  if (ref.kind === "element") return ref.element;
  if (ref.kind === "main-input") return $("prompt-input");
  if (ref.kind === "tab") return tabButtons.get(ref.branchId) ?? null;
  if (ref.kind === "branch-button") return branchHereButtons.get(ref.turnId) ?? null;
  if (ref.kind === "return-card") return turnElements.get(ref.turnId) ?? null;
  if (ref.kind === "material-button") return materialListButtons.get(ref.materialId) ?? null;
  if (ref.kind === "search-hit") return searchHitButtons.get(ref.hitKey) ?? null;
  return null;
}

/** 面板打开 → 焦点移入面板：常规 = 支线输入框（面板主操作面）；
    session 不可用降级 = 恢复按钮为首个焦点（W2 §2.8 键盘焦点行；按钮
    禁用——无可用候选——时退回降级提示本身）。
    busy 的瞬态禁用期间（动作未收尾）延迟到解锁后再移入。 */
function focusIntoPanel() {
  const view = branchView(state.panelBranchId);
  if (view !== null && (view.sessionAvailability === "unavailable" || state.forcePanelSessionNote)) {
    const recovery = $("panel-session-note").querySelector("button");
    if (recovery !== null && !recovery.disabled) recovery.focus();
    else $("panel-session-note").focus();
    return;
  }
  const input = $("panel-prompt-input");
  if (!input.disabled) {
    input.focus();
    return;
  }
  if (state.busy) {
    window.setTimeout(() => {
      if (state.panelBranchId === null) return;
      const current = $("panel-prompt-input");
      if (!current.disabled) current.focus();
      else $("panel-close").focus();
    }, 0);
    return;
  }
  $("panel-close").focus(); /* 持久禁用（session 不可用）时的兜底 */
}

/** composer 焦点还原（真实浏览器语义；focusIntoPanel 同款纪律的提取）：
    busy 锁下的 composer 是 disabled——真实浏览器对 disabled 控件 focus()
    静默无操作（DOM 桩可聚焦 disabled 控件，此前测不出；术语真实浏览器波
    发现），延后一拍到锁释放后重试（guard 的 finally 是微任务，先于 timer
    执行）；仍禁用则如实放弃（不伪装聚焦）。 */
function focusComposerWhenSelectable(el) {
  if (el === null || el === undefined) return;
  if (el.disabled !== true) {
    el.focus();
    return;
  }
  window.setTimeout(() => {
    if (el.disabled !== true) el.focus();
  }, 0);
}

/** 揭示到位：滚动到锚点 turn 并把焦点移过去（W2 §2.6）。 */
function revealAnchorTurn(turnId) {
  const el = turnElements.get(turnId);
  if (el === undefined) return;
  if (typeof el.scrollIntoView === "function") {
    el.scrollIntoView({ block: "center", behavior: scrollBehavior() });
  }
  el.focus();
}

/* ------------------------------ 树列表加载失败重试（W2 §2.1） ------------------------------ */

/** 列表加载失败态：侧栏常驻重试面（错误事实 + 可用重试）——与 8 秒自动
    隐藏横幅不同，失败不消失，重试入口一直可用（“错误条 + 重试，不空白”）。 */
function showListLoadError(message) {
  $("list-load-message").textContent = `Failed to load the tree list — ${message}`;
  const retryButton = $("list-retry");
  retryButton.disabled = false;
  retryButton.textContent = "Retry";
  $("list-load-error").hidden = false;
}

/** 重试在途态：按钮禁用 + 明示“重试中”（诚实待态；禁用兼作防重入）。 */
function showListLoadPending() {
  $("list-load-message").textContent = "Retrying the tree list…";
  const retryButton = $("list-retry");
  retryButton.disabled = true;
  retryButton.textContent = "Retrying…";
}

/**
 * 列表重试（W2 §2.1）：重新走 GET /api/trees，**不整页刷新**。在途呈
 * 禁用 + “Retrying…”；持久失败由 refreshTrees 把重试面落回失败态（错误 +
 * 重试保持可用，不再额外弹横幅——重试面就是该错误的呈现面）。启动列表
 * 加载即失败（无树打开）→ 恢复后补齐启动语义：自动打开首棵树 / 空库呈
 * 空态；已有树打开（如开树后的列表刷新失败）只刷新列表，不打断当前阅读。
 */
async function retryTreesLoad() {
  const retryButton = $("list-retry");
  if (retryButton.disabled) return; /* 在途防重入 */
  showListLoadPending();
  try {
    await refreshTrees();
  } catch {
    return; /* 列表仍失败：重试面已呈失败态（常驻） */
  }
  if (state.currentTreeId === null) {
    if (state.trees.length > 0) {
      try {
        await openTree(state.trees[0].id);
      } catch (err) {
        showError(String(err && err.message ? err.message : err));
      }
    } else {
      renderAll();
    }
  }
}

async function refreshTrees() {
  let payload;
  try {
    payload = await api("/api/trees");
  } catch (err) {
    /* 列表加载失败：侧栏常驻重试面落位；错误照常上抛（调用方呈现路径
       不变——guard / 启动横幅）。 */
    showListLoadError(String(err && err.message ? err.message : err));
    throw err;
  }
  state.trees = payload.trees;
  $("list-load-error").hidden = true;
  renderTrees();
}

/* ------------------------------ 动作 ------------------------------ */

function resetTransientView() {
  state.sourceHighlight = null;
  state.activeRunInfo = null;
  state.streaming = null;
  state.forceSessionBanner = false;
  state.forcePanelSessionNote = false;
  state.termExplain = null;
  state.termSuggest = null;
  state.terminology = null;
  state.armedSelection = null;
  state.selectionDragActive = false;
  state.pendingRerender = false;
  /* D4-2：材料面随树切换复位（阅读位置已由调用方在切树前落库）。退出中
     的块容器一并清空——绝不给下一次打开留下上一棵树的块元素。导入状态
     （含在途解析轮询）一并复位——导入事实属于发起它的树。 */
  state.materials = null;
  state.materialSelection = null;
  resetMaterialImport();
  /* D4-3：建枝流程随树切换复位（挂起的 intentKey 仍在 localStorage——重进
     同一选区时按同键幂等续走，服务端对账兜底）。 */
  state.materialBranching = null;
  if (state.materialReader !== null) {
    state.materialReader = null;
    materialReaderEpoch += 1;
    materialPendingUpdate = false;
    materialBarPendingUpdate = false;
    if (materialPositionTimer !== null) {
      window.clearTimeout(materialPositionTimer);
      materialPositionTimer = null;
    }
    hideMaterialReader({ instant: true });
    const blocksEl = document.getElementById("mat-blocks");
    if (blocksEl !== null) blocksEl.replaceChildren();
  }
  materialReaderFocusReturn = null;
  /* D4-4：「当前树」范围搜索的旧结果不再描述当前工作台（树已切换）——
     诚实清空并作废在途的旧树搜索响应（P1 同族迟到丢弃）；全部树范围的
     结果是库级事实，保持有效。筛选选择（scope/kinds）与输入框不重置
     （用户的显式选择，跨树保持）。 */
  if (state.search.resultScope === "tree") {
    searchEpoch += 1;
    state.search.phase = "idle";
    state.search.error = null;
    state.search.hits = [];
    state.search.note = null;
    state.search.resultQuery = null;
    state.search.resultScope = null;
    state.search.resultTreeId = null;
  }
}

/** 开树世代号（P1 同族，issue #7 增量验收）：启动恢复 / 列表重试的
    openTree 不经 busy 锁——与用户点击的开树并发时，迟到的旧树 state 绝不
    覆盖更新的树切换（末次开树/建树胜出）。 */
let treeOpenEpoch = 0;

async function openTree(treeId) {
  /* D4-2：切树前先把当前阅读位置落库（树×材料行；PUT 面向旧树 id 发出，
     迟到响应不影响新树状态——api 调用即发起，不等待）。 */
  if (state.materialReader !== null) saveMaterialReadingPositionNow();
  const epoch = ++treeOpenEpoch;
  const treeState = await api(`/api/trees/${encodeURIComponent(treeId)}/state`);
  if (epoch !== treeOpenEpoch) return; /* 已被更新的开树/建树取代：迟到丢弃 */
  state.currentTreeId = treeId;
  state.treeState = treeState;
  /* 树切换：面板/抽屉收起、草稿回到会话外（持久草稿仍在 localStorage，
     面板重开时恢复）。阅读位置按 tree:branch 记忆，切回可恢复。 */
  state.panelBranchId = null;
  state.returnDraft = null;
  resetTransientView();
  hidePanel({ instant: true });
  if (state.drawerOpen) {
    state.drawerOpen = false;
    state.drawerFocusRunId = null;
    state.drawerFocusReturn = null;
    hideDrawer({ instant: true });
  }
  await refreshTrees();
  await refreshDiagnostics();
  connectEvents(treeId);
  renderAll();
  /* ③ 批注区间覆盖的数据面：开树即拉术语读模型（失败如实 {ok:false}——
     无批注覆盖，绝不伪造）。 */
  refreshTerminologyForTree(treeId);
  /* D4-2：开树即拉材料列表（三态；失败态侧栏常驻重试）。 */
  void refreshMaterials();
}

async function createTree() {
  /* D4-2：同 openTree——切换前落库当前阅读位置。 */
  if (state.materialReader !== null) saveMaterialReadingPositionNow();
  treeOpenEpoch += 1; /* 建树即新的当前树：作废在途的旧 openTree（P1 同族） */
  const payload = await api("/api/trees", "POST", {});
  state.currentTreeId = payload.tree.id;
  state.treeState = payload.state;
  state.panelBranchId = null;
  state.returnDraft = null;
  resetTransientView();
  hidePanel({ instant: true });
  if (state.drawerOpen) {
    state.drawerOpen = false;
    state.drawerFocusRunId = null;
    state.drawerFocusReturn = null;
    hideDrawer({ instant: true });
  }
  await refreshTrees();
  await refreshDiagnostics();
  connectEvents(payload.tree.id);
  renderAll();
  refreshTerminologyForTree(payload.tree.id);
  /* D4-2：新树即拉材料列表（空树如实空态）。 */
  void refreshMaterials();
}

/**
 * 打开支线局部面板（W2 §2.3）。面板分支已在面板中（重复点击）只重对齐游标。
 * opts.alignCursor = false 用于建支线（首次续聊由 prompt 显式导航——与既有
 * 行为一致）与锚点揭示（reveal 内服务端已对准 source 分支）。
 */
async function openBranchPanel(branchId, opts = {}) {
  const st = state.treeState;
  if (st === null || branchId === null || branchId === st.trunkBranchId) return;
  const wasOpen = state.panelBranchId !== null;
  const switching = state.panelBranchId !== branchId;
  let switchFailed = false;
  if (opts.alignCursor !== false) {
    /* 切换语义保留：打开支线面板 = 服务端游标对齐该分支（POST /switch）。
       对齐失败不阻断打开（恢复数据缺 session 的分支实测 502：面板内容是
       产品事实照常可读——降级为既有会话不可用注记 + 换轨入口，此前整链
       抛错只留一条错误横幅，合法的搜索跳转被挡，issue #8 浏览器证据波）。 */
    try {
      const payload = await api(`/api/trees/${encodeURIComponent(state.currentTreeId)}/switch`, "POST", {
        branchId,
      });
      state.treeState = payload.state;
    } catch {
      switchFailed = true;
    }
  }
  if (switching) {
    state.panelBranchId = branchId;
    state.forcePanelSessionNote = false;
  }
  if (switchFailed) state.forcePanelSessionNote = true;
  if (opts.trigger !== undefined) state.panelFocusReturn = opts.trigger;
  renderAll();
  if (!wasOpen) showPanel();
  /* 键盘焦点：面板打开 / 分支切换 → 焦点移入面板（W2 §2.3）。 */
  if (opts.focus === "anchor") {
    /* 揭示打开：焦点交给锚点 turn（由调用方随后 revealAnchorTurn）。 */
  } else {
    focusIntoPanel();
  }
}

/**
 * 收起支线面板、回主线（W2 §1 固定回程）。面板内容与阅读位置按分支记忆，
 * 重开可恢复；回主线同时把服务端游标对齐回 Trunk（POST /switch）。
 * 收起即开始退出动效（M2），树面渲染在游标对齐返回后统一刷新一次
 * （避免双次 renderAll 掐断 Return 卡插入/徽标动效）。
 * opts.skipSwitch（signed v3 §3.5）：跳过 POST /switch——服务端提交
 * Return 时已尝试回程导航且失败（响应 navigation.failed），立即重放
 * /switch 只会复现同一失败；重新导航由 Trunk tab / 下次主干讨论承担。
 */
async function closePanel(opts = {}) {
  if (state.panelBranchId === null) return;
  state.panelBranchId = null;
  state.forcePanelSessionNote = false;
  hidePanel();
  /* 回主线：对齐游标到 Trunk（失败不阻断收起——错误交由 guard 呈现，
     树照常可读；游标以服务端状态为准）。 */
  const trunk = trunkBranchId();
  let switchError = null;
  if (!opts.skipSwitch && trunk !== null && state.currentTreeId !== null) {
    try {
      const payload = await api(`/api/trees/${encodeURIComponent(state.currentTreeId)}/switch`, "POST", {
        branchId: trunk,
      });
      state.treeState = payload.state;
    } catch (err) {
      switchError = err;
    }
  }
  renderAll();
  /* 焦点还原（W2 §2.3）：显式指定（如 Trunk tab / 主线输入框）优先；
     默认回触发元素；无引用 → 主线输入框（常驻主焦点）。 */
  if (opts.focus === "main-input") {
    focusComposerWhenSelectable($("prompt-input"));
  } else if (opts.focus !== "none") {
    restoreFocusRef(opts.focus === undefined ? state.panelFocusReturn : opts.focus);
  }
  state.panelFocusReturn = null;
  if (switchError !== null) throw switchError;
}

/** Trunk tab：收面板回主线；已在主线时重复点击仍对齐游标（旧行为）。 */
async function returnToTrunk(trunkId) {
  if (state.panelBranchId !== null) {
    await closePanel({ focus: { kind: "tab", branchId: trunkId } });
    return;
  }
  const payload = await api(`/api/trees/${encodeURIComponent(state.currentTreeId)}/switch`, "POST", {
    branchId: trunkId,
  });
  state.treeState = payload.state;
  renderAll();
}

function restoreFocusRef(ref) {
  const target = resolveFocusRef(ref);
  (target ?? $("prompt-input")).focus();
}

/**
 * 锚点揭示（W2 §2.6 + signed v3 §1.2：来源定位与 Pi 游标对齐分离）：
 * status available → 定位 + 一次性脉冲高亮 + 滚动 + 焦点移至锚点 turn——
 * **无论 navigation 成败**（产品定位来自数据库原文，session 缺失/损坏不再
 * 阻断准确高亮）；navigation failed → 如实以面板横幅提示「定位成功但
 * 活动会话未能对准」（后续 prompt 自导航，不受影响）。锚点在主线 → 主
 * 面板内揭示（面板保持打开）；锚点在其他支线 → 打开该支线面板呈现。
 * changed/unavailable → 降级不伪造：摘录仍在面板头部可读，如实报告状态。
 * 降级路径同样先落地服务端返回的 state——徽标 / 降级提示必须与服务端
 * 判定一致（W1 §3.4 如实呈现），绝不能出现「错误说降级、徽标仍
 * available」的矛盾 UI。
 */
async function revealOrigin(branchId) {
  if (branchId === null || state.currentTreeId === null) return;
  const payload = await api(
    `/api/trees/${encodeURIComponent(state.currentTreeId)}/branches/${encodeURIComponent(branchId)}/source`,
    "POST",
  );
  state.treeState = payload.state;
  state.sourceHighlight = null;
  if (payload.source.status !== "available") {
    renderAll();
    showError(`Source reference ${payload.source.status}; saved excerpt remains available.`, "panel");
    /* 降级焦点（W2 §2.6 键盘焦点行）：焦点移到说明区。取面板头部锚点
       上下文（摘录 + 状态徽标，常驻可读、tabindex=-1 程序聚焦）而非错误
       横幅——横幅 8 秒自动隐藏会连焦点一起丢，锚点上下文才是持久的说明
       区（实现取舍已记入 W2 §2.6 行内，owner 可改判）。 */
    $("panel-anchor-context").focus();
    return;
  }
  state.sourceHighlight = {
    branchId: payload.source.sourceBranchId,
    turnId: payload.source.anchorTurnId,
    start: payload.source.selection.start,
    end: payload.source.selection.end,
  };
  const navigation = payload.source.navigation ?? null;
  const navigationFailed =
    navigation !== null && navigation.status === "failed"
      ? `${navigation.code}: ${navigation.message}`
      : null;
  if (payload.source.sourceBranchId === trunkBranchId()) {
    renderAll();
    revealAnchorTurn(payload.source.anchorTurnId);
    if (navigationFailed !== null) {
      showError(
        `Source located from the saved database text (highlighted above); aligning the live session failed ` +
          `(${navigationFailed}). Prompts navigate on their own, so continuing is unaffected.`,
        "panel",
      );
    }
    return;
  }
  await openBranchPanel(payload.source.sourceBranchId, {
    alignCursor: false,
    focus: "anchor",
    trigger: { kind: "element", element: $("panel-view-source") },
  });
  revealAnchorTurn(payload.source.anchorTurnId);
  if (navigationFailed !== null) {
    showError(
      `Source located from the saved database text (highlighted); aligning the live session failed ` +
        `(${navigationFailed}). Prompts navigate on their own, so continuing is unaffected.`,
      "panel",
    );
  }
}

/**
 * 发送 prompt（主线 or 面板）：branchId 显式携带（prompt 端点自导航，
 * 不依赖游标）；在途观测走 SSE（不可用时降级轮询）；接收新 turn 的视图
 * 贴底，另一视图恢复原位；发送后焦点保持在发送视图的输入框（W2 §2.2）。
 *
 * 终局渲染是硬保证（成功 / 中止 / 失败共用收尾）：流式占位清除、
 * session-corrupt 后的恢复横幅/降级提示、最终树态与诊断面都在错误上抛
 * 之前落位——即使 SSE 全程无事件（无 run-terminal 推送收尾），失败后
 * 页面也绝不停留在「占位悬空 / 横幅缺失」的中间态。
 */
async function sendPrompt(viewKind) {
  const isPanel = viewKind === "panel";
  const branchId = isPanel ? state.panelBranchId : trunkBranchId();
  const input = $(isPanel ? "panel-prompt-input" : "prompt-input");
  const text = input.value;
  if (branchId === null || text.trim() === "") return;
  if (!sseHealthy) startDiagnosticsPolling();
  let promptError = null;
  try {
    const payload = await api(`/api/trees/${encodeURIComponent(state.currentTreeId)}/prompt`, "POST", {
      branchId,
      text,
    });
    state.treeState = payload.state;
    input.value = "";
    if (isPanel) state.forcePanelSessionNote = false;
    else state.forceSessionBanner = false;
    /* ①阅读模式：回答完成后刷新术语读模型（SSE run-terminal 同路径幂等；
       写入点守卫在 refreshTerminology 内——切树迟到响应整包丢弃）。 */
    await refreshTerminology();
  } catch (err) {
    if (err !== null && typeof err === "object" && err.code === "user-abort") {
      /* 用户主动中止：run 已收敛为 aborted（无新 turn）。保留输入文本供改写重发，
         刷新树状态与诊断面后如常呈现。 */
      await refreshTreeStateQuietly();
    } else {
      promptError = err;
      if (err !== null && typeof err === "object" && err.code === "session-corrupt") {
        /* A4：缺失/损坏 session 的可执行恢复提示（不只有瞬时错误横幅）。 */
        if (isPanel) state.forcePanelSessionNote = true;
        else state.forceSessionBanner = true;
        await refreshTreeStateQuietly();
      }
    }
  } finally {
    stopDiagnosticsPolling();
    state.activeRunInfo = null;
    state.streaming = null;
  }
  /* 终局渲染（所有收尾路径共用）：清掉流式占位、呈现恢复横幅与最终树态。
     失败路径的诊断面刷新尽力而为——刷新失败不得掩盖原始 prompt 错误。 */
  renderAll({ stick: branchId });
  if (promptError === null) {
    await refreshDiagnostics();
    focusComposerWhenSelectable(input);
  } else {
    await refreshDiagnostics().catch(() => {});
    throw promptError;
  }
}

/** 失败收尾的尽力状态刷新：刷新失败不掩盖/替换原始错误（保留既有树态照常渲染）。 */
async function refreshTreeStateQuietly() {
  if (state.currentTreeId === null) return;
  try {
    state.treeState = await api(`/api/trees/${encodeURIComponent(state.currentTreeId)}/state`);
  } catch {
    /* 保留当前树态；原始错误照常上抛由 guard 呈现 */
  }
}

/**
 * 「以保存内容开始新的探索」（signed v3 §4.4）：session 不可用分支的显式
 * 换轨入口（主线/面板 composer 的「⑃ Start new exploration」）。首问文本
 * 取自当前输入框；点击即用户确认流（confirm 二次确认：新会话、旧上下文
 * 不恢复、旧历史保持可读——不冒充旧会话恢复）。成功 → 树态落地、输入清
 * 空、session 恢复可用（横幅/降级提示随之下线）、焦点回输入框；前置条件
 * 不满足（409，session 仍可用/无历史 session）由 guard 呈现原错误。
 */
async function startNewExploration(viewKind) {
  const isPanel = viewKind === "panel";
  const branchId = isPanel ? state.panelBranchId : trunkBranchId();
  const input = $(isPanel ? "panel-prompt-input" : "prompt-input");
  if (branchId === null) return;
  const text = input.value;
  if (text.trim() === "") {
    showError(
      "Type the first question for the new exploration first, then start it.",
      isPanel ? "panel" : "main",
    );
    input.focus();
    return;
  }
  const confirmed = window.confirm(
    "Start a new exploration on this branch from saved content?\n\n" +
      "A new session will be created: the anchored excerpt and the saved history are re-included as the " +
      "first question's context, but the previous run context is NOT restored (this is not a session restore). " +
      "The old history stays readable.",
  );
  if (!confirmed) return;
  /* 材料 Branch（D4-3）走 material-new-exploration——材料来源上下文随行
     （#newExplorationMaterialContext）；可见性/确认流/收尾与 Turn 来源分支
     的换轨入口完全一致（v3 §4.4 既有语义）。 */
  const materialBranch = isMaterialBranchView(branchView(branchId));
  const payload = await api(
    `/api/trees/${encodeURIComponent(state.currentTreeId)}/branches/${encodeURIComponent(branchId)}` +
      `${materialBranch ? "/material-new-exploration" : "/new-exploration"}`,
    "POST",
    { text },
  );
  state.treeState = payload.state;
  input.value = "";
  if (isPanel) state.forcePanelSessionNote = false;
  else state.forceSessionBanner = false;
  /* 用户执行了换轨动作：清除横幅 dismiss 记录（横幅按当前事实重新呈现）。 */
  const trunk = trunkBranchId();
  if (trunk !== null) state.dismissedSessionBannerTrunks.delete(trunk);
  renderAll({ stick: branchId });
  await refreshDiagnostics();
  focusComposerWhenSelectable(input);
}

/** Abort the active run. Bypasses the busy guard on purpose: the whole point
 *  is to be clickable while a prompt is in flight. */
async function abortActiveRun() {
  const diag = state.diagnostics;
  if (diag === null || diag.activeRun === null || state.currentTreeId === null) return;
  const button = $("abort-run");
  button.disabled = true;
  button.textContent = "Aborting…";
  try {
    await api(
      `/api/trees/${encodeURIComponent(state.currentTreeId)}/runs/${encodeURIComponent(diag.activeRun.runId)}/abort`,
      "POST",
    );
  } catch (err) {
    showError(String(err && err.message ? err.message : err));
  }
  await refreshDiagnostics();
}

/**
 * 从某条 assistant turn 建支线（W2 §2.3）：无选区 = 整条答案；选区以
 * 绝对偏移提交（W1 §1.1）。新支线以局部面板打开（主线不动）；建支线
 * 不对齐游标（首次续聊由 prompt 显式导航——与既有行为一致）。
 * ③：选区从注册表取该 turn 的最新元素读取（复用元素跨重渲有效）。
 */
async function branchFromTurn(turn) {
  const entry = assistantTurns.get(turn.id);
  const selection =
    (entry !== undefined ? selectionOffsetsWithin(entry.element, turn.text) : null) ??
    { start: 0, end: turn.text.length, text: turn.text };
  const payload = await api(
    `/api/trees/${encodeURIComponent(state.currentTreeId)}/branches`,
    "POST",
    {
      sourceBranchId: turn.branchId,
      anchorTurnId: turn.id,
      selection,
    },
  );
  state.treeState = payload.state;
  await openBranchPanel(payload.branch.id, {
    alignCursor: false,
    trigger: { kind: "branch-button", turnId: turn.id },
  });
}

/**
 * 恢复动作（issue #3 P1 / W2 §2.8「可直接执行」）：从 session 仍可用的
 * 最新 assistant 答案（findSessionRecoveryAnchor）整条建支线，并以局部
 * 面板打开。不变量：新支线无 run，其续聊点 = origin 锚点 run 的 session
 * 引用（服务端语义），而锚点所在分支视图的 sessionAvailability 为
 * available——故新支线的续聊点按构造可用（面板续聊入口随之启用）。
 * 建支线不对齐游标（与 branchFromTurn 一致：首次续聊由 prompt 显式
 * 导航）。失败按调用面呈现错误横幅（guard）。
 */
async function branchFromLatestAvailableAnswer() {
  const anchor = findSessionRecoveryAnchor();
  if (anchor === null) return; /* 渲染期已禁用；兜底防竞态 */
  const payload = await api(
    `/api/trees/${encodeURIComponent(state.currentTreeId)}/branches`,
    "POST",
    {
      sourceBranchId: anchor.branchId,
      anchorTurnId: anchor.id,
      selection: { start: 0, end: anchor.text.length, text: anchor.text },
    },
  );
  state.treeState = payload.state;
  /* 用户选择了恢复动作：清除主横幅的 dismiss 记录——横幅此后按当前事实
     呈现（主干仍不可用则如实继续显示），不因旧 dismiss 被压制。 */
  const trunk = trunkBranchId();
  if (trunk !== null) state.dismissedSessionBannerTrunks.delete(trunk);
  await openBranchPanel(payload.branch.id, {
    alignCursor: false,
    trigger: { kind: "main-input" },
  });
}

/** 在树状态里按幂等键找已落库的 Return（同键探查；内容比对见 returnMatchesDraft）。 */
function findReturnByKey(treeState, idempotencyKey) {
  for (const view of treeState.branches) {
    for (const turn of view.turns) {
      if (turn.role === "return" && turn.idempotencyKey === idempotencyKey) {
        return turn;
      }
    }
  }
  return null;
}

/**
 * 对账命中判定（W1 §2.3/§2.5 的客户端镜像）：幂等键 + fromBranchId + text
 * 三者全同才视为「同一逻辑提交已落库」（响应丢失对账命中 / 服务端 200
 * 重放语义）。同键异容 = 冲突（服务端 409 return-conflict：旧键已绑定
 * 另一内容，同键重试必然再被拒）——绝不能只按键命中就当成功，否则会把
 * 旧 Return 伪装成已提交、清掉用户刚编辑的文本。
 */
function returnMatchesDraft(turn, idempotencyKey, fromBranchId, text) {
  return (
    turn.role === "return" &&
    turn.idempotencyKey === idempotencyKey &&
    turn.fromBranchId === fromBranchId &&
    turn.text === text
  );
}

/** 按（键, 来源分支, 文本）全同找已落库 Return：命中 = 可按已提交处理。 */
function findReconciledReturn(treeState, idempotencyKey, fromBranchId, text) {
  for (const view of treeState.branches) {
    for (const turn of view.turns) {
      if (returnMatchesDraft(turn, idempotencyKey, fromBranchId, text)) {
        return turn;
      }
    }
  }
  return null;
}

/** 同键异容冲突的显式提示（面板横幅）：冲突事实 + 草稿保留的后续动作。 */
function returnConflictError(existing, fromBranchId, text) {
  const differences = [];
  if (existing.fromBranchId !== fromBranchId) {
    differences.push(`fromBranchId ${fromBranchId} does not match ${existing.fromBranchId}`);
  }
  if (existing.text !== text) {
    differences.push("text differs");
  }
  const error = new Error(
    `Return conflict: this draft's idempotency key is already bound to a different Return ` +
      `(${differences.join("; ")}). Your draft is kept in the panel — edit the text to submit it as a new Return.`,
  );
  error.code = "return-conflict";
  return error;
}

/**
 * 显式提交 Return（面板分支 → 主干；W2 §2.4）：幂等键跨失败重试稳定；
 * 200 重放与 201 新建同为成功。服务端先保存后导航（signed v3 §3.5）：
 * 响应携带 navigation（navigated / no-session / failed），保存结果与
 * 导航结果分开控制收尾——保存成功 → 草稿清除、面板收起、焦点回主线
 * 输入框、主线滚到新 Return 卡（原分叉点附近）；导航失败 → 不立即重放
 * /switch（closePanel skipSwitch），主线横幅如实呈现「已保存，返回主线
 * 失败」+ 重新导航指引，绝不诱导重复提交、也不把已保存的 Return 伪装
 * 成未提交。响应丢失先按 /state 对账（键 + 来源分支 + 文本全同命中 →
 * 按成功处理，不重复提交；同键异容 → 显式冲突：保留草稿与面板、不清空
 * 已编辑文本、不把旧 Return 伪装成成功，编辑即换新键）。失败 → 草稿与
 * 键保留（localStorage 持久化），同键可重试、改写即换新键。
 */
async function submitReturn() {
  const branchId = state.panelBranchId;
  if (branchId === null) return;
  const input = $("return-input");
  const text = input.value;
  if (text.trim() === "") return;
  const draft = ensureReturnDraft(branchId);
  /* 材料 Branch（D4-3）走 material-return——响应携带材料来源卡（主线卡渲
     染的数据面）；幂等键/草稿/对账纪律与 Turn 来源 Return 完全共用。 */
  const materialBranch = isMaterialBranchView(branchView(branchId));
  let submittedTurnId = null;
  let navigation = null;
  try {
    const payload = await api(
      `/api/trees/${encodeURIComponent(state.currentTreeId)}${materialBranch ? "/material-return" : "/return"}`,
      "POST",
      {
        fromBranchId: branchId,
        text,
        idempotencyKey: draft.idempotencyKey,
      },
    );
    /* 200（同键重放）与 201（新建）同为成功：Return 已保存，清空草稿。 */
    state.treeState = payload.state;
    submittedTurnId = payload.returnTurn.id;
    navigation = payload.navigation ?? null;
    if (materialBranch && payload.card != null) {
      rememberMaterialReturnCard(state.currentTreeId, payload.returnTurn.id, payload.card);
    }
    clearReturnDraft();
  } catch (err) {
    /* 失败先查证（响应丢失：服务端已成功、响应未达客户端）：刷新树状态。
       同键且（来源分支 + 文本）全同 → 按成功处理；同键异容 → 显式冲突
       （草稿保留、面板不收、输入文本不动，编辑换新键后即为新的逻辑提交）；
       未命中 → 保留草稿与键（输入文本不动并落 localStorage），刷新后的
       状态照常呈现，错误交由 guard 呈现——用户可直接重试（同键）或改写
       （改写即换新键）。 */
    const refreshed = await api(`/api/trees/${encodeURIComponent(state.currentTreeId)}/state`);
    state.treeState = refreshed;
    const existing = findReturnByKey(refreshed, draft.idempotencyKey);
    if (existing !== null && !returnMatchesDraft(existing, draft.idempotencyKey, branchId, text)) {
      draft.failed = true;
      persistReturnDraft();
      renderAll();
      throw returnConflictError(existing, branchId, text);
    }
    if (existing !== null) {
      clearReturnDraft();
    } else {
      draft.failed = true;
      persistReturnDraft();
      renderAll();
      throw err;
    }
  }
  /* 收尾（回主干 + 滚到新 Return 卡）：保存结果与导航结果分别控制
     （signed v3 §3.5）。导航已由服务端在保存后尝试：failed → 不再重放
     /switch（skipSwitch），面板照常收起（保存已成功，留着面板会诱导
     重复提交），主线横幅如实告知「已保存，返回主线失败」+ 重新导航
     指引；navigated / no-session → 按既有语义收尾（客户端游标对齐失败
     仍呈现在主线横幅——可见面，不吞错，也不把已成功的提交伪装成失败）。 */
  if (navigation !== null && navigation.status === "failed") {
    await closePanel({ focus: "main-input", skipSwitch: true });
    showError(
      `Return saved — returning to the Trunk failed (${navigation.code}: ${navigation.message}). ` +
        `The Return is saved on the Trunk and pending adoption; use the Trunk tab to re-align the session.`,
    );
  } else {
    try {
      await closePanel({ focus: "main-input" });
    } catch (err) {
      showError(
        `Return saved — returning to the Trunk failed (${String(err && err.message ? err.message : err)}). ` +
          `The Return is saved on the Trunk and pending adoption.`,
      );
    }
  }
  if (submittedTurnId !== null) {
    const card = turnElements.get(submittedTurnId);
    if (card !== undefined && typeof card.scrollIntoView === "function") {
      card.scrollIntoView({ block: "center", behavior: scrollBehavior() });
    }
  }
}

/* ------------------------------ 来源抽屉（P1 + 反查） ------------------------------ */

async function toggleDrawer() {
  if (state.drawerOpen) {
    closeDrawer();
    return;
  }
  await openDrawer({ trigger: { kind: "element", element: $("source-drawer-toggle") } });
}

/**
 * 打开来源抽屉；opts.focusRunId = delivered 卡反查定位的 run（渲染后滚动
 * 到该 run 的出处条目）。打开时拉取 journal 尾部（保守摘要）。
 */
async function openDrawer(opts = {}) {
  if (state.drawerOpen) {
    /* 已开（如 delivered 卡点击时抽屉已开）：只更新定位目标。 */
    state.drawerFocusRunId = opts.focusRunId ?? null;
    if (opts.trigger !== undefined) state.drawerFocusReturn = opts.trigger;
    renderDrawer();
    return;
  }
  state.drawerOpen = true;
  state.drawerFocusRunId = opts.focusRunId ?? null;
  state.drawerFocusReturn = opts.trigger ?? { kind: "element", element: $("source-drawer-toggle") };
  state.journalEvents = null; /* 三态复位：进入加载中（防上次的陈旧态闪现） */
  state.terminology = null; /* 术语读模型同批拉取 */
  renderDrawer();
  showDrawer();
  $("source-drawer").focus(); /* 焦点入抽屉（W2 §2.7） */
  void loadJournal();
  void refreshTerminology().then(() => {
    if (state.drawerOpen) renderDrawer();
  });
}

/**
 * journal 拉取（打开与重试共用）：成功 / 失败如实落三态（W2 §2.7
 * 打开-加载失败；issue #3 P1——失败绝不折叠成空数组伪装成“无事件”）。
 */
async function loadJournal() {
  if (state.currentTreeId === null) return;
  const treeId = state.currentTreeId;
  state.journalEvents = null;
  renderDrawer();
  try {
    const payload = await api(`/api/trees/${encodeURIComponent(treeId)}/journal?limit=20`);
    /* P1 同族规则（issue #7 增量验收）：迟到的 journal 响应（切树后到达）
       不写入当前树的共享状态（三态属于当前打开的树）。 */
    if (state.currentTreeId !== treeId) return;
    state.journalEvents = { ok: true, events: payload.events };
  } catch {
    if (state.currentTreeId !== treeId) return;
    state.journalEvents = { ok: false };
  }
  renderDrawer();
}

/** 关闭抽屉：焦点还原到触发元素（W2 §2.7）。 */
function closeDrawer() {
  if (!state.drawerOpen) return;
  state.drawerOpen = false;
  state.drawerFocusRunId = null;
  hideDrawer();
  /* 开关的 aria-expanded / 文案只在 renderDrawer 对齐——Esc 关闭不经过
     renderAll，不补一次则读屏器持续播报已展开（浏览器面跑批器发现：
     关闭后 3 秒仍为 true，直到下一次无关重渲）。drawerOpen 已为 false，
     renderDrawer 更新开关后立即返回，不触碰抽屉内容/退出动画。 */
  renderDrawer();
  const ref = state.drawerFocusReturn;
  state.drawerFocusReturn = null;
  restoreFocusRef(ref);
}

/**
 * 来源抽屉：per-run 出处（分支/定位/状态/失败码/时间戳；条目带
 * data-run-id 供 delivered 卡反查定位）、Return 出处（from-branch/锚点
 * 摘录/送达 run）、journal 尾部（保守摘要）与工具活动（离线如实空态——
 * Studio 以空工具 allowlist 运行，无工具事件）。
 */
function renderDrawer() {
  const drawer = $("source-drawer");
  const toggle = $("source-drawer-toggle");
  toggle.textContent = state.drawerOpen ? "× Close sources" : "⑂ Sources";
  toggle.setAttribute("aria-expanded", state.drawerOpen ? "true" : "false");
  if (!state.drawerOpen) return;

  drawer.replaceChildren();
  drawerRunItems.clear();
  /* 抽屉头部（附-4，option B 方向）：抽屉为覆盖层，打开时同时盖住主线
     composer 的 Send 与 Sources 开关自身——鼠标用户此前唯一关闭路径是
     Esc。头部加可见关闭按钮，点击复用 closeDrawer()（开关 aria 对齐 +
     焦点还原与 Esc 同一语义，不另开关闭路径）。 */
  const head = document.createElement("div");
  head.className = "drawer-head";
  const title = document.createElement("h2");
  title.textContent = "Sources";
  const close = document.createElement("button");
  close.id = "drawer-close";
  close.textContent = "× Close";
  close.addEventListener("click", () => closeDrawer());
  head.append(title, close);
  drawer.append(head);

  /* per-run 出处（诊断面安全投影）。 */
  const runsTitle = document.createElement("h3");
  runsTitle.textContent = "Runs";
  drawer.append(runsTitle);
  const diag = state.diagnostics;
  if (diag === null || diag.runs.length === 0) {
    drawer.append(mutedLine("no runs recorded for this tree yet"));
  } else {
    const list = document.createElement("ul");
    list.className = "drawer-list";
    for (const run of diag.runs) {
      const li = document.createElement("li");
      li.dataset.runId = run.runId;
      const failureNote = run.failure === null ? "" : ` · failure ${run.failure.code}`;
      const time =
        run.terminalAt === null
          ? `started ${new Date(run.createdAt).toLocaleTimeString()}`
          : `${new Date(run.createdAt).toLocaleTimeString()} → ${new Date(run.terminalAt).toLocaleTimeString()}`;
      li.textContent =
        `${branchLabel(run.branchId)} · run ${run.runId.slice(0, 12)}… · ${run.state}${failureNote} · ${time}`;
      drawerRunItems.set(run.runId, li);
      list.append(li);
    }
    drawer.append(list);
  }

  /* Return 出处（signed v3 §3.2：区分已保存 / 采用尝试过 / 首次成功采用；
     尝试明细含 run 与结局——runId/状态/失败码是安全投影字段，无路径与
     session 引用）。 */
  const returnsTitle = document.createElement("h3");
  returnsTitle.textContent = "Returns";
  drawer.append(returnsTitle);
  const st = state.treeState;
  const returns =
    st === null
      ? []
      : st.branches.flatMap((view) =>
          view.turns.filter((t) => t.role === "return").map((t) => ({ view, turn: t })),
        );
  if (returns.length === 0) {
    drawer.append(mutedLine("no returns submitted for this tree yet"));
  } else {
    const list = document.createElement("ul");
    list.className = "drawer-list";
    for (const { view, turn } of returns) {
      const li = document.createElement("li");
      const anchor = turn.targetAnchor;
      const anchorNote =
        anchor === null
          ? "original anchor unavailable"
          : `anchored on “${anchor.selection.text}” from ${branchLabel(anchor.sourceBranchId)}`;
      const attempts = returnAttemptsFor(view, turn.id);
      if (turn.deliveredRunId !== null) {
        li.textContent =
          `from ${branchLabel(turn.fromBranchId ?? "")} · ${anchorNote} · ` +
          `successfully adopted into run ${turn.deliveredRunId.slice(0, 12)}… (first success)`;
      } else if (attempts.length > 0) {
        li.textContent =
          `from ${branchLabel(turn.fromBranchId ?? "")} · ${anchorNote} · ` +
          `adoption attempted, still pending (${String(attempts.length)})`;
      } else {
        li.textContent = `from ${branchLabel(turn.fromBranchId ?? "")} · ${anchorNote} · saved, pending adoption`;
      }
      list.append(li);
      for (const attempt of attempts) {
        const item = document.createElement("li");
        item.className = "attempt";
        const failureNote = attempt.failure === null ? "" : ` · failure ${attempt.failure.code}`;
        item.textContent =
          `attempt: run ${attempt.runId.slice(0, 12)}… · ${attempt.runState}${failureNote}`;
        list.append(item);
      }
    }
    drawer.append(list);
  }

  /* 术语批注与执行器面（issue #7 C ③ 完整）：已保存批注的出处（术语/摘
     录/来源分支/推广去向）+ 近期任务（三模式 term/range/auto 的任务态如
     实呈现——瞬态任务面，不是产品事实）+ 执行器用量（requests 为精确计
     数，est tokens 为 chars/4 诚实估算；服务端迟到丢弃与客户端迟到丢弃
     分开计数）+ 缓存偏好（PUT preferences，可切换；在途/失败态如实）。
     三态呈现与 journal 同纪律：加载中 / 已载（可为空）/ 失败 + 重试。 */
  const termsTitle = document.createElement("h3");
  termsTitle.textContent = "Terminology";
  drawer.append(termsTitle);
  const terminology = state.terminology;
  if (terminology === null) {
    drawer.append(mutedLine("loading terminology…"));
  } else if (!terminology.ok) {
    const line = document.createElement("p");
    line.className = "muted";
    line.append(document.createTextNode("terminology failed to load — "));
    const retryTerms = document.createElement("button");
    retryTerms.className = "drawer-retry";
    retryTerms.textContent = "Retry";
    retryTerms.title = "Fetch the terminology read model again";
    retryTerms.addEventListener("click", () =>
      void refreshTerminology().then(() => {
        renderDrawer();
        renderAll(); /* 读模型恢复即补齐批注覆盖（正文区间层） */
      }),
    );
    line.append(retryTerms);
    drawer.append(line);
  } else {
    if (terminology.annotations.length === 0) {
      drawer.append(mutedLine("no saved term annotations yet — select a term in an answer and “Explain selection”"));
    } else {
      const list = document.createElement("ul");
      list.className = "drawer-list";
      for (const annotation of terminology.annotations) {
        const li = document.createElement("li");
        const promotedNote =
          annotation.promotedBranchId === null
            ? "not promoted"
            : `promoted to ${branchLabel(annotation.promotedBranchId)}`;
        /* P0 降级显示（W1 降级 Return 卡同款纪律）：锚定失效（原文漂移/锚
           点缺失）的批注——保存快照（摘录/术语/解释）照常在列表可读，但明
           确标注来源状态，绝不冒充仍可在正文上定位（活覆盖不渲染）。 */
        const anchorStatus = terminologyAnchorStatus(annotation);
        const anchorNote =
          anchorStatus === "valid"
            ? ""
            : anchorStatus === "changed"
              ? " · source changed — the answer text drifted since saving (snapshot only, no live underline)"
              : " · source missing — the anchored answer is not in this tree (snapshot only)";
        li.textContent =
          `“${annotation.term}” (${annotation.mode}) from ${branchLabel(annotation.branchId)} · ` +
          `anchored on “${annotation.selection.text}” · ${promotedNote}${anchorNote}`;
        list.append(li);
      }
      drawer.append(list);
    }
    /* 近期任务（瞬态——模式与任务态如实；进程重启即空，如实呈现）。 */
    if (terminology.tasks.length === 0) {
      drawer.append(mutedLine("no terminology tasks in this process yet"));
    } else {
      const taskList = document.createElement("ul");
      taskList.className = "drawer-list term-task-list";
      for (const task of terminology.tasks.slice(-8)) {
        const li = document.createElement("li");
        let taskState = task.state.kind;
        if (task.state.kind === "succeeded") {
          taskState = task.state.cached === true ? "succeeded (from cache)" : "succeeded";
        } else if (task.state.kind === "failed") {
          taskState = `failed (${task.state.code})`;
        } else if (task.state.kind === "cancelled") {
          taskState =
            task.state.lateResultDiscarded === true
              ? "cancelled (late result discarded)"
              : "cancelled";
        }
        li.textContent = `${task.kind} · ${task.mode} · ${taskState}`;
        taskList.append(li);
      }
      drawer.append(taskList);
    }
    const usageNote = document.createElement("p");
    usageNote.className = "muted";
    const usage = terminology.usage;
    usageNote.textContent =
      `terminology executor: ${String(usage.total.requests)} request(s), ` +
      `est. ${String(usage.estTokens)}/${String(usage.budgetTokens)} tokens (chars/4 estimate), ` +
      `${String(usage.lateResultsDiscarded)} late result(s) discarded by the executor, ` +
      `${String(state.termDiscardedLate)} late response(s) discarded client-side, cache ${terminology.cacheEnabled ? "on" : "off"}`;
    drawer.append(usageNote);
    /* 缓存偏好（③：同 (mode, 选区, sourceHash) 解释复用缓存——可开关）。 */
    const cacheLine = document.createElement("p");
    cacheLine.className = "muted term-cache-line";
    const cacheToggle = document.createElement("button");
    cacheToggle.className = "term-cache-toggle";
    if (termPrefsPending) {
      cacheToggle.textContent = "updating cache preference…";
      cacheToggle.disabled = true;
    } else {
      cacheToggle.textContent = terminology.cacheEnabled
        ? "cache preference: on — click to disable"
        : "cache preference: off — click to enable";
      cacheToggle.addEventListener("click", () =>
        void guard(() => setTerminologyCachePreference(!terminology.cacheEnabled)),
      );
    }
    cacheLine.append(cacheToggle);
    drawer.append(cacheLine);
    if (termPrefsError !== null) {
      const prefsError = document.createElement("p");
      prefsError.className = "muted";
      prefsError.textContent = `cache preference failed — ${termPrefsError}`;
      drawer.append(prefsError);
    }
    /* 阅读模式三选一（①阅读模式）：manual-only（默认）/ minimal-hints /
       assisted-reading。模式可保存可切换；gate 未过（或仅手动）时旁注如实
       说明自动建议未生效——绝不伪装启用。切换 = PUT settings/reading-mode
       （在途禁用明示；失败如实 + 重试）。 */
    const modeRow = document.createElement("div");
    modeRow.className = "term-mode-row";
    modeRow.setAttribute("role", "group");
    modeRow.setAttribute("aria-label", "Terminology reading mode");
    const currentMode = terminology.readingMode ?? "manual-only";
    const MODE_LABELS = {
      "manual-only": "Manual only",
      "minimal-hints": "Minimal hints",
      "assisted-reading": "Assisted reading",
    };
    for (const mode of ["manual-only", "minimal-hints", "assisted-reading"]) {
      const modeButton = document.createElement("button");
      modeButton.className = "term-mode-toggle";
      modeButton.textContent = MODE_LABELS[mode];
      modeButton.title =
        mode === "manual-only"
          ? "No automatic suggestions — you explain selections yourself (default)"
          : mode === "minimal-hints"
            ? "A few suggested terms per completed answer (density-capped, display-only)"
            : "More suggested terms per completed answer (density-capped, display-only)";
      modeButton.setAttribute("aria-pressed", String(currentMode === mode));
      modeButton.disabled = termModePending;
      modeButton.addEventListener("click", () => void guard(() => setTerminologyReadingMode(mode)));
      modeRow.append(modeButton);
    }
    drawer.append(modeRow);
    if (termModePending) {
      drawer.append(mutedLine("saving reading mode…"));
    }
    const autoState = terminology.autoSuggestions ?? null;
    if (autoState !== null && autoState.enabled !== true) {
      drawer.append(
        mutedLine(
          autoState.reason === "manual-only"
            ? "reading mode is manual-only — suggestions appear only when you explain a selection yourself"
            : "the auto-annotation quality gate has not passed — automatic suggestions stay OFF; only manual explaining is in effect",
        ),
      );
    }
    if (termModeError !== null) {
      const modeError = document.createElement("p");
      modeError.className = "muted";
      modeError.textContent = `reading mode failed — ${termModeError}`;
      drawer.append(modeError);
    }
  }

  /* journal 尾部（保守摘要；最新在后）。三态（W2 §2.7 / issue #3 P1）：
     加载中 / 已载（可为空——如实空态）/ 加载失败（失败 + 重试，绝不
     伪装成无事件）。 */
  const journalTitle = document.createElement("h3");
  journalTitle.textContent = "Journal (latest 20)";
  drawer.append(journalTitle);
  if (state.journalEvents === null) {
    drawer.append(mutedLine("loading journal…"));
  } else if (!state.journalEvents.ok) {
    const line = document.createElement("p");
    line.className = "muted";
    line.append(document.createTextNode("journal failed to load — "));
    const retry = document.createElement("button");
    retry.className = "drawer-retry";
    retry.textContent = "Retry";
    retry.title = "Fetch the journal tail again";
    retry.addEventListener("click", () => void loadJournal());
    line.append(retry);
    drawer.append(line);
  } else if (state.journalEvents.events.length === 0) {
    drawer.append(mutedLine("no journal events recorded for this tree yet"));
  } else {
    const list = document.createElement("ul");
    list.className = "drawer-list journal-list";
    for (const event of state.journalEvents.events) {
      const li = document.createElement("li");
      const time = document.createElement("span");
      time.className = "muted";
      time.textContent = `${new Date(event.occurredAt).toLocaleTimeString()} `;
      li.append(time, document.createTextNode(`${event.type} — ${event.summary}`));
      list.append(li);
    }
    drawer.append(list);
  }

  /* 工具活动（诚实边界：离线驱动无工具事件）。 */
  const toolTitle = document.createElement("h3");
  toolTitle.textContent = "Tool activity";
  drawer.append(toolTitle);
  if (state.toolActivity.length === 0) {
    drawer.append(mutedLine("no tool activity observed — Studio runs with an empty tool allowlist"));
  } else {
    const list = document.createElement("ul");
    list.className = "drawer-list";
    for (const activity of state.toolActivity) {
      const li = document.createElement("li");
      /* phase "denied" 携带策略 provenance（outcome/固定模板 reason/规则
         来源）；其余阶段只有工具名 + 阶段（参数/路径/命令绝不出境）。 */
      let text = `run ${activity.runId.slice(0, 12)}… · ${activity.tool ?? "unknown tool"} ${activity.phase}`;
      if (activity.phase === "denied" && activity.decision) {
        text += ` — ${activity.decision.reason} [${activity.decision.ruleId ?? "no rule"}]`;
      }
      li.textContent = text;
      list.append(li);
    }
    drawer.append(list);
  }

  /* delivered 卡反查定位：滚动到该 run 的出处条目。 */
  const focusRunId = state.drawerFocusRunId;
  if (focusRunId !== null) {
    const li = drawerRunItems.get(focusRunId);
    if (li !== undefined && typeof li.scrollIntoView === "function") {
      li.scrollIntoView({ block: "start", behavior: scrollBehavior() });
    }
  }
}

function mutedLine(text) {
  const p = document.createElement("p");
  p.className = "muted";
  p.textContent = text;
  return p;
}

/* ------------------------------ 术语三部分（issue #7 C ③ 完整前端） ------------------------------ */

/** 术语读模型世代号（P1，issue #7 增量验收 2026-09-30）：写 state.terminology
    前双验证之一——同一树上被更新请求取代、或切树后迟到到达的响应按世代
    作废（末次请求胜出）。 */
let terminologyEpoch = 0;

/** 术语读模型拉取（解释卡保存/推广后、抽屉打开时与开树时刷新；失败不伪
    装空态——三态：null = 未载 / {ok:true,…} = 已载 / {ok:false} = 拉取
    失败。批注区间覆盖（turnOverlaysFor）只在已载时渲染）。
    P1 竞态整改：写 state 前先验「请求树 + 世代号」——A 树的响应在切到
    B 树后迟到到达时整包丢弃（成功与失败两路同守卫；原先 then 里的树守卫
    只拦渲染、不拦写入，探针实测 A 的批注会写进 B 的读模型）；守卫在写
    点，开树/保存/推广/抽屉/重试等全部调用方自动继承同一规则。 */
async function refreshTerminology() {
  if (state.currentTreeId === null) return;
  const treeId = state.currentTreeId;
  const epoch = ++terminologyEpoch;
  try {
    const payload = await api(`/api/trees/${encodeURIComponent(treeId)}/terminology`);
    if (epoch !== terminologyEpoch || state.currentTreeId !== treeId) return; /* 迟到丢弃 */
    state.terminology = { ok: true, ...payload };
    followPendingTermSuggestions(); /* ①阅读模式：pending 建议集的有界跟随 */
  } catch {
    if (epoch !== terminologyEpoch || state.currentTreeId !== treeId) return; /* 迟到丢弃 */
    state.terminology = { ok: false };
  }
}

/** 开树时拉取术语读模型（批注区间覆盖的数据面）；迟到响应在
    refreshTerminology 的写点丢弃，此处只守卫重渲（树已切换不重渲）。 */
function refreshTerminologyForTree(treeId) {
  void refreshTerminology().then(() => {
    if (state.currentTreeId === treeId) renderAll();
  });
}

/**
 * 解释选区（瞬态任务——不落任何树产品事实；隔离执行器）。任务态在卡内
 * 如实呈现（loading/explained/saved/failed/cancelled——含迟到丢弃注记），
 * 保存与推广是显式后续动作。token 是请求世代号：迟到的响应（目标卡已被
 * 替换/关闭）如实丢弃并计数（termDiscardedLate，抽屉用量行呈现），绝不
 * 覆盖新状态——「late-result-discarded（stale 目标离开视图）」的客户端面。
 */
async function explainSelection(branchId, turn, selection) {
  const mode = selection.text.trim().includes(" ") ? "range" : "term";
  termExplainSeq += 1;
  const token = termExplainSeq;
  termCardEnterPending = true;
  state.termExplain = {
    branchId,
    turnId: turn.id,
    selection,
    mode,
    state: "loading",
    explanation: null,
    error: null,
    cached: false,
    lateDiscard: false,
    saveOutcome: null,
    annotation: null,
    promotionKey: null,
    promoting: false,
    promotionConflict: null,
    firstQuestion: "",
    token,
  };
  /* 解释已捕获明确区间：选区交互收束（工具条退场，卡成为活跃面）。 */
  if (state.armedSelection !== null) disarmArmedSelection();
  renderAll();
  const cardElement = document.getElementById("term-explain-card");
  if (cardElement !== null) cardElement.focus();
  try {
    const payload = await api(
      `/api/trees/${encodeURIComponent(state.currentTreeId)}/terminology/explain`,
      "POST",
      { branchId, anchorTurnId: turn.id, selection, mode },
    );
    if (state.termExplain === null || state.termExplain.token !== token) {
      state.termDiscardedLate += 1; /* stale 目标已离开/被替换：如实丢弃 */
      return;
    }
    const card = state.termExplain;
    if (payload.annotation != null) {
      /* 服务端同选区去重命中：零模型调用，直接呈现既有批注（已推广时
         卡面给出 resume-or-create 明确去向）。 */
      state.termExplain = {
        ...card,
        state: "saved",
        annotation: payload.annotation,
        explanation: payload.annotation.explanation,
        saveOutcome: "duplicate",
      };
    } else if (payload.task != null && payload.task.state.kind === "succeeded") {
      state.termExplain = {
        ...card,
        state: "explained",
        explanation: payload.task.state.explanation,
        cached: payload.task.state.cached === true,
      };
    } else if (payload.task != null && payload.task.state.kind === "failed") {
      state.termExplain = {
        ...card,
        state: "failed",
        error: `${payload.task.state.code}: ${payload.task.state.message}`,
      };
    } else if (payload.task != null && payload.task.state.kind === "cancelled") {
      state.termExplain = {
        ...card,
        state: "cancelled",
        lateDiscard: payload.task.state.lateResultDiscarded === true,
      };
    } else {
      state.termExplain = { ...card, state: "failed", error: "the explain task ended without a result" };
    }
  } catch (err) {
    if (state.termExplain === null || state.termExplain.token !== token) {
      state.termDiscardedLate += 1;
      return;
    }
    state.termExplain = {
      ...state.termExplain,
      state: "failed",
      error: String(err && err.message ? err.message : err),
    };
  }
  renderAll();
}

/**
 * 显式保存批注（产品事实；同选区幂等——服务端返回既有批注，created:false
 * 时卡面如实呈现「已存在，显示既有批注」，不伪装成新建）。
 * P1 同族规则（issue #7 增量验收）：请求期间卡被关闭/替换（token 失配）→
 * 卡面状态如实丢弃（批注已保存为产品事实，随读模型刷新自然可见），绝不
 * 复活已关的卡。
 */
async function saveTermAnnotation() {
  const card = state.termExplain;
  if (card === null || card.explanation === null) return;
  const token = card.token;
  const payload = await api(
    `/api/trees/${encodeURIComponent(state.currentTreeId)}/terminology/annotations`,
    "POST",
    {
      branchId: card.branchId,
      anchorTurnId: card.turnId,
      selection: card.selection,
      mode: card.mode,
      term: card.selection.text,
      explanation: card.explanation,
    },
  );
  const current = state.termExplain;
  if (current !== null && current.token === token) {
    state.termExplain = {
      ...current,
      state: "saved",
      annotation: payload.annotation,
      saveOutcome: payload.created === true ? "created" : "duplicate",
    };
  }
  await refreshTerminology();
  renderAll();
}

/**
 * 幂等推广（issue #7 C ②）：从已保存批注建枝并派发首问（复用底层
 * Anchor/Branch/Origin/Run/回程/Return）。幂等键跨失败重试稳定；成功后
 * 以支线面板打开新分支（同键重放返回同一分支——created:false 如实呈现
 * 「打开的是既有推广」）。冲突（同批注异键，409）如实呈现在卡面（不吞
 * 错、不静默换目标），并刷新读模型以给出「恢复既有探索」的去向。
 */
async function promoteTermAnnotation() {
  const card = state.termExplain;
  if (card === null || card.annotation === null) return;
  const firstQuestion = card.firstQuestion;
  if (firstQuestion.trim() === "") {
    showError("Type the first question for the follow-up branch first.", "panel");
    $("term-first-question").focus();
    return;
  }
  const promotionKey = card.promotionKey ?? crypto.randomUUID();
  state.termExplain = { ...card, promotionKey, promoting: true, promotionConflict: null };
  renderAll();
  try {
    const payload = await api(
      `/api/trees/${encodeURIComponent(state.currentTreeId)}/terminology/annotations/${encodeURIComponent(card.annotation.id)}/promote`,
      "POST",
      { idempotencyKey: promotionKey, firstQuestion },
    );
    state.treeState = payload.state;
    await refreshTerminology();
    if (state.termExplain !== null && state.termExplain.token === card.token) {
      state.termExplain = null; /* P1 同族：请求期间卡已被替换时不误关新卡 */
    }
    renderAll();
    await openBranchPanel(payload.branch.id, {
      alignCursor: false,
      trigger: { kind: "main-input" },
    });
    if (payload.firstQuestionError !== null) {
      showError(
        `Branch created, but the first question failed (${payload.firstQuestionError.code}: ${payload.firstQuestionError.message}). ` +
          "The saved annotation keeps its promotion — reopen the term and promote again with the same key to retry.",
        "panel",
      );
    } else if (payload.created === false) {
      /* 同键重放：既有推广的分支（首问已成功不重复派发——issue #7 ②）。 */
      showError(`Opened the existing follow-up branch (same promotion key — no duplicate dispatch).`, "panel");
    }
  } catch (err) {
    /* 冲突/失败：如实呈现在卡面（完整失败状态），读模型刷新后给出恢复
       既有探索的明确去向；原始错误仍由 guard 呈现横幅。
       P1 同族竞态（真实浏览器面发现；DOM 桩无 SSE 并发测不出）：推广自身
       派发的首问完成会触发 SSE run-terminal 的读模型刷新，与本路径的
       refreshTerminology 竞争世代号——本路径的写入被作废时，卡面会锁定
       陈旧批注（「恢复既有探索」去向永不出现）。对账补一次直接读
       （submitReturn 响应丢失同款纪律）：以该响应为准更新卡面批注；
       共享读模型仍由常规刷新收敛。 */
    await refreshTerminology().catch(() => {});
    let reconciled = null;
    try {
      reconciled = await api(`/api/trees/${encodeURIComponent(state.currentTreeId)}/terminology`);
    } catch {
      /* 对账读取失败：卡面按现有读模型如实呈现（下方 find 走 state.terminology） */
    }
    const current = state.termExplain;
    if (current !== null && current.token === card.token) {
      const model =
        reconciled !== null
          ? reconciled
          : state.terminology !== null && state.terminology.ok
            ? state.terminology
            : null;
      const freshAnnotation =
        model !== null
          ? (model.annotations.find((a) => a.id === card.annotation.id) ?? current.annotation)
          : current.annotation;
      state.termExplain = {
        ...current,
        promoting: false,
        promotionConflict: String(err && err.message ? err.message : err),
        annotation: freshAnnotation,
      };
      renderAll();
    }
    throw err;
  }
}

/** 打开已保存批注的卡（读模型数据面，零请求——与服务端同选区去重语义
    一致）；focusFirstQuestion = 工具条推广捷径直达首问输入。 */
function openSavedAnnotationCard(annotation, branchId, turn, opts = {}) {
  termCardEnterPending = true;
  termExplainSeq += 1;
  state.termExplain = {
    branchId,
    turnId: turn.id,
    selection: annotation.selection,
    mode: annotation.mode === "range" ? "range" : "term",
    state: "saved",
    explanation: annotation.explanation,
    error: null,
    cached: false,
    lateDiscard: false,
    saveOutcome: "duplicate",
    annotation,
    promotionKey: null,
    promoting: false,
    promotionConflict: null,
    firstQuestion: "",
    token: termExplainSeq,
  };
  if (state.armedSelection !== null) disarmArmedSelection();
  renderAll();
  if (opts.focusFirstQuestion === true) {
    const input = document.getElementById("term-first-question");
    if (input !== null) input.focus();
  } else {
    const cardElement = document.getElementById("term-explain-card");
    if (cardElement !== null) cardElement.focus();
  }
}

/** 关闭解释卡：焦点还原到该答案的解释入口；解释入口不可聚焦（无武装
    选区时是 disabled 按钮——真实浏览器 disabled 控件 focus() 静默无操作，
    DOM 桩可聚焦测不出；turn 元素本身无 tabindex）时还原到该视图的
    composer（W2「常驻主焦点」回退，与 closePanel 同款）。 */
function closeTermExplain() {
  const card = state.termExplain;
  state.termExplain = null;
  renderAll();
  if (card === null) return;
  const target = termExplainButtons.get(card.turnId);
  if (target !== undefined && target.disabled !== true) {
    target.focus();
    return;
  }
  focusComposerWhenSelectable(card.branchId === trunkBranchId() ? $("prompt-input") : $("panel-prompt-input"));
}

/**
 * 抽屉内的缓存偏好切换（③：执行器偏好面）：PUT preferences；在途禁用
    明示，失败如实呈现 + 重试（不伪装成功），成功后读模型与抽屉同步。
    P1 同族规则（issue #7 增量验收）：偏好响应只写「请求树」的读模型
    （切树后迟到到达即丢弃）；本写入即读模型新一代——并发在途的旧读模型
    响应（其快照早于本次偏好变化）一并作废，防止把偏好改回旧值。
 */
async function setTerminologyCachePreference(enabled) {
  const treeId = state.currentTreeId;
  termPrefsPending = true;
  termPrefsError = null;
  renderDrawer();
  try {
    const payload = await api(
      `/api/trees/${encodeURIComponent(treeId)}/terminology/preferences`,
      "PUT",
      { cacheEnabled: enabled },
    );
    terminologyEpoch += 1;
    if (state.currentTreeId === treeId && state.terminology !== null && state.terminology.ok) {
      state.terminology = { ...state.terminology, cacheEnabled: payload.cacheEnabled === true };
    }
  } catch (err) {
    termPrefsError = String(err && err.message ? err.message : err);
  } finally {
    termPrefsPending = false;
    if (state.drawerOpen) renderDrawer();
  }
}

/**
 * 抽屉内的阅读模式切换（issue #7 ①阅读模式）：PUT settings/reading-mode。
 * 在途禁用明示；失败如实呈现 + 重试；成功后读模型同步（模式字段就地更新
 * ——P1 同族：请求树守卫 + 世代号作废并发旧响应）。gate 未过时模式仍可
 * 保存切换（旁注如实说明自动建议保持关闭——绝不伪装启用）。
 */
async function setTerminologyReadingMode(mode) {
  const treeId = state.currentTreeId;
  if (treeId === null) return;
  termModePending = true;
  termModeError = null;
  renderDrawer();
  try {
    const payload = await api(
      `/api/trees/${encodeURIComponent(treeId)}/terminology/settings/reading-mode`,
      "PUT",
      { mode },
    );
    terminologyEpoch += 1;
    if (state.currentTreeId === treeId && state.terminology !== null && state.terminology.ok) {
      /* 就地同步：readingMode + autoSuggestions 生效态（gate × 模式）。
         gate 未过（quality-gate-pending）不因模式切换改变；gate 开时模式
         决定生效与否（manual-only ↔ 其余两档）——服务端是权威面，下一次
         读模型刷新自然对齐（P1 同族：世代号作废并发旧响应）。 */
      const auto = state.terminology.autoSuggestions ?? null;
      const nextAuto =
        auto === null
          ? null
          : auto.reason === "quality-gate-pending"
            ? auto
            : payload.readingMode === "manual-only"
              ? { ...auto, enabled: false, reason: "manual-only" }
              : { ...auto, enabled: true, reason: null };
      state.terminology = {
        ...state.terminology,
        readingMode: payload.readingMode,
        ...(nextAuto === null ? {} : { autoSuggestions: nextAuto }),
      };
    }
  } catch (err) {
    termModeError = String(err && err.message ? err.message : err);
  } finally {
    termModePending = false;
    if (state.drawerOpen) renderDrawer();
  }
}

/**
 * 建议集的显式重试（budget-paused/failed 的「可恢复入口」——用户显式动
 * 作）：POST suggestions/:anchorTurnId/retry → 读模型刷新重渲。失败由
 * guard 呈现横幅（按钮态如实回到原状，绝不伪装成功）。
 */
async function retryTermSuggestions(anchorTurnId) {
  const treeId = state.currentTreeId;
  if (treeId === null) return;
  await api(
    `/api/trees/${encodeURIComponent(treeId)}/terminology/suggestions/${encodeURIComponent(anchorTurnId)}/retry`,
    "POST",
  );
  await refreshTerminology();
  renderAll();
}

/** 当前树读模型里是否存在 pending 建议集（跟随轮询的继续条件）。 */
function treeHasPendingSuggestionSets() {
  const terminology = state.terminology;
  if (terminology === null || !terminology.ok) return false;
  const auto = terminology.autoSuggestions;
  if (auto === null || typeof auto !== "object" || !Array.isArray(auto.sets)) return false;
  return auto.sets.some((set) => set.status === "pending");
}

/**
 * pending 建议集的有界跟随轮询（refreshTerminology 成功写入后调用——所有
 * 刷新入口（回答完成/开树/保存/推广/重试/抽屉重试）自动继承）：仍在途则
 * 1s 后再刷，至多 90 次；切树/终态即停。回答完成的 POST 响应可能先于隔离
 * 执行器的提取终态（串行链 + 真实模型耗时），诚实呈现 pending 而非空态。
 */
function followPendingTermSuggestions() {
  if (termSuggestFollowActive) return;
  const treeId = state.currentTreeId;
  if (treeId === null || !treeHasPendingSuggestionSets()) return;
  termSuggestFollowActive = true;
  let polls = 0;
  const tick = () => {
    if (
      state.currentTreeId !== treeId ||
      polls >= TERM_SUGGEST_FOLLOW_MAX_POLLS ||
      !treeHasPendingSuggestionSets()
    ) {
      termSuggestFollowActive = false;
      return;
    }
    polls += 1;
    void refreshTerminology().then(() => {
      if (state.currentTreeId !== treeId) {
        termSuggestFollowActive = false;
        return;
      }
      renderAll();
      if (
        polls >= TERM_SUGGEST_FOLLOW_MAX_POLLS ||
        !treeHasPendingSuggestionSets()
      ) {
        termSuggestFollowActive = false;
        return;
      }
      window.setTimeout(tick, TERM_SUGGEST_FOLLOW_INTERVAL_MS);
    });
  };
  window.setTimeout(tick, TERM_SUGGEST_FOLLOW_INTERVAL_MS);
}

/** 建议 chip 的重定位聚焦（Esc 解除武装后还原键盘位置——按词文本匹配）。 */
function focusTermSuggestionChip(term) {
  for (const chip of document.querySelectorAll(".term-suggest-chip")) {
    if (chip.textContent === term) {
      chip.focus();
      return;
    }
  }
}

/**
 * 解除武装的建议预填（Esc / Dismiss 共用）：清 state.termSuggest、重渲、
 * 焦点还原到该词的 chip（键盘位置不丢）。
 */
function disarmTermSuggestion() {
  const armed = state.termSuggest;
  if (armed === null) return;
  state.termSuggest = null;
  renderAll();
  focusTermSuggestionChip(armed.term);
}

/**
 * assistant 回答区的建议条（issue #7 ①阅读模式，渲染在该条答案 turn 元素
 * 之后）：按建议集状态如实呈现——pending（提取在途）/ ready / partial
 * （密度截断：「还有 N 个候选未显示」）/ no-suggestions / budget-paused
 * （预算不足暂停 + 可恢复入口）/ failed（诚实错误 + 重试）/ source-invalid
 * （来源失效——快照展示，点击解释禁用，既有 overlay 失效降级同纪律）。
 * 建议**只展示**：点击 chip = 预填该词的解释请求，用户显式确认（“⌖
 * Explain”）才发——不自动解释、不自动保存。chip 为原生 button（键盘可
 * 达）；无进场动效（reduced-motion 无需特例）。
 */
function termSuggestionStrip(branchId, turn) {
  const terminology = state.terminology;
  if (terminology === null || !terminology.ok) return null;
  const auto = terminology.autoSuggestions;
  if (auto === null || typeof auto !== "object" || !Array.isArray(auto.sets)) return null;
  const set = auto.sets.find((entry) => entry.anchorTurnId === turn.id && entry.branchId === branchId);
  if (set === undefined) return null;
  const div = document.createElement("div");
  div.className = "term-suggest-strip";
  div.setAttribute("role", "group");
  div.setAttribute("aria-label", "Term suggestions for this answer");

  if (set.status === "pending") {
    div.append(mutedLine("suggesting terms for this answer (isolated executor)…"));
    return div;
  }
  if (set.status === "no-suggestions") {
    div.append(mutedLine("no term suggestions for this answer"));
    return div;
  }
  if (set.status === "budget-paused") {
    div.append(
      mutedLine(
        "auto suggestions paused — the terminology budget for this process is exhausted (zero dispatch)",
      ),
    );
    div.append(termSuggestRetryButton(set));
    div.append(
      mutedLine(
        "raise the terminology budget (restart with --terminology-budget) and retry, or select a term and explain it manually",
      ),
    );
    return div;
  }
  if (set.status === "failed") {
    const error = set.error;
    div.append(
      mutedLine(
        `term suggestions failed${error !== null && error.code !== null ? ` (${error.code})` : ""} — ${
          error !== null && error.message !== null ? error.message : "the extraction did not complete"
        }`,
      ),
    );
    div.append(termSuggestRetryButton(set));
    return div;
  }

  /* ready / partial / source-invalid：候选快照逐 chip 呈现。 */
  const snapshotOnly = set.status === "source-invalid";
  const armed = state.termSuggest;
  for (const suggestion of set.suggestions) {
    const chip = document.createElement("button");
    chip.className = "term-suggest-chip";
    chip.textContent = suggestion.term;
    if (snapshotOnly) {
      chip.disabled = true;
      chip.title = "snapshot only — the answer text changed after these suggestions; click-to-explain is disabled";
    } else {
      chip.title = "Pre-fill an explain request for this term — you confirm before it is sent";
      if (
        armed !== null &&
        armed.branchId === branchId &&
        armed.turnId === turn.id &&
        armed.start === suggestion.start &&
        armed.end === suggestion.end
      ) {
        chip.classList.add("armed");
        chip.setAttribute("aria-pressed", "true");
      }
      chip.addEventListener("click", () => {
        state.termSuggest = {
          branchId,
          turnId: turn.id,
          anchorTurnId: set.anchorTurnId,
          start: suggestion.start,
          end: suggestion.end,
          term: suggestion.term,
        };
        renderAll();
      });
    }
    div.append(chip);
  }
  if (snapshotOnly) {
    div.append(
      mutedLine("the answer text changed after these suggestions were extracted — snapshot only"),
    );
    return div;
  }
  if (set.status === "partial") {
    div.append(
      mutedLine(`+ ${String(set.hiddenCount)} more candidate${set.hiddenCount === 1 ? "" : "s"} not shown (density cap)`),
    );
  }
  /* 预填的确认条（仅武装中的建议渲染）：显式确认才发解释请求。 */
  if (armed !== null && armed.branchId === branchId && armed.turnId === turn.id) {
    const bar = document.createElement("span");
    bar.className = "term-suggest-confirm";
    const label = document.createElement("span");
    label.className = "muted";
    label.textContent = `Explain “${armed.term}”?`;
    const go = document.createElement("button");
    go.className = "term-suggest-go";
    go.textContent = "⌖ Explain";
    go.title = "Send the explain request for this suggested term (your explicit confirmation)";
    go.addEventListener("click", () => {
      const current = state.termSuggest;
      if (current === null) return;
      state.termSuggest = null;
      guard(
        () =>
          explainSelection(branchId, turn, {
            start: current.start,
            end: current.end,
            text: current.term,
          }),
        branchId === trunkBranchId() ? "main" : "panel",
      );
    });
    const dismiss = document.createElement("button");
    dismiss.className = "term-suggest-dismiss";
    dismiss.textContent = "Dismiss";
    dismiss.title = "Cancel the pre-filled explain request (nothing is sent)";
    dismiss.addEventListener("click", disarmTermSuggestion);
    bar.append(label, go, dismiss);
    div.append(bar);
  }
  return div;
}

/** 建议条的重试按钮（budget-paused/failed 的可恢复入口——显式用户动作）。 */
function termSuggestRetryButton(set) {
  const retry = document.createElement("button");
  retry.className = "term-suggest-retry";
  retry.textContent = "Retry suggestions";
  retry.title = "Re-run the suggestion extraction for this answer (your explicit action)";
  retry.addEventListener("click", () => guard(() => retryTermSuggestions(set.anchorTurnId), "panel"));
  return retry;
}

/** 解释卡的关闭按钮（工具函数：Close 文案 + 关闭语义）。 */
function termCloseButton() {
  const close = document.createElement("button");
  close.className = "term-explain-close";
  close.textContent = "Close";
  close.addEventListener("click", closeTermExplain);
  return close;
}

/** 解释卡的失败重试按钮（按卡内保存的锚点/选区重发解释请求）。 */
function termRetryButton(card) {
  const retry = document.createElement("button");
  retry.className = "term-explain-retry";
  retry.textContent = "Retry";
  retry.title = "Run the isolated explanation again";
  retry.addEventListener("click", () =>
    guard(
      () =>
        explainSelection(
          card.branchId,
          { id: card.turnId, text: "", branchId: card.branchId },
          card.selection,
        ),
      "panel",
    ),
  );
  return retry;
}

/**
 * 解释卡（渲染在对应 assistant 答案之后；issue #7 C ③ 完整状态）：
 * loading / explained（含缓存命中注记）/ saved（新建 vs 幂等命中既有；
 * 未推广 → 首问输入 + 幂等推广；已推广 → resume-or-create 明确去向）/
 * failed（诚实错误 + 重试）/ cancelled（含迟到丢弃注记）/ 推广冲突面
 * （同批注异键 → 恢复既有探索的明确去向，绝不静默复用）。
 * 进场动效只在打开的那一次渲染播放（.enter；reduced-motion 下 CSS 即时
 * 化——见 style.css）。
 */
function termExplainCard() {
  const card = state.termExplain;
  if (card === null) return null;
  const div = document.createElement("div");
  div.className = "term-explain-card";
  div.id = "term-explain-card";
  div.setAttribute("tabindex", "-1"); /* 程序聚焦目标（打开/Esc 关闭还原） */
  if (termCardEnterPending) {
    div.classList.add("enter");
    termCardEnterPending = false;
  }
  const head = document.createElement("p");
  head.className = "term-explain-head";
  const modeNote = card.mode === "term" ? "term" : "span";
  head.textContent = `⌖ Explain — “${card.selection.text}” (${modeNote}, offsets ${String(card.selection.start)}..${String(card.selection.end)})`;
  div.append(head);
  if (card.state === "loading") {
    div.append(mutedLine("explaining (isolated terminology task)…"));
    const actions = document.createElement("div");
    actions.className = "term-explain-actions";
    const dismiss = document.createElement("button");
    dismiss.className = "term-explain-close";
    dismiss.textContent = "Dismiss";
    dismiss.title = "Close the card — a late result, if any, is discarded honestly (counted in the drawer usage)";
    dismiss.addEventListener("click", closeTermExplain);
    actions.append(dismiss);
    div.append(actions);
    return div;
  }
  if (card.state === "failed") {
    div.append(mutedLine(`explanation failed — ${card.error}`));
    const actions = document.createElement("div");
    actions.className = "term-explain-actions";
    actions.append(termRetryButton(card), termCloseButton());
    div.append(actions);
    return div;
  }
  if (card.state === "cancelled") {
    const note =
      card.lateDiscard === true
        ? "cancelled — a late result arrived after the cancellation and was discarded (the request cost is still recorded)"
        : "cancelled — the explanation task was cancelled before completing";
    div.append(mutedLine(note));
    const actions = document.createElement("div");
    actions.className = "term-explain-actions";
    actions.append(termRetryButton(card), termCloseButton());
    div.append(actions);
    return div;
  }
  const body = document.createElement("p");
  body.className = "term-explain-body";
  body.textContent = card.explanation ?? "";
  div.append(body);
  if (card.state === "explained" && card.cached) {
    div.append(mutedLine("(served from the executor cache — no new request)"));
  }
  /* P0 降级显示（issue #7 增量验收）：已保存批注的卡在锚定失效时明确标注
     来源状态——卡面展示的是保存快照（批注自带的摘录/解释），活覆盖不在
     当前文本上，绝不冒充仍锚定在原文上。 */
  if (card.state === "saved" && card.annotation !== null) {
    const anchorStatus = terminologyAnchorStatus(card.annotation);
    if (anchorStatus === "changed") {
      div.append(
        mutedLine(
          "the anchored answer text has changed since this annotation was saved — this card shows the saved snapshot; no live underline is drawn on the current text",
        ),
      );
    } else if (anchorStatus === "missing") {
      div.append(mutedLine("the anchored answer is no longer in this tree — this card shows the saved snapshot"));
    }
  }
  const actions = document.createElement("div");
  actions.className = "term-explain-actions";
  if (card.state === "explained") {
    const save = document.createElement("button");
    save.className = "accent term-save";
    save.textContent = "Save as annotation";
    save.addEventListener("click", () => guard(saveTermAnnotation, "panel"));
    actions.append(save);
  } else if (card.state === "saved" && card.annotation !== null) {
    if (card.annotation.promotedBranchId === null) {
      if (card.saveOutcome === "duplicate") {
        actions.append(
          mutedLine("already saved — showing the existing annotation for this exact selection"),
        );
      }
      const label = document.createElement("span");
      label.className = "muted";
      label.textContent = "saved — promote to a follow-up branch:";
      const input = document.createElement("input");
      input.id = "term-first-question";
      input.type = "text";
      input.value = card.firstQuestion;
      input.placeholder = "First question for the follow-up branch…";
      input.addEventListener("input", () => {
        if (state.termExplain !== null) state.termExplain.firstQuestion = input.value;
      });
      const promote = document.createElement("button");
      promote.className = "accent term-promote";
      promote.textContent = card.promoting ? "Promoting…" : "⑃ Promote to branch";
      promote.disabled = card.promoting;
      promote.addEventListener("click", () => guard(promoteTermAnnotation, "panel"));
      actions.append(label, input, promote);
    } else {
      /* 已推广：resume-or-create 明确二选（issue #7 ②③——同锚点恢复或明
         确另开，绝不跨同词语境静默复用）。 */
      const note = document.createElement("span");
      note.className = "muted";
      note.textContent = `saved — already promoted to ${branchLabel(card.annotation.promotedBranchId)}`;
      actions.append(note);
      const resume = document.createElement("button");
      resume.className = "term-resume";
      resume.textContent = "Open the follow-up branch";
      resume.title = "Resume the existing exploration anchored on this exact selection";
      resume.addEventListener("click", () => {
        const cardElement = document.getElementById("term-explain-card");
        state.termExplain = null; /* 恢复既有探索即收卡（去向明确，不悬空） */
        renderAll();
        guard(
          () =>
            openBranchPanel(card.annotation.promotedBranchId, {
              trigger: { kind: "element", element: cardElement },
            }),
          "panel",
        );
      });
      actions.append(resume);
      actions.append(
        mutedLine(
          "this exact selection already has its follow-up — to start a different one, select a different span or use “⑃ Branch from selection” (a promotion is one-per-annotation by design)",
        ),
      );
    }
  }
  if (card.promotionConflict !== null) {
    const conflict = document.createElement("p");
    conflict.className = "term-explain-conflict";
    conflict.textContent = `promotion conflict — ${card.promotionConflict}`;
    div.append(conflict);
    if (card.annotation !== null && card.annotation.promotedBranchId !== null) {
      /* 刷新后的批注已呈推广事实（上方的 resume-or-create 块携带「打开既有
         支线」入口）；此处只补冲突语境，不重复渲染第二个入口。 */
      actions.append(
        mutedLine(`the recorded promotion is on ${branchLabel(card.annotation.promotedBranchId)} — use “Open the follow-up branch” above`),
      );
    }
    actions.append(mutedLine("the idempotency key stays for a same-key retry; a different follow-up needs a different promotion by design"));
  }
  actions.append(termCloseButton());
  div.append(actions);
  return div;
}

/* ------------------------------ D4-2 材料阅读（issue #8 工作包 D4-2） ------------------------------ */

/** 分块读取页大小（块数；与服务端缺省 DEFAULT_BLOCK_PAGE_LIMIT=50 同值，
    显式携带以保确定性）。 */
const MATERIAL_PAGE_LIMIT = 50;
/** 已载块窗口上限（有界 DOM：超过即从顶部裁掉最旧块——阅读是前进式活动；
    裁剪计数如实呈现，重开材料/重选版本即从头可读）。 */
const MATERIAL_MAX_LOADED_BLOCKS = 300;
/** 懒加载提前量（px）：视口底边距内容底部不足该值即预取下一页。 */
const MATERIAL_LOAD_THRESHOLD_PX = 400;
/** 阅读位置保存节流（ms）：滚动停止后落一次 PUT；关闭/切版本/切树时立即
    冲刷（charter §3.2「原文阅读与分支探索各自保留位置」——阅读位置走
    服务端 reading-position 行，与对话的 scrollPositions 互不覆盖）。 */
const MATERIAL_POSITION_SAVE_DEBOUNCE_MS = 1500;
/** PDF 分块读取页大小（页数——pdf 的块即页；小于 markdown 页：大 PDF 首屏
    只取少量页，B6 的 2s 首屏目标依赖小步分页）。 */
const PDF_PAGE_FETCH_LIMIT = 10;
/** PDF 懒渲染提前量（px）：页框落在 [视口顶 - 该值, 视口底 + 该值] 才渲染
    文本层；远页保持占位（charter §3.2：可见页先行渲染）。 */
const PDF_PAGE_RENDER_OVERSCAN_PX = 1200;
/** PDF 懒渲染的几何未知回落（滚动容器 clientHeight 为 0——脚本桩/未布局）：
    只渲染前导若干页，绝不在几何不明时整册渲染。 */
const PDF_LEADING_RENDER_PAGES = 6;

/** 材料读模型世代号（P1 同族纪律：写 state.materials 前双验证——请求树 +
    世代号；切树后迟到的旧树响应整包丢弃，绝不把 A 树的材料写进 B 树）。 */
let materialsEpoch = 0;
/** 阅读器世代号（打开/切版本/刷新 detail 各递增）：迟到的 detail/分页
    响应（已切材料/切版本/切树/已关闭）按世代丢弃。 */
let materialReaderEpoch = 0;
/** 阅读位置节流 timer（关闭/切版本时冲刷）。 */
let materialPositionTimer = null;
/** 阅读器进出场动画收尾 timer（M1/M2 契约同 panel/drawer）。 */
let materialReaderAnimTimer = null;
const MATERIAL_READER_ENTER_MS = 240; /* CSS 180ms + 收尾余量 */
const MATERIAL_READER_EXIT_MS = 170;
/** 拖拽窗口内被延后的阅读器 chrome 重渲（mouseup 后与整树重渲一起冲刷）。 */
let materialPendingUpdate = false;
/* 捕获条专属的延后更新（拖拽窗口冻结置位）：冲刷走就地 updateMatSelectionBar
 * ——不整建 chrome（renderMaterialReader 的 detach 会丢 Chrome 的原生选区
 * 高亮，连续拖选后高亮消失的实测根因；DOM 桩的选区跨 detach 存活，测不出）。 */
let materialBarPendingUpdate = false;
/** 阅读器关闭时的焦点还原引用。 @type {FocusReturnRefT|null} */
let materialReaderFocusReturn = null;
/** 材料列表按钮注册表（materialId → 按钮）：阅读器关闭的焦点还原目标。 */
const materialListButtons = new Map();

/** 材料列表三态渲染（侧栏 Materials 段；renderAll 与刷新路径共用幂等）。 */
function renderMaterialsSection() {
  const section = $("materials-section");
  const list = $("material-list");
  materialListButtons.clear();
  if (state.treeState === null || state.currentTreeId === null) {
    section.hidden = true;
    list.replaceChildren();
    return;
  }
  section.hidden = false;
  const materials = state.materials;
  if (materials === null) {
    list.replaceChildren(mutedListItem("loading materials…"));
    return;
  }
  if (!materials.ok) {
    /* 拉取失败：常驻错误 + 重试（与树列表加载失败同款纪律——绝不折叠成
       空列表伪装成“无材料”）。 */
    const li = document.createElement("li");
    li.className = "muted";
    li.append(document.createTextNode(`materials failed to load — ${materials.error} `));
    const retry = document.createElement("button");
    retry.className = "drawer-retry";
    retry.textContent = "Retry";
    retry.title = "Fetch the material list again";
    retry.addEventListener("click", () => void refreshMaterials());
    li.append(retry);
    list.replaceChildren(li);
    return;
  }
  if (materials.materials.length === 0) {
    list.replaceChildren(
      mutedListItem(
        "no materials linked to this tree yet — import a .md, .markdown or .pdf file with the import entry above; " +
          "imported materials appear here",
      ),
    );
    return;
  }
  const items = [];
  for (const entry of materials.materials) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.dataset.materialId = entry.material.id;
    if (state.materialReader !== null && state.materialReader.materialId === entry.material.id) {
      button.classList.add("active");
    }
    const name = document.createElement("span");
    name.textContent = entry.material.title;
    button.append(name, materialStatusMeta(entry.versions));
    button.title = `open ${entry.material.title} in the material reader`;
    button.addEventListener("click", () => {
      closeSidebar(); /* 窄窗：选材料后收起侧栏抽屉（与树选择同一纪律） */
      void openMaterial(entry.material.id, {
        trigger: { kind: "material-button", materialId: entry.material.id },
      });
    });
    materialListButtons.set(entry.material.id, button);
    li.append(button);
    items.push(li);
  }
  list.replaceChildren(...items);
}

/** 列表状态行（li.muted 通用件）。 */
function mutedListItem(text) {
  const li = document.createElement("li");
  li.className = "muted";
  li.textContent = text;
  return li;
}

/** 列表项状态行：以最新版本为列表事实（版本链在阅读器内完整呈现）；最新
    版本非 ready 时如实带原因码（截断保持列表安静，title 携全文），并标注
    仍有旧 ready 版本可读（绝不把失败伪装成可读，也绝不因失败隐藏旧版）。 */
function materialStatusMeta(versions) {
  const meta = document.createElement("span");
  meta.className = "material-meta";
  if (versions.length === 0) {
    meta.textContent = "no versions recorded";
    return meta;
  }
  const latest = versions[versions.length - 1];
  const status = document.createElement("span");
  status.className = `material-status ${latest.parseStatus}`;
  if (typeof latest.parseError === "string" && latest.parseError !== "") {
    const reason =
      latest.parseError.length > 90 ? `${latest.parseError.slice(0, 90)}…` : latest.parseError;
    status.textContent = `${latest.parseStatus}: ${reason}`;
    status.title = latest.parseError;
  } else {
    status.textContent = latest.parseStatus;
  }
  meta.append(document.createTextNode(`${latest.parserKind} · v${String(versions.length)} · `), status);
  if (latest.parseStatus !== "ready") {
    for (let i = versions.length - 2; i >= 0; i -= 1) {
      if (versions[i].parseStatus === "ready") {
        meta.append(document.createTextNode(` · v${String(i + 1)} ready (older, readable)`));
        break;
      }
    }
  }
  return meta;
}

/** 材料列表拉取（开树/重试共用；三态 + 迟到丢弃守卫在写点）。 */
async function refreshMaterials() {
  if (state.currentTreeId === null) return;
  const treeId = state.currentTreeId;
  const epoch = ++materialsEpoch;
  try {
    const payload = await api(`/api/trees/${encodeURIComponent(treeId)}/materials`);
    if (epoch !== materialsEpoch || state.currentTreeId !== treeId) return; /* 迟到丢弃 */
    state.materials = { ok: true, materials: payload.materials };
  } catch (err) {
    if (epoch !== materialsEpoch || state.currentTreeId !== treeId) return; /* 迟到丢弃 */
    state.materials = { ok: false, error: String(err && err.message ? err.message : err) };
  }
  renderMaterialsSection();
}

/* ------------------------------ D4-2 用户导入 UI（issue #8 owner P1） ------------------------------ */

/**
 * 导入状态（模块级——导入跨列表重渲持续；HTML 里的静态导入行/状态行由
 * updateMaterialImportStatus 就地更新，renderMaterialsSection 只管列表）。
 * @type {null|{
 *   phase: "uploading"|"parsing"|"terminal"|"failed",
 *   filename: string,
 *   materialId: string|null,
 *   versionId: string|null,
 *   parseTaskId: string|null,
 *   dedup: boolean,
 *   inFlightStatus: "pending"|"parsing"|null,
 *   terminalStatus: "ready"|"failed"|"canceled"|"unsupported"|"rejected"|null,
 *   terminalError: string|null,
 *   dedupVersionLabel: string|null,
 *   error: string|null,
 *   uploadTreeId: string|null
 * }}
 */
let materialImport = null;
/** 解析轮询 timer（pending/parsing 期间每 1.5s 查一次 detail——服务端无
    推送，轮询是如实拿到终态的途径；终态/取消/失败即停）。 */
let materialImportPollTimer = null;
const MATERIAL_IMPORT_POLL_MS = 1500;

/** 静态导入 UI 注册（真实文件选择器：input[type=file] 的 change 事件——
    浏览器原生对话框；同一文件可重复导入——每次处理后清空 input.value）。 */
function registerMaterialImportUi() {
  const button = $("material-import");
  const input = $("material-import-input");
  button.addEventListener("click", () => {
    input.click();
  });
  input.addEventListener("change", () => {
    const file = input.files !== undefined && input.files !== null && input.files.length > 0 ? input.files[0] : null;
    /* 选同一文件再次导入是合法路径（重导即服务端去重——如实呈现）；清空
       value 让同名文件也能再次触发 change。 */
    input.value = "";
    if (file === null) return;
    void importMaterialFile(file);
  });
}

/** 导入入口（owner P1「真正的文件导入 UI」）：原始字节 + 文件名头——与
    D4-1 HTTP 面和浏览器探针同一语义（x-treeai-filename 百分号编码 +
    application/octet-stream + 原始字节 body）。中文/空格文件名经编码头
    原样到达。上传中一次一条（重复点击如实拒绝，不排队伪装）。 */
async function importMaterialFile(file) {
  const treeId = state.currentTreeId;
  if (treeId === null) return;
  if (materialImport !== null && materialImport.phase === "uploading") {
    materialImport = {
      ...materialImport,
      phase: "failed",
      error: "an import is already in flight — wait for it to finish before importing another file",
    };
    updateMaterialImportStatus();
    return;
  }
  const filename = typeof file.name === "string" ? file.name : "";
  materialImport = {
    phase: "uploading",
    filename,
    materialId: null,
    versionId: null,
    parseTaskId: null,
    dedup: false,
    inFlightStatus: null,
    terminalStatus: null,
    terminalError: null,
    dedupVersionLabel: null,
    error: null,
    uploadTreeId: treeId,
  };
  updateMaterialImportStatus();
  let bytes = null;
  try {
    bytes = typeof file.arrayBuffer === "function" ? await file.arrayBuffer() : null;
  } catch (err) {
    bytes = null;
    materialImport = { ...materialImport, phase: "failed", error: `reading the file failed — ${String(err && err.message ? err.message : err)}` };
  }
  if (bytes === null) {
    if (materialImport.phase !== "failed") {
      materialImport = { ...materialImport, phase: "failed", error: "the file could not be read in this browser" };
    }
    updateMaterialImportStatus();
    return;
  }
  try {
    const payload = await importMaterialViaHttp(treeId, filename, bytes);
    if (state.currentTreeId !== treeId || materialImport === null || materialImport.phase !== "uploading") {
      return; /* 切树/状态被取代：迟到响应丢弃 */
    }
    if (payload.created !== true) {
      /* 同字节去重（D4-1 服务端语义）：如实「没有新版本」——绝不动声色地
         伪装成又一次成功导入。版本标签按列表事实换算（列表已刷新后查得）。 */
      await refreshMaterials();
      const label = materialImportDedupVersionLabel(payload);
      materialImport = {
        phase: "terminal",
        filename,
        materialId: payload.material !== undefined && payload.material !== null ? String(payload.material.id) : null,
        versionId: payload.version !== undefined && payload.version !== null ? String(payload.version.id) : null,
        parseTaskId: null,
        dedup: true,
        inFlightStatus: null,
        terminalStatus: null,
        terminalError: null,
        dedupVersionLabel: label,
        error: null,
        uploadTreeId: treeId,
      };
      updateMaterialImportStatus();
      return;
    }
    materialImport = {
      phase: "parsing",
      filename,
      materialId: payload.material !== undefined && payload.material !== null ? String(payload.material.id) : null,
      versionId: payload.version !== undefined && payload.version !== null ? String(payload.version.id) : null,
      parseTaskId:
        payload.parseTaskId !== undefined && payload.parseTaskId !== null ? String(payload.parseTaskId) : null,
      dedup: false,
      inFlightStatus:
        payload.version !== undefined &&
        payload.version !== null &&
        (payload.version.parseStatus === "pending" || payload.version.parseStatus === "parsing")
          ? payload.version.parseStatus
          : null,
      terminalStatus: null,
      terminalError: null,
      dedupVersionLabel: null,
      error: null,
      uploadTreeId: treeId,
    };
    updateMaterialImportStatus();
    void refreshMaterials();
    startMaterialImportPolling();
  } catch (err) {
    if (state.currentTreeId !== treeId) return;
    materialImport = {
      ...materialImport,
      phase: "failed",
      error: String(err && err.message ? err.message : err),
    };
    updateMaterialImportStatus();
  }
}

/** 导入 HTTP（与 scripts/d4/browser/material-probes.mjs 的
    importMaterialViaHttp 同一头/字节语义——浏览器 UI 与探针走同一面）。 */
async function importMaterialViaHttp(treeId, filename, bytes) {
  const response = await fetch(`/api/trees/${encodeURIComponent(treeId)}/materials`, {
    method: "POST",
    headers: { "x-treeai-filename": encodeURIComponent(filename), "content-type": "application/octet-stream" },
    body: bytes,
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    /* non-JSON error body */
  }
  if (!response.ok) {
    const message =
      payload !== null && payload.error !== undefined
        ? `${payload.error.code}: ${payload.error.message}`
        : `HTTP ${String(response.status)}`;
    const error = new Error(message);
    if (payload !== null && payload.error !== undefined && typeof payload.error.code === "string") {
      error.code = payload.error.code;
    }
    throw error;
  }
  return payload;
}

/** 去重消息的版本标签（v 序号——按导入响应的材料在当前列表中的版本链
    换算；列表未含该材料（异常）→ 如实退回 versionId 原文）。 */
function materialImportDedupVersionLabel(payload) {
  const versionId = payload.version !== undefined && payload.version !== null ? String(payload.version.id) : null;
  if (versionId === null) return null;
  const materials = state.materials !== null && state.materials.ok ? state.materials.materials : [];
  const entry = materials.find(
    (candidate) =>
      payload.material !== undefined &&
      payload.material !== null &&
      candidate.material.id === String(payload.material.id),
  );
  if (entry === undefined) return null;
  const index = entry.versions.findIndex((candidate) => candidate.id === versionId);
  return index < 0 ? null : `v${String(index + 1)}`;
}

/** 解析轮询（pending/parsing 的如实终态获取）。 */
function startMaterialImportPolling() {
  stopMaterialImportPolling();
  materialImportPollTimer = window.setInterval(() => {
    void pollMaterialImportStatus();
  }, MATERIAL_IMPORT_POLL_MS);
}

function stopMaterialImportPolling() {
  if (materialImportPollTimer !== null) {
    window.clearInterval(materialImportPollTimer);
    materialImportPollTimer = null;
  }
}

/** 轮询/显式 Refresh 共用：拉 detail，按版本终态更新导入状态面。 */
async function pollMaterialImportStatus() {
  const current = materialImport;
  if (current === null || current.phase !== "parsing") return;
  const treeId = state.currentTreeId;
  if (treeId === null || current.materialId === null || current.uploadTreeId !== treeId) {
    stopMaterialImportPolling();
    return;
  }
  try {
    const detail = await api(
      `/api/trees/${encodeURIComponent(treeId)}/materials/${encodeURIComponent(current.materialId)}`,
    );
    if (materialImport !== current || state.currentTreeId !== treeId) return; /* 迟到丢弃 */
    const version =
      detail.versions.find((candidate) => candidate.id === current.versionId) ?? null;
    if (version === null) return; /* 版本不在链（异常）：保持轮询，下轮再查 */
    if (version.parseStatus === "pending" || version.parseStatus === "parsing") {
      materialImport = { ...current, inFlightStatus: version.parseStatus, terminalStatus: null, terminalError: null };
      updateMaterialImportStatus();
      return;
    }
    /* 终态：ready/failed/canceled/unsupported/rejected——原因逐字呈现。 */
    stopMaterialImportPolling();
    materialImport = {
      ...current,
      phase: "terminal",
      terminalStatus: version.parseStatus,
      terminalError:
        typeof version.parseError === "string" && version.parseError !== "" ? version.parseError : null,
    };
    updateMaterialImportStatus();
    void refreshMaterials();
  } catch (err) {
    /* 轮询失败如实注记，保持轮询（解析事实未到，不伪装终态）。 */
    materialImport = { ...current, error: `checking the parse status failed — ${String(err && err.message ? err.message : err)}` };
    updateMaterialImportStatus();
  }
}

/** 取消在途解析（POST parse-tasks/:taskId/cancel——服务端行级仲裁：先落
    库者赢）。409（已终态）→ 立即查一次状态（终态如实呈现）。 */
async function cancelMaterialImportParse() {
  const current = materialImport;
  if (current === null || current.phase !== "parsing" || current.parseTaskId === null) return;
  const treeId = state.currentTreeId;
  if (treeId === null || current.materialId === null) return;
  try {
    await api(
      `/api/trees/${encodeURIComponent(treeId)}/materials/${encodeURIComponent(current.materialId)}` +
        `/parse-tasks/${encodeURIComponent(current.parseTaskId)}/cancel`,
      "POST",
    );
  } catch (err) {
    if (err !== null && typeof err === "object" && err.code === "parse-task-not-cancelable") {
      /* 已终态（409）：立即刷新状态面——迟到点击如实落位。 */
      await pollMaterialImportStatus();
      return;
    }
    if (materialImport === current) {
      materialImport = { ...current, error: `canceling the parse failed — ${String(err && err.message ? err.message : err)}` };
      updateMaterialImportStatus();
    }
    return;
  }
  stopMaterialImportPolling();
  if (materialImport === null || materialImport.phase !== "parsing") return;
  materialImport = {
    ...materialImport,
    phase: "terminal",
    terminalStatus: "canceled",
    terminalError: null,
  };
  updateMaterialImportStatus();
  void refreshMaterials();
}

/** 导入状态面（静态行 #material-import-status 就地更新；状态/原因/操作
    全部如实——pending/parsing/ready/failed/rejected/canceled/去重/上传失败）。 */
function updateMaterialImportStatus() {
  const status = document.getElementById("material-import-status");
  if (status === null) return;
  status.replaceChildren();
  const current = materialImport;
  if (current === null) return;
  const text = (content, extraClass = "") => {
    const span = document.createElement("span");
    if (extraClass !== "") span.className = extraClass;
    span.textContent = content;
    status.append(span);
    return span;
  };
  const action = (label, title, onClick, className) => {
    const button = document.createElement("button");
    button.className = className;
    button.textContent = label;
    button.title = title;
    button.addEventListener("click", onClick);
    status.append(button);
    return button;
  };
  if (current.phase === "uploading") {
    text(`importing “${current.filename}”…`, "mat-import-note");
    return;
  }
  if (current.phase === "parsing") {
    const statusPart = current.inFlightStatus === null ? "" : ` (server status: ${current.inFlightStatus})`;
    text(`“${current.filename}” imported — parsing${statusPart}…`, "mat-import-note");
    if (current.error !== null) text(` (${current.error})`, "mat-import-error");
    action(
      "Cancel parse",
      "Cancel the in-flight parse task (the version stays canceled; re-import the file to try again)",
      () => void cancelMaterialImportParse(),
      "mat-import-cancel",
    );
    action(
      "Check now",
      "Check the parse status immediately (also refreshes automatically)",
      () => void pollMaterialImportStatus(),
      "mat-import-refresh",
    );
    return;
  }
  if (current.phase === "failed") {
    text(`importing “${current.filename}” failed — ${current.error ?? "unknown error"}`, "mat-import-error");
    return;
  }
  /* terminal */
  if (current.dedup) {
    const label = current.dedupVersionLabel === null ? (current.versionId ?? "an existing version") : current.dedupVersionLabel;
    text(
      `“${current.filename}” was not imported again — these exact bytes are already ${label} of this material ` +
        "(the server reused the existing version; no new version was created)",
      "mat-import-note",
    );
    return;
  }
  if (current.terminalStatus === "ready") {
    text(`“${current.filename}” is ready — it is in the list below.`, "mat-import-note");
    if (current.materialId !== null) {
      action(
        "Open in reader",
        "Open the imported material in the material reader",
        () => {
          closeSidebar();
          void openMaterial(current.materialId, { trigger: { kind: "element", element: $("material-import") } });
        },
        "mat-import-open",
      );
    }
    return;
  }
  if (current.terminalStatus === "canceled") {
    text(
      `the parse of “${current.filename}” was canceled — the version stays canceled (nothing is faked as parsed); ` +
        "import the file again to retry",
      "mat-import-error",
    );
    return;
  }
  if (current.terminalStatus !== null) {
    /* failed / unsupported / rejected：原因逐字（服务端 parseError 原文）。 */
    const reason = current.terminalError !== null ? ` — ${current.terminalError}` : "";
    text(
      `“${current.filename}” did not parse: ${current.terminalStatus}${reason}. ` +
        "The original file is kept as imported; an older ready version (if any) stays readable.",
      "mat-import-error",
    );
    return;
  }
  text(`import of “${current.filename}” finished.`, "mat-import-note");
}

/** 导入面复位（切树时调用：在途轮询停止、状态清空——不同树的导入事实
    不跨树残留）。 */
function resetMaterialImport() {
  stopMaterialImportPolling();
  materialImport = null;
  updateMaterialImportStatus();
}

/** 打开材料阅读器。幂等：同一材料已在读（且非失败态）只聚焦；换材料先把
    当前阅读位置落库（旧材料的事实不因切换丢失）。打开是异步的——先立
    loading 壳，detail 到达后选版本并拉首页；全程按世代丢弃迟到响应。
    D4-4 搜索命中跳转：opts.versionId 显式指定命中版本（旧版本命中即打开
    旧版本——版本诚实同 D4-2，绝不静默落到最新）；opts.focusBlockId 定位
    到命中块（与阅读位置恢复同一跨页前补循环）。命中版本已不在版本链
    （版本行不可变，正常不可能）时如实回落默认选择并注记，不伪装。 */
async function openMaterial(materialId, opts = {}) {
  if (state.currentTreeId === null) return;
  if (
    state.materialReader !== null &&
    state.materialReader.materialId === materialId &&
    state.materialReader.firstPageState !== "failed" &&
    opts.versionId === undefined
  ) {
    $("material-reader").focus();
    return;
  }
  if (state.materialReader !== null) {
    /* 换材料：先把当前阅读位置落库（旧材料的事实不因切换丢失），并清空
       既有块容器——blockId 序列（blk-N）跨材料重名，绝不能移用上一份的
       块元素。 */
    saveMaterialReadingPositionNow();
    const previousBlocks = document.getElementById("mat-blocks");
    if (previousBlocks !== null) previousBlocks.replaceChildren();
  }
  const treeId = state.currentTreeId;
  const epoch = ++materialReaderEpoch;
  state.materialSelection = null;
  state.materialReader = {
    materialId,
    material: { id: materialId, title: "", createdAt: "" },
    versions: [],
    versionId: "",
    readingPosition: null,
    blocks: [],
    nextAfterBlock: null,
    textUnits: 0,
    firstPageState: "loading",
    firstPageError: null,
    appendState: "idle",
    appendError: null,
    fenceOpen: false,
    trimmedBlocks: 0,
    restoredToBlockId: null,
    lastSavedBlockId: null,
    searchJump:
      opts.versionId !== undefined
        ? {
            blockId: opts.focusBlockId ?? null,
            versionId: opts.versionId,
            fellBackToDefaultVersion: false,
            arrival: opts.arrival === "return-source" ? "return-source" : "search",
          }
        : null,
  };
  materialReaderFocusReturn = opts.trigger ?? { kind: "material-button", materialId };
  renderMaterialReader();
  showMaterialReader();
  $("material-reader").focus();
  try {
    const detail = await api(
      `/api/trees/${encodeURIComponent(treeId)}/materials/${encodeURIComponent(materialId)}`,
    );
    if (
      epoch !== materialReaderEpoch ||
      state.materialReader === null ||
      state.materialReader.materialId !== materialId ||
      state.currentTreeId !== treeId
    ) {
      return; /* 迟到丢弃：已切材料/切树/关闭 */
    }
    const reader = state.materialReader;
    reader.material = detail.material;
    reader.versions = detail.versions;
    reader.readingPosition = detail.readingPosition ?? null;
    let version = null;
    if (reader.searchJump !== null) {
      /* 搜索命中跳转：命中版本优先（旧版本命中打开旧版本）；版本已不在
         链上（不可变版本行，正常不可能）→ 如实回落 + 注记（绝不伪装）。 */
      version = detail.versions.find((candidate) => candidate.id === reader.searchJump.versionId) ?? null;
      if (version === null) reader.searchJump.fellBackToDefaultVersion = true;
    }
    if (version === null) version = chooseMaterialVersion(detail);
    reader.versionId = version === null ? "" : version.id;
    await loadMaterialFirstPage(reader, { epoch, treeId });
  } catch (err) {
    if (
      epoch !== materialReaderEpoch ||
      state.materialReader === null ||
      state.materialReader.materialId !== materialId ||
      state.currentTreeId !== treeId
    ) {
      return;
    }
    state.materialReader.firstPageState = "failed";
    state.materialReader.firstPageError = String(err && err.message ? err.message : err);
    renderMaterialReader();
  }
}

/**
 * 首版选择（charter §1「隔天回来能找到原文」）：保存过阅读位置且该版本
 * 仍可读（ready——markdown 与 PDF 都支持位置恢复）→ 恢复到该版本；否则
 * 最新版本（其状态——含失败——在阅读器内如实呈现，不因失败静默回落
 * 旧版：列表与版本链都标明旧 ready 版本可读，切换是显式动作）。
 */
function chooseMaterialVersion(detail) {
  const versions = detail.versions;
  if (versions.length === 0) return null;
  const position = detail.readingPosition;
  if (position !== null) {
    const saved = versions.find((version) => version.id === position.versionId) ?? null;
    if (saved !== null && saved.parseStatus === "ready") {
      return saved;
    }
  }
  return versions[versions.length - 1];
}

/** 阅读器当前版本对象（版本链内按 versionId 查找；不在链 → null）。 */
function materialReaderVersion(reader) {
  return reader.versions.find((candidate) => candidate.id === reader.versionId) ?? null;
}

/** 当前阅读版本是否 PDF（页块渲染/懒分页/单页选区纪律的判定源）。 */
function materialReaderIsPdf(reader) {
  const version = materialReaderVersion(reader);
  return version !== null && version.parserKind === "pdf";
}

/** 首页加载（含位置恢复的跨页前补）：非 ready 版本不取块——状态面如实
    呈现（409 material-not-ready 的竞态也经 catch 落入同一失败面）；ready
    的 markdown 与 PDF 版本都取块（PDF 的块即页——页框按懒渲染纪律落位）。 */
async function loadMaterialFirstPage(reader, opts) {
  const { epoch, treeId } = opts;
  const version = reader.versions.find((candidate) => candidate.id === reader.versionId) ?? null;
  const isStale = () =>
    epoch !== materialReaderEpoch || state.materialReader !== reader || state.currentTreeId !== treeId;
  if (version === null || version.parseStatus !== "ready") {
    reader.firstPageState = "loaded";
    renderMaterialReader();
    return;
  }
  reader.firstPageState = "loading";
  reader.firstPageError = null;
  renderMaterialReader();
  /* 恢复/定位目标：D4-4 搜索命中跳转优先（用户刚点击的意图）；无跳转时
     按保存的阅读位置恢复。目标块不在首页则按 nextAfterBlock 向前补页
     （API 只有正向分页——循环以块总数为上界，长材料上是诚实代价；目标
     块出现即停）。 */
  const position = reader.readingPosition;
  const restoreBlockId =
    position !== null && position.versionId === reader.versionId && position.blockId !== null
      ? position.blockId
      : null;
  const jumpBlockId =
    reader.searchJump !== null && reader.searchJump.blockId !== null ? reader.searchJump.blockId : null;
  const targetBlockId = jumpBlockId ?? restoreBlockId;
  let afterBlock = null;
  for (;;) {
    let page;
    try {
      page = await fetchMaterialPage(reader, treeId, afterBlock);
    } catch (err) {
      if (isStale()) return;
      reader.firstPageState = "failed";
      reader.firstPageError = String(err && err.message ? err.message : err);
      renderMaterialReader();
      return;
    }
    if (isStale()) return;
    applyMaterialPage(reader, page);
    if (targetBlockId === null || page.nextAfterBlock === null) break;
    if (reader.blocks.some((entry) => entry.block.blockId === targetBlockId)) break;
    afterBlock = page.nextAfterBlock;
  }
  reader.firstPageState = "loaded";
  /* 先定注记再单次渲染，滚动放最后：原顺序（渲染→滚动→为注记再渲染）
     会在平滑滚动进行中 detach 块容器——Chrome 取消滚动并把 scrollTop 归
     0（实测 0 vs 7208），重渲染的保位恢复也救不回已取消的动画。 */
  if (jumpBlockId !== null) {
    /* 搜索命中定位注记（chrome 渲染时读取 searchJump——已由调用方设定，
       不与位置恢复注记混写）。 */
  } else {
    reader.restoredToBlockId = restoreBlockId;
  }
  renderMaterialReader();
  if (targetBlockId !== null) {
    const target = materialBlockElement(targetBlockId);
    if (target !== null && typeof target.scrollIntoView === "function") {
      /* 恢复/命中跳转用即时滚动：平滑滚动是异步动画，其后任何重渲的
         detach 都会取消动画并丢 scrollTop（真实 Chrome 实测 183/7208）；
         即时落位同步生效，配合渲染保位跨重渲稳定。 */
      target.scrollIntoView({ block: "start", behavior: "auto" });
      /* PDF：先按当前几何重估懒渲染窗口，再显式渲染跳转目标页（目标即
         已可见；真实浏览器 scrollIntoView 后的 scroll 事件会自然重估，
         脚本桩无事件——顺序保证目标页绝不被重估卸回占位）。 */
      updatePdfPageRendering(reader);
      renderPdfPageTextIn(target);
    }
  }
}

/** 分块读取请求（显式 limit=页大小；afterBlock 为下一页游标）。PDF 用
    更小的页步（PDF_PAGE_FETCH_LIMIT——大 PDF 首屏只取少量页）。 */
async function fetchMaterialPage(reader, treeId, afterBlock) {
  const limit = materialReaderIsPdf(reader) ? PDF_PAGE_FETCH_LIMIT : MATERIAL_PAGE_LIMIT;
  let path =
    `/api/trees/${encodeURIComponent(treeId)}/materials/${encodeURIComponent(reader.materialId)}` +
    `/versions/${encodeURIComponent(reader.versionId)}?limit=${String(limit)}`;
  if (afterBlock !== null) {
    path += `&afterBlock=${encodeURIComponent(afterBlock)}`;
  }
  return api(path);
}

/** 一页数据落地：窗口数据（reader.blocks）+ DOM 追加 + 顶部裁剪 + 尾部态
    + PDF 懒渲染窗口重估（可见页先行渲染）。 */
function applyMaterialPage(reader, page) {
  for (const entry of page.blocks) reader.blocks.push(entry);
  reader.nextAfterBlock = page.nextAfterBlock;
  reader.textUnits = page.textUnits;
  appendMaterialBlockElements(reader);
  trimMaterialWindow(reader);
  updatePdfPageRendering(reader);
  updateMatTail();
}

/** 追加缺失块元素（页序即 DOM 序；复用既有元素——懒加载/重渲不换走已读
    块，选区期间的元素身份稳定）。markdown 块与 PDF 页框都是 #mat-blocks
    的直接子元素，以 data-block-id 判存在。 */
function appendMaterialBlockElements(reader) {
  const blocksEl = document.getElementById("mat-blocks");
  if (blocksEl === null) return;
  const present = new Set();
  for (const child of blocksEl.children) {
    if (isElementNode(child) && child.dataset.blockId !== undefined) {
      present.add(child.dataset.blockId);
    }
  }
  for (const entry of reader.blocks) {
    if (present.has(entry.block.blockId)) continue;
    blocksEl.append(renderMaterialBlockElement(entry, reader));
  }
}

/** 有界窗口：已载块超上限时从顶部同步裁掉最旧块（数据 + DOM 一起——
    reader.blocks 即当前窗口，偏移换算/位置保存都以在场块为事实）。裁剪
    调整 scrollTop 保持视觉位置（真实浏览器按被裁元素实高；脚本桩高度为
    0 → 调整量为 0，确定性）。 */
function trimMaterialWindow(reader) {
  const blocksEl = document.getElementById("mat-blocks");
  if (blocksEl === null) return;
  const over = reader.blocks.length - MATERIAL_MAX_LOADED_BLOCKS;
  if (over <= 0) return;
  let removedHeight = 0;
  let removed = 0;
  while (removed < over && reader.blocks.length > 0) {
    const [entry] = reader.blocks;
    const element = materialBlockElement(entry.block.blockId);
    if (element !== null) {
      removedHeight += typeof element.offsetHeight === "number" ? element.offsetHeight : 0;
      blocksEl.removeChild(element);
    }
    reader.blocks.shift();
    reader.trimmedBlocks += 1;
    removed += 1;
  }
  if (removedHeight > 0 && blocksEl.scrollTop > 0) {
    blocksEl.scrollTop = Math.max(0, blocksEl.scrollTop - removedHeight);
  }
}

/** 块元素按 blockId 查找（stub 查询引擎只支持 id/class/tag——不用属性
    选择器，遍历即兼容）。 */
function materialBlockElement(blockId) {
  const blocksEl = document.getElementById("mat-blocks");
  if (blocksEl === null) return null;
  for (const child of blocksEl.children) {
    if (isElementNode(child) && child.dataset.blockId === blockId) return child;
  }
  return null;
}

/** 懒加载：贴底（提前量内）且有下一页 → 预取。滚动触发与尾部按钮共用。 */
function maybeLoadMoreMaterialBlocks(blocksEl) {
  const reader = state.materialReader;
  if (reader === null) return;
  if (reader.nextAfterBlock === null) return;
  if (reader.appendState === "loading" || reader.firstPageState !== "loaded") return;
  const threshold =
    blocksEl.scrollHeight - blocksEl.clientHeight - MATERIAL_LOAD_THRESHOLD_PX;
  if (blocksEl.scrollTop < threshold) return;
  void loadMoreMaterialBlocks();
}

/** 追加下一页（世代守卫：迟到响应绝不写进已切换的阅读器）。 */
async function loadMoreMaterialBlocks() {
  const reader = state.materialReader;
  const treeId = state.currentTreeId;
  if (reader === null || treeId === null) return;
  if (reader.nextAfterBlock === null || reader.appendState === "loading" || reader.firstPageState !== "loaded") {
    return;
  }
  const epoch = materialReaderEpoch;
  const afterBlock = reader.nextAfterBlock;
  reader.appendState = "loading";
  reader.appendError = null;
  updateMatTail();
  try {
    const page = await fetchMaterialPage(reader, treeId, afterBlock);
    if (epoch !== materialReaderEpoch || state.materialReader !== reader || state.currentTreeId !== treeId) {
      return;
    }
    applyMaterialPage(reader, page);
    reader.appendState = "idle";
  } catch (err) {
    if (epoch !== materialReaderEpoch || state.materialReader !== reader || state.currentTreeId !== treeId) {
      return;
    }
    reader.appendState = "failed";
    reader.appendError = String(err && err.message ? err.message : err);
  }
  updateMatTail();
}

/**
 * 阅读器 chrome 全量渲染（打开/切版本/状态刷新）。块容器 #mat-blocks 的
    **元素身份跨重渲保留**（先取引用，replaceChildren 后移回——子树不动），
    异步刷新对已载块零触碰；选区捕获条与尾部分别有就地更新函数（武装/
    翻页不整建 chrome）。拖拽窗口内延后（③ 同族：选择期间不重绘）。
 */
function renderMaterialReader() {
  const reader = state.materialReader;
  const root = $("material-reader");
  if (reader === null) {
    root.replaceChildren();
    root.hidden = true;
    return;
  }
  if (state.selectionDragActive) {
    materialPendingUpdate = true;
    return;
  }
  const preservedBlocks = document.getElementById("mat-blocks");
  /* Chrome 丢弃被 detach 的滚动容器的 scrollTop（实测 5464→0；DOM 桩的
     scrollTop 跨 detach 存活，桩测不出）。重渲染保持滚动位置——位置恢复/
     注记补渲不再把视口拉回顶部。内容合法重置的路径（打开新材料前已清空
     子元素）scrollTop 自然归 0，不受影响。 */
  const preservedScrollTop = preservedBlocks === null ? null : preservedBlocks.scrollTop;
  root.replaceChildren();

  /* 头部：标题 + 关闭（覆盖层打开时盖住侧栏入口，阅读器内需要可见关闭）。 */
  const head = document.createElement("div");
  head.className = "mat-head";
  const title = document.createElement("h2");
  title.className = "mat-title";
  title.textContent = reader.material.title === "" ? reader.materialId : reader.material.title;
  const close = document.createElement("button");
  close.id = "mat-close";
  close.className = "mat-close";
  close.textContent = "× Close";
  close.title = "Close the material reader (Esc) — your reading position is saved";
  close.addEventListener("click", () => closeMaterialReader());
  head.append(title, close);
  root.append(head);

  /* 元信息行：所渲染版本可辨认（charter §3.1）——版本号/新旧、解析器
     版本、导入时间、规范文本长度。 */
  const version = reader.versions.find((candidate) => candidate.id === reader.versionId) ?? null;
  const meta = document.createElement("div");
  meta.className = "mat-meta";
  if (version === null) {
    meta.textContent = reader.versions.length === 0 ? "no versions recorded" : "";
  } else {
    const number = materialVersionNumber(reader.versions, version.id);
    const isLatest = reader.versions[reader.versions.length - 1].id === version.id;
    const label = document.createElement("span");
    label.className = `mat-version-label${isLatest ? "" : " old"}`;
    label.textContent = isLatest
      ? `v${String(number)} (current)`
      : `v${String(number)} (older — v${String(reader.versions.length)} is current)`;
    meta.append(label);
    meta.append(
      document.createTextNode(
        ` · ${version.parserKind} · ${version.parserVersion} · imported ${formatProductTime(version.importedAt)}` +
          ` · ${String(version.textUnits)} text units`,
      ),
    );
  }
  root.append(meta);

  /* 版本链：每版一枚小片。ready 版本可点开（旧版本保持可读——切换是显式
     动作，绝不自动迁移任何锚点，charter §3.1）；非 ready 版本如实标注
     状态与原因（不可点——没有可读正文，不伪装）。 */
  if (reader.versions.length > 0) {
    const strip = document.createElement("div");
    strip.className = "mat-versions";
    strip.setAttribute("role", "group");
    strip.setAttribute("aria-label", "Material versions");
    reader.versions.forEach((candidate, index) => {
      const isCurrent = candidate.id === reader.versionId;
      const latest = index === reader.versions.length - 1;
      const readable = candidate.parseStatus === "ready";
      const chip = document.createElement(readable ? "button" : "span");
      chip.className = "mat-version-chip";
      chip.dataset.versionId = candidate.id;
      let text = `v${String(index + 1)} · ${candidate.parserKind}`;
      if (!latest) text += " · older";
      if (candidate.parseStatus !== "ready") text += ` · ${candidate.parseStatus}`;
      chip.textContent = text;
      if (isCurrent) {
        chip.classList.add("active");
        chip.setAttribute("aria-current", "true");
      }
      if (!readable) {
        chip.classList.add("unreadable", candidate.parseStatus);
        if (typeof candidate.parseError === "string" && candidate.parseError !== "") {
          chip.title = candidate.parseError;
        }
      } else if (!isCurrent) {
        chip.title = `Open v${String(index + 1)} (an older, readable version — saved quotes are never migrated across versions)`;
        chip.addEventListener("click", () => void switchMaterialVersion(candidate.id));
      }
      strip.append(chip);
    });
    root.append(strip);
  }

  /* 诚实状态注记（可叠加）：打开/首页失败 + 重试；无版本；非 ready 状态
     （含原因与刷新入口）；PDF 下一增量；旧版本 + 切最新入口；最新版本
     不可读但当前读的是旧版；位置恢复注记。 */
  for (const note of buildMaterialNotes(reader, version)) root.append(note);

  /* 选区捕获条（常驻——不随正文滚动消失；role=status 朗读状态变化）。 */
  const bar = document.createElement("div");
  bar.id = "mat-selection-bar";
  bar.className = "mat-selection-bar";
  bar.setAttribute("role", "status");
  root.append(bar);

  /* D4-3 建枝流程面（材料范围声明 + 首问 / 恢复二选；无流程时不渲染）。
     置于捕获条与正文之间——提交前的材料范围声明就近可读。 */
  const branchFlow = renderMaterialBranchFlow();
  if (branchFlow !== null) root.append(branchFlow);

  /* 块容器：优先移回既有元素（身份/子树/监听全部保留）。 */
  const blocksEl = preservedBlocks ?? createMaterialBlocksElement();
  root.append(blocksEl);
  if (preservedScrollTop !== null && preservedScrollTop > 0) blocksEl.scrollTop = preservedScrollTop;

  /* 尾部状态。 */
  const tail = document.createElement("div");
  tail.id = "mat-tail";
  tail.className = "mat-tail";
  root.append(tail);

  updateMatSelectionBar();
  updateMatTail();
}

/** 状态注记构建（D4-2 诚实状态面的逐项落位）。 */
function buildMaterialNotes(reader, version) {
  const notes = [];
  const appendNote = (text, opts = {}) => {
    const note = document.createElement("div");
    note.className = `mat-note${opts.danger === true ? " danger" : ""}`;
    note.append(document.createTextNode(text));
    for (const action of opts.actions ?? []) note.append(action);
    notes.push(note);
    return note;
  };
  const actionButton = (text, title, onClick, extraClass = "") => {
    const button = document.createElement("button");
    button.className = `mat-note-action${extraClass === "" ? "" : ` ${extraClass}`}`;
    button.textContent = text;
    button.title = title;
    button.addEventListener("click", onClick);
    return button;
  };
  if (reader.firstPageState === "failed" && reader.versions.length === 0) {
    /* 详情级失败（版本链都未取得）：注记区承载错误 + 重试；分块读取失败
       （版本链已知，正文为空、尾部就在正文下方）由尾部状态面承载，不
       重复两处。 */
    appendNote(
      `opening the material failed — ${reader.firstPageError ?? "unknown error"}`,
      {
        danger: true,
        actions: [
          actionButton("Retry", "Retry opening this material", () =>
            void openMaterial(reader.materialId, { trigger: materialReaderFocusReturn ?? undefined }),
          "mat-retry-open"),
        ],
      },
    );
    return notes;
  }
  if (version === null) {
    appendNote("this material has no versions recorded — nothing to read yet", { danger: true });
    return notes;
  }
  const number = materialVersionNumber(reader.versions, version.id);
  const latest = reader.versions[reader.versions.length - 1];
  if (version.parseStatus !== "ready") {
    /* 非 ready：状态如实 + 原因（failed/unsupported/rejected 的 parseError
       全文可读）；pending/parsing 给刷新入口（解析任务是进程内瞬态——没有
       推送，刷新是显式动作）；绝无“空文档伪装成功”。 */
    const reason =
      typeof version.parseError === "string" && version.parseError !== ""
        ? ` — ${version.parseError}`
        : "";
    if (version.parseStatus === "pending" || version.parseStatus === "parsing") {
      appendNote(
        `v${String(number)} is still being parsed (${version.parseStatus}${reason}) — press Refresh to check again`,
        {
          actions: [
            actionButton("Refresh", "Re-fetch this material's version statuses", () =>
              void refreshMaterialDetail(),
            ),
          ],
        },
      );
    } else {
      appendNote(
        `v${String(number)} is ${version.parseStatus}${reason}. ` +
          "This is not an empty document — the original file is kept as imported; " +
          "an older ready version (if any) stays readable via the version strip above.",
        { danger: true },
      );
    }
  } else if (version.parserKind === "pdf") {
    /* PDF 阅读面（charter §3.2）：真实页（解析产出的页块结构）+ 可选中文
       本层——每页是一个阅读面，选区经同一套规范偏移机制映射；单页纪律
       如实声明（跨页拒绝，绝不静默截断）。不伪造视觉版式：呈现的是
       d4-pdf-v1 规范文本（扫描/加密/损坏/超限材料的显式状态见上方
       parseStatus 面）。 */
    appendNote(
      "PDF reading surface — each page below renders the parsed canonical text (d4-pdf-v1) as a selectable " +
        "reading surface; select within one page (cross-page selections are refused, never silently truncated); " +
        "page text renders as you scroll (visible pages first)",
    );
  }
  if (version.id !== latest.id) {
    /* 旧版本可读 + 非破坏性切最新入口（charter §3.1：切换绝不迁移锚点）。 */
    appendNote(
      `you are reading v${String(number)} (older) — v${String(reader.versions.length)} is the current version. ` +
        "Switching never migrates saved quotes: each stays anchored to its own version.",
      {
        actions: [
          actionButton(
            `Open v${String(reader.versions.length)}`,
            "Switch the reader to the current version (non-destructive — this version stays readable)",
            () => void switchMaterialVersion(latest.id),
          ),
        ],
      },
    );
    if (latest.parseStatus !== "ready") {
      const reason =
        typeof latest.parseError === "string" && latest.parseError !== ""
          ? ` — ${latest.parseError}`
          : "";
      appendNote(
        `the current version v${String(reader.versions.length)} is ${latest.parseStatus}${reason} — this older version remains readable`,
        { danger: latest.parseStatus === "failed" || latest.parseStatus === "unsupported" || latest.parseStatus === "rejected" },
      );
    }
  }
  if (reader.restoredToBlockId !== null) {
    notes.push(mutedLine(`restored to your saved reading position (block ${reader.restoredToBlockId})`));
  }
  /* D4-4 搜索命中跳转注记 / D4-3 材料 Return 的原文跳转注记（两个来源两
     种说法——与位置恢复注记分开，绝不把跳转伪装成位置恢复）。 */
  if (reader.searchJump !== null) {
    if (reader.searchJump.arrival === "return-source") {
      if (reader.searchJump.fellBackToDefaultVersion) {
        notes.push(
          mutedLine(
            "jumped to the material source of a Return — the Return's version is no longer in this material's version " +
              "chain, so the default version selection is shown instead (nothing is faked)",
          ),
        );
      } else if (reader.searchJump.blockId !== null) {
        notes.push(mutedLine(`jumped to the material source of a Return — located at block ${reader.searchJump.blockId}`));
      } else {
        notes.push(mutedLine("jumped to the material source of a Return — the version is opened at the top"));
      }
    } else if (reader.searchJump.fellBackToDefaultVersion) {
      notes.push(
        mutedLine(
          "arrived from Search — the hit's version is no longer in this material's version chain, " +
            "so the default version selection is shown instead (nothing is faked)",
        ),
      );
    } else if (reader.searchJump.blockId !== null) {
      notes.push(mutedLine(`arrived from Search — the hit is located at block ${reader.searchJump.blockId}`));
    } else {
      notes.push(mutedLine("arrived from Search — the hit's version is opened at the top"));
    }
  }
  return notes;
}

/** 版本序号（导入序 1-based）。 */
function materialVersionNumber(versions, versionId) {
  const index = versions.findIndex((candidate) => candidate.id === versionId);
  return index < 0 ? 0 : index + 1;
}

/** 创建块容器（每阅读器会话一次；监听随元素存续——重渲只移回不重建）。 */
function createMaterialBlocksElement() {
  const blocksEl = document.createElement("div");
  blocksEl.id = "mat-blocks";
  blocksEl.className = "mat-blocks";
  blocksEl.setAttribute("aria-label", "Material text (canonical, block by block)");
  /* 键盘可达的滚动区（WCAG 2.1 SC 2.1.1：可滚动内容须键盘可操作）——
     tabindex=0 使 #mat-blocks 成为 Tab 停靠点，聚焦后方向键/PageDown
     滚动正文（此前阅读器内无任何可聚焦子元素，键盘无法滚动阅读——
     B7 beta 可用性探针发现）。 */
  blocksEl.setAttribute("tabindex", "0");
  /* ③ 同族：正文按下开启拖拽窗口——窗口内 chrome 重渲延后（块追加是纯
     增量的，不触碰既有节点，无需延后）。 */
  blocksEl.addEventListener("mousedown", () => {
    state.selectionDragActive = true;
  });
  const armFromEvent = () => {
    if (state.selectionDragActive) {
      state.selectionDragActive = false;
      window.setTimeout(flushPendingRerender, 0);
    }
    armMaterialSelection();
  };
  blocksEl.addEventListener("mouseup", armFromEvent);
  blocksEl.addEventListener("dblclick", armFromEvent);
  blocksEl.addEventListener("scroll", () => {
    const reader = state.materialReader;
    if (reader === null) return;
    scheduleMaterialPositionSave();
    maybeLoadMoreMaterialBlocks(blocksEl);
    /* PDF 懒渲染窗口随滚动重估（可见页先行渲染，窗外页卸回占位）。 */
    updatePdfPageRendering(reader);
  });
  return blocksEl;
}

/**
 * 块元素渲染（markdown → 无损字面块；pdf-page → 页框）：markdown 块元素
 * 携带 data-block-id / data-start / data-end（规范文本映射——绝对 UTF-16
 * 区间），内容由 renderMarkdownInto 无损填充；PDF 页块渲染为页框
 * （.pdf-page-frame：页头标识 + 文本层），文本层按懒渲染纪律按需填充
 * （updatePdfPageRendering——可见页先行，远页占位）。
 */
function renderMaterialBlockElement(entry, reader) {
  if (entry.block.kind === "pdf-page") return createPdfPageFrame(entry);
  const div = document.createElement("div");
  div.className = "material-block";
  div.dataset.blockId = entry.block.blockId;
  div.dataset.start = String(entry.block.start);
  div.dataset.end = String(entry.block.end);
  reader.fenceOpen = renderMarkdownInto(div, entry.text, reader.fenceOpen);
  return div;
}

/**
 * PDF 页框（charter §3.2「真实页 + 可选中文本层」）：块即页——页框是
 * #mat-blocks 的定位单元（data-block-id / data-start / data-end /
 * data-page；滚动定位/窗口裁剪/阅读位置都以页框为对象）。页头标识
 * （「Page N」）在文本层**之外**——文本层 .material-block 的 textContent
 * 与页块文本字节相等（选区偏移换算的事实源，绝不混入页头文字）。文本层
 * 初始为占位（未渲染态），由 updatePdfPageRendering 按可见性填充。
 */
function createPdfPageFrame(entry) {
  const frame = document.createElement("div");
  frame.className = "pdf-page-frame";
  frame.dataset.blockId = entry.block.blockId;
  frame.dataset.start = String(entry.block.start);
  frame.dataset.end = String(entry.block.end);
  const page = typeof entry.block.page === "number" ? entry.block.page : null;
  if (page !== null) frame.dataset.page = String(page);
  const head = document.createElement("div");
  head.className = "pdf-page-head";
  head.textContent = page === null ? entry.block.blockId : `Page ${String(page)}`;
  const textLayer = document.createElement("div");
  textLayer.className = "material-block pdf-page-text";
  textLayer.dataset.blockId = entry.block.blockId;
  textLayer.dataset.start = String(entry.block.start);
  textLayer.dataset.end = String(entry.block.end);
  if (page !== null) textLayer.dataset.page = String(page);
  textLayer.dataset.rendered = "false";
  textLayer.append(pdfPagePendingPlaceholder(page));
  frame.append(head, textLayer);
  return frame;
}

/** 未渲染页的占位说明（远页不渲染文本——绝不含正文文字）。 */
function pdfPagePendingPlaceholder(page) {
  const pending = document.createElement("div");
  pending.className = "pdf-page-pending";
  pending.textContent =
    page === null
      ? "this page is off-screen — its text renders when scrolled into view"
      : `page ${String(page)} is off-screen — its text renders when scrolled into view`;
  return pending;
}

/**
 * PDF 懒渲染（charter §3.2：可见页先行——大 PDF 首屏不整册渲染，B6 的
 * 2s 目标依赖）：页框落在 [视口顶 - 提前量, 视口底 + 提前量] 即渲染文本
 * 层；窗外页卸回占位（记住已渲染高度——min-height 占位保持滚动几何，
 * 真实浏览器不因卸载跳滚动）。几何未知（clientHeight 为 0——脚本桩/
 * 未布局）只渲染前导 PDF_LEADING_RENDER_PAGES 页。多趟推进（最多 8 趟）：
 * 渲染改变前页高度后，后续页可能进入窗口——每趟至少渲染一页才继续。
 */
function updatePdfPageRendering(reader) {
  if (reader === null || !materialReaderIsPdf(reader)) return;
  const blocksEl = document.getElementById("mat-blocks");
  if (blocksEl === null) return;
  const frames = [];
  for (const child of blocksEl.children) {
    if (isElementNode(child) && child.classList.contains("pdf-page-frame")) frames.push(child);
  }
  if (frames.length === 0) return;
  const clientHeight = typeof blocksEl.clientHeight === "number" ? blocksEl.clientHeight : 0;
  const base = typeof blocksEl.offsetTop === "number" ? blocksEl.offsetTop : 0;
  if (clientHeight <= 0) {
    /* 几何未知：只渲染前导若干页（有界），其余卸回占位。 */
    for (let i = 0; i < frames.length; i += 1) {
      const entry = reader.blocks.find((candidate) => candidate.block.blockId === frames[i].dataset.blockId);
      if (entry === undefined) continue;
      if (i < PDF_LEADING_RENDER_PAGES) renderPdfPageText(frames[i], entry);
      else unrenderPdfPageText(frames[i]);
    }
    return;
  }
  const from = blocksEl.scrollTop - PDF_PAGE_RENDER_OVERSCAN_PX;
  const to = blocksEl.scrollTop + clientHeight + PDF_PAGE_RENDER_OVERSCAN_PX;
  for (let pass = 0; pass < 8; pass += 1) {
    let renderedThisPass = 0;
    for (const frame of frames) {
      const entry = reader.blocks.find((candidate) => candidate.block.blockId === frame.dataset.blockId);
      if (entry === undefined) continue;
      const top = (typeof frame.offsetTop === "number" ? frame.offsetTop : 0) - base;
      const height = typeof frame.offsetHeight === "number" ? frame.offsetHeight : 0;
      const near = top + height >= from && top <= to;
      if (near) {
        if (renderPdfPageText(frame, entry)) renderedThisPass += 1;
      } else {
        unrenderPdfPageText(frame);
      }
    }
    if (renderedThisPass === 0) break;
  }
}

/** 渲染页文本层（幂等；返回是否本次真正填充）。逐字无损：行以 \n 分隔
    原样成文（pre-wrap），textContent 与页块文本字节相等。 */
function renderPdfPageText(frame, entry) {
  const textLayer = pdfPageTextLayer(frame);
  if (textLayer === null) return false;
  if (textLayer.dataset.rendered === "true") return false;
  textLayer.replaceChildren();
  const lines = entry.text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i] !== "") {
      const line = document.createElement("span");
      line.className = "pdf-line";
      line.textContent = lines[i];
      textLayer.append(line);
    }
    if (i < lines.length - 1) textLayer.append(document.createTextNode("\n"));
  }
  textLayer.dataset.rendered = "true";
  return true;
}

/** 页框内的文本层元素（.material-block——选区换算的定位元素）。 */
function pdfPageTextLayer(frame) {
  for (const child of frame.children) {
    if (isElementNode(child) && child.classList.contains("material-block")) return child;
  }
  return null;
}

/** 定位元素直接渲染（阅读位置/搜索跳转的 scrollIntoView 目标可能是页框：
    跳转目标即已可见——渲染其文本层）。 */
function renderPdfPageTextIn(element) {
  if (element === null || !isElementNode(element) || !element.classList.contains("pdf-page-frame")) return;
  const reader = state.materialReader;
  if (reader === null) return;
  const entry = reader.blocks.find((candidate) => candidate.block.blockId === element.dataset.blockId);
  if (entry !== undefined) renderPdfPageText(element, entry);
}

/** 卸载窗外页文本层（回占位）：记住渲染时高度（min-height 保滚动几何——
    setAttribute("style") 兼容真实 DOM 与脚本桩）。 */
function unrenderPdfPageText(frame) {
  const textLayer = pdfPageTextLayer(frame);
  if (textLayer === null || textLayer.dataset.rendered !== "true") return;
  const height = typeof frame.offsetHeight === "number" ? frame.offsetHeight : 0;
  const page = frame.dataset.page !== undefined ? Number(frame.dataset.page) : null;
  if (height > 0) frame.setAttribute("style", `min-height: ${String(height)}px;`);
  textLayer.replaceChildren(pdfPagePendingPlaceholder(page));
  textLayer.dataset.rendered = "false";
}

/**
 * d4-md-v1 的**无损字面渲染**：块文本逐字映射进 DOM——markdown 语法字符
 * 全部保留在文本中（标题的 #、强调的 *、行内代码的反引号、链接的
 * [label](url) 全语法），只按行/语法片段施加样式。container.textContent
 * 与块文本字节相等（选区偏移换算的事实源），绝不把文本当 HTML 解析。
 * 行级：ATX 标题行 → 标题样式段；```/~~~ 围栏行翻转代码状态（围栏跨块
 * 时由调用方经 fenceOpen 携带——分块读取下逐块推进）；行间换行保留为
 * 独立文本节点（CSS pre-wrap 成行）。
 */
function renderMarkdownInto(container, text, fenceOpen) {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const isLast = i === lines.length - 1;
    if (line === "") {
      /* 空行片（只可能是末尾切片——块内无空白行）：无内容，仅补换行。 */
      if (!isLast) container.append(document.createTextNode("\n"));
      continue;
    }
    if (fenceOpen) {
      container.append(codeLineSpan(line));
      if (/^(```|~~~)/.test(line)) fenceOpen = false; /* 收栏行本身也呈代码样式 */
    } else if (/^(```|~~~)/.test(line)) {
      container.append(codeLineSpan(line));
      fenceOpen = true;
    } else if (/^#{1,6}\s/.test(line) || /^#{1,6}$/.test(line)) {
      const marks = line.match(/^#+/);
      const span = document.createElement("span");
      span.className = `mat-h${String(Math.min(marks === null ? 1 : marks[0].length, 6))}`;
      span.textContent = line;
      container.append(span);
    } else {
      renderInlineMarkdownInto(container, line);
    }
    if (!isLast) container.append(document.createTextNode("\n"));
  }
  return fenceOpen;
}

/** 代码行片段（围栏行与围栏内行——等宽呈现，字符逐字保留）。 */
function codeLineSpan(line) {
  const span = document.createElement("span");
  span.className = "mat-code-line";
  span.textContent = line;
  return span;
}

/**
 * 行内无损渲染（最小安全集）：行内代码 `…`、强强调 **…** / __…__、弱强调
 * *…* / _…_、链接 [label](url)。只加样式不删字符；未闭合/不成对的标记按
 * 字面输出（宁可不渲染样式，绝不改写字节——样式误判只影响外观，映射
 * 恒成立）。_…_ 要求词边界（snake_case 不斜体）；链接不导航（阅读面保持
 * 位置与选区，语法字符全保留——B2 冻结集的链接摘录即含完整语法）。
 */
function renderInlineMarkdownInto(container, line) {
  let at = 0;
  while (at < line.length) {
    const found = nextInlineMarker(line, at);
    if (found === null) {
      container.append(document.createTextNode(line.slice(at)));
      return;
    }
    if (found.start > at) container.append(document.createTextNode(line.slice(at, found.start)));
    const span = document.createElement("span");
    span.className = found.kind;
    span.textContent = line.slice(found.start, found.end);
    if (found.kind === "mat-link") {
      span.title = "link (rendered verbatim — the reader keeps your position and does not navigate)";
    }
    container.append(span);
    at = found.end;
  }
}

/** 最早的完整行内标记（含标记本身）；无匹配返回 null。 */
function nextInlineMarker(line, from) {
  for (let p = from; p < line.length; p += 1) {
    const ch = line[p];
    if (ch === "`") {
      const close = line.indexOf("`", p + 1);
      if (close > p) return { start: p, end: close + 1, kind: "mat-code" };
      continue;
    }
    if (ch === "*" || ch === "_") {
      const double = line.slice(p, p + 2);
      if (double === "**" || double === "__") {
        const close = line.indexOf(double, p + 2);
        if (close > p) return { start: p, end: close + 2, kind: "mat-strong" };
        continue;
      }
      /* 单标记弱强调：_ 需词边界开/闭（snake_case 不斜体）；* 允许词内。 */
      if (ch === "_" && p > 0 && !/[\s([{'“「（《,.;:!?]/.test(line[p - 1])) continue;
      let close = -1;
      for (let q = p + 1; q < line.length; q += 1) {
        if (line[q] !== ch) continue;
        if (line.slice(q, q + 2) === double) continue;
        if (
          ch === "_" &&
          q < line.length - 1 &&
          !/[\s)\]}'”」》）,.;:!?]/.test(line[q + 1])
        ) {
          continue;
        }
        close = q;
        break;
      }
      if (close > p + 1) return { start: p, end: close + 1, kind: "mat-em" };
      continue;
    }
    if (ch === "[") {
      const labelEnd = line.indexOf("](", p + 1);
      if (labelEnd > p) {
        const urlEnd = line.indexOf(")", labelEnd + 2);
        if (urlEnd > labelEnd) return { start: p, end: urlEnd + 1, kind: "mat-link" };
      }
    }
  }
  return null;
}

/* ------------------------------ D4-2 选区捕获 ------------------------------ */

/**
 * 图素簇边界集（B2 无效类别 inv-05/06/07 的前端镜像）：Intl.Segmenter
 * granularity "grapheme"（与服务端 range-resolver 同一判定）；无
 * Segmenter 的环境退化为仅代理对边界（组合序列无法判定——如实边界，
 * 现代浏览器/Node 24 均有 Segmenter）。块文本量级小，按需构建不缓存。
 */
const MATERIAL_GRAPHEME_SEGMENTER =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

function graphemeBoundarySet(text) {
  const boundaries = new Set([0]);
  if (MATERIAL_GRAPHEME_SEGMENTER !== null) {
    let position = 0;
    for (const segment of MATERIAL_GRAPHEME_SEGMENTER.segment(text)) {
      position += segment.segment.length;
      boundaries.add(position);
    }
    return boundaries;
  }
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        boundaries.add(i + 2); /* 代理对中间 (i+1) 不可劈 */
        i += 1;
        continue;
      }
    }
    boundaries.add(i + 1);
  }
  return boundaries;
}

/**
 * 字素安全吸附（charter §3.2）：选区边界落在字素簇内（代理对中间、组合
 * 字符与基字符之间、emoji/ZWJ 序列内部）时**向外**吸附到整簇边界——载荷
 * 绝不劈开一个簇；吸附后的摘录即块文本切片（canonicalText 对应切片）。
 * 吸附后为空（理论不可达：进入时选区非空）→ null。
 */
function clampToGraphemeBoundaries(text, start, end) {
  const boundaries = graphemeBoundarySet(text);
  let snapped = false;
  let safeStart = start;
  let safeEnd = end;
  if (!boundaries.has(safeStart)) {
    safeStart = snapBoundaryDown(boundaries, safeStart);
    snapped = true;
  }
  if (!boundaries.has(safeEnd)) {
    safeEnd = snapBoundaryUp(boundaries, safeEnd, text.length);
    snapped = true;
  }
  if (safeStart >= safeEnd) return null;
  return { start: safeStart, end: safeEnd, snapped };
}

function snapBoundaryDown(boundaries, position) {
  let best = 0;
  for (const boundary of boundaries) {
    if (boundary < position && boundary > best) best = boundary;
  }
  return best;
}

function snapBoundaryUp(boundaries, position, max) {
  let best = max;
  for (const boundary of boundaries) {
    if (boundary > position && boundary < best) best = boundary;
  }
  return best;
}

/** 选区起/止所在的块元素（沿 parentElement 上溯；不在阅读器正文内 →
    null——两个 null 或单 null 都意味着“这不是阅读器选区”）。 */
function materialBlockOf(node) {
  let current = node;
  while (current !== null && current !== undefined) {
    if (isElementNode(current) && current.classList.contains("material-block")) return current;
    current = current.parentElement;
  }
  return null;
}

/** 块内前缀长度（selectionOffsetsWithin 的块内版：clone → 全块内容 →
    setEnd 到选区起点 → toString 长度即块内偏移；跨文本节点成立）。 */
function materialBlockLocalStart(blockEl, range) {
  const before = range.cloneRange();
  before.selectNodeContents(blockEl);
  before.setEnd(range.startContainer, range.startOffset);
  return before.toString().length;
}

/**
 * 阅读器选区 → 捕获载荷（D4-3 建枝的锚点载荷）。事实源：块元素区间 +
 * 前缀长度换算 + 块文本切片校验（excerpt === 块文本切片——即
 * canonicalText.slice(start,end)，绝对偏移由 block.start 平移）。跨块 →
 * 如实 {invalid, cross-block}（B2 纪律：markdown 选区必须含于单块，不悄悄
 * 截断）；PDF 跨页 → {invalid, cross-page}（charter §3.2：选区必须含于
 * 单页——提示分段选择，绝不静默截断）；切片校验失败（理论不可达的渲染
 * 漂移）→ {invalid, unmappable}。返回 null = 无选区/选区不在阅读器正文
 * 内（不武装）。invalid 载荷同样携带 materialId/versionId（捕获条的归属
 * 判定对两态一致）。PDF 页块的有效载荷额外携带 page（页标识）。
 */
function materialSelectionFromRange(reader) {
  const selection = window.getSelection();
  if (selection === null || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const startBlock = materialBlockOf(range.startContainer);
  const endBlock = materialBlockOf(range.endContainer);
  if (startBlock === null && endBlock === null) return null;
  const isPdf = materialReaderIsPdf(reader);
  const invalid = (reason) => ({
    kind: "invalid",
    materialId: reader.materialId,
    versionId: reader.versionId,
    reason,
  });
  if (startBlock === null || endBlock === null) return invalid("unmappable");
  if (startBlock !== endBlock) return invalid(isPdf ? "cross-page" : "cross-block");
  const blockId = startBlock.dataset.blockId;
  const entry = reader.blocks.find((candidate) => candidate.block.blockId === blockId);
  if (blockId === undefined || entry === undefined) return invalid("unmappable");
  const selected = range.toString();
  if (selected.length === 0) return null;
  const localStart = materialBlockLocalStart(startBlock, range);
  const localEnd = localStart + selected.length;
  if (localStart < 0 || localEnd > entry.text.length) return invalid("unmappable");
  if (entry.text.slice(localStart, localEnd) !== selected) {
    return invalid("unmappable");
  }
  const clamped = clampToGraphemeBoundaries(entry.text, localStart, localEnd);
  if (clamped === null) return invalid("unmappable");
  const valid = {
    kind: "valid",
    materialId: reader.materialId,
    versionId: reader.versionId,
    blockId,
    start: entry.block.start + clamped.start,
    end: entry.block.start + clamped.end,
    excerpt: entry.text.slice(clamped.start, clamped.end),
    snapped: clamped.snapped,
  };
  if (typeof entry.block.page === "number") valid.page = entry.block.page;
  return valid;
}

/** 武装阅读器选区（mouseup/双击/触屏 selectionchange 共用；解除语义与
    armTurnSelection 同族：无选区/选区移出阅读器正文即解除）。武装阅读器
    选区时同步解除正文层的武装选区——同一时刻只有一个捕获面。 */
function armMaterialSelection() {
  const reader = state.materialReader;
  if (reader === null) return;
  const payload = materialSelectionFromRange(reader);
  state.materialSelection = payload;
  if (payload !== null && state.armedSelection !== null) disarmArmedSelection();
  updateMatSelectionBar();
}

/** 解除阅读器武装（就地刷新捕获条，不触碰块容器）。 */
function disarmMaterialSelection() {
  if (state.materialSelection === null) return;
  state.materialSelection = null;
  updateMatSelectionBar();
}

/** 触屏/全局：当前选区是否落在阅读器正文内（selectionchange 武装判定）。 */
function findLiveMaterialSelection() {
  const reader = state.materialReader;
  if (reader === null) return false;
  return materialSelectionFromRange(reader) !== null;
}

/** 捕获条就地更新（武装/解除/翻提示——不整建 chrome，不触碰块）。 */
function updateMatSelectionBar() {
  const bar = document.getElementById("mat-selection-bar");
  if (bar === null) return;
  if (state.selectionDragActive) {
    /* 拖拽窗口内捕获条内容冻结：全局 selectionchange 在拖选中持续触发，
       条从 ~54px 长到 ~169px 会把正文整体推下 ~115px（真实 Chrome 实测，
       DOM 桩测不出），连续拖选的释放点随位移带偏。与 renderMaterialReader
       的「选择期间不重绘」同族——mouseup 冲刷就地重放本函数（触屏
       selectionchange 无拖拽窗口，不受影响）。 */
    materialBarPendingUpdate = true;
    return;
  }
  bar.replaceChildren();
  const reader = state.materialReader;
  if (reader === null) return;
  const selection = state.materialSelection;
  if (selection === null || selection.materialId !== reader.materialId || selection.versionId !== reader.versionId) {
    const hint = document.createElement("span");
    hint.className = "muted";
    hint.textContent =
      "(select text in the material to capture a quote — a captured selection can branch into an exploration)";
    bar.append(hint);
    return;
  }
  if (selection.kind === "invalid") {
    const note = document.createElement("span");
    note.className = "mat-invalid-note";
    note.textContent =
      selection.reason === "cross-block"
        ? "cross-block selection not anchorable — markdown selections must stay within a single block " +
          "(B2 anchoring discipline); no quote payload is produced, nothing is truncated silently"
        : selection.reason === "cross-page"
          ? "cross-page selection not anchorable — PDF selections must stay within one page " +
            "(select within a page; segmented selection across pages is the discipline — never a silent truncation); " +
            "no quote payload is produced"
          : "the selection could not be mapped to canonical offsets — no quote payload is shown";
    bar.append(note);
    return;
  }
  const quote = document.createElement("span");
  quote.className = "mat-quote";
  quote.textContent = selection.excerpt;
  const payload = document.createElement("span");
  payload.className = "mat-payload";
  const pagePart =
    typeof selection.page === "number" ? ` · page ${String(selection.page)}` : "";
  payload.textContent =
    `material ${selection.materialId} · version ${selection.versionId} · block ${selection.blockId}${pagePart}` +
    ` · UTF-16 [${String(selection.start)}, ${String(selection.end)}) · ${String(selection.excerpt.length)} units`;
  bar.append(quote, payload);
  if (selection.snapped) {
    const snap = document.createElement("span");
    snap.className = "mat-snap-note";
    snap.textContent =
      "(a selection boundary fell inside a grapheme cluster — it was snapped outward so the quote never " +
        "splits a surrogate pair, combining sequence, or emoji)";
    bar.append(snap);
  }
  const actions = document.createElement("span");
  actions.className = "mat-selection-actions";
  const copy = document.createElement("button");
  copy.className = "mat-copy";
  copy.textContent = "⧉ Copy quote";
  copy.title = "Copy the exact canonical text of this selection";
  copy.addEventListener("click", () => void copyMaterialQuote(copy, selection));
  const branch = document.createElement("button");
  branch.className = "mat-branch-d43";
  branch.textContent = "⑃ Branch from material";
  branch.title =
    "Open the exploration flow anchored on this exact selection — the material scope is declared for you to review before the first question is submitted";
  branch.addEventListener("click", () => {
    void guard(() => startMaterialBranchFlow(selection), "main");
  });
  actions.append(copy, branch);
  bar.append(actions);
}

/** 复制摘录：按 canonicalText 切片复制（excerpt 已过切片校验；正文渲染
    无覆盖改写，textContent 即原文）。Clipboard API 缺席/失败时诚实降级：
    摘录留在捕获条内可选（手动复制），绝不谎报已复制。 */
async function copyMaterialQuote(button, selection) {
  const clipboard =
    typeof navigator !== "undefined" &&
    navigator !== null &&
    typeof navigator.clipboard === "object" &&
    navigator.clipboard !== null &&
    typeof navigator.clipboard.writeText === "function"
      ? navigator.clipboard
      : null;
  if (clipboard === null) {
    button.textContent = "Copy unavailable";
    button.title = "Clipboard API unavailable — select the quote above and copy it manually";
    return;
  }
  try {
    await clipboard.writeText(selection.excerpt);
    button.textContent = "Copied ✓";
    window.setTimeout(() => {
      button.textContent = "⧉ Copy quote";
    }, 1500);
  } catch (err) {
    showError(
      `copying the quote failed — ${String(err && err.message ? err.message : err)}; ` +
        "the quote above stays selectable for a manual copy",
    );
  }
}

/* ------------------------------ D4-3 材料建枝（issue #8 charter §3.3 / ADR-004） ------------------------------ */

/** D4-3 建枝流程世代号（迟到响应丢弃——P1 同族规则）。 */
let materialBranchingSeq = 0;

/** 选区身份（与 sameMaterialSelectionIdentity 同维度：材料×版本×块×区间）。 */
function materialSelectionIdentity(selection) {
  return `${selection.materialId}:${selection.versionId}:${selection.blockId}:${String(selection.start)}-${String(selection.end)}`;
}

const MATERIAL_INTENT_PREFIX = "treeai-material-intent:";
const MATERIAL_BRANCH_ORIGIN_PREFIX = "treeai-material-branch:";
const MATERIAL_RETURN_CARD_PREFIX = "treeai-material-return-card:";

/**
 * 挂起的建枝意图（intentKey + 未落库的首问草稿）：一次逻辑提交跨页面刷新
 * /重启稳定（同键重放同枝、同键同问不重发——服务端原子绑定与对账兜底）。
 * 首问落库（dispatch succeeded）即清除；显式另开时以新键覆盖。
 */
function materialIntentStorageKey(treeId, identity) {
  return `${MATERIAL_INTENT_PREFIX}${treeId}:${identity}`;
}

function readPendingMaterialIntent(treeId, identity) {
  try {
    const raw = window.localStorage.getItem(materialIntentStorageKey(treeId, identity));
    if (raw === null) return null;
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || typeof parsed.intentKey !== "string") return null;
    return parsed;
  } catch {
    return null; /* localStorage 不可用：会话内流程照常，刷新后走恢复对账（诚实降级） */
  }
}

function persistPendingMaterialIntent(treeId, identity, intentKey, firstQuestion) {
  try {
    window.localStorage.setItem(
      materialIntentStorageKey(treeId, identity),
      JSON.stringify({ intentKey, firstQuestion }),
    );
  } catch {
    /* 同上：持久化尽力而为 */
  }
}

function clearPendingMaterialIntent(treeId, identity) {
  try {
    window.localStorage.removeItem(materialIntentStorageKey(treeId, identity));
  } catch {
    /* 同上 */
  }
}

/** 材料 Branch 的来源上下文缓存（会话 Map + localStorage 双写）：面板头部
 *  来源呈现与「⌖ View source」原文跳转的数据面（树态不含 turn origin——
 *  材料来源只在 material_branch_origins，HTTP 面无读取端点，客户端从建枝/
 *  恢复响应缓存）。缓存缺失时如实注明，绝不伪造来源细节。 */
const materialBranchOriginCache = new Map();

function rememberMaterialBranchOrigin(treeId, branchId, originData) {
  const key = `${treeId}:${branchId}`;
  materialBranchOriginCache.set(key, originData);
  try {
    window.localStorage.setItem(`${MATERIAL_BRANCH_ORIGIN_PREFIX}${key}`, JSON.stringify(originData));
  } catch {
    /* 会话内缓存仍有效 */
  }
}

function recallMaterialBranchOrigin(treeId, branchId) {
  const key = `${treeId}:${branchId}`;
  const cached = materialBranchOriginCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const raw = window.localStorage.getItem(`${MATERIAL_BRANCH_ORIGIN_PREFIX}${key}`);
    if (raw === null) return null;
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return null;
    materialBranchOriginCache.set(key, parsed);
    return parsed;
  } catch {
    return null;
  }
}

/** 材料 Return 的来源卡缓存（提交响应的 card；主线卡渲染的数据面——树态
 *  实时携带采用记录，材料身份字段从缓存读取，缺失时如实注明）。 */
const materialReturnCardCache = new Map();

function rememberMaterialReturnCard(treeId, turnId, card) {
  const key = `${treeId}:${turnId}`;
  materialReturnCardCache.set(key, card);
  try {
    window.localStorage.setItem(`${MATERIAL_RETURN_CARD_PREFIX}${key}`, JSON.stringify(card));
  } catch {
    /* 会话内缓存仍有效 */
  }
}

function recallMaterialReturnCard(treeId, turnId) {
  const key = `${treeId}:${turnId}`;
  const cached = materialReturnCardCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const raw = window.localStorage.getItem(`${MATERIAL_RETURN_CARD_PREFIX}${key}`);
    if (raw === null) return null;
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return null;
    materialReturnCardCache.set(key, parsed);
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 材料 Branch 判定（树态结构信号）：非 Trunk 分支且无 Turn 来源（turn 来源
 * 分支恒有 origin；材料来源只落 material_branch_origins——与后端
 * service.submitReturn 的判定同口径）。材料 Return 的主线识别同用。
 */
function isMaterialBranchView(view) {
  const st = state.treeState;
  if (st === null || view === null) return false;
  return view.branch.id !== st.trunkBranchId && view.origin === null;
}

/**
 * 建枝入口（捕获条按钮）：resolve-selection → from-material 两步。
 * 1. 规范选区：阅读器的捕获载荷不含 sourceHash（窗口可能被裁剪，客户端
 *    不伪造）——经 D4-2 resolve-selection 由服务端复核切片/块/边界并签发
 *    规范 MaterialSelection（含 sourceHash；捕获过期时如实 400）；
 * 2. from-material {selection, intentKey, mode:"resume-or-create"}——
 *    同来源已有探索则进入恢复/另开二选，无则按 intentKey 新建（响应携带
 *    提交前的材料范围声明）。挂起的 intentKey（同选区身份）复用——建枝后
 *    未问的流程经同键幂等续走（刷新/重启后直达声明面）。
 * 建枝零 Run/Turn（首问是独立显式提交）；本调用不触碰对话游标（无
 * POST /switch——阅读与探索互不干扰，D4-2 同纪律）。
 */
async function startMaterialBranchFlow(selection) {
  const treeId = state.currentTreeId;
  if (treeId === null) return;
  const token = ++materialBranchingSeq;
  const identity = materialSelectionIdentity(selection);
  const pending = readPendingMaterialIntent(treeId, identity);
  const intentKey = pending !== null ? pending.intentKey : crypto.randomUUID();
  state.materialBranching = {
    phase: "creating",
    selection,
    intentKey,
    branchId: null,
    context: null,
    mode: null,
    created: false,
    restore: null,
    firstQuestion: pending !== null ? String(pending.firstQuestion ?? "") : "",
    submitting: false,
    dispatchNote: null,
    error: null,
    conflict: null,
    token,
  };
  renderMaterialReader();
  const flowElement = document.getElementById("mat-branch-flow");
  if (flowElement !== null) flowElement.focus();
  try {
    /* 步骤一：规范选区（服务端复核 + sourceHash 签发）。 */
    const resolved = await api(
      `/api/trees/${encodeURIComponent(treeId)}/materials/${encodeURIComponent(selection.materialId)}` +
        `/versions/${encodeURIComponent(selection.versionId)}/resolve-selection`,
      "POST",
      {
        locator: { kind: "utf16-range", start: selection.start, end: selection.end },
        excerpt: selection.excerpt,
        blockId: selection.blockId,
      },
    );
    const canonical = resolved.selection;
    /* 步骤二：建枝/恢复（resume-or-create）。 */
    const payload = await api(
      `/api/trees/${encodeURIComponent(treeId)}/branches/from-material`,
      "POST",
      { selection: canonical, intentKey, mode: "resume-or-create" },
    );
    if (state.materialBranching === null || state.materialBranching.token !== token) return; /* 迟到丢弃 */
    state.treeState = payload.state;
    const branchId = payload.branch.id;
    rememberMaterialBranchOrigin(treeId, branchId, {
      selection: canonical,
      materialTitle: payload.context.materialTitle,
    });
    if (payload.mode === "restored") {
      const view = branchView(branchId);
      const hasTurns = view !== null && view.turns.length > 0;
      /* 恢复 + 挂起键 + 零 turn：该键正是这枝的未落库首问——直达声明面
         （同键幂等续走）。其余恢复进入明确二选。 */
      if (!hasTurns && pending !== null) {
        state.materialBranching = {
          ...state.materialBranching,
          phase: "declared",
          mode: "restored",
          created: false,
          branchId,
          context: payload.context,
          dispatchNote:
            "reopened the branch this pending intent key created (no first question has landed on it yet) — the flow resumes with the same key",
        };
        persistPendingMaterialIntent(treeId, identity, intentKey, state.materialBranching.firstQuestion);
      } else {
        state.materialBranching = {
          ...state.materialBranching,
          phase: "choice",
          mode: "restored",
          created: false,
          branchId,
          context: payload.context,
          restore: {
            created: payload.created === true,
            navigation: payload.navigation ?? null,
            sessionAvailability: payload.sessionAvailability ?? null,
            hasTurns,
          },
        };
      }
    } else {
      state.materialBranching = {
        ...state.materialBranching,
        phase: "declared",
        mode: "created",
        created: payload.created === true,
        branchId,
        context: payload.context,
      };
      persistPendingMaterialIntent(treeId, identity, intentKey, state.materialBranching.firstQuestion);
    }
  } catch (err) {
    if (state.materialBranching === null || state.materialBranching.token !== token) return; /* 迟到丢弃 */
    state.materialBranching = {
      ...state.materialBranching,
      phase: "failed",
      error: String(err && err.message ? err.message : err),
    };
  }
  renderMaterialReader();
}

/**
 * 建枝面（阅读器内、捕获条之下）：creating / declared（材料范围声明 + 首
 * 问输入）/ choice（恢复 vs 另开二选）/ failed（诚实错误 + 重试）四态。
 * 输入值经 state.materialBranching.firstQuestion 跨重渲保持（同术语首问
 * 输入的惯例）。
 */
function renderMaterialBranchFlow() {
  const flow = state.materialBranching;
  const reader = state.materialReader;
  if (flow === null || reader === null) return null;
  if (flow.selection.materialId !== reader.materialId) return null; /* 流程属于另一份材料：不在此渲染 */
  const div = document.createElement("div");
  div.id = "mat-branch-flow";
  div.className = "mat-branch-flow";
  div.setAttribute("tabindex", "-1");
  div.setAttribute("role", "region");
  div.setAttribute("aria-label", "Branch from material flow");

  if (flow.phase === "creating") {
    const head = document.createElement("p");
    head.className = "mat-branch-head";
    head.textContent = "⑃ Branch from material — resolving the selection…";
    div.append(head);
    div.append(
      mutedLine(
        "creating the branch records zero runs/turns (browsing and searching create none) — the first question is a separate explicit submit",
      ),
    );
    div.append(materialBranchCancelButton());
    return div;
  }

  if (flow.phase === "failed") {
    const head = document.createElement("p");
    head.className = "mat-branch-head danger";
    head.textContent = "⑃ Branch from material — the flow failed";
    div.append(head);
    div.append(mutedLine(`error — ${String(flow.error)}`));
    const actions = document.createElement("div");
    actions.className = "mat-branch-actions";
    const retry = document.createElement("button");
    retry.className = "mat-branch-retry";
    retry.textContent = "Retry";
    retry.title = "Resolve the selection and open the branching flow again";
    retry.addEventListener("click", () => void guard(() => startMaterialBranchFlow(flow.selection), "main"));
    actions.append(retry, materialBranchCancelButton());
    div.append(actions);
    return div;
  }

  if (flow.phase === "choice") {
    const restore = flow.restore;
    div.append(materialBranchChoiceCard(flow));
    const actions = document.createElement("div");
    actions.className = "mat-branch-actions";
    const resume = document.createElement("button");
    resume.className = "mat-branch-resume";
    resume.textContent = "↩ Open the existing exploration";
    resume.title = "Resume the exploration anchored on this exact selection (its session continues where it left off)";
    resume.addEventListener("click", () => void guard(() => materialBranchResumeExisting(), "main"));
    const fresh = document.createElement("button");
    fresh.className = "mat-branch-new";
    fresh.textContent = "⑃ Start a new exploration from this selection";
    fresh.title = "Explicitly open a second exploration from the same source — a new branch and a new session (a new submission)";
    fresh.addEventListener("click", () => void guard(() => materialBranchStartNew(), "main"));
    actions.append(resume, fresh, materialBranchCancelButton());
    div.append(actions);
    if (restore !== null && restore.navigation !== null && restore.navigation.status === "failed") {
      div.append(
        mutedLine(
          `aligning the live session failed (${String(restore.navigation.code)}: ${String(restore.navigation.message)}) — ` +
            "the branch stays fully readable; opening it shows the saved history, prompts navigate on their own",
        ),
      );
    }
    if (restore !== null && restore.sessionAvailability === "unavailable") {
      div.append(
        mutedLine(
          "the session at this branch's continuation point is unavailable — opening it shows the recovery entries " +
            "(including starting a new exploration from saved content)",
        ),
      );
    }
    if (restore !== null && !restore.hasTurns) {
      div.append(
        mutedLine(
          "the existing branch has no first question yet — continuing it there sends a normal prompt without the composed " +
            "material context; starting a new exploration below gives the full first-question flow",
        ),
      );
    }
    return div;
  }

  /* declared：材料范围声明（提交前）+ 首问输入。 */
  div.append(materialBranchContextCard(flow));
  const form = document.createElement("div");
  form.className = "mat-branch-question";
  const label = document.createElement("span");
  label.className = "muted";
  label.textContent = "first question for the new exploration:";
  const input = document.createElement("input");
  input.id = "mat-branch-first-question";
  input.type = "text";
  input.value = flow.firstQuestion;
  input.placeholder = "Ask the first question — it enters the new session together with the declared material scope…";
  input.disabled = flow.submitting;
  input.addEventListener("input", () => {
    const current = state.materialBranching;
    if (current !== null) {
      current.firstQuestion = input.value;
      /* 草稿随挂起意图持久化（同 Return 草稿纪律——刷新/重启后续走不丢输入）。 */
      if (state.currentTreeId !== null) {
        persistPendingMaterialIntent(
          state.currentTreeId,
          materialSelectionIdentity(current.selection),
          current.intentKey,
          input.value,
        );
      }
    }
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void guard(submitMaterialFirstQuestion, "main");
    }
  });
  const submit = document.createElement("button");
  submit.className = "primary mat-branch-submit";
  submit.textContent = flow.submitting ? "Dispatching…" : "Submit first question";
  submit.disabled = flow.submitting;
  submit.title =
    "Dispatch the first question with the declared material scope into a new, independent session (idempotent by intent key)";
  submit.addEventListener("click", () => void guard(submitMaterialFirstQuestion, "main"));
  form.append(label, input, submit);
  div.append(form);
  if (flow.mode === "restored") {
    div.append(
      mutedLine(
        "this branch was created earlier from the same selection and has no first question yet — submitting resumes it with the pending intent key",
      ),
    );
  } else if (flow.created === false) {
    div.append(
      mutedLine("this intent key already has its branch — the existing one is reopened (no duplicate is created)"),
    );
  }
  if (flow.submitting) {
    div.append(mutedLine("dispatching the first question… (it is not re-sent while a dispatch is pending)"));
  }
  if (flow.dispatchNote !== null) {
    const note = document.createElement("p");
    note.className = `mat-branch-dispatch${flow.dispatchNote.startsWith("dispatch failed") || flow.dispatchNote.startsWith("the first question for this branch") ? " danger" : ""}`;
    note.textContent = flow.dispatchNote;
    div.append(note);
    if (flow.dispatchNote.startsWith("dispatch failed")) {
      div.append(
        mutedLine(
          "a retry with the same key is an explicit new attempt (the backend reconciles first — a landed question is never re-sent)",
        ),
      );
    }
  }
  if (flow.conflict !== null) {
    const conflict = document.createElement("p");
    conflict.className = "mat-branch-conflict";
    conflict.textContent = `first-question conflict — ${flow.conflict}`;
    div.append(conflict);
    div.append(
      mutedLine("the first question is immutable for this branch — a changed question is a normal continuation, not a first-question retry"),
    );
    const actions = document.createElement("div");
    actions.className = "mat-branch-actions";
    const cont = document.createElement("button");
    cont.className = "accent mat-branch-continue";
    cont.textContent = "Continue on the branch with this question";
    cont.title = "Open the branch panel with the changed question in its composer — sending it there is a normal continuation";
    cont.addEventListener("click", () => void guard(() => materialBranchContinueWithQuestion(), "main"));
    actions.append(cont, materialBranchCancelButton());
    div.append(actions);
    return div;
  }
  div.append(materialBranchCancelButton());
  return div;
}

/** 取消按钮（各阶段共用：收起流程面，回到纯阅读）。 */
function materialBranchCancelButton() {
  const cancel = document.createElement("button");
  cancel.className = "mat-branch-cancel";
  cancel.textContent = "Cancel";
  cancel.title = "Close this flow and keep reading — nothing is dispatched without your explicit first question";
  cancel.addEventListener("click", closeMaterialBranchFlow);
  return cancel;
}

/**
 * 材料范围声明卡（charter §3.3 规则三「UI 在提交前说明本次使用的材料范
 * 围」）：from-material 响应的组合上下文视图——与首问派发时逐字节相同
 * （全部成分由不可变数据决定）。截断（24,000 单元上限）显式标注；组合
 * 文本全文经 <details> 可核对。
 */
function materialBranchContextCard(flow) {
  const context = flow.context;
  const card = document.createElement("div");
  card.className = "mat-branch-context";
  const head = document.createElement("p");
  head.className = "mat-branch-context-head";
  head.textContent = "Material scope for this exploration — declared before your first question";
  card.append(head);
  if (context === null) {
    card.append(mutedLine("the scope view is unavailable — do not submit until it is shown"));
    return card;
  }
  const lines = [];
  lines.push(
    `material “${context.materialTitle}” · version ${context.versionId} (${context.parserKind} ${context.parserVersion})`,
  );
  lines.push(
    `selected excerpt: block ${context.selection.blockId}, UTF-16 [${String(context.selection.start)}, ${String(context.selection.end)}) — quoted in full below`,
  );
  lines.push(
    `surrounding-material window: UTF-16 [${String(context.window.start)}, ${String(context.window.end)}) of the version canonical text` +
      ` (blocks fully covered: ${
        context.contextBlocks.length > 0 ? context.contextBlocks.map((block) => block.blockId).join(", ") : "none"
      })`,
  );
  lines.push(`composed context: ${String(context.composedUnits)} / ${String(context.limitUnits)} UTF-16 units`);
  for (const text of lines) {
    const line = document.createElement("p");
    line.className = "mat-branch-scope-line";
    line.textContent = text;
    card.append(line);
  }
  const quote = document.createElement("blockquote");
  quote.className = "mat-branch-excerpt";
  quote.textContent = context.selection.excerpt;
  card.append(quote);
  if (context.truncated) {
    const marker = document.createElement("p");
    marker.className = "mat-branch-truncated";
    marker.textContent = `TRUNCATED — ${String(context.truncationNote)}`;
    card.append(marker);
  } else {
    card.append(mutedLine("the window covers the whole material — nothing is omitted"));
  }
  const details = document.createElement("details");
  details.className = "mat-branch-composed collapsible";
  const summary = document.createElement("summary");
  summary.textContent = "the exact composed context that will enter the model input";
  const pre = document.createElement("pre");
  pre.textContent = context.composed;
  details.append(summary, pre);
  card.append(details);
  card.append(
    mutedLine(
      "creating the branch recorded zero runs/turns; submitting the first question dispatches it with exactly this scope into a new, independent session (the same bytes — the scope is deterministic)",
    ),
  );
  return card;
}

/** 恢复 vs 另开二选卡（charter §3.3 规则五/六：同来源可恢复，也可显式另开）。 */
function materialBranchChoiceCard(flow) {
  const card = document.createElement("div");
  card.className = "mat-branch-context";
  const head = document.createElement("p");
  head.className = "mat-branch-context-head";
  head.textContent = "This exact material source already has an exploration in this tree";
  card.append(head);
  const line = document.createElement("p");
  line.className = "mat-branch-scope-line";
  line.textContent =
    `source: material “${String(flow.context?.materialTitle ?? "")}” · version ${String(flow.selection.versionId)} · ` +
    `block ${flow.selection.blockId} · UTF-16 [${String(flow.selection.start)}, ${String(flow.selection.end)}) — ` +
    `selection identity is exact (material × version × block × range); look-alike excerpts elsewhere are never reused`;
  card.append(line);
  card.append(
    mutedLine(
      "you can resume the existing exploration, or explicitly start a new one from this same selection — both are honest continuations, nothing is silently reused",
    ),
  );
  return card;
}

/**
 * 幂等首问提交（先对账后动作在服务端；客户端纪律 = 在途锁不重发 + 结局
 * 如实呈现）：dispatch succeeded（outcome null = 同键重放，零重发）→ 收流
 * 程面、关阅读器、开新枝面板；failed → 诚实错误 + 同键可重试（显式新尝
 * 试）；unknown → 在途对账不决，**不盲发**（无自动重试）；409
 * material-first-question-conflict → 冲突面 + 「改问走普通续聊」去向。
 */
async function submitMaterialFirstQuestion() {
  const flow = state.materialBranching;
  if (flow === null || flow.phase !== "declared" || flow.submitting) return;
  const treeId = state.currentTreeId;
  if (treeId === null) return;
  const firstQuestion = flow.firstQuestion;
  if (firstQuestion.trim() === "") {
    const input = document.getElementById("mat-branch-first-question");
    if (input !== null) input.focus();
    showError("Type the first question for the exploration first.");
    return;
  }
  const token = flow.token;
  const branchId = flow.branchId;
  const identity = materialSelectionIdentity(flow.selection);
  state.materialBranching = { ...flow, submitting: true, dispatchNote: null, conflict: null };
  renderMaterialReader();
  try {
    const payload = await api(
      `/api/trees/${encodeURIComponent(treeId)}/material-first-question`,
      "POST",
      { intentKey: flow.intentKey, firstQuestion },
    );
    if (state.materialBranching === null || state.materialBranching.token !== token) return; /* 迟到丢弃 */
    state.treeState = payload.state;
    if (payload.dispatch === "succeeded") {
      clearPendingMaterialIntent(treeId, identity); /* 首问已落库：逻辑提交完成 */
      state.materialBranching = null;
      await closeMaterialReader();
      await openBranchPanel(branchId, {
        alignCursor: false,
        trigger: { kind: "material-button", materialId: flow.selection.materialId },
      });
      if (payload.outcome === null) {
        showError(
          "Opened the branch — the first question had already landed with this intent key (idempotent replay, no duplicate dispatch).",
          "panel",
        );
      }
      return;
    }
    if (payload.dispatch === "failed") {
      state.materialBranching = {
        ...state.materialBranching,
        submitting: false,
        dispatchNote: `dispatch failed — ${String(payload.error?.code)}: ${String(payload.error?.message)}`,
      };
    } else {
      state.materialBranching = {
        ...state.materialBranching,
        submitting: false,
        dispatchNote:
          "the first question for this branch was dispatched but never reached a terminal state (the process may have exited " +
          "mid-dispatch, or another dispatch may still be in flight) — it was NOT re-sent; reconcile the branch's runs, then retry",
      };
    }
  } catch (err) {
    if (state.materialBranching === null || state.materialBranching.token !== token) return; /* 迟到丢弃 */
    if (err !== null && typeof err === "object" && err.code === "material-first-question-conflict") {
      state.materialBranching = {
        ...state.materialBranching,
        submitting: false,
        conflict: String(err && err.message ? err.message : err),
      };
    } else {
      state.materialBranching = { ...state.materialBranching, submitting: false };
      renderMaterialReader();
      throw err; /* 网络/传输失败：guard 呈现横幅，流程面保留可重试 */
    }
  }
  renderMaterialReader();
}

/** 恢复二选之「打开既有探索」：收流程面 + 关阅读器，面板打开恢复分支。 */
async function materialBranchResumeExisting() {
  const flow = state.materialBranching;
  if (flow === null || flow.phase !== "choice" || flow.branchId === null) return;
  const branchId = flow.branchId;
  state.materialBranching = null;
  await closeMaterialReader();
  /* alignCursor:false——恢复响应的 navigation 已是诚实的服务端对齐尝试
     （失败/不可用时如实随恢复分离携带，上面已呈现）；重放 /switch 只会
     复现同一失败。 */
  await openBranchPanel(branchId, {
    alignCursor: false,
    trigger: { kind: "material-button", materialId: flow.selection.materialId },
  });
}

/** 恢复二选之「显式另开」：新键新提交（from-material mode:"new"）。 */
async function materialBranchStartNew() {
  const flow = state.materialBranching;
  if (flow === null || flow.phase !== "choice") return;
  const treeId = state.currentTreeId;
  if (treeId === null) return;
  const token = flow.token;
  const intentKey = crypto.randomUUID(); /* 另开 = 新提交：换新键 */
  state.materialBranching = {
    ...flow,
    phase: "creating",
    intentKey,
    branchId: null,
    context: null,
    mode: null,
    created: false,
    restore: null,
    dispatchNote: null,
    conflict: null,
    submitting: false,
  };
  renderMaterialReader();
  try {
    /* 规范选区已由入口步骤一签发（同一选区身份）——恢复响应的 context
       携带同值（确定性）；缺失（理论不可达）时如实失败，不伪造 sourceHash。 */
    const sourceHash =
      flow.context !== null && flow.context.selection !== null ? flow.context.selection.sourceHash : null;
    if (sourceHash === null || sourceHash === "") {
      throw new Error("the canonical selection for this source is not available — restart the flow from the capture bar");
    }
    const payload = await api(
      `/api/trees/${encodeURIComponent(treeId)}/branches/from-material`,
      "POST",
      {
        selection: {
          materialId: flow.selection.materialId,
          versionId: flow.selection.versionId,
          blockId: flow.selection.blockId,
          start: flow.selection.start,
          end: flow.selection.end,
          excerpt: flow.selection.excerpt,
          sourceHash,
        },
        intentKey,
        mode: "new",
      },
    );
    if (state.materialBranching === null || state.materialBranching.token !== token) return; /* 迟到丢弃 */
    state.treeState = payload.state;
    state.materialBranching = {
      ...state.materialBranching,
      phase: "declared",
      mode: "created",
      created: payload.created === true,
      branchId: payload.branch.id,
      context: payload.context,
    };
    rememberMaterialBranchOrigin(treeId, payload.branch.id, {
      selection: payload.origin.selection,
      materialTitle: payload.context.materialTitle,
    });
    persistPendingMaterialIntent(
      treeId,
      materialSelectionIdentity(flow.selection),
      intentKey,
      state.materialBranching.firstQuestion,
    );
  } catch (err) {
    if (state.materialBranching === null || state.materialBranching.token !== token) return; /* 迟到丢弃 */
    state.materialBranching = {
      ...state.materialBranching,
      phase: "failed",
      error: String(err && err.message ? err.message : err),
    };
  }
  renderMaterialReader();
}

/**
 * 409 冲突的「改问走普通续聊」去向：收流程面 + 关阅读器，面板打开该分支
 * 并把改后的问题预填进面板 composer——发送是用户的显式动作（普通续聊，
 * 组合材料上下文已在分支既有首问的会话历史里）。输入文本保留在面板
 * composer 中待审阅。
 */
async function materialBranchContinueWithQuestion() {
  const flow = state.materialBranching;
  if (flow === null || flow.branchId === null) return;
  const branchId = flow.branchId;
  const question = flow.firstQuestion;
  state.materialBranching = null;
  await closeMaterialReader();
  await openBranchPanel(branchId, {
    alignCursor: false,
    trigger: { kind: "material-button", materialId: flow.selection.materialId },
  });
  const input = $("panel-prompt-input");
  if (input !== null && question.trim() !== "") {
    input.value = question;
    input.focus();
  }
  showError(
    "The first question on this branch is immutable — review the question below and send it as a normal continuation " +
      "(the material context already sits in the branch's first-question session).",
    "panel",
  );
}

/** 收起建枝流程面（回纯阅读；挂起的 intentKey 保留——同选区重进可续走）。 */
function closeMaterialBranchFlow() {
  if (state.materialBranching === null) return;
  state.materialBranching = null;
  renderMaterialReader();
}

/**
 * 材料 Return 卡（主线；charter §3.3 规则七 / ADR-004 §8）：材料来源没有
 * 主线对话锚点（targetAnchor 恒 null——绝不伪造），主线按确认时间放置。
 * 来源卡字段（材料标题/版本/解析器/块·页/摘录/sourceJump）从提交响应的
 * card 缓存读取；确认时间/文本/采用记录取树态实时事实（与 returnCard 同
 * 词汇：saved → attempted → delivered）。缓存缺失时如实注明（Return 完好，
 * 绝不伪造来源细节）。
 */
function materialReturnCard(turn, attempts) {
  const treeKey = `${state.currentTreeId}:${turn.id}`;
  const nowMs = Date.now();
  const div = document.createElement("div");
  div.className = "turn return material-return";
  div.dataset.turnId = turn.id;
  div.dataset.turnText = turn.text;
  turnElements.set(turn.id, div); /* 提交后滚动定位 / 反查焦点还原 */
  if (!state.knownReturnIds.has(treeKey)) {
    state.knownReturnIds.add(treeKey);
    returnInsertedAt.set(treeKey, nowMs);
  }
  const insertedAt = returnInsertedAt.get(treeKey);
  if (insertedAt !== undefined && nowMs - insertedAt < MOTION_EPOCH_MS) {
    div.classList.add("insert");
  }
  const meta = document.createElement("span");
  meta.className = "meta";
  meta.append(
    document.createTextNode(
      `↩ Return from ${branchLabel(turn.fromBranchId ?? "")} (material exploration) · saved ${formatProductTime(turn.createdAt)}`,
    ),
  );
  const delivered = turn.deliveredRunId !== null;
  const delivery = document.createElement(delivered ? "button" : "span");
  if (delivered) {
    const deliveredAttempt = attempts.find((attempt) => attempt.runId === turn.deliveredRunId);
    const adoptedNote =
      deliveredAttempt !== undefined && deliveredAttempt.terminalAt !== null
        ? `, adopted ${formatProductTime(deliveredAttempt.terminalAt)}`
        : "";
    delivery.className = "delivery delivered delivery-link";
    delivery.textContent = `successfully adopted into Trunk context (run ${turn.deliveredRunId.slice(0, 12)}…${adoptedNote})`;
    delivery.title = `first successfully adopted into Trunk run ${turn.deliveredRunId} — open sources`;
    div.dataset.deliveredRunId = turn.deliveredRunId;
    delivery.addEventListener("click", () =>
      void openDrawer({
        focusRunId: turn.deliveredRunId,
        trigger: { kind: "return-card", turnId: turn.id },
      }),
    );
  } else if (attempts.length > 0) {
    delivery.className = "delivery attempted";
    delivery.textContent = `adoption attempted (${String(attempts.length)}) — still pending, retried on the next Trunk discussion`;
    delivery.title = attempts
      .map((a) => `run ${a.runId.slice(0, 12)}… ${a.runState}${a.failure !== null ? ` (${a.failure.code})` : ""}`)
      .join("\n");
  } else {
    delivery.className = "delivery";
    delivery.textContent = "saved — pending adoption on the next Trunk discussion";
  }
  state.seenDeliveredRunIds.set(treeKey, turn.deliveredRunId);
  meta.append(delivery);
  div.append(meta);
  const card = recallMaterialReturnCard(state.currentTreeId, turn.id);
  if (card !== null) {
    const source = document.createElement("div");
    source.className = "mat-return-source";
    const fields = document.createElement("p");
    fields.className = "mat-return-source-fields";
    const pageNote = card.page !== null ? ` · page ${String(card.page)}` : "";
    fields.textContent =
      `material “${String(card.materialTitle)}” · version ${String(card.versionId)}` +
      ` (${String(card.parserKind)} ${String(card.parserVersion)}) · block ${String(card.blockId)}${pageNote}` +
      ` · confirmed ${formatProductTime(card.confirmTime)}`;
    source.append(fields);
    const quote = document.createElement("blockquote");
    quote.className = "mat-return-excerpt";
    quote.textContent = String(card.excerpt);
    source.append(quote);
    const jump = document.createElement("button");
    jump.className = "mat-return-jump";
    jump.textContent = "⌖ View material source";
    jump.title = "Open the material at the anchored version and block — the source jump never fakes a mainline position";
    jump.addEventListener("click", () =>
      void guard(
        () =>
          openMaterial(card.sourceJump.materialId, {
            trigger: { kind: "return-card", turnId: turn.id },
            versionId: card.sourceJump.versionId,
            focusBlockId: card.sourceJump.blockId,
            arrival: "return-source",
          }),
        "main",
      ),
    );
    source.append(jump);
    div.append(source);
  } else {
    div.append(
      mutedLine(
        "the material source details for this Return are not cached in this browser — the Return itself is intact and pending adoption",
      ),
    );
  }
  div.append(document.createTextNode(turn.text));
  return div;
}

/* ------------------------------ D4-2 阅读位置 ------------------------------ */

/** 滚动停止后节流保存（一次滚动只落一次 PUT）。 */
function scheduleMaterialPositionSave() {
  if (materialPositionTimer !== null) window.clearTimeout(materialPositionTimer);
  materialPositionTimer = window.setTimeout(() => {
    materialPositionTimer = null;
    saveMaterialReadingPositionNow();
  }, MATERIAL_POSITION_SAVE_DEBOUNCE_MS);
}

/**
 * 保存阅读位置（立即版：关闭/切版本/切树前冲刷）。块级定位——顶部可见
 * 块的 blockId；focusStart 区间留给 D4-3 的跳转场景。同块不重复写；块
 * 尚未载入（blockId null）时**跳过**——UPSERT 整体替换语义下写 null 会
 * 抹掉既有位置。保存失败不阻断阅读（后台尽力事实，下次节流/关闭再试）。
 */
function saveMaterialReadingPositionNow() {
  const reader = state.materialReader;
  if (reader === null || state.currentTreeId === null) return;
  if (materialPositionTimer !== null) {
    window.clearTimeout(materialPositionTimer);
    materialPositionTimer = null;
  }
  const blockId = currentMaterialTopBlockId();
  if (blockId === null) return;
  if (reader.lastSavedBlockId === blockId) return;
  reader.lastSavedBlockId = blockId;
  const treeId = state.currentTreeId;
  void api(
    `/api/trees/${encodeURIComponent(treeId)}/materials/${encodeURIComponent(reader.materialId)}/reading-position`,
    "PUT",
    { versionId: reader.versionId, blockId, focusStart: null },
  ).catch(() => {
    /* 位置保存是后台尽力事实：失败不打断阅读（下次节流/关闭重试） */
  });
}

/** 顶部可见块（几何法：首个底边越过滚动顶端的块；脚本桩高度为 0 → 回落
    首个在场块，确定性）。markdown 块与 PDF 页框都是直接子元素（均携带
    data-block-id——阅读位置对两种块型一致按块/页定位）。 */
function currentMaterialTopBlockId() {
  const reader = state.materialReader;
  if (reader === null) return null;
  const blocksEl = document.getElementById("mat-blocks");
  if (blocksEl === null) return reader.blocks.length > 0 ? reader.blocks[0].block.blockId : null;
  const base = typeof blocksEl.offsetTop === "number" ? blocksEl.offsetTop : 0;
  const scrollTop = blocksEl.scrollTop;
  let first = null;
  for (const child of blocksEl.children) {
    if (!isElementNode(child) || child.dataset.blockId === undefined) continue;
    const blockId = child.dataset.blockId;
    if (first === null) first = blockId;
    const top = (typeof child.offsetTop === "number" ? child.offsetTop : 0) - base;
    const height = typeof child.offsetHeight === "number" ? child.offsetHeight : 0;
    if (top + height > scrollTop + 1) return blockId ?? first;
  }
  return first;
}

/* ------------------------------ D4-2 版本切换 / 刷新 / 关闭 ------------------------------ */

/**
 * 显式切换版本（非破坏性：旧版本经版本链随时可切回、保持可读；切换只是
 * 阅读面换版本——本分支无锚点可迁移，D4-3 的锚点解析由服务端按各自
    versionId 判定 stale，前端绝不“迁移”到相似文字，charter §3.1）。切换
    前先把旧版本当前位置落库（服务端行随当前阅读状态整体替换）。
 */
async function switchMaterialVersion(versionId) {
  const reader = state.materialReader;
  if (reader === null || versionId === reader.versionId) return;
  const treeId = state.currentTreeId;
  if (treeId === null) return;
  saveMaterialReadingPositionNow();
  const epoch = ++materialReaderEpoch;
  state.materialSelection = null;
  reader.versionId = versionId;
  reader.blocks = [];
  reader.nextAfterBlock = null;
  reader.textUnits = 0;
  reader.firstPageState = "loading";
  reader.firstPageError = null;
  reader.appendState = "idle";
  reader.appendError = null;
  reader.fenceOpen = false;
  reader.trimmedBlocks = 0;
  reader.restoredToBlockId = null;
  reader.lastSavedBlockId = null;
  reader.searchJump = null; /* D4-4：显式切版本即离开搜索跳转目标——跳转注记随之失效（不跨版本移用） */
  const blocksEl = document.getElementById("mat-blocks");
  if (blocksEl !== null) blocksEl.replaceChildren(); /* 版本内容整体换（元素容器保留） */
  renderMaterialReader();
  await loadMaterialFirstPage(reader, { epoch, treeId });
}

/** 刷新材料详情（pending/parsing 状态的显式刷新入口）。 */
async function refreshMaterialDetail() {
  const reader = state.materialReader;
  const treeId = state.currentTreeId;
  if (reader === null || treeId === null) return;
  const epoch = ++materialReaderEpoch;
  try {
    const detail = await api(
      `/api/trees/${encodeURIComponent(treeId)}/materials/${encodeURIComponent(reader.materialId)}`,
    );
    if (
      epoch !== materialReaderEpoch ||
      state.materialReader === null ||
      state.materialReader.materialId !== reader.materialId ||
      state.currentTreeId !== treeId
    ) {
      return;
    }
    const current = state.materialReader;
    current.material = detail.material;
    current.versions = detail.versions;
    current.readingPosition = detail.readingPosition ?? null;
    if (!detail.versions.some((candidate) => candidate.id === current.versionId)) {
      /* 当前版本已不在版本链（极端）：按选择规则重选并整体重载。 */
      const chosen = chooseMaterialVersion(detail);
      current.versionId = chosen === null ? "" : chosen.id;
      current.blocks = [];
      current.fenceOpen = false;
      current.trimmedBlocks = 0;
      const blocksEl = document.getElementById("mat-blocks");
      if (blocksEl !== null) blocksEl.replaceChildren();
      renderMaterialReader();
      await loadMaterialFirstPage(current, { epoch, treeId });
      return;
    }
    renderMaterialReader();
    /* 刷新后当前版本变为 ready（解析完成）：补载正文（markdown 块 / PDF
       页框——两种 ready 块型都取块）。 */
    const version = current.versions.find((candidate) => candidate.id === current.versionId) ?? null;
    if (
      version !== null &&
      version.parseStatus === "ready" &&
      current.blocks.length === 0 &&
      current.firstPageState === "loaded"
    ) {
      await loadMaterialFirstPage(current, { epoch, treeId });
    }
  } catch (err) {
    showError(`refreshing the material failed — ${String(err && err.message ? err.message : err)}`);
  }
}

/** 关闭阅读器：位置落库（尽力）→ 状态清空 → 退出动效 → 焦点还原（W2
    键盘焦点纪律：还原到材料列表里的触发按钮）。退出动画窗口内块容器
    必须清空——退出中再次打开另一份材料时，绝不能移用上一份的块元素。 */
function closeMaterialReader() {
  if (state.materialReader === null) return;
  saveMaterialReadingPositionNow();
  state.materialReader = null;
  state.materialSelection = null;
  materialReaderEpoch += 1; /* 作废在途 detail/分页响应 */
  materialPendingUpdate = false;
  materialBarPendingUpdate = false;
  if (materialPositionTimer !== null) {
    window.clearTimeout(materialPositionTimer);
    materialPositionTimer = null;
  }
  hideMaterialReader();
  const blocksEl = document.getElementById("mat-blocks");
  if (blocksEl !== null) blocksEl.replaceChildren();
  renderMaterialsSection(); /* 列表 active 态回落（注册表先重建，再还原焦点） */
  const ref = materialReaderFocusReturn;
  materialReaderFocusReturn = null;
  restoreFocusRef(ref);
}

/** 尾部状态就地更新（首页/追加分页态、加载更多按钮、末尾注记、裁剪注记）。 */
function updateMatTail() {
  const reader = state.materialReader;
  const tail = document.getElementById("mat-tail");
  if (reader === null || tail === null) return;
  tail.replaceChildren();
  const version = reader.versions.find((candidate) => candidate.id === reader.versionId) ?? null;
  if (version === null || version.parseStatus !== "ready") {
    return; /* 非 ready：状态面在注记区，无正文尾部 */
  }
  const isPdf = materialReaderIsPdf(reader);
  const unitWord = isPdf ? "page(s)" : "block(s)";
  if (reader.firstPageState === "loading") {
    tail.append(document.createTextNode(`loading ${isPdf ? "pages" : "blocks"}…`));
    return;
  }
  if (reader.firstPageState === "failed") {
    tail.append(document.createTextNode(`loading failed — ${reader.firstPageError ?? "unknown error"} `));
    const retry = document.createElement("button");
    retry.className = "drawer-retry mat-retry-open";
    retry.textContent = "Retry";
    retry.title = "Retry opening this material";
    retry.addEventListener("click", () =>
      void openMaterial(reader.materialId, { trigger: materialReaderFocusReturn ?? undefined }),
    );
    tail.append(retry);
    return;
  }
  if (reader.appendState === "failed") {
    const error = document.createElement("span");
    error.className = "mat-tail-error";
    error.textContent = `loading more blocks failed — ${reader.appendError ?? "unknown error"} `;
    tail.append(error);
    const retry = document.createElement("button");
    retry.className = "drawer-retry mat-retry-append";
    retry.textContent = "Retry";
    retry.title = "Retry loading the next page of blocks";
    retry.addEventListener("click", () => void loadMoreMaterialBlocks());
    tail.append(retry);
    return;
  }
  if (reader.appendState === "loading") {
    tail.append(document.createTextNode("loading more blocks…"));
  } else if (reader.nextAfterBlock !== null) {
    /* 键盘可达的显式加载入口（滚贴近底自动预取，按钮是等价显式动作）。 */
    const more = document.createElement("button");
    more.className = "mat-load-more";
    more.textContent = isPdf ? "Load more pages" : "Load more blocks";
    more.title = isPdf
      ? "Load the next page of PDF pages (also loads automatically near the bottom)"
      : "Load the next page of blocks (also loads automatically near the bottom)";
    more.addEventListener("click", () => void loadMoreMaterialBlocks());
    tail.append(more);
  } else {
    tail.append(document.createTextNode(isPdf ? "end of material (last page)" : "end of material"));
  }
  tail.append(
    document.createTextNode(
      ` · ${String(reader.blocks.length)} ${unitWord} in view · ${String(reader.textUnits)} text units total`,
    ),
  );
  if (reader.trimmedBlocks > 0) {
    tail.append(
      document.createTextNode(
        ` · ${String(reader.trimmedBlocks)} earlier ${isPdf ? "page(s)" : "block(s)"} unloaded to keep the view light — ` +
          "close and reopen (or reselect the version) to read from the beginning",
      ),
    );
  }
}

/* 阅读器进出场（M1/M2 契约同 panel/drawer：hidden 属性 + .enter/.exit，
   退出播完才 hidden；reduced-motion 下 CSS 即时化）。 */
function showMaterialReader() {
  const root = $("material-reader");
  if (materialReaderAnimTimer !== null) {
    window.clearTimeout(materialReaderAnimTimer);
    materialReaderAnimTimer = null;
  }
  root.classList.remove("exit");
  if (root.hidden) {
    root.hidden = false;
    void root.offsetHeight; /* reflow：确保 enter 动画从初始态播放 */
    root.classList.add("enter");
    materialReaderAnimTimer = window.setTimeout(() => {
      root.classList.remove("enter");
      materialReaderAnimTimer = null;
    }, MATERIAL_READER_ENTER_MS);
  }
}

function hideMaterialReader(opts = {}) {
  const root = $("material-reader");
  if (materialReaderAnimTimer !== null) {
    window.clearTimeout(materialReaderAnimTimer);
    materialReaderAnimTimer = null;
  }
  root.classList.remove("enter");
  if (opts.instant || root.hidden) {
    root.hidden = true;
    root.classList.remove("exit");
    return;
  }
  root.classList.add("exit");
  materialReaderAnimTimer = window.setTimeout(() => {
    root.hidden = true;
    root.classList.remove("exit");
    materialReaderAnimTimer = null;
  }, MATERIAL_READER_EXIT_MS);
}

/* ------------------------------ D4-4 找回既有思考 · 搜索（issue #8 工作包 D4-4） ------------------------------ */

/** 来源类型词汇表（契约 §3 kinds；顺序即请求 kinds 数组的稳定顺序）。 */
const SEARCH_KIND_ORDER = ["material", "annotation", "return", "turn"];
/** 来源类型徽标文案（charter §5 的四类筛选词汇：材料/批注/Return/对话）。 */
const SEARCH_KIND_LABELS = { material: "材料", annotation: "批注", return: "Return", turn: "对话" };

/** 搜索请求世代号（P1 同族纪律）：新搜索/树切换（清空当前树范围结果时）
    递增——迟到的旧响应整包丢弃，绝不覆盖新状态。 */
let searchEpoch = 0;
/** 搜索命中行注册表（hitKey → 行按钮）：跳转面的焦点还原目标（随
    renderSearchSection 重建，取最新 DOM——同 materialListButtons 纪律）。 */
const searchHitButtons = new Map();

/** 实际生效的检索范围：用户选「当前树」且确有树打开 → tree；否则（含无树
    打开的回落）→ all（charter §5 默认当前树、可切全部树；「当前树」开关在
    无树时如实禁用，范围不悬空）。 */
function effectiveSearchScope() {
  return state.search.scope === "tree" && state.currentTreeId !== null ? "tree" : "all";
}

/** 命中行稳定标识：契约 SearchHit 未携带事实 id（HTTP 裁剪面剥离 refId），
    以契约字段组合作行键（引擎每文档恰一条命中，start/end 参与消歧）。 */
function searchHitKey(hit) {
  return `${hit.kind}:${hit.treeId}:${hit.createdAt}:${String(hit.start)}-${String(hit.end)}`;
}

/**
 * 执行搜索（POST /api/trees/:id/search | /api/search——已落地的检索端点；
 * kinds 按用户筛选透传服务端过滤）。空查询/空筛选在客户端按服务端同一规
 * 则拦下（服务端 parseSearchQuery 会 400）——如实提示，不发注定失败的请
 * 求；响应按世代丢弃（新搜索/树切换取代）。零命中如实空列表（服务端不
 * 编造，本面同样绝不编造）；hits 缺失视为坏响应（fail-closed，不伪装空）。
 */
async function runSearch() {
  const input = $("search-input");
  const text = input.value;
  state.search.note = null;
  if (text.trim() === "") {
    state.search.note = "type something to search — blank queries are rejected (they would match nothing)";
    renderSearchSection();
    return;
  }
  const kinds = [...state.search.kinds];
  if (kinds.length === 0) {
    state.search.note = "select at least one source type (材料 / 批注 / Return / 对话) — an empty filter would match nothing";
    renderSearchSection();
    return;
  }
  const scopeTreeId = effectiveSearchScope() === "tree" ? state.currentTreeId : null;
  const epoch = ++searchEpoch;
  state.search.phase = "loading";
  state.search.error = null;
  state.search.resultQuery = text;
  state.search.resultScope = scopeTreeId === null ? "all" : "tree";
  state.search.resultTreeId = scopeTreeId;
  renderSearchSection();
  try {
    const path =
      scopeTreeId === null ? "/api/search" : `/api/trees/${encodeURIComponent(scopeTreeId)}/search`;
    const payload = await api(path, "POST", { text, kinds });
    if (epoch !== searchEpoch) return; /* 迟到丢弃：已被更新的搜索/树切换取代 */
    if (payload === null || !Array.isArray(payload.hits)) {
      throw new Error("malformed search response (no hits array)");
    }
    state.search.phase = "loaded";
    state.search.hits = payload.hits;
  } catch (err) {
    if (epoch !== searchEpoch) return;
    state.search.phase = "failed";
    state.search.error = String(err && err.message ? err.message : err);
  }
  renderSearchSection();
}

/** 状态行文案（#search-status，role=status 朗读结果态变化）：三态 + 跳转
    反馈 note（同一行以「 — 」续接）。idle 恒带索引口径的诚实声明（charter
    §5：只索引已保存产品事实——未提交草稿/解释缓存结构性不入索引）。 */
function searchStatusLine() {
  const search = state.search;
  const noteSuffix = search.note === null ? "" : ` — ${search.note}`;
  if (search.phase === "loading") {
    return `searching ${search.resultScope === "tree" ? "this tree" : "all trees"}…`;
  }
  if (search.phase === "failed") {
    return `search failed — ${search.error ?? "unknown error"} (press Search to retry)${noteSuffix}`;
  }
  if (search.phase === "loaded") {
    const scopeLabel = search.resultScope === "tree" ? "in this tree" : "across all trees";
    if (search.hits.length === 0) {
      return `0 hits for “${search.resultQuery ?? ""}” ${scopeLabel} — nothing in the saved facts matches; no results are fabricated${noteSuffix}`;
    }
    return `${String(search.hits.length)} hit(s) for “${search.resultQuery ?? ""}” ${scopeLabel} — only saved facts are searched; unsubmitted drafts are never indexed${noteSuffix}`;
  }
  return `search saved facts — 材料 / 批注 / Return / 对话; unsubmitted drafts and explain caches are never indexed${noteSuffix}`;
}

/**
 * 搜索面渲染（renderAll 与本面局部动作共用；幂等）。静态表单（输入框/
 * 范围/类型/执行按钮）只同步开关态——输入值与焦点不触碰（重渲绝不夺走
 * 用户正在输入/阅读的状态）；结果列表按当前读模型整体重建（注册表随之
 * 重建）。结果按服务端返回序呈现（引擎全序：档位/类型/次数/时间/refId），
 * 客户端不重排。
 */
function renderSearchSection() {
  const hasTree = state.currentTreeId !== null;
  const wantTree = state.search.scope === "tree" && hasTree;
  const scopeTree = $("search-scope-tree");
  scopeTree.classList.toggle("active", wantTree);
  scopeTree.setAttribute("aria-pressed", wantTree ? "true" : "false");
  scopeTree.disabled = !hasTree;
  scopeTree.title = hasTree ? "" : "no tree is open — search across all trees instead";
  const scopeAll = $("search-scope-all");
  scopeAll.classList.toggle("active", !wantTree);
  scopeAll.setAttribute("aria-pressed", !wantTree ? "true" : "false");
  for (const kind of SEARCH_KIND_ORDER) {
    const button = $(`search-kind-${kind}`);
    const on = state.search.kinds.includes(kind);
    button.classList.toggle("active", on);
    button.setAttribute("aria-pressed", on ? "true" : "false");
  }
  $("search-status").textContent = searchStatusLine();
  const list = $("search-results");
  list.replaceChildren();
  searchHitButtons.clear();
  if (state.search.phase === "loading") {
    list.append(mutedListItem("searching…"));
    return;
  }
  if (state.search.phase === "failed") {
    list.append(mutedListItem(`search failed — ${state.search.error ?? "unknown error"} (press Search to retry)`));
    return;
  }
  if (state.search.phase !== "loaded") return; /* idle：状态行已承载索引口径声明 */
  if (state.search.hits.length === 0) {
    list.append(
      mutedListItem(
        `no results — nothing in the searched facts matches “${state.search.resultQuery ?? ""}” (nothing is fabricated)`,
      ),
    );
    return;
  }
  for (const hit of state.search.hits) {
    list.append(renderSearchHitRow(hit));
  }
}

/** 命中行元信息：材料行带材料名 + 版本标签（旧版本命中显式标注「旧版本」
    ——独立样式层，绝不与当前版本混淆；版本诚实同 D4-2）；全部行带时间；
    跨树命中（全部树范围）带树名（treeTitle = 树 id，与树列表同源）。 */
function buildSearchHitMeta(hit) {
  const meta = document.createElement("span");
  meta.className = "search-hit-meta";
  const appendText = (text) => {
    if (meta.children.length > 0 || meta.textContent !== "") meta.append(document.createTextNode(" · "));
    meta.append(document.createTextNode(text));
  };
  if (hit.kind === "material") {
    if (typeof hit.materialTitle === "string" && hit.materialTitle !== "") appendText(hit.materialTitle);
    if (typeof hit.versionLabel === "string" && hit.versionLabel !== "") {
      appendText(hit.versionLabel);
      if (hit.oldVersion) {
        const old = document.createElement("span");
        old.className = "search-old-version";
        old.textContent = "旧版本";
        meta.append(document.createTextNode(" · "), old);
      }
    }
  }
  appendText(formatProductTime(hit.createdAt));
  if (hit.treeId !== state.currentTreeId) appendText(hit.treeTitle);
  return meta;
}

/** 命中行：徽标（来源类型）+ 标题 + 元信息 + 摘录（含命中区间，服务端截
    断标记原样呈现）；点击跳既有视图（guard 包裹——跳转面的失败呈主线
    横幅）。session 不可用命中的「⑃ 新探索」并排入口见
    searchHitSessionNote（来源跳转永不因此受阻）。 */
function renderSearchHitRow(hit) {
  const key = searchHitKey(hit);
  const li = document.createElement("li");
  const button = document.createElement("button");
  button.className = "search-hit";
  button.dataset.hitKey = key;
  const badge = document.createElement("span");
  badge.className = `search-hit-kind k-${hit.kind}`;
  badge.textContent = SEARCH_KIND_LABELS[hit.kind];
  const title = document.createElement("span");
  title.className = "search-hit-title";
  title.textContent = hit.title;
  const meta = buildSearchHitMeta(hit);
  const excerpt = document.createElement("span");
  excerpt.className = "search-hit-excerpt";
  excerpt.textContent = hit.excerpt;
  button.append(badge, title, meta, excerpt);
  button.title = `open this ${SEARCH_KIND_LABELS[hit.kind]} hit at its source`;
  button.addEventListener("click", () => {
    closeSidebar(); /* 窄窗：跳转后收起侧栏抽屉（与树/材料选择同一纪律） */
    void guard(() => jumpToSearchHit(hit));
  });
  searchHitButtons.set(key, button);
  li.append(button);
  const session = searchHitSessionNote(hit, key);
  if (session !== null) li.append(session);
  return li;
}

/**
 * session 不可用命中的并排换轨入口（charter §3.2：来源定位与 Pi 续聊分别
 * 判断——来源跳转永不因此受阻；§5：结果跳转后可继续原探索，session 不可
 * 用时显示显式新探索入口）。只对**当前已加载树态**中可解析、且解析到
 * session 不可用分支的命中呈现（跨树命中的可用性在跳转后由该分支面板的
 * 既有 v3 §4.4 换轨面呈现——不在数据未载时猜测）。「⑃ 新探索」按命中所
 * 在分支路由：支线命中打开该支线面板并聚焦其 composer（面板的
 * 「Start new exploration」按钮即既有显式换轨入口，首问在其旁输入）；
 * 主线命中聚焦主线 composer（主线分支无面板语义——openBranchPanel 对主
 * 线早退；主线输入框旁的换轨入口就是既有面）。本入口不另造第二条换轨
 * 路径。
 */
function searchHitSessionNote(hit, key) {
  if (state.treeState === null || hit.treeId !== state.currentTreeId) return null;
  let branchId = null;
  if (hit.kind === "annotation") {
    const located = locateAnnotationHit(hit);
    branchId = located === null ? null : located.annotation.branchId;
  } else if (hit.kind === "turn" || hit.kind === "return") {
    const located = locateTurnHit(hit);
    branchId = located === null ? null : located.view.branch.id;
  } else {
    /* 材料命中：阅读不需要 session（charter §3.2 阅读与探索互不干扰）；
       D4-3 落地后，阅读器内的建枝入口承接探索去向（武装选区 → 建枝流
       程），材料命中不在此给换轨入口。 */
    return null;
  }
  if (branchId === null) return null;
  const view = branchView(branchId);
  if (view === null || view.sessionAvailability !== "unavailable") return null;
  const wrap = document.createElement("div");
  wrap.className = "search-hit-session";
  const text = document.createElement("span");
  text.className = "search-hit-session-text";
  text.textContent = "session unavailable on this branch — the saved text stays readable";
  const explore = document.createElement("button");
  explore.className = "search-hit-explore";
  explore.textContent = "⑃ 新探索";
  explore.title =
    "open this branch and type the first question — its composer carries the “Start new exploration” entry (the old Pi session cannot continue)";
  explore.addEventListener("click", () => {
    closeSidebar();
    void guard(async () => {
      /* 主线命中的换轨面是主线 composer（v3 §4.4——主线输入框旁的换轨
         入口；openBranchPanel 对主线分支本就无面板语义）；支线命中打开
         该支线面板（面板 composer 的换轨入口）。 */
      if (branchId !== trunkBranchId()) {
        await openBranchPanel(branchId, { trigger: { kind: "search-hit", hitKey: key } });
      }
    }).then(() => {
      /* guard 收尾（busy 解锁 + composer 锁定态重算）后聚焦输入框——busy
         期间输入框被瞬态禁用，聚焦必须等解锁后再判。 */
      const input = $(branchId === trunkBranchId() ? "prompt-input" : "panel-prompt-input");
      if (!input.disabled) input.focus();
    });
  });
  wrap.append(text, explore);
  return wrap;
}

/* ---------------- 命中 → 事实的客户端定位（契约无事实 id 的如实边界） ---------------- */

/**
 * 服务端 headOf 镜像（search-service.ts 的展示标题算法：trim + 24 码元 +
 * 省略号）。契约 SearchHit 被服务端剥离了事实 id（refId）——本面以
 * kind + createdAt + 标题头（同算法重建）+ 摘录切片反查已加载树态定位
 * 事实；全部命中即唯一性证据（碰撞需同一毫秒同角色同文本头），查不到则
 * 如实说明，绝不跳到近似位置。
 */
function searchHeadOf(text) {
  const trimmed = text.trim();
  return trimmed.length > 24 ? `${trimmed.slice(0, 24)}…` : trimmed;
}

/** 服务端命中标题的镜像重建（提问/回答/Return 前缀 + headOf）。 */
function searchTurnTitle(turn) {
  if (turn.role === "return") return `Return：${searchHeadOf(turn.text)}`;
  return `${turn.role === "user" ? "提问" : "回答"}：${searchHeadOf(turn.text)}`;
}

/** 摘录去头尾截断省略号——剩余应是正文连续切片（定位校验用；「…」只出现
    在截断处，中间内容是 body 的原样子串）。 */
function searchHitExcerptCore(excerpt) {
  let core = excerpt;
  if (core.startsWith("…")) core = core.slice(1);
  if (core.endsWith("…")) core = core.slice(0, -1);
  return core;
}

/** 对话/Return 命中 → 已加载树态中的 turn（读模型顺序：主线在前、分支按
    序、turn 按序——首个全匹配胜出，确定性）。 */
function locateTurnHit(hit) {
  const st = state.treeState;
  if (st === null || hit.treeId !== state.currentTreeId) return null;
  const expectedRole =
    hit.kind === "return"
      ? "return"
      : hit.title.startsWith("提问：")
        ? "user"
        : hit.title.startsWith("回答：")
          ? "assistant"
          : null;
  if (expectedRole === null) return null;
  const excerptCore = searchHitExcerptCore(hit.excerpt);
  for (const view of st.branches) {
    for (const turn of view.turns) {
      if (turn.role !== expectedRole) continue;
      if (turn.createdAt !== hit.createdAt) continue;
      if (searchTurnTitle(turn) !== hit.title) continue;
      if (excerptCore !== "" && !turn.text.includes(excerptCore)) continue;
      return { view, turn };
    }
  }
  return null;
}

/** 批注命中 → 已加载术语读模型中的批注（产品批注无 note 字段——索引正文
    = explanation+term，与服务端装配同口径）。 */
function locateAnnotationHit(hit) {
  const terminology = state.terminology;
  if (state.treeState === null || hit.treeId !== state.currentTreeId) return null;
  if (terminology === null || !terminology.ok) return null;
  const excerptCore = searchHitExcerptCore(hit.excerpt);
  for (const annotation of terminology.annotations) {
    if (annotation.createdAt !== hit.createdAt) continue;
    if (`批注：${annotation.term}` !== hit.title) continue;
    const body = `${annotation.explanation}${annotation.term}`;
    if (excerptCore !== "" && !body.includes(excerptCore)) continue;
    return { annotation };
  }
  return null;
}

/** 树态中按 id 找 turn（含其分支视图）。 */
function findTurnById(turnId) {
  const st = state.treeState;
  if (st === null) return null;
  for (const view of st.branches) {
    const turn = view.turns.find((candidate) => candidate.id === turnId);
    if (turn !== undefined) return { view, turn };
  }
  return null;
}

/* ---------------- 命中跳转（charter §5「结果跳转后可继续原探索」） ---------------- */

/**
 * 点击命中 → 打开其来源的既有视图。跨树命中（全部树范围检索）先开命中树
 * （既有 openTree 语义：树态/材料/术语读模型随之就绪），再在树内定位。
 * 搜索/跳转纯只读：不创建 Turn（charter §3.3「浏览/搜索不创建 Turn」），
 * 材料命中不开支线面板、不 POST /switch（阅读与探索互不干扰，D4-2 同
 * 纪律）；对话/批注命中落支线时走既有面板打开语义（switch 对齐游标）。
 */
async function jumpToSearchHit(hit) {
  state.search.note = null;
  const trigger = { kind: "search-hit", hitKey: searchHitKey(hit) };
  if (hit.treeId !== state.currentTreeId) {
    await openTree(hit.treeId);
  }
  if (hit.kind === "material") {
    if (typeof hit.materialId !== "string" || hit.materialId === "") {
      state.search.note = "malformed material hit (no material id) — cannot jump";
      renderSearchSection();
      return;
    }
    await openMaterial(hit.materialId, {
      trigger,
      versionId: hit.versionId,
      focusBlockId: typeof hit.blockId === "string" && hit.blockId !== "" ? hit.blockId : null,
    });
    return;
  }
  if (hit.kind === "annotation") {
    await jumpToAnnotationHit(hit, trigger);
    return;
  }
  await jumpToTurnFactHit(hit, trigger);
}

/**
 * 批注命中 → 锚定答案的既有视图 + 已保存批注卡（openSavedAnnotationCard）。
 * 锚定答案缺失/漂移 → 来源抽屉 Terminology 节（保存快照照常可读的既有
 * 视图，状态如实标注——不伪造正文定位）。术语读模型未载时先拉取（跳转
 * 面的事实依据，失败如实落入「无法定位」分支）。
 */
async function jumpToAnnotationHit(hit, trigger) {
  if (state.terminology === null || !state.terminology.ok) {
    try {
      await refreshTerminology();
    } catch {
      /* 拉取失败：locateAnnotationHit 读不到事实——落入「无法定位」分支 */
    }
  }
  const located = locateAnnotationHit(hit);
  if (located === null) {
    state.search.note =
      "the annotation could not be located in this tree's current facts — it may have changed since the search";
    renderSearchSection();
    return;
  }
  const { annotation } = located;
  const anchored = findTurnById(annotation.anchorTurnId);
  if (anchored === null) {
    await openDrawer({ trigger });
    state.search.note =
      "the annotation's anchored answer is no longer in this tree — its saved snapshot is in Sources → Terminology";
    renderSearchSection();
    return;
  }
  const branchId = anchored.view.branch.id;
  if (branchId !== trunkBranchId()) {
    await openBranchPanel(branchId, { trigger, focus: "anchor" });
  }
  revealAnchorTurn(anchored.turn.id);
  openSavedAnnotationCard(annotation, branchId, anchored.turn);
}

/**
 * 对话 / Return 命中 → 该 turn 的既有视图：主线事实直接定位（主阅读面恒
    为 Trunk——Return 卡与主线 turn 都在 #conversation）；支线事实先开
    支线面板（既有 switch 语义）再定位（滚动 + 焦点，W2 §2.6 同款）。
 */
async function jumpToTurnFactHit(hit, trigger) {
  const located = locateTurnHit(hit);
  if (located === null) {
    state.search.note = `the ${SEARCH_KIND_LABELS[hit.kind]} hit could not be located in this tree's current facts — it may have changed since the search`;
    renderSearchSection();
    return;
  }
  const { view, turn } = located;
  if (view.branch.id !== trunkBranchId()) {
    await openBranchPanel(view.branch.id, { trigger, focus: "anchor" });
  }
  revealAnchorTurn(turn.id);
}

/* ============================== D4-8 大规模树导航 ==============================
 * （issue #8 工作包 D4-8，charter §5 + §6 B9；消费 /api/nav/* 只读产品事实
 * 面——nav-engine 的 HTTP 裁剪形状见文件头 typedef）。
 *
 * 分区：树查找（finder）→ 会话（open/close）→ 子节点分页加载 → 展开/选中
 * → 持久化（PUT expand-state 整组）→ 可见行序 + 虚拟化窗口渲染 → 键盘 →
 * 路径行 → 分支搜索 → 揭示（reveal/locate/source）。所有异步写点按
 * `state.nav.session !== session` 世代守卫（迟到的旧会话响应绝不写进新会
 * 话）；所有入口自捕获失败（导航是只读面，不进 guard/busy 锁——绝不锁住
 * composer）。 */

/** 子节点分页大小（children 端点 limit 上限 500，取后端默认值 50）。 */
const NAV_CHILDREN_PAGE_LIMIT = 50;
/** 森林列表 / 搜索的分页大小（trees 端点默认 100——侧栏显式小页）。 */
const NAV_TREES_PAGE_LIMIT = 20;
/** 标题/标识搜索的分页大小。 */
const NAV_SEARCH_LIMIT = 20;
/** 虚拟化行高（px）——与 style.css 的 .nav-item 固定行高同常数。 */
const NAV_ROW_HEIGHT_PX = 34;
/** 窗口两侧的额外渲染行数（overscan）。 */
const NAV_WINDOW_OVERSCAN = 10;
/** 路径行收拢阈值（超过即默认收拢，show full path 展开完整——收拢是显示
 * 态，数据永不截断）。 */
const NAV_PATH_COLLAPSE_THRESHOLD = 6;
/** 揭示续页安全上限（单次 reveal 最多翻的子节点页数——防病态环）。 */
const NAV_REVEAL_PAGE_GUARD = 2000;

/** 渲染期注册表（renderNavTree 重建）：焦点还原与键盘定位按 id 取最新 DOM。 */
const navRowElements = new Map();
const navFinderButtons = new Map();
const navNodeHitButtons = new Map();
/** 树查找世代号（森林列表与搜索互斥——迟到的旧查找响应如实丢弃）。 */
let navFinderEpoch = 0;

/** 子节点分页条目（惰性建——首次加载才出现）。 */
function navChildEntry(session, parentId) {
  let entry = session.childPages.get(parentId);
  if (entry === undefined) {
    entry = { ids: [], nextCursor: null, totalChildren: 0, state: "idle", error: null, inFlight: null };
    session.childPages.set(parentId, entry);
  }
  return entry;
}

/* ------------------------------ 树查找（finder） ------------------------------ */

/** 森林列表首页（启动/空查询刷新/失败重试共用；三态 + 世代守卫）。 */
async function refreshNavForestListing() {
  const finder = state.nav.finder;
  const epoch = ++navFinderEpoch;
  finder.phase = "loading";
  finder.mode = "listing";
  finder.error = null;
  finder.moreError = null;
  finder.moreLoading = false;
  renderNavFinder();
  try {
    const payload = await api(`/api/nav/trees?limit=${String(NAV_TREES_PAGE_LIMIT)}`);
    if (epoch !== navFinderEpoch) return; /* 迟到丢弃 */
    finder.phase = "loaded";
    finder.listing = { trees: payload.trees, nextCursor: payload.nextCursor, totalTrees: payload.totalTrees };
  } catch (err) {
    if (epoch !== navFinderEpoch) return;
    finder.phase = "failed";
    finder.error = String(err && err.message ? err.message : err);
  }
  renderNavFinder();
}

/** 森林列表续页（More；在途禁用，失败注记可重试——不折叠已有页）。 */
async function loadNavForestMore() {
  const finder = state.nav.finder;
  if (finder.mode !== "listing" || finder.phase !== "loaded") return;
  if (finder.listing.nextCursor === null || finder.moreLoading) return;
  finder.moreLoading = true;
  finder.moreError = null;
  renderNavFinder();
  const epoch = navFinderEpoch;
  try {
    const payload = await api(
      `/api/nav/trees?limit=${String(NAV_TREES_PAGE_LIMIT)}&cursor=${encodeURIComponent(finder.listing.nextCursor)}`,
    );
    if (epoch !== navFinderEpoch) return;
    finder.listing = {
      trees: [...finder.listing.trees, ...payload.trees],
      nextCursor: payload.nextCursor,
      totalTrees: payload.totalTrees,
    };
  } catch (err) {
    if (epoch !== navFinderEpoch) return;
    finder.moreError = String(err && err.message ? err.message : err);
  }
  finder.moreLoading = false;
  renderNavFinder();
}

/** 树搜索续页（More，同森林列表纪律）。 */
async function loadNavTreeSearchMore() {
  const finder = state.nav.finder;
  if (finder.mode !== "search" || finder.phase !== "loaded") return;
  if (finder.hitCursor === null || finder.moreLoading) return;
  finder.moreLoading = true;
  finder.moreError = null;
  renderNavFinder();
  const epoch = navFinderEpoch;
  try {
    const payload = await api(
      `/api/nav/search/trees?text=${encodeURIComponent(finder.query)}&mode=substring&limit=${String(NAV_SEARCH_LIMIT)}` +
        `&cursor=${encodeURIComponent(finder.hitCursor)}`,
    );
    if (epoch !== navFinderEpoch) return;
    finder.hits = [...finder.hits, ...payload.hits];
    finder.hitCursor = payload.nextCursor;
  } catch (err) {
    if (epoch !== navFinderEpoch) return;
    finder.moreError = String(err && err.message ? err.message : err);
  }
  finder.moreLoading = false;
  renderNavFinder();
}

/** 树查找执行：空输入 = 刷新森林列表（服务端如实拒绝空文本搜索，客户端
    不发空查询）；有输入 = 标题/标识 substring 搜索。 */
async function runNavTreeFind() {
  const text = $("nav-tree-search").value.trim();
  if (text === "") {
    await refreshNavForestListing();
    return;
  }
  const finder = state.nav.finder;
  const epoch = ++navFinderEpoch;
  finder.phase = "loading";
  finder.mode = "search";
  finder.error = null;
  finder.moreError = null;
  finder.query = text;
  finder.hits = [];
  finder.hitCursor = null;
  renderNavFinder();
  try {
    const payload = await api(
      `/api/nav/search/trees?text=${encodeURIComponent(text)}&mode=substring&limit=${String(NAV_SEARCH_LIMIT)}`,
    );
    if (epoch !== navFinderEpoch) return; /* 迟到丢弃 */
    finder.phase = "loaded";
    finder.hits = payload.hits;
    finder.hitCursor = payload.nextCursor;
  } catch (err) {
    if (epoch !== navFinderEpoch) return;
    finder.phase = "failed";
    finder.error = String(err && err.message ? err.message : err);
  }
  renderNavFinder();
}

/** 列表重建 + 焦点保持（行按钮按 data 键还原；More 按钮按形态还原——
    重渲不丢正在操作的面）。 */
function navReplaceList(list, elements, registry) {
  const active = document.activeElement;
  const hadFocus = active !== null && list.contains(active);
  const wasMore = hadFocus && active.classList.contains("nav-more");
  const focusKey =
    hadFocus && active.dataset !== undefined ? active.dataset.treeId ?? active.dataset.branchId ?? null : null;
  list.replaceChildren(...elements);
  if (focusKey !== null) {
    const restored = registry.get(focusKey);
    if (restored !== undefined) restored.focus();
  } else if (wasMore) {
    const more = list.querySelector(".nav-more");
    if (more !== null) more.focus();
  }
}

/** 树查找面渲染（finder 数据变化时调用；renderAll 不重建本面）。 */
function renderNavFinder() {
  const finder = state.nav.finder;
  const list = $("nav-tree-results");
  const note = $("nav-tree-find-note");
  navFinderButtons.clear();
  const session = state.nav.session;
  const treeRow = (tree, matchedOn) => {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.dataset.treeId = tree.treeId;
    if (session !== null && session.treeId === tree.treeId) button.classList.add("active");
    const name = document.createElement("span");
    name.className = "nav-finder-name";
    name.textContent = tree.title !== null ? tree.title : tree.treeId;
    const meta = document.createElement("span");
    meta.className = "nav-finder-meta";
    const matchedNote = matchedOn === "id" ? " · matched on id" : "";
    meta.textContent = `${tree.treeId} · ${formatProductTime(tree.createdAt)}${matchedNote}`;
    button.append(name, meta);
    button.title =
      tree.title !== null
        ? `${tree.title} · ${tree.treeId}`
        : `${tree.treeId} — untitled (no first question on the trunk)`;
    button.addEventListener("click", () => {
      closeSidebar(); /* 窄窗：选树后收起侧栏抽屉（与 Forest 列表同一纪律） */
      void openNavTree(tree.treeId);
    });
    navFinderButtons.set(tree.treeId, button);
    li.append(button);
    return li;
  };
  const items = [];
  if (finder.phase === "loading") {
    items.push(mutedListItem("loading trees…"));
    note.textContent = finder.mode === "search" ? `searching trees for “${finder.query}”…` : "loading the forest…";
  } else if (finder.phase === "failed") {
    const li = document.createElement("li");
    li.className = "muted";
    li.append(document.createTextNode(`trees failed to load — ${finder.error} `));
    const retry = document.createElement("button");
    retry.className = "drawer-retry";
    retry.textContent = "Retry";
    retry.addEventListener("click", () =>
      void (finder.mode === "search" ? runNavTreeFind() : refreshNavForestListing()),
    );
    li.append(retry);
    items.push(li);
    note.textContent = "the failure stays visible with a retry — it never collapses into an empty list";
  } else if (finder.mode === "search") {
    if (finder.hits.length === 0) {
      items.push(
        mutedListItem(
          `no tree matches “${finder.query}” by title or id — nothing is fabricated (blank the input and press Find to go back to the forest listing)`,
        ),
      );
    } else {
      for (const hit of finder.hits) items.push(treeRow(hit, hit.matchedOn));
      if (finder.hitCursor !== null) {
        const li = document.createElement("li");
        const more = document.createElement("button");
        more.className = "nav-more";
        more.textContent = finder.moreLoading
          ? "loading more hits…"
          : `More tree hits (${String(finder.hits.length)} loaded)`;
        more.disabled = finder.moreLoading;
        more.addEventListener("click", () => void loadNavTreeSearchMore());
        li.append(more);
        items.push(li);
      }
    }
    note.textContent = `${String(finder.hits.length)} tree hit(s) for “${finder.query}”`;
  } else {
    const listing = finder.listing;
    if (listing.totalTrees === 0 && listing.trees.length === 0) {
      items.push(
        mutedListItem(
          "no trees in this forest yet — create one (＋ New Tree) to start; trees you create appear in both Forest and here",
        ),
      );
    } else {
      for (const tree of listing.trees) items.push(treeRow(tree, null));
      if (listing.nextCursor !== null) {
        const li = document.createElement("li");
        const more = document.createElement("button");
        more.className = "nav-more";
        more.textContent = finder.moreLoading
          ? "loading more trees…"
          : `More trees (${String(listing.trees.length)} of ${String(listing.totalTrees)})`;
        more.disabled = finder.moreLoading;
        more.addEventListener("click", () => void loadNavForestMore());
        li.append(more);
        items.push(li);
      }
    }
    note.textContent =
      listing.totalTrees > 0 ? `${String(listing.trees.length)} of ${String(listing.totalTrees)} tree(s) listed` : "";
  }
  if (finder.moreError !== null) {
    note.textContent = `${note.textContent === "" ? "" : `${note.textContent} · `}loading more failed — ${finder.moreError}`;
  }
  navReplaceList(list, items, navFinderButtons);
}

/* ------------------------------ 会话（开/关树） ------------------------------ */

/**
 * 在导航面打开一棵树（finder 结果点击 / locate 跨树 / 失败重试共用）。
 * 顺序：单树概览（含 trunkBranchId——主干节点视图由概要合成）→ 根子节点
 * 首页 + 展开状态（并行取，独立落地）→ 恢复展开集合（世代守卫：恢复揭示
 * 按需续页）。opts.reveal = {branchId, path}（locate 已带完整路径时免再拉）。
 */
async function openNavTree(treeId, opts = {}) {
  const session = {
    treeId,
    overview: null,
    overviewState: "loading",
    overviewError: null,
    nodes: new Map(),
    childPages: new Map(),
    expanded: new Set(),
    selectedBranchId: null,
    focusBranchId: null,
    path: null,
    pathShowAll: false,
    search: { phase: "idle", error: null, query: null, hits: [], nextCursor: null },
    persistError: null,
    locateNote: null,
    persistQueued: false,
    persistRunning: false,
  };
  state.nav.session = session;
  $("nav-surface").hidden = false;
  $("nav-tree-scroll").scrollTop = 0;
  $("nav-node-search").value = "";
  $("nav-node-note").textContent = "";
  renderNavSurfaceChrome();
  renderNavTree();
  renderNavPath();
  renderNavNodeResults();
  renderNavFinder(); /* active 标记随会话切换刷新 */
  try {
    const overview = await api(`/api/nav/trees/${encodeURIComponent(treeId)}`);
    if (state.nav.session !== session) return; /* 迟到丢弃 */
    session.overview = overview;
    session.overviewState = "loaded";
    /* 主干节点视图由概要合成（children 分页到达后补真实 childCount）。 */
    session.nodes.set(overview.trunkBranchId, {
      id: overview.trunkBranchId,
      treeId,
      parentBranchId: null,
      depth: 0,
      title: overview.title,
      originKind: "none",
      childCount: 0,
      createdAt: overview.createdAt,
    });
  } catch (err) {
    if (state.nav.session !== session) return;
    session.overviewState = "failed";
    session.overviewError = String(err && err.message ? err.message : err);
    renderNavSurfaceChrome();
    return;
  }
  renderNavSurfaceChrome();
  /* overview 常量只存在于上方 try 块作用域——这里取 session.overview（已 loaded）。 */
  const childrenLoad = navLoadChildrenPage(session, session.overview.trunkBranchId, "first");
  let expandPayload = null;
  try {
    expandPayload = await api(`/api/nav/trees/${encodeURIComponent(treeId)}/expand-state`);
  } catch (err) {
    if (state.nav.session !== session) return;
    /* 展开状态读失败：浏览照常（诚实注记，绝不伪造默认展开）。 */
    session.locateNote = `saved navigation state could not be read — ${String(err && err.message ? err.message : err)}`;
  }
  if (state.nav.session !== session) return;
  await childrenLoad;
  if (state.nav.session !== session) return;
  if (expandPayload !== null && expandPayload.expandState !== null) {
    const saved = expandPayload.expandState;
    session.selectedBranchId = saved.selectedBranchId ?? null;
    session.focusBranchId = saved.selectedBranchId ?? null;
    for (const id of saved.expandedBranchIds) session.expanded.add(id);
    renderNavTree(); /* 窗口内的展开节点即刻按需加载（navPumpLoads） */
    if (session.selectedBranchId !== null) {
      if (session.nodes.has(session.selectedBranchId)) {
        /* 浅层选中：已在场——补完整路径行并滚到选中行。persist:false——
           恢复读回不回写（PUT 只属于用户动作）。 */
        void selectNavNode(session.selectedBranchId, { scroll: true, persist: false });
      } else {
        /* 深层选中：沿保存的祖先链续页直到选中行可见（重启不丢位置）。 */
        void navRevealBranch(session, session.selectedBranchId, undefined, { persist: false });
      }
    }
  } else {
    renderNavTree();
  }
  if (opts.reveal !== undefined) {
    void navRevealBranch(session, opts.reveal.branchId, opts.reveal.path);
  }
}

/** 关闭导航树（回到仅树查找的面；持久化已在每次变更时整组落库）。 */
function closeNavTree() {
  state.nav.session = null;
  $("nav-surface").hidden = true;
  $("nav-tree").replaceChildren();
  renderNavFinder();
}

/* ------------------------------ 子节点分页加载 ------------------------------ */

/**
 * 子节点分页（mode "first" = 首页/重试；"next" = 游标续页）。在途合并
 * （同父级并发调用共享同一 promise）；stale-cursor 409 = 索引已失效——
 * 该父级从首页重开（旧子节点从结构缓存移除，不自愈旧游标）；其余失败
 * 如实落 failed 态（Retry 行重试）。
 */
async function navLoadChildrenPage(session, parentId, mode) {
  const entry = navChildEntry(session, parentId);
  if (entry.state === "loading" && entry.inFlight !== null) return entry.inFlight;
  if (mode === "first" && entry.ids.length > 0 && entry.state !== "failed") return Promise.resolve();
  if (mode === "next" && entry.nextCursor === null) return Promise.resolve();
  const requestCursor = mode === "next" ? entry.nextCursor : null;
  if (mode === "first" && entry.ids.length > 0) {
    /* 显式重试首页：旧子节点先出结构缓存（即将整页重建）。 */
    for (const id of entry.ids) session.nodes.delete(id);
    entry.ids = [];
  }
  entry.state = "loading";
  entry.error = null;
  const promise = (async () => {
    try {
      let path =
        `/api/nav/trees/${encodeURIComponent(session.treeId)}/branches/${encodeURIComponent(parentId)}` +
        `/children?limit=${String(NAV_CHILDREN_PAGE_LIMIT)}`;
      if (requestCursor !== null) path += `&cursor=${encodeURIComponent(requestCursor)}`;
      const payload = await api(path);
      if (state.nav.session !== session) return; /* 迟到丢弃 */
      if (mode === "first") entry.ids = [];
      for (const node of payload.nodes) {
        session.nodes.set(node.id, node);
        entry.ids.push(node.id);
      }
      entry.totalChildren = payload.totalChildren;
      entry.nextCursor = payload.nextCursor;
      entry.state = entry.nextCursor === null ? "complete" : "partial";
      if (session.overview !== null && parentId === session.overview.trunkBranchId) {
        const trunk = session.nodes.get(parentId);
        if (trunk !== undefined && trunk.childCount !== payload.totalChildren) {
          trunk.childCount = payload.totalChildren;
        }
      }
    } catch (err) {
      if (state.nav.session !== session) return;
      if (err !== null && typeof err === "object" && err.code === "stale-cursor" && requestCursor !== null) {
        /* 409：索引失效后旧游标不可续——从首页重开（一次重试；首页请求
           不带游标，不会再 stale）。 */
        navForgetChildren(session, parentId);
        await navLoadChildrenPage(session, parentId, "first");
        return;
      }
      entry.state = "failed";
      entry.error = String(err && err.message ? err.message : err);
    } finally {
      entry.inFlight = null;
      if (state.nav.session === session) renderNavTree();
    }
  })();
  entry.inFlight = promise;
  return promise;
}

/** 丢弃某父级已载子节点（stale-cursor 重开前——旧页不是事实）。 */
function navForgetChildren(session, parentId) {
  const entry = session.childPages.get(parentId);
  if (entry === undefined) return;
  for (const id of entry.ids) session.nodes.delete(id);
  session.childPages.delete(parentId);
}

/* ------------------------------ 展开 / 选中 ------------------------------ */

/** 展开/收起（鼠标 toggle 与键盘 →/← 共用；展开即按需加载首页）。 */
function navToggleExpansion(branchId) {
  const session = state.nav.session;
  if (session === null || session.overview === null) return;
  if (session.expanded.has(branchId)) {
    session.expanded.delete(branchId);
    scheduleNavPersist(session);
    renderNavTree();
    return;
  }
  session.expanded.add(branchId);
  scheduleNavPersist(session);
  if (!session.childPages.has(branchId)) {
    void navLoadChildrenPage(session, branchId, "first");
  }
  renderNavTree();
}

/**
 * 选中节点（点击行 / Enter / 路径步 / 揭示收尾共用）：选中 + 焦点 + 完整
 * 路径行（path 端点——100 层深链完整返回）+ 滚动到选中行 + 持久化。
 * opts.persist = false：重启恢复读回的选中（restore）——读回不回写，
 * PUT 只属于用户动作（展开/选中/收起）。
 */
async function selectNavNode(branchId, opts = {}) {
  const session = state.nav.session;
  if (session === null) return;
  session.selectedBranchId = branchId;
  session.focusBranchId = branchId;
  if (opts.persist !== false) scheduleNavPersist(session);
  session.path = { state: "loading", steps: [], error: null };
  renderNavPath();
  renderNavTreeActions();
  if (opts.scroll !== false) navScrollToBranch(session, branchId);
  renderNavTree();
  try {
    const payload = await api(
      `/api/nav/trees/${encodeURIComponent(session.treeId)}/branches/${encodeURIComponent(branchId)}/path`,
    );
    if (state.nav.session !== session) return;
    session.path = { state: "loaded", steps: payload.path, error: null };
  } catch (err) {
    if (state.nav.session !== session) return;
    session.path = { state: "failed", steps: [], error: String(err && err.message ? err.message : err) };
  }
  renderNavPath();
}

/** 滚动容器定位到某分支行（窗口重算使其进入渲染窗口；瞬时滚动——键盘
    连续移动不与平滑滚动竞态）。 */
function navScrollToBranch(session, branchId) {
  const scroller = $("nav-tree-scroll");
  const rows = navVisibleRows(session);
  const index = rows.findIndex((row) => row.kind === "node" && row.node.id === branchId);
  if (index < 0) return;
  const viewport = typeof scroller.clientHeight === "number" ? scroller.clientHeight : 0;
  const top = index * NAV_ROW_HEIGHT_PX;
  const bottom = top + NAV_ROW_HEIGHT_PX;
  if (bottom > scroller.scrollTop + Math.max(viewport, NAV_ROW_HEIGHT_PX) || top < scroller.scrollTop) {
    scroller.scrollTop = Math.max(0, top - Math.max(0, Math.floor((viewport - NAV_ROW_HEIGHT_PX * 3) / 2)));
  }
}

/* ------------------------------ 展开状态持久化 ------------------------------ */

/**
 * 整组持久化（PUT expand-state：expandedBranchIds 全集 + selectedBranchId
 * ——服务端校验成员归属）。串行 + 最新快照胜出：连续展开/收起不等逐个
 * PUT 完成，队列只发最新整组（乱序到达不落旧态）。失败如实注记（浏览不
 * 阻断），成功清除注记。
 */
function scheduleNavPersist(session) {
  session.persistQueued = true;
  if (session.persistRunning) return;
  session.persistRunning = true;
  const run = async () => {
    for (;;) {
      if (!session.persistQueued) break;
      session.persistQueued = false;
      const body = {
        expandedBranchIds: [...session.expanded],
        selectedBranchId: session.selectedBranchId,
      };
      try {
        await api(`/api/nav/trees/${encodeURIComponent(session.treeId)}/expand-state`, "PUT", body);
        if (state.nav.session !== session) return;
        session.persistError = null;
      } catch (err) {
        if (state.nav.session !== session) return;
        session.persistError = String(err && err.message ? err.message : err);
      }
    }
    session.persistRunning = false;
    if (state.nav.session === session) renderNavTreeStatusOnly(session);
  };
  void run();
}

/* ------------------------------ 可见行序 + 虚拟化窗口 ------------------------------ */

/**
 * 可见行序（展开集合的先序走行）：每行是 node（真实分支行）、loading（子
 * 节点在途的占位行）、more（游标续页行——分页加载的显式入口）、failed
 * （子节点加载失败 + Retry）。收起的子树零行（DOM-free——B9「收起子树
 * 不占 DOM」）。
 */
function navVisibleRows(session) {
  const rows = [];
  const overview = session.overview;
  if (overview === null) return rows;
  const trunk = session.nodes.get(overview.trunkBranchId);
  if (trunk === undefined) return rows;
  rows.push({ kind: "node", node: trunk, depth: 0 });
  const walk = (parentId, depth) => {
    if (!session.expanded.has(parentId)) return;
    const entry = session.childPages.get(parentId);
    if (entry === undefined) {
      rows.push({ kind: "loading", parentId, depth });
      return;
    }
    if (entry.state === "loading" && entry.ids.length === 0) {
      rows.push({ kind: "loading", parentId, depth });
      return;
    }
    for (const id of entry.ids) {
      const node = session.nodes.get(id);
      if (node === undefined) continue;
      rows.push({ kind: "node", node, depth });
      walk(id, depth + 1);
    }
    if (entry.state === "failed" && entry.ids.length === 0) {
      rows.push({ kind: "failed", parentId, depth, error: entry.error });
      return;
    }
    if (entry.nextCursor !== null || entry.state === "loading") {
      rows.push({
        kind: "more",
        parentId,
        depth,
        loading: entry.state === "loading",
        failed: entry.state === "failed",
        loaded: entry.ids.length,
        total: entry.totalChildren,
      });
    }
  };
  walk(trunk.id, 1);
  return rows;
}

/** 窗口行元素（node/loading/more/failed 各自的 DOM）。 */
function navRowElement(row, session) {
  if (row.kind === "node") return navNodeRowElement(row.node, row.depth, session);
  const li = document.createElement("li");
  li.className = "nav-status-row";
  if (row.kind === "loading") {
    li.textContent = row.parentId === null ? "loading the tree…" : "loading branches…";
    return li;
  }
  if (row.kind === "failed") {
    li.classList.add("failed");
    li.append(document.createTextNode(`branches failed to load — ${row.error ?? "unknown error"} `));
    const retry = document.createElement("button");
    retry.className = "drawer-retry";
    retry.textContent = "Retry";
    retry.addEventListener("click", () => {
      void navLoadChildrenPage(session, row.parentId, "first");
      renderNavTree();
    });
    li.append(retry);
    return li;
  }
  /* more */
  li.className = "nav-more-row";
  if (row.loading) {
    li.textContent = "loading more branches…";
    return li;
  }
  if (row.failed) {
    li.textContent = "loading more branches failed — press Retry";
    const retry = document.createElement("button");
    retry.className = "drawer-retry";
    retry.textContent = "Retry";
    retry.addEventListener("click", () => {
      void navLoadChildrenPage(session, row.parentId, "next");
      renderNavTree();
    });
    li.append(document.createTextNode(" "), retry);
    return li;
  }
  const more = document.createElement("button");
  more.className = "nav-more";
  more.textContent = `More branches (${String(row.loaded)} of ${String(row.total)} loaded)`;
  more.addEventListener("click", () => {
    void navLoadChildrenPage(session, row.parentId, "next");
    renderNavTree();
  });
  li.append(more);
  return li;
}

/** 分支行：行 li（roving tabindex + treeitem 语义）内 toggle 按钮 + 标签
    按钮（id 即身份——同名节点可区分；长标题 CSS 截断、title 属性全文）。 */
function navNodeRowElement(node, depth, session) {
  const li = document.createElement("li");
  li.className = "nav-item";
  li.setAttribute("role", "treeitem");
  li.setAttribute("aria-level", String(depth + 1));
  li.dataset.branchId = node.id;
  li.tabIndex = -1;
  if (node.id === session.selectedBranchId) li.classList.add("active");
  const expanded = session.expanded.has(node.id);
  const expandable = node.childCount > 0 || expanded;
  if (expandable) li.setAttribute("aria-expanded", expanded ? "true" : "false");
  if (node.id === session.focusBranchId) {
    li.classList.add("focused");
    li.tabIndex = 0;
  }
  const row = document.createElement("div");
  row.className = "nav-row";
  /* 深链缩进（上限封顶——100 层不溢出；深度事实由 aria-level/title/路径行承载）。 */
  row.setAttribute("style", `padding-left: ${String(Math.min(depth, 12) * 12)}px`);
  let toggle;
  if (expandable) {
    toggle = document.createElement("button");
    toggle.className = "nav-toggle";
    toggle.textContent = expanded ? "▾" : "▸";
    toggle.setAttribute(
      "aria-label",
      expanded
        ? `Collapse ${node.id}`
        : `Expand ${node.id} (${String(node.childCount)} direct branch${node.childCount === 1 ? "" : "es"})`,
    );
    toggle.addEventListener("click", () => {
      session.focusBranchId = node.id;
      navToggleExpansion(node.id);
    });
  } else {
    toggle = document.createElement("span");
    toggle.className = "nav-toggle leaf";
    toggle.textContent = "·";
  }
  const label = document.createElement("button");
  label.className = "nav-label";
  const title = document.createElement("span");
  title.className = "nav-title";
  title.textContent =
    node.title !== null ? node.title : node.parentBranchId === null ? "Trunk" : "(no first question yet)";
  const idChip = document.createElement("span");
  idChip.className = "nav-id";
  idChip.textContent = node.id;
  label.append(title, idChip);
  if (node.childCount > 0) {
    const count = document.createElement("span");
    count.className = "nav-count";
    count.textContent = String(node.childCount);
    label.append(count);
  }
  const depthNote = node.parentBranchId === null ? "trunk" : `depth ${String(node.depth)} · parent ${node.parentBranchId}`;
  label.title = `${node.title ?? "(no first question yet)"} · ${node.id} · ${depthNote}`;
  label.addEventListener("click", () => {
    session.focusBranchId = node.id;
    void selectNavNode(node.id);
  });
  row.append(toggle, label);
  li.append(row);
  navRowElements.set(node.id, li);
  return li;
}

/**
 * 树视图渲染（本面所有数据落点共用；幂等）：窗口外的行只留高度占位
 * （spacer）——DOM 数量随可视区域而非全量节点增长。渲染前捕获树内焦点，
 * 重建后还原到焦点行的最新元素（焦点不因窗口重划消失）。窗口内的展开
 * 未载节点与 more 行顺带按需加载（navPumpLoads——滚动即取，请求量以窗
 * 口为界）。
 */
function renderNavTree() {
  const session = state.nav.session;
  const treeEl = $("nav-tree");
  const spacerTop = $("nav-tree-spacer-top");
  const spacerBottom = $("nav-tree-spacer-bottom");
  navRowElements.clear();
  if (session === null || session.overview === null) {
    treeEl.replaceChildren();
    spacerTop.setAttribute("style", "height: 0px");
    spacerBottom.setAttribute("style", "height: 0px");
    return;
  }
  const scroller = $("nav-tree-scroll");
  const rows = navVisibleRows(session);
  const scrollTop = scroller.scrollTop;
  const viewport = typeof scroller.clientHeight === "number" ? scroller.clientHeight : 0;
  let start = Math.max(0, Math.floor(scrollTop / NAV_ROW_HEIGHT_PX) - NAV_WINDOW_OVERSCAN);
  let end = Math.min(
    rows.length,
    Math.max(start, Math.ceil((scrollTop + viewport) / NAV_ROW_HEIGHT_PX) + NAV_WINDOW_OVERSCAN),
  );
  if (start >= rows.length) {
    /* 滚过内容末端（收起后内容变短等）：窗口钉在末行。 */
    start = Math.max(0, rows.length - 1);
    end = rows.length;
  }
  if (end < start) end = start;
  const hadFocus = document.activeElement !== null && treeEl.contains(document.activeElement);
  const elements = [];
  for (let i = start; i < end; i += 1) elements.push(navRowElement(rows[i], session));
  treeEl.replaceChildren(...elements);
  spacerTop.setAttribute("style", `height: ${String(start * NAV_ROW_HEIGHT_PX)}px`);
  spacerBottom.setAttribute("style", `height: ${String(Math.max(0, rows.length - end) * NAV_ROW_HEIGHT_PX)}px`);
  session.lastCounts = { rendered: end - start, total: rows.length };
  renderNavTreeStatusOnly(session);
  navPumpLoads(session, rows, start, end);
  if (hadFocus) navRestoreTreeFocus(session);
}

/** 状态行（虚拟化口径的如实披露 + 持久化/定位注记；计数取最近一次渲染
    的窗口口径——注记更新不抹掉计数）。 */
function renderNavTreeStatusOnly(session) {
  const el = $("nav-tree-status");
  const overview = session.overview;
  const counts = session.lastCounts;
  let text = "";
  if (overview !== null && counts !== null) {
    text =
      `rendering ${String(counts.rendered)}/${String(counts.total)} visible rows (virtualized window) · ` +
      `${String(overview.nodeCount)} nodes · max depth ${String(overview.maxDepth)}`;
  }
  if (session.persistError !== null) text += ` · expand state not saved — ${session.persistError}`;
  if (session.locateNote !== null) text += ` · ${session.locateNote}`;
  el.textContent = text;
}

/** 窗口内按需加载泵：展开未载节点 → 首页；more 行（非在途/失败）→ 续页。
 *    失败绝不自动重试（Retry 行显式重试——避免失败循环）。 */
function navPumpLoads(session, rows, start, end) {
  for (let i = start; i < end && i < rows.length; i += 1) {
    const row = rows[i];
    if (row.kind === "node" && session.expanded.has(row.node.id) && !session.childPages.has(row.node.id)) {
      void navLoadChildrenPage(session, row.node.id, "first");
    } else if (row.kind === "more" && !row.loading && !row.failed) {
      void navLoadChildrenPage(session, row.parentId, "next");
    }
  }
}

/** 树内焦点还原（窗口重划后）：焦点行的最新元素（不在窗口则回滚容器——
    键盘上下文保持）。 */
function navRestoreTreeFocus(session) {
  const id = session.focusBranchId;
  if (id === null) return;
  const el = navRowElements.get(id);
  if (el !== undefined) {
    el.focus();
    return;
  }
  $("nav-tree-scroll").focus();
}

/* ------------------------------ 键盘（逐层移动与展开） ------------------------------ */

/**
 * 树视图键盘模型（charter「键盘可逐层移动与展开；焦点不因虚拟化消失」）：
 * ↑/↓ 沿可见行序逐行移动（跨层——层级导航的扁平呈现序）；→ 展开焦点行
 * （已展开则入首子行）；← 收起焦点行（已收起则回父行）；Enter 选中；Home/
 * End 首末行。移动超出渲染窗口时先滚动（瞬时）再重渲染再落焦——焦点行
 * 必在 DOM。toggle/标签按钮自身的 Enter/Space 走原生 click，不在此拦截。
 */
function navTreeKeydown(event) {
  const session = state.nav.session;
  if (session === null || session.overview === null) return;
  const key = event.key;
  if (
    key !== "ArrowDown" &&
    key !== "ArrowUp" &&
    key !== "ArrowLeft" &&
    key !== "ArrowRight" &&
    key !== "Enter" &&
    key !== " " &&
    key !== "Home" &&
    key !== "End"
  ) {
    return;
  }
  const target = event.target;
  const onButton = target !== null && typeof target === "object" && target.tagName === "BUTTON";
  if ((key === "Enter" || key === " ") && onButton) return; /* 原生按钮键盘激活 */
  const rows = navVisibleRows(session);
  const nodeRows = [];
  rows.forEach((row, index) => {
    if (row.kind === "node") nodeRows.push({ index, node: row.node });
  });
  if (nodeRows.length === 0) return;
  const currentPos = nodeRows.findIndex((entry) => entry.node.id === session.focusBranchId);
  event.preventDefault();
  if (key === "ArrowDown" || key === "ArrowUp") {
    const delta = key === "ArrowDown" ? 1 : -1;
    const fallback = delta > 0 ? 0 : nodeRows.length - 1;
    let nextPos = currentPos < 0 ? fallback : currentPos + delta;
    if (nextPos < 0) nextPos = 0;
    if (nextPos >= nodeRows.length) nextPos = nodeRows.length - 1;
    navSetFocusBranch(session, nodeRows[nextPos].node.id);
    return;
  }
  if (key === "Home" || key === "End") {
    const pos = key === "Home" ? 0 : nodeRows.length - 1;
    navSetFocusBranch(session, nodeRows[pos].node.id);
    return;
  }
  if (currentPos < 0) return;
  const node = nodeRows[currentPos].node;
  const expanded = session.expanded.has(node.id);
  if (key === "Enter" || key === " ") {
    void selectNavNode(node.id);
    return;
  }
  if (key === "ArrowRight") {
    if (!expanded && node.childCount > 0) {
      session.focusBranchId = node.id;
      navToggleExpansion(node.id);
      return;
    }
    if (expanded) {
      const child = nodeRows.find((entry) => entry.node.parentBranchId === node.id);
      if (child !== undefined) navSetFocusBranch(session, child.node.id);
    }
    return;
  }
  if (key === "ArrowLeft") {
    if (expanded) {
      session.focusBranchId = node.id;
      navToggleExpansion(node.id);
      return;
    }
    if (node.parentBranchId !== null && session.nodes.has(node.parentBranchId)) {
      navSetFocusBranch(session, node.parentBranchId);
    }
  }
}

/** 焦点行落位：置焦点分支 → 需要时瞬时滚动进窗口 → 重渲染 → 聚焦最新元素。 */
function navSetFocusBranch(session, branchId) {
  session.focusBranchId = branchId;
  navScrollToBranch(session, branchId);
  renderNavTree();
  const el = navRowElements.get(branchId);
  if (el !== undefined) el.focus();
}

/* ------------------------------ 路径行（完整父路径） ------------------------------ */

function navStepLabel(step) {
  return step.title !== null ? step.title : step.depth === 0 ? "Trunk" : step.id;
}

/** 路径行渲染：当前节点的完整根→选中链（path 端点 100 层完整返回）；长链
    默认收拢（首两步 + “show full path” + 末两步——收拢是显示态，展开后
    全部步在场）；每步可点击选中该祖先（向上导航）。 */
function renderNavPath() {
  const session = state.nav.session;
  const heading = $("nav-path-heading");
  const wrap = $("nav-path");
  wrap.replaceChildren();
  if (session === null || session.overview === null) {
    heading.textContent = "";
    return;
  }
  if (session.selectedBranchId === null) {
    heading.textContent = "no branch selected — click a row (or press Enter) to select it and see its full path";
    return;
  }
  const path = session.path;
  if (path === null || path.state === "loading") {
    heading.textContent = "loading the full path…";
    return;
  }
  if (path.state === "failed") {
    heading.textContent = `full path failed to load — ${path.error}`;
    const retry = document.createElement("button");
    retry.className = "drawer-retry";
    retry.textContent = "Retry";
    retry.addEventListener("click", () => {
      if (session.selectedBranchId !== null) void selectNavNode(session.selectedBranchId);
    });
    wrap.append(retry);
    return;
  }
  if (path.state === "idle") return;
  const steps = path.steps;
  heading.textContent = `full path · ${String(steps.length)} level(s), root → selected`;
  const stepButton = (step, isCurrent) => {
    const button = document.createElement("button");
    button.className = isCurrent ? "nav-path-step active" : "nav-path-step";
    button.textContent = navStepLabel(step);
    button.title = `select ${step.id} (depth ${String(step.depth)})`;
    button.addEventListener("click", () => void selectNavNode(step.id));
    return button;
  };
  const parts = [];
  if (steps.length > NAV_PATH_COLLAPSE_THRESHOLD && !session.pathShowAll) {
    /* 首两步 + 末两步（收拢态仍保上下文两端；隐藏层数 = 总数 − 4）。 */
    parts.push(stepButton(steps[0], false));
    parts.push(stepButton(steps[1], false));
    const more = document.createElement("button");
    more.className = "nav-path-more";
    more.textContent = `… ${String(steps.length - 4)} more level(s) — show full path`;
    more.addEventListener("click", () => {
      session.pathShowAll = true;
      renderNavPath();
    });
    parts.push(more);
    parts.push(stepButton(steps[steps.length - 2], false));
    parts.push(stepButton(steps[steps.length - 1], true));
  } else {
    steps.forEach((step, index) => parts.push(stepButton(step, index === steps.length - 1)));
  }
  const out = [];
  parts.forEach((part, index) => {
    if (index > 0) {
      const sep = document.createElement("span");
      sep.className = "nav-path-sep";
      sep.textContent = " / ";
      out.push(sep);
    }
    out.push(part);
  });
  wrap.replaceChildren(...out);
  if (steps.length > NAV_PATH_COLLAPSE_THRESHOLD && session.pathShowAll) {
    const collapse = document.createElement("button");
    collapse.className = "nav-path-more";
    collapse.textContent = "collapse path";
    collapse.addEventListener("click", () => {
      session.pathShowAll = false;
      renderNavPath();
    });
    wrap.append(collapse);
  }
}

/* ------------------------------ 分支搜索（同名消歧） ------------------------------ */

/** 分支搜索（当前导航树范围；命中携带完整路径——同名节点的身份载荷）。 */
async function runNavNodeSearch() {
  const session = state.nav.session;
  if (session === null) return;
  const text = $("nav-node-search").value.trim();
  if (text === "") {
    session.search = { phase: "idle", error: null, query: null, hits: [], nextCursor: null };
    renderNavNodeResults();
    return;
  }
  session.search.phase = "loading";
  session.search.error = null;
  session.search.query = text;
  renderNavNodeResults();
  try {
    const payload = await api(
      `/api/nav/search/branches?text=${encodeURIComponent(text)}&mode=substring` +
        `&treeId=${encodeURIComponent(session.treeId)}&limit=${String(NAV_SEARCH_LIMIT)}`,
    );
    if (state.nav.session !== session) return; /* 迟到丢弃 */
    session.search.phase = "loaded";
    session.search.hits = payload.hits;
    session.search.nextCursor = payload.nextCursor;
  } catch (err) {
    if (state.nav.session !== session) return;
    session.search.phase = "failed";
    session.search.error = String(err && err.message ? err.message : err);
  }
  renderNavNodeResults();
}

/** 分支搜索续页。 */
async function loadNavNodeSearchMore() {
  const session = state.nav.session;
  if (session === null || session.search.phase !== "loaded" || session.search.nextCursor === null) return;
  const epochSession = session;
  try {
    const payload = await api(
      `/api/nav/search/branches?text=${encodeURIComponent(session.search.query)}&mode=substring` +
        `&treeId=${encodeURIComponent(session.treeId)}&limit=${String(NAV_SEARCH_LIMIT)}` +
        `&cursor=${encodeURIComponent(session.search.nextCursor)}`,
    );
    if (state.nav.session !== epochSession) return;
    session.search.hits = [...session.search.hits, ...payload.hits];
    session.search.nextCursor = payload.nextCursor;
  } catch (err) {
    if (state.nav.session !== epochSession) return;
    session.search.error = String(err && err.message ? err.message : err);
  }
  renderNavNodeResults();
}

/** 命中路径摘要（长链首末收拢显示，完整路径在 title 属性——同名消歧的
    完整身份始终可辨）。 */
function navHitPathText(path) {
  const labels = path.map((step) => navStepLabel(step));
  if (labels.length > 6) {
    return `${labels.slice(0, 2).join(" / ")} / … / ${labels.slice(-3).join(" / ")}`;
  }
  return labels.join(" / ");
}

function renderNavNodeResults() {
  const session = state.nav.session;
  const list = $("nav-node-results");
  const note = $("nav-node-note");
  navNodeHitButtons.clear();
  if (session === null) {
    list.replaceChildren();
    note.textContent = "";
    return;
  }
  const search = session.search;
  const items = [];
  if (search.phase === "idle") {
    list.replaceChildren();
    note.textContent = "find branches by title or id — every hit carries its full path (same-name branches stay distinguishable)";
    return;
  }
  if (search.phase === "loading") {
    items.push(mutedListItem(`searching branches for “${search.query}”…`));
    note.textContent = "searching…";
  } else if (search.phase === "failed") {
    const li = document.createElement("li");
    li.className = "muted";
    li.append(document.createTextNode(`branch search failed — ${search.error} `));
    const retry = document.createElement("button");
    retry.className = "drawer-retry";
    retry.textContent = "Retry";
    retry.addEventListener("click", () => void runNavNodeSearch());
    li.append(retry);
    items.push(li);
    note.textContent = "the failure stays visible with a retry";
  } else {
    if (search.hits.length === 0) {
      items.push(
        mutedListItem(`no branch in this tree matches “${search.query}” by title or id — nothing is fabricated`),
      );
    } else {
      for (const hit of search.hits) {
        const li = document.createElement("li");
        const button = document.createElement("button");
        button.dataset.branchId = hit.branchId;
        if (hit.branchId === session.selectedBranchId) button.classList.add("active");
        const name = document.createElement("span");
        name.className = "nav-finder-name";
        name.textContent =
          (hit.title !== null ? hit.title : "(no first question yet)") +
          (hit.matchedOn === "id" ? " (matched on id)" : "");
        const meta = document.createElement("span");
        meta.className = "nav-finder-meta";
        meta.textContent = `${hit.branchId} · depth ${String(hit.depth)} · ${hit.originKind}`;
        const pathEl = document.createElement("span");
        pathEl.className = "nav-hit-path";
        pathEl.textContent = navHitPathText(hit.path);
        button.append(name, meta, pathEl);
        button.title = `${hit.branchId} · ${hit.path.map((step) => navStepLabel(step)).join(" / ")}`;
        button.addEventListener("click", () => {
          void navRevealBranch(session, hit.branchId, hit.path);
        });
        navNodeHitButtons.set(hit.branchId, button);
        li.append(button);
        items.push(li);
      }
      if (search.nextCursor !== null) {
        const li = document.createElement("li");
        const more = document.createElement("button");
        more.className = "nav-more";
        more.textContent = `More branch hits (${String(search.hits.length)} loaded)`;
        more.addEventListener("click", () => void loadNavNodeSearchMore());
        li.append(more);
        items.push(li);
      }
    }
    note.textContent = `${String(search.hits.length)} branch hit(s) for “${search.query}” in this tree`;
  }
  navReplaceList(list, items, navNodeHitButtons);
}

/* ------------------------------ 揭示（reveal / locate / source） ------------------------------ */

/**
 * 揭示某分支：沿根→该节点的完整路径逐层展开并续页（页序即创建序，目标
 * 不在已载页时按游标翻页直到出现/翻尽——有界），然后选中 + 滚动 + 聚焦。
 * locate / 分支搜索命中 / 重启恢复的深层选中共用本函数。opts.persist =
 * false 透传给收尾选中（恢复读回不回写；locate/搜索命中是用户动作，照常
 * 持久化）。
 */
async function navRevealBranch(session, branchId, pathSteps, opts = {}) {
  try {
    let steps = pathSteps;
    if (steps === undefined) {
      const payload = await api(
        `/api/nav/trees/${encodeURIComponent(session.treeId)}/branches/${encodeURIComponent(branchId)}/path`,
      );
      if (state.nav.session !== session) return;
      steps = payload.path;
    }
    if (steps === undefined || steps.length === 0) return;
    for (let i = 0; i + 1 < steps.length; i += 1) {
      const parentId = steps[i].id;
      const wantedId = steps[i + 1].id;
      if (!session.expanded.has(parentId)) session.expanded.add(parentId);
      let guard = 0;
      for (;;) {
        if (state.nav.session !== session) return;
        if (session.nodes.has(wantedId)) break;
        const entry = navChildEntry(session, parentId);
        if (entry.state === "loading" && entry.inFlight !== null) {
          await entry.inFlight; /* 与在途页合并，完成后复查 */
          continue;
        }
        if (entry.state === "failed") break; /* 该层加载失败——如实停下（Retry 行在场） */
        if (entry.ids.length === 0) {
          /* 该层从未加载（恢复早于窗口泵触发）：直接取首页。 */
          await navLoadChildrenPage(session, parentId, "first");
          guard += 1;
          continue;
        }
        if (entry.nextCursor === null) break; /* 翻尽未见——节点已不在当前事实 */
        await navLoadChildrenPage(session, parentId, "next");
        guard += 1;
        if (guard > NAV_REVEAL_PAGE_GUARD) break;
      }
    }
    if (state.nav.session !== session) return;
    if (!session.nodes.has(branchId)) {
      session.locateNote = `${branchId} is no longer reachable in this tree's current facts — no approximate node is substituted`;
      renderNavTree();
      return;
    }
    await selectNavNode(branchId, { scroll: true, persist: opts.persist !== false });
  } catch (err) {
    if (state.nav.session !== session) return;
    session.locateNote = `locating ${branchId} failed — ${String(err && err.message ? err.message : err)}`;
    renderNavTree();
  }
}

/** 定位工作台当前分支（跨树：locate 携带目标树与完整路径——切换导航树
    并续走揭示）。 */
async function navLocateCurrent() {
  const session = state.nav.session;
  if (session === null) return;
  const st = state.treeState;
  const branchId = st === null ? null : st.cursor !== null ? st.cursor.branchId : st.trunkBranchId;
  if (branchId === null || st === null) return;
  $("nav-locate-current").disabled = true;
  session.locateNote = "locating the workbench's current branch…";
  renderNavTree();
  try {
    const payload = await api(`/api/nav/branches/${encodeURIComponent(branchId)}/locate`);
    if (state.nav.session !== session) return;
    session.locateNote = null;
    if (payload.treeId !== session.treeId) {
      await openNavTree(payload.treeId, { reveal: { branchId: payload.node.id, path: payload.path } });
      return;
    }
    await navRevealBranch(session, payload.node.id, payload.path);
  } catch (err) {
    if (state.nav.session !== session) return;
    session.locateNote = `locating the current branch failed — ${String(err && err.message ? err.message : err)}`;
  } finally {
    renderNavTreeActions();
    renderNavTree();
  }
}

/**
 * 跳回所选节点的来源（既有揭示约定，产品事实——绝不由 session 可用性决
 * 定）：locate 携带 origin——turn 来源走 revealOrigin（/source 揭示 + 降级
 * 纪律）；material 来源走阅读器按版本+块定位（sourceJump 语义）；无来源
 * 如实说明。目标树不在工作台时先 openTree 进入（工作台既有开树行为）。
 */
async function navJumpToSource() {
  const session = state.nav.session;
  if (session === null || session.selectedBranchId === null) return;
  const branchId = session.selectedBranchId;
  $("nav-source-selected").disabled = true;
  session.locateNote = `revealing the origin of ${branchId}…`;
  renderNavTree();
  try {
    const locate = await api(`/api/nav/branches/${encodeURIComponent(branchId)}/locate`);
    if (state.nav.session !== session) return;
    const origin = locate.origin;
    if (origin === null) {
      session.locateNote =
        `${branchId} has no saved origin to reveal (the trunk, or a branch created without one) — nothing is faked`;
      renderNavTree();
      return;
    }
    if (state.currentTreeId !== locate.treeId) {
      await openTree(locate.treeId);
      if (state.currentTreeId !== locate.treeId) {
        throw new Error(`opening tree ${locate.treeId} in the workbench did not complete — cannot reveal the origin here`);
      }
    }
    session.locateNote = null;
    renderNavTree();
    if (origin.kind === "turn") {
      await revealOrigin(branchId);
    } else {
      await openMaterial(origin.materialId, {
        versionId: origin.versionId,
        focusBlockId: origin.blockId,
        arrival: "return-source",
        trigger: { kind: "element", element: $("nav-source-selected") },
      });
    }
  } catch (err) {
    if (state.nav.session !== session) return;
    session.locateNote = `revealing the origin failed — ${String(err && err.message ? err.message : err)}`;
    renderNavTree();
  } finally {
    renderNavTreeActions();
  }
}

/* ------------------------------ 面板 chrome / renderAll 接线 ------------------------------ */

/** 导航树头部 chrome（标题/概要/动作可用性；概要失败 + Retry；空树指引）。 */
function renderNavSurfaceChrome() {
  const session = state.nav.session;
  const title = $("nav-tree-title");
  const meta = $("nav-tree-meta");
  if (session === null) {
    $("nav-surface").hidden = true;
    title.textContent = "";
    meta.textContent = "";
    renderNavTreeActions();
    return;
  }
  if (session.overviewState === "loading") {
    title.textContent = session.treeId;
    meta.textContent = "loading the tree overview…";
  } else if (session.overviewState === "failed") {
    title.textContent = session.treeId;
    meta.replaceChildren();
    meta.append(document.createTextNode(`tree overview failed — ${session.overviewError} `));
    const retry = document.createElement("button");
    retry.className = "drawer-retry";
    retry.textContent = "Retry";
    retry.addEventListener("click", () => void openNavTree(session.treeId));
    meta.append(retry);
  } else {
    const overview = session.overview;
    title.textContent =
      overview.title !== null
        ? `${overview.title} (${overview.treeId})`
        : `${overview.treeId} — untitled (no first question on the trunk)`;
    title.title = title.textContent;
    meta.textContent = `${String(overview.nodeCount)} nodes · max depth ${String(overview.maxDepth)}`;
    if (overview.nodeCount <= 1) {
      meta.append(
        document.createTextNode(" · this tree has no branches yet — branch from any answer to grow it"),
      );
    }
  }
  renderNavTreeActions();
}

/** 动作可用性同步（renderAll 每次调用——工作台树切换即时反映；不触碰
    树视图 DOM/焦点）。 */
function renderNavTreeActions() {
  const session = state.nav.session;
  const locate = $("nav-locate-current");
  const source = $("nav-source-selected");
  const st = state.treeState;
  const workbenchBranch = st !== null ? (st.cursor !== null ? st.cursor.branchId : st.trunkBranchId) : null;
  locate.disabled = session === null || workbenchBranch === null;
  locate.title =
    workbenchBranch === null
      ? "no tree is open in the workbench — open one (Forest) to locate its current branch here"
      : `locate the workbench's current branch (${workbenchBranch}) in this navigation view`;
  source.disabled = session === null || session.selectedBranchId === null;
  source.title =
    session === null || session.selectedBranchId === null
      ? "select a branch first (click a row or press Enter)"
      : `reveal the saved origin of ${session.selectedBranchId} (turn → source reveal; material → the reader)`;
}

/** renderAll 接线面：只同步动作可用性（树查找/树视图/路径行/命中列表由
    本面函数独占管理——SSE 刷新/面板开合绝不重建虚拟化窗口）。 */
function renderNavSection() {
  renderNavTreeActions();
}

/* ------------------------------ D4-8 静态事件接线 ------------------------------ */

$("nav-tree-find").addEventListener("click", () => void runNavTreeFind());
$("nav-tree-search").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void runNavTreeFind();
  }
});
$("nav-node-find").addEventListener("click", () => void runNavNodeSearch());
$("nav-node-search").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void runNavNodeSearch();
  }
});
$("nav-tree-scroll").addEventListener("scroll", () => renderNavTree());
$("nav-tree-scroll").addEventListener("keydown", (event) => navTreeKeydown(event));
$("nav-locate-current").addEventListener("click", () => void navLocateCurrent());
$("nav-source-selected").addEventListener("click", () => void navJumpToSource());
$("nav-close-tree").addEventListener("click", () => closeNavTree());

/* ------------------------------ 窄窗侧栏抽屉 ------------------------------ */

function closeSidebar() {
  document.body.classList.remove("sidebar-open");
  $("sidebar-toggle").setAttribute("aria-expanded", "false");
}

$("sidebar-toggle").addEventListener("click", () => {
  const open = document.body.classList.toggle("sidebar-open");
  $("sidebar-toggle").setAttribute("aria-expanded", open ? "true" : "false");
});

/* ------------------------------ 滚动位置记忆（W2 §4） ------------------------------ */

$("conversation").addEventListener("scroll", () => {
  const trunk = trunkBranchId();
  if (trunk !== null) {
    state.scrollPositions.set(scrollKey(trunk), $("conversation").scrollTop);
  }
});

$("panel-conversation").addEventListener("scroll", () => {
  if (state.panelBranchId !== null) {
    state.scrollPositions.set(scrollKey(state.panelBranchId), $("panel-conversation").scrollTop);
  }
});

/* ------------------------------ 启动 ------------------------------ */

$("new-tree").addEventListener("click", () => guard(createTree));
/* 空态主操作直达（窄窗侧栏在抽屉后，不在首屏）——与侧栏「新建」同一动作。 */
$("empty-new-tree").addEventListener("click", () => guard(createTree));
/* 列表重试（W2 §2.1）：不整页刷新，重新走 GET /api/trees。 */
$("list-retry").addEventListener("click", () => void retryTreesLoad());
$("send").addEventListener("click", () => guard(() => sendPrompt("main")));
$("panel-send").addEventListener("click", () => guard(() => sendPrompt("panel"), "panel"));
$("prompt-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    guard(() => sendPrompt("main"));
  }
});
$("panel-prompt-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    guard(() => sendPrompt("panel"), "panel");
  }
});
$("submit-return").addEventListener("click", () => guard(submitReturn, "panel"));
/* 新探索（v3 §4.4）：session 不可用分支的显式换轨入口（按钮仅在不可用时
   可见，见 updateComposerLocks）。 */
$("new-exploration").addEventListener("click", () => guard(() => startNewExploration("main")));
$("panel-new-exploration").addEventListener("click", () => guard(() => startNewExploration("panel"), "panel"));
$("abort-run").addEventListener("click", () => void abortActiveRun());
$("source-drawer-toggle").addEventListener("click", () => void toggleDrawer());

/* D4-2 用户导入 UI（issue #8 owner P1）：静态导入行（按钮 + 隐藏文件选择
   input + 状态行），注册一次；状态行由 updateMaterialImportStatus 就地
   更新（renderMaterialsSection 只管列表——两不重建对方）。 */
registerMaterialImportUi();

/* D4-4 搜索表单（静态元素，注册一次；重渲只同步开关态——输入值与焦点
   绝不被 renderAll 触碰）。Enter 执行搜索（单行输入的既有语义；主输入
   框的 Cmd+Enter 是多行 textarea 的约束，不适用）。 */
$("search-run").addEventListener("click", () => void runSearch());
$("search-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void runSearch();
  }
});
$("search-scope-tree").addEventListener("click", () => {
  if (state.currentTreeId === null) return; /* 无树打开：开关已禁用——兜底防竞态 */
  state.search.scope = "tree";
  renderSearchSection();
});
$("search-scope-all").addEventListener("click", () => {
  state.search.scope = "all";
  renderSearchSection();
});
for (const kind of SEARCH_KIND_ORDER) {
  $(`search-kind-${kind}`).addEventListener("click", () => {
    const kinds = new Set(state.search.kinds);
    if (kinds.has(kind)) kinds.delete(kind);
    else kinds.add(kind);
    /* 恢复词汇表稳定顺序（kinds 请求序确定性）。 */
    state.search.kinds = SEARCH_KIND_ORDER.filter((candidate) => kinds.has(candidate));
    renderSearchSection();
  });
}

/* 面板收起动作的失败呈现在主线横幅（面板此刻已收起/未开）。 */
$("panel-close").addEventListener("click", () => void guard(() => closePanel()));
$("panel-view-source").addEventListener("click", () => {
  const view = branchView(state.panelBranchId);
  /* 跳原文是导航动作：busy 锁（防重复提交）在途时不得静默丢弃用户点击
     （实测：切枝的 /switch 在途时点击 View source 被丢弃，阅读器不开、
     无任何反馈）。有界等待锁释放后执行。 */
  void (async () => {
    for (let i = 0; i < 50 && state.busy; i += 1) await new Promise((r) => window.setTimeout(r, 100));
    if (state.busy) return;
    await guard(() => (isMaterialBranchView(view) ? materialSourceJump(state.panelBranchId) : revealOrigin(state.panelBranchId)), "panel");
  })();
});

/**
 * 材料 Branch 的「⌖ View source」（D4-3）：跳原文——阅读器打开来源材料
 * 的**锚定版本**并定位到选区所在块（sourceJump 语义：materialId/versionId/
 * blockId——不伪造主线位置）。来源缓存缺失时如实失败（无法定位即不跳）。
 */
async function materialSourceJump(branchId) {
  const origin = recallMaterialBranchOrigin(state.currentTreeId, branchId);
  if (origin === null) {
    throw new Error(
      "the material source details for this branch are not cached in this browser — it cannot be located for jumping",
    );
  }
  await openMaterial(origin.selection.materialId, {
    trigger: { kind: "element", element: $("panel-view-source") },
    versionId: origin.selection.versionId,
    focusBlockId: origin.selection.blockId,
    arrival: "return-source",
  });
}

/* Esc 语义（W2 逐屏键盘焦点行）：抽屉 → 阅读器 → 支线面板 → 侧栏抽屉
   逐层关闭，每层把焦点还原给触发元素；主线阅读时 Esc 不丢焦点。
   ③ 解释卡按内层优先插入该序列：面板内的卡先于面板关闭（卡在面板内容
   里）；主线卡在面板之后（面板覆盖主线时先收面板）；关闭还原焦点到该
   答案的解释入口（closeTermExplain）。
   D4-2 阅读器在抽屉之后、面板之前（分层关卡按表面层叠顺序：阅读器
   z-index 在支线面板之上——它是当前注意面，先于面板收起）。 */
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (state.drawerOpen) {
    event.preventDefault();
    closeDrawer();
    return;
  }
  if (state.materialReader !== null) {
    event.preventDefault();
    /* D4-3 建枝流程面是阅读器的内层面（材料范围声明/首问在提交前不丢）：
       Esc 先收流程面，再关阅读器（分层关卡同解释卡之于面板）。 */
    if (state.materialBranching !== null) {
      closeMaterialBranchFlow();
      return;
    }
    closeMaterialReader();
    return;
  }
  const termCard = state.termExplain;
  const termCardInPanel =
    termCard !== null && state.panelBranchId !== null && termCard.branchId === state.panelBranchId;
  if (state.termSuggest !== null) {
    /* ①阅读模式：预填的建议解释是最内层的瞬态确认面——先于解释卡/面板
       解除（未发任何请求）；焦点还原到该词的 chip（键盘位置不丢）。 */
    event.preventDefault();
    disarmTermSuggestion();
    return;
  }
  if (termCardInPanel) {
    event.preventDefault();
    closeTermExplain();
    return;
  }
  if (state.panelBranchId !== null) {
    event.preventDefault();
    /* busy 锁在途时不静默丢弃 Esc（同 View source 的既有修复：切枝的
       /switch 在途时按 Esc 曾被 guard 直接吞掉——面板收不起、无任何
       反馈；B7 beta 可用性探针发现。有界等待锁释放后执行）。 */
    void (async () => {
      for (let i = 0; i < 50 && state.busy; i += 1) await new Promise((r) => window.setTimeout(r, 100));
      if (state.busy) return;
      await guard(() => closePanel());
    })();
    return;
  }
  if (termCard !== null) {
    event.preventDefault();
    closeTermExplain();
    return;
  }
  if (document.body.classList.contains("sidebar-open")) {
    event.preventDefault();
    closeSidebar();
  }
});

/* ③ 触屏选区（selectionchange 武装——与 mouseUp 同一武装守卫）：长按/拖
   动把手产生的选区不必经过 mouseup 也能武装工具条。空选区的解除延迟一
   拍（0ms）判定：正在与工具条交互（焦点在工具条内）时不解除——点击工
   具条按钮时浏览会先清空选区，焦点判定让位于点击。
   D4-2 同族：阅读器正文内的选区同样经 selectionchange 武装（捕获条）；
   解除判定对两个捕获面同时生效（正文工具条/阅读器捕获条都不因点击
   而误解除）。 */
document.addEventListener("selectionchange", () => {
  const active = document.activeElement;
  if (active !== null && isElementNode(active) && withinTerminologySurface(active)) return;
  const context = findLiveSelectionTurn();
  if (context !== null) {
    armTurnSelection(context.element, context.turn, context.branchId);
    return;
  }
  if (findLiveMaterialSelection()) {
    armMaterialSelection();
    return;
  }
  window.setTimeout(() => {
    if (state.armedSelection === null && state.materialSelection === null) return;
    const still = findLiveSelectionTurn();
    if (still !== null) return;
    if (findLiveMaterialSelection()) return;
    const activeNow = document.activeElement;
    if (activeNow !== null && isElementNode(activeNow) && withinTerminologySurface(activeNow)) return;
    disarmArmedSelection();
    disarmMaterialSelection();
  }, 0);
});

/* ③ 拖拽窗口收尾（真实浏览器：mouseup 可能落在 turn 元素之外）：冲刷被
   延后的整树重渲（延后一拍，click 先于冲刷——按钮不被换走）。 */
document.addEventListener("mouseup", () => {
  if (!state.selectionDragActive) return;
  state.selectionDragActive = false;
  window.setTimeout(flushPendingRerender, 0);
});

void (async () => {
  let bootError = null;
  /* D4-8：导航面森林列表首页（只读产品事实；三态自捕获，失败不进 bootError）。 */
  void refreshNavForestListing();
  try {
    await refreshTrees();
    if (state.trees.length > 0) {
      await openTree(state.trees[0].id);
    } else {
      renderAll();
    }
  } catch (err) {
    bootError = err;
  }
  /* 初始焦点（W2 §2.1 键盘焦点顺序）：启动完成后编程设定到“新建”按钮
     （成功 / 失败路径一致落位）。仅启动这一次——后续重渲（SSE 终态刷新、
     面板开合）走 renderAll，不触碰焦点，绝不夺焦。 */
  $("new-tree").focus();
  if (bootError !== null) {
    showError(String(bootError && bootError.message ? bootError.message : bootError));
  }
})();
