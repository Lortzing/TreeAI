/**
 * D4-7 安装程序/跨平台单元测试（issue #8 §5 / B8 的纯逻辑层）。
 *
 * 被测对象是 scripts/d4/installer/core.ts——构建脚本（package-installer.mjs）、
 * 产物内启动器（launcher.ts）、CI 冒烟（smoke-bundle.mjs）与本地实测
 * （test-macos-local.mjs）共用的决策核心。启动器/构建的 I/O 流程由
 * CI 冒烟与 macOS 本机实测覆盖（evidence/d4/d4-7/），这里只锁纯函数语义：
 *
 *   - 平台数据目录/安装目录解析（含环境变量优先级与 XDG）；
 *   - config.json 解析与校验（配置错误必须给出可执行恢复信息）；
 *   - 服务进程参数构造（cli.ts 严格 flag 对契约）；
 *   - 端口顺延候选；
 *   - 浏览器唤起命令选择（含 BROWSER/TREEAI_BROWSER 覆盖）；
 *   - Node 官方发行包 URL 与 esbuild 平台包名；
 *   - VERSION.json 清单校验（签名状态必须如实为 absent）；
 *   - 产物布局校验（合成最小产物：缺件必须报、齐件必须过、符号链接必须报）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BUNDLE_MANIFEST_SCHEMA,
  CONFIG_FILE_NAME,
  DATA_DIR_ENV,
  DEFAULT_PORT,
  ESBUILD_PLATFORM_PACKAGE,
  MANIFEST_FILE_NAME,
  PI_API_KEY_ENV,
  buildServerArgs,
  browserCommandFor,
  dataDirFor,
  defaultLauncherConfig,
  installRootFor,
  nodeDistFor,
  parseLauncherConfig,
  parseRuntimeState,
  portCandidates,
  requiredShimFiles,
  tarExtractArgs,
  validateBundleLayout,
  validateBundleManifest,
  validateLauncherConfig,
} from "../../scripts/d4/installer/core.ts";

/* launcher.ts 是自执行入口（import 即运行），不能在测试里做值导入；
   用 type-only 导入把它和 shims.ts 纳入 tests-typecheck 的覆盖
   （类型层完全编译检查、运行时零副作用）。 */
import type { StartOptions as LauncherStartOptions } from "../../scripts/d4/installer/launcher.ts";
import type * as shimsModule from "../../scripts/d4/installer/shims.ts";

type ShimsExports = typeof shimsModule;

/* ------------------------------------------------------------------ */
/* 平台数据目录 / 安装目录                                             */
/* ------------------------------------------------------------------ */

/* 假 home 路径按仓内纪律拼接构造（secret-scanner 的 home-path 规则扫描
   源文件本身；tests/unit/secret-scanner.test.ts 同款做法）。 */
const MAC_HOME = "/Users/" + "tester";
const NIX_HOME = "/home/" + "t";
const WIN_HOME = "C:\\Users\\" + "t";

test("dataDirFor: macOS 平台目录（无覆盖时）", () => {
  assert.equal(dataDirFor("darwin", {}, MAC_HOME), `${MAC_HOME}/Library/Application Support/TreeAI`);
});

test("dataDirFor: Windows 尊重 APPDATA", () => {
  assert.equal(
    dataDirFor("win32", { APPDATA: `${WIN_HOME}\\AppData\\Roaming` }, WIN_HOME),
    join(`${WIN_HOME}\\AppData\\Roaming`, "TreeAI"),
  );
  /* APPDATA 缺失时退回 home 下的规范路径。 */
  assert.equal(dataDirFor("win32", {}, WIN_HOME), join(WIN_HOME, "AppData", "Roaming", "TreeAI"));
});

test("dataDirFor: Linux 尊重 XDG_DATA_HOME，默认 ~/.local/share", () => {
  assert.equal(dataDirFor("linux", {}, NIX_HOME), `${NIX_HOME}/.local/share/TreeAI`);
  assert.equal(dataDirFor("linux", { XDG_DATA_HOME: `${NIX_HOME}/xdg` }, NIX_HOME), `${NIX_HOME}/xdg/TreeAI`);
});

