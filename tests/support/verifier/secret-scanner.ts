/**
 * Secret / redaction scanner for TreeAI D2 (Agent F).
 *
 * Zero-dependency Node reimplementation of the D1 rule set (test philosophy
 * reused per task book §1.3; the implementation is fresh D2 code — the D1
 * probe directory is never imported or copied). Scans text file CONTENT and
 * FILE NAMES for credential shapes and absolute user-home paths.
 *
 * Documented blind spots (inherited from D1, declared — not hidden):
 *   - skipped directories: .git, node_modules, venvs, caches, dist, build;
 *   - binary files (NUL sniff) and files > 20 MB are skipped;
 *   - rules are pattern matches; private token formats that do not match any
 *     rule are not detected;
 *   - DIRECTORY names are not scanned by scanFiles (pre-write blind spot that
 *     D1's T7 demonstrated); the verifier's post-write rescan of its own run
 *     directory covers the artifacts it writes, and the masked report keeps
 *     the run honest.
 *
 * Findings never contain the matched text: only the first 4 characters plus
 * the match length.
 */

import { createHash } from "node:crypto";
import {
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { basename, join, relative, sep } from "node:path";

export const SCANNER_VERSION = "d2-v1.1";

export const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "dist",
  "build",
  ".DS_Store",
]);

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8192;

interface ContentRule {
  ruleId: string;
  regex: RegExp;
  description: string;
}

