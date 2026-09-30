/**
 * Shared B3「材料探索闭环」offline executing check (D4-3 wave, issue #8
 * charter §6 B3 — the offline-executable subset; ADR-004 §9).
 *
 * Runs the REAL product loop (MaterialImportService + MaterialRepository +
 * MaterialRangeResolver + MaterialBranchingService on top of the REAL
 * TreeStudioService with the offline echo Pi runtime — zero credentials, zero
 * network) in a throwaway data directory, covering the deterministic core of
 * charter §3.3 / B3:
 *
 *  - create-from-selection: a frozen B1 markdown fixture AND a frozen B1
 *    text-layer PDF fixture import through the real pipeline, a selection
 *    resolves through the real range resolver, and branching lands
 *    Branch + material origin + (tree, intent_key) binding with ZERO runs and
 *    turns (浏览/搜索不创建 Turn);
 *  - context window honesty: the composed context view is deterministic and
 *    byte-identical between creation and dispatch; a large generated material
 *    truncates with the explicit marker and stays under the frozen 24,000
 *    UTF-16 cap; an oversized selection is refused with zero rows;
 *  - independent run origin: the first run's session is new (not the trunk
 *    run's session); the audited turn prefix carries versionId only; the
 *    composed material context enters the model input (echo evidence);
 *  - idempotent first question: same key + same question replays without
 *    re-sending (landed-turn reconciliation), and the replay stays
 *    deterministic across a process restart (same turn ids, zero new rows);
 *  - 409 conflict discipline: same intent key with a different selection, and
 *    a dispatched first question with different content, are both refused;
 *  - reconciliation-before-action: a non-terminal run (process-death shape)
 *    yields dispatch "unknown" WITHOUT re-sending; an explicit upstream
 *    failure (sentinel runtime) yields "failed" and the retry is allowed;
 *  - restore vs explicit new: the same source restores the existing branch,
 *    explicit new opens a second one; a look-alike selection in another
 *    material is never reused; cross-tree isolation holds;
 *  - material return: lands on the owning tree's trunk with targetAnchor
 *    null, a full material source card, idempotent replay, and an adoption
 *    attempt recorded after the trunk prompt;
 *  - missing session: normal continuation fails closed; the explicit new
 *    exploration succeeds with the material context carried;
 *  - non-ready materials refuse branching honestly (frozen B1 negative).
 *
 * NOT covered here (honestly NOT_RUN elsewhere): real-Pi browser evidence for
 * B3 (run:d4-browser --mode real-pi at the final candidate SHA) and the UI.
 *
 * Consumers: scripts/verify-d4.js (check `b3-material-exploration`). The
 * frozen fixture tree stays read-only; all additional data is generated
 * deterministically inside this check (no B3 frozen content set exists —
 * tests/fixtures/d4 is not written).
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MaterialRepository, TreeRepository } from "@treeai/persistence";
import type { MaterialId, MaterialSelection, MaterialVersionId, PiRuntime, SessionReference, TreeId } from "@treeai/contracts";
import { classifyPiFailure, createPiRuntimeFromConfig } from "@treeai/runtime-pi";
import { EchoSdkPort, ECHO_FAILURE_MESSAGE } from "../../../apps/studio/src/echo-port.ts";
import {
  MATERIAL_CONTEXT_LIMIT_UNITS,
  MATERIAL_MAX_SELECTION_UNITS,
  MaterialBranchConflictError,
  MaterialBranchingService,
  MaterialFirstQuestionConflictError,
} from "../../../apps/studio/src/materials/branching.ts";
import { MaterialImportService } from "../../../apps/studio/src/materials/import-service.ts";
import { MaterialRangeResolver } from "../../../apps/studio/src/materials/range-resolver.ts";
import { REPO_ROOT, runCommand } from "./util.ts";

export interface B3ExplorationCheckOutcome {
  readonly status: "PASS" | "FAIL" | "NOT_RUN";
  readonly exitCode: number | null;
  /** One-line summary for the check matrix. */
  readonly detail: string;
  /** Per-scenario execution lines (evidence log). */
  readonly lines: readonly string[];
  readonly problems: readonly string[];
}

/* ------------------------------------------------------------------ */
/* Frozen fixture shapes (B1 expected truth — mirrors d4-probes.ts)    */
/* ------------------------------------------------------------------ */

interface ExpectedBlock {
  readonly blockId: string;
  readonly start: number;
  readonly end: number;
  readonly page?: number;
  readonly text: string;
}

interface ExpectedTruth {
  readonly canonicalText: string;
  readonly blocks: readonly ExpectedBlock[];
}

