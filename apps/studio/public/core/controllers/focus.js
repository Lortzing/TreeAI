/** Panel/drawer motion timers, stable focus references and exact source/turn reveal focus. Instance-owned state and dependencies. */

export function createStudioFocusController(deps) {

  /** 面板 / 抽屉进出场动画的收尾 timer（M1/M2：退出播完后才真正 hidden）。 */
  let panelAnimTimer = null;

  let drawerAnimTimer = null;

  const PANEL_ENTER_MS = 240;
   /* CSS 180ms + 收尾余量 */
  const PANEL_EXIT_MS = 170;


  /* ------------------------------ 面板 / 抽屉进出场（M1/M2） ------------------------------ */

  /**
   * M1/M2：面板进入（侧滑 + 淡入 150–200ms ease-out）与对称退出。退出播完
   * 才置 hidden；reduced-motion 下 CSS 全局降级为即时（无位移）。转场期间
   * 主线为覆盖层下的原布局——阅读位置不动。
   */
  function showPanel() {
    const panel = deps.$("branch-panel");
    if (panelAnimTimer !== null) {
      deps.window.clearTimeout(panelAnimTimer);
      panelAnimTimer = null;
    }
    panel.classList.remove("exit");
    if (panel.hidden) {
      panel.hidden = false;
      void panel.offsetHeight; /* reflow：确保 enter 动画从初始态播放 */
      panel.classList.add("enter");
      panelAnimTimer = deps.window.setTimeout(() => {
        panel.classList.remove("enter");
        panelAnimTimer = null;
      }, PANEL_ENTER_MS);
    }
  }


  function hidePanel(opts = {}) {
    const panel = deps.$("branch-panel");
    if (panelAnimTimer !== null) {
      deps.window.clearTimeout(panelAnimTimer);
      panelAnimTimer = null;
    }
    panel.classList.remove("enter");
    if (opts.instant || panel.hidden) {
      panel.hidden = true;
      panel.classList.remove("exit");
      return;
    }
    panel.classList.add("exit");
    panelAnimTimer = deps.window.setTimeout(() => {
      panel.hidden = true;
      panel.classList.remove("exit");
      panelAnimTimer = null;
    }, PANEL_EXIT_MS);
  }


  function showDrawer() {
    const drawer = deps.$("source-drawer");
    if (drawerAnimTimer !== null) {
      deps.window.clearTimeout(drawerAnimTimer);
      drawerAnimTimer = null;
    }
    drawer.classList.remove("exit");
    if (drawer.hidden) {
      drawer.hidden = false;
      void drawer.offsetHeight;
      drawer.classList.add("enter");
      drawerAnimTimer = deps.window.setTimeout(() => {
        drawer.classList.remove("enter");
        drawerAnimTimer = null;
      }, PANEL_ENTER_MS);
    }
  }


  function hideDrawer(opts = {}) {
    const drawer = deps.$("source-drawer");
    if (drawerAnimTimer !== null) {
      deps.window.clearTimeout(drawerAnimTimer);
      drawerAnimTimer = null;
    }
    drawer.classList.remove("enter");
    if (opts.instant || drawer.hidden) {
      drawer.hidden = true;
      drawer.classList.remove("exit");
      return;
    }
    drawer.classList.add("exit");
    drawerAnimTimer = deps.window.setTimeout(() => {
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
    if (ref.kind === "main-input") return deps.$("prompt-input");
    if (ref.kind === "tab") return deps.tabButtons.get(ref.branchId) ?? null;
    if (ref.kind === "branch-button") return deps.branchHereButtons.get(ref.turnId) ?? null;
    if (ref.kind === "return-card") return deps.turnElements.get(ref.turnId) ?? null;
    if (ref.kind === "material-button") return deps.materialListButtons.get(ref.materialId) ?? null;
    if (ref.kind === "search-hit") return deps.getSearchHitButton(ref.hitKey);
    return null;
  }


  /** 面板打开 → 焦点移入面板：常规 = 支线输入框（面板主操作面）；
      session 不可用降级 = 恢复按钮为首个焦点（W2 §2.8 键盘焦点行；按钮
      禁用——无可用候选——时退回降级提示本身）。
      busy 的瞬态禁用期间（动作未收尾）延迟到解锁后再移入。 */
  function focusIntoPanel() {
    const view = deps.branchView(deps.state.panelBranchId);
    if (view !== null && (view.sessionAvailability === "unavailable" || deps.state.forcePanelSessionNote)) {
      const recovery = deps.$("panel-session-note").querySelector("button");
      if (recovery !== null && !recovery.disabled) recovery.focus();
      else deps.$("panel-session-note").focus();
      return;
    }
    const input = deps.$("panel-prompt-input");
    if (!input.disabled) {
      input.focus();
      return;
    }
    if (deps.state.busy) {
      deps.window.setTimeout(() => {
        if (deps.state.panelBranchId === null) return;
        const current = deps.$("panel-prompt-input");
        if (!current.disabled) current.focus();
        else deps.$("panel-close").focus();
      }, 0);
      return;
    }
    deps.$("panel-close").focus(); /* 持久禁用（session 不可用）时的兜底 */
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
    deps.window.setTimeout(() => {
      if (el.disabled !== true) el.focus();
    }, 0);
  }


  /** 揭示到位：滚动到锚点 turn 并把焦点移过去（W2 §2.6）。 */
  function revealAnchorTurn(turnId) {
    if (deps.selectRoundForTurn(turnId)) deps.renderAll();
    if (deps.state.materialReader !== null && deps.findTurnById(turnId)?.view.branch.id === deps.trunkBranchId()) deps.closeMaterialReader();
    const el = deps.turnElements.get(turnId);
    if (el === undefined) return;
    if (typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "center", behavior: deps.scrollBehavior() });
    }
    el.focus();
  }

  function restoreFocusRef(ref) {
    const target = resolveFocusRef(ref);
    // A return target may now live in secondary tools. Reveal its disclosure chain
    // before focusing, otherwise the browser silently drops focus on the hidden button.
    for (let parent = target?.parentElement; parent; parent = parent.parentElement) {
      if (parent === deps.$("materials-section") && !parent.open) {
        deps.$("reading-materials").focus();
        return;
      }
      if (parent.tagName === "DETAILS") parent.open = true;
    }
    (target ?? deps.$("prompt-input")).focus();
  }

  return {
    focusComposerWhenSelectable,
    hidePanel,
    hideDrawer,
    showPanel,
    focusIntoPanel,
    restoreFocusRef,
    revealAnchorTurn,
    showDrawer,
  };
}
