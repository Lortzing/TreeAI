import type { BundleManifest, LauncherConfig, RuntimeState } from "../core.ts";
interface LauncherMaintenanceDependencies {
 readonly BUNDLE_ROOT: string;
 fail(message: string, code?: number): never;
 requireManifest(): BundleManifest;
 out(line: string): void;
 stopInstance(reason: string): Promise<boolean>;
 dataDir(): string;
 openBrowser(url: string, opts: { noBrowser: boolean }): void;
 logLine(text: string): void;
}
/** Installer maintenance commands with the original host lifecycle Instance-owned state and dependencies. */
import { mkdirSync } from "node:fs";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { copyFileSync } from "node:fs";
import { installRootFor } from "../core.ts";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { MANIFEST_FILE_NAME } from "../core.ts";
import { readFileSync } from "node:fs";
import { statSync } from "node:fs";
import { rmSync } from "node:fs";
import { renameSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { NO_BROWSER_ENV } from "../core.ts";
import { createInterface } from "node:readline/promises";
import { appendFileSync } from "node:fs";
import { windowsSelfDeleteScript } from "../core.ts";
import { tmpdir } from "node:os";
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

export function createLauncherMaintenance(deps: LauncherMaintenanceDependencies) {



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
        if (value === undefined) deps.fail("--old 需要一个目录路径");
        oldDir = value;
        i += 1;
      } else {
        deps.fail(`upgrade 不认识的参数：${arg}（可用：--old <旧安装目录>）`);
      }
    }
    const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? ".";
    const defaultOld = installRootFor(process.platform, process.env, home);
    const oldInstall = resolve(oldDir ?? defaultOld);
    if (!existsSync(join(oldInstall, MANIFEST_FILE_NAME))) {
      deps.fail(
        `旧安装目录不存在或不是 TreeAI 安装（${oldInstall}）。` +
          "修复：运行 upgrade --old <旧安装目录> 指明旧安装；" +
          "也可以直接把本目录当作新安装使用（用户数据在数据目录，不受安装位置影响）。",
      );
    }

    const newManifest = deps.requireManifest();
    const oldRaw = JSON.parse(readFileSync(join(oldInstall, MANIFEST_FILE_NAME), "utf8")) as {
      bundleVersion?: unknown;
    };
    const oldVersion = typeof oldRaw["bundleVersion"] === "string" ? oldRaw["bundleVersion"] : "?";
    deps.out(`treeai-launcher: 升级 ${oldVersion} → ${newManifest.bundleVersion}（安装目录 ${oldInstall}）`);

    /* 1. 停止旧实例（数据目录跨版本共享）。 */
    await deps.stopInstance("upgrade");

    /* 2. 备份旧安装 → 3. 放置新版本；任一步失败即恢复备份。 */
    const backup = `${oldInstall}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    try {
      if (!statSync(oldInstall).isDirectory()) {
        throw new Error(`旧安装不是目录：${oldInstall}`);
      }
      rmSync(backup, { recursive: true, force: true });
      renameSync(oldInstall, backup);
      copyDir(deps.BUNDLE_ROOT, oldInstall);
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
      deps.fail(
        `升级失败（放置新版本出错）：${message}；旧安装已尽量恢复（备份在 ${backup}）。` +
          `数据目录未受影响（${deps.dataDir()}）`,
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
      deps.out("treeai-launcher: 新版本健康检查未通过，已回滚到旧版本。新版本输出：");
      deps.out(probeText.trim() || "(无输出)");
      deps.fail(
        `升级失败已回滚（旧版本 ${oldVersion} 已恢复）。数据目录未受影响（${deps.dataDir()}）。` +
          "请把上面的输出反馈给开发者。",
      );
    }

    deps.out(
      `treeai-launcher: 升级成功：${newManifest.bundleVersion} 已启动并通过健康检查（旧版本备份：${backup}）`,
    );
    deps.out(`treeai-launcher: 用户数据未做任何改动：${deps.dataDir()}`);
    const urlMatch = /url=(http:\/\/127\.0\.0\.1:\d+)/.exec(probeText);
    if (urlMatch !== null) {
      deps.out(`treeai-launcher: url=${urlMatch[1]}`);
      deps.openBrowser(urlMatch[1]!, { noBrowser: false });
    } else {
      deps.fail("升级成功但无法解析新实例 URL（内部探针输出异常）——请运行 doctor 检查");
    }
    deps.logLine(`upgrade ${oldVersion} -> ${newManifest.bundleVersion} ok`);
    return 0;
  }


  /* ------------------------------------------------------------------ */
  /* uninstall                                                          */
  /* ------------------------------------------------------------------ */

  async function cmdUninstall(args: readonly string[]): Promise<number> {
    let deleteData = false;
    for (const arg of args) {
      if (arg === "--delete-data") deleteData = true;
      else deps.fail(`uninstall 不认识的参数：${arg}（可用：--delete-data）`);
    }
    await deps.stopInstance("uninstall");

    const dir = deps.dataDir();
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
            deps.out("treeai-launcher: 已改为保留数据。");
          }
        } finally {
          rl.close();
        }
      }
      if (deleteData) {
        /* 先记日志再删目录：logLine 会重建 logs/ 子目录，顺序颠倒会把刚删的
           数据目录又建出来（冒烟已抓到过这个回归）。 */
        deps.logLine(`uninstall delete-data ${dir}`);
        rmSync(dir, { recursive: true, force: true });
        deps.out(`treeai-launcher: 已删除数据目录 ${dir}`);
      } else {
        deps.logLine("uninstall keep-data");
        deps.out(
          `treeai-launcher: 用户数据已保留：${dir}（重新安装任意版本即可继续使用；确认不要了可手动删除该目录）`,
        );
      }
    } else {
      deps.logLine("uninstall keep-data (default)");
      deps.out(
        `treeai-launcher: 用户数据已保留：${dir}（重新安装任意版本即可继续使用；确认不要了可手动删除该目录）`,
      );
    }

    /* 自删除：POSIX 直接删（脚本已读入内存）；Windows 分两段。段一在本进程
     * 内同步删除 node/ 以外的一切——运行中的 node.exe 是唯一被锁文件（本进程
     * 自身；CWD 不在本目录），app/ 的 node_modules 深路径由 Node 的 rmSync 处
     * 理（libuv 走 \\?\ 前缀，不受 MAX_PATH 限制）。段二把 node/ 与根目录交
     * 给分离 PowerShell 收尾。不能把全部删除押在分离进程上：CI runner 实测
     * 它三版脚本零日志零删除（run 36760164991/36764463430——进程疑似从未起
     * 来）。两段都写数据目录日志（--delete-data 后数据目录已删，写失败静默）。 */
    if (process.platform === "win32") {
      const logPath = join(deps.dataDir(), "uninstall-selfdelete.log");
      const logLineSelf = (message: string) => {
        try {
          appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
        } catch {
          /* 数据目录已删除（--delete-data）或不可写：诊断日志尽力而为 */
        }
      };
      try {
        /* 跳过仍在本执行链上的文件：node/（运行中的 node.exe 唯一被锁处）
         * 与 cmd 正在逐行读取的入口 .bat（uninstall.bat 直呼或 treeai.bat
         * 通用入口）/ 它们调用的 treeai.ps1——cmd.exe 增量读 .bat，删掉它
         * 会出现 "The batch file cannot be found" 且退出码非 0（run
         * 36768819745 实测）；这四项交由分离 PowerShell 收尾。 */
        const keep = new Set(["node", "uninstall.bat", "treeai.bat", "treeai.ps1"]);
        const before = readdirSync(deps.BUNDLE_ROOT);
        for (const entry of before) {
          if (keep.has(entry)) continue;
          rmSync(join(deps.BUNDLE_ROOT, entry), { recursive: true, force: true });
        }
        const left = readdirSync(deps.BUNDLE_ROOT);
        logLineSelf(`launcher-stage removed ${String(before.length - left.length)}/${String(before.length)} top-level, left: ${left.join(",")}`);
        deps.out(`treeai-launcher: 安装目录内容已删除（node 运行时与入口脚本随进程退出由后台收尾）：${deps.BUNDLE_ROOT}`);
      } catch (err) {
        logLineSelf(`launcher-stage failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      /* 脚本落 %TEMP% 再以 -File 调用——与 .bat → treeai.ps1 的既有工作链路
         同构（-Command 传整段脚本在 CI runner 上三版零执行，run 36764463430）。 */
      const script = windowsSelfDeleteScript(deps.BUNDLE_ROOT, logPath);
      let scriptPath = join(tmpdir(), `treeai-uninst-${String(process.pid)}.ps1`);
      try {
        writeFileSync(scriptPath, script, { encoding: "utf8" });
      } catch {
        scriptPath = join(deps.BUNDLE_ROOT, "uninst.ps1");
        try {
          writeFileSync(scriptPath, script, { encoding: "utf8" });
        } catch (err) {
          logLineSelf(`script-stage write failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const child = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
      logLineSelf(`handoff spawned powershell -File ${scriptPath} (pid=${String(child.pid)})`);
      deps.out(`treeai-launcher: 安装目录删除已排队（Windows 需等本进程退出后完成）：${deps.BUNDLE_ROOT}`);
    } else {
      rmSync(deps.BUNDLE_ROOT, { recursive: true, force: true });
      deps.out(`treeai-launcher: 已删除安装目录 ${deps.BUNDLE_ROOT}`);
    }
    /* 不再 logLine：--delete-data 后数据目录已删除，写日志会把它重建出来。 */
    return 0;
  }

  return {
    cmdUpgrade,
    cmdUninstall,
  };
}
