/** markdown-reader ownership for material-probes.mjs; compatibility entrypoint remains one level above. */
import {
  inputClickAt,
  materialButtonSelector,
  waitFor,
} from "./input.mjs";
import {
  pageReaderLoadedExpr,
} from "./selection.mjs";

/* ---- 侧栏树切换（真实输入点击树列表行）。 ---- */

export function activeTreeIdInUiExpr() {
  return `(() => { const row = document.querySelector("#tree-list button.active"); ` +
    `if (row === null) return null; const name = row.querySelector(".material-name"); ` +
    `return row.dataset.treeId ?? null; })()`;
}

export async function switchTreeInUi(ctx, treeId) {
  const active = await ctx.evalJs(activeTreeIdInUiExpr());
  if (active === treeId) return;
  const index = await ctx.evalJs(
    `(() => { const rows = [...document.querySelectorAll("#tree-list button")]; ` +
      `return rows.findIndex((b) => b.dataset.treeId === ${JSON.stringify(treeId)}); })()`,
  );
  if (index === null || index < 0) throw new Error(`tree ${treeId} not present in the sidebar tree list`);
  await inputClickAt(ctx, `#tree-list li:nth-child(${String(index + 1)}) button`);
  await waitFor(
    ctx,
    `(() => { const row = document.querySelector("#tree-list button.active"); ` +
      `return row !== null && row.dataset.treeId === ${JSON.stringify(treeId)}; })()`,
    { label: `tree ${treeId} active in the sidebar` },
  );
}

/* ------------------------------------------------------------------ */
/* 阅读器就位 / 无损渲染断言                                              */
/* ------------------------------------------------------------------ */

export async function openMaterialInReader(ctx, material, { blocks, tail, timeoutMs = 20_000 }) {
  await inputClickAt(ctx, materialButtonSelector(material.materialId));
  return waitFor(ctx, pageReaderLoadedExpr(blocks, tail), { label: `material reader for ${material.title} (${String(blocks)} blocks)`, timeoutMs });
}

export async function readDomBlocks(ctx) {
  return ctx.evalJs(`(() => {
    const blocksEl = document.getElementById("mat-blocks");
    if (blocksEl === null) return [];
    const out = [];
    for (const child of blocksEl.children) {
      if (child.classList !== undefined && child.classList.contains("material-block")) {
        out.push({ blockId: child.dataset.blockId, start: Number(child.dataset.start), end: Number(child.dataset.end), text: child.textContent });
      }
    }
    return out;
  })()`);
}

/** 逐字无损：在场每个块 textContent/dataset 与冻结真值字节相等。 */
export async function assertBlocksLossless(ctx, truth, { expectedCount, label }) {
  const domBlocks = await readDomBlocks(ctx);
  if (domBlocks.length !== expectedCount) {
    throw new Error(`${label}: ${String(domBlocks.length)} blocks in view, expected ${String(expectedCount)}`);
  }
  const byId = new Map(truth.blocks.map((block) => [block.blockId, block]));
  for (const dom of domBlocks) {
    const frozen = byId.get(dom.blockId);
    if (frozen === undefined) {
      throw new Error(`${label}: block ${dom.blockId} is not in the frozen truth`);
    }
    if (dom.text !== frozen.text || dom.start !== frozen.start || dom.end !== frozen.end) {
      throw new Error(
        `${label}: block ${dom.blockId} is not byte-equal to the frozen truth ` +
          `(text equal: ${String(dom.text === frozen.text)}, range [${String(dom.start)}, ${String(dom.end)}) vs [${String(frozen.start)}, ${String(frozen.end)}))`,
      );
    }
  }
  return domBlocks.length;
}

/** 阅读器 chrome：版本标签 / 解析器种类与版本 / 版本链。 */
export async function assertReaderChrome(ctx, material, truth) {
  const info = await ctx.evalJs(`(() => {
    const reader = document.getElementById("material-reader");
    const label = reader === null ? null : reader.querySelector(".mat-version-label");
    const meta = reader === null ? null : reader.querySelector(".mat-meta");
    const chips = reader === null ? [] : Array.from(reader.querySelectorAll(".mat-version-chip"));
    return {
      label: label === null ? null : label.textContent,
      meta: meta === null ? null : meta.textContent,
      chips: chips.map((chip) => ({ text: chip.textContent, active: chip.classList.contains("active") })),
    };
  })()`);
  const problems = [];
  if (info.label !== "v1 (current)") problems.push(`version label ${JSON.stringify(info.label)} ≠ "v1 (current)"`);
  if (info.meta === null || !info.meta.includes(`markdown · ${truth.normalizer}`)) {
    problems.push(`meta does not state parser kind/version: ${JSON.stringify(info.meta)}`);
  }
  if (!info.meta.includes(`${String(truth.textUnits)} text units`)) {
    problems.push(`meta textUnits mismatch: ${JSON.stringify(info.meta)}`);
  }
  if (info.chips.length !== 1 || info.chips[0].text !== "v1 · markdown" || info.chips[0].active !== true) {
    problems.push(`version strip mismatch: ${JSON.stringify(info.chips)}`);
  }
  if (problems.length > 0) {
    throw new Error(`reader chrome for ${material.title} — ${problems.join("; ")}`);
  }
  return true;
}
