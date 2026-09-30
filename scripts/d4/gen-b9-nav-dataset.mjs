#!/usr/bin/env node
/**
 * TreeAI D4-8 — deterministic B9 large-scale tree-navigation dataset generator
 * (structure truth + manifest), implementing the FROZEN spec at
 * tests/fixtures/d4/b9-nav/spec.json (never modified by this script).
 *
 * Charter: docs/d4/D4-project-v1.md §4 D4-8, §5 大规模树导航, §6 B9.
 * Engine module: apps/studio/src/nav/b9-dataset.ts (this CLI is a thin wrapper).
 *
 * Dataset shape (per spec): 100 trees / 10000 non-trunk branches, with the six
 * special trees (b9-big 5000 nodes BFS branching 2–5, b9-deep 100-level chain,
 * b9-wide ≥200 root children, b9-empty trunk-only, b9-samename ≥50 same-titled
 * branches under different parents, b9-longtitle ≥100 titles ≥200 chars),
 * Chinese/English mixed template titles, turn + material origin mix, full
 * parent paths per node. Determinism: seed d4-b9-2026-09-30, per-step
 * xorshift128 PRNGs, no Math.random(), no timestamps — two runs are
 * byte-identical (self-verified on every run before anything is written).
 *
 * Generated dataset files are NOT committed: tests/fixtures/d4/b9-nav/ holds
 * only the frozen spec (MANIFEST discipline). This script refuses to write
 * into the fixtures tree and produces its output into an explicit --out dir.
 *
 * Self-verification performed on every run, before anything is written:
 *   1. determinism — the whole dataset is generated twice and the serialized
 *      structure truth must be byte-identical;
 *   2. structure-truth invariants — checkB9Invariants (totals, depth/parent
 *      consistency, all six special-tree shape rules, origin discipline)
 *      must return zero problems;
 *   3. manifest hash — recorded structureTruthSha256 matches the bytes written.
 *
 * Usage:
 *   node scripts/d4/gen-b9-nav-dataset.mjs --out DIR
 *   node scripts/d4/gen-b9-nav-dataset.mjs --out DIR --quiet
 *   node scripts/d4/gen-b9-nav-dataset.mjs --out DIR --load-check
 *
 * Exit codes (verify-d4 convention): 0 = all checks pass + written;
 * 1 = tool error; 2 = verification failure (nothing written).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  B9_SEED,
  B9_SET_ID,
  buildB9Manifest,
  checkB9Invariants,
  generateB9Dataset,
  serializeB9Dataset,
  serializeB9Manifest,
  sha256Hex,
} from "../../apps/studio/src/nav/b9-dataset.ts";
import { loadB9Dataset, openB9Repositories } from "../../apps/studio/src/nav/b9-loader.ts";

const SCRIPT_DIR = new URL(".", import.meta.url);
const REPO_ROOT = join(fileURLToPath(SCRIPT_DIR), "..", "..");
const FIXTURES_B9_DIR = join(REPO_ROOT, "tests", "fixtures", "d4", "b9-nav");

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

const outDir = argValue("out");
const quiet = args.includes("--quiet");
const loadCheck = args.includes("--load-check");

if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(
    [
      "usage: node scripts/d4/gen-b9-nav-dataset.mjs --out DIR [--quiet] [--load-check]",
      "",
      "  Deterministically generates the B9 nav dataset per the frozen spec",
      "  (tests/fixtures/d4/b9-nav/spec.json) into DIR:",
      "    b9-structure.json  — structure truth (per node: id, parent id, title,",
      "                         depth, origin kind, full parent path, origin refs)",
      "    b9-manifest.json   — content hashes + per-tree stats",
      "",
      "  Self-verifies determinism (double generation, byte-identical) and all",
      "  structure-truth invariants BEFORE writing anything. With --load-check",
      "  it additionally loads the dataset into a REAL persistence database in",
      "  a fresh temp dir via the real repository APIs, verifies row counts,",
      "  then removes the temp dir (structure truth is the artifact kept).",
      "  Exit codes: 0 pass, 1 tool error, 2 verification failure.",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

if (outDir === null) {
  process.stderr.write("error: --out DIR is required (see --help)\n");
  process.exit(1);
}

function fail(message, code = 2) {
  process.stderr.write(`gen-b9-nav-dataset: ${message}\n`);
  process.exit(code);
}

// 防御：绝不允许把生成物写进冻结 fixtures 树（spec 的修改=范围变更）。
const resolvedOut = isAbsolute(outDir) ? outDir : join(process.cwd(), outDir);
const relToFixtures = relative(FIXTURES_B9_DIR, resolvedOut);
if (relToFixtures === "" || (!relToFixtures.startsWith("..") && !isAbsolute(relToFixtures))) {
  fail(`refusing to write into the frozen fixtures tree (${FIXTURES_B9_DIR}); generated datasets are produced on demand elsewhere`);
}
if (existsSync(join(resolvedOut, "b9-structure.json"))) {
  fail(`output already exists at ${join(resolvedOut, "b9-structure.json")} (append-only discipline: choose a fresh directory)`);
}

/* ------------------------------------------------------------------ */
/* 生成 + 自校验（先全部通过，再写盘）                                   */
/* ------------------------------------------------------------------ */

