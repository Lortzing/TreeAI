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
        ? "请先打开一棵思考树"
        : "定位当前讨论所在的路径";
    source.disabled = session === null || session.selectedBranchId === null;
    source.title =
      session === null || session.selectedBranchId === null
        ? "请先选择一条路径"
        : "打开这条路径的来源";
  }

  function renderNavSurfaceChrome() {
    const state = getState();
    const session = state.nav.session;
    const title = getElement("nav-tree-title");
    const meta = getElement("nav-tree-meta");
    title.dataset.treeId = session?.treeId ?? "";
    if (session === null) {
      getElement("nav-surface").hidden = true;
      title.textContent = "";
      meta.textContent = "";
      renderNavTreeActions();
      return;
    }
    if (session.overviewState === "loading") {
      title.textContent = "思考树";
      meta.textContent = "正在加载…";
    } else if (session.overviewState === "failed") {
      title.textContent = "思考树";
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
          ? overview.title
          : "新的思考";
      title.title = title.textContent;
      meta.textContent = `${String(overview.nodeCount)} 条路径`;
      if (overview.nodeCount <= 1) {
        meta.append(
          document.createTextNode(" · 选中回答可以展开支线"),
        );
      }
    }
    renderNavTreeActions();
  }

  return { renderNavSurfaceChrome, renderNavTreeActions };
}
