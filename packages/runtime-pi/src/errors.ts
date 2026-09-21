/**
 * Pi 失败 → TreeAIError 归一化。
 *
 * 契约（packages/contracts/src/errors.ts）：
 * - 8 类封闭编码：auth / model-unavailable / user-abort / timeout /
 *   policy-denied / upstream / session-corrupt / unknown。
 * - message/details 必须已脱敏；cause 保留原始错误对象（持久化前由
 *   event-journal 再脱敏，非本包义务）。
 * - 调用方前置条件违规（编程错误）抛平台标准错误（TypeError），
 *   不走 TreeAIError——本模块只处理运行期失败。
 *
 * 分类策略：结构化信号优先（policy 标记、Pi 已知 throw 语义），
 * 其余按消息文本模式（继承 D1 pi-bridge 已验证的模式集并保守扩展）。
 * 顺序有讲究：timeout 先于 abort（超时取消也会产生 AbortError）；
 * auth 先于 upstream（401/403 优先于 5xx 语义）。
 */

import type { TreeAIError, TreeAIErrorCode } from "@treeai/contracts";
import type { JsonRecord } from "@treeai/contracts";
import { errorToMessage, redactJsonValue, redactText } from "./redact.ts";

/**
 * TreeAIError 的可抛出实现（Error 子类，结构满足契约接口）。
 * contracts 是纯类型包（无运行时代码），类在本包定义。
 */
export class TreeAIRuntimeError extends Error implements TreeAIError {
  readonly code: TreeAIErrorCode;
  readonly details: JsonRecord | undefined;

  constructor(
    code: TreeAIErrorCode,
    message: string,
    options?: { details?: JsonRecord; cause?: unknown },
  ) {
    super(redactText(message), options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "TreeAIError";
    this.code = code;
    this.details = options?.details === undefined ? undefined : redactJsonValue(options.details) as JsonRecord;
    // cause 沿用 ES2022 Error 自带字段（readonly 视图由 TreeAIError 接口约束）。
    this.cause = options?.cause;
  }
}

/* ------------------------------------------------------------------ */
/* 构造器（按编码）                                                     */
/* ------------------------------------------------------------------ */

export function authError(message: string, options?: { details?: JsonRecord; cause?: unknown }): TreeAIError {
  return new TreeAIRuntimeError("auth", message, options);
}

export function modelUnavailableError(message: string, options?: { details?: JsonRecord; cause?: unknown }): TreeAIError {
  return new TreeAIRuntimeError("model-unavailable", message, options);
}

export function userAbortError(message: string, options?: { details?: JsonRecord; cause?: unknown }): TreeAIError {
  return new TreeAIRuntimeError("user-abort", message, options);
}

export function timeoutError(message: string, options?: { details?: JsonRecord; cause?: unknown }): TreeAIError {
  return new TreeAIRuntimeError("timeout", message, options);
}

export function policyDeniedError(message: string, options?: { details?: JsonRecord; cause?: unknown }): TreeAIError {
  return new TreeAIRuntimeError("policy-denied", message, options);
}

export function upstreamError(message: string, options?: { details?: JsonRecord; cause?: unknown }): TreeAIError {
  return new TreeAIRuntimeError("upstream", message, options);
}

export function sessionCorruptError(message: string, options?: { details?: JsonRecord; cause?: unknown }): TreeAIError {
  return new TreeAIRuntimeError("session-corrupt", message, options);
}

export function unknownError(message: string, options?: { details?: JsonRecord; cause?: unknown }): TreeAIError {
  return new TreeAIRuntimeError("unknown", message, options);
}

/* ------------------------------------------------------------------ */
/* 策略拒绝标记（ToolPolicy 集成挂钩）                                  */
/* ------------------------------------------------------------------ */

/**
 * 策略拒绝标记。ToolPolicy（Agent D）/宿主在阻止工具执行时
 * 给错误对象挂上该符号属性，本模块据此映射为 "policy-denied"，
 * 避免对策略文本做脆弱的消息匹配。
 */
export const POLICY_DENIED_MARKER = Symbol.for("treeai.policyDenied");

export function markAsPolicyDenied(err: unknown): void {
  if (err !== null && typeof err === "object") {
    (err as Record<symbol, unknown>)[POLICY_DENIED_MARKER] = true;
  }
}

export function isPolicyDenied(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === "object" &&
    (err as Record<symbol, unknown>)[POLICY_DENIED_MARKER] === true
  );
}

