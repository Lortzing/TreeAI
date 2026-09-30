/**
 * TreeAI D4-7 — 安装产物运行时启动器（launcher）。
 *
 * 由产物内固定版本的 Node 直接执行（类型剥离，无 npm 依赖）：
 *   <产物>/node/bin/node  <产物>/launcher/launcher.ts  <子命令> [参数]
 *
 * 平台入口（start.command / start.sh / start.bat → treeai.ps1）只是本文件的
 * 薄封装。子命令：
 *
 *   start [--no-browser] [--port N]   启动/首次运行（健康检查后打开系统浏览器）
 *   stop                              停止（优雅 SIGTERM/taskkill，超时强杀）
 *   restart                           stop + start（透传 start 参数）
 *   status                            运行状态（exit 0 = 运行中）
 *   paths                             打印所有解析路径
 *   doctor                            诊断（配置错误给出可执行恢复信息）
 *   upgrade [--old DIR]               用本产物替换旧安装（数据保留；失败自动回滚）
 *   uninstall [--delete-data]         卸载安装目录；数据默认保留，显式 opt-in 才删
 *
 * 纪律（issue #8 §5）：
 *   - 默认只监听 127.0.0.1（loopback）；端口冲突自动顺延并明确告知；
 *   - 用户数据全部在平台数据目录（见 core.dataDirFor），安装目录可整体替换；
 *   - API key 只经 TREEAI_STUDIO_API_KEY 环境变量注入启动器 → 子进程环境，
 *     或交互式输入（不回显）；绝不写盘/日志；
 *   - 中文与空格路径全程可用（路径永不进 shell 字符串拼接）。
 */

import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { Socket } from "node:net";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BROWSER_ENV,
  DATA_DIR_FILES,
  DEFAULT_PORT,
  MANIFEST_FILE_NAME,
  NO_BROWSER_ENV,
  PI_API_KEY_ENV,
  type BundleManifest,
  type LauncherConfig,
  type RuntimeState,
  browserCommandFor,
  buildServerArgs,
  dataDirFor,
  defaultLauncherConfig,
  installRootFor,
  isPidAlive,
  parseLauncherConfig,
  parseRuntimeState,
  portCandidates,
  probeDirectoryWritable,
  validateBundleLayout,
  validateBundleManifest,
  validateLauncherConfig,
} from "./core.ts";

/* ------------------------------------------------------------------ */
/* 路径与常量                                                          */
/* ------------------------------------------------------------------ */

const BUNDLE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP_ENTRY = join(BUNDLE_ROOT, "app", "apps", "studio", "src", "index.ts");
const MANIFEST_PATH = join(BUNDLE_ROOT, MANIFEST_FILE_NAME);

const HEALTH_TIMEOUT_MS = 90_000;
const HEALTH_POLL_MS = 500;
const STOP_GRACE_MS = 30_000;
const EADDRINUSE_RETRIES = 3;

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function fail(message: string, code = 1): never {
  process.stderr.write(`treeai-launcher: 失败：${message}\n`);
  process.exit(code);
}

function dataDir(): string {
  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? ".";
  return dataDirFor(process.platform, process.env, home);
}

function configPath(): string {
  return join(dataDir(), DATA_DIR_FILES.config);
}

function runtimeStatePath(): string {
  return join(dataDir(), DATA_DIR_FILES.runtimeState);
}

function logLine(text: string): void {
  try {
    mkdirSync(join(dataDir(), "logs"), { recursive: true });
    appendFileSync(join(dataDir(), DATA_DIR_FILES.launcherLog), `${new Date().toISOString()} ${text}\n`);
  } catch {
    /* 日志失败不阻断主流程 */
  }
}

/* ------------------------------------------------------------------ */
/* 清单 / 配置 / 状态                                                  */
/* ------------------------------------------------------------------ */

