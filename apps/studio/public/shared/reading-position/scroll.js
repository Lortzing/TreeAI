/** Conservatively stick to bottom only when within the original threshold. */
export function createIsAtBottom(AT_BOTTOM_PX) {
function isAtBottom(container) {
  return container.scrollTop + container.clientHeight >= container.scrollHeight - AT_BOTTOM_PX;
}

  return isAtBottom;
}
