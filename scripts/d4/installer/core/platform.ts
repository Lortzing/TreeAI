/** platform ownership for core.ts; compatibility entrypoint remains one level above. */
import type {
  NodeDistSpec,
  TargetPlatform,
} from "./model.ts";
import {
  DATA_DIR_ENV,
  DATA_DIR_NAME,
  NODE_DIST_BASE_URL,
  PLATFORM_SPECS,
} from "./policy.ts";
import {
  join,
} from "node:path";

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
