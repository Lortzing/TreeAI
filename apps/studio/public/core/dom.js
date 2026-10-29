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

/** Secondary implementation details are available without occupying the reading surface. */
export function createDisclosure(document, label, ...content) {
  const details = document.createElement("details");
  details.className = "technical-details";
  const summary = document.createElement("summary");
  summary.textContent = label;
  details.append(summary, ...content);
  return details;
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

