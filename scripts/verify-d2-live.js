#!/usr/bin/env node
/**
 * verify-d2-live — TreeAI D2 live scenario suite (Agent F).
 *
 * Runs the six frozen scenarios (basic, tool-policy, steer, abort, resume,
 * tree-navigation) through tests/live/framework.ts.
 *
 * Exit codes (same discipline as verify-d2):
 *   0 — every scenario PASS
 *   1 — the verifier itself failed
 *   2 — at least one FAIL
 *   3 — no FAIL, but BLOCKED or NOT_RUN present
 *
 * Credential policy (task book §5 Agent F item 3):
 *   - credentials enter ONLY through the controlled env vars
 *     TREEAI_LIVE_PROVIDER_ID, TREEAI_LIVE_MODEL_ID, TREEAI_LIVE_API_KEY;
 *   - the user's real Pi configuration (~/.pi) is NEVER read — no fallback,
 *     no shortcut;
 *   - values are held in memory, handed to the runtime factory, and never
 *     logged, persisted or written into evidence (a belt-and-braces guard
 *     below additionally strips the literal value from every write);
 *   - missing credentials => every scenario BLOCKED, exit 3.
 *
 * Drivers:
 *   --driver=pi   (default) real @treeai/runtime-pi; requires credentials
 *   --driver=fake offline dry-run of the same six scenarios against
 *                 FakePiRuntime; zero credentials (recorded as such)
 *
 * Evidence: evidence/d2/runs/<UTC-run-id>/{environment.json,result.json,
 * events.jsonl,checks.json,logs/,sessions/} — append-only, never overwriting
 * a historical run; session transcripts live inside the run dir so the
 * post-write secret rescan covers them too.
 *
 * Root package.json wiring (verify:d2:live) is the Integrator's job.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { EvidenceWriter } from "../tests/support/verifier/evidence.ts";
import { runScannerSelfTest } from "../tests/support/verifier/secret-scanner.ts";
import { validateJsonSchema } from "../tests/support/verifier/schema-validator.ts";
import {
  checkExitCodeConsistency,
  computeVerdict,
} from "../tests/support/verifier/verdict.ts";
import { readJson, runCommand, truncate, utcRunId } from "../tests/support/verifier/util.ts";
import {
  LIVE_SCENARIOS,
  defaultFakeScripts,
  fakeDriver,
  loadPiDriver,
  runOneScenario,
} from "../tests/live/framework.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const VERIFIER_NAME = "verify-d2-live";
const VERIFIER_VERSION = "1.0.0";

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

const args = process.argv.slice(2);
/** Parse flags in both `--name=value` and `--name value` forms. */
function argValue(name) {
  const prefix = `--${name}=`;
  for (const a of args) {
    if (a.startsWith(prefix)) return a.slice(prefix.length);
  }
  const i = args.indexOf(`--${name}`);
  if (i !== -1 && i + 1 < args.length && !args[i + 1].startsWith("--")) {
    return args[i + 1];
  }
  return null;
}
const ROOT = argValue("root") ?? join(SCRIPT_DIR, "..");
const RUNS_ROOT = argValue("runs-root") ?? join(ROOT, "evidence", "d2", "runs");
const DRIVER_ARG = argValue("driver") ?? "pi";
if (DRIVER_ARG !== "pi" && DRIVER_ARG !== "fake") {
  console.error(`[verify-d2-live] unknown --driver=${DRIVER_ARG} (expected pi|fake)`);
  process.exit(1);
}

/** Controlled credential env var NAMES (only ever the names are logged). */
const ENV_PROVIDER = "TREEAI_LIVE_PROVIDER_ID";
const ENV_MODEL = "TREEAI_LIVE_MODEL_ID";
const ENV_API_KEY = "TREEAI_LIVE_API_KEY";

/* ------------------------------------------------------------------ */
/* Credential-value guard (belt and braces on top of the writer)        */
/* ------------------------------------------------------------------ */

/** The live credential value, if any. Never logged, only substring-matched. */
let credentialValue = null;
let credentialStripped = 0;

/** Remove the literal credential value from any text bound for the disk. */
function stripCredential(text) {
  if (credentialValue === null || credentialValue.length < 8) return text;
  let out = text;
  while (out.includes(credentialValue)) {
    out = out.split(credentialValue).join("[CREDENTIAL-REDACTED]");
    credentialStripped += 1;
  }
  return out;
}

