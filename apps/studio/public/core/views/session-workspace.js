/** Saved Episode pages and Session relationship graph, owned by one Studio instance. */
export function createSessionWorkspace(deps) {
const readingTitles = new Map();
function questionTitle(view) {
  const firstQuestion = view?.turns.find((turn) => turn.role === "user");
  return firstQuestion ? firstQuestion.text.replace(/\s+/g, " ").trim() : "";
}
function renderReadingHeading() {
  const view = deps.branchView(deps.trunkBranchId());
  const title = questionTitle(view);
  if (deps.state.currentTreeId !== null && title) readingTitles.set(deps.state.currentTreeId, title);
  const heading = deps.$("reading-title");
  if (heading) {
    heading.textContent = title || "一个问题，无限可能。";
    heading.title = title;
  }
  if (deps.$("forest-count")) deps.$("forest-count").textContent = String(deps.state.trees.length).padStart(2, "0");
  if (deps.$("branch-count")) deps.$("branch-count").textContent = String(deps.state.treeState?.branches.length ?? 0).padStart(2, "0");
}

const sessionUI = { mode: "chat", treeId: null, branchId: null, zoom: 1, signature: "", rounds: new Map(), followBranchId: null };
const SESSION_GRAPH_LIMIT = 120;
let harvestLimit = 20;
// Convenience cursor only: saved turns remain authoritative and every restored ID is validated.
function storedRound(view) {
  try { return deps.window.localStorage?.getItem(`treeai:round:${roundKey(view)}`); } catch { return null; }
}
function rememberRound(view, round) {
  if (!round) return;
  if (sessionUI.rounds.get(roundKey(view)) === round.id) return;
  sessionUI.rounds.set(roundKey(view), round.id);
  try { deps.window.localStorage?.setItem(`treeai:round:${roundKey(view)}`, round.id); } catch { /* Reading works without storage. */ }
}

function sessionRounds(view) {
  const rounds = [];
  const groups = new Map();
  const turnRounds = new Map();
  for (const turn of view.turns) {
    if (turn.role === "return") continue;
    // 旧记录没有 Episode 时保守使用 Run / Turn 身份，绝不猜测消息配对。
    const id = turn.episodeId || turn.runId || turn.id;
    let round = groups.get(id);
    if (!round) {
      round = { id, turns: [], returns: [], createdAt: turn.createdAt, runs: new Set() };
      groups.set(id, round);
      rounds.push(round);
    }
    round.turns.push(turn);
    if (turn.runId) round.runs.add(turn.runId);
    turnRounds.set(turn.id, round);
  }
  const unattached = [];
  for (const turn of view.turns) {
    if (turn.role !== "return") continue;
    const anchored = turn.targetAnchor ? turnRounds.get(turn.targetAnchor.anchorTurnId) : null;
    const previous = [...rounds].reverse().find((round) => round.createdAt <= turn.createdAt);
    const round = anchored || previous;
    if (round) round.returns.push(turn);
    else unattached.push(turn);
  }
  return { rounds, unattached };
}

function sessionName(view) {
  return questionTitle(view) || view.origin?.selection.text || (view.branch.id === deps.trunkBranchId() ? "还未提问的主线" : "还未开始的探索");
}

function workspaceElement(tag, className, text) {
  const element = deps.document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function workspaceButton(label, className, action) {
  const button = workspaceElement("button", className, label);
  button.type = "button";
  button.addEventListener("click", action);
  return button;
}

function animateSessionSurface(target, origin) {
  if (!target || !origin || deps.prefersReducedMotion() || typeof target.animate !== "function") return;
  const destination = target.getBoundingClientRect();
  if (!origin.width || !origin.height || !destination.width || !destination.height) return;
  target.style.animation = "none";
  const animation = target.animate([
    { transformOrigin: "top left", transform: `translate(${origin.left - destination.left}px, ${origin.top - destination.top}px) scale(${origin.width / destination.width}, ${origin.height / destination.height})`, opacity: .45 },
    { transformOrigin: "top left", transform: "translate(0, 0) scale(1, 1)", opacity: 1 },
  ], { duration: 420, easing: "cubic-bezier(.22,1,.36,1)", fill: "both" });
  animation.onfinish = () => animation.cancel();
}

function roundKey(view) { return `${deps.state.currentTreeId}:${view.branch.id}`; }

function currentSessionRound(view) {
  const model = sessionRounds(view);
  const key = roundKey(view);
  const selectedId = sessionUI.rounds.get(key) || storedRound(view);
  let round = model.rounds.find((item) => item.id === selectedId);
  if (!round || sessionUI.followBranchId === view.branch.id) round = model.rounds[model.rounds.length - 1];
  rememberRound(view, round);
  return { ...model, round, index: model.rounds.indexOf(round) };
}

function selectRoundForTurn(turnId) {
  const found = deps.findTurnById(turnId);
  if (!found) return;
  const round = sessionRounds(found.view).rounds.find((item) => [...item.turns, ...item.returns].some((turn) => turn.id === turnId));
  if (round && sessionUI.rounds.get(roundKey(found.view)) !== round.id) {
    rememberRound(found.view, round);
    return true;
  }
  return false;
}

function setWorkspaceView(mode, branchId, originRect, focus = true) {
  if (!["chat", "map", "harvest"].includes(mode)) return;
  if (deps.state.drawerOpen) deps.closeDrawer();
  deps.closeSidebar();
  sessionUI.branchId = branchId || deps.state.panelBranchId || deps.trunkBranchId();
  sessionUI.mode = mode;
  sessionUI.signature = "";
  renderSessionWorkspace();
  if (!focus) return;
  if (mode === "chat") {
    if (deps.state.treeState) deps.focusComposerWhenSelectable(deps.$(deps.state.panelBranchId ? "panel-prompt-input" : "prompt-input"));
    else deps.$("empty-new-tree").focus();
  } else deps.$("session-workspace").focus({ preventScroll: true });
}

function renderRoundNavigation() {
  const root = deps.$("round-navigation");
  if (!root) return;
  root.hidden = !deps.state.treeState || sessionUI.mode !== "chat";
  const view = deps.branchView(deps.state.panelBranchId || deps.trunkBranchId());
  if (!view) return;
  const { round, rounds, index } = currentSessionRound(view);
  deps.$("round-previous").disabled = index <= 0;
  deps.$("round-next").disabled = index < 0 || index >= rounds.length - 1;
  deps.$("round-position").textContent = round ? `${String(index + 1).padStart(2, "0")} / ${String(rounds.length).padStart(2, "0")}` : "00 / 00";
  for (const id of ["main-reading-content", "branch-panel"]) {
    const card = deps.$(id);
    card.classList.toggle("has-history", rounds.length > 1);
    card.classList.toggle("has-more-history", rounds.length > 2);
  }
}

function renderSessionWorkspace() {
  const root = deps.$("session-workspace");
  if (!root) return; // 独立功能测试中的最小旧骨架仍可运行。
  const st = deps.state.treeState;
  const treeId = deps.state.currentTreeId;
  if (sessionUI.treeId !== treeId) {
    sessionUI.treeId = treeId;
    sessionUI.branchId = st?.trunkBranchId ?? null;
    sessionUI.signature = "";
    sessionUI.zoom = 1;
    harvestLimit = 20;
  }
  if (st && !st.branches.some((view) => view.branch.id === sessionUI.branchId)) {
    sessionUI.branchId = st.trunkBranchId;
  }
  deps.$("main").dataset.workspaceView = sessionUI.mode;
  for (const mode of ["chat", "map", "harvest"]) {
    const button = deps.$("mode-" + mode);
    button?.classList.toggle("active", sessionUI.mode === mode);
    button?.setAttribute("aria-pressed", String(sessionUI.mode === mode));
  }
  const alternate = sessionUI.mode !== "chat";
  if (alternate && treeId) {
    const context = sessionUI.mode === "harvest" ? "收获与继续" : "关系图";
    deps.$("topbar-path").textContent = `${readingTitles.get(treeId) || treeId} / ${context}`;
    deps.$("topbar-path").title = `${treeId} / ${context}`;
  } else {
    deps.renderTopbarPath();
  }
  root.hidden = !alternate;
  for (const id of ["tree-view", "empty-state"]) {
    const underlying = deps.$(id);
    if (alternate) {
      underlying.setAttribute("inert", "");
      underlying.setAttribute("aria-hidden", "true");
    } else {
      underlying.removeAttribute("inert");
      underlying.removeAttribute("aria-hidden");
    }
  }
  renderRoundNavigation();
  if (!alternate) return;
  const signature = JSON.stringify([sessionUI.mode, treeId, sessionUI.branchId, sessionUI.zoom,
    harvestLimit, deps.state.materials, st?.branches.map((view) => [view.branch.id, view.branch.parentBranchId, view.sessionAvailability,
      view.origin, view.turns.map((turn) => [turn.id, turn.episodeId, turn.role, turn.text, turn.deliveredRunId, turn.targetAnchor]), view.returnAttempts])]);
  if (signature === sessionUI.signature) return;
  sessionUI.signature = signature;
  const focused = deps.document.activeElement;
  const focusId = focused?.id;
  const previousScroll = root.querySelector(sessionUI.mode === "harvest" ? ".harvest-content" : ".session-map-scroll");
  const savedScroll = previousScroll ? { top: previousScroll.scrollTop, left: previousScroll.scrollLeft } : null;
  root.replaceChildren();
  if (!st) {
    const empty = workspaceElement("div", "session-view-empty");
    empty.append(workspaceElement("h1", "", "暂无 Session"), workspaceButton("＋ 新建思考树", "primary", () => deps.guard(deps.createTree)));
    root.append(empty);
  } else if (sessionUI.mode === "harvest") renderHarvest(root, st);
  else renderSessionMap(root, st, savedScroll);
  if (sessionUI.mode === "harvest" && savedScroll) root.querySelector(".harvest-content").scrollTop = savedScroll.top;
  if (focusId && focused !== deps.document.body && !deps.document.body.contains?.(focused)) {
    const replacement = deps.$(focusId);
    if (replacement) replacement.focus({ preventScroll: true });
    else root.focus({ preventScroll: true });
  }
}

function sessionViewHeading(root, eyebrow, title, description) {
  const heading = workspaceElement("header", "session-view-heading");
  heading.append(workspaceElement("h1", "", title));
  root.append(heading);
  return heading;
}


function renderHarvest(root, st) {
  sessionViewHeading(root, "", "收获与继续", "");
  const content = workspaceElement("div", "harvest-content");
  content.append(workspaceElement("p", "harvest-note", "保存你认可的收获，回到出处继续思考。采用状态仅表示是否进入主线运行上下文。"));
  const recent = workspaceElement("section", "harvest-section");
  recent.append(workspaceElement("h2", "", "继续讨论"));
  const active = st.branches.map((view) => ({ view, latest: view.turns.filter((turn) => turn.role !== "return").at(-1) }))
    .filter((item) => item.latest).sort((a, b) => b.latest.createdAt.localeCompare(a.latest.createdAt) || a.view.branch.id.localeCompare(b.view.branch.id));
  for (const { view, latest } of active.slice(0, 5)) {
    const row = workspaceElement("div", "harvest-resume");
    row.append(workspaceButton(sessionName(view), "harvest-resume-button", () => void deps.guard(() => openSessionRound(view.branch.id))),
      workspaceElement("span", "harvest-note", `最近讨论 ${new Date(latest.createdAt).toLocaleString()}${view.sessionAvailability === "unavailable" ? " · 执行会话不可用，保存内容仍可读" : ""}`));
    recent.append(row);
  }
  if (!active.length) recent.append(workspaceElement("p", "harvest-note", "还没有讨论。带着一个问题开始阅读材料。"));
  content.append(recent);
  const materials = workspaceElement("section", "harvest-section");
  materials.append(workspaceElement("h2", "", "继续阅读"), workspaceElement("p", "harvest-note", "打开材料会恢复数据库中保存的阅读版本和位置。"));
  const loaded = deps.state.materials;
  if (!loaded) materials.append(workspaceElement("p", "harvest-note", "正在加载材料…"));
  else if (!loaded.ok) materials.append(workspaceElement("p", "", loaded.error), workspaceButton("重试加载材料", "", () => void deps.refreshMaterials()));
  else if (!loaded.materials.length) materials.append(workspaceElement("p", "harvest-note", "还没有材料，可从侧栏导入。"));
  else for (const { material } of loaded.materials) {
    materials.append(workspaceButton(material.title, "harvest-material", () => void deps.guard(async () => {
      setWorkspaceView("chat", undefined, undefined, false);
      await deps.openMaterial(material.id, { trigger: { kind: "element", element: deps.$("mode-harvest") } });
    })));
  }
  content.append(materials);
  const returns = st.branches.flatMap((view) => view.turns.filter((turn) => turn.role === "return").map((turn) => ({ turn, view })))
    .sort((a, b) => b.turn.createdAt.localeCompare(a.turn.createdAt) || a.turn.id.localeCompare(b.turn.id));
  const saved = workspaceElement("section", "harvest-section");
  saved.append(workspaceElement("h2", "", `已保存的收获 · ${returns.length}`));
  if (!returns.length) saved.append(workspaceElement("p", "harvest-note", "还没有保存的收获。探索后可编辑 Return 草稿，确认保存到主线。"));
  for (const { turn, view } of returns.slice(0, harvestLimit)) {
    const card = workspaceElement("article", "harvest-card");
    card.dataset.harvestId = turn.id;
    const attempts = view.returnAttempts.filter((attempt) => attempt.turnId === turn.id);
    const status = turn.deliveredRunId ? "已进入一次成功主线运行的上下文" : attempts.length ? `已尝试采用 ${attempts.length} 次 · 仍待采用` : "已保存 · 待下次主线讨论采用";
    card.append(workspaceElement("p", "harvest-note", `${new Date(turn.createdAt).toLocaleString()} · ${status}`), workspaceElement("p", "harvest-text", turn.text));
    const from = st.branches.find((item) => item.branch.id === turn.fromBranchId);
    card.append(workspaceElement("p", "harvest-note", `来自：${from ? sessionName(from) : turn.fromBranchId || "来源分支不可用"}`));
    if (turn.targetAnchor) {
      card.append(workspaceElement("blockquote", "harvest-quote", turn.targetAnchor.selection.text));
      const identity = workspaceElement("details", "harvest-identity");
      identity.append(workspaceElement("summary", "", "来源身份"), workspaceElement("p", "", `${turn.targetAnchor.sourceBranchId} / ${turn.targetAnchor.anchorTurnId} / ${turn.targetAnchor.anchorEntryId} · ${turn.targetAnchor.selection.start}–${turn.targetAnchor.selection.end}`));
      card.append(identity);
    }
    const actions = workspaceElement("div", "harvest-actions");
    actions.append(workspaceButton("查看收获所在轮次", "", () => void deps.guard(async () => {
      selectRoundForTurn(turn.id);
      sessionUI.followBranchId = null;
      await openSessionRound(view.branch.id);
    })));
    if (from) actions.append(workspaceButton("查看原始出处", "", () => void deps.guard(async () => {
      const treeId = deps.state.currentTreeId;
      if (from.origin) {
        await openSessionRound(from.branch.id);
        await deps.revealOrigin(from.branch.id);
      } else {
        // Database-backed locate survives a fresh browser with no material-origin cache.
        const location = await deps.api(`/api/nav/branches/${encodeURIComponent(from.branch.id)}/locate`);
        if (deps.state.currentTreeId !== treeId) return;
        if (location.treeId !== treeId || location.origin?.kind !== "material") throw new Error("原始出处不可用；已保存的收获仍然保留。");
        setWorkspaceView("chat", undefined, undefined, false);
        await deps.openMaterial(location.origin.materialId, {
          versionId: location.origin.versionId, focusBlockId: location.origin.blockId, arrival: "return-source",
          trigger: { kind: "element", element: deps.$("mode-harvest") },
        });
      }
    })));
    card.append(actions);
    [...actions.children].forEach((button, index) => { button.id = `harvest-action-${turn.id}-${index}`; });
    saved.append(card);
  }
  if (returns.length > harvestLimit) saved.append(workspaceButton(`继续显示收获（还有 ${returns.length - harvestLimit} 条）`, "", () => {
    harvestLimit += 20;
    renderSessionWorkspace();
  }));
  content.append(saved);
  root.append(content);
}

function renderSessionMap(root, st, savedScroll) {
  const heading = sessionViewHeading(root, "", "关系图", "");
  const tools = workspaceElement("div", "session-map-tools");
  tools.append(workspaceElement("span", "", `${st.branches.length} 个 Session · 当前思考树`));
  const zoomGroup = workspaceElement("div", "map-zoom");
  const zoom = (amount) => {
    sessionUI.zoom = Math.min(1.25, Math.max(.5, Math.round((sessionUI.zoom + amount) * 100) / 100));
    renderSessionWorkspace();
  };
  const zoomOut = workspaceButton("−", "", () => zoom(-.15));
  zoomOut.id = "session-zoom-out";
  zoomOut.setAttribute("aria-label", "缩小关系图");
  zoomOut.disabled = sessionUI.zoom <= .5;
  const zoomIn = workspaceButton("＋", "", () => zoom(.15));
  zoomIn.id = "session-zoom-in";
  zoomIn.setAttribute("aria-label", "放大关系图");
  zoomIn.disabled = sessionUI.zoom >= 1.25;
  const reset = workspaceButton("重置", "", () => { sessionUI.zoom = 1; renderSessionWorkspace(); });
  reset.id = "session-zoom-reset";
  zoomGroup.append(zoomOut, workspaceElement("span", "", `${Math.round(sessionUI.zoom * 100)}%`), zoomIn, reset);
  tools.append(zoomGroup);
  root.append(tools);
  // 按实际父子关系做横向布局；限制可视图节点，规模导航仍由既有按需加载树承担。
  const shown = st.branches.slice(0, SESSION_GRAPH_LIMIT);
  const byId = new Map(shown.map((view) => [view.branch.id, view]));
  const children = new Map(shown.map((view) => [view.branch.id, []]));
  const roots = [];
  for (const view of shown) {
    const parent = view.branch.parentBranchId;
    if (parent && byId.has(parent) && parent !== view.branch.id) children.get(parent).push(view.branch.id);
    else roots.push(view.branch.id);
  }
  const positions = new Map();
  const visited = new Set();
  let row = 0;
  let maxDepth = 0;
  function place(id, depth) {
    if (visited.has(id)) return null;
    visited.add(id);
    maxDepth = Math.max(maxDepth, depth);
    const childRows = children.get(id).map((child) => place(child, depth + 1)).filter((value) => value !== null);
    const y = childRows.length ? (childRows[0] + childRows[childRows.length - 1]) / 2 : row++ * 220 + 105;
    positions.set(id, { x: 48 + depth * 310, y });
    return y;
  }
  roots.forEach((id) => place(id, 0));
  shown.filter((view) => !visited.has(view.branch.id)).forEach((view) => place(view.branch.id, 0));
  const width = Math.max(650, 360 + maxDepth * 310);
  const height = Math.max(460, row * 220 + 80);
  const scroller = workspaceElement("div", "session-map-scroll");
  scroller.setAttribute("aria-label", "关系图；滚动查看，点击卡片组进入轮次");
  const canvas = workspaceElement("div", "session-map-canvas");
  canvas.setAttribute("style", `width:${width * sessionUI.zoom}px;height:${height * sessionUI.zoom}px`);
  const layer = workspaceElement("div", "session-map-layer");
  layer.setAttribute("style", `width:${width}px;height:${height}px;transform:scale(${sessionUI.zoom})`);
  // SVG 只画关系；可访问、可键盘操作的 Session 仍是原生 HTML 按钮。
  if (typeof deps.document.createElementNS === "function") {
    const svg = deps.document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    svg.setAttribute("aria-hidden", "true");
    svg.classList.add("session-connectors");
    for (const view of shown) {
      const child = positions.get(view.branch.id);
      const parent = positions.get(view.branch.parentBranchId);
      if (!parent || !child || child.x <= parent.x) continue;
      const path = deps.document.createElementNS("http://www.w3.org/2000/svg", "path");
      const x1 = parent.x + 222, x2 = child.x;
      path.setAttribute("d", `M ${x1} ${parent.y + 72} C ${x1 + 48} ${parent.y + 72}, ${x2 - 48} ${child.y + 72}, ${x2} ${child.y + 72}`);
      svg.append(path);
    }
    layer.append(svg);
  }
  for (const view of shown) {
    const id = view.branch.id;
    const position = positions.get(id);
    const { rounds } = sessionRounds(view);
    const selected = id === sessionUI.branchId;
    const node = workspaceButton("", "session-stack" + (selected ? " selected" : ""), () => void deps.guard(() => openSessionRound(id, node.getBoundingClientRect?.())));
    if (rounds.length > 1) node.classList.add("stack-double");
    if (rounds.length > 2) node.classList.add("stack-multiple");
    node.dataset.sessionId = id;
    node.dataset.parentSessionId = view.branch.parentBranchId || "";
    node.setAttribute("style", `left:${position.x}px;top:${position.y}px`);
    node.setAttribute("aria-label", `${sessionName(view)}，${rounds.length} 轮对话，打开 Session 卡片`);
    node.setAttribute("aria-pressed", String(selected));
    const face = workspaceElement("span", "stack-face");
    face.append(workspaceElement("span", "stack-kind", id === st.trunkBranchId ? "主线 SESSION" : "探索 SESSION"),
      workspaceElement("strong", "stack-title", sessionName(view)),
      workspaceElement("span", "stack-meta", `${String(rounds.length).padStart(2, "0")} 轮对话${view.sessionAvailability === "unavailable" ? " · 原执行会话不可用" : ""}`));
    node.append(face);
    node.title = `${id}\n${sessionName(view)}${view.origin ? `\n来源：${view.origin.selection.text}` : ""}`;
    layer.append(node);
  }
  canvas.append(layer);
  scroller.append(canvas);
  root.append(scroller);
  const foot = workspaceElement("footer", "session-view-foot");

  if (st.branches.length > shown.length) {
    foot.append(workspaceButton(`仅展示前 ${shown.length} 个 · 打开深度导航`, "session-text-button", () => {
      setWorkspaceView("chat");
      deps.$("nav-section").open = true;
      deps.document.body.classList.add("sidebar-open");
      deps.$("sidebar-toggle").setAttribute("aria-expanded", "true");
      deps.$("nav-tree-search").focus();
    }));
  }
  root.append(foot);
  if (savedScroll) { scroller.scrollTop = savedScroll.top; scroller.scrollLeft = savedScroll.left; }
}

function moveSessionRound(delta) {
  const view = deps.branchView(deps.state.panelBranchId || deps.trunkBranchId());
  if (!view || sessionUI.mode !== "chat") return;
  const { rounds, index: current } = currentSessionRound(view);
  const index = Math.max(0, Math.min(rounds.length - 1, current + delta));
  if (!rounds[index] || index === current) return;
  sessionUI.followBranchId = null;
  rememberRound(view, rounds[index]);
  deps.renderAll();
  const container = deps.$(deps.state.panelBranchId ? "panel-conversation" : "conversation");
  container.scrollTop = 0;
  const card = deps.$(deps.state.panelBranchId ? "branch-panel" : "main-reading-content");
  if (!deps.prefersReducedMotion() && typeof card.animate === "function") card.animate([
    { opacity: .35, transform: `translateX(${delta > 0 ? 24 : -24}px)` },
    { opacity: 1, transform: "translateX(0)" },
  ], { duration: 280, easing: "cubic-bezier(.22,1,.36,1)" });
}

async function openSessionRound(branchId, originRect) {
  setWorkspaceView("chat", branchId, undefined, false);
  if (deps.state.materialReader !== null) deps.closeMaterialReader();
  if (branchId === deps.trunkBranchId()) {
    if (deps.state.panelBranchId !== null) await deps.closePanel({ focus: "none" });
  } else if (deps.state.panelBranchId !== branchId) {
    await deps.openBranchPanel(branchId, { trigger: { kind: "element", element: deps.$("mode-map") } });
  }
  deps.renderAll();
  animateSessionSurface(deps.$(deps.state.panelBranchId ? "branch-panel" : "main-reading-content"), originRect);
}


return { sessionUI, readingTitles, questionTitle, renderReadingHeading, currentSessionRound, selectRoundForTurn, setWorkspaceView, renderSessionWorkspace, moveSessionRound };
}
