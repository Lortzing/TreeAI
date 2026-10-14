/** errors ownership for nav-engine.ts; compatibility entrypoint remains one level above. */
import type {
  NavEngineErrorCode,
} from "./model.ts";

export class NavEngineError extends Error {
  /** 稳定原因码（HTTP 接线据此映射 404/400；见 server.ts D4-8 段）。 */
  readonly code: NavEngineErrorCode;

  constructor(code: NavEngineErrorCode, message: string) {
    super(`nav-engine: ${message}`);
    this.name = "NavEngineError";
    this.code = code;
  }
}
