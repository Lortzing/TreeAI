/** Navigation restart phase with original assertions and caller cleanup Instance-owned state and dependencies. */
import { scrollRowIntoWindow } from "./input.mjs";
import { rowSelector } from "./settlement.mjs";
import { armWaiterExpr } from "./settlement.mjs";
import { settleSelect } from "./settlement.mjs";
import { navRowDomClickWithFallback } from "./input.mjs";
import { awaitWaiter } from "./settlement.mjs";
import { B9_DEEP_TREE_ID } from "../../../../apps/studio/src/nav/b9-dataset.ts";
import { sleep } from "../material-probes.mjs";
import { waitFor } from "../material-probes.mjs";
import { openTreeUnmeasured } from "./operations.mjs";
import { assertSelectedRowRendered } from "./settlement.mjs";

export async function runNavRestart(deps) {

      {
        /* 保存一组确定性的展开集合 + 选中（b9-deep：c020 选中——键盘相后当前
           选中仍是 c010，换节点才有真实的选中操作）。 */
        await scrollRowIntoWindow(deps.ctx, rowSelector("b9-deep-c020"));
        await deps.ctx.evalJs(armWaiterExpr(settleSelect("b9-deep-c020")));
        await navRowDomClickWithFallback(deps.ctx, `${rowSelector("b9-deep-c020")} .nav-label`);
        await awaitWaiter(deps.ctx, "select:b9-deep-c020 (pre-restart)", 15_000);
        const readExpandState = async () => {
          const res = await deps.ctx.api("GET", `/api/nav/trees/${B9_DEEP_TREE_ID}/expand-state`);
          if (res.status !== 200) throw new Error(`expand-state GET HTTP ${String(res.status)}`);
          return res.body?.expandState ?? res.body;
        };
        /* 整组 PUT 是应用自身路径（异步串行队列）：等待它落地（服务端读到新选中）。 */
        {
          const deadline = Date.now() + 10_000;
          for (;;) {
            const state = await readExpandState();
            if (state.selectedBranchId === "b9-deep-c020") break;
            if (Date.now() >= deadline) {
              throw new Error(`the reader's expand-state PUT did not land in 10s (selected ${JSON.stringify(state.selectedBranchId)})`);
            }
            await sleep(120);
          }
        }
        deps.restart.before = await readExpandState();
        const oldPort = deps.ctx.studioPort();
        await deps.ctx.stopStudio();
        await deps.ctx.navigate("about:blank");
        const newUrl = await deps.ctx.bootStudioOn(deps.dataDir);
        await deps.ctx.navigate(newUrl);
        await waitFor(deps.ctx, `(() => document.querySelector("#tree-view, #empty-state, #new-tree") !== null)()`, { label: "shell after nav restart" });
        deps.restart.after = await readExpandState();
        if (
          deps.restart.after.selectedBranchId !== deps.restart.before.selectedBranchId ||
          JSON.stringify([...(deps.restart.after.expandedBranchIds ?? [])].sort()) !==
            JSON.stringify([...(deps.restart.before.expandedBranchIds ?? [])].sort())
        ) {
          throw new Error(
            `expand state did not survive the real process restart: before ${JSON.stringify(deps.restart.before)} after ${JSON.stringify(deps.restart.after)}`,
          );
        }
        /* UI 恢复：重开 b9-deep → 保存的选中行恢复 + 展开集合在场（状态行总数）。 */
        await openTreeUnmeasured(deps.ctx, B9_DEEP_TREE_ID);
        /* UI 恢复：重开 b9-deep → 保存的选中恢复（路径行落定）+ 展开集合在场；
           选中行的 .active 渲染断言经精确滚入（选中行可在窗口外——已知现象）。 */
        await waitFor(
          deps.ctx,
          `(() => { const heading = document.getElementById("nav-path-heading").textContent ?? ""; ` +
            `const steps = document.querySelectorAll("#nav-path .nav-path-step"); ` +
            `if (!heading.includes("完整路径")) return false; ` +
            `if (steps.length === 0) return false; ` +
            `if (steps[steps.length - 1].dataset.branchId !== "b9-deep-c020") return false; ` +
            `const status = document.getElementById("nav-tree-status").textContent ?? ""; ` +
            `return status.includes("visible rows"); })()`,
          { label: "saved selection + expansion restored in the UI after the restart", timeoutMs: 30_000 },
        ).catch(async (err) => {
          const snap = await deps.ctx.evalJs(
            `(() => ({ heading: (document.getElementById("nav-path-heading").textContent ?? "").slice(0, 100), ` +
              `status: (document.getElementById("nav-tree-status").textContent ?? "").slice(0, 160), ` +
              `title: (document.getElementById("nav-tree-title").textContent ?? "").slice(0, 60), ` +
              `note: (document.getElementById("nav-tree-find-note").textContent ?? "").slice(0, 80), ` +
              `steps: [...document.querySelectorAll("#nav-path .nav-path-step")].map((b) => b.title).slice(-2) }))()`,
          );
          throw new Error(`restore-after-restart assertion failed — snapshot: ${JSON.stringify(snap)}; original: ${err instanceof Error ? err.message : String(err)}`);
        });
        await assertSelectedRowRendered(deps.ctx, "b9-deep-c020", deps.mirror, B9_DEEP_TREE_ID);
        deps.restart.oldPort = oldPort;
        deps.restart.newPort = deps.ctx.studioPort();
        deps.restart.selectedRestored = deps.restart.after.selectedBranchId;
        deps.restart.expandedCount = (deps.restart.after.expandedBranchIds ?? []).length;
      }

  return {

  };
}
