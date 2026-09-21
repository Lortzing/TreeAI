/**
 * RunState：TreeAI Run 的运行状态与状态机（任务书 §3.3 第 4 项冻结内容）。
 *
 * 状态机不变量（对 persistence / event-journal / 测试同时生效）：
 *
 * I1 初始态：每个 Run 创建时处于 `queued`。
 *
 * I2 终态吸收：`succeeded` / `failed` / `aborted` 是终态，
 *    不存在离开终态的合法迁移（见 RunStateTransitions，终态目标集为空）。
 *
 * I3 单终态：一个 Run 至多进入一个终态。持久化层必须拒绝把已终态的 Run
 *    再次写入另一终态（并发下也不得产生双终态）。
 *
 * I4 abort 收敛：`aborting` 只能从 `running` 进入；进入后必须收敛为
 *    `aborted`（中止成功）或 `failed`（中止本身出错）。
 *    永久停留在 `aborting` 是契约违规。
 *
 * I5 无回退：不允许向"更早"的状态回退（如 running → queued），
 *    也不允许跳过前置状态直达终态（如 queued → succeeded）。
 *
 * I6 重启恢复：宿主进程退出后，任何仍处于非终态（queued/running/aborting）
 *    的 Run 必须被恢复流程解决，不得遗留永久非终态：
 *    - 宿主崩溃（未执行 dispose）：恢复时置为 `failed`，
 *      TreeAIError.code = "unknown"、message 指明宿主中断、
 *      details 建议携带 `{ hostInterrupted: true }`（已脱敏）；
 *    - 宿主主动 dispose 时在途的 Run：按用户中止语义收敛为 `aborted`
 *      （TreeAIError.code = "user-abort"）。
 *
 * I7 迁移表穷尽：RunStateTransitions 之外的任何迁移都是非法的；
 *    event-journal 的投影器必须拒绝非法迁移并留下可审计记录。
 */

/** Run 的运行状态。 */
export type RunState =
  | "queued"
  | "running"
  | "aborting"
  | "succeeded"
  | "failed"
  | "aborted";

/** 终态（吸收态）。 */
export type TerminalRunState = "succeeded" | "failed" | "aborted";

/** 非终态。 */
export type NonTerminalRunState = "queued" | "running" | "aborting";

/**
 * 合法迁移表（类型的"数据"形式，供测试与投影器对照）。
 * 终态映射为空元组，编码 I2（吸收性）。
 */
export interface RunStateTransitions {
  readonly queued: readonly ["running", "failed"];
  readonly running: readonly ["aborting", "succeeded", "failed"];
  readonly aborting: readonly ["aborted", "failed"];
  readonly succeeded: readonly [];
  readonly failed: readonly [];
  readonly aborted: readonly [];
}

/**
 * 编译期迁移合法性检查：
 * `AllowedRunStateTransition<From, To>` 为 `true` 当且仅当
 * `To ∈ RunStateTransitions[From]`。
 *
 * 用法（消费方示例）：
 * ```ts
 * function transition<From extends RunState, To extends RunState>(
 *   from: From,
 *   to: To,
 * ): AllowedRunStateTransition<From, To> extends true ? To : never;
 * ```
 * 非法迁移使返回类型坍缩为 `never`，在赋值处编译失败。
 */
export type AllowedRunStateTransition<
  From extends RunState,
  To extends RunState,
> = To extends RunStateTransitions[From][number] ? true : false;
