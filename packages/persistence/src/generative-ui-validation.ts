import type { ComparisonDocument, ComparisonArtifact, UiGenerationContext } from "@treeai/contracts";
import { InvalidArgumentError } from "./errors.ts";

export const MAX_COMPARISON_CHARS = 12_000;
function invalid(): never { throw new InvalidArgumentError("对比卡结构或来源无效，请缩小范围后重试。"); }
function record(v: unknown, fields: readonly string[]): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return invalid();
  const r = v as Record<string, unknown>;
  if (Object.keys(r).length !== fields.length || Object.keys(r).some(k => !fields.includes(k))) return invalid();
  return r;
}
function text(v: unknown, max: number): string {
  if (typeof v !== "string" || !v.trim() || v.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(v)) return invalid();
  return v;
}
function list(v: unknown, min: number, max: number): unknown[] {
  if (!Array.isArray(v) || v.length < min || v.length > max) return invalid();
  return v;
}
function key(v: unknown): string {
  const s = text(v, 40);
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(s)) return invalid();
  return s;
}
export function validateComparison(value: unknown, sourceKeys: readonly string[]): ComparisonDocument {
  if (JSON.stringify(value)?.length > MAX_COMPARISON_CHARS) return invalid();
  const r = record(value, ["kind", "title", "concepts", "rows"]);
  if (r.kind !== "comparison") return invalid();
  const concepts = list(r.concepts, 2, 3).map(v => { const c = record(v, ["key", "label"]); return { key: key(c.key), label: text(c.label, 80) }; });
  if (new Set(concepts.map(c => c.key)).size !== concepts.length) return invalid();
  const rows = list(r.rows, 1, 6).map(v => {
    const row = record(v, ["key", "dimension", "cells", "takeaway", "basis"]);
    if (row.basis !== "source-based" && row.basis !== "model-inference") return invalid();
    const cells = list(row.cells, concepts.length, concepts.length).map(v => {
      const cell = record(v, ["conceptKey", "text", "sourceKeys"]);
      const refs = list(cell.sourceKeys, 0, 4).map(v => key(v));
      if (refs.some(k => !sourceKeys.includes(k)) || new Set(refs).size !== refs.length || (row.basis === "source-based" && refs.length === 0)) return invalid();
      return { conceptKey: key(cell.conceptKey), text: text(cell.text, 800), sourceKeys: refs };
    });
    if (new Set(cells.map(c => c.conceptKey)).size !== concepts.length || cells.some(c => !concepts.some(x => x.key === c.conceptKey))) return invalid();
    return { key: key(row.key), dimension: text(row.dimension, 80), cells, takeaway: text(row.takeaway, 800), basis: row.basis as "source-based" | "model-inference" };
  });
  if (new Set(rows.map(r => r.key)).size !== rows.length) return invalid();
  return { kind: "comparison", title: text(r.title, 120), concepts, rows };
}
export function comparisonFallback(doc: ComparisonDocument): string {
  return [doc.title, ...doc.rows.map(row => [row.dimension + (row.basis === "model-inference" ? "（模型推断）" : "（附来源）"),
    ...doc.concepts.map(c => `${c.label}：${row.cells.find(cell => cell.conceptKey === c.key)!.text}`),
    `收获：${row.takeaway}`].join("\n"))].join("\n\n");
}
export function validateUiContext(value: unknown): UiGenerationContext {
  const c = record(value, ["instruction", "sources"]);
  if (typeof c.instruction !== "string" || c.instruction.length > 400) return invalid();
  const sources = list(c.sources, 1, 4).map(v => {
    if (!v || typeof v !== "object") return invalid();
    const kind = (v as Record<string, unknown>).kind;
    const s = record(v, kind === "turn" ? ["key", "title", "kind", "branchId", "turnId", "start", "end", "text", "sourceHash"] : ["key", "title", "kind", "selection"]);
    key(s.key); text(s.title, 300);
    let start: unknown, end: unknown, excerpt: unknown, hash: unknown;
    if (kind === "turn") {
      text(s.branchId, 200); text(s.turnId, 200);
      start = s.start; end = s.end; excerpt = s.text; hash = s.sourceHash;
    } else if (kind === "material") {
      const m = record(s.selection, ["materialId", "versionId", "blockId", "start", "end", "excerpt", "sourceHash"]);
      text(m.materialId, 200); text(m.versionId, 200); text(m.blockId, 200);
      start = m.start; end = m.end; excerpt = m.excerpt; hash = m.sourceHash;
    } else return invalid();
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || Number(start) < 0 || Number(end) <= Number(start)) return invalid();
    if (text(excerpt, 12_000).length !== Number(end) - Number(start) || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) return invalid();
    return s;
  });
  if (new Set(sources.map(s => s.key)).size !== sources.length || JSON.stringify(c).length > 28_000) return invalid();
  return value as UiGenerationContext;
}
export function validateComparisonArtifact(value: unknown, context: UiGenerationContext): ComparisonArtifact {
  const r = record(value, ["schemaVersion", "catalogVersion", "document", "fallbackText"]);
  if (r.schemaVersion !== 1 || r.catalogVersion !== "comparison-v1") return invalid();
  const doc = validateComparison(r.document, context.sources.map(s => s.key));
  if (r.fallbackText !== comparisonFallback(doc)) return invalid();
  return { schemaVersion: 1, catalogVersion: "comparison-v1", document: doc, fallbackText: r.fallbackText as string };
}