/** 读产物清单；失败返回 problems（doctor 用），其余入口用 requireManifest。 */
function readManifest(): { manifest: BundleManifest | null; problems: string[] } {
  if (!existsSync(MANIFEST_PATH)) {
    return { manifest: null, problems: [`产物缺少 ${MANIFEST_FILE_NAME}（产物可能不完整，请重新下载/解压并核对 SHA256SUMS.txt）`] };
  }
  try {
    const raw: unknown = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
    return validateBundleManifest(raw);
  } catch (err) {
    return { manifest: null, problems: [`${MANIFEST_FILE_NAME} 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`] };
  }
}

function requireManifest(): BundleManifest {
  const { manifest, problems } = readManifest();
  if (manifest === null) fail(problems.join("；"));
  return manifest;
}

/** 读配置；缺失返回 null（调用方决定是否生成默认）。 */
function readConfig(): { config: LauncherConfig | null; problems: string[]; missing: boolean } {
  const path = configPath();
  if (!existsSync(path)) return { config: null, problems: [], missing: true };
  const { config, problems } = parseLauncherConfig(readFileSync(path, "utf8"));
  return { config, problems, missing: false };
}

function ensureDataDir(): string {
  const dir = dataDir();
  try {
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, "logs"), { recursive: true });
  } catch (err) {
    fail(`数据目录不可用（${dir}）：${err instanceof Error ? err.message : String(err)}`);
  }
  return dir;
}

function readRuntimeState(): RuntimeState | null {
  if (!existsSync(runtimeStatePath())) return null;
  return parseRuntimeState(readFileSync(runtimeStatePath(), "utf8"));
}

function writeRuntimeState(state: RuntimeState): void {
  writeFileSync(runtimeStatePath(), `${JSON.stringify(state, null, 2)}\n`);
}

function clearRuntimeState(): void {
  rmSync(runtimeStatePath(), { force: true });
}

/* ------------------------------------------------------------------ */
/* 网络 / 进程探针                                                     */
/* ------------------------------------------------------------------ */

