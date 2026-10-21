/** Product navigation bindings; all added listeners are released on instance disposal. */
export function registerWorkspaceEvents(deps) {
  const { $, state, document, window, sessionUI, scrollBehavior, openMaterial, closeMaterialReader, setWorkspaceView, moveSessionRound } = deps;
  const listeners = [];
  const listen = (target, name, handler) => {
    if (!target) return;
    target.addEventListener(name, handler);
    listeners.push([target, name, handler]);
  };
/* 真实搜索表单仍在原位；只展开 disclosure，不复制表单或重置筛选。 */
function focusThoughtSearch() {
  const section = $("search-section");
  section.open = true;
  $("search-shortcut")?.setAttribute("aria-expanded", "true");
  document.body.classList.add("sidebar-open");
  $("sidebar-toggle").setAttribute("aria-expanded", "true");
  $("search-input").focus();
  section.scrollIntoView?.({ block: "nearest", behavior: scrollBehavior() });
}
listen($("search-shortcut"), "click", focusThoughtSearch);
listen($("search-section"), "toggle", () => {
  $("search-shortcut")?.setAttribute("aria-expanded", $("search-section").open ? "true" : "false");
});
listen($("reading-materials"), "click", () => {
  if (state.materialReader !== null) {
    $("material-reader").focus();
    return;
  }
  if (state.materials?.ok && state.materials.materials.length === 1) {
    void openMaterial(state.materials.materials[0].material.id, {
      trigger: { kind: "element", element: $("reading-materials") },
    });
    return;
  }
  document.body.classList.add("sidebar-open");
  $("sidebar-toggle").setAttribute("aria-expanded", "true");
  $("material-import").focus();
  $("materials-section").scrollIntoView?.({ block: "nearest", behavior: scrollBehavior() });
});
listen($("reading-trunk"), "click", () => {
  closeMaterialReader();
  $("prompt-input").focus();
});
listen(document, "keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    focusThoughtSearch();
  }
});

/* ------------------------------ 滚动位置记忆（W2 §4） ------------------------------ */

for (const mode of ["chat", "map"]) {
  listen($("mode-" + mode), "click", () => setWorkspaceView(mode));
}
listen($("view-map-entry"), "click", () => setWorkspaceView("map"));
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
