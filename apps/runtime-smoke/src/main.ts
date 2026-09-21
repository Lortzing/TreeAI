/**
 * CLI entry for the Wave 2 offline smoke scenario.
 *
 * Runs the full 11-step integration flow in a fresh temp directory and
 * prints a compact, secret-free summary (markers and counts only — no
 * absolute paths, no credentials, no session content).
 *
 * Also serves as the sandbox probe: this file performs no I/O outside its
 * temp directory and never touches the user's Pi home (~/.pi).
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWave2Scenario } from "./scenario.ts";

const root = await mkdtemp(join(tmpdir(), "treeai-runtime-smoke-"));
const report = await runWave2Scenario(root);
process.stdout.write(
  [
    "runtime-smoke:scenario ok",
    `runtime-smoke:runs ${report.runs} (succeeded=${report.succeeded} failed=${report.failed} aborted=${report.aborted})`,
    `runtime-smoke:journal-events gen1=${report.journalEventsGen1} gen2=${report.journalEventsGen2}`,
    `runtime-smoke:recovered-runs ${report.recoveredRuns}`,
    `runtime-smoke:policy-decisions ${report.policyDecisions}`,
    `runtime-smoke:session-files created=${report.sessionFilesCreated} persisted=${report.sessionFilesPersisted}`,
    "",
  ].join("\n"),
);
