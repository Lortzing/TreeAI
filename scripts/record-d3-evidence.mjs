#!/usr/bin/env node
/**
 * record-d3 — D3 证据 manifest 生成器（issue #4 P1「证据工程化」）。
 *
 * 用途：把一组固定的离线验证命令的**事实**（命令、退出码、耗时、末 40 行
 * 输出）连同绑定 commit SHA 与产物 SHA-256，追加式落盘到
 * evidence/d3/offline/<UTC-run-id>-evidence-manifest/{manifest.json,result.md}。
 *
 * 纪律（对齐 scripts/verify-d2.js 与 evidence/d3/README.md）：
 *   - 只追加，不覆盖：run 目录已存在即干净失败（exit 1）；
 *   - 绑定 commit SHA：boundCommit 取 `git rev-parse HEAD`；工作区是否
 *     干净如实记录（gitDirty）；
 *   - 秘密纪律：所有命令输出在写盘前先脱敏（仓库 secret-scanner 规则：
 *     主目录绝对路径 → [HOME]、秘密形状 → 掩蔽），写盘后复扫 run 目录，
 *     发现 finding 即 exit 1 并在 notes 如实登记；
 *   - 不声明门禁结论：本脚本只登记事实；Gate 0–2 / A1–A7 的结论归负责人
 *     （docs/d3/D3-status.md），真实 Pi 与试用证据归 evidence/d3/real-pi/
 *     与 trials/ 口径，另行记录。
 *
 * 退出码判据（如实、狭窄）：
 *   0 — git-head / node --check app.js / npm run typecheck /
 *       npm test --workspace @treeai/studio / npm test 全部退出 0；
 *   1 — 上述任一命令非 0，或脚本自身失败（含写盘后扫描发现 finding）。
 *   verify:d2 的退出码**如实记录但计入判据之外**——CI 中由 d2-offline
 *   workflow 单独把关（本地未跟踪目录导致的已知 secret-scan 基线不重复
 *   计入本 manifest 的成功与否；规则见 manifest.notes）。
 *
 * 零 npm 依赖（仅 node: 内建 + 仓库内 tests/support/verifier 扫描器）。
 * 根 package.json 挂载为 `npm run record:d3`。
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  maskSecretsInText,
  redactHomePaths,
  scanText,
} from "../tests/support/verifier/secret-scanner.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE_ROOT = join(ROOT, "evidence", "d3", "offline");
const TAIL_LINES = 40;
const COMMAND_TIMEOUT_MS = 600_000;

/* ------------------------------------------------------------------ */
/* run 目录（UTC 时间戳，追加式）                                       */
/* ------------------------------------------------------------------ */

/** 紧凑 UTC 时间戳（与 verify-d2 的 utcRunId 同形：YYYYMMDDTHHMMSSmmmZ，
 *  毫秒精度防碰撞；无冒号——合法且跨平台安全的目录名成分）。 */
