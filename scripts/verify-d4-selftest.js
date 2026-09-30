#!/usr/bin/env node
/**
 * verify-d4-selftest — failure-path selftest for scripts/verify-d4.js.
 *
 * Mirrors the verify-d2-selftest discipline (issue #8 §8: the selftest
 * proves that missing evidence, bad data and failures are never swallowed
 * into a green result):
 *
 *   - every scenario builds a synthetic tree in a temp dir and runs the
 *     REAL verifier via `node scripts/verify-d4.js --root … --only …`;
 *   - the control scenario must exit 0 (ALL_PASS) on a clean copy;
 *   - each injected defect must flip the scoped run to exit 2 (HAS_FAIL)
 *     with the intended check failing — a defect the verifier cannot see
 *     is a selftest failure (exit 2);
 *   - child run dirs are preserved as proof under
 *     evidence/d4/selftest/<utc-run-id>/child-runs/<scenario>/.
 *
 * Exit codes: 0 = all injections detected + control clean; 2 = a scenario
 * misbehaved; 1 = selftest error.
 */

import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { sha256File } from "../tests/support/verifier/secret-scanner.ts";
import { utcRunId } from "../tests/support/verifier/util.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPT_DIR, "..");
const VERIFIER = join(SCRIPT_DIR, "verify-d4.js");
const EVIDENCE_DIR = join(ROOT, "evidence", "d4", "selftest", utcRunId("d4-selftest"));

/** The scoped checks this selftest exercises (node_modules-free set). */
const ONLY_ARGS = [
  "--only", "fixtures-integrity-d4",
  "--only", "docs-integrity-d4",
  "--only", "entrypoints-d4",
];

function buildSyntheticTree(dest) {
  mkdirSync(dest, { recursive: true });
  cpSync(join(ROOT, "package.json"), join(dest, "package.json"));
  cpSync(join(ROOT, "scripts", "verify-d4.js"), join(dest, "scripts", "verify-d4.js"), { recursive: true, force: true });
  cpSync(join(ROOT, "scripts", "run-d4-browser.mjs"), join(dest, "scripts", "run-d4-browser.mjs"), { recursive: true, force: true });
  cpSync(join(ROOT, "tests"), join(dest, "tests"), { recursive: true });
  cpSync(join(ROOT, "docs", "d4"), join(dest, "docs", "d4"), { recursive: true });
  cpSync(
    join(ROOT, "docs", "adr", "ADR-003-d4-material-sources-versions-run-origins.md"),
    join(dest, "docs", "adr", "ADR-003-d4-material-sources-versions-run-origins.md"),
    { recursive: true, force: true },
  );
}

