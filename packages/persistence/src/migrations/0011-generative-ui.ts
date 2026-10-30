import type { Migration } from "./index.ts";

export const generativeUiMigration: Migration = {
  version: 11,
  name: "generative-ui",
  up(db) {
    db.exec(`CREATE TABLE generative_ui_tasks (
      id TEXT PRIMARY KEY NOT NULL,
      tree_id TEXT NOT NULL REFERENCES trees(id),
      branch_id TEXT NOT NULL REFERENCES branches(id),
      anchor_turn_id TEXT NOT NULL REFERENCES turns(id),
      intent_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision > 0),
      context_hash TEXT NOT NULL,
      context_json TEXT NOT NULL,
      model TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','failed','cancelled','interrupted')),
      artifact_json TEXT,
      error TEXT,
      reserved_chars INTEGER NOT NULL CHECK(reserved_chars >= 0),
      charged_chars INTEGER NOT NULL CHECK(charged_chars >= 0),
      cost_unknown INTEGER NOT NULL CHECK(cost_unknown IN (0,1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(tree_id, intent_id),
      UNIQUE(anchor_turn_id, revision),
      CHECK((state = 'succeeded') = (artifact_json IS NOT NULL))
    );
    CREATE INDEX generative_ui_anchor ON generative_ui_tasks(tree_id, anchor_turn_id, revision);
    CREATE INDEX generative_ui_budget ON generative_ui_tasks(created_at);`);
  },
};
