/** Live parent database access and original clock/ID/transaction ownership; no cached handle or second transaction state. */

import type {
  MaterialRow,
  MaterialVersionRow,
} from "./model.ts";

import type {
  IsoTimestamp,
  MaterialSelection,
} from "@treeai/contracts";

import type {
  DatabaseSync,
} from "node:sqlite";
import type {
  MaterialRepository,
} from "./repository.ts";

export interface MaterialDomainContext {
  database(): DatabaseSync;
  assertOpen(): void;
  now(): IsoTimestamp;
  newId(prefix: string): string;
  readonly repository: MaterialRepository;
  findTreeRow(treeId: string): { id: string } | undefined;
  findMaterialRow(materialId: string): MaterialRow | undefined;
  findVersionRow(versionId: string): MaterialVersionRow | undefined;
  loadSelectionContext(selection: MaterialSelection): {
    material: MaterialRow;
    version: MaterialVersionRow;
  };
  validateSelectionDiscipline(selection: MaterialSelection, version: MaterialVersionRow): void;
}
