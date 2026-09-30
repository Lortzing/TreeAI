#!/usr/bin/env node
/**
 * package-installer — TreeAI D4-7 安装产物构建入口（issue #8 §5 / B8）。
 *
 * 产出每平台一个带版本与校验和的安装压缩包：
 *   treeai-studio-<version>-<platform>.tar.gz   （darwin-arm64 / linux-x64）
 *   treeai-studio-<version>-<platform>.zip      （win-x64）
 * 外加 SHA256SUMS.txt（压缩包 + 独立清单副本的 SHA256）与构建报告 JSON。
 *
 * 产物布局（解压即装；不要求克隆源码 / 手动装 Node / 编译）：
 *
 *   treeai-studio-<version>-<platform>/
 *     VERSION.json          版本清单（含内置 Node 发行包官方 SHA256、git 提交、
 *                           签名状态=absent，如实记录）
 *     README.md             安装/使用/升级/卸载/签名状态说明（中文）
 *     node/                 固定版本 Node 运行时（nodejs.org 官方发行包抽取）
 *     launcher/             launcher.ts + core.ts（启动器；无 npm 依赖）
 *     app/                  studio 应用快照（TypeScript 源码 + 静态前端 +
 *                           预编译 event-journal + 物化 node_modules）
 *     treeai.{sh|ps1} + start/stop/…            平台入口脚本
 *
 * 诚实边界（与 D4-status 一致，不夸大）：
 *   - node_modules 来自构建机 npm ci 的安装树：剔除开发依赖（typescript、
 *     @types、undici-types）与 .bin 符号链接目录，@treeai/* 由 workspace
 *     符号链接物化为真实目录副本（Windows zip 不保留符号链接）；
 *   - @esbuild 只保留目标平台二进制包（esbuild 运行时只加载当前平台的包；
 *     裁剪清单进构建报告，不静默）；
 *   - 产物无签名、无公证：manifest.signing 如实为 absent；
 *   - staging 目录打包前经 tests/support/verifier/secret-scanner.ts 扫描
 *     （其文档化盲区同样适用：node_modules 目录名被其跳过——node_modules
 *     内只有 registry 发布代码与 workspace 源码副本，报告如实注明）。
 *
 * 用法（在仓内、npm ci 之后）：
 *   node scripts/d4/package-installer.mjs --platform darwin-arm64 \
 *        [--version 0.1.0-abc1234] [--node-version 24.21.0] \
 *        [--out-dir dist/d4-installer]
 *
 * 退出码：0 = 构建成功；1 = 参数/环境错误；2 = 构建/校验失败。
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import {
  BUNDLE_MANIFEST_SCHEMA,
  ESBUILD_PLATFORM_PACKAGE,
  MANIFEST_FILE_NAME,
  PLATFORM_SPECS,
  TARGET_PLATFORMS,
  dataDirFor,
  installRootFor,
  nodeDistFor,
  validateBundleLayout,
} from "./installer/core.ts";
import { bundleReadme, shimFilesFor } from "./installer/shims.ts";
import { scanFiles } from "../../tests/support/verifier/secret-scanner.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..");

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function usage() {
  return [
    "用法：node scripts/d4/package-installer.mjs --platform <darwin-arm64|win-x64|linux-x64>",
    "                [--version <bundle 版本>] [--node-version <node 版本>]",
    "                [--out-dir <输出目录>]（默认 dist/d4-installer）",
    "",
    "--platform 必填（一次一个平台；三平台产物由 CI 矩阵分别构建）。",
    "--version 缺省 = <package.json version>+<git 短 SHA>。",
    "--node-version 缺省 = 根 package.json engines.node（固定工具链）。",
  ].join("\n");
}

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
function fail(message, code = 2) {
  process.stderr.write(`package-installer: 失败：${message}\n`);
  process.exit(code);
}

if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(`${usage()}\n`);
  process.exit(0);
}

const platformArg = argValue("platform");
if (platformArg === null) {
  process.stderr.write(`${usage()}\n`);
  fail("--platform 必填", 1);
}
if (!TARGET_PLATFORMS.includes(platformArg)) {
  fail(`--platform 必须是 ${TARGET_PLATFORMS.join(" / ")} 之一（got '${platformArg}'）`, 1);
}
const PLATFORM = platformArg;

const rootPackageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
const NODE_VERSION = argValue("node-version") ?? rootPackageJson.engines.node;
const OUT_DIR = resolve(REPO_ROOT, argValue("out-dir") ?? join("dist", "d4-installer"));
const startedAt = Date.now();

function git(argsList) {
  const res = spawnSync("git", argsList, { cwd: REPO_ROOT, encoding: "utf8" });
  return res.status === 0 ? res.stdout.trim() : null;
}
const GIT_COMMIT = git(["rev-parse", "HEAD"]) ?? "unknown";
const GIT_DIRTY = git(["status", "--porcelain"]) !== null && git(["status", "--porcelain"]) !== "";
const BUNDLE_VERSION =
  argValue("version") ?? `${rootPackageJson.version}+${(GIT_COMMIT ?? "unknown").slice(0, 8)}`;

process.stdout.write(
  [
    `package-installer: 构建 TreeAI Studio 安装产物（D4-7）`,
    `  平台          ${PLATFORM}`,
    `  bundle 版本   ${BUNDLE_VERSION}`,
    `  内置 Node     ${NODE_VERSION}（nodejs.org 官方发行包）`,
    `  git 提交      ${GIT_COMMIT}${GIT_DIRTY ? "（工作区有未提交改动）" : ""}`,
    `  输出目录      ${OUT_DIR}`,
    ``,
  ].join("\n"),
);

/* ------------------------------------------------------------------ */
/* 前置检查                                                            */
/* ------------------------------------------------------------------ */

