/** bundle ownership for core.ts; compatibility entrypoint remains one level above. */
import type {
  BundleManifest,
  TargetPlatform,
} from "./model.ts";
import {
  BUNDLE_LAYOUT,
  BUNDLE_MANIFEST_SCHEMA,
  MANIFEST_FILE_NAME,
  PLATFORM_SPECS,
  TARGET_PLATFORMS,
} from "./policy.ts";
import {
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import {
  join,
} from "node:path";

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
  for (const [name, path] of Object.entries(BUNDLE_LAYOUT)) {
    if (name.startsWith("launcher") && name !== "launcherCore" && name !== "launcherEntry" && typeof path === "string") mustExist(path, "启动器模块");
  }
  mustExist(BUNDLE_LAYOUT.appEntry, "studio 服务入口");
  mustExist(BUNDLE_LAYOUT.publicIndex, "studio 静态前端");
  mustExist(BUNDLE_LAYOUT.studioPackageJson, "studio package.json");
  mustExist(BUNDLE_LAYOUT.eventJournalDistEntry, "event-journal 预编译产物");
  mustExist(BUNDLE_LAYOUT.piSdkPackageJson, "Pi SDK npm 包");
  mustExist(BUNDLE_LAYOUT.pdfjsMain, "本地 PDF.js display 模块");
  mustExist(BUNDLE_LAYOUT.pdfjsWorker, "本地 PDF.js worker");
  mustExist(BUNDLE_LAYOUT.pdfjsCmaps, "PDF.js CMap 资源");
  mustExist(BUNDLE_LAYOUT.pdfjsStandardFonts, "PDF.js 标准字体资源");
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
