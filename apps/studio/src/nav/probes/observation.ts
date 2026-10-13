/** observation ownership for b9-probes.ts; compatibility entrypoint remains one level above. */
import type {
  B9ProbeOutcome,
  ProbeContext,
} from "./model.ts";
import {
  performance,
} from "node:perf_hooks";

export function runProbe(id: string, context: ProbeContext, body: (failures: string[]) => string): B9ProbeOutcome {
  const startedAt = performance.now();
  const failures: string[] = [];
  let detail = "";
  try {
    detail = body(failures);
  } catch (error) {
    failures.push(`probe threw: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    id,
    status: failures.length === 0 ? "PASS" : "FAIL",
    detail,
    durationMs: performance.now() - startedAt,
    failures,
  };
}