if (!existsSync(join(REPO_ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"))) {
  fail("node_modules 不完整（缺 @earendil-works/pi-coding-agent）。先在仓内运行 npm ci。", 1);
}

/* event-journal 的 package.json main 指向 dist（构建产物）：打包前必须构建。
   直接用本仓 node_modules 的 tsc（跨平台，不经 npm.cmd）。 */
process.stdout.write("package-installer: 构建 event-journal（tsc -p tsconfig.build.json）…\n");
try {
  execFileSync(
    process.execPath,
    [join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", join("packages", "event-journal", "tsconfig.build.json")],
    { cwd: REPO_ROOT, stdio: "inherit" },
  );
} catch (err) {
  fail(`event-journal 构建失败：${err instanceof Error ? err.message : String(err)}`);
}

/* ------------------------------------------------------------------ */
/* 下载并校验 Node 官方发行包                                          */
/* ------------------------------------------------------------------ */

const CACHE_DIR = join(OUT_DIR, ".cache", "node-dist");
mkdirSync(CACHE_DIR, { recursive: true });
const dist = nodeDistFor(NODE_VERSION, PLATFORM);
const distArchivePath = join(CACHE_DIR, dist.archiveName);

async function downloadTo(url, destination) {
  const res = await fetch(url);
  if (!res.ok || res.body === null) throw new Error(`下载失败 ${url}: HTTP ${String(res.status)}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(destination));
}

async function sha256File(path) {
  const buffer = readFileSync(path);
  return createHash("sha256").update(buffer).digest("hex");
}

let distSha256 = null;
if (existsSync(distArchivePath)) {
  process.stdout.write(`package-installer: 使用缓存发行包 ${distArchivePath}\n`);
} else {
  process.stdout.write(`package-installer: 下载 ${dist.archiveUrl} …\n`);
  try {
    await downloadTo(dist.archiveUrl, distArchivePath);
  } catch (err) {
    fail(`下载 Node 发行包失败：${err instanceof Error ? err.message : String(err)}`);
  }
}
process.stdout.write(`package-installer: 下载并核对官方 SHASUMS256.txt …\n`);
const shasumsPath = join(CACHE_DIR, `SHASUMS256.txt.v${NODE_VERSION}`);
if (!existsSync(shasumsPath)) {
  try {
    await downloadTo(dist.shasumsUrl, shasumsPath);
  } catch (err) {
    fail(`下载 SHASUMS256.txt 失败：${err instanceof Error ? err.message : String(err)}`);
  }
}
const shasums = readFileSync(shasumsPath, "utf8");
const expected = shasums
  .split("\n")
  .map((line) => /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim()))
  .filter((m) => m !== null && m[2] === dist.archiveName)
  .map((m) => m[1]);
if (expected.length !== 1) {
  fail(`SHASUMS256.txt 中没有（或有多条）${dist.archiveName} 的条目——发行包名与官方清单不匹配`);
}
distSha256 = await sha256File(distArchivePath);
if (distSha256 !== expected[0]) {
  fail(
    `Node 发行包 SHA256 不符官方 SHASUMS256.txt（期望 ${expected[0]}，实测 ${distSha256}）。` +
      "已删除缓存；请重新运行（持续不符请停止并上报）。",
  );
  rmSync(distArchivePath, { force: true });
}
process.stdout.write(`package-installer: 发行包 SHA256 与官方一致（${distSha256.slice(0, 16)}…）\n`);

/* 解出 node 可执行文件（+ 尽力携带 LICENSE）。 */
const extractDir = mkdtempSync(join(tmpdir(), "treeai-node-dist-"));
function extractArchive(archivePath, intoDir) {
  if (archivePath.endsWith(".zip")) {
    if (process.platform === "win32") {
      execFileSync(
        "powershell",
        ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${intoDir.replace(/'/g, "''")}' -Force`],
        { stdio: "inherit" },
      );
      return;
    }
    /* macOS/Linux 主机：bsdtar 能解 zip；GNU tar 不能 → 先试 unzip。 */
    const hasUnzip = spawnSync("which", ["unzip"], { encoding: "utf8" }).status === 0;
    if (hasUnzip) {
      execFileSync("unzip", ["-q", "-o", archivePath, "-d", intoDir], { stdio: "inherit" });
    } else {
      execFileSync("tar", ["-xf", archivePath, "-C", intoDir], { stdio: "inherit" });
    }
    return;
  }
  const flag = archivePath.endsWith(".tar.xz") ? "-xJf" : "-xzf";
  execFileSync("tar", [flag, archivePath, "-C", intoDir], { stdio: "inherit" });
}
process.stdout.write("package-installer: 解包 Node 发行包…\n");
try {
  extractArchive(distArchivePath, extractDir);
} catch (err) {
  fail(`解包 Node 发行包失败：${err instanceof Error ? err.message : String(err)}`);
}
const nodeBinaryInExtract = join(extractDir, dist.binaryInArchive);
if (!existsSync(nodeBinaryInExtract)) {
  fail(`发行包中没有预期的 node 可执行文件（${dist.binaryInArchive}）`);
}

