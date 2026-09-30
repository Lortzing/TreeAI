/**
 * TreeAI D4-7 安装程序/跨平台 — 共享核心逻辑（纯函数 + 目录校验）。
 *
 * 本文件被三方共用，语义必须保持一致：
 *   - `scripts/d4/installer/launcher.ts` —— 打包进安装产物的运行时启动器
 *     （由产物内固定版本的 Node 经类型剥离直接执行，无任何 npm 依赖）；
 *   - `scripts/d4/package-installer.mjs` —— 构建侧（staging/校验）；
 *   - `scripts/d4/installer/smoke-bundle.mjs` / `test-macos-local.mjs` ——
 *     CI 冒烟与本地 macOS 实测驱动；
 *   - `tests/unit/d4-7-installer.test.ts` —— 单元测试。
 *
 * 纪律（issue #8 §5 安装程序/跨平台 + B8）：
 *   - 纯函数只做决策，不做 I/O；I/O 函数只做检查，不修状态；
 *   - 中文/空格路径必须全程可用（路径一律经 join/字面量拼接，绝不 shell 拼接）；
 *   - 默认监听 loopback（127.0.0.1），端口冲突自动顺延并明确告知用户；
 *   - 数据目录按平台规范（macOS ~/Library/Application Support/TreeAI、
 *     Windows %APPDATA%\TreeAI、Linux ~/.local/share/TreeAI）；
 *   - 升级/卸载默认保留用户数据；删除数据必须显式 opt-in。
 */

import { existsSync, lstatSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/* ------------------------------------------------------------------ */
/* 平台与产物布局                                                      */
/* ------------------------------------------------------------------ */

/** 支持矩阵（issue #8 §5）：首批仅这三个平台；其余架构不默认为已支持。 */
export type TargetPlatform = "darwin-arm64" | "win-x64" | "linux-x64";

export const TARGET_PLATFORMS: readonly TargetPlatform[] = [
  "darwin-arm64",
  "win-x64",
  "linux-x64",
];

export interface PlatformSpec {
  /** 产物平台标识（目录/压缩包命名用）。 */
  readonly target: TargetPlatform;
  /** nodejs.org 发行版的平台后缀（node-vX.Y.Z-<suffix>…）。 */
  readonly nodeDistSuffix: string;
  /** 发行版压缩包扩展（决定下载 URL 与解包方式）。 */
  readonly nodeDistExt: ".tar.gz" | ".tar.xz" | ".zip";
  /** 发行包内 node 可执行文件的相对路径。 */
  readonly nodeBinaryInDist: string;
  /** 产物内的 node 可执行文件相对路径（BUNDLE_ROOT 起）。 */
  readonly nodeBinaryInBundle: string;
  /** 当前平台是否为 POSIX 语义（信号/权限/自删除策略）。 */
  readonly posix: boolean;
}

export const PLATFORM_SPECS: Readonly<Record<TargetPlatform, PlatformSpec>> = {
  "darwin-arm64": {
    target: "darwin-arm64",
    nodeDistSuffix: "darwin-arm64",
    nodeDistExt: ".tar.gz",
    nodeBinaryInDist: "bin/node",
    nodeBinaryInBundle: join("node", "bin", "node"),
    posix: true,
  },
  "win-x64": {
    target: "win-x64",
    nodeDistSuffix: "win-x64",
    nodeDistExt: ".zip",
    nodeBinaryInDist: "node.exe",
    nodeBinaryInBundle: join("node", "node.exe"),
    posix: false,
  },
  "linux-x64": {
    target: "linux-x64",
    nodeDistSuffix: "linux-x64",
    nodeDistExt: ".tar.xz",
    nodeBinaryInDist: "bin/node",
    nodeBinaryInBundle: join("node", "bin", "node"),
    posix: true,
  },
};

/** 由构建机 process.platform/process.arch 判断当前主机是否等于目标平台。 */
export function hostMatchesTarget(
  hostPlatform: NodeJS.Platform,
  hostArch: string,
  target: TargetPlatform,
): boolean {
  if (target === "darwin-arm64") return hostPlatform === "darwin" && hostArch === "arm64";
  if (target === "win-x64") return hostPlatform === "win32" && hostArch === "x64";
  return hostPlatform === "linux" && hostArch === "x64";
}

/* ------------------------------------------------------------------ */
/* 平台数据目录 / 安装目录                                             */
/* ------------------------------------------------------------------ */

export const DATA_DIR_NAME = "TreeAI";
export const DATA_DIR_ENV = "TREEAI_DATA_DIR";

/**
 * 平台数据目录（issue #8 §5：平台数据目录为验收项）。
 * macOS ~/Library/Application Support/TreeAI；Windows %APPDATA%\TreeAI；
 * Linux ~/.local/share/TreeAI（尊重 XDG_DATA_HOME）。
 * `TREEAI_DATA_DIR` 环境变量恒为最高优先级（测试/多实例隔离用）。
 */
export function dataDirFor(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): string {
  const override = env[DATA_DIR_ENV];
  if (typeof override === "string" && override.trim() !== "") return override;
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", DATA_DIR_NAME);
  }
  if (platform === "win32") {
    const appData = env["APPDATA"];
    if (typeof appData === "string" && appData.trim() !== "") return join(appData, DATA_DIR_NAME);
    return join(home, "AppData", "Roaming", DATA_DIR_NAME);
  }
  const xdg = env["XDG_DATA_HOME"];
  if (typeof xdg === "string" && xdg.trim() !== "") return join(xdg, DATA_DIR_NAME);
  return join(home, ".local", "share", DATA_DIR_NAME);
}

