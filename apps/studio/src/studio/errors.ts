/** Studio errors ownership; public compatibility exports remain in ../service.ts. */
import type {
  RunId,
  RunState,
  TreeAIError,
  TurnId,
} from "@treeai/contracts";

/** abort 目标不是该树当前在途的 run（已终态/无在途/另有在途）→ 操作冲突（409）。 */
export class RunNotActiveError extends Error {
  constructor(runId: RunId, state: RunState) {
    super(
      `run ${runId} is not the active in-flight run (state: ${state}); only the active run of a tree can be aborted`,
    );
    this.name = "RunNotActiveError";
  }
}

/**
 * 相同 idempotencyKey 已绑定到内容不同的 Return（fromBranchId 或 text 与
 * 已落库 Return 不一致）→ 重试语义冲突（409）。既有 Return 保持不变；
 * 新的逻辑提交必须携带新键。
 */
export class ReturnConflictError extends Error {
  constructor(idempotencyKey: string, existingTurnId: TurnId, difference: string) {
    super(
      `return idempotency key '${idempotencyKey}' is already bound to return ${existingTurnId} ` +
        `with different content (${difference}); use a new idempotency key for a new submission`,
    );
    this.name = "ReturnConflictError";
  }
}

/**
 * 「以保存内容开始新的探索」与分支当前状态冲突（signed v3 §4.4 的前置
 * 条件不满足）→ 操作冲突（409）：分支尚无历史 session（普通 prompt 即会
 * 新建）、或续聊点 session 仍可用（应走普通续聊）。不产生任何写入。
 */
export class NewExplorationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NewExplorationConflictError";
  }
}

export function toTreeAIError(err: unknown): TreeAIError {
  if (err !== null && typeof err === "object" && "code" in err && "message" in err) {
    const candidate = err as { code: unknown; message: unknown };
    if (typeof candidate.code === "string" && typeof candidate.message === "string") {
      return { code: candidate.code as TreeAIError["code"], message: candidate.message };
    }
  }
  return { code: "unknown", message: err instanceof Error ? err.message : String(err) };
}