/* ------------------------------------------------------------------ */
/* staging                                                            */
/* ------------------------------------------------------------------ */

const spec = PLATFORM_SPECS[PLATFORM];
const bundleDirName = `treeai-studio-${BUNDLE_VERSION}-${PLATFORM}`;
const stageRoot = join(OUT_DIR, "stage");
const stageDir = join(stageRoot, bundleDirName);
rmSync(stageRoot, { recursive: true, force: true });
mkdirSync(dirname(join(stageDir, spec.nodeBinaryInBundle)), { recursive: true });
mkdirSync(join(stageDir, "launcher"), { recursive: true });
mkdirSync(join(stageDir, "app"), { recursive: true });

const copied = { files: 0, bytes: 0 };
function copyFile(src, dest) {
  copyFileSync(src, dest);
  copied.files += 1;
  copied.bytes += statSync(src).size;
}

/** 递归复制目录；filterTop 只作用于源目录顶层条目（返回 false 跳过）。
    任何深度的 .bin 目录（符号链接集）与孤立符号链接都被跳过并记录。 */
const skippedSymlinks = [];
function copyDirFiltered(srcRoot, destRoot, filterTop) {
  const walk = (src, dest) => {
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      if (src === srcRoot && filterTop !== undefined && !filterTop(entry)) continue;
      if (entry.isDirectory() && entry.name === ".bin") {
        skippedSymlinks.push(join(src, entry.name));
        continue; /* .bin 全是符号链接；Windows zip 不保，运行时也不经它 */
      }
      const from = join(src, entry.name);
      const to = join(dest, entry.name);
      if (entry.isDirectory()) {
        walk(from, to);
      } else if (entry.isSymbolicLink()) {
        skippedSymlinks.push(from);
        continue;
      } else {
        copyFile(from, to);
      }
    }
  };
  walk(srcRoot, destRoot);
}

/* 1. node 运行时 */
const nodeBinaryDest = join(stageDir, spec.nodeBinaryInBundle);
copyFile(nodeBinaryInExtract, nodeBinaryDest);
chmodSync(nodeBinaryDest, 0o755);
for (const licenseName of ["LICENSE", "LICENSE.md"]) {
  const licenseSrc = join(extractDir, `node-v${NODE_VERSION}-${spec.nodeDistSuffix}`, licenseName);
  if (existsSync(licenseSrc)) {
    copyFile(licenseSrc, join(stageDir, "node", licenseName));
  }
}

