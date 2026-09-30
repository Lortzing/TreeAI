/**
 * Migration 0007：术语三部分——批注与执行器状态（issue #7 C）。
 *
 * 设计要点：
 * - terminology_annotations 是「术语 → 解释」的**已保存产品事实**，锚定在
 *   assistant 答案选区上（与 branch_origins 同一选区纪律：绝对 UTF-16
 *   偏移 + 切片一致，由仓储层写入校验保证）；
 * - 去重：UNIQUE(tree_id, anchor_turn_id, sel_start, sel_end)——同一选区
 *   至多一条批注，重复保存返回既有行（服务层读路径对齐，不静默改写）；
 * - sourceHash：锚点答案全文的 SHA-256 指纹（漂移检测 + 执行器缓存键），
 *   与切片不变量互补（同长度改写能被切片校验拦住，指纹额外记录批注
 *   时刻的全文身份）；
 * - 幂等推广：promotion_key 按树内部分唯一（与 return 的幂等键同一纪律，
 *   UNIQUE(tree_id, promotion_key)）；promoted_branch_id 至多绑定一次
 *   （条件 UPDATE，首次成功绑定生效）——同键重放返回同一分支，不重复
 *   建枝、不重复派发首问；
 * - terminology_state 是执行器的键值状态（累计用量/预算/缓存偏好）——
 *   跨重启的用量记账事实源（值由服务层以 JSON 文本写入）。
 */
import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./index.ts";

export const TERMINOLOGY_SCHEMA_VERSION = 7;

const DDL = `
CREATE TABLE terminology_annotations (
  id                 TEXT PRIMARY KEY,
  tree_id            TEXT NOT NULL REFERENCES trees(id),
  branch_id          TEXT NOT NULL REFERENCES branches(id),
  anchor_turn_id     TEXT NOT NULL REFERENCES turns(id),
  sel_start          INTEGER NOT NULL,
  sel_end            INTEGER NOT NULL,
  sel_text           TEXT NOT NULL,
  source_hash        TEXT NOT NULL,
  term               TEXT NOT NULL,
  explanation        TEXT NOT NULL,
  mode               TEXT NOT NULL,
  promoted_branch_id TEXT REFERENCES branches(id),
  promotion_key      TEXT,
  created_at         TEXT NOT NULL
);
CREATE INDEX idx_terminology_annotations_tree ON terminology_annotations(tree_id);
CREATE UNIQUE INDEX idx_terminology_annotations_range
  ON terminology_annotations(tree_id, anchor_turn_id, sel_start, sel_end);
CREATE UNIQUE INDEX idx_terminology_annotations_promotion_key
  ON terminology_annotations(tree_id, promotion_key)
  WHERE promotion_key IS NOT NULL;
CREATE TABLE terminology_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export const terminologyMigration: Migration = {
  version: TERMINOLOGY_SCHEMA_VERSION,
  name: "terminology-annotations",
  up: (db: DatabaseSync): void => {
    db.exec(DDL);
  },
};
