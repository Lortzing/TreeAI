import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { readStudioCss, studioCssModuleNames } from "./support/styles.ts";

const publicDir = fileURLToPath(new URL("../public/", import.meta.url));

test("published CSS modules preserve ordered cascade and critical responsive rules", () => {
  const modules = studioCssModuleNames(publicDir);
  assert.deepEqual(modules, ["tokens-base.css","workspace.css","conversation.css","terminology.css","controls-branches.css","materials.css","sources-navigation.css","responsive.css","reduced-motion.css"]);
  const merged = readStudioCss(publicDir);
  assert.ok(merged.length > 55_000, "all original CSS sections are present");
  assert.match(merged, /@media \(max-width: 719px\)/);
  assert.match(merged, /@media \(min-width: 1180px\)/);
  assert.match(merged, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(merged, /@keyframes panel-in/);
  for (const name of modules) {
    const source = readFileSync(join(publicDir, "styles", name), "utf8");
    assert.ok(source.length > 0, `missing/empty CSS module: ${name}`);
  }
});