/* 2. 启动器（.ts 由内置 Node 类型剥离直接执行；无 npm 依赖） */
copyFile(join(SCRIPT_DIR, "installer", "launcher.ts"), join(stageDir, "launcher", "launcher.ts"));
copyFile(join(SCRIPT_DIR, "installer", "core.ts"), join(stageDir, "launcher", "core.ts"));

/* 3. 应用快照（白名单：源码 + 静态前端 + package.json + event-journal dist） */
const WORKSPACE_PACKAGES = ["contracts", "event-journal", "persistence", "runtime-pi", "tool-policy"];
const workspaceTopFilter = (pkg) => (entry) =>
  entry.name === "src" || entry.name === "package.json" || (pkg === "event-journal" && entry.name === "dist");
for (const pkg of WORKSPACE_PACKAGES) {
  copyDirFiltered(
    join(REPO_ROOT, "packages", pkg),
    join(stageDir, "app", "packages", pkg),
    workspaceTopFilter(pkg),
  );
}
copyDirFiltered(
  join(REPO_ROOT, "apps", "studio"),
  join(stageDir, "app", "apps", "studio"),
  (entry) => entry.name === "src" || entry.name === "public" || entry.name === "package.json",
);

/* 4. node_modules：@earendil-works（registry 依赖树）+ @treeai/*（物化副本） */
const prunedEsbuild = [];
const esbuildKeep = ESBUILD_PLATFORM_PACKAGE[PLATFORM];
const ESBUILD_PLATFORM_RE =
  /^(aix|android|darwin|freebsd|linux|netbsd|openbsd|openharmony|sunos|win32)-(amd64|arm64|x64|ia32|arm|loong64|ppc64|riscv64|s390x|mips64el)$/;
copyDirFiltered(
  join(REPO_ROOT, "node_modules", "@earendil-works"),
  join(stageDir, "app", "node_modules", "@earendil-works"),
  (entry) => entry.name !== ".bin", /* 顶层只有 pi-coding-agent；.bin 不需要 */
);/* @esbuild 裁剪在完整复制后做（平台包都在嵌套 node_modules/@esbuild 下；
     ESBUILD_PLATFORM_PACKAGE 是带作用域的全名，目录内只比较平台段）。 */
const esbuildScopeDir = join(
  stageDir,
  "app",
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "node_modules",
  "@esbuild",
);
const esbuildKeepDir = esbuildKeep.split("/").pop();
if (existsSync(esbuildScopeDir) && existsSync(join(esbuildScopeDir, esbuildKeepDir))) {
  for (const entry of readdirSync(esbuildScopeDir, { withFileTypes: true })) {
    if (entry.isDirectory() && ESBUILD_PLATFORM_RE.test(entry.name) && entry.name !== esbuildKeepDir) {
      rmSync(join(esbuildScopeDir, entry.name), { recursive: true, force: true });
      prunedEsbuild.push(entry.name);
    }
  }
}
mkdirSync(join(stageDir, "app", "node_modules", "@treeai"), { recursive: true });
/* node_modules/@treeai/*：两文件重导出桩（package.json + index.js）。
   真实源码在 app/packages/*（不在 node_modules 下——Node 对 node_modules
   内的 .ts 拒绝类型剥离（ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING），
   开发仓里这是符号链接、解析到 node_modules 外才成立；Windows zip 不保
   符号链接，所以产物用「node_modules 外源码 + JS 桩重导出」的等价布局）。 */
for (const pkg of WORKSPACE_PACKAGES) {
  const stubDir = join(stageDir, "app", "node_modules", "@treeai", pkg);
  mkdirSync(stubDir, { recursive: true });
  const original = JSON.parse(readFileSync(join(REPO_ROOT, "packages", pkg, "package.json"), "utf8"));
  const stubPackageJson = {
    name: original.name,
    version: original.version,
    type: "module",
    main: "./index.js",
    exports: { ".": "./index.js" },
    _treeaiBundleNote: "re-export stub; real code at app/packages/ (Node type-strips only outside node_modules)",
  };
  writeFileSync(join(stubDir, "package.json"), `${JSON.stringify(stubPackageJson, null, 2)}\n`);
  const entry =
    pkg === "event-journal"
      ? "../../../packages/event-journal/dist/src/index.js"
      : `../../../packages/${pkg}/src/index.ts`;
  writeFileSync(
    join(stubDir, "index.js"),
    `// TreeAI D4-7 bundle stub: re-export the workspace package living outside\n` +
      `// node_modules (see package.json _treeaiBundleNote).\n` +
      `export * from "${entry}";\n`,
  );
}

