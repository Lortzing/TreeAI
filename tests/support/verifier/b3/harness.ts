/** harness owner; frozen probe bodies and order preserved. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MaterialRepository, TreeRepository } from "@treeai/persistence";
import type { MaterialId, MaterialSelection, MaterialVersionId, PiRuntime, TreeId } from "@treeai/contracts";
import { classifyPiFailure, createPiRuntimeFromConfig } from "@treeai/runtime-pi";
import { EchoSdkPort, ECHO_FAILURE_MESSAGE } from "../../../../apps/studio/src/echo-port.ts";
import { MaterialBranchingService } from "../../../../apps/studio/src/materials/branching.ts";
import { MaterialImportService } from "../../../../apps/studio/src/materials/import-service.ts";
import { MaterialRangeResolver } from "../../../../apps/studio/src/materials/range-resolver.ts";

import { FAILURE_SENTINEL } from './truth.ts';


/* ------------------------------------------------------------------ */
/* The check                                                           */
/* ------------------------------------------------------------------ */

export interface ImportOutcome {
  readonly parseStatus: string;
  readonly materialId: MaterialId;
  readonly versionId: MaterialVersionId;
}


export interface Harness {
  readonly dir: string;
  readonly repository: TreeRepository;
  readonly materialRepository: MaterialRepository;
  readonly materials: MaterialImportService;
  readonly resolver: MaterialRangeResolver;
  readonly branching: MaterialBranchingService;
  readonly service: import("../../../../apps/studio/src/service.ts").TreeStudioService;
  shutdown(): Promise<void>;
}


/**
 * Build a full studio stack on a data dir (fresh temp dir by default; pass
 * `dir` to reopen an existing one — the restart/session-loss scenarios).
 * The echo runtime carries a sentinel-failure proxy for the explicit
 * dispatch-failure scenario. TreeStudioService comes from a dynamic import:
 * service.ts value-imports @treeai/event-journal, whose package main points
 * at dist/ (a gitignored build output) — the check ensures that build
 * exists first (the studio suite's own build:deps step).
 */
export async function openHarness(dir?: string): Promise<Harness> {
  const { TreeStudioService } = await import("../../../../apps/studio/src/service.ts");
  const dataDir = dir ?? mkdtempSync(join(tmpdir(), "treeai-d4-b3-"));
  const dbPath = join(dataDir, "treeai.db");
  const repository = TreeRepository.open({ path: dbPath });
  const materialRepository = MaterialRepository.open({ path: dbPath });
  const echoRuntime = createPiRuntimeFromConfig({
    port: new EchoSdkPort(),
    defaultCwd: join(dataDir, "workspace"),
  });
  const runtime: PiRuntime = {
    get piVersion() {
      return echoRuntime.piVersion;
    },
    createSession: (init) => echoRuntime.createSession(init),
    restoreSession: (reference) => echoRuntime.restoreSession(reference),
    prompt: (input) =>
      input.text.includes(FAILURE_SENTINEL)
        ? Promise.reject(classifyPiFailure(new Error(ECHO_FAILURE_MESSAGE), "Pi run failed"))
        : echoRuntime.prompt(input),
    steer: (input) => echoRuntime.steer(input),
    abort: () => echoRuntime.abort(),
    navigateTree: (target) => echoRuntime.navigateTree(target),
    subscribe: (listener) => echoRuntime.subscribe(listener),
    dispose: () => echoRuntime.dispose(),
  };
  const service = new TreeStudioService({
    repository,
    runtime,
    model: { providerId: "studio-provider", modelId: "studio-model" },
    sessionDir: join(dataDir, "sessions"),
    cwd: join(dataDir, "workspace"),
  });
  const materials = new MaterialImportService({ repository: materialRepository });
  const resolver = new MaterialRangeResolver({ repository: materialRepository });
  const branching = new MaterialBranchingService({
    treeRepository: repository,
    materialRepository,
    studio: service,
  });
  return {
    dir: dataDir,
    repository,
    materialRepository,
    materials,
    resolver,
    branching,
    service,
    async shutdown(): Promise<void> {
      await service.dispose();
      materialRepository.close();
      repository.close();
    },
  };
}


/** Import and wait for the parse task to settle; returns the settled status. */
export async function importAndSettle(
  harness: Harness,
  treeId: TreeId,
  filename: string,
  bytes: Uint8Array,
): Promise<ImportOutcome> {
  const result = await harness.materials.importMaterial(treeId, { filename, bytes });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const detail = harness.materials.getMaterialDetail(treeId, result.material.id);
    const version = detail.versions.find((entry) => entry.id === result.version.id);
    if (version !== undefined && version.parseStatus !== "pending" && version.parseStatus !== "parsing") {
      return { parseStatus: version.parseStatus, materialId: result.material.id, versionId: result.version.id };
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return { parseStatus: "timeout", materialId: result.material.id, versionId: result.version.id };
}


export function resolveOccurrence(
  harness: Harness,
  materialId: MaterialId,
  versionId: MaterialVersionId,
  needle: string,
): MaterialSelection | null {
  const resolution = harness.resolver.resolve({
    materialId,
    versionId,
    locator: { kind: "text-occurrence", needle, occurrence: 1 },
  });
  return resolution.ok ? resolution.result.selection : null;
}


export class Check {
  readonly lines: string[] = [];
  readonly problems: string[] = [];
  passed = 0;

  ok(scenario: string, detail: string): void {
    this.passed += 1;
    this.lines.push(`[b3.${scenario}] PASS — ${detail}`);
  }

  fail(scenario: string, detail: string): void {
    this.lines.push(`[b3.${scenario}] FAIL — ${detail}`);
    this.problems.push(`b3 ${scenario}: ${detail}`);
  }
}
