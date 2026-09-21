#!/usr/bin/env node
/**
 * verify-d2 — TreeAI D2 offline acceptance verifier (Agent F).
 *
 * Exit codes (frozen, mirrors the D1 2026-09-20 hardening):
 *   0 — every requested check PASS
 *   1 — the verifier itself failed (unexpected internal error)
 *   2 — at least one FAIL
 *   3 — no FAIL, but BLOCKED or NOT_RUN present
 *
 * Honesty rules baked into the structure (task book §5 Agent F item 2):
 *   - a command that is not wired / a module not yet delivered is NOT_RUN
 *     with a reason — never a PASS and never silently dropped;
 *   - a delivered module whose tests fail is a FAIL;
 *   - exit 0 is reserved for "everything asked actually passed".
 *
 * Evidence discipline (item 5): every run appends a fresh
 * evidence/d2/runs/<UTC-run-id>/{environment.json,result.json,events.jsonl,
 * checks.json,logs/} directory; historical runs are never overwritten;
 * every write is redacted + secret-scanned BEFORE it touches the disk and
 * the whole run dir is rescanned afterwards (a post-write finding
 * overrides the verdict to FAIL/exit 2).
 *
 * Flags:
 *   --root=<dir>      operate on another tree (failure-path selftest)
 *   --only=<id>       run only the named check(s); repeatable
 *   --d1-repro        additionally run ./d1-spikes/scripts/verify-d1 --repro
 *                     (explicit opt-in: normal offline PRs never force live
 *                     model calls; execution also needs network + d1-spikes
 *                     write authorization — see agent-f-handoff.md)
 *   --runs-root=<dir> override where the run directory is created
 *
 * Root package.json wiring (verify:d2) is the Integrator's job; this file
 * is directly executable with node.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { EvidenceWriter } from "../tests/support/verifier/evidence.ts";
import { verifyFixturesIntegrity } from "../tests/support/verifier/probes.ts";
import { runScannerSelfTest, scanFiles } from "../tests/support/verifier/secret-scanner.ts";
import { runValidatorSelfTest } from "../tests/support/verifier/schema-validator.ts";
import {
  checkExitCodeConsistency,
  computeVerdict,
} from "../tests/support/verifier/verdict.ts";
import { readJson, runCommand, tailLines, truncate, utcRunId } from "../tests/support/verifier/util.ts";
import { validateJsonSchema } from "../tests/support/verifier/schema-validator.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

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
const ONLY = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith("--only=")) {
    ONLY.push(a.slice("--only=".length));
  } else if (a === "--only" && i + 1 < args.length && !args[i + 1].startsWith("--")) {
    ONLY.push(args[i + 1]);
    i += 1;
  }
}
const D1_REPRO = args.includes("--d1-repro");
const RUNS_ROOT = argValue("runs-root") ?? join(ROOT, "evidence", "d2", "runs");

const VERIFIER_NAME = "verify-d2";
const VERIFIER_VERSION = "1.0.0";

/* ------------------------------------------------------------------ */
/* Check machinery                                                     */
/* ------------------------------------------------------------------ */

/** @typedef {{id: string, status: "PASS"|"FAIL"|"BLOCKED"|"NOT_RUN", exitCode: number|null,
 *             reason?: string, error?: {message: string, code?: string},
 *             detail?: string, durationMs?: number, evidenceFiles?: string[],
 *             meta?: Record<string, unknown>}} ResultItem */

const items = [];
const writer = new EvidenceWriter(RUNS_ROOT, utcRunId("d2-offline"));
const startedAt = new Date().toISOString();

function log(checkId, text) {
  if (text === undefined || text.length === 0) return;
  try {
    writer.writeTextGuarded(`logs/${checkId}.txt`, truncate(text, 60_000));
  } catch {
    // Logging failures must not crash the verifier; the post-write scan and
    // journal verification still hold the line.
  }
}

function journalCheck(item) {
  writer.journal({
    type: "verify.check-finished",
    payload: {
      check: item.id,
      status: item.status,
      ...(item.durationMs !== undefined ? { durationMs: item.durationMs } : {}),
    },
    evidence:
      item.evidenceFiles !== undefined && item.evidenceFiles.length > 0
        ? item.evidenceFiles.map((f) => ({ source: "treeai-journal", refId: f }))
        : [],
  });
}

