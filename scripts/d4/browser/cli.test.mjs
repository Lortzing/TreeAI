import {test} from "node:test";
import assert from "node:assert/strict";
import { parseCli, CHROME_CANDIDATES, USAGE } from "./cli.mjs";

test("B3/B9 D4 browser CLI default remains offline selftest without credentials",()=>{
  const x=parseCli([]);
  assert.equal(x.mode,"selftest");
  assert.deepEqual(x.only,[]);
  assert.equal(x.promptTimeoutMs,240000);
  assert.ok(CHROME_CANDIDATES.includes("/usr/bin/chromium"));
  assert.match(USAGE,/--mode/);
});
test("browser CLI --only repetitions, flags, and order are preserved",()=>{
  const x=parseCli(["--keep-data","--only","d4-read-and-select","--mode","selftest","--only","terminology-path"]);
  assert.deepEqual(x.only,["d4-read-and-select","terminology-path"]);
  assert.equal(x.keepData,true);
});
test("browser CLI refuses unknown flags, missing values, inappropriate real-Pi flags",()=>{
  assert.throws(()=>parseCli(["--unknown","x"]),/unknown flag/);
  assert.throws(()=>parseCli(["--mode"]),/missing value/);
  assert.throws(()=>parseCli(["--model","not-a-model"]),/only to --mode real-pi/);
  assert.throws(()=>parseCli(["--mode","real-pi"]),/requires --provider and --model/);
});

test("browser CLI accepts --keep-data as a standalone final switch", () => {
  assert.equal(parseCli(["--keep-data"]).keepData, true);
  assert.deepEqual(parseCli(["--only", "d4-read-and-select", "--keep-data"]).only, ["d4-read-and-select"]);
  assert.equal(parseCli(["--keep-data", "--mode", "selftest", "--keep-data"]).keepData, true);
});

test("browser CLI retains positional values and rejects incomplete option pairs", () => {
  const x = parseCli(["--data", "sample-data", "--artifacts", "sample-artifacts", "--prompt-timeout-ms", "1000", "--keep-data"]);
  assert.equal(x.dataDir, "sample-data");
  assert.equal(x.artifactsDir, "sample-artifacts");
  assert.equal(x.promptTimeoutMs, 1000);
  assert.equal(x.keepData, true);
  assert.throws(() => parseCli(["--only"]), /missing value/);
  assert.throws(() => parseCli(["--unknown"]), /unknown flag/);
  assert.throws(() => parseCli(["--prompt-timeout-ms", "999"]), />= 1000/);
});
