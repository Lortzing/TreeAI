/**
 * Redaction boundary tests: secrets and home paths must be removed;
 * legitimate test content must survive.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { redactString, redactValue, findLeakCandidates, REDACTION_VERSION } from "../src/redact.js";

test("anthropic-style keys are redacted", () => {
  const out = redactString("key sk-ant-api03-AbCdEf123456789012345 tail");
  assert.ok(!out.includes("sk-ant-api03-AbCdEf"));
  assert.ok(out.includes("[REDACTED:"));
});

test("openai-style keys are redacted", () => {
  const out = redactString("sk-proj-AbCdEfGh123456789012345678");
  assert.ok(!out.includes("sk-proj-"));
});

test("bearer tokens are redacted but the scheme is kept", () => {
  const out = redactString("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig");
  assert.ok(out.includes("Authorization: Bearer [REDACTED:"));
  assert.ok(!out.includes("eyJhbGciOiJIUzI1NiJ9"));
});

test("github and google tokens are redacted", () => {
  assert.ok(!redactString("ghp_AbCdEfGhIjKlMnOpQrStUvWxYz1234567890").includes("ghp_"));
  assert.ok(!redactString("key AIzaSyA1234567890abcdefghijklmnopqrstu").includes("AIzaSyA"));
});

test("env-style assignments are redacted", () => {
  const out = redactString("ANTHROPIC_API_KEY=sk-ant-supersecretvalue123");
  assert.ok(!out.includes("supersecretvalue"));
});

test("home directory absolute paths are reduced to ~/", () => {
  const out = redactString("/Users/someone/projects/x and /home/other/y");
  assert.equal(out, "~/projects/x and ~/y");
});

test("sensitive object fields are redacted regardless of value", () => {
  const out = redactValue({
    apiKey: "whatever",
    nested: { access_token: 12345, Authorization: "x" },
    safe: "keep me",
  }) as Record<string, unknown>;
  assert.equal(out.apiKey, "[REDACTED:d1-v1]");
  const nested = out.nested as Record<string, unknown>;
  assert.equal(nested.access_token, "[REDACTED:d1-v1]");
  assert.equal(nested.Authorization, "[REDACTED:d1-v1]");
  assert.equal(out.safe, "keep me");
});

test("legitimate probe content is NOT redacted (boundary)", () => {
  const body = "MARKER=TREEAI-D1-FIXTURE-7f3a SUM=42 TREEAI-RESUME-9c4e STEERED-OK ACK 42 5";
  assert.equal(redactString(body), body);
});

test("the word token alone survives; long random hex without prefix survives", () => {
  assert.equal(redactString("token"), "token");
  const hex = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
  assert.equal(redactString(`id ${hex}`), `id ${hex}`);
});

test("findLeakCandidates detects unredacted secrets and home paths", () => {
  const leaks = findLeakCandidates({
    a: "sk-ant-api03-AbCdEf123456789012345",
    b: "/Users/alice/secret",
    apiKey: "plain-not-redacted",
  });
  assert.ok(leaks.includes("anthropic-key"));
  assert.ok(leaks.includes("home-path"));
  assert.ok(leaks.some((l) => l.startsWith("unredacted-field:")));
});

test("findLeakCandidates passes clean payloads", () => {
  assert.deepEqual(findLeakCandidates({ text: "MARKER=TREEAI-D1-FIXTURE-7f3a", n: 42 }), []);
});

test("redaction version constant", () => {
  assert.equal(REDACTION_VERSION, "d1-v1");
});