async function healthOk(port: number, timeoutMs = 2_000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`http://127.0.0.1:${String(port)}/api/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: unknown };
    return body["ok"] === true;
  } catch {
    return false;
  }
}

/** 端口是否已被监听（连得上 = 占用）。 */
function portOccupied(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = new Socket();
    const done = (occupied: boolean): void => {
      socket.destroy();
      resolvePromise(occupied);
    };
    socket.setTimeout(800);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
    socket.connect(port, "127.0.0.1");
  });
}

/** 与已记录实例一致才操作（pid 复用保护：健康端点必须应答）。 */
async function recordedInstanceUsable(state: RuntimeState): Promise<boolean> {
  return isPidAlive(state.pid) && (await healthOk(state.port));
}

/* ------------------------------------------------------------------ */
/* 浏览器                                                             */
/* ------------------------------------------------------------------ */

function openBrowser(url: string, opts: { noBrowser: boolean }): void {
  if (opts.noBrowser || process.env[NO_BROWSER_ENV] === "1") {
    out(`treeai-launcher: 已按配置不打开浏览器：${url}`);
    return;
  }
  const command = browserCommandFor(process.platform, process.env);
  if (command === null) {
    out(`treeai-launcher: 未配置可用的浏览器打开命令（${BROWSER_ENV} 为空），请手动访问 ${url}`);
    return;
  }
  try {
    const child = spawn(command.command, [...command.args, url], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    out(`treeai-launcher: 已请求系统浏览器打开 ${url}`);
  } catch (err) {
    out(
      `treeai-launcher: 打开浏览器失败（${err instanceof Error ? err.message : String(err)}），请手动访问 ${url}`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* start                                                              */
/* ------------------------------------------------------------------ */

export interface StartOptions {
  readonly noBrowser: boolean;
  readonly portOverride: number | null;
  /** 升级流程内部复用时的探针启动：不额外多话。 */
  readonly quiet: boolean;
}

/** 交互式读取 API key（不回显；仅 TTY）。返回 null = 用户跳过。 */
async function promptApiKey(provider: string): Promise<string | null> {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) return null;
  process.stdout.write(
    `treeai-launcher: driver=pi 需要 API key（只注入本次进程内存，绝不写盘）。` +
      `请输入 ${provider} 的 API key（输入不回显；直接回车跳过）：\n`,
  );
  const muted = new Writable({
    write(_chunk, _encoding, callback): void {
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output: muted, terminal: true });
  try {
    const answer = await rl.question("");
    const trimmed = answer.trim();
    return trimmed === "" ? null : trimmed;
  } finally {
    rl.close();
  }
}

function readLogTail(path: string, bytes: number): string {
  try {
    const stat = statSync(path);
    const start = Math.max(0, stat.size - bytes);
    const buffer = Buffer.alloc(stat.size - start);
    const fd = openSync(path, "r");
    try {
      readSync(fd, buffer, 0, buffer.length, start);
      return buffer.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

async function startServer(
  config: LauncherConfig,
  opts: StartOptions,
): Promise<{ port: number; url: string; bundleVersion: string }> {
  ensureDataDir();
  const manifest = requireManifest();
  const desiredPort = opts.portOverride ?? config.port ?? DEFAULT_PORT;
  const studioLogPath = join(dataDir(), DATA_DIR_FILES.studioLog);

  const candidates = portCandidates(desiredPort);
  let attemptBase = 0;

  for (let attempt = 0; attempt < EADDRINUSE_RETRIES; attempt++) {
    /* 找第一个空闲候选端口；顺延必须告知用户。 */
    let port = candidates[attemptBase] ?? DEFAULT_PORT;
    let portAdvanced = false;
    while (await portOccupied(port)) {
      const next = candidates[attemptBase + 1];
      if (next === undefined) {
        fail(
          `端口 ${String(desiredPort)} 起的 ${String(candidates.length)} 个候选都被占用；` +
            `请编辑 ${configPath()} 换一个 port 后重试`,
        );
      }
      attemptBase += 1;
      port = next;
      portAdvanced = true;
    }
    if (portAdvanced && !opts.quiet) {
      out(
        `treeai-launcher: 端口 ${String(desiredPort)} 被占用，已自动改用 ${String(port)}` +
          `（固定端口请改 ${configPath()} 的 port 字段）`,
      );
    }

    /* pi 驱动的 API key：环境变量优先，交互式补输（不落盘）。 */
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    if (config.driver === "pi") {
      let key = process.env[PI_API_KEY_ENV];
      if (typeof key !== "string" || key.trim() === "") {
        const typed = await promptApiKey(config.provider ?? "");
        if (typed === null) {
          fail(
            `driver=pi 需要 API key：请设置环境变量 ${PI_API_KEY_ENV} 后重试` +
              `（Windows: set ${PI_API_KEY_ENV}=…；macOS/Linux: export ${PI_API_KEY_ENV}=…；` +
              "或在交互式终端运行 start 时按提示输入）",
          );
        }
        key = typed;
      }
      childEnv[PI_API_KEY_ENV] = key;
    }

    const logFd = openSync(studioLogPath, "a");
    appendFileSync(
      studioLogPath,
      `\n===== treeai-studio start ${new Date().toISOString()} (bundle ${manifest.bundleVersion}) =====\n`,
    );
    const child = spawn(process.execPath, [APP_ENTRY, ...buildServerArgs(config, port, dataDir())], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: childEnv,
      windowsHide: true,
    });
    closeSync(logFd); /* 子进程持有继承副本；父进程侧立即关闭 */
    const pid = child.pid;
    if (typeof pid !== "number") fail(`无法启动 studio 服务进程（spawn 失败：${APP_ENTRY}）`);

    /* 健康等待；进程早退 → 读日志尾部判断 EADDRINUSE 顺延重试。 */
    const startedAt = Date.now();
    let earlyExit = false;
    while (Date.now() - startedAt < HEALTH_TIMEOUT_MS) {
      if (!isPidAlive(pid)) {
        earlyExit = true;
        break;
      }
      if (await healthOk(port, 1_000)) {
        const url = `http://127.0.0.1:${String(port)}`;
        writeRuntimeState({
          pid,
          port,
          url,
          startedAt: new Date().toISOString(),
          bundleVersion: manifest.bundleVersion,
        });
        logLine(`start ok pid=${String(pid)} port=${String(port)} bundle=${manifest.bundleVersion}`);
        return { port, url, bundleVersion: manifest.bundleVersion };
      }
      await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
    }
    if (earlyExit) {
      const tail = readLogTail(studioLogPath, 4_000);
      if (/EADDRINUSE/.test(tail) && attempt + 1 < EADDRINUSE_RETRIES) {
        if (!opts.quiet) {
          out(
            `treeai-launcher: 端口 ${String(port)} 在启动瞬间被抢占（EADDRINUSE），自动改用下一候选端口重试…`,
          );
        }
        attemptBase += 1;
        continue;
      }
      fail(
        `studio 服务进程启动后很快退出（端口 ${String(port)}）。最近日志：\n${tail || "(无输出)"}` +
          `\n可运行 doctor 诊断；配置文件：${configPath()}`,
      );
    }
    fail(
      `等待服务健康检查超时（${String(HEALTH_TIMEOUT_MS / 1000)}s，端口 ${String(port)}）。` +
        `日志：${studioLogPath}`,
    );
  }
  /* 循环内所有路径都会 return/fail；兜底不可达但保持类型完整。 */
  fail("start 重试次数耗尽");
}

