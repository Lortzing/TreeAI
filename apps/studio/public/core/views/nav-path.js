/** Navigation nav-path; preserves the existing D4 endpoint and display contracts. */
export function createNavPathView(deps) {
  const { document, getElement: $, getState, selectNavNode } = deps;
  const state = getState();

  const NAV_PATH_COLLAPSE_THRESHOLD = 6;

  function navStepLabel(step) {
    return step.title !== null ? step.title : step.depth === 0 ? "Trunk" : step.id;
  }

  /** 路径行渲染：当前节点的完整根→选中链（path 端点 100 层完整返回）；长链
      默认收拢（首两步 + “show full path” + 末两步——收拢是显示态，展开后
      全部步在场）；每步可点击选中该祖先（向上导航）。 */
  function renderNavPath() {
    const session = state.nav.session;
    const heading = $("nav-path-heading");
    const wrap = $("nav-path");
    wrap.replaceChildren();
    if (session === null || session.overview === null) {
      heading.textContent = "";
      return;
    }
    if (session.selectedBranchId === null) {
      heading.textContent = "no branch selected — click a row (or press Enter) to select it and see its full path";
      return;
    }
    const path = session.path;
    if (path === null || path.state === "loading") {
      heading.textContent = "loading the full path…";
      return;
    }
    if (path.state === "failed") {
      heading.textContent = `full path failed to load — ${path.error}`;
      const retry = document.createElement("button");
      retry.className = "drawer-retry";
      retry.textContent = "Retry";
      retry.addEventListener("click", () => {
        if (session.selectedBranchId !== null) void selectNavNode(session.selectedBranchId);
      });
      wrap.append(retry);
      return;
    }
    if (path.state === "idle") return;
    const steps = path.steps;
    heading.textContent = `full path · ${String(steps.length)} level(s), root → selected`;
    const stepButton = (step, isCurrent) => {
      const button = document.createElement("button");
      button.className = isCurrent ? "nav-path-step active" : "nav-path-step";
      button.textContent = navStepLabel(step);
      button.title = `select ${step.id} (depth ${String(step.depth)})`;
      button.addEventListener("click", () => void selectNavNode(step.id));
      return button;
    };
    const parts = [];
    if (steps.length > NAV_PATH_COLLAPSE_THRESHOLD && !session.pathShowAll) {
      /* 首两步 + 末两步（收拢态仍保上下文两端；隐藏层数 = 总数 − 4）。 */
      parts.push(stepButton(steps[0], false));
      parts.push(stepButton(steps[1], false));
      const more = document.createElement("button");
      more.className = "nav-path-more";
      more.textContent = `… ${String(steps.length - 4)} more level(s) — show full path`;
      more.addEventListener("click", () => {
        session.pathShowAll = true;
        renderNavPath();
      });
      parts.push(more);
      parts.push(stepButton(steps[steps.length - 2], false));
      parts.push(stepButton(steps[steps.length - 1], true));
    } else {
      steps.forEach((step, index) => parts.push(stepButton(step, index === steps.length - 1)));
    }
    const out = [];
    parts.forEach((part, index) => {
      if (index > 0) {
        const sep = document.createElement("span");
        sep.className = "nav-path-sep";
        sep.textContent = " / ";
        out.push(sep);
      }
      out.push(part);
    });
    wrap.replaceChildren(...out);
    if (steps.length > NAV_PATH_COLLAPSE_THRESHOLD && session.pathShowAll) {
      const collapse = document.createElement("button");
      collapse.className = "nav-path-more";
      collapse.textContent = "collapse path";
      collapse.addEventListener("click", () => {
        session.pathShowAll = false;
        renderNavPath();
      });
      wrap.append(collapse);
    }
  }

  return { renderNavPath };
}