function pushItem(item) {
  items.push(item);
  journalCheck(item);
  const mark =
    item.status === "PASS" ? "PASS" : item.status === "FAIL" ? "FAIL" : item.status;
  console.log(`  [${mark}] ${item.id}${item.reason !== undefined ? ` — ${item.reason}` : ""}`);
}

async function runCheck(id, fn) {
  const t0 = Date.now();
  try {
    const item = await fn();
    pushItem({ durationMs: Date.now() - t0, ...item, id });
  } catch (err) {
    pushItem({
      id,
      status: "FAIL",
      exitCode: 1,
      error: { message: `check crashed: ${String(err)}` },
      durationMs: Date.now() - t0,
    });
  }
}

/** Run a subprocess-based check with honest exit-code mapping. */
function commandCheck(id, command, argv, options = {}) {
  return async () => {
    const res = runCommand(command, argv, {
      cwd: ROOT,
      timeoutMs: options.timeoutMs ?? 300_000,
    });
    log(id, `$ ${command} ${argv.join(" ")}\n${res.stdout}\n${res.stderr}`);
    if (res.error !== undefined) {
      return {
        status: "BLOCKED",
        exitCode: null,
        reason: `could not execute ${command}: ${res.error}`,
      };
    }
    if (res.status === 0) {
      return {
        status: "PASS",
        exitCode: 0,
        detail: tailLines(res.stdout + res.stderr, 1),
      };
    }
    if (res.status !== null && options.notRunOn !== undefined && options.notRunOn.includes(res.status)) {
      return {
        status: "NOT_RUN",
        exitCode: res.status,
        reason: options.notRunReason ?? `command exited ${res.status} (nothing to check yet)`,
      };
    }
    return {
      status: "FAIL",
      exitCode: res.status ?? 1,
      error: {
        message: truncate(`${command} exited ${String(res.status)} (${res.signal ?? "no signal"})`, 2000),
      },
      detail: truncate(tailLines(res.stderr || res.stdout, 12), 4000),
    };
  };
}

/** npm test -w <pkg> with NOT_RUN semantics for missing/unwired packages. */
function moduleTestCheck(id, pkgDir, pkgName) {
  return async () => {
    if (!existsSync(join(ROOT, pkgDir))) {
      return {
        status: "NOT_RUN",
        exitCode: null,
        reason: `package directory ${pkgDir} does not exist yet`,
      };
    }
    if (!existsSync(join(ROOT, pkgDir, "src"))) {
      return {
        status: "NOT_RUN",
        exitCode: null,
        reason: `${pkgName} has no src/ yet (module owner has not delivered)`,
      };
    }
    const pkg = readJson(join(ROOT, pkgDir, "package.json"));
    const scripts = (pkg && pkg.scripts) || {};
    if (typeof scripts.test !== "string") {
      return {
        status: "NOT_RUN",
        exitCode: null,
        reason: `${pkgName} has no test script wired yet`,
      };
    }
    const res = runCommand("npm", ["test", "-w", pkgName], {
      cwd: ROOT,
      timeoutMs: 600_000,
    });
    log(id, `$ npm test -w ${pkgName}\n${res.stdout}\n${res.stderr}`);
    if (res.error !== undefined) {
      return {
        status: "BLOCKED",
        exitCode: null,
        reason: `npm not executable: ${res.error}`,
      };
    }
    if (res.status === 0) {
      return {
        status: "PASS",
        exitCode: 0,
        detail: truncate(tailLines(res.stdout, 2), 4000),
      };
    }
    return {
      status: "FAIL",
      exitCode: res.status,
      error: {
        message: truncate(`npm test -w ${pkgName} exited ${String(res.status)}`, 2000),
      },
      detail: truncate(tailLines(res.stderr || res.stdout, 12), 4000),
    };
  };
}

/* ------------------------------------------------------------------ */
/* Environment record                                                  */
/* ------------------------------------------------------------------ */