/* 5. 平台入口脚本 */
for (const shim of shimFilesFor(PLATFORM)) {
  const dest = join(stageDir, shim.path);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, shim.content);
  if (shim.mode === 0o755) chmodSync(dest, 0o755);
}

/* 6. 清单与 README */
const manifest = {
  schemaVersion: BUNDLE_MANIFEST_SCHEMA,
  product: "TreeAI Studio",
  bundleVersion: BUNDLE_VERSION,
  platform: PLATFORM,
  node: {
    version: NODE_VERSION,
    distFile: dist.archiveName,
    distSha256,
  },
  gitCommit: GIT_COMMIT,
  gitDirty: GIT_DIRTY,
  builtAt: new Date().toISOString(),
  signing: {
    codeSigning: "absent",
    notarization: "absent",
    note: "本产物未做代码签名/公证（仓库未持有证书）；macOS Gatekeeper / Windows SmartScreen 的正规应对见 README。",
  },
};
writeFileSync(join(stageDir, MANIFEST_FILE_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
/* README 展示的是「目标平台用户」的缺省路径模式（~/… 形式），不是构建机的。 */
const readmePlatform =
  PLATFORM === "darwin-arm64" ? "darwin" : PLATFORM === "win-x64" ? "win32" : "linux";
const pathEnv = readmePlatform === "win32" ? { APPDATA: "%APPDATA%", LOCALAPPDATA: "%LOCALAPPDATA%" } : {};
const readmeDataDir = dataDirFor(readmePlatform, pathEnv, "~").replaceAll("/", "\\");
const readmeInstallRoot = installRootFor(readmePlatform, pathEnv, "~").replaceAll("/", "\\");
writeFileSync(
  join(stageDir, "README.md"),
  bundleReadme({
    bundleVersion: BUNDLE_VERSION,
    platform: PLATFORM,
    nodeVersion: NODE_VERSION,
    dataDir: readmeDataDir,
    installRoot: readmeInstallRoot,
    builtAt: manifest.builtAt,
    gitCommit: GIT_COMMIT,
  }),
);

/* ------------------------------------------------------------------ */
/* 校验：布局 + 密钥扫描                                               */
/* ------------------------------------------------------------------ */

const layoutProblems = validateBundleLayout(stageDir, PLATFORM);
if (layoutProblems.length > 0) {
  fail(`staging 布局校验失败：\n  ${layoutProblems.join("\n  ")}`);
}
process.stdout.write("package-installer: staging 布局校验通过（node/launcher/app/入口脚本/无符号链接）\n");

process.stdout.write("package-installer: 密钥扫描（tests/support/verifier/secret-scanner.ts）…\n");
const scan = scanFiles([stageDir], stageDir);
if (scan.findings.length > 0) {
  const described = scan.findings
    .map((f) => `${f.ruleId} @ ${f.path} (${f.preview ?? ""}…长度 ${String(f.length ?? "?")})`)
    .join("\n  ");
  fail(`staging 密钥扫描发现 ${String(scan.findings.length)} 个疑似凭据形状——产物绝不携带凭据：\n  ${described}`);
}
process.stdout.write(
  `package-installer: 密钥扫描通过（${String(scan.stats.filesScanned)} 文件；` +
    "其文档化盲区适用：scanner 跳过名为 node_modules 的目录，node_modules 内为 registry 发布代码与 workspace 源码副本，已如实记录于构建报告）\n",
);

/* ------------------------------------------------------------------ */
/* 压缩 + SHA256SUMS                                                  */
/* ------------------------------------------------------------------ */

const archiveName =
  PLATFORM === "win-x64" ? `${bundleDirName}.zip` : `${bundleDirName}.tar.gz`;
const archivePath = join(OUT_DIR, archiveName);
function createArchive() {
  if (PLATFORM === "win-x64") {
    if (process.platform === "win32") {
      /* 压缩整个顶层目录（解压后得到 treeai-studio-<ver>-win-x64/…）。 */
      execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `Compress-Archive -Path '${join(stageRoot, bundleDirName).replace(/'/g, "''")}' -DestinationPath '${archivePath.replace(/'/g, "''")}' -Force`,
        ],
        { stdio: "inherit" },
      );
      return;
    }
    const hasZip = spawnSync("which", ["zip"], { encoding: "utf8" }).status === 0;
    if (hasZip) {
      execFileSync("zip", ["-q", "-r", "-y", archivePath, bundleDirName], { cwd: stageRoot, stdio: "inherit" });
    } else {
      execFileSync("tar", ["-a", "-cf", archivePath, bundleDirName], { cwd: stageRoot, stdio: "inherit" });
    }
    return;
  }
  execFileSync("tar", ["-czf", archivePath, bundleDirName], { cwd: stageRoot, stdio: "inherit" });
}
process.stdout.write(`package-installer: 压缩 ${archiveName} …\n`);
try {
  createArchive();
} catch (err) {
  fail(`压缩失败：${err instanceof Error ? err.message : String(err)}`);
}

