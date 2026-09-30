/**
 * Migration 0005：Return 幂等键作用域收窄为 Tree 内唯一（已签署 W1 v3.0 §3.4）。
 *
 * 设计要点：
 * - 0004 建立的全局唯一索引（idx_turns_idempotency_key）把幂等键当作全局
 *   资源；已签署契约改为每棵 Tree 独立命名空间——同一个逻辑提交键在
 *   不同 Tree 中各自有效（客户端仍可统一用 UUID，但跨 Tree 撞键不再
 *   判负）；Tree 内同键仍至多一条（重放/冲突语义不变）；
 * - 本 migration 撤下全局索引、建立树内唯一部分索引
 *   idx_turns_idempotency_key_tree（WHERE idempotency_key IS NOT NULL
 *   ——无键历史行豁免不变，多行 NULL 允许）；
 * - append-only 纪律：0004 保持原样交付，修正以新版本号承载；本 migration
 *   不改写任何既有行。升级时若库内存在跨 Tree 同键（0004 索引下不可能
 *   出现，防御起见仍处理），CREATE UNIQUE INDEX 判负 → 整体回滚并按
 *   migration 失败上报，绝不静默合并两个不同的逻辑提交。
 */
import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./index.ts";

export const RETURN_IDEMPOTENCY_TREE_SCOPE_SCHEMA_VERSION = 5;

const DDL = `
DROP INDEX idx_turns_idempotency_key;
CREATE UNIQUE INDEX idx_turns_idempotency_key_tree
  ON turns(tree_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
`;

export const returnIdempotencyTreeScopeMigration: Migration = {
  version: RETURN_IDEMPOTENCY_TREE_SCOPE_SCHEMA_VERSION,
  name: "return-idempotency-tree-scope",
  up: (db: DatabaseSync): void => {
    db.exec(DDL);
  },
};
