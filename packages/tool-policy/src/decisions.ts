/**
 * 决定构造：类别-风险映射、固定 reason 模板、ToolDecision 工厂。
 *
 * 纪律（contracts tool-decision.ts 不变量）：
 * - 默认拒绝的 ruleId 为 null（无规则命中）；allow 只能来自显式规则
 *   （配置规则或授权），ruleId 非空。
 * - require-approval 不是 allow：调用方必须阻塞等待授权结果。
 * - reason 使用固定模板字符串，不拼接任何用户可控内容（路径、命令、
 *   主机名都不进 reason），结构化定位信息只进 scope.roots 与审计
 *   记录的 targetPath 字段——脱敏边界因此是单一、可审计的。
 */
import type { ToolActionCategory, ToolDecision, ToolRiskLevel } from "@treeai/contracts";

/** 全部动作类别（与 contracts 的封闭联合一致）。 */
export const TOOL_ACTION_CATEGORIES: readonly ToolActionCategory[] = [
  "read",
  "write",
  "shell",
  "network",
  "other-high-risk",
];

/** 类别 → 固定风险级别。 */
export const CATEGORY_RISK: Readonly<Record<ToolActionCategory, ToolRiskLevel>> = {
  read: "low",
  write: "high",
  shell: "high",
  network: "high",
  "other-high-risk": "high",
};

export function isToolActionCategory(value: unknown): value is ToolActionCategory {
  return typeof value === "string" && (TOOL_ACTION_CATEGORIES as readonly string[]).includes(value);
}

/**
 * 固定 reason 模板。全部为静态字符串（无动态拼接）。
 * 任何文案不得暗示本模块构成安全边界。
 */
export const REASONS = {
  /* read */
  readMissingPath: "read request has no usable target path; denied (fail closed)",
  readUnresolvable: "read target path could not be canonicalized; denied (fail closed)",
  readOutsideRoots: "read target resolves outside every configured read root; no rule allows it",
  readAllowed: "read target resolves inside a configured read root (explicit allow rule)",
  /* write */
  writeMissingPath: "write request has no usable target path; denied (fail closed)",
  writeUnresolvable: "write target path could not be canonicalized; denied (fail closed)",
  writeOutsideWorkspace: "write target resolves outside every approved workspace root; denied",
  writeNeedsApproval:
    "write target is inside an approved workspace root; per-operation or time-limited authorization is required before execution",
  writeAllowedByGrant:
    "write authorized by a matching grant for this exact action and canonical target path (application-layer policy; not a security boundary)",
  /* shell */
  shellDenied: "shell is denied by default; no explicit allow is configured",
  shellAllowed:
    "shell allowed by explicit owner-configured rule; command content is not inspected (application-layer policy; not a security boundary)",
  /* network */
  networkDenied: "network is denied by default; no explicit allow is configured",
  networkAllowed:
    "network allowed by explicit owner-configured rule; target host is not inspected (application-layer policy; not a security boundary)",
  /* other-high-risk */
  highRiskMissingPath:
    "high-risk operation has no target path, so it cannot be scoped to a workspace; denied",
  highRiskUnresolvable: "high-risk target path could not be canonicalized; denied (fail closed)",
  highRiskOutsideWorkspace: "high-risk target resolves outside every approved workspace root; denied",
  highRiskNeedsApproval:
    "high-risk target is inside an approved workspace root; per-operation or time-limited authorization is required before execution",
  highRiskAllowedByGrant:
    "high-risk operation authorized by a matching grant for this exact action and canonical target path (application-layer policy; not a security boundary)",
} as const;

/** 规则 id 常量（deny 的 ruleId 恒为 null，见文件头纪律）。 */
export const RULE_IDS = {
  allowReadRoots: "allow-read-configured-roots",
  writeNeedsApproval: "write-in-workspace-requires-approval",
  highRiskNeedsApproval: "high-risk-in-workspace-requires-approval",
  explicitAllowShell: "explicit-allow-shell",
  explicitAllowNetwork: "explicit-allow-network",
  /** 授权产生的 allow 使用 `authorization-grant:<grantId>` 形式（见 engine.ts）。 */
  authorizationGrantPrefix: "authorization-grant:",
} as const;

/** 构造一个不可变的 ToolDecision。 */
export function makeDecision(args: {
  readonly outcome: ToolDecision["outcome"];
  readonly category: ToolActionCategory;
  readonly reason: string;
  readonly ruleId: string | null;
  readonly roots: readonly string[];
}): ToolDecision {
  const decision: ToolDecision = {
    outcome: args.outcome,
    category: args.category,
    risk: CATEGORY_RISK[args.category],
    reason: args.reason,
    ruleId: args.ruleId,
    scope: { roots: [...args.roots] },
  };
  return Object.freeze(decision);
}
