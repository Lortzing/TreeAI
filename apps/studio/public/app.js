/* TreeAI Studio — D3 Core MVP 前端（vanilla JS，无构建步骤）。
 *
 * 范围（诚实声明）：无 Markdown 渲染、无自动摘要。核心交互：
 *  - 创建/打开 Tree；
 *  - Trunk/Branch 对话展示（P1：prompt 在途时经 SSE 流式占位回显
 *    message-delta；run-terminal 后以 /state 整树刷新——/state 是权威
 *    读模型，流式回显是瞬态展示）；
 *  - 在 assistant 答案内选中文本 → “Branch from here”（无选区 = 整条答案）；
 *  - 分支续聊；切回 Trunk；
 *  - 编辑并显式提交 Return 到 Trunk；
 *  - 诊断/状态条：当前 run 状态、失败码与消息（失败面板不自动消失）、
 *    在途时 Abort、“未观测策略决策”的如实呈现（Studio 无工具执行器
 *    ——绝不声称未接入的策略执行）；
 *  - 来源抽屉（P1）：per-run 出处、Return 出处与 journal 尾部的保守
 *    摘要（工具活动如实空态——Studio 离线以空工具 allowlist 运行）；
 *  - 缺失 session 降级（A4）：分支徽标 + 可关闭横幅（树保持可读、续聊
 *    fail-closed、可执行的恢复方式），session-corrupt 失败时同样提示。
 *
 * 事件流：EventSource 订阅 /api/trees/:id/events（snapshot 后推送
 * run-started / message-delta / abort-requested / run-terminal /
 * tool-activity）。SSE 不可用时降级为 prompt 在途时轮询诊断面（既有
 * 行为）；/diagnostics 仍用于初始加载。
 */

"use strict";

/** @typedef {{id:string, createdAt:string, forestId:string}} TreeT */
/** @typedef {{id:string, treeId:string, parentBranchId:string|null, createdAt:string}} BranchT */
/** @typedef {{branchId:string, sourceBranchId:string, anchorTurnId:string, anchorEntryId:string, selection:{start:number,end:number,text:string}, createdAt:string}} OriginT */
/** @typedef {{sourceBranchId:string, anchorTurnId:string, anchorEntryId:string, selection:{start:number,end:number,text:string}}} ReturnTargetAnchorT */
/** @typedef {{id:string, treeId:string, branchId:string, episodeId:string, runId:string|null, role:"user"|"assistant"|"return", text:string, piEntryId:string|null, fromBranchId:string|null, deliveredRunId:string|null, idempotencyKey:string|null, targetAnchor:ReturnTargetAnchorT|null, createdAt:string}} TurnT */
/** @typedef {{branch:BranchT, origin:OriginT|null, originStatus:"available"|"changed"|"unavailable"|null, sessionAvailability:"available"|"unavailable"|null, turns:TurnT[]}} BranchViewT */
/** @typedef {{tree:TreeT, trunkBranchId:string|null, branches:BranchViewT[], cursor:{treeId:string,branchId:string,entryId:string}|null}} TreeStateT */
/** @typedef {{runId:string, branchId:string, episodeId:string, state:string, failure:{code:string,message:string}|null, createdAt:string, terminalAt:string|null}} RunDiagnosticsT */
/** @typedef {{treeId:string, runtimeState:"idle"|"streaming"|"aborting", activeRun:{runId:string,branchId:string,episodeId:string}|null, runs:RunDiagnosticsT[], policyDecisions:{observed:boolean, reason:string}}} TreeDiagnosticsT */
/** @typedef {{branchId:string, idempotencyKey:string, text:string, failed:boolean}} ReturnDraftT */
/** @typedef {{eventId:string, runId:string, seq:number, occurredAt:string, type:string, summary:string}} JournalEventT */
/** @typedef {{runId:string, branchId:string, episodeId:string}} ActiveRunInfoT */
/** @typedef {{runId:string, branchId:string, text:string}} StreamingT */

