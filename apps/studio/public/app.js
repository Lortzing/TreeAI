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
 *  - 解释卡完整状态：in-flight / 成功（含缓存命中注记）/ 失败（诚实错
 *    误 + 重试）/ 取消（含迟到丢弃注记）/ 保存幂等命中（显示既有批注）/
 *    推广成功（同键重放如实）/ 推广冲突（409 如实 + 恢复既有探索的去
 *    向）；已推广批注呈 resume-or-create 明确二选，绝不跨语境静默复用；
 *  - 响应式（<720px 工具条/卡片全宽 + 大触点）/ 键盘（Tab 顺序、Esc 分
 *    层关卡 + 焦点还原）/ 触屏（selectionchange 武装）/ reduced-motion
 *    （卡进场动效即时化——CSS 全局降级块 + 显式规则）。
 *
 * 范围（诚实声明）：无 Markdown 渲染、无自动摘要。其余既有事实面：
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
/** @typedef {{kind:"element", element:object}|{kind:"tab", branchId:string}|{kind:"branch-button", turnId:string}|{kind:"return-card", turnId:string}|{kind:"main-input"}} FocusReturnRefT */

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
       失败时面板可能未开/已收 → 错误呈现在主线横幅。 */
    button.addEventListener("click", () => {
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

/** 焦点是否在术语面（工具条/解释卡）内——选区解除延迟判定用。 */
function withinTerminologySurface(element) {
  let current = element;
  while (current !== null && isElementNode(current)) {
    if (current.classList.contains("selection-toolbar") || current.classList.contains("term-explain-card")) {
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

/** 冲刷拖拽窗口内被延后的整树重渲（③ 选择期间不重绘的收尾）。 */
function flushPendingRerender() {
  if (!state.pendingRerender) return;
  state.pendingRerender = false;
  renderAll();
}

/** 解释卡重建后的焦点保持（③ 草稿/焦点纪律）：旧卡内聚焦的控件（首问
    输入 / 卡本身）在同 id 新卡上恢复焦点——重渲不丢打字焦点。 */
function preserveTermCardFocus() {
  const active = document.activeElement;
  if (active === null || !isElementNode(active)) return;
  if (active.id !== "term-explain-card" && active.id !== "term-first-question") return;
  const fresh = document.getElementById(active.id);
  if (fresh !== null && fresh !== active) fresh.focus();
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
  for (const node of current) {
    if (!keep.has(node)) container.removeChild(node);
  }
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
      /* 降级放置（P1）：锚点不在当前视图——targetAnchor 快照随卡传递，
         区分来源位于其他 Branch / 已变化 / 缺失，摘录照常在卡面可读。 */
      desired.push(returnCard(turn, turn.targetAnchor, returnAttemptsFor(view, turn.id), "fallback"));
      continue;
    }
    desired.push(ensureTurnElement(container, turn, branchId));
    if (turn.role === "assistant") {
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

  reconcileTopLevel(container, desired);
  preserveTermCardFocus();

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
       #7 增量验收）：刷新期间切树 → 迟到的旧树 state 不写共享树态。 */
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
  state.terminology = null;
  state.armedSelection = null;
  state.selectionDragActive = false;
  state.pendingRerender = false;
}

/** 开树世代号（P1 同族，issue #7 增量验收）：启动恢复 / 列表重试的
    openTree 不经 busy 锁——与用户点击的开树并发时，迟到的旧树 state 绝不
    覆盖更新的树切换（末次开树/建树胜出）。 */
let treeOpenEpoch = 0;

async function openTree(treeId) {
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
}

async function createTree() {
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
  if (opts.alignCursor !== false) {
    /* 切换语义保留：打开支线面板 = 服务端游标对齐该分支（POST /switch）。 */
    const payload = await api(`/api/trees/${encodeURIComponent(state.currentTreeId)}/switch`, "POST", {
      branchId,
    });
    state.treeState = payload.state;
  }
  if (switching) {
    state.panelBranchId = branchId;
    state.forcePanelSessionNote = false;
  }
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
    $("prompt-input").focus();
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
    input.focus();
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
  const payload = await api(
    `/api/trees/${encodeURIComponent(state.currentTreeId)}/branches/${encodeURIComponent(branchId)}/new-exploration`,
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
  input.focus();
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
  let submittedTurnId = null;
  let navigation = null;
  try {
    const payload = await api(`/api/trees/${encodeURIComponent(state.currentTreeId)}/return`, "POST", {
      fromBranchId: branchId,
      text,
      idempotencyKey: draft.idempotencyKey,
    });
    /* 200（同键重放）与 201（新建）同为成功：Return 已保存，清空草稿。 */
    state.treeState = payload.state;
    submittedTurnId = payload.returnTurn.id;
    navigation = payload.navigation ?? null;
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
       既有探索的明确去向；原始错误仍由 guard 呈现横幅。 */
    await refreshTerminology().catch(() => {});
    const current = state.termExplain;
    if (current !== null && current.token === card.token) {
      const freshAnnotation =
        state.terminology !== null && state.terminology.ok
          ? (state.terminology.annotations.find((a) => a.id === card.annotation.id) ?? current.annotation)
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

/** 关闭解释卡：焦点还原到该答案的解释入口（无则还原到 turn 元素——
    W2 键盘焦点纪律，与 closeDrawer 同模式）。 */
function closeTermExplain() {
  const card = state.termExplain;
  state.termExplain = null;
  renderAll();
  if (card === null) return;
  const target = termExplainButtons.get(card.turnId) ?? turnElements.get(card.turnId);
  if (target !== undefined) target.focus();
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
/* 面板收起动作的失败呈现在主线横幅（面板此刻已收起/未开）。 */
$("panel-close").addEventListener("click", () => void guard(() => closePanel()));
$("panel-view-source").addEventListener("click", () =>
  void guard(() => revealOrigin(state.panelBranchId), "panel"),
);

/* Esc 语义（W2 逐屏键盘焦点行）：抽屉 → 支线面板 → 侧栏抽屉逐层关闭，
   每层把焦点还原给触发元素；主线阅读时 Esc 不丢焦点。
   ③ 解释卡按内层优先插入该序列：面板内的卡先于面板关闭（卡在面板内容
   里）；主线卡在面板之后（面板覆盖主线时先收面板）；关闭还原焦点到该
   答案的解释入口（closeTermExplain）。 */
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (state.drawerOpen) {
    event.preventDefault();
    closeDrawer();
    return;
  }
  const termCard = state.termExplain;
  const termCardInPanel =
    termCard !== null && state.panelBranchId !== null && termCard.branchId === state.panelBranchId;
  if (termCardInPanel) {
    event.preventDefault();
    closeTermExplain();
    return;
  }
  if (state.panelBranchId !== null) {
    event.preventDefault();
    void guard(() => closePanel());
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
   具条按钮时浏览会先清空选区，焦点判定让位于点击。 */
document.addEventListener("selectionchange", () => {
  const active = document.activeElement;
  if (active !== null && isElementNode(active) && withinTerminologySurface(active)) return;
  const context = findLiveSelectionTurn();
  if (context !== null) {
    armTurnSelection(context.element, context.turn, context.branchId);
    return;
  }
  window.setTimeout(() => {
    if (state.armedSelection === null) return;
    const still = findLiveSelectionTurn();
    if (still !== null) return;
    const activeNow = document.activeElement;
    if (activeNow !== null && isElementNode(activeNow) && withinTerminologySurface(activeNow)) return;
    disarmArmedSelection();
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