const items = [];
const writer = new EvidenceWriter(RUNS_ROOT, utcRunId("d2-live"));
const startedAt = new Date().toISOString();

function journalCheck(item) {
  writer.journal({
    type: "verify.check-finished",
    payload: {
      check: item.id,
      status: item.status,
      ...(item.durationMs !== undefined ? { durationMs: item.durationMs } : {}),
    },
  });
}

function pushItem(item) {
  items.push(item);
  journalCheck(item);
  const mark = item.status === "PASS" ? "PASS" : item.status === "FAIL" ? "FAIL" : item.status;
  console.log(`  [${mark}] ${item.id}${item.reason !== undefined ? ` — ${item.reason}` : ""}`);
}

/** Guarded JSON write that additionally strips the credential literal. */
function writeJsonUltraGuarded(relPath, value) {
  const raw = `${JSON.stringify(value, null, 2)}\n`;
  return writer.writeTextGuarded(relPath, stripCredential(raw));
}

/* ------------------------------------------------------------------ */
/* Environment record                                                  */
/* ------------------------------------------------------------------ */

function collectEnvironment(driverName, credentialPolicy) {
  const npmVersion = runCommand("npm", ["--version"], { cwd: ROOT });
  const gitHead = runCommand("git", ["rev-parse", "HEAD"], { cwd: ROOT });
  const tsPkg = readJson(join(ROOT, "node_modules", "typescript", "package.json"));
  const installedPiPkg = readJson(
    join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
  );
  return {
    schemaVersion: "d2-environment-1",
    generatedAt: new Date().toISOString(),
    mode: "live",
    driver: driverName,
    runtime: {
      node: process.version,
      npm: npmVersion.status === 0 ? npmVersion.stdout.trim() : "unknown",
      platform: process.platform,
      arch: process.arch,
      ...(tsPkg && typeof tsPkg.version === "string" ? { typeScript: tsPkg.version } : {}),
      ci: process.env.CI !== undefined,
    },
    pi: {
      pinnedVersion: "0.85.1",
      installedVersion:
        installedPiPkg && typeof installedPiPkg.version === "string"
          ? installedPiPkg.version
          : null,
      ...(installedPiPkg
        ? { source: "node_modules/@earendil-works/pi-coding-agent/package.json" }
        : {}),
    },
    credentialPolicy,
    ...(gitHead.status === 0 ? { git: { commit: gitHead.stdout.trim() } } : {}),
    verifier: { name: VERIFIER_NAME, version: VERIFIER_VERSION },
  };
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  console.log(`verify-d2-live ${VERIFIER_VERSION} — live scenario suite`);
  console.log(`root: ${ROOT}`);
  console.log(`driver: ${DRIVER_ARG}`);
  console.log(`evidence: ${writer.runDir}`);
  console.log("");

  writer.journal({
    type: "verify.run-started",
    payload: { mode: "live", verifier: VERIFIER_NAME, version: VERIFIER_VERSION, driver: DRIVER_ARG },
  });

  const records = [];
  let driver = null;
  let driverName = DRIVER_ARG;
  let credentialPolicy;

  if (DRIVER_ARG === "fake") {
    driver = fakeDriver({ scriptByScenario: defaultFakeScripts() });
    credentialPolicy = {
      policy: "offline",
      note: "--driver=fake: the same six scenarios run against FakePiRuntime; no credentials are present, needed, or read, and the user's real Pi config was not touched",
    };
  } else {
    const providerId = process.env[ENV_PROVIDER];
    const modelId = process.env[ENV_MODEL];
    const apiKey = process.env[ENV_API_KEY];
    const missing = [];
    if (typeof providerId !== "string" || providerId.length === 0) missing.push(ENV_PROVIDER);
    if (typeof modelId !== "string" || modelId.length === 0) missing.push(ENV_MODEL);
    if (typeof apiKey !== "string" || apiKey.length === 0) missing.push(ENV_API_KEY);

    if (missing.length > 0) {
      // Missing credentials: every scenario BLOCKED, exit 3. Names only.
      credentialPolicy = {
        policy: "none",
        note: `live credentials missing: ${missing.join(", ")} (env var NAMES only are logged; values never). The user's real Pi config was NOT read as a shortcut`,
      };
      console.log(`credentials: missing ${missing.join(", ")} — all scenarios BLOCKED`);
      for (const scenario of LIVE_SCENARIOS) {
        records.push({
          id: `live-scenario-${scenario.id}`,
          status: "BLOCKED",
          exitCode: null,
          scenario: scenario.id,
          driver: "pi",
          piVersion: "0.85.1",
          reason: `live credentials not provided (set ${missing.join(", ")}); no fallback to the user's real Pi config`,
        });
      }
      driver = null;
    } else {
      credentialValue = apiKey;
      credentialPolicy = {
        policy: "controlled-env-injection",
        note: `credentials supplied exclusively via ${ENV_PROVIDER}, ${ENV_MODEL}, ${ENV_API_KEY}; held in memory only, handed to the runtime factory, never persisted or logged; the user's real Pi config was not read`,
      };
      const loaded = await loadPiDriver({ credentials: { apiKey } });
      if (loaded.driver === null) {
        console.log(`pi driver unavailable: ${loaded.problem}`);
        for (const scenario of LIVE_SCENARIOS) {
          records.push({
            id: `live-scenario-${scenario.id}`,
            status: "NOT_RUN",
            exitCode: null,
            scenario: scenario.id,
            driver: "pi",
            piVersion: "0.85.1",
            reason: `real runtime driver unavailable: ${loaded.problem}`,
          });
        }
      } else {
        driver = loaded.driver;
      }
    }
  }

  writeJsonUltraGuarded("environment.json", collectEnvironment(driverName, credentialPolicy));

  if (driver !== null) {
    // Sessions live INSIDE the run dir: they are run evidence, and the
    // post-write secret rescan therefore covers them too.
    const sessionDir = join(writer.runDir, "sessions");
    const model =
      DRIVER_ARG === "fake"
        ? { providerId: "fake-provider", modelId: "fake-model" }
        : {
            providerId: process.env[ENV_PROVIDER],
            modelId: process.env[ENV_MODEL],
          };
    for (const scenario of LIVE_SCENARIOS) {
      const record = await runOneScenario({
        driver,
        model,
        sessionDir: join(sessionDir, scenario.id),
        scenario,
      });
      writeJsonUltraGuarded(`logs/${record.id}.json`, record);
      records.push(record);
      writer.journal({
        type: "verify.scenario-finished",
        payload: {
          scenario: record.scenario,
          status: record.status,
          durationMs: record.durationMs,
        },
      });
    }
  }

  // ---- scenario records must conform to the scenarioResult schema ------
  const scenarioSchema = scenarioResultSchema();
  const schemaProblems = [];
  for (const record of records) {
    const res = validateJsonSchema(record, scenarioSchema);
    if (!res.valid) {
      schemaProblems.push(
        `${record.id}: ${res.errors.map((e) => e.message).join("; ")}`,
      );
    }
  }
  pushItem({
    id: "scenario-results-schema",
    status: schemaProblems.length === 0 ? "PASS" : "FAIL",
    exitCode: schemaProblems.length === 0 ? 0 : 1,
    ...(schemaProblems.length === 0
      ? { detail: `all ${records.length} records conform to $defs/scenarioResult` }
      : { error: { message: truncate(schemaProblems.join("; "), 2000) } }),
  });

  // ---- exit-code discipline --------------------------------------------
  const exitProblems = checkExitCodeConsistency([...records, ...items]);
  pushItem({
    id: "exit-codes",
    status: exitProblems.length === 0 ? "PASS" : "FAIL",
    exitCode: exitProblems.length === 0 ? 0 : 1,
    ...(exitProblems.length === 0
      ? { detail: "all records follow the frozen status/exitCode discipline" }
      : { error: { message: exitProblems.join("; ") } }),
  });

  // ---- evidence write hygiene -------------------------------------------
  const preWriteLeaks = [...writer.preWriteLeaks];
  const hygieneProblems = [...preWriteLeaks.map((f) => `pre-write leak (${f.ruleId}) was masked and recorded`)];
  if (credentialStripped > 0) {
    hygieneProblems.push(`the literal credential value appeared ${credentialStripped} time(s) in verifier output and was stripped`);
  }
  pushItem({
    id: "evidence-write-hygiene",
    status: hygieneProblems.length === 0 ? "PASS" : "FAIL",
    exitCode: hygieneProblems.length === 0 ? 0 : 2,
    ...(hygieneProblems.length === 0
      ? { detail: "no secret-shaped content attempted to enter the evidence" }
      : { error: { message: hygieneProblems.join("; ") } }),
  });

  // ---- assemble + write final artifacts ----------------------------------
  const allItems = [...records, ...items];
  const summary = computeVerdict(allItems);
  const result = {
    runId: writer.runId,
    schemaVersion: "d2-result-1",
    mode: "live",
    driver: driverName,
    startedAt,
    endedAt: new Date().toISOString(),
    verdict: summary.verdict,
    counts: summary.counts,
    exitCode: summary.exitCode,
    results: allItems,
    notes: [
      DRIVER_ARG === "fake"
        ? "--driver=fake: framework dry-run against FakePiRuntime (zero credentials)"
        : "real-driver run; credentials via controlled env injection only",
    ],
  };
  writeJsonUltraGuarded("checks.json", { runId: writer.runId, checks: allItems });
  writeJsonUltraGuarded("result.json", result);

  // ---- post-write discipline ---------------------------------------------
  const journalCheckResult = writer.verifyJournalOnDisk();
  const postScan = writer.postWriteScan();
  const overrides = [];
  if (!journalCheckResult.ok) overrides.push(...journalCheckResult.problems);
  if (postScan.findings.length > 0) {
    overrides.push(
      `post-write scan found ${postScan.findings.length} finding(s) in the run dir (rules: ${[
        ...new Set(postScan.findings.map((f) => f.ruleId)),
      ].join(", ")})`,
    );
  }
  const finalResultRes = validateJsonSchema(
    readJson(join(writer.runDir, "result.json")),
    readJson(join(ROOT, "schemas", "d2", "result.schema.json")),
  );
  if (!finalResultRes.valid) {
    overrides.push(...finalResultRes.errors.map((e) => `final result.json: ${e.message}`));
  }

  let verdict = summary.verdict;
  let exitCode = summary.exitCode;
  if (overrides.length > 0 && verdict !== "HAS_FAIL") {
    verdict = "HAS_FAIL";
    exitCode = 2;
    const overridden = { ...result, verdict, exitCode };
    overridden.notes = [
      ...(result.notes ?? []),
      `verdict overridden by post-write discipline: ${overrides.join("; ")}`,
    ];
    writeJsonUltraGuarded("result.json", overridden);
  }

  writer.journal({
    type: "verify.run-finished",
    payload: {
      verdict,
      exitCode,
      counts: summary.counts,
      overrides,
    },
  });

  console.log("");
  console.log("verify-d2-live summary:");
  console.log(
    `  ${summary.counts.pass} PASS, ${summary.counts.fail} FAIL, ${summary.counts.blocked} BLOCKED, ${summary.counts.notRun} NOT_RUN`,
  );
  if (overrides.length > 0) {
    console.log(`  verdict override: ${overrides.join("; ")}`);
  }
  console.log(`  verdict: ${verdict} (exit ${exitCode})`);
  console.log(`  evidence: ${writer.runDir}`);
  process.exit(exitCode);
}

