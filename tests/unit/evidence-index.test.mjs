import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEvidenceIndex, evidenceLocator } from "../../scripts/evidence-index.mjs";

test("R6 evidence locator groups by verified source path, not verdict",()=>{
  assert.deepEqual(evidenceLocator("evidence/d4/runs/r2/logs/failure.txt"),{domain:"d4",stream:"runs",runId:"r2"});
  assert.equal(evidenceLocator("evidence/d1/test.json"),null);
  assert.equal(evidenceLocator("evidence/d2/README.md"),null);
  const paths=["evidence/d4/runs/r2/logs/raw.txt","evidence/d4/runs/r2/result.json",
    "evidence/d4/runs/r1/result.json","evidence/d3/browser/one/summary.json"];
  const report=buildEvidenceIndex(paths,"a".repeat(40),p=>Buffer.from(p));
  assert.equal(report.runs.length,3);
  assert.equal(report.runs.find(x=>x.runId==="r2")?.rawFiles,1);
  const sha=report.runs.find(x=>x.runId==="r2")?.markers[0].sha256;
  assert.match(sha??"",/^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(report).includes("PASS"),false);
  assert.deepEqual(buildEvidenceIndex(paths.slice().reverse(),"a".repeat(40),p=>Buffer.from(p)),report);
});
