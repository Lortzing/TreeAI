/**
 * 脱敏测试（任务书 §5 Agent E 第 6 项）：
 * - secret corpus 全部脱敏，且 findRemainingSecrets 复查无残留；
 * - clean corpus 不被破坏（deepEqual 原样保留）；
 * - 各规则类别的独立行为；
 * - 深度/循环/不可序列化防御。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REDACTION_VERSION,
  deepRedact,
  findRemainingSecrets,
  redactString,
  redactStringWithCategories,
} from "../src/redact.js";
import { SYNTH, assertNoSynthSecrets } from "./helpers.js";

const MARKER = `[REDACTED:${REDACTION_VERSION}]`;

/* ------------------------------------------------------------------ */
/* Secret corpus：全部脱敏 + 复查无残留                                */
/* ------------------------------------------------------------------ */

test("secret corpus: every synthetic secret is redacted and re-scan finds nothing", () => {
  const corpus = {
    anthropicKey: SYNTH.anthropicKey,
    openaiKey: SYNTH.openaiKey,
    genericKey: SYNTH.genericKey,
    githubToken: SYNTH.githubToken,
    googleKey: SYNTH.googleKey,
    xaiKey: SYNTH.xaiKey,
    bearerHeader: `Authorization: Bearer ${SYNTH.bearerValue}`,
    basicHeader: `Authorization: Basic ${SYNTH.bearerValue}`,
    xApiKeyHeader: `x-api-key: ${SYNTH.apiKeyHeaderValue}`,
    cookieHeader: `Cookie: session=${SYNTH.cookieValue}; tracking=${SYNTH.cookieValue}`,
    setCookieHeader:
      `Set-Cookie: sid=${SYNTH.cookieValue}; Path=/; Domain=example.com; ` +
      `Expires=Wed, 21 Oct 2026 07:28:00 GMT; Max-Age=3600; SameSite=Lax; Secure; HttpOnly`,
    urlWithUserinfo: `https://${SYNTH.homeAlice}:${SYNTH.urlPassword}@api.provider.example.com/v1/chat`,
    urlWithSecretQuery: `https://api.provider.example.com/v1/chat?key=${SYNTH.urlQueryValue}&model=claude-sonnet-5`,
    urlWithAccessToken: `https://api.provider.example.com/callback?access_token=${SYNTH.urlQueryValue}`,
    envAssignment: `MY_SERVICE_API_KEY=${SYNTH.envValue}`,
    envToken: `SESSION_TOKEN=${SYNTH.envValue}`,
    sensitiveJsonKeys: {
      apiKey: SYNTH.anthropicKey,
      authorization: `Bearer ${SYNTH.bearerValue}`,
      cookie: `session=${SYNTH.cookieValue}`,
      password: SYNTH.envValue,
      client_secret: SYNTH.envValue,
      nested: { refreshToken: SYNTH.githubToken, deep: [{ token: SYNTH.googleKey }] },
    },
    homePaths: [
      `/Users/${SYNTH.homeAlice}/.pi/sessions/s1.jsonl`,
      `/home/${SYNTH.homeBob}/notes.txt`,
      `C:\\Users\\${SYNTH.homeCarol}\\Documents\\config.json`,
    ],
    messageBody:
      `call failed with ${SYNTH.anthropicKey} and ${SYNTH.githubToken} in the request body`,
  };

  const result = deepRedact(corpus);

  // 1) 输出中不含任何合成秘密。
  assertNoSynthSecrets("deepRedact(secret corpus)", JSON.stringify(result.value));

  // 2) 复查：无残留。
  assert.deepEqual(findRemainingSecrets(result.value), []);

  // 3) 确有规则命中。
  assert.ok(result.applied.length > 0);

  // 4) 关键位置抽查：标记替换到位。
  const out = result.value as Record<string, unknown>;
  assert.equal(out["anthropicKey"], MARKER);
  assert.equal(out["githubToken"], MARKER);
  const bearer = out["bearerHeader"] as string;
  assert.ok(bearer.startsWith("Authorization: Bearer "));
  assert.ok(bearer.includes(MARKER));
  const setCookie = out["setCookieHeader"] as string;
  assert.ok(setCookie.startsWith("Set-Cookie: sid="));
  assert.ok(setCookie.includes(MARKER));
  // Set-Cookie 属性保留（非凭据）。
  assert.ok(setCookie.includes("Path=/"));
  assert.ok(setCookie.includes("HttpOnly"));
  assert.ok(setCookie.includes("SameSite=Lax"));
  // URL：凭据脱敏，host/path 保留。
  const userinfoUrl = out["urlWithUserinfo"] as string;
  assert.ok(userinfoUrl.startsWith("https://"));
  assert.ok(userinfoUrl.includes(MARKER));
  assert.ok(userinfoUrl.includes("@api.provider.example.com/v1/chat"));
  const queryUrl = out["urlWithSecretQuery"] as string;
  assert.ok(queryUrl.includes("key=" + MARKER));
  assert.ok(queryUrl.includes("&model=claude-sonnet-5"));
  // 环境变量赋值：名字保留、值替换。
  assert.equal(out["envAssignment"], `MY_SERVICE_API_KEY=${MARKER}`);
  // 家目录规约。
  const paths = out["homePaths"] as string[];
  assert.equal(paths[0], "~/.pi/sessions/s1.jsonl");
  assert.equal(paths[1], "~/notes.txt");
  assert.equal(paths[2], "~/Documents\\config.json");
  // 敏感 JSON 键整体替换。
  const keys = out["sensitiveJsonKeys"] as Record<string, unknown>;
  assert.equal(keys["apiKey"], MARKER);
  assert.equal(keys["password"], MARKER);
  const nested = keys["nested"] as Record<string, unknown>;
  assert.equal(nested["refreshToken"], MARKER);
  const deep = nested["deep"] as { token: unknown }[];
  assert.equal(deep[0]?.token, MARKER);
});

