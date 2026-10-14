/** Finder requests own their epoch; a newer listing/search supersedes every older page. */
export function createNavFinderController({ getState, getQuery, api, renderNavFinder }) {
  const NAV_TREES_PAGE_LIMIT = 20;
  const NAV_SEARCH_LIMIT = 20;
  let navFinderEpoch = 0;

  /** 森林列表首页（启动/空查询刷新/失败重试共用；三态 + 世代守卫）。 */
  async function refreshNavForestListing() {
    const finder = getState().nav.finder;
    const epoch = ++navFinderEpoch;
    finder.phase = "loading";
    finder.mode = "listing";
    finder.error = null;
    finder.moreError = null;
    finder.moreLoading = false;
    renderNavFinder();
    try {
      const payload = await api(`/api/nav/trees?limit=${String(NAV_TREES_PAGE_LIMIT)}`);
      if (epoch !== navFinderEpoch) return; /* 迟到丢弃 */
      finder.phase = "loaded";
      finder.listing = { trees: payload.trees, nextCursor: payload.nextCursor, totalTrees: payload.totalTrees };
    } catch (err) {
      if (epoch !== navFinderEpoch) return;
      finder.phase = "failed";
      finder.error = String(err && err.message ? err.message : err);
    }
    renderNavFinder();
  }

  /** 森林列表续页（More；在途禁用，失败注记可重试——不折叠已有页）。 */
  async function loadNavForestMore() {
    const finder = getState().nav.finder;
    if (finder.mode !== "listing" || finder.phase !== "loaded") return;
    if (finder.listing.nextCursor === null || finder.moreLoading) return;
    finder.moreLoading = true;
    finder.moreError = null;
    renderNavFinder();
    const epoch = navFinderEpoch;
    try {
      const payload = await api(
        `/api/nav/trees?limit=${String(NAV_TREES_PAGE_LIMIT)}&cursor=${encodeURIComponent(finder.listing.nextCursor)}`,
      );
      if (epoch !== navFinderEpoch) return;
      finder.listing = {
        trees: [...finder.listing.trees, ...payload.trees],
        nextCursor: payload.nextCursor,
        totalTrees: payload.totalTrees,
      };
    } catch (err) {
      if (epoch !== navFinderEpoch) return;
      finder.moreError = String(err && err.message ? err.message : err);
    }
    finder.moreLoading = false;
    renderNavFinder();
  }

  /** 树搜索续页（More，同森林列表纪律）。 */
  async function loadNavTreeSearchMore() {
    const finder = getState().nav.finder;
    if (finder.mode !== "search" || finder.phase !== "loaded") return;
    if (finder.hitCursor === null || finder.moreLoading) return;
    finder.moreLoading = true;
    finder.moreError = null;
    renderNavFinder();
    const epoch = navFinderEpoch;
    try {
      const payload = await api(
        `/api/nav/search/trees?text=${encodeURIComponent(finder.query)}&mode=substring&limit=${String(NAV_SEARCH_LIMIT)}` +
          `&cursor=${encodeURIComponent(finder.hitCursor)}`,
      );
      if (epoch !== navFinderEpoch) return;
      finder.hits = [...finder.hits, ...payload.hits];
      finder.hitCursor = payload.nextCursor;
    } catch (err) {
      if (epoch !== navFinderEpoch) return;
      finder.moreError = String(err && err.message ? err.message : err);
    }
    finder.moreLoading = false;
    renderNavFinder();
  }

  /** 树查找执行：空输入 = 刷新森林列表（服务端如实拒绝空文本搜索，客户端
      不发空查询）；有输入 = 标题/标识 substring 搜索。 */
  async function runNavTreeFind() {
    const text = getQuery().trim();
    if (text === "") {
      await refreshNavForestListing();
      return;
    }
    const finder = getState().nav.finder;
    const epoch = ++navFinderEpoch;
    finder.phase = "loading";
    finder.mode = "search";
    finder.error = null;
    finder.moreError = null;
    finder.query = text;
    finder.hits = [];
    finder.hitCursor = null;
    renderNavFinder();
    try {
      const payload = await api(
        `/api/nav/search/trees?text=${encodeURIComponent(text)}&mode=substring&limit=${String(NAV_SEARCH_LIMIT)}`,
      );
      if (epoch !== navFinderEpoch) return; /* 迟到丢弃 */
      finder.phase = "loaded";
      finder.hits = payload.hits;
      finder.hitCursor = payload.nextCursor;
    } catch (err) {
      if (epoch !== navFinderEpoch) return;
      finder.phase = "failed";
      finder.error = String(err && err.message ? err.message : err);
    }
    renderNavFinder();
  }

  return { refreshNavForestListing, loadNavForestMore, loadNavTreeSearchMore, runNavTreeFind };
}
