/** Stable turn actions, armed selection toolbar, Return/annotation actions and button identity registries. Instance-owned state and dependencies. */

export function createTurnActionsView(deps) {

  const branchHereButtons = new Map();

  /** 解释入口按钮注册表（turnId → 按钮）：解释卡 Esc/关闭的焦点还原目标。 */
  const termExplainButtons = new Map();

  /** turn 所属分支（批注覆盖点击重开卡时定位视图用）。 */
  function branchIdOfTurn(turn) {
    return turn.branchId;
  }


  /** 动作层：重建 .turn-actions（按钮 + 武装选区工具条）——正文区不触碰。 */
  function renderTurnActions(element, turn, branchId) {
    const old = element.querySelector(".turn-actions");
    if (old !== null) element.removeChild(old);
    element.append(buildTurnActions(turn, branchId));
  }


  /** 构建动作层（.turn-actions）：常驻入口（建支线/解释）+ 选择提示 +
      武装选区时的工具条（③ 模式/工具条）。 */
  function buildTurnActions(turn, branchId) {
    const st = deps.state.treeState;
    const view = branchId === st.trunkBranchId ? "main" : "panel";
    const wrap = deps.document.createElement("span");
    wrap.className = "turn-actions";
    const armed = deps.state.armedSelection;
    const armedHere = armed !== null && armed.branchId === branchId && armed.turnId === turn.id;

    const branchButton = deps.document.createElement("button");
    branchButton.className = "branch-here";
    branchButton.textContent = armedHere ? "⑃ 从选文展开支线" : "⑃ 从这里展开支线";
    branchHereButtons.set(turn.id, branchButton);
    branchButton.addEventListener("click", () => deps.guard(() => deps.branchFromTurn(turn), view));

    /* 术语解释入口（issue #7 C ③）：选区（点词双击/任意划线/触屏
       selectionchange）即武装；无选区禁用（解释需要明确区间，不做整答案
       回退）。武装态读 state.armedSelection（与工具条同源）。 */
    const explainButton = deps.document.createElement("button");
    explainButton.className = "term-explain";
    explainButton.textContent = "⌖ 解释选文";
    explainButton.disabled = !armedHere;
    explainButton.title =
      "解释选中的文字";
    termExplainButtons.set(turn.id, explainButton);
    explainButton.addEventListener("click", () => {
      const current = deps.state.armedSelection;
      if (current === null || current.branchId !== branchId || current.turnId !== turn.id) return;
      deps.guard(
        () => deps.explainSelection(branchId, turn, { start: current.start, end: current.end, text: current.text }),
        view,
      );
    });

    const hint = deps.document.createElement("span");
    hint.className = "selection-hint";
    hint.textContent = "选择文字可从选文开始追问";
    wrap.append(branchButton, explainButton, hint);
    if (armedHere) wrap.append(buildSelectionToolbar(branchId, turn, armed));
    return wrap;
  }


  /** 工具条内按（分支, 锚点 turn, 精确区间）找已保存批注（读模型数据面）。
      P0 同源校验：批注摘录必须与当前选区文本全等——同偏移异文（原文漂移后
      的陈旧批注）不是「这个选区的批注」，不给捷径（服务端解释仍会以同选区
      去重如实返回该批注，卡面带 source changed 降级说明）。 */
  function findAnnotationForSelection(branchId, turnId, selection) {
    const terminology = deps.state.terminology;
    if (terminology === null || !terminology.ok) return null;
    return (
      terminology.annotations.find(
        (annotation) =>
          annotation.branchId === branchId &&
          annotation.anchorTurnId === turnId &&
          annotation.selection.start === selection.start &&
          annotation.selection.end === selection.end &&
          annotation.selection.text === selection.text,
      ) ?? null
    );
  }


  /**
   * 选区工具条（③ 模式/工具条）：服务端既有模式的入口——解释（点词 term /
   * 划线 range，按选区文本是否含空白判定）、建支线（通用入口，绝不复用已有
   * 探索）；已有批注时给出「打开已存批注 / 推广」捷径，已推广的批注呈现
   * resume-or-create 明确去向（issue #7 ②③：同锚点恢复或明确另开，绝不跨
   * 语境静默复用）。键盘可达（原生 button）。
   */
  function buildSelectionToolbar(branchId, turn, armed) {
    const st = deps.state.treeState;
    const view = branchId === st.trunkBranchId ? "main" : "panel";
    const bar = deps.document.createElement("span");
    bar.className = "selection-toolbar";
    bar.setAttribute("role", "toolbar");
    bar.setAttribute(
      "aria-label",
      `Selection actions — ${armed.mode === "term" ? "term" : "span"} “${armed.text}”`,
    );

    const explain = deps.document.createElement("button");
    explain.className = "toolbar-explain";
    explain.textContent = armed.mode === "term" ? "⌖ Explain term" : "⌖ Explain span";
    explain.title = "Run the isolated terminology executor on this selection (no main-session side effects)";
    explain.addEventListener("click", () => {
      deps.guard(
        () => deps.explainSelection(branchId, turn, { start: armed.start, end: armed.end, text: armed.text }),
        view,
      );
    });
    bar.append(explain);

    const branch = deps.document.createElement("button");
    branch.className = "toolbar-branch";
    branch.textContent = "⑃ 从选文展开支线";
    branch.title = "Anchor a brand-new branch on this selection (never reuses an existing exploration)";
    branch.addEventListener("click", () => deps.guard(() => deps.branchFromTurn(turn), view));
    bar.append(branch);

    /* 已解释未保存：工具条直达保存（与解释卡同一动作）。 */
    const card = deps.state.termExplain;
    if (
      card !== null &&
      card.branchId === branchId &&
      card.turnId === turn.id &&
      card.state === "explained" &&
      card.selection.start === armed.start &&
      card.selection.end === armed.end
    ) {
      const save = deps.document.createElement("button");
      save.className = "toolbar-save";
      save.textContent = "✓ Save as annotation";
      save.title = "Persist this explanation as a term annotation (product fact)";
      save.addEventListener("click", () => deps.guard(deps.saveTermAnnotation, view));
      bar.append(save);
    }

    const existing = findAnnotationForSelection(branchId, turn.id, armed);
    if (existing !== null) {
      const open = deps.document.createElement("button");
      open.className = "toolbar-annotation";
      open.textContent = existing.promotedBranchId === null ? "✓ Saved annotation" : "✓ Follow-up exists";
      open.title = "Open the saved annotation card for this exact selection";
      open.addEventListener("click", () => deps.openSavedAnnotationCard(existing, branchId, turn));
      bar.append(open);
      if (existing.promotedBranchId === null) {
        const promote = deps.document.createElement("button");
        promote.className = "toolbar-promote";
        promote.textContent = "⑃ Promote to branch";
        promote.title = "Open the annotation card and focus the follow-up first-question field";
        promote.addEventListener("click", () => deps.openSavedAnnotationCard(existing, branchId, turn, { focusFirstQuestion: true }));
        bar.append(promote);
      }
    }
    return bar;
  }


  /**
   * 就地同步武装态（mouseup/双击/selectionchange 路径）：只改动作层内的既有
   * 按钮/工具条（被捕获的按钮引用与焦点不失效），正文区一字不碰。renderAll
   * 路径由 buildTurnActions 全量重建，两路最终态一致。
   */
  function syncTurnActionsArmedState(element, turn, branchId) {
    const actions = element.querySelector(".turn-actions");
    if (actions === null) return;
    const armed = deps.state.armedSelection;
    const armedHere = armed !== null && armed.branchId === branchId && armed.turnId === turn.id;
    const branchButton = actions.querySelector(".branch-here");
    if (branchButton !== null) {
      branchButton.textContent = armedHere ? "⑃ 从选文展开支线" : "⑃ 从这里展开支线";
    }
    const explainButton = actions.querySelector(".term-explain");
    if (explainButton !== null) explainButton.disabled = !armedHere;
    const toolbar = actions.querySelector(".selection-toolbar");
    if (toolbar !== null && toolbar.parentElement !== null) toolbar.parentElement.removeChild(toolbar);
    if (armedHere) actions.append(buildSelectionToolbar(branchId, turn, armed));
  }

  return {
    termExplainButtons,
    branchIdOfTurn,
    syncTurnActionsArmedState,
    renderTurnActions,
    branchHereButtons,
  };
}
