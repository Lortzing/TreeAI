/**
 * TreeAI D1 spike - fixture preparation.
 *
 * Task book section 5: "所有运行均在 d1-spikes/fixtures/ 的临时副本中进行"
 * (all runs happen in a temp copy of the fixtures). This module copies the
 * resolved fixture source (shared fixtures/ when available, otherwise the
 * local fallback) into a fresh temp directory and returns its path plus a
 * cleanup function. The Pi session cwd is set to this temp copy, so the
 * read tool can only touch the copy.
 */

import { cpSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveFixtureSource } from "./paths.js";
import { FIXTURE_FILE } from "./prompts.js";
import { removeDirIfPresent } from "./recorder.js";

export interface PreparedFixture {
  cwd: string;
  source: "shared" | "local-fallback";
  fixturePath: string;
  cleanup: () => void;
}

export function prepareFixtureCwd(prefix = "treeai-d1-sdk-"): PreparedFixture {
  const { dir, source } = resolveFixtureSource();
  if (!existsSync(join(dir, FIXTURE_FILE))) {
    throw new Error(
      `Fixture ${FIXTURE_FILE} not found in ${dir} (source=${source}). ` +
        "Agent D's shared fixtures/ is not present and the local fallback is incomplete.",
    );
  }
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  cpSync(dir, cwd, { recursive: true });
  return {
    cwd,
    source,
    fixturePath: join(cwd, FIXTURE_FILE),
    cleanup: () => removeDirIfPresent(cwd),
  };
}