export function parseStartArgs(args: readonly string[]): { noBrowser: boolean; portOverride: number | null } {
  let noBrowser = false;
  let portOverride: number | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--no-browser") {
      noBrowser = true;
    } else if (arg === "--port") {
      const value = args[i + 1];
      if (value === undefined) fail("--port 需要一个端口号");
      portOverride = Number(value);
      i += 1;
    } else {
      fail(`start 不认识的参数：${arg}（可用：--no-browser、--port N）`);
    }
  }
  return { noBrowser, portOverride };
}

async function cmdStart(args: readonly string[]): Promise<number> {
  const { noBrowser, portOverride } = parseStartArgs(args);
  ensureDataDir();

  const { config, problems, missing } = readConfig();
  let effective: LauncherConfig;
  if (missing) {
    effective = defaultLauncherConfig();
    writeFileSync(configPath(), `${JSON.stringify(effective, null, 2)}\n`);
    out(`treeai-launcher: 首次运行，已生成默认离线配置 ${configPath()}（driver=echo，无需模型）`);
  } else if (config === null) {
    fail(`配置文件损坏：${configPath()}\n${problems.join("\n")}\n修复后重试，或删除该文件重新 start。`);
  } else {
    const validation = validateLauncherConfig(config);
    if (validation.length > 0) {
      fail(`配置校验未通过（${configPath()}）：\n${validation.join("\n")}\n可运行 doctor 查看逐项诊断。`);
    }
    effective = config;
  }

  /* 已在运行：幂等 start 只开浏览器。 */
  const state = readRuntimeState();
  if (state !== null && (await recordedInstanceUsable(state))) {
    out(
      `treeai-launcher: 已在运行 ${state.url}（bundle ${state.bundleVersion}，pid ${String(state.pid)}）`,
    );
    openBrowser(state.url, { noBrowser });
    return 0;
  }
  clearRuntimeState();

  const { port, url, bundleVersion } = await startServer(effective, {
    noBrowser,
    portOverride,
    quiet: false,
  });
  out(`treeai-launcher: 已启动 ${url}（bundle ${bundleVersion}，端口 ${String(port)}）`);
  out(`treeai-launcher: url=${url}`);
  out(`treeai-launcher: 数据目录 ${dataDir()}；停止用 stop；诊断用 doctor`);
  openBrowser(url, { noBrowser });
  return 0;
}

/* ------------------------------------------------------------------ */
/* stop / restart / status / paths                                     */
/* ------------------------------------------------------------------ */

