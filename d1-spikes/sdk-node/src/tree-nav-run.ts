/**
 * TreeAI D1 spike - tree/navigation architecture probe entry (owner closure
 * follow-up, 2026-09-20). SEPARATE from the five unified scenarios.
 *
 * Usage:
 *   tsx src/tree-nav-run.ts [--timeout-ms N] [--evidence-dir DIR]
 *   (npm run probe:tree-nav)
 *
 * Writes ONLY under <evidence-dir>/tree-nav/runs/<timestamp>-<pid>/ — a
 * dedicated tree-nav/ subtree next to (never inside) evidence/sdk/runs/, so
 * tree navigation results can never mix into the five-scenario results or
 * their verification. Same append-only model: one fresh directory per run,
 * history is never rewritten.
 *
 * Model baseline: resolves the model exactly like src/run.ts
 * (PI_PROBE_MODEL override, else first available via
 * createAgentSessionServices), so a tree-nav run on the unified baseline
 * (e.g. tal-token-plan-06c64a09/deepseek-v4.1-flash, thinking=off) is
 * directly comparable to the five-scenario runs.
 *
 * Exit codes: 0 PASS, 1 FAIL, 2 BLOCKED, 3 usage error.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { TREE_NAV_SCENARIO } from "./types.js";
import { runScenario } from "./runner.js";
import { runTreeNavScenario } from "./scenarios/tree-nav.js";
import {
  createRealSessionFactory,
  resolveProbeModel,
  PI_PACKAGE_VERSION,
  PI_API_SURFACE,
  type ResolvedModel,
} from "./pi-bridge.js";
import { captureEnvironment } from "./env.js";
import { defaultEvidenceDir, D1_SPIKES_DIR } from "./paths.js";
import { DEFAULT_TIMEOUT_MS, scenarioCommand } from "./prompts.js";
import { detectSharedSchemas } from "./validate.js";
import { adapterMetrics, DIRECT_PI_ACCESS } from "./audit.js";
import { redactValue } from "./redact.js";

function usage(): never {
  console.error("usage: tsx src/tree-nav-run.ts [--timeout-ms N] [--evidence-dir DIR]");
  process.exit(3);
}

function parseArgs(argv: string[]): { timeoutMs: number; evidenceDir: string } {
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let evidenceDir = defaultEvidenceDir();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--timeout-ms") {
      const v = argv[++i];
      if (v === undefined || !/^\d+$/.test(v)) usage();
      timeoutMs = Number(v);
    } else if (arg === "--evidence-dir") {
      const v = argv[++i];
      if (v === undefined || v.trim() === "") usage();
      evidenceDir = v;
    } else {
      usage();
    }
  }
  return { timeoutMs, evidenceDir };
}

async function main(): Promise<number> {
  const { timeoutMs, evidenceDir } = parseArgs(process.argv.slice(2));

  const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
  // Dedicated subtree: evidence/sdk/tree-nav/runs/<timestamp>-<pid>/ —
  // deliberately NOT evidence/sdk/runs/ (five-scenario territory).
  const runDir = join(evidenceDir, "tree-nav", "runs", `${runStamp}-${process.pid}`);
  mkdirSync(runDir, { recursive: true });

  const environment = captureEnvironment();
  writeFileSync(
    join(runDir, "environment.json"),
    JSON.stringify(redactValue(environment), null, 2) + "\n",
  );

  const sharedSchemas = detectSharedSchemas(D1_SPIKES_DIR);
  const limitations: string[] = [];
  if (sharedSchemas.evidenceEventSchema === null || sharedSchemas.scenarioResultSchema === null) {
    limitations.push(
      "Agent D's shared JSON schemas (d1-spikes/schemas/) were not present; local field rules were used instead (PENDING integration).",
    );
  }
  limitations.push(
    "tree-nav is an architecture probe outside the five unified D1 scenarios; the shared schemas' scenario enum does not cover 'tree-nav' (PENDING_OWNER whether to extend the shared contract).",
  );

  // Same model resolution path as src/run.ts so the baseline matches the
  // five-scenario runs; a credentials block is visible in the result.
  let modelInfo: ResolvedModel | undefined;
  let resolveError: string | undefined;
  try {
    modelInfo = await resolveProbeModel();
  } catch (err) {
    resolveError = `${(err as Error).name}: ${(err as Error).message}`;
  }

  const metrics = adapterMetrics();
  const auditNote =
    `adapter code: ${metrics.adapter.totalCodeLines} code lines across ${metrics.adapter.files.length} file(s) ` +
    `(${metrics.adapter.files.map((f) => f.path).join(", ")}); probe harness: ${metrics.harness.totalCodeLines} code lines; ` +
    `direct Pi API surface: ${Object.keys(PI_API_SURFACE).length} entry points; ` +
    `Pi package version: ${PI_PACKAGE_VERSION}`;
  limitations.push(auditNote);
  limitations.push("Spike probe output, not a production adapter: no RuntimeAdapter, no TreeAI domain model.");

  const result = await runScenario({
    scenario: TREE_NAV_SCENARIO,
    command: scenarioCommand(TREE_NAV_SCENARIO),
    timeoutMs,
    runDir,
    limitations,
    exec: async (ctx) => {
      if (modelInfo === undefined) {
        ctx.markBlocked(
          "BLOCKED_CREDENTIALS",
          resolveError ??
            "No authenticated model available; cannot run a real Pi conversation. " +
              "Provide credentials via `pi auth login` or a provider API key environment variable and re-run.",
        );
      }
      ctx.observe(
        `model: ${modelInfo!.providerId}/${modelInfo!.modelId} (thinking=${modelInfo!.thinkingLevel}, source=${modelInfo!.source})`,
      );
      ctx.observe(`direct Pi state/type access points used by the adapter: ${DIRECT_PI_ACCESS.length}`);
      await runTreeNavScenario(ctx, { createSession: createRealSessionFactory(modelInfo!) });
    },
  });
  console.log(
    `[sdk-node] tree-nav: ${result.status} (exit=${result.exitCode}, ${result.durationMs}ms, events=${result.evidenceFiles[0]})`,
  );

  const summary = {
    implementation: "sdk-node" as const,
    runDir: relative(D1_SPIKES_DIR, runDir),
    scenario: TREE_NAV_SCENARIO,
    note: "tree/navigation architecture probe; separate from the five unified scenarios and never part of probe:all",
    startedAt: result.startedAt,
    results: [
      {
        scenario: result.scenario,
        status: result.status,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        evidenceFiles: result.evidenceFiles,
      },
    ],
    environment: {
      node: environment.runtime.node,
      npm: environment.runtime.npm,
      piPackageVersion: environment.pi.packageVersion,
      piGlobalCliVersion: environment.pi.globalCliVersion,
      model: modelInfo,
      modelResolveError: resolveError ?? null,
      envApiKeyNamesPresent: environment.probe.envApiKeyNamesPresent,
    },
    adapterMetrics: metrics,
    sharedSchemasDetected: sharedSchemas,
  };
  writeFileSync(join(runDir, "run-summary.json"), JSON.stringify(redactValue(summary), null, 2) + "\n");

  console.log(`[sdk-node] run dir: ${runDir}`);
  console.log(`[sdk-node] exit code: ${result.exitCode}`);
  return result.exitCode;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err) => {
    console.error(`[sdk-node] fatal: ${(err as Error).stack ?? (err as Error).message}`);
    process.exit(1);
  });
