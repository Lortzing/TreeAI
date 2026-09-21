/**
 * 反例：终态迁移非法（run-state.ts I2 终态吸收）。
 * 期望：本文件编译失败（Expect 要求 true，得到 false）。
 */
import type { AllowedRunStateTransition } from "../../../src/index.js";
import type { Expect } from "../../../tests/type-test-utils.js";

// succeeded 是终态，不得迁出；AllowedRunStateTransition 为 false，
// 违反 Expect<T extends true> 约束 → 编译失败。
type _illegal = Expect<AllowedRunStateTransition<"succeeded", "running">>;
