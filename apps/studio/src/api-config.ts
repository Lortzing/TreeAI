import type { PiRuntimeCredentials } from "@treeai/runtime-pi";
/** API-only connection profiles. No SDK imports, login state or credential files. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const API_FORMATS = ["anthropic-messages", "openai-completions", "openai-responses", "google-generative-ai"] as const;
type ApiFormat = typeof API_FORMATS[number];
type ObjectValue = Record<string, unknown>;
export interface ApiModel {
  readonly id: string;
  readonly name: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly reasoning: boolean;
  readonly input: ("text" | "image")[];
}
export interface ApiProvider {
  readonly api: ApiFormat;
  readonly baseUrl: string;
  readonly apiKeyEnv: string;
  readonly headerEnv: Readonly<Record<string, string>>;
  readonly models: readonly ApiModel[];
}
export interface ApiConfig { readonly providers: Readonly<Record<string, ApiProvider>> }
const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;
function reject(field: string): never { throw new Error(`Invalid API configuration: ${field}`); }
function object(value: unknown, field: string): ObjectValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return reject(field);
  return value as ObjectValue;
}
function keys(value: ObjectValue, allowed: readonly string[], field: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) reject(field);
}
function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "" || /[\r\n\x00]/.test(value)) return reject(field);
  return value;
}
function positive(value: unknown, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return reject(field);
  return value;
}
export function parseApiConfig(value: unknown): ApiConfig {
  const root = object(value, "root");
  keys(root, ["providers"], "root fields (only API providers are supported)");
  const source = object(root.providers, "providers");
  if (Object.keys(source).length === 0) reject("providers must not be empty");
  const providers: Record<string, ApiProvider> = Object.create(null);
  for (const [id, raw] of Object.entries(source)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id) || ["__proto__", "constructor", "prototype"].includes(id)) reject("provider ID");
    const p = object(raw, "provider");
    keys(p, ["api", "baseUrl", "apiKeyEnv", "headerEnv", "models"], "provider fields (API keys must use environment references; OAuth/token-plan login is unsupported)");
    if (!API_FORMATS.includes(p.api as ApiFormat)) reject("unsupported API format");
    const baseUrl = string(p.baseUrl, "baseUrl");
    let url: URL;
    try { url = new URL(baseUrl); } catch { return reject("baseUrl"); }
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && local)) || url.username || url.password || url.search || url.hash || /[$!]/.test(baseUrl)) reject("baseUrl must be HTTPS or loopback HTTP without credentials, query or fragment");
    const apiKeyEnv = string(p.apiKeyEnv, "apiKeyEnv");
    if (!envName.test(apiKeyEnv)) reject("apiKeyEnv must name an environment variable");
    const headerEnv: Record<string, string> = Object.create(null);
    for (const [header, rawEnv] of Object.entries(p.headerEnv === undefined ? {} : object(p.headerEnv, "headerEnv"))) {
      if (!/^[A-Za-z0-9-]+$/.test(header) || ["host", "content-length", "transfer-encoding", "connection"].includes(header.toLowerCase())) reject("headerEnv header name");
      const name = string(rawEnv, "headerEnv variable");
      if (!envName.test(name)) reject("headerEnv must name environment variables");
      headerEnv[header] = name;
    }
    if (!Array.isArray(p.models) || p.models.length === 0) reject("models must not be empty");
    const seen = new Set<string>();
    const models = p.models.map((rawModel): ApiModel => {
      const m = object(rawModel, "model");
      keys(m, ["id", "name", "contextWindow", "maxTokens", "reasoning", "input"], "model fields");
      const modelId = string(m.id, "model ID");
      if (/[$!]/.test(modelId) || seen.has(modelId)) reject("model ID must be unique and literal");
      seen.add(modelId);
      const contextWindow = positive(m.contextWindow, 32768, "contextWindow");
      const maxTokens = positive(m.maxTokens, 4096, "maxTokens");
      if (maxTokens > contextWindow) reject("maxTokens exceeds contextWindow");
      if (m.reasoning !== undefined && typeof m.reasoning !== "boolean") reject("reasoning");
      const input = m.input ?? ["text"];
      if (!Array.isArray(input) || input.length === 0 || input.some((v) => v !== "text" && v !== "image") || new Set(input).size !== input.length) reject("model input");
      return { id: modelId, name: m.name === undefined ? modelId : string(m.name, "model name"), contextWindow, maxTokens, reasoning: m.reasoning === true, input: input as ("text" | "image")[] };
    });
    providers[id] = { api: p.api as ApiFormat, baseUrl, apiKeyEnv, headerEnv, models };
  }
  return { providers };
}
export function loadApiConfig(path: string): ApiConfig {
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error("API configuration could not be read as JSON (contents withheld)"); }
  return parseApiConfig(value);
}
export function validateApiSelection(config: ApiConfig, providerId: string, modelId: string): void {
  if (!Object.hasOwn(config.providers, providerId) || !config.providers[providerId]?.models.some((m) => m.id === modelId)) reject("selected provider/model is not declared");
}
export function prepareApiConfig(config: ApiConfig, options: {
  readonly dataDir: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly terminologyProviderId: string;
  readonly terminologyModelId: string;
}, env: Readonly<Record<string, string | undefined>>): {
  readonly agentDir: string;
  readonly credentials: PiRuntimeCredentials;
  readonly secrets: readonly string[];
} {
  for (const [providerId, modelId] of [[options.providerId, options.modelId], [options.terminologyProviderId, options.terminologyModelId]]) {
    validateApiSelection(config, providerId!, modelId!);
  }
  const providers: Record<string, unknown> = Object.create(null);
  const secrets: string[] = [];
  const providerKeys: Record<string, string> = Object.create(null);
  const providerHeaders: Record<string, Record<string, string>> = Object.create(null);
  for (const [id, p] of Object.entries(config.providers)) {
    for (const name of [p.apiKeyEnv, ...Object.values(p.headerEnv)]) {
      const value = env[name];
      if (typeof value !== "string" || value.trim() === "" || /[\r\n\x00]/.test(value)) throw new Error(`API configuration requires environment variable ${name}`);
      secrets.push(value);
    }
    providerKeys[id] = env[p.apiKeyEnv]!;
    providerHeaders[id] = Object.fromEntries(Object.entries(p.headerEnv).map(([header, name]) => [header, env[name]!]));
    providers[id] = { api: p.api, baseUrl: p.baseUrl, apiKey: '${' + p.apiKeyEnv + '}',
      headers: Object.fromEntries(Object.entries(p.headerEnv).map(([header, name]) => [header, '${' + name + '}'])), models: p.models };
  }
  const agentDir = join(options.dataDir, "api-agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers }, null, 2) + "\n", { mode: 0o600 });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [], extensions: [], skills: [], prompts: [] }) + "\n", { mode: 0o600 });
  return { agentDir, credentials: { providerId: options.providerId, apiKey: env[config.providers[options.providerId]!.apiKeyEnv]!, providerKeys, providerHeaders }, secrets };
}