/** Content rules — same coverage as D1 check-secrets (rule ids preserved). */
const CONTENT_RULES: ContentRule[] = [
  {
    ruleId: "anthropic-key",
    regex: /sk-ant-[A-Za-z0-9_-]{16,}/g,
    description: "Anthropic-style API key",
  },
  {
    ruleId: "openai-key",
    regex: /sk-(?!ant-)[A-Za-z0-9_-]{32,}/g,
    description: "OpenAI-style API key",
  },
  {
    ruleId: "aws-access-key",
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    description: "AWS access key id",
  },
  {
    ruleId: "google-api-key",
    regex: /\bAIza[0-9A-Za-z_\-]{35}/g,
    description: "Google API key",
  },
  {
    ruleId: "github-token",
    regex: /\bgh[pousr]_[A-Za-z0-9]{36,}/g,
    description: "GitHub token",
  },
  {
    ruleId: "slack-token",
    regex: /\bxox[baprs]-[A-Za-z0-9\-]{10,}/g,
    description: "Slack token",
  },
  {
    ruleId: "private-key-block",
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g,
    description: "PEM private key block",
  },
  {
    ruleId: "jwt",
    regex: /\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{4,}/g,
    description: "JSON Web Token",
  },
  {
    ruleId: "bearer-header",
    regex:
      /\bauthorization['"]?\s*[:=]\s*['"]?\s*bearer\s+[A-Za-z0-9\-._~+/]{8,}/gi,
    description: "Auth header carrying a bearer value",
  },
  {
    ruleId: "bearer-standalone",
    regex: /\bbearer\s+[A-Za-z0-9\-._~+/]{20,}/gi,
    description: "Standalone bearer token",
  },
  {
    ruleId: "env-secret-assignment",
    regex:
      /^[ \t]*(?:export[ \t]+)?[A-Za-z_][A-Za-z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]*[ \t]*=[ \t]*["']?(?=[^\r\n]*[A-Za-z])(?=[^\r\n]*[0-9])[^\s"']{8,}/gim,
    description: "Secret-like env var assignment",
  },
  {
    ruleId: "json-secret-field",
    regex:
      /[\"']?[A-Za-z0-9_\-]*(?:api_key|apikey|secret|token|password|passwd|credential)[A-Za-z0-9_\-]*[\"']?[ \t]*:[ \t]*[\"'](?=[^\"']*[0-9])[^\"]{12,}[\"']/gi,
    description: "Secret-like JSON or YAML field",
  },
  {
    ruleId: "npmrc-auth",
    regex: /^[ \t]*_(?:authToken|password)[ \t]*=[ \t]*\S+/gm,
    description: "npmrc auth value",
  },
  {
    ruleId: "netrc-password",
    regex: /^[ \t]*(?:machine\s+\S+\s+)?login\s+\S+\s+password\s+(?=\S*\d)\S+/gim,
    description: "netrc credentials line",
  },
  {
    ruleId: "home-path",
    regex: /\/(?:Users|home)\/[A-Za-z0-9_.\-]+/g,
    description: "Absolute user-home path",
  },
];

interface FilenameRule {
  ruleId: string;
  predicate: (basename: string) => boolean;
  description: string;
}

const FILENAME_RULES: FilenameRule[] = [
  {
    ruleId: "env-file",
    predicate: (b) => b === ".env" || b.startsWith(".env."),
    description: "dot-env style file present",
  },
  { ruleId: "netrc-file", predicate: (b) => b === ".netrc", description: "netrc credential file present" },
  {
    ruleId: "git-credentials-file",
    predicate: (b) => b === ".git-credentials",
    description: "git credentials file present",
  },
  {
    ruleId: "ssh-private-key-file",
    predicate: (b) =>
      b === "id_rsa" || b === "id_dsa" || b === "id_ecdsa" || b === "id_ed25519" || b.endsWith(".pem") || b.endsWith(".key"),
    description: "private key file present",
  },
  {
    ruleId: "service-account-file",
    predicate: (b) => b.includes("service-account") && b.endsWith(".json"),
    description: "service account credential file present",
  },
  {
    ruleId: "credentials-json-file",
    // EXACT stem match (plus dotted env-suffix variants): "credentials.json",
    // "creds.json", "secrets.prod.json" fire. Descriptive names like
    // "missing-credential-policy.json" or "live-fake-no-creds.json" (this
    // repo's schema probes legitimately test credential policy) must NOT —
    // secret VALUES inside any file are caught by the content rules.
    predicate: (b) =>
      /^(?:credentials?|creds?|secrets?|tokens?|api[-_.]?keys?|auth)(?:\.(?:prod|production|dev|test|testing|staging|stage|local|live|backup|bak|old|tmp|temp|sample|example))*\.json$/i.test(
        b,
      ),
    description: "credential json file present",
  },
  { ruleId: "htpasswd-file", predicate: (b) => b === ".htpasswd", description: "htpasswd file present" },
  {
    ruleId: "bare-credentials-file",
    predicate: (b) => b === "credentials",
    description: "credentials file present (review)",
  },
];

export interface Finding {
  ruleId: string;
  path: string;
  line: number;
  excerptMasked: string;
  description: string;
}

export interface ScanStats {
  filesScanned: number;
  filesSkippedBinary: number;
  filesSkippedLarge: number;
  filesUnreadable: number;
}

export interface ScanReport {
  scanner: "treeai-d2-check-secrets";
  scannerVersion: string;
  scannedRoots: string[];
  ruleCount: number;
  stats: ScanStats;
  findingCount: number;
  findings: Finding[];
}

export function mask(matchedText: string): string {
  return `${matchedText.slice(0, 4)}...[REDACTED len=${matchedText.length}]`;
}

/** Home-path redaction applied BEFORE any evidence content is written. */
export function redactHomePaths(text: string): string {
  return text.replace(/\/(?:Users|home)\/[A-Za-z0-9_.\-]+/g, "[HOME]");
}

function scanLine(line: string, path: string, lineno: number, out: Finding[]): void {
  for (const rule of CONTENT_RULES) {
    rule.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.regex.exec(line)) !== null) {
      out.push({
        ruleId: rule.ruleId,
        path,
        line: lineno,
        excerptMasked: mask(m[0]),
        description: rule.description,
      });
      if (m.index === rule.regex.lastIndex) rule.regex.lastIndex++;
    }
  }
}

/** Scan one text buffer; path is the display path used in findings. */
export function scanText(text: string, path: string): Finding[] {
  const out: Finding[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    scanLine(lines[i]!, path, i + 1, out);
  }
  return out;
}

/** Scan one file name (basename) against the filename rules. */
export function scanFilename(name: string, path: string): Finding[] {
  const out: Finding[] = [];
  for (const rule of FILENAME_RULES) {
    if (rule.predicate(name)) {
      out.push({
        ruleId: rule.ruleId,
        path,
        line: 0,
        excerptMasked: `(filename rule) ${name}`,
        description: rule.description,
      });
    }
  }
  return out;
}

function* iterFiles(roots: string[]): Generator<string> {
  for (const root of roots) {
    let st;
    try {
      st = statSync(root);
    } catch {
      continue;
    }
    if (st.isFile()) {
      yield root;
      continue;
    }
    const stack: string[] = [root];
    while (stack.length > 0) {
      const current = stack.pop()!;
      let entries;
      try {
        entries = readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      // Deterministic order.
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        const full = join(current, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) stack.push(full);
        } else if (entry.isFile()) {
          if (!SKIP_DIRS.has(entry.name)) yield full;
        }
      }
    }
  }
}