const archiveSha = await sha256File(archivePath);
const manifestCopyPath = join(OUT_DIR, `VERSION-${bundleDirName}.json`);
copyFileSync(join(stageDir, MANIFEST_FILE_NAME), manifestCopyPath);
const manifestCopySha = await sha256File(manifestCopyPath);
writeFileSync(
  join(OUT_DIR, "SHA256SUMS.txt"),
  `${archiveSha}  ${archiveName}\n${manifestCopySha}  ${relative(OUT_DIR, manifestCopyPath)}\n`,
);
writeFileSync(join(OUT_DIR, `${archiveName}.sha256`), `${archiveSha}\n`);

/* ------------------------------------------------------------------ */
/* 构建报告 + 收尾                                                     */
/* ------------------------------------------------------------------ */

const buildReport = {
  schemaVersion: "d4-installer-build-report-1",
  platform: PLATFORM,
  bundleVersion: BUNDLE_VERSION,
  node: { version: NODE_VERSION, distFile: dist.archiveName, distSha256, source: "nodejs.org (SHASUMS256.txt verified)" },
  git: { commit: GIT_COMMIT, dirty: GIT_DIRTY },
  archive: { name: archiveName, sha256: archiveSha },
  contents: {
    files: copied.files,
    bytes: copied.bytes,
    prunedEsbuildPlatforms: prunedEsbuild.sort(),
    skippedSymlinkEntries: skippedSymlinks.length,
    skippedSymlinkNote: "各层 node_modules/.bin 与孤立符号链接（Windows zip 不保留；运行时直接以路径调用 node，不经 .bin）",
    excluded: [
      "devDependencies（typescript / @types/node / undici-types）",
      "apps/studio/terminology（冻结质量集 fixture，运行时不需要）",
      "各 workspace tests/（测试，不打进产物）",
      "apps/runtime-smoke（集成冒烟 app，不打进产物）",
    ],
  },
  secretScan: {
    scanner: "tests/support/verifier/secret-scanner.ts (d2-v1.1)",
    findings: 0,
    blindSpotNote:
      "scanner 跳过名为 node_modules 的目录（文档化盲区）；node_modules 内为 npm registry 发布代码与 workspace 源码副本",
  },
  signing: manifest.signing,
  durationMs: Date.now() - startedAt,
};
writeFileSync(
  join(OUT_DIR, `build-report-${PLATFORM}.json`),
  `${JSON.stringify(buildReport, null, 2)}\n`,
);

rmSync(extractDir, { recursive: true, force: true });
const archiveMb = (statSync(archivePath).size / (1024 * 1024)).toFixed(1);
process.stdout.write(
  [
    ``,
    `package-installer: 构建完成（${String(((Date.now() - startedAt) / 1000).toFixed(1))}s）`,
    `  ${archivePath}（${archiveMb} MiB）`,
    `  SHA256 ${archiveSha}`,
    `  裁剪的平台 esbuild 包：${prunedEsbuild.length === 0 ? "无" : prunedEsbuild.join(", ")}`,
    `  签名状态：未签名 / 未公证（如实记录）`,
    ``,
  ].join("\n"),
);
process.exit(0);
