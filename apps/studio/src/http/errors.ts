import type { ServerResponse } from "node:http";
import { ConstraintViolationError, EntityNotFoundError, InvalidArgumentError, PersistenceError } from "@treeai/persistence";
import { RunNotActiveError, NewExplorationConflictError, ReturnConflictError } from "../service.ts";
import { TerminologyPromotionConflictError } from "../terminology.ts";
import { MaterialNotReadyError, MaterialTooLargeError, MaterialUnsupportedError, ParseTaskNotCancelableError } from "../materials/import-service.ts";
import { MaterialBranchConflictError, MaterialFirstQuestionConflictError } from "../materials/branching.ts";
import { NavEngineError } from "../nav/nav-engine.ts";
import { sendJson, type ApiErrorBody } from "./responses.ts";

export function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof EntityNotFoundError) {
    sendJson(res, 404, { error: { code: "not-found", message: err.message } } satisfies ApiErrorBody);
    return;
  }
  if (err instanceof InvalidArgumentError || err instanceof ConstraintViolationError) {
    sendJson(res, 400, { error: { code: "invalid-argument", message: err.message } } satisfies ApiErrorBody);
    return;
  }
  if (err instanceof RunNotActiveError) {
    // abort 目标不是该树当前在途 run（已终态/无在途/另有在途）——操作冲突。
    sendJson(res, 409, { error: { code: "conflict", message: err.message } } satisfies ApiErrorBody);
    return;
  }
  if (err instanceof ReturnConflictError) {
    // 同幂等键已绑定不同内容的 Return——重试语义冲突（既有 Return 不变）。
    sendJson(res, 409, { error: { code: "return-conflict", message: err.message } } satisfies ApiErrorBody);
    return;
  }
  if (err instanceof NewExplorationConflictError) {
    // 「以保存内容开始新的探索」的前置条件不满足（session 仍可用 / 无历史
    // session）——与分支当前状态冲突，零写入。
    sendJson(res, 409, { error: { code: "new-exploration-conflict", message: err.message } } satisfies ApiErrorBody);
    return;
  }
  if (err instanceof TerminologyPromotionConflictError) {
    // 术语推广冲突（同批注异键 / 并发竞争判负）——既有推广不变。
    sendJson(res, 409, { error: { code: "terminology-promotion-conflict", message: err.message } } satisfies ApiErrorBody);
    return;
  }
  if (err instanceof MaterialUnsupportedError) {
    // 不支持的材料（未知扩展名 / 解析器未装配，如 D4-1 集成前的 pdf）。
    sendJson(res, 415, { error: { code: "material-unsupported", message: err.message } } satisfies ApiErrorBody);
    return;
  }
  if (err instanceof MaterialTooLargeError) {
    // 超过单文件上限（charter §5：解析前拒绝）。
    sendJson(res, 413, { error: { code: "material-too-large", message: err.message } } satisfies ApiErrorBody);
    return;
  }
  if (err instanceof MaterialNotReadyError) {
    // 非 ready 版本的读取/建枝前置（不支持/失败/取消绝不伪装空成功文档）。
    sendJson(res, 409, { error: { code: "material-not-ready", message: err.message } } satisfies ApiErrorBody);
    return;
  }
  if (err instanceof ParseTaskNotCancelableError) {
    // 取消目标已终态（ready/failed/canceled）——操作冲突。
    sendJson(res, 409, { error: { code: "parse-task-not-cancelable", message: err.message } } satisfies ApiErrorBody);
    return;
  }
  if (err instanceof MaterialBranchConflictError) {
    // 材料建枝意图冲突（同树同 intent_key 已绑定不同选区）——既有建枝不变。
    sendJson(res, 409, { error: { code: "material-branch-conflict", message: err.message } } satisfies ApiErrorBody);
    return;
  }
  if (err instanceof MaterialFirstQuestionConflictError) {
    // 材料首问内容冲突（首问已用不同内容落库）——改问走普通续聊。
    sendJson(res, 409, { error: { code: "material-first-question-conflict", message: err.message } } satisfies ApiErrorBody);
    return;
  }
  if (err instanceof NavEngineError) {
    // 大规模树导航（issue #8 D4-8）：稳定原因码 → 状态码。必须在下方
    // TreeAIError 鸭子类型分支之前（NavEngineError 也携带字符串 code）。
    if (err.code === "unknown-tree" || err.code === "unknown-branch") {
      sendJson(res, 404, { error: { code: "not-found", message: err.message } } satisfies ApiErrorBody);
      return;
    }
    if (err.code === "stale-cursor") {
      // 索引版本已变（invalidate 后旧游标）——客户端须从首页重开分页。
      sendJson(res, 409, { error: { code: "stale-cursor", message: err.message } } satisfies ApiErrorBody);
      return;
    }
    if (err.code === "data-integrity") {
      sendJson(res, 500, { error: { code: "data-integrity", message: err.message } } satisfies ApiErrorBody);
      return;
    }
    // invalid-argument / invalid-cursor：调用方输入错误。
    sendJson(res, 400, { error: { code: err.code, message: err.message } } satisfies ApiErrorBody);
    return;
  }
  if (err instanceof TypeError) {
    // 调用方契约违规（如并发 prompt）——单用户本地工具下按操作冲突呈现。
    sendJson(res, 409, { error: { code: "conflict", message: err.message } } satisfies ApiErrorBody);
    return;
  }
  if (err !== null && typeof err === "object" && "code" in err && "message" in err) {
    const candidate = err as { code: unknown; message: unknown };
    if (typeof candidate.code === "string" && typeof candidate.message === "string") {
      if (candidate.code === "user-abort") {
        // 用户/宿主主动中止，不是上游失败：按操作冲突呈现（run 已收敛 aborted）。
        sendJson(res, 409, { error: { code: "user-abort", message: candidate.message } } satisfies ApiErrorBody);
        return;
      }
      // TreeAIError（运行期失败：auth/upstream/session-corrupt/…）
      sendJson(res, 502, { error: { code: candidate.code, message: candidate.message } } satisfies ApiErrorBody);
      return;
    }
  }
  if (err instanceof PersistenceError) {
    sendJson(res, 500, { error: { code: err.code, message: err.message } } satisfies ApiErrorBody);
    return;
  }
  const message = err instanceof Error ? err.message : "internal error";
  sendJson(res, 500, { error: { code: "internal", message } } satisfies ApiErrorBody);
}

