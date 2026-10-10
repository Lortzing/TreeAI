const SEARCH_KIND_ORDER = ["material", "annotation", "return", "turn"];
const SEARCH_KIND_LABELS = { material: "材料", annotation: "批注", return: "Return", turn: "对话" };

export { SEARCH_KIND_LABELS, SEARCH_KIND_ORDER };

export function createSearchView({
  document,
  getElement,
  getState,
  mutedListItem,
  formatProductTime,
  closeSidebar,
  guard,
  jumpToSearchHit,
  locateAnnotationHit,
  locateTurnHit,
  branchView,
  trunkBranchId,
  openBranchPanel,
}) {
  const searchHitButtons = new Map();

  function searchHitKey(hit) {
    const target = hit.target;
    if (target === null || typeof target !== "object") return `unaddressable:${hit.kind}:${hit.treeId}`;
    if (target.kind === "material") {
      return `${target.kind}:${target.treeId}:${target.materialId}:${target.versionId}:${target.blockId ?? ""}`;
    }
    if (target.kind === "annotation") {
      return `${target.kind}:${target.treeId}:${target.annotationId}`;
    }
    return `${target.kind}:${target.treeId}:${target.branchId}:${target.turnId}`;
  }

  function searchStatusLine() {
    const state = getState();
    const search = state.search;
    const noteSuffix = search.note === null ? "" : ` — ${search.note}`;
    if (search.phase === "loading") {
      return `searching ${search.resultScope === "tree" ? "this tree" : "all trees"}…`;
    }
    if (search.phase === "failed") {
      return `search failed — ${search.error ?? "unknown error"} (press Search to retry)${noteSuffix}`;
    }
    if (search.phase === "loaded") {
      const scopeLabel = search.resultScope === "tree" ? "in this tree" : "across all trees";
      if (search.hits.length === 0) {
        return `0 hits for “${search.resultQuery ?? ""}” ${scopeLabel} — nothing in the saved facts matches; no results are fabricated${noteSuffix}`;
      }
      return `${String(search.hits.length)} hit(s) for “${search.resultQuery ?? ""}” ${scopeLabel} — only saved facts are searched; unsubmitted drafts are never indexed${noteSuffix}`;
    }
    return `search saved facts — 材料 / 批注 / Return / 对话; unsubmitted drafts and explain caches are never indexed${noteSuffix}`;
  }

  function buildSearchHitMeta(hit) {
    const state = getState();
    const meta = document.createElement("span");
    meta.className = "search-hit-meta";
    const appendText = (text) => {
      if (meta.children.length > 0 || meta.textContent !== "") meta.append(document.createTextNode(" · "));
      meta.append(document.createTextNode(text));
    };
    if (hit.kind === "material") {
      if (typeof hit.materialTitle === "string" && hit.materialTitle !== "") appendText(hit.materialTitle);
      if (typeof hit.versionLabel === "string" && hit.versionLabel !== "") {
        appendText(hit.versionLabel);
        if (hit.oldVersion) {
          const old = document.createElement("span");
          old.className = "search-old-version";
          old.textContent = "旧版本";
          meta.append(document.createTextNode(" · "), old);
        }
      }
    }
    appendText(formatProductTime(hit.createdAt));
    if (hit.treeId !== state.currentTreeId) appendText(hit.treeTitle);
    return meta;
  }

  function searchHitSessionNote(hit, key) {
    const state = getState();
    if (state.treeState === null || hit.treeId !== state.currentTreeId) return null;
    let branchId = null;
    if (hit.kind === "annotation") {
      const located = locateAnnotationHit(hit);
      branchId = located === null ? null : located.annotation.branchId;
    } else if (hit.kind === "turn" || hit.kind === "return") {
      const located = locateTurnHit(hit);
      branchId = located === null ? null : located.view.branch.id;
    } else {
      return null;
    }
    if (branchId === null) return null;
    const view = branchView(branchId);
    if (view === null || view.sessionAvailability !== "unavailable") return null;
    const wrap = document.createElement("div");
    wrap.className = "search-hit-session";
    const text = document.createElement("span");
    text.className = "search-hit-session-text";
    text.textContent = "session unavailable on this branch — the saved text stays readable";
    const explore = document.createElement("button");
    explore.className = "search-hit-explore";
    explore.textContent = "⑃ 新探索";
    explore.title =
      "open this branch and type the first question — its composer carries the “Start new exploration” entry (the old Pi session cannot continue)";
    explore.addEventListener("click", () => {
      closeSidebar();
      void guard(async () => {
        if (branchId !== trunkBranchId()) {
          await openBranchPanel(branchId, { trigger: { kind: "search-hit", hitKey: key } });
        }
      }).then(() => {
        const input = getElement(branchId === trunkBranchId() ? "prompt-input" : "panel-prompt-input");
        if (!input.disabled) input.focus();
      });
    });
    wrap.append(text, explore);
    return wrap;
  }

  function renderSearchHitRow(hit) {
    const key = searchHitKey(hit);
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.className = "search-hit";
    button.dataset.hitKey = key;
    const badge = document.createElement("span");
    badge.className = `search-hit-kind k-${hit.kind}`;
    badge.textContent = SEARCH_KIND_LABELS[hit.kind];
    const title = document.createElement("span");
    title.className = "search-hit-title";
    title.textContent = hit.title;
    const meta = buildSearchHitMeta(hit);
    const excerpt = document.createElement("span");
    excerpt.className = "search-hit-excerpt";
    excerpt.textContent = hit.excerpt;
    button.append(badge, title, meta, excerpt);
    button.title = `open this ${SEARCH_KIND_LABELS[hit.kind]} hit at its source`;
    button.addEventListener("click", () => {
      closeSidebar();
      void guard(() => jumpToSearchHit(hit));
    });
    searchHitButtons.set(key, button);
    li.append(button);
    const session = searchHitSessionNote(hit, key);
    if (session !== null) li.append(session);
    return li;
  }

  function renderSearchSection() {
    const state = getState();
    const hasTree = state.currentTreeId !== null;
    const wantTree = state.search.scope === "tree" && hasTree;
    const scopeTree = getElement("search-scope-tree");
    scopeTree.classList.toggle("active", wantTree);
    scopeTree.setAttribute("aria-pressed", wantTree ? "true" : "false");
    scopeTree.disabled = !hasTree;
    scopeTree.title = hasTree ? "" : "no tree is open — search across all trees instead";
    const scopeAll = getElement("search-scope-all");
    scopeAll.classList.toggle("active", !wantTree);
    scopeAll.setAttribute("aria-pressed", !wantTree ? "true" : "false");
    for (const kind of SEARCH_KIND_ORDER) {
      const button = getElement(`search-kind-${kind}`);
      const on = state.search.kinds.includes(kind);
      button.classList.toggle("active", on);
      button.setAttribute("aria-pressed", on ? "true" : "false");
    }
    getElement("search-status").textContent = searchStatusLine();
    const list = getElement("search-results");
    list.replaceChildren();
    searchHitButtons.clear();
    if (state.search.phase === "loading") {
      list.append(mutedListItem("searching…"));
      return;
    }
    if (state.search.phase === "failed") {
      list.append(mutedListItem(`search failed — ${state.search.error ?? "unknown error"} (press Search to retry)`));
      return;
    }
    if (state.search.phase !== "loaded") return;
    if (state.search.hits.length === 0) {
      list.append(
        mutedListItem(
          `no results — nothing in the searched facts matches “${state.search.resultQuery ?? ""}” (nothing is fabricated)`,
        ),
      );
      return;
    }
    for (const hit of state.search.hits) {
      list.append(renderSearchHitRow(hit));
    }
  }

  return {
    renderSearchSection,
    searchHitKey,
    getSearchHitButton: (key) => searchHitButtons.get(key) ?? null,
  };
}
