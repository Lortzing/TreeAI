/**
 * TreeAI D4-7 — 产物入口脚本（shim）模板与 README 生成。
 *
 * 打包脚本（scripts/d4/package-installer.mjs）把这些内容物化为产物根目录的
 * 平台入口文件。所有 shim 都是薄封装：定位产物目录 → 用产物内固定版本的
 * node 执行 launcher/launcher.ts <子命令>。真实逻辑全部在 launcher.ts，
 * 三个平台不各自重复实现（避免三份漂移的脚本）。
 *
 * 路径纪律：shim 一律用引号包裹自身路径，中文/空格路径必须可用。
 */

import type { TargetPlatform } from "./core.ts";

export interface ShimFile {
  readonly path: string;
  readonly mode: 0o755 | 0o644;
  readonly content: string;
}

function posixTreeaiSh(): ShimFile {
  return {
    path: "treeai.sh",
    mode: 0o755,
    content: `#!/bin/bash
# TreeAI Studio 通用入口（macOS / Linux）。用法：./treeai.sh <start|stop|restart|status|doctor|paths|upgrade|uninstall> [参数]
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
exec "$HERE/node/bin/node" "$HERE/launcher/launcher.ts" "$@"
`,
  };
}

function posixCommandShim(
  command: string,
  subcommand: string,
  doctorEntry: string,
  pause: boolean,
): ShimFile {
  const pauseBlock = pause
    ? `\n# 双击运行时给用户一个看清输出的机会（在 Terminal 里手动执行时不暂停）。\nif [ -t 0 ]; then\n  printf '\\n按回车键关闭本窗口… '\n  IFS= read -r _reply || true\nfi\n`
    : "";
  return {
    path: command,
    mode: 0o755,
    content: `#!/bin/bash
# TreeAI Studio — ${subcommand}（双击或终端执行；自动定位脚本所在目录，支持中文/空格路径）
HERE="$(cd "$(dirname "$0")" && pwd)"
set +e
"$HERE/treeai.sh" ${subcommand} "$@"
exit_code=$?
set -e
if [ "$exit_code" -ne 0 ]; then
  printf '\\n操作失败（退出码 %s）。可运行诊断：\\n  %s/${doctorEntry}\\n' "$exit_code" "$HERE"
fi${pauseBlock}
exit "$exit_code"
`,
  };
}

function windowsTreeaiPs1(): ShimFile {
  return {
    path: "treeai.ps1",
    mode: 0o644,
    content: `# TreeAI Studio 通用入口（Windows PowerShell）。
# 用法：.\\treeai.ps1 <start|stop|restart|status|doctor|paths|upgrade|uninstall> [参数]
param(
  [Parameter(Position = 0)][string]$Command = "start",
  [Parameter(ValueFromRemainingArguments = $true)]$Rest
)
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
# 参数必须先拼成数组再以 @var 展开：PowerShell 命令模式下的裸 "+" 会被当作
# 字面参数传给 node（CI win-x64 实测 start 不认识的参数：+）。$Rest 无剩余
# 参数时可能为 $null，过滤后 splat。
$nodeArgs = @($Command) + @($Rest)
$nodeArgs = @($nodeArgs | Where-Object { $null -ne $_ })
& (Join-Path $root "node\\node.exe") (Join-Path $root "launcher\\launcher.ts") @nodeArgs
exit $LASTEXITCODE
`,
  };
}

function windowsTreeaiBat(): ShimFile {
  return {
    path: "treeai.bat",
    mode: 0o644,
    content: `@echo off
rem TreeAI Studio 通用入口（Windows，PowerShell 垫片）。
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0treeai.ps1" %*
exit /b %ERRORLEVEL%
`,
  };
}

function windowsCommandBat(subcommand: string): ShimFile {
  return {
    path: `${subcommand}.bat`,
    mode: 0o644,
    content: `@echo off
rem TreeAI Studio — ${subcommand}
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0treeai.ps1" ${subcommand} %*
exit /b %ERRORLEVEL%
`,
  };
}

/** 各平台的入口脚本集合（start/stop/restart/doctor/upgrade/uninstall + 通用入口）。 */
export function shimFilesFor(platform: TargetPlatform): ShimFile[] {
  if (platform === "win-x64") {
    return [
      windowsTreeaiPs1(),
      windowsTreeaiBat(),
      windowsCommandBat("start"),
      windowsCommandBat("stop"),
      windowsCommandBat("restart"),
      windowsCommandBat("doctor"),
      windowsCommandBat("upgrade"),
      windowsCommandBat("uninstall"),
    ];
  }
  const extension = platform === "darwin-arm64" ? "command" : "sh";
  const doctorEntry = `doctor.${extension}`;
  const files: ShimFile[] = [posixTreeaiSh()];
  // macOS 的 .command 双击运行完窗口即关：start/doctor 等需要用户读输出的
  // 命令加「按回车关闭」暂停；stop/uninstall 等短命令不暂停。
  const pauseCommands = new Set(["start", "doctor", "upgrade"]);
  for (const subcommand of ["start", "stop", "restart", "doctor", "upgrade", "uninstall"]) {
    files.push(
      posixCommandShim(
        `${subcommand}.${extension}`,
        subcommand,
        doctorEntry,
        pauseCommands.has(subcommand),
      ),
    );
  }
  return files;
}

/**
 * 产物 README（中文）。如实记录签名/公证状态（absent）与 Gatekeeper /
 * SmartScreen 的应对办法——不要求用户关闭系统安全保护。
 */
