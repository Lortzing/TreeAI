/**
 * ToolPolicyEngine：默认拒绝的策略评估核心。
 *
 * 评估矩阵（类别 → 行为）：
 * - read：targetPath 缺失/不可规范化 → deny；规范化后位于某个
 *   readRoot → allow（显式规则 allow-read-configured-roots）；
 *   否则 deny（ruleId null，默认拒绝）。
 * - write：targetPath 缺失/不可规范化 → deny；位于某个 workspaceRoot
 *   之外 → deny；之内且无匹配授权 → require-approval；有匹配授权
 *   （类别 + canonical 路径严格相等 + 未过期 + 未消费）→ allow。
 * - shell / network：默认 deny；仅当调用方显式配置 allowShell /
 *   allowNetwork（负责人级显式规则）才 allow（risk=high）。
 * - other-high-risk：无 targetPath → deny（无法限定范围）；有路径时
 *   同 write（workspace + 授权）。
 *
 * 失败语义：
 * - 请求是来自工具层的不可信输入：语义性缺失（无路径）与不可解析
 *   一律产出 deny 决定（fail closed），不抛异常。
 * - 结构性垃圾（非对象、类别不在封闭枚举内、字段类型错误）无法构造
 *   合法 ToolDecision，属宿主映射层的编程错误 → 抛 TypeError
 *   （contracts errors.ts 的分类边界）。
 *
 * 安全表述：ToolPolicy 是应用层策略，**不是 OS 沙箱，不构成安全边界**。
 * 评估与实际执行之间存在竞态窗口；硬链接、挂载点、同进程直接调用
 * fs 等手段不受本策略约束——见 README「不能防御的风险」。
 */
import type { ToolActionCategory, ToolDecision } from "@treeai/contracts";
import { AuthorizationStore } from "./authorization.js";
import { safeActionLabel, ToolPolicyAuditLog } from "./audit.js";
import { resolveToolPolicyConfig, type ResolvedToolPolicyConfig, type ToolPolicyConfig } from "./config.js";
import {
  isToolActionCategory,
  makeDecision,
  REASONS,
  RULE_IDS,
} from "./decisions.js";
import { canonicalizePath, isPathWithin } from "./paths.js";

/** 一次策略评估请求（由宿主从工具调用映射而来）。 */
export interface ToolPolicyRequest {
  readonly category: ToolActionCategory;
  /**
   * read/write/other-high-risk 的目标路径。相对路径按引擎 cwd 解析；
   * `..`、符号链接、大小写与不存在目标均由规范化处理。
   */
  readonly targetPath?: string;
  /** shell 命令（仅用于审计存在性标志；策略不检查内容）。 */
  readonly command?: string;
  /** 网络主机（仅用于审计存在性标志；策略不检查内容）。 */
  readonly host?: string;
  /** other-high-risk 的动作标签（审计中按安全模式净化后记录）。 */
  readonly action?: string;
}

/** 引擎选项。 */
export interface ToolPolicyEngineOptions {
  /** 时钟注入（测试用）；默认 Date.now。 */
  readonly now?: () => number;
  /** 审计记录容量上限（默认 10000；到达后丢弃最旧并计数）。 */
  readonly maxAuditRecords?: number;
}

/** 单次评估的内部结果：决定 + 结构化上下文（进审计记录）。 */
interface EvaluationResult {
  readonly decision: ToolDecision;
  readonly canonicalTarget: string | null;
  readonly grantId: string | null;
  readonly consumedGrant: boolean;
}

export class ToolPolicyEngine {
  readonly #config: ResolvedToolPolicyConfig;
  readonly #now: () => number;
  readonly #auditLog: ToolPolicyAuditLog;
  readonly #authorizations: AuthorizationStore;

