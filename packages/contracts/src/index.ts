/**
 * @treeai/contracts —— TreeAI D2 冻结契约（Gate 0，CONTRACT-FREEZE-1）。
 *
 * 本包是纯类型包：只导出 TypeScript 类型/接口，无运行时代码、
 * 无第三方依赖、无 Pi SDK import。所有生产 package
 * （runtime-pi / persistence / tool-policy / event-journal）与
 * apps/runtime-smoke 只允许通过本包共享接口与数据形状。
 *
 * 破坏性变更流程见 docs/d2/contracts-README.md
 * （CONTRACT-CHANGE-xxx，需 Integrator 批准）。
 */

/* 基础类型 */
export type * from "./branding.js";
export type * from "./json.js";

/* 领域标识与关系 */
export type * from "./identifiers.js";

/* Pi 会话引用（引用而非内嵌：ADR-001 §4） */
export type * from "./session-reference.js";

/* Run 状态机 */
export type * from "./run-state.js";

/* 统一错误分类 */
export type * from "./errors.js";

/* 领域事件与运行时事件 */
export type * from "./events.js";

/* 工具策略决定 */
export type * from "./tool-decision.js";

/* PiRuntime 领域接口（唯一实现方：packages/runtime-pi） */
export type * from "./pi-runtime.js";
