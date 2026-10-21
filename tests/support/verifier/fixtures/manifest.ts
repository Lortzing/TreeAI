import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256File } from '../secret-scanner.ts';
import { type D4FixturesStats, readJson, asRecord, asArray, listFilesRecursive } from './truth.ts';

type Stats = { -readonly [K in keyof D4FixturesStats]: D4FixturesStats[K] };

export function verifyManifest(d4Root: string, problems: string[], stats: Stats) {
  // 1. hash manifest ------------------------------------------------------
  const manifestPath = join(d4Root, "MANIFEST.sha256");
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
    const filesOnDisk = listFilesRecursive(d4Root).filter((f) => f !== "MANIFEST.sha256");
    stats.hashedFiles = filesOnDisk.length;
    const manifestKeys = [...entries.keys()].sort();
    if (JSON.stringify(manifestKeys) !== JSON.stringify(filesOnDisk)) {
      problems.push("MANIFEST.sha256 and the D4 fixture tree diverged (added/removed/renamed file)");
    }
    for (const [rel, expectedHash] of entries) {
      try {
        if (sha256File(join(d4Root, rel)) !== expectedHash) {
          problems.push(`fixture ${rel} hash mismatch (tampered)`);
        }
      } catch {
        problems.push(`fixture ${rel} listed in manifest but unreadable`);
      }
    }
  } catch {
    problems.push("MANIFEST.sha256 missing or unreadable");
  }

  // 2. assembled top manifest ---------------------------------------------
  const topManifest = asRecord(
    readJson(join(d4Root, "manifest.json"), problems, "d4 manifest.json"),
  );
  if (topManifest !== null) {
    if (topManifest["version"] !== 1) problems.push("d4 manifest.json: version must be 1");
    if (typeof topManifest["frozenAt"] !== "string") {
      problems.push("d4 manifest.json: frozenAt missing");
    }
    const sets = asRecord(topManifest["sets"]);
    if (sets === null) {
      problems.push("d4 manifest.json: sets object missing");
    } else {
      const b1 = asRecord(sets["b1-import"]);
      if (b1 === null) {
        problems.push("d4 manifest.json: sets.b1-import missing");
      } else {
        const oversize = asArray(b1["generatedOversize"]);
        if (oversize === null || oversize.length < 3) {
          problems.push("d4 manifest.json: sets.b1-import.generatedOversize must document ≥3 probes");
        }
      }
      for (const key of ["b2-anchors", "b4-search", "b6-scale", "b9-nav"]) {
        if (sets[key] === undefined) {
          problems.push(`d4 manifest.json: sets.${key} missing`);
        }
      }
    }
  }

}
