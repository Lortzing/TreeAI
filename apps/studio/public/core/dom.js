/** DOM identity/reuse rules used across conversation and terminology. */
export function isElementNode(node) {
  return (
    node !== null &&
    typeof node === "object" &&
    typeof node.classList === "object" &&
    node.classList !== null &&
    typeof node.dataset === "object"
  );
}


export function findReusableTurnElement(container, turn) {
  for (const child of container.children) {
    if (!isElementNode(child)) continue;
    if (!child.classList.contains("turn") || child.classList.contains("return")) continue;
    if (child.dataset.turnId !== turn.id) continue;
    if (child.dataset.turnText !== turn.text) continue;
    return child;
  }
  return null;
}

