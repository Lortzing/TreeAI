#!/usr/bin/env node
/**
 * Read-only R6 evidence locator. It indexes tracked paths, not model transcripts
 * or raw screenshots. This is not an acceptance verdict or a deletion script.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MARKERS = new Set(["result.json", "summary.json", "checks.json", "manifest.json", "environment.json"]);
export function evidenceLocator(path) {
  const parts = path.split("/");
  if (parts[0] !== "evidence" || parts.length < 3) return null;
  const domain = parts[1];
  const stream = parts[2];
  if (!["d2","d3","d4","terminology"].includes(domain)) return null;
  // D2/D4: evidence/d*/runs/<runId>/...; D3: browser/<runId>/...
  const runId = parts.length >= 5 ? parts[3] : null;
  if (runId === null || runId === "README.md") return null;
  return { domain, stream, runId };
}
export function buildEvidenceIndex(paths, sha, readMarker) {
  const runs = new Map();
  for (const path of paths.slice().sort()) {
    const loc = evidenceLocator(path);
    if (loc === null) continue;
    const key = [loc.domain,loc.stream,loc.runId].join("/");
    const entry = runs.get(key) ?? {
      ...loc, files:0, markers:[], rawFiles:0,
    };
    entry.files += 1;
    const filename = path.slice(path.lastIndexOf("/") + 1);
    if (MARKERS.has(filename)) {
      const digest = createHash("sha256").update(readMarker(path)).digest("hex");
      entry.markers.push({path,sha256:digest});
    } else entry.rawFiles++;
    runs.set(key,entry);
  }
  return {
    schema:"treeai-evidence-locator-v1",
    sourceCommit:sha,
    note:"Repository paths and marker hashes only: no verdict, no private content, no deletion; same-SHA acceptance remains mandatory.",
    runs:[...runs.values()].sort((a,b)=>
      [a.domain,a.stream,a.runId].join("/").localeCompare([b.domain,b.stream,b.runId].join("/"))),
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv.length !== 0 && !(argv.length === 2 && argv[0] === "--out" && argv[1])) {
    console.error("Usage: node scripts/evidence-index.mjs [--out path.json]");
    process.exitCode=1;
  } else {
    const sha = execFileSync("git",["rev-parse","HEAD"],{cwd:ROOT,encoding:"utf8"}).trim();
    const paths = execFileSync("git",["ls-files","-z","--","evidence/"],{cwd:ROOT,encoding:"utf8"})
      .split("\\0").filter(Boolean);
    const index = buildEvidenceIndex(paths,sha,path=>readFileSync(resolve(ROOT,path)));
    const json=JSON.stringify(index,null,2)+"\\n";
    if(argv.length===2) writeFileSync(resolve(argv[1]),json);
    else process.stdout.write(json);
  }
}
