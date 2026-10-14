/** beta focus-drafts phase; the public probe retains original cleanup and output order Instance-owned state and dependencies. */
import { inputClickAt } from "../material-probes.mjs";
import { waitFor } from "../material-probes.mjs";
import { sleep } from "../material-probes.mjs";
import { materialButtonSelector } from "../material-probes.mjs";

export async function runBetaFocusDrafts(deps) {

      {
        /* 起点：面板经 tab 点击打开（此前相位的开合状态不作为前提；阅读器
           若仍开着先收起——回程从干净态开始）。 */
        const readerOpenAtStart = await deps.ctx.evalJs(`(() => { const r = document.getElementById("material-reader"); return r !== null && !r.hidden; })()`);
        if (readerOpenAtStart === true) {
          await inputClickAt(deps.ctx, "#mat-close");
          await waitFor(deps.ctx, `(() => { const r = document.getElementById("material-reader"); return r === null || r.hidden; })()`, {
            label: "reader closed before the draft round trip",
          });
        }
        await inputClickAt(deps.ctx, deps.branchTabSelector);
        await waitFor(deps.ctx, `(() => { const p = document.getElementById("branch-panel"); return p !== null && !p.hidden; })()`, {
          label: "panel open (draft round trip)",
          timeoutMs: 20_000,
        });
        /* 面板输入草稿问题（不提交）。 */
        const draftText = `草稿问题：回程后这段文字必须原样保留。（${deps.BETA_MARKERS.draft}）`;
        await inputClickAt(deps.ctx, "#panel-prompt-input");
        await deps.ctx.cdpSend("Input.insertText", { text: draftText });
        const typedDraft = await deps.ctx.evalJs(`(() => document.getElementById("panel-prompt-input").value)()`);
        if (typedDraft !== draftText) {
          throw new Error(`focusScrollDraft: the draft did not receive the typed text (got ${JSON.stringify(typedDraft)})`);
        }
        /* 面板滚动位置（离开前的记录 + 主动滚离贴底位置）。 */
        const panelScrollBefore = await deps.ctx.evalJs(
          `(() => { const pc = document.getElementById("panel-conversation"); ` +
            `pc.scrollTop = Math.max(0, Math.floor((pc.scrollHeight - pc.clientHeight) / 2)); ` +
            `return { scrollTop: pc.scrollTop, scrollHeight: pc.scrollHeight, clientHeight: pc.clientHeight }; })()`,
        );
        /* 查看来源（离开）：阅读器开于锚定块。 */
        await deps.domClick(deps.ctx, "#panel-view-source");
        await waitFor(
          deps.ctx,
          `(() => { const reader = document.getElementById("material-reader"); ` +
            `return reader !== null && !reader.hidden && ` +
            `(reader.textContent ?? "").includes("jumped to the material source of a Return — located at block ${deps.mdRange.blockId}"); })()`,
          { label: "focusScrollDraft: View source opened the reader at the anchored block", timeoutMs: 25_000 },
        );
        /* 阅读器下滚数屏（懒加载 + 滚动位置保存路径）。 */
        let topBlockAtClose = null;
        let readerScrollAtClose = null;
        for (let step = 0; step < 6; step += 1) {
          await deps.ctx.evalJs(
            `(() => { const el = document.getElementById("mat-blocks"); ` +
              `el.scrollTop = Math.min(el.scrollHeight, el.scrollTop + Math.floor(el.clientHeight * 0.85)); return true; })()`,
          );
          await sleep(350);
        }
        const closeState = await deps.ctx.evalJs(
          `(() => { const blocks = document.getElementById("mat-blocks"); ` +
            `const base = blocks.offsetTop; let first = null; ` +
            `for (const child of blocks.children) { ` +
              `if (child.dataset === undefined || child.dataset.blockId === undefined) continue; ` +
              `const blockId = child.dataset.blockId; if (first === null) first = blockId; ` +
              `const top = child.offsetTop - base; const height = child.offsetHeight; ` +
              `if (top + height > blocks.scrollTop + 1) return { topBlockAtClose: blockId, scrollTop: blocks.scrollTop, inViewBlocks: document.querySelectorAll("#mat-blocks .material-block").length }; } ` +
            `return { topBlockAtClose: first, scrollTop: blocks.scrollTop, inViewBlocks: document.querySelectorAll("#mat-blocks .material-block").length }; })()`,
        );
        if (closeState.topBlockAtClose === deps.mdRange.blockId) {
          throw new Error(`focusScrollDraft: the reader did not scroll away from the anchored block before closing (${JSON.stringify(closeState)})`);
        }
        topBlockAtClose = closeState.topBlockAtClose;
        readerScrollAtClose = closeState.scrollTop;
        /* Esc 回支线：草稿保留 + 焦点还原 + 面板滚动保留 + （重开）阅读器位置保留。 */
        await deps.pressKey(deps.ctx, "Escape", "Escape", 27);
        await waitFor(deps.ctx, `(() => { const r = document.getElementById("material-reader"); return r === null || r.hidden; })()`, {
          label: "focusScrollDraft: Escape closed the reader (back to the branch panel)",
        });
        const backState = await deps.ctx.evalJs(
          `(() => ({ panelOpen: !document.getElementById("branch-panel").hidden, ` +
            `draft: document.getElementById("panel-prompt-input").value, ` +
            `activeId: document.activeElement === null ? null : (document.activeElement.id || null), ` +
            `activeIsViewSource: document.activeElement === document.getElementById("panel-view-source"), ` +
            `panelScrollTop: document.getElementById("panel-conversation").scrollTop }))()`,
        );
        const backProblems = [];
        if (backState.panelOpen !== true) backProblems.push("the branch panel is not open after the reader closed");
        if (backState.draft !== draftText) backProblems.push(`the draft was not preserved (got ${JSON.stringify(backState.draft)})`);
        if (backState.activeIsViewSource !== true) backProblems.push(`focus was not restored to #panel-view-source (active ${JSON.stringify(backState.activeId)})`);
        if (Math.abs(backState.panelScrollTop - panelScrollBefore.scrollTop) > deps.IMMEDIATE_ARRIVAL_TOLERANCE_PX) {
          backProblems.push(`the panel scroll position changed (${String(panelScrollBefore.scrollTop)} → ${String(backState.panelScrollTop)})`);
        }
        if (backProblems.length > 0) {
          throw new Error(`focusScrollDraft: the round trip lost state — ${backProblems.join("; ")}`);
        }
        deps.focusScrollDraft.draftPreserved = true;
        deps.focusScrollDraft.draftMarker = deps.BETA_MARKERS.draft;
        deps.focusScrollDraft.focusRestoredTo = "#panel-view-source";
        deps.focusScrollDraft.panelScrollPreserved = { before: panelScrollBefore.scrollTop, after: backState.panelScrollTop };
        /* 阅读器滚动位置保留（会话内回程：应用自身的保存/恢复路径）。
           等关闭时冲刷的 reading-position PUT 落库（服务端可读回）。 */
        const materialId = deps.scenarioSetup.materialBranchOrigin.materialId;
        let savedPosition = null;
        {
          const deadline = Date.now() + 10_000;
          for (;;) {
            const detail = await deps.ctx.api("GET", `/api/trees/${encodeURIComponent(deps.scenarioSetup.treeId ?? (await deps.ctx.evalJs(`(() => document.querySelector("#tree-list button.active span")?.textContent)()`)))}/materials/${encodeURIComponent(materialId)}`);
            if (detail.status === 200 && detail.body?.readingPosition?.blockId === topBlockAtClose) {
              savedPosition = detail.body.readingPosition;
              break;
            }
            if (Date.now() >= deadline) {
              throw new Error(
                `focusScrollDraft: the reader's reading-position save did not land in 10s (expected block ${String(topBlockAtClose)}, ` +
                  `server says ${JSON.stringify(detail.body?.readingPosition?.blockId ?? null)})`,
              );
            }
            await sleep(150);
          }
        }
        /* 重开阅读器（材料列表按钮——自然的续读路径）：恢复到关闭时的保存块。 */
        await inputClickAt(deps.ctx, materialButtonSelector(materialId));
        const restored = await waitFor(
          deps.ctx,
          `(() => { const reader = document.getElementById("material-reader"); ` +
            `if (reader === null || reader.hidden) return false; ` +
            `if (!(reader.textContent ?? "").includes(${JSON.stringify(`restored to your saved reading position (block ${topBlockAtClose})`)})) return false; ` +
            `const blocks = document.getElementById("mat-blocks"); ` +
            `const block = document.querySelector('#mat-blocks [data-block-id="${topBlockAtClose}"]'); ` +
            `if (block === null) return false; ` +
            `return { scrollTop: blocks.scrollTop, blockTop: block.offsetTop - blocks.offsetTop, diff: Math.abs(blocks.scrollTop - (block.offsetTop - blocks.offsetTop)) }; })()`,
          { label: `focusScrollDraft: reopening the reader restores the saved position (block ${String(topBlockAtClose)})`,
            timeoutMs: 25_000 },
        );
        if (restored.diff > deps.IMMEDIATE_ARRIVAL_TOLERANCE_PX) {
          throw new Error(
            `focusScrollDraft: the restored scroll is not aligned to the saved block (scrollTop ${String(restored.scrollTop)} vs block top ${String(restored.blockTop)})`,
          );
        }
        deps.focusScrollDraft.readerScrollPreserved = {
          topBlockAtClose,
          scrollTopAtClose: readerScrollAtClose,
          savedPosition,
          restoredToBlock: topBlockAtClose,
          restoredDiffPx: restored.diff,
          note: "in-session round trip via the app's own reading-position save/restore path (the cross-restart scenario belongs to d4-restart-continue)",
        };
        await deps.ctx.screenshot("beta-draft-roundtrip-restored");
        await inputClickAt(deps.ctx, "#mat-close");
        await waitFor(deps.ctx, `(() => { const r = document.getElementById("material-reader"); return r === null || r.hidden; })()`, { label: "reader closed (draft phase end)" });
        await inputClickAt(deps.ctx, "#panel-close");
        await waitFor(deps.ctx, `(() => { const p = document.getElementById("branch-panel"); return p === null || p.hidden; })()`, { label: "panel closed (draft phase end)" });
      }

  return {

  };
}
