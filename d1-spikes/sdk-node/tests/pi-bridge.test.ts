/**
 * Pi bridge tests: capability checks against the installed Pi SDK package
 * (no network, no credentials) plus unit tests for pure helpers.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as Pi from "@earendil-works/pi-coding-agent";
import { classifyAndThrow, PI_API_SURFACE, PI_PACKAGE_VERSION } from "../src/pi-bridge.js";
import { BlockedError } from "../src/blocked.js";
import { SDK_NODE_DIR } from "../src/paths.js";

test("installed Pi SDK exports the API surface this probe depends on", () => {
  const pi = Pi as unknown as Record<string, unknown>;
  for (const name of [
    "createAgentSessionServices",
    "createAgentSessionFromServices",
    "SessionManager",
    "ModelRuntime",
    "VERSION",
    "DefaultResourceLoader",
    "SettingsManager",
  ]) {
    assert.ok(pi[name] !== undefined, `Pi SDK must export ${name}`);
  }
  // SessionManager factory methods used by the bridge.
  const sm = Pi.SessionManager as unknown as Record<string, unknown>;
  for (const method of ["create", "open", "inMemory", "continueRecent", "list"]) {
    assert.ok(typeof sm[method] === "function", `SessionManager.${method} must be a function`);
  }
  // ModelRuntime instance methods used via services.modelRuntime.
  const proto = Pi.ModelRuntime.prototype as unknown as Record<string, unknown>;
  for (const method of ["getModel", "getAvailable"]) {
    assert.ok(typeof proto[method] === "function", `ModelRuntime.${method} must be a function`);
  }
});

test("VERSION matches the pinned package.json dependency", () => {
  const pkg = JSON.parse(
    readFileSync(join(SDK_NODE_DIR, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), "utf8"),
  ) as { version: string };
  assert.equal(PI_PACKAGE_VERSION, pkg.version);
  assert.equal(pkg.version, "0.85.1");
});

test("Pi SDK type declarations exist (type safety evidence)", () => {
  const dts = join(
    SDK_NODE_DIR,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "index.d.ts",
  );
  assert.ok(existsSync(dts));
  const text = readFileSync(dts, "utf8");
  assert.ok(text.includes("AgentSession"));
  assert.ok(text.includes("AgentSessionEvent"));
  assert.ok(text.includes("SessionManager"));
});

test("classifyAndThrow maps auth errors to BLOCKED_CREDENTIALS", () => {
  assert.throws(
    () => classifyAndThrow("401 Unauthorized: invalid x-api-key"),
    (err: unknown) => err instanceof BlockedError && err.blockedReason === "BLOCKED_CREDENTIALS",
  );
  assert.throws(
    () => classifyAndThrow("missing API key for provider"),
    (err: unknown) => err instanceof BlockedError && err.blockedReason === "BLOCKED_CREDENTIALS",
  );
});

test("classifyAndThrow maps other errors to plain FAIL errors", () => {
  assert.throws(
    () => classifyAndThrow("socket hang up"),
    (err: unknown) => !(err instanceof BlockedError),
  );
});

test("PI_API_SURFACE inventory is non-empty and mentions dispose/abort/steer", () => {
  const keys = Object.keys(PI_API_SURFACE);
  assert.ok(keys.length >= 10);
  assert.ok(keys.some((k) => k.includes("abort")));
  assert.ok(keys.some((k) => k.includes("steer")));
  assert.ok(keys.some((k) => k.includes("dispose")));
});
