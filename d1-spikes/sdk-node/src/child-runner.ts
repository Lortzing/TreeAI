/**
 * TreeAI D1 spike - real resume child-process runner.
 *
 * Spawns `node --import tsx resume-child.ts <phase> ...` so phase A and
 * phase B run in separate OS processes. Stdout is captured (the child
 * prints one RESUME_SUMMARY JSON line); stderr is captured to a redacted
 * file for evidence. The child is killed if it exceeds its own deadline.
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SDK_NODE_DIR } from "./paths.js";
import { redactString } from "./redact.js";
import type { BlockedReason, ResumeChildRunner } from "./types.js";
import { BLOCKED_REASONS } from "./types.js";

const CHILD_TIMEOUT_MS = Number(process.env.PI_PROBE_CHILD_TIMEOUT_MS ?? 150_000);

function parseSummaryLine(stdout: string): Record<string, unknown> | undefined {
  for (const line of stdout.split("\n").reverse()) {
    if (line.startsWith("RESUME_SUMMARY ")) {
      try {
        return JSON.parse(line.slice("RESUME_SUMMARY ".length)) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

interface ChildOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runChild(args: string[], stderrLogPath: string): Promise<ChildOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", join(SDK_NODE_DIR, "src", "scenarios", "resume-child.ts"), ...args],
      {
        cwd: SDK_NODE_DIR,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, CHILD_TIMEOUT_MS);
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // Stderr is evidence too, but must be redacted before it hits disk.
      writeFileSync(stderrLogPath, redactString(stderr) || "(empty)\n");
      if (killed) {
        reject(new Error(`resume child exceeded ${CHILD_TIMEOUT_MS}ms and was killed`));
        return;
      }
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

function parseBlockedReason(value: unknown): BlockedReason | undefined {
  return typeof value === "string" && (BLOCKED_REASONS as readonly string[]).includes(value)
    ? (value as BlockedReason)
    : undefined;
}

export const realResumeChildRunner: ResumeChildRunner = {
  async phaseA(opts) {
    mkdirSync(opts.eventsDir, { recursive: true });
    mkdirSync(opts.sessionDir, { recursive: true });
    const stderrLog = join(opts.eventsDir, "phaseA.stderr.log");
    const out = await runChild(
      ["A", opts.cwd, opts.sessionDir, opts.eventsDir, opts.prompt],
      stderrLog,
    );
    const summary = parseSummaryLine(out.stdout);
    return {
      exitCode: out.exitCode,
      sessionFile: typeof summary?.sessionFile === "string" ? summary.sessionFile : undefined,
      sessionId: typeof summary?.sessionId === "string" ? summary.sessionId : undefined,
      blockedReason: parseBlockedReason(summary?.blockedReason),
    };
  },
  async phaseB(opts) {
    mkdirSync(opts.eventsDir, { recursive: true });
    const stderrLog = join(opts.eventsDir, "phaseB.stderr.log");
    const out = await runChild(
      ["B", opts.cwd, opts.sessionFile, opts.eventsDir, opts.prompt],
      stderrLog,
    );
    const summary = parseSummaryLine(out.stdout);
    const history = summary?.history as
      | {
          entries: number;
          userMessages: number;
          assistantMessages: number;
          lastAssistantText: string | undefined;
        }
      | undefined;
    return {
      exitCode: out.exitCode,
      sessionId: typeof summary?.sessionId === "string" ? summary.sessionId : undefined,
      blockedReason: parseBlockedReason(summary?.blockedReason),
      history,
      answer: typeof summary?.answer === "string" ? summary.answer : undefined,
    };
  },
};
