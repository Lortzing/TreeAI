/**
 * Migration 0004：Return 幂等键与目标锚点（issue #2 P0）。
 *
 * 设计要点：
 * - turns.idempotency_key：return turn 的提交幂等键（客户端生成、跨失败
 *   重试稳定）。部分唯一索引（WHERE idempotency_key IS NOT NULL）在同键
 *   重复插入时直接判负——响应丢失后的重试、双击与并发同键由数据库层
 *   裁决为"至多一条"；无键的历史 Return 不受约束（多行 NULL 允许）；
 * - turns.target_anchor：提交时出处分支 origin 的快照（JSON 序列化的
 *   ReturnTargetAnchor），标识 Return 的原分叉点，前端据此在锚点答案
 *   附近呈现；只作展示定位，不参与 Pi 导航；
 * - 前向增量：既有行两列保持 NULL（历史 Return 豁免幂等与锚点语义），
 *   不回填、不改写既有列。
 */
import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./index.ts";

export const RETURN_IDEMPOTENCY_SCHEMA_VERSION = 4;

const DDL = `
ALTER TABLE turns ADD COLUMN idempotency_key TEXT;
ALTER TABLE turns ADD COLUMN target_anchor TEXT;
CREATE UNIQUE INDEX idx_turns_idempotency_key ON turns(idempotency_key) WHERE idempotency_key IS NOT NULL;
`;

export const returnIdempotencyMigration: Migration = {
  version: RETURN_IDEMPOTENCY_SCHEMA_VERSION,
  name: "return-idempotency",
  up: (db: DatabaseSync): void => {
    db.exec(DDL);
  },
};
