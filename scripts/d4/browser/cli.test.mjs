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
