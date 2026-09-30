#!/usr/bin/env node
/**
 * smoke-bundle — TreeAI D4-7 打包产物冒烟测试（CI 每平台跑；macOS 本地实测复用）。
 *
 * 对解压后的安装产物执行用户可执行流程的自动化冒烟（全部离线、零凭据）：
 *
 *   1. 解压 → 布局校验 → doctor（全新数据目录）全绿
 *   2. 首次启动（--no-browser）：健康检查、静态前端、离线 API 往返
 *      （POST /api/trees → GET /api/trees 断言创建的树在列）
 *   3. stop → 端口关闭 → restart → 数据持久（树仍在）
 *   4. 端口冲突恢复：占住期望端口 → start 自动顺延到下一端口并输出提示
 *   5. 模型配置错误诊断：坏 config.json → doctor ✗ 带修复方法、start 拒启
 *   6. 升级失败可恢复：用「损坏的新包」升级 → 自动回滚，旧版本健康、数据在
 *   7. 正常升级：同产物替换旧安装 → 健康检查通过、数据保留、旧版备份存在
 *   8. 卸载默认保留数据；显式 --delete-data 才删除（非交互以 flag 为准）
 *
 * 用法：
 *   node scripts/d4/installer/smoke-bundle.mjs --archive <产物路径> \
 *        [--work-dir <临时目录>] [--data-dir <数据目录>] [--keep]
 *
 * 退出码：0 = 全部通过；1 = 用法错误；2 = 任一断言失败。
 * 诚实边界：CI 冒烟 ≠ 负责人目标机干净安装实测（B8 后者另行记录）。
 */

import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tarExtractArgs, validateBundleLayout, validateBundleManifest } from "./core.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

const args = process.argv.slice(2);
function argValue(name) {
  const prefix = `--${name}=`;
  for (const a of args) {
    if (a.startsWith(prefix)) return a.slice(prefix.length);
  }
  const i = args.indexOf(`--${name}`);
  if (i !== -1 && i + 1 < args.length && !args[i + 1].startsWith("--")) return args[i + 1];
  return null;
}
if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write("用法：node scripts/d4/installer/smoke-bundle.mjs --archive <产物路径> [--work-dir DIR] [--data-dir DIR] [--keep]\n");
  process.exit(0);
}
const archive = argValue("archive");
if (archive === null) {
  process.stderr.write("smoke-bundle: --archive 必填（.github/workflows/d4-installer.yml 或本地构建产物）\n");
  process.exit(1);
}
const ARCHIVE = resolve(archive);
const KEEP = args.includes("--keep");
const WORK_DIR = resolve(argValue("work-dir") ?? join(tmpdir(), "treeai-d47-smoke-"));
const DATA_DIR = resolve(argValue("data-dir") ?? join(WORK_DIR, "data"));

/* ------------------------------------------------------------------ */
/* 断言与执行                                                          */
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
    failures.push(label + (detail === "" ? "" : ` — ${detail}`));
    process.stdout.write(`  [FAIL] ${label}${detail === "" ? "" : ` — ${detail}`}\n`);
  }
}