function readExpected(path: string, problems: string[], fixtureId: string): ExpectedTruth | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { canonicalText?: unknown; blocks?: unknown };
    if (typeof raw.canonicalText !== "string" || !Array.isArray(raw.blocks)) {
      problems.push(`b1 expected ${fixtureId}: missing canonicalText/blocks at ${path}`);
      return null;
    }
    const blocks: ExpectedBlock[] = [];
    for (const entry of raw.blocks) {
      const record = entry as Record<string, unknown>;
      if (
        typeof record["blockId"] !== "string" ||
        typeof record["start"] !== "number" ||
        typeof record["end"] !== "number" ||
        typeof record["text"] !== "string"
      ) {
        problems.push(`b1 expected ${fixtureId}: malformed block entry at ${path}`);
        return null;
      }
      blocks.push({
        blockId: record["blockId"],
        start: record["start"],
        end: record["end"],
        ...(typeof record["page"] === "number" ? { page: record["page"] } : {}),
        text: record["text"],
      });
    }
    return { canonicalText: raw.canonicalText, blocks };
  } catch (error) {
    problems.push(`b1 expected ${fixtureId}: unreadable at ${path} (${error instanceof Error ? error.message : String(error)})`);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Deterministic scenario data (generated here — no frozen B3 set)     */
/* ------------------------------------------------------------------ */

const THREE_BLOCKS = "Alpha 开篇 baseline。\n\nBeta context block 中英混排。\n\nGamma 收尾 tail。";

/** 61 blocks × ~1000 units ≈ 61,000 units — far over the 24,000 cap. */
function largeMaterialText(): string {
  const paragraphs: string[] = [];
  for (let index = 0; index < 61; index += 1) {
    paragraphs.push(`Block ${String(index).padStart(2, "0")}: ${"探索段落内容。".repeat(160)}`);
  }
  return paragraphs.join("\n\n");
}

/** One single huge block so a >20,000-unit selection is representable. */
function oversizedSelectionText(): string {
  return `超限选区材料。${"长".repeat(MATERIAL_MAX_SELECTION_UNITS + 500)}`;
}

/** Deterministic upstream-failure sentinel (service.test.ts 同款代理纪律). */
const FAILURE_SENTINEL = "TRIGGER-B3-UPSTREAM-FAILURE";

/* ------------------------------------------------------------------ */
/* The check                                                           */
/* ------------------------------------------------------------------ */

interface ImportOutcome {
  readonly parseStatus: string;
  readonly materialId: MaterialId;
  readonly versionId: MaterialVersionId;
}

interface Harness {
  readonly dir: string;
  readonly repository: TreeRepository;
  readonly materialRepository: MaterialRepository;
  readonly materials: MaterialImportService;
  readonly resolver: MaterialRangeResolver;
  readonly branching: MaterialBranchingService;
  readonly service: import("../../../apps/studio/src/service.ts").TreeStudioService;
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
async function openHarness(dir?: string): Promise<Harness> {
  const { TreeStudioService } = await import("../../../apps/studio/src/service.ts");
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
async function importAndSettle(
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

function resolveOccurrence(
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

class Check {
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

export async function runB3ExplorationCheck(d4Root: string): Promise<B3ExplorationCheckOutcome> {
  const check = new Check();

  /* --- Preconditions: frozen fixtures + the event-journal build ------- */
  const mdExpected = readExpected(join(d4Root, "b1-import", "markdown", "md-01.expected.json"), check.problems, "md-01");
  const pdfExpected = readExpected(join(d4Root, "b1-import", "pdf", "pdf-01.expected.json"), check.problems, "pdf-01");
  const mdBytesPath = join(d4Root, "b1-import", "markdown", "md-01.md");
  const pdfBytesPath = join(d4Root, "b1-import", "pdf", "pdf-01.pdf");
  const negativeBytesPath = join(d4Root, "b1-import", "negative", "neg-pdf-corrupt.pdf");
  for (const [path, what] of [
    [mdBytesPath, "b1 md-01 fixture"],
    [pdfBytesPath, "b1 pdf-01 fixture"],
    [negativeBytesPath, "b1 corrupt negative fixture"],
  ] as const) {
    if (!existsSync(path)) check.problems.push(`${what} missing at ${path}`);
  }
  if (mdExpected === null || pdfExpected === null || check.problems.length > 0) {
    return {
      status: "FAIL",
      exitCode: 1,
      detail: `preconditions failed: ${check.problems.join("; ")}`,
      lines: check.lines,
      problems: check.problems,
    };
  }

  /* service.ts value-imports @treeai/event-journal (dist/ is a build
     output). The studio suite builds it via build:deps; a standalone
     verify:d4 run builds it here on demand — deterministic, zero network. */
  const journalDist = join(REPO_ROOT, "packages", "event-journal", "dist", "src", "index.js");
  if (!existsSync(journalDist)) {
    const build = runCommand("npm", ["run", "--workspace", "@treeai/event-journal", "build:test"], {
      cwd: REPO_ROOT,
      timeoutMs: 300_000,
    });
    if (build.status !== 0 || !existsSync(journalDist)) {
      return {
        status: "FAIL",
        exitCode: 1,
        detail: `event-journal build failed (status ${String(build.status)}): ${build.stderr.slice(0, 400)}`,
        lines: check.lines,
        problems: ["event-journal dist missing and the on-demand build failed"],
      };
    }
    check.lines.push("[b3.build] PASS — event-journal dist built on demand for the standalone run");
  }

  let harness = await openHarness();
  try {
    /* --- Scenario: create-from-selection (markdown, frozen B1 md-01) -- */
    const treeA = harness.service.createTree().tree;
    const md = await importAndSettle(harness, treeA.id, "md-01.md", new Uint8Array(readFileSync(mdBytesPath)));
    if (md.parseStatus !== "ready") {
      check.fail("create.md", `the frozen markdown fixture settled '${md.parseStatus}' (expected ready)`);
    } else {
      const needle = mdExpected.blocks[1]!.text.slice(0, 10);
      const selection = resolveOccurrence(harness, md.materialId, md.versionId, needle);
      if (selection === null) {
        check.fail("create.md", `selection resolution failed for needle '${needle}'`);
      } else {
        const creation = harness.branching.createMaterialBranch({ treeId: treeA.id, selection, intentKey: "b3-md-1" });
        const episodes = harness.repository.listEpisodes(creation.branch.id);
        const turns = harness.repository.listTurns(creation.branch.id);
        const deterministic =
          harness.branching.buildContext(creation.origin).composed === creation.context.composed;
        if (
          creation.created &&
          episodes.length === 0 &&
          turns.length === 0 &&
          deterministic &&
          creation.context.composed.includes(selection.excerpt) &&
          !creation.context.truncated
        ) {
          check.ok(
            "create.md",
            `markdown create-from-selection: zero runs/turns, composed=${String(creation.context.composedUnits)}u ` +
              "deterministic (creation === dispatch view), excerpt anchored",
          );
        } else {
          check.fail(
            "create.md",
            `created=${String(creation.created)} episodes=${String(episodes.length)} turns=${String(turns.length)} ` +
              `deterministic=${String(deterministic)}`,
          );
        }
      }
    }

    /* --- Scenario: create-from-selection (text-layer PDF, frozen pdf-01) + return card */
    const pdf = await importAndSettle(harness, treeA.id, "pdf-01.pdf", new Uint8Array(readFileSync(pdfBytesPath)));
    if (pdf.parseStatus !== "ready") {
      check.fail("create.pdf", `the frozen PDF fixture settled '${pdf.parseStatus}' (expected ready)`);
    } else {
      const page2 = pdfExpected.blocks.find((block) => block.page === 2)!;
      const needle = page2.text.slice(Math.floor(page2.text.length / 2), Math.floor(page2.text.length / 2) + 6);
      const selection = resolveOccurrence(harness, pdf.materialId, pdf.versionId, needle);
      if (selection === null) {
        check.fail("create.pdf", `selection resolution failed for needle '${needle}'`);
      } else {
        const creation = harness.branching.createMaterialBranch({ treeId: treeA.id, selection, intentKey: "b3-pdf-1" });
        const dispatch = await harness.branching.firstQuestion({
          treeId: treeA.id,
          intentKey: "b3-pdf-1",
          firstQuestion: "这一页在讲什么？",
        });
        const ret = await harness.branching.submitMaterialReturn({
          treeId: treeA.id,
          fromBranchId: creation.branch.id,
          text: "收获：第二页主题确认。",
          idempotencyKey: "b3-pdf-ret-1",
        });
        if (dispatch.dispatch === "succeeded" && ret.card.page === 2 && ret.card.parserKind === "pdf") {
          check.ok(
            "create.pdf",
            `pdf create-from-selection: page-2 block anchored, dispatched, return card page=2 ` +
              `parser=${ret.card.parserKind}/${ret.card.parserVersion}`,
          );
        } else {
          check.fail(
            "create.pdf",
            `dispatch=${dispatch.dispatch} cardPage=${String(ret.card.page)} parser=${ret.card.parserKind}`,
          );
        }
      }
    }

    /* --- Scenario: context window honesty ------------------------------ */
    const big = await importAndSettle(harness, treeA.id, "big.md", new TextEncoder().encode(largeMaterialText()));
    if (big.parseStatus !== "ready") {
      check.fail("context.bounds", `the generated large material settled '${big.parseStatus}'`);
    } else {
      const selection = resolveOccurrence(harness, big.materialId, big.versionId, "Block 30:");
      if (selection === null) {
        check.fail("context.bounds", "selection resolution failed on the large material");
      } else {
        const creation = harness.branching.createMaterialBranch({ treeId: treeA.id, selection, intentKey: "b3-big-1" });
        const context = creation.context;
        const honest =
          context.truncated &&
          context.truncationNote !== null &&
          context.composed.includes("[Context truncated:") &&
          context.composedUnits <= MATERIAL_CONTEXT_LIMIT_UNITS &&
          context.composed.includes(selection.excerpt) &&
          !context.composed.includes("Block 00:") &&
          !context.composed.includes("Block 60:");
        if (honest) {
          check.ok(
            "context.bounds",
            `large material: truncated=true with the explicit marker, composed=${String(context.composedUnits)}u ` +
              `≤ ${String(MATERIAL_CONTEXT_LIMIT_UNITS)}, selection in full, distant blocks excluded`,
          );
        } else {
          check.fail(
            "context.bounds",
            `truncated=${String(context.truncated)} units=${String(context.composedUnits)} ` +
              `marker=${String(context.composed.includes("[Context truncated:"))}`,
          );
        }
      }
    }
    const oversized = await importAndSettle(
      harness,
      treeA.id,
      "huge.md",
      new TextEncoder().encode(oversizedSelectionText()),
    );
    if (oversized.parseStatus !== "ready") {
      check.fail("context.oversized", `the oversized-selection material settled '${oversized.parseStatus}'`);
    } else {
      const resolution = harness.resolver.resolve({
        materialId: oversized.materialId,
        versionId: oversized.versionId,
        locator: { kind: "utf16-range", start: 0, end: MATERIAL_MAX_SELECTION_UNITS + 100 },
      });
      if (!resolution.ok) {
        check.fail("context.oversized", `range resolution failed: ${resolution.rejection.code}`);
      } else {
        const branchesBefore = harness.repository.listBranches(treeA.id).length;
        let refused = false;
        try {
          harness.branching.createMaterialBranch({
            treeId: treeA.id,
            selection: resolution.result.selection,
            intentKey: "b3-huge-1",
          });
        } catch {
          refused = true;
        }
        const zeroRows =
          harness.repository.listBranches(treeA.id).length === branchesBefore &&
          harness.materialRepository.findFirstQuestion(treeA.id, "b3-huge-1") === null;
        if (refused && zeroRows) {
          check.ok(
            "context.oversized",
            `a ${String(MATERIAL_MAX_SELECTION_UNITS + 100)}u selection is refused with zero rows ` +
              "(truncating the user's own selection would be a dishonest anchor)",
          );
        } else {
          check.fail("context.oversized", `refused=${String(refused)} zeroRows=${String(zeroRows)}`);
        }
      }
    }

    /* --- Scenario: independent origin + idempotent first question + restart */
    const loopTree = harness.service.createTree().tree;
    const loopMaterial = await importAndSettle(harness, loopTree.id, "loop.md", new TextEncoder().encode(THREE_BLOCKS));
    if (loopMaterial.parseStatus !== "ready") {
      check.fail("firstquestion.dispatch", `the loop material settled '${loopMaterial.parseStatus}'`);
    } else {
      const selection = resolveOccurrence(harness, loopMaterial.materialId, loopMaterial.versionId, "Beta context block");
      if (selection === null) {
        check.fail("firstquestion.dispatch", "selection resolution failed on the loop material");
      } else {
        const trunkId = harness.service.getTreeState(loopTree.id).trunkBranchId!;
        const trunkPrompt = await harness.service.prompt(loopTree.id, trunkId, "trunk 主线提问");
        const creation = harness.branching.createMaterialBranch({ treeId: loopTree.id, selection, intentKey: "b3-fq-1" });
        const dispatch = await harness.branching.firstQuestion({
          treeId: loopTree.id,
          intentKey: "b3-fq-1",
          firstQuestion: "Beta 上下文在讲什么？",
        });
        const prefix = `[exploration from material ${loopMaterial.versionId}]`;
        const independent =
          dispatch.dispatch === "succeeded" &&
          dispatch.outcome !== null &&
          dispatch.outcome.run.session.sessionId !== trunkPrompt.run.session.sessionId;
        const audited = dispatch.outcome?.userTurn.text === `${prefix}\n\nBeta 上下文在讲什么？`;
        const contextEntered =
          dispatch.outcome?.assistantTurn.text.includes("[Exploration context from material") === true;
        if (independent && audited && contextEntered) {
          check.ok(
            "firstquestion.dispatch",
            "independent session (≠ the trunk run's session), audited versionId-only prefix, composed context entered the model input",
          );
        } else {
          check.fail(
            "firstquestion.dispatch",
            `independent=${String(independent)} audited=${String(audited)} contextEntered=${String(contextEntered)}`,
          );
        }

        /* Replay: no re-send, same landed turn, zero new rows. */
        const replay = await harness.branching.firstQuestion({
          treeId: loopTree.id,
          intentKey: "b3-fq-1",
          firstQuestion: "Beta 上下文在讲什么？",
        });
        const replayHonest =
          replay.dispatch === "succeeded" &&
          replay.outcome === null &&
          replay.landed?.userTurnId === dispatch.landed?.userTurnId &&
          harness.repository.listTurns(creation.branch.id).length === 2;
        if (replayHonest) {
          check.ok("firstquestion.replay", "same key + same question replays the landed turn without re-sending");
        } else {
          check.fail("firstquestion.replay", `dispatch=${replay.dispatch} outcomeNull=${String(replay.outcome === null)}`);
        }

        /* Restart determinism: dispose, reopen the same data dir, replay. */
        const userTurnId = dispatch.landed!.userTurnId;
        const runId = dispatch.landed!.runId;
        const sessionsBefore = readdirSync(join(harness.dir, "sessions")).length;
        const dataDir = harness.dir;
        await harness.shutdown();
        harness = await openHarness(dataDir);
        const replay2 = await harness.branching.firstQuestion({
          treeId: loopTree.id,
          intentKey: "b3-fq-1",
          firstQuestion: "Beta 上下文在讲什么？",
        });
        const restartHonest =
          replay2.dispatch === "succeeded" &&
          replay2.outcome === null &&
          replay2.landed?.userTurnId === userTurnId &&
          replay2.landed?.runId === runId &&
          readdirSync(join(harness.dir, "sessions")).length === sessionsBefore;
        if (restartHonest) {
          check.ok(
            "firstquestion.restart",
            "post-restart replay reconciles the same landed turn/run, zero new sessions or branches",
          );
        } else {
          check.fail(
            "firstquestion.restart",
            `dispatch=${replay2.dispatch} sameTurn=${String(replay2.landed?.userTurnId === userTurnId)}`,
          );
        }

        /* 409 discipline: different content after landing / same key different selection. */
        let conflictContent = false;
        try {
          await harness.branching.firstQuestion({ treeId: loopTree.id, intentKey: "b3-fq-1", firstQuestion: "换一个问题" });
        } catch (err) {
          conflictContent = err instanceof MaterialFirstQuestionConflictError;
        }
        const other = resolveOccurrence(harness, loopMaterial.materialId, loopMaterial.versionId, "Gamma 收尾");
        let conflictSelection = false;
        try {
          harness.branching.createMaterialBranch({ treeId: loopTree.id, selection: other!, intentKey: "b3-fq-1" });
        } catch (err) {
          conflictSelection = err instanceof MaterialBranchConflictError;
        }
        if (conflictContent && conflictSelection) {
          check.ok(
            "firstquestion.conflict",
            "different first-question content and same-key-different-selection both refuse (409 discipline)",
          );
        } else {
          check.fail(
            "firstquestion.conflict",
            `content=${String(conflictContent)} selection=${String(conflictSelection)}`,
          );
        }
      }
    }

    /* --- Scenario: reconciliation-before-action ------------------------- */
    const reconTree = harness.service.createTree().tree;
    const reconMaterial = await importAndSettle(harness, reconTree.id, "recon.md", new TextEncoder().encode(THREE_BLOCKS));
    if (reconMaterial.parseStatus !== "ready") {
      check.fail("reconciliation", `the recon material settled '${reconMaterial.parseStatus}'`);
    } else {
      const selection = resolveOccurrence(harness, reconMaterial.materialId, reconMaterial.versionId, "Beta context block");
      const recon = harness.branching.createMaterialBranch({ treeId: reconTree.id, selection: selection!, intentKey: "b3-recon-1" });
      /* Process-death shape: episode + queued run, no landed turn. */
      const episode = harness.repository.createEpisode(recon.branch.id);
      const fakeReference: SessionReference = {
        sessionId: "session_b3_fake" as SessionReference["sessionId"],
        sessionFile: "b3-fake-session.jsonl",
        entryId: "entry_b3_fake" as SessionReference["entryId"],
        piVersion: "0.85.1" as SessionReference["piVersion"],
        availability: { status: "available" },
      };
      const hungRun = harness.repository.createRun(episode.id, fakeReference);
      const blocked = await harness.branching.firstQuestion({
        treeId: reconTree.id,
        intentKey: "b3-recon-1",
        firstQuestion: "悬置后的问题",
      });
      const blockedHonest =
        blocked.dispatch === "unknown" &&
        blocked.outcome === null &&
        blocked.error?.code === "dispatch-unknown" &&
        harness.repository.listTurns(recon.branch.id).length === 0;
      /* Host sweeps the hung run to a terminal failure (recovery duty). */
      harness.repository.updateRunState(hungRun.id, "failed", {
        failure: { code: "unknown", message: "swept by the b3 check to unblock reconciliation" },
      });
      if (blockedHonest) {
        check.ok(
          "reconciliation.unknown",
          "a non-terminal run yields dispatch 'unknown' WITHOUT re-sending (reconcile first, act second)",
        );
      } else {
        check.fail(
          "reconciliation.unknown",
          `dispatch=${blocked.dispatch} turns=${String(harness.repository.listTurns(recon.branch.id).length)}`,
        );
      }

      /* Explicit upstream failure → 'failed'; the retry is an allowed new attempt. */
      const sentinelTree = harness.service.createTree().tree;
      const sentinelMaterial = await importAndSettle(
        harness,
        sentinelTree.id,
        "sentinel.md",
        new TextEncoder().encode(THREE_BLOCKS),
      );
      const sentinelSelection = resolveOccurrence(
        harness,
        sentinelMaterial.materialId,
        sentinelMaterial.versionId,
        "Beta context block",
      );
      harness.branching.createMaterialBranch({
        treeId: sentinelTree.id,
        selection: sentinelSelection!,
        intentKey: "b3-sentinel-1",
      });
      const failed = await harness.branching.firstQuestion({
        treeId: sentinelTree.id,
        intentKey: "b3-sentinel-1",
        firstQuestion: `${FAILURE_SENTINEL} 会失败的首问`,
      });
      const failedHonest = failed.dispatch === "failed" && failed.error?.code === "upstream";
      const retry = await harness.branching.firstQuestion({
        treeId: sentinelTree.id,
        intentKey: "b3-sentinel-1",
        firstQuestion: "去掉哨兵后的重试",
      });
      const retryHonest = retry.dispatch === "succeeded" && retry.outcome !== null;
      if (failedHonest && retryHonest) {
        check.ok(
          "reconciliation.failed",
          "an explicit upstream failure reports 'failed' honestly and the retry dispatches (retry = a new explicit attempt)",
        );
      } else {
        check.fail(
          "reconciliation.failed",
          `failed=${failed.dispatch}/${String(failed.error?.code)} retry=${retry.dispatch}`,
        );
      }
      void sentinelSelection;
    }

    /* --- Scenario: restore vs explicit new + look-alike + cross-tree ---- */
    const restoreTreeA = harness.service.createTree().tree;
    const restoreTreeB = harness.service.createTree().tree;
    const restoreMaterial = await importAndSettle(
      harness,
      restoreTreeA.id,
      "restore.md",
      new TextEncoder().encode(THREE_BLOCKS),
    );
    if (restoreMaterial.parseStatus !== "ready") {
      check.fail("restore", `the restore material settled '${restoreMaterial.parseStatus}'`);
    } else {
      harness.materialRepository.linkTreeMaterial(restoreTreeB.id, restoreMaterial.materialId);
      const selection = resolveOccurrence(
        harness,
        restoreMaterial.materialId,
        restoreMaterial.versionId,
        "Beta context block",
      );
      const created = harness.branching.createMaterialBranch({
        treeId: restoreTreeA.id,
        selection: selection!,
        intentKey: "b3-src-1",
      });
      await harness.branching.firstQuestion({ treeId: restoreTreeA.id, intentKey: "b3-src-1", firstQuestion: "恢复场景首问" });
      const restored = await harness.branching.restoreOrOpen({ treeId: restoreTreeA.id, selection: selection!, mode: "restore" });
      const reopened = await harness.branching.restoreOrOpen({
        treeId: restoreTreeA.id,
        selection: selection!,
        mode: "new",
        intentKey: "b3-src-2",
      });
      /* Look-alike: a different material carrying the same excerpt text. */
      const twin = await importAndSettle(
        harness,
        restoreTreeA.id,
        "twin.md",
        new TextEncoder().encode("另一份材料。\n\nBeta context block 中英混排。\n\n完全不同的首尾。"),
      );
      const twinSelection = resolveOccurrence(harness, twin.materialId, twin.versionId, "Beta context block");
      let lookalikeRefused = false;
      try {
        await harness.branching.restoreOrOpen({ treeId: restoreTreeA.id, selection: twinSelection!, mode: "restore" });
      } catch {
        lookalikeRefused = true;
      }
      /* Cross-tree: the same linked material has no exploration in tree B. */
      let crossTreeRefused = false;
      try {
        await harness.branching.restoreOrOpen({ treeId: restoreTreeB.id, selection: selection!, mode: "restore" });
      } catch {
        crossTreeRefused = true;
      }
      const treeBBranch = harness.branching.createMaterialBranch({
        treeId: restoreTreeB.id,
        selection: selection!,
        intentKey: "b3-src-b",
      });
      const treeBDispatch = await harness.branching.firstQuestion({
        treeId: restoreTreeB.id,
        intentKey: "b3-src-b",
        firstQuestion: "树 B 的首问",
      });
      const honest =
        restored.mode === "restored" &&
        restored.branch.id === created.branch.id &&
        restored.sessionAvailability === "available" &&
        reopened.mode === "created" &&
        reopened.branch.id !== created.branch.id &&
        lookalikeRefused &&
        crossTreeRefused &&
        treeBDispatch.dispatch === "succeeded" &&
        treeBBranch.branch.treeId === restoreTreeB.id;
      if (honest) {
        check.ok(
          "restore",
          "same source restores the existing branch (session available); explicit new opens a second; " +
            "look-alike material and cross-tree restores are refused; tree B owns its own branch",
        );
      } else {
        check.fail(
          "restore",
          `restored=${restored.mode}/${String(restored.branch.id === created.branch.id)} ` +
            `new=${String(reopened.branch.id !== created.branch.id)} lookalike=${String(lookalikeRefused)} ` +
            `crossTree=${String(crossTreeRefused)} treeB=${treeBDispatch.dispatch}`,
        );
      }
    }

    /* --- Scenario: material return + adoption --------------------------- */
    const returnTree = harness.service.createTree().tree;
    const returnMaterial = await importAndSettle(
      harness,
      returnTree.id,
      "return.md",
      new TextEncoder().encode(THREE_BLOCKS),
    );
    if (returnMaterial.parseStatus !== "ready") {
      check.fail("return", `the return material settled '${returnMaterial.parseStatus}'`);
    } else {
      const selection = resolveOccurrence(harness, returnMaterial.materialId, returnMaterial.versionId, "Beta context block");
      const creation = harness.branching.createMaterialBranch({ treeId: returnTree.id, selection: selection!, intentKey: "b3-ret-1" });
      await harness.branching.firstQuestion({ treeId: returnTree.id, intentKey: "b3-ret-1", firstQuestion: "return 首问" });
      const trunkId = harness.service.getTreeState(returnTree.id).trunkBranchId!;
      const submission = await harness.branching.submitMaterialReturn({
        treeId: returnTree.id,
        fromBranchId: creation.branch.id,
        text: "收获：Beta 是窗口的中心块。",
        idempotencyKey: "b3-ret-key-1",
      });
      const replay = await harness.branching.submitMaterialReturn({
        treeId: returnTree.id,
        fromBranchId: creation.branch.id,
        text: "收获：Beta 是窗口的中心块。",
        idempotencyKey: "b3-ret-key-1",
      });
      await harness.service.prompt(returnTree.id, trunkId, "主线消化这份收获");
      const attempts = harness.repository.listReturnAdoptionAttempts(submission.returnTurn.id);
      const honest =
        submission.created &&
        submission.returnTurn.branchId === trunkId &&
        submission.returnTurn.targetAnchor === null &&
        submission.card.excerpt === selection!.excerpt &&
        submission.card.blockId === selection!.blockId &&
        submission.navigation.status === "no-session" &&
        !replay.created &&
        replay.returnTurn.id === submission.returnTurn.id &&
        attempts.length === 1;
      if (honest) {
        check.ok(
          "return",
          "lands on the trunk with targetAnchor=null (no fabricated mainline anchor), full source card, " +
            "idempotent replay, one adoption attempt recorded after the trunk prompt",
        );
      } else {
        check.fail(
          "return",
          `created=${String(submission.created)} anchorNull=${String(submission.returnTurn.targetAnchor === null)} ` +
            `replay=${String(!replay.created)} attempts=${String(attempts.length)}`,
        );
      }
    }

    /* --- Scenario: missing session → explicit new exploration ----------- */
    const lossTree = harness.service.createTree().tree;
    const lossMaterial = await importAndSettle(harness, lossTree.id, "loss.md", new TextEncoder().encode(THREE_BLOCKS));
    if (lossMaterial.parseStatus !== "ready") {
      check.fail("sessionloss", `the loss material settled '${lossMaterial.parseStatus}'`);
    } else {
      const selection = resolveOccurrence(harness, lossMaterial.materialId, lossMaterial.versionId, "Beta context block");
      const creation = harness.branching.createMaterialBranch({ treeId: lossTree.id, selection: selection!, intentKey: "b3-loss-1" });
      await harness.branching.firstQuestion({ treeId: lossTree.id, intentKey: "b3-loss-1", firstQuestion: "丢失前的首问" });
      const branchId = creation.branch.id;
      const dataDir = harness.dir;
      await harness.shutdown();
      const sessionsDir = join(dataDir, "sessions");
      for (const file of readdirSync(sessionsDir)) rmSync(join(sessionsDir, file));
      harness = await openHarness(dataDir);
      let failClosed = false;
      try {
        await harness.service.prompt(lossTree.id, branchId, "普通续聊必须拒绝");
      } catch (err) {
        failClosed = err instanceof Error && (err as { code?: unknown }).code === "session-corrupt";
      }
      const exploration = await harness.branching.promptNewMaterialExploration(lossTree.id, branchId, "换轨后的新问题");
      const contextCarried =
        exploration.assistantTurn.text.includes("[Exploration context from material") &&
        exploration.assistantTurn.text.includes("换轨后的新问题");
      /* The landed first question still replays idempotently after the loss. */
      const replay = await harness.branching.firstQuestion({
        treeId: lossTree.id,
        intentKey: "b3-loss-1",
        firstQuestion: "丢失前的首问",
      });
      const honest =
        failClosed &&
        exploration.run.state === "succeeded" &&
        contextCarried &&
        replay.dispatch === "succeeded" &&
        replay.outcome === null;
      if (honest) {
        check.ok(
          "sessionloss",
          "normal continuation fails closed; the explicit new exploration carries the material context; " +
            "the landed first question still replays idempotently",
        );
      } else {
        check.fail(
          "sessionloss",
          `failClosed=${String(failClosed)} state=${exploration.run.state} ` +
            `contextCarried=${String(contextCarried)} replay=${replay.dispatch}`,
        );
      }
    }

    /* --- Scenario: non-ready refusal (frozen B1 negative) --------------- */
    const negativeTree = harness.service.createTree().tree;
    const negative = await importAndSettle(
      harness,
      negativeTree.id,
      "neg-pdf-corrupt.pdf",
      new Uint8Array(readFileSync(negativeBytesPath)),
    );
    if (negative.parseStatus === "ready") {
      check.fail("nonready", "the corrupt negative unexpectedly reached ready");
    } else if (negative.parseStatus === "timeout") {
      check.fail("nonready", "the corrupt negative never settled");
    } else {
      /* The resolver refuses anchoring on the non-ready version; so does the
         branching service (material-not-ready) — never a fabricated success. */
      const resolution = harness.resolver.resolve({
        materialId: negative.materialId,
        versionId: negative.versionId,
        locator: { kind: "utf16-range", start: 0, end: 4 },
      });
      const refusedAtResolver = !resolution.ok && resolution.rejection.code === "material-not-ready";
      let refusedAtBranching = false;
      if (resolution.ok) {
        try {
          harness.branching.createMaterialBranch({
            treeId: negativeTree.id,
            selection: resolution.result.selection,
            intentKey: "b3-neg-1",
          });
        } catch (err) {
          refusedAtBranching = err instanceof Error && err.message.includes("not ready");
        }
      }
      const zeroBranches = harness.repository.listBranches(negativeTree.id).length === 1;
      if ((refusedAtResolver || refusedAtBranching) && zeroBranches) {
        check.ok(
          "nonready",
          `the corrupt negative settles '${negative.parseStatus}' and branching/refusal stay honest (zero fabricated rows)`,
        );
      } else {
        check.fail(
          "nonready",
          `status=${negative.parseStatus} resolverRefused=${String(refusedAtResolver)} ` +
            `branchingRefused=${String(refusedAtBranching)} zeroBranches=${String(zeroBranches)}`,
        );
      }
    }
  } finally {
    await harness.shutdown().catch(() => {});
    rmSync(harness.dir, { recursive: true, force: true });
  }

  if (check.problems.length > 0) {
    return {
      status: "FAIL",
      exitCode: 2,
      detail: `${String(check.passed)} scenarios passed, ${String(check.problems.length)} failed`,
      lines: check.lines,
      problems: check.problems,
    };
  }
  return {
    status: "PASS",
    exitCode: 0,
    detail: `${String(check.passed)} deterministic scenarios passed on the real service stack (echo runtime, zero credentials)`,
    lines: check.lines,
    problems: [],
  };
}
