/** D4 B6 browser scroll/typing probe, extracted without changing the frozen budgets or input path. */
import { sleep, waitFor, inputClickAt, switchTreeInUi, materialButtonSelector } from "./material-probes.mjs";
import { timingStats, fmt } from "./scale-measurements.mjs";

/** Pure B6 browser responsiveness verdict; frozen limits are supplied by the caller. */
export function classifyB6Responsiveness(raw, { mainThreadSegmentLimitMs, keystrokeP95LimitMs }) {
  const MAIN_THREAD_SEGMENT_LIMIT_MS = mainThreadSegmentLimitMs;
  const KEYSTROKE_P95_LIMIT_MS = keystrokeP95LimitMs;
  const stepStats = timingStats(raw.steps);
  const keyStats = timingStats(raw.keys.map((k) => k.keydownToRender).filter((v) => v !== null));
  const worstTask = raw.longTasks.reduce((max, task) => Math.max(max, task.duration), 0);
  const problems = [];
  if (worstTask > MAIN_THREAD_SEGMENT_LIMIT_MS) {
    problems.push(`a ${fmt(worstTask)}ms main-thread segment occurred while paging (limit ${String(MAIN_THREAD_SEGMENT_LIMIT_MS)}ms)`);
  }
  if (stepStats.p95Ms > MAIN_THREAD_SEGMENT_LIMIT_MS) {
    problems.push(`scroll step-to-frame p95 ${fmt(stepStats.p95Ms)}ms > ${String(MAIN_THREAD_SEGMENT_LIMIT_MS)}ms`);
  }
  if (keyStats.count < 10) {
    problems.push(`only ${String(keyStats.count)} keystrokes measured during the paging loop`);
  } else if (keyStats.p95Ms > KEYSTROKE_P95_LIMIT_MS) {
    problems.push(`keystroke-to-render p95 ${fmt(keyStats.p95Ms)}ms > ${String(KEYSTROKE_P95_LIMIT_MS)}ms while paging`);
  }
  return { stepStats, keyStats, worstTask, problems };
}

