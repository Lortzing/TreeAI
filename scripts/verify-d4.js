#!/usr/bin/env node
/**
 * verify-d4 — TreeAI D4 offline acceptance verifier (D4-0 wave, issue #8 §8).
 *
 * Exit codes (frozen, mirrors the D2 discipline):
 *   0 — every requested check PASS
 *   1 — the verifier itself failed (unexpected internal error)
 *   2 — at least one FAIL
 *   3 — no FAIL, but BLOCKED or NOT_RUN present
 *
 * Honesty rules baked into the structure:
 *   - a work package that is not implemented yet is NOT_RUN with a reason
 *     naming the package — never a PASS and never silently dropped;
 *   - the B1–B9 acceptance rows stay in the matrix from day one, owned by
 *     their work packages (D4-1…D4-8), and flip from NOT_RUN to real
 *     execution only when the implementation lands;
 *   - offline green ≠ final gate: B3/B7/B8 real-Pi, browser and manual
 *     evidence live in run:d4-browser and the D4-G3 human sequence.
 *
 * Evidence discipline (same as verify-d2): every run appends a fresh
 * evidence/d4/runs/d4-offline-<UTC-run-id>/{environment.json,result.json,
 * events.jsonl,checks.json,logs/} directory; run dirs are never
 * overwritten; every write is redacted + secret-scanned before it touches
 * the disk and the whole dir is rescanned afterwards (a post-write finding
 * overrides the verdict to FAIL/exit 2).
 *
 * Flags:
 *   --root=<dir>      operate on another tree (failure-path selftest)
 *   --only=<id>       run only the named check(s); repeatable
 *   --runs-root=<dir> override where the run directory is created
 *
 * Root package.json wiring (verify:d4) is the Integrator's job; this file
 * is directly executable with node.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { EvidenceWriter } from "../tests/support/verifier/evidence.ts";
import { verifyD4FixturesIntegrity } from "../tests/support/verifier/d4-probes.ts";
import { runB1ImportCheck } from "../tests/support/verifier/d4-b1-import.ts";
import { checkExitCodeConsistency, computeVerdict } from "../tests/support/verifier/verdict.ts";
import { readJson, runCommand, tailLines, truncate, utcRunId } from "../tests/support/verifier/util.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

const args = process.argv.slice(2);

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
const RUNS_ROOT = argValue("runs-root") ?? join(ROOT, "evidence", "d4", "runs");

const VERIFIER_NAME = "verify-d4";
const VERIFIER_VERSION = "0.1.0";

/* ------------------------------------------------------------------ */
/* Check machinery (mirrors verify-d2.js)                              */
/* ------------------------------------------------------------------ */

const items = [];
const writer = new EvidenceWriter(RUNS_ROOT, utcRunId("d4-offline"));
const startedAt = new Date().toISOString();