function compactUtcTimestamp() {
  const iso = new Date().toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}${iso.slice(20, 23)}Z`;
}

/* 目录名与 evidence/d3/offline/ 既有记录同序：<时间戳>-<标签>。 */
const runId = `${compactUtcTimestamp()}-evidence-manifest`;
const runDir = join(EVIDENCE_ROOT, runId);
if (existsSync(runDir)) {
  console.error(`[record-d3] run directory already exists, refusing to overwrite (append-only): ${runDir}`);
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* 命令执行                                                            */
/* ------------------------------------------------------------------ */

const TMPDIR_LITERAL = tmpdir();

/** 写盘前脱敏：ANSI 转义剥离 + 临时目录路径 + 主目录绝对路径 + 秘密形状掩蔽。 */
function sanitize(text) {
  const withoutAnsi = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  const withoutTmp = withoutAnsi.split(TMPDIR_LITERAL).join("$TMPDIR");
  const withoutHome = redactHomePaths(withoutTmp);
  return maskSecretsInText(withoutHome).masked;
}

function tailLines(text, count) {
  const lines = text.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-count);
}

function runCommand(id, command, argv, timeoutMs = COMMAND_TIMEOUT_MS) {
  const startedAt = Date.now();
  const res = spawnSync(command, argv, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    timeout: timeoutMs,
  });
  const output = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  const sanitized = sanitize(output);
  const item = {
    id,
    /* 命令字符串同样过脱敏（process.execPath 是主目录绝对路径——证据纪律
       禁止其入库；真实调用的可复现性不受影响）。 */
    command: sanitize([command, ...argv].join(" ")),
    exitCode: res.status,
    durationMs: Date.now() - startedAt,
    outputTail: tailLines(sanitized, TAIL_LINES),
  };
  if (res.error !== undefined) {
    item.error = String(res.error.message ?? res.error);
  }
  console.log(
    `  [${item.exitCode === 0 ? "ok" : `exit ${String(item.exitCode)}`}] ${id} (${item.durationMs}ms)`,
  );
  return item;
}

/* 固定命令清单（顺序即执行顺序）。 */
const COMMAND_SPECS = [
  { id: "git-head", command: "git", argv: ["rev-parse", "HEAD"], timeoutMs: 30_000 },
  { id: "node-version", command: process.execPath, argv: ["--version"], timeoutMs: 30_000 },
  { id: "npm-version", command: "npm", argv: ["--version"], timeoutMs: 60_000 },
  { id: "app-js-syntax", command: process.execPath, argv: ["--check", "apps/studio/public/app.js"], timeoutMs: 60_000 },
  { id: "typecheck", command: "npm", argv: ["run", "typecheck"] },
  { id: "studio-tests", command: "npm", argv: ["test", "--workspace", "@treeai/studio"] },
  { id: "root-tests", command: "npm", argv: ["test"] },
  { id: "verify-d2", command: "npm", argv: ["run", "verify:d2"] },
];

/** manifest 退出判据内的命令（verify:d2 除外——CI 另行把关，见文件头）。 */
const EXIT_CRITERIA = new Set(["git-head", "app-js-syntax", "typecheck", "studio-tests", "root-tests"]);

console.log(`record-d3 — D3 offline evidence manifest`);
console.log(`root: ${ROOT}`);
console.log(`run dir: ${runDir}`);
console.log("");

const recordedAt = new Date().toISOString();
const commands = COMMAND_SPECS.map((spec) => runCommand(spec.id, spec.command, spec.argv, spec.timeoutMs));

/* git 绑定信息。 */
const gitHead = commands.find((c) => c.id === "git-head");
if (gitHead === undefined || gitHead.exitCode !== 0) {
  console.error("[record-d3] FAIL: cannot bind to a commit (git rev-parse HEAD failed)");
  process.exit(1);
}
const boundCommit = (gitHead.outputTail[gitHead.outputTail.length - 1] ?? "").trim();
if (!/^[0-9a-f]{40}$/.test(boundCommit)) {
  console.error(`[record-d3] FAIL: unexpected HEAD shape: ${JSON.stringify(boundCommit)}`);
  process.exit(1);
}
const gitDirtyRes = spawnSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" });
const gitDirty = gitDirtyRes.status === 0 && gitDirtyRes.stdout.trim().length > 0;

/* npm 版本（来自上面记录的命令输出）。 */
const npmVersionCommand = commands.find((c) => c.id === "npm-version");
const npmVersion =
  npmVersionCommand !== undefined && npmVersionCommand.outputTail.length > 0
    ? npmVersionCommand.outputTail[npmVersionCommand.outputTail.length - 1].trim()
    : "unknown";

/* ------------------------------------------------------------------ */
/* 产物哈希                                                            */
/* ------------------------------------------------------------------ */

function sha256File(relativePath) {
  const absolute = join(ROOT, relativePath);
  return createHash("sha256").update(readFileSync(absolute)).digest("hex");
}

const STUDIO_PUBLIC_FILES = ["apps/studio/public/app.js", "apps/studio/public/index.html", "apps/studio/public/style.css"];

const artifacts = STUDIO_PUBLIC_FILES.map((path) => ({ path, sha256: sha256File(path) }));

/* ------------------------------------------------------------------ */
/* result.md（人类可读摘要；中文事实登记，不含门禁结论）                  */
/* ------------------------------------------------------------------ */

function resultMarkdown() {
  const commandRows = commands
    .map((c) => `| \`${c.command}\` | ${String(c.exitCode)} | ${c.durationMs}ms |`)
    .join("\n");
  const artifactRows = artifacts
    .map((a) => `| \`${a.path}\` | \`${a.sha256}\` |`)
    .join("\n");
  const shortSha = boundCommit.slice(0, 7);
  return `# D3 离线证据 manifest — \`${shortSha}\`（${recordedAt.slice(0, 10)}）

绑定提交：\`${boundCommit}\`（工作区${gitDirty ? "存在未提交改动（gitDirty = true）" : "干净"}）。
运行环境：Node ${process.version} / npm ${npmVersion} / ${process.platform} ${process.arch}。
本记录由 \`npm run record:d3\`（scripts/record-d3-evidence.mjs）生成，只登记事实
（命令、退出码、耗时、产物 SHA-256），不声明任何门禁结论。

## 命令结果（按执行顺序）

| 命令 | 退出码 | 耗时 |
| --- | --- | --- |
${commandRows}

完整输出尾部（各命令末 ${TAIL_LINES} 行，已脱敏）见 \`manifest.json\` 的 \`commands[].outputTail\`。

## 退出判据

- 本 manifest 生成脚本退出 0 的判据：\`node --check apps/studio/public/app.js\`、
  \`npm run typecheck\`、\`npm test --workspace @treeai/studio\`、\`npm test\`、
  SHA 绑定（git rev-parse HEAD）全部退出 0。
- \`npm run verify:d2\` 的退出码如实记录，**不计入**上述判据——CI 中由
  d2-offline workflow 单独把关。

## 产物哈希（Studio 前端基线输入）

| 文件 | SHA-256 |
| --- | --- |
${artifactRows}

\`manifest.json\` 的 \`artifacts\` 另含本 run 目录两个产物（result.md 与
manifest.json 自身）的 SHA-256；manifest 自哈希按空占位规则计算（见其 notes）。

## 边界（如实声明）

- 本 manifest 只覆盖**离线自动化**。真实 Pi Studio 操作证据、故障/幂等序列
  与 3–5 人试用记录按 evidence/d3/README.md 归 \`real-pi/\` 与 \`trials/\`
  口径另行记录（Go 条件要求全部证据同 SHA）。
- 命令输出仅保留末 ${TAIL_LINES} 行；绝对路径与秘密形状内容在写盘前掩蔽，
  写盘后对 run 目录复扫（仓库 secret-scanner 规则）。
- Studio 的 UI 自动化覆盖是脚本化 DOM 套件（apps/studio/tests/ui-probe.test.ts），
  非真实浏览器 E2E——像素级视觉基线不在其覆盖范围。
`;
}