function scenarioResultSchema() {
  const resultSchema = readJson(join(ROOT, "schemas", "d2", "result.schema.json"));
  return { $ref: "#/$defs/scenarioResult", $defs: resultSchema["$defs"] };
}

main().catch((err) => {
  console.error(`[verify-d2-live] VERIFIER_ERROR: ${String(err)}`);
  try {
    writer.journal({
      type: "verify.run-finished",
      payload: { verdict: "VERIFIER_ERROR", exitCode: 1, error: stripCredential(String(err)) },
    });
    writeJsonUltraGuarded("result.json", {
      runId: writer.runId,
      schemaVersion: "d2-result-1",
      mode: "live",
      driver: DRIVER_ARG,
      startedAt,
      endedAt: new Date().toISOString(),
      verdict: "VERIFIER_ERROR",
      counts: { pass: 0, fail: 0, blocked: 0, notRun: 1 },
      exitCode: 1,
      results: [
        {
          id: "verifier",
          status: "NOT_RUN",
          exitCode: 1,
          reason: `verifier crashed before completing: ${stripCredential(String(err)).slice(0, 500)}`,
        },
      ],
      notes: ["verifier self-error; scenarios after the crash point were not executed"],
    });
  } catch {
    // the process exit code still tells the truth
  }
  process.exit(1);
});
