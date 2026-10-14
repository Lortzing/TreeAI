/** errors ownership for branching.ts; compatibility entrypoint remains one level above. */

/* ------------------------------------------------------------------ */
/* 错误（HTTP 层映射见 server.ts：409）                                 */
/* ------------------------------------------------------------------ */

/**
 * 材料**建枝**意图冲突：同树同 intent_key 已绑定不同材料选区（materialId/
 * versionId/blockId/start/end 任一不同）→ 409。既有 Branch/来源/绑定不变；
 * 一次逻辑提交（同一键）不得静默换源——换选区必须换键。
 */
export class MaterialBranchConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaterialBranchConflictError";
  }
}

/**
 * 材料**首问**内容冲突：该材料分支的首问已用不同内容落库（dispatched 且
 * 送达）→ 409。首问对同一 intent 键不可变（改问是普通续聊，不是首问重试）；
 * 与术语推广的「同键异问 → 409」同一纪律（issue #7 P0 整改口径）。
 */
export class MaterialFirstQuestionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaterialFirstQuestionConflictError";
  }
}

export function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function toErrorCode(err: unknown): string {
  if (err !== null && typeof err === "object" && "code" in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "unknown";
}
