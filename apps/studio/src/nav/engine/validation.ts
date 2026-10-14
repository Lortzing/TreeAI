/** validation ownership for nav-engine.ts; compatibility entrypoint remains one level above. */
import {
  NavEngineError,
} from "./errors.ts";
import type {
  NavSearchMode,
} from "./model.ts";

export function assertLimit(value: number | undefined, max: number, what: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new NavEngineError("invalid-argument", `${what} must be an integer between 1 and ${String(max)} (got ${String(value)})`);
  }
  return value;
}

export function assertMode(mode: NavSearchMode | undefined): NavSearchMode {
  if (mode === undefined) return "substring";
  if (mode !== "exact" && mode !== "prefix" && mode !== "substring") {
    throw new NavEngineError("invalid-argument", `search mode must be 'exact' | 'prefix' | 'substring' (got ${String(mode)})`);
  }
  return mode;
}

/** 标题匹配（大小写折算与 search-engine 同约定：toLowerCase，无归一化）。 */
export function fold(text: string): string {
  return text.toLowerCase();
}

export function matchByMode(haystackFolded: string, needleFolded: string, mode: NavSearchMode): boolean {
  if (needleFolded.length === 0) return false;
  if (mode === "exact") return haystackFolded === needleFolded;
  if (mode === "prefix") return haystackFolded.startsWith(needleFolded);
  return haystackFolded.includes(needleFolded);
}
