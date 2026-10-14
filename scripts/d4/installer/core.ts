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

/** Stable public installer core entrypoint. */
export type {
  TargetPlatform,
  PlatformSpec,
  LauncherDriver,
  LauncherConfig,
  NodeDistSpec,
  BundleManifest,
  RuntimeState,
} from "./core/model.ts";
export {
  TARGET_PLATFORMS,
  PLATFORM_SPECS,
  DATA_DIR_NAME,
  DATA_DIR_ENV,
  CONFIG_SCHEMA_VERSION,
  CONFIG_FILE_NAME,
  RUNTIME_STATE_FILE_NAME,
  DEFAULT_PORT,
  PORT_SCAN_LIMIT,
  PI_API_KEY_ENV,
  NO_BROWSER_ENV,
  BROWSER_ENV,
  NODE_DIST_BASE_URL,
  ESBUILD_PLATFORM_PACKAGE,
  BUNDLE_MANIFEST_SCHEMA,
  MANIFEST_FILE_NAME,
  BUNDLE_LAYOUT,
  DATA_DIR_FILES,
} from "./core/policy.ts";
export {
  hostMatchesTarget,
  dataDirFor,
  installRootFor,
  nodeDistFor,
  tarExtractArgs,
} from "./core/platform.ts";
export {
  defaultLauncherConfig,
  parseLauncherConfig,
  validateLauncherConfig,
  buildServerArgs,
  portCandidates,
} from "./core/configuration.ts";
export {
  browserCommandFor,
  windowsSelfDeleteScript,
} from "./core/shell.ts";
export {
  validateBundleManifest,
  requiredShimFiles,
  validateBundleLayout,
} from "./core/bundle.ts";
export {
  parseRuntimeState,
  isPidAlive,
  probeDirectoryWritable,
  isSymlink,
} from "./core/runtime.ts";
