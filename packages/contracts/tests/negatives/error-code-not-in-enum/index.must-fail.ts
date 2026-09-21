/**
 * 反例：TreeAIError.code 是封闭的 8 类枚举。
 * 期望：本文件编译失败（"catastrophe" 不在枚举内）。
 */
import type { TreeAIError } from "../../../src/index.js";

// 必须编译失败：code 只接受
// auth | model-unavailable | user-abort | timeout | policy-denied
// | upstream | session-corrupt | unknown。
const error: TreeAIError = {
  code: "catastrophe",
  message: "not a classified failure",
};
