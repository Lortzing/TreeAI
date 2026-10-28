import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API_FORMATS, loadApiConfig, parseApiConfig, prepareApiConfig } from "../src/api-config.ts";
import { parseArgs } from "../src/cli.ts";
const provider = () => ({ api: "anthropic-messages", baseUrl: "http://127.0.0.1:15722", apiKeyEnv: "LOCAL_API_KEY", models: [{ id: "claude-haiku-4-5" }] });
const options = (dataDir: string) => ({ dataDir, providerId: "local", modelId: "claude-haiku-4-5", terminologyProviderId: "local", terminologyModelId: "claude-haiku-4-5" });

test("API profiles support API formats and multiple independent providers/models", () => {
  for (const api of API_FORMATS) {
    const config = parseApiConfig({ providers: { local: { ...provider(), api }, second: { ...provider(), models: [{ id: "other" }] } } });
    assert.equal(config.providers.local!.api, api);
    assert.equal(config.providers.second!.models[0]!.id, "other");
    assert.equal(config.providers.local!.models[0]!.reasoning, false);
  }
});
test("API configuration rejects inline credentials, OAuth and unknown fields without echoing values", () => {
  for (const bad of [{ apiKey: "secret-mark" }, { token: "secret-mark" }, { oauth: "secret-mark" }, { login: "secret-mark" }, { api: "secret-mark" }, { apiKeyEnv: "!secret-mark" }]) {
    assert.throws(() => parseApiConfig({ providers: { local: { ...provider(), ...bad } } }), (e: unknown) => e instanceof Error && !e.message.includes("secret-mark"));
  }
});
test("API URLs reject credentials, remote plaintext, queries and non-HTTP protocols", () => {
  for (const baseUrl of ["http://example.com", "https://user:secret@example.com", "https://example.com?key=secret", "https://example.com/#secret", "file:///secret", "!secret", "${SECRET}", "https://example.com\n"]) {
    assert.throws(() => parseApiConfig({ providers: { local: { ...provider(), baseUrl } } }), (e: unknown) => e instanceof Error && !e.message.includes("secret"));
  }
  for (const baseUrl of ["https://api.example.com/v1", "http://localhost:15722", "http://[::1]:15722"]) {
    assert.equal(parseApiConfig({ providers: { local: { ...provider(), baseUrl } } }).providers.local!.baseUrl, baseUrl);
  }
});
test("API model limits, duplicate IDs, input modalities and header references are validated", () => {
  for (const models of [[], [{ id: "x" }, { id: "x" }], [{ id: "x", maxTokens: 0 }], [{ id: "x", contextWindow: 4.5 }], [{ id: "x", contextWindow: 10, maxTokens: 11 }], [{ id: "x", reasoning: "yes" }], [{ id: "x", input: ["audio"] }]]) {
    assert.throws(() => parseApiConfig({ providers: { local: { ...provider(), models } } }));
  }
  for (const headerEnv of [{ Authorization: "Bearer secret" }, { Host: "ENV" }, { "Bad\nHeader": "ENV" }]) {
    assert.throws(() => parseApiConfig({ providers: { local: { ...provider(), headerEnv } } }));
  }
});
test("preparation stores only environment references, validates selection and missing secrets before writing", () => {
  const dir = mkdtempSync(join(tmpdir(), "treeai-api-config-"));
  try {
    const config = parseApiConfig({ providers: { local: { ...provider(), headerEnv: { "User-Agent": "CLIENT_UA" } } } });
    assert.throws(() => prepareApiConfig(config, { ...options(dir), modelId: "unknown" }, {}), /not declared/);
    assert.throws(() => prepareApiConfig(config, { ...options(dir), terminologyProviderId: "absent" }, {}), /not declared/);
    assert.throws(() => prepareApiConfig(config, options(dir), {}), /LOCAL_API_KEY/);
    assert.throws(() => prepareApiConfig(config, options(dir), { LOCAL_API_KEY: "valid", CLIENT_UA: "bad\nvalue" }), /CLIENT_UA/);
    assert.deepEqual(readdirSync(dir), []);
    const result = prepareApiConfig(config, options(dir), { LOCAL_API_KEY: "secret-value-never-write", CLIENT_UA: "private-user-agent" });
    assert.equal(result.credentials.apiKey, "secret-value-never-write");
    const saved = readFileSync(join(result.agentDir, "models.json"), "utf8");
    assert.ok(!saved.includes("secret-value-never-write"));
    assert.ok(!saved.includes("private-user-agent"));
    const p = JSON.parse(saved).providers.local;
    assert.equal(p.apiKey, "${LOCAL_API_KEY}");
    assert.equal(p.headers["User-Agent"], "${CLIENT_UA}");
    assert.equal(p.models[0].id, "claude-haiku-4-5");
    assert.deepEqual(readdirSync(result.agentDir).sort(), ["models.json", "settings.json"]);
    assert.throws(() => loadApiConfig(join(dir, "missing.json")), /contents withheld/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("CLI API profiles require a server Pi driver and own a controlled directory", () => {
  const flags = ["--driver", "pi", "--provider", "local", "--model", "claude-haiku-4-5", "--api-config", "./api.json"];
  assert.ok(parseArgs(flags).apiConfigPath!.endsWith("/api.json"));
  assert.throws(() => parseArgs(["--api-config", "api.json"]), /requires --driver pi/);
  assert.throws(() => parseArgs([...flags, "--agent-dir", "/tmp/agent"]), /omit --agent-dir/);
  assert.throws(() => parseArgs([...flags, "--import-package", "/tmp/import"]), /server mode/);
});
