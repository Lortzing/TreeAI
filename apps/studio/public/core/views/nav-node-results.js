/** Navigation nav-node-results; preserves the existing D4 endpoint and display contracts. */
export function createNavNodeResultsView(deps) {
  const { document, getElement: $, getState, mutedListItem, navNodeHitButtons, navReplaceList, runNavNodeSearch, loadNavNodeSearchMore, navRevealBranch } = deps;
  const state = getState();

  function navStepLabel(step) {
    return step.title !== null ? step.title : step.depth === 0 ? "Trunk" : step.id;
  }

  /** 命中路径摘要（长链首末收拢显示，完整路径在 title 属性——同名消歧的
      完整身份始终可辨）。 */
  function navHitPathText(path) {
    const labels = path.map((step) => navStepLabel(step));
    if (labels.length > 6) {
      return `${labels.slice(0, 2).join(" / ")} / … / ${labels.slice(-3).join(" / ")}`;
    }
    return labels.join(" / ");
  }

  function renderNavNodeResults() {
    const session = state.nav.session;
    const list = $("nav-node-results");
    const note = $("nav-node-note");
    navNodeHitButtons.clear();
    if (session === null) {
      list.replaceChildren();
      note.textContent = "";
      return;
    }
    const search = session.search;
    const items = [];
    if (search.phase === "idle") {
      list.replaceChildren();
      note.textContent = "find branches by title or id — every hit carries its full path (same-name branches stay distinguishable)";
      return;
    }
    if (search.phase === "loading") {
      items.push(mutedListItem(`searching branches for “${search.query}”…`));
      note.textContent = "searching…";
    } else if (search.phase === "failed") {
      const li = document.createElement("li");
      li.className = "muted";
      li.append(document.createTextNode(`branch search failed — ${search.error} `));
      const retry = document.createElement("button");
      retry.className = "drawer-retry";
      retry.textContent = "Retry";
      retry.addEventListener("click", () => void runNavNodeSearch());
      li.append(retry);
      items.push(li);
      note.textContent = "the failure stays visible with a retry";
    } else {
      if (search.hits.length === 0) {
        items.push(
          mutedListItem(`no branch in this tree matches “${search.query}” by title or id — nothing is fabricated`),
        );
      } else {
        for (const hit of search.hits) {
          const li = document.createElement("li");
          const button = document.createElement("button");
          button.dataset.branchId = hit.branchId;
          if (hit.branchId === session.selectedBranchId) button.classList.add("active");
          const name = document.createElement("span");
          name.className = "nav-finder-name";
          name.textContent =
            (hit.title !== null ? hit.title : "(no first question yet)") +
            (hit.matchedOn === "id" ? " (matched on id)" : "");
          const meta = document.createElement("span");
          meta.className = "nav-finder-meta";
          meta.textContent = `${hit.branchId} · depth ${String(hit.depth)} · ${hit.originKind}`;
          const pathEl = document.createElement("span");
          pathEl.className = "nav-hit-path";
          pathEl.textContent = navHitPathText(hit.path);
          button.append(name, meta, pathEl);
          button.title = `${hit.branchId} · ${hit.path.map((step) => navStepLabel(step)).join(" / ")}`;
          button.addEventListener("click", () => {
            void navRevealBranch(session, hit.branchId, hit.path);
          });
          navNodeHitButtons.set(hit.branchId, button);
          li.append(button);
          items.push(li);
        }
        if (search.nextCursor !== null) {
          const li = document.createElement("li");
          const more = document.createElement("button");
          more.className = "nav-more";
          more.textContent = `More branch hits (${String(search.hits.length)} loaded)`;
          more.addEventListener("click", () => void loadNavNodeSearchMore());
          li.append(more);
          items.push(li);
        }
      }
      note.textContent = `${String(search.hits.length)} branch hit(s) for “${search.query}” in this tree`;
    }
    navReplaceList(list, items, navNodeHitButtons);
  }

  return { renderNavNodeResults };
}
