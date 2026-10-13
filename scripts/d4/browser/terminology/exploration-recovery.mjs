/** terminology exploration-recovery phase; the public probe retains original cleanup and output order Instance-owned state and dependencies. */
import { waitFor } from "../material-probes.mjs";

export async function runTerminologyExplorationRecovery(deps) {


      /* ============ 9) ② 已有探索恢复 + 显式另开 ============ */
      {
        /* 已有探索恢复：同批注（同选区）再进入既有支线——分支数不变。 */
        const placed = await deps.ctx.evalJs(deps.turnSelectExpr(deps.anchorTurnId, deps.termPick.start, deps.termPick.end));
        if (placed?.selectedText !== deps.termPick.text) {
          throw new Error(`recovery: term re-selection failed — ${JSON.stringify(placed)}`);
        }
        await waitFor(
          deps.ctx,
          `(() => { const bar = document.querySelector("#conversation .selection-toolbar"); ` +
            `return bar !== null && bar.querySelector(".toolbar-annotation") !== null ` +
            `&& bar.querySelector(".toolbar-annotation").textContent === "✓ Follow-up exists"; })()`,
          { label: "re-arming the promoted term offers the existing-exploration entry (✓ Follow-up exists)" },
        );
        await deps.domClick(deps.ctx, "#conversation .selection-toolbar .toolbar-annotation");
        await waitFor(
          deps.ctx,
          `(() => { const card = document.getElementById("term-explain-card"); ` +
            `return card !== null && card.querySelector(".term-resume") !== null ` +
            `&& (card.textContent ?? "").includes("already promoted to"); })()`,
          { label: "the saved annotation card shows the resume-or-create affordance" },
        );
        const branchCountBeforeResume = (await deps.treeStateViaApi(deps.ctx, deps.treeId))?.branches?.length ?? 0;
        await deps.domClick(deps.ctx, "#term-explain-card .term-resume");
        await waitFor(
          deps.ctx,
          `(() => { const panel = document.getElementById("branch-panel"); ` +
            `if (panel === null || panel.hidden) return false; ` +
            `return (document.getElementById("panel-conversation").textContent ?? "").includes(${JSON.stringify(deps.TERM_MARKERS.restartF)}); })()`,
          { label: "resume re-enters the existing exploration (its full history is present)",
          timeoutMs: 20_000 },
        );
        const branchCountAfterResume = (await deps.treeStateViaApi(deps.ctx, deps.treeId))?.branches?.length ?? 0;
        if (branchCountAfterResume !== branchCountBeforeResume) {
          throw new Error(`recovery resume changed the branch count (${String(branchCountBeforeResume)} → ${String(branchCountAfterResume)})`);
        }
        deps.record.recovery.existingExploration = {
          toolbarEntry: "✓ Follow-up exists",
          cardAffordance: "Open the follow-up branch (resume-or-create, one-per-annotation guidance shown)",
          sameBranchReentered: true,
          branchCountUnchanged: true,
          historyMarkersVisible: [deps.TERM_MARKERS.termQ1, deps.TERM_MARKERS.restartF],
        };
        await deps.closePanel(deps.ctx);

        /* 显式另开：复用通用建枝入口（⑃ Branch from selection）——新分支 +
           批注推广指向不变。 */
        const rePlaced = await deps.ctx.evalJs(deps.turnSelectExpr(deps.anchorTurnId, deps.termPick.start, deps.termPick.end));
        if (rePlaced?.selectedText !== deps.termPick.text) {
          throw new Error(`explicit-new: term re-selection failed — ${JSON.stringify(rePlaced)}`);
        }
        await deps.waitForArmedToolbar(deps.ctx, "explicit new exploration", { expectMode: "term" });
        await deps.domClick(deps.ctx, "#conversation .selection-toolbar .toolbar-branch");
        await waitFor(
          deps.ctx,
          `(() => { const panel = document.getElementById("branch-panel"); ` +
            `if (panel === null || panel.hidden) return false; ` +
            `const note = document.getElementById("panel-anchor-context"); ` +
            `return note !== null && (note.textContent ?? "").includes(${JSON.stringify(`“${deps.termPick.text}”`)}); })()`,
          { label: "the generic branch entry opened a NEW branch anchored on the same selection" },
        );
        const stateAfterOpen = await deps.treeStateViaApi(deps.ctx, deps.treeId);
        const openBranchView = (stateAfterOpen?.branches ?? []).find((view) => view?.branch?.id !== deps.termBranchId && view?.branch?.id !== deps.rangeBranchId && view?.branch?.parentBranchId !== null && view?.origin?.anchorTurnId === deps.anchorTurnId && view?.origin?.selection?.start === deps.termPick.start);
        if (openBranchView === undefined) {
          throw new Error("explicit-new: the generic branch did not land as a separate branch anchored on the same selection");
        }
        const openBranchId = openBranchView.branch.id;
        await deps.panelFollowUp(deps.ctx, deps.TERM_MARKERS.openF, `这是另开探索的首问：同一选区的另一种读法是什么？（${deps.TERM_MARKERS.openF}）`, deps.answerTimeoutMs, "explicit new branch");
        const readAfterOpen = await deps.terminologyViaApi(deps.ctx, deps.treeId);
        const termAnnotationFinal = (readAfterOpen?.annotations ?? []).find(
          (entry) => entry?.anchorTurnId === deps.anchorTurnId && entry?.selection?.start === deps.termPick.start && entry?.selection?.end === deps.termPick.end);
        if (termAnnotationFinal?.promotedBranchId !== deps.termBranchId) {
          throw new Error(`explicit-new: the annotation's promotion binding changed: ${JSON.stringify(termAnnotationFinal?.promotedBranchId)}`);
        }
        deps.record.recovery.explicitNewBranch = {
          entry: "⑃ Branch from selection (the generic W1 branch entry — never reuses an existing exploration)",
          newBranchId: openBranchId,
          distinctFrom: [deps.termBranchId, deps.rangeBranchId],
          firstPrompt: deps.TERM_MARKERS.openF,
          annotationPromotionBindingUnchanged: deps.termBranchId,
        };
        await deps.ctx.screenshot("term-explicit-new-branch");
        await deps.closePanel(deps.ctx);
      }

  return {

  };
}
