/**
 * Migration 0001：初始 schema（Forest / Tree / Branch / Episode / Run / SessionReference）。
 *
 * 设计要点：
 * - TreeAI DB 是产品事实源（ADR-001 §4.1）：本 schema 不依赖、也不引用
 *   Pi session 文件的存在；SessionReference 仅保存引用三元组与版本。
 * - 单终态防御分三层（contracts run-state.ts I3）：
 *   1. 仓储层条件 UPDATE（`WHERE terminal_state IS NULL`）；
 *   2. 表级 CHECK（terminal_state 与 state 一致、failure 仅 failed）；
 *   3. 触发器 `runs_terminal_immutable`：终态行的 state/terminal_state/failure
 *      再变更时直接 ABORT（对绕过仓储层的裸 SQL 同样生效）。
 * - availability 一致性：available ⇔ reason 为空（CHECK 强制）。
 * - 外键全部显式声明；打开连接时启用 foreign_keys（见 database.ts）。
 * - 排序：runs 查询以 `created_at, rowid` 排序（rowid 单调递增，本包
 *   不删除 run，追加式纪律下可作为稳定插入序）。
 */
import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./index.ts";

export const INITIAL_SCHEMA_VERSION = 1;

const DDL = `
CREATE TABLE forests (
  id         TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE trees (
  id         TEXT PRIMARY KEY NOT NULL,
  forest_id  TEXT NOT NULL REFERENCES forests(id),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_trees_forest ON trees(forest_id);

CREATE TABLE branches (
  id               TEXT PRIMARY KEY NOT NULL,
  tree_id          TEXT NOT NULL REFERENCES trees(id),
  parent_branch_id TEXT REFERENCES branches(id),
  created_at       TEXT NOT NULL,
  CHECK (parent_branch_id IS NULL OR parent_branch_id <> id)
);
CREATE INDEX idx_branches_tree   ON branches(tree_id);
CREATE INDEX idx_branches_parent ON branches(parent_branch_id);

CREATE TABLE episodes (
  id         TEXT PRIMARY KEY NOT NULL,
  branch_id  TEXT NOT NULL REFERENCES branches(id),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_episodes_branch ON episodes(branch_id);

CREATE TABLE runs (
  id             TEXT PRIMARY KEY NOT NULL,
  episode_id     TEXT NOT NULL REFERENCES episodes(id),
  state          TEXT NOT NULL CHECK (state IN ('queued','running','aborting','succeeded','failed','aborted')),
  created_at     TEXT NOT NULL,
  terminal_at    TEXT,
  terminal_state TEXT CHECK (terminal_state IS NULL OR terminal_state IN ('succeeded','failed','aborted')),
  failure_json   TEXT,
  CHECK ((terminal_at IS NULL) = (terminal_state IS NULL)),
  CHECK (terminal_state IS NULL OR terminal_state = state),
  CHECK (failure_json IS NULL OR terminal_state = 'failed')
);
CREATE INDEX idx_runs_episode ON runs(episode_id);
CREATE INDEX idx_runs_state   ON runs(state);

CREATE TABLE session_references (
  run_id               TEXT PRIMARY KEY NOT NULL REFERENCES runs(id),
  session_id           TEXT NOT NULL,
  session_file         TEXT NOT NULL,
  entry_id             TEXT NOT NULL,
  pi_version           TEXT NOT NULL,
  availability_status  TEXT NOT NULL CHECK (availability_status IN ('available','unavailable')),
  availability_reason  TEXT CHECK (availability_reason IS NULL OR availability_reason IN ('missing-file','version-mismatch','corrupt','unknown')),
  availability_detail  TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  CHECK (
    (availability_status = 'available' AND availability_reason IS NULL)
    OR (availability_status = 'unavailable' AND availability_reason IS NOT NULL)
  )
);
CREATE INDEX idx_session_references_file ON session_references(session_file);

CREATE TRIGGER runs_terminal_immutable
BEFORE UPDATE ON runs
WHEN OLD.terminal_state IS NOT NULL
     AND (
       NEW.state <> OLD.terminal_state
       OR NEW.terminal_state <> OLD.terminal_state
       OR NEW.failure_json IS NOT OLD.failure_json
     )
BEGIN
  SELECT RAISE(ABORT, 'run is already in terminal state: ' || OLD.terminal_state);
END;
`;

export const initialSchemaMigration: Migration = {
  version: INITIAL_SCHEMA_VERSION,
  name: "initial-schema",
  up: (db: DatabaseSync): void => {
    db.exec(DDL);
  },
};
