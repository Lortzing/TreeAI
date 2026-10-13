/** Navigation nav-node-search; preserves the existing D4 endpoint and display contracts. */
export function createNavNodeSearchController(deps) {
  const { getElement: $, getState, api, renderNavNodeResults } = deps;
  const state = getState();

  const NAV_SEARCH_LIMIT = 20;

  /** 分支搜索（当前导航树范围；命中携带完整路径——同名节点的身份载荷）。 */
  async function runNavNodeSearch() {
    const session = state.nav.session;
    if (session === null) return;
    const text = $("nav-node-search").value.trim();
    if (text === "") {
      session.search = { phase: "idle", error: null, query: null, hits: [], nextCursor: null };
      renderNavNodeResults();
      return;
    }
    session.search.phase = "loading";
    session.search.error = null;
    session.search.query = text;
    renderNavNodeResults();
    try {
      const payload = await api(
        `/api/nav/search/branches?text=${encodeURIComponent(text)}&mode=substring` +
          `&treeId=${encodeURIComponent(session.treeId)}&limit=${String(NAV_SEARCH_LIMIT)}`,
      );
      if (state.nav.session !== session) return; /* 迟到丢弃 */
      session.search.phase = "loaded";
      session.search.hits = payload.hits;
      session.search.nextCursor = payload.nextCursor;
    } catch (err) {
      if (state.nav.session !== session) return;
      session.search.phase = "failed";
      session.search.error = String(err && err.message ? err.message : err);
    }
    renderNavNodeResults();
  }

  /** 分支搜索续页。 */
  async function loadNavNodeSearchMore() {
    const session = state.nav.session;
    if (session === null || session.search.phase !== "loaded" || session.search.nextCursor === null) return;
    const epochSession = session;
    try {
      const payload = await api(
        `/api/nav/search/branches?text=${encodeURIComponent(session.search.query)}&mode=substring` +
          `&treeId=${encodeURIComponent(session.treeId)}&limit=${String(NAV_SEARCH_LIMIT)}` +
          `&cursor=${encodeURIComponent(session.search.nextCursor)}`,
      );
      if (state.nav.session !== epochSession) return;
      session.search.hits = [...session.search.hits, ...payload.hits];
      session.search.nextCursor = payload.nextCursor;
    } catch (err) {
      if (state.nav.session !== epochSession) return;
      session.search.error = String(err && err.message ? err.message : err);
    }
    renderNavNodeResults();
  }

  return { runNavNodeSearch, loadNavNodeSearchMore };
}
