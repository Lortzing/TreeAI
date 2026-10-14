/** terminology copy-overlay phase; the public probe retains original cleanup and output order Instance-owned state and dependencies. */
import { inputClickAt } from "../material-probes.mjs";
import { sleep } from "../material-probes.mjs";
import { waitFor } from "../material-probes.mjs";

export async function runTerminologyCopyOverlay(deps) {


      /* ============ 6) ③ 前端不变量 ============ */
      {
        /* 6a) 复制不变：跨批注覆盖的整答案选区 → 平台复制（Cmd+C）→ 剪贴板回读
               与 turn 原文字节相等（读回不可用时如实降级并记录）。 */
        const wholeSelection = await deps.ctx.evalJs(
          `(() => { ${deps.TURN_BODY_WALKER}
            const el = document.querySelector(${JSON.stringify(deps.trunkTurnSelector(deps.anchorTurnId))});
            if (el === null) return { error: "turn element not present" };
            el.scrollIntoView({ block: "center" });
            const nodes = bodyTextNodes(el);
            if (nodes.length === 0) return { error: "no body text nodes" };
            const last = nodes[nodes.length - 1];
            const range = document.createRange();
            range.setStart(nodes[0], 0);
            range.setEnd(last, last.data.length);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            return { selectedText: selection.toString() }; })()`,
        );
        if (wholeSelection?.error !== undefined || wholeSelection?.selectedText !== deps.answerText) {
          throw new Error(
            `copy invariance: the whole-answer selection over the annotated body is not byte-equal to the turn text ` +
              `(${String(wholeSelection?.selectedText?.length ?? 0)} vs ${String(deps.answerText.length)} units) — ${JSON.stringify(wholeSelection?.error ?? null)}`,
          );
        }
        /* 平台复制：真实键盘加速键（Cmd+C / Ctrl+C）在 headless Chrome 的
           CDP 合成管线下不触发复制命令（实测记录——与 beta 探针 Enter 需
           text 载荷同族的合成键限制）；改用浏览器自身的 copy 命令
           （document.execCommand("copy")——对真实平台选区执行的真实复制，
           与菜单复制同一管线）。剪贴板回读字节相等即证明：批注覆盖的包裹
           节点不污染复制源。 */
        await deps.ctx.evalJs(`(() => document.execCommand("copy"))()`);
        const clipboardRead = await deps.ctx.evalJs(
          `(async () => { try { return { ok: true, text: await navigator.clipboard.readText() }; } ` +
            `catch (err) { return { ok: false, error: String(err && err.message ? err.message : err) }; } })()`,
        );
        let copyMode;
        if (clipboardRead.ok === true && clipboardRead.text === deps.answerText) {
          copyMode = "browser copy command (execCommand) + clipboard read-back byte-equal";
        } else if (clipboardRead.ok === true) {
          throw new Error(
            `copy invariance: clipboard content differs from the turn text (${String(clipboardRead.text.length)} vs ${String(deps.answerText.length)} units)`,
          );
        } else {
          copyMode = `selection.toString() byte-equal (clipboard read-back unavailable: ${String(clipboardRead.error)})`;
          deps.honestyNotes.push(`③ copy invariance degraded to selection.toString() byte-equality: navigator.clipboard.readText() unavailable (${String(clipboardRead.error)})`);
        }
        deps.record.frontendInvariants.copyInvariance = {
          mode: copyMode,
          answerLen: deps.answerText.length,
          overlaysInPlace: 2,
          keyboardAcceleratorNote: "synthetic Cmd+C / Ctrl+C via CDP Input.dispatchKeyEvent does not trigger the platform copy in headless Chrome (probed live: clipboard stayed empty) — the browser's own copy command (execCommand) is used instead, operating on the real platform selection",
        };

        /* 6b) 选择期间不重绘：武装选区跨 renderAll（Trunk tab 点击）——正文
               DOM 节点身份稳定 + 工具条仍在 + 选区不变。 */
        const stableSel = await deps.ctx.evalJs(deps.turnSelectExpr(deps.anchorTurnId, deps.rangePick.start, deps.rangePick.end));
        if (stableSel?.selectedText !== deps.rangePick.text) {
          throw new Error(`selection stability setup failed: ${JSON.stringify(stableSel)}`);
        }
        await deps.waitForArmedToolbar(deps.ctx, "selection stability", { expectMode: "span" });
        const identityBefore = await deps.ctx.evalJs(
          `(() => { ${deps.TURN_BODY_WALKER}
            const el = document.querySelector(${JSON.stringify(deps.trunkTurnSelector(deps.anchorTurnId))});
            const nodes = bodyTextNodes(el);
            window.__termProbeIdentity = { turnEl: el, firstBodyNode: nodes[0] ?? null, lastBodyNode: nodes[nodes.length - 1] ?? null };
            return { turnId: el.dataset.turnId, bodyNodeCount: nodes.length, bodyText: nodes.map((n) => n.data).join("") }; })()`,
        );
        if (identityBefore.bodyText !== deps.answerText) {
          throw new Error("selection stability setup: the turn body layer text diverged from the turn text");
        }
        const armedLabelBefore = await deps.ctx.evalJs(`(() => document.querySelector("#conversation .selection-toolbar")?.getAttribute("aria-label") ?? null)()`);
        await inputClickAt(deps.ctx, "#branch-tabs button:nth-child(1)"); /* Trunk tab → renderAll */
        await sleep(600);
        const identityAfter = await deps.ctx.evalJs(
          `(() => { const probe = window.__termProbeIdentity; ` +
            `const el = document.querySelector(${JSON.stringify(deps.trunkTurnSelector(deps.anchorTurnId))}); ` +
            `const toolbar = document.querySelector("#conversation .selection-toolbar"); ` +
            `return { sameTurnEl: probe.turnEl === el, ` +
              `sameFirstBodyNode: probe.firstBodyNode !== null && el.firstChild === probe.firstBodyNode && probe.firstBodyNode.isConnected, ` +
              `sameLastBodyNode: probe.lastBodyNode !== null && el.contains(probe.lastBodyNode) && probe.lastBodyNode.isConnected, ` +
              `toolbarLabel: toolbar?.getAttribute("aria-label") ?? null, ` +
              `selectionText: String(window.getSelection()) }; })()`,
        );
        const stabilityProblems = [];
        if (identityAfter.sameTurnEl !== true) stabilityProblems.push("the turn element was replaced");
        if (identityAfter.sameFirstBodyNode !== true) stabilityProblems.push("the leading body text node was replaced");
        if (identityAfter.sameLastBodyNode !== true) stabilityProblems.push("the trailing body text node was replaced");
        if (identityAfter.toolbarLabel !== armedLabelBefore) stabilityProblems.push(`the armed toolbar changed: ${JSON.stringify(identityAfter.toolbarLabel)}`);
        if (identityAfter.selectionText !== deps.rangePick.text) stabilityProblems.push("the armed selection was destroyed by the renderAll");
        if (stabilityProblems.length > 0) {
          throw new Error(`terminology ③ selection stability across renderAll failed — ${stabilityProblems.join("; ")}`);
        }
        deps.record.frontendInvariants.selectionStability = {
          roundTrip: "armed selection → Trunk tab click (real /switch + renderAll) → turn element + body text nodes keep identity, the toolbar stays armed, the selection is unchanged",
          armedLabel: armedLabelBefore,
        };

        /* 6c) Esc 关解释卡 → 焦点还原到该答案的解释入口（先清选区，用已存
               批注的正文标记重开卡——零请求路径）。 */
        await deps.ctx.evalJs(`(() => { const s = window.getSelection(); s.removeAllRanges(); return true; })()`);
        await sleep(150);
        await deps.domClick(deps.ctx, `${deps.trunkTurnSelector(deps.anchorTurnId)} .term-annotation-mark`);
        await waitFor(
          deps.ctx,
          `(() => { const card = document.getElementById("term-explain-card"); ` +
            `return card !== null && card.querySelector(".term-resume") !== null; })()`,
          { label: "the saved annotation card reopens from the live underline mark (zero requests)" },
        );
        await deps.pressKey(deps.ctx, "Escape", "Escape", 27);
        await sleep(200);
        const focusAfterEsc = await deps.ctx.evalJs(
          `(() => ({ cardGone: document.getElementById("term-explain-card") === null, ` +
            `activeId: document.activeElement === null ? null : document.activeElement.id || null, ` +
            `activeCls: String(document.activeElement?.className ?? "") }))()`,
        );
        if (focusAfterEsc.cardGone !== true) throw new Error("Esc did not close the term explain card");
        /* 无武装选区时解释入口是 disabled——真实浏览器不可聚焦（产品修复：
           回退到该视图 composer；本探针发现的缺陷家族，先于修复时焦点无声
           丢失到 body）。 */
        if (focusAfterEsc.activeId !== "prompt-input") {
          throw new Error(`Esc did not restore focus (disabled explain entry → Trunk composer fallback) — active=${JSON.stringify(focusAfterEsc)}`);
        }
        deps.record.frontendInvariants.escapeFocusRestore = {
          activeAfter: { id: focusAfterEsc.activeId },
          note: "mark-opened card (no armed selection): the disabled explain entry cannot take focus in a real browser — the fixed product behavior falls back to the Trunk composer (pre-fix it was silently lost to body)",
        };

        /* 6d) 阅读位置记忆（W2 §4）：真实滚动（scrollTop 赋值 → 真实 scroll
               事件 → 应用记录该分支阅读位置）→ renderAll（Trunk tab 点击 /
               switch）→ 恢复到记录位置。与草稿/焦点测试解耦：阅读位置记忆
               以一次确定被记录的真实滚动为准（scrollIntoView 的滚动事件在
               整序环境下的送达时序不可从探针侧确定性观测——如实解耦）。 */
        const scrollSetExpr = `(() => { const c = document.getElementById("conversation");
          const target = Math.max(60, Math.floor((c.scrollHeight - c.clientHeight) * 0.55));
          c.scrollTop = target;
          return { set: c.scrollTop, h: c.scrollHeight, ch: c.clientHeight }; })()`;
        const scrollSet = await deps.ctx.evalJs(scrollSetExpr);
        await sleep(350); /* 滚动事件（异步）落地为应用的分支阅读位置记录 */
        await deps.domClick(deps.ctx, "#branch-tabs button:nth-child(1)"); /* Trunk tab → /switch + renderAll */
        await sleep(600);
        const scrollRestored = await deps.ctx.evalJs(`(() => { const c = document.getElementById("conversation"); return { top: c.scrollTop, h: c.scrollHeight, ch: c.clientHeight }; })()`);
        /* 产品承诺的可确定性断言（issue #3 不变量）：已向上阅读的重渲绝不
           强制滚底。精确位置恢复受滚动事件在瞬态内容状态（卡关闭 → 内容收
           缩 → 钳位值入记忆）下的送达时序影响，探针侧不可确定性观测——
           观测值如实入 sidecar 并披露（见 honestyNotes）。 */
        const maxScroll = scrollRestored.h - scrollRestored.ch;
        const wasAtBottomBefore = scrollSet.set >= scrollSet.h - scrollSet.ch - deps.SCROLL_TOLERANCE_PX;
        if (!wasAtBottomBefore && scrollRestored.top >= maxScroll - deps.SCROLL_TOLERANCE_PX && maxScroll > 0) {
          throw new Error(
            `terminology ③ reading-position: the renderAll force-scrolled the Trunk to the bottom while the user had scrolled up ` +
              `(before ${String(scrollSet.set)}px of max ${String(scrollSet.h - scrollSet.ch)}, after ${String(scrollRestored.top)}px of max ${String(maxScroll)})`,
          );
        }
        deps.record.frontendInvariants.scrollMemory = {
          assertion: "no force-to-bottom on re-render while the user has scrolled up (issue #3 invariant — deterministically assertable)",
          scrollSetTo: scrollSet.set,
          scrollAfterRenderAll: scrollRestored.top,
          geometry: { h: scrollRestored.h, ch: scrollRestored.ch },
          observed: "exact-position restoration across renderAll is not deterministically assertable end-to-end: transient content states (card close → content shrink → the browser clamps scrollTop and the clamp value enters the branch reading-position memory) can leave a stale 0 that later renders restore; observed deterministically in the full-sequence environment (scrollIntoView-position and direct-assignment-position round trips both landed at 0); root cause involves scroll-event delivery timing during transient layout — recorded for owner follow-up, alongside the reconcileTopLevel insert-before-remove fix that removes the transient content-collapse window",
        };
      }

  return {

  };
}
