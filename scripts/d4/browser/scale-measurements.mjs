/** D4 B6 browser probe measurement primitives. Frozen limits and verdicts remain in scale-probes.mjs. */
export function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(p * sorted.length) - 1];
}

export function timingStats(values) {
  return {
    count: values.length,
    medianMs: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: values.length === 0 ? 0 : Math.max(...values),
  };
}

export const fmt = (n) => n.toFixed(1);

/** 阅读器就位结算：阅读器可见 + 首块在场（PDF：首页文本层已渲染——
 *  「先渲染可见页」的可读口径）。 */
export function settleReaderReadable(materialId, isPdf) {
  const pdfCheck = isPdf
    ? `const firstLayer = blocks.querySelector(".pdf-page-text"); ` +
      `if (firstLayer === null || firstLayer.dataset.rendered !== "true") return false; ` +
      `pdfFrames = blocks.querySelectorAll(".pdf-page-frame").length;`
    : `pdfFrames = null;`;
  return `(() => { const reader = document.getElementById("material-reader"); ` +
    `if (reader === null || reader.hidden) return false; ` +
    `const blocks = document.getElementById("mat-blocks"); ` +
    `if (blocks === null) return false; ` +
    `let pdfFrames = null; ${pdfCheck} ` +
    `const blockCount = ${isPdf ? `blocks.querySelectorAll(".pdf-page-frame").length` : `blocks.querySelectorAll(".material-block").length`}; ` +
    `if (blockCount < 1) return false; ` +
    `if (document.getElementById("mat-tail") === null) return false; ` +
    `return { blockCount, pdfFrames }; })()`;
}