/** 默认安装目录（升级流程的「旧安装」缺省定位；用户可自由选择其他目录）。 */
export function installRootFor(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): string {
  const override = env["TREEAI_INSTALL_ROOT"];
  if (typeof override === "string" && override.trim() !== "") return override;
  if (platform === "darwin") return join(home, "Applications", DATA_DIR_NAME);
  if (platform === "win32") {
    const localAppData = env["LOCALAPPDATA"];
    if (typeof localAppData === "string" && localAppData.trim() !== "") {
      return join(localAppData, "Programs", DATA_DIR_NAME);
    }
    return join(home, "AppData", "Local", "Programs", DATA_DIR_NAME);
  }
  return join(home, ".local", "opt", DATA_DIR_NAME);
}

/* ------------------------------------------------------------------ */
/* 启动器配置（数据目录内 config.json）                                */
/* ------------------------------------------------------------------ */

export const CONFIG_SCHEMA_VERSION = 1;
export const CONFIG_FILE_NAME = "config.json";
export const RUNTIME_STATE_FILE_NAME = "runtime.json";
export const DEFAULT_PORT = 8787;
export const PORT_SCAN_LIMIT = 50;
export const PI_API_KEY_ENV = "TREEAI_STUDIO_API_KEY";

export type LauncherDriver = "echo" | "pi";

export interface LauncherConfig {
  readonly schemaVersion: number;
  /** 缺省 8787；被占用时启动器自动顺延（见 portCandidates）。 */
  readonly port: number;
  /** 缺省 echo（离线确定性回声，无网络无凭据）；pi 需 provider/model+key。 */
  readonly driver: LauncherDriver;
  readonly provider?: string;
  readonly model?: string;
  readonly terminologyProvider?: string;
  readonly terminologyModel?: string;
  readonly terminologyBudgetTokens?: number;
  readonly noBrowser?: boolean;
}

export function defaultLauncherConfig(): LauncherConfig {
  return { schemaVersion: CONFIG_SCHEMA_VERSION, port: DEFAULT_PORT, driver: "echo" };
}

/**
 * 解析 config.json。返回 problems（人话，可直接展示）；config 仅在零问题时
 * 返回。损坏配置绝不静默回落缺省——那会把用户的模型配置伪装成 echo。
 */
