/**
 * 反例：ToolDecision.outcome 是封闭枚举（allow | deny | require-approval）。
 * 期望：本文件编译失败（"maybe" 不在枚举内）。
 */
import type { ToolDecision } from "../../../src/index.js";

// 必须编译失败：require-approval 之外不存在"待定"语义。
const decision: ToolDecision = {
  outcome: "maybe",
  category: "write",
  risk: "high",
  reason: "invalid outcome must not compile",
  ruleId: null,
  scope: { roots: [] },
};
