/** shell ownership for core.ts; compatibility entrypoint remains one level above. */
import {
  BROWSER_ENV,
} from "./policy.ts";

/**
 * 选择「打开 URL」的命令。`TREEAI_BROWSER`/`BROWSER` 环境变量优先
 * （按空格拆分为命令+参数，末尾追加 URL；测试用它替换成记录器脚本）；
 * 否则用平台缺省（darwin: open / win32: cmd start / 其他: xdg-open）。
 */
export function splitBrowserCommand(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const char of value.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current !== "") {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaped) current += "\\";
  if (current !== "") parts.push(current);
  return parts;
}

export function browserCommandFor(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
): { command: string; args: readonly string[] } | null {
  const override = env[BROWSER_ENV] ?? env["BROWSER"];
  if (typeof override === "string" && override.trim() !== "") {
    const parts = splitBrowserCommand(override);
    const command = parts[0];
    if (command === undefined || command === "") return null;
    return { command, args: parts.slice(1) };
  }
  if (platform === "darwin") return { command: "open", args: [] };
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", ""] };
  return { command: "xdg-open", args: [] };
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
export function windowsSelfDeleteScript(bundleRoot: string, logPath: string): string {
  const ps = (value: string) => value.replace(/'/g, "''");
  return [
    "$target = '" + ps(bundleRoot) + "'",
    "$logPath = '" + ps(logPath) + "'",
    "function Log([string]$m) { try { Add-Content -LiteralPath $logPath -Value ((Get-Date -Format o) + ' ' + $m) -ErrorAction Stop } catch {} }",
    /* GetTempPath()（Win32 API）比 $env:TEMP 稳：环境块缺 TEMP 时仍能取到。 */
    "$empty = Join-Path ([System.IO.Path]::GetTempPath()) ('treeai-uninst-' + [guid]::NewGuid().ToString('N'))",
    "$done = $false",
    "try {",
    "  Log ('start pid=' + $PID + ' target=' + $target)",
    "  Log ('top=' + ((Get-ChildItem -LiteralPath $target -Force -ErrorAction SilentlyContinue | Select-Object -First 20 -ExpandProperty Name) -join ','))",
    "  [void](New-Item -ItemType Directory -Path $empty -Force)",
    "  for($i=0; $i -lt 40; $i++) {",
    "    [void](robocopy $empty $target /MIR /NFL /NDL /NJH /NJS /NP)",
    "    $rc = $LASTEXITCODE",
    "    if (-not (Test-Path -LiteralPath $target)) { $done = $true; break }",
    "    try { Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop; $done = $true; break }",
    "    catch {",
    "      $left = (Get-ChildItem -LiteralPath $target -Force -ErrorAction SilentlyContinue | Measure-Object).Count",
    "      Log ('attempt ' + $i + ' robocopy=' + $rc + ' left=' + $left + ' remove-failed: ' + $_.Exception.Message)",
    "      Start-Sleep -Seconds 1",
    "    }",
    "  }",
    "} catch { Log ('fatal: ' + $_.Exception.Message) }",
    "Log ('done=' + $done)",
    "[void](Remove-Item -LiteralPath $empty -Recurse -Force)",
    "if (-not $done) { exit 1 }",
    "exit 0",
  ].join("\n");
}
