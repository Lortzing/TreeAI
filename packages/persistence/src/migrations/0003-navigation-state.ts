import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./index.ts";

export const NAVIGATION_STATE_SCHEMA_VERSION = 3;

const DDL = `
CREATE TABLE tree_active_navigation (
  tree_id             TEXT PRIMARY KEY NOT NULL REFERENCES trees(id),
  branch_id           TEXT NOT NULL REFERENCES branches(id),
  session_id          TEXT NOT NULL,
  session_file        TEXT NOT NULL,
  entry_id            TEXT NOT NULL,
  pi_version          TEXT NOT NULL,
  availability_status TEXT NOT NULL CHECK (availability_status IN ('available','unavailable')),
  availability_reason TEXT CHECK (availability_reason IS NULL OR availability_reason IN ('missing-file','version-mismatch','corrupt','unknown')),
  availability_detail TEXT,
  updated_at          TEXT NOT NULL,
  CHECK (
    (availability_status = 'available' AND availability_reason IS NULL)
    OR (availability_status = 'unavailable' AND availability_reason IS NOT NULL)
  )
);
CREATE INDEX idx_tree_active_navigation_branch ON tree_active_navigation(branch_id);
`;

export const navigationStateMigration: Migration = {
  version: NAVIGATION_STATE_SCHEMA_VERSION,
  name: "navigation-state",
  up: (db: DatabaseSync): void => {
    db.exec(DDL);
  },
};