const state = {
  /** @type {TreeT[]} */ trees: [],
  /** @type {string|null} */ currentTreeId: null,
  /** @type {string|null} */ currentBranchId: null,
  /** @type {TreeStateT|null} */ treeState: null,
  /** @type {TreeDiagnosticsT|null} */ diagnostics: null,
  /** @type {{turnId:string,start:number,end:number}|null} */ sourceHighlight: null,
  /**
   * Return 草稿（draft 态，未持久化）：幂等键标识一次逻辑提交，跨失败
   * 重试保持稳定；失败后编辑文本即视为新的逻辑提交（重新生成键——旧键
   * 可能已被服务端绑定到旧文本）。随分支切换重置。
   * @type {ReturnDraftT|null}
   */
  returnDraft: null,
  busy: false,
  /** 在途 run 定位（SSE run-started；run-terminal 清空）。 */
  activeRunInfo: null,
  /** 流式占位回显（瞬态；run-terminal 后由 /state 权威刷新取代）。 */
  streaming: null,
  /** 失败面板已关闭的 run（dismiss 后不再复显；新失败重新出现）。 */
  dismissedFailureRunIds: new Set(),
  /** session-corrupt 失败后强制显示可执行恢复横幅（下一次成功 prompt 清除）。 */
  forceSessionBanner: false,
  /** 来源抽屉。 */
  drawerOpen: false,
  /** @type {JournalEventT[]|null} */ journalEvents: null,
  /** 最近工具活动（真实 Pi 驱动才会有；离线如实为空）。 */
  toolActivity: [],
};

/** Diagnostics poll timer — fallback while a prompt is active and SSE is down. */
let diagnosticsTimer = null;
const DIAGNOSTICS_POLL_MS = 500;

/** SSE connection for the open tree (null when disconnected). */
let eventSource = null;
let sseHealthy = false;

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
    const error = new Error(message);
    if (payload && payload.error && typeof payload.error.code === "string") {
      error.code = payload.error.code;
    }
    throw error;
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
    const label = document.createElement("span");
    label.textContent = branchLabel(view.branch.id);
    button.append(label);
    if (view.origin !== null) {
      const anchorStatus = view.originStatus ?? "unavailable";
      button.title = `branched from ${branchLabel(view.origin.sourceBranchId)} · “${view.origin.selection.text}” · source ${anchorStatus}`;
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.textContent = " °";
      button.append(dot);
    }
    /* A4 缺失 session：分支徽标（续聊将 fail-closed；详情见横幅）。 */
    if (view.sessionAvailability === "unavailable") {
      const badge = document.createElement("span");
      badge.className = "session-badge";
      badge.textContent = "· session missing";
      badge.title = "the session file for this branch's continuation point is missing; the tree stays readable but continuing here will fail";
      button.append(badge);
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
  const status = document.createElement("span");
  status.className = `origin-status ${view.originStatus ?? "unavailable"}`;
  status.textContent = ` · source ${view.originStatus ?? "unavailable"}`;
  const sourceButton = document.createElement("button");
  sourceButton.className = "source-button";
  sourceButton.textContent = "View source";
  sourceButton.addEventListener("click", () => guard(() => revealOrigin(view.branch.id)));
  banner.append(label, sel, status, sourceButton);
  banner.hidden = false;
}

/**
 * A4 缺失 session 横幅（可关闭、不自动消失）：树保持完全可读（数据库
 * 是事实源），该分支续聊将 fail-closed；可执行恢复方式 = 从 session 仍
 * 可用的 turn 建新分支 / 新建 Tree。session-corrupt 的 prompt 失败同样
 * 强制显示（forceSessionBanner，下一次成功 prompt 清除）。
 */
