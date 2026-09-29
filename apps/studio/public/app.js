/* TreeAI Studio — D3 Core MVP 前端（vanilla JS，无构建步骤）。
 *
 * 范围（诚实声明）：无流式推送（每次操作后整树状态刷新）、无 Markdown
 * 渲染、无自动摘要。核心交互：
 *  - 创建/打开 Tree；
 *  - Trunk/Branch 对话展示；
 *  - 在 assistant 答案内选中文本 → “Branch from here”（无选区 = 整条答案）；
 *  - 分支续聊；切回 Trunk；
 *  - 编辑并显式提交 Return 到 Trunk。
 */

"use strict";

/** @typedef {{id:string, createdAt:string, forestId:string}} TreeT */
/** @typedef {{id:string, treeId:string, parentBranchId:string|null, createdAt:string}} BranchT */
/** @typedef {{branchId:string, sourceBranchId:string, anchorTurnId:string, anchorEntryId:string, selection:{start:number,end:number,text:string}, createdAt:string}} OriginT */
/** @typedef {{id:string, treeId:string, branchId:string, episodeId:string, runId:string|null, role:"user"|"assistant"|"return", text:string, piEntryId:string|null, fromBranchId:string|null, deliveredRunId:string|null, createdAt:string}} TurnT */
/** @typedef {{branch:BranchT, origin:OriginT|null, turns:TurnT[]}} BranchViewT */
/** @typedef {{tree:TreeT, trunkBranchId:string|null, branches:BranchViewT[], cursor:{treeId:string,branchId:string,entryId:string}|null}} TreeStateT */

const state = {
  /** @type {TreeT[]} */ trees: [],
  /** @type {string|null} */ currentTreeId: null,
  /** @type {string|null} */ currentBranchId: null,
  /** @type {TreeStateT|null} */ treeState: null,
  busy: false,
};

const $ = (id) => document.getElementById(id);

async function api(path, method = "GET", body = undefined) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    /* non-JSON error body */
  }
  if (!response.ok) {
    const message = payload && payload.error ? `${payload.error.code}: ${payload.error.message}` : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

function showError(message) {
  const banner = $("error-banner");
  banner.textContent = message;
  banner.hidden = false;
  window.setTimeout(() => {
    banner.hidden = true;
  }, 8000);
}

async function guard(fn) {
  if (state.busy) return;
  state.busy = true;
  setBusy(true);
  try {
    await fn();
  } catch (err) {
    showError(String(err && err.message ? err.message : err));
  } finally {
    state.busy = false;
    setBusy(false);
  }
}

function setBusy(busy) {
  for (const id of ["send", "submit-return", "new-tree"]) {
    $(id).disabled = busy;
  }
}

/* ------------------------------ 渲染 ------------------------------ */

function branchLabel(branchId) {
  const st = state.treeState;
  if (st === null) return branchId;
  if (branchId === st.trunkBranchId) return "Trunk";
  const index = st.branches.findIndex((view) => view.branch.id === branchId);
  return `Branch ${index}`;
}

function renderTrees() {
  const list = $("tree-list");
  list.replaceChildren();
  for (const tree of state.trees) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    if (tree.id === state.currentTreeId) button.classList.add("active");
    const name = document.createElement("span");
    name.textContent = tree.id;
    const date = document.createElement("span");
    date.className = "tree-date";
    date.textContent = new Date(tree.createdAt).toLocaleString();
    button.append(name, date);
    button.addEventListener("click", () => guard(() => openTree(tree.id)));
    li.append(button);
    list.append(li);
  }
}

function renderBranchTabs() {
  const st = state.treeState;
  const tabs = $("branch-tabs");
  tabs.replaceChildren();
  for (const view of st.branches) {
    const button = document.createElement("button");
    if (view.branch.id === state.currentBranchId) button.classList.add("active");
    const label = branchLabel(view.branch.id);
    button.textContent = label;
    if (view.origin !== null) {
      button.title = `branched from ${branchLabel(view.origin.sourceBranchId)} · “${view.origin.selection.text}”`;
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.textContent = " °";
      button.append(dot);
    }
    button.addEventListener("click", () => guard(() => switchBranch(view.branch.id)));
    tabs.append(button);
  }
  const cursor = st.cursor;
  $("cursor-note").textContent =
    cursor === null
      ? "session: —"
      : `session @ ${branchLabel(cursor.branchId)} · ${cursor.entryId}`;
}

function renderOriginBanner() {
  const st = state.treeState;
  const banner = $("origin-banner");
  const view = st.branches.find((v) => v.branch.id === state.currentBranchId);
  if (view === undefined || view.origin === null) {
    banner.hidden = true;
    return;
  }
  banner.replaceChildren();
  const label = document.createElement("span");
  label.textContent = `Branched from ${branchLabel(view.origin.sourceBranchId)} — anchored selection: `;
  const sel = document.createElement("span");
  sel.className = "sel";
  sel.textContent = `“${view.origin.selection.text}”`;
  banner.append(label, sel);
  banner.hidden = false;
}

function selectionOffsetsWithin(element, text) {
  const selection = window.getSelection();
  if (selection === null || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.commonAncestorContainer)) return null;
  const selected = range.toString();
  if (selected.length === 0) return null;
  const before = range.cloneRange();
  before.selectNodeContents(element);
  before.setEnd(range.startContainer, range.startOffset);
  const start = before.toString().length;
  if (text.slice(start, start + selected.length) !== selected) return null;
  return { start, end: start + selected.length, text: selected };
}

