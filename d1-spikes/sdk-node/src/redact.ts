/**
 * TreeAI D1 spike - evidence redaction (task book 6.1, Agent D alignment).
 *
 * Boundary: remove API keys, auth headers, home-directory absolute paths,
 * and .env-style assignments from anything written to evidence files.
 * Keep all test body content (prompts, answers, fixture values) intact.
 *
 * Redaction version: d1-v1.
 */

export const REDACTION_VERSION = "d1-v1";
const REDACTED = `[REDACTED:${REDACTION_VERSION}]`;

/** Secret-looking literal patterns. Applied to every string value. */
const STRING_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{8,}/g },
  { name: "openai-key", re: /\bsk-proj-[A-Za-z0-9_-]{8,}/g },
  { name: "generic-sk-key", re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { name: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g },
  { name: "google-api-key", re: /\bAIza[A-Za-z0-9_-]{20,}\b/g },
  { name: "xai-key", re: /\bxai-[A-Za-z0-9_-]{16,}\b/g },
  { name: "bearer", re: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi },
  {
    name: "authorization-header",
    re: /\b(Authorization\s*:\s*)(?:Bearer\s+|Basic\s+|token\s+)?[A-Za-z0-9._~+/=-]{8,}/gi,
  },
  { name: "x-api-key", re: /\b(x-api-key\s*:\s*)[A-Za-z0-9._~+/=-]{8,}/gi },
  {
    name: "env-assignment",
    re: /\b([A-Z0-9_]{2,}(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE)[A-Z0-9_]{0,32}\s*=\s*)[^\s"']{8,}/g,
  },
];

/** macOS / Linux home-directory absolute paths -> ~/. */
const HOME_PATH_PATTERNS: RegExp[] = [
  /\/Users\/[A-Za-z0-9._-]+\//g,
  /\/home\/[A-Za-z0-9._-]+\//g,
];

/** Object keys whose values are always redacted regardless of shape. */
const SENSITIVE_KEY_NAMES = new Set([
  "apikey",
  "api_key",
  "apikeys",
  "api_keys",
  "authorization",
  "auth",
  "accesstoken",
  "access_token",
  "accesstokens",
  "bearertoken",
  "bearer_token",
  "clientsecret",
  "client_secret",
  "credential",
  "credentials",
  "password",
  "passwd",
  "privatekey",
  "private_key",
  "refreshtoken",
  "refresh_token",
  "secret",
  "secrets",
  "sessiontoken",
  "session_token",
  "token",
  "tokens",
]);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function redactString(value: string): string {
  let out = value;
  for (const { re } of STRING_PATTERNS) {
    out = out.replace(re, (match, ...groups) => {
      // Keep the prefix ("Bearer ", "Authorization: ", "API_KEY=") for auditability,
      // replace only the credential itself.
      const prefix = typeof groups[0] === "string" ? groups[0] : "";
      return prefix + REDACTED;
    });
  }
  for (const re of HOME_PATH_PATTERNS) {
    out = out.replace(re, "~/");
  }
  return out;
}

/** Redact an arbitrary JSON-ish value in place (returns a new structure). */
export function redactValue(value: unknown, keyHint?: string, depth = 0): unknown {
  if (depth > 32) {
    return "[REDACTED:depth-limit]";
  }
  if (keyHint !== undefined && SENSITIVE_KEY_NAMES.has(normalizeKey(keyHint))) {
    return REDACTED;
  }
  if (typeof value === "string") {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, undefined, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v, k, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Best-effort detection of remaining secrets in an already-redacted value.
 * Used as a self-check before evidence is finalized; returns the pattern
 * names that still match.
 */
export function findLeakCandidates(value: unknown): string[] {
  const found = new Set<string>();
  const walk = (v: unknown, depth: number): void => {
    if (depth > 32 || v === null) return;
    if (typeof v === "string") {
      for (const { name, re } of STRING_PATTERNS) {
        const test = new RegExp(re.source, re.flags.replace("g", ""));
        if (test.test(v)) found.add(name);
      }
      for (const re of HOME_PATH_PATTERNS) {
        const test = new RegExp(re.source, re.flags.replace("g", ""));
        if (test.test(v)) found.add("home-path");
      }
      return;
    }
    if (typeof v !== "object") return;
    if (Array.isArray(v)) {
      v.forEach((item) => walk(item, depth + 1));
      return;
    }
    for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
      if (SENSITIVE_KEY_NAMES.has(normalizeKey(k))) {
        if (item !== REDACTED) found.add(`unredacted-field:${k}`);
      }
      walk(item, depth + 1);
    }
  };
  walk(value, 0);
  return [...found];
}
