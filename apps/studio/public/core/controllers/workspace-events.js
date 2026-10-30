/** Product navigation bindings; all added listeners are released on instance disposal. */
export function registerWorkspaceEvents(deps) {
  const { $, state, document, window, sessionUI, scrollBehavior, openMaterial, closeMaterialReader, setWorkspaceView, moveSessionRound } = deps;
  const listeners = [];
  const listen = (target, name, handler) => {
    if (!target?.addEventListener) return;
    target.addEventListener(name, handler);
    listeners.push([target, name, handler]);
  };
const narrowScreen = window.matchMedia?.("(max-width: 719px)");
const isNarrow = () => narrowScreen?.matches ?? true;
const closeHistoryDrawer = () => {
  document.body.classList.remove("sidebar-open");
  syncSidebarToggle();
};
function syncSidebarToggle() {
  const open = isNarrow()
    ? document.body.classList.contains("sidebar-open")
    : !document.body.classList.contains("sidebar-collapsed");
  const label = open ? "收起侧栏" : "展开侧栏";
  $("sidebar-toggle").setAttribute("aria-expanded", String(open));
  $("sidebar-toggle").setAttribute("aria-label", label);
  $("sidebar-toggle").title = label;
}
try {
  if (window.localStorage?.getItem("treeai.sidebar-collapsed") === "true") document.body.classList.add("sidebar-collapsed");
} catch { /* Storage can be unavailable; the current page still works. */ }
syncSidebarToggle();
listen(narrowScreen, "change", syncSidebarToggle);
listen($("sidebar-toggle"), "click", () => {
  if ($("workspace-library")) $("workspace-library").open = false;
  $("materials-section").open = false;
  closeSearch(false);
  const name = isNarrow() ? "sidebar-open" : "sidebar-collapsed";
  const enabled = document.body.classList.toggle(name);
  if (!isNarrow()) {
    try { window.localStorage?.setItem("treeai.sidebar-collapsed", String(enabled)); } catch { /* optional preference */ }
  }
  syncSidebarToggle();
});
function closeSearch(restoreFocus = true) {
  $("search-section").open = false;
  $("search-shortcut")?.setAttribute("aria-expanded", "false");
  if (restoreFocus) $("search-shortcut").focus();
}
function focusThoughtSearch() {
  if ($("workspace-library")) $("workspace-library").open = false;
  $("materials-section").open = false;
  $("search-section").open = true;
  $("search-shortcut")?.setAttribute("aria-expanded", "true");
  if (isNarrow()) document.body.classList.add("sidebar-open");
  syncSidebarToggle();
  $("search-input").focus();
}
listen($("search-shortcut"), "click", (event) => {
  event.preventDefault?.();
  if ($("search-section").open) closeSearch();
  else focusThoughtSearch();
});
listen($("search-close"), "click", () => closeSearch());
listen($("search-section"), "toggle", () => {
  $("search-shortcut")?.setAttribute("aria-expanded", $("search-section").open ? "true" : "false");
});
listen($("reading-materials"), "click", () => {
  // Native details activation owns expansion, including keyboard Enter/Space.
  if ($("workspace-library")) $("workspace-library").open = false;
  closeSearch(false);
  closeHistoryDrawer();
});
listen($("materials-section"), "toggle", () => {
  $("reading-materials")?.setAttribute("aria-expanded", String($("materials-section").open));
});
listen($("reading-trunk"), "click", () => {
  closeMaterialReader();
  setWorkspaceView("chat");
  $("prompt-input").focus();
});
listen(document, "keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    focusThoughtSearch();
  }
});
listen($("workspace-library-toggle"), "mousedown", (event) => {
  if (state.armedSelection != null) event.preventDefault();
});
listen($("workspace-library-toggle"), "click", () => {
  closeHistoryDrawer();
  closeSearch(false);
  $("materials-section").open = false;
});
listen($("workspace-library"), "toggle", () => {
  $("workspace-library-toggle")?.setAttribute("aria-expanded", $("workspace-library").open ? "true" : "false");
});
listen($("workspace-library-close"), "click", () => {
  $("workspace-library").open = false;
  $("workspace-library-toggle").focus();
});
listen(document, "pointerdown", (event) => {
  const library = $("workspace-library");
  if (library?.open && event.target && !library.contains(event.target)) library.open = false;
  const search = $("search-section");
  if (search.open && event.target && !search.contains(event.target)) closeSearch(false);
});

/* ------------------------------ 滚动位置记忆（W2 §4） ------------------------------ */

for (const mode of ["chat", "map", "harvest"]) {
  listen($("mode-" + mode), "click", () => {
    closeMaterialReader();
    setWorkspaceView(mode);
  });
}
listen($("round-previous"), "click", () => moveSessionRound(-1));
listen($("round-next"), "click", () => moveSessionRound(1));
listen(document, "keydown", (event) => {
  if (sessionUI.mode !== "chat" || state.drawerOpen || state.materialReader !== null || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (["SELECT", "INPUT", "TEXTAREA", "BUTTON"].includes(event.target?.tagName) || event.target?.isContentEditable) return;
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    moveSessionRound(event.key === "ArrowLeft" ? -1 : 1);
  }
});
for (const id of ["conversation", "panel-conversation"]) {
  let touch = null;
  listen($(id), "pointerdown", (event) => {
    if (event.pointerType === "touch") touch = { x: event.clientX, y: event.clientY };
  });
  listen($(id), "pointerup", (event) => {
    if (!touch) return;
    const dx = event.clientX - touch.x, dy = event.clientY - touch.y;
    touch = null;
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5 && !window.getSelection()?.toString()) moveSessionRound(dx < 0 ? 1 : -1);
  });
  listen($(id), "pointercancel", () => { touch = null; });
}


  return () => { for (const [target, name, handler] of listeners) target.removeEventListener?.(name, handler); };
}
