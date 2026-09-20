/**
 * Redaction boundary tests: secrets and home paths must be removed;
 * legitimate test content must survive.
 *
 * Every secret-shaped input below is SYNTHETIC and is assembled by string
 * concatenation at module load, so no complete secret-shaped literal ever
 * appears in this file. The workspace scanner (d1-spikes/scripts/check-secrets,
 * Agent D owned) must stay quiet on the repository itself while these tests
 * keep feeding realistic material through every redaction rule.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { redactString, redactValue, findLeakCandidates, REDACTION_VERSION } from "../src/redact.js";

// Synthetic test material (NOT real credentials), split so that no single
// line in this file matches a secret-scanner rule.
const anthropicStyleKey = "sk-ant-" + "api03-AbCdEf123456789012345";
const openaiStyleKey = "sk-" + "proj-AbCdEfGh123456789012345678";
const githubStyleToken = "gh" + "p_AbCdEfGhIjKlMnOpQrStUvWxYz1234567890";
const googleStyleKey = "AIza" + "SyA1234567890abcdefghijklmnopqrstu";
const jwtStyleBearer = "ey" + "JhbGciOiJIUzI1NiJ9.payload.sig";
const envStyleSecret = "sk-ant-" + "supersecretvalue123";
const usersStylePath = "/Use" + "rs/someone/projects/x";
const homeStylePath = "/ho" + "me/other/y";
const aliceStylePath = "/Use" + "rs/alice/secret";

test("anthropic-style keys are redacted", () => {
  const out = redactString(`key ${anthropicStyleKey} tail`);
  assert.ok(!out.includes("sk-ant-api03"));
  assert.ok(out.includes("[REDACTED:"));
});

test("openai-style keys are redacted", () => {
  const out = redactString(openaiStyleKey);
  assert.ok(!out.includes("sk-proj-"));
});

test("bearer tokens are redacted but the scheme is kept", () => {
  const out = redactString("Authorization: Bearer " + jwtStyleBearer);
  assert.ok(out.includes("Authorization: Bearer [REDACTED:"));
  assert.ok(!out.includes("JhbGciOiJIUzI1NiJ9"));
});

test("github and google tokens are redacted", () => {
  assert.ok(!redactString(githubStyleToken).includes("ghp_"));
  assert.ok(!redactString(googleStyleKey).includes("AIzaSyA"));
});

test("env-style assignments are redacted", () => {
  const out = redactString("ANTHROPIC_API_KEY=" + envStyleSecret);
  assert.ok(!out.includes("supersecretvalue"));
});

test("home directory absolute paths are reduced to ~/", () => {
  const out = redactString(usersStylePath + " and " + homeStylePath);
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
  const body = "COUNT=16 SUM=80 MIN=1 MAX=9 MEDIAN=5 TREEAI-RESUME-9c4e STEERED-OK ACK 42 5";
  assert.equal(redactString(body), body);
});

test("the word token alone survives; long random hex without prefix survives", () => {
  assert.equal(redactString("token"), "token");
  const hex = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
  assert.equal(redactString(`id ${hex}`), `id ${hex}`);
});

test("findLeakCandidates detects unredacted secrets and home paths", () => {
  const leaks = findLeakCandidates({
    a: anthropicStyleKey,
    b: aliceStylePath,
    apiKey: "plain-not-redacted",
  });
  assert.ok(leaks.includes("anthropic-key"));
  assert.ok(leaks.includes("home-path"));
  assert.ok(leaks.some((l) => l.startsWith("unredacted-field:")));
});

test("findLeakCandidates passes clean payloads", () => {
  assert.deepEqual(findLeakCandidates({ text: "COUNT=16 SUM=80 MIN=1 MAX=9 MEDIAN=5", n: 42 }), []);
});

test("redaction version constant", () => {
  assert.equal(REDACTION_VERSION, "d1-v1");
});
