import type { BundleManifest, LauncherConfig, RuntimeState } from "../core.ts";
interface LauncherDiagnosticsDependencies {
 readonly BUNDLE_ROOT: string;
 out(line: string): void;
 dataDir(): string;
 configPath(): string;
 readManifest(): { manifest: BundleManifest | null; problems: string[] };
 readConfig(): { config: LauncherConfig | null; problems: string[]; missing: boolean };
 readRuntimeState(): RuntimeState | null;
 recordedInstanceUsable(state: RuntimeState): Promise<boolean>;
 portOccupied(port: number): Promise<boolean>;
}
/** Installer diagnostics commands with the original host lifecycle Instance-owned state and dependencies. */
import { join } from "node:path";
import { DATA_DIR_FILES } from "../core.ts";
import { installRootFor } from "../core.ts";
import { validateBundleLayout } from "../core.ts";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { probeDirectoryWritable } from "../core.ts";
import { validateLauncherConfig } from "../core.ts";
import { PI_API_KEY_ENV } from "../core.ts";
import { DEFAULT_PORT } from "../core.ts";

export function createLauncherDiagnostics(deps: LauncherDiagnosticsDependencies) {


  async function cmdPaths(): Promise<number> {
    const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? ".";
    deps.out(`treeai-launcher: bundle=${deps.BUNDLE_ROOT}`);
    deps.out(`treeai-launcher: data=${deps.dataDir()}`);
    deps.out(`treeai-launcher: config=${deps.configPath()}`);
    deps.out(`treeai-launcher: studio-log=${join(deps.dataDir(), DATA_DIR_FILES.studioLog)}`);
    deps.out(`treeai-launcher: install-root-default=${installRootFor(process.platform, process.env, home)}`);
    deps.out(`treeai-launcher: node=${process.execPath} (${process.version})`);
    return 0;
  }


  /* ------------------------------------------------------------------ */
  /* doctor                                                             */
  /* ------------------------------------------------------------------ */

  async function cmdDoctor(): Promise<number> {
    let failures = 0;
    const problem = (text: string): void => {
      failures += 1;
      deps.out(`  ✗ ${text}`);
    };
    const fine = (text: string): void => {
      deps.out(`  ✓ ${text}`);
    };
    const warn = (text: string): void => {
      deps.out(`  ! ${text}`);
    };

    deps.out("treeai-launcher: doctor — D4-7 诊断");

    /* 1. 产物清单与布局 */
    const { manifest, problems: manifestProblems } = deps.readManifest();
    if (manifest === null) {
      for (const p of manifestProblems) problem(p);
    } else {
      fine(
        `产物清单：bundle ${manifest.bundleVersion}，平台 ${manifest.platform}，Node ${manifest.node.version}（git ${manifest.gitCommit.slice(0, 12)}）`,
      );
      const layoutProblems = validateBundleLayout(deps.BUNDLE_ROOT, manifest.platform);
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
    const dir = deps.dataDir();
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
    const { config, problems, missing } = deps.readConfig();
    if (missing) {
      warn(`尚未创建配置（首次 start 会生成默认离线配置于 ${deps.configPath()}）`);
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
        for (const p of validation) problem(`配置（${deps.configPath()}）：${p}`);
      }
    }

    /* 6. 端口状态 */
    const desiredPort = config?.port ?? DEFAULT_PORT;
    const state = deps.readRuntimeState();
    if (state !== null && (await deps.recordedInstanceUsable(state))) {
      fine(`已在运行 ${state.url}（换端口：stop 后改 ${deps.configPath()} 再 start）`);
    } else if (await deps.portOccupied(desiredPort)) {
      warn(
        `端口 ${String(desiredPort)} 被其他程序占用：start 会自动顺延到下一个可用端口并在输出中告知；` +
          `固定端口请改 ${deps.configPath()} 的 port 字段`,
      );
    } else {
      fine(`端口 ${String(desiredPort)} 空闲`);
    }

    deps.out("");
    if (failures === 0) {
      deps.out("treeai-launcher: doctor 结论：全部通过（! 警告不影响启动）");
      return 0;
    }
    deps.out(`treeai-launcher: doctor 结论：发现 ${String(failures)} 个问题（上面每条 ✗ 都附带了修复方法）`);
    return 1;
  }

  return {
    cmdPaths,
    cmdDoctor,
  };
}
