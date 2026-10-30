import type { Migration } from "./index.ts";

/** A request is accepted before session alignment; binding to its Run is atomic.
 * Run terminal state remains authoritative. A pre-Run interruption is never retried implicitly. */
export const promptRequestsMigration: Migration = {
  version: 12,
  name: "prompt-requests",
  up(db) {
    db.exec(`
      CREATE TABLE prompt_requests (
        tree_id TEXT NOT NULL REFERENCES trees(id),
        request_key TEXT NOT NULL CHECK(length(request_key) BETWEEN 1 AND 200),
        branch_id TEXT NOT NULL REFERENCES branches(id),
        payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64),
        run_id TEXT UNIQUE REFERENCES runs(id),
        failure_code TEXT,
        failure_message TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY(tree_id, request_key),
        CHECK ((failure_code IS NULL) = (failure_message IS NULL)),
        CHECK (run_id IS NULL OR failure_code IS NULL)
      );
      CREATE TRIGGER prompt_requests_branch_tree BEFORE INSERT ON prompt_requests
      WHEN NOT EXISTS (SELECT 1 FROM branches WHERE id = NEW.branch_id AND tree_id = NEW.tree_id)
      BEGIN SELECT RAISE(ABORT, 'prompt request branch/tree mismatch'); END;
      CREATE TRIGGER prompt_requests_run_branch_insert BEFORE INSERT ON prompt_requests
      WHEN NEW.run_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM runs JOIN episodes ON episodes.id = runs.episode_id
        WHERE runs.id = NEW.run_id AND episodes.branch_id = NEW.branch_id
      ) BEGIN SELECT RAISE(ABORT, 'prompt request run/branch mismatch'); END;
      CREATE TRIGGER prompt_requests_run_branch BEFORE UPDATE OF run_id ON prompt_requests
      WHEN NEW.run_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM runs JOIN episodes ON episodes.id = runs.episode_id
        WHERE runs.id = NEW.run_id AND episodes.branch_id = NEW.branch_id
      ) BEGIN SELECT RAISE(ABORT, 'prompt request run/branch mismatch'); END;
    `);
  },
};
