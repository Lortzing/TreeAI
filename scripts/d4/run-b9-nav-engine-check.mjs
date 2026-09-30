#!/usr/bin/env node
/**
 * run-b9-nav-engine-check — TreeAI D4-8 B9 large-scale tree-navigation
 * ENGINE-level acceptance check (offline, deterministic, no network).
 *
 * Charter: docs/d4/D4-project-v1.md §6 B9 (engine-executable subset).
 * Frozen spec: tests/fixtures/d4/b9-nav/spec.json (never modified here).
 *
 * Pipeline: generate (double-run determinism self-check) → structure-truth
 * invariants → load into a REAL persistence database in a fresh temp data
 * dir via the real repository/store APIs → run the frozen engine probe set
 * (locate/ancestors/path 100%, origins 100%, wide pagination, deep chain,
 * same-name disambiguation, search, empty tree, big-tree shape, tree list)
 * plus the scripted performance sequence (≥50 warm expand/switch/search
 * ops, p95 ≤ 300ms; cold first open of the 5000-node tree ≤ 2s) → append
 * evidence under evidence/d4/runs/b9-nav-engine-<UTC>/ (append-only; every
 * write redacted + secret-scanned; post-write rescan can override the
 * verdict to FAIL).
 *
 * HONEST SCOPE — this is ENGINE-LEVEL evidence only, NOT the B9 browser
 * verdict: DOM/virtualization growth, keyboard navigation and restart-state
 * persistence belong to the D4-8 wiring/frontend increments and are recorded
 * NOT_RUN there. B9 must not be claimed PASS from this script alone.
 *
 * Exit codes (verify-d4 convention): 0 = every check PASS; 1 = tool error
 * (unexpected internal error); 2 = at least one FAIL (incl. secret-scan
 * findings).
 *
 * Flags:
 *   --runs-root=<dir>  where the evidence run directory is created
 *                      (default evidence/d4/runs)
 *   --keep-data        keep the temporary loaded database directory (and
 *                      print its path) for debugging; removed by default
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { EvidenceWriter } from "../../tests/support/verifier/evidence.ts";
import { runCommand, utcRunId } from "../../tests/support/verifier/util.ts";
import {
  buildB9Manifest,
  checkB9Invariants,
  generateB9Dataset,
  serializeB9Dataset,
  serializeB9Manifest,
  sha256Hex,
} from "../../apps/studio/src/nav/b9-dataset.ts";
import { loadB9Dataset, openB9Repositories } from "../../apps/studio/src/nav/b9-loader.ts";
import { TreeNavEngine } from "../../apps/studio/src/nav/nav-engine.ts";
import { runB9EngineChecks } from "../../apps/studio/src/nav/b9-probes.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPT_DIR, "..", "..");

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

const args = process.argv.slice(2);

function argValue(name) {
  const prefix = `--${name}=`;
  for (const a of args) {
    if (a.startsWith(prefix)) return a.slice(prefix.length);
  }
  return null;
}

const runsRootArg = argValue("runs-root");
const RUNS_ROOT = runsRootArg === null ? join(ROOT, "evidence", "d4", "runs") : runsRootArg;
const KEEP_DATA = args.includes("--keep-data");

/* ------------------------------------------------------------------ */
/* 运行                                                                */
/* ------------------------------------------------------------------ */

function gitState() {
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" });
    return { commit, dirty: status.trim().length > 0 };
  } catch {
    return { commit: "unknown", dirty: true };
  }
}

function fileSha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const startedAt = Date.now();
const writer = new EvidenceWriter(RUNS_ROOT, utcRunId("b9-nav-engine"));
const git = gitState();

const toolError = (error) => {
  // 工具错误（exit 1）：仍写出诚实的事件与结果，再退出。
  try {
    writer.journal({ type: "tool-error", payload: { message: String(error?.message ?? error) } });
    writer.writeJsonGuarded("result.json", {
      schemaVersion: "b9-nav-engine-1",
      runId: writer.runId,
      scope: "engine-level evidence only — NOT the B9 browser verdict",
      verdict: "TOOL_ERROR",
      exitCode: 1,
      error: String(error?.message ?? error),
    });
  } catch {
    // 尽力写盘；退出码仍以 1 表达工具错误。
  }
  process.stderr.write(`run-b9-nav-engine-check: tool error: ${String(error?.stack ?? error)}\n`);
  process.exit(1);
};

