/**
 * event-journal 的基础设施错误。
 *
 * 定位说明（相对 `@treeai/contracts` 的 `TreeAIError`）：
 * `TreeAIError` 是冻结的 8 类**运行期失败**分类（auth/model-unavailable/...），
 * 表达"一次 Run 失败了"。而 journal 自身的存储/完整性问题（文件损坏、I/O
 * 失败、对已关闭 journal 的使用）不是 Run 的运行期失败，把它们塞进
 * `TreeAIError` 会与状态投影语义混淆（一次 journal 读失败不应被误读为
 * Run 失败）。因此本模块对基础设施错误使用本类；Run 级别的失败只以
 * `TreeAIError` 形态出现在事件 payload（`runtime.error` / `runtime.recovered`）
 * 与投影结果（`RunProjection.failure`）中。
 *
 * 该错误不属于领域契约的新增内容，不触发 CONTRACT-CHANGE。
 */
export type EventJournalErrorReason =
  /** journal 文件中存在无法解析或校验失败的行（明确报错，不静默跳过）。 */
  | "corrupt"
  /** 文件系统 I/O 失败。 */
  | "io"
  /** 对已 close 的 journal 调用写入类方法。 */
  | "closed";

export class EventJournalError extends Error {
  readonly reason: EventJournalErrorReason;

  constructor(reason: EventJournalErrorReason, message: string) {
    super(`[event-journal:${reason}] ${message}`);
    this.name = "EventJournalError";
    this.reason = reason;
  }
}
