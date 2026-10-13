/** input ownership for material-probes.mjs; compatibility entrypoint remains one level above. */

/* ------------------------------------------------------------------ */
/* 小工具                                                               */
/* ------------------------------------------------------------------ */

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(ctx, expression, { label, timeoutMs = 12_000, intervalMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await ctx.evalJs(expression);
    if (value) return value;
    if (Date.now() + intervalMs >= deadline) {
      throw new Error(`timeout (${String(timeoutMs)}ms) waiting for: ${label}`);
    }
    await sleep(intervalMs);
  }
}

/** 真实输入点击（CDP Input 管线：mousePressed + mouseReleased 于元素中心）。
    每次尝试前先把目标滚进视口，且以 elementFromPoint 复核命中——取坐标
    与落点之间可能隔着一次延后重渲（拖选解除的 0ms 冲刷会重建侧栏 DOM，
    实测把 md-11 的点击坐标作废），不命中则等一拍重试（有界）。 */
export async function inputClickAt(ctx, selector) {
  let lastState = null;
  for (let attempt = 0; ; attempt += 1) {
    lastState = await ctx.evalJs(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); ` +
        `if (el === null) return { missing: true }; ` +
        `if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center" }); ` +
        `const r = el.getBoundingClientRect(); ` +
        `if (r.width <= 0 || r.height <= 0) return { hidden: true }; ` +
        `const x = r.left + r.width / 2, y = r.top + r.height / 2; ` +
        `const hit = document.elementFromPoint(x, y); ` +
        `return { x: x, y: y, hit: hit !== null && hit.closest(${JSON.stringify(selector)}) !== null }; })()`,
    );
    if (lastState?.missing === true) throw new Error(`click target not found: ${selector}`);
    if (lastState?.hidden === true) throw new Error(`click target not visible: ${selector}`);
    /* 命中复核与坐标在同一表达式内求值——两步分开会被两次 CDP 往返间的
       重渲拆开（这正是 md-11 点击落空的机制）。 */
    if (lastState?.hit === true) {
      await ctx.cdpSend("Input.dispatchMouseEvent", { type: "mousePressed", x: lastState.x, y: lastState.y, button: "left", buttons: 1, clickCount: 1 });
      await ctx.cdpSend("Input.dispatchMouseEvent", { type: "mouseReleased", x: lastState.x, y: lastState.y, button: "left", buttons: 0, clickCount: 1 });
      return;
    }
    if (attempt >= 6) {
      throw new Error(`click target never settled at its coordinates (covered or moving): ${selector}`);
    }
    await sleep(150);
  }
}

export function materialButtonSelector(materialId) {
  return `#material-list button[data-material-id=${JSON.stringify(materialId)}]`;
}
