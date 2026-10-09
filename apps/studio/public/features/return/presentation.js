/** Return display primitives. Domain facts and source mismatch are not synthesized. */
const RETURN_EXCERPT_COLLAPSE_THRESHOLD = 120;

export function createReturnExcerptElement(document) {
function returnExcerptElement(text) {
  if (text.length <= RETURN_EXCERPT_COLLAPSE_THRESHOLD) return null;
  const details = document.createElement("details");
  details.className = "return-excerpt collapsible";
  const summary = document.createElement("summary");
  summary.textContent = `“${text.slice(0, 100)}…”`;
  const full = document.createElement("span");
  full.className = "return-excerpt-full";
  full.textContent = `“${text}”`;
  details.append(summary, full);
  return details;
}

  return returnExcerptElement;
}

export function returnFallbackReason(st, turn) {
  const anchor = turn.targetAnchor;
  if (st === null || anchor === null) return { kind: "missing", anchor: null };
  let anchorTurn = null;
  for (const view of st.branches) {
    const found = view.turns.find((t) => t.id === anchor.anchorTurnId);
    if (found !== undefined) {
      anchorTurn = found;
      break;
    }
  }
  if (anchorTurn === null) return { kind: "missing", anchor };
  const stillHolds =
    anchorTurn.role === "assistant" &&
    anchorTurn.text.slice(anchor.selection.start, anchor.selection.end) === anchor.selection.text;
  if (!stillHolds) return { kind: "changed", anchor };
  return { kind: "elsewhere", anchor, anchorBranchId: anchorTurn.branchId };
}


export function returnAttemptsFor(view, turnId) {
  return (view.returnAttempts ?? []).filter((attempt) => attempt.turnId === turnId);
}


export function formatProductTime(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

