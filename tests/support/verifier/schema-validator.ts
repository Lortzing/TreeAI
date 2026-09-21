/**
 * Minimal JSON Schema validator (subset of draft 2020-12) — TreeAI D2 Agent F.
 *
 * Zero-dependency Node implementation used by scripts/verify-d2* and by the
 * tests. It supports exactly the keyword subset that schemas/d2/*.json uses
 * (see SUPPORTED_KEYWORDS); it is NOT a general-purpose validator. Any keyword
 * present in a schema but unsupported causes a validation ERROR (never a
 * silent pass), so schema authors cannot accidentally rely on unchecked
 * constraints.
 *
 * Supported keywords:
 *   $ref (local #/... only), type (string or array, incl. "integer"),
 *   enum, const, required, properties, additionalProperties (bool|schema),
 *   items (schema), minItems, maxItems, uniqueItems, minLength, maxLength,
 *   pattern, minimum, maximum, anyOf, oneOf, allOf, not, format ("date-time"),
 *   $defs, and the annotation keywords ($schema/$id/title/description).
 *
 * Cross-line rules (e.g. strictly increasing seq) are intentionally NOT
 * expressible here; the verifier enforces them separately.
 */

export interface ValidationError {
  /** JSON pointer of the failing instance position ("" for the root). */
  instancePath: string;
  /** Human-readable message (schema path included where useful). */
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

const SUPPORTED_KEYWORDS = new Set([
  "$schema",
  "$id",
  "$defs",
  "$ref",
  "title",
  "description",
  "type",
  "enum",
  "const",
  "required",
  "properties",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  "format",
  // Annotations we accept and ignore:
  "examples",
  "default",
  "deprecated",
]);

const SUPPORTED_FORMATS = new Set(["date-time"]);

/** RFC3339 date-time, UTC-only per the D2 evidence convention. */
const UTC_DATE_TIME =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$/;

type Schema = Record<string, unknown>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function jsonTypeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (Number.isInteger(v)) return "integer";
  if (typeof v === "number") return "number";
  return typeof v;
}