function collectEnvironment() {
  const npmVersion = runCommand("npm", ["--version"], { cwd: ROOT });
  const gitHead = runCommand("git", ["rev-parse", "HEAD"], { cwd: ROOT });
  const gitDirty = runCommand("git", ["status", "--porcelain"], { cwd: ROOT });
  const tsPkg = readJson(join(ROOT, "node_modules", "typescript", "package.json"));
  const runtimePiPkg = readJson(join(ROOT, "packages", "runtime-pi", "package.json"));
  const piDep =
    runtimePiPkg && runtimePiPkg.dependencies
      ? runtimePiPkg.dependencies["@earendil-works/pi-coding-agent"]
      : undefined;
  const installedPiPkg = readJson(
    join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
  );
  return {
    schemaVersion: "d2-environment-1",
    generatedAt: new Date().toISOString(),
    mode: "offline",
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
      ...(typeof piDep === "string" ? { declaredDependency: piDep } : {}),
    },
    credentialPolicy: {
      policy: "offline",
      note: "verify:d2 runs with no credentials by design; live checks are not requested and d1-repro requires an explicit flag",
    },
    ...(gitHead.status === 0
      ? {
          git: {
            commit: gitHead.stdout.trim(),
            dirty: gitDirty.status === 0 && gitDirty.stdout.trim().length > 0,
          },
        }
      : {}),
    verifier: { name: VERIFIER_NAME, version: VERIFIER_VERSION },
  };
}

/* ------------------------------------------------------------------ */
/* The checks                                                          */
/* ------------------------------------------------------------------ */

