export function createDiagnosticsView({ document, getElement, getState, branchLabel }) {
  function renderFailurePanel(run) {
    const state = getState();
    const panel = getElement("failure-panel");
    if (run === null || run.failure === null || state.dismissedFailureRunIds.has(run.runId)) {
      panel.hidden = true;
      return;
    }
    panel.replaceChildren();
    const label = document.createElement("span");
    label.className = "failure-panel-label";
    label.textContent = `Run ${run.runId.slice(0, 12)}… failed — ${run.failure.code}: ${run.failure.message}`;
    const dismiss = document.createElement("button");
    dismiss.className = "failure-panel-dismiss";
    dismiss.textContent = "Dismiss";
    dismiss.addEventListener("click", () => {
      state.dismissedFailureRunIds.add(run.runId);
      renderFailurePanel(run);
    });
    panel.append(label, dismiss);
    panel.hidden = false;
  }

  function renderDiagnostics() {
    const state = getState();
    const bar = getElement("diagnostics-bar");
    if (state.diagnostics === null || state.treeState === null) {
      bar.hidden = true;
      renderFailurePanel(null);
      return;
    }
    const diag = state.diagnostics;
    bar.hidden = false;

    const status = getElement("run-status");
    status.textContent = diag.runtimeState;
    status.className = `run-status ${diag.runtimeState}`;

    const parts = [];
    if (diag.activeRun !== null) {
      parts.push(`active run on ${branchLabel(diag.activeRun.branchId)}`);
    }
    const last = diag.runs.length > 0 ? diag.runs[diag.runs.length - 1] : null;
    const detail = getElement("run-detail");
    detail.replaceChildren();
    if (parts.length > 0) {
      detail.append(document.createTextNode(`${parts.join(" · ")} · `));
    }
    if (last === null) {
      detail.append(document.createTextNode("no runs yet"));
    } else {
      const stateSpan = document.createElement("span");
      stateSpan.className = `last-run-state ${last.state}`;
      stateSpan.textContent = `last run: ${last.state}`;
      detail.append(stateSpan);
    }

    const lastFailed = [...diag.runs].reverse().find((run) => run.failure !== null) ?? null;
    renderFailurePanel(lastFailed);

    const abortButton = getElement("abort-run");
    const isActive = diag.activeRun !== null;
    abortButton.hidden = !isActive;
    abortButton.textContent = diag.runtimeState === "aborting" ? "Aborting…" : "Abort run";
    abortButton.disabled = diag.runtimeState === "aborting";

    const policy = diag.policyDecisions;
    if (policy.observed === false) {
      getElement("policy-note").textContent = `policy: no decisions observed — ${policy.reason}`;
    } else {
      const latest = policy.decisions[policy.decisions.length - 1];
      const latestNote =
        latest === undefined
          ? ""
          : ` — latest: ${latest.tool ?? "unknown tool"} ${latest.outcome} (${latest.ruleId ?? "no rule"})`;
      getElement("policy-note").textContent = `policy: ${String(policy.decisions.length)} decision(s) observed${latestNote}`;
    }
  }

  return { renderDiagnostics, renderFailurePanel };
}
