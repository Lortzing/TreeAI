/** beta keyboard phase; the public probe retains original cleanup and output order Instance-owned state and dependencies. */
import { inputClickAt } from "../material-probes.mjs";
import { materialButtonSelector } from "../material-probes.mjs";
import { waitFor } from "../material-probes.mjs";

export async function runBetaKeyboard(deps) {

      {
        /* 阅读器打开（键盘遍历要到达阅读器正文容器）。 */
        await inputClickAt(deps.ctx, materialButtonSelector(deps.scenarioSetup.materialBranchOrigin.materialId));
        await waitFor(
          deps.ctx,
          `(() => { const reader = document.getElementById("material-reader"); ` +
            `return reader !== null && !reader.hidden && document.querySelectorAll("#mat-blocks .material-block").length === 50; })()`,
          { label: "md-11 reader open (keyboard phase)", timeoutMs: 20_000 },
        );
        /* Tab 遍历（确定性口径）：先 Shift+Tab 回卷到文档起点（焦点越过首个
           可聚焦元素落回 body——起点边界），再正向 Tab 完整遍历文档序。
           起点边界后每次 Tab 必须落在元素上（无陷阱），到达阅读器正文容器
           （#mat-blocks，键盘可滚动面）为止。回卷与正向序列全程入 sidecar。 */
        await deps.ctx.evalJs(`(() => { if (document.activeElement !== null && document.activeElement !== document.body) document.activeElement.blur(); return true; })()`);
        deps.keyboard.rewindSequence = [];
        let rewindSteps = 0;
        for (; rewindSteps < 60; rewindSteps += 1) {
          await deps.pressKey(deps.ctx, "Tab", "Tab", 9, { modifiers: 8 });
          const active = await deps.ctx.evalJs(deps.ACTIVE_EL_EXPR);
          deps.keyboard.rewindSequence.push(active);
          if (active === null) break;
        }
        if (rewindSteps >= 60) {
          throw new Error(`keyboard: Shift+Tab never reached the document start boundary — rewind: ${JSON.stringify(deps.keyboard.rewindSequence)}`);
        }
        deps.keyboard.rewindSteps = rewindSteps + 1;
        const seen = new Map();
        let reachedBlocks = false;
        for (let step = 1; step <= 80; step += 1) {
          await deps.pressKey(deps.ctx, "Tab", "Tab", 9);
          const active = await deps.ctx.evalJs(deps.ACTIVE_EL_EXPR);
          deps.keyboard.sequence.push({ step, active });
          if (active === null) {
            throw new Error(
              `keyboard: Tab step ${String(step)} lost focus (activeElement is body/null — focus trap or an unfocusable surface); sequence: ${JSON.stringify(deps.keyboard.sequence)}`,
            );
          }
          const key = active.id ?? `${active.tag}.${active.cls}`;
          seen.set(key, (seen.get(key) ?? 0) + 1);
          if (active.id === "mat-blocks") { reachedBlocks = true; break; }
        }
        if (!reachedBlocks) {
          throw new Error(`keyboard: Tab traversal never reached the reader's text container (#mat-blocks) in ${String(deps.keyboard.sequence.length)} steps`);
        }
        const reached = {
          newTree: seen.has("new-tree"),
          materialImport: seen.has("material-import"),
          searchInput: seen.has("search-input"),
          readerContent: seen.has("mat-blocks"),
        };
        for (const [name, ok] of Object.entries(reached)) {
          if (ok !== true) {
            throw new Error(`keyboard: Tab traversal never reached ${name} — sequence: ${JSON.stringify(deps.keyboard.sequence)}`);
          }
        }
        deps.keyboard.tabSteps = deps.keyboard.sequence.length;
        deps.keyboard.reached = reached;
        /* 焦点保持：遍历终点仍在 #mat-blocks（无中途丢失已由逐步断言保证）。 */
        deps.keyboard.focusRetainedThroughTraversal = true;
        /* 焦点样式可见（computed style）：Tab 聚焦的 #mat-blocks + 此前途经的
           #search-input（各自重走一次聚焦，读 computed outline）。 */
        const focusStyle = async (selector) => deps.ctx.evalJs(
          `(() => { const el = document.querySelector(${JSON.stringify(selector)}); ` +
            `if (el === null) return null; el.focus(); ` +
            `const cs = getComputedStyle(el); ` +
            `return { selector: ${JSON.stringify(selector)}, outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth, ` +
              `outlineColor: cs.outlineColor, focusVisible: el.matches(":focus-visible") }; })()`,
        );
        const blocksStyle = await focusStyle("#mat-blocks");
        const searchStyle = await focusStyle("#search-input");
        const styleProblems = [];
        for (const style of [blocksStyle, searchStyle]) {
          if (style === null || style.outlineStyle === "none" || Number.parseFloat(style.outlineWidth) <= 0) {
            styleProblems.push(JSON.stringify(style));
          }
        }
        if (styleProblems.length > 0) {
          throw new Error(`keyboard: the focus indicator is not visible (computed outline) — ${styleProblems.join("; ")}`);
        }
        deps.keyboard.focusStyleVisible = { readerBlocks: blocksStyle, searchInput: searchStyle };
        /* 阅读器方向键滚动有效：焦点在 #mat-blocks 上（Tab 终点已重聚焦）。 */
        await deps.ctx.evalJs(`(() => { document.getElementById("mat-blocks").focus(); return true; })()`);
        const arrowBefore = await deps.ctx.evalJs(`(() => document.getElementById("mat-blocks").scrollTop)()`);
        for (let i = 0; i < 6; i += 1) await deps.pressKey(deps.ctx, "ArrowDown", "ArrowDown", 40);
        const arrowDown = await deps.ctx.evalJs(`(() => document.getElementById("mat-blocks").scrollTop)()`);
        for (let i = 0; i < 3; i += 1) await deps.pressKey(deps.ctx, "ArrowUp", "ArrowUp", 38);
        const arrowUp = await deps.ctx.evalJs(`(() => document.getElementById("mat-blocks").scrollTop)()`);
        if (!(arrowDown > arrowBefore)) {
          throw new Error(`keyboard: ArrowDown did not scroll the reader (${String(arrowBefore)} → ${String(arrowDown)})`);
        }
        if (!(arrowUp < arrowDown && arrowUp > 0)) {
          throw new Error(`keyboard: ArrowUp did not scroll back while staying in the material (${String(arrowDown)} → ${String(arrowUp)})`);
        }
        deps.keyboard.arrowScroll = { before: arrowBefore, afterDown: arrowDown, afterUp: arrowUp };
        /* 焦点保持在滚动/懒加载重渲之后（焦点未丢）。 */
        const activeAfterArrows = await deps.ctx.evalJs(deps.ACTIVE_EL_EXPR);
        if (activeAfterArrows?.id !== "mat-blocks") {
          throw new Error(`keyboard: focus was lost after arrow-scrolling the reader — ${JSON.stringify(activeAfterArrows)}`);
        }
        deps.keyboard.focusRetainedAfterArrowScroll = true;
        /* Enter 激活：焦点在阅读器关闭按钮上按 Enter → 阅读器关闭（button 的
           键盘激活语义）。 */
        await deps.ctx.evalJs(`(() => { document.querySelector("#material-reader .mat-close").focus(); return true; })()`);
        await deps.pressKey(deps.ctx, "Enter", "Enter", 13, { text: "\r" });
        await waitFor(deps.ctx, `(() => { const r = document.getElementById("material-reader"); return r === null || r.hidden; })()`, {
          label: "keyboard: Enter on the reader close button closes the reader",
        });
        deps.keyboard.enterActivation = "reader close button (Enter) closed the reader";
        /* Space 激活：焦点在搜索范围切换按钮上按 Space → aria-pressed 翻转。 */
        const spaceBefore = await deps.ctx.evalJs(`(() => { const b = document.getElementById("search-scope-all"); b.focus(); return b.getAttribute("aria-pressed"); })()`);
        await deps.pressKey(deps.ctx, " ", "Space", 32);
        const spaceAfter = await deps.ctx.evalJs(`(() => document.getElementById("search-scope-all").getAttribute("aria-pressed"))()`);
        if (spaceBefore === spaceAfter) {
          throw new Error(`keyboard: Space did not activate the search-scope toggle (aria-pressed ${String(spaceBefore)} unchanged)`);
        }
        await deps.pressKey(deps.ctx, " ", "Space", 32); /* 还原 */
        deps.keyboard.spaceActivation = `search-scope toggle (Space) flipped aria-pressed ${String(spaceBefore)} → ${String(spaceAfter)} → ${String(spaceBefore)}`;
        /* Escape 分层关闭 + 焦点还原：抽屉 → 阅读器 → 支线面板。 */
        const escapeLayers = [];
        const recordEscape = async (label, open, closedExpr, verifyFocusExpr, focusTargetLabel) => {
          await open();
          await deps.ctx.evalJs(`(() => { window.__betaEscapeTrace = []; window.__betaEscapeBefore = {mode:document.getElementById('main')?.dataset.workspaceView, drawerHidden:document.getElementById('source-drawer')?.hidden, flow:document.getElementById('mat-branch-flow')?.textContent}; window.__betaEscapeErrors = []; window.addEventListener('error', event => window.__betaEscapeErrors.push(event.message), {once:true}); window.addEventListener('keydown', event => { window.__betaEscapeTrace.push({phase:'capture',key:event.key,target:event.target?.id,prevented:event.defaultPrevented}); const original = event.preventDefault; event.preventDefault = function() { window.__betaEscapeTrace.push({phase:'prevent',stack:new Error().stack}); return original.call(this); }; }, {capture:true,once:true}); document.addEventListener('keydown', event => window.__betaEscapeTrace.push({phase:'bubble',key:event.key,target:event.target?.id,prevented:event.defaultPrevented}), {once:true}); return true; })()`);
          await deps.pressKey(deps.ctx, "Escape", "Escape", 27);
          try {
            await waitFor(deps.ctx, closedExpr, { label: `keyboard: Escape closed the ${label}`, timeoutMs: 10_000 });
          } catch (error) {
            await deps.ctx.screenshot(`beta-keyboard-escape-${label.replaceAll(' ', '-')}`);
            const context = await deps.ctx.evalJs(`(() => ({ route:window.__betaEscapeTrace.find(e=>e.phase==='prevent')?.stack, before:window.__betaEscapeBefore, errors:window.__betaEscapeErrors, events:window.__betaEscapeTrace, active: document.activeElement?.id, mode: document.getElementById('main')?.dataset.workspaceView, readerHidden: document.getElementById('material-reader')?.hidden, readerClass:document.getElementById('material-reader')?.className, drawerHidden: document.getElementById('source-drawer')?.hidden, flowHidden: document.getElementById('mat-branch-flow')?.hidden, dialogOpen: document.getElementById('api-settings-dialog')?.open }))()`);
            throw new Error(`${label} Escape evidence ${JSON.stringify(context)}; ${error instanceof Error ? error.message : String(error)}`);
          }
          const focusState = await deps.ctx.evalJs(
            `(() => { const a = document.activeElement; ` +
              `return { summary: a === null || a === document.body ? null : { id: a.id === "" ? null : a.id, tag: a.tagName, cls: String(a.className).slice(0, 50) }, ` +
                `ok: ${verifyFocusExpr} }; })()`,
          );
          escapeLayers.push({ layer: label, focusRestoredTo: focusTargetLabel, active: focusState.summary, ok: focusState.ok });
          if (focusState.ok !== true) {
            throw new Error(`keyboard: Escape closed the ${label} but focus was not restored to ${focusTargetLabel} — ${JSON.stringify(focusState)}`);
          }
        };
        await recordEscape(
          "source drawer",
          async () => {
            await inputClickAt(deps.ctx, "#source-drawer-toggle");
            await waitFor(deps.ctx, `(() => { const d = document.getElementById("source-drawer"); return d !== null && !d.hidden; })()`, { label: "source drawer open" });
          },
          `(() => { const d = document.getElementById("source-drawer"); return d === null || d.hidden; })()`,
          `document.activeElement === document.getElementById("source-drawer-toggle")`,
          "#source-drawer-toggle",
        );
        /* 阅读器的 Esc 焦点还原目标是打开它的材料列表按钮（materialReaderFocusReturn
           的 material-button 引用——动态按钮无 id，以落在 #material-list 内断言）。 */
        await recordEscape(
          "material reader",
          async () => {
            await inputClickAt(deps.ctx, materialButtonSelector(deps.scenarioSetup.materialBranchOrigin.materialId));
            await waitFor(
              deps.ctx,
              `(() => { const r = document.getElementById("material-reader"); return r !== null && !r.hidden && document.querySelectorAll("#mat-blocks .material-block").length > 0; })()`,
              { label: "reader reopened (keyboard escape phase)" },
            );
          },
          `(() => { const r = document.getElementById("material-reader"); return r === null || r.hidden; })()`,
          `(() => { const a = document.activeElement; return a !== null && a.closest("#material-list") !== null; })()`,
          "the material-list button that opened the reader",
        );
        /* 面板的 Esc 还原目标是打开它的分支 tab（panelFocusReturn 的 tab 引用——
           动态按钮无 id，以落在该 tab 上断言）。 */
        await recordEscape(
          "branch panel",
          async () => {
            await inputClickAt(deps.ctx, deps.branchTabSelector);
            await waitFor(deps.ctx, `(() => { const p = document.getElementById("branch-panel"); return p !== null && !p.hidden; })()`, { label: "panel reopened (keyboard escape phase)" });
          },
          `(() => { const p = document.getElementById("branch-panel"); return p === null || p.hidden; })()`,
          `(() => { const a = document.activeElement; return a !== null && a.closest(${JSON.stringify(deps.branchTabSelector)}) !== null; })()`,
          "the branch tab that opened the panel",
        );
        deps.keyboard.escapeLayers = escapeLayers;
        deps.keyboard.noFocusTrap = true;
      }

  return {

  };
}
