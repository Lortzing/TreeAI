import { createLauncherMaintenance } from "./commands/maintenance.ts";
import { createLauncherDiagnostics } from "./commands/diagnostics.ts";
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
import { tmpdir } from "node:os";
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
  windowsSelfDeleteScript,
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
const launcherDiagnostics = createLauncherDiagnostics({
  get out() { return out; },
  get BUNDLE_ROOT() { return BUNDLE_ROOT; },
  get dataDir() { return dataDir; },
  get configPath() { return configPath; },
  get readManifest() { return readManifest; },
  get readConfig() { return readConfig; },
  get readRuntimeState() { return readRuntimeState; },
  get recordedInstanceUsable() { return recordedInstanceUsable; },
  get portOccupied() { return portOccupied; },
});
const { cmdPaths, cmdDoctor } = launcherDiagnostics;
const launcherMaintenance = createLauncherMaintenance({
  get fail() { return fail; },
  get requireManifest() { return requireManifest; },
  get out() { return out; },
  get stopInstance() { return stopInstance; },
  get BUNDLE_ROOT() { return BUNDLE_ROOT; },
  get dataDir() { return dataDir; },
  get openBrowser() { return openBrowser; },
  get logLine() { return logLine; },
});
const { cmdUpgrade, cmdUninstall } = launcherMaintenance;


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
