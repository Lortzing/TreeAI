/**
 * 深度脱敏（REDACTION_VERSION = "d2-v1"）。
 *
 * 边界与义务（任务书 §5 Agent E 第 6 项、contracts events.ts 不变量）：
 *
 * 1. **调用方先脱敏，模块兜底**：进入 `TreeAIEvent.payload` /
 *    `EvidenceReference.locator` 的值按契约必须已由调用方（runtime-pi 等
 *    生产者）脱敏。本模块在持久化前对 payload 与 locator 再做一次深度
 *    脱敏，作为纵深防御（defense in depth），不是对调用方义务的替代。
 * 2. **覆盖面**（统一脱敏规则）：
 *    - token 形态：`sk-ant-` / `sk-proj-` / `sk-` 前缀 API key、GitHub
 *      `gh[pousr]_` token、Google `AIza` key、`xai-` key；
 *    - 认证头：`Bearer`、`Authorization:`、`x-api-key:`（保留头名前缀，
 *      替换凭据本体）；
 *    - cookie：`Cookie:` / `Set-Cookie:` 头中的 cookie 值（保留 cookie 名
 *      与 Set-Cookie 的 Path/Domain/Expires/Max-Age/SameSite/Secure/
 *      HttpOnly 等属性；**cookie 值一律视为凭据**，即使内容看似无害）；
 *    - provider URL：URL 中嵌入的凭据——userinfo（`https://user:pass@host`）
 *      与名称敏感的 query 参数（`?key=`、`&token=`、`&access_token=` 等）。
 *      URL 的 host/path **不是秘密**，保留以供审计（这是"provider URL
 *      脱敏"的实现边界：脱敏其中凭据，不整体抹除 URL）；
 *    - 环境变量式赋值：`<...>_API_KEY=...` / `<...>_TOKEN=` / `<...>_SECRET=`
 *      / `<...>_PASSWORD=` / `<...>_PASSPHRASE=`（值长度 ≥ 8 才视为凭据）；
 *    - 敏感 JSON 键（键名规范化后匹配 token/authorization/cookie/
 *      password/secret/credential 等）：值整体替换为 REDACTED 标记；
 *    - 敏感路径：家目录绝对路径（`/Users/<name>`、`/home/<name>`、
 *      `C:\Users\<name>`）规约为 `~/`，不泄漏本机用户名；
 *    - 结构防御：嵌套深度 > 32、循环引用、不可 JSON 序列化的值
 *      （undefined/function/symbol/bigint）分别以标记替换，不抛错。
 * 3. **不在脱敏范围内的字段**：`eventId` / `runId` / `type` /
 *    `occurredAt` 是 TreeAI 受控的领域标识与时间戳，不做模式脱敏
 *    （见 README"脱敏边界"）。`SessionReference.sessionId` / `entryId`
 *    是 Pi 稳定暴露的标识、非凭据（ADR-001 §4），可出现在 payload 中。
 * 4. **过脱敏权衡**：为安全起见，部分无害内容也会被替换（如以敏感名
 *    命名的 query 参数、`Bearer` 后跟 12+ 位单词字符的普通文本）。
 *    测试中的 clean corpus 界定了"必须原样保留"的内容范围。
 * 5. **自检**：`findRemainingSecrets` 可对已脱敏值复查是否仍有疑似秘密
 *    残留（对 REDACTED 标记本身不误报），供本模块测试与 Agent F 的
 *    验收器复用。
 *
 * 本文件在 D1 spike `d1-spikes/sdk-node/src/redact.ts`（d1-v1）的测试
 * 思想上扩展（任务书 §1.3 允许复用测试思想；未复制其代码路径）。
 */
import type { JsonValue } from "@treeai/contracts";

export const REDACTION_VERSION = "d2-v1";

const REDACTED = `[REDACTED:${REDACTION_VERSION}]`;

/* ------------------------------------------------------------------ */
/* token 形态（整段匹配替换）                                          */
/* ------------------------------------------------------------------ */

interface NamedPattern {
  readonly name: string;
  readonly re: RegExp;
}

