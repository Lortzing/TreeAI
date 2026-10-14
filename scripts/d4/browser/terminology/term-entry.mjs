/** terminology term-entry phase; the public probe retains original cleanup and output order Instance-owned state and dependencies. */
import { waitFor } from "../material-probes.mjs";
import { inputClickAt } from "../material-probes.mjs";

export async function runTerminologyTermEntry(deps) {

      {
        deps.termPick = deps.pickTerm(deps.answerText);
        if (deps.termPick === null || deps.termPick.end - deps.termPick.start < 2) {
          throw new Error(`terminology ② term selection could not be picked from the anchor answer (${String(deps.answerText.length)} units)`);
        }
        /* 真实连续拖选（term=点词级单词：无空白 → term 模式）。 */
        await deps.dragSelectOnTurn(deps.ctx, deps.anchorTurnId, deps.termPick, "term selection (real drag)");
        await deps.waitForArmedToolbar(deps.ctx, "term selection", { expectMode: "term" });
        deps.record.entryVertical.term.armed = { ...deps.termPick, gesture: "real continuous mouse drag", toolbarMode: "term" };
        await deps.ctx.screenshot("term-toolbar-armed");

        /* 解释卡（POST mode 字段随选区判定；echo=确定性回声 / real-pi=真实模型）。 */
        await deps.domClick(deps.ctx, "#conversation .selection-toolbar .toolbar-explain");
        const cardExplained = await waitFor(
          deps.ctx,
          `(() => { const card = document.getElementById("term-explain-card"); ` +
            `if (card === null) return false; ` +
            `if (!card.textContent.includes(${JSON.stringify(`⌖ Explain — “${deps.termPick.text}” (term,`)})) return false; ` +
            `const body = card.querySelector(".term-explain-body"); ` +
            `return body !== null && (body.textContent ?? "").trim().length > 0 ? { explanation: body.textContent } : false; })()`,
          { label: "term explain card reached the explained state", timeoutMs: deps.answerTimeoutMs },
        );
        if (!(cardExplained.explanation ?? "").toLowerCase().includes(deps.termPick.text.toLowerCase())) {
          throw new Error(
            `term explanation does not contain the selected term (got ${String(cardExplained.explanation?.length ?? 0)} units, term=${JSON.stringify(deps.termPick.text)}) — ${deps.modeNote}`,
          );
        }
        deps.record.entryVertical.term.explained = {
          mode: "term",
          explanationLen: cardExplained.explanation.length,
          containsSelectedTerm: true,
          driver: deps.ctx.MODE === "selftest" ? "echo (deterministic)" : "real Pi",
        };
        await deps.ctx.screenshot("term-explain-card");

        /* 保存批注 → saved 卡（首问输入在场）+ 正文区间覆盖 + 抽屉列表。 */
        await deps.domClick(deps.ctx, "#term-explain-card .term-save");
        await waitFor(
          deps.ctx,
          `(() => { const card = document.getElementById("term-explain-card"); ` +
            `return card !== null && card.querySelector("#term-first-question") !== null; })()`,
          { label: "term annotation saved (the card offers the promotion first-question input)" },
        );
        await waitFor(
          deps.ctx,
          `(() => { const turn = document.querySelector(${JSON.stringify(deps.trunkTurnSelector(deps.anchorTurnId))}); ` +
            `if (turn === null) return false; ` +
            `const marks = [...turn.querySelectorAll(".term-annotation-mark")]; ` +
            `return marks.length === 1 && marks[0].textContent === ${JSON.stringify(deps.termPick.text)}; })()`,
          { label: "the saved term annotation renders as the live underline overlay" },
        );
        const readAfterSave = await deps.terminologyViaApi(deps.ctx, deps.treeId);
        const annotation = (readAfterSave?.annotations ?? []).find(
          (entry) => entry?.anchorTurnId === deps.anchorTurnId && entry?.selection?.start === deps.termPick.start && entry?.selection?.end === deps.termPick.end,
        );
        if (annotation === undefined || annotation.mode !== "term" || annotation.promotedBranchId !== null) {
          throw new Error(`term annotation server fact mismatch: ${JSON.stringify(annotation)}`);
        }
        deps.record.entryVertical.term.saved = {
          annotationId: annotation.id,
          mode: "term",
          term: annotation.term,
          liveOverlayRendered: true,
        };

        /* 推广建枝：首问输入 → 双击提交（busy 锁 + 服务端幂等键 → 恰一次派发）。 */
        await inputClickAt(deps.ctx, "#term-first-question");
        await deps.ctx.cdpSend("Input.insertText", {
          text: `请基于这条术语批注展开：这个词在原文语境里为什么关键？（${deps.TERM_MARKERS.termQ1}）`,
        });
        const promoteSelector = "#term-explain-card .term-promote";
        const doubleClickMode = await deps.domDoubleClick(deps.ctx, promoteSelector);
        await waitFor(
          deps.ctx,
          `(() => { const panel = document.getElementById("branch-panel"); ` +
            `if (panel === null || panel.hidden) return false; ` +
            `return (document.getElementById("panel-conversation").textContent ?? "").includes(${JSON.stringify(deps.TERM_MARKERS.termQ1)}); })()`,
          { label: "term promotion first question landed and the branch panel opened (double-click submit)", timeoutMs: deps.answerTimeoutMs },
        );
        const stateAfterPromote = await deps.treeStateViaApi(deps.ctx, deps.treeId);
        const termBranchView = (stateAfterPromote?.branches ?? []).find((view) =>
          (view?.turns ?? []).some((turn) => turn?.role === "user" && typeof turn?.text === "string" && turn.text.includes(deps.TERM_MARKERS.termQ1)));
        if (termBranchView === undefined) throw new Error("terminology ② term promotion branch not found in the tree state");
        deps.termBranchId = termBranchView.branch.id;
        const q1UserTurns = termBranchView.turns.filter(
          (turn) => turn?.role === "user" && typeof turn.text === "string" && turn.text.includes(deps.TERM_MARKERS.termQ1));
        const termAnswers = termBranchView.turns.filter((turn) => turn?.role === "assistant" && (turn?.text ?? "").trim().length > 0);
        if (q1UserTurns.length !== 1) {
          throw new Error(`term double-click promotion dispatched the first question ${String(q1UserTurns.length)} times (must be exactly 1)`);
        }
        if (termAnswers.length < 1) throw new Error(`term promotion first question landed no assistant answer — ${deps.modeNote}`);
        const readAfterPromote = await deps.terminologyViaApi(deps.ctx, deps.treeId);
        const promotedAnnotation = (readAfterPromote?.annotations ?? []).find((entry) => entry?.id === annotation.id);
        if (promotedAnnotation?.promotedBranchId !== deps.termBranchId) {
          throw new Error(`term annotation promotion binding mismatch: ${JSON.stringify(promotedAnnotation?.promotedBranchId)}`);
        }
        deps.record.entryVertical.term.promoted = {
          branchId: deps.termBranchId,
          doubleClick: doubleClickMode,
          firstQuestionUserTurns: 1,
          assistantAnswer: true,
          promotedBranchBinding: deps.termBranchId,
        };
        deps.record.idempotency.doubleClick = {
          mode: "term",
          secondClick: doubleClickMode,
          userTurnsWithMarker: q1UserTurns.length,
          exactlyOnce: q1UserTurns.length === 1,
          mechanism: "client busy lock (guard) + server promotion idempotency key",
        };
        await deps.ctx.screenshot("term-branch-panel");

        /* 支线 ≥2 轮追问。 */
        await deps.panelFollowUp(deps.ctx, deps.TERM_MARKERS.termF1, `第一轮追问：这个术语和一个相邻概念的区别是什么？（${deps.TERM_MARKERS.termF1}）`, deps.answerTimeoutMs, "term branch");
        await deps.panelFollowUp(deps.ctx, deps.TERM_MARKERS.termF2, `第二轮追问：给出一个使用该术语的例子。（${deps.TERM_MARKERS.termF2}）`, deps.answerTimeoutMs, "term branch");
        deps.record.entryVertical.term.followUps = [deps.TERM_MARKERS.termF1, deps.TERM_MARKERS.termF2];

        /* Return 回主线（术语来源卡：摘录/保存时间/来源分支——与材料 Return 卡同范式）。 */
        const termReturnText = `术语探索的收获（term）：该词的语境含义与边界已经核对。（${deps.TERM_MARKERS.termRet}）`;
        const termCard = await deps.submitTermReturn(deps.ctx, termReturnText, deps.TERM_MARKERS.termRet, "term branch return");
        const metaProblems = [];
        if (!(termCard?.meta ?? "").includes(`anchored on “${deps.termPick.text}”`)) {
          metaProblems.push(`source-card excerpt missing: ${JSON.stringify(termCard?.meta)}`);
        }
        if (!(termCard?.meta ?? "").includes("saved ")) metaProblems.push(`saved time missing: ${JSON.stringify(termCard?.meta)}`);
        if (!(termCard?.meta ?? "").includes(`↩ Return from `)) metaProblems.push(`from-branch missing: ${JSON.stringify(termCard?.meta)}`);
        if (metaProblems.length > 0) {
          throw new Error(`term Return card (terminology source card) mismatch — ${metaProblems.join("; ")}`);
        }
        const stateAfterReturn = await deps.treeStateViaApi(deps.ctx, deps.treeId);
        const trunkAfter = deps.trunkViewOf(stateAfterReturn);
        const retTurn = (trunkAfter?.turns ?? []).find(
          (turn) => turn?.role === "return" && turn?.text === termReturnText && turn?.fromBranchId === deps.termBranchId);
        if (retTurn === undefined) {
          throw new Error("term Return did not land on the Trunk with the promoting branch as its source (server fact)");
        }
        deps.record.entryVertical.term.returned = {
          cardMeta: termCard.meta,
          deliveryNote: termCard.delivery,
          serverFromBranchId: deps.termBranchId,
        };
        await deps.ctx.screenshot("term-return-card");
      }

  return {

  };
}
