import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

for (const entry of ["run-d3-browser.mjs", "run-d3-real-pi.mjs", "run-terminology-eval.mjs"]) {
  test(`${entry} help exits before Chrome, Studio or provider initialization`, () => {
    const result = spawnSync(process.execPath, [resolve("scripts", entry), "--help"], {
      encoding: "utf8", timeout: 5000,
      env: { ...process.env, TREEAI_STUDIO_API_KEY: "", PATH: "" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /usage:/);
    assert.doesNotMatch(result.stdout + result.stderr, /studio on|DevTools|summary:|BLOCKED:/);
  });
}

test("browser runner rejects an unknown flag before launching a child", () => {
  const result = spawnSync(process.execPath, [resolve("scripts/run-d3-browser.mjs"), "--unknown", "value"], {
    encoding: "utf8", timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown flag/);
  assert.doesNotMatch(result.stdout, /mode selftest|summary:/);
});

test("browser runner accepts a trailing standalone keep-data flag", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { createBrowserCli } from './scripts/d3/browser-cli.mjs';
    const { parseCli } = createBrowserCli({ DEFAULT_PROMPT_SETTLE_MS: 30000, USAGE: 'usage', MODES: ['selftest', 'real-pi'] });
    if (!parseCli(['--keep-data']).keepData) process.exit(2);
  `], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
});
