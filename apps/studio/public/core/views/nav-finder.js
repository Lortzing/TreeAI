export function createNavFinderView({
  rememberTreeTitles = () => {},
  document,
  getElement,
  getState,
  mutedListItem,
  formatProductTime,
  closeSidebar,
  openNavTree,
  runNavTreeFind,
  refreshNavForestListing,
  loadNavForestMore,
  loadNavTreeSearchMore,
  navFinderButtons,
  replaceList,
}) {
  function renderNavFinder() {
    const state = getState();
    const finder = state.nav.finder;
    if (finder.phase === "loaded") rememberTreeTitles(finder.mode === "listing" ? finder.listing.trees : finder.hits);
    const list = getElement("nav-tree-results");
    const note = getElement("nav-tree-find-note");
    navFinderButtons.clear();
    const session = state.nav.session;
    const treeRow = (tree, matchedOn) => {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.dataset.treeId = tree.treeId;
      if (session !== null && session.treeId === tree.treeId) button.classList.add("active");
      const name = document.createElement("span");
      name.className = "nav-finder-name";
      name.textContent = tree.title !== null ? tree.title : "新的思考";
      const meta = document.createElement("span");
      meta.className = "nav-finder-meta";
      const matchedNote = matchedOn === "id" ? " · matched on id" : "";
      meta.textContent = formatProductTime(tree.createdAt);
      button.append(name, meta);
      button.title =
        tree.title !== null
          ? tree.title
          : "尚未提出第一个问题";
      button.addEventListener("click", () => {
        // The selected tree is rendered inside this tool panel, so keep it visible.
        closeSidebar({ keepLibrary: true });
        void openNavTree(tree.treeId);
      });
      navFinderButtons.set(tree.treeId, button);
      li.append(button);
      return li;
    };
    const items = [];
    if (finder.phase === "loading") {
      items.push(mutedListItem("loading trees…"));
      note.textContent = finder.mode === "search" ? `searching trees for “${finder.query}”…` : "loading the forest…";
    } else if (finder.phase === "failed") {
      const li = document.createElement("li");
      li.className = "muted";
      li.append(document.createTextNode(`trees failed to load — ${finder.error} `));
      const retry = document.createElement("button");
      retry.className = "drawer-retry";
      retry.textContent = "Retry";
      retry.addEventListener("click", () =>
        void (finder.mode === "search" ? runNavTreeFind() : refreshNavForestListing()),
      );
      li.append(retry);
      items.push(li);
      note.textContent = "加载失败，请重试。";
    } else if (finder.mode === "search") {
      if (finder.hits.length === 0) {
        items.push(
          mutedListItem(
            `没有找到“${finder.query}”。清空搜索可查看全部思考树。`,
          ),
        );
      } else {
        for (const hit of finder.hits) items.push(treeRow(hit, hit.matchedOn));
        if (finder.hitCursor !== null) {
          const li = document.createElement("li");
          const more = document.createElement("button");
          more.className = "nav-more";
          more.textContent = finder.moreLoading
            ? "loading more hits…"
            : `More tree hits (${String(finder.hits.length)} loaded)`;
          more.disabled = finder.moreLoading;
          more.addEventListener("click", () => void loadNavTreeSearchMore());
          li.append(more);
          items.push(li);
        }
      }
      note.textContent = `找到 ${String(finder.hits.length)} 棵思考树`;
    } else {
      const listing = finder.listing;
      if (listing.totalTrees === 0 && listing.trees.length === 0) {
        items.push(
          mutedListItem(
            "还没有思考树，可以先创建一个新的思考。",
          ),
        );
      } else {
        for (const tree of listing.trees) items.push(treeRow(tree, null));
        if (listing.nextCursor !== null) {
          const li = document.createElement("li");
          const more = document.createElement("button");
          more.className = "nav-more";
          more.textContent = finder.moreLoading
            ? "loading more trees…"
            : `More trees (${String(listing.trees.length)} of ${String(listing.totalTrees)})`;
          more.disabled = finder.moreLoading;
          more.addEventListener("click", () => void loadNavForestMore());
          li.append(more);
          items.push(li);
        }
      }
      note.textContent =
        listing.totalTrees > 0 ? `已显示 ${String(listing.trees.length)} / ${String(listing.totalTrees)} 棵思考树` : "";
    }
    if (finder.moreError !== null) {
      note.textContent = `${note.textContent === "" ? "" : `${note.textContent} · `}loading more failed — ${finder.moreError}`;
    }
    replaceList(list, items, navFinderButtons);
  }

  return { renderNavFinder };
}
