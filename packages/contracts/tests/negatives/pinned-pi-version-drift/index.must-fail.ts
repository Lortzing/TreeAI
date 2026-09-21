/**
 * 反例：Pi 版本漂移在编译期即被拒绝。
 * 期望：本文件编译失败（"0.85.2" 不是 PinnedPiVersion）。
 */
import type { PinnedPiVersion } from "../../../src/index.js";

// 必须编译失败：D2 基线锁定 0.85.1（ADR-001 / DECISION-003），
// 禁止 latest、范围版本或未批准的升级。
const drifted: PinnedPiVersion = "0.85.2";
