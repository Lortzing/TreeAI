/** Reconciled conversation/Return ordering, source anchor context, selection-preserving DOM reuse and reading position. Instance-owned state and dependencies. */
import { findReusableTurnElement } from "../dom.js";

export function createConversationView(deps) {


  const turnElements = new Map();


  /** 流式占位（M5 静态指示——caret 不闪烁；id/类名词法锁定）。 */
  function streamingPlaceholder(text) {
    const placeholder = deps.document.createElement("div");
    placeholder.id = "streaming-turn";
    placeholder.className = "turn assistant streaming-turn";
    placeholder.append(deps.document.createTextNode(text));
    const caret = deps.document.createElement("span");
    caret.className = "streaming-caret";
    caret.textContent = " ▍ streaming…";
    placeholder.append(caret);
    return placeholder;
  }


  /** 取得 turn 的渲染元素（③：优先复用——同 turnId 且同文本）。复用时只
      更新动作层与区间覆盖（覆盖签名未变则正文文本节点原样保留）；新建时
      挂接选区监听并初始化两层。 */
  function ensureTurnElement(container, turn, branchId) {
    const existing = findReusableTurnElement(container, turn);
    if (existing !== null) {
      turnElements.set(turn.id, existing);
      if (turn.role === "assistant") {
        deps.assistantTurns.set(turn.id, { element: existing, turn, branchId });
        updateAssistantTurnLayer(existing, turn, branchId);
      }
      return existing;
    }
    const div = deps.document.createElement("div");
    div.className = `turn ${turn.role}`;
    div.dataset.turnId = turn.id;
    div.dataset.turnText = turn.text;
    turnElements.set(turn.id, div);
    if (turn.role === "assistant") {
      deps.assistantTurns.set(turn.id, { element: div, turn, branchId });
      deps.attachTurnSelectionListeners(div, turn, branchId);
      updateAssistantTurnLayer(div, turn, branchId);
    } else {
      div.textContent = turn.text;
    }
    return div;
  }


  /** assistant turn 的分层更新：区间覆盖（签名未变不动正文）+ 动作层重建。 */
  function updateAssistantTurnLayer(element, turn, branchId) {
    const overlays = deps.turnOverlaysFor(branchId, turn);
    const signature = overlays
      .map((overlay) => `${overlay.kind}:${String(overlay.start)}-${String(overlay.end)}${overlay.pulse ? ":pulse" : ""}`)
      .join("|");
    if (element.dataset.appliedOverlays !== signature) {
      deps.applyTurnOverlays(element, turn, overlays);
      element.dataset.appliedOverlays = signature;
    }
    deps.renderTurnActions(element, turn, branchId);
  }


  /**
   * 顶层子节点的按位调和（③ 正文/操作分层的核心）：期望序列与现序列逐位
   * 对齐——完全一致时**零 DOM 变更**（异步刷新——SSE 终态/轮询——对未变化
   * 的结构不触碰任何节点，武装选区下的正文层身份与文本节点原样保留，
   * issue #7 ③「选择期间不重绘」）；有差异时只动差异位（insertBefore 定点
   * 插入/移除，不改无关兄弟节点的位置）。turn 元素是复用的稳定层；卡片
   * （Return / 解释卡 / 流式占位 / 空态）每次重建为新鲜节点。
   */
  function reconcileTopLevel(container, desired) {
    const current = [...container.children];
    if (current.length === desired.length && current.every((node, index) => node === desired[index])) {
      return; /* 零变更快路径 */
    }
    const keep = new Set(desired);
    /* 先就位、后移除（顺序整改）：新节点先插入到目标位，再摘除非保留的
       旧节点——移除窗口内新旧并存，内容高度不会瞬时塌缩。原先「先移除后
       插入」在替换瞬态卡（解释卡 / Return 卡——每次重渲重建的新鲜节点）
       时，内容高度先塌再涨，浏览器把 scrollTop 钳到塌缩高度（实测塌到 0），
       而滚动监听把该钳位值记成分支的阅读位置——此后每次重渲都恢复到错误
       位置（用户阅读位置无声重置到顶部；W2 §4 纪律被瞬态布局破坏——术语
       真实浏览器探针在整序环境下确定性复现，单独跑时布局时序不触发）。
       就位/移除同属一个同步块，无中间绘制；终态与原实现逐位一致。 */
    for (let index = 0; index < desired.length; index += 1) {
      const node = desired[index];
      const at = container.children[index];
      if (at === node) continue;
      if (at === undefined) {
        container.appendChild(node);
      } else {
        container.insertBefore(node, at);
      }
    }
    for (const node of current) {
      if (!keep.has(node)) container.removeChild(node);
    }
    while (container.children.length > desired.length) {
      container.removeChild(container.children[desired.length]);
    }
  }


  /**
   * 共享对话渲染（主线 / 面板；issue #7 C ③ 正文/操作分层）：
   *  - 每个 turn 的正文是自己的层（turn 元素承载前导正文区——纯文本节点 +
   *    统一区间覆盖包裹；动作/覆盖层在尾部 .turn-actions）；正文区
   *    textContent 恒等于 turn 原文，复制行为不变；
   *  - turn 元素按 (turnId, text) 复用（reconcileTopLevel）：不再整容器
   *    replaceChildren——只有状态围绕正文变化的重渲对正文层零触碰；
   *  - Return 按目标锚点定位、锚点高亮（M6 一次性脉冲）、流式占位
   *    （M5 静态指示）语义与既有锁定一致；
   * 滚动策略（W2 §2.2/§4 + issue #3）：接收新内容（stick）只在用户本就
   * 贴底时跟随贴底（平滑；reduced-motion 直接定位）——已向上阅读绝不
   * 强制滚底；其余渲染恢复该分支已记忆的阅读位置；无记录（首次打开）
   * 直接落底（自然的阅读起点，非强制拉动）。
   */
  function renderTurnsInto(container, view, branchId, stick) {
    const page = deps.currentSessionRound(view);
    view = { ...view, turns: page.round ? [...page.round.turns, ...page.round.returns] : page.unattached };
    if (page.round) container.dataset.episodeId = page.round.id;
    else delete container.dataset.episodeId;
    const st = deps.state.treeState;
    /* 贴底判定取重渲前实况（结构变更会改变 scrollHeight）。 */
    const wasAtBottom = deps.isAtBottom(container);

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

    /* 期望的顶层子节点序列：turn 元素（复用层）与卡片（瞬态层）按渲染顺序。 */
    const desired = [];
    if (view.turns.length === 0) {
      const empty = deps.document.createElement("p");
      empty.className = "muted";
      empty.textContent =
        branchId === st.trunkBranchId
          ? "在下方输入你的第一个问题。"
          : "在下方提问，继续探索这条支线。";
      desired.push(empty);
    }
    for (const turn of view.turns) {
      if (turn.role === "return") {
        if (isAnchored(turn)) continue; /* 已随锚点答案渲染 */
        /* 材料 Return（D4-3）：来源分支无 Turn 来源（材料来源）→ 材料来源卡
           （targetAnchor null 是诚实事实——按确认时间放置，原文跳转不伪造
           主线位置）；与 Turn 来源 Return 的降级卡分开呈现。 */
        const fromView = turn.fromBranchId === null ? null : deps.branchView(turn.fromBranchId);
        if (deps.isMaterialBranchView(fromView)) {
          desired.push(deps.materialReturnCard(turn, deps.returnAttemptsFor(view, turn.id)));
          continue;
        }
        /* 降级放置（P1）：锚点不在当前视图——targetAnchor 快照随卡传递，
           区分来源位于其他 Branch / 已变化 / 缺失，摘录照常在卡面可读。 */
        desired.push(deps.returnCard(turn, turn.targetAnchor, deps.returnAttemptsFor(view, turn.id), "fallback"));
        continue;
      }
      desired.push(ensureTurnElement(container, turn, branchId));
      if (turn.role === "assistant") {
        /* 术语建议条（①阅读模式）：渲染在该条答案之后、其 Return 卡之前
           ——建议附着在回答区，正文层（textContent 字节不变）不受影响。 */
        const suggestStrip = deps.termSuggestionStrip(branchId, turn);
        if (suggestStrip !== null) desired.push(suggestStrip);
        for (const returnTurn of anchoredReturns.get(turn.id) ?? []) {
          desired.push(
            deps.returnCard(returnTurn, returnTurn.targetAnchor, deps.returnAttemptsFor(view, returnTurn.id), "anchored"),
          );
        }
        /* 术语解释卡：渲染在对应答案（及其 Return 卡）之后。 */
        if (
          deps.state.termExplain !== null &&
          deps.state.termExplain.branchId === branchId &&
          deps.state.termExplain.turnId === turn.id
        ) {
          const card = deps.termExplainCard();
          if (card !== null) desired.push(card);
        }
      }
    }

    /* P1 流式占位回显：在途 run 位于本视图分支时追加瞬态占位 turn
       （run-terminal 后由 /state 权威刷新取代）。 */
    const streaming = deps.state.streaming;
    if (streaming !== null && streaming.branchId === branchId && (!page.round || page.index === page.rounds.length - 1)) {
      desired.push(streamingPlaceholder(streaming.text));
    }

    /* ③ 草稿/焦点纪律：聚焦目标先于调和移除读取（真实浏览器里旧卡移除即
       失焦），重建后在同 id 新节点上恢复。 */
    const termFocusTargetId = deps.termCardFocusTargetId();
    reconcileTopLevel(container, desired);
    deps.preserveTermCardFocus(termFocusTargetId);

    const saved = deps.state.scrollPositions.get(deps.scrollKey(branchId));
    if ((stick && wasAtBottom) || saved === undefined) {
      /* 贴底跟随——仅当用户本就贴底（或首次打开无阅读位置记录，直接落底
         为自然的阅读起点）；已向上阅读（stick 且 !wasAtBottom 且有记录）
         落入恢复分支，阅读位置不动（issue #3：不得强制滚底）。 */
      container.scrollTo({
        top: container.scrollHeight,
        behavior: saved === undefined ? "auto" : deps.scrollBehavior(),
      });
    } else {
      container.scrollTop = Math.min(saved, container.scrollHeight);
    }
    // Native scroll events arrive later; a same-task refresh must restore the actual position,
    // rather than the previous snapshot that would undo an immediate reduced-motion follow.
    if (container.clientHeight > 0) {
      deps.state.scrollPositions.set(deps.scrollKey(branchId), container.scrollTop);
    }
  }


  /** 主线（Trunk）主阅读面板渲染。 */
  function renderMainConversation(stick) {
    const container = deps.$("conversation");
    const trunk = deps.trunkBranchId();
    const view = deps.branchView(trunk);
    if (view === null) {
      container.replaceChildren();
      const note = deps.document.createElement("p");
      note.className = "muted";
      note.textContent = "No trunk branch in this tree.";
      container.append(note);
      return;
    }
    renderTurnsInto(container, view, trunk, stick);
  }


  /** 面板头部：锚点上下文（摘录 + originStatus 徽标；降级不伪造——摘录始终可读）。 */
  function renderPanelAnchorContext(view) {
    const el = deps.$("panel-anchor-context");
    el.replaceChildren();
    /* 材料 Branch（D4-3）：无 Turn 来源——材料来源上下文（标题/版本/块/摘录）
       从建枝/恢复响应的缓存读取（树态不含材料来源；缺失时如实注明）。 */
    if (deps.isMaterialBranchView(view)) {
      const origin = deps.recallMaterialBranchOrigin(deps.state.currentTreeId, view.branch.id);
      if (origin === null) {
        el.textContent = "Branched from a material selection (source details not cached in this browser)";
        return;
      }
      const selection = origin.selection;
      el.append(
        deps.document.createTextNode(
          `From material “${String(origin.materialTitle)}” — version ${String(selection.versionId)}, anchored selection: `,
        ),
      );
      const sel = deps.document.createElement("span");
      sel.className = "sel";
      sel.textContent = `“${selection.excerpt}”`;
      const statusSpan = deps.document.createElement("span");
      statusSpan.className = "origin-status available";
      statusSpan.textContent = ` · block ${selection.blockId} · material source`;
      el.append(sel, statusSpan);
      return;
    }
    if (view.origin === null) {
      el.textContent = "no anchor recorded for this branch";
      return;
    }
    const status = view.originStatus ?? "unavailable";
    el.append(
      deps.document.createTextNode(`Branched from ${deps.branchLabel(view.origin.sourceBranchId)} — anchored selection: `),
    );
    const sel = deps.document.createElement("span");
    sel.className = "sel";
    sel.textContent = `“${view.origin.selection.text}”`;
    const statusSpan = deps.document.createElement("span");
    statusSpan.className = `origin-status ${status}`;
    statusSpan.textContent = ` · source ${status}`;
    el.append(sel, statusSpan);
  }


  /**
   * 支线 session 不可用降级提示（W2 §2.8）：常驻（非 dismissible——它解释
   * 的是被禁用的续聊入口这一事实状态），并作为降级视图的首个焦点。内含
   * 可直接执行的恢复按钮（issue #3 P1）。
   */
  function renderPanelSessionNote(view) {
    const note = deps.$("panel-session-note");
    const unavailable = view.sessionAvailability === "unavailable" || deps.state.forcePanelSessionNote;
    if (!unavailable) {
      note.hidden = true;
      return;
    }
    note.replaceChildren();
    note.append(
      deps.document.createTextNode(
        "Session missing on this branch — the branch stays fully readable (the database is the source of truth), " +
          "but continuing here will fail. Recovery: start a new exploration from saved content (button next to the " +
          "composer below), branch from a turn whose session is still available, or start a fresh Tree.",
      ),
    );
    note.append(deps.sessionRecoveryControls("panel"));
    note.hidden = false;
  }


  /** 支线局部面板渲染（可见性由 showPanel/hidePanel 管理，此处只填内容）。 */
  function renderPanel(stick) {
    if (deps.state.panelBranchId === null) return;
    const view = deps.branchView(deps.state.panelBranchId);
    if (view === null) return;
    /* 面板标题走意义名（D1）；机械序号在锚点上下文与 title 身份语境。 */
    deps.$("panel-title").textContent = deps.branchDisplayName(view.branch.id);
    renderPanelAnchorContext(view);
    renderPanelSessionNote(view);
    renderTurnsInto(deps.$("panel-conversation"), view, view.branch.id, stick);
    deps.syncReturnDraftForBranch(view.branch.id);
  }


  /** 流式占位回显：增量到达时只更新占位文本节点（不整树重渲）；用户本就
      贴底时跟随贴底，已向上阅读则完全不动滚动（issue #3 P1）。 */
  function updateStreamingPlaceholder() {
    const streaming = deps.state.streaming;
    if (streaming === null) return;
    const visible =
      streaming.branchId === deps.trunkBranchId() || streaming.branchId === deps.state.panelBranchId;
    if (!visible) return;
    const view = deps.branchView(streaming.branchId);
    if (view) {
      const page = deps.currentSessionRound(view);
      if (page.round && page.index !== page.rounds.length - 1) return;
    }
    let node = deps.document.getElementById("streaming-turn");
    const containerId = deps.conversationContainerId(streaming.branchId);
    if (node === null || node.parentElement === null || node.parentElement.id !== containerId) {
      deps.renderAll({ stick: streaming.branchId });
      return;
    }
    const container = node.parentElement;
    /* 先取增量写入前的贴底实况（写入会增高 scrollHeight，事后再判会把恰在
       底部的用户误判为已上移）。 */
    const follow = deps.isAtBottom(container);
    const textNode = node.firstChild;
    if (textNode !== null && typeof textNode.data === "string") {
      textNode.data = streaming.text;
    }
    if (follow) {
      container.scrollTo({ top: container.scrollHeight, behavior: deps.scrollBehavior() });
      if (container.clientHeight > 0) {
        deps.state.scrollPositions.set(deps.scrollKey(streaming.branchId), container.scrollTop);
      }
    }
  }

  return {
    turnElements,
    renderMainConversation,
    renderPanel,
    updateStreamingPlaceholder,
  };
}
