/* TreeAI Studio — D3 Core MVP 前端（vanilla JS，无构建步骤）。
 *
 * 交互模型（W2 §1–§2，issue #2 P1「主线阅读 + 局部支线」）：
 *  - 主阅读面板始终跟随主线（Trunk）：阅读、续聊、Return 卡渲染都在主线；
 *  - 支线以锚点作用域的局部侧板打开（覆盖层，不做整页 tab 切换）——
 *    面板开合与转场期间主线布局与阅读位置不动；面板头部固定常驻
 *    「来源揭示 / 回主干」操作（不随滚动消失）；
 *  - 分支 tab 保留为切换器：支线 tab = 打开该支线面板；Trunk tab = 收起
 *    面板回主线。切换仍 POST /switch（服务端对齐 Pi 游标），UI 不再整页换视图；
 *  - 锚点 Return 卡渲染在主干 targetAnchor 原分叉点附近（W1 §2.2）；
 *    confirmed → delivered 状态变化只改徽标；delivered 卡的 deliveredRunId
 *    可反查来源抽屉中该 run 的出处条目；
 *  - Return 草稿持久化于 localStorage（key = tree+branch；W1 §2.1：draft
 *    仅客户端，不落 TreeAI DB、未显式提交前永不生效）；提交成功 / 响应
 *    丢失对账命中（幂等键 + 来源分支 + 文本全同）即清除；面板打开时先对
 *    账，已落库的草稿直接丢弃并呈现 confirmed/delivered 卡；同键异容 =
 *    显式冲突（保留草稿与面板，编辑换新键）；失败保留草稿与幂等键供同键
 *    重试；
 *  - 每分支阅读位置恢复（W2 §4）：滚动位置按 tree:branch 记忆，切走再回
 *    恢复原位；接收新 turn / 流式增量的视图只在用户本就贴底时跟随贴底
 *    （已向上阅读绝不强制滚底，issue #3 P1；首次打开无记录直接落底）。
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
 *  - 缺失 session 降级（A4/W2 §2.8）：分支徽标 + 横幅（树保持可读、续聊
 *    fail-closed 且入口禁用并说明原因），恢复方式是可直接执行的按钮
 *    （从 session 仍可用的最新 assistant 答案整条建支线——近似说明见
 *    findSessionRecoveryAnchor），session-corrupt 失败时同样提示。横幅
 *    dismiss 为页面级持久状态（重渲不复活；主干恢复可用或执行恢复动作
 *    时清除）。prompt 失败（含 session-corrupt）的终局渲染是硬保证：
 *    流式占位清除、恢复横幅/降级提示、最终树态与诊断面都在错误上抛前
 *    落位（不依赖 SSE 事件收尾）。
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
/** @typedef {{id:string, treeId:string, branchId:string, episodeId:string, runId:string|null, role:"user"|"assistant"|"return", text:string, piEntryId:string|null, fromBranchId:string|null, deliveredRunId:string|null, idempotencyKey:string|null, targetAnchor:ReturnTargetAnchorT|null, createdAt:string}} TurnT */
/** @typedef {{branch:BranchT, origin:OriginT|null, originStatus:"available"|"changed"|"unavailable"|null, sessionAvailability:"available"|"unavailable"|null, turns:TurnT[]}} BranchViewT */
/** @typedef {{tree:TreeT, trunkBranchId:string|null, branches:BranchViewT[], cursor:{treeId:string,branchId:string,entryId:string}|null}} TreeStateT */
/** @typedef {{runId:string, branchId:string, episodeId:string, state:string, failure:{code:string,message:string}|null, createdAt:string, terminalAt:string|null}} RunDiagnosticsT */
/** @typedef {{treeId:string, runtimeState:"idle"|"streaming"|"aborting", activeRun:{runId:string,branchId:string,episodeId:string}|null, runs:RunDiagnosticsT[], policyDecisions:{observed:boolean, reason:string}}} TreeDiagnosticsT */
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

