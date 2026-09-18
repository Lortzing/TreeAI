/**
 * TreeAI D1 spike - BlockedError: a real run could not complete for
 * environmental reasons (credentials, SDK install, model config, fixture).
 * Blocked runs are recorded as status BLOCKED, never as PASS or FAIL.
 */

import type { BlockedReason } from "./types.js";

export class BlockedError extends Error {
  readonly blockedReason: BlockedReason;
  constructor(blockedReason: BlockedReason, message: string) {
    super(message);
    this.name = "BlockedError";
    this.blockedReason = blockedReason;
  }
}

export function isBlockedError(err: unknown): err is BlockedError {
  return err instanceof BlockedError;
}
