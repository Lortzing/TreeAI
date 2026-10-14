/** Terminology suggestion-projection ownership; public compatibility exports remain in ../terminology.ts. */
import type {
  TerminologySuggestionSet,
} from "./model.ts";
import {
  hashSourceText,
} from "./prompts.ts";
import type {
  BranchId,
} from "@treeai/contracts";

/**
 * 建议集的读取投影（来源校验；服务端纯函数——readModel 与 HTTP 共用）：
 * 锚点答案缺失 / 漂移（branch 不符或全文指纹失配）→ source-invalid（建议
 * 只作快照展示，前端禁用点击解释——既有 overlay 失效快照降级同纪律）；
 * 来源完好 → 维持存储状态。
 */
export function projectSuggestionSet(
  set: TerminologySuggestionSet,
  anchorTurn: { readonly branchId: BranchId; readonly text: string } | null,
): TerminologySuggestionSet {
  if (
    anchorTurn === null ||
    anchorTurn.branchId !== set.branchId ||
    hashSourceText(anchorTurn.text) !== set.sourceHash
  ) {
    return { ...set, status: "source-invalid" };
  }
  return set;
}
