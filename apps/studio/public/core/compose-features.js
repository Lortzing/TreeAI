import { createGenerativeUiController } from "./controllers/generative-ui.js";
import { createSessionWorkspace } from "./views/session-workspace.js";
import { createNavigationFeatures } from "./composition/navigation.js";
import { createMaterialFeatures } from "./composition/materials.js";
/** Composition of instance-owned Studio domain views/controllers; initialization is separated from event wiring and boot. Instance-owned state and dependencies. */
import { createStudioEventsController } from "./controllers/studio-events.js";
import { createStudioFocusController } from "./controllers/focus.js";
import { createTreeChromeView } from "./views/tree-chrome.js";
import { createTurnActionsView } from "./views/turn-actions.js";
import { createConversationView } from "./views/conversation.js";
import { createSourceDrawerView } from "./views/source-drawer.js";
import { createTurnSelectionController } from "./controllers/turn-selection.js";
import { createTerminologyController } from "./controllers/terminology.js";
import { createStudioBasics } from "./controllers/basics.js";
import { createSourceHasher } from "../shared/source/sha256.js";
import { createTurnOverlays } from "./views/turn-overlays.js";
import { createStudioRenderer } from "./controllers/render.js";
import { createReturnController } from "./controllers/return.js";
import { createTreeController } from "./controllers/tree.js";
import { createBranchController } from "./controllers/branch.js";
import { createPromptController } from "./controllers/prompt.js";
import { createSourceDrawerController } from "./controllers/source-drawer.js";
import { createTerminologyView } from "./views/terminology.js";

import { createSearchController } from "./controllers/search.js";
import { createReturnCardRenderer } from "./views/return.js";
import { createDiagnosticsView } from "./views/diagnostics.js";

import { createSearchView } from "./views/search.js";