const CHECKS = [
  {
    id: "fixtures-integrity",
    fn: async () => {
      const result = verifyFixturesIntegrity(
        join(ROOT, "tests", "fixtures"),
        join(ROOT, "schemas", "d2"),
      );
      if (result.problems.length > 0) {
        return {
          status: "FAIL",
          exitCode: 1,
          error: { message: result.problems.join("; ") },
        };
      }
      return {
        status: "PASS",
        exitCode: 0,
        detail: `${result.hashedFiles} files hashed; ${result.validProbes} valid / ${result.invalidProbes} invalid probes confirmed`,
      };
    },
  },
  {
    id: "schema-validator-selftest",
    fn: async () => {
      const failures = runValidatorSelfTest();
      if (failures.length > 0) {
        return { status: "FAIL", exitCode: 1, error: { message: failures.join("; ") } };
      }
      return { status: "PASS", exitCode: 0, detail: "keyword corpus clean" };
    },
  },
  {
    id: "secret-scanner-selftest",
    fn: async () => {
      const result = runScannerSelfTest();
      if (!result.pass) {
        return {
          status: "FAIL",
          exitCode: 1,
          error: { message: result.problems.join("; ") },
        };
      }
      return {
        status: "PASS",
        exitCode: 0,
        detail: `${result.rulesFired} rules fired on the synthetic corpus, clean corpus clean`,
      };
    },
  },
  {
    id: "typecheck",
    fn: commandCheck("typecheck", process.execPath, ["scripts/typecheck.js"], {
      notRunOn: [3],
      notRunReason: "no workspace has TypeScript sources yet (Gate 0 scaffold semantics)",
    }),
  },
  {
    id: "tests-typecheck",
    fn: commandCheck(
      "tests-typecheck",
      process.execPath,
      [join("node_modules", "typescript", "bin", "tsc"), "-p", "tests/tsconfig.json"],
    ),
  },
  {
    id: "unit-tests-contracts",
    fn: moduleTestCheck("unit-tests-contracts", join("packages", "contracts"), "@treeai/contracts"),
  },
  {
    id: "unit-tests-runtime-pi",
    fn: moduleTestCheck("unit-tests-runtime-pi", join("packages", "runtime-pi"), "@treeai/runtime-pi"),
  },
  {
    id: "unit-tests-persistence",
    fn: moduleTestCheck("unit-tests-persistence", join("packages", "persistence"), "@treeai/persistence"),
  },
  {
    id: "unit-tests-tool-policy",
    fn: moduleTestCheck("unit-tests-tool-policy", join("packages", "tool-policy"), "@treeai/tool-policy"),
  },
  {
    id: "unit-tests-event-journal",
    fn: moduleTestCheck("unit-tests-event-journal", join("packages", "event-journal"), "@treeai/event-journal"),
  },
  {
    id: "unit-tests-agent-f",
    fn: commandCheck("unit-tests-agent-f", process.execPath, ["--test", "tests/unit/*.test.ts"]),
  },
  {
    id: "integration-tests-agent-f",
    fn: commandCheck("integration-tests-agent-f", process.execPath, [
      "--test",
      "tests/integration/*.test.ts",
    ]),
  },
  {
    id: "live-framework-selftest",
    fn: commandCheck("live-framework-selftest", process.execPath, ["--test", "tests/live/*.test.ts"]),
  },
  {
    id: "runtime-smoke",
    fn: async () => {
      const dir = join(ROOT, "apps", "runtime-smoke");
      if (!existsSync(dir)) {
        return {
          status: "NOT_RUN",
          exitCode: null,
          reason: "apps/runtime-smoke does not exist yet",
        };
      }
      const pkg = readJson(join(dir, "package.json"));
      const scripts = (pkg && pkg.scripts) || {};
      if (typeof scripts.test !== "string") {
        return {
          status: "NOT_RUN",
          exitCode: null,
          reason: "runtime-smoke is Integrator-owned Wave 2 skeleton; no test script wired yet",
        };
      }
      const res = runCommand("npm", ["test", "-w", "@treeai/runtime-smoke"], {
        cwd: ROOT,
        timeoutMs: 600_000,
      });
      log("runtime-smoke", res.stdout + res.stderr);
      if (res.status === 0) return { status: "PASS", exitCode: 0 };
      return {
        status: "FAIL",
        exitCode: res.status ?? 1,
        error: { message: `runtime-smoke tests exited ${String(res.status)}` },
      };
    },
  },
  {
    id: "pi-version-pin",
    fn: async () => {
      const runtimePiPkg = readJson(join(ROOT, "packages", "runtime-pi", "package.json"));
      const dep =
        runtimePiPkg && runtimePiPkg.dependencies
          ? runtimePiPkg.dependencies["@earendil-works/pi-coding-agent"]
          : undefined;
      if (dep !== "0.85.1") {
        return {
          status: "FAIL",
          exitCode: 1,
          error: {
            message: `packages/runtime-pi must depend on @earendil-works/pi-coding-agent exactly "0.85.1" (D1 DECISION-003); found ${JSON.stringify(dep)}`,
          },
        };
      }
      const installed = readJson(
        join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
      );
      const installedVersion =
        installed && typeof installed.version === "string" ? installed.version : null;
      if (installedVersion !== "0.85.1") {
        return {
          status: "FAIL",
          exitCode: 1,
          error: {
            message: `installed Pi version is ${JSON.stringify(installedVersion)}, pinned is "0.85.1" (run npm ci)`,
          },
        };
      }
      return {
        status: "PASS",
        exitCode: 0,
        detail: `declared "${dep}" / installed "${installedVersion}"`,
      };
    },
  },
  {
    id: "secret-scan-workspace",
    fn: async () => {
      const roots = [
        join(ROOT, "tests"),
        join(ROOT, "schemas", "d2"),
        join(ROOT, ".github", "workflows"),
        join(ROOT, "evidence", "d2"),
      ].filter((p) => existsSync(p));
      // Only Agent F's scripts (the other scripts/ files are the
      // Integrator's; they are not part of this gate's write zone).
      const scriptsDir = join(ROOT, "scripts");
      if (existsSync(scriptsDir)) {
        for (const name of readdirSync(scriptsDir)) {
          if (/^verify-d2/.test(name)) roots.push(join(scriptsDir, name));
        }
      }
      const report = scanFiles(roots, ROOT);
      log(
        "secret-scan-workspace",
        `scanned ${report.stats.filesScanned} files across ${roots.length} roots\n` +
          JSON.stringify(report.findings, null, 2),
      );
      if (report.findingCount > 0) {
        return {
          status: "FAIL",
          exitCode: 1,
          error: {
            message: `${report.findingCount} secret-scan findings (rules: ${[
              ...new Set(report.findings.map((f) => f.ruleId)),
            ].join(", ")})`,
          },
        };
      }
      return {
        status: "PASS",
        exitCode: 0,
        detail: `${report.stats.filesScanned} files scanned, 0 findings (scanner ${report.scannerVersion})`,
      };
    },
  },
  {
    id: "residual-resources",
    fn: async () => {
      const patterns = [
        /^treeai-fake-rt\./,
        /^treeai-scanner-/,
        /^treeai-live-selftest\./,
        /^treeai-d2-e2e-/,
        /^treeai-probe-/,
        /^treeai-d2-sectest\./,
      ];
      const leftovers = [];
      try {
        for (const name of readdirSync(tmpdir())) {
          if (patterns.some((p) => p.test(name))) leftovers.push(name);
        }
      } catch (err) {
        return {
          status: "BLOCKED",
          exitCode: null,
          reason: `temp dir unreadable: ${String(err)}`,
        };
      }
      if (leftovers.length > 0) {
        return {
          status: "FAIL",
          exitCode: 1,
          error: { message: `leaked temp resources: ${leftovers.join(", ")}` },
        };
      }
      return { status: "PASS", exitCode: 0, detail: "no treeai-* temp leftovers" };
    },
  },
  {
    id: "d1-repro",
    fn: async () => {
      if (!D1_REPRO) {
        return {
          status: "NOT_RUN",
          exitCode: null,
          reason:
            "explicit --d1-repro flag required (offline PRs never force live model calls); execution also needs network + d1-spikes write authorization",
        };
      }
      const script = join(ROOT, "d1-spikes", "scripts", "verify-d1");
      if (!existsSync(script)) {
        return {
          status: "NOT_RUN",
          exitCode: null,
          reason: "d1-spikes/scripts/verify-d1 not present in this tree",
        };
      }
      const res = runCommand(script, ["--repro"], { cwd: ROOT, timeoutMs: 600_000 });
      log("d1-repro", res.stdout + res.stderr);
      if (res.status === 0) {
        return { status: "PASS", exitCode: 0, detail: tailLines(res.stdout, 2) };
      }
      return {
        status: "FAIL",
        exitCode: res.status ?? 1,
        error: { message: `verify-d1 --repro exited ${String(res.status)}` },
      };
    },
  },
];

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  console.log(`verify-d2 ${VERIFIER_VERSION} — offline acceptance run`);
  console.log(`root: ${ROOT}`);
  console.log(`evidence: ${writer.runDir}`);
  if (ONLY.length > 0) console.log(`scoped to: ${ONLY.join(", ")}`);
  console.log("");

  writer.journal({
    type: "verify.run-started",
    payload: { mode: "offline", verifier: VERIFIER_NAME, version: VERIFIER_VERSION },
  });

  // Environment first (guarded write, before any check output exists).
  const environment = collectEnvironment();
  writer.writeJsonGuarded("environment.json", environment);

  const selected = CHECKS.filter((c) => ONLY.length === 0 || ONLY.includes(c.id));
  for (const check of selected) {
    if (ONLY.length > 0 && !ONLY.includes(check.id)) continue;
    await runCheck(check.id, check.fn);
  }

  // ---- exit-code consistency (independent of the schema) --------------
  const exitProblems = checkExitCodeConsistency(items);
  pushItem({
    id: "exit-codes",
    status: exitProblems.length === 0 ? "PASS" : "FAIL",
    exitCode: exitProblems.length === 0 ? 0 : 1,
    ...(exitProblems.length === 0
      ? { detail: "all items follow the frozen status/exitCode discipline" }
      : { error: { message: exitProblems.join("; ") } }),
  });

  // ---- evidence write hygiene ----------------------------------------
  const preWriteLeaks = [...writer.preWriteLeaks];
  pushItem({
    id: "evidence-write-hygiene",
    status: preWriteLeaks.length === 0 ? "PASS" : "FAIL",
    exitCode: preWriteLeaks.length === 0 ? 0 : 2,
    ...(preWriteLeaks.length === 0
      ? { detail: "no secret-shaped content attempted to enter the evidence" }
      : {
          error: {
            message: `${preWriteLeaks.length} pre-write leaks were masked and recorded (rule ids: ${[
              ...new Set(preWriteLeaks.map((f) => f.ruleId)),
            ].join(", ")})`,
          },
        }),
  });

  // ---- schema validation of this run's own artifacts ------------------
  const draftResult = buildResult("ALL_PASS", 0); // placeholder shape
  const envRes = validateJsonSchema(
    readJson(join(writer.runDir, "environment.json")),
    readJson(join(ROOT, "schemas", "d2", "environment.schema.json")),
  );
  const draftRes = validateJsonSchema(
    draftResult,
    readJson(join(ROOT, "schemas", "d2", "result.schema.json")),
  );
  const eventSchema = readJson(join(ROOT, "schemas", "d2", "event.schema.json"));
  const eventProblems = [];
  try {
    const journalText = readFileSync(join(writer.runDir, "events.jsonl"), "utf8");
    let n = 0;
    for (const line of journalText.split("\n")) {
      if (line.trim().length === 0) continue;
      n += 1;
      const res = validateJsonSchema(JSON.parse(line), eventSchema);
      if (!res.valid) {
        eventProblems.push(`events.jsonl line ${n}: ${res.errors.map((e) => e.message).join("; ")}`);
      }
    }
  } catch (err) {
    eventProblems.push(`events.jsonl unreadable: ${String(err)}`);
  }
  const schemaProblems = [
    ...envRes.errors.map((e) => `environment.json: ${e.message}`),
    ...draftRes.errors.map((e) => `result.json draft: ${e.message}`),
    ...eventProblems,
  ];
  pushItem({
    id: "schema-validation",
    status: schemaProblems.length === 0 ? "PASS" : "FAIL",
    exitCode: schemaProblems.length === 0 ? 0 : 1,
    ...(schemaProblems.length === 0
      ? { detail: "environment.json and the result draft validate against schemas/d2" }
      : { error: { message: schemaProblems.join("; ") } }),
  });

  // ---- assemble + write the final artifacts ---------------------------
  const summary = computeVerdict(items);
  const result = buildResult(summary.verdict, summary.exitCode);
  writer.writeJsonGuarded("checks.json", { runId: writer.runId, checks: items });
  writer.writeJsonGuarded("result.json", result);

  // ---- post-write discipline ------------------------------------------
  // Pre-write leaks are masked BEFORE storage, so any finding in the
  // post-write rescan is a NEW leak introduced by the write path itself
  // and must override the verdict.
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

  // Re-validate the FINAL result.json (with all items) against the schema.
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
    // Rewrite the result with the override noted.
    const overridden = buildResult(verdict, exitCode);
    overridden.notes = [
      ...(overridden.notes ?? []),
      `verdict overridden by post-write discipline: ${overrides.join("; ")}`,
    ];
    writer.writeJsonGuarded("result.json", overridden);
  }

  writer.journal({
    type: "verify.run-finished",
    payload: {
      verdict,
      exitCode,
      counts: { pass: summary.counts.pass, fail: summary.counts.fail, blocked: summary.counts.blocked, notRun: summary.counts.notRun },
      overrides,
    },
  });

  // ---- human summary ---------------------------------------------------
  console.log("");
  console.log("verify-d2 summary:");
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