  constructor(config: ToolPolicyConfig = {}, options: ToolPolicyEngineOptions = {}) {
    this.#config = resolveToolPolicyConfig(config);
    this.#now = options.now ?? Date.now;
    this.#auditLog = new ToolPolicyAuditLog({ maxRecords: options.maxAuditRecords, now: this.#now });
    this.#authorizations = new AuthorizationStore({
      workspaceRoots: this.#config.workspaceRoots,
      cwd: this.#config.cwd,
      now: this.#now,
      audit: this.#auditLog,
    });
  }

  /** 构造期解析后的配置（roots 已规范化；诊断用只读快照）。 */
  get resolvedConfig(): ResolvedToolPolicyConfig {
    return this.#config;
  }

  /** 授权接口（宿主侧；不实现 UI）。 */
  get authorizations(): AuthorizationStore {
    return this.#authorizations;
  }

  /** 追加式脱敏审计日志。 */
  get audit(): ToolPolicyAuditLog {
    return this.#auditLog;
  }

  /** 评估一次工具操作请求。永不因请求语义内容抛异常（fail closed）。 */
  evaluate(request: ToolPolicyRequest): ToolDecision {
    // 结构性校验：无法构造合法决定的输入属宿主编程错误。
    if (request === null || typeof request !== "object") {
      throw new TypeError("ToolPolicyRequest must be an object");
    }
    if (!isToolActionCategory(request.category)) {
      throw new TypeError(
        `ToolPolicyRequest.category must be one of read/write/shell/network/other-high-risk (got ${String(request.category)})`,
      );
    }
    if (request.targetPath !== undefined && typeof request.targetPath !== "string") {
      throw new TypeError("ToolPolicyRequest.targetPath must be a string when provided");
    }

    const hasTarget = typeof request.targetPath === "string" && request.targetPath.trim().length > 0;
    const hasCommand = typeof request.command === "string" && request.command.length > 0;
    const hasHost = typeof request.host === "string" && request.host.length > 0;
    const actionLabel = safeActionLabel(request.action);

    const result = this.#evaluateCategory(request.category, hasTarget ? (request.targetPath as string) : undefined);

    // 审计先于授权消费记录：决定本身先落账，随后记录其消费的授权。
    this.#auditLog.append({
      kind: "decision",
      category: result.decision.category,
      outcome: result.decision.outcome,
      risk: result.decision.risk,
      ruleId: result.decision.ruleId,
      reason: result.decision.reason,
      scopeRoots: result.decision.scope.roots,
      targetPath: result.canonicalTarget,
      grantId: result.grantId,
      hasCommand,
      hasHost,
      actionLabel,
    });
    if (result.consumedGrant && result.grantId !== null) {
      this.#authorizations.consume(result.grantId);
    }
    return result.decision;
  }

  #evaluateCategory(category: ToolActionCategory, targetPath: string | undefined): EvaluationResult {
    switch (category) {
      case "read":
        return this.#evaluateRead(targetPath);
      case "write":
        return this.#evaluateWriteLike("write", targetPath);
      case "shell":
        return this.#evaluateShell();
      case "network":
        return this.#evaluateNetwork();
      case "other-high-risk":
        return this.#evaluateWriteLike("other-high-risk", targetPath);
    }
  }

  #evaluateRead(targetPath: string | undefined): EvaluationResult {
    if (targetPath === undefined) {
      return this.#plainDeny("read", REASONS.readMissingPath);
    }
    const canonical = canonicalizePath(targetPath, this.#config.cwd);
    if (canonical === null) {
      return this.#plainDeny("read", REASONS.readUnresolvable);
    }
    const matchedRoot = this.#config.readRoots.find((root) => isPathWithin(canonical, root));
    if (matchedRoot === undefined) {
      return this.#plainDeny("read", REASONS.readOutsideRoots, canonical);
    }
    return {
      decision: makeDecision({
        outcome: "allow",
        category: "read",
        reason: REASONS.readAllowed,
        ruleId: RULE_IDS.allowReadRoots,
        roots: [matchedRoot],
      }),
      canonicalTarget: canonical,
      grantId: null,
      consumedGrant: false,
    };
  }

  #evaluateWriteLike(
    category: "write" | "other-high-risk",
    targetPath: string | undefined,
  ): EvaluationResult {
    const reasons =
      category === "write"
        ? {
            missing: REASONS.writeMissingPath,
            unresolvable: REASONS.writeUnresolvable,
            outside: REASONS.writeOutsideWorkspace,
            needsApproval: REASONS.writeNeedsApproval,
            allowed: REASONS.writeAllowedByGrant,
          }
        : {
            missing: REASONS.highRiskMissingPath,
            unresolvable: REASONS.highRiskUnresolvable,
            outside: REASONS.highRiskOutsideWorkspace,
            needsApproval: REASONS.highRiskNeedsApproval,
            allowed: REASONS.highRiskAllowedByGrant,
          };
    if (targetPath === undefined) {
      return this.#plainDeny(category, reasons.missing);
    }
    const canonical = canonicalizePath(targetPath, this.#config.cwd);
    if (canonical === null) {
      return this.#plainDeny(category, reasons.unresolvable);
    }
    const matchedRoot = this.#config.workspaceRoots.find((root) => isPathWithin(canonical, root));
    if (matchedRoot === undefined) {
      return this.#plainDeny(category, reasons.outside, canonical);
    }
    const grant = this.#authorizations.findMatchingGrant(category, canonical);
    if (grant === null) {
      return {
        decision: makeDecision({
          outcome: "require-approval",
          category,
          reason: reasons.needsApproval,
          ruleId: category === "write" ? RULE_IDS.writeNeedsApproval : RULE_IDS.highRiskNeedsApproval,
          roots: [matchedRoot],
        }),
        canonicalTarget: canonical,
        grantId: null,
        consumedGrant: false,
      };
    }
    return {
      decision: makeDecision({
        outcome: "allow",
        category,
        reason: reasons.allowed,
        ruleId: `${RULE_IDS.authorizationGrantPrefix}${grant.grantId}`,
        roots: [matchedRoot],
      }),
      canonicalTarget: canonical,
      grantId: grant.grantId,
      consumedGrant: grant.singleUse,
    };
  }

  #evaluateShell(): EvaluationResult {
    if (this.#config.allowShell) {
      return {
        decision: makeDecision({
          outcome: "allow",
          category: "shell",
          reason: REASONS.shellAllowed,
          ruleId: RULE_IDS.explicitAllowShell,
          roots: [],
        }),
        canonicalTarget: null,
        grantId: null,
        consumedGrant: false,
      };
    }
    return this.#plainDeny("shell", REASONS.shellDenied);
  }

  #evaluateNetwork(): EvaluationResult {
    if (this.#config.allowNetwork) {
      return {
        decision: makeDecision({
          outcome: "allow",
          category: "network",
          reason: REASONS.networkAllowed,
          ruleId: RULE_IDS.explicitAllowNetwork,
          roots: [],
        }),
        canonicalTarget: null,
        grantId: null,
        consumedGrant: false,
      };
    }
    return this.#plainDeny("network", REASONS.networkDenied);
  }

  #plainDeny(
    category: ToolActionCategory,
    reason: string,
    canonicalTarget: string | null = null,
  ): EvaluationResult {
    return {
      decision: makeDecision({
        outcome: "deny",
        category,
        reason,
        ruleId: null,
        roots: [],
      }),
      canonicalTarget,
      grantId: null,
      consumedGrant: false,
    };
  }
}

/** 便捷工厂。 */
export function createToolPolicy(
  config?: ToolPolicyConfig,
  options?: ToolPolicyEngineOptions,
): ToolPolicyEngine {
  return new ToolPolicyEngine(config, options);
}