export function createStudioFeatures(deps) {

const sessionWorkspace = createSessionWorkspace({
  get $() { return $; },
  get trunkBranchId() { return trunkBranchId; },
  get branchView() { return branchView; },
  get closeSidebar() { return closeSidebar; },
  get closeDrawer() { return closeDrawer; },
  get focusComposerWhenSelectable() { return focusComposerWhenSelectable; },
  get renderTopbarPath() { return renderTopbarPath; },
  get renderAll() { return renderAll; },
  get createTree() { return createTree; },
  get guard() { return guard; },
  get openBranchPanel() { return openBranchPanel; },
  get closePanel() { return closePanel; },
  get closeMaterialReader() { return closeMaterialReader; },
  get branchLabel() { return branchLabel; },
  get state() { return deps.state; },
  get document() { return deps.document; },
  prefersReducedMotion: () => deps.window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || false,
  findTurnById(turnId) {
    for (const view of deps.state.treeState?.branches || []) {
      const turn = view.turns.find((item) => item.id === turnId);
      if (turn) return { view, turn };
    }
    return null;
  },
});
const { sessionUI, readingTitles, questionTitle, renderReadingHeading, currentSessionRound, selectRoundForTurn, setWorkspaceView, renderSessionWorkspace, moveSessionRound } = sessionWorkspace;
const findTurnById = (turnId) => {
  for (const view of deps.state.treeState?.branches || []) {
    const turn = view.turns.find((item) => item.id === turnId);
    if (turn) return { view, turn };
  }
  return null;
};


    const studioEventsController = createStudioEventsController({
      get state() { return deps.state; },
      get renderDiagnostics() { return renderDiagnostics; },
      get api() { return api; },
      get window() { return deps.window; },
      get EventSource() { return deps.EventSource; },
      get trunkBranchId() { return trunkBranchId; },
      get renderAll() { return renderAll; },
      get updateStreamingPlaceholder() { return updateStreamingPlaceholder; },
      get refreshTerminology() { return refreshTerminology; },
      get renderDrawer() { return renderDrawer; },
    });


    const studioFocusController = createStudioFocusController({
      get selectRoundForTurn() { return selectRoundForTurn; },
      get renderAll() { return renderAll; },
      get findTurnById() { return findTurnById; },
      get trunkBranchId() { return trunkBranchId; },
      get closeMaterialReader() { return closeMaterialReader; },
      get $() { return $; },
      get window() { return deps.window; },
      get tabButtons() { return tabButtons; },
      get branchHereButtons() { return branchHereButtons; },
      get turnElements() { return turnElements; },
      get materialListButtons() { return materialListButtons; },
      get getSearchHitButton() { return getSearchHitButton; },
      get branchView() { return branchView; },
      get state() { return deps.state; },
      get scrollBehavior() { return scrollBehavior; },
    });

    const treeChromeView = createTreeChromeView({
      get readingTitles() { return readingTitles; },
      get questionTitle() { return questionTitle; },
      get sessionUI() { return sessionUI; },
      get setWorkspaceView() { return setWorkspaceView; },
      get $() { return $; },
      get state() { return deps.state; },
      get document() { return deps.document; },
      get closeSidebar() { return closeSidebar; },
      get guard() { return guard; },
      get openTree() { return openTree; },
      get branchLabel() { return branchLabel; },
      get branchDisplayName() { return branchDisplayName; },
      get returnToTrunk() { return returnToTrunk; },
      get openBranchPanel() { return openBranchPanel; },
      get trunkBranchId() { return trunkBranchId; },
      get branchView() { return branchView; },
      get branchFromLatestAvailableAnswer() { return branchFromLatestAvailableAnswer; },
    });

    const turnActionsView = createTurnActionsView({
      get state() { return deps.state; },
      get document() { return deps.document; },
      get guard() { return guard; },
      get branchFromTurn() { return branchFromTurn; },
      get explainSelection() { return explainSelection; },
      get saveTermAnnotation() { return saveTermAnnotation; },
      get openSavedAnnotationCard() { return openSavedAnnotationCard; },
    });


    const generativeUi = createGenerativeUiController({
      document: deps.document, window: deps.window, fetch: deps.fetch, crypto: deps.crypto, state: deps.state,
      appendDraft: (branchId, text) => returnController.appendReturnDraft(branchId, text),
      locateSource: (branchId, turnId, source) => guard(async () => {
        if (source.kind === "turn" && source.turnId === turnId) studioFocusController.revealAnchorTurn(turnId);
        else if (source.kind === "material") await materialSourceJump(branchId);
        else await revealOrigin(branchId);
      }, "panel"),
    });

    const conversationView = createConversationView({
      comparisonCard: (turn, branchId) => generativeUi.card(turn, branchId),
      get currentSessionRound() { return currentSessionRound; },
      get document() { return deps.document; },
      get assistantTurns() { return assistantTurns; },
      get attachTurnSelectionListeners() { return attachTurnSelectionListeners; },
      get turnOverlaysFor() { return turnOverlaysFor; },
      get applyTurnOverlays() { return applyTurnOverlays; },
      get renderTurnActions() { return renderTurnActions; },
      get state() { return deps.state; },
      get isAtBottom() { return isAtBottom; },
      get branchView() { return branchView; },
      get isMaterialBranchView() { return isMaterialBranchView; },
      get materialReturnCard() { return materialReturnCard; },
      get returnAttemptsFor() { return returnAttemptsFor; },
      get returnCard() { return returnCard; },
      get termSuggestionStrip() { return termSuggestionStrip; },
      get termExplainCard() { return termExplainCard; },
      get termCardFocusTargetId() { return termCardFocusTargetId; },
      get preserveTermCardFocus() { return preserveTermCardFocus; },
      get scrollKey() { return scrollKey; },
      get scrollBehavior() { return scrollBehavior; },
      get $() { return $; },
      get trunkBranchId() { return trunkBranchId; },
      get recallMaterialBranchOrigin() { return recallMaterialBranchOrigin; },
      get branchLabel() { return branchLabel; },
      get branchDisplayName() { return branchDisplayName; },
      get sessionRecoveryControls() { return sessionRecoveryControls; },
      get syncReturnDraftForBranch() { return syncReturnDraftForBranch; },
      get conversationContainerId() { return conversationContainerId; },
      get renderAll() { return renderAll; },
    });


    const sourceDrawerView = createSourceDrawerView({
      get $() { return $; },
      get state() { return deps.state; },
      get document() { return deps.document; },
      get closeDrawer() { return closeDrawer; },
      get mutedLine() { return mutedLine; },
      get branchLabel() { return branchLabel; },
      get returnAttemptsFor() { return returnAttemptsFor; },
      get refreshTerminology() { return refreshTerminology; },
      get renderAll() { return renderAll; },
      get terminologyAnchorStatus() { return terminologyAnchorStatus; },
      get terminologyController() { return terminologyController; },
      get guard() { return guard; },
      get setTerminologyCachePreference() { return setTerminologyCachePreference; },
      get setTerminologyReadingMode() { return setTerminologyReadingMode; },
      get loadJournal() { return loadJournal; },
      get scrollBehavior() { return scrollBehavior; },
    });

    const turnSelectionController = createTurnSelectionController({
      get window() { return deps.window; },
      get state() { return deps.state; },
      get syncTurnActionsArmedState() { return syncTurnActionsArmedState; },
      get renderTurnActions() { return renderTurnActions; },
      get materialReaderView() { return materialReaderView; },
      get materialSelectionController() { return materialSelectionController; },
      get renderAll() { return renderAll; },
      get renderMaterialReader() { return renderMaterialReader; },
      get updateMatSelectionBar() { return updateMatSelectionBar; },
      get document() { return deps.document; },
    });

    const terminologyController = createTerminologyController({
      get state() { return deps.state; },
      get api() { return api; },
      get renderAll() { return renderAll; },
      get disarmArmedSelection() { return disarmArmedSelection; },
      get document() { return deps.document; },
      get showError() { return showError; },
      get $() { return $; },
      get crypto() { return deps.crypto; },
      get openBranchPanel() { return openBranchPanel; },
      get termExplainButtons() { return termExplainButtons; },
      get focusComposerWhenSelectable() { return focusComposerWhenSelectable; },
      get trunkBranchId() { return trunkBranchId; },
      get renderDrawer() { return renderDrawer; },
      get window() { return deps.window; },
    });


    const studioBasics = createStudioBasics({
      get currentSessionRound() { return currentSessionRound; },
      get document() { return deps.document; },
      get window() { return deps.window; },
      get fetch() { return deps.fetch; },
      get state() { return deps.state; },
    });

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


    const returnInsertedAt = new Map();

     /* `${treeId}:${turnId}` → epoch ms */
    const deliveredChangedAt = new Map();

    /* ------------------------------ ③ 正文/操作分层（issue #7 C ③） ------------------------------ */

    /** 元素节点判定（真实 DOM 与脚本桩共用：文本节点无 classList/dataset）。 */
    /** 容器内按 (turnId, text) 找可复用的 turn 元素（正文层跨重渲稳定）。 */
    /* -------- 批注锚定联合校验（issue #7 增量验收 2026-09-30 P0） -------- */

    const sha256Hex = createSourceHasher();


    const turnOverlays = createTurnOverlays({
      get sha256Hex() { return sha256Hex; },
      get state() { return deps.state; },
      get document() { return deps.document; },
      get openSavedAnnotationCard() { return openSavedAnnotationCard; },
      get branchIdOfTurn() { return branchIdOfTurn; },
    });


    const studioRenderer = createStudioRenderer({
      get renderReadingHeading() { return renderReadingHeading; },
      get renderSessionWorkspace() { return renderSessionWorkspace; },
      get state() { return deps.state; },
      get tabButtons() { return tabButtons; },
      get branchHereButtons() { return branchHereButtons; },
      get turnElements() { return turnElements; },
      get assistantTurns() { return assistantTurns; },
      get termExplainButtons() { return termExplainButtons; },
      get $() { return $; },
      get renderTopbarPath() { return renderTopbarPath; },
      get renderBranchTabs() { return renderBranchTabs; },
      get renderSessionBanner() { return renderSessionBanner; },
      get renderMainConversation() { return renderMainConversation; },
      get trunkBranchId() { return trunkBranchId; },
      get renderPanel() { return renderPanel; },
      get updateComposerLocks() { return updateComposerLocks; },
      get renderTrees() { return renderTrees; },
      get renderMaterialsSection() { return renderMaterialsSection; },
      get renderSearchSection() { return renderSearchSection; },
      get renderNavSection() { return renderNavSection; },
    });

    const returnController = createReturnController({
      get selectRoundForTurn() { return selectRoundForTurn; },
      get window() { return deps.window; },
      get state() { return deps.state; },
      get branchView() { return branchView; },
      get $() { return $; },
      get crypto() { return deps.crypto; },
      get isMaterialBranchView() { return isMaterialBranchView; },
      get api() { return api; },
      get rememberMaterialReturnCard() { return rememberMaterialReturnCard; },
      get renderAll() { return renderAll; },
      get closePanel() { return closePanel; },
      get showError() { return showError; },
      get turnElements() { return turnElements; },
      get scrollBehavior() { return scrollBehavior; },
    });


    const treeController = createTreeController({
      get $() { return $; },
      get state() { return deps.state; },
      get showError() { return showError; },
      get renderAll() { return renderAll; },
      get api() { return api; },
      get renderTrees() { return renderTrees; },
      get resetMaterialImport() { return resetMaterialImport; },
      get materialReaderController() { return materialReaderController; },
      get materialReaderView() { return materialReaderView; },
      get materialSelectionController() { return materialSelectionController; },
      get window() { return deps.window; },
      get hideMaterialReader() { return hideMaterialReader; },
      get document() { return deps.document; },
      get searchEpoch() { return searchController.searchEpoch; },
      set searchEpoch(value) { searchController.searchEpoch = value; },
      get saveMaterialReadingPositionNow() { return saveMaterialReadingPositionNow; },
      get hidePanel() { return hidePanel; },
      get hideDrawer() { return hideDrawer; },
      get refreshDiagnostics() { return refreshDiagnostics; },
      get connectEvents() { return connectEvents; },
      get refreshTerminologyForTree() { return refreshTerminologyForTree; },
      get refreshMaterials() { return refreshMaterials; },
    });

    const branchController = createBranchController({
      get selectRoundForTurn() { return selectRoundForTurn; },
      get closeMaterialReader() { return closeMaterialReader; },
      get state() { return deps.state; },
      get api() { return api; },
      get renderAll() { return renderAll; },
      get showPanel() { return showPanel; },
      get focusIntoPanel() { return focusIntoPanel; },
      get hidePanel() { return hidePanel; },
      get trunkBranchId() { return trunkBranchId; },
      get focusComposerWhenSelectable() { return focusComposerWhenSelectable; },
      get $() { return $; },
      get restoreFocusRef() { return restoreFocusRef; },
      get showError() { return showError; },
      get revealAnchorTurn() { return revealAnchorTurn; },
      get assistantTurns() { return assistantTurns; },
      get selectionOffsetsWithin() { return selectionOffsetsWithin; },
      get findSessionRecoveryAnchor() { return findSessionRecoveryAnchor; },
    });


    const promptController = createPromptController({
      get sessionUI() { return sessionUI; },
      get state() { return deps.state; },
      get trunkBranchId() { return trunkBranchId; },
      get $() { return $; },
      get studioEventsController() { return studioEventsController; },
      get startDiagnosticsPolling() { return startDiagnosticsPolling; },
      get api() { return api; },
      get refreshTerminology() { return refreshTerminology; },
      get stopDiagnosticsPolling() { return stopDiagnosticsPolling; },
      get renderAll() { return renderAll; },
      get refreshDiagnostics() { return refreshDiagnostics; },
      get focusComposerWhenSelectable() { return focusComposerWhenSelectable; },
      get showError() { return showError; },
      get window() { return deps.window; },
      get isMaterialBranchView() { return isMaterialBranchView; },
      get branchView() { return branchView; },
    });


    const sourceDrawerController = createSourceDrawerController({
      get state() { return deps.state; },
      get $() { return $; },
      get renderDrawer() { return renderDrawer; },
      get showDrawer() { return showDrawer; },
      get refreshTerminology() { return refreshTerminology; },
      get api() { return api; },
      get hideDrawer() { return hideDrawer; },
      get restoreFocusRef() { return restoreFocusRef; },
    });


    const terminologyView = createTerminologyView({
      get state() { return deps.state; },
      get document() { return deps.document; },
      get mutedLine() { return mutedLine; },
      get renderAll() { return renderAll; },
      get guard() { return guard; },
      get explainSelection() { return explainSelection; },
      get trunkBranchId() { return trunkBranchId; },
      get disarmTermSuggestion() { return disarmTermSuggestion; },
      get retryTermSuggestions() { return retryTermSuggestions; },
      get closeTermExplain() { return closeTermExplain; },
      get terminologyController() { return terminologyController; },
      get terminologyAnchorStatus() { return terminologyAnchorStatus; },
      get saveTermAnnotation() { return saveTermAnnotation; },
      get promoteTermAnnotation() { return promoteTermAnnotation; },
      get branchLabel() { return branchLabel; },
      get openBranchPanel() { return openBranchPanel; },
    });
const materialsFeatures = createMaterialFeatures({
      get sessionUI() { return sessionUI; },
      get setWorkspaceView() { return setWorkspaceView; },
  get environment() { return deps; },
  get $() { return $; },
  get api() { return api; },
  get showError() { return showError; },
  get restoreFocusRef() { return restoreFocusRef; },
  get mutedListItem() { return mutedListItem; },
  get closeSidebar() { return closeSidebar; },
  get formatProductTime() { return formatProductTime; },
  get mutedLine() { return mutedLine; },
  get flushPendingRerender() { return flushPendingRerender; },
  get disarmArmedSelection() { return disarmArmedSelection; },
  get guard() { return guard; },
  get branchView() { return branchView; },
  get openBranchPanel() { return openBranchPanel; },
  get turnElements() { return turnElements; },
  get returnInsertedAt() { return returnInsertedAt; },
  get MOTION_EPOCH_MS() { return MOTION_EPOCH_MS; },
  get branchLabel() { return branchLabel; },
  get openDrawer() { return openDrawer; },
});
const {
  materialListButtons,
  isMaterialBranchView,
  materialReturnCard,
  recallMaterialBranchOrigin,
  materialReaderView,
  materialSelectionController,
  renderMaterialReader,
  updateMatSelectionBar,
  renderMaterialsSection,
  rememberMaterialReturnCard,
  resetMaterialImport,
  materialReaderController,
  hideMaterialReader,
  saveMaterialReadingPositionNow,
  refreshMaterials,
  openMaterial,
  registerMaterialImportUi,
  materialSourceJump,
  closeMaterialBranchFlow,
  closeMaterialReader,
  findLiveMaterialSelection,
  armMaterialSelection,
  disarmMaterialSelection,
} = materialsFeatures;

    const searchController = createSearchController({
      get state() { return deps.state; },
      get $() { return $; },
      get renderSearchSection() { return renderSearchSection; },
      get api() { return api; },
      get searchHitKey() { return searchHitKey; },
      get openTree() { return openTree; },
      get openMaterial() { return openMaterial; },
      get refreshTerminology() { return refreshTerminology; },
      get openDrawer() { return openDrawer; },
      get trunkBranchId() { return trunkBranchId; },
      get openBranchPanel() { return openBranchPanel; },
      get revealAnchorTurn() { return revealAnchorTurn; },
      get openSavedAnnotationCard() { return openSavedAnnotationCard; },
    });
const navigationFeatures = createNavigationFeatures({
      get readingTitles() { return readingTitles; },
      get renderTrees() { return renderTrees; },
  get environment() { return deps; },
  get $() { return $; },
  get api() { return api; },
  get mutedListItem() { return mutedListItem; },
  get openTree() { return openTree; },
  get revealOrigin() { return revealOrigin; },
  get openMaterial() { return openMaterial; },
  get formatProductTime() { return formatProductTime; },
  get closeSidebar() { return closeSidebar; },
});
const {
  renderNavSection,
  runNavTreeFind,
  runNavNodeSearch,
  renderNavTree,
  navTreeKeydown,
  navLocateCurrent,
  navJumpToSource,
  closeNavTree,
  refreshNavForestListing,
} = navigationFeatures;

  const { refreshDiagnostics, connectEvents, startDiagnosticsPolling, stopDiagnosticsPolling, disconnectEvents } = studioEventsController;

  const {
    focusComposerWhenSelectable,
    hidePanel,
    hideDrawer,
    showPanel,
    focusIntoPanel,
    restoreFocusRef,
    revealAnchorTurn,
    showDrawer,
  } = studioFocusController;

  const {
    sessionRecoveryControls,
    tabButtons,
    renderTopbarPath,
    renderBranchTabs,
    renderSessionBanner,
    renderTrees,
    findSessionRecoveryAnchor,
  } = treeChromeView;

  const { termExplainButtons, branchIdOfTurn, syncTurnActionsArmedState, renderTurnActions, branchHereButtons } = turnActionsView;

  const { turnElements, renderMainConversation, renderPanel, updateStreamingPlaceholder } = conversationView;

  const { renderDrawer } = sourceDrawerView;

  const {
    disarmArmedSelection,
    assistantTurns,
    attachTurnSelectionListeners,
    termCardFocusTargetId,
    preserveTermCardFocus,
    selectionOffsetsWithin,
    flushPendingRerender,
    withinTerminologySurface,
    findLiveSelectionTurn,
    armTurnSelection,
  } = turnSelectionController;

  const {
    openSavedAnnotationCard,
    explainSelection,
    saveTermAnnotation,
    refreshTerminology,
    refreshTerminologyForTree,
    setTerminologyCachePreference,
    setTerminologyReadingMode,
    disarmTermSuggestion,
    retryTermSuggestions,
    closeTermExplain,
    promoteTermAnnotation,
  } = terminologyController;

  const {
    api,
    trunkBranchId,
    $,
    branchView,
    scrollBehavior,
    closeSidebar,
    guard,
    branchLabel,
    branchDisplayName,
    isAtBottom,
    returnAttemptsFor,
    scrollKey,
    conversationContainerId,
    mutedLine,
    showError,
    formatProductTime,
    updateComposerLocks,
    mutedListItem,
  } = studioBasics;


  const {
    returnCard,
  } = createReturnCardRenderer({
    document: deps.document,
    getCurrentTreeId: () => deps.state.currentTreeId,
    getTreeState: () => deps.state.treeState,
    knownReturnIds: deps.state.knownReturnIds,
    seenDeliveredRunIds: deps.state.seenDeliveredRunIds,
    turnElements,
    returnInsertedAt,
    deliveredChangedAt,
    motionEpochMs: MOTION_EPOCH_MS,
    branchLabel: (...args) => branchLabel(...args),
    formatProductTime: (...args) => formatProductTime(...args),
    openDrawer: (...args) => openDrawer(...args),
  });

  const { turnOverlaysFor, applyTurnOverlays, terminologyAnchorStatus } = turnOverlays;

  const { renderAll } = studioRenderer;

  const { syncReturnDraftForBranch, persistReturnDraft, submitReturn } = returnController;


  /* ------------------------------ 诊断面 ------------------------------ */

  const {
    renderDiagnostics,
  } = createDiagnosticsView({
    document: deps.document,
    getElement: (...args) => $(...args),
    getState: () => deps.state,
    branchLabel: (...args) => branchLabel(...args),
  });

  const { openTree, createTree, retryTreesLoad, refreshTrees } = treeController;

  const { branchFromTurn, openBranchPanel, returnToTrunk, branchFromLatestAvailableAnswer, closePanel, revealOrigin } = branchController;

  const { sendPrompt, startNewExploration, abortActiveRun } = promptController;

  const { closeDrawer, loadJournal, openDrawer, toggleDrawer } = sourceDrawerController;

  const { termSuggestionStrip, termExplainCard } = terminologyView;

  const { jumpToSearchHit, locateAnnotationHit, locateTurnHit, runSearch } = searchController;

  const {
    renderSearchSection,
    searchHitKey,
    getSearchHitButton,
  } = createSearchView({
    document: deps.document,
    getElement: (...args) => $(...args),
    getState: () => deps.state,
    mutedListItem: (...args) => mutedListItem(...args),
    formatProductTime: (...args) => formatProductTime(...args),
    closeSidebar: (...args) => closeSidebar(...args),
    guard: (...args) => guard(...args),
    jumpToSearchHit: (...args) => jumpToSearchHit(...args),
    locateAnnotationHit: (...args) => locateAnnotationHit(...args),
    locateTurnHit: (...args) => locateTurnHit(...args),
    branchView: (...args) => branchView(...args),
    trunkBranchId: (...args) => trunkBranchId(...args),
    openBranchPanel: (...args) => openBranchPanel(...args),
  });

  return {
    disposeGenerativeUi: () => generativeUi.dispose(),
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
  };
}
