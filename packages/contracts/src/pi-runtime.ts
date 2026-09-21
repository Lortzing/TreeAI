/**
 * PiRuntime：TreeAI 对 Pi 会话运行时的领域接口
 * （任务书 §3.3 第 1 项冻结内容）。
 *
 * 定位与红线：
 * - 这是 TreeAI 专属领域接口，**不是**通用多 Runtime 适配协议；
 *   唯一实现方是 packages/runtime-pi（Agent B，进程内嵌入
 *   Pi SDK，精确版本 0.85.1，包名见 ADR-001 与 contracts 文档）。
 * - 本接口不暴露任何 Pi SDK 类型；Pi 类型只允许出现在 runtime-pi 内部。
 * - 原始 Pi 事件经归一化为 PiRuntimeEvent（脱敏）后流出；
 *   不得把 Pi 内部结构作为领域层必填形状。
 *
 * 活跃会话模型：
 * - 一个 PiRuntime 实例同一时刻至多一个活跃会话。
 * - `createSession` / `restoreSession` 会替换活跃会话（若已有）；
 *   替换后实现必须自动重新订阅 Pi 事件，既有 listener 继续收到事件
 *   （先收到 `session.replaced`，再收到新会话事件）。
 * - `prompt` / `steer` / `abort` / `navigateTree` 作用于活跃会话。
 *
 * 并发模型：
 * - 同一时刻至多一个在途 run（isStreaming 语义）；对在途 run 再次
 *   prompt、或对非在途状态调用 steer/navigateTree 属调用方契约违规
 *   （编程错误，抛平台标准错误如 TypeError，见 errors.ts 的分类边界）。
 * - `abort` 与 `dispose` 幂等。
 *
 * 失败语义（Promise 拒绝统一使用 TreeAIError，见 errors.ts）：
 * - prompt 被中止 → code "user-abort"（run 收敛为 aborted）。
 * - 模型/凭据/上游/超时失败 → 对应 code（run 收敛为 failed）。
 * - 会话不可恢复（文件缺失、损坏、版本不兼容）→ code "session-corrupt"。
 */
import type { PiRuntimeEvent } from "./events.js";
import type {
  PiEntryId,
  PiVersion,
  SessionReference,
} from "./session-reference.js";

/** 事件监听器。 */
export type PiRuntimeEventListener = (event: PiRuntimeEvent) => void;

/** 退订函数。 */
export type PiUnsubscribe = () => void;

/** 模型选择（结构化；禁止凭据出现在任何 init 输入中）。 */
export interface PiModelSelector {
  readonly providerId: string;
  readonly modelId: string;
}

/**
 * 创建新会话的输入。
 *
 * 不变量：
 * - **不得包含任何凭据**。凭据注入是 runtime-pi 实现层职责
 *  （如 SDK 的内存凭据机制），不经契约传递、不落盘。
 * - sessionDir：受控的 session 存储目录。测试与夹具必须使用临时目录，
 *   不得读写用户真实 Pi 配置或 session 目录。
 * - cwd：工具执行工作目录；未指定时由实现定义默认值。
 */
export interface PiSessionInit {
  readonly model: PiModelSelector;
  readonly sessionDir?: string;
  readonly cwd?: string;
}

/** 创建/恢复会话成功后的快照。 */
export interface PiSessionSnapshot {
  readonly reference: SessionReference;
}

/** prompt 输入。 */
export interface PiPromptInput {
  readonly text: string;
}

/** prompt 的归一化最终结果。 */
export interface PiPromptResult {
  /** 归一化的最终助手消息文本（流式增量由事件流承载）。 */
  readonly message: string;
  /** run 完成后的会话引用（entryId 已前进），调用方据此持久化更新。 */
  readonly reference: SessionReference;
}

/** steer 输入（Pi 0.85.1 语义：同一 agent run 内追加新 turn）。 */
export interface PiSteerInput {
  readonly text: string;
}

/** navigateTree 目标：会话树内的既有条目。 */
export interface PiNavigateTreeTarget {
  readonly entryId: PiEntryId;
}

/** runtime-pi 必须提供的会话运行时领域接口。 */
export interface PiRuntime {
  /** 实际加载的 Pi 精确版本；实现必须在启动时校验其等于 PinnedPiVersion，不一致即失败。 */
  readonly piVersion: PiVersion;

  /**
   * 通过 Pi 公开 SDK 创建新会话并设为活跃会话。
   * 推送 `session.created`（若替换了已有会话，先推送 `session.replaced`）。
   */
  createSession(init: PiSessionInit): Promise<PiSessionSnapshot>;

  /**
   * 从 SessionReference 恢复会话并设为活跃会话。
   * 实现执行实时校验（文件存在、可解析、版本兼容）；
   * 失败以 TreeAIError（通常 code "session-corrupt"）拒绝。
   * 恢复不得依赖 availability 的缓存值，也不得写 Pi session 文件。
   * 推送 `session.restored`（若替换了已有会话，先推送 `session.replaced`）。
   */
  restoreSession(reference: SessionReference): Promise<PiSessionSnapshot>;

  /**
   * 在活跃会话上执行一轮 prompt（含期间 steer 派生的 turn），
   * 归一化最终结果后 resolve。流式过程经 subscribe 推送事件。
   * 被中止时以 TreeAIError（code "user-abort"）拒绝；
   * 其他失败以对应 code 拒绝。拒绝后运行时回到非 streaming 状态。
   */
  prompt(input: PiPromptInput): Promise<PiPromptResult>;

  /**
   * 在在途 run 期间追加转向输入（Pi 0.85.1：同一 agent run 新 turn，
   * 单 agent_start 语义，作为回归基线）。
   * 入队即 resolve（不等 turn 完成）；经事件流推送 `steer.enqueued`。
   * 前置条件：存在在途 run，否则为调用方契约违规。
   */
  steer(input: PiSteerInput): Promise<void>;

  /**
   * 请求中止在途 run。幂等：无在途 run 时静默 no-op。
   * abort 被接受即 resolve（不等待 prompt 收敛）；
   * 在途 prompt promise 随后以 TreeAIError（code "user-abort"）settle，
   * 运行时回到非 streaming 状态。
   */
  abort(): Promise<void>;

  /**
   * 在**同一**活跃会话内将会话树叶指针移动到目标条目
   * （Pi 原生 navigateTree 语义，D2 正式回归能力）：
   * - 不创建新 session、不更换 session 文件（区别于 fork）；
   * - 树保持追加式（不删除被放弃分支的条目）；
   * - 上下文按目标分支重建。
   * 前置条件：无在途 run（非 streaming）。返回更新后的会话引用
   * （entryId = 目标），推送 `tree.navigated`。
   */
  navigateTree(target: PiNavigateTreeTarget): Promise<SessionReference>;

  /**
   * 订阅运行时事件。可多订阅；订阅在会话替换后保持有效；
   * 新订阅者不收到历史事件（回放是 event-journal 的职责）；
   * dispose 后不再推送任何事件。
   */
  subscribe(listener: PiRuntimeEventListener): PiUnsubscribe;

  /**
   * 释放资源（幂等：重复调用安全 resolve）。调用后：
   * - 在途 prompt 以 TreeAIError（code "user-abort"）settle；
   * - 事件停止推送；
   * - 除 dispose 外的任何方法调用均为调用方契约违规。
   */
  dispose(): Promise<void>;
}
