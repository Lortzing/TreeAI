/**
 * Shared B2「精确锚点」executing check (D4-2 wave, issue #8 charter §6 B2).
 *
 * Runs the REAL range/anchor resolution layer (MaterialRangeResolver — the
 * product service in apps/studio/src/materials/range-resolver.ts, NOT a test
 * helper) on top of the REAL import pipeline (MaterialImportService +
 * MaterialRepository + d4-md-v1 / d4-pdf-v1) in a throwaway SQLite database
 * against the frozen B2 selection set:
 *
 *  - every VALID selection (markdown-selections.json + pdf-selections.json)
 *    is imported through the pipeline and resolved through the resolver;
 *    the resolution must equal the stored truth EXACTLY (blockId, start, end,
 *    excerpt) and carry sourceHash === SHA-256(canonicalText of the frozen
 *    truth) — 精确匹配 100%，构造性成立，不信任任何手写偏移；
 *  - every INVALID selection (invalid-selections.json) must be REJECTED with
 *    the correct category reason (误定位为 0): range categories map 1:1 to
 *    the resolver's frozen rejection codes; stale-version items execute the
 *    md-vpair version pair (anchor excerpt from v1, re-anchored on v2 →
 *    stale-version; the old version stays readable and its anchor
 *    re-resolves); unsupported-material items point at negative fixtures
 *    whose versions end failed → material-not-ready (no canonical text to
 *    anchor, never an empty ready document);
 *  - honest per-item reporting: every item contributes one evidence line; a
 *    fixture that resolves despite being frozen invalid counts as a
 *    MIS-LOCATION (check FAIL); nothing is ever moved out of the denominator.
 *
 * Consumers: scripts/verify-d4.js (check `b2-precise-anchors`). The frozen
 * fixture tree stays read-only — nothing under tests/fixtures/d4 is written.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MaterialRepository, TreeRepository } from "@treeai/persistence";
import type { MaterialId, MaterialVersionId, TreeId } from "@treeai/contracts";
import { MaterialImportService } from "../../../apps/studio/src/materials/import-service.ts";
import { MaterialRangeResolver } from "../../../apps/studio/src/materials/range-resolver.ts";

export interface B2AnchorsCheckOutcome {
  readonly status: "PASS" | "FAIL" | "NOT_RUN";
  readonly exitCode: number | null;
  /** One-line summary for the check matrix. */
  readonly detail: string;
  /** Per-item execution lines (evidence log). */
  readonly lines: readonly string[];
  readonly problems: readonly string[];
}

/* ------------------------------------------------------------------ */
/* Frozen fixture shapes (mirrors d4-probes.ts field vocabulary)         */
/* ------------------------------------------------------------------ */

interface ValidSelectionItem {
  readonly id: string;
  readonly fixture: string;
  readonly category: string;
  readonly locator: { readonly kind: string; readonly [key: string]: unknown };
  readonly expected: {
    readonly blockId: string;
    readonly start: number;
    readonly end: number;
    readonly excerpt: string;
  };
}

interface InvalidSelectionItem {
  readonly id: string;
  readonly category: string;
  readonly input: {
    readonly fixture?: string;
    readonly pair?: string;
    readonly start?: number;
    readonly end?: number;
    readonly blockId?: string;
    readonly excerpt?: string;
  };
  readonly expectReason?: string;
}

