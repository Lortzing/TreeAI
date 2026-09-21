/**
 * event-journal 内部共享的小工具（不构成公开契约面）。
 */

/** 值是否是 JSON 对象（非 null、非数组）。 */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 字符串是否是可解析的 ISO 8601 时间戳（宽松校验：Date.parse 非 NaN）。 */
export function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed);
}
