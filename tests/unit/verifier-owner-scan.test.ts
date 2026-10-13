import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

test("D2 workspace scan includes extracted verifier owners", () => {
  const root = mkdtempSync(join(tmpdir(), "treeai-owner-scan-"));
  try {
    cpSync(resolve("schemas/d2"), join(root, "schemas", "d2"), { recursive: true });
    const ownerDir = join(root, "scripts", "verification");
    mkdirSync(ownerDir, { recursive: true });
    const synthetic = "sk-" + Array.from({ length: 48 }, (_, i) => "abcdef0123456789"[i % 16]).join("");
    writeFileSync(join(ownerDir, "new-owner.mjs"), JSON.stringify(synthetic));
    const result = spawnSync(process.execPath, [resolve("scripts/verify-d2.js"), "--root", root,
      "--runs-root", join(root, "runs"), "--only", "secret-scan-workspace"], {
      encoding: "utf8", timeout: 10000,
    });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stdout, /\[FAIL\] secret-scan-workspace/);
    assert.ok(!String(result.stdout + result.stderr).includes(synthetic));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