function renderSessionBanner() {
  const banner = $("session-banner");
  const st = state.treeState;
  if (st === null) {
    banner.hidden = true;
    return;
  }
  const view = st.branches.find((v) => v.branch.id === state.currentBranchId);
  const unavailable = view !== undefined && view.sessionAvailability === "unavailable";
  if (!unavailable && !state.forceSessionBanner) {
    banner.hidden = true;
    return;
  }
  banner.replaceChildren();
  const text = document.createElement("span");
  text.className = "session-banner-text";
  text.textContent =
    "Session missing on this branch — the tree stays fully readable (the database is the source of truth), " +
    "but continuing here will fail. Recovery: start a fresh Tree, or branch from a turn whose session is still available.";
  const dismiss = document.createElement("button");
  dismiss.className = "session-banner-dismiss";
  dismiss.textContent = "Dismiss";
  dismiss.addEventListener("click", () => {
    banner.hidden = true;
  });
  banner.append(text, dismiss);
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

/**
 * Return 卡片：锚点答案在当前视图内 → 紧随其后渲染（meta 含选区摘录，
 * 满足“原分叉点附近”）；锚点缺失（历史 Return 或锚点在其他分支）→
 * 由调用方按时间顺序原位渲染并降级标注。delivered 时 deliveredRunId
 * 呈现在文本与 title 中，便于在诊断面反查该 Run。
 */
function returnCard(turn, anchor) {
  const div = document.createElement("div");
  div.className = "turn return";
  div.dataset.turnId = turn.id;
  div.dataset.turnText = turn.text;

  const meta = document.createElement("span");
  meta.className = "meta";
  const from = branchLabel(turn.fromBranchId ?? "");
  const anchorNote =
    anchor !== null
      ? ` · anchored on “${anchor.selection.text}” from ${branchLabel(anchor.sourceBranchId)}`
      : " · original anchor unavailable";
  meta.append(document.createTextNode(`↩ Return from ${from}${anchorNote}`));
  const delivery = document.createElement("span");
  if (turn.deliveredRunId !== null) {
    delivery.className = "delivered";
    delivery.textContent = ` · delivered into Trunk context (run ${turn.deliveredRunId})`;
  } else {
    delivery.textContent = " · not yet delivered (delivered on the next Trunk prompt)";
  }
  meta.append(delivery);
  if (turn.deliveredRunId !== null) {
    div.title = `delivered into Trunk run ${turn.deliveredRunId}`;
  }
  div.append(meta, document.createTextNode(turn.text));
  return div;
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

  /* Return 按目标锚点定位：targetAnchor.anchorTurnId 命中当前视图内的
     assistant turn → 该锚点之后渲染；锚点不在当前视图（历史 Return 或
     锚点位于其他分支）→ 按时间顺序原位渲染并降级标注。 */
  const turnIds = new Set(view.turns.map((turn) => turn.id));
  const anchoredReturns = new Map();
  for (const turn of view.turns) {
    if (turn.role !== "return" || turn.targetAnchor === null) continue;
    if (!turnIds.has(turn.targetAnchor.anchorTurnId)) continue;
    const list = anchoredReturns.get(turn.targetAnchor.anchorTurnId) ?? [];
    list.push(turn);
    anchoredReturns.set(turn.targetAnchor.anchorTurnId, list);
  }
  const isAnchored = (turn) =>
    turn.role === "return" &&
    turn.targetAnchor !== null &&
    (anchoredReturns.get(turn.targetAnchor.anchorTurnId) ?? []).includes(turn);

  for (const turn of view.turns) {
    if (turn.role === "return") {
      if (isAnchored(turn)) continue; /* 已随锚点答案渲染 */
      container.append(returnCard(turn, null)); /* 降级：锚点不在当前视图 */
      continue;
    }

    const div = document.createElement("div");
    div.className = `turn ${turn.role}`;
    div.dataset.turnId = turn.id;
    div.dataset.turnText = turn.text;

    const highlight = state.sourceHighlight;
    if (
      turn.role === "assistant" &&
      highlight !== null &&
      highlight.turnId === turn.id &&
      highlight.start >= 0 &&
      highlight.end > highlight.start &&
      highlight.end <= turn.text.length
    ) {
      const marked = document.createElement("mark");
      marked.className = "source-highlight";
      marked.textContent = turn.text.slice(highlight.start, highlight.end);
      div.append(
        document.createTextNode(turn.text.slice(0, highlight.start)),
        marked,
        document.createTextNode(turn.text.slice(highlight.end)),
      );
    } else {
      div.textContent = turn.text;
    }

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

    if (turn.role === "assistant") {
      for (const returnTurn of anchoredReturns.get(turn.id) ?? []) {
        container.append(returnCard(returnTurn, returnTurn.targetAnchor));
      }
    }
  }

  /* P1 流式占位回显：在途 run 位于当前分支时追加瞬态占位 turn
     （run-terminal 后由 /state 权威刷新取代；跨分支的在途 run 不显示）。 */
  const streaming = state.streaming;
  if (streaming !== null && streaming.branchId === state.currentBranchId) {
    const placeholder = document.createElement("div");
    placeholder.id = "streaming-turn";
    placeholder.className = "turn assistant streaming-turn";
    placeholder.textContent = streaming.text;
    const caret = document.createElement("span");
    caret.className = "streaming-caret";
    caret.textContent = " ▍";
    placeholder.append(caret);
    container.append(placeholder);
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
    renderSessionBanner();
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
  /* 草稿随“面板在当前分支打开”开始；同一分支上跨渲染保持（失败重试
     复用同一键）。切换到其他分支 = 新的逻辑提交上下文 → 重置。 */
  if (state.returnDraft === null || state.returnDraft.branchId !== state.currentBranchId) {
    state.returnDraft = {
      branchId: state.currentBranchId,
      idempotencyKey: crypto.randomUUID(),
      text: input.value,
      failed: false,
    };
  }
}

/** 提交前兜底：草稿不存在（面板未经渲染等边角）时以当前输入开一份。 */
function ensureReturnDraft() {
  if (state.returnDraft === null) {
    state.returnDraft = {
      branchId: state.currentBranchId,
      idempotencyKey: crypto.randomUUID(),
      text: $("return-input").value,
      failed: false,
    };
  }
  return state.returnDraft;
}

function clearReturnDraft() {
  state.returnDraft = null;
}

/* 失败后编辑 = 新的逻辑提交：旧键可能已被服务端绑定到旧文本（同键异容
   会被 409 拒绝），故文本一变即换新键；未失败的编辑仍属同一草稿。 */
$("return-input").addEventListener("input", () => {
  const draft = state.returnDraft;
  if (draft === null) return;
  const value = $("return-input").value;
  if (draft.failed && value !== draft.text) {
    draft.idempotencyKey = crypto.randomUUID();
    draft.failed = false;
  }
  draft.text = value;
});

/* ------------------------------ 诊断面 ------------------------------ */

function renderDiagnostics() {
  const diag = state.diagnostics;
  const bar = $("diagnostics-bar");
  if (diag === null || state.treeState === null) {
    bar.hidden = true;
    renderFailurePanel(null);
    return;
  }
  bar.hidden = false;

  const status = $("run-status");
  status.textContent = diag.runtimeState;
  status.className = `run-status ${diag.runtimeState}`;

  const parts = [];
  if (diag.activeRun !== null) {
    parts.push(`active run on ${branchLabel(diag.activeRun.branchId)}`);
  }
  const last = diag.runs.length > 0 ? diag.runs[diag.runs.length - 1] : null;
  const detail = $("run-detail");
  detail.replaceChildren();
  if (parts.length > 0) {
    detail.append(document.createTextNode(`${parts.join(" · ")} · `));
  }
  if (last === null) {
    detail.append(document.createTextNode("no runs yet"));
  } else {
    /* 终态呈现可区分：aborted 单独着色（中止是显式用户动作，非失败）。 */
    const stateSpan = document.createElement("span");
    stateSpan.className = `last-run-state ${last.state}`;
    stateSpan.textContent = `last run: ${last.state}`;
    detail.append(stateSpan);
  }

  /* P1 失败面板（持久、不自动消失）：最新失败 run 的 code+消息+定位，
     可手动关闭；dismiss 后该 run 不再复显（新失败会再次出现）。 */
  const lastFailed = [...diag.runs].reverse().find((run) => run.failure !== null) ?? null;
  renderFailurePanel(lastFailed);

  const abortButton = $("abort-run");
  const isActive = diag.activeRun !== null;
  abortButton.hidden = !isActive;
  abortButton.textContent = diag.runtimeState === "aborting" ? "Aborting…" : "Abort run";
  abortButton.disabled = diag.runtimeState === "aborting";

  /* 如实呈现：无工具执行器 → 未观测任何策略决策（不声称未接入的执行）。 */
  $("policy-note").textContent =
    diag.policyDecisions.observed === false
      ? `policy: no decisions observed — ${diag.policyDecisions.reason}`
      : "policy: decisions observed";
}

/** 失败面板渲染（P1）。run 为 null 或已被 dismiss → 隐藏。 */
function renderFailurePanel(run) {
  const panel = $("failure-panel");
  if (run === null || run.failure === null || state.dismissedFailureRunIds.has(run.runId)) {
    panel.hidden = true;
    return;
  }
  panel.replaceChildren();
  const label = document.createElement("span");
  label.className = "failure-panel-label";
  label.textContent = `Run ${run.runId.slice(0, 12)}… failed — ${run.failure.code}: ${run.failure.message}`;
  const dismiss = document.createElement("button");
  dismiss.className = "failure-panel-dismiss";
  dismiss.textContent = "Dismiss";
  dismiss.addEventListener("click", () => {
    state.dismissedFailureRunIds.add(run.runId);
    renderFailurePanel(run);
  });
  panel.append(label, dismiss);
  panel.hidden = false;
}

async function refreshDiagnostics() {
  if (state.currentTreeId === null) {
    state.diagnostics = null;
    renderDiagnostics();
    return;
  }
  const diagnostics = await api(`/api/trees/${encodeURIComponent(state.currentTreeId)}/diagnostics`);
  if (state.currentTreeId !== diagnostics.treeId) return; /* stale after a tree switch */
  state.diagnostics = diagnostics;
  renderDiagnostics();
}

function startDiagnosticsPolling() {
  if (diagnosticsTimer !== null) return;
  diagnosticsTimer = window.setInterval(() => {
    void refreshDiagnostics().catch(() => {
      /* 轮询失败不打断在途 prompt；收尾刷新会呈现最终状态 */
    });
  }, DIAGNOSTICS_POLL_MS);
}

function stopDiagnosticsPolling() {
  if (diagnosticsTimer === null) return;
  window.clearInterval(diagnosticsTimer);
  diagnosticsTimer = null;
}

/* ------------------------------ SSE 事件流（P1） ------------------------------ */

function disconnectEvents() {
  if (eventSource !== null) {
    eventSource.close();
    eventSource = null;
  }
  sseHealthy = false;
}

/**
 * 订阅当前树的事件流。连接即收到 snapshot（诊断面）；随后按事件类型
 * 推送。SSE 出错时降级为轮询（EventSource 会自动重连，重连成功即恢复
 * 事件流并停止轮询）。
 */
function connectEvents(treeId) {
  disconnectEvents();
  if (typeof EventSource === "undefined") return; /* 降级：轮询兜底 */
  const source = new EventSource(`/api/trees/${encodeURIComponent(treeId)}/events`);
  eventSource = source;
  source.onopen = () => {
    sseHealthy = true;
    stopDiagnosticsPolling();
  };
  source.onerror = () => {
    /* 断开/重连中：降级轮询；重连后 onopen 恢复。 */
    sseHealthy = false;
    if (state.currentTreeId === treeId) startDiagnosticsPolling();
  };
  const isCurrent = () => state.currentTreeId === treeId;
  source.addEventListener("snapshot", (event) => {
    if (!isCurrent()) return;
    const diag = JSON.parse(event.data);
    if (diag.treeId !== state.currentTreeId) return;
    state.diagnostics = diag;
    renderDiagnostics();
  });
  source.addEventListener("run-started", (event) => {
    if (!isCurrent()) return;
    const info = JSON.parse(event.data);
    state.activeRunInfo = info;
    if (state.diagnostics !== null) {
      state.diagnostics.runtimeState = "streaming";
      state.diagnostics.activeRun = {
        runId: info.runId,
        branchId: info.branchId,
        episodeId: info.episodeId,
      };
    }
    if (info.branchId === state.currentBranchId) {
      state.streaming = { runId: info.runId, branchId: info.branchId, text: "" };
      renderConversation();
    }
    renderDiagnostics();
  });
  source.addEventListener("message-delta", (event) => {
    if (!isCurrent()) return;
    const delta = JSON.parse(event.data);
    const active = state.activeRunInfo;
    if (active === null || delta.runId !== active.runId) return;
    if (active.branchId !== state.currentBranchId) return; /* 在途 run 不在当前视图 */
    if (state.streaming === null || state.streaming.runId !== delta.runId) {
      state.streaming = { runId: delta.runId, branchId: active.branchId, text: "" };
    }
    state.streaming.text += delta.delta;
    updateStreamingPlaceholder();
  });
  source.addEventListener("abort-requested", (event) => {
    if (!isCurrent()) return;
    const payload = JSON.parse(event.data);
    if (state.diagnostics !== null && state.activeRunInfo !== null && payload.runId === state.activeRunInfo.runId) {
      state.diagnostics.runtimeState = "aborting";
    }
    renderDiagnostics();
  });
  source.addEventListener("run-terminal", (event) => {
    if (!isCurrent()) return;
    const terminal = JSON.parse(event.data);
    state.activeRunInfo = null;
    state.streaming = null;
    /* /state 是权威读模型：终态后整树刷新（prompt 响应也会刷新，幂等）。 */
    void (async () => {
      try {
        state.treeState = await api(`/api/trees/${encodeURIComponent(state.currentTreeId)}/state`);
        renderAll();
      } catch {
        /* 刷新失败不打断；sendPrompt 的收尾刷新会重试 */
      }
      await refreshDiagnostics().catch(() => {});
    })();
  });
  source.addEventListener("tool-activity", (event) => {
    if (!isCurrent()) return;
    const activity = JSON.parse(event.data);
    state.toolActivity = [...state.toolActivity.slice(-19), activity];
    if (state.drawerOpen) renderDrawer();
  });
}

/** 流式占位回显：增量到达时只更新占位节点（不整树重渲）。 */
function updateStreamingPlaceholder() {
  const streaming = state.streaming;
  if (streaming === null) return;
  let node = document.getElementById("streaming-turn");
  if (node === null) {
    renderConversation();
    return;
  }
  node.textContent = streaming.text;
  const container = $("conversation");
  container.scrollTop = container.scrollHeight;
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
  state.sourceHighlight = null;
  state.activeRunInfo = null;
  state.streaming = null;
  await refreshTrees();
  await refreshDiagnostics();
  connectEvents(treeId);
  renderAll();
}

async function createTree() {
  const payload = await api("/api/trees", "POST", {});
  state.currentTreeId = payload.tree.id;
  state.treeState = payload.state;
  state.currentBranchId = payload.trunkBranchId;
  state.sourceHighlight = null;
  state.activeRunInfo = null;
  state.streaming = null;
  await refreshTrees();
  await refreshDiagnostics();
  connectEvents(payload.tree.id);
  renderAll();
}

async function revealOrigin(branchId) {
  const payload = await api(
    `/api/trees/${encodeURIComponent(state.currentTreeId)}/branches/${encodeURIComponent(branchId)}/source`,
    "POST",
  );
  state.sourceHighlight = null;
  if (payload.source.status !== "available") {
    renderAll();
    showError(`Source reference ${payload.source.status}; saved excerpt remains available.`);
    return;
  }
  state.treeState = payload.state;
  state.currentBranchId = payload.source.sourceBranchId;
  state.sourceHighlight = {
    turnId: payload.source.anchorTurnId,
    start: payload.source.selection.start,
    end: payload.source.selection.end,
  };
  renderAll();
  const sourceTurn = [...document.querySelectorAll("[data-turn-id]")].find(
    (element) => element.dataset.turnId === payload.source.anchorTurnId,
  );
  sourceTurn?.scrollIntoView({ block: "center", behavior: "smooth" });
}

async function switchBranch(branchId) {
  const payload = await api(`/api/trees/${encodeURIComponent(state.currentTreeId)}/switch`, "POST", {
    branchId,
  });
  state.treeState = payload.state;
  state.currentBranchId = branchId;
  state.sourceHighlight = null;
  renderAll();
}

async function sendPrompt() {
  const input = $("prompt-input");
  const text = input.value;
  if (text.trim() === "") return;
  /* prompt 在途观测：SSE 健康时由事件流驱动（run-started/message-delta/
     run-terminal）；SSE 不可用/未就绪时降级为轮询诊断面（既有行为）。 */
  if (!sseHealthy) startDiagnosticsPolling();
  try {
    const payload = await api(`/api/trees/${encodeURIComponent(state.currentTreeId)}/prompt`, "POST", {
      branchId: state.currentBranchId,
      text,
    });
    state.treeState = payload.state;
    input.value = "";
    state.forceSessionBanner = false;
  } catch (err) {
    if (err !== null && typeof err === "object" && err.code === "user-abort") {
      /* 用户主动中止：run 已收敛为 aborted（无新 turn）。保留输入文本供改写重发，
         刷新树状态与诊断面后如常呈现。 */
      state.treeState = await api(`/api/trees/${encodeURIComponent(state.currentTreeId)}/state`);
    } else {
      if (err !== null && typeof err === "object" && err.code === "session-corrupt") {
        /* A4：缺失/损坏 session 的可执行恢复提示（不只有瞬时错误横幅）。 */
        state.forceSessionBanner = true;
        state.treeState = await api(`/api/trees/${encodeURIComponent(state.currentTreeId)}/state`);
      }
      throw err;
    }
  } finally {
    stopDiagnosticsPolling();
    state.activeRunInfo = null;
    state.streaming = null;
  }
  renderAll();
  await refreshDiagnostics();
}

/** Abort the active run. Bypasses the busy guard on purpose: the whole point
 *  is to be clickable while a prompt is in flight. */
async function abortActiveRun() {
  const diag = state.diagnostics;
  if (diag === null || diag.activeRun === null || state.currentTreeId === null) return;
  const button = $("abort-run");
  button.disabled = true;
  button.textContent = "Aborting…";
  try {
    await api(
      `/api/trees/${encodeURIComponent(state.currentTreeId)}/runs/${encodeURIComponent(diag.activeRun.runId)}/abort`,
      "POST",
    );
  } catch (err) {
    showError(String(err && err.message ? err.message : err));
  }
  await refreshDiagnostics();
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

/** 在树状态里按幂等键找已落库的 Return（响应丢失探查）。 */
function findReturnByKey(treeState, idempotencyKey) {
  for (const view of treeState.branches) {
    for (const turn of view.turns) {
      if (turn.role === "return" && turn.idempotencyKey === idempotencyKey) {
        return turn;
      }
    }
  }
  return null;
}

async function submitReturn() {
  const input = $("return-input");
  const text = input.value;
  if (text.trim() === "") return;
  const draft = ensureReturnDraft();
  try {
    const payload = await api(`/api/trees/${encodeURIComponent(state.currentTreeId)}/return`, "POST", {
      fromBranchId: state.currentBranchId,
      text,
      idempotencyKey: draft.idempotencyKey,
    });
    /* 200（同键重放）与 201（新建）同为成功：清空草稿，回到 Trunk。 */
    state.treeState = payload.state;
    state.currentBranchId = payload.state.trunkBranchId;
    clearReturnDraft();
    input.value = "";
  } catch (err) {
    /* 失败先查证（响应丢失：服务端已成功、响应未达客户端）：刷新树状态，
       同键 Return 已落库 → 按成功处理；否则保留草稿与键（输入文本不动），
       刷新后的状态照常呈现，错误交由 guard 呈现——用户可直接重试（同键）
       或改写（改写即换新键）。 */
    const refreshed = await api(`/api/trees/${encodeURIComponent(state.currentTreeId)}/state`);
    if (findReturnByKey(refreshed, draft.idempotencyKey) !== null) {
      state.treeState = refreshed;
      state.currentBranchId = refreshed.trunkBranchId;
      clearReturnDraft();
      input.value = "";
    } else {
      state.treeState = refreshed;
      draft.failed = true;
      renderAll();
      throw err;
    }
  }
  renderAll();
}

/* ------------------------------ 来源抽屉（P1） ------------------------------ */

/** 打开/关闭来源抽屉；打开时拉取 journal 尾部（保守摘要）。 */
async function toggleDrawer() {
  state.drawerOpen = !state.drawerOpen;
  if (state.drawerOpen) {
    state.journalEvents = null;
    renderDrawer();
    try {
      const payload = await api(`/api/trees/${encodeURIComponent(state.currentTreeId)}/journal?limit=20`);
      state.journalEvents = payload.events;
    } catch {
      state.journalEvents = []; /* 诚实空态：拉取失败也如实呈现为空 */
    }
    renderDrawer();
  } else {
    renderDrawer();
  }
}

/**
 * 来源抽屉：per-run 出处（分支/定位/状态/失败码/时间戳）、Return 出处
 * （from-branch/锚点摘录/送达 run）、journal 尾部（保守摘要）与工具活动
 * （离线如实空态——Studio 以空工具 allowlist 运行，无工具事件）。
 */
function renderDrawer() {
  const drawer = $("source-drawer");
  const toggle = $("source-drawer-toggle");
  drawer.hidden = !state.drawerOpen;
  toggle.textContent = state.drawerOpen ? "× Close sources" : "⑂ Sources";
  toggle.setAttribute("aria-expanded", state.drawerOpen ? "true" : "false");
  if (!state.drawerOpen) return;

  drawer.replaceChildren();
  const title = document.createElement("h2");
  title.textContent = "Sources";
  drawer.append(title);

  /* per-run 出处（诊断面安全投影）。 */
  const runsTitle = document.createElement("h3");
  runsTitle.textContent = "Runs";
  drawer.append(runsTitle);
  const diag = state.diagnostics;
  if (diag === null || diag.runs.length === 0) {
    drawer.append(mutedLine("no runs recorded for this tree yet"));
  } else {
    const list = document.createElement("ul");
    list.className = "drawer-list";
    for (const run of diag.runs) {
      const li = document.createElement("li");
      const failureNote = run.failure === null ? "" : ` · failure ${run.failure.code}`;
      const time =
        run.terminalAt === null
          ? `started ${new Date(run.createdAt).toLocaleTimeString()}`
          : `${new Date(run.createdAt).toLocaleTimeString()} → ${new Date(run.terminalAt).toLocaleTimeString()}`;
      li.textContent =
        `${branchLabel(run.branchId)} · run ${run.runId.slice(0, 12)}… · ${run.state}${failureNote} · ${time}`;
      list.append(li);
    }
    drawer.append(list);
  }

  /* Return 出处。 */
  const returnsTitle = document.createElement("h3");
  returnsTitle.textContent = "Returns";
  drawer.append(returnsTitle);
  const st = state.treeState;
  const returns = st === null ? [] : st.branches.flatMap((view) => view.turns.filter((t) => t.role === "return"));
  if (returns.length === 0) {
    drawer.append(mutedLine("no returns submitted for this tree yet"));
  } else {
    const list = document.createElement("ul");
    list.className = "drawer-list";
    for (const turn of returns) {
      const li = document.createElement("li");
      const anchor = turn.targetAnchor;
      const anchorNote =
        anchor === null
          ? "original anchor unavailable"
          : `anchored on “${anchor.selection.text}” from ${branchLabel(anchor.sourceBranchId)}`;
      const delivery =
        turn.deliveredRunId === null
          ? "not yet delivered"
          : `delivered into run ${turn.deliveredRunId.slice(0, 12)}…`;
      li.textContent = `from ${branchLabel(turn.fromBranchId ?? "")} · ${anchorNote} · ${delivery}`;
      list.append(li);
    }
    drawer.append(list);
  }

  /* journal 尾部（保守摘要；最新在后）。 */
  const journalTitle = document.createElement("h3");
  journalTitle.textContent = "Journal (latest 20)";
  drawer.append(journalTitle);
  if (state.journalEvents === null) {
    drawer.append(mutedLine("loading journal…"));
  } else if (state.journalEvents.length === 0) {
    drawer.append(mutedLine("no journal events recorded for this tree yet"));
  } else {
    const list = document.createElement("ul");
    list.className = "drawer-list journal-list";
    for (const event of state.journalEvents) {
      const li = document.createElement("li");
      const time = document.createElement("span");
      time.className = "muted";
      time.textContent = `${new Date(event.occurredAt).toLocaleTimeString()} `;
      li.append(time, document.createTextNode(`${event.type} — ${event.summary}`));
      list.append(li);
    }
    drawer.append(list);
  }

  /* 工具活动（诚实边界：离线驱动无工具事件）。 */
  const toolTitle = document.createElement("h3");
  toolTitle.textContent = "Tool activity";
  drawer.append(toolTitle);
  if (state.toolActivity.length === 0) {
    drawer.append(mutedLine("no tool activity observed — Studio runs with an empty tool allowlist"));
  } else {
    const list = document.createElement("ul");
    list.className = "drawer-list";
    for (const activity of state.toolActivity) {
      const li = document.createElement("li");
      li.textContent = `run ${activity.runId.slice(0, 12)}… · ${activity.tool ?? "unknown tool"} ${activity.phase}`;
      list.append(li);
    }
    drawer.append(list);
  }
}

function mutedLine(text) {
  const p = document.createElement("p");
  p.className = "muted";
  p.textContent = text;
  return p;
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
$("abort-run").addEventListener("click", () => void abortActiveRun());
$("source-drawer-toggle").addEventListener("click", () => void toggleDrawer());

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
