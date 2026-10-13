/** terminology range-entry phase; the public probe retains original cleanup and output order Instance-owned state and dependencies. */
import { waitFor } from "../material-probes.mjs";
import { inputClickAt } from "../material-probes.mjs";
import { sleep } from "../material-probes.mjs";

export async function runTerminologyRangeEntry(deps) {

      {
        deps.rangePick = deps.pickRange(deps.answerText, deps.termPick);
        if (deps.rangePick === null) {
          throw new Error(`terminology ② range selection could not be picked from the anchor answer (${String(deps.answerText.length)} units)`);
        }
        await deps.dragSelectOnTurn(deps.ctx, deps.anchorTurnId, deps.rangePick, "range selection (real drag)");
        await deps.waitForArmedToolbar(deps.ctx, "range selection", { expectMode: "span" });
        deps.record.entryVertical.range.armed = { ...deps.rangePick, gesture: "real continuous mouse drag", toolbarMode: "range (span)" };

        await deps.domClick(deps.ctx, "#conversation .selection-toolbar .toolbar-explain");
        const rangeCard = await waitFor(
          deps.ctx,
          `(() => { const card = document.getElementById("term-explain-card"); ` +
            `if (card === null) return false; ` +
            `if (!card.textContent.includes(${JSON.stringify(`⌖ Explain — “${deps.rangePick.text.slice(0, Math.min(24, deps.rangePick.text.length))}`)})) return false; ` +
            `const body = card.querySelector(".term-explain-body"); ` +
            `return body !== null && (body.textContent ?? "").trim().length > 0 ? { explanation: body.textContent } : false; })()`,
          { label: "range explain card reached the explained state", timeoutMs: deps.answerTimeoutMs },
        );
        const rangeWords = deps.asciiWordsOf(deps.rangePick.text);
        const rangeExplanation = rangeCard.explanation ?? "";
        const rangeContainsWord = rangeWords.some((word) => rangeExplanation.toLowerCase().includes(word.toLowerCase()));
        if (rangeExplanation.trim().length === 0) {
          throw new Error(`range explanation is empty — ${deps.modeNote}`);
        }
        if (rangeWords.length > 0 && rangeContainsWord !== true) {
          throw new Error(
            `range explanation does not contain any source word of the selection (words=${JSON.stringify(rangeWords.slice(0, 4))}, ` +
              `explanation ${String(rangeExplanation.length)} units) — ${deps.modeNote}`,
          );
        }
        deps.record.entryVertical.range.explained = {
          mode: "range",
          explanationLen: rangeExplanation.length,
          sourceWords: rangeWords.slice(0, 4),
          containsSourceWord: rangeWords.length === 0 ? "n/a (no ASCII word ≥3 in the selection; non-empty asserted)" : rangeContainsWord,
          driver: deps.ctx.MODE === "selftest" ? "echo (deterministic)" : "real Pi",
        };

        /* 保存批注（第二条；与 term 区间相邻不重叠 → 双覆盖并存）。 */
        await deps.domClick(deps.ctx, "#term-explain-card .term-save");
        await waitFor(
          deps.ctx,
          `(() => { const card = document.getElementById("term-explain-card"); ` +
            `return card !== null && card.querySelector("#term-first-question") !== null; })()`,
          { label: "range annotation saved (the card offers the promotion first-question input)" },
        );
        try {
          await waitFor(
            deps.ctx,
            `(() => { const turn = document.querySelector(${JSON.stringify(deps.trunkTurnSelector(deps.anchorTurnId))}); ` +
              `if (turn === null) return false; ` +
              `const marks = [...turn.querySelectorAll(".term-annotation-mark")]; ` +
              `return marks.length === 2 && marks.some((m) => m.textContent === ${JSON.stringify(deps.termPick.text)}) ` +
              `&& marks.some((m) => m.textContent === ${JSON.stringify(deps.rangePick.text)}); })()`,
            { label: "both saved annotations render as live underline overlays (term + range, non-overlapping)", timeoutMs: deps.answerTimeoutMs },
          );
        } catch (err) {
          const read = await deps.terminologyViaApi(deps.ctx, deps.treeId).catch(() => null);
          const snap = await deps.ctx.evalJs(
            `(() => { const turn = document.querySelector(${JSON.stringify(deps.trunkTurnSelector(deps.anchorTurnId))}); ` +
              `if (turn === null) return { turnMissing: true }; ` +
              `const marks = [...turn.querySelectorAll(".term-annotation-mark")]; ` +
              `const bodyText = (() => { const walker = document.createTreeWalker(turn, NodeFilter.SHOW_TEXT, ` +
                `{ acceptNode: (n) => (n.parentElement !== null && n.parentElement.closest(".turn-actions") !== null) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT }); ` +
                `const parts = []; for (;;) { const n = walker.nextNode(); if (n === null) break; parts.push(n.data); } return parts.join(""); })(); ` +
              `return { markCount: marks.length, markTexts: marks.map((m) => m.textContent), bodyLen: bodyText.length, ` +
                `bodySlice: bodyText.slice(${Number(deps.rangePick.start)}, ${Number(deps.rangePick.end)}) }; })()`,
          ).catch(() => null);
          await deps.ctx.sidecar("range-overlay-debug", { annotations: read?.annotations ?? null, snap, termPick: deps.termPick, rangePick: deps.rangePick }).catch(() => {});
          throw new Error(`both-annotation overlay wait failed — debug sidecar range-overlay-debug (server annotations + DOM marks recorded); original: ${err instanceof Error ? err.message : String(err)}`);
        }
        const readAfterRangeSave = await deps.terminologyViaApi(deps.ctx, deps.treeId);
        const rangeAnnotation = (readAfterRangeSave?.annotations ?? []).find(
          (entry) => entry?.anchorTurnId === deps.anchorTurnId && entry?.selection?.start === deps.rangePick.start && entry?.selection?.end === deps.rangePick.end);
        if (rangeAnnotation === undefined || rangeAnnotation.mode !== "range" || rangeAnnotation.promotedBranchId !== null) {
          throw new Error(`range annotation server fact mismatch: ${JSON.stringify(rangeAnnotation)}`);
        }
        deps.record.entryVertical.range.saved = {
          annotationId: rangeAnnotation.id,
          mode: "range",
          liveOverlayRendered: true,
          bothOverlaysCoexist: true,
        };
        await deps.ctx.screenshot("range-saved-card");

        /* ③ 焦点/滚动/草稿（推广首问草稿 → renderAll 离开回来 → 保留 + 焦点还原
           + 主线滚动保留；renderAll 由 Trunk tab 的 DOM click 触发（/switch +
           全量重渲是应用自身路径；DOM click 不移动焦点——复现「输入中恰有
           异步刷新」的 W2/③ 焦点保持语义，ui-terminology 套件以 SSE 终态同款
           断言），不经 resetTransientView，卡与草稿必须存活）。 */
        const rangeFirstQuestion = `请基于这条划线批注展开：这句话的主张是什么？（${deps.TERM_MARKERS.rangeQ1}）`;
        await inputClickAt(deps.ctx, "#term-first-question");
        await deps.ctx.cdpSend("Input.insertText", { text: rangeFirstQuestion });
        const activeBefore = await deps.ctx.evalJs(`(() => document.activeElement?.id ?? null)()`);
        await deps.domClick(deps.ctx, "#branch-tabs button:nth-child(1)"); /* Trunk tab → /switch + renderAll（不夺焦点） */
        await sleep(600);
        const draftState = await deps.ctx.evalJs(
          `(() => ({ value: document.getElementById("term-first-question")?.value ?? null, ` +
            `activeId: document.activeElement?.id ?? null, ` +
            `cardPresent: document.getElementById("term-explain-card") !== null }))()`,
        );
        const draftProblems = [];
        if (draftState.value !== rangeFirstQuestion) draftProblems.push(`draft lost: ${JSON.stringify(draftState.value?.slice(0, 40))}`);
        if (draftState.activeId !== "term-first-question") draftProblems.push(`focus not restored: ${JSON.stringify(draftState.activeId)} (was ${JSON.stringify(activeBefore)})`);
        if (draftState.cardPresent !== true) draftProblems.push("the explain card did not survive the renderAll");
        if (draftProblems.length > 0) {
          throw new Error(`terminology ③ draft/focus round trip failed — ${draftProblems.join("; ")}`);
        }
        deps.record.frontendInvariants.draftFocus = {
          roundTrip: "typed a promotion first-question draft → Trunk tab click (real /switch + renderAll) → draft + focus + card all preserved",
          draftLen: rangeFirstQuestion.length,
          activeIdAfter: draftState.activeId,
        };
        /* 响应丢失推广：传输层丢弃 promote 响应 → 卡面如实冲突 + 刷新揭示既有
           推广 → 恢复既有探索（恰一条首问 user turn，分支数恰 +1）。 */
        const branchCountBefore = (await deps.treeStateViaApi(deps.ctx, deps.treeId))?.branches?.length ?? 0;
        let droppedCount = 0;
        ({ dropped: droppedCount } = await deps.withDroppedResponses(deps.ctx, "*terminology/annotations/*/promote", async () => {
          await deps.domClick(deps.ctx, "#term-explain-card .term-promote");
          try {
            await waitFor(
              deps.ctx,
              `(() => { const card = document.getElementById("term-explain-card"); ` +
                `if (card === null) return false; ` +
                `const text = card.textContent ?? ""; ` +
                `return text.includes("promotion conflict —") && text.includes("saved — already promoted to") ` +
                  `&& card.querySelector(".term-resume") !== null; })()`,
              { label: "response-loss promote: honest conflict on the card + the refreshed annotation reveals the recorded promotion", timeoutMs: deps.answerTimeoutMs },
            );
          } catch (err) {
            const snap = await deps.ctx.evalJs(
              `(() => ({ cardPresent: document.getElementById("term-explain-card") !== null, ` +
                `cardText: (document.getElementById("term-explain-card")?.textContent ?? "").slice(0, 1200), ` +
                `panelHidden: document.getElementById("branch-panel")?.hidden ?? null, ` +
                `panelError: (document.getElementById("panel-error-banner")?.textContent ?? "").slice(0, 300), ` +
                `mainError: (document.getElementById("error-banner")?.textContent ?? "").slice(0, 300), ` +
                `branchTabs: [...document.querySelectorAll("#branch-tabs button")].map((b) => b.textContent), ` +
                `inputValue: (document.getElementById("term-first-question")?.value ?? "").slice(0, 120), ` +
                `busy: document.getElementById("send")?.disabled ?? null }))()`,
            );
            await deps.ctx.sidecar("response-loss-debug", snap).catch(() => {});
            throw new Error(`response-loss promote did not surface the honest conflict — snapshot sidecar response-loss-debug; original: ${err instanceof Error ? err.message : String(err)}`);
          }
        }));
        if (droppedCount !== 1) {
          throw new Error(`response-loss injection dropped ${String(droppedCount)} promote response(s) (expected exactly 1)`);
        }
        const stateAfterLoss = await deps.treeStateViaApi(deps.ctx, deps.treeId);
        deps.rangeBranchId = (stateAfterLoss?.branches ?? []).find((view) =>
          (view?.turns ?? []).some((turn) => turn?.role === "user" && typeof turn?.text === "string" && turn.text.includes(deps.TERM_MARKERS.rangeQ1)))?.branch?.id ?? null;
        if (typeof deps.rangeBranchId !== "string") {
          throw new Error("response-loss promote: the promoted branch is not in the tree state (the server did not process the request)");
        }
        if ((stateAfterLoss?.branches ?? []).length !== branchCountBefore + 1) {
          throw new Error(
            `response-loss promote changed the branch count by ${String((stateAfterLoss?.branches ?? []).length - branchCountBefore)} (must be exactly +1 — no duplicate branch)`,
          );
        }
        const rangeQ1Turns = ((stateAfterLoss?.branches ?? []).find((view) => view?.branch?.id === deps.rangeBranchId)?.turns ?? [])
          .filter((turn) => turn?.role === "user" && typeof turn?.text === "string" && turn.text.includes(deps.TERM_MARKERS.rangeQ1));
        if (rangeQ1Turns.length !== 1) {
          throw new Error(`response-loss promote: the first question landed ${String(rangeQ1Turns.length)} user turns on the promoted branch (must be exactly 1)`);
        }
        deps.record.entryVertical.range.responseLoss = {
          droppedResponses: 1,
          promotedBranchId: deps.rangeBranchId,
          branchCountDelta: 1,
          firstQuestionUserTurns: 1,
          cardSurfaced: "promotion conflict — … + saved — already promoted to … + Open the follow-up branch",
        };
        deps.record.idempotency.responseLoss = {
          mode: "range",
          injection: "CDP Fetch Response-stage failRequest on POST …/terminology/annotations/:id/promote (the server processed it fully)",
          retrySemantics: "the refreshed read model reveals the recorded promotion — the honest UI path is resume (no re-dispatch); the first question was dispatched exactly once (server fact)",
          userTurnsWithMarker: 1,
        };
        await deps.ctx.screenshot("range-response-loss-card");

        /* 恢复既有探索（.term-resume → 同一分支面板；分支数不变）。 */
        await deps.domClick(deps.ctx, "#term-explain-card .term-resume");
        await waitFor(
          deps.ctx,
          `(() => { const panel = document.getElementById("branch-panel"); ` +
            `if (panel === null || panel.hidden) return false; ` +
            `return (document.getElementById("panel-conversation").textContent ?? "").includes(${JSON.stringify(deps.TERM_MARKERS.rangeQ1)}); })()`,
          { label: "resume opens the existing promoted branch with its first question", timeoutMs: 20_000 },
        );
        const branchCountAfterResume = (await deps.treeStateViaApi(deps.ctx, deps.treeId))?.branches?.length ?? 0;
        if (branchCountAfterResume !== branchCountBefore + 1) {
          throw new Error(`resume changed the branch count (${String(branchCountAfterResume)} vs ${String(branchCountBefore + 1)})`);
        }
        deps.record.entryVertical.range.resumed = { sameBranch: true, branchCountUnchanged: true };

        /* 支线 ≥2 轮追问 + Return。 */
        await deps.panelFollowUp(deps.ctx, deps.TERM_MARKERS.rangeF1, `第一轮追问：这句话与上一句的逻辑关系是什么？（${deps.TERM_MARKERS.rangeF1}）`, deps.answerTimeoutMs, "range branch");
        await deps.panelFollowUp(deps.ctx, deps.TERM_MARKERS.rangeF2, `第二轮追问：换一个角度复述这句话。（${deps.TERM_MARKERS.rangeF2}）`, deps.answerTimeoutMs, "range branch");
        deps.record.entryVertical.range.followUps = [deps.TERM_MARKERS.rangeF1, deps.TERM_MARKERS.rangeF2];
        const rangeReturnText = `术语探索的收获（range）：划线句的主张已核对。（${deps.TERM_MARKERS.rangeRet}）`;
        const rangeCardMeta = await deps.submitTermReturn(deps.ctx, rangeReturnText, deps.TERM_MARKERS.rangeRet, "range branch return");
        const rangeMetaProblems = [];
        if (!(rangeCardMeta?.meta ?? "").includes(`anchored on “${deps.rangePick.text.slice(0, Math.min(20, deps.rangePick.text.length))}`)) {
          rangeMetaProblems.push(`source-card excerpt missing: ${JSON.stringify(rangeCardMeta?.meta)}`);
        }
        if (!(rangeCardMeta?.meta ?? "").includes("saved ")) rangeMetaProblems.push(`saved time missing: ${JSON.stringify(rangeCardMeta?.meta)}`);
        if (rangeMetaProblems.length > 0) {
          throw new Error(`range Return card mismatch — ${rangeMetaProblems.join("; ")}`);
        }
        deps.record.entryVertical.range.returned = { cardMeta: rangeCardMeta.meta, serverFromBranchId: deps.rangeBranchId };
        await deps.closePanel(deps.ctx);
      }

  return {

  };
}
