import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

test("installer core loads without npm modules from a Chinese and space bundle path", () => {
  const root = mkdtempSync(join(tmpdir(), "TreeAI 中文 bundle "));
  try {
    const launcherDir = join(root, "launcher");
    mkdirSync(launcherDir);
    cpSync(resolve("scripts/d4/installer/core.ts"), join(launcherDir, "core.ts"));
    cpSync(resolve("scripts/d4/installer/core"), join(launcherDir, "core"), { recursive: true });
    cpSync(resolve("scripts/d4/installer/commands"), join(launcherDir, "commands"), { recursive: true });
    cpSync(resolve("scripts/d4/installer/launcher.ts"), join(launcherDir, "launcher.ts"));
    const help = spawnSync(process.execPath, [join(launcherDir, "launcher.ts"), "--help"], {
      encoding: "utf8", timeout: 5000, env: { PATH: "" },
    });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /start.*stop.*restart.*status/);
    const paths = spawnSync(process.execPath, [join(launcherDir, "launcher.ts"), "paths"], {
      encoding: "utf8", timeout: 5000, env: { PATH: "", TREEAI_DATA_DIR: join(root, "user data") },
    });
    assert.equal(paths.status, 0, paths.stderr);
    assert.ok(paths.stdout.includes(`bundle=${realpathSync(root)}`));
    assert.ok(paths.stdout.includes(`data=${join(root, "user data")}`));
    const url = pathToFileURL(join(launcherDir, "core.ts")).href;
    const code = `const core = await import(${JSON.stringify(url)}); if (core.DEFAULT_PORT !== 8787 || core.defaultLauncherConfig().port !== 8787) process.exit(2);`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      encoding: "utf8", timeout: 5000, env: { PATH: "" },
    });
    assert.equal(result.status, 0, result.stderr);
    rmSync(join(launcherDir, "core", "runtime.ts"));
    const missing = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      encoding: "utf8", timeout: 5000, env: { PATH: "" },
    });
    assert.notEqual(missing.status, 0, "a missing runtime owner cannot appear installed");
    assert.match(missing.stderr, /runtime\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
