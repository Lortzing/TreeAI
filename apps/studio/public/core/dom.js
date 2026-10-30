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


/** Shared stroke icons for compact controls; paths are static application assets. */
export function controlIcon(document, name) {
  const paths = {
    plus: 'M12 5v14M5 12h14',
    microphone: 'M12 15a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v7a3 3 0 0 0 3 3ZM5 10v2a7 7 0 0 0 14 0v-2M12 19v3M9 22h6',
    stop: 'M7 7h10v10H7Z',
    text: 'M5 5h14M12 5v14M8 19h8',
    region: 'M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5',
  };
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'ui-icon' })) icon.setAttribute(key, value);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', paths[name] ?? paths.plus); icon.append(path); return icon;
}