function log(checkId, text) {
  if (text === undefined || text.length === 0) return;
  try {
    writer.writeTextGuarded(`logs/${checkId}.txt`, truncate(text, 60_000));
  } catch {
    // Logging failures must not crash the verifier.
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
  console.log(`  [${item.status}] ${item.id}${item.reason !== undefined ? ` — ${item.reason}` : ""}`);
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

function commandCheck(id, command, argv, options = {}) {
  return async () => {
    const res = runCommand(command, argv, { cwd: ROOT, timeoutMs: options.timeoutMs ?? 300_000 });
    log(id, `$ ${command} ${argv.join(" ")}\n${res.stdout}\n${res.stderr}`);
    if (res.error !== undefined) {
      return { status: "BLOCKED", exitCode: null, reason: `could not execute ${command}: ${res.error}` };
    }
    if (res.status === 0) {
      return { status: "PASS", exitCode: 0, detail: tailLines(res.stdout + res.stderr, 1) };
    }
    return {
      status: "FAIL",
      exitCode: res.status ?? 1,
      error: { message: truncate(`${command} exited ${String(res.status)} (${res.signal ?? "no signal"})`, 2000) },
      detail: truncate(tailLines(res.stderr || res.stdout, 12), 4000),
    };
  };
}

/** NOT_RUN placeholder owned by an unimplemented work package. */
function notRunCheck(id, workPackage, reason) {
  return async () => ({
    status: "NOT_RUN",
    exitCode: null,
    reason: `${reason} (owner: ${workPackage})`,
  });
}

/* ------------------------------------------------------------------ */
/* Environment record                                                  */
/* ------------------------------------------------------------------ */

function collectEnvironment() {
  const npmVersion = runCommand("npm", ["--version"], { cwd: ROOT });
  const gitHead = runCommand("git", ["rev-parse", "HEAD"], { cwd: ROOT });
  const gitDirty = runCommand("git", ["status", "--porcelain"], { cwd: ROOT });
  const tsPkg = readJson(join(ROOT, "node_modules", "typescript", "package.json"));
  return {
    schemaVersion: "d4-environment-1",
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
    credentialPolicy: {
      policy: "offline",
      note: "verify:d4 runs with no credentials by design; real-Pi/browser evidence lives in run:d4-browser --mode real-pi",
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
    id: "fixtures-integrity-d4",
    fn: async () => {
      const d4Root = join(ROOT, "tests", "fixtures", "d4");
      if (!existsSync(d4Root)) {
        return { status: "NOT_RUN", exitCode: null, reason: "tests/fixtures/d4 not present in this tree" };
      }
      const result = verifyD4FixturesIntegrity(d4Root);
      if (result.problems.length > 0) {
        return { status: "FAIL", exitCode: 1, error: { message: result.problems.join("; ") } };
      }
      const s = result.stats;
      return {
        status: "PASS",
        exitCode: 0,
        detail:
          `${s.hashedFiles} files hashed; B1 ${s.mdFixtures} md + ${s.pdfFixtures} pdf + ` +
          `${s.negativeFixtures} negatives + ${s.versionPairs} version pair(s); ` +
          `B2 ${s.validSelections} valid / ${s.invalidSelections} invalid; ` +
          `B4 ${s.positiveQueries} positive / ${s.noResultQueries} no-result`,
      };
    },
  },
  {
    id: "docs-integrity-d4",
    fn: async () => {
      const problems = [];
      const mirrorPath = join(ROOT, "docs", "d4", "D4-project-v1.md");
      const mirror = existsSync(mirrorPath) ? readFileSync(mirrorPath, "utf8") : null;
      if (mirror === null) {
        problems.push("docs/d4/D4-project-v1.md (项目书镜像) missing");
      } else {
        for (const marker of [
          "TreeAI D4 项目书 v1.1",
          "负责人最新明确确认",
          "## 6. D4 验收矩阵",
          "## 9. 开工清单与停止条件",
          "D4-0",
          "D4-8",
        ]) {
          if (!mirror.includes(marker)) problems.push(`mirror missing marker: ${marker}`);
        }
        if (!mirror.startsWith("<!--")) {
          problems.push("mirror must start with the provenance comment block");
        }
      }
      const statusPath = join(ROOT, "docs", "d4", "D4-status.md");
      const status = existsSync(statusPath) ? readFileSync(statusPath, "utf8") : null;
      if (status === null) {
        problems.push("docs/d4/D4-status.md missing");
      } else {
        for (const marker of ["D4-0", "D4-1", "D4-2", "D4-3", "D4-4", "D4-5", "D4-6", "D4-7", "D4-8", "D4-G0", "D4-G3"]) {
          if (!status.includes(marker)) problems.push(`D4-status missing task id: ${marker}`);
        }
        for (const column of ["任务ID", "状态", "被测完整SHA", "证据类型", "复验条件"]) {
          if (!status.includes(column)) problems.push(`D4-status missing required column: ${column}`);
        }
      }
      const adrPath = join(ROOT, "docs", "adr", "ADR-003-d4-material-sources-versions-run-origins.md");
      const adr = existsSync(adrPath) ? readFileSync(adrPath, "utf8") : null;
      if (adr === null) {
        problems.push("ADR-003 missing");
      } else {
        for (const marker of [
          "**状态：Accepted",
          "决策一",
          "决策二",
          "决策三",
          "测试义务",
        ]) {
          if (!adr.includes(marker)) problems.push(`ADR-003 missing marker: ${marker}`);
        }
      }
      const contractsPath = join(ROOT, "docs", "d4", "D4-contracts.md");
      const contracts = existsSync(contractsPath) ? readFileSync(contractsPath, "utf8") : null;
      if (contracts === null) {
        problems.push("docs/d4/D4-contracts.md missing");
      } else {
        for (const marker of ["0008", "material_versions", "branches/from-material", "冻结验收集格式"]) {
          if (!contracts.includes(marker)) problems.push(`D4-contracts missing marker: ${marker}`);
        }
      }
      if (problems.length > 0) {
        return { status: "FAIL", exitCode: 1, error: { message: problems.join("; ") } };
      }
      return {
        status: "PASS",
        exitCode: 0,
        detail: "project mirror, status matrix, ADR-003 and contracts design all present and structurally complete",
      };
    },
  },
  {
    id: "entrypoints-d4",
    fn: async () => {
      const problems = [];
      const pkg = readJson(join(ROOT, "package.json"));
      const scripts = (pkg && pkg.scripts) || {};
      const required = ["verify:d4", "verify:d4:selftest", "run:d4-browser"];
      for (const name of required) {
        if (typeof scripts[name] !== "string") {
          problems.push(`package.json script not wired: ${name}`);
        }
      }
      for (const file of ["scripts/verify-d4.js", "scripts/verify-d4-selftest.js", "scripts/run-d4-browser.mjs"]) {
        if (!existsSync(join(ROOT, file))) problems.push(`entry script missing: ${file}`);
      }
      if (problems.length > 0) {
        return { status: "FAIL", exitCode: 1, error: { message: problems.join("; ") } };
      }
      const help = runCommand(process.execPath, [join("scripts", "run-d4-browser.mjs"), "--help"], {
        cwd: ROOT,
        timeoutMs: 60_000,
      });
      log("entrypoints-d4", `$ node scripts/run-d4-browser.mjs --help\n${help.stdout}\n${help.stderr}`);
      if (help.status !== 0) {
        return {
          status: "FAIL",
          exitCode: 1,
          error: { message: `run-d4-browser --help exited ${String(help.status)}` },
        };
      }
      return {
        status: "PASS",
        exitCode: 0,
        detail: "verify:d4 / verify:d4:selftest / run:d4-browser wired; runner help renders",
      };
    },
  },
  {
    id: "typecheck",
    fn: commandCheck("typecheck", "npm", ["run", "typecheck"], { timeoutMs: 600_000 }),
  },
  {
    id: "tests-typecheck",
    fn: commandCheck(
      "tests-typecheck",
      process.execPath,
      [join("node_modules", "typescript", "bin", "tsc"), "-p", "tests/tsconfig.json"],
      { timeoutMs: 600_000 },
    ),
  },
  {
    id: "unit-tests-d4",
    fn: commandCheck(
      "unit-tests-d4",
      process.execPath,
      ["--test", join("tests", "unit", "d4-fixtures-integrity.test.ts")],
      { timeoutMs: 600_000 },
    ),
  },

  // ---- acceptance-matrix rows: NOT_RUN until their work package lands ----
  {
    id: "b1-import-versions",
    // REAL executing check (D4-1): the import pipeline runs against whatever
    // b1-import registries exist at runtime (md/pdf enumerated generically);
    // ready fixtures must round-trip to their frozen truth byte-exactly,
    // negatives must be rejected with the frozen reason, same-bytes re-import
    // must reuse the version, version pairs execute when locatable, and the
    // manifest-registered oversize probes (>20MiB / >200 pages / >1M units)
    // are generated deterministically here and must be refused.
    fn: async () => {
      const d4Root = join(ROOT, "tests", "fixtures", "d4");
      if (!existsSync(d4Root)) {
        return {
          status: "NOT_RUN",
          exitCode: null,
          reason: "tests/fixtures/d4 not present in this tree",
        };
      }
      const outcome = await runB1ImportCheck(d4Root);
      log("b1-import-versions", `b1 import/versions check\n${outcome.lines.join("\n")}`);
      if (outcome.status === "FAIL") {
        return {
          status: "FAIL",
          exitCode: 2,
          error: { message: outcome.problems.join("; ") },
          detail: truncate(outcome.detail, 4000),
        };
      }
      if (outcome.status === "NOT_RUN") {
        return { status: "NOT_RUN", exitCode: null, reason: outcome.detail };
      }
      return { status: "PASS", exitCode: 0, detail: outcome.detail };
    },
  },
  {
    id: "b2-precise-anchors",
    fn: notRunCheck(
      "b2-precise-anchors",
      "D4-2",
      "markdown/pdf readers and range layer not implemented; B2 executes against tests/fixtures/d4/b2-anchors once D4-2 lands",
    ),
  },
  {
    id: "b3-real-exploration",
    fn: notRunCheck(
      "b3-real-exploration",
      "D4-3",
      "material exploration loop not implemented; real-Pi evidence is produced by run:d4-browser --mode real-pi, not offline",
    ),
  },
  {
    id: "b4-cross-material-find",
    fn: notRunCheck(
      "b4-cross-material-find",
      "D4-4",
      "local full-text search not implemented; B4 executes against tests/fixtures/d4/b4-search once D4-4 lands",
    ),
  },
  {
    id: "b5-restore-integrity",
    fn: notRunCheck("b5-restore-integrity", "D4-5", "export/restore not implemented"),
  },
  {
    id: "b6-scale-performance",
    fn: notRunCheck(
      "b6-scale-performance",
      "D4-6",
      "scale dataset generator + performance measurement not implemented (spec frozen at tests/fixtures/d4/b6-scale)",
    ),
  },
  {
    id: "b7-beta-usability",
    fn: notRunCheck(
      "b7-beta-usability",
      "D4-6",
      "beta closeout pending; automated part runs via run:d4-browser, manual part belongs to the D4-G3 human sequence",
    ),
  },
  {
    id: "b8-install-crossplatform",
    fn: notRunCheck(
      "b8-install-crossplatform",
      "D4-7",
      "installers/cross-platform not implemented; requires clean-environment installs on macOS/Windows/Ubuntu",
    ),
  },
  {
    id: "b9-large-tree-nav",
    fn: notRunCheck(
      "b9-large-tree-nav",
      "D4-8",
      "large-scale tree navigation not implemented (spec frozen at tests/fixtures/d4/b9-nav)",
    ),
  },
];

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  console.log(`verify-d4 ${VERIFIER_VERSION} — offline acceptance run`);
  console.log(`root: ${ROOT}`);
  console.log(`evidence: ${writer.runDir}`);
  if (ONLY.length > 0) console.log(`scoped to: ${ONLY.join(", ")}`);
  console.log("");

  writer.journal({
    type: "verify.run-started",
    payload: { mode: "offline", verifier: VERIFIER_NAME, version: VERIFIER_VERSION },
  });

  const environment = collectEnvironment();
  writer.writeJsonGuarded("environment.json", environment);

  const selected = CHECKS.filter((c) => ONLY.length === 0 || ONLY.includes(c.id));
  for (const check of selected) {
    await runCheck(check.id, check.fn);
  }

  // exit-code consistency (independent of any schema)
  const exitProblems = checkExitCodeConsistency(items);
  pushItem({
    id: "exit-codes",
    status: exitProblems.length === 0 ? "PASS" : "FAIL",
    exitCode: exitProblems.length === 0 ? 0 : 1,
    ...(exitProblems.length === 0
      ? { detail: "all items follow the frozen status/exitCode discipline" }
      : { error: { message: exitProblems.join("; ") } }),
  });

  // evidence write hygiene
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

  const summary = computeVerdict(items);
  const result = {
    runId: writer.runId,
    schemaVersion: "d4-result-1",
    mode: "offline",
    startedAt,
    endedAt: new Date().toISOString(),
    verdict: summary.verdict,
    counts: summary.counts,
    exitCode: summary.exitCode,
    results: items,
    notes: [
      ...(ONLY.length > 0 ? [`scoped run (--only): only ${ONLY.join(", ")} executed`] : []),
      "offline green is not final-gate green: B3/B7 real-Pi + manual evidence live in run:d4-browser and D4-G3",
      "D2/D3 regression gates stay separate entry points (verify:d2, record:d3) per the charter §8 command list",
    ],
  };
  writer.writeJsonGuarded("checks.json", { runId: writer.runId, checks: items });
  writer.writeJsonGuarded("result.json", result);

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

  let verdict = summary.verdict;
  let exitCode = summary.exitCode;
  if (overrides.length > 0 && verdict !== "HAS_FAIL") {
    verdict = "HAS_FAIL";
    exitCode = 2;
    const overridden = {
      ...result,
      verdict,
      exitCode,
      notes: [
        ...result.notes,
        `verdict overridden by post-write discipline: ${overrides.join("; ")}`,
      ],
    };
    writer.writeJsonGuarded("result.json", overridden);
  }

  writer.journal({
    type: "verify.run-finished",
    payload: {
      verdict,
      exitCode,
      counts: {
        pass: summary.counts.pass,
        fail: summary.counts.fail,
        blocked: summary.counts.blocked,
        notRun: summary.counts.notRun,
      },
      overrides,
    },
  });

  console.log("");
  console.log("verify-d4 summary:");
  console.log(
    `  ${summary.counts.pass} PASS, ${summary.counts.fail} FAIL, ${summary.counts.blocked} BLOCKED, ${summary.counts.notRun} NOT_RUN`,
  );
  if (overrides.length > 0) console.log(`  verdict override: ${overrides.join("; ")}`);
  console.log(`  verdict: ${verdict} (exit ${exitCode})`);
  console.log(`  evidence: ${writer.runDir}`);
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(`[verify-d4] VERIFIER_ERROR: ${String(err)}`);
  try {
    writer.journal({
      type: "verify.run-finished",
      payload: { verdict: "VERIFIER_ERROR", exitCode: 1, error: String(err) },
    });
    writer.writeJsonGuarded("result.json", {
      runId: writer.runId,
      schemaVersion: "d4-result-1",
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
