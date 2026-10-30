/** Tree read/create/open epochs, honest list failures and coordinated transient-state reset. Instance-owned state and dependencies. */

export function createTreeController(deps) {


  /* ------------------------------ 树列表加载失败重试（W2 §2.1） ------------------------------ */

  /** 列表加载失败态：侧栏常驻重试面（错误事实 + 可用重试）——与 8 秒自动
      隐藏横幅不同，失败不消失，重试入口一直可用（“错误条 + 重试，不空白”）。 */
  function showListLoadError(message) {
    deps.$("list-load-message").textContent = `Failed to load the tree list — ${message}`;
    const retryButton = deps.$("list-retry");
    retryButton.disabled = false;
    retryButton.textContent = "Retry";
    deps.$("list-load-error").hidden = false;
  }


  /** 重试在途态：按钮禁用 + 明示“重试中”（诚实待态；禁用兼作防重入）。 */
  function showListLoadPending() {
    deps.$("list-load-message").textContent = "Retrying the tree list…";
    const retryButton = deps.$("list-retry");
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
    const retryButton = deps.$("list-retry");
    if (retryButton.disabled) return; /* 在途防重入 */
    showListLoadPending();
    try {
      await refreshTrees();
    } catch {
      return; /* 列表仍失败：重试面已呈失败态（常驻） */
    }
    if (deps.state.currentTreeId === null) {
      if (deps.state.trees.length > 0) {
        try {
          await openTree(deps.state.trees[0].id);
        } catch (err) {
          deps.showError(String(err && err.message ? err.message : err));
        }
      } else {
        deps.renderAll();
      }
    }
  }


  async function refreshTrees() {
    let payload;
    try {
      payload = await deps.api("/api/trees");
    } catch (err) {
      /* 列表加载失败：侧栏常驻重试面落位；错误照常上抛（调用方呈现路径
         不变——guard / 启动横幅）。 */
      showListLoadError(String(err && err.message ? err.message : err));
      throw err;
    }
    deps.state.trees = payload.trees;
    deps.$("list-load-error").hidden = true;
    deps.renderTrees();
  }


  /* ------------------------------ 动作 ------------------------------ */

  function resetTransientView() {
    deps.state.sourceHighlight = null;
    deps.state.activeRunInfo = null;
    deps.state.streaming = null;
    deps.state.forceSessionBanner = false;
    deps.state.forcePanelSessionNote = false;
    deps.state.termExplain = null;
    deps.state.termSuggest = null;
    deps.state.terminology = null;
    deps.state.armedSelection = null;
    deps.state.selectionDragActive = false;
    deps.state.pendingRerender = false;
    /* D4-2：材料面随树切换复位（阅读位置已由调用方在切树前落库）。退出中
       的块容器一并清空——绝不给下一次打开留下上一棵树的块元素。导入状态
       （含在途解析轮询）一并复位——导入事实属于发起它的树。 */
    deps.state.materials = null;
    deps.state.materialSelection = null;
    deps.resetMaterialImport();
    /* D4-3：建枝流程随树切换复位（挂起的 intentKey 仍在 localStorage——重进
       同一选区时按同键幂等续走，服务端对账兜底）。 */
    deps.state.materialBranching = null;
    if (deps.state.materialReader !== null) {
      deps.state.materialReader = null;
      deps.materialReaderController.materialReaderEpoch += 1;
      deps.materialReaderView.materialPendingUpdate = false;
      deps.materialSelectionController.materialBarPendingUpdate = false;
      if (deps.materialReaderController.materialPositionTimer !== null) {
        deps.window.clearTimeout(deps.materialReaderController.materialPositionTimer);
        deps.materialReaderController.materialPositionTimer = null;
      }
      deps.hideMaterialReader({ instant: true });
      const blocksEl = deps.document.getElementById("mat-blocks");
      if (blocksEl !== null) blocksEl.replaceChildren();
    }
    deps.materialReaderController.materialReaderFocusReturn = null;
    /* D4-4：「当前树」范围搜索的旧结果不再描述当前工作台（树已切换）——
       诚实清空并作废在途的旧树搜索响应（P1 同族迟到丢弃）；全部树范围的
       结果是库级事实，保持有效。筛选选择（scope/kinds）与输入框不重置
       （用户的显式选择，跨树保持）。 */
    if (deps.state.search.resultScope === "tree") {
      deps.searchEpoch += 1;
      deps.state.search.phase = "idle";
      deps.state.search.error = null;
      deps.state.search.hits = [];
      deps.state.search.note = null;
      deps.state.search.resultQuery = null;
      deps.state.search.resultScope = null;
      deps.state.search.resultTreeId = null;
    }
  }


  /** 开树世代号（P1 同族，issue #7 增量验收）：启动恢复 / 列表重试的
      openTree 不经 busy 锁——与用户点击的开树并发时，迟到的旧树 state 绝不
      覆盖更新的树切换（末次开树/建树胜出）。 */
  let treeOpenEpoch = 0;


  async function openTree(treeId) {
    /* D4-2：切树前先把当前阅读位置落库（树×材料行；PUT 面向旧树 id 发出，
       迟到响应不影响新树状态——api 调用即发起，不等待）。 */
    if (deps.state.materialReader !== null) deps.saveMaterialReadingPositionNow();
    const epoch = ++treeOpenEpoch;
    const treeState = await deps.api(`/api/trees/${encodeURIComponent(treeId)}/state`);
    if (epoch !== treeOpenEpoch) return; /* 已被更新的开树/建树取代：迟到丢弃 */
    deps.state.currentTreeId = treeId;
    try { deps.window.localStorage?.setItem("treeai:last-tree", treeId); } catch { /* Optional browser cursor. */ }
    deps.state.treeState = treeState;
    /* 树切换：面板/抽屉收起、草稿回到会话外（持久草稿仍在 localStorage，
       面板重开时恢复）。阅读位置按 tree:branch 记忆，切回可恢复。 */
    deps.state.panelBranchId = null;
    deps.state.returnDraft = null;
    resetTransientView();
    deps.hidePanel({ instant: true });
    if (deps.state.drawerOpen) {
      deps.state.drawerOpen = false;
      deps.state.drawerFocusRunId = null;
      deps.state.drawerFocusReturn = null;
      deps.hideDrawer({ instant: true });
    }
    await refreshTrees();
    await deps.refreshDiagnostics();
    deps.connectEvents(treeId);
    deps.renderAll();
    /* ③ 批注区间覆盖的数据面：开树即拉术语读模型（失败如实 {ok:false}——
       无批注覆盖，绝不伪造）。 */
    deps.refreshTerminologyForTree(treeId);
    /* D4-2：开树即拉材料列表（三态；失败态侧栏常驻重试）。 */
    void deps.refreshMaterials();
  }


  async function createTree() {
    /* D4-2：同 openTree——切换前落库当前阅读位置。 */
    if (deps.state.materialReader !== null) deps.saveMaterialReadingPositionNow();
    treeOpenEpoch += 1; /* 建树即新的当前树：作废在途的旧 openTree（P1 同族） */
    const payload = await deps.api("/api/trees", "POST", {});
    deps.state.currentTreeId = payload.tree.id;
    try { deps.window.localStorage?.setItem("treeai:last-tree", payload.tree.id); } catch { /* Optional browser cursor. */ }
    deps.state.treeState = payload.state;
    deps.state.panelBranchId = null;
    deps.state.returnDraft = null;
    resetTransientView();
    deps.hidePanel({ instant: true });
    if (deps.state.drawerOpen) {
      deps.state.drawerOpen = false;
      deps.state.drawerFocusRunId = null;
      deps.state.drawerFocusReturn = null;
      deps.hideDrawer({ instant: true });
    }
    await refreshTrees();
    await deps.refreshDiagnostics();
    deps.connectEvents(payload.tree.id);
    deps.renderAll();
    deps.refreshTerminologyForTree(payload.tree.id);
    /* D4-2：新树即拉材料列表（空树如实空态）。 */
    void deps.refreshMaterials();
  }

  return {
    openTree,
    createTree,
    retryTreesLoad,
    refreshTrees,
  };
}
