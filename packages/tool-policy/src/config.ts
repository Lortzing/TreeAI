/**
 * 策略配置：目录范围（由调用方传入）与默认值。
 *
 * 边界（DECISION-005 关闭记录）：工具仅可读 fixtures 与负责人明确
 * 授权的目录；shell 与网络默认拒绝；写入和其他高风险操作逐次授权。
 * 本模块不硬编码任何目录——readRoots（含 fixtures 路径）与
 * workspaceRoots 全部由调用方（宿主）传入，默认值为空 → 拒绝一切。
 */
import { canonicalizePath } from "./paths.js";

/** 策略配置（构造时冻结解析；roots 在构造期规范化一次）。 */
export interface ToolPolicyConfig {
  /**
   * 允许读取的目录根（绝对或相对路径；相对路径按 cwd 解析）。
   * 调用方应把 fixtures 目录与负责人授权的目录传入此处。
   * 默认：空数组 → 所有读取拒绝。
   */
  readonly readRoots?: readonly string[];
  /**
   * 批准的写入 workspace 根。写入目标必须规范化后落在其中之一，
   * 且还需要逐次/限时授权才能 allow。
   * 默认：空数组 → 所有写入拒绝。
   */
  readonly workspaceRoots?: readonly string[];
  /**
   * 相对 targetPath 的解析基准。默认 process.cwd()（构造时求值一次）。
   */
  readonly cwd?: string;
  /**
   * 显式允许 shell（默认 false）。这是负责人层面的显式规则开关；
   * 开启后 shell 操作 allow（risk=high），但本模块不检查命令内容。
   */
  readonly allowShell?: boolean;
  /**
   * 显式允许 network（默认 false）。同 allowShell：不检查目标主机。
   */
  readonly allowNetwork?: boolean;
}

/** 默认策略：全部拒绝（默认 deny 的具体化）。 */
export const DEFAULT_TOOL_POLICY_CONFIG: Readonly<
  Required<Pick<ToolPolicyConfig, "readRoots" | "workspaceRoots" | "allowShell" | "allowNetwork">>
> = {
  readRoots: [],
  workspaceRoots: [],
  allowShell: false,
  allowNetwork: false,
};

/** 构造期解析后的配置（roots 已规范化；供诊断与包含性检查使用）。 */
export interface ResolvedToolPolicyConfig {
  /** 规范化后的读取根。 */
  readonly readRoots: readonly string[];
  /** 规范化后的写入 workspace 根。 */
  readonly workspaceRoots: readonly string[];
  /** 相对路径解析基准（绝对路径）。 */
  readonly cwd: string;
  readonly allowShell: boolean;
  readonly allowNetwork: boolean;
  /** 调用方原始传入的 roots（诊断用）。 */
  readonly rawReadRoots: readonly string[];
  readonly rawWorkspaceRoots: readonly string[];
}

/** 校验并解析配置。配置是宿主（受信任调用方）提供的编程输入：
 * 结构非法时抛 TypeError（平台标准错误，属编程错误，
 * 不产出 ToolDecision——见 contracts errors.ts 的分类边界说明）。 */
export function resolveToolPolicyConfig(config: ToolPolicyConfig): ResolvedToolPolicyConfig {
  if (config === null || typeof config !== "object") {
    throw new TypeError("ToolPolicyConfig must be an object");
  }
  const readRoots = validateRoots(config.readRoots, "readRoots");
  const workspaceRoots = validateRoots(config.workspaceRoots, "workspaceRoots");
  const cwd =
    typeof config.cwd === "string" && config.cwd.length > 0 ? resolveAbsolute(config.cwd) : process.cwd();
  if (typeof config.allowShell !== "boolean" && config.allowShell !== undefined) {
    throw new TypeError("ToolPolicyConfig.allowShell must be a boolean when provided");
  }
  if (typeof config.allowNetwork !== "boolean" && config.allowNetwork !== undefined) {
    throw new TypeError("ToolPolicyConfig.allowNetwork must be a boolean when provided");
  }

  return {
    readRoots: canonicalizeRoots(readRoots, cwd),
    workspaceRoots: canonicalizeRoots(workspaceRoots, cwd),
    cwd,
    allowShell: config.allowShell ?? DEFAULT_TOOL_POLICY_CONFIG.allowShell,
    allowNetwork: config.allowNetwork ?? DEFAULT_TOOL_POLICY_CONFIG.allowNetwork,
    rawReadRoots: readRoots,
    rawWorkspaceRoots: workspaceRoots,
  };
}

function validateRoots(value: readonly string[] | undefined, field: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new TypeError(`ToolPolicyConfig.${field} must be an array of directory paths`);
  }
  for (const root of value) {
    if (typeof root !== "string" || root.trim().length === 0) {
      throw new TypeError(`ToolPolicyConfig.${field} entries must be non-empty strings`);
    }
  }
  return [...value];
}

function resolveAbsolute(p: string): string {
  return canonicalizePath(p) ?? p;
}

function canonicalizeRoots(roots: readonly string[], cwd: string): readonly string[] {
  const resolved: string[] = [];
  for (const root of roots) {
    const canonical = canonicalizePath(root, cwd);
    if (canonical === null) {
      // 配置期即无法解析（如悬空符号链接）：暴露为编程错误而非静默跳过。
      throw new TypeError(
        `ToolPolicyConfig root could not be canonicalized (unresolvable path, e.g. dangling symlink); ` +
          `refusing to start with a root that cannot be verified`,
      );
    }
    resolved.push(canonical);
  }
  return resolved;
}
