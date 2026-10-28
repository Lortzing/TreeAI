/** input ownership for nav-probes.mjs; compatibility entrypoint remains one level above. */
import {
  sleep,
} from "../material-probes.mjs";
import {
  ROW_HEIGHT,
} from "./policy.mjs";

/** 行滚入渲染窗口（**只滚 #nav-tree-scroll**——scrollIntoView 会连带滚动
 *  侧栏外层，把 Materials 等区块搬到导航树原位（实测覆盖 toggle 落点）；
 *  真实 scrollTop 写入驱动应用自身的 scroll → renderNavTree 重划）。
 *  目标行的精确滚动位置由结构真值 + 探针侧展开/已载镜像派生（确定性）；
 *  镜像缺位时回落滚动阶梯扫描。 */
export async function scrollRowIntoWindow(ctx, selector, { rowIndex = null, timeoutMs = 8000, quiet = true } = {}) {
  if (quiet) await waitForNavQuiet(ctx, { timeoutMs: 6000 });
  const deadline = Date.now() + timeoutMs;
  for (let round = 0; ; round += 1) {
    if ((await ctx.evalJs(`(() => document.querySelector(${JSON.stringify(selector)}) !== null)()`)) === true) {
      return true;
    }
    if (rowIndex !== null && round === 0) {
      /* 精确位置：目标行居窗口上三分之一。 */
      await ctx.evalJs(
        `(() => { const scroller = document.getElementById("nav-tree-scroll"); ` +
          `scroller.scrollTop = Math.max(0, ${String(rowIndex)} * ${String(ROW_HEIGHT)} - 120); return true; })()`,
      );
    } else {
      /* 阶梯扫描（底部优先——顺带触发按需续页泵）。 */
      const fractions = round === 0 ? [1, 0, 0.5, 0.25, 0.75] : [1, 0.33, 0.66, 0.15, 0.85];
      for (const fraction of fractions) {
        await ctx.evalJs(
          `(() => { const scroller = document.getElementById("nav-tree-scroll"); ` +
            `scroller.scrollTop = Math.round((scroller.scrollHeight - scroller.clientHeight) * ${String(fraction)}); return true; })()`,
        );
        await sleep(200);
        if ((await ctx.evalJs(`(() => document.querySelector(${JSON.stringify(selector)}) !== null)()`)) === true) {
          return true;
        }
      }
    }
    await sleep(120);
    if (Date.now() >= deadline) {
      const snap = await ctx.evalJs(
        `(() => { const rows = [...document.querySelectorAll("#nav-tree .nav-item")]; ` +
          `const scroller = document.getElementById("nav-tree-scroll"); ` +
          `return { title: (document.getElementById("nav-tree-title").textContent ?? "").slice(0, 60), ` +
            `status: (document.getElementById("nav-tree-status").textContent ?? "").slice(0, 140), ` +
            `scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight, ` +
            `rows: rows.length, first: rows.length > 0 ? rows[0].dataset.branchId : null }; })()`,
      ).catch(() => null);
      throw new Error(`nav row never entered the rendered window: ${selector} — tree: ${JSON.stringify(snap)}`);
    }
  }
}

/** 导航行点击（坐标 + 命中复核同表达式；**不做 scrollIntoView**——理由见
 *  scrollRowIntoWindow；行不进视口时只滚 #nav-tree-scroll）。 */