function runVerifier(root, runsRoot) {
  const res = spawnSync(process.execPath, [VERIFIER, "--root", root, "--runs-root", runsRoot, ...ONLY_ARGS], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 300_000,
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function regenerateManifest(root) {
  const d4 = join(root, "tests", "fixtures", "d4");
  const files = [];
  const walk = (rel) => {
    for (const name of readdirSync(join(d4, rel))) {
      const relPath = rel === "" ? name : `${rel}/${name}`;
      if (statSync(join(d4, relPath)).isDirectory()) walk(relPath);
      else if (relPath !== "MANIFEST.sha256") files.push(relPath);
    }
  };
  walk("");
  files.sort();
  const lines = files.map((f) => `${sha256File(join(d4, f))}  ${f}`);
  writeFileSync(join(d4, "MANIFEST.sha256"), `${lines.join("\n")}\n`, "utf8");
}

function readModifyWrite(path, mutate) {
  const doc = JSON.parse(readFileSync(path, "utf8"));
  mutate(doc);
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
}

/** @typedef {{id: string, inject: (root: string) => void,
 *             expectCheck: string, expectNeedle: string}} Scenario */

const SCENARIOS = [
  {
    id: "control-clean-tree",
    inject: () => {},
    expectCheck: null,
    expectNeedle: null,
  },
  {
    id: "inject-tampered-fixture",
    inject: (root) => {
      const target = join(root, "tests", "fixtures", "d4", "b1-import", "markdown", "md-01.md");
      writeFileSync(target, "TAMPERED CONTENT\n", "utf8");
    },
    expectCheck: "fixtures-integrity-d4",
    expectNeedle: "hash mismatch",
  },
  {
    id: "inject-stray-fixture",
    inject: (root) => {
      writeFileSync(
        join(root, "tests", "fixtures", "d4", "b1-import", "markdown", "stray.md"),
        "not in the manifest\n",
        "utf8",
      );
    },
    expectCheck: "fixtures-integrity-d4",
    expectNeedle: "diverged",
  },
  {
    id: "inject-broken-selection-behind-regenerated-manifest",
    inject: (root) => {
      const path = join(root, "tests", "fixtures", "d4", "b2-anchors", "markdown-selections.json");
      readModifyWrite(path, (doc) => {
        doc.items[0].expected.start += 1;
      });
      regenerateManifest(root);
    },
    expectCheck: "fixtures-integrity-d4",
    expectNeedle: "locator resolves to",
  },
  {
    id: "inject-fake-no-result-query",
    inject: (root) => {
      const path = join(root, "tests", "fixtures", "d4", "b4-search", "queries.json");
      readModifyWrite(path, (doc) => {
        doc.noResult[0].text = doc.positive[0].text;
      });
      regenerateManifest(root);
    },
    expectCheck: "fixtures-integrity-d4",
    expectNeedle: "actually present",
  },
  {
    id: "inject-missing-mirror",
    inject: (root) => {
      rmSync(join(root, "docs", "d4", "D4-project-v1.md"), { force: true });
    },
    expectCheck: "docs-integrity-d4",
    expectNeedle: "D4-project-v1.md",
  },
  {
    id: "inject-unwired-entrypoint",
    inject: (root) => {
      readModifyWrite(join(root, "package.json"), (pkg) => {
        delete pkg.scripts["verify:d4"];
      });
    },
    expectCheck: "entrypoints-d4",
    expectNeedle: "verify:d4",
  },
];

function main() {
  console.log("verify-d4-selftest — failure-path injections against the real verifier");
  console.log(`evidence: ${EVIDENCE_DIR}`);
  let failures = 0;

  for (const scenario of SCENARIOS) {
    const workDir = mkdtempSync(join(tmpdir(), "treeai-d4-selftest."));
    try {
      const root = join(workDir, "tree");
      buildSyntheticTree(root);
      scenario.inject(root);
      const childRuns = join(EVIDENCE_DIR, "child-runs", scenario.id);
      mkdirSync(childRuns, { recursive: true });
      const run = runVerifier(root, childRuns);

      if (scenario.expectCheck === null) {
        if (run.status !== 0) {
          console.log(`  [FAIL] ${scenario.id}: control scenario exited ${String(run.status)} (expected 0)`);
          console.log(run.stdout.split("\n").slice(0, 12).join("\n"));
          failures += 1;
        } else {
          console.log(`  [PASS] ${scenario.id}: clean copy → exit 0 (ALL_PASS)`);
        }
        continue;
      }

      const sawCheckFail = run.stdout.includes(`[FAIL] ${scenario.expectCheck}`);
      const sawNeedle = run.stdout.includes(scenario.expectNeedle) || run.stdout.includes(scenario.expectNeedle.slice(0, 40));
      if (run.status !== 2 || !sawCheckFail || !sawNeedle) {
        console.log(
          `  [FAIL] ${scenario.id}: verifier exited ${String(run.status)}; ` +
            `check-fail seen: ${String(sawCheckFail)}; needle "${scenario.expectNeedle}" seen: ${String(sawNeedle)}`,
        );
        console.log(run.stdout.split("\n").slice(0, 14).join("\n"));
        failures += 1;
      } else {
        console.log(`  [PASS] ${scenario.id}: ${scenario.expectCheck} FAIL with exit 2`);
      }
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }

  console.log("");
  if (failures > 0) {
    console.log(`verify-d4-selftest: ${String(failures)} scenario(s) misbehaved (exit 2)`);
    process.exit(2);
  }
  console.log("verify-d4-selftest: all injections detected; control clean (exit 0)");
  process.exit(0);
}

main();
