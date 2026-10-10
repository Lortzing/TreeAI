export function createNavFinderView({
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
      name.textContent = tree.title !== null ? tree.title : tree.treeId;
      const meta = document.createElement("span");
      meta.className = "nav-finder-meta";
      const matchedNote = matchedOn === "id" ? " · matched on id" : "";
      meta.textContent = `${tree.treeId} · ${formatProductTime(tree.createdAt)}${matchedNote}`;
      button.append(name, meta);
      button.title =
        tree.title !== null
          ? `${tree.title} · ${tree.treeId}`
          : `${tree.treeId} — untitled (no first question on the trunk)`;
      button.addEventListener("click", () => {
        closeSidebar();
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
      note.textContent = "the failure stays visible with a retry — it never collapses into an empty list";
    } else if (finder.mode === "search") {
      if (finder.hits.length === 0) {
        items.push(
          mutedListItem(
            `no tree matches “${finder.query}” by title or id — nothing is fabricated (blank the input and press Find to go back to the forest listing)`,
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
      note.textContent = `${String(finder.hits.length)} tree hit(s) for “${finder.query}”`;
    } else {
      const listing = finder.listing;
      if (listing.totalTrees === 0 && listing.trees.length === 0) {
        items.push(
          mutedListItem(
            "no trees in this forest yet — create one (＋ New Tree) to start; trees you create appear in both Forest and here",
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
        listing.totalTrees > 0 ? `${String(listing.trees.length)} of ${String(listing.totalTrees)} tree(s) listed` : "";
    }
    if (finder.moreError !== null) {
      note.textContent = `${note.textContent === "" ? "" : `${note.textContent} · `}loading more failed — ${finder.moreError}`;
    }
    replaceList(list, items, navFinderButtons);
  }

  return { renderNavFinder };
}
