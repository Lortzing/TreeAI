#!/usr/bin/env node
/**
 * test-macos-local — TreeAI D4-7 本机 macOS ARM64 真实安装实测驱动。
 *
 * 在「真机、真实平台数据目录、真实系统浏览器命令」上执行 B8 的本机子集：
 * 构建 A/B 两个版本 → 装入含中文与空格的目录 → 首次运行（真实 open + 记录器
 * 双证）→ 离线闭环 → 停止/重启（状态持久）→ 端口冲突恢复 → doctor →
 * 模型配置错误恢复 → 正常升级（数据保留）→ 损坏升级自动回滚 → 卸载默认
 * 保留数据 → 显式 --delete-data 删除。
 *
 * 诚实边界（写进证据，不许省略）：
 *   - 本脚本只在 darwin/arm64 运行；Windows 11 x64 / Ubuntu 24.04 的
 *     干净安装实测属于负责人目标机验证（B8 BLOCKED 部分），不由本脚本替代；
 *   - A/B 两版本是同一提交的两个版本号——升级机制（停机/备份/替换/健康
 *     验证/回滚/数据不动）是本实测的对象；跨提交的版本升级随真实发布验证；
 *   - 使用真实平台数据目录 ~/Library/Application Support/TreeAI：前置检查
 *     它必须不存在（不碰可能的真实用户数据），结束时必须恢复不存在。
 *
 * 用法（在仓内）：
 *   node scripts/d4/installer/test-macos-local.mjs [--keep] [--version-a X --version-b Y]
 *
 * 证据输出：evidence/d4/d4-7/d47-macos-<UTC>/（environment.json、
 * commands.log、summary.md、server 日志副本、secret-scan.json；全程 home
 * 路径脱敏后再落盘并复扫）。
 * 退出码：0 全部通过；1 环境不符/用法错误；2 任一断言失败。
 */

import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scanFiles } from "../../../tests/support/verifier/secret-scanner.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..", "..");
const EVIDENCE_ROOT = join(REPO_ROOT, "evidence", "d4", "d4-7");

const args = process.argv.slice(2);
function argValue(name) {
  const i = args.indexOf(`--${name}`);
  if (i !== -1 && i + 1 < args.length && !args[i + 1].startsWith("--")) return args[i + 1];
  return null;
}
const KEEP = args.includes("--keep");
const VERSION_A = argValue("version-a") ?? "0.1.0-d47local-a";
const VERSION_B = argValue("version-b") ?? "0.1.0-d47local-b";

/* ------------------------------------------------------------------ */
/* 环境                                                                */
/* ------------------------------------------------------------------ */

const HOME = homedir();
const REAL_DATA_DIR = join(HOME, "Library", "Application Support", "TreeAI");
const WORK_ROOT = join(tmpdir(), "treeai-d47-local");
/* 安装路径刻意含中文与空格（B8 验收项）。 */
const INSTALL_PARENT = join(WORK_ROOT, "安装 目录（中文+空格）");
const INSTALL_A = join(INSTALL_PARENT, `treeai-studio-${VERSION_A}-darwin-arm64`);
const ARCHIVE_A = `treeai-studio-${VERSION_A}-darwin-arm64.tar.gz`;
const ARCHIVE_B = `treeai-studio-${VERSION_B}-darwin-arm64.tar.gz`;

function redact(text) {
  return text.split(HOME).join("~");
}

function fail(message, code = 1) {
  process.stderr.write(`test-macos-local: ${message}\n`);
  process.exit(code);
}

if (process.platform !== "darwin" || process.arch !== "arm64") {
  fail(`本实测只支持 darwin/arm64（当前 ${process.platform}/${process.arch}）；其他平台见 B8 的负责人目标机验证。`);
}