test(`dataDirFor: ${DATA_DIR_ENV} 覆盖一切平台缺省（测试/多实例隔离）`, () => {
  for (const platform of ["darwin", "win32", "linux"] as const) {
    assert.equal(dataDirFor(platform, { [DATA_DIR_ENV]: "/tmp/隔离 数据" }, NIX_HOME), "/tmp/隔离 数据");
  }
});

test("installRootFor: 三平台缺省 + TREEAI_INSTALL_ROOT 覆盖", () => {
  assert.equal(installRootFor("darwin", {}, MAC_HOME), `${MAC_HOME}/Applications/TreeAI`);
  assert.equal(
    installRootFor("win32", { LOCALAPPDATA: `${WIN_HOME}\\AppData\\Local` }, WIN_HOME),
    join(`${WIN_HOME}\\AppData\\Local`, "Programs", "TreeAI"),
  );
  assert.equal(installRootFor("linux", {}, NIX_HOME), `${NIX_HOME}/.local/opt/TreeAI`);
  assert.equal(installRootFor("linux", { TREEAI_INSTALL_ROOT: "/opt/treeai" }, NIX_HOME), "/opt/treeai");
});

/* ------------------------------------------------------------------ */
/* config.json                                                        */
/* ------------------------------------------------------------------ */

test("parseLauncherConfig: 缺省 echo 配置 + 校验通过", () => {
  const { config, problems } = parseLauncherConfig(
    JSON.stringify({ schemaVersion: 1, port: 8787, driver: "echo" }),
  );
  assert.deepEqual(problems, []);
  assert.equal(config?.driver, "echo");
  assert.deepEqual(validateLauncherConfig(config!), []);
});

test("parseLauncherConfig: 坏 JSON 必须报错并给出恢复路径（绝不静默回落默认）", () => {
  const { config, problems } = parseLauncherConfig("{ not json");
  assert.equal(config, null);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /不是合法 JSON/);
  assert.match(problems[0]!, /修复方法/);
});

test("parseLauncherConfig: driver=pi 缺 provider/model → 可执行恢复信息", () => {
  const { config } = parseLauncherConfig(JSON.stringify({ schemaVersion: 1, port: 8787, driver: "pi" }));
  const problems = validateLauncherConfig(config!);
  assert.equal(problems.length, 2);
  assert.match(problems.join("\n"), /driver=pi 需要 provider.*修复方法/s);
  assert.match(problems.join("\n"), /driver=pi 需要 model.*修复方法/s);
  assert.match(problems.join("\n"), /"driver" 改回 "echo"/);
});

test("parseLauncherConfig: echo 带 provider 是错误（提示如何转 pi）", () => {
  const { config } = parseLauncherConfig(
    JSON.stringify({ schemaVersion: 1, port: 8787, driver: "echo", provider: "x" }),
  );
  const problems = validateLauncherConfig(config!);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /driver=echo 时不需要 provider\/model/);
});

test("parseLauncherConfig: 非法端口被拒（1–65535）", () => {
  const { config } = parseLauncherConfig(JSON.stringify({ schemaVersion: 1, port: 70000, driver: "echo" }));
  const problems = validateLauncherConfig(config!);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /port 必须是 1–65535 的整数/);
});

test("parseLauncherConfig: schemaVersion 不符给出重建指引", () => {
  const { config } = parseLauncherConfig(JSON.stringify({ schemaVersion: 99, port: 8787, driver: "echo" }));
  const problems = validateLauncherConfig(config!);
  assert.match(problems[0]!, /schemaVersion 是 99/);
});

test("defaultLauncherConfig: 零依赖离线缺省", () => {
  const config = defaultLauncherConfig();
  assert.equal(config.driver, "echo");
  assert.equal(config.port, DEFAULT_PORT);
  assert.deepEqual(validateLauncherConfig(config), []);
});

