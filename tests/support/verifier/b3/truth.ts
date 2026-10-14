/** truth owner; frozen probe bodies and order preserved. */
import { readFileSync } from "node:fs";

import { join } from "node:path";




import { MATERIAL_MAX_SELECTION_UNITS } from "../../../../apps/studio/src/materials/branching.ts";






/* ------------------------------------------------------------------ */
/* Frozen fixture shapes (B1 expected truth — mirrors d4-probes.ts)    */
/* ------------------------------------------------------------------ */

export interface ExpectedBlock {
  readonly blockId: string;
  readonly start: number;
  readonly end: number;
  readonly page?: number;
  readonly text: string;
}


export interface ExpectedTruth {
  readonly canonicalText: string;
  readonly blocks: readonly ExpectedBlock[];
}


export function readExpected(path: string, problems: string[], fixtureId: string): ExpectedTruth | null {
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

export const THREE_BLOCKS = "Alpha 开篇 baseline。\n\nBeta context block 中英混排。\n\nGamma 收尾 tail。";


/** 61 blocks × ~1000 units ≈ 61,000 units — far over the 24,000 cap. */
export function largeMaterialText(): string {
  const paragraphs: string[] = [];
  for (let index = 0; index < 61; index += 1) {
    paragraphs.push(`Block ${String(index).padStart(2, "0")}: ${"探索段落内容。".repeat(160)}`);
  }
  return paragraphs.join("\n\n");
}


/** One single huge block so a >20,000-unit selection is representable. */
export function oversizedSelectionText(): string {
  return `超限选区材料。${"长".repeat(MATERIAL_MAX_SELECTION_UNITS + 500)}`;
}


/** Deterministic upstream-failure sentinel (service.test.ts 同款代理纪律). */
export const FAILURE_SENTINEL = "TRIGGER-B3-UPSTREAM-FAILURE";
