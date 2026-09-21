#!/usr/bin/env node
/**
 * verify-d2-selftest — failure-path selftest for the D2 gate (Agent F).
 *
 * Task book §5 Agent F item 5: "建立秘密扫描和失败路径自测，证明注入坏
 * schema/秘密/非法退出码时门禁失败" — prove, by actually injecting defects
 * and running the REAL verifier, that the gate fails when:
 *
 *   A. a secret-shaped file appears in the scanned workspace;
 *   B. a schema is weakened (event schema replaced by an accept-anything
 *      document → "invalid" probes start validating → constraint loss);
 *   C. the exit-code discipline constraints are stripped from the result
 *      schema (a PASS item with exitCode 1 becomes schema-valid);
 *   and that a CLEAN tree still passes (the gate is not vacuous).
 *
 * Each scenario builds a minimal synthetic tree (scripts/verify-d2.js +
 * tests/ + schemas/d2/) in a temp dir — never the real working tree — runs
 * the real verifier with --root/--runs-root pointing there, and asserts the
 * child exit code is 2 (HAS_FAIL) with the expected failed check.
 *
 * The selftest's own evidence lands in evidence/d2/selftest/<UTC-id>/
 * (guarded writes; child run dirs are preserved under child-runs/).
 *
 * Exit codes: 0 = all injections detected + control clean; 2 = any scenario
 * did not behave (the gate would let a real defect through); 1 = selftest
 * error.
 */

import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { EvidenceWriter } from "../tests/support/verifier/evidence.ts";
import { truncate, utcRunId } from "../tests/support/verifier/util.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, "..");
const VERIFIER = join(REPO_ROOT, "scripts", "verify-d2.js");

/** Scenario outcome for the selftest's own evidence. */
function scenarioRecord(id, expectedExit, actualExit, pass, detail) {
  return {
    id,
    status: pass ? "PASS" : "FAIL",
    exitCode: pass ? 0 : 2,
    reason: pass ? undefined : `expected exit ${expectedExit}, got ${actualExit}`,
    ...(detail !== undefined ? { detail } : {}),
  };
}

/**
 * Build a minimal synthetic tree the verifier can run scoped checks in.
 * Contains ONLY what the scoped checks need (no node_modules required:
 * the verifier's imports are Node built-ins plus tests/support, all copied).
 */
function buildSyntheticTree(baseDir) {
  const root = join(baseDir, "tree");
  mkdirSync(join(root, "scripts"), { recursive: true });
  cpSync(join(REPO_ROOT, "scripts", "verify-d2.js"), join(root, "scripts", "verify-d2.js"));
  cpSync(join(REPO_ROOT, "tests"), join(root, "tests"), { recursive: true });
  cpSync(join(REPO_ROOT, "schemas", "d2"), join(root, "schemas", "d2"), { recursive: true });
  return root;
}

