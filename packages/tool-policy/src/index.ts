/**
 * @treeai/tool-policy —— 默认拒绝的应用层工具策略。
 *
 * 安全表述（不可弱化）：本包是**应用层策略，不是 OS 沙箱，不构成
 * 安全边界**（ADR-001 批准记录：同进程风险仅在受信任本地模式下接受）。
 * 详见 README「威胁模型 / 不能防御的风险」。
 *
 * 依赖：仅 `@treeai/contracts`（纯类型，一律 `import type`）与 Node
 * 内置模块。不 import Pi。
 */
export { ToolPolicyEngine, createToolPolicy } from "./engine.ts";
export type { ToolPolicyRequest, ToolPolicyEngineOptions } from "./engine.ts";
export {
  AuthorizationStore,
  GRANTABLE_CATEGORIES,
} from "./authorization.ts";
export type { ToolAuthorizationRequest, ToolAuthorizationGrant } from "./authorization.ts";
export { ToolPolicyAuditLog, safeActionLabel } from "./audit.ts";
export type { ToolPolicyAuditRecord, ToolPolicyAuditKind } from "./audit.ts";
export { DEFAULT_TOOL_POLICY_CONFIG, resolveToolPolicyConfig } from "./config.ts";
export type { ToolPolicyConfig, ResolvedToolPolicyConfig } from "./config.ts";
export { canonicalizePath, isPathWithin } from "./paths.ts";
export {
  CATEGORY_RISK,
  isToolActionCategory,
  makeDecision,
  REASONS,
  RULE_IDS,
  TOOL_ACTION_CATEGORIES,
} from "./decisions.ts";

/* contracts 类型便捷再导出（类型层面；无运行时代码）。 */
export type {
  ToolActionCategory,
  ToolDecision,
  ToolDecisionOutcome,
  ToolDecisionScope,
  ToolRiskLevel,
} from "@treeai/contracts";
