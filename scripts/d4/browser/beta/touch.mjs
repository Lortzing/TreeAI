/** beta touch phase; the public probe retains original cleanup and output order Instance-owned state and dependencies. */
import { waitFor } from "../material-probes.mjs";
import { materialButtonSelector } from "../material-probes.mjs";
import { sleep } from "../material-probes.mjs";
import { waitForArmedBar } from "../material-probes.mjs";
import { inputClickAt } from "../material-probes.mjs";

export async function runBetaTouch(deps) {

      {
        await deps.setViewport(deps.ctx, deps.NARROW_VIEWPORT);
        /* tap 开侧栏抽屉。 */
        const toggleRect = await deps.ctx.evalJs(
          `(() => { const b = document.getElementById("sidebar-toggle"); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
        );
        await deps.tapAt(toggleRect.x, toggleRect.y);
        await waitFor(
          deps.ctx,
          `(() => document.body.classList.contains("sidebar-open") && getComputedStyle(document.getElementById("sidebar")).visibility === "visible")()`,
          { label: "touch: tap opens the sidebar drawer", timeoutMs: 10_000 },
        );
        await deps.waitForDrawerSettled(deps.ctx);
        /* tap 打开材料阅读（md-11）。 */
        const mdBtn = await deps.ctx.evalJs(
          `(() => { const b = document.querySelector(${JSON.stringify(materialButtonSelector(deps.scenarioSetup.materialBranchOrigin.materialId))}); ` +
            `const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
        );
        await deps.tapAt(mdBtn.x, mdBtn.y);
        await waitFor(
          deps.ctx,
          `(() => { const reader = document.getElementById("material-reader"); ` +
            `return reader !== null && !reader.hidden && !document.body.classList.contains("sidebar-open") ` +
            `&& document.querySelectorAll("#mat-blocks .material-block").length === 50; })()`,
          { label: "touch: tap on the material opens the reader (drawer dismisses)", timeoutMs: 20_000 },
        );
        await deps.waitForDrawerDismissed(deps.ctx);
        deps.touch.tapOpenedReader = true;
        /* swipe 滚动阅读器。 */
        const beforeSwipe = await deps.ctx.evalJs(`(() => document.getElementById("mat-blocks").scrollTop)()`);
        await deps.swipeAt({ x: 195, y: 620, dy: -420, dx: 0, steps: 8 });
        await sleep(400);
        const afterSwipe = await deps.ctx.evalJs(`(() => document.getElementById("mat-blocks").scrollTop)()`);
        if (!(afterSwipe > beforeSwipe + 50)) {
          throw new Error(`touch: the swipe did not scroll the reader (${String(beforeSwipe)} → ${String(afterSwipe)})`);
        }
        deps.touch.swipeScrolledPx = Math.round(afterSwipe - beforeSwipe);
        /* 换到 pdf-01（tap 材料按钮；抽屉开→选材料→收起）。 */
        await deps.tapAt(toggleRect.x, toggleRect.y);
        await waitFor(deps.ctx, `(() => document.body.classList.contains("sidebar-open"))()`, { label: "touch: drawer reopens (pdf phase)" });
        await deps.waitForDrawerSettled(deps.ctx);
        const pdfMaterialId = await deps.ctx.evalJs(
          `(() => { for (const b of document.querySelectorAll("#material-list button[data-material-id]")) { ` +
            `if ((b.querySelector(".material-meta")?.textContent ?? "").includes("pdf")) return b.dataset.materialId; } return null; })()`,
        );
        if (typeof pdfMaterialId !== "string") throw new Error("touch: no pdf material in the sidebar");
        const pdfBtn = await deps.ctx.evalJs(
          `(() => { const b = document.querySelector(${JSON.stringify(materialButtonSelector(pdfMaterialId))}); ` +
            `const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
        );
        await deps.tapAt(pdfBtn.x, pdfBtn.y);
        await waitFor(
          deps.ctx,
          `(() => { const reader = document.getElementById("material-reader"); ` +
            `return reader !== null && !reader.hidden && !document.body.classList.contains("sidebar-open") ` +
            `&& document.querySelectorAll("#mat-blocks .pdf-page-frame").length === ${String(deps.pdfFixture.truth.blocks.length)}; })()`,
          { label: "touch: tap on pdf-01 switches the reader (all page frames)", timeoutMs: 25_000 },
        );
        await deps.waitForDrawerDismissed(deps.ctx);
        /* 第 2 页滚入视口 + 文本层渲染（可见页先行）。 */
        await deps.ctx.evalJs(
          `(() => { const frames = [...document.querySelectorAll("#mat-blocks .pdf-page-frame")]; ` +
            `const target = frames.find((f) => f.dataset.blockId === ${JSON.stringify(deps.pdfRange.blockId)}); ` +
            `if (target === undefined) return false; target.scrollIntoView({ block: "center" }); return true; })()`,
        );
        await waitFor(
          deps.ctx,
          `(() => (document.querySelector(${JSON.stringify(`#mat-blocks .pdf-page-text[data-block-id="${deps.pdfRange.blockId}"]`)})?.dataset.rendered ?? null) === "true")()`,
          { label: "touch: the pdf page text layer renders as it scrolls into view",
            timeoutMs: 15_000 },
        );
        /* 长按实测（如实记录）：headless Chrome 153 的原生长按不合成持久选区
           （只取坐标置监听，不置位选区——长按后 selectionchange 计数与终选区
           如实入 sidecar）。 */
        {
          /* 只取坐标（不置位）：长按目标词中心。 */
          const point = await deps.ctx.evalJs(
            `(() => { const layer = document.querySelector(${JSON.stringify(`#mat-blocks .pdf-page-text[data-block-id="${deps.pdfRange.blockId}"]`)}); ` +
              `const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT); ` +
              `const n = walker.nextNode(); if (n === null) return null; ` +
              `const range = document.createRange(); range.setStart(n, 4); range.setEnd(n, 12); ` +
              `const r = range.getBoundingClientRect(); ` +
              `window.__betaTouchSelCount = 0; ` +
              `document.addEventListener("selectionchange", () => { window.__betaTouchSelCount += 1; }); ` +
              `return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`,
          );
          await deps.ctx.cdpSend("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: point.x, y: point.y, id: 1 }] });
          await sleep(900);
          await deps.ctx.cdpSend("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          await sleep(500);
          const longPressResult = await deps.ctx.evalJs(
            `(() => ({ selectionChangeEvents: window.__betaTouchSelCount, selectionText: String(window.getSelection()) }))()`,
          );
          deps.touch.longPressProbe = { target: point, result: longPressResult, synthesizedPersistedSelection: longPressResult.selectionText.length > 0 };
        }
        /* 文本层上拖选武装捕获条（app 的触路径：selectionchange 武装——
           选区在触摸手势进行中建立，全程零鼠标事件）。 */
        deps.touchStats.dragSelects += 1;
        const drag = await deps.touchDragSelect(deps.ctx, deps.pdfLayerSelectExpr(deps.pdfRange.blockId, deps.pdfRange.start, deps.pdfRange.end));
        if (drag.placed.selectedText !== deps.pdfRange.excerpt || drag.stillSelected !== deps.pdfRange.excerpt) {
          throw new Error(
            `touch: the in-gesture selection on the pdf text layer did not hold — placed ${JSON.stringify(drag.placed.selectedText)}, at touchEnd ${JSON.stringify(drag.stillSelected)}, want ${JSON.stringify(deps.pdfRange.excerpt)}`,
          );
        }
        let bar;
        try {
          bar = await waitForArmedBar(deps.ctx, "touch pdf-01 selection", 6000);
        } catch (error) {
          const diagnostic = await deps.ctx.evalJs(`(() => {
            const s = window.getSelection(), r = s && s.rangeCount ? s.getRangeAt(0) : null;
            const frame = document.querySelector("#mat-blocks .pdf-page-frame");
            return { selectionText: s?.toString() ?? null, rangeText: r?.toString() ?? null,
              collapsed: r?.collapsed ?? null, anchor: r?.startContainer?.parentElement?.className ?? null,
              focus: r?.endContainer?.parentElement?.className ?? null,
              readerOpen: !document.getElementById("material-reader")?.hidden,
              pdfFrames: document.querySelectorAll("#mat-blocks .pdf-page-frame").length };
          })()`);
          throw new Error(`touch pdf-01 selection: duringArmed=${String(drag.barDuring.payload !== null)}, afterReleaseLen=${String(drag.afterRelease.length)}, heldLen=${String(drag.stillSelected.length)}, placedLen=${String(drag.placed.selectedText.length)}; ${String(error)}; native diagnostic ${JSON.stringify(diagnostic)}`);
        }
        if (bar.payload === null) {
          throw new Error(`touch: the capture bar did not arm with a payload — ${JSON.stringify(bar)}`);
        }
        if (!bar.payload.includes(`block ${deps.pdfRange.blockId}`) || !bar.payload.includes("page 2")) {
          throw new Error(`touch: the armed payload does not carry the pdf block/page — ${JSON.stringify(bar.payload)}`);
        }
        if (bar.quote !== deps.pdfRange.excerpt) {
          throw new Error(`touch: the armed quote differs from the planned excerpt — ${JSON.stringify(bar.quote)}`);
        }
        deps.touch.selectionArmedViaTouch = true;
        deps.touch.armedPayload = bar.payload;
        deps.touch.armedDuringGesture = { zeroMouseEvents: true, path: "selectionchange arming (the app's touch path)" };
        /* tap 工具条按钮（复制）：剪贴板回读字节相等。 */
        await deps.ctx.cdpSend("Browser.grantPermissions", { origin: deps.ctx.studioOrigin(), permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
        const copyRect = await deps.ctx.evalJs(
          `(() => { const b = document.querySelector("#mat-selection-bar .mat-copy"); ` +
            `if (b === null) return null; const r = b.getBoundingClientRect(); ` +
            `if (r.width <= 0 || r.height <= 0) return null; return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
        );
        if (copyRect === null) throw new Error("touch: the capture bar copy button has no box (not visible)");
        await deps.tapAt(copyRect.x, copyRect.y);
        const copyState = await waitFor(
          deps.ctx,
          `(() => { const btn = document.querySelector("#mat-selection-bar .mat-copy"); ` +
            `return btn !== null && btn.textContent === "Copied ✓" ? { label: btn.textContent } : false; })()`,
          { label: "touch: tap on Copy shows the Copied ✓ confirmation", timeoutMs: 5000 },
        );
        const clip = await deps.ctx.evalJs(
          `(async () => { try { return { ok: true, text: await navigator.clipboard.readText() }; } ` +
            `catch (err) { return { ok: false, error: String(err && err.message ? err.message : err) }; } })()`,
        );
        if (clip.ok === true) {
          if (clip.text !== deps.pdfRange.excerpt) {
            throw new Error(`touch: the clipboard content differs from the excerpt (got ${JSON.stringify(clip.text.slice(0, 40))}…)`);
          }
          deps.touch.toolbarButtonTapped = true;
          deps.touch.copyVerification = "clipboard read-back byte-equal";
        } else {
          /* 诚实降级：确认态已验证 + 摘录与冻结真值一致（剪贴板读回不可用）。 */
          deps.touch.toolbarButtonTapped = true;
          deps.touch.copyVerification = `copy-confirmed (Copied ✓ shown; clipboard read-back unavailable: ${String(clip.error)})`;
        }
        deps.touch.copyLabel = copyState.label;
        /* 收尾：解除选区、关阅读器、还原视口。 */
        await deps.ctx.evalJs(`(() => { window.getSelection().removeAllRanges(); return true; })()`);
        await sleep(250);
        await inputClickAt(deps.ctx, "#mat-close");
        await waitFor(deps.ctx, `(() => { const r = document.getElementById("material-reader"); return r === null || r.hidden; })()`, { label: "reader closed (touch phase)" });
        await deps.setViewport(deps.ctx, deps.DEFAULT_VIEWPORT);
        deps.touch.taps = deps.touchStats.taps;
        deps.touch.swipes = deps.touchStats.swipes;
        deps.touch.dragSelects = deps.touchStats.dragSelects;
      }

  return {

  };
}
