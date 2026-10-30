/** Generated presentation is a saved derivative, never a Turn or a Return. */
import type { BranchId, IsoTimestamp, TreeId } from "./identifiers.js";
import type { TurnId } from "./product.js";
import type { MaterialSelection } from "./material.js";

export interface ComparisonDocument {
  readonly kind: "comparison";
  readonly title: string;
  readonly concepts: readonly { readonly key: string; readonly label: string }[];
  readonly rows: readonly {
    readonly key: string;
    readonly dimension: string;
    readonly cells: readonly { readonly conceptKey: string; readonly text: string; readonly sourceKeys: readonly string[] }[];
    readonly takeaway: string;
    readonly basis: "source-based" | "model-inference";
  }[];
}
export type UiSourceBinding = {
  readonly key: string;
  readonly title: string;
} & ({ readonly kind: "turn"; readonly branchId: BranchId; readonly turnId: TurnId;
  readonly start: number; readonly end: number; readonly text: string; readonly sourceHash: string;
} | { readonly kind: "material"; readonly selection: MaterialSelection });

export interface UiGenerationContext {
  readonly instruction: string;
  readonly sources: readonly UiSourceBinding[];
}
export interface ComparisonArtifact {
  readonly schemaVersion: 1;
  readonly catalogVersion: "comparison-v1";
  readonly document: ComparisonDocument;
  readonly fallbackText: string;
}
export type UiGenerationState = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
export interface UiGenerationTask {
  readonly id: string;
  readonly treeId: TreeId;
  readonly branchId: BranchId;
  readonly anchorTurnId: TurnId;
  readonly intentId: string;
  readonly revision: number;
  readonly contextHash: string;
  readonly context: UiGenerationContext;
  readonly model: string;
  readonly state: UiGenerationState;
  readonly artifact: ComparisonArtifact | null;
  readonly error: string | null;
  /** Conservative character accounting; not tokens or currency. */
  readonly reservedChars: number;
  readonly chargedChars: number;
  readonly costUnknown: boolean;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}
