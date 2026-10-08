# Studio HTTP endpoint and error implementation notes

This note was mechanically moved from the original header of `apps/studio/src/server.ts` to keep routine source reads focused. It captures implementation commentary, **not** a replacement for signed product contracts or runtime tests. Consult code and product authorities for current behavior.

---

Studio HTTP 面（node:http，零新增依赖）。

JSON API + 静态页面（public/）+ SSE 事件流（P1）。所有写路径返回更新后
的完整树状态，让最小 UI 无需本地状态同步逻辑。

错误映射：EntityNotFoundError → 404；InvalidArgumentError/
ConstraintViolationError → 400；RunNotActiveError/ReturnConflictError
（同幂等键不同内容）/NewExplorationConflictError（新探索前置条件不满足）
/契约违规（如并发 prompt，TypeError）/用户中止（TreeAIError code
"user-abort"）→ 409；其余运行期 TreeAIError → 502
（上游失败）；PersistenceError → 500；其余 → 500。

POST /api/trees/:id/branches/:branchId/source —— 锚点揭示（signed v3
§1.2：来源定位与 Pi 游标对齐分离）：source 为纯产品定位（status 三态 +
selection 快照，与 session 可用性无关），source.navigation 为
status==="available" 时对 Pi 游标的独立对齐结果（navigated / failed+code
+message——失败不降格来源状态，数据库原文照常可定位高亮）。

POST /api/trees/:id/branches/:branchId/new-exploration —— 用户显式确认的
「以保存内容开始新的探索」（signed v3 §4.4）：body {text}；200 =
{outcome, state}（新 session 首问完成，保存内容已作为上下文带入）；
409 new-exploration-conflict = 前置条件不满足（session 仍可用 / 无历史
session）；400 = 空文本。

POST /api/trees/:id/return 幂等语义（保存先于导航，signed W1 v3.0
§3.5）：新建 Return → 201；同 idempotencyKey 同内容重放 → 200（同一
returnTurn，零新写入）；同键不同内容 → 409 return-conflict。两种成功
均返回 {returnTurn, navigation, state}——navigation 为保存后回程导航
的结果（navigated / no-session / failed+code+message）：导航失败不是
HTTP 错误（Return 已保存），客户端按「已保存，返回主线失败」分开呈现；
主干尚无 session 时仍照常保存（navigation "no-session"）。

GET /api/trees/:id/events —— SSE（text/event-stream, no-store）：
连接即发送 snapshot 事件（当前 getTreeDiagnostics 投影），随后转发该
树的安全 UI 事件（按事件类型命名）；~15s 心跳注释行；客户端断开
（req close）即退订。未知树 → 404 JSON（切流之前）。事件词汇表
（payload 即 service.ts StudioEvent）：
  - snapshot        {…TreeDiagnostics}
  - run-started     {treeId, branchId, episodeId, runId}
  - message-delta   {treeId, runId, delta}
  - abort-requested {treeId, runId}
  - run-terminal    {treeId, runId, state, failure|null}
  - tool-activity   {treeId, runId, tool|null, phase, decision?}
    （phase: started|finished|denied；denied 时 decision 携带
     {outcome, reason, ruleId} 策略 provenance——参数/路径/命令绝不出境）
SSE 是瞬态推送：连接只过滤转发，不落任何状态；/state 与 /diagnostics
仍是权威读模型。

GET /api/trees/:id/journal?limit=N —— journal 保守投影（P1 来源抽屉）：
{events: [{eventId, runId, seq, occurredAt, type, summary}]}，按写入顺序
（最新在后）；limit 缺省 50、须为 1..500 的整数（否则 400）。未知树 →
404。未注入 journal → 空列表（诚实空态）。

材料 API（issue #8 D4-1，契约 §3；未注入 materials 服务 → 503 如实说明）：
  POST /api/trees/:id/materials —— 导入：原始字节 body（本地 loopback，
  无 multipart 依赖），文件名经 x-treeai-filename 头（UTF-8 百分号编码）。
  201 {material, version, created, parseTaskId} 新建；同字节重导 200（树内
  复用既有 material+version，零新行）；超限 413 material-too-large（读体
  时即拒绝，内存有界）；不支持 415 material-unsupported（未知扩展名，或
  D4-1 集成前的 .pdf——detail 如实说明，绝不伪成功）。导入即返回，版本
  由异步解析任务推进 pending → parsing → ready|failed|canceled。
  GET  /api/trees/:id/materials —— 列表（{materials:[{material, versions}]}）。
  GET  /api/trees/:id/materials/:materialId —— 详情（版本链 + 阅读位置 +
  近期解析任务）。
  POST …/materials/:materialId/versions —— 新版本（同语义/同返回码）。
  GET  …/materials/:materialId/versions/:versionId?afterBlock=&limit= ——
  canonicalText 分块读取：{blocks:[{block, text}], nextAfterBlock, textUnits}
  （缺省从头、limit 缺省 50，1..500；afterBlock 为块游标，读尽
  nextAfterBlock=null）。仅 ready 版本可读：非 ready → 409
  material-not-ready（不支持/失败/取消绝不伪装成空成功文档）。
  POST …/materials/:materialId/parse-tasks/:taskId/cancel —— 取消解析：
  200 canceled；已终态 409 parse-task-not-cancelable；treeId 参与作用域
  校验——树不存在/任务不属该树/材料未链接该树统一 404（issue #8 P1）。
  迟到结果结构性
  丢弃（版本行条件 UPDATE 由数据库仲裁，不可能复活/覆盖已取消状态）。
  PUT  …/materials/:materialId/reading-position —— 持久化阅读位置
  （{versionId, blockId?, focusStart?}；校验失败 400）→ 204 无 body。

