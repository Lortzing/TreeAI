/**
 * D4-5 数据可携带 —— 恢复服务（issue #8 D4-5；契约 §5）。
 *
 * `--import-package <dir>`：把导出包恢复到**空数据目录**。
 *
 * 纪律（charter §5 / 契约 §5「导入流程」）：
 *  1. 目标只允许空数据目录（不存在或零条目；非空 → 明确拒绝）；
 *  2. 全部验证先在**暂存区**完成（与目标同文件系统的临时目录），任何
 *     失败目标原封不动：
 *     - 清单 schema/格式/产品 schema 版本（facts 布局必须与本构建一致）；
 *     - 条目完整性：包内文件与清单**双向全量比对**（多出的文件、缺失的
 *       文件、字节大小、SHA-256 校验和逐项复核）；
 *     - 路径安全：拒绝路径穿越/绝对路径/反斜杠/控制字符/命名违规与
 *       超限条目/超限包；拒绝符号链接；
 *     - facts 形状：列集与冻结布局逐列相等、行/格类型与 nullability 复核；
 *     - 引用完整性：全外键闭包 + 主键唯一性（跨文件校验；落库时 SQL
 *       FK/CHECK/触发器为第二层防御）；
 *     - 落库后 `PRAGMA foreign_key_check` + `PRAGMA integrity_check`；
 *  3. 验证全部通过后**原子落位**（暂存目录 rename 为目标数据目录——
 *     目标不存在或为空目录时才执行；rename 前再复核一次空目录）；
 *  4. 含 session 的包（显式导出选项）：session 原件落到 <data>/sessions/，
 *     session 引用行改写为恢复后的新路径（可续聊）；未含 session 的包
 *     保持原引用路径——指向不存在的旧位置，可用性探针如实判
 *     missing-file（fail-closed + 显式新探索，charter §1 路径 6）。
 *
 * 恢复承诺边界（charter §5）：产品事实可读 + 可显式新探索；不承诺旧 Pi
 * 上下文可续。恢复到非空目录/合并两个已使用库**明确不在**首版范围。
 */

/** Stable public restore service entrypoint. */
export type {
  RestorePackageOptions,
  RestorePackageResult,
} from "./restore/model.ts";
export {
  restorePackage,
  assertRestoreTargetEmpty,
} from "./restore/service.ts";