/* 子进程环境基线：清掉会影响「真实路径/真实浏览器」语义的覆盖变量。 */
const BASE_ENV = { ...process.env };
delete BASE_ENV.TREEAI_DATA_DIR;
delete BASE_ENV.TREEAI_LAUNCH_NO_BROWSER;
delete BASE_ENV.BROWSER;
delete BASE_ENV.TREEAI_BROWSER;

const runId = `d47-macos-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z")}`;
const EVIDENCE_DIR = join(EVIDENCE_ROOT, runId);
mkdirSync(EVIDENCE_DIR, { recursive: true });
const commandLog = [];

/* ------------------------------------------------------------------ */
/* 记录与断言                                                          */
/* ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;
const failures = [];
function check(ok, label, detail = "") {
  if (ok) {
    passed += 1;
    process.stdout.write(`  [PASS] ${label}\n`);
  } else {
    failed += 1;
    failures.push(`${label}${detail === "" ? "" : ` — ${redact(detail)}`}`);
    process.stdout.write(`  [FAIL] ${label}${detail === "" ? "" : ` — ${redact(detail)}`}\n`);
  }
}

function logCommand(title, command, argv, result) {
  commandLog.push(
    [
      `## ${title}`,
      `$ ${redact([command, ...argv].map((p) => (/[\s"]/.test(p) ? `"${p}"` : p)).join(" "))}`,
      `exit=${String(result.status)}`,
      "```",
      redact(`${result.stdout}${result.stderr ? `\n(stderr)\n${result.stderr}` : ""}`).trim(),
      "```",
      "",
    ].join("\n"),
  );
}

function run(title, command, argv, opts = {}) {
  const res = spawnSync(command, argv, {
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 180_000,
    env: { ...BASE_ENV, ...(opts.env ?? {}) },
    cwd: opts.cwd,
  });
  const result = { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  logCommand(title, command, argv, result);
  return result;
}

function sectionTitle(text) {
  process.stdout.write(`\n== ${text}\n`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function httpJson(url, init) {
  try {
    const res = await fetch(url, init);
    const body = await res.json();
    return { status: res.status, ok: res.ok, body };
  } catch (err) {
    return { status: 0, ok: false, body: { error: String(err) } };
  }
}

function parseUrl(output) {
  const m = /url=(http:\/\/127\.0\.0\.1:(\d+))/.exec(output);
  return m === null ? null : { url: m[1], port: Number(m[2]) };
}

function executableShims(bundleRoot) {
  for (const name of readdirSync(bundleRoot)) {
    if (name.endsWith(".command") || name.endsWith(".sh")) {
      chmodSync(join(bundleRoot, name), 0o755);
    }
  }
}

/** 把真实数据目录里的运行痕迹复制进证据（在 --delete-data 之前调用）。 */
function snapshotDataDirEvidence() {
  try {
    const studioLog = join(REAL_DATA_DIR, "logs", "studio.log");
    if (existsSync(studioLog)) {
      writeFileSync(join(EVIDENCE_DIR, "studio-server.log"), redact(readFileSync(studioLog, "utf8")));
    }
    const launcherLog = join(REAL_DATA_DIR, "logs", "launcher.log");
    if (existsSync(launcherLog)) {
      writeFileSync(join(EVIDENCE_DIR, "launcher.log"), redact(readFileSync(launcherLog, "utf8")));
    }
    for (const file of ["config.json", "runtime.json"]) {
      const src = join(REAL_DATA_DIR, file);
      if (existsSync(src)) {
        writeFileSync(join(EVIDENCE_DIR, `data-${file}`), redact(readFileSync(src, "utf8")));
      }
    }
  } catch (err) {
    writeFileSync(join(EVIDENCE_DIR, "data-snapshot-error.txt"), redact(String(err)));
  }
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

const dataDirExistedBefore = existsSync(REAL_DATA_DIR);
let exitCode = 2;
let createdDataDirThisRun = false;

try {
  sectionTitle("0. 环境与前置");
  if (dataDirExistedBefore) {
    throw new Error(
      `真实数据目录 ${REAL_DATA_DIR} 已存在——本实测拒绝在可能有真实用户数据的状态下运行。` +
        "请先处理该目录（或确认其内容可丢弃后手动移除）再重跑。",
    );
  }
  rmSync(WORK_ROOT, { recursive: true, force: true });
  const swVers = run("sw_vers", "sw_vers", []);
  const arch = run("uname -m", "uname", ["-m"]);
  const nodeVersion = run("node --version", "node", ["--version"]);
  const gitHead = run("git rev-parse HEAD", "git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT });
  check(swVers.status === 0 && /ProductVersion/.test(swVers.stdout), "记录 macOS 版本", swVers.stdout);
  check(arch.stdout.trim() === "arm64", "主机架构 arm64", arch.stdout);
  check(nodeVersion.stdout.trim() === "v24.21.0", "构建机 Node 24.21.0", nodeVersion.stdout);
  writeFileSync(
    join(EVIDENCE_DIR, "environment.json"),
    JSON.stringify(
      {
        schemaVersion: "d47-macos-evidence-1",
        runId,
        generatedAt: new Date().toISOString(),
        mode: "local-real-macos",
        host: {
          platform: `${process.platform}/${process.arch}`,
          macOS: swVers.stdout.trim(),
          node: nodeVersion.stdout.trim(),
        },
        git: { commit: gitHead.stdout.trim() },
        versions: { a: VERSION_A, b: VERSION_B },
        realDataDir: redact(REAL_DATA_DIR),
        dataDirExistedBefore,
        installPathPattern: redact(INSTALL_PARENT),
        honesty: {
          browser: "首次运行用真实 macOS open 命令；URL 精确性另经 BROWSER 记录器捕获",
          upgradeAB:
            "A/B 为同一提交的两个版本号：本实测验证升级机制（停机/备份/替换/健康验证/回滚/数据不动），非跨提交内容差异",
          blocked:
            "Windows 11 x64 与 Ubuntu 24.04 的干净安装实测属负责人目标机验证（B8 BLOCKED），本机证据不替代",
        },
      },
      null,
      2,
    ) + "\n",
  );

  sectionTitle("1. 构建安装产物 A/B（package-installer.mjs）");
  const buildA = run(
    "构建产物 A",
    process.execPath,
    ["scripts/d4/package-installer.mjs", "--platform", "darwin-arm64", "--version", VERSION_A, "--out-dir", WORK_ROOT],
    { cwd: REPO_ROOT, timeoutMs: 420_000 },
  );
  if (existsSync(join(WORK_ROOT, "build-report-darwin-arm64.json"))) {
    copyFileSync(join(WORK_ROOT, "build-report-darwin-arm64.json"), join(EVIDENCE_DIR, "build-report-a.json"));
  }
  const buildB = run(
    "构建产物 B",
    process.execPath,
    ["scripts/d4/package-installer.mjs", "--platform", "darwin-arm64", "--version", VERSION_B, "--out-dir", WORK_ROOT],
    { cwd: REPO_ROOT, timeoutMs: 420_000 },
  );
  if (existsSync(join(WORK_ROOT, "build-report-darwin-arm64.json"))) {
    copyFileSync(join(WORK_ROOT, "build-report-darwin-arm64.json"), join(EVIDENCE_DIR, "build-report-b.json"));
  }
  check(buildA.status === 0 && buildB.status === 0, "A/B 构建退出码 0", buildA.stdout + buildA.stderr + buildB.stderr);
  const shaA = run("sha256 A", "shasum", ["-a", "256", join(WORK_ROOT, ARCHIVE_A)]);
  const shaB = run("sha256 B", "shasum", ["-a", "256", join(WORK_ROOT, ARCHIVE_B)]);
  check(shaA.status === 0 && shaB.status === 0, "记录产物 SHA256");
  writeFileSync(
    join(EVIDENCE_DIR, "sha256-archives.txt"),
    `${redact(shaA.stdout.trim())}\n${redact(shaB.stdout.trim())}\n`,
  );

  sectionTitle("2. 安装到含中文与空格的目录 → 首次运行（真实 open）");
  mkdirSync(INSTALL_PARENT, { recursive: true });
  run("解压产物 A 到安装目录", "tar", ["-xzf", join(WORK_ROOT, ARCHIVE_A), "-C", INSTALL_PARENT], { timeoutMs: 300_000 });
  check(existsSync(join(INSTALL_A, "VERSION.json")), "安装目录就绪（中文+空格路径）", INSTALL_A);
  executableShims(INSTALL_A);
  const firstRun = run("首次运行 start.command（真实 open）", join(INSTALL_A, "start.command"), [], {
    timeoutMs: 240_000,
  });
  check(firstRun.status === 0, "start.command 退出码 0", firstRun.stdout + firstRun.stderr);
  check(/首次运行，已生成默认离线配置/.test(firstRun.stdout), "首启生成默认离线配置", firstRun.stdout);
  check(
    /已请求系统浏览器打开 http:\/\/127\.0\.0\.1:\d+/.test(firstRun.stdout),
    "真实 open 唤起系统浏览器",
    firstRun.stdout,
  );
  const firstUrl = parseUrl(firstRun.stdout);
  check(firstUrl !== null, "首启输出实际 URL", firstRun.stdout);
  createdDataDirThisRun = existsSync(REAL_DATA_DIR);
  check(createdDataDirThisRun, "真实平台数据目录已创建", REAL_DATA_DIR);

  const health1 = await httpJson(`${firstUrl?.url}/api/health`);
  check(health1.ok && health1.body["ok"] === true, "GET /api/health → {ok:true}");
  const staticHtml = await fetch(firstUrl?.url)
    .then((r) => r.text())
    .catch(() => "");
  check(staticHtml.includes("<!doctype html>"), "GET / 静态前端可服务");
  const created1 = await httpJson(`${firstUrl?.url}/api/trees`, { method: "POST" });
  const treeId = created1.body?.["tree"]?.["id"];
  check(created1.status === 201 && typeof treeId === "string", "POST /api/trees 创建树（离线闭环）");
  const listed1 = await httpJson(`${firstUrl?.url}/api/trees`);
  check(
    Array.isArray(listed1.body?.["trees"]) && listed1.body["trees"].some((t) => t["id"] === treeId),
    "GET /api/trees 树在列",
  );

  sectionTitle("3. 浏览器 URL 精确性（BROWSER 记录器，不再开新标签）");
  const recorderScript = join(WORK_ROOT, "browser-recorder.sh");
  const recorderLog = join(WORK_ROOT, "browser-open.log");
  writeFileSync(
    recorderScript,
    `#!/bin/bash\nprintf '%s %s\\n' "$(date -u +%FT%TZ)" "$1" >> "${recorderLog}"\nexit 0\n`,
  );
  chmodSync(recorderScript, 0o755);
  run("停止实例（准备记录器首启）", join(INSTALL_A, "stop.command"), []);
  const recorderRun = run("start.command（BROWSER 记录器）", join(INSTALL_A, "start.command"), [], {
    env: { BROWSER: recorderScript },
    timeoutMs: 240_000,
  });
  check(recorderRun.status === 0, "记录器模式 start 退出码 0", recorderRun.stdout + recorderRun.stderr);
  await sleep(1_000);
  const recorderContent = existsSync(recorderLog) ? readFileSync(recorderLog, "utf8") : "";
  const recorderUrl = parseUrl(recorderRun.stdout);
  check(
    recorderUrl !== null && recorderContent.includes(recorderUrl.url),
    "记录器捕获的 URL 与实际监听端口一致",
    `${recorderContent.trim()} vs ${String(recorderUrl?.url)}`,
  );
  const listed2 = await httpJson(`${recorderUrl?.url}/api/trees`);
  check(listed2.body?.["trees"]?.some((t) => t["id"] === treeId), "第二次启动：数据仍持久");

  sectionTitle("4. 停止 → 重启 → 状态持久");
  const stop1 = run("stop.command", join(INSTALL_A, "stop.command"), []);
  check(stop1.status === 0 && /已停止/.test(stop1.stdout), "stop 优雅停止", stop1.stdout);
  await sleep(1_000);
  const restart1 = run("restart.command", join(INSTALL_A, "restart.command"), [], { timeoutMs: 240_000 });
  check(restart1.status === 0, "restart 退出码 0", restart1.stdout + restart1.stderr);
  const restartUrl = parseUrl(restart1.stdout);
  const listed3 = await httpJson(`${restartUrl?.url}/api/trees`);
  check(listed3.body?.["trees"]?.some((t) => t["id"] === treeId), "重启后树仍在（跨重启持久）");

  sectionTitle("5. 端口冲突自动顺延");
  const usedPort = restartUrl?.port ?? 8787;
  run("先停止", join(INSTALL_A, "stop.command"), []);
  const blocker = createServer();
  await new Promise((r) => blocker.listen(usedPort, "127.0.0.1", r));
  const conflictRun = run("端口被占时的 start.command", join(INSTALL_A, "start.command"), [], {
    env: { TREEAI_LAUNCH_NO_BROWSER: "1" },
    timeoutMs: 240_000,
  });
  blocker.close();
  check(conflictRun.status === 0, "端口冲突下 start 成功", conflictRun.stdout + conflictRun.stderr);
  check(/被占用，已自动改用/.test(conflictRun.stdout), "输出端口顺延提示", conflictRun.stdout);
  const conflictUrl = parseUrl(conflictRun.stdout);
  check(
    conflictUrl !== null && conflictUrl.port !== usedPort,
    `实际端口已顺延（${String(usedPort)} → ${String(conflictUrl?.port)}）`,
  );
  const conflictHealth = await httpJson(`${conflictUrl?.url}/api/health`);
  check(conflictHealth.ok, "顺延端口健康检查通过");
  check(
    (await httpJson(`${conflictUrl?.url}/api/trees`)).body?.["trees"]?.some((t) => t["id"] === treeId),
    "顺延端口上数据仍在",
  );

  sectionTitle("6. doctor（健康安装）");
  const doctor1 = run("doctor.command", join(INSTALL_A, "doctor.command"), [], { timeoutMs: 120_000 });
  check(doctor1.status === 0, "doctor 退出码 0", doctor1.stdout + doctor1.stderr);
  check(/数据目录可写/.test(doctor1.stdout), "doctor 确认真实数据目录可写", doctor1.stdout);
  const pathsOut = run("treeai.sh paths", join(INSTALL_A, "treeai.sh"), ["paths"], {});
  check(
    /install-root-default=.*Applications\/TreeAI/.test(pathsOut.stdout),
    "默认安装目录解析为 ~/Applications/TreeAI",
    pathsOut.stdout,
  );
  check(
    /data=.*Application Support\/TreeAI/.test(pathsOut.stdout),
    "数据目录解析为真实平台路径",
    pathsOut.stdout,
  );

  sectionTitle("7. 模型配置错误 → 可执行恢复");
  run("停止", join(INSTALL_A, "stop.command"), []);
  const configPath = join(REAL_DATA_DIR, "config.json");
  const goodConfig = readFileSync(configPath, "utf8");
  writeFileSync(
    configPath,
    JSON.stringify({ schemaVersion: 1, port: 8787, driver: "pi", provider: "", model: "" }, null, 2),
  );
  const badDoctor = run("坏配置 doctor.command", join(INSTALL_A, "doctor.command"), [], { timeoutMs: 120_000 });
  check(badDoctor.status === 1, "doctor 退出码 1", badDoctor.stdout + badDoctor.stderr);
  check(
    /driver=pi 需要 provider/.test(badDoctor.stdout) && /修复方法/.test(badDoctor.stdout),
    "doctor 给出修复步骤",
    badDoctor.stdout,
  );
  const badStart = run("坏配置 start.command", join(INSTALL_A, "start.command"), [], {
    env: { TREEAI_LAUNCH_NO_BROWSER: "1" },
    timeoutMs: 120_000,
  });
  check(
    badStart.status !== 0 && /配置校验未通过/.test(badStart.stdout + badStart.stderr),
    "start 拒绝坏配置",
    badStart.stdout + badStart.stderr,
  );
  writeFileSync(configPath, goodConfig);
  const recovered = run("修复后 start.command", join(INSTALL_A, "start.command"), [], {
    env: { TREEAI_LAUNCH_NO_BROWSER: "1" },
    timeoutMs: 240_000,
  });
  check(recovered.status === 0, "修复配置后可启动", recovered.stdout + recovered.stderr);
  const recoveredUrl = parseUrl(recovered.stdout);
  check(
    (await httpJson(`${recoveredUrl?.url}/api/trees`)).body?.["trees"]?.some((t) => t["id"] === treeId),
    "配置故障期间数据未丢失",
  );
  run("停止", join(INSTALL_A, "stop.command"), []);

  sectionTitle("8. 正常升级 A→B（数据保留）");
  run("解压产物 B（新版本）", "tar", ["-xzf", join(WORK_ROOT, ARCHIVE_B), "-C", WORK_ROOT], { timeoutMs: 300_000 });
  const NEW_B = join(WORK_ROOT, `treeai-studio-${VERSION_B}-darwin-arm64`);
  executableShims(NEW_B);
  const upgrade = run("upgrade.command --old <A 安装目录>", join(NEW_B, "upgrade.command"), ["--old", INSTALL_A], {
    timeoutMs: 420_000,
  });
  check(upgrade.status === 0, "upgrade 退出码 0", upgrade.stdout + upgrade.stderr);
  check(/升级成功/.test(upgrade.stdout), "输出升级成功", upgrade.stdout);
  check(/数据未做任何改动/.test(upgrade.stdout), "输出数据未动", upgrade.stdout);
  const upgradedManifest = JSON.parse(readFileSync(join(INSTALL_A, "VERSION.json"), "utf8"));
  check(upgradedManifest.bundleVersion === VERSION_B, "安装目录已替换为 B", String(upgradedManifest.bundleVersion));
  check(
    readdirSync(INSTALL_PARENT).some((n) => n.startsWith(`${basename(INSTALL_A)}.backup-`)),
    "旧版本 A 已完整备份",
  );
  const upgradeUrl = parseUrl(upgrade.stdout);
  check(
    upgradeUrl !== null &&
      (await httpJson(`${upgradeUrl.url}/api/trees`)).body?.["trees"]?.some((t) => t["id"] === treeId),
    "升级后树仍在（数据保留）",
  );
  run("停止升级后的实例", join(INSTALL_A, "stop.command"), []);

  sectionTitle("9. 损坏新包升级 → 自动回滚");
  const BROKEN = join(WORK_ROOT, "broken-new");
  mkdirSync(BROKEN, { recursive: true });
  run("解压产物 B（破坏版）", "tar", ["-xzf", join(WORK_ROOT, ARCHIVE_B), "-C", BROKEN], { timeoutMs: 300_000 });
  const BROKEN_ROOT = join(BROKEN, `treeai-studio-${VERSION_B}-darwin-arm64`);
  rmSync(join(BROKEN_ROOT, "app", "apps", "studio", "src", "index.ts"), { force: true });
  executableShims(BROKEN_ROOT);
  const brokenUpgrade = run("损坏新包 upgrade.command --old <A>", join(BROKEN_ROOT, "upgrade.command"), ["--old", INSTALL_A], {
    timeoutMs: 420_000,
  });
  check(brokenUpgrade.status !== 0, "损坏升级退出非 0", brokenUpgrade.stdout + brokenUpgrade.stderr);
  check(/回滚/.test(brokenUpgrade.stdout + brokenUpgrade.stderr), "输出已回滚", brokenUpgrade.stdout);
  const rollbackManifest = JSON.parse(readFileSync(join(INSTALL_A, "VERSION.json"), "utf8"));
  check(rollbackManifest.bundleVersion === VERSION_B, "回滚恢复到升级前版本（B）", String(rollbackManifest.bundleVersion));
  const rollbackStart = run("回滚后 start.command", join(INSTALL_A, "start.command"), [], {
    env: { TREEAI_LAUNCH_NO_BROWSER: "1" },
    timeoutMs: 240_000,
  });
  check(rollbackStart.status === 0, "回滚后可正常启动", rollbackStart.stdout + rollbackStart.stderr);
  const rollbackUrl = parseUrl(rollbackStart.stdout);
  check(
    (await httpJson(`${rollbackUrl?.url}/api/trees`)).body?.["trees"]?.some((t) => t["id"] === treeId),
    "回滚后数据仍在",
  );
  run("停止", join(INSTALL_A, "stop.command"), []);

  sectionTitle("10. 卸载：默认保留数据");
  snapshotDataDirEvidence();
  const uninstall1 = run("uninstall.command（默认）", join(INSTALL_A, "uninstall.command"), [], { timeoutMs: 120_000 });
  check(uninstall1.status === 0, "uninstall 退出码 0", uninstall1.stdout + uninstall1.stderr);
  check(/用户数据已保留/.test(uninstall1.stdout), "输出数据已保留", uninstall1.stdout);
  check(!existsSync(INSTALL_A), "安装目录已删除");
  check(existsSync(join(REAL_DATA_DIR, "treeai.db")), "真实数据目录与数据库仍在（默认保留）");

  sectionTitle("11. 卸载：显式 --delete-data");
  const REINSTALL = join(WORK_ROOT, "reinstall");
  mkdirSync(REINSTALL, { recursive: true });
  run("重解压产物 B", "tar", ["-xzf", join(WORK_ROOT, ARCHIVE_B), "-C", REINSTALL], { timeoutMs: 300_000 });
  const REINSTALL_ROOT = join(REINSTALL, `treeai-studio-${VERSION_B}-darwin-arm64`);
  executableShims(REINSTALL_ROOT);
  const uninstall2 = run("uninstall.command --delete-data", join(REINSTALL_ROOT, "uninstall.command"), ["--delete-data"], {
    timeoutMs: 120_000,
  });
  check(uninstall2.status === 0, "--delete-data 卸载退出码 0", uninstall2.stdout + uninstall2.stderr);
  check(/已删除数据目录/.test(uninstall2.stdout), "输出数据已删除", uninstall2.stdout);
  check(!existsSync(REAL_DATA_DIR), "真实数据目录已按显式 opt-in 删除");

  /* ---- 证据落盘 ---- */
  sectionTitle("12. 证据落盘与密钥复扫");
  if (recorderContent !== "") {
    writeFileSync(join(EVIDENCE_DIR, "browser-open.log"), redact(recorderContent));
  }
  const summary = [
    `# D4-7 本机 macOS ARM64 真实安装实测 — ${runId}`,
    "",
    "- 模式：local-real-macos（真机、真实平台数据目录、真实 open 命令）",
    `- 主机：${swVers.stdout.trim().split("\n").join("；")} / arm64；Node ${nodeVersion.stdout.trim()}`,
    `- 被测提交：${gitHead.stdout.trim()}`,
    `- 产物：A=${ARCHIVE_A}、B=${ARCHIVE_B}（同一提交的两个版本号，验证升级机制）`,
    `- 安装路径（中文+空格）：${redact(INSTALL_PARENT)}`,
    `- 真实数据目录：${redact(REAL_DATA_DIR)}（运行前不存在=${String(dataDirExistedBefore)}；结束后不存在=${String(!existsSync(REAL_DATA_DIR))}）`,
    "",
    `## 结果：PASS ${String(passed)} / FAIL ${String(failed)}`,
    "",
    failures.length > 0 ? `## 失败项\n${failures.map((f) => `- ${f}`).join("\n")}` : "全部通过。",
    "",
    "## 诚实边界",
    "- Windows 11 x64 / Ubuntu 24.04 的干净安装实测属负责人目标机验证（B8 BLOCKED 部分），本机证据不替代。",
    "- A/B 为同一提交的两个版本号：验证的是升级机制（停机/备份/替换/健康验证/回滚/数据不动）。",
    "- 真实 Pi 冒烟（模型调用）未包含：本实测零凭据（与 D4-7 工程波边界一致）。",
    "",
    "全部命令与退出码见 commands.log；环境见 environment.json。",
    "",
  ].join("\n");
  writeFileSync(join(EVIDENCE_DIR, "summary.md"), summary);
  writeFileSync(join(EVIDENCE_DIR, "commands.log"), commandLog.join("\n"));
  const scan = scanFiles([EVIDENCE_DIR], EVIDENCE_DIR);
  const scanReport = {
    scanner: "d2-v1.1",
    findings: scan.findings.map((f) => ({ ruleId: f.ruleId, path: redact(f.path) })),
    filesScanned: scan.stats.filesScanned,
  };
  writeFileSync(join(EVIDENCE_DIR, "secret-scan.json"), `${JSON.stringify(scanReport, null, 2)}\n`);
  check(scan.findings.length === 0, "证据密钥扫描零发现", JSON.stringify(scanReport.findings));
  check(!existsSync(REAL_DATA_DIR), "收尾：真实数据目录恢复不存在");

  exitCode = failed === 0 ? 0 : 2;
} catch (err) {
  process.stdout.write(`\ntest-macos-local: 异常中止：${err instanceof Error ? err.message : String(err)}\n`);
  writeFileSync(join(EVIDENCE_DIR, "commands.log"), commandLog.join("\n"));
  writeFileSync(
    join(EVIDENCE_DIR, "summary.md"),
    `# D4-7 本机 macOS 实测 — ${runId}\n\n异常中止：${err instanceof Error ? err.message : String(err)}\n\nPASS ${String(passed)} / FAIL ${String(failed)}\n`,
  );
  exitCode = 2;
} finally {
  /* 复原纪律：本实测创建的真实数据目录必须清理（只清理本实测创建过的）。 */
  if (createdDataDirThisRun && existsSync(REAL_DATA_DIR) && !KEEP) {
    try {
      const runtimeStatePath = join(REAL_DATA_DIR, "runtime.json");
      if (existsSync(runtimeStatePath)) {
        const state = JSON.parse(readFileSync(runtimeStatePath, "utf8"));
        if (state !== null && typeof state.pid === "number") {
          try {
            process.kill(state.pid, "SIGTERM");
          } catch {
            /* 已退出 */
          }
          await sleep(1_000);
        }
      }
      rmSync(REAL_DATA_DIR, { recursive: true, force: true });
      process.stdout.write("test-macos-local: 已清理本实测创建的数据目录\n");
    } catch (err) {
      process.stdout.write(
        `test-macos-local: 警告——数据目录清理失败：${err instanceof Error ? err.message : String(err)}（请手动检查 ${REAL_DATA_DIR}）\n`,
      );
    }
  }
  if (!KEEP) {
    rmSync(WORK_ROOT, { recursive: true, force: true });
  }
}
process.stdout.write(`\ntest-macos-local: 证据目录 ${redact(EVIDENCE_DIR)}\n`);
process.exit(exitCode);
