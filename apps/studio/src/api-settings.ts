/** Local API configuration management. Product facts and live sessions are never rewritten. */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiRuntime } from "@treeai/runtime-pi";
import { parseApiConfig, prepareApiConfig, validateApiSelection, type ApiConfig } from "./api-config.ts";
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
  private readonly options: { dataDir: string; initial: SavedApiSettings | null; env: Readonly<Record<string, string | undefined>>; probe?: typeof probeApiConnection };
  private current: SavedApiSettings | null;
  private readonly initialRevision: string;
  private probing = false;
  private configurationWarning = false;
  constructor(options: { dataDir: string; initial: SavedApiSettings | null; env: Readonly<Record<string, string | undefined>>; probe?: typeof probeApiConnection }) {
    this.options = options;
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
      revision: revision(this.current), restartRequired: revision(this.current) !== this.initialRevision,
      environment: [...names].map((name) => ({ name, present: !!this.options.env[name]?.trim() })) };
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
    try { return await (this.options.probe ?? probeApiConnection)(next, this.options.env); }
    finally { this.probing = false; }
  }
}
