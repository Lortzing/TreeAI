#!/usr/bin/env node
/**
 * TreeAI D2 — workspace typecheck orchestrator (Gate 0 scaffold).
 *
 * Owner: Integrator (root tooling). NOT part of Agent F's scripts/verify-d2*.
 *
 * Behavior:
 *   - Discovers workspaces under packages/* and apps/*.
 *   - Runs `tsc -p <workspace>` for every workspace that has a tsconfig.json
 *     AND at least one TypeScript source file under src/.
 *   - Workspaces without sources are reported as SKIPPED with the reason.
 *     A skipped workspace is never counted as checked — this script does not
 *     fake coverage, and says so explicitly.
 *
 * Exit codes (aligned with the D2 task-book verifier convention):
 *   0 — every workspace WITH sources type-checked cleanly (at least one)
 *   1 — one or more tsc invocations failed, or the toolchain is missing
 *   3 — nothing to check yet (NOT_IMPLEMENTED / NOT_RUN semantics)
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE_ROOTS = ["packages", "apps"];

function listWorkspaceDirs() {
  const dirs = [];
  for (const segment of WORKSPACE_ROOTS) {
    const base = join(root, segment);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(base, entry.name);
      if (existsSync(join(dir, "package.json"))) dirs.push(dir);
    }
  }
  return dirs.sort();
}

function hasTypeScriptSources(dir) {
  const src = join(dir, "src");
  if (!existsSync(src)) return false;
  const stack = [src];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        stack.push(join(current, entry.name));
      } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
        return true;
      }
    }
  }
  return false;
}

function readPackageName(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return typeof pkg.name === "string" ? pkg.name : dir;
  } catch {
    return dir;
  }
}

const tscBin = join(root, "node_modules", "typescript", "bin", "tsc");
if (!existsSync(tscBin)) {
  console.error("[typecheck] typescript is not installed at the workspace root.");
  console.error("[typecheck] run `npm ci` first. Aborting.");
  process.exit(1);
}

const dirs = listWorkspaceDirs();
const checked = [];
const skipped = [];
const failures = [];

for (const dir of dirs) {
  const name = readPackageName(dir);
  const tsconfig = join(dir, "tsconfig.json");
  if (!existsSync(tsconfig)) {
    skipped.push([name, "no tsconfig.json"]);
    continue;
  }
  if (!hasTypeScriptSources(dir)) {
    skipped.push([name, "no TypeScript sources under src/ yet (awaiting module owner)"]);
    continue;
  }
  console.log(`[typecheck] checking ${name} (${relative(root, dir)})`);
  try {
    execFileSync(process.execPath, [tscBin, "-p", dir], { stdio: "inherit" });
    checked.push(name);
  } catch {
    failures.push(name);
  }
}

console.log("");
console.log("typecheck summary (Gate 0 scaffold):");
console.log(`  checked: ${checked.length === 0 ? "(none)" : checked.join(", ")}`);
for (const [name, reason] of skipped) {
  console.log(`  skipped: ${name} — ${reason}`);
}

if (failures.length > 0) {
  console.error(`[typecheck] FAIL: tsc failed for: ${failures.join(", ")}`);
  process.exit(1);
}
if (checked.length === 0) {
  console.log("[typecheck] no workspace has TypeScript sources yet — NOT_IMPLEMENTED (exit 3).");
  process.exit(3);
}
console.log(
  "[typecheck] all workspaces WITH sources passed. " +
    "Skipped workspaces have no sources yet and are NOT verified by this run.",
);
process.exit(0);