export async function measureB6Responsiveness(ctx, dataset, environment, { mainThreadSegmentLimitMs, keystrokeP95LimitMs }) {
  const MAIN_THREAD_SEGMENT_LIMIT_MS = mainThreadSegmentLimitMs;
  const KEYSTROKE_P95_LIMIT_MS = keystrokeP95LimitMs;
    const responsiveness = {};
    {
      /* 监视器安装：longtask 观察器 + 键入计时（keydown → 落值 → 下一帧）。 */
      await ctx.evalJs(
        `(() => { window.__b6Scroll = { longTasks: [], steps: [], keys: [], startedAt: performance.now() }; ` +
          `new PerformanceObserver((list) => { for (const entry of list.getEntries()) ` +
          `window.__b6Scroll.longTasks.push({ startTime: Number(entry.startTime.toFixed(1)), duration: Number(entry.duration.toFixed(1)) }); ` +
          `}).observe({ entryTypes: ["longtask"] }); ` +
          `const input = document.getElementById("search-input"); ` +
          `input.addEventListener("keydown", () => { window.__b6Scroll.keys.push({ tKey: performance.now() }); }, { capture: true }); ` +
          `input.addEventListener("input", () => { const entries = window.__b6Scroll.keys; const entry = entries[entries.length - 1]; ` +
          `if (entry === undefined || entry.tInput !== undefined) return; entry.tInput = performance.now(); ` +
          `requestAnimationFrame(() => { entry.tPaint = performance.now(); }); }, { capture: true }); ` +
          `return true; })()`,
      );
      /* 翻页驱动：每步真实 scrollTop 写入（scroll 事件驱动应用自身的懒加载
         与 PDF 可见页渲染），步延迟 = 写入 → 下一帧；每两步在 Search 输入框
         真实键入一字（keydown 事件，真实输入管线）。 */
      const typedChars = "b6-input-responsiveness-probe-0123456789";
      const pageThrough = async (materialIndex, steps) => {
        const material = dataset.materials[materialIndex];
        await switchTreeInUi(ctx, material.treeId);
        await waitFor(
          ctx,
          `(() => document.querySelector(${JSON.stringify(materialButtonSelector(material.materialId))}) !== null)()`,
          { label: `material ${material.materialId} listed (scroll phase)` },
        );
        await inputClickAt(ctx, materialButtonSelector(material.materialId));
        await waitFor(
          ctx,
          `(() => { const reader = document.getElementById("material-reader"); return reader !== null && !reader.hidden; })()`,
          { label: `reader open for ${material.materialId} (scroll phase)`, timeoutMs: 25_000 },
        );
        await inputClickAt(ctx, "#search-input");
        let typed = 0;
        for (let step = 0; step < steps; step += 1) {
          await ctx.evalJs(
            `(() => { const el = document.getElementById("mat-blocks"); if (el === null) return false; ` +
              `const t0 = performance.now(); ` +
              `el.scrollTop = Math.min(el.scrollHeight, el.scrollTop + Math.floor(el.clientHeight * 0.85)); ` +
              `requestAnimationFrame(() => { window.__b6Scroll.steps.push(Number((performance.now() - t0).toFixed(1))); }); ` +
              `return el.scrollTop >= el.scrollHeight - el.clientHeight; })()`,
          );
          if (step % 2 === 0 && typed < typedChars.length) {
            const ch = typedChars[typed];
            typed += 1;
            await ctx.cdpSend("Input.dispatchKeyEvent", {
              type: "keyDown",
              key: ch,
              text: ch,
              code: `Key${ch.toUpperCase()}`,
              windowsVirtualKeyCode: ch.charCodeAt(0),
              modifiers: 0,
            });
            await ctx.cdpSend("Input.dispatchKeyEvent", { type: "keyUp", key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: ch.charCodeAt(0), modifiers: 0 });
          }
          await sleep(180);
        }
        await inputClickAt(ctx, "#mat-close");
        await waitFor(ctx, `(() => { const r = document.getElementById("material-reader"); return r === null || r.hidden; })()`, { label: "reader closed (scroll phase)" });
      };
      await pageThrough(70, 42); /* 长文 PDF（59 页） */
      await pageThrough(0, 34); /* 长文 markdown（221 块） */
      await ctx.evalJs(`(() => { document.getElementById("search-input").value = ""; return true; })()`);

      const raw = await ctx.evalJs(
        `(() => { const probe = window.__b6Scroll; ` +
          `probe.endedAt = performance.now(); ` +
          `return { longTasks: probe.longTasks, steps: probe.steps, keys: probe.keys.map((k) => ({ keydownToValue: k.tInput !== undefined ? Number((k.tInput - k.tKey).toFixed(1)) : null, keydownToRender: k.tPaint !== undefined ? Number((k.tPaint - k.tKey).toFixed(1)) : null })) }; })()`,
      );
      const { stepStats, keyStats, worstTask, problems } = classifyB6Responsiveness(raw, {
        mainThreadSegmentLimitMs: MAIN_THREAD_SEGMENT_LIMIT_MS,
        keystrokeP95LimitMs: KEYSTROKE_P95_LIMIT_MS,
      });
      responsiveness.longTasks = raw.longTasks;
      responsiveness.longTaskCount = raw.longTasks.length;
      responsiveness.worstLongTaskMs = worstTask;
      responsiveness.stepLatency = stepStats;
      responsiveness.keystrokeLatency = keyStats;
      responsiveness.note =
        "step latency = scrollTop write → next animation frame (per paging step); keystroke-to-render = keydown → character landed in the search input → next frame (typed DURING the paging loop); " +
        "the product runs search on explicit submit (no as-you-type path) — the measured input path is the keystroke echo of the search box under scroll load";
      if (problems.length > 0) {
        throw new Error(`B6 browser responsiveness — ${problems.join("; ")} (${environment.honestyNote})`);
      }
    }

  return responsiveness;
}
