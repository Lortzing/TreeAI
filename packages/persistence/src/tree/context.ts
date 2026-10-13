/** Live parent database access and original clock/ID/transaction ownership; no cached handle or second transaction state. */

import type {
  IsoTimestamp,
} from "@treeai/contracts";


import type {
  DatabaseSync,
} from "node:sqlite";
import type {
  TreeRepository,
} from "./repository.ts";

export interface TreeDomainContext {
  database(): DatabaseSync;
  assertOpen(): void;
  now(): IsoTimestamp;
  newId(prefix: string): string;
  readonly repository: TreeRepository;
}
