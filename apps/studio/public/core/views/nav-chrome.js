export function createNavChromeView({ document, getElement, getState, openNavTree }) {
  function renderNavTreeActions() {
    const state = getState();
    const session = state.nav.session;
    const locate = getElement("nav-locate-current");
    const source = getElement("nav-source-selected");
    const treeState = state.treeState;
    const workbenchBranch =
      treeState !== null ? (treeState.cursor !== null ? treeState.cursor.branchId : treeState.trunkBranchId) : null;
    locate.disabled = session === null || workbenchBranch === null;
    locate.title =
      workbenchBranch === null
        ? "no tree is open in the workbench — open one (Forest) to locate its current branch here"
        : `locate the workbench's current branch (${workbenchBranch}) in this navigation view`;
    source.disabled = session === null || session.selectedBranchId === null;
    source.title =
      session === null || session.selectedBranchId === null
        ? "select a branch first (click a row or press Enter)"
        : `reveal the saved origin of ${session.selectedBranchId} (turn → source reveal; material → the reader)`;
  }

  function renderNavSurfaceChrome() {
    const state = getState();
    const session = state.nav.session;
    const title = getElement("nav-tree-title");
    const meta = getElement("nav-tree-meta");
    if (session === null) {
      getElement("nav-surface").hidden = true;
      title.textContent = "";
      meta.textContent = "";
      renderNavTreeActions();
      return;
    }
    if (session.overviewState === "loading") {
      title.textContent = session.treeId;
      meta.textContent = "loading the tree overview…";
    } else if (session.overviewState === "failed") {
      title.textContent = session.treeId;
      meta.replaceChildren();
      meta.append(document.createTextNode(`tree overview failed — ${session.overviewError} `));
      const retry = document.createElement("button");
      retry.className = "drawer-retry";
      retry.textContent = "Retry";
      retry.addEventListener("click", () => void openNavTree(session.treeId));
      meta.append(retry);
    } else {
      const overview = session.overview;
      title.textContent =
        overview.title !== null
          ? `${overview.title} (${overview.treeId})`
          : `${overview.treeId} — untitled (no first question on the trunk)`;
      title.title = title.textContent;
      meta.textContent = `${String(overview.nodeCount)} nodes · max depth ${String(overview.maxDepth)}`;
      if (overview.nodeCount <= 1) {
        meta.append(
          document.createTextNode(" · this tree has no branches yet — branch from any answer to grow it"),
        );
      }
    }
    renderNavTreeActions();
  }

  return { renderNavSurfaceChrome, renderNavTreeActions };
}
