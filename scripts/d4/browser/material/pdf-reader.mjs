/** pdf-reader ownership for material-probes.mjs; compatibility entrypoint remains one level above. */
import {
  sleep,
  waitFor,
} from "./input.mjs";
import {
  captureFrozenSelection,
} from "./selection.mjs";

/* ------------------------------------------------------------------ */
/* PDF 阅读面（charter §3.2：页框 + 懒渲染文本层 + 单页选区纪律）          */
/* ------------------------------------------------------------------ */

/* app.js 的 PDF 分页步长（fetchMaterialPage 的 PDF_PAGE_FETCH_LIMIT）——
   探针镜像该常量以计算各阶段期望页数；漂移会让就位等待如实超时。 */
export const PDF_FETCH_PAGE_STEP = 10;

/* app.js 的 markdown 分块步长（fetchMaterialPage 的 MATERIAL_PAGE_LIMIT）。 */
export const MATERIAL_FETCH_BLOCK_STEP = 50;

/** PDF 阅读器就位表达式（页框数 + 尾部「N page(s) in view」+ 末页/更多态）。 */
export function pdfReaderLoadedExpr(pages, tail) {
  const tailCheck =
    tail === "end"
      ? `if (!text.includes("已到最后一页")) return false;`
      : tail === "more"
        ? `if (tail.querySelector(".mat-load-more") === null) return false;`
        : "";
  return `(() => {
    const reader = document.getElementById("material-reader");
    if (reader === null || reader.hidden) return false;
    const frames = document.querySelectorAll("#mat-blocks .pdf-page-frame").length;
    if (frames !== ${Number(pages)}) return false;
    const tail = document.getElementById("mat-tail");
    if (tail === null) return false;
    const text = tail.textContent;
    if (!text.includes(${JSON.stringify(`${String(pages)} page(s) in view`)})) return false;
    ${tailCheck}
    return { frames: frames, tail: text };
  })()`;
}

/** PDF 页框/文本层选择器（Node 侧拼装；blockId 来自冻结真值，纯 ASCII）。 */
export function pdfFrameSelector(blockId) {
  return `#mat-blocks .pdf-page-frame[data-block-id=${JSON.stringify(blockId)}]`;
}

export function pdfLayerSelector(blockId) {
  return `#mat-blocks .pdf-page-text[data-block-id=${JSON.stringify(blockId)}]`;
}

/** 页文本层渲染就位：页框滚入视口（应用自身的滚动监听驱动
    updatePdfPageRendering 的懒渲染）→ data-rendered === "true" + 无占位 +
    非空文本。**迭代滚入**（有界）：从未渲染过的页是 ~68px 占位——内容
    因此偏短，一次 scrollIntoView 会被钳制在短内容的最大滚动位；按序
    渲染的级联又会把目标页推到渲染窗外（实测 pdf-08 page-10：一次滚动
    后 4-6 页渲染、7-10 仍是占位）。真实用户会继续滚动直到看见目标页
    ——探针同款：滚→等渲染落定→未渲染再滚（页每次落位更深），有界
    次数内不达即如实失败（附几何诊断）。 */
