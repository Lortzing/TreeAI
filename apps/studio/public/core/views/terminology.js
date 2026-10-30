import { handleComposerKey } from "../controllers/appearance.js";
import { createDisclosure } from "../dom.js";
/** Suggestion strips and explanation/annotation/promotion cards; no automatic product writes. Instance-owned state and dependencies. */

export function createTerminologyView(deps) {


  /**
   * assistant 回答区的建议条（issue #7 ①阅读模式，渲染在该条答案 turn 元素
   * 之后）：按建议集状态如实呈现——pending（提取在途）/ ready / partial
   * （密度截断：「还有 N 个候选未显示」）/ no-suggestions / budget-paused
   * （预算不足暂停 + 可恢复入口）/ failed（诚实错误 + 重试）/ source-invalid
   * （来源失效——快照展示，点击解释禁用，既有 overlay 失效降级同纪律）。
   * 建议**只展示**：点击 chip = 预填该词的解释请求，用户显式确认（“⌖
   * Explain”）才发——不自动解释、不自动保存。chip 为原生 button（键盘可
   * 达）；无进场动效（reduced-motion 无需特例）。
   */
  function termSuggestionStrip(branchId, turn) {
    const terminology = deps.state.terminology;
    if (terminology === null || !terminology.ok) return null;
    const auto = terminology.autoSuggestions;
    if (auto === null || typeof auto !== "object" || !Array.isArray(auto.sets)) return null;
    const set = auto.sets.find((entry) => entry.anchorTurnId === turn.id && entry.branchId === branchId);
    if (set === undefined) return null;
    const div = deps.document.createElement("div");
    div.className = "term-suggest-strip";
    div.setAttribute("role", "group");
    div.setAttribute("aria-label", "Term suggestions for this answer");

    if (set.status === "pending") {
      div.append(deps.mutedLine("suggesting terms for this answer (isolated executor)…"));
      return div;
    }
    if (set.status === "no-suggestions") {
      div.append(deps.mutedLine("no term suggestions for this answer"));
      return div;
    }
    if (set.status === "budget-paused") {
      div.append(
        deps.mutedLine(
          "auto suggestions paused — the terminology budget for this process is exhausted (zero dispatch)",
        ),
      );
      div.append(termSuggestRetryButton(set));
      div.append(
        deps.mutedLine(
          "raise the terminology budget (restart with --terminology-budget) and retry, or select a term and explain it manually",
        ),
      );
      return div;
    }
    if (set.status === "failed") {
      const error = set.error;
      div.append(
        deps.mutedLine(
          `term suggestions failed${error !== null && error.code !== null ? ` (${error.code})` : ""} — ${
            error !== null && error.message !== null ? error.message : "the extraction did not complete"
          }`,
        ),
      );
      div.append(termSuggestRetryButton(set));
      return div;
    }

    /* ready / partial / source-invalid：候选快照逐 chip 呈现。 */
    const snapshotOnly = set.status === "source-invalid";
    const armed = deps.state.termSuggest;
    for (const suggestion of set.suggestions) {
      const chip = deps.document.createElement("button");
      chip.className = "term-suggest-chip";
      chip.textContent = suggestion.term;
      if (snapshotOnly) {
        chip.disabled = true;
        chip.title = "snapshot only — the answer text changed after these suggestions; click-to-explain is disabled";
      } else {
        chip.title = "Pre-fill an explain request for this term — you confirm before it is sent";
        if (
          armed !== null &&
          armed.branchId === branchId &&
          armed.turnId === turn.id &&
          armed.start === suggestion.start &&
          armed.end === suggestion.end
        ) {
          chip.classList.add("armed");
          chip.setAttribute("aria-pressed", "true");
        }
        chip.addEventListener("click", () => {
          deps.state.termSuggest = {
            branchId,
            turnId: turn.id,
            anchorTurnId: set.anchorTurnId,
            start: suggestion.start,
            end: suggestion.end,
            term: suggestion.term,
          };
          deps.renderAll();
        });
      }
      div.append(chip);
    }
    if (snapshotOnly) {
      div.append(
        deps.mutedLine("the answer text changed after these suggestions were extracted — snapshot only"),
      );
      return div;
    }
    if (set.status === "partial") {
      div.append(
        deps.mutedLine(`+ ${String(set.hiddenCount)} more candidate${set.hiddenCount === 1 ? "" : "s"} not shown (density cap)`),
      );
    }
    /* 预填的确认条（仅武装中的建议渲染）：显式确认才发解释请求。 */
    if (armed !== null && armed.branchId === branchId && armed.turnId === turn.id) {
      const bar = deps.document.createElement("span");
      bar.className = "term-suggest-confirm";
      const label = deps.document.createElement("span");
      label.className = "muted";
      label.textContent = `Explain “${armed.term}”?`;
      const go = deps.document.createElement("button");
      go.className = "term-suggest-go";
      go.textContent = "⌖ Explain";
      go.title = "Send the explain request for this suggested term (your explicit confirmation)";
      go.addEventListener("click", () => {
        const current = deps.state.termSuggest;
        if (current === null) return;
        deps.state.termSuggest = null;
        deps.guard(
          () =>
            deps.explainSelection(branchId, turn, {
              start: current.start,
              end: current.end,
              text: current.term,
            }),
          branchId === deps.trunkBranchId() ? "main" : "panel",
        );
      });
      const dismiss = deps.document.createElement("button");
      dismiss.className = "term-suggest-dismiss";
      dismiss.textContent = "Dismiss";
      dismiss.title = "Cancel the pre-filled explain request (nothing is sent)";
      dismiss.addEventListener("click", deps.disarmTermSuggestion);
      bar.append(label, go, dismiss);
      div.append(bar);
    }
    return div;
  }


  /** 建议条的重试按钮（budget-paused/failed 的可恢复入口——显式用户动作）。 */
  function termSuggestRetryButton(set) {
    const retry = deps.document.createElement("button");
    retry.className = "term-suggest-retry";
    retry.textContent = "Retry suggestions";
    retry.title = "Re-run the suggestion extraction for this answer (your explicit action)";
    retry.addEventListener("click", () => deps.guard(() => deps.retryTermSuggestions(set.anchorTurnId), "panel"));
    return retry;
  }


  /** 解释卡的关闭按钮（工具函数：Close 文案 + 关闭语义）。 */
  function termCloseButton() {
    const close = deps.document.createElement("button");
    close.className = "term-explain-close";
    close.textContent = "Close";
    close.addEventListener("click", deps.closeTermExplain);
    return close;
  }


  /** 解释卡的失败重试按钮（按卡内保存的锚点/选区重发解释请求）。 */
  function termRetryButton(card) {
    const retry = deps.document.createElement("button");
    retry.className = "term-explain-retry";
    retry.textContent = "Retry";
    retry.title = "Run the isolated explanation again";
    retry.addEventListener("click", () =>
      deps.guard(
        () =>
          deps.explainSelection(
            card.branchId,
            { id: card.turnId, text: "", branchId: card.branchId },
            card.selection,
          ),
        "panel",
      ),
    );
    return retry;
  }


  /**
   * 解释卡（渲染在对应 assistant 答案之后；issue #7 C ③ 完整状态）：
   * loading / explained（含缓存命中注记）/ saved（新建 vs 幂等命中既有；
   * 未推广 → 首问输入 + 幂等推广；已推广 → resume-or-create 明确去向）/
   * failed（诚实错误 + 重试）/ cancelled（含迟到丢弃注记）/ 推广冲突面
   * （同批注异键 → 恢复既有探索的明确去向，绝不静默复用）。
   * 进场动效只在打开的那一次渲染播放（.enter；reduced-motion 下 CSS 即时
   * 化——见 style.css）。
   */
  function termExplainCard() {
    const card = deps.state.termExplain;
    if (card === null) return null;
    const div = deps.document.createElement("div");
    div.className = "term-explain-card";
    div.id = "term-explain-card";
    div.setAttribute("tabindex", "-1"); /* 程序聚焦目标（打开/Esc 关闭还原） */
    if (deps.terminologyController.termCardEnterPending) {
      div.classList.add("enter");
      deps.terminologyController.termCardEnterPending = false;
    }
    const head = deps.document.createElement("p");
    head.className = "term-explain-head";
    const modeNote = card.mode === "term" ? "term" : "span";
    head.textContent = `⌖ Explain — “${card.selection.text}” (${modeNote}, offsets ${String(card.selection.start)}..${String(card.selection.end)})`;
    const location = createDisclosure(deps.document, "引用详情", deps.document.createTextNode(head.textContent));
    head.textContent = `解释“${card.selection.text}”`;
    div.append(head, location);
    if (card.state === "loading") {
      div.append(deps.mutedLine("正在解释…"));
      const actions = deps.document.createElement("div");
      actions.className = "term-explain-actions";
      const dismiss = deps.document.createElement("button");
      dismiss.className = "term-explain-close";
      dismiss.textContent = "Dismiss";
      dismiss.title = "Close the card — a late result, if any, is discarded honestly (counted in the drawer usage)";
      dismiss.addEventListener("click", deps.closeTermExplain);
      actions.append(dismiss);
      div.append(actions);
      return div;
    }
    if (card.state === "failed") {
      div.append(deps.mutedLine(`explanation failed — ${card.error}`));
      const actions = deps.document.createElement("div");
      actions.className = "term-explain-actions";
      actions.append(termRetryButton(card), termCloseButton());
      div.append(actions);
      return div;
    }
    if (card.state === "cancelled") {
      const note =
        card.lateDiscard === true
          ? "cancelled — a late result arrived after the cancellation and was discarded (the request cost is still recorded)"
          : "cancelled — the explanation task was cancelled before completing";
      div.append(deps.mutedLine(note));
      const actions = deps.document.createElement("div");
      actions.className = "term-explain-actions";
      actions.append(termRetryButton(card), termCloseButton());
      div.append(actions);
      return div;
    }
    const body = deps.document.createElement("p");
    body.className = "term-explain-body";
    body.textContent = card.explanation ?? "";
    div.append(body);
    if (card.state === "explained" && card.cached) {
      location.append(deps.mutedLine("(served from the executor cache — no new request)"));
    }
    /* P0 降级显示（issue #7 增量验收）：已保存批注的卡在锚定失效时明确标注
       来源状态——卡面展示的是保存快照（批注自带的摘录/解释），活覆盖不在
       当前文本上，绝不冒充仍锚定在原文上。 */
    if (card.state === "saved" && card.annotation !== null) {
      const anchorStatus = deps.terminologyAnchorStatus(card.annotation);
      if (anchorStatus === "changed") {
        div.append(
          deps.mutedLine(
            "the anchored answer text has changed since this annotation was saved — this card shows the saved snapshot; no live underline is drawn on the current text",
          ),
        );
      } else if (anchorStatus === "missing") {
        div.append(deps.mutedLine("the anchored answer is no longer in this tree — this card shows the saved snapshot"));
      }
    }
    const actions = deps.document.createElement("div");
    actions.className = "term-explain-actions";
    if (card.state === "explained") {
      const save = deps.document.createElement("button");
      save.className = "accent term-save";
      save.textContent = "Save as annotation";
      save.addEventListener("click", () => deps.guard(deps.saveTermAnnotation, "panel"));
      actions.append(save);
    } else if (card.state === "saved" && card.annotation !== null) {
      if (card.annotation.promotedBranchId === null) {
        if (card.saveOutcome === "duplicate") {
          actions.append(
            deps.mutedLine("already saved — showing the existing annotation for this exact selection"),
          );
        }
        const label = deps.document.createElement("span");
        label.className = "muted";
        label.textContent = "saved — promote to a follow-up branch:";
        const input = deps.document.createElement("textarea");
        input.id = "term-first-question";
        input.rows = 2;
        input.value = card.firstQuestion;
        input.placeholder = "First question for the follow-up branch…";
        input.addEventListener("input", () => {
          if (deps.state.termExplain !== null) deps.state.termExplain.firstQuestion = input.value;
        });
        input.addEventListener("keydown", (event) => handleComposerKey(event, input, () => deps.guard(deps.promoteTermAnnotation, "panel"), deps.document));
        const promote = deps.document.createElement("button");
        promote.className = "accent term-promote";
        promote.textContent = card.promoting ? "Promoting…" : "⑃ Promote to branch";
        promote.disabled = card.promoting;
        promote.addEventListener("click", () => deps.guard(deps.promoteTermAnnotation, "panel"));
        actions.append(label, input, promote);
      } else {
        /* 已推广：resume-or-create 明确二选（issue #7 ②③——同锚点恢复或明
           确另开，绝不跨同词语境静默复用）。 */
        const note = deps.document.createElement("span");
        note.className = "muted";
        note.textContent = `saved — already promoted to ${deps.branchLabel(card.annotation.promotedBranchId)}`;
        actions.append(note);
        const resume = deps.document.createElement("button");
        resume.className = "term-resume";
        resume.textContent = "Open the follow-up branch";
        resume.title = "Resume the existing exploration anchored on this exact selection";
        resume.addEventListener("click", () => {
          const cardElement = deps.document.getElementById("term-explain-card");
          deps.state.termExplain = null; /* 恢复既有探索即收卡（去向明确，不悬空） */
          deps.renderAll();
          deps.guard(
            () =>
              deps.openBranchPanel(card.annotation.promotedBranchId, {
                trigger: { kind: "element", element: cardElement },
              }),
            "panel",
          );
        });
        actions.append(resume);
        actions.append(
          deps.mutedLine(
            "this exact selection already has its follow-up — to start a different one, select a different span or use “⑃ Branch from selection” (a promotion is one-per-annotation by design)",
          ),
        );
      }
    }
    if (card.promotionConflict !== null) {
      const conflict = deps.document.createElement("p");
      conflict.className = "term-explain-conflict";
      conflict.textContent = `promotion conflict — ${card.promotionConflict}`;
      div.append(conflict);
      if (card.annotation !== null && card.annotation.promotedBranchId !== null) {
        /* 刷新后的批注已呈推广事实（上方的 resume-or-create 块携带「打开既有
           支线」入口）；此处只补冲突语境，不重复渲染第二个入口。 */
        actions.append(
          deps.mutedLine(`the recorded promotion is on ${deps.branchLabel(card.annotation.promotedBranchId)} — use “Open the follow-up branch” above`),
        );
      }
      actions.append(deps.mutedLine("可以重试当前问题，或修改问题后另开支线。"));
    }
    actions.append(termCloseButton());
    div.append(actions);
    return div;
  }

  return {
    termSuggestionStrip,
    termExplainCard,
  };
}
