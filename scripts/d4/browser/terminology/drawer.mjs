/** drawer ownership for terminology-probes.mjs; compatibility entrypoint remains one level above. */
import {
  inputClickAt,
  waitFor,
} from "../material-probes.mjs";
import {
  MODE_BUTTON_INDEX,
} from "./policy.mjs";

/* ------------------------------------------------------------------ */
/* UI 流（抽屉 / 主干提问 / 面板追问 / Return / 分支 tab）                 */
/* ------------------------------------------------------------------ */

export async function openDrawer(ctx) {
  const open = await ctx.evalJs(`(() => { const d = document.getElementById("source-drawer"); return d !== null && !d.hidden; })()`);
  if (open === true) return;
  await inputClickAt(ctx, "#source-drawer-toggle");
  await waitFor(
    ctx,
    `(() => { const d = document.getElementById("source-drawer"); ` +
      `return d !== null && !d.hidden && d.querySelector(".term-mode-row") !== null && d.textContent.includes("已保存的批注"); })()`,
    { label: "sources drawer open with the terminology section rendered" },
  );
}

export async function closeDrawer(ctx) {
  const closed = await ctx.evalJs(`(() => { const d = document.getElementById("source-drawer"); return d === null || d.hidden; })()`);
  if (closed === true) return;
  /* 抽屉为覆盖层（z-index 30，盖住顶栏 Sources 开关自身——产品在抽屉头部
     提供可见关闭按钮；真实用户路径）。 */
  await inputClickAt(ctx, "#drawer-close");
  await waitFor(ctx, `(() => { const d = document.getElementById("source-drawer"); return d === null || d.hidden; })()`, {
    label: "sources drawer closed (in-drawer × Close button)",
  });
}

export function modeButtonSelector(mode) {
  return `.term-mode-row .term-mode-toggle:nth-child(${String(MODE_BUTTON_INDEX[mode])})`;
}
