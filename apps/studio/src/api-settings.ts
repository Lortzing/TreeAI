/** Local API configuration management. Product facts and live sessions are never rewritten. */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiRuntime } from "@treeai/runtime-pi";
import { parseApiConfig, prepareApiConfig, validateApiSelection, type ApiConfig } from "./api-config.ts";
import { createCredentialStore, resolveCredentialEnvironment, type CredentialStore } from "./credential-store.ts";
export interface ApiSelection { readonly providerId: string; readonly modelId: string }
export interface SavedApiSettings { readonly config: ApiConfig; readonly selection: ApiSelection }
export function parseApiSettings(value: unknown): SavedApiSettings {
  if (!value || typeof value !== "object") throw new Error("Invalid API settings");
  const input = value as Record<string, unknown>;
  const config = parseApiConfig(input.config);
  const s = input.selection as Record<string, unknown> | undefined;
  if (!s || typeof s.providerId !== "string" || typeof s.modelId !== "string") throw new Error("Select an API provider and model");
  validateApiSelection(config, s.providerId, s.modelId);
  return { config, selection: { providerId: s.providerId, modelId: s.modelId } };
}
export function readSavedApiSettings(dataDir: string): SavedApiSettings | null {
  const file = join(dataDir, "api-settings.json");
  if (!existsSync(file)) return null;
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, "utf8")); }
  catch { throw new Error("Saved API settings could not be read (contents withheld)"); }
  return parseApiSettings(value);
}
function revision(settings: SavedApiSettings | null): string {
  return createHash("sha256").update(JSON.stringify(settings)).digest("hex");
}
export async function probeApiConnection(settings: SavedApiSettings, env: Readonly<Record<string, string | undefined>>): Promise<{ ok: boolean; code: string; message: string }> {
  const root = mkdtempSync(join(tmpdir(), "treeai-api-probe-"));
  let runtime: ReturnType<typeof createPiRuntime> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { providerId, modelId } = settings.selection;
    const prepared = prepareApiConfig(settings.config, { dataDir: root, providerId, modelId, terminologyProviderId: providerId, terminologyModelId: modelId }, env);
    runtime = createPiRuntime({ agentDir: prepared.agentDir, defaultCwd: root, credentials: prepared.credentials });
    const run = async () => {
      await runtime!.createSession({ model: { providerId, modelId }, cwd: root, sessionDir: join(root, "sessions") });
      const result = await runtime!.prompt({ text: "Reply with the single word OK." });
      if (!result.message.trim()) throw new Error("empty-api-response");
    };
    await Promise.race([run(), new Promise<never>((_, reject) => { timer = setTimeout(() => { void runtime?.abort(); reject(new Error("probe-timeout")); }, 25000); })]);
    return { ok: true, code: "connected", message: "API 连接成功，模型已完成实际请求。" };
  } catch (error) {
    const timedOut = error instanceof Error && error.message === "probe-timeout";
    return { ok: false, code: timedOut ? "timeout" : "connection-failed", message: timedOut ? "连接测试超时，请检查服务地址与模型状态。" : "连接失败，请检查接口格式、地址、模型和凭据环境变量。" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    try { await runtime?.dispose(); } finally { rmSync(root, { recursive: true, force: true }); }
  }
}
export class ApiSettingsService {
  private readonly options: { dataDir: string; initial: SavedApiSettings | null; env: Readonly<Record<string, string | undefined>>; probe?: typeof probeApiConnection; credentialStore?: CredentialStore };
  private current: SavedApiSettings | null;
  private readonly initialRevision: string;
  private probing = false;
  private configurationWarning = false;
  private readonly store: CredentialStore;
  private storedNames = new Set<string>();
  constructor(options: { dataDir: string; initial: SavedApiSettings | null; env: Readonly<Record<string, string | undefined>>; probe?: typeof probeApiConnection; credentialStore?: CredentialStore }) {
    this.options = options;
    this.store = options.credentialStore ?? createCredentialStore(options.dataDir);
    try { this.current = readSavedApiSettings(options.dataDir) ?? options.initial; }
    catch { this.current = options.initial; this.configurationWarning = true; }
    this.initialRevision = revision(options.initial);
  }
  snapshot() {
    const names = new Set<string>();
    for (const provider of Object.values(this.current?.config.providers ?? {})) {
      names.add(provider.apiKeyEnv);
      for (const name of Object.values(provider.headerEnv)) names.add(name);
    }
    return { enabled: true, configured: this.current !== null, configurationWarning: this.configurationWarning,
      config: this.current?.config ?? { providers: {} }, selection: this.current?.selection ?? { providerId: "", modelId: "" },
      credentialStore: { supported: this.store.supported, backend: this.store.backend },
      revision: revision(this.current), restartRequired: revision(this.current) !== this.initialRevision,
      environment: [...names].map((name) => ({ name, present: !!this.options.env[name]?.trim() || this.storedNames.has(name), stored: this.storedNames.has(name), source: this.options.env[name]?.trim() ? "environment" : this.storedNames.has(name) ? "keychain" : "missing" })) };
  }
  async refreshCredentials() {
    this.storedNames.clear();
    if (!this.store.supported || this.current === null) return;
    for (const provider of Object.values(this.current.config.providers)) {
      try {
        const present = this.store.has ? await this.store.has(provider.apiKeyEnv) : await this.store.get(provider.apiKeyEnv) !== null;
        if (present) this.storedNames.add(provider.apiKeyEnv);
      }
      catch { /* A locked keychain remains unavailable; API use fails honestly. */ }
    }
  }
  async credential(value: unknown, remove = false) {
    const settings = parseApiSettings(value);
    const name = settings.config.providers[settings.selection.providerId]!.apiKeyEnv;
    if (remove) { await this.store.remove(name); this.storedNames.delete(name); }
    else {
      const secret = (value as Record<string, unknown>).value;
      if (typeof secret !== "string") throw new Error("invalid-credential");
      await this.store.set(name, secret); this.storedNames.add(name);
    }
    return { ok: true, stored: !remove, environmentOverride: !!this.options.env[name]?.trim(), backend: this.store.backend };
  }
  save(value: unknown) {
    const input = value as Record<string, unknown> | null;
    if (input?.revision !== revision(this.current)) throw new Error("settings-conflict");
    const next = parseApiSettings(value);
    const path = join(this.options.dataDir, "api-settings.json");
    const temp = path + ".tmp";
    try {
      writeFileSync(temp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
      renameSync(temp, path);
    } finally { rmSync(temp, { force: true }); }
    this.current = next;
    this.configurationWarning = false;
    return this.snapshot();
  }
  async test(value: unknown) {
    if (this.probing) throw new Error("probe-busy");
    const next = parseApiSettings(value);
    this.probing = true;
    try {
      const names = Object.values(next.config.providers).flatMap(p => [p.apiKeyEnv, ...Object.values(p.headerEnv)]);
      const env = !this.store.supported || names.every(name => this.options.env[name]?.trim()) ? this.options.env
        : await resolveCredentialEnvironment(next.config, this.options.env, this.store);
      return await (this.options.probe ?? probeApiConnection)(next, env);
    }
    finally { this.probing = false; }
  }
}