async function stopInstance(reason: string): Promise<boolean> {
  const state = readRuntimeState();
  if (state === null) return false;
  if (!(await recordedInstanceUsable(state))) {
    clearRuntimeState();
    return false;
  }
  if (process.platform === "win32") {
    /* Windows 无跨进程 SIGTERM：先 taskkill（树内），等待后强制。 */
    spawnSync("taskkill", ["/PID", String(state.pid), "/T"], { stdio: "ignore", windowsHide: true });
    const deadline = Date.now() + STOP_GRACE_MS;
    while (isPidAlive(state.pid) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300));
    }
    if (isPidAlive(state.pid)) {
      spawnSync("taskkill", ["/PID", String(state.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      const hardDeadline = Date.now() + 10_000;
      while (isPidAlive(state.pid) && Date.now() < hardDeadline) {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  } else {
    try {
      process.kill(state.pid, "SIGTERM");
    } catch {
      /* 已退出 */
    }
    const deadline = Date.now() + STOP_GRACE_MS;
    while (isPidAlive(state.pid) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300));
    }
    if (isPidAlive(state.pid)) {
      process.kill(state.pid, "SIGKILL");
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
  const stopped = !(await healthOk(state.port, 1_000));
  clearRuntimeState();
  logLine(`stop (${reason}) pid=${String(state.pid)} port=${String(state.port)} clean=${String(stopped)}`);
  return stopped;
}

async function cmdStop(): Promise<number> {
  ensureDataDir();
  const wasRunning = await stopInstance("stop");
  out(wasRunning ? "treeai-launcher: 已停止" : "treeai-launcher: 当前没有在运行（无需停止）");
  return 0;
}

async function cmdRestart(args: readonly string[]): Promise<number> {
  await cmdStop();
  return cmdStart(args);
}

async function cmdStatus(): Promise<number> {
  const state = readRuntimeState();
  if (state === null) {
    out("treeai-launcher: running=false");
    out("treeai-launcher: 未在运行");
    return 1;
  }
  const running = await recordedInstanceUsable(state);
  out(`treeai-launcher: running=${String(running)}`);
  if (running) {
    out(
      `treeai-launcher: 运行中 ${state.url}（bundle ${state.bundleVersion}，pid ${String(state.pid)}，启动于 ${state.startedAt}）`,
    );
  } else {
    out(`treeai-launcher: 未在运行（发现过期状态记录 pid ${String(state.pid)}，已忽略）`);
    clearRuntimeState();
  }
  return running ? 0 : 1;
}

async function cmdPaths(): Promise<number> {
  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? ".";
  out(`treeai-launcher: bundle=${BUNDLE_ROOT}`);
  out(`treeai-launcher: data=${dataDir()}`);
  out(`treeai-launcher: config=${configPath()}`);
  out(`treeai-launcher: studio-log=${join(dataDir(), DATA_DIR_FILES.studioLog)}`);
  out(`treeai-launcher: install-root-default=${installRootFor(process.platform, process.env, home)}`);
  out(`treeai-launcher: node=${process.execPath} (${process.version})`);
  return 0;
}

/* ------------------------------------------------------------------ */
/* doctor                                                             */
/* ------------------------------------------------------------------ */

async function cmdDoctor(): Promise<number> {
  let failures = 0;
  const problem = (text: string): void => {
    failures += 1;
    out(`  ✗ ${text}`);
  };
  const fine = (text: string): void => {
    out(`  ✓ ${text}`);
  };
  const warn = (text: string): void => {
    out(`  ! ${text}`);
  };

  out("treeai-launcher: doctor — D4-7 诊断");

  /* 1. 产物清单与布局 */
  const { manifest, problems: manifestProblems } = readManifest();
  if (manifest === null) {
    for (const p of manifestProblems) problem(p);
  } else {
    fine(
      `产物清单：bundle ${manifest.bundleVersion}，平台 ${manifest.platform}，Node ${manifest.node.version}（git ${manifest.gitCommit.slice(0, 12)}）`,
    );
    const layoutProblems = validateBundleLayout(BUNDLE_ROOT, manifest.platform);
    if (layoutProblems.length === 0) {
      fine("产物布局完整（node/launcher/app/入口脚本/静态前端/预编译依赖）");
    } else {
      for (const p of layoutProblems) problem(p);
    }
    /* 2. 内置 Node 与清单一致 */
    const versionProbe = spawnSync(process.execPath, ["--version"], { encoding: "utf8", windowsHide: true });
    const reported = versionProbe.status === 0 ? (versionProbe.stdout ?? "").trim() : "";
    if (reported === `v${manifest.node.version}`) {
      fine(`内置 Node 运行时正常（${reported}）`);
    } else {
      problem(
        `内置 Node 版本异常：期望 v${manifest.node.version}，实测 ${reported || "(无法执行)"}；` +
          "请重新下载安装包并核对 SHA256SUMS.txt",
      );
    }
  }

  /* 3. 数据目录可写 */
  const dir = dataDir();
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    problem(`数据目录创建失败（${dir}）：${err instanceof Error ? err.message : String(err)}`);
  }
  const probe = probeDirectoryWritable(dir);
  if (probe.ok) {
    fine(`数据目录可写（${dir}）`);
  } else {
    problem(
      `数据目录不可写（${dir}）：${probe.detail}。修复：检查磁盘与权限，` +
        "或用 TREEAI_DATA_DIR 环境变量指定其他目录后重试",
    );
  }

  /* 4. 配置（错误必须给出可执行恢复信息） */
  const { config, problems, missing } = readConfig();
  if (missing) {
    warn(`尚未创建配置（首次 start 会生成默认离线配置于 ${configPath()}）`);
  } else if (config === null) {
    for (const p of problems) problem(p);
  } else {
    const validation = validateLauncherConfig(config);
    if (validation.length === 0) {
      fine(
        config.driver === "echo"
          ? `配置有效（driver=echo 离线回声，端口 ${String(config.port)}）`
          : `配置有效（driver=pi，provider=${config.provider ?? "?"}，model=${config.model ?? "?"}，端口 ${String(config.port)}）`,
      );
      /* 5. pi 凭据就绪度（非交互且缺 key = start 会失败） */
      if (config.driver === "pi" && typeof process.env[PI_API_KEY_ENV] !== "string") {
        const interactive = process.stdin.isTTY === true;
        const hint =
          `driver=pi 但环境变量 ${PI_API_KEY_ENV} 未设置。` +
          (interactive
            ? "交互式 start 会提示输入（不回显、不落盘）；也可先在终端设置该变量。"
            : "非交互环境下无法提示输入，start 会失败：请先设置该环境变量再启动。");
        if (interactive) warn(hint);
        else problem(hint);
      }
    } else {
      for (const p of validation) problem(`配置（${configPath()}）：${p}`);
    }
  }

  /* 6. 端口状态 */
  const desiredPort = config?.port ?? DEFAULT_PORT;
  const state = readRuntimeState();
  if (state !== null && (await recordedInstanceUsable(state))) {
    fine(`已在运行 ${state.url}（换端口：stop 后改 ${configPath()} 再 start）`);
  } else if (await portOccupied(desiredPort)) {
    warn(
      `端口 ${String(desiredPort)} 被其他程序占用：start 会自动顺延到下一个可用端口并在输出中告知；` +
        `固定端口请改 ${configPath()} 的 port 字段`,
    );
  } else {
    fine(`端口 ${String(desiredPort)} 空闲`);
  }

  out("");
  if (failures === 0) {
    out("treeai-launcher: doctor 结论：全部通过（! 警告不影响启动）");
    return 0;
  }
  out(`treeai-launcher: doctor 结论：发现 ${String(failures)} 个问题（上面每条 ✗ 都附带了修复方法）`);
  return 1;
}

/* ------------------------------------------------------------------ */
/* upgrade                                                            */
/* ------------------------------------------------------------------ */

function copyDir(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory()) {
      copyDir(src, dst);
    } else if (entry.isSymbolicLink()) {
      /* 产物内不应有符号链接（构建时已物化）；如遇则如实失败。 */
      throw new Error(`产物内发现符号链接（不应存在）：${src}`);
    } else {
      copyFileSync(src, dst);
    }
  }
}

