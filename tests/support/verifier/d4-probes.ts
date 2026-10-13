/** Frozen integrity coordinator: hash → registries → selections → search → scale → scanner. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanText } from './secret-scanner.ts';
import { listFilesRecursive, type D4FixturesResult } from './fixtures/truth.ts';
export { type D4FixturesStats, type D4FixturesResult } from './fixtures/truth.ts';
import { verifyManifest } from './fixtures/manifest.ts';
import { verifyRegistry } from './fixtures/registry.ts';
import { verifySelections } from './fixtures/selections.ts';
import { verifySearch } from './fixtures/search.ts';
import { verifyScale } from './fixtures/scale.ts';
export function verifyD4FixturesIntegrity(d4Root: string): D4FixturesResult {
  const problems: string[] = [];
  const stats: {
    hashedFiles: number; mdFixtures: number; pdfFixtures: number;
    negativeFixtures: number; versionPairs: number;
    validSelections: number; invalidSelections: number;
    positiveQueries: number; noResultQueries: number;
  } = {
    hashedFiles: 0, mdFixtures: 0, pdfFixtures: 0, negativeFixtures: 0,
    versionPairs: 0, validSelections: 0, invalidSelections: 0,
    positiveQueries: 0, noResultQueries: 0,
  };

  verifyManifest(d4Root, problems, stats);
  const { registries, expectedById } = verifyRegistry(d4Root, problems, stats);
  verifySelections(d4Root, problems, stats, expectedById, registries);
  verifySearch(d4Root, problems, stats, expectedById, registries);
  verifyScale(d4Root, problems, stats);
  // 9. secret scan over text fixtures ---------------------------------------
  for (const rel of listFilesRecursive(d4Root)) {
    if (!/\.(json|md|txt)$/.test(rel)) continue;
    const text = readFileSync(join(d4Root, rel), "utf8");
    for (const finding of scanText(text, rel)) {
      problems.push(`secret-scan: ${rel}: ${finding.ruleId}`);
    }
  }

  return { problems, stats };
}
