import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { percentile, timingStats, fmt, settleReaderReadable } from "./scale-measurements.mjs";

test("B6 timing statistics keep the original nearest-rank p95 and empty-sample semantics", () => {
  assert.equal(percentile([], 0.95), 0);
  assert.equal(percentile([30, 10, 20], 0.5), 20);
  assert.equal(percentile([30, 10, 20], 0.95), 30);
  assert.deepEqual(timingStats([]), { count: 0, medianMs: 0, p95Ms: 0, maxMs: 0 });
  assert.deepEqual(timingStats([10, 40, 20, 30]), { count: 4, medianMs: 20, p95Ms: 40, maxMs: 40 });
  assert.equal(fmt(1.234), "1.2");
});

test("B6 browser readable predicate keeps PDF text-layer readiness and markdown block readiness distinct", () => {
  const reader = { hidden: false };
  const textLayer = { dataset: { rendered: "true" } };
  const blocks = {
    querySelector: () => textLayer,
    querySelectorAll: (selector) => selector === ".pdf-page-frame" ? [{}, {}] : [{}, {}, {}],
  };
  const elements = { "material-reader": reader, "mat-blocks": blocks, "mat-tail": {} };
  const document = { getElementById: (id) => elements[id] ?? null };
  const run = (isPdf) => runInNewContext(settleReaderReadable("mat-1", isPdf), { document });
  const pdf = run(true);
  assert.equal(pdf.blockCount, 2);
  assert.equal(pdf.pdfFrames, 2);
  const markdown = run(false);
  assert.equal(markdown.blockCount, 3);
  assert.equal(markdown.pdfFrames, null);
  textLayer.dataset.rendered = "false";
  assert.equal(run(true), false, "PDF page is not readable until the actual text layer has rendered");
  assert.equal(run(false).blockCount, 3, "Markdown does not depend on PDF rendering");
  reader.hidden = true;
  assert.equal(run(true), false);
  assert.equal(run(false), false);
  reader.hidden = false;
  delete elements["mat-tail"];
  assert.equal(run(true), false);
  assert.equal(run(false), false);
});
