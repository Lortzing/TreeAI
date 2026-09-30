/**
 * Migration 0008：D4 材料核心——材料、内容寻址原件、不可变版本、
 * 材料来源、阅读状态与首问幂等（issue #8 D4-1；ADR-003 §2/§3/§4）。
 *
 * 设计要点：
 * - material_blobs 内容寻址原件存储：content_hash = 原件字节 SHA-256，
 *   同字节全局一份；不同内容同名文件 hash 不同 ⇒ 不会错误去重
 *   （ADR-003 §3 决策二）；
 * - material_versions 不可变版本链：UNIQUE(material_id, content_hash)
 *   ——同材料重复导入相同字节复用版本；内容变化产生新版本，**不覆盖**
 *   旧摘录、批注与 Branch 来源锚点（charter §3.1）。canonicalText 与
 *   block map（MaterialBlock[] 的 JSON，对 canonicalText 的有序连续
 *   覆盖）随版本固化；
 * - material_branch_origins 与 branch_origins（Turn 来源）平行，各自以
 *   branch_id 为主键——结构性保证每枝至多一条来源（ADR-003 §2 决策二：
 *   已交付表不可加宽，SQLite ALTER 不能加表级 CHECK，故平行新表）；
 *   材料来源永不携带 anchorTurnId/piEntryId（charter §3.2）；
 * - material_first_questions 首问幂等：PRIMARY KEY(tree_id, intent_key)
 *   ——双击、响应丢失重试、进程重启重放同一键返回同一 Branch，至多
 *   派发一次首问（ADR-003 §4，与 return idempotencyKey / 术语
 *   promotionKey 同一树内唯一模式）；
 * - branches.origin_kind 判别列（'none'|'turn'|'material'；trunk='none'）：
 *   迁移对既有带 branch_origins 行的分支回填 'turn'，其余分支保持
 *   DEFAULT 'none'——读模型与 B4 搜索一次判别来源类型（ADR-003 §2）。
 *
 * 与 docs/d4/D4-contracts.md §2 的差异（不静默偏离，随 D4-1 报告回写）：
 * 契约 DDL 的外键目标列写作 trees(tree_id)/branches(branch_id)，与
 * 0001 冻结表的实际主键列名（trees.id / branches.id）不符——照抄会在
 * 建表时即失败（unknown column）。本迁移按实际主键列名落地为
 * REFERENCES trees(id)/branches(id)，语义即契约意图（引用主键）。
 * 其余 DDL 与契约逐字一致。
 */
import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./index.ts";

export const MATERIAL_CORE_SCHEMA_VERSION = 8;

const DDL = `
CREATE TABLE materials (
  material_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE material_blobs (
  content_hash TEXT PRIMARY KEY,        -- 原件字节 SHA-256
  bytes BLOB NOT NULL
);
CREATE TABLE material_versions (
  version_id TEXT PRIMARY KEY,
  material_id TEXT NOT NULL REFERENCES materials(material_id),
  content_hash TEXT NOT NULL REFERENCES material_blobs(content_hash),
  parser_kind TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  parse_status TEXT NOT NULL
    CHECK (parse_status IN ('pending','parsing','ready','failed','canceled','unsupported','rejected')),
  parse_error TEXT,
  text_units INTEGER NOT NULL,
  canonical_text TEXT NOT NULL,
  block_map_json TEXT NOT NULL,          -- MaterialBlock[] 的 JSON
  UNIQUE (material_id, content_hash)     -- 同材料同字节复用版本（ADR-003 §3）
);
CREATE INDEX idx_material_versions_material ON material_versions(material_id);
CREATE TABLE tree_material_links (
  tree_id TEXT NOT NULL REFERENCES trees(id),
  material_id TEXT NOT NULL REFERENCES materials(material_id),
  linked_at TEXT NOT NULL,
  PRIMARY KEY (tree_id, material_id)
);
CREATE TABLE material_branch_origins (
  branch_id TEXT PRIMARY KEY REFERENCES branches(id),
  tree_id TEXT NOT NULL REFERENCES trees(id),
  material_id TEXT NOT NULL REFERENCES materials(material_id),
  version_id TEXT NOT NULL REFERENCES material_versions(version_id),
  block_id TEXT NOT NULL,
  start INTEGER NOT NULL,
  end INTEGER NOT NULL,
  excerpt TEXT NOT NULL,
  source_hash TEXT NOT NULL,             -- 版本 canonicalText SHA-256
  created_at TEXT NOT NULL,
  CHECK (start >= 0 AND end > start)
);
CREATE TABLE tree_material_reading_state (
  tree_id TEXT NOT NULL REFERENCES trees(id),
  material_id TEXT NOT NULL REFERENCES materials(material_id),
  version_id TEXT NOT NULL,
  block_id TEXT,
  focus_start INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tree_id, material_id)
);
CREATE TABLE material_first_questions (   -- 首问幂等（ADR-003 §4）
  intent_key TEXT NOT NULL,
  tree_id TEXT NOT NULL REFERENCES trees(id),
  branch_id TEXT NOT NULL REFERENCES branches(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (tree_id, intent_key)
);
ALTER TABLE branches ADD COLUMN origin_kind TEXT NOT NULL
  DEFAULT 'none' CHECK (origin_kind IN ('none','turn','material'));
UPDATE branches SET origin_kind = 'turn'
  WHERE id IN (SELECT branch_id FROM branch_origins);
`;

export const materialCoreMigration: Migration = {
  version: MATERIAL_CORE_SCHEMA_VERSION,
  name: "material-core",
  up: (db: DatabaseSync): void => {
    db.exec(DDL);
  },
};
