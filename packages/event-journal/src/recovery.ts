/**
 * 宿主退出后的恢复语义（任务书 §5 Agent E 第 4 项；contracts run-state.ts I6）。
 *
 * 场景与收敛规则（全部使用冻结六态与 TreeAIError 8 类，不新增 domain state）：
 *
 * - **host-crash**（宿主崩溃、未执行 dispose）：journal 中仍处于非终态
 *   （queued/running/aborting）的 run，恢复时收敛为 `failed`，
 *   code = `unknown`，details 携带 `{ hostInterrupted: true }`
 *   （run-state.ts I6 第一分支）。
 * - **host-dispose**（宿主主动 dispose）：
 *   - 在途（running/aborting）的 run 按用户中止语义收敛为 `aborted`，
 *     code = `user-abort`（I6 第二分支）；
 *   - 仍为 `queued`（从未在途）的 run 收敛为 `failed`，code = `unknown`，
 *     details 携带 `{ hostInterrupted: true, neverStarted: true }`。
 *     **解释依据**：I6 的 dispose 分支限定"在途的 Run"；冻结迁移表
 *     不允许 queued→aborted（queued 仅可达 running/failed），按 I7
 *     表外迁移非法，故 queued 只能收敛为 failed。若负责人希望 queued
 *     也可收敛为 aborted，需 CONTRACT-CHANGE 修改迁移表（本解释已在
 *     README 与 handoff 记录）。
 *
 * 恢复的实现方式：对每个非终态 run **追加**一条 `runtime.recovered` 事件
 * （evidence source = `treeai-journal`），由投影器收敛状态——不改写、
 * 不删除任何既有事件（追加式审计纪律）。恢复是幂等的：已终态的 run
 * 不会被再次收敛。
 */
import type {
  EventId,
  RunId,
  RunState,
  TerminalRunState,
  TreeAIError,
} from "@treeai/contracts";

export type RecoveryCause = "host-crash" | "host-dispose";

export interface RecoveryConvergence {
  readonly resolvedTo: TerminalRunState;
  readonly error: TreeAIError;
}

/** 计算某个非终态 run 在给定恢复场景下应收敛到的终态与失败信息。 */
export function resolveRecoveryConvergence(state: RunState, cause: RecoveryCause): RecoveryConvergence {
  if (cause === "host-crash") {
    return {
      resolvedTo: "failed",
      error: {
        code: "unknown",
        message: "host process exited before run converged; converged by recovery (host-crash)",
        details: { hostInterrupted: true },
      },
    };
  }
  if (state === "running" || state === "aborting") {
    return {
      resolvedTo: "aborted",
      error: {
        code: "user-abort",
        message: "host disposed while run was in flight; converged by recovery (host-dispose)",
        details: { hostInterrupted: true },
      },
    };
  }
  return {
    resolvedTo: "failed",
    error: {
      code: "unknown",
      message: "host exited before queued run started; converged by recovery (host-dispose)",
      details: { hostInterrupted: true, neverStarted: true },
    },
  };
}

export interface RecoveredRun {
  readonly runId: RunId;
  readonly from: RunState;
  readonly resolvedTo: TerminalRunState;
  readonly error: TreeAIError;
  readonly seq: number;
  readonly eventId: EventId;
}

export interface RecoveryReport {
  readonly cause: RecoveryCause;
  /** 本次恢复实际收敛的 run（已追加 runtime.recovered 事件）。 */
  readonly recovered: readonly RecoveredRun[];
  /** 恢复时已处于终态、无需处理的 run。 */
  readonly alreadyTerminal: readonly {
    readonly runId: RunId;
    readonly state: TerminalRunState;
  }[];
  /** 调用方指定但 journal 中不存在任何事件的 run。 */
  readonly unknownRuns: readonly RunId[];
}
