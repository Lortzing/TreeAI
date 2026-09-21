/**
 * 脱敏工具：runtime-pi 的输出卫生边界。
 *
 * 契约义务（packages/contracts/src/errors.ts / events.ts 不变量）：
 * - TreeAIError.message / details、PiRuntimeEvent.payload 推送前必须已脱敏；
 * - 不得包含凭据、token、Authorization/Cookie 头、sk- 形态 API key、
 *   凭据字段名后跟的值、用户家目录绝对路径正文。
 *
 * 实现为纯函数、无副作用、无 I/O。规则保守：宁可多脱敏也不泄漏。
 */

import { homedir } from "node:os";

/** Bearer token（含 jwt 形态）整体替换。 */
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/g;
/** Authorization / Proxy-Authorization 头值整体替换。 */
const AUTH_HEADER_PATTERN = /\b(Authorization|Proxy-Authorization)\s*[:=]\s*[^\s"',;]+/gi;
/** Cookie / Set-Cookie 头值整体替换。 */
const COOKIE_PATTERN = /\b(Cookie|Set-Cookie)\s*[:=]\s*[^\n\r]+/gi;
/** OpenAI 风格 sk- API key（含 sk-proj- 等前缀变体）。 */
const SK_KEY_PATTERN = /\bsk-[A-Za-z0-9\-_]{8,}\b/g;
/** 凭据字段名后跟的值（key: value / "key": "value" / key=value 形态）。 */
const CREDENTIAL_FIELD_PATTERN =
  /\b(api[_-]?key|apikey|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|passwd)["']?\s*[:=]\s*["']?[^\s"',;&}]+/gi;
/**
 * 凭据字段名（整体匹配 JSON 对象的 key）。redactJsonValue 对命中
 * key 的值整体替换（字符串形式只能看到名字看不到关联值）。
 */
const CREDENTIAL_KEY_PATTERN =
  /^(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|passwd|token|authorization|cookie)$/i;

const REDACTED = "[REDACTED]";

/** 缓存家目录（避免每次调用 os.homedir；测试可注入）。 */
let cachedHome: string | null = null;

/** 仅供测试注入假家目录。 */
export function setHomedirForTesting(home: string | null): void {
  cachedHome = home;
}

function getHome(): string {
  if (cachedHome === null) {
    cachedHome = homedir();
  }
  return cachedHome;
}

/**
 * 对文本脱敏。规则按顺序应用；家目录路径前缀替换为 `~`
 * （避免泄漏用户名，同时保留可读的相对定位）。
 */
export function redactText(input: string): string {
  let out = input;
  // Bearer 先于 Authorization 头处理（头模式只吞到首个空白，
  // "Bearer <token>" 的 token 在第二个词，顺序反了会漏）。
  out = out.replace(BEARER_PATTERN, `Bearer ${REDACTED}`);
  out = out.replace(AUTH_HEADER_PATTERN, (_m, name: string) => `${name}: ${REDACTED}`);
  out = out.replace(COOKIE_PATTERN, (_m, name: string) => `${name}: ${REDACTED}`);
  out = out.replace(SK_KEY_PATTERN, REDACTED);
  out = out.replace(
    CREDENTIAL_FIELD_PATTERN,
    (_m, name: string) => `${name}=${REDACTED}`,
  );
  const home = getHome();
  if (home && home !== "/" && home.length > 1) {
    out = out.split(home).join("~");
  }
  return out;
}

/**
 * 递归脱敏 JSON 值中的所有字符串。key 命中凭据字段名（整体匹配）时，
 * 对应值无论类型一律整体替换为 [REDACTED]（字符串正文脱敏无法感知
 * key→value 关联，故在结构层处理）。
 */
export function redactJsonValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactJsonValue(item));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const redactedKey = redactText(key);
      out[redactedKey] = CREDENTIAL_KEY_PATTERN.test(key) ? REDACTED : redactJsonValue(item);
    }
    return out;
  }
  return value;
}

/** 取错误消息（安全：非 Error 的值 String() 化并截断）。 */
export function errorToMessage(err: unknown): string {
  if (err instanceof Error) {
    return `${err.name}: ${err.message}`;
  }
  const text = String(err);
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}
