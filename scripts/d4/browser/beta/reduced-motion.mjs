/** beta reduced-motion phase; the public probe retains original cleanup and output order Instance-owned state and dependencies. */
import { inputClickAt } from "../material-probes.mjs";
import { waitFor } from "../material-probes.mjs";
import { sleep } from "../material-probes.mjs";

export async function runBetaReducedMotion(deps) {

      {
        /* 面板重开（贴底跟随的载体）。 */
        await inputClickAt(deps.ctx, deps.branchTabSelector);
        await waitFor(deps.ctx, `(() => { const p = document.getElementById("branch-panel"); return p !== null && !p.hidden; })()`, {
          label: "panel open (reduced-motion phase)",
          timeoutMs: 20_000,
        });
        /* 贴底跟随的对照测量（无 reduce，如实记录——不设平滑断言）。 */
        const instrumentStick = () => deps.ctx.evalJs(
          `(() => { window.__betaStick = { atMutation: null, frames: [] }; ` +
            `const pc = document.getElementById("panel-conversation"); ` +
            `const mo = new MutationObserver(() => { ` +
              `if (window.__betaStick.atMutation === null) { ` +
                `window.__betaStick.atMutation = { scrollTop: pc.scrollTop, bottom: pc.scrollHeight - pc.clientHeight, t: Number(performance.now().toFixed(1)) }; } }); ` +
            `mo.observe(pc, { childList: true, subtree: true }); ` +
            `window.__betaStickMo = mo; ` +
            `const rec = () => { ` +
              `window.__betaStick.frames.push({ t: Number(performance.now().toFixed(1)), top: pc.scrollTop, bottom: pc.scrollHeight - pc.clientHeight }); ` +
              `if (window.__betaStick.frames.length < 30) requestAnimationFrame(rec); }; ` +
            `requestAnimationFrame(rec); return true; })()`,
        );
        const readStick = () => deps.ctx.evalJs(
          `(() => { if (window.__betaStickMo) window.__betaStickMo.disconnect(); ` +
            `const probe = window.__betaStick; ` +
            `return { atMutation: probe.atMutation, frames: probe.frames, ` +
              `settledTop: document.getElementById("panel-conversation").scrollTop, ` +
              `settledBottom: document.getElementById("panel-conversation").scrollHeight - document.getElementById("panel-conversation").clientHeight }; })()`,
        );
        const panelFollowUp = async (marker, text) => {
          /* 贴底跟随只在用户本就贴底时发生（issue #3）——先把面板会话滚到底，
             后续断言的才是「新内容到达时的跟随」路径。 */
          await deps.ctx.evalJs(`(() => { const pc = document.getElementById("panel-conversation"); pc.scrollTop = pc.scrollHeight; return true; })()`);
          await sleep(150);
          await inputClickAt(deps.ctx, "#panel-prompt-input");
          await deps.ctx.cdpSend("Input.insertText", { text: `追问：${text}（${marker}）` });
          await inputClickAt(deps.ctx, "#panel-send");
          await waitFor(
            deps.ctx,
            `(() => { const conv = document.getElementById("panel-conversation"); ` +
              `const turns = [...conv.querySelectorAll(".turn")]; ` +
              `const q = turns.findIndex((t) => (t.textContent ?? "").includes(${JSON.stringify(marker)})); ` +
              `if (q < 0) return false; ` +
              `return turns.slice(q + 1).some((t) => t.classList.contains("assistant") && (t.textContent ?? "").trim().length > 0); })()`,
            { label: `follow-up ${marker} landed (reduced-motion phase)`, timeoutMs: deps.answerTimeoutMs },
          );
        };
        await instrumentStick();
        await panelFollowUp(deps.BETA_MARKERS.fControl, "贴底跟随的对照测量");
        await sleep(500);
        deps.reducedMotion.controlStickToBottom = await readStick();

        /* reduce 开启：页面 matchMedia 为真。 */
        await deps.ctx.cdpSend("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
        await sleep(250);
        const matched = await deps.ctx.evalJs(`(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches)()`);
        if (matched !== true) {
          throw new Error("reducedMotion: page matchMedia('(prefers-reduced-motion: reduce)') is false after the emulation was set");
        }
        deps.reducedMotion.matched = true;
        /* 贴底跟随在 reduce 下即时落位。口径（charter B7 行「终位置一帧内
           到达」）：首个变更微任务时刻已在终位；其后至多一帧的过渡（流式
           增量写入与跟随滚动分属相邻任务——平滑滚动则会呈现多帧在途）。 */
        await instrumentStick();
        await panelFollowUp(deps.BETA_MARKERS.fReduce, "reduce 下的即时落位");
        await sleep(500);
        const reduceStick = await readStick();
        const stickProblems = [];
        if (reduceStick.atMutation === null) {
          stickProblems.push("no mutation was observed on the panel conversation");
        } else if (reduceStick.atMutation.scrollTop < reduceStick.atMutation.bottom - deps.IMMEDIATE_ARRIVAL_TOLERANCE_PX) {
          stickProblems.push(
            `at the mutation instant the panel was still in transit (scrollTop ${String(reduceStick.atMutation.scrollTop)} < bottom ${String(reduceStick.atMutation.bottom)} — smooth scroll in flight under reduce)`,
          );
        }
        const transitRunOf = (frames) => {
          let best = 0;
          let run = 0;
          for (const f of frames) {
            if (f.top < f.bottom - deps.IMMEDIATE_ARRIVAL_TOLERANCE_PX) { run += 1; best = Math.max(best, run); }
            else run = 0;
          }
          return best;
        };
        const reduceFrames = reduceStick.frames ?? [];
        const transitFrames = reduceFrames.filter((f) => f.top < f.bottom - deps.IMMEDIATE_ARRIVAL_TOLERANCE_PX);
        reduceStick.transitFrameCount = transitFrames.length;
        reduceStick.maxConsecutiveTransitFrames = transitRunOf(reduceFrames);
        if (transitRunOf(reduceFrames) > 1) {
          stickProblems.push(
            `the scroll stayed in transit for ${String(transitRunOf(reduceFrames))} consecutive frames after the mutation (smooth animation in flight under reduce; transit frames: ${JSON.stringify(transitFrames.slice(0, 4))})`,
          );
        }
        if (Math.abs((reduceStick.settledTop ?? -1) - (reduceStick.settledBottom ?? -2)) > deps.IMMEDIATE_ARRIVAL_TOLERANCE_PX) {
          stickProblems.push(`the settled position is not the bottom (top ${String(reduceStick.settledTop)} vs bottom ${String(reduceStick.settledBottom)})`);
        }
        if (stickProblems.length > 0) {
          throw new Error(`reducedMotion: the stick-to-bottom scroll was not immediate under reduce — ${stickProblems.join("; ")}`);
        }
        deps.reducedMotion.stickToBottomUnderReduce = reduceStick;
        deps.reducedMotion.immediateArrival = true;

        /* 定位跳转：面板 ⌖ View source → 阅读器开于锚定块。断言即时落位：
           锚定块进入 DOM 的微任务时刻 scrollTop 已是终位（scrollIntoView 与
           渲染同一同步块）+ 到位之后的帧不再位移（加载期帧不计数——阅读器
           打开是异步 detail/分页过程）。 */
        await deps.ctx.evalJs(
          `(() => { window.__betaJump = { arrival: null, frames: [] }; ` +
            `const mo = new MutationObserver(() => { ` +
              `const block = document.querySelector('#mat-blocks [data-block-id="${deps.mdRange.blockId}"]'); ` +
              `if (block !== null && window.__betaJump.arrival === null) { ` +
                `window.__betaJump.arrival = { t: Number(performance.now().toFixed(1)), scrollTop: document.getElementById("mat-blocks").scrollTop }; } }); ` +
            `mo.observe(document.getElementById("material-reader"), { childList: true, subtree: true }); ` +
            `window.__betaJumpMo = mo; ` +
            `const rec = () => { ` +
              `window.__betaJump.frames.push({ t: Number(performance.now().toFixed(1)), top: document.getElementById("mat-blocks") === null ? null : document.getElementById("mat-blocks").scrollTop, ` +
                `blockPresent: document.querySelector('#mat-blocks [data-block-id="${deps.mdRange.blockId}"]') !== null }); ` +
              `if (window.__betaJump.frames.length < 40) requestAnimationFrame(rec); }; ` +
            `requestAnimationFrame(rec); return true; })()`,
        );
        await deps.domClick(deps.ctx, "#panel-view-source");
        const jumpSettled = await waitFor(
          deps.ctx,
          `(() => { const reader = document.getElementById("material-reader"); ` +
            `if (reader === null || reader.hidden) return false; ` +
            `const block = document.querySelector('#mat-blocks [data-block-id="${deps.mdRange.blockId}"]'); ` +
            `if (block === null) return false; ` +
            `return (reader.textContent ?? "").includes("jumped to the material source of a Return — located at block ${deps.mdRange.blockId}"); })()`,
          { label: "reducedMotion: View source opened the reader at the anchored block", timeoutMs: 25_000 },
        );
        if (jumpSettled !== true) throw new Error("reducedMotion: the anchored block never settled");
        const jump = await deps.ctx.evalJs(
          `(() => { if (window.__betaJumpMo) window.__betaJumpMo.disconnect(); ` +
            `const blocks = document.getElementById("mat-blocks"); ` +
            `const block = document.querySelector('#mat-blocks [data-block-id="${deps.mdRange.blockId}"]'); ` +
            `const blockTop = block.offsetTop - blocks.offsetTop; ` +
            `return { ...window.__betaJump, finalTop: blocks.scrollTop, blockTop, diff: Math.abs(blocks.scrollTop - blockTop) }; })()`,
        );
        const jumpProblems = [];
        if (jump.arrival === null) jumpProblems.push("the anchored block's arrival was never observed during the jump");
        if (jump.diff > deps.IMMEDIATE_ARRIVAL_TOLERANCE_PX) {
          jumpProblems.push(`the reader did not land with the anchored block at the top (scrollTop ${String(jump.finalTop)} vs block top ${String(jump.blockTop)}, diff ${String(jump.diff)}px)`);
        }
        if (jump.arrival !== null && Math.abs(jump.arrival.scrollTop - jump.blockTop) > deps.IMMEDIATE_ARRIVAL_TOLERANCE_PX) {
          jumpProblems.push(
            `at the anchored block's arrival instant the reader was not yet at the final position (scrollTop ${String(jump.arrival.scrollTop)} vs block top ${String(jump.blockTop)} — smooth scroll in flight under reduce)`,
          );
        }
        const movingFramesAfterArrival = (jump.frames ?? []).filter(
          (f) => f.blockPresent === true && f.t >= (jump.arrival?.t ?? Infinity) && Math.abs((f.top ?? -1) - jump.finalTop) > deps.IMMEDIATE_ARRIVAL_TOLERANCE_PX,
        );
        if (movingFramesAfterArrival.length > 0) {
          jumpProblems.push(`${String(movingFramesAfterArrival.length)} post-arrival frames show an in-transit scroll position after the jump`);
        }
        if (jumpProblems.length > 0) {
          throw new Error(`reducedMotion: the View-source positioning jump was not immediate under reduce — ${jumpProblems.join("; ")}`);
        }
        deps.reducedMotion.viewSourceJump = { anchoredBlock: deps.mdRange.blockId, arrival: jump.arrival, finalTop: jump.finalTop, blockTop: jump.blockTop, diffPx: jump.diff, frames: jump.frames };
        /* 清除模拟（还原），并断言回落的真实性。 */
        await deps.ctx.cdpSend("Emulation.setEmulatedMedia", { features: [] });
        await sleep(250);
        const matchedAfterReset = await deps.ctx.evalJs(`(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches)()`);
        if (matchedAfterReset !== false) {
          throw new Error("reducedMotion: the emulated media did not reset (matchMedia still true after clearing)");
        }
        deps.reducedMotion.emulationResetVerified = true;
      }

  return {

  };
}
