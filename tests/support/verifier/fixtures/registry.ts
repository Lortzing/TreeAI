import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { type D4FixturesStats, MIN_MD_FIXTURES, MIN_PDF_FIXTURES, MIN_NEGATIVE_FIXTURES, MD_REQUIRED_COVERAGE, PDF_REQUIRED_COVERAGE, type Expected, type RegistryFixture, type Registry, readJson, asRecord, asString, asArray, loadExpected } from './truth.ts';

type Stats = { -readonly [K in keyof D4FixturesStats]: D4FixturesStats[K] };

export function verifyRegistry(d4Root: string, problems: string[], stats: Stats) {
  // 3. registries ----------------------------------------------------------
  const registries: Registry[] = [];
  for (const name of ["md-registry.json", "pdf-registry.json"]) {
    const raw = asRecord(readJson(join(d4Root, "b1-import", name), problems, `b1 ${name}`));
    if (raw === null) continue;
    const kind = asString(raw["kind"]) ?? "?";
    const fixturesRaw = asArray(raw["fixtures"]) ?? [];
    const negativesRaw = asArray(raw["negativeFixtures"]) ?? [];
    const fixtures: RegistryFixture[] = [];
    for (const f of fixturesRaw) {
      const r = asRecord(f);
      if (r === null) { problems.push(`${name}: non-object fixture entry`); continue; }
      const fixtureId = asString(r["fixtureId"]);
      const file = asString(r["file"]);
      const outcome = asString(r["outcome"]);
      if (fixtureId === null || file === null || outcome === null) {
        problems.push(`${name}: fixture entry missing fixtureId/file/outcome`);
        continue;
      }
      if (!existsSync(join(d4Root, "b1-import", file))) {
        problems.push(`${name}: fixture file missing on disk: ${file}`);
      }
      const expected = asString(r["expected"]);
      if (outcome === "ready" && expected === null) {
        problems.push(`${name}: ready fixture ${fixtureId} without expected file`);
      }
      fixtures.push({
        fixtureId, file, outcome, expected: expected ?? undefined,
        coverage: (asArray(r["coverage"]) ?? []).filter((c): c is string => typeof c === "string"),
        reason: asString(r["reason"]) ?? undefined,
      });
    }
    const negatives: RegistryFixture[] = [];
    for (const f of negativesRaw) {
      const r = asRecord(f);
      if (r === null) { problems.push(`${name}: non-object negative entry`); continue; }
      const fixtureId = asString(r["fixtureId"]);
      const file = asString(r["file"]);
      const reason = asString(r["reason"]);
      if (fixtureId === null || file === null || reason === null) {
        problems.push(`${name}: negative entry missing fixtureId/file/reason`);
        continue;
      }
      if (!existsSync(join(d4Root, "b1-import", file))) {
        problems.push(`${name}: negative file missing on disk: ${file}`);
      }
      negatives.push({ fixtureId, file, outcome: "rejected", reason });
    }
    stats.mdFixtures += kind === "markdown" ? fixtures.length : 0;
    stats.pdfFixtures += kind === "pdf" ? fixtures.length : 0;
    stats.negativeFixtures += negatives.length;
    const pairsRaw = asArray(raw["versionPairs"]) ?? [];
    stats.versionPairs += pairsRaw.length;
    registries.push({ kind, fixtures, negativeFixtures: negatives, versionPairs: pairsRaw.map((p) => asRecord(p) ?? {}) });
  }
  if (stats.mdFixtures < MIN_MD_FIXTURES) {
    problems.push(`b1: markdown fixtures ${stats.mdFixtures} < ${MIN_MD_FIXTURES}`);
  }
  if (stats.pdfFixtures < MIN_PDF_FIXTURES) {
    problems.push(`b1: pdf fixtures ${stats.pdfFixtures} < ${MIN_PDF_FIXTURES}`);
  }
  if (stats.negativeFixtures < MIN_NEGATIVE_FIXTURES) {
    problems.push(`b1: negative fixtures ${stats.negativeFixtures} < ${MIN_NEGATIVE_FIXTURES}`);
  }
  if (stats.versionPairs < 1) {
    problems.push("b1: no version pair registered (required for 改版/stale-anchor tests)");
  }

  // coverage tags across the B1 set
  const coverage = new Set<string>();
  for (const reg of registries) {
    for (const f of reg.fixtures) for (const c of f.coverage ?? []) coverage.add(c);
  }
  const requiredByKind = (kind: string): readonly string[] =>
    kind === "markdown" ? MD_REQUIRED_COVERAGE : PDF_REQUIRED_COVERAGE;
  for (const reg of registries) {
    if (reg.kind !== "markdown" && reg.kind !== "pdf") continue;
    const own = new Set<string>();
    for (const f of reg.fixtures) for (const c of f.coverage ?? []) own.add(c);
    for (const req of requiredByKind(reg.kind)) {
      if (!own.has(req)) {
        problems.push(`b1 ${reg.kind}: required coverage tag missing: ${req}`);
      }
    }
  }
  for (const req of ["zh", "en", "code", "repeated-words"]) {
    if (!coverage.has(req)) problems.push(`b1: charter coverage tag missing across set: ${req}`);
  }

  // load expected truth for all ready fixtures
  const expectedById = new Map<string, Expected>();
  for (const reg of registries) {
    for (const f of reg.fixtures) {
      if (f.outcome !== "ready" || f.expected === undefined) continue;
      const exp = loadExpected(join(d4Root, "b1-import", f.expected), problems, f.fixtureId);
      if (exp !== null) {
        if (exp.fixtureId !== f.fixtureId) {
          problems.push(`b1: expected.fixtureId ${exp.fixtureId} ≠ registry ${f.fixtureId}`);
        }
        expectedById.set(f.fixtureId, exp);
      }
    }
  }

  // 4. version pair structure ---------------------------------------------
  for (const reg of registries) {
    for (const pair of reg.versionPairs ?? []) {
      const v1 = asString(pair["v1Expected"]);
      const v2 = asString(pair["v2Expected"]);
      const materialKey = asString(pair["materialKey"]) ?? "?";
      if (v1 === null || v2 === null) {
        problems.push(`b1 version pair ${materialKey}: v1Expected/v2Expected missing`);
        continue;
      }
      const e1 = loadExpected(join(d4Root, "b1-import", v1), problems, `${materialKey}-v1`);
      const e2 = loadExpected(join(d4Root, "b1-import", v2), problems, `${materialKey}-v2`);
      if (e1 === null || e2 === null) continue;
      if (e1.canonicalText === e2.canonicalText) {
        problems.push(`b1 version pair ${materialKey}: v1 and v2 canonical texts are identical`);
        continue;
      }
      const t1 = e1.blocks.map((b) => b.text);
      const t2 = e2.blocks.map((b) => b.text);
      let prefix = 0;
      while (prefix < t1.length && prefix < t2.length && t1[prefix] === t2[prefix]) prefix++;
      let suffix = 0;
      while (
        suffix < t1.length - prefix && suffix < t2.length - prefix &&
        t1[t1.length - 1 - suffix] === t2[t2.length - 1 - suffix]
      ) suffix++;
      if (prefix < 2 || suffix < 2) {
        problems.push(
          `b1 version pair ${materialKey}: shared prefix/suffix blocks ${prefix}/${suffix} < 2`,
        );
      }
    }
  }

  return { registries, expectedById };
}
