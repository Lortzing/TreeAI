/**
 * D4 fixtures integrity test (frozen B1/B2/B4/B6/B9 sets).
 *
 * The heavy lifting lives in tests/support/verifier/d4-probes.ts
 * (verifyD4FixturesIntegrity) so scripts/verify-d4.js and the failure-path
 * selftest exercise the EXACT same gate logic as this test. Here we assert
 * it is green on the real tree and prove it detects tampering on copies —
 * including tampering hidden behind a regenerated hash manifest.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyD4FixturesIntegrity } from "../support/verifier/d4-probes.ts";
import { sha256File } from "../support/verifier/secret-scanner.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const D4_ROOT = join(HERE, "..", "fixtures", "d4");

function listFiles(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(root, rel))) {
    const relPath = rel === "" ? name : `${rel}/${name}`;
    if (statSync(join(root, relPath)).isDirectory()) {
      out.push(...listFiles(root, relPath));
    } else {
      out.push(relPath);
    }
  }
  return out.sort();
}

/** Re-pins MANIFEST.sha256 for a temp copy — hides hash tampering, so only
 *  the semantic checks (locator resolution, truth consistency) can catch it. */
function regenerateManifest(root: string): void {
  const files = listFiles(root).filter((f) => f !== "MANIFEST.sha256");
  const lines = files.map((f) => `${sha256File(join(root, f))}  ${f}`);
  writeFileSync(join(root, "MANIFEST.sha256"), `${lines.join("\n")}\n`, "utf8");
}

test("the real D4 fixture tree is fully consistent (hashes, truth, selections, queries)", () => {
  const result = verifyD4FixturesIntegrity(D4_ROOT);
  assert.deepEqual(
    result.problems,
    [],
    `D4 fixture tree inconsistent: ${result.problems.join("; ")}`,
  );
  const s = result.stats;
  assert.ok(s.mdFixtures >= 12, `markdown fixtures: ${s.mdFixtures}`);
  assert.ok(s.pdfFixtures >= 12, `pdf fixtures: ${s.pdfFixtures}`);
  assert.ok(s.negativeFixtures >= 8, `negative fixtures: ${s.negativeFixtures}`);
  assert.ok(s.validSelections >= 60, `valid selections: ${s.validSelections}`);
  assert.ok(s.invalidSelections >= 12, `invalid selections: ${s.invalidSelections}`);
  assert.ok(s.positiveQueries >= 40, `positive queries: ${s.positiveQueries}`);
  assert.ok(s.noResultQueries >= 10, `no-result queries: ${s.noResultQueries}`);
});

test("tampered fixture content is detected (hash mismatch)", () => {
  const dir = mkdtempSync(join(tmpdir(), "treeai-d4-tamper."));
  try {
    cpSync(D4_ROOT, join(dir, "d4"), { recursive: true });
    const target = join(dir, "d4", "b1-import", "markdown", "md-01.md");
    writeFileSync(target, "TAMPERED CONTENT\n", "utf8");
    const result = verifyD4FixturesIntegrity(join(dir, "d4"));
    assert.ok(
      result.problems.some((p) => p.includes("md-01.md") && p.includes("hash mismatch")),
      `expected tamper detection, got: ${result.problems.join("; ")}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("injected stray fixture file is detected (manifest divergence)", () => {
  const dir = mkdtempSync(join(tmpdir(), "treeai-d4-stray."));
  try {
    cpSync(D4_ROOT, join(dir, "d4"), { recursive: true });
    writeFileSync(
      join(dir, "d4", "b1-import", "markdown", "stray.md"),
      "not in the manifest\n",
      "utf8",
    );
    const result = verifyD4FixturesIntegrity(join(dir, "d4"));
    assert.ok(
      result.problems.some((p) => p.includes("diverged")),
      `expected divergence detection, got: ${result.problems.join("; ")}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a selection with a wrong offset is detected even behind a regenerated manifest", () => {
  const dir = mkdtempSync(join(tmpdir(), "treeai-d4-sel."));
  try {
    cpSync(D4_ROOT, join(dir, "d4"), { recursive: true });
    const path = join(dir, "d4", "b2-anchors", "markdown-selections.json");
    const doc = JSON.parse(readFileSync(path, "utf8")) as { items: Array<{ expected: { start: number } }> };
    doc.items[0]!.expected.start += 1;
    writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
    regenerateManifest(join(dir, "d4"));
    const result = verifyD4FixturesIntegrity(join(dir, "d4"));
    assert.ok(
      result.problems.some((p) => p.includes("locator resolves to") || p.includes("excerpt")),
      `expected offset-defect detection, got: ${result.problems.join("; ")}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a no-result query whose text actually exists is detected", () => {
  const dir = mkdtempSync(join(tmpdir(), "treeai-d4-nr."));
  try {
    cpSync(D4_ROOT, join(dir, "d4"), { recursive: true });
    const path = join(dir, "d4", "b4-search", "queries.json");
    const doc = JSON.parse(readFileSync(path, "utf8")) as {
      positive: Array<{ text: string }>;
      noResult: Array<{ id: string; text: string }>;
    };
    const stolen = doc.positive[0]!.text;
    doc.noResult[0]!.text = stolen;
    writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
    regenerateManifest(join(dir, "d4"));
    const result = verifyD4FixturesIntegrity(join(dir, "d4"));
    assert.ok(
      result.problems.some((p) => p.includes("noResult") && p.includes("actually present")),
      `expected fake no-result detection, got: ${result.problems.join("; ")}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
