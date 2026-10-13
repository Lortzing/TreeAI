/** policy ownership for tree-repository.ts; compatibility entrypoint remains one level above. */
import type {
  RunState,
  RunStateTransitions,
  TurnRole,
} from "@treeai/contracts";

/**
 * 单树展开状态 id 数量的硬上限（issue #8 D4-8）：整组快照写入必须保持
 * 有界（5000 节点树全展开也在限内；超过即拒绝——有界状态，防无意识
 * 无限膨胀）。
 */
export const NAV_EXPAND_STATE_MAX_BRANCHES = 10_000;

/* ------------------------------------------------------------------ */
/* 冻结迁移表的运行时副本（编译期以 satisfies 与 contracts 对齐）        */
/* ------------------------------------------------------------------ */

export const RUN_STATE_TRANSITIONS = {
  queued: ["running", "failed"],
  running: ["aborting", "succeeded", "failed"],
  aborting: ["aborted", "failed"],
  succeeded: [],
  failed: [],
  aborted: [],
} as const satisfies RunStateTransitions;

export const TERMINAL_STATES: readonly RunState[] = ["succeeded", "failed", "aborted"];

/* --------------------- D3 产品层（turns / branch_origins） --------------------- */

export const TURN_ROLES: readonly TurnRole[] = ["user", "assistant", "return"];

export const UNAVAILABLE_REASONS: readonly string[] = ["missing-file", "version-mismatch", "corrupt", "unknown"];

/* ------------------------------------------------------------------ */
/* TreeRepository                                                       */
/* ------------------------------------------------------------------ */

export const MISSING_FILE_DETAIL = "session file not found (deleted or moved)";