/** Run the real verifier against a synthetic tree and report the outcome. */
function runVerifier(root, childRunsRoot, onlyIds) {
  const argv = [
    "--root",
    root,
    "--runs-root",
    childRunsRoot,
    ...onlyIds.flatMap((id) => ["--only", id]),
  ];
  const res = spawnSync(process.execPath, [VERIFIER, ...argv], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  let result = null;
  try {
    // The child always writes result.json into its (fresh) run dir.
    const runs = readdirSync(childRunsRoot).sort();
    const lastRun = runs[runs.length - 1];
    if (lastRun !== undefined) {
      result = JSON.parse(readFileSync(join(childRunsRoot, lastRun, "result.json"), "utf8"));
    }
  } catch {
    result = null;
  }
  return {
    exitCode: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    result,
  };
}

/* ------------------------------------------------------------------ */

async function main() {
  const evidenceRoot = join(REPO_ROOT, "evidence", "d2", "selftest");
  const writer = new EvidenceWriter(evidenceRoot, utcRunId("d2-selftest"));
  const startedAt = new Date().toISOString();
  console.log(`verify-d2-selftest — failure-path selftest`);
  console.log(`evidence: ${writer.runDir}\n`);
  writer.journal({
    type: "verify.run-started",
    payload: { mode: "offline", verifier: "verify-d2-selftest" },
  });

  const scenarios = [];
  let workDir = null;

  // Child verifier run dirs are preserved INSIDE the selftest evidence
  // (they are the proof of each injected failure).
  const childRunsFor = (name) => join(writer.runDir, "child-runs", name);

  try {
    workDir = mkdtempSync(join(tmpdir(), "treeai-d2-sectest."));

    /* ---- control: clean tree passes ------------------------------- */
    {
      const root = buildSyntheticTree(join(workDir, "control"));
      const childRuns = childRunsFor("control-clean");
      const run = runVerifier(root, childRuns, ["fixtures-integrity", "secret-scan-workspace"]);
      const pass =
        run.exitCode === 0 &&
        run.result !== null &&
        run.result.verdict === "ALL_PASS";
      scenarios.push(
        scenarioRecord(
          "control-clean-tree",
          0,
          run.exitCode,
          pass,
          "clean synthetic tree: fixtures-integrity + secret-scan-workspace must both PASS",
        ),
      );
      console.log(
        `  [${pass ? "PASS" : "FAIL"}] control-clean-tree (child exit ${run.exitCode})`,
      );
    }

    /* ---- A. secret injection --------------------------------------- */
    {
      const root = buildSyntheticTree(join(workDir, "secret"));
      // A credential-shaped string in the scanned workspace. Built by
      // concatenation so THIS file never contains the raw pattern either.
      const token = ["sk-test-", "abcdef0123456789", "abcdef0123456789"].join("");
      writeFileSync(
        join(root, "tests", "fixtures", "e2e", "injected-credentials.txt"),
        `# local experiment, do not commit\napi_key = "${token}"\n`,
        "utf8",
      );
      const childRuns = childRunsFor("secret");
      const run = runVerifier(root, childRuns, ["secret-scan-workspace"]);
      const failedCheck = run.result?.results?.find?.((r) => r.id === "secret-scan-workspace");
      const pass =
        run.exitCode === 2 &&
        failedCheck !== undefined &&
        failedCheck.status === "FAIL" &&
        run.result.verdict === "HAS_FAIL";
      scenarios.push(
        scenarioRecord(
          "inject-secret",
          2,
          run.exitCode,
          pass,
          pass
            ? "secret-shaped file in tests/ → secret-scan-workspace FAIL, gate exit 2"
            : `secret injection NOT detected (child exit ${run.exitCode}, verdict ${run.result?.verdict})`,
        ),
      );
      console.log(`  [${pass ? "PASS" : "FAIL"}] inject-secret (child exit ${run.exitCode})`);
    }

    /* ---- B. weakened event schema ---------------------------------- */
    {
      const root = buildSyntheticTree(join(workDir, "bad-schema"));
      // Replace the event schema with an accept-anything document: every
      // "invalid" event probe now validates → constraint-loss detection
      // must fail the gate.
      writeFileSync(
        join(root, "schemas", "d2", "event.schema.json"),
        `${JSON.stringify({ type: "object" }, null, 2)}\n`,
        "utf8",
      );
      const childRuns = childRunsFor("bad-schema");
      const run = runVerifier(root, childRuns, ["fixtures-integrity"]);
      const failedCheck = run.result?.results?.find?.((r) => r.id === "fixtures-integrity");
      const pass =
        run.exitCode === 2 &&
        failedCheck !== undefined &&
        failedCheck.status === "FAIL" &&
        typeof failedCheck.error?.message === "string" &&
        failedCheck.error.message.includes("constraint was lost");
      scenarios.push(
        scenarioRecord(
          "inject-bad-schema",
          2,
          run.exitCode,
          pass,
          pass
            ? "accept-anything event schema → invalid probes validate → fixtures-integrity FAIL"
            : `weakened schema NOT detected (child exit ${run.exitCode}: ${truncate(
                failedCheck?.error?.message ?? run.stderr,
                300,
              )})`,
        ),
      );
      console.log(`  [${pass ? "PASS" : "FAIL"}] inject-bad-schema (child exit ${run.exitCode})`);
    }

    /* ---- C. stripped exit-code discipline --------------------------- */
    {
      const root = buildSyntheticTree(join(workDir, "bad-exit-codes"));
      // Surgically remove BOTH anyOf blocks that enforce the exit-code
      // discipline (root verdict↔exitCode and resultItem status↔exitCode):
      // a PASS item with exitCode 1 becomes schema-valid.
      const schemaPath = join(root, "schemas", "d2", "result.schema.json");
      const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
      delete schema.anyOf;
      delete schema.$defs.resultItem.anyOf;
      writeFileSync(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, "utf8");
      const childRuns = childRunsFor("bad-exit-codes");
      const run = runVerifier(root, childRuns, ["fixtures-integrity"]);
      const failedCheck = run.result?.results?.find?.((r) => r.id === "fixtures-integrity");
      const pass =
        run.exitCode === 2 &&
        failedCheck !== undefined &&
        failedCheck.status === "FAIL" &&
        typeof failedCheck.error?.message === "string" &&
        failedCheck.error.message.includes("pass-item-with-exit-1");
      scenarios.push(
        scenarioRecord(
          "inject-illegal-exit-codes",
          2,
          run.exitCode,
          pass,
          pass
            ? "exit-code constraints stripped → PASS-with-exit-1 probe validates → fixtures-integrity FAIL"
            : `illegal exit codes NOT detected (child exit ${run.exitCode}: ${truncate(
                failedCheck?.error?.message ?? run.stderr,
                300,
              )})`,
        ),
      );
      console.log(
        `  [${pass ? "PASS" : "FAIL"}] inject-illegal-exit-codes (child exit ${run.exitCode})`,
      );
    }
  } finally {
    if (workDir !== null) {
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {
        // best effort; a leftover temp dir is caught by residual-resources
      }
    }
  }

  /* ---- assemble the selftest result -------------------------------- */
  const failCount = scenarios.filter((s) => s.status === "FAIL").length;
  const verdict = failCount > 0 ? "HAS_FAIL" : "ALL_PASS";
  const exitCode = failCount > 0 ? 2 : 0;
  const result = {
    runId: writer.runId,
    schemaVersion: "d2-result-1",
    mode: "offline",
    startedAt,
    endedAt: new Date().toISOString(),
    verdict,
    counts: {
      pass: scenarios.length - failCount,
      fail: failCount,
      blocked: 0,
      notRun: 0,
    },
    exitCode,
    results: scenarios,
    notes: [
      "failure-path selftest: defects were injected into synthetic trees (temp dirs), the real scripts/verify-d2.js was executed against them, and each injection was required to fail the gate (child exit 2)",
      "the real working tree was never modified",
    ],
  };
  writer.writeJsonGuarded("result.json", result);
  writer.journal({
    type: "verify.run-finished",
    payload: { verdict, exitCode, scenarios: scenarios.length },
  });

  console.log("");
  console.log(
    `verify-d2-selftest summary: ${scenarios.length - failCount} PASS, ${failCount} FAIL → ${verdict} (exit ${exitCode})`,
  );
  console.log(`evidence: ${writer.runDir}`);
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(`[verify-d2-selftest] ERROR: ${String(err)}`);
  process.exit(1);
});