function buildResult(verdict, exitCode) {
  const summary = computeVerdict(items);
  const notes = [];
  if (ONLY.length > 0) notes.push(`scoped run (--only): only ${ONLY.join(", ")} executed`);
  if (!D1_REPRO) notes.push("d1-repro skipped: requires explicit --d1-repro (offline PRs never force live model calls)");
  return {
    runId: writer.runId,
    schemaVersion: "d2-result-1",
    mode: "offline",
    startedAt,
    endedAt: new Date().toISOString(),
    verdict,
    counts: summary.counts,
    exitCode,
    results: items,
    notes,
  };
}

main().catch((err) => {
  // Verifier self-error: exit 1, with a best-effort evidence record.
  console.error(`[verify-d2] VERIFIER_ERROR: ${String(err)}`);
  try {
    writer.journal({
      type: "verify.run-finished",
      payload: { verdict: "VERIFIER_ERROR", exitCode: 1, error: String(err) },
    });
    writer.writeJsonGuarded("result.json", {
      runId: writer.runId,
      schemaVersion: "d2-result-1",
      mode: "offline",
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
          reason: `verifier crashed before completing: ${String(err)}`,
        },
      ],
      notes: ["verifier self-error; checks after the crash point were not executed"],
    });
  } catch {
    // nothing more we can do; the process exit code still tells the truth
  }
  process.exit(1);
});
