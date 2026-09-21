/**
 * Verdict computation for the D2 verifier (Agent F).
 *
 * Frozen exit-code semantics (task book §5 Agent F):
 *   0 — every requested check PASS
 *   1 — the verifier itself failed (not computed here; the entry script maps
 *       its own unexpected exceptions to 1)
 *   2 — at least one FAIL
 *   3 — no FAIL, but BLOCKED or NOT_RUN present
 *
 * This module is pure (no I/O) so it can be unit-tested exhaustively,
 * including the failure paths the self-test must demonstrate.
 */

export type ResultStatus = "PASS" | "FAIL" | "BLOCKED" | "NOT_RUN";

export interface ResultItem {
  readonly id: string;
  readonly status: ResultStatus;
  readonly exitCode: number | null;
  readonly evidenceFiles?: readonly string[];
  readonly error?: { message: string; code?: string; details?: unknown };
  readonly reason?: string;
  readonly durationMs?: number;
  readonly detail?: string;
  readonly meta?: Record<string, unknown>;
}

export type Verdict = "ALL_PASS" | "HAS_FAIL" | "INCOMPLETE" | "VERIFIER_ERROR";

export interface VerdictSummary {
  readonly counts: { readonly pass: number; readonly fail: number; readonly blocked: number; readonly notRun: number };
  readonly verdict: Verdict;
  readonly exitCode: number;
}

export function computeVerdict(items: readonly ResultItem[]): VerdictSummary {
  let pass = 0;
  let fail = 0;
  let blocked = 0;
  let notRun = 0;
  for (const item of items) {
    switch (item.status) {
      case "PASS":
        pass++;
        break;
      case "FAIL":
        fail++;
        break;
      case "BLOCKED":
        blocked++;
        break;
      case "NOT_RUN":
        notRun++;
        break;
    }
  }
  if (fail > 0) {
    return {
      counts: { pass, fail, blocked, notRun },
      verdict: "HAS_FAIL",
      exitCode: 2,
    };
  }
  if (blocked > 0 || notRun > 0) {
    return {
      counts: { pass, fail, blocked, notRun },
      verdict: "INCOMPLETE",
      exitCode: 3,
    };
  }
  return {
    counts: { pass, fail, blocked, notRun },
    verdict: "ALL_PASS",
    exitCode: 0,
  };
}

/**
 * Independent exit-code discipline check (defense in depth: the result schema
 * enforces the same rule structurally; this function re-checks the assembled
 * items so a schema bug can never smuggle an illegal exit code through).
 *
 * Returns one problem string per violation; empty = consistent.
 */
export function checkExitCodeConsistency(items: readonly ResultItem[]): string[] {
  const problems: string[] = [];
  for (const item of items) {
    const ec = item.exitCode;
    switch (item.status) {
      case "PASS":
        if (ec !== 0) {
          problems.push(`${item.id}: PASS must carry exitCode 0, got ${String(ec)}`);
        }
        break;
      case "FAIL":
        if (typeof ec !== "number" || !Number.isInteger(ec) || ec < 1) {
          problems.push(`${item.id}: FAIL must carry a non-zero integer exitCode, got ${String(ec)}`);
        }
        if (!item.error || typeof item.error.message !== "string" || item.error.message.length === 0) {
          problems.push(`${item.id}: FAIL must carry a structured error`);
        }
        break;
      case "BLOCKED":
        if (ec === 0 || (ec !== null && (typeof ec !== "number" || !Number.isInteger(ec) || ec < 1))) {
          problems.push(`${item.id}: BLOCKED must carry null or a non-zero integer exitCode, got ${String(ec)}`);
        }
        if (typeof item.reason !== "string" || item.reason.length === 0) {
          problems.push(`${item.id}: BLOCKED must carry a reason`);
        }
        break;
      case "NOT_RUN":
        if (ec === 0 || (ec !== null && (typeof ec !== "number" || !Number.isInteger(ec) || ec < 1))) {
          problems.push(`${item.id}: NOT_RUN must carry null or a non-zero integer exitCode, got ${String(ec)}`);
        }
        if (typeof item.reason !== "string" || item.reason.length === 0) {
          problems.push(`${item.id}: NOT_RUN must carry a reason (never fake a pass)`);
        }
        break;
    }
    if (item.status !== "PASS" && item.status !== "FAIL" && item.status !== "BLOCKED" && item.status !== "NOT_RUN") {
      problems.push(`${item.id}: unknown status ${String(item.status)}`);
    }
  }
  return problems;
}