test("buildServerArgs: echo 只带 port/data；pi 带完整模型装配", () => {
  const echo = defaultLauncherConfig();
  assert.deepEqual(buildServerArgs(echo, 8788, "/tmp/数据 目录"), ["--port", "8788", "--data", "/tmp/数据 目录"]);
  const pi = {
    ...defaultLauncherConfig(),
    driver: "pi" as const,
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    terminologyProvider: "anthropic",
    terminologyModel: "claude-haiku",
    terminologyBudgetTokens: 500000,
  };
  assert.deepEqual(buildServerArgs(pi, 8787, "/d"), [
    "--port",
    "8787",
    "--data",
    "/d",
    "--driver",
    "pi",
    "--provider",
    "anthropic",
    "--model",
    "claude-sonnet-4-5",
    "--terminology-provider",
    "anthropic",
    "--terminology-model",
    "claude-haiku",
    "--terminology-budget",
    "500000",
  ]);
});

/* ------------------------------------------------------------------ */
/* 端口顺延 / 浏览器唤起                                              */
/* ------------------------------------------------------------------ */

test("portCandidates: 从期望端口连续顺延", () => {
  assert.deepEqual(portCandidates(8787, 3), [8787, 8788, 8789]);
  assert.deepEqual(portCandidates(8787, 1), [8787]);
});

test("portCandidates: 越界（>65535）截断；非法输入回落默认", () => {
  assert.deepEqual(portCandidates(65535, 3), [65535]);
  assert.deepEqual(portCandidates(0, 2), [DEFAULT_PORT, DEFAULT_PORT + 1]);
});

test("browserCommandFor: 平台缺省 + BROWSER/TREEAI_BROWSER 覆盖（含参数）", () => {
  assert.deepEqual(browserCommandFor("darwin", {}), { command: "open", args: [] });
  assert.deepEqual(browserCommandFor("linux", {}), { command: "xdg-open", args: [] });
  assert.deepEqual(browserCommandFor("win32", {}), { command: "cmd", args: ["/c", "start", ""] });
  assert.deepEqual(browserCommandFor("darwin", { BROWSER: "/tmp/recorder.sh" }), {
    command: "/tmp/recorder.sh",
    args: [],
  });
  assert.deepEqual(browserCommandFor("darwin", { TREEAI_BROWSER: "firefox --new-window" }), {
    command: "firefox",
    args: ["--new-window"],
  });
  assert.deepEqual(browserCommandFor("linux", { BROWSER: "", TREEAI_BROWSER: "chromium" }), {
    command: "chromium",
    args: [],
  });
});

/* ------------------------------------------------------------------ */
/* Node 发行包 / esbuild 裁剪                                          */
/* ------------------------------------------------------------------ */

test("nodeDistFor: 三平台官方 URL 与包内二进制路径", () => {
  const mac = nodeDistFor("24.21.0", "darwin-arm64");
  assert.equal(mac.archiveUrl, "https://nodejs.org/dist/v24.21.0/node-v24.21.0-darwin-arm64.tar.gz");
  assert.equal(mac.binaryInArchive, "node-v24.21.0-darwin-arm64/bin/node");
  const win = nodeDistFor("24.21.0", "win-x64");
  assert.equal(win.archiveUrl, "https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-x64.zip");
  assert.equal(win.binaryInArchive, join("node-v24.21.0-win-x64", "node.exe"));
  const linux = nodeDistFor("24.21.0", "linux-x64");
  assert.equal(linux.archiveUrl, "https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz");
  assert.equal(linux.shasumsUrl, "https://nodejs.org/dist/v24.21.0/SHASUMS256.txt");
});

test("ESBUILD_PLATFORM_PACKAGE: 每平台恰好保留自己的二进制包", () => {
  assert.equal(ESBUILD_PLATFORM_PACKAGE["darwin-arm64"], "@esbuild/darwin-arm64");
  assert.equal(ESBUILD_PLATFORM_PACKAGE["win-x64"], "@esbuild/win32-x64");
  assert.equal(ESBUILD_PLATFORM_PACKAGE["linux-x64"], "@esbuild/linux-x64");
});

/* ------------------------------------------------------------------ */
/* VERSION.json 清单                                                   */
/* ------------------------------------------------------------------ */

