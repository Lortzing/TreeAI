/**
 * Fixtures integrity + schema-probe corpus test.
 *
 * The heavy lifting lives in tests/support/verifier/probes.ts
 * (verifyFixturesIntegrity) so scripts/verify-d2.js and the failure-path
 * selftest exercise the EXACT same gate logic as this test. Here we assert
 * it is green on the real tree and prove it detects tampering on copies.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyFixturesIntegrity } from "../support/verifier/probes.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "fixtures");
const SCHEMAS = join(HERE, "..", "..", "schemas", "d2");

test("the real fixture tree is fully consistent (hashes, manifest, probes)", () => {
  const result = verifyFixturesIntegrity(FIXTURES, SCHEMAS);
  assert.deepEqual(
    result.problems,
    [],
    `fixture tree inconsistent: ${result.problems.join("; ")}`,
  );
  assert.ok(result.hashedFiles >= 25, `expected the full corpus hashed, got ${result.hashedFiles}`);
  assert.ok(result.validProbes >= 9, `valid probes: ${result.validProbes}`);
  assert.ok(result.invalidProbes >= 14, `invalid probes: ${result.invalidProbes}`);
});

test("tampered fixture content is detected (hash mismatch)", () => {
  const dir = mkdtempSync(join(tmpdir(), "treeai-probe-tamper."));
  try {
    cpSync(FIXTURES, join(dir, "fixtures"), { recursive: true });
    const target = join(dir, "fixtures", "e2e", "readonly", "branch-a.txt");
    writeFileSync(target, "TAMPERED CONTENT\n", "utf8");
    const result = verifyFixturesIntegrity(join(dir, "fixtures"), SCHEMAS);
    assert.ok(
      result.problems.some((p) => p.includes("branch-a.txt") && p.includes("hash mismatch")),
      `expected tamper detection, got: ${result.problems.join("; ")}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("injected stray fixture file is detected (manifest divergence)", () => {
  const dir = mkdtempSync(join(tmpdir(), "treeai-probe-stray."));
  try {
    cpSync(FIXTURES, join(dir, "fixtures"), { recursive: true });
    writeFileSync(
      join(dir, "fixtures", "e2e", "readonly", "stray.txt"),
      "not in the manifest\n",
      "utf8",
    );
    const result = verifyFixturesIntegrity(join(dir, "fixtures"), SCHEMAS);
    assert.ok(
      result.problems.some((p) => p.includes("diverged")),
      `expected divergence detection, got: ${result.problems.join("; ")}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an invalid probe relabeled valid is detected (constraint-loss detection)", () => {
  const dir = mkdtempSync(join(tmpdir(), "treeai-probe-relabel."));
  try {
    cpSync(FIXTURES, join(dir, "fixtures"), { recursive: true });
    const manifestPath = join(dir, "fixtures", "schema-probes", "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      probes: Record<string, string>;
    };
    // Relabel a probe that MUST be rejected (non-UTC timestamp) as valid.
    manifest.probes["event/invalid/non-utc-timestamp.json"] = "valid";
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const result = verifyFixturesIntegrity(join(dir, "fixtures"), SCHEMAS);
    assert.ok(
      result.problems.some((p) => p.includes("non-utc-timestamp") && p.includes("rejected")),
      `expected rejection detection, got: ${result.problems.join("; ")}`,
    );
    // NOTE: the hash mismatch for manifest.json is ALSO expected (we modified
    // it) — both findings together are the honest result.
    assert.ok(result.problems.some((p) => p.includes("manifest.json")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("schemas themselves are valid JSON with required basics", () => {
  for (const name of ["event.schema.json", "result.schema.json", "environment.schema.json"]) {
    const schema = JSON.parse(readFileSync(join(SCHEMAS, name), "utf8")) as Record<string, unknown>;
    assert.equal(typeof schema["type"], "string");
    assert.ok(Array.isArray(schema["required"]));
    assert.equal(schema["$schema"], "https://json-schema.org/draft/2020-12/schema");
  }
});
