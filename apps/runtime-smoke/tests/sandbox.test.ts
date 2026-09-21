/**
 * Sandbox test: the smoke scenario must run as a real child process under
 * an isolated HOME and never touch it (no ~/.pi reads or writes) — the
 * offline guarantee required by the task book.
 *
 * Output hygiene: failures report sizes/booleans only (test stdout is
 * captured into D2 evidence logs and must stay secret-free).
 */

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");

test("scenario child process runs offline under a sandboxed HOME without touching it", async () => {
  const sandboxHome = await mkdtemp(join(tmpdir(), "runtime-smoke-sandbox-"));
  try {
    const child = spawn(process.execPath, [join(appDir, "src", "main.ts")], {
      env: {
        HOME: sandboxHome,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        TMPDIR: process.env.TMPDIR ?? tmpdir(),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Safety valve: a hung child must not hang the suite.
    const killTimer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 60_000);
    killTimer.unref?.();

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const exitCode = await new Promise<number>((resolve) => {
      child.on("close", (code) => {
        resolve(code === null ? -1 : code);
      });
    });

    assert.equal(exitCode, 0, `scenario child must exit 0 (stderr length: ${stderr.length})`);
    assert.ok(stdout.includes("runtime-smoke:scenario ok"), "child must report scenario success");
    assert.ok(stdout.includes("runtime-smoke:runs 8"), "child must report 8 runs");
    assert.ok(!existsSync(join(sandboxHome, ".pi")), "sandbox HOME must not gain a .pi directory");
    assert.ok(!stdout.includes("Bearer"), "stdout must not contain credential-shaped strings");
  } finally {
    rmSync(sandboxHome, { recursive: true, force: true });
  }
});