async function cmdUpgrade(args: readonly string[]): Promise<number> {
  let oldDir: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--old") {
      const value = args[i + 1];
      if (value === undefined) fail("--old 需要一个目录路径");
      oldDir = value;
      i += 1;
    } else {
      fail(`upgrade 不认识的参数：${arg}（可用：--old <旧安装目录>）`);
    }
  }
  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? ".";
  const defaultOld = installRootFor(process.platform, process.env, home);
  const oldInstall = resolve(oldDir ?? defaultOld);
  if (!existsSync(join(oldInstall, MANIFEST_FILE_NAME))) {
    fail(
      `旧安装目录不存在或不是 TreeAI 安装（${oldInstall}）。` +
        "修复：运行 upgrade --old <旧安装目录> 指明旧安装；" +
        "也可以直接把本目录当作新安装使用（用户数据在数据目录，不受安装位置影响）。",
    );
  }

  const newManifest = requireManifest();
  const oldRaw = JSON.parse(readFileSync(join(oldInstall, MANIFEST_FILE_NAME), "utf8")) as {
    bundleVersion?: unknown;
  };
  const oldVersion = typeof oldRaw["bundleVersion"] === "string" ? oldRaw["bundleVersion"] : "?";
  out(`treeai-launcher: 升级 ${oldVersion} → ${newManifest.bundleVersion}（安装目录 ${oldInstall}）`);

  /* 1. 停止旧实例（数据目录跨版本共享）。 */
  await stopInstance("upgrade");

  /* 2. 备份旧安装 → 3. 放置新版本；任一步失败即恢复备份。 */
  const backup = `${oldInstall}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try {
    if (!statSync(oldInstall).isDirectory()) {
      throw new Error(`旧安装不是目录：${oldInstall}`);
    }
    rmSync(backup, { recursive: true, force: true });
    renameSync(oldInstall, backup);
    copyDir(BUNDLE_ROOT, oldInstall);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    rmSync(oldInstall, { recursive: true, force: true });
    if (existsSync(backup)) {
      try {
        renameSync(backup, oldInstall);
      } catch {
        /* 恢复失败是极端情况：如实报告备份位置。 */
      }
    }
    fail(
      `升级失败（放置新版本出错）：${message}；旧安装已尽量恢复（备份在 ${backup}）。` +
        `数据目录未受影响（${dataDir()}）`,
    );
  }

  /* 4. 启动新版本做健康验证（通过才算升级成功；失败自动回滚）。 */
  const newLauncher = join(oldInstall, "launcher", "launcher.ts");
  const probe = spawnSync(process.execPath, [newLauncher, "start", "--no-browser"], {
    encoding: "utf8",
    timeout: 180_000,
    windowsHide: true,
    env: { ...process.env, [NO_BROWSER_ENV]: "1" },
  });
  const probeText = `${probe.stdout ?? ""}\n${probe.stderr ?? ""}`;
  if (probe.status !== 0 || !/url=http:\/\/127\.0\.0\.1:\d+/.test(probeText)) {
    rmSync(oldInstall, { recursive: true, force: true });
    renameSync(backup, oldInstall);
    out("treeai-launcher: 新版本健康检查未通过，已回滚到旧版本。新版本输出：");
    out(probeText.trim() || "(无输出)");
    fail(
      `升级失败已回滚（旧版本 ${oldVersion} 已恢复）。数据目录未受影响（${dataDir()}）。` +
        "请把上面的输出反馈给开发者。",
    );
  }

  out(
    `treeai-launcher: 升级成功：${newManifest.bundleVersion} 已启动并通过健康检查（旧版本备份：${backup}）`,
  );
  out(`treeai-launcher: 用户数据未做任何改动：${dataDir()}`);
  const urlMatch = /url=(http:\/\/127\.0\.0\.1:\d+)/.exec(probeText);
  if (urlMatch !== null) {
    out(`treeai-launcher: url=${urlMatch[1]}`);
    openBrowser(urlMatch[1]!, { noBrowser: false });
  } else {
    fail("升级成功但无法解析新实例 URL（内部探针输出异常）——请运行 doctor 检查");
  }
  logLine(`upgrade ${oldVersion} -> ${newManifest.bundleVersion} ok`);
  return 0;
}

/* ------------------------------------------------------------------ */
/* uninstall                                                          */
/* ------------------------------------------------------------------ */

async function cmdUninstall(args: readonly string[]): Promise<number> {
  let deleteData = false;
  for (const arg of args) {
    if (arg === "--delete-data") deleteData = true;
    else fail(`uninstall 不认识的参数：${arg}（可用：--delete-data）`);
  }
  await stopInstance("uninstall");

  const dir = dataDir();
  if (deleteData) {
    if (process.stdin.isTTY === true) {
      process.stdout.write(
        `即将删除全部用户数据（${dir}，包含树、材料、批注与运行记录）。输入 yes 确认删除，其他任意输入保留：\n`,
      );
      const rl = createInterface({ input: process.stdin });
      try {
        const answer = (await rl.question("")).trim();
        if (answer !== "yes") {
          deleteData = false;
          out("treeai-launcher: 已改为保留数据。");
        }
      } finally {
        rl.close();
      }
    }
    if (deleteData) {
      /* 先记日志再删目录：logLine 会重建 logs/ 子目录，顺序颠倒会把刚删的
         数据目录又建出来（冒烟已抓到过这个回归）。 */
      logLine(`uninstall delete-data ${dir}`);
      rmSync(dir, { recursive: true, force: true });
      out(`treeai-launcher: 已删除数据目录 ${dir}`);
    } else {
      logLine("uninstall keep-data");
      out(
        `treeai-launcher: 用户数据已保留：${dir}（重新安装任意版本即可继续使用；确认不要了可手动删除该目录）`,
      );
    }
  } else {
    logLine("uninstall keep-data (default)");
    out(
      `treeai-launcher: 用户数据已保留：${dir}（重新安装任意版本即可继续使用；确认不要了可手动删除该目录）`,
    );
  }

  /* 自删除：POSIX 直接删（脚本已读入内存）；Windows 上 node.exe 正在本目录
     运行、文件被锁，先退出进程再由分离的 PowerShell 延迟删除。 */
  if (process.platform === "win32") {
    const script =
      `for($i=0; $i -lt 30; $i++) { ` +
      `try { Remove-Item -LiteralPath '${BUNDLE_ROOT.replace(/'/g, "''")}' -Recurse -Force -ErrorAction Stop; exit 0 } ` +
      `catch { Start-Sleep -Seconds 1 } }; exit 1`;
    const child = spawn("powershell", ["-NoProfile", "-Command", script], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    out(`treeai-launcher: 安装目录删除已排队（Windows 需等本进程退出后完成）：${BUNDLE_ROOT}`);
  } else {
    rmSync(BUNDLE_ROOT, { recursive: true, force: true });
    out(`treeai-launcher: 已删除安装目录 ${BUNDLE_ROOT}`);
  }
  /* 不再 logLine：--delete-data 后数据目录已删除，写日志会把它重建出来。 */
  return 0;
}

/* ------------------------------------------------------------------ */
/* main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0] ?? "start";
  const rest = argv.slice(1);
  switch (command) {
    case "start":
      return cmdStart(rest);
    case "stop":
      return cmdStop();
    case "restart":
      return cmdRestart(rest);
    case "status":
      return cmdStatus();
    case "paths":
      return cmdPaths();
    case "doctor":
      return cmdDoctor();
    case "upgrade":
      return cmdUpgrade(rest);
    case "uninstall":
      return cmdUninstall(rest);
    case "--help":
    case "-h":
    case "help":
      out(
        "用法：launcher <start|stop|restart|status|paths|doctor|upgrade|uninstall> [参数]\n" +
          "  start [--no-browser] [--port N]   启动/首次运行（健康检查后打开浏览器）\n" +
          "  stop / restart / status / paths / doctor\n" +
          "  upgrade [--old DIR]                升级替换旧安装（数据保留，失败自动回滚）\n" +
          "  uninstall [--delete-data]          卸载（默认保留数据）",
      );
      return 0;
    default:
      fail(`未知子命令：${command}（--help 查看用法）`);
  }
}

const exitCode = await main();
process.exit(exitCode);
