/** terminology layout phase; the public probe retains original cleanup and output order Instance-owned state and dependencies. */
import { waitFor } from "../material-probes.mjs";
import { sleep } from "../material-probes.mjs";

export async function runTerminologyLayout(deps) {


      /* ============ 7) ③ 宽 1600 / 窄 390 两档术语面可用 ============ */
      {
        const hits = {};
        /* —— 宽档（1600×900）—— */
        await deps.setViewport(deps.ctx, deps.WIDE_VIEWPORT);
        {
          const placed = await deps.ctx.evalJs(deps.turnSelectExpr(deps.anchorTurnId, deps.rangePick.start, deps.rangePick.end));
          if (placed?.selectedText !== deps.rangePick.text) throw new Error(`wide viewport: selection placement failed — ${JSON.stringify(placed)}`);
          await deps.waitForArmedToolbar(deps.ctx, "wide viewport", { expectMode: "span" });
          /* 工具条命中在开卡之前断言（解释卡打开即收束选区交互、工具条退场）。 */
          hits.wide = await deps.assertHits(deps.ctx, {
            toolbarExplain: "#conversation .selection-toolbar .toolbar-explain",
            toolbarBranch: "#conversation .selection-toolbar .toolbar-branch",
          }, "wide viewport (1600×900) armed selection toolbar");
          await deps.domClick(deps.ctx, `${deps.trunkTurnSelector(deps.anchorTurnId)} .term-annotation-mark`);
          await waitFor(deps.ctx, `(() => document.getElementById("term-explain-card") !== null)()`, { label: "wide viewport: card open" });
          await sleep(350); /* 进场动效落位 */
          hits.wideCard = await deps.assertHits(deps.ctx, {
            explainCard: "#term-explain-card",
            cardClose: "#term-explain-card .term-explain-close",
          }, "wide viewport (1600×900) term explain card");
          await deps.pressKey(deps.ctx, "Escape", "Escape", 27);
          await deps.openDrawer(deps.ctx);
          await sleep(250);
          hits.wideDrawer = await deps.assertHits(deps.ctx, {
            modeManual: deps.modeButtonSelector("manual-only"),
            modeMinimal: deps.modeButtonSelector("minimal-hints"),
            modeAssisted: deps.modeButtonSelector("assisted-reading"),
            cacheToggle: "#source-drawer .term-cache-toggle",
          }, "wide viewport (1600×900) sources drawer");
          await deps.closeDrawer(deps.ctx);
        }
        /* —— 窄档（390×844 mobile）—— */
        await deps.setViewport(deps.ctx, deps.NARROW_VIEWPORT);
        {
          const placed = await deps.ctx.evalJs(deps.turnSelectExpr(deps.anchorTurnId, deps.rangePick.start, deps.rangePick.end));
          if (placed?.selectedText !== deps.rangePick.text) throw new Error(`narrow viewport: selection placement failed — ${JSON.stringify(placed)}`);
          await deps.waitForArmedToolbar(deps.ctx, "narrow viewport", { expectMode: "span" });
          hits.narrow = await deps.assertHits(deps.ctx, {
            toolbarExplain: "#conversation .selection-toolbar .toolbar-explain",
          }, "narrow viewport (390×844 mobile) armed selection toolbar");
          const overflow = await deps.ctx.evalJs(
            `(() => ({ documentElement: document.documentElement.scrollWidth - document.documentElement.clientWidth }))()`,
          );
          if (overflow.documentElement > deps.OVERFLOW_X_TOLERANCE_PX) {
            throw new Error(`narrow viewport: horizontal overflow ${String(overflow.documentElement)}px`);
          }
          await deps.domClick(deps.ctx, `${deps.trunkTurnSelector(deps.anchorTurnId)} .term-annotation-mark`);
          await waitFor(deps.ctx, `(() => document.getElementById("term-explain-card") !== null)()`, { label: "narrow viewport: card open" });
          await sleep(350);
          hits.narrowCard = await deps.assertHits(deps.ctx, {
            explainCard: "#term-explain-card",
            cardClose: "#term-explain-card .term-explain-close",
          }, "narrow viewport (390×844 mobile) term explain card");
          await deps.pressKey(deps.ctx, "Escape", "Escape", 27);
          await deps.openDrawer(deps.ctx);
          await sleep(250);
          hits.narrowDrawer = await deps.assertHits(deps.ctx, {
            modeManual: deps.modeButtonSelector("manual-only"),
            modeMinimal: deps.modeButtonSelector("minimal-hints"),
            modeAssisted: deps.modeButtonSelector("assisted-reading"),
          }, "narrow viewport (390×844 mobile) sources drawer");
          await deps.closeDrawer(deps.ctx);
        }
        deps.record.frontendInvariants.wideNarrow = {
          wide: `${String(deps.WIDE_VIEWPORT.width)}×${String(deps.WIDE_VIEWPORT.height)}`,
          narrow: `${String(deps.NARROW_VIEWPORT.width)}×${String(deps.NARROW_VIEWPORT.height)} (mobile)`,
          hits,
          narrowHorizontalOverflowPx: 0,
        };
        await deps.ctx.screenshot("term-narrow-viewport");
        /* 还原缺省视口（重启相位的就位断言按桌面布局度量）。 */
        await deps.setViewport(deps.ctx, deps.DEFAULT_VIEWPORT);
      }

  return {

  };
}
