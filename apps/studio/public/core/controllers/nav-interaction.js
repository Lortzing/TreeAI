import { NAV_ROW_HEIGHT_PX } from "../views/nav-tree.js";

/** Navigation selection, scrolling and keyboard interaction over the current virtual tree. */
export function createNavInteractionController(deps) {
  const { getState, getElement: $, api, navVisibleRows, navRowElements, navLoadChildrenPage, scheduleNavPersist, renderNavTree, renderNavPath, renderNavTreeActions } = deps;
  const state = getState();

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

  return { navToggleExpansion, selectNavNode, navTreeKeydown };
}
