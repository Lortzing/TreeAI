/** input ownership for terminology-probes.mjs; compatibility entrypoint remains one level above. */
import {
  sleep,
} from "../material-probes.mjs";

/* ------------------------------------------------------------------ */
/* 小工具（CDP 视口 / 命中 / 点击管线 / Fetch 观测与丢弃）                 */
/* ------------------------------------------------------------------ */

export async function setViewport(ctx, viewport) {
  await ctx.cdpSend("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
    mobile: viewport.mobile ?? false,
  });
  await sleep(350);
}

/** 命中探测：先滚入视口，再取元素中心 elementFromPoint 是否落在元素内。 */
export async function hitTest(ctx, selector) {
  return ctx.evalJs(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); ` +
      `if (el === null) return { missing: true }; ` +
      `if (el.hidden === true) return { missing: true, hidden: true }; ` +
      `if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center" }); ` +
      `const r = el.getBoundingClientRect(); ` +
      `if (r.width <= 0 || r.height <= 0) return { missing: true, zeroRect: true }; ` +
      `const x = r.left + r.width / 2, y = r.top + r.height / 2; ` +
      `if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) ` +
      `return { missing: true, outside: true, rect: { left: r.left, top: r.top, w: r.width, h: r.height } }; ` +
      `const hit = document.elementFromPoint(x, y); ` +
      `return { x, y, hit: hit !== null && (hit === el || el.contains(hit)) }; })()`,
  );
}

export async function assertHits(ctx, selectors, label) {
  const results = {};
  const problems = [];
  for (const [name, selector] of Object.entries(selectors)) {
    const state = await hitTest(ctx, selector);
    results[name] = state?.hit === true ? true : state;
    if (state?.hit !== true) problems.push(`${name} (${selector}): ${JSON.stringify(state)}`);
  }
  if (problems.length > 0) {
    throw new Error(`${label} — terminology controls not hit-testable: ${problems.join("; ")}`);
  }
  return results;
}

/** DOM click（与复制/建枝按钮同款管线——CDP 输入点击的 press/release 分段会
 *  与 0ms 解除路径抢跑，见 b3 既有注释）。 */
export async function domClick(ctx, selector) {
  const clicked = await ctx.evalJs(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); ` +
      `if (el === null) return false; el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); return true; })()`,
  );
  if (clicked !== true) throw new Error(`click target not found: ${selector}`);
}

/** 双击提交（b3 同款：两发 click 事件均送达应用监听器；被测对象 = busy 锁
 *  + 服务端幂等键。第二击落在重渲后的当前按钮——真实双击的第二击同样
 *  可能落在收起后的面）。 */
export async function domDoubleClick(ctx, selector) {
  const clickOnce = async (detail) => {
    const clicked = await ctx.evalJs(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); ` +
        `if (el === null) return false; ` +
        `el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: ${String(detail)} })); ` +
        `return true; })()`,
    );
    return clicked === true;
  };
  if ((await clickOnce(1)) !== true) throw new Error(`double-click target not found (first click): ${selector}`);
  await sleep(30);
  if ((await clickOnce(2)) !== true) return "second-click-target-gone";
  await ctx.evalJs(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); ` +
      `if (el !== null) el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2 })); return true; })()`,
  );
  return "double-click-delivered";
}

/** 真实按键（keyDown + keyUp）。 */
export async function pressKey(ctx, key, code, vk, { modifiers = 0, text = undefined } = {}) {
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
  await ctx.cdpSend("Input.dispatchKeyEvent", { type: "keyDown", ...base, ...(text !== undefined ? { text } : {}) });
  await ctx.cdpSend("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  await sleep(90);
}
