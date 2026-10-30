import { registerWorkspaceEvents } from "./controllers/workspace-events.js";
import { registerApiSettings } from "./controllers/api-settings.js";
import { createStudioFeatures } from "./compose-features.js";

import { createStudioState } from "./state.js";

/**
 * Studio state factory. Every start owns its state, event listeners,
 * pollers, SSE connection, render caches and DOM integration.
 * Domain controllers/views are assembled in compose-features.js;
 * this entrypoint owns startup, static event wiring and lifecycle.
 */

import { isElementNode } from "./dom.js";

import { SEARCH_KIND_ORDER } from "./views/search.js";

export function createStudioApp(deps) {
  const { document, window, fetch, EventSource, navigator, localStorage, crypto } = deps;
  const docListeners = [];
  let started = false;
  let cleanup = () => {};

  function registerDocumentListener(name, listener, options) {
    document.addEventListener(name, listener, options);
    docListeners.push([name, listener, options]);
  }

  function start() {
    if (started) return;
    started = true;
    const disposeApiSettings = registerApiSettings({ document, fetch });
const studioState = createStudioState({

});
const { state } = studioState;
const studioFeatures = createStudioFeatures({
  get state() { return state; },
  get window() { return window; },
  get EventSource() { return EventSource; },
  get document() { return document; },
  get crypto() { return crypto; },
  get fetch() { return fetch; },
  get navigator() { return navigator; },
});
const {
  disposeGenerativeUi,
  sessionUI, setWorkspaceView, moveSessionRound, scrollBehavior, openMaterial,
  $,
  persistReturnDraft,
  runNavTreeFind,
  runNavNodeSearch,
  renderNavTree,
  navTreeKeydown,
  navLocateCurrent,
  navJumpToSource,
  closeNavTree,
  trunkBranchId,
  scrollKey,
  guard,
  createTree,
  retryTreesLoad,
  sendPrompt,
  submitReturn,
  startNewExploration,
  abortActiveRun,
  toggleDrawer,
  registerMaterialImportUi,
  runSearch,
  renderSearchSection,
  closePanel,
  branchView,
  isMaterialBranchView,
  materialSourceJump,
  revealOrigin,
  closeDrawer,
  closeMaterialBranchFlow,
  closeMaterialReader,
  disarmTermSuggestion,
  closeTermExplain,
  closeSidebar,
  withinTerminologySurface,
  findLiveSelectionTurn,
  armTurnSelection,
  findLiveMaterialSelection,
  armMaterialSelection,
  disarmArmedSelection,
  disarmMaterialSelection,
  flushPendingRerender,
  refreshNavForestListing,
  refreshTrees,
  openTree,
  renderAll,
  showError,
  stopDiagnosticsPolling,
  disconnectEvents,
} = studioFeatures;

const disposeWorkspaceEvents = registerWorkspaceEvents({ $, state, document, window, sessionUI, scrollBehavior, openMaterial, closeMaterialReader, setWorkspaceView, moveSessionRound });

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

/* Esc 语义（W2 逐屏键盘焦点行）：抽屉 → 阅读器 → 支线面板 → 侧栏抽屉
   逐层关闭，每层把焦点还原给触发元素；主线阅读时 Esc 不丢焦点。
   ③ 解释卡按内层优先插入该序列：面板内的卡先于面板关闭（卡在面板内容
   里）；主线卡在面板之后（面板覆盖主线时先收面板）；关闭还原焦点到该
   答案的解释入口（closeTermExplain）。
   D4-2 阅读器在抽屉之后、面板之前（分层关卡按表面层叠顺序：阅读器
   z-index 在支线面板之上——它是当前注意面，先于面板收起）。 */
registerDocumentListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (state.drawerOpen) {
    event.preventDefault();
    closeDrawer();
    return;
  }
  if (sessionUI.mode !== "chat") {
    event.preventDefault();
    setWorkspaceView("chat");
    return;
  }
  if (state.materialReader !== null) {
    event.preventDefault();
    /* D4-3 建枝流程面是阅读器的内层面（材料范围声明/首问在提交前不丢）：
       Esc 先收流程面，再关阅读器（分层关卡同解释卡之于面板）。 */
    if (state.materialBranching !== null &&
        state.materialBranching.selection.materialId === state.materialReader.materialId) {
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

/* Native touch selection may be cleared by Chrome on touchEnd even after the
   reader captured a valid selection during the gesture. Preserve that exact
   captured payload through the release's transient empty selectionchange;
   never synthesize a range, and reset the grace on the next touchstart.
   A later explicit clear/outside gesture still disarms as before. */
let materialTouchStartKey = null;
let materialTouchReleaseGraceUntil = 0;
function materialTouchKey(selection) {
  if (selection === null) return null;
  return selection.kind === "valid"
    ? [selection.materialId, selection.versionId, selection.blockId, selection.start, selection.end].join(":")
    : [selection.materialId, selection.versionId, selection.kind, selection.reason].join(":");
}
registerDocumentListener("touchstart", () => {
  materialTouchStartKey = materialTouchKey(state.materialSelection);
  materialTouchReleaseGraceUntil = 0;
});
registerDocumentListener("touchend", (event) => {
  const target = event.target;
  const inReader = target !== null && typeof target.closest === "function" &&
    target.closest("#mat-blocks") !== null;
  const key = materialTouchKey(state.materialSelection);
  if (inReader && key !== null && key !== materialTouchStartKey) {
    materialTouchReleaseGraceUntil = Date.now() + 350;
  }
  materialTouchStartKey = null;
});
registerDocumentListener("touchcancel", () => {
  materialTouchStartKey = null;
  materialTouchReleaseGraceUntil = 0;
});

/* ③ 触屏选区（selectionchange 武装——与 mouseUp 同一武装守卫）：长按/拖
   动把手产生的选区不必经过 mouseup 也能武装工具条。空选区的解除延迟一
   拍（0ms）判定：正在与工具条交互（焦点在工具条内）时不解除——点击工
   具条按钮时浏览会先清空选区，焦点判定让位于点击。
   D4-2 同族：阅读器正文内的选区同样经 selectionchange 武装（捕获条）；
   解除判定对两个捕获面同时生效（正文工具条/阅读器捕获条都不因点击
   而误解除）。 */
registerDocumentListener("selectionchange", () => {
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
    if (state.materialSelection !== null && Date.now() < materialTouchReleaseGraceUntil) return;
    const activeNow = document.activeElement;
    if (activeNow !== null && isElementNode(activeNow) && withinTerminologySurface(activeNow)) return;
    disarmArmedSelection();
    disarmMaterialSelection();
  }, 0);
});

/* ③ 拖拽窗口收尾（真实浏览器：mouseup 可能落在 turn 元素之外）：冲刷被
   延后的整树重渲（延后一拍，click 先于冲刷——按钮不被换走）。 */
registerDocumentListener("mouseup", () => {
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

    cleanup = () => {
      disposeGenerativeUi();
      disposeApiSettings();
      disposeWorkspaceEvents();
      stopDiagnosticsPolling();
      disconnectEvents();
      for (const [name, listener, options] of docListeners.splice(0)) {
        document.removeEventListener?.(name, listener, options);
      }
    };
  }

  function dispose() {
    if (!started) return;
    cleanup();
    started = false;
  }

  return { start, dispose };
}
