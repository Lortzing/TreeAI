/**
 * Migration 0006：Return 采用尝试关联（已签署 W1 v3.0 §3.2）。
 *
 * 设计要点：
 * - 「已保存」与「成功采用」是两个独立事实：Return 落库即保存；每次组装
 *   （compose）该 Return 的主干 Run 都构成一次采用尝试——无论该 Run 最终
 *   succeeded / failed / aborted；
 * - return_adoption_attempts 以 (return_turn_id, run_id) 复合主键记录
 *   Return→Run 关联与尝试时刻。Run 结果不冗余存储：runs 行自身是事实源，
 *   读取面以「关联 + run 状态」联合投影（失败/中止后的下一次主干讨论会
 *   再次组装同一 Return → 新增一条关联，pending 重注入语义不变）；
 * - turns.delivered_run_id（0002 列定义不变）语义收窄为「首次成功采用」
 *   的 Run：只在成功收敛事务里写入、至多一次（markReturnDelivered 的
 *   条件 UPDATE 语义不变）；成功之后的 Run 不再重复注入该 Return；
 * - 无历史回填：表为空创建，尝试关联只由服务层在组装时刻写入。
 */
import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./index.ts";

export const RETURN_ADOPTION_ATTEMPTS_SCHEMA_VERSION = 6;

const DDL = `
CREATE TABLE return_adoption_attempts (
  return_turn_id TEXT NOT NULL REFERENCES turns(id),
  run_id         TEXT NOT NULL REFERENCES runs(id),
  attempted_at   TEXT NOT NULL,
  PRIMARY KEY (return_turn_id, run_id)
);
CREATE INDEX idx_return_adoption_attempts_run ON return_adoption_attempts(run_id);
`;

export const returnAdoptionAttemptsMigration: Migration = {
  version: RETURN_ADOPTION_ATTEMPTS_SCHEMA_VERSION,
  name: "return-adoption-attempts",
  up: (db: DatabaseSync): void => {
    db.exec(DDL);
  },
};
