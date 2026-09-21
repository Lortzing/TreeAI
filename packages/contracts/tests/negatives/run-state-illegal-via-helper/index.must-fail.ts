/**
 * 反例：经投影 helper 的非法迁移。
 * 期望：本文件编译失败（返回类型坍缩为 never，不能赋给 RunState）。
 */
import type { AllowedRunStateTransition, RunState } from "../../../src/index.js";

type NextRunState<From extends RunState, To extends RunState> =
  AllowedRunStateTransition<From, To> extends true
    ? To
    : readonly ["ILLEGAL_RUN_STATE_TRANSITION", From, To];

declare function transitionRunState<
  From extends RunState,
  To extends RunState,
>(current: From, next: To): NextRunState<From, To>;

// aborted 是终态：返回错误标记元组，不能赋给 RunState → 编译失败。
const after: RunState = transitionRunState("aborted", "running");