export function parseLauncherConfig(text: string): { config: LauncherConfig | null; problems: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return {
      config: null,
      problems: [
        `config.json 不是合法 JSON（${err instanceof Error ? err.message : String(err)}）。` +
          "修复方法：编辑该文件纠正语法，或将其删除后重新 start（会生成默认离线配置）。",
      ],
    };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { config: null, problems: ["config.json 顶层必须是 JSON 对象。"] };
  }
  const record = raw as Record<string, unknown>;
  const config: LauncherConfig = {
    schemaVersion: typeof record["schemaVersion"] === "number" ? record["schemaVersion"] : CONFIG_SCHEMA_VERSION,
    port: typeof record["port"] === "number" ? record["port"] : DEFAULT_PORT,
    driver: record["driver"] === "pi" ? "pi" : "echo",
    ...(typeof record["provider"] === "string" ? { provider: record["provider"] } : {}),
    ...(typeof record["model"] === "string" ? { model: record["model"] } : {}),
    ...(typeof record["terminologyProvider"] === "string"
      ? { terminologyProvider: record["terminologyProvider"] }
      : {}),
    ...(typeof record["terminologyModel"] === "string" ? { terminologyModel: record["terminologyModel"] } : {}),
    ...(typeof record["terminologyBudgetTokens"] === "number"
      ? { terminologyBudgetTokens: record["terminologyBudgetTokens"] }
      : {}),
    ...(record["noBrowser"] === true ? { noBrowser: true } : {}),
  };
  return { config, problems: [] };
}

/**
 * 校验配置并给出可执行恢复信息（B8：模型配置错误有可执行恢复）。
 * 只报问题；问题的每一条都含「怎么修」。
 */
export function validateLauncherConfig(config: LauncherConfig): string[] {
  const problems: string[] = [];
  if (config.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    problems.push(
      `config.json 的 schemaVersion 是 ${String(config.schemaVersion)}，本版本只支持 ${String(CONFIG_SCHEMA_VERSION)}。` +
        "修复方法：删除 config.json 后重新 start（重新生成默认配置），再按 README 重新填写。",
    );
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    problems.push(
      `port 必须是 1–65535 的整数（当前 ${String(config.port)}）。` +
        `修复方法：编辑 config.json 把 port 改回 ${String(DEFAULT_PORT)}，或不写 port 使用默认值。`,
    );
  }
  if (config.driver === "pi") {
    if (typeof config.provider !== "string" || config.provider.trim() === "") {
      problems.push(
        "driver=pi 需要 provider（例如 anthropic）。修复方法：在 config.json 加 \"provider\": \"<你的 provider id>\"，" +
        "或先把 \"driver\" 改回 \"echo\"（离线回声模式，无需模型）。",
      );
    }
    if (typeof config.model !== "string" || config.model.trim() === "") {
      problems.push(
        "driver=pi 需要 model（例如 claude-sonnet-4-5）。修复方法：在 config.json 加 \"model\": \"<模型 id>\"," +
        "或先把 \"driver\" 改回 \"echo\"。",
      );
    }
    if (typeof config.terminologyBudgetTokens === "number" &&
      (!Number.isInteger(config.terminologyBudgetTokens) || config.terminologyBudgetTokens <= 0)) {
      problems.push("terminologyBudgetTokens 必须是正整数（或不写使用默认 1000000）。");
    }
  } else if (config.provider !== undefined || config.model !== undefined) {
    problems.push(
      "driver=echo 时不需要 provider/model（echo 是离线回声驱动）。" +
        '想用真实模型：把 "driver" 改为 "pi" 并补齐 provider/model。',
    );
  }
  return problems;
}

/** 由配置构造 studio 服务进程参数（apps/studio/src/cli.ts 的严格 flag 对）。 */
export function buildServerArgs(
  config: LauncherConfig,
  port: number,
  dataDir: string,
): string[] {
  const args: string[] = ["--port", String(port), "--data", dataDir];
  if (config.driver === "pi") {
    args.push("--driver", "pi", "--provider", config.provider ?? "", "--model", config.model ?? "");
    if (typeof config.terminologyProvider === "string" && config.terminologyProvider.trim() !== "") {
      args.push("--terminology-provider", config.terminologyProvider);
    }
    if (typeof config.terminologyModel === "string" && config.terminologyModel.trim() !== "") {
      args.push("--terminology-model", config.terminologyModel);
    }
    if (typeof config.terminologyBudgetTokens === "number") {
      args.push("--terminology-budget", String(config.terminologyBudgetTokens));
    }
  }
  return args;
}

