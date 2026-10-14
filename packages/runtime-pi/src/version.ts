import type {
  PiVersion,
  PinnedPiVersion,
} from "@treeai/contracts";
export const PINNED_PI_VERSION: PinnedPiVersion = "0.85.1";

export const PINNED_PI_VERSION_BRANDED: PiVersion = PINNED_PI_VERSION as PiVersion;

export class PiVersionMismatchError extends Error {
  readonly actualVersion: string;
  readonly expectedVersion: string;

  constructor(actualVersion: string, expectedVersion: string) {
    super(
      `Pi SDK version mismatch: expected ${expectedVersion}, but loaded ${actualVersion}. ` +
        `TreeAI D2 pins @earendil-works/pi-coding-agent to exactly ${expectedVersion} ` +
        `(contracts.PinnedPiVersion); refusing to start the runtime.`,
    );
    this.name = "PiVersionMismatchError";
    this.actualVersion = actualVersion;
    this.expectedVersion = expectedVersion;
  }
}