interface RegistryFixtureEntry {
  readonly fixtureId: string;
  readonly file: string;
  readonly expected?: string;
  readonly outcome: string;
}
interface RegistryNegativeEntry {
  readonly fixtureId: string;
  readonly file: string;
  readonly reason: string;
}
interface RegistryPairEntry {
  readonly materialKey: string;
  readonly v1File: string;
  readonly v2File: string;
  readonly v1Expected: string;
  readonly v2Expected: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function readJson(path: string, problems: string[], what: string): Record<string, unknown> | null {
  try {
    const record = asRecord(JSON.parse(readFileSync(path, "utf8")));
    if (record === null) {
      problems.push(`${what}: not a JSON object at ${path}`);
      return null;
    }
    return record;
  } catch (error) {
    problems.push(`${what}: unreadable/invalid JSON at ${path} (${error instanceof Error ? error.message : String(error)})`);
    return null;
  }
}

/** B1 冻结真值（canonicalText + blocks）。 */
interface ExpectedTruth {
  readonly canonicalText: string;
  readonly blocks: readonly { blockId: string; start: number; end: number; kind: string }[];
}

function loadExpected(path: string, problems: string[], fixtureId: string): ExpectedTruth | null {
  const raw = readJson(path, problems, `b1 expected ${fixtureId}`);
  if (raw === null) return null;
  const canonicalText = asString(raw["canonicalText"]);
  const blocksRaw = asArray(raw["blocks"]);
  if (canonicalText === null || blocksRaw === null) {
    problems.push(`b1 expected ${fixtureId}: missing canonicalText/blocks`);
    return null;
  }
  const blocks: { blockId: string; start: number; end: number; kind: string }[] = [];
  for (const entry of blocksRaw) {
    const record = asRecord(entry);
    const blockId = record === null ? null : asString(record["blockId"]);
    const kind = record === null ? null : asString(record["kind"]);
    const start = record === null ? undefined : record["start"];
    const end = record === null ? undefined : record["end"];
    if (blockId === null || kind === null || typeof start !== "number" || typeof end !== "number") {
      problems.push(`b1 expected ${fixtureId}: malformed block entry`);
      return null;
    }
    blocks.push({ blockId, start, end, kind });
  }
  return { canonicalText, blocks };
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/* ------------------------------------------------------------------ */
/* The check                                                            */
/* ------------------------------------------------------------------ */

interface Harness {
  readonly service: MaterialImportService;
  readonly resolver: MaterialRangeResolver;
  readonly treeId: TreeId;
  readonly dir: string;
  dispose(): void;
}

function openHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "treeai-d4-b2-"));
  const dbPath = join(dir, "treeai.db");
  const treeRepository = TreeRepository.open({ path: dbPath });
  const materialRepository = MaterialRepository.open({ path: dbPath });
  const service = new MaterialImportService({ repository: materialRepository });
  const resolver = new MaterialRangeResolver({ repository: materialRepository });
  const forest = treeRepository.createForest();
  const tree = treeRepository.createTree(forest.id);
  return {
    service,
    resolver,
    treeId: tree.id,
    dir,
    dispose(): void {
      materialRepository.close();
      treeRepository.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["ready", "failed", "canceled", "unsupported", "rejected"]);

async function untilTerminal(
  harness: Harness,
  materialId: MaterialId,
  timeoutMs: number,
  problems: string[],
): Promise<{ status: string; parseError: string | null } | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const detail = harness.service.getMaterialDetail(harness.treeId, materialId);
    const version = detail.versions[detail.versions.length - 1] ?? null;
    if (version !== null && TERMINAL_STATUSES.has(version.parseStatus)) {
      return { status: version.parseStatus, parseError: version.parseError };
    }
    if (Date.now() > deadline) {
      problems.push(`timed out waiting for a terminal parse status (material ${materialId})`);
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 读尽一个版本的分块文本（真实读取面）。 */
function readVersionText(harness: Harness, materialId: MaterialId, versionId: MaterialVersionId): string | null {
  const parts: string[] = [];
  let afterBlock: string | null = null;
  for (;;) {
    const page = harness.service.readVersionBlocks(harness.treeId, materialId, versionId, afterBlock === null ? {} : { afterBlock });
    for (const entry of page.blocks) parts.push(entry.text);
    if (page.nextAfterBlock === null) return parts.join("");
    afterBlock = page.nextAfterBlock;
  }
}

/** B2 无效类别 → 解析层冻结拒绝原因码（1:1，除两个特殊类别）。 */
const RANGE_CATEGORY_CODES: Readonly<Record<string, string>> = {
  "out-of-bounds": "out-of-bounds",
  "zero-length": "zero-length",
  reversed: "reversed",
  "surrogate-split": "surrogate-split",
  "combining-split": "combining-split",
  "emoji-split": "emoji-split",
  "cross-page": "cross-page",
  "block-mismatch": "block-mismatch",
  "excerpt-mismatch": "excerpt-mismatch",
};

async function runB2AnchorsCheck(d4Root: string): Promise<B2AnchorsCheckOutcome> {
  const problems: string[] = [];
  const lines: string[] = [];
  const b2Root = join(d4Root, "b2-anchors");
  const b1Root = join(d4Root, "b1-import");
  if (!existsSync(b2Root)) {
    return { status: "NOT_RUN", exitCode: null, detail: "tests/fixtures/d4/b2-anchors not present in this tree", lines, problems };
  }

  /* ---- registries (fixture/negative/pair resolution) ---- */
  interface ReadyEntry {
    readonly file: string;
    readonly kind: "markdown" | "pdf";
    readonly expectedPath: string;
  }
  const readyByFixture = new Map<string, ReadyEntry>();
  const negativeByFixture = new Map<string, RegistryNegativeEntry>();
  const pairsByKey = new Map<string, RegistryPairEntry>();
  for (const name of ["md-registry.json", "pdf-registry.json"]) {
    const registryPath = join(b1Root, name);
    if (!existsSync(registryPath)) continue;
    const raw = readJson(registryPath, problems, `b1 ${name}`);
    if (raw === null) continue;
    const kind = asString(raw["kind"]) === "pdf" ? "pdf" : "markdown";
    for (const entry of asArray(raw["fixtures"]) ?? []) {
      const record = asRecord(entry);
      const fixtureId = record === null ? null : asString(record["fixtureId"]);
      const file = record === null ? null : asString(record["file"]);
      const expected = record === null ? null : asString(record["expected"]);
      const outcome = record === null ? null : asString(record["outcome"]);
      if (fixtureId === null || file === null || expected === null || outcome === null) continue;
      if (outcome === "ready") readyByFixture.set(fixtureId, { file, kind, expectedPath: expected });
    }
    for (const entry of asArray(raw["negativeFixtures"]) ?? []) {
      const record = asRecord(entry);
      const fixtureId = record === null ? null : asString(record["fixtureId"]);
      const file = record === null ? null : asString(record["file"]);
      const reason = record === null ? null : asString(record["reason"]);
      if (fixtureId !== null && file !== null && reason !== null) {
        negativeByFixture.set(fixtureId, { fixtureId, file, reason });
      }
    }
    for (const entry of asArray(raw["versionPairs"]) ?? []) {
      const record = asRecord(entry);
      const materialKey = record === null ? null : asString(record["materialKey"]);
      const v1File = record === null ? null : asString(record["v1File"]);
      const v2File = record === null ? null : asString(record["v2File"]);
      const v1Expected = record === null ? null : asString(record["v1Expected"]);
      const v2Expected = record === null ? null : asString(record["v2Expected"]);
      if (materialKey !== null && v1File !== null && v2File !== null && v1Expected !== null && v2Expected !== null) {
        pairsByKey.set(materialKey, { materialKey, v1File, v2File, v1Expected, v2Expected });
      }
    }
  }

  /* ---- selection files ---- */
  const validItems: ValidSelectionItem[] = [];
  const invalidItems: InvalidSelectionItem[] = [];
  for (const name of ["markdown-selections.json", "pdf-selections.json"]) {
    const raw = readJson(join(b2Root, name), problems, `b2 ${name}`);
    if (raw === null) continue;
    for (const entry of asArray(raw["items"]) ?? []) {
      const record = asRecord(entry);
      if (record === null) {
        problems.push(`b2 ${name}: non-object item`);
        continue;
      }
      const id = asString(record["id"]) ?? "?";
      const fixture = asString(record["fixture"]);
      const category = asString(record["category"]);
      const locator = asRecord(record["locator"]);
      const expected = asRecord(record["expected"]);
      if (fixture === null || category === null || locator === null || expected === null) {
        problems.push(`b2 ${name} ${id}: missing fixture/category/locator/expected`);
        continue;
      }
      const eStart = expected["start"];
      const eEnd = expected["end"];
      const eExcerpt = asString(expected["excerpt"]);
      const eBlock = asString(expected["blockId"]);
      if (typeof eStart !== "number" || typeof eEnd !== "number" || eExcerpt === null || eBlock === null) {
        problems.push(`b2 ${name} ${id}: malformed expected`);
        continue;
      }
      validItems.push({
        id,
        fixture,
        category,
        locator: locator as unknown as ValidSelectionItem["locator"],
        expected: { blockId: eBlock, start: eStart, end: eEnd, excerpt: eExcerpt },
      });
    }
  }
  {
    const raw = readJson(join(b2Root, "invalid-selections.json"), problems, "b2 invalid");
    if (raw !== null) {
      for (const entry of asArray(raw["items"]) ?? []) {
        const record = asRecord(entry);
        if (record === null) {
          problems.push("b2 invalid: non-object item");
          continue;
        }
        const id = asString(record["id"]) ?? "?";
        const category = asString(record["category"]);
        const input = asRecord(record["input"]);
        if (category === null || input === null) {
          problems.push(`b2 invalid ${id}: missing category/input`);
          continue;
        }
        invalidItems.push({
          id,
          category,
          input: input as unknown as InvalidSelectionItem["input"],
          expectReason: asString(record["expectReason"]) ?? undefined,
        });
      }
    }
  }
  if (validItems.length === 0 || invalidItems.length === 0) {
    return {
      status: "NOT_RUN",
      exitCode: null,
      detail: `b2-anchors present but no selection items were loadable (${validItems.length} valid / ${invalidItems.length} invalid)`,
      lines,
      problems,
    };
  }

  const harness = openHarness();
  let misLocations = 0;
  try {
    /* ---- fixture import cache (through the REAL import pipeline) ---- */
    const imported = new Map<
      string,
      { materialId: MaterialId; versionId: MaterialVersionId; truth: ExpectedTruth }
    >();
    const readyFixture = async (
      fixtureId: string,
    ): Promise<{ materialId: MaterialId; versionId: MaterialVersionId; truth: ExpectedTruth } | null> => {
      const cached = imported.get(fixtureId);
      if (cached !== undefined) return cached;
      const entry = readyByFixture.get(fixtureId);
      if (entry === undefined) {
        problems.push(`b2: fixture ${fixtureId} is not a registered ready b1 fixture`);
        return null;
      }
      const truth = loadExpected(join(b1Root, entry.expectedPath), problems, fixtureId);
      if (truth === null) return null;
      const bytes = new Uint8Array(readFileSync(join(b1Root, entry.file)));
      const result = await harness.service.importMaterial(harness.treeId, {
        filename: entry.file.split("/").pop() ?? `${fixtureId}.md`,
        bytes,
      });
      const terminal = await untilTerminal(harness, result.material.id, 60_000, problems);
      if (terminal === null) return null;
      if (terminal.status !== "ready") {
        problems.push(`b2: fixture ${fixtureId} did not reach ready ('${terminal.status}': ${terminal.parseError ?? ""})`);
        return null;
      }
      const record = { materialId: result.material.id, versionId: result.version.id, truth };
      imported.set(fixtureId, record);
      return record;
    };

    /* ---- version pair import (stale-version items) ---- */
    const pairsImported = new Map<
      string,
      {
        materialId: MaterialId;
        v1: MaterialVersionId;
        v2: MaterialVersionId;
        v1Text: string;
        v1Truth: ExpectedTruth;
      }
    >();
    const readyPair = async (materialKey: string) => {
      const cached = pairsImported.get(materialKey);
      if (cached !== undefined) return cached;
      const pair = pairsByKey.get(materialKey);
      if (pair === undefined) {
        problems.push(`b2: version pair ${materialKey} is not registered`);
        return null;
      }
      const first = await harness.service.importMaterial(harness.treeId, {
        filename: pair.v1File.split("/").pop() ?? "pair-v1.md",
        bytes: new Uint8Array(readFileSync(join(b1Root, pair.v1File))),
      });
      const firstTerminal = await untilTerminal(harness, first.material.id, 60_000, problems);
      if (firstTerminal === null || firstTerminal.status !== "ready") {
        problems.push(`b2: version pair ${materialKey}: v1 did not reach ready`);
        return null;
      }
      const second = await harness.service.addMaterialVersion(harness.treeId, first.material.id, {
        filename: pair.v2File.split("/").pop() ?? "pair-v2.md",
        bytes: new Uint8Array(readFileSync(join(b1Root, pair.v2File))),
      });
      if (second.created !== true) {
        problems.push(`b2: version pair ${materialKey}: v2 bytes did not append a new version`);
        return null;
      }
      const secondTerminal = await untilTerminal(harness, second.material.id, 60_000, problems);
      if (secondTerminal === null || secondTerminal.status !== "ready") {
        problems.push(`b2: version pair ${materialKey}: v2 did not reach ready`);
        return null;
      }
      const v1Truth = loadExpected(join(b1Root, pair.v1Expected), problems, `${materialKey}-v1`);
      if (v1Truth === null) return null;
      const v1Text = readVersionText(harness, first.material.id, first.version.id);
      if (v1Text !== v1Truth.canonicalText) {
        problems.push(`b2: version pair ${materialKey}: v1 text diverges from the frozen truth after v2 landed (old sources must stay readable)`);
        return null;
      }
      const record = {
        materialId: first.material.id,
        v1: first.version.id,
        v2: second.version.id,
        v1Text: v1Truth.canonicalText,
        v1Truth,
      };
      pairsImported.set(materialKey, record);
      lines.push(`version pair ${materialKey}: v1→v2 imported; v1 snapshot intact after v2 (old version stays readable)`);
      return record;
    };

    /* ---- valid selections: resolution must equal the frozen truth exactly ---- */
    let validOk = 0;
    const categoryCounts = new Map<string, number>();
    for (const item of validItems) {
      const fixture = await readyFixture(item.fixture);
      if (fixture === null) continue;
      const truth = fixture.truth;
      const resolution = harness.resolver.resolve({
        materialId: fixture.materialId,
        versionId: fixture.versionId,
        locator: item.locator as never,
      });
      if (!resolution.ok) {
        problems.push(`b2 valid ${item.id} (${item.category}): rejected '${resolution.rejection.code}' — ${resolution.rejection.message}`);
        continue;
      }
      const selection = resolution.result.selection;
      let exact = true;
      if (selection.start !== item.expected.start || selection.end !== item.expected.end) {
        problems.push(
          `b2 valid ${item.id}: resolved [${selection.start},${selection.end}) but the frozen truth is [${item.expected.start},${item.expected.end})`,
        );
        exact = false;
      }
      if (selection.excerpt !== item.expected.excerpt) {
        problems.push(`b2 valid ${item.id}: excerpt diverges from the frozen truth`);
        exact = false;
      }
      if (selection.blockId !== item.expected.blockId || resolution.result.block.blockId !== item.expected.blockId) {
        problems.push(
          `b2 valid ${item.id}: resolved block '${selection.blockId}' but the frozen truth is '${item.expected.blockId}'`,
        );
        exact = false;
      }
      if (selection.versionId !== fixture.versionId) {
        problems.push(`b2 valid ${item.id}: selection carries a foreign versionId`);
        exact = false;
      }
      if (selection.sourceHash !== sha256Text(truth.canonicalText)) {
        problems.push(`b2 valid ${item.id}: sourceHash does not match SHA-256(canonicalText) of the frozen truth`);
        exact = false;
      }
      /* 锚点复核往返：带期望摘录 + 声明块再解析，同样必须通过。 */
      const roundTrip = harness.resolver.resolve({
        materialId: fixture.materialId,
        versionId: fixture.versionId,
        locator: item.locator as never,
        excerpt: item.expected.excerpt,
        blockId: item.expected.blockId,
      });
      if (!roundTrip.ok) {
        problems.push(
          `b2 valid ${item.id}: anchor round-trip with the frozen excerpt/blockId was rejected '${roundTrip.rejection.code}'`,
        );
        exact = false;
      }
      if (!exact) continue;
      validOk += 1;
      categoryCounts.set(item.category, (categoryCounts.get(item.category) ?? 0) + 1);
      lines.push(
        `b2 valid ${item.id} (${item.category}): [${selection.start},${selection.end}) ${selection.blockId} — exact, round-trip ok`,
      );
    }

    /* ---- invalid selections: correct category rejection, zero mis-location ---- */
    let invalidOk = 0;
    const invalidCategoryCounts = new Map<string, number>();
    for (const item of invalidItems) {
      if (RANGE_CATEGORY_CODES[item.category] !== undefined) {
        /* 区间类别：真实 fixture + 冻结区间/声明。 */
        const fixtureId = item.input.fixture;
        const start = item.input.start;
        const end = item.input.end;
        if (fixtureId === undefined || typeof start !== "number" || typeof end !== "number") {
          problems.push(`b2 invalid ${item.id} (${item.category}): missing fixture/start/end`);
          continue;
        }
        const fixture = await readyFixture(fixtureId);
        if (fixture === null) continue;
        const resolution = harness.resolver.resolve({
          materialId: fixture.materialId,
          versionId: fixture.versionId,
          locator: { kind: "utf16-range", start, end },
          ...(typeof item.input.excerpt === "string" ? { excerpt: item.input.excerpt } : {}),
          ...(typeof item.input.blockId === "string" ? { blockId: item.input.blockId } : {}),
        });
        if (resolution.ok) {
          misLocations += 1;
          problems.push(
            `b2 invalid ${item.id} (${item.category}): MIS-LOCATION — the frozen-invalid range [${start},${end}) resolved successfully on ${fixtureId}`,
          );
          continue;
        }
        const expectedCode = RANGE_CATEGORY_CODES[item.category]!;
        if (resolution.rejection.code !== expectedCode) {
          problems.push(
            `b2 invalid ${item.id} (${item.category}): rejected '${resolution.rejection.code}' but the frozen category requires '${expectedCode}' — ${resolution.rejection.message}`,
          );
          continue;
        }
        invalidOk += 1;
        invalidCategoryCounts.set(item.category, (invalidCategoryCounts.get(item.category) ?? 0) + 1);
        lines.push(`b2 invalid ${item.id} (${item.category}): rejected '${resolution.rejection.code}' — correct`);
        continue;
      }
      if (item.category === "stale-version") {
        const pairKey = item.input.pair;
        const start = item.input.start;
        const end = item.input.end;
        if (pairKey === undefined || typeof start !== "number" || typeof end !== "number") {
          problems.push(`b2 invalid ${item.id} (stale-version): missing pair/start/end`);
          continue;
        }
        const pair = await readyPair(pairKey);
        if (pair === null) continue;
        if (end <= start || start < 0 || end > pair.v1Text.length) {
          problems.push(`b2 invalid ${item.id} (stale-version): range [${start},${end}) is empty or out of v1 bounds`);
          continue;
        }
        const anchorExcerpt = pair.v1Text.slice(start, end);
        const reanchored = harness.resolver.resolve({
          materialId: pair.materialId,
          versionId: pair.v2,
          locator: { kind: "utf16-range", start, end },
          excerpt: anchorExcerpt,
          anchor: { versionId: pair.v1, sourceHash: sha256Text(pair.v1Text) },
        });
        if (reanchored.ok) {
          misLocations += 1;
          problems.push(
            `b2 invalid ${item.id} (stale-version): MIS-LOCATION — the v1 anchor re-anchored successfully on v2`,
          );
          continue;
        }
        if (reanchored.rejection.code !== "stale-version") {
          problems.push(
            `b2 invalid ${item.id} (stale-version): rejected '${reanchored.rejection.code}' but the frozen category requires 'stale-version' — ${reanchored.rejection.message}`,
          );
          continue;
        }
        /* 旧版本可读：锚点在其锚定版本上重新解析（区间在 v1 上是完整选区
           时必须成功；结构性无效区间如实报告，不算本项失败）。 */
        const onOld = harness.resolver.resolve({
          materialId: pair.materialId,
          versionId: pair.v1,
          locator: { kind: "utf16-range", start, end },
          excerpt: anchorExcerpt,
        });
        const oldNote = onOld.ok
          ? `old anchor re-validates on v1 (${onOld.result.selection.blockId})`
          : `range is not a complete selection on v1 ('${onOld.rejection.code}'), v1 text stays readable via the reading API`;
        invalidOk += 1;
        invalidCategoryCounts.set("stale-version", (invalidCategoryCounts.get("stale-version") ?? 0) + 1);
        lines.push(`b2 invalid ${item.id} (stale-version): rejected 'stale-version' — correct; ${oldNote}`);
        continue;
      }
      if (item.category === "unsupported-material") {
        const fixtureId = item.input.fixture;
        if (fixtureId === undefined) {
          problems.push(`b2 invalid ${item.id} (unsupported-material): missing fixture`);
          continue;
        }
        const negative = negativeByFixture.get(fixtureId);
        if (negative === undefined) {
          problems.push(`b2 invalid ${item.id}: ${fixtureId} is not a registered negative fixture`);
          continue;
        }
        const bytes = new Uint8Array(readFileSync(join(b1Root, negative.file)));
        const importedNegative = await harness.service.importMaterial(harness.treeId, {
          filename: negative.file.split("/").pop() ?? "negative.bin",
          bytes,
        });
        const terminal = await untilTerminal(harness, importedNegative.material.id, 60_000, problems);
        if (terminal === null) continue;
        if (terminal.status === "ready") {
          problems.push(`b2 invalid ${item.id}: negative fixture ${fixtureId} reached ready (must not)`);
          continue;
        }
        const resolution = harness.resolver.resolve({
          materialId: importedNegative.material.id,
          versionId: importedNegative.version.id,
          locator: { kind: "utf16-range", start: 0, end: 10 },
        });
        if (resolution.ok) {
          misLocations += 1;
          problems.push(
            `b2 invalid ${item.id} (unsupported-material): MIS-LOCATION — a selection resolved against the ${terminal.status} version`,
          );
          continue;
        }
        if (resolution.rejection.code !== "material-not-ready") {
          problems.push(
            `b2 invalid ${item.id} (unsupported-material): rejected '${resolution.rejection.code}' but the frozen category requires 'material-not-ready' — ${resolution.rejection.message}`,
          );
          continue;
        }
        invalidOk += 1;
        invalidCategoryCounts.set("unsupported-material", (invalidCategoryCounts.get("unsupported-material") ?? 0) + 1);
        lines.push(
          `b2 invalid ${item.id} (unsupported-material): ${fixtureId} is ${terminal.status} ('${terminal.parseError ?? ""}'); anchoring refused 'material-not-ready' — correct`,
        );
        continue;
      }
      problems.push(`b2 invalid ${item.id}: unknown frozen category '${item.category}' (not executed)`);
    }

    /* ---- verdict ---- */
    const charterCoverage: ReadonlyArray<{ readonly label: string; readonly match: ReadonlySet<string> }> = [
      { label: "repeat-word-2nd", match: new Set(["repeat-word-2nd"]) },
      { label: "cross-line", match: new Set(["cross-line"]) },
      { label: "unicode-family", match: new Set(["unicode", "combining", "emoji", "astral", "full-width"]) },
      { label: "long-tail", match: new Set(["long-tail"]) },
    ];
    const coverageNotes: string[] = [];
    for (const requirement of charterCoverage) {
      let count = 0;
      for (const [category, n] of categoryCounts) {
        if (requirement.match.has(category)) count += n;
      }
      coverageNotes.push(`${requirement.label} x${count}`);
    }
    const passed =
      problems.length === 0 &&
      validOk === validItems.length &&
      invalidOk === invalidItems.length &&
      misLocations === 0;
    const detail =
      `${validOk}/${validItems.length} valid selections resolved exactly through the product range layer ` +
      `(${coverageNotes.join(", ")}); ${invalidOk}/${invalidItems.length} invalid selections rejected with the frozen ` +
      `category reason (${[...invalidCategoryCounts.entries()].map(([c, n]) => `${c}x${n}`).join(", ")}); ` +
      `mis-locations ${misLocations} (charter B2 requires 0)`;
    return {
      status: passed ? "PASS" : "FAIL",
      exitCode: passed ? 0 : 2,
      detail,
      lines,
      problems,
    };
  } finally {
    harness.dispose();
  }
}

export { runB2AnchorsCheck };
