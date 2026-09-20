/**
 * Static tests: dependency pinning, lockfile sync, and forbidden-pattern
 * checks (no RuntimeAdapter, no TreeAI domain model, no SQLite, no
 * unpinned version ranges, no fake-mode writes to the shared evidence dir).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { D1_SPIKES_DIR, SDK_NODE_DIR } from "../src/paths.js";

const packageJson = JSON.parse(
  readFileSync(join(SDK_NODE_DIR, "package.json"), "utf8"),
) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: Record<string, string>;
};

const lockFile = JSON.parse(
  readFileSync(join(SDK_NODE_DIR, "package-lock.json"), "utf8"),
) as {
  lockfileVersion: number;
  packages?: Record<string, { version?: string; resolved?: string }>;
  dependencies?: Record<string, unknown>;
};

test("lockfile exists and was committed alongside package.json", () => {
  assert.ok(existsSync(join(SDK_NODE_DIR, "package-lock.json")));
  assert.ok(lockFile.lockfileVersion >= 2);
});

test("every dependency is pinned to an exact version (no latest, *, ^, ~)", () => {
  const ranges = { ...packageJson.dependencies, ...packageJson.devDependencies };
  const entries = Object.entries(ranges);
  assert.ok(entries.length >= 4, "expected the pi package plus dev deps");
  for (const [name, range] of entries) {
    assert.match(
      range,
      /^\d+\.\d+\.\d+$/,
      `${name} must be an exact version, got "${range}"`,
    );
  }
  assert.equal(packageJson.dependencies!["@earendil-works/pi-coding-agent"], "0.85.1");
});

test("lockfile agrees with package.json pins for direct dependencies", () => {
  const root = lockFile.packages?.[""];
  assert.ok(root, "lockfile has a root package entry");
  const locked = {
    ...(root as { dependencies?: Record<string, string> }).dependencies,
    ...(root as { devDependencies?: Record<string, string> }).devDependencies,
  };
  const declared = { ...packageJson.dependencies, ...packageJson.devDependencies };
  for (const [name, range] of Object.entries(declared)) {
    assert.equal(locked[name], range, `lockfile range for ${name} diverged from package.json`);
  }
  const piLocked = lockFile.packages?.["node_modules/@earendil-works/pi-coding-agent"]?.version;
  assert.equal(piLocked, "0.85.1", "locked pi-coding-agent version");
});

test("engines pins a Node major matching the recorded environment", () => {
  assert.match(packageJson.engines!.node!, /^>=\d+\.\d+\.\d+ <\d+$/);
});

test("no forbidden production dependencies (sqlite, ORM, web frameworks)", () => {
  const deps = Object.keys(packageJson.dependencies ?? {});
  for (const dep of deps) {
    assert.ok(!/sqlite|prisma|typeorm|drizzle|knex|express|fastify|next|react|vue/i.test(dep), `forbidden dep: ${dep}`);
  }
  // The only runtime dependency is the Pi SDK itself.
  assert.deepEqual(deps, ["@earendil-works/pi-coding-agent"]);
});

test("src contains no RuntimeAdapter, TreeAI domain models, or SQLite usage", () => {
  // Declaration-shaped patterns only: comments and prose may NAME these
  // concepts (e.g. "this spike implements no RuntimeAdapter"), but no src
  // file may declare, extend, implement, or type-annotate with them.
  const forbidden = [
    /class\s+RuntimeAdapter/,
    /interface\s+RuntimeAdapter/,
    /extends\s+RuntimeAdapter/,
    /implements\s+RuntimeAdapter/,
    /:\s*RuntimeAdapter\b/,
    /class\s+(Forest|Tree|Branch|Episode|Run)\b/,
    /interface\s+(Forest|Tree|Branch|Episode|Run)\b/,
    /extends\s+(Forest|Tree|Branch|Episode|Run)\b/,
    /implements\s+(Forest|Tree|Branch|Episode|Run)\b/,
    /:\s*(Forest|Tree|Branch|Episode|Run)\b/,
    /from\s+["'](better-sqlite3|sqlite3|node:sqlite)["']/,
    /require\(["'](better-sqlite3|sqlite3|node:sqlite)["']\)/,
  ];
  const srcFiles = listTsFiles(join(SDK_NODE_DIR, "src"));
  assert.ok(srcFiles.length >= 15, "expected the spike sources to be present");
  for (const file of srcFiles) {
    const text = readFileSync(file, "utf8");
    for (const re of forbidden) {
      assert.ok(
        !re.test(text),
        `${file} matches forbidden pattern ${re} (production concepts must not leak into the spike)`,
      );
    }
  }
});

test("tests never write into the shared evidence directory", () => {
  // Built via concatenation so this file's own source does not contain the
  // literal call it forbids.
  const sharedEvidenceCall = new RegExp("defaultEvidence" + "Dir\\s*\\(\\)");
  const testFiles = listTsFiles(join(SDK_NODE_DIR, "tests"));
  for (const file of testFiles) {
    const text = readFileSync(file, "utf8");
    assert.ok(
      !text.includes("evidence/sdk") || text.includes("never to d1-spikes/evidence"),
      `${file} must not target the shared evidence dir`,
    );
    assert.ok(!sharedEvidenceCall.test(text), `${file} must not call the default evidence dir helper`);
  }
});

test("real entry points never import the fake session (no fake results in real probes)", () => {
  for (const entry of ["run.ts", "tree-nav-run.ts"]) {
    const text = readFileSync(join(SDK_NODE_DIR, "src", entry), "utf8");
    assert.ok(!text.includes("fake-session"), `${entry} must not import the fake session`);
  }
});

test("tree-nav stays separate from the five unified scenarios", () => {
  const pkg = JSON.parse(readFileSync(join(SDK_NODE_DIR, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  // probe:all drives src/run.ts with the five-name SCENARIOS list only.
  assert.equal(pkg.scripts!["probe:all"]!.endsWith("src/run.ts all"), true);
  assert.equal(pkg.scripts!["probe:tree-nav"]!.endsWith("src/tree-nav-run.ts"), true);
  // The five-scenario entry never mentions tree-nav.
  const runTs = readFileSync(join(SDK_NODE_DIR, "src", "run.ts"), "utf8");
  assert.equal(runTs.includes("tree-nav"), false);
  // Evidence separation: the tree-nav entry writes under a dedicated
  // tree-nav/ subtree, never directly into the five-scenario runs/ root.
  const treeNavRun = readFileSync(join(SDK_NODE_DIR, "src", "tree-nav-run.ts"), "utf8");
  assert.ok(treeNavRun.includes('join(evidenceDir, "tree-nav", "runs"'));
  assert.ok(!treeNavRun.includes('evidenceDir, "runs"'));
});

test("README.md exists and documents install, all five probes, tree-nav, and limitations", () => {
  const readme = readFileSync(join(SDK_NODE_DIR, "README.md"), "utf8");
  for (const section of [
    "npm ci",
    "probe:basic",
    "probe:tool",
    "probe:steer",
    "probe:abort",
    "probe:resume",
    "probe:tree-nav",
    "probe:all",
    "PENDING_OWNER",
    "BLOCKED",
  ]) {
    assert.ok(readme.includes(section), `README must mention ${section}`);
  }
});

test("local fallback fixture matches the canonical values and stays aligned with the shared fixture", () => {
  const fixture = JSON.parse(
    readFileSync(join(SDK_NODE_DIR, "fixtures-local", "numbers.json"), "utf8"),
  ) as { values: number[] };
  // Canonical content: the 16 digits of pi (d1-spikes/fixtures/numbers.json).
  assert.deepEqual(fixture.values, [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5, 8, 9, 7, 9, 3]);
  // Aggregates the tool scenario expects (src/prompts.ts constants).
  const sorted = [...fixture.values].sort((a, b) => a - b);
  assert.equal(fixture.values.length, 16);
  assert.equal(fixture.values.reduce((sum, v) => sum + v, 0), 80);
  assert.equal(sorted[0], 1);
  assert.equal(sorted[sorted.length - 1], 9);
  assert.equal((sorted[7]! + sorted[8]!) / 2, 5);
  // When Agent D's shared fixture is delivered, the fallback must not drift
  // from it (values are the load-bearing contract; descriptions may differ).
  const sharedPath = join(D1_SPIKES_DIR, "fixtures", "numbers.json");
  if (existsSync(sharedPath)) {
    const shared = JSON.parse(readFileSync(sharedPath, "utf8")) as { values: number[] };
    assert.deepEqual(
      fixture.values,
      shared.values,
      "fixtures-local/numbers.json drifted from the shared fixture; realign it and src/prompts.ts",
    );
  }
});

test("local fallback schemas mirror the task-book required fields", () => {
  const eventSchema = JSON.parse(
    readFileSync(join(SDK_NODE_DIR, "schemas-local", "evidence-event.schema.json"), "utf8"),
  ) as { required: string[] };
  assert.deepEqual(eventSchema.required.sort(), [
    "implementation",
    "observedAt",
    "payload",
    "piEventType",
    "redactionVersion",
    "runState",
    "scenario",
    "seq",
    "sessionId",
  ]);
  const resultSchema = JSON.parse(
    readFileSync(join(SDK_NODE_DIR, "schemas-local", "scenario-result.schema.json"), "utf8"),
  ) as { required: string[] };
  assert.ok(resultSchema.required.includes("evidenceFiles"));
  assert.ok(resultSchema.required.includes("error"));
});

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(p));
    else if (entry.name.endsWith(".ts")) out.push(p);
  }
  return out;
}
