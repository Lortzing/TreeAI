/** cursor ownership for nav-engine.ts; compatibility entrypoint remains one level above. */
import {
  NavEngineError,
} from "./errors.ts";
import type {
  CursorPayload,
} from "./model.ts";

export function encodeCursor(version: number, offset: number): string {
  return Buffer.from(JSON.stringify({ v: version, o: offset }), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): CursorPayload {
  let parsed: CursorPayload;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as CursorPayload;
  } catch {
    throw new NavEngineError("invalid-cursor", `invalid cursor (not a navigation cursor): ${cursor.slice(0, 40)}`);
  }
  if (
    typeof parsed !== "object" || parsed === null ||
    typeof parsed.v !== "number" || !Number.isInteger(parsed.v) ||
    typeof parsed.o !== "number" || !Number.isInteger(parsed.o) || parsed.o < 0
  ) {
    throw new NavEngineError("invalid-cursor", `invalid cursor payload: ${cursor.slice(0, 40)}`);
  }
  return parsed;
}