/* ------------------------------------------------------------------ */
/* 模式匹配分类                                                         */
/* ------------------------------------------------------------------ */

const TIMEOUT_PATTERN = /\btimeout\b|\btimed?\s*out\b|ETIMEDOUT|ESOCKETTIMEDOUT/i;
const AUTH_PATTERN =
  /\bapi\s*key\b|\bapikey\b|unauthorized|\b401\b|\b403\b|authentication|invalid\s+credentials|permission\s+denied.*(auth|credential|token)/i;
const MODEL_UNAVAILABLE_PATTERN =
  /no\s+models?\s+available|could\s+not\s+be\s+resolved|no\s+model\s+selected|model\s+not\s+found|unknown\s+model/i;
const ABORT_PATTERN = /\baborted?\b|operation\s+was\s+aborted/i;
const UPSTREAM_PATTERN =
  /\b5\d\d\b|overloaded|rate\s*limit|server\s+error|service\s+unavailable|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|EPIPE|network|fetch\s+failed|socket\s+hang\s+up|bad\s+gateway/i;
const SESSION_CORRUPT_PATTERN =
  /session\s+file|not\s+a\s+valid\s+pi\s+session|failed\s+to\s+parse|entry\s+.*\s+not\s+found|ENOENT/i;

/**
 * 把任意 Pi/宿主失败归类为 TreeAIError。
 *
 * 已是 TreeAIError（含本类）则原样返回（幂等）。
 * 结构化信号优先：policy 标记 > TreeAIError 透传；
 * 文本模式按 timeout > auth > model-unavailable > abort > upstream >
 * session-corrupt > unknown 的顺序判定。
 */
/** 8 类封闭编码的运行时值集合（contracts 为纯类型包，集合在本包定义）。 */
const TREEAI_ERROR_CODES: ReadonlySet<string> = new Set([
  "auth",
  "model-unavailable",
  "user-abort",
  "timeout",
  "policy-denied",
  "upstream",
  "session-corrupt",
  "unknown",
]);

/**
 * 取用于分类的错误文本。无正文的错误（空 message）视为无消息，
 * 让 fallbackMessage 生效——errorToMessage 的 "Error: " 形态是 truthy，
 * 直接用会吞掉 fallback。
 */
function classificationText(err: unknown): string {
  if (err instanceof Error && err.message.trim().length === 0) {
    return "";
  }
  const rendered = errorToMessage(err);
  return rendered.trim().length === 0 ? "" : rendered;
}

export function classifyPiFailure(err: unknown, fallbackMessage?: string): TreeAIError {
  if (err instanceof TreeAIRuntimeError) {
    return err;
  }
  // 结构上满足 TreeAIError 的普通对象（如其他副本的同类错误）也透传。
  // code 必须是 8 类封闭编码之一：Node 系统错误也带字符串 code
  // （ENOENT/ETIMEDOUT/...），不能被误当作 TreeAIError 放行。
  if (
    err !== null &&
    typeof err === "object" &&
    "code" in err &&
    "message" in err &&
    typeof (err as TreeAIError).code === "string" &&
    TREEAI_ERROR_CODES.has((err as TreeAIError).code)
  ) {
    return err as TreeAIError;
  }
  if (isPolicyDenied(err)) {
    return policyDeniedError("blocked by tool policy", { cause: err });
  }
  const message = classificationText(err) || fallbackMessage || "Pi SDK operation failed";
  const make = (code: TreeAIErrorCode, extra?: JsonRecord): TreeAIError =>
    new TreeAIRuntimeError(code, message, { cause: err, details: extra });

  if (TIMEOUT_PATTERN.test(message)) return make("timeout");
  if (AUTH_PATTERN.test(message)) return make("auth");
  if (MODEL_UNAVAILABLE_PATTERN.test(message)) return make("model-unavailable");
  if (err instanceof Error && err.name === "AbortError") return make("user-abort");
  if (ABORT_PATTERN.test(message)) return make("user-abort");
  if (UPSTREAM_PATTERN.test(message)) return make("upstream");
  if (SESSION_CORRUPT_PATTERN.test(message)) return make("session-corrupt");
  return make("unknown");
}