const log = (line) => {
  if (!quiet) process.stdout.write(line);
};

log(`gen-b9-nav-dataset: seed=${B9_SEED} setId=${B9_SET_ID}\n`);

// 1) 双次生成，字节级恒等
const datasetA = generateB9Dataset();
const jsonA = serializeB9Dataset(datasetA);
const datasetB = generateB9Dataset();
const jsonB = serializeB9Dataset(datasetB);
if (jsonA !== jsonB) {
  fail("determinism check FAILED: two generations differ (byte-identical required)");
}
log(`  determinism: two runs byte-identical (${String(Buffer.byteLength(jsonA, "utf8"))} bytes / ${String(jsonA.length)} UTF-16 units)\n`);

// 2) 结构真值不变量
const problems = checkB9Invariants(datasetA);
if (problems.length > 0) {
  for (const problem of problems.slice(0, 20)) {
    process.stderr.write(`  invariant problem: ${problem}\n`);
  }
  fail(`invariant check FAILED: ${problems.length} problem(s)`);
}
log(`  invariants: 0 problems (trees ${datasetA.totals.trees}, non-trunk branches ${datasetA.totals.nonTrunkBranches}, branch rows ${datasetA.totals.branchRows}, maxDepth ${datasetA.totals.maxDepth}, turn origins ${datasetA.totals.turnOrigins}, material origins ${datasetA.totals.materialOrigins})\n`);

// 3) manifest 哈希一致性
const manifest = buildB9Manifest(datasetA, jsonA);
const manifestJson = serializeB9Manifest(manifest);
if (manifest.structureTruthSha256 !== sha256Hex(jsonA)) {
  fail("manifest hash check FAILED: structureTruthSha256 does not match the serialized bytes");
}

/* ------------------------------------------------------------------ */
/* 写盘（全部校验通过后）                                               */
/* ------------------------------------------------------------------ */

mkdirSync(resolvedOut, { recursive: true });
writeFileSync(join(resolvedOut, "b9-structure.json"), jsonA, "utf8");
writeFileSync(join(resolvedOut, "b9-manifest.json"), manifestJson, "utf8");

log(`  wrote: ${join(resolvedOut, "b9-structure.json")} (sha256 ${manifest.structureTruthSha256})\n`);
log(`  wrote: ${join(resolvedOut, "b9-manifest.json")} (sha256 ${sha256Hex(manifestJson)})\n`);
for (const tree of manifest.trees.filter((t) => t.kind === "special")) {
  log(`    ${tree.treeId}: ${tree.nodes} nodes, depth ${tree.maxDepth}, turn ${tree.turnOrigins}, material ${tree.materialOrigins}\n`);
}

/* ------------------------------------------------------------------ */
/* 可选：装载自检（真实仓储 API → 临时库 → 行数核对 → 删除）              */
/* ------------------------------------------------------------------ */

if (loadCheck) {
  const dataDir = mkdtempSync(join(tmpdir(), "b9-gen-loadcheck-"));
  const repos = openB9Repositories(dataDir);
  try {
    const stats = loadB9Dataset(datasetA, repos);
    const loadOk =
      stats.branches === datasetA.totals.branchRows &&
      stats.turnOrigins === datasetA.totals.turnOrigins &&
      stats.materialOrigins === datasetA.totals.materialOrigins &&
      repos.repository.integrityCheck().ok;
    if (!loadOk) {
      fail(
        `load check FAILED (branches ${String(stats.branches)}/${String(datasetA.totals.branchRows)}, ` +
          `turn ${String(stats.turnOrigins)}/${String(datasetA.totals.turnOrigins)}, ` +
          `material ${String(stats.materialOrigins)}/${String(datasetA.totals.materialOrigins)})`,
      );
    }
    log(
      `  load check: ${String(stats.branches)} branch rows into a real persistence DB in ${stats.elapsedMs.toFixed(0)}ms via repository APIs; sqlite integrity ok\n`,
    );
  } finally {
    repos.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

log("gen-b9-nav-dataset: OK\n");
process.exit(0);