function validManifest(): Record<string, unknown> {
  return {
    schemaVersion: BUNDLE_MANIFEST_SCHEMA,
    product: "TreeAI Studio",
    bundleVersion: "0.1.0-test",
    platform: "darwin-arm64",
    node: { version: "24.21.0", distFile: "node-v24.21.0-darwin-arm64.tar.gz", distSha256: "a".repeat(64) },
    gitCommit: "0123456789abcdef0123456789abcdef01234567",
    gitDirty: false,
    builtAt: "2026-09-30T00:00:00.000Z",
    signing: { codeSigning: "absent", notarization: "absent", note: "…" },
  };
}

test("validateBundleManifest: 合法清单通过", () => {
  const { manifest, problems } = validateBundleManifest(validManifest());
  assert.deepEqual(problems, []);
  assert.equal(manifest?.platform, "darwin-arm64");
});

test("validateBundleManifest: 签名状态伪装成已签名必须被拒（如实纪律）", () => {
  const forged = validManifest();
  (forged.signing as Record<string, unknown>)["codeSigning"] = "signed";
  const { manifest, problems } = validateBundleManifest(forged);
  assert.equal(manifest, null);
  assert.match(problems.join("\n"), /signing 必须如实为 absent/);
});

test("validateBundleManifest: 缺 node SHA256 / 非法平台被拒", () => {
  const noSha = validManifest();
  (noSha.node as Record<string, unknown>)["distSha256"] = "zz";
  assert.equal(validateBundleManifest(noSha).manifest, null);
  const badPlatform = validManifest();
  badPlatform["platform"] = "freebsd-arm64";
  const problems = validateBundleManifest(badPlatform).problems;
  assert.match(problems.join("\n"), /platform 必须是/);
});

/* ------------------------------------------------------------------ */
/* 产物布局校验（合成最小产物）                                        */
/* ------------------------------------------------------------------ */

