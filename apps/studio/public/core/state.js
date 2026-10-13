/** Initial instance-owned Studio transient/read-model state; persistent product truth remains in the database. Instance-owned state and dependencies. */

export function createStudioState(deps) {

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

  return {
    state,
  };
}
