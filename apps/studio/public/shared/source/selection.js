/** Source selection range maps to UTF-16 units and fails closed on stale excerpts. */
export function createSelectionOffsetsWithin(window) {
function selectionOffsetsWithin(element, text) {
  const selection = window.getSelection();
  if (selection === null || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.commonAncestorContainer)) return null;
  const selected = range.toString();
  if (selected.length === 0) return null;
  const before = range.cloneRange();
  before.selectNodeContents(element);
  before.setEnd(range.startContainer, range.startOffset);
  const start = before.toString().length;
  if (text.slice(start, start + selected.length) !== selected) return null;
  return { start, end: start + selected.length, text: selected };
}

  return selectionOffsetsWithin;
}