export async function ensurePdfPageRendered(ctx, blockId, label) {
  const MAX_ATTEMPTS = 14;
  let lastState = null;
  for (let attempt = 0; ; attempt += 1) {
    const state = await ctx.evalJs(
      `(() => { const frame = document.querySelector(${JSON.stringify(pdfFrameSelector(blockId))}); ` +
        `if (frame === null) return { error: "page frame ${blockId} is not loaded in the reader window" }; ` +
        `const layer = frame.querySelector(".pdf-page-text"); ` +
        `if (layer !== null && layer.dataset.rendered !== "true") frame.scrollIntoView({ block: "center" }); ` +
        `return { rendered: layer === null ? null : layer.dataset.rendered }; })()`,
    );
    if (state === null || state.error !== undefined) {
      throw new Error(`${label}: ${JSON.stringify(state)}`);
    }
    lastState = state;
    if (state.rendered === "true") {
      await waitFor(
        ctx,
        `(() => { const layer = document.querySelector(${JSON.stringify(pdfLayerSelector(blockId))}); ` +
          `if (layer === null) return false; ` +
          `if (layer.dataset.rendered !== "true") return false; ` +
          `if (layer.querySelector(".pdf-page-pending") !== null) return false; ` +
          `return layer.textContent.length > 0; })()`,
        { label: `pdf page text layer ${blockId} rendered (${label})`, timeoutMs: 10_000 },
      );
      return true;
    }
    if (attempt >= MAX_ATTEMPTS - 1) break;
    await sleep(250);
  }
  const geom = await ctx
    .evalJs(
      `(() => { const blocks = document.getElementById("mat-blocks"); ` +
        `if (blocks === null) return { blocks: null }; ` +
        `const frames = [...blocks.querySelectorAll(".pdf-page-frame")].map((f) => ` +
        `{ return { id: f.dataset.blockId, top: f.offsetTop, h: f.offsetHeight, rendered: f.querySelector(".pdf-page-text")?.dataset.rendered ?? null }; }); ` +
        `return { scrollTop: blocks.scrollTop, scrollH: blocks.scrollHeight, clientH: blocks.clientHeight, ` +
        `offsetTop: blocks.offsetTop, frames }; })()`,
    )
    .catch(() => null);
  throw new Error(
    `${label}: pdf page ${blockId} never rendered within ${String(MAX_ATTEMPTS)} scroll-settle attempts ` +
      `(last state ${JSON.stringify(lastState)}); geometry=${JSON.stringify(geom)}`,
  );
}

/** 已渲染页文本层的逐字无损断言：textContent/dataset 与冻结页块字节相等。 */
export async function assertPdfPageLayerLossless(ctx, truth, blockId, label) {
  const frozen = truth.blocks.find((block) => block.blockId === blockId);
  if (frozen === undefined) {
    throw new Error(`${label}: page block ${blockId} is not in the frozen truth`);
  }
  const layer = await ctx.evalJs(
    `(() => { const el = document.querySelector(${JSON.stringify(pdfLayerSelector(blockId))}); ` +
      `return el === null ? null : { text: el.textContent, rendered: el.dataset.rendered, ` +
      `start: el.dataset.start, end: el.dataset.end, page: el.dataset.page }; })()`,
  );
  if (layer === null || layer.rendered !== "true") {
    throw new Error(`${label}: page ${blockId} text layer is not rendered — ${JSON.stringify(layer)}`);
  }
  if (layer.text !== frozen.text) {
    throw new Error(
      `${label}: page ${blockId} text layer is not byte-equal to the frozen truth block text ` +
        `(${String(layer.text.length)} vs ${String(frozen.text.length)} UTF-16 units)`,
    );
  }
  if (Number(layer.start) !== frozen.start || Number(layer.end) !== frozen.end) {
    throw new Error(
      `${label}: page ${blockId} layer range [${String(layer.start)}, ${String(layer.end)}) ≠ frozen [${String(frozen.start)}, ${String(frozen.end)})`,
    );
  }
  if (typeof frozen.page === "number" && Number(layer.page) !== frozen.page) {
    throw new Error(`${label}: page ${blockId} layer page ${String(layer.page)} ≠ frozen ${String(frozen.page)}`);
  }
  return true;
}

/** PDF 阅读器 chrome：版本标签 / 解析器种类与版本（d4-pdf-v1）/ 版本链 /
    单页选区纪律注记（markdown 版 assertReaderChrome 的 pdf 面——meta 串
    不同：`pdf · d4-pdf-v1`，绝无 markdown 字样）。 */
