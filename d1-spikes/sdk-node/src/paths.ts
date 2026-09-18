/**
 * TreeAI D1 spike - path resolution.
 *
 * All probes write evidence only under d1-spikes/evidence/sdk/ and run in
 * temp copies of fixtures. Nothing here writes to the repository root or
 * to other agents' directories.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** This file: <sdk-node>/src/paths.ts */
const SRC_DIR = dirname(fileURLToPath(import.meta.url));
/** <sdk-node> */
export const SDK_NODE_DIR = dirname(SRC_DIR);
/** <d1-spikes> */
export const D1_SPIKES_DIR = dirname(SDK_NODE_DIR);

/** Default evidence root for this implementation (Agent B owned). */
export function defaultEvidenceDir(): string {
  const override = process.env.PI_PROBE_EVIDENCE_DIR;
  if (override && override.trim() !== "") return override;
  return join(D1_SPIKES_DIR, "evidence", "sdk");
}

/**
 * Fixture source directory: shared d1-spikes/fixtures/ when Agent D has
 * delivered it, otherwise the local fallback inside this spike
 * (fixtures-local/). The fallback keeps this probe runnable without
 * touching shared directories; it is documented as a limitation.
 */
export function resolveFixtureSource(): { dir: string; source: "shared" | "local-fallback" } {
  const shared = join(D1_SPIKES_DIR, "fixtures");
  const sharedNumbers = join(shared, "numbers.json");
  if (existsSync(sharedNumbers)) {
    return { dir: shared, source: "shared" };
  }
  return { dir: join(SDK_NODE_DIR, "fixtures-local"), source: "local-fallback" };
}