export function bundleReadme(opts: {
  bundleVersion: string;
  platform: TargetPlatform;
  nodeVersion: string;
  dataDir: string;
  installRoot: string;
  builtAt: string;
  gitCommit: string;
}): string {
  const isWindows = opts.platform === "win-x64";
  const isMac = opts.platform === "darwin-arm64";
  const entry = isWindows ? "start.bat" : isMac ? "start.command" : "start.sh";
  const doctor = isWindows ? "doctor.bat" : isMac ? "doctor.command" : "doctor.sh";
  const stop = isWindows ? "stop.bat" : isMac ? "stop.command" : "stop.sh";
  const restart = isWindows ? "restart.bat" : isMac ? "restart.command" : "restart.sh";
  const upgrade = isWindows ? "upgrade.bat" : isMac ? "upgrade.command" : "upgrade.sh";
  const uninstall = isWindows ? "uninstall.bat" : isMac ? "uninstall.command" : "uninstall.sh";
  const term = isWindows ? "PowerShell / cmd" : "终端（Terminal）";
  return `# TreeAI Studio 安装包（D4-7）

- 版本：**${opts.bundleVersion}**
- 平台：${opts.platform}（支持矩阵：macOS Apple Silicon / Windows 11 x64 / Ubuntu 24.04 LTS x64；其他架构不在支持范围）
- 内置 Node 运行时：v${opts.nodeVersion}（来自 nodejs.org 官方发行包，SHA256 已核对并记录在 VERSION.json）
- 构建时间：${opts.builtAt}；源码提交：${opts.gitCommit}
- 数据目录（本机默认）：\`${opts.dataDir}\`
- 默认安装目录（升级流程按此寻找旧安装）：\`${opts.installRoot}\`

## 安装（无需克隆源码 / 手动装 Node / 编译任何东西）

1. 解压本压缩包到任意有写权限的目录（目录名可含中文和空格）。
${isMac ? "2. 若解压工具丢失了执行权限，在终端执行一次：`chmod +x *.command treeai.sh`\n3. 双击 **start.command**（或在终端运行 `./start.command`）。" : isWindows ? "2. 双击 **start.bat**（或在 PowerShell 运行 `.\\start.bat`）。" : "2. 在终端执行 `chmod +x *.sh`（如需要），然后运行 `./start.sh`。"}
3. 首次启动会：创建数据目录 → 在本机回环地址（127.0.0.1）监听（默认端口 8787，被占用时自动顺延并明确提示）→ 打开系统浏览器访问 \`http://127.0.0.1:<端口>\`。

默认是**离线回声驱动（echo）**：不需要模型、不需要 API key、不联网，可以先完整体验界面与工作流。

## 日常使用

| 操作 | 入口（${term} 或双击） |
|---|---|
| 启动 / 打开 | ${entry}（已在运行则只打开浏览器） |
| 停止 | ${stop} |
| 重启 | ${restart} |
| 诊断 | ${doctor}（node 运行时 / 数据目录 / 配置 / 端口逐项检查，问题附修复方法） |
| 升级 | 解压新版本后运行新目录里的 ${upgrade} |
| 卸载 | ${uninstall}（**默认保留用户数据**；加 \`--delete-data\` 才删除数据目录） |

## 配置真实模型（可选）

编辑数据目录里的 \`config.json\`：

\`\`\`json
{
  "schemaVersion": 1,
  "port": 8787,
  "driver": "pi",
  "provider": "<provider id，例如 anthropic>",
  "model": "<模型 id>"
}
\`\`\`

API key **只**通过环境变量 \`${"TREEAI_STUDIO_API_KEY"}\` 注入：在 ${term} 里
\`set TREEAI_STUDIO_API_KEY=…\`（Windows）或 \`export TREEAI_STUDIO_API_KEY=…\`
（macOS/Linux）后再启动；交互式启动时启动器也会提示输入（输入不回显，
只进本次进程内存，绝不写入文件、日志或数据库）。配置写错不会静默失败：
启动/doctor 会给出具体修复步骤。

## 端口冲突

默认端口 8787 被其他程序占用时，启动器自动换用下一个可用端口（8788、8789…）
并在输出里明确告知实际端口；浏览器打开的永远是实际端口。想固定端口：改
\`config.json\` 的 \`port\` 字段。

## 升级与数据安全

- 所有用户数据（数据库、材料、会话、日志、配置）都在**数据目录**，不在安装
  目录：替换/删除安装目录不影响数据。
- 升级：解压新版本 → 运行新版本的 ${upgrade}。旧安装会先停机、被完整备份为
  \`<安装目录>.backup-<时间戳>\`，新版本启动并通过健康检查后才算成功；启动
  失败会**自动回滚**到旧版本。数据目录全程不动。
- 卸载：${uninstall} 只删安装目录；\`--delete-data\` 才删数据（有确认提示）。

## 签名与公证状态（如实说明）

- 本产物**没有代码签名，也没有公证**（本仓库未购买任何签名证书）。
- macOS：从网络下载的产物首次运行可能被 Gatekeeper 拦截。处理办法（任选其一，
  都是系统支持的正规途径，**不需要关闭安全设置**）：在 Finder 里右键入口脚本
  选「打开」；或 \`${"xattr -dr com.apple.quarantine <解压目录>"}\` 后再运行。
- Windows：SmartScreen 可能提示「未知发布者」，选「仍要运行」。
- Linux：无签名机制影响。
- 产物完整性请用同目录的 SHA256SUMS.txt 核对压缩包哈希；VERSION.json 记录了
  内置 Node 发行包的官方 SHA256。

## 反馈

本安装包由 TreeAI 仓库的 D4-7 工作包产出（scripts/d4/package-installer.mjs）。
问题请附 ${doctor} 的完整输出。
`;
}
