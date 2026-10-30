import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const SECURITY_EXECUTABLE = "/usr/bin/security";
const TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 16_384;
const ITEM_NOT_FOUND_EXIT_CODE = 44;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface CredentialStore {
  supported: boolean;
  backend: string;
  get(name: string): Promise<string | null>;
  has?(name: string): Promise<boolean>;
  set(name: string, value: string): Promise<void>;
  remove(name: string): Promise<void>;
}

export interface CredentialStoreCommand {
  executable: string;
  args: readonly string[];
  input?: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface CredentialStoreCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export type CredentialStoreCommandRunner = (command: CredentialStoreCommand) => Promise<CredentialStoreCommandResult>;

export interface CredentialStoreOptions {
  platform?: string;
  run?: CredentialStoreCommandRunner;
}

export interface CredentialEnvironmentProvider {
  apiKeyEnv?: string;
  headerEnv?: Record<string, string>;
}

export interface CredentialEnvironmentConfig {
  providers: Record<string, CredentialEnvironmentProvider>;
}

function runSecurity(command: CredentialStoreCommand): Promise<CredentialStoreCommandResult> {
  return new Promise((resolveResult) => {
    const child = execFile(command.executable, [...command.args], {
      encoding: "utf8",
      maxBuffer: Math.min(command.maxOutputBytes, MAX_OUTPUT_BYTES),
      shell: false,
      timeout: Math.min(command.timeoutMs, TIMEOUT_MS),
    }, (error, stdout, stderr) => {
      resolveResult({
        exitCode: error ? (typeof error.code === "number" ? error.code : null) : 0,
        stdout: String(stdout),
        stderr: String(stderr),
      });
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(command.input);
  });
}

function quoteInteractiveToken(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function removeOutputNewline(value: string): string {
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n")) return value.slice(0, -1);
  return value;
}

function validateName(name: string): void {
  if (!ENV_NAME.test(name)) throw new Error("Invalid credential name");
}

function validateSecret(value: string): void {
  if (value.length === 0 || value.trim().length === 0 || value.length > MAX_OUTPUT_BYTES || /[\r\n\0]/.test(value)) {
    throw new Error("Invalid credential value");
  }
}

function failure(): Error {
  return new Error("Credential store operation failed");
}

export function createCredentialStore(dataDir: string, options: CredentialStoreOptions = {}): CredentialStore {
  const supported = (options.platform ?? process.platform) === "darwin";
  const service = `com.treeai.credential-store.${createHash("sha256").update(resolve(dataDir)).digest("hex")}`;
  const run = options.run ?? runSecurity;

  function assertSupported(): void {
    if (!supported) throw new Error("Credential store is unsupported on this platform");
  }

  async function execute(command: CredentialStoreCommand): Promise<CredentialStoreCommandResult> {
    try {
      return await run(command);
    } catch {
      throw failure();
    }
  }

  function command(args: readonly string[], input?: string): CredentialStoreCommand {
    return {
      executable: SECURITY_EXECUTABLE,
      args,
      ...(input === undefined ? {} : { input }),
      timeoutMs: TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    };
  }

  return {
    supported,
    backend: supported ? "macos-keychain" : "unsupported",
    async has(name) {
      assertSupported(); validateName(name);
      const result = await execute(command(["find-generic-password", "-s", service, "-a", name]));
      if (result.exitCode === ITEM_NOT_FOUND_EXIT_CODE) return false;
      if (result.exitCode !== 0) throw failure();
      return true;
    },
    async get(name) {
      assertSupported();
      validateName(name);
      const result = await execute(command(["find-generic-password", "-s", service, "-a", name, "-w"]));
      if (result.exitCode === ITEM_NOT_FOUND_EXIT_CODE) return null;
      if (result.exitCode !== 0) throw failure();
      const value = removeOutputNewline(result.stdout);
      try { validateSecret(value); } catch { throw failure(); }
      return value;
    },
    async set(name, value) {
      assertSupported();
      validateName(name);
      validateSecret(value);
      const input = `add-generic-password -U -s ${quoteInteractiveToken(service)} -a ${quoteInteractiveToken(name)} -w ${quoteInteractiveToken(value)}\n`;
      const result = await execute(command(["-i"], input));
      if (result.exitCode !== 0) throw failure();
      // Interactive security can exit successfully even when a command failed.
      if (await this.get(name) !== value) throw failure();
    },
    async remove(name) {
      assertSupported();
      validateName(name);
      const result = await execute(command(["delete-generic-password", "-s", service, "-a", name]));
      if (result.exitCode !== 0 && result.exitCode !== ITEM_NOT_FOUND_EXIT_CODE) throw failure();
    },
  };
}

export async function resolveCredentialEnvironment(
  config: CredentialEnvironmentConfig,
  baseEnv: Record<string, string | undefined>,
  store: CredentialStore,
): Promise<Record<string, string | undefined>> {
  const resolved: Record<string, string | undefined> = { ...baseEnv };
  if (!store.supported) return resolved;

  const names = new Set<string>();
  for (const provider of Object.values(config.providers)) {
    if (provider.apiKeyEnv) names.add(provider.apiKeyEnv);
    for (const name of Object.values(provider.headerEnv ?? {})) names.add(name);
  }

  await Promise.all([...names].map(async (name) => {
    if (baseEnv[name]?.trim()) return;
    const value = await store.get(name);
    if (value !== null) Object.defineProperty(resolved, name, { value, writable: true, enumerable: true, configurable: true });
  }));
  return resolved;
}
