/**
 * ToolDecision：工具策略决定（任务书 §3.3 第 7 项冻结内容）。
 *
 * 安全表述（不可弱化）：ToolPolicy 是**应用层策略**，不是 OS 沙箱，
 * 不构成安全边界（ADR-001 批准记录：同进程风险仅在受信任本地模式下接受）。
 * 任何 README、错误消息、验收报告不得把它描述为安全边界。
 */

/** 被评估操作的动作类别。 */
export type ToolActionCategory =
  | "read"
  | "write"
  | "shell"
  | "network"
  /** 其他高风险操作（逐次授权的兜底类别）。 */
  | "other-high-risk";

/** 风险级别。 */
export type ToolRiskLevel = "low" | "medium" | "high";

/** 决定结果。 */
export type ToolDecisionOutcome = "allow" | "deny" | "require-approval";

/**
 * 决定所覆盖的目录范围。
 *
 * - roots 为**规范化绝对路径**目录根（实现必须处理 `..`、绝对路径、
 *   符号链接、大小写差异等规范化问题）。
 * - 空数组表示决定不绑定具体目录（如对 shell/network 的全局拒绝）。
 */
export interface ToolDecisionScope {
  readonly roots: readonly string[];
}

/**
 * 结构化工具策略决定。
 *
 * 不变量：
 * - 默认拒绝：未配置/未命中规则的操作必须是 `deny`
 *   （ruleId 为 null 表示无规则命中的默认拒绝）。
 * - `allow` 只能来自显式规则；shell 与 network 默认 `deny`。
 * - `require-approval` **不是** allow：调用方必须阻塞等待授权结果，
 *   不得先执行后补授权。
 * - reason 必须人类可读且已脱敏：不得包含秘密或文件正文。
 * - 决定记录（含进入 journal 的 tool.decision 事件）不得包含
 *   凭据或被访问文件的内容。
 */
export interface ToolDecision {
  readonly outcome: ToolDecisionOutcome;
  readonly category: ToolActionCategory;
  readonly risk: ToolRiskLevel;
  readonly reason: string;
  /** 产生决定的策略规则 id；null = 无规则命中的默认拒绝。 */
  readonly ruleId: string | null;
  readonly scope: ToolDecisionScope;
}