/** 端口顺延候选：desired, desired+1, …（封顶 65535；供冲突恢复扫描）。 */
export function portCandidates(desired: number, limit: number = PORT_SCAN_LIMIT): number[] {
  const base = Number.isInteger(desired) && desired >= 1 ? desired : DEFAULT_PORT;
  const out: number[] = [];
  for (let i = 0; i < limit; i++) {
    const port = base + i;
    if (port > 65535) break;
    out.push(port);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 浏览器唤起（系统浏览器；打开的是 loopback URL）                     */
/* ------------------------------------------------------------------ */

export const NO_BROWSER_ENV = "TREEAI_LAUNCH_NO_BROWSER";
export const BROWSER_ENV = "TREEAI_BROWSER";

/**
 * 选择「打开 URL」的命令。`TREEAI_BROWSER`/`BROWSER` 环境变量优先
 * （按空格拆分为命令+参数，末尾追加 URL；测试用它替换成记录器脚本）；
 * 否则用平台缺省（darwin: open / win32: cmd start / 其他: xdg-open）。
 */
export function browserCommandFor(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
): { command: string; args: readonly string[] } | null {
  const override = env[BROWSER_ENV] ?? env["BROWSER"];
  if (typeof override === "string" && override.trim() !== "") {
    const parts = override.trim().split(/\s+/);
    const command = parts[0];
    if (command === undefined || command === "") return null;
    return { command, args: parts.slice(1) };
  }
  if (platform === "darwin") return { command: "open", args: [] };
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", ""] };
  return { command: "xdg-open", args: [] };
}

/* ------------------------------------------------------------------ */
/* Node 发行版下载（构建时从 nodejs.org 拉取固定版本；用户侧零编译）   */
/* ------------------------------------------------------------------ */

export const NODE_DIST_BASE_URL = "https://nodejs.org/dist";

export interface NodeDistSpec {
  readonly archiveName: string;
  readonly archiveUrl: string;
  readonly shasumsUrl: string;
  /** 发行包解开后，node 可执行文件在包目录内的相对路径。 */
  readonly binaryInArchive: string;
}

export function nodeDistFor(nodeVersion: string, platform: TargetPlatform): NodeDistSpec {
  const spec = PLATFORM_SPECS[platform];
  const distRootDir = `node-v${nodeVersion}-${spec.nodeDistSuffix}`;
  return {
    archiveName: `${distRootDir}${spec.nodeDistExt}`,
    archiveUrl: `${NODE_DIST_BASE_URL}/v${nodeVersion}/${distRootDir}${spec.nodeDistExt}`,
    shasumsUrl: `${NODE_DIST_BASE_URL}/v${nodeVersion}/SHASUMS256.txt`,
    binaryInArchive: join(distRootDir, spec.nodeBinaryInDist),
  };
}

/**
 * esbuild 平台二进制包名（pi-coding-agent 依赖树携带）。打包时只保留目标
 * 平台的包，其余平台的 @esbuild/* 会被裁剪（esbuild 主包运行时只 require
 * 当前平台的二进制包；裁剪记录进构建报告，不静默）。
 */
export const ESBUILD_PLATFORM_PACKAGE: Readonly<Record<TargetPlatform, string>> = {
  "darwin-arm64": "@esbuild/darwin-arm64",
  "win-x64": "@esbuild/win32-x64",
  "linux-x64": "@esbuild/linux-x64",
};

/* ------------------------------------------------------------------ */
/* 产物清单（VERSION.json）与产物布局校验                              */
/* ------------------------------------------------------------------ */

export const BUNDLE_MANIFEST_SCHEMA = "d4-installer-manifest-1";
export const MANIFEST_FILE_NAME = "VERSION.json";

export interface BundleManifest {
  readonly schemaVersion: string;
  readonly product: string;
  readonly bundleVersion: string;
  readonly platform: TargetPlatform;
  readonly node: {
    readonly version: string;
    readonly distFile: string;
    readonly distSha256: string;
  };
  readonly gitCommit: string;
  readonly gitDirty: boolean;
  readonly builtAt: string;
  readonly signing: {
    readonly codeSigning: "absent";
    readonly notarization: "absent";
    readonly note: string;
  };
}

export function validateBundleManifest(raw: unknown): { manifest: BundleManifest | null; problems: string[] } {
  const problems: string[] = [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { manifest: null, problems: ["VERSION.json 顶层必须是 JSON 对象"] };
  }
  const r = raw as Record<string, unknown>;
  const asString = (key: string): string | undefined => {
    const value = r[key];
    return typeof value === "string" ? value : undefined;
  };
  const schema = asString("schemaVersion");
  const product = asString("product");
  const bundleVersion = asString("bundleVersion");
  const platform = asString("platform");
  const gitCommit = asString("gitCommit");
  const builtAt = asString("builtAt");
  const node = r["node"];
  const signing = r["signing"];
  if (schema !== BUNDLE_MANIFEST_SCHEMA) {
    problems.push(`schemaVersion 必须是 ${BUNDLE_MANIFEST_SCHEMA}（当前 ${String(schema)}）`);
  }
  if (product === undefined) problems.push("缺少 product");
  if (bundleVersion === undefined || bundleVersion.trim() === "") problems.push("缺少 bundleVersion");
  if (platform === undefined || !TARGET_PLATFORMS.includes(platform as TargetPlatform)) {
    problems.push(`platform 必须是 ${TARGET_PLATFORMS.join(" / ")} 之一（当前 ${String(platform)}）`);
  }
  if (gitCommit === undefined || gitCommit.trim() === "") problems.push("缺少 gitCommit");
  if (builtAt === undefined) problems.push("缺少 builtAt");
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    problems.push("缺少 node 元数据（version/distFile/distSha256）");
  } else {
    const n = node as Record<string, unknown>;
    if (typeof n["version"] !== "string" || (n["version"] as string).trim() === "") problems.push("node.version 缺失");
    if (typeof n["distFile"] !== "string") problems.push("node.distFile 缺失");
    if (typeof n["distSha256"] !== "string" || !/^[0-9a-f]{64}$/.test(n["distSha256"] as string)) {
      problems.push("node.distSha256 必须是 64 位十六进制（nodejs.org 官方 SHASUMS256.txt 的值）");
    }
  }
  if (signing === null || typeof signing !== "object" || Array.isArray(signing)) {
    problems.push("缺少 signing 状态（必须如实记录未签名/未公证）");
  } else {
    const s = signing as Record<string, unknown>;
    if (s["codeSigning"] !== "absent" || s["notarization"] !== "absent") {
      problems.push("signing 必须如实为 absent（本仓无代码签名/公证证书，不得伪装）");
    }
  }
  if (problems.length > 0) return { manifest: null, problems };
  const m = raw as unknown as BundleManifest;
  return { manifest: m, problems: [] };
}

/** 产物内相对布局（staging 与 smoke 共用的真值）。 */
export const BUNDLE_LAYOUT = {
  appEntry: join("app", "apps", "studio", "src", "index.ts"),
  publicIndex: join("app", "apps", "studio", "public", "index.html"),
  studioPackageJson: join("app", "apps", "studio", "package.json"),
  workspacePackages: ["contracts", "event-journal", "persistence", "runtime-pi", "tool-policy"] as const,
  eventJournalDistEntry: join("app", "packages", "event-journal", "dist", "src", "index.js"),
  piSdkPackageJson: join("app", "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
  launcherEntry: join("launcher", "launcher.ts"),
  launcherCore: join("launcher", "core.ts"),
  readme: "README.md",
} as const;

/** 各平台产物必须携带的入口脚本（相对 BUNDLE_ROOT）。 */
export function requiredShimFiles(platform: TargetPlatform): readonly string[] {
  if (platform === "win-x64") {
    return ["treeai.ps1", "treeai.bat", "start.bat", "stop.bat", "restart.bat", "doctor.bat", "upgrade.bat", "uninstall.bat"];
  }
  const extension = platform === "darwin-arm64" ? "command" : "sh";
  return [
    "treeai.sh",
    `start.${extension}`,
    `stop.${extension}`,
    `restart.${extension}`,
    `doctor.${extension}`,
    `upgrade.${extension}`,
    `uninstall.${extension}`,
  ];
}

/**
 * 校验产物目录布局（构建后、解包后共用）。返回问题列表（空 = 通过）。
 * 显式检查 app/node_modules 内不存在符号链接（Windows zip 不保符号链接，
 * 打包时已把 workspace 链接物化为真实副本）。
 */
export function validateBundleLayout(bundleRoot: string, platform: TargetPlatform): string[] {
  const problems: string[] = [];
  const mustExist = (relPath: string, what: string): void => {
    if (!existsSync(join(bundleRoot, relPath))) problems.push(`缺少 ${what}：${relPath}`);
  };
  const spec = PLATFORM_SPECS[platform];
  mustExist(spec.nodeBinaryInBundle, "固定版本 node 可执行文件");
  mustExist(BUNDLE_LAYOUT.launcherEntry, "启动器");
  mustExist(BUNDLE_LAYOUT.launcherCore, "启动器核心");
  mustExist(BUNDLE_LAYOUT.appEntry, "studio 服务入口");
  mustExist(BUNDLE_LAYOUT.publicIndex, "studio 静态前端");
  mustExist(BUNDLE_LAYOUT.studioPackageJson, "studio package.json");
  mustExist(BUNDLE_LAYOUT.eventJournalDistEntry, "event-journal 预编译产物");
  mustExist(BUNDLE_LAYOUT.piSdkPackageJson, "Pi SDK npm 包");
  mustExist(BUNDLE_LAYOUT.readme, "README");
  mustExist(MANIFEST_FILE_NAME, "版本清单 VERSION.json");
  for (const pkg of BUNDLE_LAYOUT.workspacePackages) {
    mustExist(join("app", "packages", pkg, "package.json"), `workspace 包 ${pkg}`);
    mustExist(join("app", "packages", pkg, "src", "index.ts"), `workspace 包 ${pkg} 源码`);
    mustExist(join("app", "node_modules", "@treeai", pkg, "package.json"), `node_modules 内 ${pkg} 重导出桩`);
    mustExist(join("app", "node_modules", "@treeai", pkg, "index.js"), `node_modules 内 ${pkg} 桩入口`);
  }
  for (const shim of requiredShimFiles(platform)) {
    mustExist(shim, "平台入口脚本");
  }
  if (spec.posix) {
    const nodePath = join(bundleRoot, spec.nodeBinaryInBundle);
    if (existsSync(nodePath)) {
      try {
        if ((statSync(nodePath).mode & 0o111) === 0) problems.push("node 可执行文件没有执行位（打包时未 chmod +x）");
      } catch {
        problems.push(`无法读取 node 可执行文件权限：${spec.nodeBinaryInBundle}`);
      }
    }
  }
  const nodeModulesRoot = join(bundleRoot, "app", "node_modules");
  const symlinks: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isSymbolicLink()) {
        symlinks.push(full);
      }
    }
  };
  walk(nodeModulesRoot);
  for (const link of symlinks) {
    problems.push(`app/node_modules 内存在符号链接（Windows zip 会丢失）：${link}`);
  }
  return problems;
}

