/**
 * 请求时工具策略缝（issue #5 P0 离线段）。
 *
 * 设计边界（与 packages/tool-policy 的分工一致）：
 * - 本文件**不**依赖 `@treeai/tool-policy`（依赖图保持 runtime-pi 只依赖
 *   contracts + Pi SDK）：评估器是结构接口 `PiToolPolicyEvaluator`，
 *   `ToolPolicyEngine`（@treeai/tool-policy）结构满足它，由宿主注入。
 *   请求形状 `PiToolPolicyRequest` 是 `ToolPolicyRequest` 的结构镜像
 *   （字段逐一一致），决定形状 `ToolDecision` 直接来自 contracts。
 * - Pi 工具调用 → 策略请求的**映射**是 Pi 0.85.1 特有知识（内建工具的
 *   参数 schema），因此落在本包；目录/开关配置（readRoots 等）由宿主
 *   经注入的引擎表达（tool-policy README：本模块不硬编码任何目录）。
 *
 * 分类（fail closed 方向）：
 * - read/ls/find/grep → `read`，targetPath 取 args.path（grep/find/ls 的
 *   path 可选；缺失 → 无路径的 read → 引擎 deny，fail closed）；
 * - write/edit → `write`，targetPath 取 args.path；
 * - bash/powershell → `shell`，command 取 args.command；
 * - 其余（扩展/自定义工具）→ `other-high-risk` + action=工具名，无
 *   targetPath（宿主无法限定未知工具的作用范围）→ 引擎 deny。
 *
 * 安全表述：ToolPolicy 是应用层策略，不是 OS 沙箱，不构成安全边界；
 * 本缝只约束「经本运行时会话的实际工具执行请求先经评估」这一调用纪律。
 */

import type { ToolActionCategory, ToolDecision } from "@treeai/contracts";
import type { PiPortToolCallRequest } from "./pi-sdk-port.ts";

/**
 * 策略评估请求（@treeai/tool-policy `ToolPolicyRequest` 的结构镜像；
 * 字段名与类型逐一一致，二者可互换赋值）。
 */
export interface PiToolPolicyRequest {
  readonly category: ToolActionCategory;
  readonly targetPath?: string;
  readonly command?: string;
  readonly host?: string;
  readonly action?: string;
}

/**
 * 策略评估器缝：`evaluate()` 对请求的语义内容永不抛异常（缺失/不可解析
 * 一律产出 deny/require-approval 决定，fail closed）；只有结构性垃圾
 * （非对象、类别不在封闭枚举）抛 TypeError。@treeai/tool-policy 的
 * `ToolPolicyEngine` 结构满足本接口。
 */
export interface PiToolPolicyEvaluator {
  evaluate(request: PiToolPolicyRequest): ToolDecision;
}

/** Pi 0.85.1 内建工具名 →（类别, 路径/命令字段）映射表。 */
const READ_PATH_TOOLS: ReadonlySet<string> = new Set(["read", "ls", "find", "grep"]);
const WRITE_PATH_TOOLS: ReadonlySet<string> = new Set(["write", "edit"]);
const SHELL_TOOLS: ReadonlySet<string> = new Set(["bash", "powershell"]);

/** 从不可信参数对象上安全提取非空字符串字段。 */
function stringArg(args: unknown, key: string): string | undefined {
  if (args === null || typeof args !== "object") {
    return undefined;
  }
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * 把一次 Pi 工具调用请求映射为策略评估请求（Pi 0.85.1 内建工具精确
 * 分类；未知工具一律 other-high-risk 无路径 → 引擎 deny，fail closed）。
 */
export function classifyPiToolCall(request: PiPortToolCallRequest): PiToolPolicyRequest {
  const name = request.toolName;
  if (READ_PATH_TOOLS.has(name)) {
    const targetPath = stringArg(request.args, "path");
    return targetPath === undefined ? { category: "read" } : { category: "read", targetPath };
  }
  if (WRITE_PATH_TOOLS.has(name)) {
    const targetPath = stringArg(request.args, "path");
    return targetPath === undefined ? { category: "write" } : { category: "write", targetPath };
  }
  if (SHELL_TOOLS.has(name)) {
    const command = stringArg(request.args, "command");
    return command === undefined ? { category: "shell" } : { category: "shell", command };
  }
  return { category: "other-high-risk", action: name };
}
