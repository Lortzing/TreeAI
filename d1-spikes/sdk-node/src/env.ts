/**
 * TreeAI D1 spike - environment snapshot (no secrets).
 *
 * Records how the probe was run: Node/npm versions, Pi package version,
 * model selection, and credential AVAILABILITY (booleans only). Values of
 * credentials are never read or written here.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { SDK_NODE_DIR } from "./paths.js";
import { PROBE_THINKING_LEVEL } from "./prompts.js";

export interface EnvironmentSnapshot {
  capturedAt: string;
  runtime: {
    node: string;
    npm: string;
    platform: string;
    arch: string;
  };
  pi: {
    packageName: string;
    packageVersion: string;
    globalCliVersion: string | null;
    agentDir: string;
    agentDirAuthFileExists: boolean;
    agentDirModelsFileExists: boolean;
  };
  probe: {
    implementation: "sdk-node";
    thinkingLevel: string;
    modelOverride: string | null;
    envApiKeyNamesPresent: string[];
  };
}

/** Names of env vars we check for presence (booleans only, never values). */
const ENV_KEY_NAMES = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "XAI_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
];

function runSafe(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout: 10_000 }).trim();
  } catch {
    return null;
  }
}

export function captureEnvironment(): EnvironmentSnapshot {
  const piPackageJsonPath = join(
    SDK_NODE_DIR,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "package.json",
  );
  let packageVersion = "unknown";
  if (existsSync(piPackageJsonPath)) {
    try {
      packageVersion = (JSON.parse(readFileSync(piPackageJsonPath, "utf8")) as { version: string }).version;
    } catch {
      packageVersion = "unparseable";
    }
  }
  const agentDir = join(homedir(), ".pi", "agent");
  return {
    capturedAt: new Date().toISOString(),
    runtime: {
      node: process.version,
      npm: runSafe("npm", ["--version"]) ?? "unknown",
      platform: process.platform,
      arch: process.arch,
    },
    pi: {
      packageName: "@earendil-works/pi-coding-agent",
      packageVersion,
      globalCliVersion: runSafe("pi", ["--version"]),
      agentDir,
      agentDirAuthFileExists: existsSync(join(agentDir, "auth.json")),
      agentDirModelsFileExists: existsSync(join(agentDir, "models.json")),
    },
    probe: {
      implementation: "sdk-node",
      thinkingLevel: PROBE_THINKING_LEVEL,
      modelOverride: process.env.PI_PROBE_MODEL ?? null,
      envApiKeyNamesPresent: ENV_KEY_NAMES.filter((name) => {
        const v = process.env[name];
        return typeof v === "string" && v.length > 0;
      }),
    },
  };
}
