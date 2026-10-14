/** selection ownership for b3-probes.mjs; compatibility entrypoint remains one level above. */

/* ------------------------------------------------------------------ */
/* 小工具                                                               */
/* ------------------------------------------------------------------ */

/** 块文本上构造代理对安全的 UTF-16 半开区间（canonicalText 切片逐码元一致）。 */
export function safeBlockRange(block, preferLen = 24) {
  const text = block.text;
  let start = Math.min(6, Math.max(0, text.length - 2));
  let end = Math.min(start + preferLen, text.length);
  const surrogateLead = (ch) => (ch & 0xfc00) === 0xd800;
  const surrogateTrail = (ch) => (ch & 0xfc00) === 0xdc00;
  while (start < text.length && surrogateLead(text.charCodeAt(start)) && start + 1 < text.length && surrogateTrail(text.charCodeAt(start + 1)) === false) start += 1;
  while (start > 0 && surrogateTrail(text.charCodeAt(start))) start -= 1;
  while (end > start && surrogateLead(text.charCodeAt(end - 1))) end -= 1;
  while (end < text.length && surrogateTrail(text.charCodeAt(end))) end += 1;
  if (end - start < 2) {
    /* 短块兜底：整块（块边界本身就是锚定边界）。 */
    start = 0;
    end = text.length;
  }
  return { blockId: block.blockId, start: block.start + start, end: block.start + end, excerpt: text.slice(start, end) };
}

/** PDF 页文本层上的规范选区（文本层 .material-block 的 textContent 与页块
 *  文本字节相等——页头「Page N」在层外，偏移换算干净；页框含页头，不可用）。 */
export function pageSelectPdfLayer(blockId, start, end) {
  return `(() => {
    const layer = document.querySelector("#mat-blocks .pdf-page-text" + "[data-block-id=" + JSON.stringify(${JSON.stringify(blockId)}) + "]");
    if (layer === null) return { error: "pdf page text layer ${blockId} is not present (scroll it into view first)" };
    if (layer.dataset.rendered !== "true") return { error: "pdf page text layer ${blockId} is not rendered yet" };
    const blockStart = Number(layer.dataset.start);
    const localStart = ${Number(start)} - blockStart;
    const localEnd = ${Number(end)} - blockStart;
    if (!(localStart >= 0) || localEnd > layer.textContent.length) {
      return { error: "canonical range [${start}, ${end}) is outside page block ${blockId}" };
    }
    const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
    let pos = 0;
    let a = null;
    let b = null;
    for (;;) {
      const node = walker.nextNode();
      if (node === null) break;
      const len = node.data.length;
      if (a === null && localStart <= pos + len) a = { node, offset: localStart - pos };
      if (b === null && localEnd <= pos + len) b = { node, offset: localEnd - pos };
      pos += len;
    }
    if (a === null || b === null) return { error: "offsets did not map onto text nodes of ${blockId}" };
    const range = document.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return { selectedText: selection.toString() };
  })()`;
}

/* ------------------------------------------------------------------ */
/* 场景准备（幂等）：pdf fixture 导入 + 选区确定                         */
/* ------------------------------------------------------------------ */

/** PDF 阅读器就位（页框数 + 尾部「N page(s) in view · end of material (last page)」）。 */
export function pdfReaderLoadedExpr(pages) {
  return `(() => { const reader = document.getElementById("material-reader"); ` +
    `if (reader === null || reader.hidden) return false; ` +
    `const frames = document.querySelectorAll("#mat-blocks .pdf-page-frame").length; ` +
    `if (frames !== ${String(pages)}) return false; ` +
    `const tail = document.getElementById("mat-tail"); ` +
    `if (tail === null) return false; ` +
    `const text = tail.textContent ?? ""; ` +
    `if (!text.includes(${JSON.stringify(`${String(pages)} page(s) in view`)})) return false; ` +
    `if (!text.includes("end of material (last page)")) return false; ` +
    `return { frames, tail: text }; })()`;
}
