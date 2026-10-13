/** Platform execution/archives/polling; no CLI or verdict state. */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tarExtractArgs } from './core.ts';
const IS_WIN = process.platform === 'win32';
export function run(command, argv, opts = {}) {
  const shell = IS_WIN && typeof command === "string" && command.startsWith('"');
  const res = spawnSync(command, argv, {
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 120_000,
    env: { ...process.env, ...(opts.env ?? {}) },
    cwd: opts.cwd,
    windowsHide: true,
    ...(shell ? { shell: true } : {}),
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

export async function httpJson(url, init) {
  try {
    const res = await fetch(url, init);
    const body = await res.json();
    return { status: res.status, ok: res.ok, body };
  } catch (err) {
    return { status: 0, ok: false, body: { error: String(err) } };
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function extractArchive(archivePath, intoDir) {
  mkdirSync(intoDir, { recursive: true });
  if (archivePath.endsWith(".zip")) {
    if (process.platform === "win32") {
      const system32Tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
      if (existsSync(system32Tar)) {
        execVisible(system32Tar, ["-xf", archivePath, "-C", intoDir, "--no-same-owner"]);
        return;
      }
      execVisible("powershell.exe", [
        "-NoProfile",
        "-Command",
        `Expand-Archive -LiteralPath ${JSON.stringify(archivePath)} -DestinationPath ${JSON.stringify(intoDir)} -Force`,
      ]);
      return;
    }
    const hasUnzip = spawnSync("which", ["unzip"], { encoding: "utf8" }).status === 0;
    if (hasUnzip) {
      execVisible("unzip", ["-q", "-o", archivePath, "-d", intoDir]);
      return;
    }
  }
  execVisible("tar", tarExtractArgs(archivePath, intoDir));
}

export function execVisible(command, argv) {
  const res = run(command, argv, { timeoutMs: 300_000 });
  if (res.status !== 0) {
    throw new Error(`${command} ${argv.join(" ")} 退出码 ${String(res.status)}\n${res.stdout}\n${res.stderr}`);
  }
}

export function parseUrlFrom(output) {
  const m = /url=(http:\/\/127\.0\.0\.1:(\d+))/.exec(output);
  return m === null ? null : { url: m[1], port: Number(m[2]) };
}

export function readdirHasBackup(parent, bundleBaseName) {
  try {
    return readdirSync(parent).some((name) => name.startsWith(`${bundleBaseName}.backup-`));
  } catch {
    return false;
  }
}

export async function waitFor(timeoutMs, predicate) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(500);
  }
  return predicate();
}