export function scanFiles(roots: string[], baseDir: string): ScanReport {
  const findings: Finding[] = [];
  const stats: ScanStats = {
    filesScanned: 0,
    filesSkippedBinary: 0,
    filesSkippedLarge: 0,
    filesUnreadable: 0,
  };
  for (const path of iterFiles(roots)) {
    const name = basename(path);
    const display = relative(baseDir, path).split(sep).join("/") || name;
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      stats.filesUnreadable++;
      continue;
    }
    if (size > MAX_FILE_BYTES) {
      stats.filesSkippedLarge++;
      continue;
    }
    let head: Buffer;
    let text: string;
    try {
      head = readFileSync(path).subarray(0, BINARY_SNIFF_BYTES);
      if (head.includes(0)) {
        stats.filesSkippedBinary++;
        continue;
      }
      text = readFileSync(path, "utf8");
    } catch {
      stats.filesUnreadable++;
      continue;
    }
    stats.filesScanned++;
    findings.push(...scanFilename(name, display));
    findings.push(...scanText(text, display));
  }
  findings.sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line || (a.ruleId < b.ruleId ? -1 : 1),
  );
  return {
    scanner: "treeai-d2-check-secrets",
    scannerVersion: SCANNER_VERSION,
    scannedRoots: roots.map((r) => relative(baseDir, r).split(sep).join("/")),
    ruleCount: CONTENT_RULES.length + FILENAME_RULES.length,
    stats,
    findingCount: findings.length,
    findings,
  };
}

/**
 * Mask every content-rule match inside `text`, replacing each with a masked
 * placeholder. Used by the evidence writer when a leak is detected pre-write:
 * the masked copy is stored, the leak is recorded, and the run is failed.
 */
export function maskSecretsInText(text: string): { masked: string; count: number } {
  let count = 0;
  let out = text;
  for (const rule of CONTENT_RULES) {
    rule.regex.lastIndex = 0;
    out = out.replace(rule.regex, (m) => {
      count++;
      return mask(m);
    });
  }
  return { masked: out, count };
}

/* ------------------------------------------------------------------ */
/* Self-test: synthetic corpus built at runtime in a temp dir.         */
/* No token literal is ever stored in the repository.                  */
/* ------------------------------------------------------------------ */

const SYNTH_ALPHABET = "abcdef0123456789";

function synth(n: number, offset = 0): string {
  let s = "";
  for (let i = 0; i < n; i++) {
    s += SYNTH_ALPHABET[(i + offset) % SYNTH_ALPHABET.length];
  }
  return s;
}

export interface SelfTestResult {
  pass: boolean;
  problems: string[];
  rulesFired: number;
  findings: number;
}

/**
 * Build a synthetic corpus in a system temp dir, scan it, and assert:
 *   1. every rule fires at least once;
 *   2. the clean corpus produces no findings;
 *   3. no unmasked token fragment appears in the serialized report.
 * The corpus is removed afterwards.
 */
