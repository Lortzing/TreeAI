/** terminology reading-modes phase; the public probe retains original cleanup and output order Instance-owned state and dependencies. */
import { inputClickAt } from "../material-probes.mjs";
import { waitFor } from "../material-probes.mjs";

export async function runTerminologyReadingModes(deps) {


      /* ============ 1) ① 阅读模式面 ============ */
      {
        await deps.openDrawer(deps.ctx);
        const drawerInfo = await deps.ctx.evalJs(
          `(() => { const drawer = document.getElementById("source-drawer"); ` +
            `const buttons = [...drawer.querySelectorAll(".term-mode-row .term-mode-toggle")]; ` +
            `return { labels: buttons.map((b) => b.textContent), pressed: buttons.map((b) => b.getAttribute("aria-pressed")), ` +
              `gateNote: [...drawer.querySelectorAll("p.muted")].some((p) => p.textContent.includes(${JSON.stringify(deps.GATE_NOTE_SNIPPET)})), ` +
              `usageLine: (drawer.querySelector(".term-cache-line") !== null), ` +
              `annotationsNote: drawer.textContent.includes("no saved term annotations yet") }; })()`,
        );
        const problems = [];
        if (JSON.stringify(drawerInfo.labels) !== JSON.stringify(["Manual only", "Minimal hints", "Assisted reading"])) {
          problems.push(`mode buttons: ${JSON.stringify(drawerInfo.labels)}`);
        }
        if (drawerInfo.pressed[0] !== "true" || drawerInfo.pressed[1] !== "false" || drawerInfo.pressed[2] !== "false") {
          problems.push(`default pressed states: ${JSON.stringify(drawerInfo.pressed)} (manual-only must be the default)`);
        }
        if (drawerInfo.gateNote !== true) {
          problems.push("the quality-gate-pending honest note is not present in the drawer");
        }
        if (problems.length > 0) {
          throw new Error(`terminology ① reading-mode drawer mismatch — ${problems.join("; ")}`);
        }
        deps.record.readingModes.drawer = {
          labels: drawerInfo.labels,
          defaultPressed: "manual-only",
          gateNotePresent: true,
          gateNoteText: `「…${deps.GATE_NOTE_SNIPPET}…」(TERMINOLOGY_AUTO_QUALITY_GATE=false — the production default, asserted as-is)`,
        };
        await deps.ctx.screenshot("term-drawer-modes");

        /* 三选一真实切换（PUT 载荷观测 + 服务端回读 + pressed 迁移）。 */
        const switches = [];
        for (const mode of ["minimal-hints", "assisted-reading", "manual-only"]) {
          const { observed } = await deps.withObservedRequests(deps.ctx, "*settings/reading-mode*", async () => {
            await inputClickAt(deps.ctx, deps.modeButtonSelector(mode));
            await waitFor(
              deps.ctx,
              `(() => { const b = document.querySelector(${JSON.stringify(deps.modeButtonSelector(mode))}); ` +
                `return b !== null && b.getAttribute("aria-pressed") === "true"; })()`,
              { label: `reading mode ${mode} becomes pressed`, timeoutMs: 10_000 },
            );
          });
          const puts = observed.filter((entry) => entry.method === "PUT");
          if (puts.length !== 1) {
            throw new Error(`reading-mode switch to ${mode}: expected exactly 1 PUT, observed ${JSON.stringify(observed)}`);
          }
          if (puts[0].postData !== JSON.stringify({ mode })) {
            throw new Error(`reading-mode PUT payload mismatch for ${mode}: ${JSON.stringify(puts[0].postData)}`);
          }
          const serverMode = await deps.readingModeViaApi(deps.ctx, deps.treeId);
          if (serverMode !== mode) {
            throw new Error(`server reading-mode readback after switching to ${mode}: ${JSON.stringify(serverMode)}`);
          }
          switches.push({ mode, putPayload: puts[0].postData, serverReadback: serverMode });
        }
        deps.record.readingModes.switches = switches;
        await deps.closeDrawer(deps.ctx);
      }

  return {

  };
}
