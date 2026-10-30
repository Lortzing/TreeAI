/** Rectangle text capture still resolves through the existing canonical selection contract. */
export function wireRegionSelection({ document, window, root, blocks, arm, notify }) {
  let start = null, overlay = null;
  const intersects = (a, b) => a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom;
  const clear = () => { start = null; overlay?.remove(); overlay = null; };
  blocks.addEventListener("pointerdown", event => {
    if (root.dataset.selectionMode !== "region" || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    start = { x: event.clientX, y: event.clientY };
    blocks.setPointerCapture?.(event.pointerId);
    overlay = document.createElement("div"); overlay.className = "region-selection-box";
    overlay.setAttribute("aria-hidden", "true"); root.append(overlay);
  });
  blocks.addEventListener("pointermove", event => {
    if (!start || !overlay) return;
    const r = root.getBoundingClientRect();
    Object.assign(overlay.style, { left: `${Math.min(start.x, event.clientX) - r.left}px`, top: `${Math.min(start.y, event.clientY) - r.top}px`, width: `${Math.abs(start.x - event.clientX)}px`, height: `${Math.abs(start.y - event.clientY)}px` });
  });
  blocks.addEventListener("pointercancel", clear);
  blocks.addEventListener("pointerup", event => {
    if (!start) return;
    event.preventDefault(); event.stopPropagation();
    const box = { left: Math.min(start.x, event.clientX), right: Math.max(start.x, event.clientX), top: Math.min(start.y, event.clientY), bottom: Math.max(start.y, event.clientY) };
    clear();
    if (box.right - box.left < 4 || box.bottom - box.top < 4) { notify("拖出一个矩形，选择要提问的文字。"); return; }
    const matches = [];
    let inspected = 0;
    for (const block of blocks.querySelectorAll(".material-block")) {
      if (!intersects(block.getBoundingClientRect(), box)) continue;
      const walker = document.createTreeWalker(block, 4);
      let node, first = null, last = null;
      while ((node = walker.nextNode())) {
        const range = document.createRange(); range.selectNodeContents(node);
        if (![...range.getClientRects()].some(rect => intersects(rect, box))) continue;
        for (let i = 0; i < node.textContent.length; i++) {
          if (++inspected > 100000) { notify("框选范围过大，请缩小范围后重试。"); return; }
          range.setStart(node, i); range.setEnd(node, i + 1);
          if ([...range.getClientRects()].some(rect => rect.width > 0 && intersects(rect, box))) {
            first ??= { node, offset: i }; last = { node, offset: i + 1 };
          }
        }
      }
      if (first && last) matches.push({ first, last });
    }
    if (matches.length !== 1) { notify(matches.length ? "请在同一段落或同一页内框选，避免混合不同出处。" : "框内没有可选择的文字。图片区域尚需文字识别。请改选可读文字。"); return; }
    const { first, last } = matches[0];
    const range = document.createRange(); range.setStart(first.node, first.offset); range.setEnd(last.node, last.offset);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    root.dataset.selectionMode = "text";
    for (const button of root.querySelectorAll("[data-selection-tool]")) button.setAttribute("aria-pressed", String(button.dataset.selectionTool === "text"));
    notify("已选择框内首尾文字之间的连续原文，请核对摘录后提问。");
    arm();
  });
}