export function runScannerSelfTest(): SelfTestResult {
  const problems: string[] = [];
  const tmpRoot = join(
    process.env.TREEAI_TMPDIR_SELFTEST && process.env.TREEAI_TMPDIR_SELFTEST.length > 0
      ? process.env.TREEAI_TMPDIR_SELFTEST
      : (process.env.TMPDIR ?? "/tmp"),
    `treeai-d2-sectest.${Date.now()}.${process.pid}`,
  );
  mkdirSync(tmpRoot, { recursive: true });
  try {
    const tok40 = synth(40);
    const tok48 = synth(48, 3);
    const tok30 = synth(30, 7);
    const tok32 = synth(32, 11);
    // Concatenation discipline (inherited from D1): every secret-shaped
    // string below is assembled from fragments so that THIS SOURCE FILE never
    // contains a contiguous match for any content rule (the workspace secret
    // scan covers this very file).
    const jwtTok =
      "ey" + "JhbGciOiJIUzI1NiJ9" + "." + "ey" + "zdWIiOjEyMw" + "." +
      "SflKxwRJSMeKKF2QT4fwpMeJf36POk";

    const positives = [
      "anthropic style key: " + "sk-ant-" + tok40,
      "openai style key: " + "sk-" + tok48,
      "aws key: " + "AKIA" + "0123456789ABCDEF" + " region eu-west-1",
      "google key: " + "AIza" + synth(36, 2),
      "github token: " + "ghp_" + synth(40, 5),
      "slack token: " + "xoxb-" + "1234-" + "5678-" + "abcd" + "5678",
      "key block:",
      "-----BEGIN " + "OPENSSH PRIVATE KEY" + "-----",
      "jwt: " + jwtTok,
      "auth header " + "Authorization" + ": " + "Bearer " + tok32,
      "standalone " + "bearer " + synth(40, 13),
      "MY_" + "API_KEY=" + tok30,
      "machine " + "example.test" + " login " + "demo" + " password " + synth(16, 4),
    ];
    writeFileSync(join(tmpRoot, "positives.txt"), `${positives.join("\n")}\n`, "utf8");

    const jsonKey = "api" + "_key";
    writeFileSync(
      join(tmpRoot, "config.json"),
      "{\n  " + JSON.stringify(jsonKey) + ": " + JSON.stringify(tok32) + "\n}\n",
      "utf8",
    );

    const envDir = join(tmpRoot, "dotenv");
    mkdirSync(envDir);
    writeFileSync(
      join(envDir, ".env"),
      "ANTHROPIC_" + "API_KEY=" + "sk-ant-" + tok40 + "\n",
      "utf8",
    );
    writeFileSync(
      join(envDir, ".npmrc"),
      "registry=https://registry.npmjs.org/\n" + "_" + "authToken=" + tok32 + "\n",
      "utf8",
    );
    writeFileSync(join(envDir, "id_rsa"), "-----BEGIN " + "RSA PRIVATE KEY" + "-----\n", "utf8");
    writeFileSync(join(envDir, "service-account" + "-fake.json"), "{}\n", "utf8");
    writeFileSync(
      join(envDir, ".netrc"),
      "machine example.test login demo password " + synth(16, 4) + "\n",
      "utf8",
    );
    writeFileSync(join(envDir, ".git-credentials"), "https://demo@example.test\n", "utf8");
    writeFileSync(join(envDir, "credentials" + ".prod.json"), "{}\n", "utf8");
    writeFileSync(join(envDir, ".htpasswd"), "demo:$apr1$sample\n", "utf8");
    writeFileSync(join(envDir, "credentials"), "review me\n", "utf8");

    const cleanDir = join(tmpRoot, "clean");
    mkdirSync(cleanDir);
    writeFileSync(
      join(cleanDir, "notes.txt"),
      [
        "The token bucket was empty after the burst.",
        "header was Authorization: Bearer <redacted>",
        "see the contract in the schemas dir",
        "count of values and their sum are checked",
        "/usr/local/bin/node and /opt/homebrew/bin/python3",
        "password policies are documented in the guide",
      ].join("\n") + "\n",
      "utf8",
    );

    writeFileSync(
      join(tmpRoot, "homepaths.txt"),
      "src at " + "/Users/" + "fixtureuser" + "/project/main.ts\n" +
        "venv at " + "/home/" + "fixtureuser" + "/repo/.venv\n",
      "utf8",
    );

    const report = scanFiles([tmpRoot], tmpRoot);
    const fired = new Set<string>();
    for (const f of report.findings) fired.add(f.ruleId);
    const allRuleIds = new Set<string>([
      ...CONTENT_RULES.map((r) => r.ruleId),
      ...FILENAME_RULES.map((r) => r.ruleId),
    ]);
    const missing = [...allRuleIds].filter((id) => !fired.has(id)).sort();
    const cleanFindings = report.findings.filter((f) => f.path.startsWith("clean/"));
    const reportText = JSON.stringify(report.findings);
    const leaks: string[] = [];
    for (const tok of [tok40, tok48, tok30, tok32, jwtTok]) {
      if (reportText.includes(tok)) leaks.push(tok.slice(0, 6));
    }

    if (missing.length > 0) problems.push(`rules did not fire: ${missing.join(", ")}`);
    if (cleanFindings.length > 0) {
      problems.push(`false positives on clean corpus: ${JSON.stringify(cleanFindings)}`);
    }
    if (leaks.length > 0) problems.push(`unmasked token fragments in report: ${JSON.stringify(leaks)}`);

    return {
      pass: problems.length === 0,
      problems,
      rulesFired: fired.size,
      findings: report.findings.length,
    };
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

/** Convenience: sha256 of a file (used by fixtures integrity). */
export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