const TOKEN_PATTERNS: readonly NamedPattern[] = [
  { name: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{8,}/g },
  { name: "openai-key", re: /\bsk-proj-[A-Za-z0-9_-]{8,}/g },
  { name: "generic-sk-key", re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { name: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g },
  { name: "google-api-key", re: /\bAIza[A-Za-z0-9_-]{20,}/g },
  { name: "xai-key", re: /\bxai-[A-Za-z0-9_-]{16,}\b/g },
];

/* URL userinfo（scheme 后紧邻的 user[:pass]@）——保留 scheme，替换凭据段。 */
const URL_USERINFO_RE = /(\bhttps?:\/\/)([A-Za-z0-9._~%!$&'()*+,;=:-]+)(?=@)/g;

/* URL query 中名称敏感的参数——保留参数名，替换值。 */
const URL_QUERY_SECRET_RE =
  /([?&])(api_?key|access_token|refresh_token|client_secret|id_token|session|token|key|auth|signature|sig|secret|password|passwd|credential)=([^&#\s"']*)/gi;

const BEARER_RE = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi;

const AUTHORIZATION_HEADER_RE =
  /\b(Authorization\s*:\s*)(?:Bearer\s+|Basic\s+|Token\s+|token\s+)?[A-Za-z0-9._~+/=-]{8,}/gi;

const X_API_KEY_HEADER_RE = /\b(x-api-key\s*:\s*)[A-Za-z0-9._~+/=-]{8,}/gi;

/* (?<!Set-) ：避免把 "Set-Cookie:" 中的 "Cookie:" 子串当作普通 Cookie 头
 * （否则 Set-Cookie 的属性保留逻辑会被先行破坏）。 */
const COOKIE_HEADER_RE = /(?<!Set-)\b(Cookie\s*:\s*)([^\r\n]+)/gi;
const SET_COOKIE_HEADER_RE = /\b(Set-Cookie\s*:\s*)([^\r\n]+)/gi;

const ENV_ASSIGNMENT_RE =
  /\b([A-Z0-9_]{2,}(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE)[A-Z0-9_]{0,32}\s*=\s*)([^\s"']{8,})/g;

/* 家目录绝对路径（macOS / Linux / Windows）。 */
const HOME_PATH_PATTERNS: readonly RegExp[] = [
  /\/Users\/[A-Za-z0-9._-]+(?:\/|$)/g,
  /\/home\/[A-Za-z0-9._-]+(?:\/|$)/g,
  /[A-Za-z]:[\\/](?:Users|users)[\\/][A-Za-z0-9._-]+[\\/]/g,
];

/* Set-Cookie 中保留（非凭据）的属性名（规范化小写）。 */
const SET_COOKIE_SAFE_ATTRIBUTES = new Set([
  "path",
  "domain",
  "expires",
  "max-age",
  "samesite",
  "secure",
  "httponly",
  "partitioned",
  "priority",
  "comment",
]);

/* 敏感 JSON 键（键名规范化 = 小写并去非字母数字后匹配）。 */
const SENSITIVE_KEY_NAMES = new Set([
  "apikey",
  "apikeys",
  "apisecret",
  "authorization",
  "auth",
  "accesstoken",
  "accesstokens",
  "bearertoken",
  "clientsecret",
  "credential",
  "credentials",
  "cookie",
  "cookies",
  "setcookie",
  "idtoken",
  "jwt",
  "password",
  "passwd",
  "passphrase",
  "privatekey",
  "refreshtoken",
  "secret",
  "secrets",
  "sessiontoken",
  "token",
  "tokens",
]);

const MAX_DEPTH = 32;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isRedactionMarker(value: string): boolean {
  return value.startsWith("[REDACTED:") || value.startsWith("[UNSERIALIZABLE:");
}

/** 将 cookie 段列表中的值替换为 REDACTED；Set-Cookie 模式保留非凭据属性。 */
function redactCookieSegments(headerValue: string, preserveAttributes: boolean): string {
  return headerValue
    .split(";")
    .map((segment) => {
      const eq = segment.indexOf("=");
      if (eq < 0) return segment;
      const name = segment.slice(0, eq).trim();
      if (name.length === 0) return segment;
      if (preserveAttributes && SET_COOKIE_SAFE_ATTRIBUTES.has(name.toLowerCase())) {
        return segment;
      }
      return `${name}=${REDACTED}`;
    })
    .join(";");
}

/** 检查已脱敏的 cookie 头中是否仍有未替换的值。 */
function cookieValueRemaining(headerValue: string, preserveAttributes: boolean): boolean {
  for (const segment of headerValue.split(";")) {
    const eq = segment.indexOf("=");
    if (eq < 0) continue;
    const name = segment.slice(0, eq).trim();
    const value = segment.slice(eq + 1);
    if (name.length === 0 || value.length === 0 || isRedactionMarker(value)) continue;
    if (preserveAttributes && SET_COOKIE_SAFE_ATTRIBUTES.has(name.toLowerCase())) continue;
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* 字符串脱敏                                                          */
/* ------------------------------------------------------------------ */

/**
 * 对单个字符串应用全部字符串级脱敏规则。
 * 返回脱敏结果与命中的规则类别（类别名供审计，不含内容本身）。
 */
export function redactStringWithCategories(input: string): {
  readonly value: string;
  readonly applied: readonly string[];
} {
  const applied: string[] = [];
  let out = input;

  for (const { name, re } of TOKEN_PATTERNS) {
    const next = out.replace(re, REDACTED);
    if (next !== out) applied.push(`pattern:${name}`);
    out = next;
  }

  let next = out.replace(URL_USERINFO_RE, `$1${REDACTED}`);
  if (next !== out) applied.push("pattern:url-userinfo");
  out = next;

  next = out.replace(URL_QUERY_SECRET_RE, (_match, sep: string, name: string) => `${sep}${name}=${REDACTED}`);
  if (next !== out) applied.push("pattern:url-query-secret");
  out = next;

  next = out.replace(BEARER_RE, `$1${REDACTED}`);
  if (next !== out) applied.push("pattern:bearer");
  out = next;

  next = out.replace(AUTHORIZATION_HEADER_RE, `$1${REDACTED}`);
  if (next !== out) applied.push("pattern:authorization-header");
  out = next;

  next = out.replace(X_API_KEY_HEADER_RE, `$1${REDACTED}`);
  if (next !== out) applied.push("pattern:x-api-key-header");
  out = next;

  next = out.replace(COOKIE_HEADER_RE, (_match, prefix: string, headerValue: string) =>
    prefix + redactCookieSegments(headerValue, false),
  );
  if (next !== out) applied.push("pattern:cookie-header");
  out = next;

  next = out.replace(SET_COOKIE_HEADER_RE, (_match, prefix: string, headerValue: string) =>
    prefix + redactCookieSegments(headerValue, true),
  );
  if (next !== out) applied.push("pattern:set-cookie-header");
  out = next;

  next = out.replace(ENV_ASSIGNMENT_RE, (_match, prefix: string) => prefix + REDACTED);
  if (next !== out) applied.push("pattern:env-assignment");
  out = next;

  for (const re of HOME_PATH_PATTERNS) {
    const candidate = out.replace(re, (match) => (match.endsWith("/") || match.endsWith("\\") ? "~/" : "~"));
    if (candidate !== out) applied.push("path:home");
    out = candidate;
  }

  return { value: out, applied };
}

/** 对单个字符串应用全部字符串级脱敏规则（只要结果）。 */
export function redactString(input: string): string {
  return redactStringWithCategories(input).value;
}

/* ------------------------------------------------------------------ */
/* 深度脱敏                                                            */
/* ------------------------------------------------------------------ */

export interface RedactionResult {
  /** 脱敏后的新结构（不修改入参）。 */
  readonly value: JsonValue;
  /** 命中的规则类别列表（如 "pattern:bearer"、"key:token"、"path:home"）。 */
  readonly applied: readonly string[];
}

function walk(
  value: unknown,
  keyHint: string | undefined,
  depth: number,
  applied: string[],
  seen: WeakSet<object>,
): JsonValue {
  if (depth > MAX_DEPTH) {
    applied.push("depth-limit");
    return "[REDACTED:depth-limit]";
  }
  if (keyHint !== undefined && SENSITIVE_KEY_NAMES.has(normalizeKey(keyHint))) {
    applied.push(`key:${keyHint}`);
    return REDACTED;
  }
  if (typeof value === "string") {
    const result = redactStringWithCategories(value);
    for (const category of result.applied) applied.push(category);
    return result.value;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "undefined" || typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
    applied.push("unserializable");
    return `[UNSERIALIZABLE:${typeof value}]`;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      applied.push("circular");
      return "[REDACTED:circular]";
    }
    seen.add(value);
    const out: JsonValue[] = value.map((item) => walk(item, undefined, depth + 1, applied, seen));
    seen.delete(value);
    return out;
  }
  if (typeof value === "object") {
    if (seen.has(value)) {
      applied.push("circular");
      return "[REDACTED:circular]";
    }
    seen.add(value);
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = walk(v, k, depth + 1, applied, seen);
    }
    seen.delete(value);
    return out;
  }
  applied.push("unserializable");
  return `[UNSERIALIZABLE:${typeof value}]`;
}

/**
 * 深度脱敏任意 JSON-ish 值：返回新结构（绝不修改入参），并收集命中的
 * 规则类别。用于 journal 持久化前的兜底脱敏。
 */
export function deepRedact(value: unknown, keyHint?: string): RedactionResult {
  const applied: string[] = [];
  const value2 = walk(value, keyHint, 0, applied, new WeakSet<object>());
  return { value: value2, applied };
}

/* ------------------------------------------------------------------ */
/* 自检：残留秘密探测                                                  */
/* ------------------------------------------------------------------ */

function testNonGlobal(re: RegExp, s: string): boolean {
  return new RegExp(re.source, re.flags.replace("g", "")).test(s);
}

function detectInString(s: string, found: Set<string>): void {
  for (const { name, re } of TOKEN_PATTERNS) {
    if (testNonGlobal(re, s)) found.add(name);
  }
  if (testNonGlobal(URL_USERINFO_RE, s)) found.add("url-userinfo");

  const query = new RegExp(URL_QUERY_SECRET_RE.source, "gi");
  let match: RegExpExecArray | null;
  while ((match = query.exec(s)) !== null) {
    const value = match[3] ?? "";
    if (value.length > 0 && !isRedactionMarker(value)) {
      found.add("url-query-secret");
      break;
    }
  }

  if (testNonGlobal(BEARER_RE, s)) found.add("bearer");
  if (testNonGlobal(AUTHORIZATION_HEADER_RE, s)) found.add("authorization-header");
  if (testNonGlobal(X_API_KEY_HEADER_RE, s)) found.add("x-api-key-header");

  const env = new RegExp(ENV_ASSIGNMENT_RE.source, "g");
  while ((match = env.exec(s)) !== null) {
    const value = match[2] ?? "";
    if (value.length >= 8 && !isRedactionMarker(value)) {
      found.add("env-assignment");
      break;
    }
  }

  const cookie = new RegExp(COOKIE_HEADER_RE.source, "gi");
  while ((match = cookie.exec(s)) !== null) {
    if (cookieValueRemaining(match[2] ?? "", false)) {
      found.add("cookie-value");
      break;
    }
  }
  const setCookie = new RegExp(SET_COOKIE_HEADER_RE.source, "gi");
  while ((match = setCookie.exec(s)) !== null) {
    if (cookieValueRemaining(match[2] ?? "", true)) {
      found.add("cookie-value");
      break;
    }
  }

  for (const re of HOME_PATH_PATTERNS) {
    if (testNonGlobal(re, s)) found.add("home-path");
  }
}

/**
 * 对已（ supposedly）脱敏的值复查是否仍有疑似秘密残留。
 * 返回命中的类别名（排序去重）；空数组表示未发现残留。
 * 对 REDACTED/UNSERIALIZABLE 标记本身不误报。
 *
 * 注意：这是启发式自检（best-effort），不构成完整的安全扫描；
 * 正式门禁是 Agent F 的 secret scan（任务书 §5 Agent F）。
 */
export function findRemainingSecrets(value: unknown): string[] {
  const found = new Set<string>();
  const visit = (v: unknown, depth: number): void => {
    if (depth > 64 || v === null) return;
    if (typeof v === "string") {
      detectInString(v, found);
      return;
    }
    if (typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const item of v) visit(item, depth + 1);
      return;
    }
    for (const [k, item] of Object.entries(v)) {
      if (
        SENSITIVE_KEY_NAMES.has(normalizeKey(k)) &&
        typeof item === "string" &&
        item.length > 0 &&
        !isRedactionMarker(item)
      ) {
        found.add(`unredacted-field:${k}`);
      }
      visit(item, depth + 1);
    }
  };
  visit(value, 0);
  return [...found].sort();
}
