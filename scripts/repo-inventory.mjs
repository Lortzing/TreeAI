#!/usr/bin/env node
/**
 * Repository-owned, deterministic baseline inventory. Run in a clean checkout.
 * Output is intentionally untracked (stdout or --out); no evidence is deleted.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";

const argv = process.argv.slice(2);
const outIndex = argv.indexOf("--out");
if (outIndex >= 0 && (!argv[outIndex + 1] || outIndex + 2 !== argv.length)) {
  console.error("Usage: node scripts/repo-inventory.mjs [--out path.json]");
  process.exit(1);
}
if (outIndex < 0 && argv.length) {
  console.error("Usage: node scripts/repo-inventory.mjs [--out path.json]");
  process.exit(1);
}
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const paths = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean).sort();
const textExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx", ".css", ".html", ".md", ".sh", ".py", ".swift", ".json", ".yml", ".yaml"]);
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx", ".css", ".html", ".sh", ".py", ".swift"]);
const exceptionExtensions = new Set([".pdf", ".jsonl", ".lock"]);
const category = (p) => p.split("/")[0] || "(root)";
const files = [];
for (const path of paths) {
  const absolute = resolve(root, path);
  const stats = statSync(absolute);
  if (!stats.isFile()) continue;
  const ext = extname(path).toLowerCase();
  const exception = path === "package-lock.json" || exceptionExtensions.has(ext) ||
    path.startsWith("evidence/") || path.startsWith("d1-spikes/evidence/") ||
    path.includes("/fixtures/") || path.includes("/generated/");
  const isText = textExtensions.has(ext) || ["LICENSE", "AGENTS.md", "README.md"].includes(path);
  const content = isText ? readFileSync(absolute, "utf8") : null;
  const lineCount = content === null ? null : (content.length ? content.split("\n").length : 0);
  const maxLineLength = content === null ? null : Math.max(0, ...content.split("\n").map((line) => line.length));
  const importSpecifiers = content !== null && sourceExtensions.has(ext)
    ? [...content.matchAll(/(?:from\s*|import\s*\(|import\s*|require\s*\()\s*["']([^"']+)["']/g)].map((m) => m[1])
    : [];
  files.push({
    path, category: category(path), bytes: stats.size, lines: lineCount, maxLineLength,
    imports: [...new Set(importSpecifiers)].sort(),
    exception,
    review: !exception && (
      (sourceExtensions.has(ext) && (stats.size > 32768 || lineCount > 800)) ||
      (ext === ".md" && (stats.size > 12288 || maxLineLength > 500))
    ),
    priority: !exception && sourceExtensions.has(ext) && lineCount > 1200 ? "high" : null,
  });
}
const byPath = new Map(files.map((file) => [file.path, file]));
for (const file of files) file.referencedBy = [];
for (const from of files) {
  for (const specifier of from.imports) {
    if (!specifier.startsWith(".")) continue;
    const base = resolve(root, dirname(from.path), specifier);
    for (const suffix of ["", ".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.js"]) {
      const target = base + suffix;
      const rel = target.startsWith(root + "/") ? target.slice(root.length + 1) : "";
      if (byPath.has(rel)) {
        byPath.get(rel).referencedBy.push(from.path);
        break;
      }
    }
  }
}
for (const file of files) file.referencedBy.sort();
const totals = {};
for (const file of files) {
  const stats = totals[file.category] ??= { files: 0, bytes: 0, review: 0 };
  stats.files++;
  stats.bytes += file.bytes;
  if (file.review) stats.review++;
}
const report = {
  schema: "treeai-repo-inventory-v1",
  sha: head,
  limitations: [
    "Import graph is static/best-effort and omits non-literal dynamic paths, CSS urls, HTTP routes, CLI and installer references.",
    "Line counts are UTF-8 physical lines, not executable statements.",
    "High-size fixtures, evidence, lockfiles, generated assets and PDFs are exempt from automatic code-splitting advice.",
    "Git tracked checkout must be complete; run only after npm/git commands have been audited for missing referenced paths."
  ],
  totals,
  files,
};
const json = JSON.stringify(report, null, 2) + "\n";
if (outIndex >= 0) {
  const destination = resolve(process.cwd(), argv[outIndex + 1]);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, json);
  console.error(`Inventory written: ${destination} (${files.length} files, SHA ${head})`);
} else {
  process.stdout.write(json);
}
