/** models owner; frozen probe bodies and order preserved. */














export interface B3ExplorationCheckOutcome {
  readonly status: "PASS" | "FAIL" | "NOT_RUN";
  readonly exitCode: number | null;
  /** One-line summary for the check matrix. */
  readonly detail: string;
  /** Per-scenario execution lines (evidence log). */
  readonly lines: readonly string[];
  readonly problems: readonly string[];
}
