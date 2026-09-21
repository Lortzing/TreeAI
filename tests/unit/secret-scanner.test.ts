/**
 * Unit tests for the secret scanner.
 *
 * NO real token literal is stored in this file. Every secret-shaped string is
 * synthesized at runtime from character math (synth-style helpers), so this
 * source itself never matches the scanner rules (the workspace scan covers
 * this file too — a self-match would be a finding, not a hidden pass).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  mask,
  maskSecretsInText,
  redactHomePaths,
  runScannerSelfTest,
  scanFilename,
  scanFiles,
  scanText,
} from "../support/verifier/secret-scanner.ts";

const ALPHABET = "abcdef0123456789";

function synth(n: number, offset = 0): string {
  let s = "";
  for (let i = 0; i < n; i++) s += ALPHABET[(i + offset) % ALPHABET.length];
  return s;
}

function ruleIdsOf(findings: { ruleId: string }[]): string[] {
  return [...new Set(findings.map((f) => f.ruleId))];
}

test("content rules fire on synthetic secret shapes", () => {
  const text = [
    "anthropic key " + "sk-ant-" + synth(40),
    "openai key " + "sk-" + synth(48, 3),
    "aws " + "AKIA" + "0123456789ABCDEF",
    "google " + "AIza" + synth(36, 2),
    "github " + "ghp_" + synth(40, 5),
    "slack " + "xoxb-" + synth(20, 6),
    "-----BEGIN " + "OPENSSH PRIVATE KEY" + "-----",
    "jwt " + "ey" + "JhbGciOiJIUzI1NiJ9" + "." + "ey" + "zdWIiOjEyMw" + "." + "SflKxwRJSMeKKF2QT4fwpMeJf36POk",
    "Authorization" + ": " + "Bearer " + synth(32, 11),
    "bearer " + synth(40, 13),
    "MY_" + "API_KEY=" + synth(30, 7),
    "_" + "authToken=" + synth(32, 11),
    "machine example.test login demo password " + synth(16, 4),
  ].join("\n");
  const ids = ruleIdsOf(scanText(text, "synthetic.txt"));
  for (const expected of [
    "anthropic-key",
    "openai-key",
    "aws-access-key",
    "google-api-key",
    "github-token",
    "slack-token",
    "private-key-block",
    "jwt",
    "bearer-header",
    "bearer-standalone",
    "env-secret-assignment",
    "npmrc-auth",
    "netrc-password",
  ]) {
    assert.ok(ids.includes(expected), `rule ${expected} did not fire; fired: ${ids.join(",")}`);
  }
});

test("json-secret-field fires on token-ish keys with digit-bearing string values", () => {
  const json = JSON.stringify({ ["api" + "_key"]: synth(32) });
  const ids = ruleIdsOf(scanText(json, "config.json"));
  assert.ok(ids.includes("json-secret-field"));
});

test("clean text produces no findings", () => {
  const clean = [
    "The token bucket was empty after the burst.",
    "Passwords must be at least 12 characters long.",
    "count of processed records: 41",
    "Authorization: Bearer <redacted>",
    "see docs/d2/contracts-README.md",
  ].join("\n");
  assert.deepEqual(scanText(clean, "clean.txt"), []);
});

test("home paths are detected and redaction replaces them", () => {
  const text = "reading " + "/Users/" + "someone" + "/notes.txt failed";
  const ids = ruleIdsOf(scanText(text, "paths.txt"));
  assert.ok(ids.includes("home-path"));
  const redacted = redactHomePaths(text);
  assert.ok(!redacted.includes("/Users/"));
  assert.ok(redacted.includes("[HOME]"));
});

test("mask keeps only a prefix and the length", () => {
  const m = mask(synth(40));
  assert.ok(m.startsWith("abcd"));
  assert.ok(m.includes("len=40"));
  assert.ok(m.length < 40, "masked excerpt must be short");
});

test("maskSecretsInText removes every match", () => {
  const tok = synth(48, 3);
  const text = "a " + "sk-" + tok + " b " + "sk-" + tok + " c";
  const { masked, count } = maskSecretsInText(text);
  assert.equal(count, 2);
  assert.ok(!masked.includes(tok));
});

test("filename rules", () => {
  assert.ok(scanFilename(".env", ".env").length > 0);
  assert.ok(scanFilename(".env.local", ".env.local").length > 0);
  assert.ok(scanFilename("id_rsa", "id_rsa").length > 0);
  assert.ok(scanFilename("server.pem", "server.pem").length > 0);
  assert.ok(scanFilename("svc-service-account-x.json", "x").length > 0);
  assert.ok(scanFilename("credentials", "credentials").length > 0);
  // The credential-json rule is an EXACT stem match (plus dotted env
  // suffixes): real credential stores fire; descriptive schema-probe names
  // must not (regression guard for the false positives on
  // tests/fixtures/schema-probes/.../missing-credential-policy.json and
  // live-fake-no-creds.json). Secret VALUES inside any file are the content
  // rules' job.
  assert.ok(scanFilename("credentials.json", "x").length > 0);
  assert.ok(scanFilename("creds.json", "x").length > 0);
  assert.ok(scanFilename("credentials.prod.json", "x").length > 0);
  assert.ok(scanFilename("api-keys.json", "x").length > 0);
  assert.deepEqual(scanFilename("missing-credential-policy.json", "x"), []);
  assert.deepEqual(scanFilename("credential-policy.json", "x"), []);
  assert.deepEqual(scanFilename("live-fake-no-creds.json", "x"), []);
  assert.deepEqual(scanFilename("my-credentials.json", "x"), []);
  assert.deepEqual(scanFilename("notes.txt", "notes.txt"), []);
  assert.deepEqual(scanFilename("environment.json", "environment.json"), []);
});

test("scanFiles: findings never contain the raw secret", () => {
  const dir = mkdtempSync(join(tmpdir(), "treeai-scanner-test."));
  try {
    const tok = synth(48, 3);
    writeFileSync(join(dir, "leak.txt"), "leaked " + "sk-" + tok + "\n", "utf8");
    const report = scanFiles([dir], dir);
    assert.equal(report.findingCount, 1);
    const serialized = JSON.stringify(report.findings);
    assert.ok(!serialized.includes(tok), "raw token must not appear in the report");
    assert.ok(report.stats.filesScanned >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scanFiles skips node_modules and .git", () => {
  const dir = mkdtempSync(join(tmpdir(), "treeai-scanner-skip."));
  try {
    const tok = synth(48, 3);
    const nm = join(dir, "node_modules", "dep");
    const git = join(dir, ".git");
    mkdirSync(nm, { recursive: true });
    mkdirSync(git, { recursive: true });
    writeFileSync(join(nm, "leak.txt"), "sk-" + tok + "\n", "utf8");
    writeFileSync(join(git, "leak.txt"), "sk-" + tok + "\n", "utf8");
    writeFileSync(join(dir, "clean.txt"), "nothing to see\n", "utf8");
    const report = scanFiles([dir], dir);
    assert.equal(report.findingCount, 0, "skipped dirs must not be scanned");
    assert.equal(report.stats.filesScanned, 1, `only the clean file counts, got ${report.stats.filesScanned}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scanner self-test (synthetic corpus, temp dir, every rule fires, clean corpus clean)", () => {
  const result = runScannerSelfTest();
  assert.ok(result.pass, `selftest problems: ${JSON.stringify(result.problems)}`);
  assert.ok(result.rulesFired >= 23, `expected all rules to fire, fired ${result.rulesFired}`);
});
