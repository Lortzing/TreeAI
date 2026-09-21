/**
 * JSON 值类型：contracts 中所有"可持久化/可审计数据"的表示基础。
 *
 * 约定：
 * - 领域类型中的 payload 一律是 JSON 可序列化值（事件 journal、错误 details 等）。
 * - 任何进入 TreeAIEvent.payload / TreeAIError.details 的值都必须先完成脱敏
 *   （见 events.ts 与 errors.ts 的不变量说明）。类型系统无法强制脱敏，
 *   脱敏义务由生产者模块（event-journal、runtime-pi）承担并被其测试覆盖。
 */
export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JsonRecord = { readonly [key: string]: JsonValue };