/* ------------------------------------------------------------------ */
/* 运行时状态文件（数据目录内 runtime.json）                           */
/* ------------------------------------------------------------------ */

export interface RuntimeState {
  readonly pid: number;
  readonly port: number;
  readonly url: string;
  readonly startedAt: string;
  readonly bundleVersion: string;
}

export function parseRuntimeState(text: string): RuntimeState | null {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (
      typeof raw["pid"] === "number" &&
      typeof raw["port"] === "number" &&
      typeof raw["url"] === "string" &&
      typeof raw["startedAt"] === "string" &&
      typeof raw["bundleVersion"] === "string"
    ) {
      return {
        pid: raw["pid"],
        port: raw["port"],
        url: raw["url"],
        startedAt: raw["startedAt"],
        bundleVersion: raw["bundleVersion"],
      };
    }
  } catch {
    return null;
  }
  return null;
}

/** 数据目录内固定文件名（启动器与测试共用）。 */
export const DATA_DIR_FILES = {
  config: CONFIG_FILE_NAME,
  runtimeState: RUNTIME_STATE_FILE_NAME,
  logsDir: "logs",
  studioLog: join("logs", "studio.log"),
  launcherLog: join("logs", "launcher.log"),
} as const;

/** 判断一个进程 pid 是否存活（POSIX 与 Windows 通用：process.kill(pid, 0)）。 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err !== null && typeof err === "object" && (err as { code?: string }).code === "EPERM";
  }
}

/** 目录可写探针（doctor 用）：写入并删除一个临时文件。 */
export function probeDirectoryWritable(dir: string): { ok: boolean; detail: string } {
  try {
    const probe = join(dir, `.treeai-write-probe-${String(process.pid)}-${String(Date.now())}`);
    writeFileSync(probe, "probe", { flag: "wx" });
    rmSync(probe, { force: true });
    return { ok: true, detail: "可写" };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** lstat 便捷导出（launcher/构建侧共用，避免重复 import 纪律漂移）。 */
export function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * tar 解包参数（构建 packager 与 packaged-bundle 冒烟共用）。
 *
 * 恒带 `--no-same-owner`（GNU/bsdtar 均支持）：rootless 容器（user-namespace
 * root，如本仓验收容器）里 tar 默认尝试恢复归档内 UID/GID，会在 nodejs.org
 * 发行包这类属主与当前用户不同的归档上失败退出（issue #8 增量验收 2026-09-30
 * P2 建议）。解出的文件一律重新 staging/校验，无人依赖保留的属主，关闭属主
 * 恢复在所有环境安全。压缩格式由后缀显式选择（.tar.xz/.tar.gz），其余（zip
 * 经 bsdtar 的兜底路径）交给 -xf 自动探测。
 */
export function tarExtractArgs(archivePath: string, intoDir: string): string[] {
  const flag = archivePath.endsWith(".tar.xz") ? "-xJf" : archivePath.endsWith(".tar.gz") ? "-xzf" : "-xf";
  return [flag, archivePath, "-C", intoDir, "--no-same-owner"];
}

/**
 * Windows 卸载自删除脚本（cmdUninstall 派发的分离 PowerShell 用；抽出为
 * 纯函数供单测锁定）。
 *
 * 背景（CI run 36747308856 win-x64 首次跑到卸载段）：安装目录内
 * app/node_modules 最深相对路径 179 字符，解压目录稍深即超 Windows
 * MAX_PATH 260——PowerShell 5.1 的 Remove-Item 无法删除长路径子项，
 * 30 次重试全部失败，卸载后目录残留。修复：先 robocopy 以空目录 /MIR
 * 镜像目标（robocopy 原生支持长路径，经典清场手法）把目录清空，再删除
 * 已空的短路径目录本身；循环重试等待 launcher 自身 node.exe 退出释放
 * 文件锁（运行中的 exe 所在目录不可删）。
 */
export function windowsSelfDeleteScript(bundleRoot: string): string {
  const target = bundleRoot.replace(/'/g, "''");
  return [
    `$target = '${target}'`,
    "$empty = Join-Path $env:TEMP ('treeai-uninst-' + [guid]::NewGuid().ToString('N'))",
    "[void](New-Item -ItemType Directory -Path $empty -Force)",
    "$done = $false",
    "for($i=0; $i -lt 30; $i++) {",
    "  [void](robocopy $empty $target /MIR /NFL /NDL /NJH /NJS /NP)",
    "  try { Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop; $done = $true; break } catch { Start-Sleep -Seconds 1 }",
    "}",
    "[void](Remove-Item -LiteralPath $empty -Recurse -Force)",
    "if (-not $done) { exit 1 }",
    "exit 0",
  ].join("\n");
}
