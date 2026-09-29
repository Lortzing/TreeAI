/**
 * Migration 0002：D3 产品层状态（Turn / BranchOrigin / Return）。
 *
 * 设计要点（contracts/src/product.ts 不变量的存储侧防御）：
 * - TreeAI DB 仍是产品事实源（ADR-001 §4.1）：Turn 文本是产品数据，
 *   piEntryId 只是导航锚点引用，不复制 Pi session 内容；
 * - turns.role 判别式 CHECK：user/assistant 必须挂 Run 且不得携带
 *   return 专属字段；return 不得挂 Run 且必须给出处分支；
 * - branch_origins 以 branch_id 为主键：每个分支至多一条锚点记录；
 *   选区 CHECK（0 <= start <= end）与仓储层切片一致性校验互为防御；
 * - 排序沿用 0001 的追加式纪律：created_at, rowid。
 */
import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./index.ts";

export const PRODUCT_STATE_SCHEMA_VERSION = 2;

const DDL = `
CREATE TABLE turns (
  id               TEXT PRIMARY KEY NOT NULL,
  tree_id          TEXT NOT NULL REFERENCES trees(id),
  branch_id        TEXT NOT NULL REFERENCES branches(id),
  episode_id       TEXT NOT NULL REFERENCES episodes(id),
  run_id           TEXT REFERENCES runs(id),
  role             TEXT NOT NULL CHECK (role IN ('user','assistant','return')),
  text             TEXT NOT NULL,
  pi_entry_id      TEXT,
  from_branch_id   TEXT REFERENCES branches(id),
  delivered_run_id TEXT REFERENCES runs(id),
  created_at       TEXT NOT NULL,
  CHECK (
    (role = 'return' AND run_id IS NULL AND from_branch_id IS NOT NULL)
    OR (role <> 'return' AND run_id IS NOT NULL AND from_branch_id IS NULL AND delivered_run_id IS NULL)
  )
);
CREATE INDEX idx_turns_branch ON turns(branch_id, created_at);
CREATE INDEX idx_turns_tree   ON turns(tree_id);

CREATE TABLE branch_origins (
  branch_id        TEXT PRIMARY KEY NOT NULL REFERENCES branches(id),
  source_branch_id TEXT NOT NULL REFERENCES branches(id),
  anchor_turn_id   TEXT NOT NULL REFERENCES turns(id),
  anchor_entry_id  TEXT NOT NULL,
  sel_start        INTEGER NOT NULL,
  sel_end          INTEGER NOT NULL,
  sel_text         TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  CHECK (sel_start >= 0 AND sel_end >= sel_start)
);
`;

export const productStateMigration: Migration = {
  version: PRODUCT_STATE_SCHEMA_VERSION,
  name: "product-state",
  up: (db: DatabaseSync): void => {
    db.exec(DDL);
  },
};
