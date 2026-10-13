/** layout ownership for pdf-parser.ts; compatibility entrypoint remains one level above. */
import {
  PdfCorruptError,
} from "./errors.ts";
import type {
  PageTextLine,
} from "./model.ts";

/* ------------------------------------------------------------------ */
/* 钉死阅读顺序（移植 layout.mjs orderPageLines——d4-pdf-v1 唯一规则）    */
/* ------------------------------------------------------------------ */

/** 栏带间隔阈值（PDF 点）：x 超出当前带最大 x 超过该值开新带。 */
export const BAND_GAP = 40;

export function orderPageLines(lines: readonly PageTextLine[]): PageTextLine[] {
  const xs = [...new Set(lines.map((l) => l.x))].sort((a, b) => a - b);
  const bands: { minX: number; maxX: number }[] = [];
  let band: { minX: number; maxX: number } | null = null;
  for (const x of xs) {
    if (band === null || x - band.maxX > BAND_GAP) {
      band = { minX: x, maxX: x };
      bands.push(band);
    } else if (x > band.maxX) {
      band.maxX = x;
    }
  }
  const bandIndexOf = (x: number): number => {
    for (let i = 0; i < bands.length; i += 1) {
      if (x >= bands[i]!.minX && x <= bands[i]!.maxX) return i;
    }
    throw new PdfCorruptError(`x ${String(x)} not in any band`);
  };
  return [...lines].sort((a, b) => {
    const ba = bandIndexOf(a.x);
    const bb = bandIndexOf(b.x);
    if (ba !== bb) return ba - bb;
    if (a.y !== b.y) return b.y - a.y; // y 递减（页首在前）
    if (a.x !== b.x) return a.x - b.x;
    return a.order - b.order;
  });
}