try {
  writer.journal({ type: "run-start", payload: { mode: "offline-engine", git } });

  /* ---------- 1) 生成 + 确定性 + 不变量 ---------- */
  const dataset = generateB9Dataset();
  const structureJson = serializeB9Dataset(dataset);
  const secondRunJson = serializeB9Dataset(generateB9Dataset());
  const determinismOk = structureJson === secondRunJson;
  const invariantProblems = checkB9Invariants(dataset);
  const manifest = buildB9Manifest(dataset, structureJson);
  const manifestJson = serializeB9Manifest(manifest);
  writer.journal({
    type: "dataset-generated",
    payload: {
      setId: dataset.setId,
      seed: dataset.seed,
      determinismOk,
      invariantProblems: invariantProblems.length,
      structureTruthSha256: manifest.structureTruthSha256,
    },
  });

  const checks = [];
  checks.push({
    id: "dataset-determinism",
    status: determinismOk ? "PASS" : "FAIL",
    durationMs: 0,
    detail: determinismOk
      ? `two generations byte-identical (${String(structureJson.length)} bytes); structureTruthSha256 ${manifest.structureTruthSha256}`
      : "two generations differ — determinism broken (seed/PRNG discipline)",
    failures: determinismOk ? [] : ["serialized structure truth differs across runs"],
  });
  checks.push({
    id: "structure-invariants",
    status: invariantProblems.length === 0 ? "PASS" : "FAIL",
    durationMs: 0,
    detail:
      invariantProblems.length === 0
        ? `totals: trees ${String(dataset.totals.trees)}, non-trunk branches ${String(dataset.totals.nonTrunkBranches)} (branch rows ${String(dataset.totals.branchRows)}), maxDepth ${String(dataset.totals.maxDepth)}, turn origins ${String(dataset.totals.turnOrigins)}, material origins ${String(dataset.totals.materialOrigins)}; all six special-tree shape rules verified`
        : `${String(invariantProblems.length)} invariant problem(s)`,
    failures: invariantProblems,
  });

  /* ---------- 2) 装载到真实产品库（全新临时数据目录） ---------- */
  const dataDir = mkdtempSync(join(tmpdir(), "b9-nav-engine-"));
  const repos = openB9Repositories(dataDir);
  let loadStats;
  try {
    loadStats = loadB9Dataset(dataset, repos);
    const integrity = repos.repository.integrityCheck();
    const loadOk =
      loadStats.branches === dataset.totals.branchRows &&
      loadStats.turnOrigins === dataset.totals.turnOrigins &&
      loadStats.materialOrigins === dataset.totals.materialOrigins &&
      integrity.ok;
    checks.push({
      id: "dataset-load",
      status: loadOk ? "PASS" : "FAIL",
      durationMs: Math.round(loadStats.elapsedMs),
      detail: loadOk
        ? `loaded via real repository APIs into a fresh temp data dir in ${loadStats.elapsedMs.toFixed(0)}ms: ${String(loadStats.branches)} branch rows / ${String(loadStats.episodes)} episodes / ${String(loadStats.runs)} runs / ${String(loadStats.userTurns)} user turns / ${String(loadStats.assistantTurns)} assistant turns / ${String(loadStats.materials)} materials (ready) / ${String(loadStats.turnOrigins)} turn origins / ${String(loadStats.materialOrigins)} material origins; sqlite integrity_check ok`
        : `load mismatch or integrity failure (branches ${String(loadStats.branches)}/${String(dataset.totals.branchRows)}, integrity ok=${String(integrity.ok)})`,
      failures: loadOk ? [] : ["loaded row counts differ from dataset totals or sqlite integrity_check failed"],
    });
    writer.journal({ type: "dataset-loaded", payload: { ...loadStats, integrityOk: integrity.ok } });
  } catch (error) {
    repos.close();
    rmSync(dataDir, { recursive: true, force: true });
    toolError(error);
  }

  /* ---------- 3) 引擎级探针 + 性能序列 ---------- */
  const engine = new TreeNavEngine({ repository: repos.repository, materialRepository: repos.materialRepository });
  const engineResult = runB9EngineChecks({ dataset, engine });
  for (const probe of engineResult.probes) {
    checks.push({
      id: probe.id,
      status: probe.status,
      durationMs: Math.round(probe.durationMs),
      detail: probe.detail,
      failures: probe.failures,
    });
  }
  writer.journal({
    type: "checks-complete",
    payload: {
      total: checks.length,
      passed: checks.filter((c) => c.status === "PASS").length,
      failed: checks.filter((c) => c.status === "FAIL").length,
    },
  });

  /* ---------- 4) 证据写盘（脱敏 + 秘密扫描守卫） ---------- */
  const npmVersion = runCommand("npm", ["--version"], { cwd: ROOT });
  const environment = {
    schemaVersion: "b9-nav-engine-environment-1",
    generatedAt: new Date().toISOString(),
    mode: "offline-engine",
    runtime: {
      node: process.version,
      npm: npmVersion.status === 0 ? npmVersion.stdout.trim() : "unknown",
      platform: process.platform,
      arch: process.arch,
      ci: process.env.CI === "true",
    },
    credentialPolicy: {
      policy: "offline",
      note: "engine-level check: no network, no model, no credentials; the B9 browser verdict (DOM/virtualization/keyboard) is a separate wiring/frontend increment",
    },
    git,
    verifier: { name: "run-b9-nav-engine-check", version: "0.1.0" },
  };

  const specSha256 = fileSha256(join(ROOT, "tests", "fixtures", "d4", "b9-nav", "spec.json"));
  const fixturesManifestSha256 = fileSha256(join(ROOT, "tests", "fixtures", "d4", "MANIFEST.sha256"));
  const anyFail = checks.some((check) => check.status === "FAIL");
  const result = {
    schemaVersion: "b9-nav-engine-1",
    runId: writer.runId,
    scope:
      "engine-level evidence only — NOT the B9 browser verdict; DOM/virtualization/keyboard/restart-state belong to the D4-8 wiring/frontend increments",
    verdict: anyFail ? "FAIL" : "PASS",
    exitCode: anyFail ? 2 : 0,
    command: "node scripts/d4/run-b9-nav-engine-check.mjs",
    durationMs: Date.now() - startedAt,
    dataset: {
      setId: dataset.setId,
      seed: dataset.seed,
      spec: "tests/fixtures/d4/b9-nav/spec.json (frozen)",
      specSha256,
      fixturesManifestSha256,
      structureTruthSha256: manifest.structureTruthSha256,
      structureTruthBytes: manifest.structureTruthBytes,
      manifestSha256: sha256Hex(manifestJson),
      totals: dataset.totals,
    },
    load: loadStats,
    probeSummary: {
      total: checks.length,
      passed: checks.filter((c) => c.status === "PASS").length,
      failed: checks.filter((c) => c.status === "FAIL").length,
    },
    performance: {
      firstOpenMs: Number(engineResult.perf.firstOpenMs.toFixed(3)),
      warmupMs: Number(engineResult.perf.warmupMs.toFixed(3)),
      opCount: engineResult.perf.opCount,
      p95Ms: Number(engineResult.perf.p95Ms.toFixed(3)),
      medianMs: Number(engineResult.perf.medianMs.toFixed(3)),
      maxMs: Number(engineResult.perf.maxMs.toFixed(3)),
      limits: { p95Ms: 300, firstOpenMs: 2000 },
      note: "engine-level timings (in-process service calls on the loaded local database); not the browser p95",
    },
  };

  writer.writeJsonGuarded("environment.json", environment);
  writer.writeJsonGuarded("checks.json", { runId: writer.runId, checks });
  writer.writeJsonGuarded(
    "perf.json",
    {
      runId: writer.runId,
      firstOpenMs: Number(engineResult.perf.firstOpenMs.toFixed(3)),
      warmupMs: Number(engineResult.perf.warmupMs.toFixed(3)),
      opCount: engineResult.perf.opCount,
      p95Ms: Number(engineResult.perf.p95Ms.toFixed(3)),
      medianMs: Number(engineResult.perf.medianMs.toFixed(3)),
      maxMs: Number(engineResult.perf.maxMs.toFixed(3)),
      ops: engineResult.perf.ops.map((op) => ({ ...op, durationMs: Number(op.durationMs.toFixed(3)) })),
    },
  );
  writer.writeJsonGuarded("result.json", result);

  // 写盘后全目录复扫：新发现的秘密命中覆盖结论（纪律与 verify-d4 相同）。
  const journalCheckResult = writer.verifyJournalOnDisk();
  const rescan = writer.postWriteScan();
  const overrides = [];
  if (!journalCheckResult.ok) overrides.push(...journalCheckResult.problems);
  if (rescan.findings.length > 0) {
    overrides.push(
      `post-write scan found ${String(rescan.findings.length)} finding(s) in the run dir (rules: ${[
        ...new Set(rescan.findings.map((f) => f.ruleId)),
      ].join(", ")})`,
    );
  }
  let verdict = result.verdict;
  let exitCode = result.exitCode;
  if (overrides.length > 0 && verdict !== "FAIL") {
    verdict = "FAIL";
    exitCode = 2;
    const overridden = {
      ...result,
      verdict,
      exitCode,
      notes: [
        "verdict overridden after evidence writes: " + overrides.join("; "),
      ],
    };
    writer.writeJsonGuarded("result.json", overridden);
    process.stderr.write(`run-b9-nav-engine-check: verdict overridden to FAIL (${overrides.join("; ")})\n`);
  }

  repos.close();
  if (KEEP_DATA) {
    process.stdout.write(`run-b9-nav-engine-check: data dir kept at ${dataDir}\n`);
  } else {
    rmSync(dataDir, { recursive: true, force: true });
  }

  /* ---------- 5) 人类可读摘要 ---------- */
  for (const check of checks) {
    process.stdout.write(`[${check.status}] ${check.id} — ${check.detail}\n`);
    for (const failure of check.failures.slice(0, 10)) {
      process.stdout.write(`    failure: ${failure}\n`);
    }
  }
  process.stdout.write(
    `\nrun-b9-nav-engine-check: ${verdict} (${result.probeSummary.passed}/${String(checks.length)} checks pass; ` +
      `p95 ${result.performance.p95Ms}ms over ${String(result.performance.opCount)} warm ops; ` +
      `cold first open ${result.performance.firstOpenMs}ms)\n` +
      `evidence: ${writer.runDir}\n` +
      `scope: engine-level only — B9 is NOT claimable as PASS from this run (browser/frontend increments pending)\n`,
  );
  process.exit(exitCode);
} catch (error) {
  toolError(error);
}
