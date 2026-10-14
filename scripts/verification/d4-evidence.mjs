import { join, basename } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { truncate } from "../../tests/support/verifier/util.ts";
/** d4-evidence original ordered checks Instance-owned state and dependencies. */

export function createD4Evidence(deps) {

  /* ------------------------------------------------------------------ */
  /* Browser-face evidence audit (b6-browser-face / b9-nav-browser-face)  */
  /* ------------------------------------------------------------------ */

  /**
   * Audit the committed run:d4-browser evidence (evidence/d4/browser/<runId>/):
   * the newest run whose summary.json carries checkId PASS wins; its numbered
   * sidecar (NN-<sidecarName>.json) is validated by the caller's rules and the
   * recorded numbers are reported with the run's binding (runId / gitCommit /
   * mode). Absent or failed evidence stays NOT_RUN (never a silent PASS).
   * The browser measurement itself belongs to run:d4-browser (real Chrome +
   * real studio processes); this audit verifies the recorded evidence is
   * present, complete, and within the charter budgets.
   */
  function auditBrowserEvidence(root, checkId, sidecarName, { validate, describe }) {
    const browserDir = join(root, "evidence", "d4", "browser");
    if (!existsSync(browserDir)) {
      return {
        status: "NOT_RUN",
        exitCode: null,
        reason: "no evidence/d4/browser yet — the run:d4-browser evidence run has not been recorded",
      };
    }
    const runDirs = readdirSync(browserDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(browserDir, entry.name))
      .filter((dir) => existsSync(join(dir, "summary.json")))
      .sort()
      .reverse(); /* run ids are UTC-timestamped — lexicographic = chronological */
    for (const runDir of runDirs) {
      let summary = null;
      try {
        summary = JSON.parse(readFileSync(join(runDir, "summary.json"), "utf8"));
      } catch {
        continue;
      }
      const check = (summary.checks ?? []).find((candidate) => candidate.id === checkId);
      if (check === undefined) continue;
      if (check.status !== "PASS") {
        return {
          status: "FAIL",
          exitCode: 2,
          error: {
            message: `the newest recorded ${checkId} evidence run is not PASS (${String(check.status)}${
              check.error !== undefined ? `: ${truncate(String(check.error.message ?? ""), 300)}` : ""
            }) — re-run run:d4-browser and record the evidence`,
          },
          detail: `evidence run ${summary.runId ?? basename(runDir)} (mode ${String(summary.mode)})`,
        };
      }
      const sidecarFile = readdirSync(runDir).find((name) => name.endsWith(`-${sidecarName}.json`));
      if (sidecarFile === undefined) {
        return {
          status: "FAIL",
          exitCode: 2,
          error: { message: `the ${checkId} evidence run ${summary.runId ?? basename(runDir)} carries no ${sidecarName} sidecar` },
        };
      }
      let sidecar = null;
      try {
        sidecar = JSON.parse(readFileSync(join(runDir, sidecarFile), "utf8"));
      } catch (err) {
        return { status: "FAIL", exitCode: 2, error: { message: `sidecar ${sidecarFile} is not readable JSON: ${String(err)}` } };
      }
      const problems = validate(sidecar);
      if (problems.length > 0) {
        return {
          status: "FAIL",
          exitCode: 2,
          error: { message: `recorded ${checkId} evidence violates the charter budgets: ${problems.join("; ")}` },
          detail: `evidence run ${summary.runId ?? basename(runDir)}`,
        };
      }
      const binding = `evidence run ${summary.runId ?? basename(runDir)} (mode ${String(summary.mode)}, gitCommit ${
        summary.gitCommit ?? "unknown"
      }, recorded ${String(summary.generatedAt ?? "?")}); local-machine engineering evidence (environment in the sidecar; never claimed cross-machine); the final candidate-SHA regression re-runs run:d4-browser`;
      return {
        status: "PASS",
        exitCode: 0,
        detail: `${describe(sidecar)} — ${binding}`,
        evidenceFiles: [join("evidence", "d4", "browser", basename(runDir), sidecarFile)],
      };
    }
    return {
      status: "NOT_RUN",
      exitCode: null,
      reason: `no recorded run:d4-browser evidence carries ${checkId} PASS yet — run scripts/run-d4-browser.mjs --mode selftest with --artifacts evidence/d4/browser/<runId> and commit it`,
    };
  }

  return {
    auditBrowserEvidence,
  };
}