export async function assertPdfReaderChrome(ctx, material, truth) {
  const info = await ctx.evalJs(`(() => {
    const reader = document.getElementById("material-reader");
    const label = reader === null ? null : reader.querySelector(".mat-version-label");
    const meta = reader === null ? null : reader.querySelector(".mat-meta");
    const chips = reader === null ? [] : Array.from(reader.querySelectorAll(".mat-version-chip"));
    const note = reader === null ? null : reader.querySelector(".mat-note");
    return {
      label: label === null ? null : label.textContent,
      meta: meta === null ? null : meta.textContent,
      chips: chips.map((chip) => ({ text: chip.textContent, active: chip.classList.contains("active") })),
      note: note === null ? null : note.textContent,
    };
  })()`);
  const problems = [];
  if (info.label !== "v1 (current)") problems.push(`version label ${JSON.stringify(info.label)} ≠ "v1 (current)"`);
  if (info.meta === null || !info.meta.includes(`pdf · ${truth.normalizer}`)) {
    problems.push(`meta does not state the pdf parser kind/version: ${JSON.stringify(info.meta)}`);
  }
  if (info.meta === null || !info.meta.includes(`${String(material.textUnits)} text units`)) {
    problems.push(`meta textUnits mismatch: ${JSON.stringify(info.meta)}`);
  }
  if (info.chips.length !== 1 || info.chips[0].text !== "v1 · pdf" || info.chips[0].active !== true) {
    problems.push(`version strip mismatch: ${JSON.stringify(info.chips)}`);
  }
  if (info.note === null || !info.note.includes("PDF reading surface") || !info.note.includes("select within one page")) {
    problems.push(`the pdf reading-surface / single-page discipline note is absent: ${JSON.stringify(info.note)}`);
  }
  if (problems.length > 0) {
    throw new Error(`pdf reader chrome for ${material.title} — ${problems.join("; ")}`);
  }
  return true;
}

/** 跨页真实 DOM 选区（B2 纪律镜像：PDF 选区必须含于单页——期望捕获条呈
    不可锚定）。两页文本层都必须已渲染；本表达式不再滚动（页框已被
    ensurePdfPageRendered 滚入渲染窗口，再滚动会把另一页推出懒渲染窗口）。 */
export function pageSelectCrossPagePdf(blockA, localStartA, blockB, localEndB) {
  const layerOf = (id) => `document.querySelector(${JSON.stringify(pdfLayerSelector(id))})`;
  return `(() => {
    const elA = ${layerOf(blockA)};
    const elB = ${layerOf(blockB)};
    if (elA === null || elB === null) return { error: "pdf page text layer absent" };
    if (elA.dataset.rendered !== "true" || elB.dataset.rendered !== "true") return { error: "pdf page text layer not rendered" };
    const anchorIn = (el, local) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let pos = 0;
      for (;;) {
        const node = walker.nextNode();
        if (node === null) return null;
        const len = node.data.length;
        if (local <= pos + len) return { node, offset: local - pos };
        pos += len;
      }
    };
    const a = anchorIn(elA, ${Number(localStartA)});
    const b = anchorIn(elB, ${Number(localEndB)});
    if (a === null || b === null) return { error: "offsets did not map onto text nodes" };
    const range = document.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return { selectedText: selection.toString() };
  })()`;
}

/** PDF 冻结选区捕获（页感知包装）：目标页先滚入渲染窗口（懒渲染纪律）→
    已渲染文本层与冻结页块逐字无损 → captureFrozenSelection 的同构路径
    （文本层携带同款 data-block-id/start/end，findBlock 已解析到文本层）。 */
export async function capturePdfFrozenSelection(ctx, { treeId, material, item, truth }) {
  const expected = item.expected;
  if (item.fixture !== material.fixtureId) {
    throw new Error(`${item.id}: frozen selection targets fixture ${item.fixture}, but the open material is ${material.fixtureId}`);
  }
  const block = truth.blocks.find((candidate) => candidate.blockId === expected.blockId);
  if (block === undefined) {
    throw new Error(`${item.id}: block ${expected.blockId} is not in the frozen pdf truth`);
  }
  if (typeof block.page !== "number") {
    throw new Error(`${item.id}: frozen pdf block ${expected.blockId} carries no page number`);
  }
  await ensurePdfPageRendered(ctx, expected.blockId, item.id);
  await assertPdfPageLayerLossless(ctx, truth, expected.blockId, item.id);
  return captureFrozenSelection(ctx, { treeId, material, item, truth, page: block.page });
}
