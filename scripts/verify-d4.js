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

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { basename, dirname } from "node:path";

import { EvidenceWriter } from "../tests/support/verifier/evidence.ts";
import { verifyD4FixturesIntegrity } from "../tests/support/verifier/d4-probes.ts";
import { runB1ImportCheck } from "../tests/support/verifier/d4-b1-import.ts";
import { runB2AnchorsCheck } from "../tests/support/verifier/d4-b2-anchors.ts";
import { runB3ExplorationCheck } from "../tests/support/verifier/d4-b3-exploration.ts";
import { runB4SearchCheck } from "../tests/support/verifier/d4-b4-search.ts";
import { runB5RestoreCheck } from "../tests/support/verifier/d4-b5-restore.ts";
import { runB6ScaleCheck } from "../tests/support/verifier/d4-b6-scale.ts";
import { runB9NavCheck } from "../tests/support/verifier/d4-b9-nav.ts";
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
      const adr4Path = join(ROOT, "docs", "adr", "ADR-004-d4-material-branching-and-first-question.md");
      const adr4 = existsSync(adr4Path) ? readFileSync(adr4Path, "utf8") : null;
      if (adr4 === null) {
        problems.push("ADR-004 missing");
      } else {
        for (const marker of ["**状态：Accepted", "决策一", "决策四", "测试义务"]) {
          if (!adr4.includes(marker)) problems.push(`ADR-004 missing marker: ${marker}`);
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
    // REAL executing check (D4-2): the frozen B2 selection set runs through the
    // product range/anchor resolution layer (MaterialRangeResolver) on top of
    // the real import pipeline (MaterialImportService + MaterialRepository).
    // All valid selections must resolve to exactly the stored truth (100%,
    // incl. repeat-word-2nd / cross-line / unicode / long-tail coverage); all
    // invalid selections must be rejected with the correct frozen category
    // reason (stale-version executes the md-vpair version pair; unsupported
    // materials refuse anchoring as material-not-ready); any successful
    // resolution of a frozen-invalid selection counts as a mis-location (0
    // required). The browser-selection part of charter B2 stays a later
    // run:d4-browser concern — this check's scope is the mechanical layer.
    fn: async () => {
      const d4Root = join(ROOT, "tests", "fixtures", "d4");
      if (!existsSync(d4Root)) {
        return {
          status: "NOT_RUN",
          exitCode: null,
          reason: "tests/fixtures/d4 not present in this tree",
        };
      }
      const outcome = await runB2AnchorsCheck(d4Root);
      log("b2-precise-anchors", `b2 precise anchors check\n${outcome.lines.join("\n")}`);
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
    id: "b3-material-exploration",
    // REAL executing check (D4-3): the material exploration loop runs on the
    // real service stack (MaterialImportService + MaterialRangeResolver +
    // MaterialBranchingService over the real TreeStudioService, offline echo
    // Pi runtime — zero credentials) against frozen B1 fixtures plus
    // deterministic data generated inside the check. Covers the offline-
    // executable core of charter §3.3/B3: create-from-selection (md + pdf),
    // context window honesty (24,000-unit cap, truncation marker, oversized
    // selection refusal), independent run origin, idempotent first question
    // (replay + post-restart determinism), 409 conflicts, reconcile-before-
    // action (unknown/failed), restore vs explicit new + look-alike/cross-tree
    // isolation, material return with source card, missing-session explicit
    // new exploration, non-ready refusal. The REAL-Pi part of charter B3
    // (browser evidence at the final candidate SHA) stays with
    // run:d4-browser --mode real-pi — see b3-real-exploration.
    fn: async () => {
      const d4Root = join(ROOT, "tests", "fixtures", "d4");
      if (!existsSync(d4Root)) {
        return {
          status: "NOT_RUN",
          exitCode: null,
          reason: "tests/fixtures/d4 not present in this tree",
        };
      }
      const outcome = await runB3ExplorationCheck(d4Root);
      log("b3-material-exploration", `b3 material exploration check\n${outcome.lines.join("\n")}`);
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
    id: "b3-real-exploration",
    // Evidence audit (delivered 2026-10-01): the recorded run:d4-browser
    // --mode real-pi run under evidence/d4/browser. mode is verified — an
    // echo/selftest run NEVER satisfies this row. Charter B3 items validated
    // against the recorded sidecars: md + pdf branches, ≥2 follow-up rounds
    // each, cross-branch isolation, restart continuation, double-click and
    // transport-layer response-loss idempotency, return-to-source exact
    // excerpts, Return material source cards + return-card jump, post-return
    // restart readability. This row audits evidence; producing it requires
    // credentials (TREEAI_STUDIO_API_KEY) outside this offline verifier.
    fn: async () => {
      const browserDir = join(ROOT, "evidence", "d4", "browser");
      if (!existsSync(browserDir)) {
        return { status: "NOT_RUN", exitCode: null, reason: "no evidence/d4/browser yet — the real-pi run has not been recorded" };
      }
      const runDirs = readdirSync(browserDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(browserDir, entry.name))
        .filter((dir) => existsSync(join(dir, "summary.json")))
        .sort()
        .reverse();
      for (const runDir of runDirs) {
        let summary = null;
        try {
          summary = JSON.parse(readFileSync(join(runDir, "summary.json"), "utf8"));
        } catch {
          continue;
        }
        if (summary.mode !== "real-pi") continue; /* echo runs never satisfy this row */
        const branchCheck = (summary.checks ?? []).find((c) => c.id === "d4-branch-from-material");
        const returnCheck = (summary.checks ?? []).find((c) => c.id === "d4-return-from-material");
        if (branchCheck === undefined || returnCheck === undefined) continue;
        if (branchCheck.status !== "PASS" || returnCheck.status !== "PASS") {
          return {
            status: "FAIL",
            exitCode: 2,
            error: { message: `the newest real-pi evidence run is not PASS on the B3 checks (${branchCheck.status}/${returnCheck.status}) — re-run and record` },
            detail: `evidence run ${String(summary.runId ?? "")} mode ${String(summary.mode)}`,
          };
        }
        const problems = [];
        let branchSidecar = null;
        let returnSidecar = null;
        try {
          const branchFile = readdirSync(runDir).find((name) => name.endsWith("-branch-from-material.json"));
          const returnFile = readdirSync(runDir).find((name) => name.endsWith("-return-from-material.json"));
          if (branchFile === undefined || returnFile === undefined) {
            return { status: "FAIL", exitCode: 2, error: { message: `real-pi run ${String(summary.runId ?? "")} lacks the B3 sidecars` } };
          }
          branchSidecar = JSON.parse(readFileSync(join(runDir, branchFile), "utf8"));
          returnSidecar = JSON.parse(readFileSync(join(runDir, returnFile), "utf8"));
        } catch (err) {
          return { status: "FAIL", exitCode: 2, error: { message: `B3 sidecar not readable: ${String(err)}` } };
        }
        if (branchSidecar.mode !== "real-pi" || returnSidecar.mode !== "real-pi") problems.push("sidecar mode is not real-pi");
        if (branchSidecar.branches?.md === undefined || branchSidecar.branches?.pdf === undefined) {
          problems.push("branches: md and pdf both required");
        }
        if (branchSidecar.selections?.md?.excerpt === undefined || branchSidecar.selections?.pdf?.excerpt === undefined) {
          problems.push("selections with excerpts for md and pdf both required");
        }
        const lines = (branchSidecar.lines ?? []).join("\n");
        if (!lines.includes("double-click")) problems.push("double-click idempotency not recorded");
        if (!lines.includes("idempotent replay")) problems.push("response-loss idempotent-retry not recorded");
        const followUps = (branchSidecar.lines ?? []).filter((l) => l.includes("follow-up rounds landed")).length;
        if (followUps < 2) problems.push(`follow-up rounds recorded for ${String(followUps)} branch(es), need md + pdf (2)`);
        if (!lines.includes("cross-branch isolation")) problems.push("cross-branch isolation not recorded");
        if (!lines.includes("restart continuation")) problems.push("restart continuation not recorded");
        const retLines = (returnSidecar.lines ?? []).join("\n");
        if (!retLines.includes("exact excerpt in view")) problems.push("return-to-source exact excerpt not recorded");
        if (!retLines.includes("material source fields")) problems.push("Return material source card fields not recorded");
        if (!retLines.includes("source jump reopens the reader")) problems.push("return-card source jump not recorded");
        if (!retLines.includes("restart")) problems.push("post-return restart readability not recorded");
        if ((returnSidecar.returns ?? []).length < 2) problems.push("returns for md and pdf both required");
        if (problems.length > 0) {
          return {
            status: "FAIL",
            exitCode: 2,
            error: { message: `recorded real-pi B3 evidence is incomplete: ${problems.join("; ")}` },
            detail: `evidence run ${String(summary.runId ?? "")} mode ${String(summary.mode)}`,
          };
        }
        return {
          status: "PASS",
          exitCode: 0,
          detail:
            `real-pi run ${String(summary.runId ?? "")} (mode ${String(summary.mode)}, gitCommit ${String(summary.gitCommit ?? "?").slice(0, 12)}): ` +
            "md+pdf branches with real first questions, double-click + response-loss idempotency, 2 follow-up rounds each, " +
            "cross-branch isolation, restart continuation, return-to-source exact excerpts, Return source cards + jump, post-return restart",
        };
      }
      return {
        status: "NOT_RUN",
        exitCode: null,
        reason: "no recorded run:d4-browser --mode real-pi evidence run yet (this row audits recorded evidence; producing it needs TREEAI_STUDIO_API_KEY)",
      };
    },
  },
  {
    id: "b4-cross-material-find",
    // REAL executing check (D4-4): the frozen B4 corpus (facts.json: saved
    // product facts across 3 trees; material fragments pinned to the B1 frozen
    // truth canonicalText) is assembled into search documents through the
    // PRODUCT assembly path (buildSearchDocuments in
    // apps/studio/src/search/search-service.ts — the same pure function the
    // HTTP search endpoints use) and queried through the real engine
    // (LocalSearchEngine). Every positive query must place its pre-specified
    // target factId in the top-5 (charter floor 95%; the frozen set + the
    // deterministic engine assert all of them); every no-result query must
    // return zero hits (nothing fabricated). The browser/UI part of charter
    // B4 (source jump) stays with run:d4-browser; the HTTP endpoints are
    // covered by the studio suite (search-api.test.ts).
    fn: async () => {
      const d4Root = join(ROOT, "tests", "fixtures", "d4");
      if (!existsSync(d4Root)) {
        return {
          status: "NOT_RUN",
          exitCode: null,
          reason: "tests/fixtures/d4 not present in this tree",
        };
      }
      const outcome = runB4SearchCheck(d4Root);
      log("b4-cross-material-find", `b4 cross-material find check\n${outcome.lines.join("\n")}`);
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
    id: "b5-restore-integrity",
    // REAL executing check (D4-5): export/restore portability through the
    // actual CLI entry (subprocesses running apps/studio/src/index.ts export /
    // --import-package) against a representative dataset built by the real
    // import pipeline + repositories. Covers the offline-mechanical slice of
    // charter B5: empty-dir restore integrity compare (saved facts/returns/
    // excerpts survive), corrupted package refused with the target and source
    // untouched, material new version keeps old excerpt linkage, whole-session
    // deletion degrades availability honestly (facts stay readable; explicit
    // new exploration is the product path), parse cancel holds after restore,
    // and per-request search rebuild identical over source and restored
    // databases (B5 索引删除重建). The browser-path items of B5 (restart+
    // resume in a real browser, the explicit-new-exploration UI affordance)
    // stay with run:d4-browser / the final candidate-SHA regression — not
    // claimed here.
    fn: async () => {
      const outcome = await runB5RestoreCheck(ROOT);
      log("b5-restore-integrity", `b5 restore/asset-integrity check\n${outcome.lines.join("\n")}`);
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
    id: "b6-scale-performance",
    // REAL executing check (D4-6): the frozen B6 scale dataset (spec at
    // tests/fixtures/d4/b6-scale/spec.json) is generated deterministically by
    // scripts/d4/gen-b6-scale-dataset.mjs (two CLI runs byte-identical +
    // --load-check into a real persistence DB), loaded through the real
    // parsers + repository APIs (100 materials / exactly 1M canonical units /
    // 1,000 non-trunk branches / 10,000 saved facts), and measured through the
    // REAL service/HTTP surface on a server assembled like index.ts:
    // search p95 ≤500ms over the 50 frozen needle queries (warm, per-request
    // rebuild path; cold reported separately), material-open p95 ≤2s over 30
    // existing-material opens (first visible blocks page, large PDFs
    // included), the 10 MiB/100-page frozen sample imports to parse-ready
    // ≤30s, cancel answers ≤200ms with late results structurally discarded,
    // scroll block-page p95 ≤200ms. CPU/memory/OS + loadavg recorded;
    // near-limit probes are rerun once with both runs recorded (parallel-wave
    // machine honesty). The browser face of B6 stays NOT claimed: see
    // b6-browser-face.
    fn: async () => {
      const outcome = await runB6ScaleCheck(ROOT);
      log("b6-scale-performance", `b6 scale/performance check\n${[...outcome.lines, ...outcome.notRun.map((n) => `NOT_RUN: ${n}`)].join("\n")}`);
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
    id: "b6-browser-face",
    // REAL executing check (final browser-evidence wave): audits the committed
    // run:d4-browser evidence under evidence/d4/browser/ for the newest run whose
    // summary carries d4-b6-scale-browser PASS, validating the recorded metrics
    // against the charter B6 browser budgets (material-open p95 <=2s over 30 real
    // sidebar opens incl. long PDFs readable with the first visible page; no
    // >200ms main-thread segment while paging; keystroke-to-render p95 <=200ms
    // while paging; the cancel attempt + its honest structural finding; search
    // hit-list render recorded as evidence). The browser measurement itself runs
    // via run:d4-browser (real Chrome + real studio processes on the B6 corpus);
    // this row verifies the recorded evidence is present, complete and within
    // budget, and discloses its binding (runId / gitCommit / mode / environment).
    // Local-machine engineering evidence (environment in the sidecar) — never
    // claimed cross-machine; the final candidate-SHA regression re-runs
    // run:d4-browser. The server-side budgets (search p95, gated cancel) stay
    // with b6-scale-performance — the two rows never substitute for each other.
    fn: async () => {
      const audit = auditBrowserEvidence(ROOT, "d4-b6-scale-browser", "b6-scale-browser", {
        validate: (sidecar) => {
          const problems = [];
          const open = sidecar.materialOpen;
          if (open === undefined || open.stats === undefined) problems.push("material-open metrics missing");
          else {
            if (open.stats.count !== 30) problems.push(`material-open count ${String(open.stats.count)} != 30`);
            if (open.stats.p95Ms > 2000) problems.push(`material-open p95 ${String(open.stats.p95Ms)}ms > 2000ms`);
          }
          const r = sidecar.responsiveness;
          if (r === undefined || r.stepLatency === undefined || r.keystrokeLatency === undefined) {
            problems.push("responsiveness metrics missing");
          } else {
            if (r.worstLongTaskMs > 200) problems.push(`worst longtask ${String(r.worstLongTaskMs)}ms > 200ms`);
            if (r.stepLatency.p95Ms > 200) problems.push(`scroll step-to-frame p95 ${String(r.stepLatency.p95Ms)}ms > 200ms`);
            if (r.keystrokeLatency.count < 10) problems.push(`only ${String(r.keystrokeLatency.count)} keystrokes measured`);
            if (r.keystrokeLatency.p95Ms > 200) problems.push(`keystroke-to-render p95 ${String(r.keystrokeLatency.p95Ms)}ms > 200ms`);
          }
          const cancel = sidecar.cancelProbe;
          if (cancel === undefined) problems.push("cancel probe record missing");
          else if (cancel.clickToCanceledMs === undefined && cancel.windowMissed !== true) {
            problems.push("neither a measured cancel nor the honest window-missed finding is recorded");
          } else if (cancel.clickToCanceledMs !== undefined && cancel.clickToCanceledMs > 500) {
            problems.push(`cancel click→canceled ${String(cancel.clickToCanceledMs)}ms > 500ms (browser-observed)`);
          }
          if (sidecar.searchRender === undefined || (sidecar.searchRender.queries ?? []).length < 10) {
            problems.push("search hit-list render evidence missing (<10 queries)");
          }
          return problems;
        },
        describe: (sidecar) => {
          const open = sidecar.materialOpen.stats;
          const r = sidecar.responsiveness;
          const cancel = sidecar.cancelProbe;
          return (
            `30 real-sidebar material opens p95 ${String(open.p95Ms)}ms (median ${String(open.medianMs)}ms, long PDFs readable with the first ` +
            `visible page); paging the long PDF + long md: worst longtask ${String(r.worstLongTaskMs)}ms over ${String(r.longTaskCount)} tasks, ` +
            `step-to-frame p95 ${String(r.stepLatency.p95Ms)}ms; keystroke-to-render p95 ${String(r.keystrokeLatency.p95Ms)}ms while paging; ` +
            `cancel: ${
              cancel.clickToCanceledMs !== undefined
                ? `click → canceled in ${String(cancel.clickToCanceledMs)}ms (browser-observed)`
                : `window structurally missed (single-threaded server + synchronous parser — finding recorded; import-to-ready ${String(cancel.importToReadyMs)}ms ≤ 30s browser-observed)`
            }; search hit-list render p50 ${String(sidecar.searchRender.stats.medianMs)}ms / p95 ${String(sidecar.searchRender.stats.p95Ms)}ms (evidence)`
          );
        },
      });
      return audit;
    },
  },
  {
    id: "b7-beta-usability",
    // REAL executing check (B7 automated part): audits the committed
    // run:d4-browser evidence under evidence/d4/browser/ for the newest run whose
    // summary carries d4-beta-usability PASS, validating the recorded sidecar's
    // six scenario blocks against the charter B7 automated surface (clean-env
    // start per README with an honest first-boot empty state; wide (>=1440px) and
    // narrow (~390x844 mobile) viewports usable with no horizontal overflow and
    // hit-testable key controls + reachable capture bar; keyboard Tab traversal
    // to the main controls with visible focus, Enter/Space activation, layered
    // Escape with focus restoration, reader arrow scrolling, no focus trap;
    // simulated touch via CDP Input.dispatchTouchEvent — tap/swipe/drag-select
    // arming the capture bar through the selectionchange path/copy tap; reduced-
    // motion honored with immediate-arrival positioning jumps; the in-session
    // focus/scroll/draft round trip preserving draft text, focus, panel scroll
    // and the reader's saved reading position). The browser measurement itself
    // runs via run:d4-browser (real Chrome + a real studio process, echo in
    // selftest / real Pi in real-pi mode). HONEST SCOPE: this row passing is the
    // AUTOMATED part of B7 only — the Mac experience sign-off and the 3–5 person
    // individual trials remain the owner's D4-G3 human sequence and are never
    // substituted by this audit.
    fn: async () => {
      const audit = auditBrowserEvidence(ROOT, "d4-beta-usability", "beta-usability", {
        validate: (sidecar) => {
          const problems = [];
          const b = sidecar.betaUsability;
          if (b === undefined) {
            return ["the sidecar carries no betaUsability block"];
          }
          const cleanBoot = b.cleanBoot;
          if (cleanBoot === undefined) problems.push("cleanBoot section missing");
          else {
            if (cleanBoot.entryConsistentWithReadme !== true || cleanBoot.flagsConsistentWithReadme !== true) {
              problems.push("the README start-path reconciliation did not hold (entry/flags)");
            }
            const empty = cleanBoot.emptyStateHonest ?? {};
            if (empty.emptyStateVisible !== true || empty.forestTreeButtons !== 0 || empty.materialsSectionHidden !== true) {
              problems.push("the first-boot empty state is not recorded as honest (no trees / no materials / create-tree affordance)");
            }
            if (typeof cleanBoot.treeCreatedViaEmptyState !== "string") {
              problems.push("the create-tree flow was not exercised on the clean boot");
            }
          }
          const wn = b.wideNarrow;
          if (wn === undefined || wn.wide === undefined || wn.narrow === undefined) {
            problems.push("wideNarrow sections missing");
          } else {
            if (wn.wide.widthPx === undefined || wn.wide.widthPx < 1440) problems.push(`wide viewport ${String(wn.wide.widthPx)}px < 1440px`);
            if (wn.narrow.widthPx === undefined || wn.narrow.widthPx > 400) problems.push(`narrow viewport ${String(wn.narrow.widthPx)}px is not the ~390px mobile window`);
            for (const [name, section] of [["wide", wn.wide], ["narrow", wn.narrow]]) {
              if ((section.overflowX?.documentElement ?? 99) > 1) problems.push(`${name} viewport records horizontal overflow`);
              if (section.readerUsable !== true || section.panelUsable !== true) problems.push(`${name} viewport reader/panel not recorded usable`);
              const hits = section.hits ?? {};
              for (const control of ["newTree", "materialImport", "searchInput", "branchTab"]) {
                if (hits[control] !== true) problems.push(`${name} viewport: the ${control} control is not recorded hit-testable`);
              }
            }
            if (wn.narrow.drawerOpensViaToggle !== true) problems.push("the narrow sidebar drawer does not open via the toggle");
          }
          const kb = b.keyboard;
          if (kb === undefined) problems.push("keyboard section missing");
          else {
            if (kb.tabSteps === undefined || kb.tabSteps < 1) problems.push("keyboard Tab traversal steps missing");
            const reached = kb.reached ?? {};
            for (const control of ["newTree", "materialImport", "searchInput", "readerContent"]) {
              if (reached[control] !== true) problems.push(`keyboard traversal never reached ${control}`);
            }
            if (kb.focusStyleVisible === undefined || Object.values(kb.focusStyleVisible ?? {}).some((s) => s === null || s?.outlineStyle === "none")) {
              problems.push("the keyboard focus indicator is not recorded visible (computed outline)");
            }
            if ((kb.arrowScroll?.afterDown ?? 0) <= (kb.arrowScroll?.before ?? 0)) problems.push("reader arrow scrolling not recorded effective");
            if (kb.enterActivation === undefined || kb.spaceActivation === undefined) problems.push("Enter/Space activation not recorded");
            if ((kb.escapeLayers ?? []).length < 3 || !(kb.escapeLayers ?? []).every((l) => l.ok === true)) {
              problems.push("layered Escape close with focus restoration not recorded for drawer/reader/panel");
            }
            if (kb.noFocusTrap !== true) problems.push("the no-focus-trap assertion is not recorded");
          }
          const touch = b.touch;
          if (touch === undefined) problems.push("touch section missing");
          else {
            if (touch.tapOpenedReader !== true) problems.push("touch tap did not open the material reader");
            if ((touch.swipeScrolledPx ?? 0) <= 0) problems.push("the touch swipe did not scroll the reader");
            if (touch.selectionArmedViaTouch !== true) problems.push("the in-gesture text-layer selection did not arm the capture bar (selectionchange path)");
            if (touch.toolbarButtonTapped !== true) problems.push("the capture-bar toolbar button was not tapped");
            if (typeof touch.copyVerification !== "string") problems.push("the copy verification is not recorded");
          }
          const rm = b.reducedMotion;
          if (rm === undefined) problems.push("reducedMotion section missing");
          else {
            if (rm.matched !== true) problems.push("page matchMedia('(prefers-reduced-motion: reduce)') was not true under the emulation");
            if (rm.immediateArrival !== true) problems.push("the positioning jump / stick-to-bottom was not immediate under reduce (in-transit frames recorded)");
            if (rm.viewSourceJump === undefined || rm.viewSourceJump.anchoredBlock === undefined) problems.push("the View-source positioning jump record is missing");
          }
          const fsd = b.focusScrollDraft;
          if (fsd === undefined) problems.push("focusScrollDraft section missing");
          else {
            if (fsd.draftPreserved !== true) problems.push("the panel draft text was not preserved across the round trip");
            if (fsd.focusRestoredTo !== "#panel-view-source") problems.push(`focus after the round trip is ${String(fsd.focusRestoredTo)} (expected #panel-view-source)`);
            if (fsd.panelScrollPreserved === undefined) problems.push("the panel scroll preservation record is missing");
            const rsp = fsd.readerScrollPreserved ?? {};
            if (rsp.restoredToBlock !== rsp.topBlockAtClose || (rsp.restoredDiffPx ?? 99) > 2) {
              problems.push("the reader did not reopen at the saved reading position (in-session round trip)");
            }
          }
          return problems;
        },
        describe: (sidecar) => {
          const b = sidecar.betaUsability;
          return (
            `clean boot per README (argv/entry/flags reconciled; honest empty state; tree created via the empty-state action); ` +
            `wide ${String(b.wideNarrow.wide.widthPx)}px + narrow ${String(b.wideNarrow.narrow.widthPx)}px (mobile) viewports usable ` +
            `with no horizontal overflow and hit-testable key controls; keyboard: ${String(b.keyboard.tabSteps)} Tab steps to the reader text ` +
            `with visible focus outlines, Enter+Space activations, ${String(b.keyboard.escapeLayers.length)} layered Escape closes with focus ` +
            `restoration, reader arrows scroll; touch: ${String(b.touch.taps)} taps / ${String(b.touch.swipes)} swipes / ` +
            `${String(b.touch.dragSelects)} in-gesture drag-select arming the capture bar via selectionchange (${b.touch.copyVerification}); ` +
            `reduced-motion honored with immediate arrival; draft/focus/panel-scroll/reader-position all preserved across the in-session ` +
            `round trip — AUTOMATED part of B7 only: the Mac sign-off and the 3–5 person trials remain the owner's D4-G3 human sequence, ` +
            `so this PASS is NOT B7 complete`
          );
        },
      });
      return audit;
    },
  },
  {
    id: "b8-install-crossplatform",
    fn: notRunCheck(
      "b8-install-crossplatform",
      "D4-7",
      "engineering delivered (packaging scripts/d4/package-installer.mjs + launcher + d4-installer CI workflow + macOS local real test under evidence/d4/d4-7/); B8 acceptance still requires the owner's clean-install real-machine validation on Windows 11 x64 and Ubuntu 24.04 (plus real-Pi material smoke), which no CI run can substitute",
    ),
  },
  {
    id: "b9-large-tree-nav",
    // REAL executing check (D4-8): the offline structural slice of charter B9
    // against the actual deliverable surfaces — the generator CLI as real
    // subprocesses (determinism across processes, manifest hash equality,
    // --load-check into a real persistence DB), the loader, and the /api/nav/*
    // HTTP surface through a real node:http server with the full B9 dataset:
    // structure-truth vs API queries 100% (all 10,100 branches located by id
    // with ancestors/path/origin/sibling position matching truth; every node
    // view compared via subtree pagination), 100-level deep chain complete,
    // wide-tree children paged in truth order, same-name disambiguation by
    // id, empty tree honest, lazy endpoints page-bounded (<1MiB), expand
    // state surviving a simulated restart (migration 0010), and nav responses
    // byte-identical after every session goes unavailable (product tree ≠
    // run/session trees). Engine-side p95 + first-open are recorded as
    // evidence only — the browser face of B9 (p95 in a real browser,
    // virtualization, keyboard) is NOT claimed here: see b9-nav-browser-face.
    fn: async () => {
      const outcome = await runB9NavCheck(ROOT);
      log("b9-large-tree-nav", `b9 large-scale tree nav check\n${[...outcome.lines, ...outcome.notRun.map((n) => `NOT_RUN: ${n}`)].join("\n")}`);
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
    id: "b9-nav-browser-face",
    // REAL executing check (final browser-evidence wave): audits the committed
    // run:d4-browser evidence under evidence/d4/browser/ for the newest run whose
    // summary carries d4-nav-browser PASS, validating the recorded metrics against
    // the charter B9 browser budgets (b9-big first open to usable <=2s; >=50 timed
    // scripted expand/switch ops with p95 <=300ms; virtualized DOM row count bound
    // against the loaded row total; keyboard level-by-level movement with focus
    // retained across re-windowing; expand state surviving a real SIGTERM process
    // restart; structure-truth spot checks). The browser measurement itself runs
    // via run:d4-browser (real Chrome + a real studio process on the B9 dataset);
    // this row verifies the recorded evidence is present, complete and within
    // budget, and discloses its binding (runId / gitCommit / mode / environment).
    // Local-machine engineering evidence (environment in the sidecar) — never
    // claimed cross-machine; the final candidate-SHA regression re-runs
    // run:d4-browser. The engine-side 100% locate/subtree verification stays with
    // b9-large-tree-nav — the two rows never substitute for each other.
    fn: async () => {
      const audit = auditBrowserEvidence(ROOT, "d4-nav-browser", "nav-browser", {
        validate: (sidecar) => {
          const problems = [];
          const timing = sidecar.timing;
          if (timing === undefined) problems.push("nav timing metrics missing");
          else {
            if (timing.bigFirstOpenMs === undefined || timing.bigFirstOpenMs > 2000) {
              problems.push(`b9-big first open ${String(timing.bigFirstOpenMs)}ms > 2000ms (or missing)`);
            }
            if (timing.timedOpCount === undefined || timing.timedOpCount < 50) {
              problems.push(`timed op count ${String(timing.timedOpCount)} < 50`);
            }
            if (timing.p95Ms === undefined || timing.p95Ms > 300) {
              problems.push(`nav op p95 ${String(timing.p95Ms)}ms > 300ms (or missing)`);
            }
          }
          const v = sidecar.virtualization;
          if (v === undefined || v.wideTotalRows === undefined || v.wideTotalRows < 200 || (v.samples ?? []).length < 4) {
            problems.push("virtualization samples missing or the wide tree was not fully loaded (<200 rows)");
          } else if (!(v.samples ?? []).every((sample) => sample.domRows <= v.domRowLimit)) {
            problems.push("a virtualization sample exceeded the windowed DOM row limit");
          }
          if ((sidecar.keyboard?.steps ?? []).length < 8) problems.push("keyboard steps missing (<8)");
          const restart = sidecar.restart;
          if (restart === undefined || restart.before === undefined || restart.after === undefined || restart.selectedRestored === undefined) {
            problems.push("expand-state restart record missing");
          }
          if ((sidecar.spotChecks ?? []).length < 8) problems.push(`structure-truth spot checks < 8 (${String((sidecar.spotChecks ?? []).length)})`);
          return problems;
        },
        describe: (sidecar) => {
          const timing = sidecar.timing;
          const v = sidecar.virtualization;
          return (
            `b9-big first open to usable ${String(timing.bigFirstOpenMs)}ms; ${String(timing.timedOpCount)} timed expand/switch ops ` +
            `p95 ${String(timing.p95Ms)}ms (median ${String(timing.medianMs)}ms, max ${String(timing.maxMs)}ms; ` +
            `${String(timing.preemptedOps ?? 0)} more-page ops pump-preempted, honestly recorded); virtualization: DOM rows ≤ ` +
            `${String(v.domRowLimit)} while ${String(v.wideTotalRows)} wide-tree rows are loaded; keyboard ` +
            `${String(sidecar.keyboard.steps.length)} steps with focus retained; expand state byte-equal across a real ` +
            `SIGTERM restart (selected ${String(sidecar.restart.selectedRestored)} restored); ${String(sidecar.spotChecks.length)} ` +
            `structure-truth spot checks; ${String((sidecar.frontendBugs ?? []).length)} frontend findings recorded`
          );
        },
      });
      return audit;
    },
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
