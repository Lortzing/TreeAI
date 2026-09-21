/**
 * SessionReference：TreeAI 对 Pi 会话的唯一持久化引用形式。
 *
 * 上游事实（ADR-001 §4 数据边界，负责人 2026-09-20 批准）：
 * 1. Pi session JSONL 文件是 Pi 的内部持久化格式，其 schema 由 Pi 版本管理；
 *    TreeAI 不得将其 schema 当作稳定契约，也不得在 Pi session 文件中存放
 *    TreeAI 域数据（Forest/Tree/Branch/Episode/Run 等）的唯一副本。
 * 2. TreeAI 自有数据库只保存对 Pi 会话的引用三元组：
 *    sessionFile + sessionId + entryId（均为 Pi 稳定暴露的标识）。
 * 3. 对会话的写入只经 Pi 官方 API，绝不直接改写 session JSONL。
 * 4. 删除/丢失一个 Pi session 不得破坏 TreeAI 域数据完整性；
 *    允许的降级是"失去该会话的回放来源"（availability → unavailable），
 *    而不是级联删除域数据。
 * 5. 凭据归 Pi 管理，SessionReference 不携带任何凭据。
 */
import type { Brand } from "./branding.js";

/** Pi 会话标识（Pi 稳定暴露，如 `get_state`/session 元信息中的 sessionId）。 */
export type PiSessionId = Brand<string, "PiSessionId">;

/**
 * Pi session 条目标识（跨重启持久游标）。
 * 同时是 `navigateTree` 的移动目标与叶指针位置：TreeAI 以 entryId 记录
 * "某个 Branch/Episode 对应会话树中的位置"。
 */
export type PiEntryId = Brand<string, "PiEntryId">;

/** 产生/最后确认该会话的 Pi 精确版本字符串（如 "0.85.1"）。 */
export type PiVersion = Brand<string, "PiVersion">;

/**
 * D2 批准的 Pi 精确版本基线（ADR-001 / D1 DECISION-003）。
 * 以字面量类型固定：禁止 `latest`、`*`、范围版本或未记录的 Git HEAD。
 * 实现方（runtime-pi）必须在启动时校验实际版本等于该值，不一致即明确失败。
 */
export type PinnedPiVersion = "0.85.1";

/** SessionReference 不可用的原因分类。 */
export type SessionUnavailableReason =
  /** session 文件不存在（被删除/移动）。域数据必须保持完整。 */
  | "missing-file"
  /** 引用记录的 Pi 版本与当前运行时不兼容。 */
  | "version-mismatch"
  /** session 文件存在但无法解析/校验失败。 */
  | "corrupt"
  /** 其他未能归类的原因（详情见 detail，须脱敏）。 */
  | "unknown";

/**
 * 可用性是持久化层维护的**缓存评估**，不是实时探针：
 * 由 TreeRepository（Agent C）在写入/恢复/检测到丢失时更新。
 * 运行时（runtime-pi）恢复会话时执行自己的实时校验，二者互不替代。
 */
export type SessionAvailability =
  | { readonly status: "available" }
  | {
      readonly status: "unavailable";
      readonly reason: SessionUnavailableReason;
      /** 已脱敏的人类可读补充说明（不得含凭据或敏感路径正文）。 */
      readonly detail?: string;
    };

/**
 * TreeAI 持久化的 Pi 会话引用。
 *
 * 不变量：
 * - 这是 TreeAI 数据库中关于 Pi 会话的**全部**必需信息；
 *   不得依赖解析 Pi 私有 session 内容作为域数据事实源。
 * - sessionFile 为 Pi session JSONL 文件路径。规范化形式（绝对/相对、
 *  跨机器可移植性）由持久化层（Agent C）定义并保持一致。
 * - entryId 是引用生成时刻的叶指针；prompt/navigateTree 之后由调用方
 *   以返回的新引用更新，不就地修改（接口全为 readonly）。
 * - 不携带凭据、token 或任何秘密。
 */
export interface SessionReference {
  readonly sessionId: PiSessionId;
  readonly sessionFile: string;
  readonly entryId: PiEntryId;
  readonly piVersion: PiVersion;
  readonly availability: SessionAvailability;
}
