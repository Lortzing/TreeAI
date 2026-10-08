import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createSourceHasher } from "../public/shared/source/sha256.js";

test("browser source SHA-256 retains UTF-8 and Unicode identity", () => {
  const sha256Hex = createSourceHasher();
  for (const source of [
    "", "hello", "TreeAI",
    "北京大学 递归归纳", "a𠀋\u0301⚙️😀b",
    "left\r\nright\n\nsource",
    "\ud800", "\udc00", "\ud800ab\udc00",
    "x".repeat(100000),
  ]) {
    const expected = createHash("sha256").update(source, "utf8").digest("hex");
    assert.equal(sha256Hex(source), expected);
    assert.equal(sha256Hex(source), expected, "cached repeat must be identical");
  }
  const independent = createSourceHasher();
  assert.equal(independent("TreeAI"), sha256Hex("TreeAI"), "fresh app factory preserves identity");
});
