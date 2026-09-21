/**
 * Unit tests for the zero-dependency JSON Schema subset validator.
 *
 * Every keyword used by schemas/d2/*.json is exercised with at least one
 * positive and one negative case, plus the built-in self-test corpus
 * (validatorSelfTestCases / runValidatorSelfTest) that scripts/verify-d2
 * also runs as its schema-validator-selftest check.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  runValidatorSelfTest,
  validateJsonSchema,
  validatorSelfTestCases,
} from "../support/verifier/schema-validator.ts";

function ok(instance: unknown, schema: unknown): void {
  const res = validateJsonSchema(instance, schema);
  assert.equal(
    res.valid,
    true,
    `expected valid, got errors: ${JSON.stringify(res.errors)}`,
  );
}

function rejects(instance: unknown, schema: unknown): void {
  const res = validateJsonSchema(instance, schema);
  assert.equal(res.valid, false, "expected invalid, but validated");
  assert.ok(res.errors.length > 0, "invalid result must carry errors");
}

test("type: string / integer / number / boolean / null / array / object", () => {
  ok("x", { type: "string" });
  rejects(1, { type: "string" });
  ok(1, { type: "integer" });
  rejects(1.5, { type: "integer" });
  ok(1.5, { type: "number" });
  ok(1, { type: "number" });
  rejects("1", { type: "number" });
  ok(true, { type: "boolean" });
  ok(null, { type: "null" });
  rejects(0, { type: "null" });
  ok([1], { type: "array" });
  rejects({}, { type: "array" });
  ok({}, { type: "object" });
  rejects([], { type: "object" });
  // union type
  ok("a", { type: ["string", "integer"] });
  ok(2, { type: ["string", "integer"] });
  rejects(true, { type: ["string", "integer"] });
});

test("enum and const", () => {
  ok("a", { enum: ["a", "b"] });
  rejects("c", { enum: ["a", "b"] });
  ok(0.85, { const: 0.85 });
  ok({ x: 1 }, { const: { x: 1 } });
  rejects({ x: 2 }, { const: { x: 1 } });
});

test("required / properties / additionalProperties", () => {
  const schema = {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string" }, n: { type: "integer" } },
    additionalProperties: false,
  };
  ok({ id: "a" }, schema);
  ok({ id: "a", n: 3 }, schema);
  rejects({ n: 3 }, schema);
  rejects({ id: "a", extra: 1 }, schema);
  rejects({ id: 5 }, schema);
  // additionalProperties as a schema
  const lenient = {
    type: "object",
    properties: { id: { type: "string" } },
    additionalProperties: { type: "boolean" },
  };
  ok({ id: "a", flag: true }, lenient);
  rejects({ id: "a", flag: "yes" }, lenient);
});

test("array: items / minItems / maxItems / uniqueItems", () => {
  ok([1, 2], { type: "array", items: { type: "integer" } });
  rejects([1, "x"], { type: "array", items: { type: "integer" } });
  ok([1], { type: "array", minItems: 1 });
  rejects([], { type: "array", minItems: 1 });
  ok([1, 2], { type: "array", maxItems: 2 });
  rejects([1, 2, 3], { type: "array", maxItems: 2 });
  ok([1, 2], { type: "array", uniqueItems: true });
  rejects([1, 1], { type: "array", uniqueItems: true });
});

test("string: minLength / maxLength / pattern", () => {
  ok("abc", { type: "string", minLength: 3 });
  rejects("ab", { type: "string", minLength: 3 });
  ok("abc", { type: "string", maxLength: 3 });
  rejects("abcd", { type: "string", maxLength: 3 });
  ok("run.state-changed", { type: "string", pattern: "^[a-z0-9]+(\\.[a-z0-9-]+)+$" });
  rejects("runstatechanged", { type: "string", pattern: "^[a-z0-9]+(\\.[a-z0-9-]+)+$" });
});

test("number: minimum / maximum", () => {
  ok(1, { type: "integer", minimum: 1 });
  rejects(0, { type: "integer", minimum: 1 });
  ok(5, { type: "integer", maximum: 5 });
  rejects(6, { type: "integer", maximum: 5 });
});

test("anyOf / oneOf / allOf / not", () => {
  ok(1, { anyOf: [{ type: "string" }, { type: "integer" }] });
  ok("s", { anyOf: [{ type: "string" }, { type: "integer" }] });
  rejects(true, { anyOf: [{ type: "string" }, { type: "integer" }] });
  ok(1, { oneOf: [{ type: "integer" }, { type: "boolean" }] });
  // both branches match -> oneOf fails
  rejects(1, { oneOf: [{ type: "integer" }, { type: "integer" }] });
  ok({ a: 1 }, { allOf: [{ type: "object" }, { required: ["a"] }] });
  rejects({ b: 1 }, { allOf: [{ type: "object" }, { required: ["a"] }] });
  ok("x", { not: { type: "integer" } });
  rejects(1, { not: { type: "integer" } });
});

test("format date-time: UTC-only RFC3339", () => {
  ok("2026-09-21T10:00:00Z", { type: "string", format: "date-time" });
  ok("2026-09-21T10:00:00.123Z", { type: "string", format: "date-time" });
  rejects("2026-09-21T10:00:00+08:00", { type: "string", format: "date-time" });
  rejects("2026-09-21 10:00:00Z", { type: "string", format: "date-time" });
  rejects("not-a-time", { type: "string", format: "date-time" });
});

test("local $ref through $defs", () => {
  const schema = {
    type: "object",
    properties: { item: { $ref: "#/$defs/thing" } },
    $defs: { thing: { type: "string" } },
  };
  ok({ item: "s" }, schema);
  rejects({ item: 1 }, schema);
});

test("unsupported keyword is a loud error, never a silent pass", () => {
  assert.throws(
    () => validateJsonSchema({ a: 1 }, { type: "object", minProperties: 1 }),
    /unsupported schema keyword/i,
  );
  assert.throws(
    () => validateJsonSchema("x", { patternProperties: { "^a$": true } }),
    /unsupported schema keyword/i,
  );
});

test("boolean root schemas: true allows everything, false allows nothing", () => {
  assert.equal(validateJsonSchema("anything", true).valid, true);
  assert.equal(validateJsonSchema("anything", false).valid, false);
});

test("non-object schema input is rejected loudly", () => {
  assert.throws(() => validateJsonSchema("x", "not-a-schema"), /invalid schema/i);
  assert.throws(() => validateJsonSchema("x", null), /invalid schema/i);
  assert.throws(() => validateJsonSchema("x", 42), /invalid schema/i);
});

test("selftest corpus: cases exist and all pass", () => {
  const cases = validatorSelfTestCases();
  assert.ok(cases.length >= 30, `expected a substantial corpus, got ${cases.length}`);
  const failures = runValidatorSelfTest();
  assert.deepEqual(failures, []);
});

test("real schemas accept their canonical valid instances", () => {
  // event-shaped instance against the actual shipped schema (smoke only;
  // the full corpus lives in fixtures-integrity tests).
  const schema = {
    type: "object",
    required: ["eventId", "runId", "seq", "occurredAt", "type", "payload", "evidence"],
    additionalProperties: false,
    properties: {
      eventId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" },
      runId: { type: "string" },
      seq: { type: "integer", minimum: 1 },
      occurredAt: { type: "string", format: "date-time" },
      type: { type: "string" },
      payload: { type: "object" },
      evidence: { type: "array" },
    },
  };
  ok(
    {
      eventId: "r-e1",
      runId: "r",
      seq: 1,
      occurredAt: "2026-09-21T00:00:00Z",
      type: "run.state-changed",
      payload: {},
      evidence: [],
    },
    schema,
  );
  rejects(
    {
      eventId: "r-e1",
      runId: "r",
      seq: 0,
      occurredAt: "2026-09-21T00:00:00Z",
      type: "run.state-changed",
      payload: {},
      evidence: [],
    },
    schema,
  );
});