/* ------------------------------------------------------------------ */
/* 写盘（先 result.md，后 manifest.json；追加式）                        */
/* ------------------------------------------------------------------ */

/* 写盘顺序固定（依赖关系）：result.md 先写（不引用 manifest 自哈希——
   manifest 自哈希依赖 result.md 的内容哈希，反向引用会构成自引用环）；
   manifest 后写，含三个 public 文件 + result.md 的哈希 + 自身的占位规则哈希。 */
mkdirSync(runDir, { recursive: false });
const manifestRelPath = `evidence/d3/offline/${runId}/manifest.json`;
const resultRelPath = `evidence/d3/offline/${runId}/result.md`;
writeFileSync(join(runDir, "result.md"), resultMarkdown(), "utf8");

/* manifest.json 无法包含自身的真实哈希（自引用不可能）：其 artifacts 条目的
   sha256 按「该条目哈希字段为空串时的规范序列化」计算（JSON.stringify(m, null, 2)
   + 换行）；校验时以同规则重算比对。 */
function buildManifest(selfHash) {
  const manifestArtifacts = [
    ...artifacts,
    { path: resultRelPath, sha256: sha256File(resultRelPath) },
    { path: manifestRelPath, sha256: selfHash },
  ];
  return {
    schemaVersion: "d3-evidence-manifest-1",
    boundCommit,
    recordedAt,
    environment: {
      node: process.version,
      npm: npmVersion,
      platform: `${process.platform} ${process.arch}`,
      gitDirty,
    },
    commands,
    artifacts: manifestArtifacts,
    notes: [
      "append-only: the run directory is created fresh; an existing directory aborts the script (exit 1) before any command runs",
      "verify:d2 exit code is recorded verbatim and is NOT part of this manifest's exit criteria — CI gates it separately via the d2-offline workflow (its local exit code can reflect pre-existing untracked-evidence secret-scan findings that do not exist in a clean checkout)",
      `command outputs are truncated to the last ${TAIL_LINES} lines; home-directory paths and secret-shaped content are masked before writing (repo secret-scanner rules); the run dir is rescanned after writing`,
      "manifest.json self-hash rule: its own artifacts entry's sha256 is computed over the canonical serialization (JSON.stringify(manifest, null, 2) + trailing newline) with that entry's sha256 set to the empty string; re-derive the same way to verify",
      "facts only — no gate verdicts: Gate 0-2 / A1-A7 conclusions belong to the owner (docs/d3/D3-status.md); real-Pi and trial evidence is tracked separately under evidence/d3/real-pi/ and evidence/d3/trials/",
    ],
  };
}