export async function navRowClickAt(ctx, selector, { timeoutMs = 8000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; ; attempt += 1) {
    await scrollRowIntoWindow(ctx, selector, { timeoutMs });
    const state = await ctx.evalJs(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); ` +
        `if (el === null) return { missing: true }; ` +
        `const r = el.getBoundingClientRect(); ` +
        `if (r.width <= 0 || r.height <= 0) return { hidden: true }; ` +
        `const x = r.left + r.width / 2, y = r.top + r.height / 2; ` +
        `const hit = document.elementFromPoint(x, y); ` +
        `return { x, y, hit: hit !== null && hit.closest(${JSON.stringify(selector)}) !== null }; })()`,
    );
    if (state?.missing === true) throw new Error(`nav click target not found: ${selector}`);
    if (state?.hit === true) {
      await ctx.cdpSend("Input.dispatchMouseEvent", { type: "mousePressed", x: state.x, y: state.y, button: "left", buttons: 1, clickCount: 1 });
      await ctx.cdpSend("Input.dispatchMouseEvent", { type: "mouseReleased", x: state.x, y: state.y, button: "left", buttons: 0, clickCount: 1 });
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`nav click target never settled at its coordinates (covered or moving): ${selector}`);
    }
    await sleep(120);
  }
}

/** 按需续页泵静置等待：状态行总行数连续两拍不变（泵把 more 行 load 完
 *  才静）——避免与异步装载/窗口重划竞态（实测点击落点被逐出窗口）。 */
export async function waitForNavQuiet(ctx, { timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    const total = await ctx.evalJs(
      `(() => { const match = /rendering \\d+\\/(\\d+) visible rows/.exec(document.getElementById("nav-tree-status").textContent ?? ""); ` +
        `return match === null ? null : Number(match[1]); })()`,
    );
    if (total !== null && total === last) return total;
    last = total;
    if (Date.now() >= deadline) return total;
    await sleep(350);
  }
}

/** 行点击：单次命中探测（真实输入点击）→ 未命中（被侧栏布局缺陷覆盖，
 *  见 frontendBugs）即 DOM dispatch。事件直达应用监听器；虚拟化窗口内的
 *  行仍在 DOM。布局修复后自动回到真实输入管线（无重试等待——被覆盖时
 *  的重试循环只会空转计时）。 */
export async function navRowDomClickWithFallback(ctx, selector, { rowIndex = null } = {}) {
  let state = null;
  for (let attempt = 0; ; attempt += 1) {
    /* 计时窗口内不做静置等待（arm 前的滚入已静置；重试路径才再静置）。 */
    await scrollRowIntoWindow(ctx, selector, { rowIndex, timeoutMs: 6000, quiet: attempt > 0 });
    state = await ctx.evalJs(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); ` +
        `if (el === null) return { missing: true }; ` +
        `const r = el.getBoundingClientRect(); ` +
        `if (r.width <= 0 || r.height <= 0) return { hidden: true }; ` +
        `const x = r.left + r.width / 2, y = r.top + r.height / 2; ` +
        `const hit = document.elementFromPoint(x, y); ` +
        `return { x, y, branchId: el.closest('[data-branch-id]')?.dataset.branchId ?? null, expanded: el.closest('.nav-item')?.getAttribute('aria-expanded') ?? null, hit: hit !== null && hit.closest(${JSON.stringify(selector)}) !== null }; })()`,
    );
    if (state?.missing === true) {
      if (attempt >= 2) throw new Error(`nav click target not found: ${selector}`);
      await sleep(250);
      continue;
    }
    break;
  }
  if (state?.hit === true) {
    await ctx.cdpSend("Input.dispatchMouseEvent", { type: "mousePressed", x: state.x, y: state.y, button: "left", buttons: 1, clickCount: 1 });
    await ctx.cdpSend("Input.dispatchMouseEvent", { type: "mouseReleased", x: state.x, y: state.y, button: "left", buttons: 0, clickCount: 1 });
    const selected = !selector.includes('.nav-label') || state.branchId === null || await ctx.evalJs(`document.querySelector('#nav-tree .nav-item.active')?.dataset.branchId === ${JSON.stringify(state.branchId)}`);
    const toggled = !selector.includes('.nav-toggle') || await ctx.evalJs(`document.querySelector(${JSON.stringify(selector)})?.closest('.nav-item')?.getAttribute('aria-expanded') !== ${JSON.stringify(state.expanded)}`);
    if (selected && toggled) return "input-click";
  }
  /* DOM dispatch：行可在两次求值间被重渲逐出窗口（按需续页/窗口重划）——
     有限重试（重滚入 + 重发）。 */
  for (let attempt = 0; ; attempt += 1) {
    const clicked = await ctx.evalJs(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); ` +
        `if (el === null) return false; el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); return true; })()`,
    );
    if (clicked === true) return "dom-click (covered by the sidebar layout bug)";
    if (attempt >= 3) {
      const snap = await ctx.evalJs(
        `(() => { const rows = [...document.querySelectorAll("#nav-tree .nav-item")]; ` +
          `const scroller = document.getElementById("nav-tree-scroll"); ` +
          `return { status: (document.getElementById("nav-tree-status").textContent ?? "").slice(0, 140), ` +
            `scrollTop: scroller.scrollTop, first: rows.length > 0 ? rows[0].dataset.branchId : null, ` +
            `last: rows.length > 0 ? rows[rows.length - 1].dataset.branchId : null, count: rows.length }; })()`,
      );
      throw new Error(`nav DOM click target not found after retries: ${selector} — tree state: ${JSON.stringify(snap)}`);
    }
    await sleep(150);
  }
}

/** 输入填充（focus + 清值 + 真实 insertText；find 按钮走 DOM click 兜底——
 *  侧栏布局缺陷同样覆盖 surface 的下部控件，见 frontendBugs）。 */
export async function navFillInput(ctx, selector, text) {
  const focused = await ctx.evalJs(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); ` +
      `if (el === null) return false; el.focus(); el.value = ""; return true; })()`,
  );
  if (focused !== true) throw new Error(`nav input target not found: ${selector}`);
  await ctx.cdpSend("Input.insertText", { text });
  const value = await ctx.evalJs(`(() => document.querySelector(${JSON.stringify(selector)}).value)()`);
  if (value !== text) {
    throw new Error(`nav input did not receive the text (${JSON.stringify(value)} ≠ ${JSON.stringify(text)})`);
  }
}
