/**
 * 失败分类与脱敏：errors.ts / redact.ts 纯函数单测。
 * 覆盖：8 类封闭编码的消息映射、优先级顺序、TreeAIError 透传、
 * policy 标记、cause 保留、构造时脱敏、redactText 规则。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyPiFailure,
  isPolicyDenied,
  markAsPolicyDenied,
  POLICY_DENIED_MARKER,
  TreeAIRuntimeError,
  authError,
} from "../../src/errors.ts";
import { redactJsonValue, redactText, setHomedirForTesting } from "../../src/redact.ts";

function codeOf(input: unknown): string | undefined {
  return (classifyPiFailure(input) as { code?: string }).code;
}

test("classifyPiFailure maps message patterns to the 8 closed codes", () => {
  // auth
  assert.equal(codeOf(new Error("Request failed with status 401")), "auth");
  assert.equal(codeOf(new Error("Unauthorized: invalid API key")), "auth");
  assert.equal(codeOf(new Error("403 Forbidden for this model")), "auth");
  // model-unavailable
  assert.equal(codeOf(new Error("No models available")), "model-unavailable");
  assert.equal(codeOf(new Error("model not found: provider/x")), "model-unavailable");
  assert.equal(codeOf(new Error("Unknown model requested")), "model-unavailable");
  // user-abort
  const abortErr = new Error("The operation was aborted");
  abortErr.name = "AbortError";
  assert.equal(codeOf(abortErr), "user-abort");
  assert.equal(codeOf(new Error("This run was aborted by the user")), "user-abort");
  // timeout
  assert.equal(codeOf(new Error("Request timed out after 60000ms")), "timeout");
  assert.equal(codeOf(Object.assign(new Error("connect ETIMEDOUT 1.2.3.4:443"), { code: "ETIMEDOUT" })), "timeout");
  // upstream
  assert.equal(codeOf(new Error("HTTP 503 Service Unavailable")), "upstream");
  assert.equal(codeOf(new Error("Overloaded 529")), "upstream");
  assert.equal(codeOf(new Error("fetch failed: ECONNREFUSED")), "upstream");
  // session-corrupt
  assert.equal(codeOf(new Error("Session file is not a valid pi session")), "session-corrupt");
  assert.equal(codeOf(new Error("Failed to parse session data")), "session-corrupt");
  // unknown
  assert.equal(codeOf(new Error("something inexplicable happened")), "unknown");
  assert.equal(codeOf("a plain string failure"), "unknown");
  assert.equal(codeOf(undefined), "unknown");
});

test("classification precedence: timeout > auth > model-unavailable > abort > upstream", () => {
  assert.equal(codeOf(new Error("operation timed out and was aborted")), "timeout");
  assert.equal(codeOf(new Error("got 401 then a 502 bad gateway")), "auth");
  assert.equal(codeOf(new Error("no model selected after the request aborted")), "model-unavailable");
  assert.equal(codeOf(new Error("request aborted: upstream 500")), "user-abort");
  assert.equal(codeOf(new Error("rate limit hit")), "upstream", "non-matching text falls through to upstream pattern");
});

test("TreeAIError instances pass through unchanged (identity)", () => {
  const err = authError("auth needed", { details: { providerId: "p" } });
  assert.equal(classifyPiFailure(err), err, "same object identity");

  // 结构满足 TreeAIError 的普通对象同样透传（跨副本防御）。
  const structural = { code: "upstream", message: "structural", details: undefined } as const;
  const result = classifyPiFailure(structural);
  assert.equal(result, structural);

  // Node 系统错误也带字符串 code（ENOENT/ETIMEDOUT/...），
  // 不得被误当 TreeAIError 透传——必须走消息分类。
  const sysTimeout = Object.assign(new Error("connect ETIMEDOUT 1.2.3.4:443"), { code: "ETIMEDOUT" });
  assert.equal(codeOf(sysTimeout), "timeout");
  const sysNetwork = Object.assign(new Error("fetch failed: ECONNREFUSED"), { code: "ECONNREFUSED" });
  assert.equal(codeOf(sysNetwork), "upstream");
});

test("policy marker wins over message classification", () => {
  const err = new Error("blocked by policy: 401 unauthorized timeout nonsense");
  markAsPolicyDenied(err);
  const classified = classifyPiFailure(err);
  assert.equal((classified as { code?: string }).code, "policy-denied");
  assert.ok(isPolicyDenied(err));
  assert.equal(isPolicyDenied(new Error("no marker")), false);
  assert.notEqual(classified, err, "marker path wraps the original as cause");
  assert.equal((classified as { cause?: unknown }).cause, err, "original preserved as cause");
});

test("cause and fallback message handling", () => {
  const original = new Error("");
  const viaFallback = classifyPiFailure(original, "fallback text");
  assert.equal((viaFallback as { message?: string }).message, "fallback text");
  assert.equal((viaFallback as { cause?: unknown }).cause, original);

  // 空 fallback 时给确定性默认。
  const viaDefault = classifyPiFailure(new Error(""), undefined);
  assert.ok(((viaDefault as { message?: string }).message ?? "").length > 0);

  // errorToMessage 输出 name: message。
  const named = classifyPiFailure(new TypeError("boom"));
  assert.ok((named as { message?: string }).message?.includes("TypeError"));
});

test("TreeAIRuntimeError redacts message and details at construction", () => {
  const fakeHome = join(tmpdir(), "treeai-redact-home");
  setHomedirForTesting(fakeHome);
  try {
    const err = authError(
      `Authorization: Bearer sk-live-abcdef1234567890 rejected for ${join(fakeHome, "project")}`,
      { details: { header: "Bearer sk-live-abcdef1234567890", nested: { note: "api_key=abcd1234efgh5678" } } },
    );
    const message = err.message;
    assert.ok(!message.includes("sk-live-abcdef1234567890"), "bearer key not leaked");
    assert.ok(!message.includes(fakeHome), "home directory not leaked");
    assert.ok(message.includes("[REDACTED]"));

    const details = JSON.stringify(err.details ?? {});
    assert.ok(!details.includes("sk-live-abcdef1234567890"), "details redacted recursively");
    assert.ok(!details.includes("abcd1234efgh5678"), "credential field value redacted");

    // cause 保留原始错误（未脱敏——持久化前由 event-journal 处理，见 errors.ts 注释）。
    const cause = new Error("Authorization: Bearer sk-live-abcdef1234567890");
    const withCause = authError("wrapped", { cause });
    assert.equal((withCause as { cause?: unknown }).cause, cause);
  } finally {
    setHomedirForTesting(null);
  }
});

test("TreeAIRuntimeError is a real Error subclass satisfying the contract shape", () => {
  const err = authError("x");
  assert.ok(err instanceof Error);
  assert.ok(err instanceof TreeAIRuntimeError);
  assert.equal(err.name, "TreeAIError");
  assert.equal(err.code, "auth");
  assert.equal(typeof err.message, "string");
  assert.equal(err.details, undefined, "details omitted when not provided");
});

test("redactText rules: headers, cookies, bearer, sk-keys, credential fields, home", () => {
  // 恢复真实家目录（其他测试可能注入过假的）。
  setHomedirForTesting(null);
  const home = homedir();

  const out1 = redactText("Authorization: Bearer abc.def.ghi");
  assert.ok(!out1.includes("abc.def.ghi") && out1.includes("[REDACTED]"));

  const out2 = redactText("Cookie: session=supersecret; theme=dark");
  assert.ok(!out2.includes("supersecret"));

  const out3 = redactText("token Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig");
  assert.ok(!out3.includes("eyJhbGciOiJIUzI1NiJ9"));

  const out4 = redactText("key was sk-proj-0123456789abcdef");
  assert.ok(!out4.includes("sk-proj-0123456789abcdef"));

  const out5 = redactText('{"api_key": "value12345"}');
  assert.ok(!out5.includes("value12345"));

  const out6 = redactText(`failed reading ${join(home, "notes.txt")}`);
  assert.ok(!out6.includes(home), "home directory replaced");
  assert.ok(out6.includes("~"));

  // 非敏感文本不动。
  assert.equal(redactText("plain text about trees and models"), "plain text about trees and models");
});

test("redactJsonValue recurses arrays and nested objects; setHomedirForTesting injects", () => {
  const fakeHome = join(tmpdir(), "treeai-fake-home-xyz");
  setHomedirForTesting(fakeHome);
  try {
    const value = {
      a: [`path ${join(fakeHome, "deep")}`],
      b: { password: "hunter2" },
      c: 42,
    };
    const out = JSON.stringify(redactJsonValue(value));
    assert.ok(!out.includes(fakeHome), "home-relative path redacted via injected homedir");
    assert.ok(out.includes("~"), "home replaced with tilde");
    assert.ok(!out.includes("hunter2"), "credential value redacted");
    assert.ok(out.includes("42"), "numbers pass through");
  } finally {
    setHomedirForTesting(null);
  }
});

test("POLICY_DENIED_MARKER uses a cross-realm symbol key", () => {
  assert.equal(typeof POLICY_DENIED_MARKER, "symbol");
  assert.equal(POLICY_DENIED_MARKER, Symbol.for("treeai.policyDenied"), "stable via Symbol.for");
});
