/**
 * Migration 0010：树导航展开状态（issue #8 D4-8 大规模树导航；编号登记
 * coordination/d4/README.md 迁移表 0010 行——search-index 原预留 2026-09-30
 * 弃用后按 assertContiguous 交付顺序流转给 D4-8 的展开/阅读状态持久化）。
 *
 * 设计要点：
 * - nav_tree_expand_state 是 Tree 级 UI 导航状态的持久化投影（每树至多
 *   一行，PK tree_id）：整组读写，无逐分支历史、无部分更新协议；
 * - expanded_branch_ids_json：当前展开分支 id 集合的完整 JSON 快照（数组
 *   按提交序去重；写入方为 TreeRepository.saveNavExpandState——代码层
 *   校验每个 id 存在且属于该树后才落库，列本身不设外键约束以保持
 *   「UI 投影不是产品事实」的边界：分支权威结构在 branches 表）；
 * - selected_branch_id：阅读位置语义的当前定位分支（REFERENCES
 *   branches(id)——单值引用由外键兜底；写入前同样经代码校验树归属）；
 * - 重启后展开状态与阅读位置不丢（charter §6 B9 restart-state 的离线
 *   结构性切片）；前端虚拟化/DOM 计数不在本表范围。
 */
import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./index.ts";

export const NAV_TREE_EXPAND_STATE_SCHEMA_VERSION = 10;

const DDL = `
CREATE TABLE nav_tree_expand_state (
  tree_id                TEXT PRIMARY KEY NOT NULL REFERENCES trees(id),
  expanded_branch_ids_json TEXT NOT NULL,        -- 展开分支 id 数组的 JSON 快照（写入方校验树归属）
  selected_branch_id     TEXT REFERENCES branches(id),  -- 阅读位置：当前定位分支（NULL=未选）
  updated_at             TEXT NOT NULL
);
CREATE INDEX idx_nav_tree_expand_state_selected ON nav_tree_expand_state(selected_branch_id);
`;

export const navTreeExpandStateMigration: Migration = {
  version: NAV_TREE_EXPAND_STATE_SCHEMA_VERSION,
  name: "nav-tree-expand-state",
  up: (db: DatabaseSync): void => {
    db.exec(DDL);
  },
};
