/** models owner; frozen probe bodies and order preserved. */






















export interface B6ScaleCheckOutcome {
  readonly status: "PASS" | "FAIL" | "NOT_RUN";
  readonly exitCode: number | null;
  /** One-line summary for the check matrix. */
  readonly detail: string;
  /** Per-item execution lines (evidence log). */
  readonly lines: readonly string[];
  readonly problems: readonly string[];
  /** Honest NOT_RUN scope (browser face; carried into the evidence record). */
  readonly notRun: readonly string[];
}