function makeSyntheticBundle(platform: "darwin-arm64" | "linux-x64" | "win-x64"): string {
  const root = mkdtempSync(join(tmpdir(), "treeai-d47-layout-"));
  const nodeBin = platform === "win-x64" ? join("node", "node.exe") : join("node", "bin", "node");
  mkdirSync(join(root, nodeBin, ".."), { recursive: true });
  writeFileSync(join(root, nodeBin), "fake", { flag: "wx" });
  if (platform !== "win-x64") chmodSync(join(root, nodeBin), 0o755);
  for (const f of [join("launcher", "launcher.ts"), join("launcher", "core.ts"), "README.md"]) {
    mkdirSync(join(root, f, ".."), { recursive: true });
    writeFileSync(join(root, f), "");
  }
  for (const appFile of [
    join("app", "apps", "studio", "src", "index.ts"),
    join("app", "apps", "studio", "public", "index.html"),
    join("app", "apps", "studio", "package.json"),
    join("app", "packages", "event-journal", "dist", "src", "index.js"),
    join("app", "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
    join("app", "node_modules", "@treeai", "contracts", "package.json"),
  ]) {
    mkdirSync(join(root, appFile, ".."), { recursive: true });
    writeFileSync(join(root, appFile), "");
  }
  for (const pkg of ["contracts", "event-journal", "persistence", "runtime-pi", "tool-policy"]) {
    for (const p of [
      join("app", "packages", pkg, "package.json"),
      join("app", "packages", pkg, "src", "index.ts"),
      join("app", "node_modules", "@treeai", pkg, "package.json"),
      join("app", "node_modules", "@treeai", pkg, "index.js"),
    ]) {
      mkdirSync(join(root, p, ".."), { recursive: true });
      writeFileSync(join(root, p), "");
    }
  }
  const shims = requiredShimFiles(platform);
  for (const shim of shims) {
    writeFileSync(join(root, shim), "");
  }
  writeFileSync(
    join(root, MANIFEST_FILE_NAME),
    JSON.stringify({ ...validManifest(), platform }),
  );
  return root;
}

test("validateBundleLayout: 合成最小产物通过（三平台）", () => {
  for (const platform of ["darwin-arm64", "linux-x64", "win-x64"] as const) {
    const root = makeSyntheticBundle(platform);
    try {
      assert.deepEqual(validateBundleLayout(root, platform), [], platform);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("validateBundleLayout: 缺件必须点名报错", () => {
  const root = makeSyntheticBundle("darwin-arm64");
  try {
    rmSync(join(root, "app", "apps", "studio", "public", "index.html"));
    const problems = validateBundleLayout(root, "darwin-arm64");
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /studio 静态前端/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validateBundleLayout: node 缺执行位必须报错（posix）", () => {
  const root = makeSyntheticBundle("darwin-arm64");
  try {
    chmodSync(join(root, "node", "bin", "node"), 0o644);
    const problems = validateBundleLayout(root, "darwin-arm64");
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /执行位/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validateBundleLayout: node_modules 内的符号链接必须报错（Windows zip 不保）", () => {
  const root = makeSyntheticBundle("linux-x64");
  try {
    const target = join(root, "app", "packages", "persistence", "package.json");
    const link = join(root, "app", "node_modules", "@treeai", "persistence", "evil-link");
    symlinkSync(target, link);
    const problems = validateBundleLayout(root, "linux-x64");
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /符号链接/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* 运行时状态                                                          */
/* ------------------------------------------------------------------ */

test("parseRuntimeState: 合法状态与损坏输入", () => {
  const state = parseRuntimeState(
    JSON.stringify({ pid: 123, port: 8787, url: "http://127.0.0.1:8787", startedAt: "t", bundleVersion: "v" }),
  );
  assert.equal(state?.pid, 123);
  assert.equal(state?.url, "http://127.0.0.1:8787");
  assert.equal(parseRuntimeState("{"), null);
  assert.equal(parseRuntimeState(JSON.stringify({ pid: "x" })), null);
});

test("常量：API key 环境变量名与 studio CLI 冻结契约一致", () => {
  /* apps/studio/src/cli.ts 的 PI_API_KEY_ENV；此处锁死，防漂移。 */
  assert.equal(PI_API_KEY_ENV, "TREEAI_STUDIO_API_KEY");
  assert.equal(CONFIG_FILE_NAME, "config.json");
});

/* 编译期覆盖：launcher.ts / shims.ts 经 type-only import 纳入 tests-typecheck
   （launcher 自执行，不能值导入）；这里只固定公开形状的编译期约束。 */
test("shims/launcher 类型层纳入检查（type-only import）", () => {
  const files: shimsModule.ShimFile[] = [];
  const readmes: Array<ReturnType<ShimsExports["bundleReadme"]>> = [];
  const options: LauncherStartOptions[] = [];
  assert.deepEqual([files.length, readmes.length, options.length], [0, 0, 0]);
});

/* rootless 容器回归（issue #8 增量验收 2026-09-30 P2）：tar 解包必须恒带
   --no-same-owner——user-namespace root 下 GNU tar 恢复归档 UID/GID 会在
   nodejs.org 发行包（属主≠当前用户）上失败退出；本仓解包后一律重新
   staging/校验，关闭属主恢复在所有环境安全。 */
test("tarExtractArgs: 恒带 --no-same-owner 且按后缀选择解包 flag（rootless 容器回归）", () => {
  assert.deepEqual(tarExtractArgs("node-v24.21.0-linux-x64.tar.xz", "/tmp/x"), [
    "-xJf",
    "node-v24.21.0-linux-x64.tar.xz",
    "-C",
    "/tmp/x",
    "--no-same-owner",
  ]);
  assert.deepEqual(tarExtractArgs("treeai-studio-0.0.0-darwin-arm64.tar.gz", "/tmp/y"), [
    "-xzf",
    "treeai-studio-0.0.0-darwin-arm64.tar.gz",
    "-C",
    "/tmp/y",
    "--no-same-owner",
  ]);
  /* 非 tar 后缀（zip 经 bsdtar 兜底路径）交给 -xf 自动探测，flag 仍在。 */
  assert.deepEqual(tarExtractArgs("treeai-studio-0.0.0-win-x64.zip", "/tmp/z"), [
    "-xf",
    "treeai-studio-0.0.0-win-x64.zip",
    "-C",
    "/tmp/z",
    "--no-same-owner",
  ]);
});