function renderConversation() {
  const st = state.treeState;
  const container = $("conversation");
  container.replaceChildren();
  const view = st.branches.find((v) => v.branch.id === state.currentBranchId);
  if (view === undefined) return;

  if (view.turns.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent =
      view.branch.id === st.trunkBranchId
        ? "Empty Trunk — send the first prompt."
        : "Empty branch — continue it with a prompt.";
    container.append(empty);
  }

  for (const turn of view.turns) {
    const div = document.createElement("div");
    div.className = `turn ${turn.role}`;
    div.dataset.turnId = turn.id;
    div.dataset.turnText = turn.text;

    if (turn.role === "return") {
      const meta = document.createElement("span");
      meta.className = "meta";
      const from = branchLabel(turn.fromBranchId ?? "");
      const delivered =
        turn.deliveredRunId !== null
          ? ` · <span class="delivered">delivered into Trunk context</span>`
          : ` · not yet delivered (delivered on the next Trunk prompt)`;
      meta.innerHTML = `↩ Return from ${from}${delivered}`;
      div.append(meta, document.createTextNode(turn.text));
      container.append(div);
      continue;
    }

    div.textContent = turn.text;

    if (turn.role === "assistant") {
      const hint = document.createElement("span");
      hint.className = "selection-hint";
      hint.textContent = "(select text above to anchor the branch)";
      const branchButton = document.createElement("button");
      branchButton.className = "branch-here";
      branchButton.textContent = "⑃ Branch from here";
      branchButton.addEventListener("click", () =>
        guard(() => branchFromTurn(div, turn)),
      );
      div.append(document.createElement("br"), branchButton, hint);
      div.addEventListener("mouseup", () => {
        const sel = selectionOffsetsWithin(div, turn.text);
        div.classList.toggle("has-selection", sel !== null);
        branchButton.textContent =
          sel !== null ? "⑃ Branch from selection" : "⑃ Branch from here";
      });
    }
    container.append(div);
  }
  container.scrollTop = container.scrollHeight;
}

function renderAll() {
  const hasTree = state.treeState !== null;
  $("empty-state").hidden = hasTree;
  $("tree-view").hidden = !hasTree;
  if (hasTree) {
    renderBranchTabs();
    renderOriginBanner();
    renderConversation();
    renderReturnPanel();
  }
  renderTrees();
}

function renderReturnPanel() {
  const st = state.treeState;
  const isBranch = state.currentBranchId !== null && state.currentBranchId !== st.trunkBranchId;
  $("return-panel").hidden = !isBranch;
  if (!isBranch) return;
  const view = st.branches.find((v) => v.branch.id === state.currentBranchId);
  const lastAnswer = [...(view ? view.turns : [])].reverse().find((t) => t.role === "assistant");
  const input = $("return-input");
  if (input.value.trim() === "" && lastAnswer !== undefined) {
    input.value = lastAnswer.text;
  }
}

/* ------------------------------ 动作 ------------------------------ */

async function refreshTrees() {
  const payload = await api("/api/trees");
  state.trees = payload.trees;
  renderTrees();
}

async function openTree(treeId) {
  const treeState = await api(`/api/trees/${encodeURIComponent(treeId)}/state`);
  state.currentTreeId = treeId;
  state.treeState = treeState;
  state.currentBranchId = treeState.cursor !== null ? treeState.cursor.branchId : treeState.trunkBranchId;
  await refreshTrees();
  renderAll();
}

async function createTree() {
  const payload = await api("/api/trees", "POST", {});
  state.currentTreeId = payload.tree.id;
  state.treeState = payload.state;
  state.currentBranchId = payload.trunkBranchId;
  await refreshTrees();
  renderAll();
}

async function switchBranch(branchId) {
  const payload = await api(`/api/trees/${encodeURIComponent(state.currentTreeId)}/switch`, "POST", {
    branchId,
  });
  state.treeState = payload.state;
  state.currentBranchId = branchId;
  renderAll();
}

async function sendPrompt() {
  const input = $("prompt-input");
  const text = input.value;
  if (text.trim() === "") return;
  const payload = await api(`/api/trees/${encodeURIComponent(state.currentTreeId)}/prompt`, "POST", {
    branchId: state.currentBranchId,
    text,
  });
  state.treeState = payload.state;
  input.value = "";
  renderAll();
}

async function branchFromTurn(turnElement, turn) {
  const selection =
    selectionOffsetsWithin(turnElement, turn.text) ??
    { start: 0, end: turn.text.length, text: turn.text };
  const payload = await api(
    `/api/trees/${encodeURIComponent(state.currentTreeId)}/branches`,
    "POST",
    {
      sourceBranchId: state.currentBranchId,
      anchorTurnId: turn.id,
      selection,
    },
  );
  state.treeState = payload.state;
  state.currentBranchId = payload.branch.id;
  $("return-input").value = "";
  renderAll();
}

async function submitReturn() {
  const input = $("return-input");
  const text = input.value;
  if (text.trim() === "") return;
  const payload = await api(`/api/trees/${encodeURIComponent(state.currentTreeId)}/return`, "POST", {
    fromBranchId: state.currentBranchId,
    text,
  });
  state.treeState = payload.state;
  state.currentBranchId = payload.state.trunkBranchId;
  input.value = "";
  renderAll();
}

/* ------------------------------ 启动 ------------------------------ */

$("new-tree").addEventListener("click", () => guard(createTree));
$("send").addEventListener("click", () => guard(sendPrompt));
$("prompt-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    guard(sendPrompt);
  }
});
$("submit-return").addEventListener("click", () => guard(submitReturn));

void (async () => {
  try {
    await refreshTrees();
    if (state.trees.length > 0) {
      await openTree(state.trees[0].id);
    } else {
      renderAll();
    }
  } catch (err) {
    showError(String(err && err.message ? err.message : err));
  }
})();
