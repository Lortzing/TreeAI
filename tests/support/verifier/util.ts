/**
 * Shared utilities for the D2 verifier support library (Agent F).
 * Zero dependencies; Node built-ins only.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root (the tree that contains tests/support/verifier). */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** UTC ISO 8601 timestamp with millisecond precision, Z suffix. */
export function utcNowIso(): string {
  return new Date().toISOString();
}

/**
 * UTC run id for evidence directories: sortable, filesystem-safe, and
 * collision-guarded by the evidence writer (never reused).
 */
export function utcRunId(prefix: string): string {
  const now = new Date();
  const pad = (n: number, w: number): string => String(n).padStart(w, "0");
  return (
    `${prefix}-${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1, 2)}${pad(now.getUTCDate(), 2)}` +
    `T${pad(now.getUTCHours(), 2)}${pad(now.getUTCMinutes(), 2)}${pad(now.getUTCSeconds(), 2)}` +
    `${pad(now.getUTCMilliseconds(), 3)}Z`
  );
}

export interface CommandOutcome {
  /** Process exit status, or null when the process died on a signal / never ran. */
  status: number | null;
  signal: NodeJS.Signals | null;
  /** true when the run was killed by our timeout. */
  timedOut: boolean;
  stdout: string;
  stderr: string;
  /** Wall-clock duration in ms. */
  durationMs: number;
  error?: string;
}

export interface RunCommandOptions {
  cwd?: string;
  timeoutMs?: number;
  /** Max bytes kept per stream (tail-preserved). Default 1 MiB. */
  maxBufferBytes?: number;
  env?: Record<string, string>;
}

/**
 * Spawn a command synchronously with a hard timeout and stream caps.
 * Never throws for non-zero exits — the caller decides what a non-zero exit
 * MEANS (PASS/FAIL/BLOCKED/NOT_RUN mapping is policy, not mechanics).
 */
export function runCommand(
  command: string,
  args: readonly string[],
  options: RunCommandOptions = {},
): CommandOutcome {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 300_000;
  const maxBufferBytes = options.maxBufferBytes ?? 1024 * 1024;
  try {
    const res = spawnSync(command, [...args], {
      cwd: options.cwd,
      timeout: timeoutMs,
      maxBuffer: maxBufferBytes,
      encoding: "utf8",
      env: options.env ? { ...process.env, ...options.env } : process.env,
    });
    const durationMs = Date.now() - started;
    if (res.error) {
      return {
        status: res.status,
        signal: res.signal ?? null,
        timedOut: res.error.message.includes("ETIMEDOUT") || (res.signal === "SIGTERM" && res.status === null),
        stdout: (res.stdout as string | null) ?? "",
        stderr: `${(res.stderr as string | null) ?? ""}${res.error.message}`,
        durationMs,
        error: res.error.message,
      };
    }
    return {
      status: res.status,
      signal: res.signal ?? null,
      timedOut: res.signal === "SIGTERM" && res.status === null,
      stdout: (res.stdout as string | null) ?? "",
      stderr: (res.stderr as string | null) ?? "",
      durationMs,
    };
  } catch (err) {
    return {
      status: null,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      durationMs: Date.now() - started,
      error: String(err),
    };
  }
}

/** Read+parse JSON; returns null (never throws) when unreadable/invalid. */
export function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/** Package.json of a workspace package, or null. */
export function readPackageJson(dir: string): Record<string, unknown> | null {
  const p = join(dir, "package.json");
  if (!existsSync(p)) return null;
  const parsed = readJson(p);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return null;
}

/** Truncate a string for `detail` fields, keeping head and tail. */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const head = Math.floor(maxLength / 2);
  const tail = maxLength - head - 15;
  return `${text.slice(0, head)}\n...[truncated ${text.length - maxLength} chars]...\n${text.slice(-Math.max(tail, 0))}`;
}

/** Last non-empty lines of a command output (for error detail). */
export function tailLines(text: string, count: number): string {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  return lines.slice(-count).join("\n");
}
