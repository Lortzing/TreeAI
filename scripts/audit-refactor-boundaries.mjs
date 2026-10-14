#!/usr/bin/env node
/** Read-only R0/R2 comparison: literal imports, source sizes and static scenario names. */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, resolve, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const baseIndex = args.indexOf("--base");
const outIndex = args.indexOf("--out");
if (baseIndex < 0 || !args[baseIndex + 1] || args.length !== (outIndex < 0 ? 2 : 4) || (outIndex >= 0 && !args[outIndex + 1])) {
  console.error("Usage: node scripts/audit-refactor-boundaries.mjs --base <commit> [--out report.json]");
  process.exit(1);
}
const git = (...argv) => execFileSync("git", argv, { cwd: root, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
const base = git("rev-parse", "--verify", `${args[baseIndex + 1]}^{commit}`).trim();
const head = git("rev-parse", "HEAD").trim();
const scopes = ["apps", "packages", "scripts", "tests"];
const oldPaths = git("ls-tree", "-rz", "--name-only", base, "--", ...scopes).split("\0").filter(Boolean);
const currentPaths = [...new Set(git("ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...scopes).split("\0").filter(Boolean))].sort();
const source = (path) => /\.(?:ts|js|mjs|cjs)$/.test(path);
const isTest = (path) => /\.test\.(?:ts|js|mjs|cjs)$/.test(path);
const imports = new Map();
const currentCases = new Map();
const oldCases = new Map();
const errors = [];
function inspect(path, text, cases) {
  const ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const dependencies = new Set();
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      dependencies.add(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node)) {
      const first = node.arguments[0];
      if (first && ts.isStringLiteralLike(first)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(ast) === "require") dependencies.add(first.text);
        if (isTest(path) && /^(?:test|it)(?:\.(?:skip|todo|only))?$/.test(node.expression.getText(ast))) {
          const name = first.text;
          const previous = cases.get(name) ?? [];
          previous.push(path);
          cases.set(name, previous);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return dependencies;
}
for (const path of oldPaths.filter(isTest)) inspect(path, git("show", `${base}:${path}`), oldCases);
for (const path of currentPaths.filter(source)) {
  const absolute = resolve(root, path);
  if (!existsSync(absolute)) continue; // deleted working-tree file; scenario audit still detects lost cases
  imports.set(path, inspect(path, readFileSync(absolute, "utf8"), currentCases));
}
const reverseImports = {};
for (const [from, specs] of imports) {
  for (const spec of specs) {
    if (!spec.startsWith(".")) continue;
    const candidate = resolve(root, dirname(from), spec);
    const candidates = [candidate, ...[".ts", ".js", ".mjs", "/index.ts", "/index.js"].map((suffix) => candidate + suffix)];
    if (extname(candidate) === ".js") candidates.push(candidate.slice(0, -3) + ".ts");
    const target = candidates.find(existsSync);
    if (!target) { errors.push(`Unresolved literal import: ${from} -> ${spec}`); continue; }
    const to = relative(root, target);
    (reverseImports[to] ??= []).push(from);
    if (/^(?:apps\/[^/]+\/src|packages\/[^/]+\/src)\//.test(from) && /(?:^|\/)(?:tests|fixtures)\//.test(to)) {
      errors.push(`Production imports test/fixture: ${from} -> ${to}`);
    }
  }
}
for (const [name, paths] of oldCases) {
  const now = currentCases.get(name) ?? [];
  if (now.length < paths.length) errors.push(`Static scenario lost (${paths.length} -> ${now.length}): ${name}`);
}
const measured = ["apps/studio/public/app.js", "apps/studio/public/core/create-studio-app.js", "apps/studio/src/server.ts", "scripts/run-d4-browser.mjs"];
const sizes = measured.map((path) => {
  let before = null;
  if (oldPaths.includes(path)) before = git("show", `${base}:${path}`).split("\n").length;
  const after = existsSync(resolve(root, path)) ? readFileSync(resolve(root, path), "utf8").split("\n").length : null;
  return { path, beforeLines: before, afterLines: after };
});
const report = {
  schema: "treeai-refactor-boundaries-v1", baseCommit: base, headCommit: head,
  workingTree: true, sizes,
  staticScenarios: {
    before: [...oldCases.values()].reduce((n, paths) => n + paths.length, 0),
    after: [...currentCases.values()].reduce((n, paths) => n + paths.length, 0),
    preserved: !errors.some((error) => error.startsWith("Static scenario lost")),
  },
  reverseImports, errors,
  limitations: [
    "Literal source imports and static test/it names only; computed names, nested subtests and assertions require existing suites.",
    "This comparison does not prove behavioral parity or native/physical/human acceptance.",
    "HTTP ESM/CSS/installer inclusion is audited separately by audit-studio-assets; test entrypoints remain in package scripts and CI.",
    "Current paths include untracked source files; the working-tree report is not a clean-commit acceptance record.",
  ],
};
const json = JSON.stringify(report, null, 2) + "\n";
if (outIndex >= 0) writeFileSync(resolve(args[outIndex + 1]), json);
else process.stdout.write(json);
console.error(`${errors.length ? "FAIL" : "PASS"}: ${report.staticScenarios.before} baseline static scenarios / ${report.staticScenarios.after} current; ${errors.length} boundary violations`);
if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; }
