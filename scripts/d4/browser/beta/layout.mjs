/** beta layout phase; the public probe retains original cleanup and output order Instance-owned state and dependencies. */
import { inputClickAt } from "../material-probes.mjs";
import { materialButtonSelector } from "../material-probes.mjs";
import { waitFor } from "../material-probes.mjs";
import { pageSelectCanonical } from "../material-probes.mjs";
import { waitForArmedBar } from "../material-probes.mjs";
import { sleep } from "../material-probes.mjs";

export async function runBetaLayout(deps) {

      {
        /* —— 宽档（≥1440px）—— */
        await deps.setViewport(deps.ctx, deps.WIDE_VIEWPORT);
        const wideViewport = await deps.ctx.evalJs(`(() => ({ w: window.innerWidth, h: window.innerHeight }))()`);
        if (wideViewport.w < 1440) throw new Error(`wide viewport is ${String(wideViewport.w)}px (< 1440 required)`);
        const wideOverflow = await deps.assertNoHorizontalOverflow(deps.ctx, "wide viewport");
        const wideHits = await deps.assertHits(
          deps.ctx,
          {
            newTree: "#new-tree",
            materialImport: "#material-import",
            searchInput: "#search-input",
            treeRow: "#tree-list button.active",
            branchTab: deps.branchTabSelector,
          },
          "wide viewport",
        );
        /* 阅读器两档可用：打开 md-11（真实点击）→ 块渲染 + 无横向溢出。 */
        await inputClickAt(deps.ctx, materialButtonSelector(deps.scenarioSetup.materialBranchOrigin.materialId));
        await waitFor(
          deps.ctx,
          `(() => { const reader = document.getElementById("material-reader"); ` +
            `return reader !== null && !reader.hidden && document.querySelectorAll("#mat-blocks .material-block").length === 50; })()`,
          { label: "md-11 reader usable at the wide viewport", timeoutMs: 20_000 },
        );
        await deps.assertNoHorizontalOverflow(deps.ctx, "wide viewport with the reader open");
        /* 捕获条可达：武装选区 → 捕获条按钮 elementFromPoint 命中。 */
        const placedWide = await deps.ctx.evalJs(pageSelectCanonical(deps.mdRange.blockId, deps.mdRange.start, deps.mdRange.end));
        if (placedWide?.selectedText !== deps.mdRange.excerpt) {
          throw new Error(`wide viewport: selection placement failed — ${JSON.stringify(placedWide)}`);
        }
        await waitForArmedBar(deps.ctx, "beta wide-viewport selection", 6000);
        const wideBarHits = await deps.assertHits(
          deps.ctx,
          { copy: "#mat-selection-bar .mat-copy", branch: "#mat-selection-bar .mat-branch-d43" },
          "wide viewport capture bar",
        );
        /* 关阅读器后再测支线面板（≥1180px 阅读器与面板同列，阅读器 z-index
           在上——面板命中测试须在阅读器收起后）。 */
        await inputClickAt(deps.ctx, "#mat-close");
        await waitFor(deps.ctx, `(() => { const r = document.getElementById("material-reader"); return r === null || r.hidden; })()`, { label: "reader closed (wide, before the panel test)" });
        /* 支线面板两档可用：tab 点击打开 → 输入框命中 → 收起。 */
        await inputClickAt(deps.ctx, deps.branchTabSelector);
        await waitFor(deps.ctx, `(() => { const p = document.getElementById("branch-panel"); return p !== null && !p.hidden; })()`, {
          label: "branch panel opens at the wide viewport (tab click)",
          timeoutMs: 20_000,
        });
        await deps.assertHits(deps.ctx, { panelInput: "#panel-prompt-input", panelViewSource: "#panel-view-source" }, "wide viewport branch panel");
        await deps.assertNoHorizontalOverflow(deps.ctx, "wide viewport with the panel open");
        await inputClickAt(deps.ctx, "#panel-close");
        await waitFor(deps.ctx, `(() => { const p = document.getElementById("branch-panel"); return p === null || p.hidden; })()`, { label: "panel closed (wide)" });
        deps.wideNarrow.wide = {
          widthPx: wideViewport.w,
          heightPx: wideViewport.h,
          overflowX: wideOverflow,
          hits: wideHits,
          captureBarHits: wideBarHits,
          readerUsable: true,
          panelUsable: true,
        };

        /* —— 窄档（~390×844，mobile 触屏视口）—— */
        await deps.setViewport(deps.ctx, deps.NARROW_VIEWPORT);
        const narrowViewport = await deps.ctx.evalJs(`(() => ({ w: window.innerWidth, h: window.innerHeight }))()`);
        if (narrowViewport.w > 400 || narrowViewport.w < 380) {
          throw new Error(`narrow viewport is ${String(narrowViewport.w)}px (expected ~390)`);
        }
        const narrowState = await deps.ctx.evalJs(
          `(() => ({ toggleVisible: getComputedStyle(document.getElementById("sidebar-toggle")).display !== "none", ` +
            `sidebarDrawerHidden: getComputedStyle(document.getElementById("sidebar")).visibility === "hidden", bodyClass: document.body.className, libraryOpen: document.getElementById("workspace-library").open, active: document.activeElement?.id }))()`,
        );
        if (narrowState.toggleVisible !== true || narrowState.sidebarDrawerHidden !== true) {
          throw new Error(`narrow viewport: the sidebar drawer is not in its closed state — ${JSON.stringify(narrowState)}`);
        }
        const narrowOverflowClosed = await deps.assertNoHorizontalOverflow(deps.ctx, "narrow viewport (drawer closed)");
        /* 抽屉开合（真实点击 #sidebar-toggle）。 */
        await inputClickAt(deps.ctx, "#sidebar-toggle");
        await waitFor(
          deps.ctx,
          `(() => document.body.classList.contains("sidebar-open") && getComputedStyle(document.getElementById("sidebar")).visibility === "visible")()`,
          { label: "narrow viewport: the sidebar drawer opens via the toggle", timeoutMs: 10_000 },
        );
        await deps.waitForDrawerSettled(deps.ctx);
        const narrowHits = await deps.assertHits(
          deps.ctx,
          {
            newTree: "#new-tree",
            materialImport: "#material-import",
            searchInput: "#search-input",
            treeRow: "#tree-list button.active",
            branchTab: deps.branchTabSelector,
          },
          "narrow viewport (drawer open)",
        );
        await deps.assertNoHorizontalOverflow(deps.ctx, "narrow viewport (drawer open)");
        /* 阅读器两档可用：抽屉内点击材料 → 阅读器全幅可用（选材料收抽屉是产品纪律）。 */
        await inputClickAt(deps.ctx, materialButtonSelector(deps.scenarioSetup.materialBranchOrigin.materialId));
        await waitFor(
          deps.ctx,
          `(() => { const reader = document.getElementById("material-reader"); ` +
            `return reader !== null && !reader.hidden && !document.body.classList.contains("sidebar-open") ` +
            `&& document.querySelectorAll("#mat-blocks .material-block").length === 50; })()`,
          { label: "narrow viewport: the reader opens full-width and the drawer dismisses (material select)",
            timeoutMs: 20_000 },
        );
        await deps.waitForDrawerDismissed(deps.ctx);
        await deps.assertNoHorizontalOverflow(deps.ctx, "narrow viewport with the reader open");
        /* 捕获条可达（窄档）。 */
        const placedNarrow = await deps.ctx.evalJs(pageSelectCanonical(deps.mdRange.blockId, deps.mdRange.start, deps.mdRange.end));
        if (placedNarrow?.selectedText !== deps.mdRange.excerpt) {
          throw new Error(`narrow viewport: selection placement failed — ${JSON.stringify(placedNarrow)}`);
        }
        await waitForArmedBar(deps.ctx, "beta narrow-viewport selection", 6000);
        const narrowBarHits = await deps.assertHits(deps.ctx, { copy: "#mat-selection-bar .mat-copy" }, "narrow viewport capture bar");
        await deps.ctx.evalJs(`(() => { window.getSelection().removeAllRanges(); return true; })()`);
        await sleep(250);
        await inputClickAt(deps.ctx, "#mat-close");
        await waitFor(deps.ctx, `(() => { const r = document.getElementById("material-reader"); return r === null || r.hidden; })()`, { label: "reader closed (narrow)" });
        /* 支线面板两档可用：抽屉开 → tab 点击 → 面板开（抽屉按产品纪律收起）。 */
        await inputClickAt(deps.ctx, "#sidebar-toggle");
        await waitFor(deps.ctx, `(() => document.body.classList.contains("sidebar-open"))()`, { label: "drawer reopens (narrow panel phase)" });
        await deps.waitForDrawerSettled(deps.ctx);
        await inputClickAt(deps.ctx, deps.branchTabSelector);
        await waitFor(
          deps.ctx,
          `(() => { const p = document.getElementById("branch-panel"); ` +
            `return p !== null && !p.hidden && !document.body.classList.contains("sidebar-open"); })()`,
          { label: "narrow viewport: the branch panel opens and the drawer dismisses (branch tab select)",
            timeoutMs: 20_000 },
        );
        await deps.waitForDrawerDismissed(deps.ctx);
        await deps.assertHits(deps.ctx, { panelInput: "#panel-prompt-input", panelViewSource: "#panel-view-source" }, "narrow viewport branch panel");
        await deps.assertNoHorizontalOverflow(deps.ctx, "narrow viewport with the panel open");
        await inputClickAt(deps.ctx, "#panel-close");
        await waitFor(deps.ctx, `(() => { const p = document.getElementById("branch-panel"); return p === null || p.hidden; })()`, { label: "panel closed (narrow)" });
        deps.wideNarrow.narrow = {
          widthPx: narrowViewport.w,
          heightPx: narrowViewport.h,
          mobileViewport: true,
          drawerOpensViaToggle: true,
          overflowX: narrowOverflowClosed,
          hits: narrowHits,
          captureBarHits: narrowBarHits,
          readerUsable: true,
          panelUsable: true,
        };
        /* 还原缺省视口（后续相位的基准）。 */
        await deps.setViewport(deps.ctx, deps.DEFAULT_VIEWPORT);
      }

  return {

  };
}