const placeholderManifest = buildManifest("");
const placeholderJson = `${JSON.stringify(placeholderManifest, null, 2)}\n`;
const selfHash = createHash("sha256").update(placeholderJson).digest("hex");
writeFileSync(join(runDir, "manifest.json"), `${JSON.stringify(buildManifest(selfHash), null, 2)}\n`, "utf8");

/* ------------------------------------------------------------------ */
/* 写盘后复扫（evidence/d3/README.md 秘密纪律）                         */
/* ------------------------------------------------------------------ */

const postFindings = [
  ...scanText(readFileSync(join(runDir, "manifest.json"), "utf8"), manifestRelPath),
  ...scanText(readFileSync(join(runDir, "result.md"), "utf8"), resultRelPath),
];
if (postFindings.length > 0) {
  const summary = postFindings.map((f) => `${f.path}:${f.line} ${f.ruleId}`).join("; ");
  const failNote = `post-write scan found ${postFindings.length} finding(s): ${summary}`;
  console.error(`[record-d3] FAIL: ${failNote}`);
  const failed = JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8"));
  failed.notes = [...failed.notes, `FAILURE: ${failNote} (recorded verbatim; the run dir is kept, not rewritten)`];
  writeFileSync(join(runDir, "manifest.json"), `${JSON.stringify(failed, null, 2)}\n`, "utf8");
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* 退出判据                                                            */
/* ------------------------------------------------------------------ */

const failedCriteria = commands.filter((c) => EXIT_CRITERIA.has(c.id) && c.exitCode !== 0);
console.log("");
console.log(`record-d3 summary:`);
for (const c of commands) {
  console.log(`  ${c.id}: exit ${String(c.exitCode)} (${c.durationMs}ms)`);
}
console.log(`  bound commit: ${boundCommit.slice(0, 12)}… (gitDirty: ${gitDirty ? "true" : "false"})`);
console.log(`  evidence: ${runDir}`);
if (failedCriteria.length > 0) {
  console.error(`[record-d3] FAIL: exit-criteria commands failed: ${failedCriteria.map((c) => c.id).join(", ")}`);
  process.exit(1);
}
console.log("[record-d3] manifest recorded (facts only — no gate verdicts).");
process.exit(0);
