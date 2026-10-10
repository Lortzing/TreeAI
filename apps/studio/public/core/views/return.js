const RETURN_EXCERPT_COLLAPSE_THRESHOLD = 120;

export function createReturnCardRenderer({
  document,
  getCurrentTreeId,
  getTreeState,
  knownReturnIds,
  seenDeliveredRunIds,
  turnElements,
  returnInsertedAt,
  deliveredChangedAt,
  motionEpochMs,
  branchLabel,
  formatProductTime,
  openDrawer,
}) {
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

  function returnFallbackReason(turn) {
    const treeState = getTreeState();
    const anchor = turn.targetAnchor;
    if (treeState === null || anchor === null) return { kind: "missing", anchor: null };
    let anchorTurn = null;
    for (const view of treeState.branches) {
      const found = view.turns.find((candidate) => candidate.id === anchor.anchorTurnId);
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

  function returnCard(turn, anchor, attempts, placement) {
    const treeKey = `${getCurrentTreeId()}:${turn.id}`;
    const nowMs = Date.now();
    const div = document.createElement("div");
    div.className = "turn return";
    div.dataset.turnId = turn.id;
    div.dataset.turnText = turn.text;
    turnElements.set(turn.id, div);
    if (!knownReturnIds.has(treeKey)) {
      knownReturnIds.add(treeKey);
      returnInsertedAt.set(treeKey, nowMs);
    }
    const insertedAt = returnInsertedAt.get(treeKey);
    if (insertedAt !== undefined && nowMs - insertedAt < motionEpochMs) {
      div.classList.add("insert");
    }

    const meta = document.createElement("span");
    meta.className = "meta";
    const from = branchLabel(turn.fromBranchId ?? "");
    const savedAt = formatProductTime(turn.createdAt);
    let anchorNote;
    let excerptElement = null;
    const shortExcerpt = anchor !== null && anchor.selection.text.length <= RETURN_EXCERPT_COLLAPSE_THRESHOLD;
    if (placement === "anchored" && anchor !== null) {
      anchorNote = shortExcerpt
        ? ` · anchored on “${anchor.selection.text}” from ${branchLabel(anchor.sourceBranchId)}`
        : ` · anchored on a long selection from ${branchLabel(anchor.sourceBranchId)}`;
      excerptElement = returnExcerptElement(anchor.selection.text);
    } else if (anchor !== null) {
      const reason = returnFallbackReason(turn);
      const inline = shortExcerpt ? ` (anchored on “${anchor.selection.text}”)` : "";
      if (reason.kind === "elsewhere") {
        anchorNote = ` · source on ${branchLabel(reason.anchor.sourceBranchId)}${inline}`;
      } else if (reason.kind === "changed") {
        anchorNote = ` · source changed${inline}`;
      } else if (reason.anchor !== null) {
        anchorNote = ` · source missing${inline}`;
      } else {
        anchorNote = " · original anchor unavailable";
      }
      excerptElement = returnExcerptElement(anchor.selection.text);
    } else {
      anchorNote = " · original anchor unavailable";
    }
    meta.append(document.createTextNode(`↩ Return from ${from} · saved ${savedAt}${anchorNote}`));

    const delivered = turn.deliveredRunId !== null;
    const delivery = document.createElement(delivered ? "button" : "span");
    delivery.className = `delivery${delivered ? " delivered delivery-link" : ""}`;
    const seenRun = seenDeliveredRunIds.get(treeKey);
    if (delivered && seenRun === null) {
      deliveredChangedAt.set(treeKey, nowMs);
    }
    const changedAt = deliveredChangedAt.get(treeKey);
    if (delivered && changedAt !== undefined && nowMs - changedAt < motionEpochMs) {
      delivery.classList.add("badge-change");
    }
    if (delivered) {
      const deliveredAttempt = attempts.find((attempt) => attempt.runId === turn.deliveredRunId);
      const adoptedNote =
        deliveredAttempt !== undefined && deliveredAttempt.terminalAt !== null
          ? `, adopted ${formatProductTime(deliveredAttempt.terminalAt)}`
          : "";
      delivery.textContent = `successfully adopted into Trunk context (run ${turn.deliveredRunId.slice(0, 12)}…${adoptedNote})`;
      delivery.title = `first successfully adopted into Trunk run ${turn.deliveredRunId} — open sources`;
      div.dataset.deliveredRunId = turn.deliveredRunId;
      div.title = `first successfully adopted into Trunk run ${turn.deliveredRunId}`;
      delivery.addEventListener("click", () =>
        void openDrawer({
          focusRunId: turn.deliveredRunId,
          trigger: { kind: "return-card", turnId: turn.id },
        }),
      );
    } else if (attempts.length > 0) {
      delivery.className = "delivery attempted";
      delivery.textContent = `adoption attempted (${String(attempts.length)}) — still pending, retried on the next Trunk discussion`;
      delivery.title = attempts
        .map((attempt) => `run ${attempt.runId.slice(0, 12)}… ${attempt.runState}${attempt.failure !== null ? ` (${attempt.failure.code})` : ""}`)
        .join("\n");
    } else {
      delivery.textContent = "saved — pending adoption on the next Trunk discussion";
    }
    seenDeliveredRunIds.set(treeKey, turn.deliveredRunId);
    meta.append(delivery);
    div.append(meta);
    if (excerptElement !== null) div.append(excerptElement);
    div.append(document.createTextNode(turn.text));
    return div;
  }

  return { returnCard };
}
