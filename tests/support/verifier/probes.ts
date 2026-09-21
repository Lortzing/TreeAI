/**
 * Shared fixtures-integrity + schema-probe-corpus verification (Agent F).
 *
 * Used by THREE consumers so the gate cannot drift between them:
 *   - tests/unit/fixtures-integrity.test.ts (granular assertions)
 *   - scripts/verify-d2.js  (check `fixtures-integrity`)
 *   - scripts/verify-d2-selftest.js (injects defects and asserts this FAILS)
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { sha256File } from "./secret-scanner.ts";
import { validateJsonSchema } from "./schema-validator.ts";

export interface ProbeCorpusResult {
  /** Empty = fully consistent. Any entry = the gate must FAIL. */
  readonly problems: string[];
  readonly validProbes: number;
  readonly invalidProbes: number;
  readonly hashedFiles: number;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function listFilesRecursive(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(root, rel))) {
    const relPath = rel === "" ? name : `${rel}/${name}`;
    if (statSync(join(root, relPath)).isDirectory()) {
      out.push(...listFilesRecursive(root, relPath));
    } else {
      out.push(relPath);
    }
  }
  return out.sort();
}

/**
 * Full integrity pass over a fixtures tree (default: the repo's
 * tests/fixtures) against a schemas dir (default: schemas/d2):
 *   1. MANIFEST.sha256 covers every fixture file except itself, and every
 *      hash matches (tamper detection);
 *   2. manifest.json probe expectations match the probe files on disk;
 *   3. every "valid" probe validates against its schema;
 *   4. every "invalid" probe is REJECTED (a lost constraint is a problem).
 */
export function verifyFixturesIntegrity(
  fixturesRoot: string,
  schemasRoot: string,
): ProbeCorpusResult {
  const problems: string[] = [];

  // --- 1. hash manifest ------------------------------------------------
  const manifestPath = join(fixturesRoot, "MANIFEST.sha256");
  let hashedFiles = 0;
  try {
    const entries = new Map<string, string>();
    for (const line of readFileSync(manifestPath, "utf8").split("\n")) {
      if (line.trim().length === 0) continue;
      const m = /^([0-9a-f]{64})  (.+)$/.exec(line);
      if (m === null) {
        problems.push(`malformed MANIFEST.sha256 line: ${line.slice(0, 80)}`);
        continue;
      }
      entries.set(m[2]!, m[1]!);
    }
    const filesOnDisk = listFilesRecursive(fixturesRoot).filter(
      (f) => f !== "MANIFEST.sha256",
    );
    hashedFiles = filesOnDisk.length;
    const manifestKeys = [...entries.keys()].sort();
    if (JSON.stringify(manifestKeys) !== JSON.stringify(filesOnDisk)) {
      problems.push(
        "MANIFEST.sha256 and the fixture tree diverged (added/removed/renamed file)",
      );
    }
    for (const [rel, expectedHash] of entries) {
      try {
        if (sha256File(join(fixturesRoot, rel)) !== expectedHash) {
          problems.push(`fixture ${rel} hash mismatch (tampered)`);
        }
      } catch {
        problems.push(`fixture ${rel} listed in manifest but unreadable`);
      }
    }
  } catch {
    problems.push("MANIFEST.sha256 missing or unreadable");
  }

  // --- 2..4. probe corpus ----------------------------------------------
  const probesRoot = join(fixturesRoot, "schema-probes");
  let manifest: { probes?: Record<string, string> } = {};
  try {
    manifest = readJson(join(probesRoot, "manifest.json")) as typeof manifest;
  } catch {
    problems.push("schema-probes/manifest.json missing or unreadable");
  }

  const schemas: Record<string, unknown> = {};
  for (const family of ["event", "result", "environment"]) {
    try {
      schemas[family] = readJson(join(schemasRoot, `${family}.schema.json`));
    } catch {
      problems.push(`schema ${family}.schema.json missing or unreadable`);
    }
  }

  let probeFiles: string[] = [];
  try {
    probeFiles = listFilesRecursive(probesRoot).filter(
      (f) => f.endsWith(".json") && f !== "manifest.json",
    );
  } catch {
    problems.push("schema-probes directory missing");
  }

  const expectations = manifest.probes ?? {};
  const expectationKeys = Object.keys(expectations).sort();
  if (JSON.stringify(expectationKeys) !== JSON.stringify(probeFiles)) {
    problems.push("manifest.json probe entries and probe files diverged");
  }

  let validProbes = 0;
  let invalidProbes = 0;
  for (const [file, expectation] of Object.entries(expectations)) {
    if (expectation !== "valid" && expectation !== "invalid") {
      problems.push(`bad expectation for ${file}: ${String(expectation)}`);
      continue;
    }
    const family = file.split("/")[0]!;
    const schema = schemas[family];
    if (schema === undefined) continue;
    let instance: unknown;
    try {
      instance = readJson(join(probesRoot, file));
    } catch {
      problems.push(`probe ${file} is not valid JSON`);
      continue;
    }
    const res = validateJsonSchema(instance, schema);
    if (expectation === "valid") {
      validProbes++;
      if (!res.valid) {
        problems.push(
          `valid probe ${file} was rejected: ${res.errors.map((e) => e.message).join("; ")}`,
        );
      }
    } else {
      invalidProbes++;
      if (res.valid) {
        problems.push(
          `invalid probe ${file} validated — a schema constraint was lost (or the validator is broken)`,
        );
      }
    }
  }

  return { problems, validProbes, invalidProbes, hashedFiles };
}
