/** models owner; frozen probe bodies and order preserved. */



import type { RunId } from "@treeai/contracts";








/* ------------------------------------------------------------------ */
/* Scenario report                                                     */
/* ------------------------------------------------------------------ */

export interface ScenarioReport {
  readonly runs: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly aborted: number;
  readonly journalEventsGen1: number;
  readonly journalEventsGen2: number;
  readonly recoveredRuns: number;
  /** 请求路径上真实经门评估并落 journal 的 tool.decision 数（非合成）。 */
  readonly policyDecisions: number;
  readonly sessionFilesCreated: number;
  readonly sessionFilesPersisted: number;
}


export interface RunBook {
  readonly id: RunId;
  readonly label: string;
  readonly expected: "succeeded" | "failed" | "aborted";
}
