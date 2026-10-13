/** Terminology errors ownership; public compatibility exports remain in ../terminology.ts. */

/* ------------------------------------------------------------------ */
/* 服务：保存 / 幂等推广 / 读模型                                        */
/* ------------------------------------------------------------------ */

/** 推广与批注当前状态冲突（同批注异键 / 已推广后异键重试）→ 409。 */
export class TerminologyPromotionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminologyPromotionConflictError";
  }
}
