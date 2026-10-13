/** Navigation virtualization phase with original assertions and caller cleanup Instance-owned state and dependencies. */
import { openTreeUnmeasured } from "./operations.mjs";
import { B9_WIDE_TREE_ID } from "../../../../apps/studio/src/nav/b9-dataset.ts";
import { waitFor } from "../material-probes.mjs";
import { scrollRowIntoWindow } from "./input.mjs";
import { rowSelector } from "./settlement.mjs";
import { ROW_HEIGHT } from "./policy.mjs";
import { sleep } from "../material-probes.mjs";
import { B9_BIG_TREE_ID } from "../../../../apps/studio/src/nav/b9-dataset.ts";

export async function runNavVirtualization(deps) {

      {
        /* b9-wide 重开（上一相结束于 b9-deep）+ 全量装入（滚动到底触发按需续页）。 */
        await openTreeUnmeasured(deps.ctx, B9_WIDE_TREE_ID);
        await waitFor(deps.ctx, `(() => document.querySelector("#nav-tree .nav-item") !== null)()`, { label: "wide tree first rows" });
        await scrollRowIntoWindow(deps.ctx, rowSelector(deps.wideChildren[deps.wideChildren.length - 1].id), { timeoutMs: 30_000 });
        const wideTotal = 1 + deps.wideChildren.length; /* trunk + 220 子枝 */
        for (const offset of [0, 30, 80, 140, 200]) {
          await deps.ctx.evalJs(`(() => { const scroller = document.getElementById("nav-tree-scroll"); scroller.scrollTop = ${String(offset * ROW_HEIGHT)}; return true; })()`);
          await sleep(200);
          const sample = await deps.ctx.evalJs(
            `(() => { const rows = [...document.querySelectorAll("#nav-tree .nav-item")]; ` +
              `return { domRows: rows.length, first: rows.length > 0 && rows[0].dataset.branchId ? rows[0].dataset.branchId : null, ` +
                `status: document.getElementById("nav-tree-status").textContent ?? "" }; })()`,
          );
          deps.virtualization.samples.push({ scrollTopPx: offset * ROW_HEIGHT, ...sample });
          if (sample.domRows > deps.domRowLimit) {
            throw new Error(
              `virtualization violated at scrollTop ${String(offset * ROW_HEIGHT)}: ${String(sample.domRows)} DOM rows > ${String(deps.domRowLimit)} ` +
                `(window ${String(deps.scrollerHeight)}px / ${String(ROW_HEIGHT)}px row height + overscan; loaded sibling rows: ${String(wideTotal)})`,
            );
          }
        }
        const statusText = deps.virtualization.samples[deps.virtualization.samples.length - 1].status;
        const match = /rendering (\d+)\/(\d+) visible rows/.exec(statusText);
        if (match === null || Number(match[2]) !== wideTotal) {
          throw new Error(
            `the wide tree's visible-row total does not reflect all ${String(wideTotal)} loaded rows: ${JSON.stringify(statusText)}`,
          );
        }
        deps.virtualization.wideTotalRows = wideTotal;
        const distinctFirst = new Set(deps.virtualization.samples.map((s) => s.first));
        if (distinctFirst.size < 3) {
          throw new Error(
            `the rendered window did not move with scrolling (first row stable across offsets: ${JSON.stringify([...distinctFirst])})`,
          );
        }
        const anyFull = deps.virtualization.samples.some((s) => s.domRows >= wideTotal);
        if (anyFull) {
          throw new Error("the DOM carries the full sibling list (virtualization absent)");
        }
        /* b9-big：展开集合在场的可见行远小于 5000 节点。 */
        await openTreeUnmeasured(deps.ctx, B9_BIG_TREE_ID);
        await sleep(500);
        const bigSample = await deps.ctx.evalJs(
          `(() => { const status = document.getElementById("nav-tree-status").textContent ?? ""; ` +
            `const match = /rendering (\\d+)\\/(\\d+) visible rows/.exec(status); ` +
            `return { domRows: document.querySelectorAll("#nav-tree .nav-item").length, rendered: match === null ? null : Number(match[1]), total: match === null ? null : Number(match[2]) }; })()`,
        );
        if (bigSample.domRows > deps.domRowLimit) {
          throw new Error(`b9-big DOM rows ${String(bigSample.domRows)} > ${String(deps.domRowLimit)} (virtualization violated)`);
        }
        if (bigSample.total === null || bigSample.total > deps.big.nodes.length) {
          throw new Error(`b9-big visible-row total ${JSON.stringify(bigSample)} exceeds the tree (dataset shape changed?)`);
        }
        deps.virtualization.bigRendered = bigSample;
      }

  return {

  };
}