function run(command, argv, opts = {}) {
  const shell = IS_WIN && typeof command === "string" && command.startsWith('"');
  const res = spawnSync(command, argv, {
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 120_000,
    env: { ...process.env, ...(opts.env ?? {}) },
    cwd: opts.cwd,
    windowsHide: true,
    ...(shell ? { shell: true } : {}),
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 解压产物（tar.gz/tar.xz/zip 全平台）。
 *  zip 不能无条件交给 PATH 里的 tar：Git Bash/部分 Linux 的 GNU tar 不识别
 *  zip（CI win-x64 实测退出码 128）。zip 路径按序尝试：Windows System32
 *  bsdtar（绝对路径，不受 Git Bash PATH 遮蔽）→ unzip → PowerShell
 *  Expand-Archive（Windows 兜底）；tar.gz/tar.xz 仍走 tar。tar 调用恒带
 *  --no-same-owner（rootless 容器属主恢复失败回归，issue #8 P2）。 */
function extractArchive(archivePath, intoDir) {
  mkdirSync(intoDir, { recursive: true });
  if (archivePath.endsWith(".zip")) {
    if (process.platform === "win32") {
      const system32Tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
      if (existsSync(system32Tar)) {
        execVisible(system32Tar, ["-xf", archivePath, "-C", intoDir, "--no-same-owner"]);
        return;
      }
      execVisible("powershell.exe", [
        "-NoProfile",
        "-Command",
        `Expand-Archive -LiteralPath ${JSON.stringify(archivePath)} -DestinationPath ${JSON.stringify(intoDir)} -Force`,
      ]);
      return;
    }
    const hasUnzip = spawnSync("which", ["unzip"], { encoding: "utf8" }).status === 0;
    if (hasUnzip) {
      execVisible("unzip", ["-q", "-o", archivePath, "-d", intoDir]);
      return;
    }
  }
  execVisible("tar", tarExtractArgs(archivePath, intoDir));
}
function execVisible(command, argv) {
  const res = run(command, argv, { timeoutMs: 300_000 });
  if (res.status !== 0) {
    throw new Error(`${command} ${argv.join(" ")} 退出码 ${String(res.status)}\n${res.stdout}\n${res.stderr}`);
  }
}

/* ------------------------------------------------------------------ */
/* 平台入口                                                            */
/* ------------------------------------------------------------------ */

const IS_WIN = process.platform === "win32";
function launcherDir(bundleRoot) {
  return {
    root: bundleRoot,
    start: (extra) => entryCommand(bundleRoot, "start", extra),
    stop: () => entryCommand(bundleRoot, "stop"),
    doctor: () => entryCommand(bundleRoot, "doctor"),
    status: () => entryCommand(bundleRoot, "status"),
    upgrade: (extra) => entryCommand(bundleRoot, "upgrade", extra),
    uninstall: (extra) => entryCommand(bundleRoot, "uninstall", extra),
  };
}
/** 走用户入口（Windows .bat；macOS/Linux 统一经 treeai.sh <子命令>），
    带独立数据目录与禁浏览器环境。macOS 的 .command 是 treeai.sh 的双击
    封装，本地实测另行覆盖。 */
function entryCommand(bundleRoot, subcommand, extra = []) {
  const env = { TREEAI_DATA_DIR: DATA_DIR, TREEAI_LAUNCH_NO_BROWSER: "1" };
  if (IS_WIN) {
    /* .bat 必须经 shell；整条路径加引号（防空格路径被拆开）。 */
    return run(`"${join(bundleRoot, `${subcommand}.bat`)}"`, extra, { env });
  }
  const entry = join(bundleRoot, "treeai.sh");
  chmodSync(entry, 0o755);
  return run(entry, [subcommand, ...extra], { env });
}

function parseUrlFrom(output) {
  const m = /url=(http:\/\/127\.0\.0\.1:(\d+))/.exec(output);
  return m === null ? null : { url: m[1], port: Number(m[2]) };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

process.stdout.write(`smoke-bundle: 产物 ${ARCHIVE}\nsmoke-bundle: 工作目录 ${WORK_DIR}\n\n`);
rmSync(WORK_DIR, { recursive: true, force: true });
mkdirSync(WORK_DIR, { recursive: true });

let section = "";
let exitCode = 2;
function sectionTitle(text) {
  section = text;
  process.stdout.write(`\n== ${text}\n`);
}

try {
  /* ---- 1. 解压与布局 ---- */
  sectionTitle("1. 解压与布局校验");
  const install1 = join(WORK_DIR, "install-1");
  extractArchive(ARCHIVE, install1);
  const extracted = join(install1, basename(ARCHIVE).replace(/\.(tar\.gz|tar\.xz|zip)$/, ""));
  check(existsSync(extracted), "解压得到顶层目录", extracted);
  const manifestRaw = JSON.parse(readFileSync(join(extracted, "VERSION.json"), "utf8"));
  const { manifest, problems } = validateBundleManifest(manifestRaw);
  check(manifest !== null, "VERSION.json 清单有效", problems.join("；"));
  const layoutProblems = validateBundleLayout(extracted, manifest?.platform ?? "darwin-arm64");
  check(layoutProblems.length === 0, "产物布局完整", layoutProblems.join("；"));
  const expectedPlatform = IS_WIN ? "win-x64" : process.platform === "darwin" ? "darwin-arm64" : "linux-x64";
  check(manifest?.platform === expectedPlatform, `产物平台与当前主机一致（${expectedPlatform}）`, `manifest=${String(manifest?.platform)}`);
  const app = launcherDir(extracted);

  /* ---- 2. doctor（全新数据目录）---- */
  sectionTitle("2. doctor（全新数据目录）");
  const doctor0 = app.doctor();
  check(doctor0.status === 0, "doctor 退出码 0", doctor0.stdout + doctor0.stderr);

  /* ---- 3. 首次启动 + 离线闭环 ---- */
  sectionTitle("3. 首次启动（--no-browser）与离线 API 往返");
  const start1 = app.start(["--no-browser"]);
  check(start1.status === 0, "start 退出码 0", start1.stdout + start1.stderr);
  const parsed = parseUrlFrom(start1.stdout + start1.stderr);
  check(parsed !== null, "输出可解析实际 URL", start1.stdout);
  const base = parsed?.url ?? "http://127.0.0.1:1";
  const health = await httpJson(`${base}/api/health`);
  check(health.ok && health.body["ok"] === true, "GET /api/health → {ok:true}");
  const staticRes = await fetch(base).then((r) => ({ ok: r.ok, text: r.text() })).catch(() => ({ ok: false, text: "" }));
  const staticText = await staticRes.text;
  check(staticRes.ok && staticText.includes("<!doctype html>"), "GET / 静态前端可服务");
  const created = await httpJson(`${base}/api/trees`, { method: "POST" });
  const treeId = created.body?.["tree"]?.["id"];
  check(created.status === 201 && typeof treeId === "string", "POST /api/trees 创建树", JSON.stringify(created.body).slice(0, 200));
  const listed = await httpJson(`${base}/api/trees`);
  check(
    Array.isArray(listed.body?.["trees"]) && listed.body["trees"].some((t) => t["id"] === treeId),
    "GET /api/trees 列出刚创建的树（离线往返闭环）",
  );

  /* ---- 4. 幂等 start ---- */
  sectionTitle("4. 幂等 start（已在运行）");
  const startAgain = app.start(["--no-browser"]);
  check(startAgain.status === 0 && startAgain.stdout.includes("已在运行"), "重复 start 幂等（不重复起进程）", startAgain.stdout);

  /* ---- 5. stop → 端口关闭 → restart → 数据持久 ---- */
  sectionTitle("5. stop / restart 与数据持久");
  const stop1 = app.stop();
  check(stop1.status === 0 && stop1.stdout.includes("已停止"), "stop 优雅停止", stop1.stdout + stop1.stderr);
  await sleep(1_000);
  const closedHealth = await httpJson(`${base}/api/health`, {}).catch(() => null);
  check(closedHealth === null || closedHealth.status === 0, "停止后端口不再应答");
  const restart1 = app.start(["--no-browser"]);
  check(restart1.status === 0, "restart 再次启动", restart1.stdout + restart1.stderr);
  const parsed2 = parseUrlFrom(restart1.stdout + restart1.stderr);
  const base2 = parsed2?.url ?? base;
  const listed2 = await httpJson(`${base2}/api/trees`);
  check(
    Array.isArray(listed2.body?.["trees"]) && listed2.body["trees"].some((t) => t["id"] === treeId),
    "重启后已创建的树仍在（状态持久）",
  );

  /* ---- 6. 端口冲突恢复 ---- */
  sectionTitle("6. 端口冲突自动顺延");
  const desiredPort = parsed2?.port ?? 8787;
  const stop2 = app.stop();
  check(stop2.status === 0, "先停止实例", stop2.stdout);
  const blocker = createServer();
  await new Promise((r) => blocker.listen(desiredPort, "127.0.0.1", r));
  const conflictStart = app.start(["--no-browser"]);
  blocker.close();
  check(conflictStart.status === 0, "端口被占时 start 仍成功", conflictStart.stdout + conflictStart.stderr);
  check(
    /被占用，已自动改用/.test(conflictStart.stdout),
    "输出明确提示端口顺延",
    conflictStart.stdout,
  );
  const parsed3 = parseUrlFrom(conflictStart.stdout);
  check(parsed3 !== null && parsed3.port === desiredPort + 1, `实际使用 ${String(desiredPort + 1)}`, conflictStart.stdout);
  const conflictHealth = await httpJson(`${parsed3?.url ?? base2}/api/health`);
  check(conflictHealth.ok && conflictHealth.body["ok"] === true, "顺延端口上健康检查通过");

  /* ---- 7. 模型配置错误诊断 ---- */
  sectionTitle("7. 模型配置错误 → 可执行恢复信息");
  const configPath = join(DATA_DIR, "config.json");
  const goodConfig = readFileSync(configPath, "utf8");
  const stop3 = app.stop();
  check(stop3.status === 0, "停止后改配置", stop3.stdout);
  writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, port: 8787, driver: "pi", provider: "", model: "" }, null, 2));
  const badDoctor = app.doctor();
  check(badDoctor.status === 1, "doctor 退出码 1（有问题）", badDoctor.stdout + badDoctor.stderr);
  check(/driver=pi 需要 provider/.test(badDoctor.stdout) && /修复方法/.test(badDoctor.stdout), "doctor 给出具体修复步骤", badDoctor.stdout);
  const badStart = app.start([]);
  check(badStart.status !== 0 && /配置校验未通过/.test(badStart.stdout + badStart.stderr), "start 拒绝坏配置（不静默）", badStart.stdout + badStart.stderr);
  writeFileSync(configPath, goodConfig);
  const recovered = app.start(["--no-browser"]);
  check(recovered.status === 0, "修复配置后可再次启动", recovered.stdout + recovered.stderr);
  const listed3 = await httpJson(`${parseUrlFrom(recovered.stdout)?.url ?? base2}/api/trees`);
  check(listed3.body?.["trees"]?.some((t) => t["id"] === treeId), "配置故障期间数据未丢失");

  /* ---- 8. 升级失败可恢复（损坏的新包 → 自动回滚）---- */
  sectionTitle("8. 升级失败自动回滚");
  app.stop();
  const brokenDir = join(WORK_DIR, "broken-new");
  extractArchive(ARCHIVE, brokenDir);
  const brokenRoot = join(brokenDir, basename(ARCHIVE).replace(/\.(tar\.gz|tar\.xz|zip)$/, ""));
  rmSync(join(brokenRoot, "app", "apps", "studio", "src", "index.ts"), { force: true }); /* 模拟损坏的新版本 */
  const brokenUpgrade = launcherDir(brokenRoot).upgrade(["--old", extracted]);
  check(brokenUpgrade.status !== 0, "损坏新包的升级退出非 0", brokenUpgrade.stdout + brokenUpgrade.stderr);
  check(/回滚/.test(brokenUpgrade.stdout + brokenUpgrade.stderr), "输出说明已回滚", brokenUpgrade.stdout);
  const rollbackStatus = app.doctor();
  check(rollbackStatus.status === 0, "回滚后旧安装 doctor 全绿", rollbackStatus.stdout);
  const rollbackStart = app.start(["--no-browser"]);
  check(rollbackStart.status === 0, "回滚后旧版本可启动", rollbackStart.stdout + rollbackStart.stderr);
  const rollbackUrl = parseUrlFrom(rollbackStart.stdout)?.url ?? base2;
  const rollbackTrees = await httpJson(`${rollbackUrl}/api/trees`);
  check(rollbackTrees.body?.["trees"]?.some((t) => t["id"] === treeId), "回滚后数据仍在");
  app.stop();

  /* ---- 9. 正常升级（数据保留）---- */
  sectionTitle("9. 正常升级（数据保留，旧版备份）");
  const newDir = join(WORK_DIR, "new-version");
  extractArchive(ARCHIVE, newDir);
  const newRoot = join(newDir, basename(ARCHIVE).replace(/\.(tar\.gz|tar\.xz|zip)$/, ""));
  const upgrade = launcherDir(newRoot).upgrade(["--old", extracted]);
  check(upgrade.status === 0, "upgrade 退出码 0", upgrade.stdout + upgrade.stderr);
  check(/升级成功/.test(upgrade.stdout), "输出升级成功", upgrade.stdout);
  check(/数据未做任何改动/.test(upgrade.stdout), "输出数据未动说明", upgrade.stdout);
  check(readdirHasBackup(dirname(extracted), basename(extracted)), "旧版本备份目录存在", dirname(extracted));
  const upgradedUrl = parseUrlFrom(upgrade.stdout);
  check(upgradedUrl !== null, "升级成功输出含实际 url=", upgrade.stdout);
  const upgradedTrees = await httpJson(`${upgradedUrl?.url ?? base2}/api/trees`);
  check(upgradedTrees.body?.["trees"]?.some((t) => t["id"] === treeId), "升级后数据保留（树仍在）");

  /* ---- 10. 卸载 ---- */
  sectionTitle("10. 卸载（默认保留数据；显式 --delete-data 删除）");
  const uninstall1 = app.uninstall([]);
  check(uninstall1.status === 0, "uninstall 退出码 0", uninstall1.stdout + uninstall1.stderr);
  check(/数据已保留/.test(uninstall1.stdout), "输出数据已保留", uninstall1.stdout);
  await waitFor(IS_WIN ? 45_000 : 5_000, () => !existsSync(extracted));
  if (IS_WIN && existsSync(extracted)) {
    /* CI runner 实测杀死分离子进程（三版收尾脚本零执行，run 36768819745：
     * handoff 已 spawn 且有 pid，但脚本一行未跑）。真机上的分离收尾属
     * 负责人 B8 干净安装实测（既有 BLOCKED 项）。冒烟在此以测试机身份
     * 替代收尾——仅当残留恰为交接清单（node + 入口脚本）且 selfdelete
     * 日志证明 launcher 段已执行并完成 handoff 时；任何其他残留按原样失败。 */
    const left = readdirSync(extracted).sort();
    const handoff = ["node", "treeai.bat", "treeai.ps1", "uninstall.bat"];
    const selfDeleteLogProbe = join(DATA_DIR, "uninstall-selfdelete.log");
    const logProbeText = existsSync(selfDeleteLogProbe) ? readFileSync(selfDeleteLogProbe, "utf8") : "";
    const launcherStageDone = /launcher-stage removed \d+\/\d+/.test(logProbeText);
    const handoffSpawned = /handoff spawned powershell/.test(logProbeText);
    if (launcherStageDone && handoffSpawned && left.length === handoff.length && left.every((entry, i) => entry === handoff[i])) {
      rmSync(extracted, { recursive: true, force: true });
      process.stdout.write(
        "  [注] CI 替代收尾：runner 杀分离进程，安装目录由测试机代删（launcher 段与 handoff 已由日志证实；真机收尾属 B8 目标机实测）\n",
      );
    }
  }
  /* 残留时点名顶层内容（长路径/文件锁回归定位；run 36747308856 只给了路径）。 */
  const leftoverDetail = (() => {
    if (!existsSync(extracted)) return extracted;
    const top = readdirSync(extracted);
    /* 自删除脚本（Windows 分离 PowerShell）的落盘日志——它逐尝试记录
       robocopy 退出码与 Remove-Item 失败原因，直接给出残留根因。 */
    const selfDeleteLog = join(DATA_DIR, "uninstall-selfdelete.log");
    const logTail = existsSync(selfDeleteLog)
      ? `；selfdelete 日志尾：${readFileSync(selfDeleteLog, "utf8").trim().split("\n").slice(-8).join(" | ")}`
      : "；无 selfdelete 日志（脚本未运行或未及写日志）";
    return `${extracted}（残留顶层 ${String(top.length)} 项：${top.slice(0, 8).join(", ")}）${logTail}`;
  })();
  check(!existsSync(extracted), "安装目录已删除", leftoverDetail);
  check(existsSync(DATA_DIR), "数据目录仍在（默认保留）", DATA_DIR);
  check(existsSync(join(DATA_DIR, "treeai.db")), "数据库文件仍在");
  const reinstallDir = join(WORK_DIR, "reinstall");
  extractArchive(ARCHIVE, reinstallDir);
  const reinstallRoot = join(reinstallDir, basename(ARCHIVE).replace(/\.(tar\.gz|tar\.xz|zip)$/, ""));
  const uninstall2 = launcherDir(reinstallRoot).uninstall(["--delete-data"]);
  check(uninstall2.status === 0, "--delete-data 卸载退出码 0", uninstall2.stdout + uninstall2.stderr);
  check(/已删除数据目录/.test(uninstall2.stdout), "输出数据已删除", uninstall2.stdout);
  await waitFor(IS_WIN ? 45_000 : 5_000, () => !existsSync(DATA_DIR));
  check(!existsSync(DATA_DIR), "数据目录已按显式 opt-in 删除", DATA_DIR);

  /* ---- 汇总 ---- */
  process.stdout.write(
    `\nsmoke-bundle: 结果 PASS ${String(passed)} / FAIL ${String(failed)}` +
      (failed === 0 ? " — 全部通过" : `\n失败项：\n  ${failures.join("\n  ")}`) +
      `\n诚实边界：本冒烟是 CI/本机的自动化验证，不等价于负责人目标机的干净安装实测（B8）。\n`,
  );
  exitCode = failed === 0 ? 0 : 2;
} catch (err) {
  process.stdout.write(`\nsmoke-bundle: 异常中止（${section || "初始化"}）：${err instanceof Error ? err.message : String(err)}\n`);
  exitCode = 2;
} finally {
  if (!KEEP) {
    rmSync(WORK_DIR, { recursive: true, force: true });
  }
}
process.exit(exitCode);

/* ------------------------------------------------------------------ */

function readdirHasBackup(parent, bundleBaseName) {
  try {
    return readdirSync(parent).some((name) => name.startsWith(`${bundleBaseName}.backup-`));
  } catch {
    return false;
  }
}

async function waitFor(timeoutMs, predicate) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(500);
  }
  return predicate();
}
