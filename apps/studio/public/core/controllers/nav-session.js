/** Instance-owned navigation sessions and child paging; stale responses never update the active tree. */
export function createNavSessionController(deps) {
  const {
    getState,
    getElement: $,
    api,
    renderNavSurfaceChrome,
    renderNavTree,
    renderNavPath,
    renderNavNodeResults,
    renderNavFinder,
    selectNavNode,
    navRevealBranch,
  } = deps;
  const state = getState();

  const NAV_CHILDREN_PAGE_LIMIT = 50;

  /** 子节点分页条目（惰性建——首次加载才出现）。 */
  function navChildEntry(session, parentId) {
    let entry = session.childPages.get(parentId);
    if (entry === undefined) {
      entry = { ids: [], nextCursor: null, totalChildren: 0, state: "idle", error: null, inFlight: null };
      session.childPages.set(parentId, entry);
    }
    return entry;
  }

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

  return { openNavTree, closeNavTree, navLoadChildrenPage, navChildEntry };
}
