import { sep, join } from "node:path";
import { realpathSync, readdirSync, readFileSync } from "node:fs";
/** browser-session-probes original runner scenarios/helpers Instance-owned state and dependencies. */

export function createBrowserSessionProbes(deps) {

  /**
   * 目录边界包含性（镜像 tool-policy paths.ts 的 isPathWithin 字符串语义）：
   * 调用方须先做物理解析（physicalPath），避免符号链接造成的假性内外。
   */
  function isPathWithin(target, root) {
    if (target === root) return true;
    return target.startsWith(root.endsWith(sep) ? root : root + sep);
  }

  /** 物理路径（realpathSync.native：OS POSIX 语义，解析符号链接）。失败 → null。 */
  function physicalPath(path) {
    try {
      return realpathSync.native(path);
    } catch {
      return null;
    }
  }

  /** 递归列出目录下所有文件（目录缺失/不可读 → 空列表；canary 扫描与
   *  sessions 快照共用——Pi SDK 的会话文件可能按模型/日期嵌套存放）。 */
  function walkFiles(dir) {
    const out = [];
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walkFiles(path));
      else if (entry.isFile()) out.push(path);
    }
    return out;
  }

  /** 树的 session 文件（全树一个 .jsonl——支线经 navigateTree 在同一文件
   *  的 entry 树上续聊，不换文件）：含指定提示词的会话文件必须恰好一个。 */
  function findTreeSessionFile(promptNeedle) {
    const candidates = walkFiles(join(deps.sc.dataDir, "sessions")).filter((path) => path.endsWith(".jsonl"));
    const hits = candidates.filter((path) => {
      try {
        return readFileSync(path, "utf8").includes(promptNeedle);
      } catch {
        return false;
      }
    });
    deps.assert(
      hits.length === 1,
      `expected exactly one tree session file containing the ${JSON.stringify(promptNeedle)} prompt, found ${String(hits.length)}`,
    );
    return hits[0];
  }

  /** session entry 树的可见性路径（真实模型下列举措辞有方差——20260929T161646Z
   *  的 b2 只回 "birch"，模型行为不构成串扰证据）：从含 promptNeedle 的用户
   *  entry 沿 parentId 走到根，收集路径上全部 message 文本。这条链正是
   *  navigateTree 续聊点的完整可见上下文——标记词在/不在路径上即上下文
   *  可见性的机械证明，与模型怎么措辞无关。 */
  function sessionEntryPathText(sessionFile, promptNeedle) {
    let entries;
    try {
      entries = readFileSync(sessionFile, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line));
    } catch (err) {
      throw new Error(`the tree session file could not be read/parsed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const byId = new Map(entries.filter((e) => typeof e.id === "string").map((e) => [e.id, e]));
    const leaf = entries.find(
      (e) =>
        e.type === "message" &&
        e.message !== null &&
        typeof e.message === "object" &&
        e.message.role === "user" &&
        JSON.stringify(e.message.content ?? "").includes(promptNeedle),
    );
    if (leaf === undefined) {
      throw new Error(`no user entry carrying the ${JSON.stringify(promptNeedle)} prompt found in the tree session file`);
    }
    const texts = [];
    let current = leaf;
    while (current !== undefined) {
      if (current.type === "message" && Array.isArray(current.message?.content)) {
        for (const part of current.message.content) {
          if (typeof part?.text === "string") texts.push(part.text);
        }
      }
      const parent = current.parentId;
      current = typeof parent === "string" ? byId.get(parent) : undefined;
    }
    return texts.join("\n");
  }

  return {
    physicalPath,
    isPathWithin,
    walkFiles,
    sessionEntryPathText,
    findTreeSessionFile,
  };
}