test("string redaction: cookie names survive, values never do", () => {
  const out = redactString(`Cookie: prefs=dark; session=${SYNTH.cookieValue}`);
  assert.ok(out.startsWith("Cookie: "));
  assert.ok(out.includes("prefs=" + MARKER));
  assert.ok(out.includes("session=" + MARKER));
});

test("redactStringWithCategories reports category names, not contents", () => {
  const { value, applied } = redactStringWithCategories(
    `token ${SYNTH.anthropicKey} and Bearer ${SYNTH.bearerValue}`,
  );
  assert.ok(!value.includes(SYNTH.anthropicKey));
  assert.ok(applied.some((c) => c.startsWith("pattern:")));
  for (const category of applied) {
    // 类别名只能是白名单形态，不得夹带被替换的内容。
    assert.match(category, /^(pattern|path|key):[A-Za-z0-9_-]+$/);
  }
});

/* ------------------------------------------------------------------ */
/* Clean corpus：不被破坏                                              */
/* ------------------------------------------------------------------ */

test("clean corpus: deepRedact returns an equal structure (no over-redaction of required fields)", () => {
  const clean = {
    model: "claude-sonnet-5",
    providerUrl: "https://api.anthropic.com/v1/messages?model=claude-sonnet-5",
    userText: "请帮我总结这个分支的改动，谢谢！",
    identifiers: {
      runId: "run-000042",
      sessionId: "sess-abc-123",
      entryId: "entry-77",
      episodeId: "ep-9",
    },
    counts: { turns: 3, toolCalls: 12, ok: true, none: null },
    paths: ["/var/log/treeai/journal.jsonl", "/etc/treeai/config.json", "C:\\ProgramData\\treeai\\cfg.json"],
    timestamps: ["2026-09-21T10:00:00.000Z"],
    message: "Authorization approved by author Jane in the session-42 audit trail",
    nested: { items: [{ name: "read-file", status: "finished" }], extra: [] },
  };

  const result = deepRedact(clean);
  assert.deepEqual(result.value, clean);
  assert.deepEqual(findRemainingSecrets(result.value), []);
});

test("clean corpus: scalar and array passthrough", () => {
  assert.equal(deepRedact("hello world").value, "hello world");
  assert.equal(deepRedact(42).value, 42);
  assert.equal(deepRedact(true).value, true);
  assert.equal(deepRedact(null).value, null);
  assert.deepEqual(deepRedact(["a", 1, null, false]).value, ["a", 1, null, false]);
});

/* ------------------------------------------------------------------ */
/* 结构防御                                                            */
/* ------------------------------------------------------------------ */

test("deep nesting beyond the limit yields a depth marker without throwing", () => {
  let deep: unknown = { leaf: true };
  for (let i = 0; i < 60; i++) {
    deep = { child: deep };
  }
  const result = deepRedact(deep);
  assert.ok(result.applied.includes("depth-limit"));
  assert.ok(JSON.stringify(result.value).includes("[REDACTED:depth-limit]"));
});

test("circular references are marked, not followed forever", () => {
  const node: Record<string, unknown> = { name: "a" };
  node["self"] = node;
  const result = deepRedact(node);
  assert.ok(result.applied.includes("circular"));
  const out = result.value as Record<string, unknown>;
  assert.equal(out["name"], "a");
  assert.equal(out["self"], "[REDACTED:circular]");
});

test("unserializable values are replaced by typed markers", () => {
  const result = deepRedact({
    fn: () => 1,
    undef: undefined,
    big: 10n,
    sym: Symbol("s"),
    ok: "kept",
  });
  const out = result.value as Record<string, unknown>;
  assert.equal(out["fn"], "[UNSERIALIZABLE:function]");
  assert.equal(out["undef"], "[UNSERIALIZABLE:undefined]");
  assert.equal(out["big"], "[UNSERIALIZABLE:bigint]");
  assert.equal(out["sym"], "[UNSERIALIZABLE:symbol]");
  assert.equal(out["ok"], "kept");
  assert.ok(result.applied.includes("unserializable"));
});

test("input is never mutated", () => {
  const input = { apiKey: SYNTH.anthropicKey, keep: "value" };
  const snapshot = JSON.stringify(input);
  deepRedact(input);
  assert.equal(JSON.stringify(input), snapshot);
});

/* ------------------------------------------------------------------ */
/* 复查器                                                              */
/* ------------------------------------------------------------------ */

test("findRemainingSecrets flags unredacted values (negative control)", () => {
  const dirty = {
    apiKey: SYNTH.anthropicKey,
    cookieHeader: `Cookie: session=${SYNTH.cookieValue}`,
    homePath: `/Users/${SYNTH.homeAlice}/x`,
  };
  const found = findRemainingSecrets(dirty);
  assert.ok(found.includes("anthropic-key"));
  assert.ok(found.includes("cookie-value"));
  assert.ok(found.includes("home-path"));
  assert.ok(found.includes("unredacted-field:apiKey"));
});