function typeMatches(v: unknown, t: string): boolean {
  const actual = jsonTypeOf(v);
  if (t === "number") return actual === "number" || actual === "integer";
  if (t === "integer") return actual === "integer";
  return actual === t;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!deepEqual(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

class Validator {
  private readonly root: Schema;
  private readonly errors: ValidationError[] = [];

  constructor(root: Schema) {
    this.root = root;
  }

  error(instancePath: string, message: string): void {
    this.errors.push({ instancePath, message });
  }

  resolveRef(ref: string): Schema {
    if (!ref.startsWith("#")) {
      throw new Error(`only local $ref are supported, got: ${ref}`);
    }
    let node: unknown = this.root;
    const parts = ref.slice(1).split("/").filter((p) => p.length > 0);
    for (const raw of parts) {
      const part = raw.replace(/~1/g, "/").replace(/~0/g, "~");
      if (!isPlainObject(node) || !(part in node)) {
        throw new Error(`unresolvable $ref: ${ref}`);
      }
      node = node[part];
    }
    if (!isPlainObject(node)) {
      throw new Error(`$ref target is not an object: ${ref}`);
    }
    return node;
  }

  validate(instance: unknown, schema: unknown, path: string): void {
    // Boolean schemas (true = anything, false = nothing) are honored.
    if (schema === true) return;
    if (schema === false) {
      this.error(path, "schema is false (nothing is allowed)");
      return;
    }
    if (!isPlainObject(schema)) {
      throw new Error(`invalid schema at ${path}: expected object or boolean`);
    }

    for (const key of Object.keys(schema)) {
      if (!SUPPORTED_KEYWORDS.has(key)) {
        throw new Error(
          `unsupported schema keyword "${key}" (validator subset violation at schema path ${path})`,
        );
      }
    }

    if (typeof schema.$ref === "string") {
      const target = this.resolveRef(schema.$ref);
      // $ref siblings are ignored per draft 2020-12 semantics.
      this.validate(instance, target, path);
      return;
    }

    if (schema.type !== undefined) {
      const t = schema.type;
      const allowed = Array.isArray(t) ? t : [t];
      for (const a of allowed) {
        if (typeof a !== "string") {
          throw new Error(`invalid type keyword at ${path}`);
        }
      }
      if (!allowed.some((a) => typeMatches(instance, a))) {
        this.error(path, `expected type ${JSON.stringify(allowed)}, got ${jsonTypeOf(instance)}`);
        // Type mismatch short-circuits most other keywords meaningfully.
        return;
      }
    }

    if (schema.enum !== undefined) {
      if (!Array.isArray(schema.enum)) throw new Error("enum must be an array");
      if (!schema.enum.some((c) => deepEqual(instance, c))) {
        this.error(path, `value not in enum ${JSON.stringify(schema.enum)}`);
      }
    }

    if ("const" in schema) {
      if (!deepEqual(instance, schema.const)) {
        this.error(path, `value must equal const ${JSON.stringify(schema.const)}`);
      }
    }

    if (Array.isArray(schema.allOf)) {
      for (const sub of schema.allOf) {
        this.validate(instance, sub, path);
      }
    }

    if (Array.isArray(schema.anyOf)) {
      const before = this.errors.length;
      let anyOk = false;
      for (const sub of schema.anyOf) {
        this.errors.length = before; // scratch
        try {
          this.validate(instance, sub, path);
        } catch (err) {
          // A sub-schema that throws (bad schema) must not be swallowed.
          throw err;
        }
        if (this.errors.length === before) {
          anyOk = true;
          break;
        }
      }
      this.errors.length = before;
      if (!anyOk) {
        this.error(path, "no anyOf branch matched");
      }
    }

    if (Array.isArray(schema.oneOf)) {
      const before = this.errors.length;
      let matches = 0;
      for (const sub of schema.oneOf) {
        this.errors.length = before; // scratch
        this.validate(instance, sub, path);
        if (this.errors.length === before) matches++;
      }
      this.errors.length = before;
      if (matches !== 1) {
        this.error(path, `oneOf matched ${matches} branches, expected exactly 1`);
      }
    }

    if (schema.not !== undefined) {
      const before = this.errors.length;
      this.validate(instance, schema.not, path);
      const notValid = this.errors.length === before;
      this.errors.length = before;
      if (notValid) {
        this.error(path, "value must NOT match the \"not\" subschema");
      }
    }

    if (schema.format !== undefined) {
      if (typeof schema.format !== "string" || !SUPPORTED_FORMATS.has(schema.format)) {
        throw new Error(`unsupported format "${String(schema.format)}" at ${path}`);
      }
      if (typeof instance === "string" && !UTC_DATE_TIME.test(instance)) {
        this.error(path, `not a UTC RFC3339 date-time: ${JSON.stringify(instance)}`);
      }
    }

    if (typeof instance === "string") {
      const { minLength, maxLength, pattern } = schema;
      if (minLength !== undefined) {
        if (typeof minLength !== "number") throw new Error("minLength must be number");
        if (instance.length < minLength) {
          this.error(path, `string shorter than minLength ${minLength}`);
        }
      }
      if (maxLength !== undefined) {
        if (typeof maxLength !== "number") throw new Error("maxLength must be number");
        if (instance.length > maxLength) {
          this.error(path, `string longer than maxLength ${maxLength}`);
        }
      }
      if (pattern !== undefined) {
        if (typeof pattern !== "string") throw new Error("pattern must be string");
        if (!new RegExp(pattern, "u").test(instance)) {
          this.error(path, `string does not match pattern ${pattern}`);
        }
      }
    }

    if (typeof instance === "number") {
      const { minimum, maximum } = schema;
      if (minimum !== undefined) {
        if (typeof minimum !== "number") throw new Error("minimum must be number");
        if (instance < minimum) this.error(path, `number below minimum ${minimum}`);
      }
      if (maximum !== undefined) {
        if (typeof maximum !== "number") throw new Error("maximum must be number");
        if (instance > maximum) this.error(path, `number above maximum ${maximum}`);
      }
    }

    if (Array.isArray(instance)) {
      const { minItems, maxItems, uniqueItems, items } = schema;
      if (minItems !== undefined && instance.length < (minItems as number)) {
        this.error(path, `array has fewer than minItems ${String(minItems)}`);
      }
      if (maxItems !== undefined && instance.length > (maxItems as number)) {
        this.error(path, `array has more than maxItems ${String(maxItems)}`);
      }
      if (uniqueItems === true) {
        for (let i = 0; i < instance.length; i++) {
          for (let j = i + 1; j < instance.length; j++) {
            if (deepEqual(instance[i], instance[j])) {
              this.error(path, `array items at ${i} and ${j} are not unique`);
            }
          }
        }
      }
      if (items !== undefined) {
        for (let i = 0; i < instance.length; i++) {
          this.validate(instance[i], items, `${path}/${i}`);
        }
      }
    }

    if (isPlainObject(instance)) {
      const { required, properties, additionalProperties } = schema;
      if (Array.isArray(required)) {
        for (const r of required) {
          if (typeof r !== "string") throw new Error("required entries must be strings");
          if (!(r in instance)) {
            this.error(path, `missing required property "${r}"`);
          }
        }
      }
      if (properties !== undefined) {
        if (!isPlainObject(properties)) throw new Error("properties must be object");
        for (const key of Object.keys(instance)) {
          if (key in properties) {
            this.validate(instance[key], properties[key], `${path}/${key}`);
          }
        }
      }
      if (additionalProperties !== undefined) {
        const props = isPlainObject(properties) ? properties : {};
        for (const key of Object.keys(instance)) {
          if (key in props) continue;
          if (additionalProperties === false) {
            this.error(`${path}/${key}`, `additional property "${key}" is not allowed`);
          } else if (additionalProperties !== true) {
            this.validate(instance[key], additionalProperties, `${path}/${key}`);
          }
        }
      }
    }
  }

  run(instance: unknown): ValidationResult {
    this.validate(instance, this.root, "");
    return { valid: this.errors.length === 0, errors: this.errors };
  }
}

/**
 * Validate `instance` against `schema`. Throws only on INVALID SCHEMAS
 * (unsupported keywords, unresolvable $ref, malformed keyword values) —
 * never on invalid instances.
 */
export function validateJsonSchema(instance: unknown, schema: unknown): ValidationResult {
  if (!isPlainObject(schema) && schema !== true && schema !== false) {
    throw new Error(
      `invalid schema: expected object or boolean, got ${schema === null ? "null" : typeof schema}`,
    );
  }
  // Boolean root schemas are honored: true = no constraints, false = nothing allowed.
  const root: Schema = isPlainObject(schema) ? schema : schema === false ? { not: {} } : {};
  const v = new Validator(root);
  return v.run(instance);
}

/**
 * Keyword-level self-test cases for the validator itself (mirrors the D1
 * schema-check --selftest discipline: the gate must prove its own tool).
 * Cases are data, not literals with secret shapes.
 */
export interface SelfTestCase {
  name: string;
  schema: unknown;
  instance: unknown;
  expectValid: boolean;
}

export function validatorSelfTestCases(): SelfTestCase[] {
  return [
    { name: "type-string-ok", schema: { type: "string" }, instance: "x", expectValid: true },
    { name: "type-string-bad", schema: { type: "string" }, instance: 1, expectValid: false },
    {
      name: "type-integer-rejects-float",
      schema: { type: "integer" },
      instance: 1.5,
      expectValid: false,
    },
    {
      name: "type-integer-accepts-int",
      schema: { type: "integer" },
      instance: 2,
      expectValid: true,
    },
    {
      name: "type-number-accepts-integer",
      schema: { type: "number" },
      instance: 3,
      expectValid: true,
    },
    {
      name: "type-multi",
      schema: { type: ["null", "string"] },
      instance: null,
      expectValid: true,
    },
    { name: "type-multi-bad", schema: { type: ["null", "string"] }, instance: 4, expectValid: false },
    { name: "const-ok", schema: { const: "0.85.1" }, instance: "0.85.1", expectValid: true },
    { name: "const-bad", schema: { const: "0.85.1" }, instance: "0.85.2", expectValid: false },
    {
      name: "enum-ok",
      schema: { enum: ["a", "b"] },
      instance: "b",
      expectValid: true,
    },
    { name: "enum-bad", schema: { enum: ["a", "b"] }, instance: "c", expectValid: false },
    {
      name: "required-missing",
      schema: { type: "object", required: ["x"], properties: { x: { type: "string" } } },
      instance: {},
      expectValid: false,
    },
    {
      name: "required-present",
      schema: { type: "object", required: ["x"], properties: { x: { type: "string" } } },
      instance: { x: "y" },
      expectValid: true,
    },
    {
      name: "additionalProperties-false",
      schema: { type: "object", properties: { a: { type: "string" } }, additionalProperties: false },
      instance: { a: "b", extra: 1 },
      expectValid: false,
    },
    {
      name: "additionalProperties-schema",
      schema: {
        type: "object",
        properties: { a: { type: "string" } },
        additionalProperties: { type: "integer" },
      },
      instance: { a: "b", extra: 2 },
      expectValid: true,
    },
    {
      name: "minLength",
      schema: { type: "string", minLength: 2 },
      instance: "a",
      expectValid: false,
    },
    {
      name: "maxLength",
      schema: { type: "string", maxLength: 2 },
      instance: "abc",
      expectValid: false,
    },
    {
      name: "pattern",
      schema: { type: "string", pattern: "^[a-z]+$" },
      instance: "ABC",
      expectValid: false,
    },
    { name: "minimum", schema: { type: "integer", minimum: 1 }, instance: 0, expectValid: false },
    { name: "maximum", schema: { type: "integer", maximum: 5 }, instance: 6, expectValid: false },
    {
      name: "items-type",
      schema: { type: "array", items: { type: "integer" } },
      instance: [1, "x"],
      expectValid: false,
    },
    { name: "minItems", schema: { type: "array", minItems: 1 }, instance: [], expectValid: false },
    {
      name: "uniqueItems",
      schema: { type: "array", uniqueItems: true },
      instance: [1, 1],
      expectValid: false,
    },
    {
      name: "uniqueItems-ok",
      schema: { type: "array", uniqueItems: true },
      instance: [1, 2],
      expectValid: true,
    },
    {
      name: "anyOf-one-branch",
      schema: { anyOf: [{ type: "string" }, { type: "integer" }] },
      instance: 7,
      expectValid: true,
    },
    {
      name: "anyOf-none",
      schema: { anyOf: [{ type: "string" }, { type: "integer" }] },
      instance: true,
      expectValid: false,
    },
    {
      name: "anyOf-branch-pins-two-fields",
      schema: {
        anyOf: [
          { properties: { a: { const: 1 }, b: { const: 10 } } },
          { properties: { a: { const: 2 }, b: { const: 20 } } },
        ],
      },
      instance: { a: 1, b: 20 },
      expectValid: false,
    },
    {
      name: "oneOf-exactly-one",
      schema: { oneOf: [{ type: "string" }, { minLength: 1 }] },
      instance: "x",
      expectValid: false,
    },
    {
      name: "allOf-both",
      schema: { allOf: [{ type: "string" }, { minLength: 2 }] },
      instance: "a",
      expectValid: false,
    },
    {
      name: "not",
      schema: { not: { enum: ["bad"] } },
      instance: "bad",
      expectValid: false,
    },
    {
      name: "format-date-time-utc",
      schema: { format: "date-time" },
      instance: "2026-09-21T00:00:00Z",
      expectValid: true,
    },
    {
      name: "format-date-time-offset-rejected",
      schema: { format: "date-time" },
      instance: "2026-09-21T00:00:00+02:00",
      expectValid: false,
    },
    {
      name: "format-non-string-ignored",
      schema: { format: "date-time" },
      instance: 5,
      expectValid: true,
    },
    {
      name: "local-ref",
      schema: { $defs: { s: { type: "string" } }, $ref: "#/$defs/s" },
      instance: 6,
      expectValid: false,
    },
    {
      name: "boolean-schema-false",
      schema: false,
      instance: "x",
      expectValid: false,
    },
    {
      name: "boolean-schema-true",
      schema: true,
      instance: "x",
      expectValid: true,
    },
  ];
}

/** Run the keyword self-test; returns failures (empty = pass). */
export function runValidatorSelfTest(): string[] {
  const failures: string[] = [];
  for (const c of validatorSelfTestCases()) {
    let result: ValidationResult;
    try {
      result = validateJsonSchema(c.instance, c.schema);
    } catch (err) {
      failures.push(`${c.name}: validator threw: ${String(err)}`);
      continue;
    }
    if (result.valid !== c.expectValid) {
      failures.push(
        `${c.name}: expected ${c.expectValid ? "valid" : "invalid"}, got ${result.valid ? "valid" : "invalid"} (${result.errors.map((e) => e.message).join("; ")})`,
      );
    }
  }
  return failures;
}
