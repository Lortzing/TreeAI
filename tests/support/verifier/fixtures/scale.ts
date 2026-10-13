
import { join } from 'node:path';

import { type D4FixturesStats, readJson, asRecord, asArray } from './truth.ts';

type Stats = { -readonly [K in keyof D4FixturesStats]: D4FixturesStats[K] };

export function verifyScale(d4Root: string, problems: string[], stats: Stats) {
  // 8. scale specs -----------------------------------------------------------
  const b6 = asRecord(readJson(join(d4Root, "b6-scale", "spec.json"), problems, "b6 spec"));
  if (b6 !== null) {
    const b6Dataset = asRecord(b6["dataset"]) ?? b6;
    const materials = asRecord(b6Dataset["materials"]);
    const facts = asRecord(b6Dataset["savedFacts"]);
    const branches = asRecord(b6Dataset["branches"]);
    if (materials === null || facts === null || branches === null) {
      problems.push("b6 spec: materials/savedFacts/branches sections missing");
    } else {
      if ((materials["count"] as number) < 100) problems.push("b6 spec: materials.count < 100");
      if ((materials["totalCanonicalTextUnits"] as number) < 1_000_000) {
        problems.push("b6 spec: totalCanonicalTextUnits < 1,000,000");
      }
      if ((facts["count"] as number) < 10_000) problems.push("b6 spec: savedFacts.count < 10,000");
      if ((branches["count"] as number) < 1000) problems.push("b6 spec: branches.count < 1000");
    }
    const det = asRecord(b6["determinism"]);
    if (det === null || typeof det["seed"] !== "string") {
      problems.push("b6 spec: determinism.seed missing");
    }
  }
  const b9 = asRecord(readJson(join(d4Root, "b9-nav", "spec.json"), problems, "b9 spec"));
  if (b9 !== null) {
    const b9Dataset = asRecord(b9["dataset"]) ?? b9;
    const trees = asRecord(b9Dataset["trees"]);
    if (trees === null) {
      problems.push("b9 spec: trees section missing");
    } else {
      if ((trees["count"] as number) < 100) problems.push("b9 spec: trees.count < 100");
      if ((trees["totalBranches"] as number) < 10_000) {
        problems.push("b9 spec: totalBranches < 10,000");
      }
      const special = JSON.stringify(asArray(trees["specialTrees"]) ?? []);
      for (const needle of ["5000", "100", "宽树"]) {
        if (!special.includes(needle)) {
          problems.push(`b9 spec: specialTrees does not mention ${needle}`);
        }
      }
    }
    const det = asRecord(b9["determinism"]);
    if (det === null || typeof det["seed"] !== "string") {
      problems.push("b9 spec: determinism.seed missing");
    }
  }

}
