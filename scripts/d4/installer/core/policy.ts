/** policy ownership for core.ts; compatibility entrypoint remains one level above. */
import type {
  PlatformSpec,
  TargetPlatform,
} from "./model.ts";
import {
  join,
} from "node:path";

export const TARGET_PLATFORMS: readonly TargetPlatform[] = [
  "darwin-arm64",
  "win-x64",
  "linux-x64",
];

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

/* ------------------------------------------------------------------ */
/* 平台数据目录 / 安装目录                                             */
/* ------------------------------------------------------------------ */

export const DATA_DIR_NAME = "TreeAI";


export const DATA_DIR_ENV = "TREEAI_DATA_DIR";

/* ------------------------------------------------------------------ */
/* 启动器配置（数据目录内 config.json）                                */
/* ------------------------------------------------------------------ */

export const CONFIG_SCHEMA_VERSION = 1;


export const CONFIG_FILE_NAME = "config.json";


export const RUNTIME_STATE_FILE_NAME = "runtime.json";


export const DEFAULT_PORT = 8787;


export const PORT_SCAN_LIMIT = 50;


export const PI_API_KEY_ENV = "TREEAI_STUDIO_API_KEY";

/* ------------------------------------------------------------------ */
/* 浏览器唤起（系统浏览器；打开的是 loopback URL）                     */
/* ------------------------------------------------------------------ */

export const NO_BROWSER_ENV = "TREEAI_LAUNCH_NO_BROWSER";


export const BROWSER_ENV = "TREEAI_BROWSER";

/* ------------------------------------------------------------------ */
/* Node 发行版下载（构建时从 nodejs.org 拉取固定版本；用户侧零编译）   */
/* ------------------------------------------------------------------ */

export const NODE_DIST_BASE_URL = "https://nodejs.org/dist";

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

/** 产物内相对布局（staging 与 smoke 共用的真值）。 */
export const BUNDLE_LAYOUT = {
  appEntry: join("app", "apps", "studio", "src", "index.ts"),
  publicIndex: join("app", "apps", "studio", "public", "index.html"),
  studioPackageJson: join("app", "apps", "studio", "package.json"),
  workspacePackages: ["contracts", "event-journal", "persistence", "runtime-pi", "tool-policy"] as const,
  eventJournalDistEntry: join("app", "packages", "event-journal", "dist", "src", "index.js"),
  piSdkPackageJson: join("app", "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
  pdfjsMain: join("app", "node_modules", "pdfjs-dist", "build", "pdf.mjs"),
  pdfjsWorker: join("app", "node_modules", "pdfjs-dist", "build", "pdf.worker.mjs"),
  pdfjsCmaps: join("app", "node_modules", "pdfjs-dist", "cmaps"),
  pdfjsStandardFonts: join("app", "node_modules", "pdfjs-dist", "standard_fonts"),
  launcherEntry: join("launcher", "launcher.ts"),
  launcherCore: join("launcher", "core.ts"),
  launcherCoreModel: join("launcher", "core", "model.ts"),
  launcherCorePolicy: join("launcher", "core", "policy.ts"),
  launcherCorePlatform: join("launcher", "core", "platform.ts"),
  launcherCoreConfiguration: join("launcher", "core", "configuration.ts"),
  launcherCoreShell: join("launcher", "core", "shell.ts"),
  launcherCoreBundle: join("launcher", "core", "bundle.ts"),
  launcherDiagnostics: join("launcher", "commands", "diagnostics.ts"),
  launcherMaintenance: join("launcher", "commands", "maintenance.ts"),
  launcherCoreRuntime: join("launcher", "core", "runtime.ts"),

  readme: "README.md",
} as const;

/** 数据目录内固定文件名（启动器与测试共用）。 */
export const DATA_DIR_FILES = {
  config: CONFIG_FILE_NAME,
  runtimeState: RUNTIME_STATE_FILE_NAME,
  logsDir: "logs",
  studioLog: join("logs", "studio.log"),
  launcherLog: join("logs", "launcher.log"),
} as const;