材料阅读与来源定位 API（issue #8 D4-2，契约 §3 + D4-2 落地增量）：
  GET  …/materials/:materialId/reading-position —— 读取持久化阅读位置
  → 200 {readingPosition: MaterialReadingPosition | null}。阅读位置按
  Tree×材料持久化（charter §3.2 阅读侧）；分支探索位置是分支自身的
  产品事实（runs/turns），两者各自保留、互不覆盖。
  POST …/materials/:materialId/versions/:versionId/resolve-selection
  —— 统一区间/锚点解析：body {locator:{kind:"utf16-range"|"text-
  occurrence", …}, excerpt?, blockId?, anchor?{versionId, sourceHash?}}
  → 200 {selection, block}（规范 MaterialSelection；零误定位——绝不以
  相似文字兜底）；区间纪律拒绝 → 400 + 稳定原因码（invalid-locator/
  needle-not-found/out-of-bounds/reversed/zero-length/surrogate-split/
  combining-split/emoji-split/excerpt-mismatch/stale-version/cross-page/
  cross-block/block-mismatch）；非 ready 版本 → 409 material-not-ready。

搜索 API（issue #8 D4-4，契约 §3；未注入 search 服务 → 503 如实说明）：
  POST /api/trees/:treeId/search —— 当前树内搜索（默认范围=当前树；
  未知树 404）。POST /api/search —— 全部树搜索。body {text, kinds?}
  （kinds ⊆ material|annotation|return|turn）→ 引擎选项；200
  {hits:[SearchHit]}——契约裁剪面：可空字段缺省（非 null），引擎附加
  refId/matchType/matchCount 剥离。空/纯空白 text → 400；kinds 非法
  （非数组/空数组/未知成员）→ 400。零命中如实空数组（不编造）。搜索
  纯只读：不创建任何产品事实（项目书 §4「浏览/搜索不创建 Turn」）。

大规模树导航 API（issue #8 D4-8，charter §5；未注入 nav 服务 → 503
nav-not-wired 如实说明）：/api/nav/* 只读产品事实（trees/branches/
turns/origins），从不读 run/session 可用性——产品树 ≠ 运行 session 树
（session 全部消失时导航结果逐字节不变）。单次响应永不携带整棵树载荷
（children/subtree 均有 limit 上限 + 游标续页——按需加载）。详见区段
注释（路由清单与错误映射）；展开状态 PUT → 204，读取无状态 → null
诚实空态（重启后展开状态与阅读位置不丢：migration 0010）。

材料建枝 API（issue #8 D4-3，charter §3.3 / ADR-004；未注入 materials
  → 503 如实说明；契约 §3「from-material 拆两步」的差异记录见
  D4-contracts.md §3 D4-3 落地增量）：
  POST /api/trees/:treeId/branches/from-material —— 材料建枝（零 Run/
  Turn）+ 同来源恢复/显式另开：body {selection, intentKey,
  mode:"resume-or-create"|"new"}。mode "new" → 显式另开（新 Branch + 新
  session 意图，201 新建 / 200 同键幂等重放 / 409 同键不同选区）；mode
  "resume-or-create"（缺省）→ 同来源已有探索则恢复（200 mode:"restored"，
  续聊点导航结果与 sessionAvailability 分离携带；此时 intentKey 不绑定，
  恢复的是既有 Branch），无则按 intentKey 新建（201）。建枝只落 Branch/
  来源/首问绑定（浏览/搜索不创建 Turn——首问是独立显式提交）。
  POST /api/trees/:treeId/material-first-question —— 幂等首问（先对账
  后行动，ADR-004 决策四）：body {intentKey, firstQuestion} → 200
  {branch, dispatch, outcome, error, landed}（目标分支经 (treeId,
  intentKey) 绑定解析）；dispatch ∈ succeeded|failed|unknown（unknown =
  在途 Run 对账不决，不盲发）；首问已用不同内容落库 → 409
  material-first-question-conflict（改问走普通续聊）。
  POST /api/trees/:treeId/material-return —— 材料 Branch 的 Return
  （复用 submitReturn：保存先于导航、幂等键、采用尝试/成功分离）+
  材料来源卡（标题/版本/块·页/摘录/确认时间/采用记录 + sourceJump；
  targetAnchor 恒 null——不伪造主线锚点）：body {fromBranchId, text,
  idempotencyKey}；201 新建 / 200 同键同内容重放。
  POST …/branches/:branchId/material-new-exploration —— 缺 session 的显式
  新探索（W1 §3.4 + 材料上下文随行）：body {text} → 200 {outcome, state}。
