/**
 * Migration 0009：术语推广首问派发账本（issue #7 P0 整改，2026-09-30 验收）。
 *
 * 设计要点（coordination/d4/README.md 迁移登记表 0009 行（2026-09-30 编号更正：assertContiguous 强制下一号为 0009，search-index/export-metadata 顺移 0010/0011））：
 * - terminology_promotion_dispatches 是术语推广首问的**派发账本**：不可变
 *   payload hash + 派发状态 + Run 引用，补齐「至多一次成功首问」与
 *   「明确失败 vs 结果未知」的判定依据（此前仅以分支是否有 Turn 推断，
 *   2026-09-30 验收 P0 判不合格）；
 * - annotation_id 唯一：每条批注至多一行账本，与推广绑定同事务落库
 *   （意图登记先于任何派发——崩溃后重放以账本而非内存为准）；
 * - first_question_hash：组合上下文 + 首问全文的 SHA-256——同键异问即
 *   冲突（服务层 409），绝不静默换问；
 * - dispatch_state 状态机（CHECK 收口）：pending（从未派发）→
 *   dispatched（在途/中断——结果未知，重放须先对账）→ succeeded（run_id
 *   非空）/ failed（failure_json 非空，可重试）；
 * - attempts 只计实际发出的派发尝试（与「成功至多一次」互补：失败重试
 *   是显式允许的新尝试，不是重放）；
 * - 与 material_first_questions（migration 0008，材料首问幂等）同一纪律
 *   （树内键唯一 + 首问身份），但服务不同域：术语账本以批注为主键维度。
 */
import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./index.ts";

export const TERMINOLOGY_DISPATCH_LEDGER_SCHEMA_VERSION = 9;

const DDL = `
CREATE TABLE terminology_promotion_dispatches (
  id                  TEXT PRIMARY KEY,
  annotation_id       TEXT NOT NULL UNIQUE REFERENCES terminology_annotations(id),
  tree_id             TEXT NOT NULL REFERENCES trees(id),
  promotion_key       TEXT NOT NULL,
  branch_id           TEXT NOT NULL REFERENCES branches(id),
  first_question_hash TEXT NOT NULL,             -- 首问不可变 payload 的 SHA-256
  dispatch_state      TEXT NOT NULL
    CHECK (dispatch_state IN ('pending','dispatched','succeeded','failed')),
  attempts            INTEGER NOT NULL DEFAULT 0, -- 实际派发尝试次数（0=从未发出）
  run_id              TEXT REFERENCES runs(id),   -- 已知成功派发的 Run
  failure_json        TEXT,                       -- dispatch_state='failed' 时的脱敏失败
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX idx_terminology_dispatches_tree_key
  ON terminology_promotion_dispatches(tree_id, promotion_key);
`;

export const terminologyDispatchLedgerMigration: Migration = {
  version: TERMINOLOGY_DISPATCH_LEDGER_SCHEMA_VERSION,
  name: "terminology-dispatch-ledger",
  up: (db: DatabaseSync): void => {
    db.exec(DDL);
  },
};
