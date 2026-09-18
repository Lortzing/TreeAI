/**
 * TreeAI D1 spike - CLI entry point (real probe; no fakes).
 *
 * Usage:
 *   tsx src/run.ts <basic|tool|steer|abort|resume|all> [options]
 *
 * Options:
 *   --timeout-ms <n>   total timeout per scenario (default PI_PROBE_TIMEOUT_MS or 180000)
 *   --evidence-dir <d> evidence root (default d1-spikes/evidence/sdk)
 *
 * Exit codes: 0 all PASS; 1 any FAIL; 2 any BLOCKED; 3 usage error.
 * Writes: <evidence-dir>/runs/<timestamp>/<scenario>/{events.jsonl,result.json}
 *         <evidence-dir>/runs/<timestamp>/environment.json
 *         <evidence-dir>/runs/<timestamp>/run-summary.json
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCENARIOS, type ScenarioName, type ScenarioResult } from "./types.js";
import { runScenario, aggregateExitCode } from "./runner.js";
import { executeScenario } from "./scenarios/index.js";
import {
  createRealSessionFactory,
  resolveProbeModel,
  PI_PACKAGE_VERSION,
  PI_API_SURFACE,
  type ResolvedModel,
} from "./pi-bridge.js";
import { realResumeChildRunner } from "./child-runner.js";
import { captureEnvironment } from "./env.js";
import { defaultEvidenceDir, D1_SPIKES_DIR } from "./paths.js";
import { DEFAULT_TIMEOUT_MS, scenarioCommand } from "./prompts.js";
import { detectSharedSchemas } from "./validate.js";
import { adapterMetrics, DIRECT_PI_ACCESS } from "./audit.js";

function usage(): never {
  console.error("usage: tsx src/run.ts <basic|tool|steer|abort|resume|all> [--timeout-ms N] [--evidence-dir DIR]");
  process.exit(3);
}

function parseArgs(argv: string[]): { scenario: ScenarioName | "all"; timeoutMs: number; evidenceDir: string } {
  const [scenario, ...rest] = argv;
  if (scenario !== "all" && !SCENARIOS.includes(scenario as ScenarioName)) {
    usage();
  }
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let evidenceDir = defaultEvidenceDir();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--timeout-ms") {
      const v = rest[++i];
      if (v === undefined || !/^\d+$/.test(v)) usage();
      timeoutMs = Number(v);
    } else if (arg === "--evidence-dir") {
      const v = rest[++i];
      if (v === undefined || v.trim() === "") usage();
      evidenceDir = v;
    } else {
      usage();
    }
  }
  return { scenario: scenario as ScenarioName | "all", timeoutMs, evidenceDir };
}

async function main(): Promise<number> {
  const { scenario, timeoutMs, evidenceDir } = parseArgs(process.argv.slice(2));

  const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(evidenceDir, "runs", `${runStamp}-${process.pid}`);
  mkdirSync(runDir, { recursive: true });

  // Environment snapshot (no secrets) - always written, blocked or not.
  const environment = captureEnvironment();
  writeFileSync(join(runDir, "environment.json"), JSON.stringify(environment, null, 2) + "\n");

  const sharedSchemas = detectSharedSchemas(D1_SPIKES_DIR);
  const globalLimitations: string[] = [];
  if (sharedSchemas.evidenceEventSchema === null || sharedSchemas.scenarioResultSchema === null) {
    globalLimitations.push(
      "Agent D's shared JSON schemas (d1-spikes/schemas/) were not present; results were validated against the task-book field rules implemented in src/validate.ts instead (PENDING integration).",
    );
  }

  // Model resolution happens up front so every scenario records the same
  // model identity, and a credentials block is visible in every result.
  let modelInfo: ResolvedModel | undefined;
  let resolveError: string | undefined;
  try {
    const resolved = await resolveProbeModel();
    modelInfo = resolved;
  } catch (err) {
    resolveError = `${(err as Error).name}: ${(err as Error).message}`;
  }

  const metrics = adapterMetrics();
  const auditNote =
    `adapter code: ${metrics.adapter.totalCodeLines} code lines across ${metrics.adapter.files.length} file(s) ` +
    `(${metrics.adapter.files.map((f) => f.path).join(", ")}); probe harness: ${metrics.harness.totalCodeLines} code lines; ` +
    `direct Pi API surface: ${Object.keys(PI_API_SURFACE).length} entry points; ` +
    `Pi package version: ${PI_PACKAGE_VERSION}`;

  const toRun: ScenarioName[] = scenario === "all" ? [...SCENARIOS] : [scenario];
  const results: ScenarioResult[] = [];

  for (const name of toRun) {
    const limitations = [...globalLimitations];
    if (resolveError !== undefined) {
      limitations.push(`model resolution failed before scenario start: ${resolveError}`);
    }
    limitations.push(auditNote);
    limitations.push("Spike probe output, not a production adapter: no RuntimeAdapter, no TreeAI domain model.");

    const result = await runScenario({
      scenario: name,
      command: scenarioCommand(name),
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
        await executeScenario(name, ctx, {
          createSession: createRealSessionFactory(modelInfo!),
          childRunner: realResumeChildRunner,
        });
      },
    });
    results.push(result);
    console.log(
      `[sdk-node] ${name}: ${result.status} (exit=${result.exitCode}, ${result.durationMs}ms, events=${result.evidenceFiles[0]})`,
    );
  }

  const summary = {
    implementation: "sdk-node" as const,
    runDir,
    scenario: scenario === "all" ? "all" : scenario,
    startedAt: results[0]?.startedAt ?? new Date().toISOString(),
    results: results.map((r) => ({
      scenario: r.scenario,
      status: r.status,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      evidenceFiles: r.evidenceFiles,
    })),
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
  writeFileSync(join(runDir, "run-summary.json"), JSON.stringify(summary, null, 2) + "\n");

  const exitCode = aggregateExitCode(results);
  console.log(`[sdk-node] run dir: ${runDir}`);
  console.log(`[sdk-node] aggregate exit code: ${exitCode}`);
  return exitCode;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err) => {
    console.error(`[sdk-node] fatal: ${(err as Error).stack ?? (err as Error).message}`);
    process.exit(1);
  });