/** 错误横幅按视图落位：面板内动作的失败呈现在面板（W2 §2.3），其余主线。 */
function showError(message, view = "main") {
  const banner = $(view === "panel" ? "panel-error-banner" : "error-banner");
  banner.textContent = message;
  banner.hidden = false;
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
 * 续聊入口锁定（W2 §2.2 在途锁定 + §2.8 fail-closed）：
 * busy（单在途 prompt）或目标分支 session 不可用时禁用输入与发送。
 */
function updateComposerLocks() {
  const busy = state.busy;
  const trunkView = state.treeState === null ? null : branchView(trunkBranchId());
  const trunkLocked = busy || (trunkView !== null && trunkView.sessionAvailability === "unavailable");
  $("prompt-input").disabled = trunkLocked;
  $("send").disabled = trunkLocked;
  const panelView = state.panelBranchId === null ? null : branchView(state.panelBranchId);
  const panelLocked = busy || (panelView !== null && panelView.sessionAvailability === "unavailable");
  $("panel-prompt-input").disabled = panelLocked;
  $("panel-send").disabled = panelLocked;
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
    "but continuing here will fail. Recovery: start a fresh Tree, or branch from a turn whose session is still available.";
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
    reason.textContent = "no session currently available — start a new Tree or restore the session file";
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

/**
 * Return 卡片（W2 §2.4 + M3/M4）：锚点答案在当前视图内 → 紧随其后渲染
 * （meta 含选区摘录，满足“原分叉点附近”）；锚点缺失（历史 Return 或锚点在
 * 其他分支）→ 按时间顺序原位渲染并降级标注。confirmed 呈“待送达”；
 * delivered 呈送达 + deliveredRunId 反查入口（点击打开来源抽屉定位该 run）。
 *
 * M3/M4 的动效 class 在插入/状态变化后的短观测窗口（MOTION_EPOCH_MS）内
 * 随重渲保持——状态刷新（SSE 终态 + prompt 响应）可能在一个动效周期内
 * 连发两次 renderAll，窗口外不再携带（渲染幂等，不重播）。
 */
const MOTION_EPOCH_MS = 260;
const returnInsertedAt = new Map(); /* `${treeId}:${turnId}` → epoch ms */
const deliveredChangedAt = new Map(); /* `${treeId}:${turnId}` → epoch ms */

function returnCard(turn, anchor) {
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
  const anchorNote =
    anchor !== null
      ? ` · anchored on “${anchor.selection.text}” from ${branchLabel(anchor.sourceBranchId)}`
      : " · original anchor unavailable";
  meta.append(document.createTextNode(`↩ Return from ${from}${anchorNote}`));

  const delivered = turn.deliveredRunId !== null;
  const delivery = document.createElement(delivered ? "button" : "span");
  delivery.className = `delivery${delivered ? " delivered delivery-link" : ""}`;
  /* M4：confirmed → delivered 徽标切换（~100ms 颜色/文案过渡；只在已见
     confirmed 的卡上检测到状态变化时播放；reduced-motion 即时）。
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
    delivery.textContent = `delivered into Trunk context (run ${turn.deliveredRunId.slice(0, 12)}…)`;
    delivery.title = `delivered into Trunk run ${turn.deliveredRunId} — open sources`;
    div.dataset.deliveredRunId = turn.deliveredRunId;
    div.title = `delivered into Trunk run ${turn.deliveredRunId}`;
    delivery.addEventListener("click", () =>
      void openDrawer({
        focusRunId: turn.deliveredRunId,
        trigger: { kind: "return-card", turnId: turn.id },
      }),
    );
  } else {
    delivery.textContent = "confirmed — delivered on the next Trunk prompt";
  }
  state.seenDeliveredRunIds.set(treeKey, turn.deliveredRunId);
  meta.append(delivery);
  div.append(meta, document.createTextNode(turn.text));
  return div;
}

/**
 * 共享对话渲染（主线 / 面板）：turn 列表、按 targetAnchor 定位的 Return 卡、
 * 锚点高亮（M6 一次性脉冲）、流式占位（M5 静态指示）。
 * 滚动策略（W2 §2.2/§4 + issue #3）：接收新内容（stick）只在用户本就
 * 贴底时跟随贴底（平滑；reduced-motion 直接定位）——已向上阅读绝不
 * 强制滚底；其余渲染恢复该分支已记忆的阅读位置；无记录（首次打开）
 * 直接落底（自然的阅读起点，非强制拉动）。
 */
function renderTurnsInto(container, view, branchId, stick) {
  const st = state.treeState;
  /* 贴底判定取重渲前实况（replaceChildren 移除内容会改变 scrollHeight）。 */
  const wasAtBottom = isAtBottom(container);
  container.replaceChildren();
  if (view.turns.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent =
      branchId === st.trunkBranchId
        ? "Empty Trunk — send the first prompt."
        : "Empty branch — continue it with a prompt.";
    container.append(empty);
  }

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

  for (const turn of view.turns) {
    if (turn.role === "return") {
      if (isAnchored(turn)) continue; /* 已随锚点答案渲染 */
      container.append(returnCard(turn, null)); /* 降级：锚点不在当前视图 */
      continue;
    }

    const div = document.createElement("div");
    div.className = `turn ${turn.role}`;
    div.dataset.turnId = turn.id;
    div.dataset.turnText = turn.text;
    turnElements.set(turn.id, div);

    const highlight = state.sourceHighlight;
    if (
      turn.role === "assistant" &&
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
      const marked = document.createElement("mark");
      marked.className = pulse ? "source-highlight pulse" : "source-highlight";
      marked.textContent = turn.text.slice(highlight.start, highlight.end);
      div.append(
        document.createTextNode(turn.text.slice(0, highlight.start)),
        marked,
        document.createTextNode(turn.text.slice(highlight.end)),
      );
      /* 揭示后焦点可移至锚点 turn（W2 §2.6 键盘焦点行）。 */
      div.setAttribute("tabindex", "-1");
      div.classList.add("anchor-focus");
    } else {
      div.textContent = turn.text;
    }

    if (turn.role === "assistant") {
      const hint = document.createElement("span");
      hint.className = "selection-hint";
      hint.textContent = "(select text above to anchor the branch)";
      const branchButton = document.createElement("button");
      branchButton.className = "branch-here";
      branchButton.textContent = "⑃ Branch from here";
      branchHereButtons.set(turn.id, branchButton);
      branchButton.addEventListener("click", () =>
        guard(() => branchFromTurn(div, turn), branchId === st.trunkBranchId ? "main" : "panel"),
      );
      div.append(document.createElement("br"), branchButton, hint);
      div.addEventListener("mouseup", () => {
        const sel = selectionOffsetsWithin(div, turn.text);
        div.classList.toggle("has-selection", sel !== null);
        branchButton.textContent =
          sel !== null ? "⑃ Branch from selection" : "⑃ Branch from here";
      });
    }
    container.append(div);

    if (turn.role === "assistant") {
      for (const returnTurn of anchoredReturns.get(turn.id) ?? []) {
        container.append(returnCard(returnTurn, returnTurn.targetAnchor));
      }
    }
  }

  /* P1 流式占位回显：在途 run 位于本视图分支时追加瞬态占位 turn
     （run-terminal 后由 /state 权威刷新取代）。 */
  const streaming = state.streaming;
  if (streaming !== null && streaming.branchId === branchId) {
    const placeholder = document.createElement("div");
    placeholder.id = "streaming-turn";
    placeholder.className = "turn assistant streaming-turn";
    placeholder.append(document.createTextNode(streaming.text));
    /* M5：静态 streaming 指示——无循环动画（caret 不闪烁）。 */
    const caret = document.createElement("span");
    caret.className = "streaming-caret";
    caret.textContent = " ▍ streaming…";
    placeholder.append(caret);
    container.append(placeholder);
  }

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
        "but continuing here will fail. Recovery: start a fresh Tree, or branch from a turn whose session is still available.",
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
  const stickBranch = opts.stick ?? null;
  /* 渲染期注册表重建（焦点还原 / 锚点定位取最新 DOM）。 */
  tabButtons.clear();
  branchHereButtons.clear();
  turnElements.clear();
  const hasTree = state.treeState !== null;
  $("empty-state").hidden = hasTree;
  $("tree-view").hidden = !hasTree;
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

  /* 如实呈现：无工具执行器 → 未观测任何策略决策（不声称未接入的执行）。 */
  $("policy-note").textContent =
    diag.policyDecisions.observed === false
      ? `policy: no decisions observed — ${diag.policyDecisions.reason}`
      : "policy: decisions observed";
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
       接收新 turn 的视图贴底；另一视图恢复其阅读位置。 */
    void (async () => {
      try {
        state.treeState = await api(`/api/trees/${encodeURIComponent(state.currentTreeId)}/state`);
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

/* ------------------------------ 动作 ------------------------------ */

async function refreshTrees() {
  const payload = await api("/api/trees");
  state.trees = payload.trees;
  renderTrees();
}

function resetTransientView() {
  state.sourceHighlight = null;
  state.activeRunInfo = null;
  state.streaming = null;
  state.forceSessionBanner = false;
  state.forcePanelSessionNote = false;
}

async function openTree(treeId) {
  const treeState = await api(`/api/trees/${encodeURIComponent(treeId)}/state`);
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
}

async function createTree() {
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
  if (trunk !== null && state.currentTreeId !== null) {
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
 * 锚点揭示（W2 §2.6）：available → 定位 + 一次性脉冲高亮 + 滚动 + 焦点
 * 移至锚点 turn；锚点在主线 → 主面板内揭示（面板保持打开）；锚点在其他
 * 支线 → 打开该支线面板呈现。changed/unavailable → 降级不伪造：摘录仍在
 * 面板头部可读，如实报告状态。降级路径同样先落地服务端返回的 state——
 * 徽标 / 降级提示必须与服务端判定一致（W1 §3.4 如实呈现），绝不能出现
 * 「错误说降级、徽标仍 available」的矛盾 UI。
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
    return;
  }
  state.sourceHighlight = {
    branchId: payload.source.sourceBranchId,
    turnId: payload.source.anchorTurnId,
    start: payload.source.selection.start,
    end: payload.source.selection.end,
  };
  if (payload.source.sourceBranchId === trunkBranchId()) {
    renderAll();
    revealAnchorTurn(payload.source.anchorTurnId);
    return;
  }
  await openBranchPanel(payload.source.sourceBranchId, {
    alignCursor: false,
    focus: "anchor",
    trigger: { kind: "element", element: $("panel-view-source") },
  });
  revealAnchorTurn(payload.source.anchorTurnId);
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
 */
async function branchFromTurn(turnElement, turn) {
  const selection =
    selectionOffsetsWithin(turnElement, turn.text) ??
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
 * 200 重放与 201 新建同为成功。响应丢失先按 /state 对账（键 + 来源分支 +
 * 文本全同命中 → 按成功处理，不重复提交；同键异容 → 显式冲突：保留草稿
 * 与面板、不清空已编辑文本、不把旧 Return 伪装成成功，编辑即换新键）。
 * 提交成功 → 草稿清除、面板收起、焦点回主线输入框（回程），主线滚到新
 * Return 卡（原分叉点附近）。失败 → 草稿与键保留（localStorage 持久化），
 * 同键可重试、改写即换新键。
 */
async function submitReturn() {
  const branchId = state.panelBranchId;
  if (branchId === null) return;
  const input = $("return-input");
  const text = input.value;
  if (text.trim() === "") return;
  const draft = ensureReturnDraft(branchId);
  let submittedTurnId = null;
  try {
    const payload = await api(`/api/trees/${encodeURIComponent(state.currentTreeId)}/return`, "POST", {
      fromBranchId: branchId,
      text,
      idempotencyKey: draft.idempotencyKey,
    });
    /* 200（同键重放）与 201（新建）同为成功：清空草稿，回主线。 */
    state.treeState = payload.state;
    submittedTurnId = payload.returnTurn.id;
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
  /* 收尾（回主干 + 滚到新 Return 卡）：Return 本身已成功；面板此刻正在
     收起，收尾（游标对齐）失败呈现在主线横幅（可见面）——不吞错，也不把
     已成功的提交伪装成失败（面板已收起，面板横幅不可见）。 */
  try {
    await closePanel({ focus: "main-input" });
  } catch (err) {
    showError(String(err && err.message ? err.message : err));
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
  renderDrawer();
  showDrawer();
  $("source-drawer").focus(); /* 焦点入抽屉（W2 §2.7） */
  void loadJournal();
}

/**
 * journal 拉取（打开与重试共用）：成功 / 失败如实落三态（W2 §2.7
 * 打开-加载失败；issue #3 P1——失败绝不折叠成空数组伪装成“无事件”）。
 */
async function loadJournal() {
  if (state.currentTreeId === null) return;
  state.journalEvents = null;
  renderDrawer();
  try {
    const payload = await api(`/api/trees/${encodeURIComponent(state.currentTreeId)}/journal?limit=20`);
    state.journalEvents = { ok: true, events: payload.events };
  } catch {
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
  const title = document.createElement("h2");
  title.textContent = "Sources";
  drawer.append(title);

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

  /* Return 出处。 */
  const returnsTitle = document.createElement("h3");
  returnsTitle.textContent = "Returns";
  drawer.append(returnsTitle);
  const st = state.treeState;
  const returns = st === null ? [] : st.branches.flatMap((view) => view.turns.filter((t) => t.role === "return"));
  if (returns.length === 0) {
    drawer.append(mutedLine("no returns submitted for this tree yet"));
  } else {
    const list = document.createElement("ul");
    list.className = "drawer-list";
    for (const turn of returns) {
      const li = document.createElement("li");
      const anchor = turn.targetAnchor;
      const anchorNote =
        anchor === null
          ? "original anchor unavailable"
          : `anchored on “${anchor.selection.text}” from ${branchLabel(anchor.sourceBranchId)}`;
      const delivery =
        turn.deliveredRunId === null
          ? "not yet delivered"
          : `delivered into run ${turn.deliveredRunId.slice(0, 12)}…`;
      li.textContent = `from ${branchLabel(turn.fromBranchId ?? "")} · ${anchorNote} · ${delivery}`;
      list.append(li);
    }
    drawer.append(list);
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
      li.textContent = `run ${activity.runId.slice(0, 12)}… · ${activity.tool ?? "unknown tool"} ${activity.phase}`;
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
$("abort-run").addEventListener("click", () => void abortActiveRun());
$("source-drawer-toggle").addEventListener("click", () => void toggleDrawer());
/* 面板收起动作的失败呈现在主线横幅（面板此刻已收起/未开）。 */
$("panel-close").addEventListener("click", () => void guard(() => closePanel()));
$("panel-view-source").addEventListener("click", () =>
  void guard(() => revealOrigin(state.panelBranchId), "panel"),
);

/* Esc 语义（W2 逐屏键盘焦点行）：抽屉 → 支线面板 → 侧栏抽屉逐层关闭，
   每层把焦点还原给触发元素；主线阅读时 Esc 不丢焦点。 */
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (state.drawerOpen) {
    event.preventDefault();
    closeDrawer();
    return;
  }
  if (state.panelBranchId !== null) {
    event.preventDefault();
    void guard(() => closePanel());
    return;
  }
  if (document.body.classList.contains("sidebar-open")) {
    event.preventDefault();
    closeSidebar();
  }
});

void (async () => {
  try {
    await refreshTrees();
    if (state.trees.length > 0) {
      await openTree(state.trees[0].id);
    } else {
      renderAll();
    }
  } catch (err) {
    showError(String(err && err.message ? err.message : err));
  }
})();
