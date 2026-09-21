/**
 * 反例：品牌化领域标识不得互换。
 * 期望：本文件编译失败（BranchId 不能赋给 RunId）。
 */
import type { BranchId, RunId } from "../../../src/index.js";

declare const branchId: BranchId;

// 必须编译失败：BranchId 与 RunId 是不同的品牌类型。
const runId: RunId = branchId;
