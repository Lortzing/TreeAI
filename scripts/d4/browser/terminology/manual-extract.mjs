/** terminology manual-extract phase; the public probe retains original cleanup and output order Instance-owned state and dependencies. */
import { inputClickAt } from "../material-probes.mjs";
import { waitFor } from "../material-probes.mjs";

export async function runTerminologyManualExtract(deps) {

      {
        await deps.openDrawer(deps.ctx);
        const { observed } = await deps.withObservedRequests(deps.ctx, "*settings/reading-mode*", async () => {
          await inputClickAt(deps.ctx, deps.modeButtonSelector("minimal-hints"));
          await waitFor(
            deps.ctx,
            `(() => document.querySelector(${JSON.stringify(deps.modeButtonSelector("minimal-hints"))})?.getAttribute("aria-pressed") === "true")()`,
            { label: "reading mode minimal-hints becomes pressed", timeoutMs: 10_000 },
          );
        });
        const puts = observed.filter((entry) => entry.method === "PUT");
        if (puts.length !== 1 || puts[0].postData !== JSON.stringify({ mode: "minimal-hints" })) {
          throw new Error(`minimal-hints switch PUT observation mismatch: ${JSON.stringify(observed)}`);
        }
        await deps.closeDrawer(deps.ctx);
        const { answerTurn: a2 } = await deps.sendTrunkPrompt(deps.ctx, deps.treeId, deps.TRUNK_Q2, {
          timeoutMs: deps.answerTimeoutMs,
          label: "trunk Q2 (minimal-hints phase — the terminology anchor answer)",
        });
        const read = await deps.terminologyViaApi(deps.ctx, deps.treeId);
        const stripAbsent = await deps.ctx.evalJs(`(() => document.querySelector("#conversation .term-suggest-strip") === null)()`);
        const sessionFiles = deps.terminologySessionFiles(deps.dataDir);
        const problems = [];
        if ((read?.tasks ?? []).length !== 0) problems.push(`tasks: ${JSON.stringify(read?.tasks)}`);
        if (read?.usage?.total?.requests !== 0) problems.push(`usage requests: ${JSON.stringify(read?.usage?.total)}`);
        if (read?.autoSuggestions?.enabled !== false || read?.autoSuggestions?.reason !== "quality-gate-pending") {
          problems.push(`autoSuggestions: ${JSON.stringify(read?.autoSuggestions)}`);
        }
        if ((read?.autoSuggestions?.sets ?? []).length !== 0) problems.push(`suggestion sets: ${JSON.stringify(read?.autoSuggestions?.sets)}`);
        if (stripAbsent !== true) problems.push("a .term-suggest-strip rendered under minimal-hints");
        if (sessionFiles !== null && sessionFiles.length !== 0) problems.push(`terminology session files: ${JSON.stringify(sessionFiles)}`);
        if (problems.length > 0) {
          throw new Error(`terminology ① minimal-hints zero-auto-dispatch violated — ${problems.join("; ")}`);
        }
        if (a2.text.trim().length < 40) {
          throw new Error(
            `terminology ② anchor answer too short for term/range selections (${String(a2.text.length)} units) — ${deps.modeNote}`,
          );
        }
        deps.answerText = a2.text;
        deps.anchorTurnId = a2.id;
        deps.record.readingModes.minimalHintsZeroDispatch = {
          mode: "minimal-hints",
          putPayload: puts[0].postData,
          anchorAnswerLen: deps.answerText.length,
          tasks: 0,
          usageRequests: 0,
          suggestionSets: 0,
          stripRendered: false,
          isolatedExecutorSessionFiles: 0,
          reason: "quality-gate-pending",
          note: "the production gate is OFF by design (TERMINOLOGY_AUTO_QUALITY_GATE=false): zero auto dispatch after a completed answer IS the tested semantics, not a probe limitation",
        };
        /* 建议 chip 预填/确认路径：gate 关闭下建议集恒空、chip 永不出现——
           如实披露（绝不改产品 gate 让建议出现）。 */
        deps.record.readingModes.suggestionChipPrefill = {
          exercisable: false,
          reason:
            "TERMINOLOGY_AUTO_QUALITY_GATE=false in production — no suggestion set is ever produced (sets always []), so the chip → pre-fill → explicit-confirm path cannot be exercised without changing the product gate (forbidden by the probe charter); the four honest strip states (pending/terminal or gate-off note) reduce to the gate-off drawer note + no strip, both asserted",
        };
        deps.honestyNotes.push(
          "① suggestion chip pre-fill/confirm-before-dispatch is NOT exercised: the production quality gate is OFF, suggestion sets are structurally empty, and the probe must not enable the gate to make chips appear",
        );
      }

  return {

  };
}
