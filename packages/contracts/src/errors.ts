/**
 * TreeAIError：TreeAI 统一错误分类（任务书 §3.3 第 6 项冻结内容）。
 */
import type { JsonRecord } from "./json.js";

/** 错误分类编码（封闭联合，冻结于 CONTRACT-FREEZE-1）。 */
export type TreeAIErrorCode =
  /** 认证失败 / 凭据无效或缺失（含上游 401/403 类）。 */
  | "auth"
  /** 模型不可用 / 无法解析（如扩展注册的 provider 未加载导致模型不可见）。 */
  | "model-unavailable"
  /** 用户或宿主主动中止（abort、dispose 期间在途操作）。 */
  | "user-abort"
  /** 超时。 */
  | "timeout"
  /** 工具策略拒绝（ToolPolicy deny；被 require-approval 阻塞等待授权也归此类）。 */
  | "policy-denied"
  /** 上游错误（模型服务、Pi SDK 层面的失败）。 */
  | "upstream"
  /** 会话损坏 / 不可用（文件缺失、解析失败、版本不兼容）。 */
  | "session-corrupt"
  /** 未知错误。兜底分类，含宿主崩溃后的恢复归类（见 run-state.ts I6）。 */
  | "unknown";

/**
 * TreeAI 统一错误形状。
 *
 * 不变量：
 * - `message` 与 `details` 必须已脱敏：不得包含凭据、token、
 *   Authorization/Cookie 头、敏感路径正文或文件内容。
 * - `cause` 保留原始错误对象用于诊断与审计，但**持久化前必须脱敏**，
 *   不得原样序列化入库（event-journal 的义务）。
 * - 分类边界：TreeAIError 表达"运行期失败"。调用方违反前置条件
 *   （如对无在途 run 的会话调用 steer、dispose 后再调用 prompt）
 *   属编程错误，实现应抛出平台标准错误（如 TypeError）而非 TreeAIError。
 */
export interface TreeAIError {
  readonly code: TreeAIErrorCode;
  readonly message: string;
  /** 可选结构化上下文（已脱敏的 JSON）。 */
  readonly details?: JsonRecord;
  /** 原始错误对象；保留用于诊断，持久化前必须脱敏。 */
  readonly cause?: unknown;
}
