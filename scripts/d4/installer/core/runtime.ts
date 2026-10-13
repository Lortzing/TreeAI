/** runtime ownership for core.ts; compatibility entrypoint remains one level above. */
import type {
  RuntimeState,
} from "./model.ts";
import {
  lstatSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  join,
} from "node:path";

export function parseRuntimeState(text: string): RuntimeState | null {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (
      typeof raw["pid"] === "number" &&
      typeof raw["port"] === "number" &&
      typeof raw["url"] === "string" &&
      typeof raw["startedAt"] === "string" &&
      typeof raw["bundleVersion"] === "string"
    ) {
      return {
        pid: raw["pid"],
        port: raw["port"],
        url: raw["url"],
        startedAt: raw["startedAt"],
        bundleVersion: raw["bundleVersion"],
      };
    }
  } catch {
    return null;
  }
  return null;
}

/** 判断一个进程 pid 是否存活（POSIX 与 Windows 通用：process.kill(pid, 0)）。 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err !== null && typeof err === "object" && (err as { code?: string }).code === "EPERM";
  }
}

/** 目录可写探针（doctor 用）：写入并删除一个临时文件。 */
export function probeDirectoryWritable(dir: string): { ok: boolean; detail: string } {
  try {
    const probe = join(dir, `.treeai-write-probe-${String(process.pid)}-${String(Date.now())}`);
    writeFileSync(probe, "probe", { flag: "wx" });
    rmSync(probe, { force: true });
    return { ok: true, detail: "可写" };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** lstat 便捷导出（launcher/构建侧共用，避免重复 import 纪律漂移）。 */
export function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
