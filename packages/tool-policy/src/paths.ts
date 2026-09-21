/**
 * 路径规范化与包含性校验（tool-policy 的安全校验基础）。
 *
 * 输入路径不可信：可能包含 `..`、相对段、符号链接、大小写差异、
 * 重复/尾部斜杠，或指向尚不存在的目标（写入前的常见形态）。
 *
 * 规范化算法（canonicalizePath）—— 物理逐段解析，全程不做词性折叠：
 *
 * 绝对禁止先把输入交给 path.resolve / path.normalize / Node 默认的
 * JS realpath：三者都会**先做词法 `..` 折叠**，把 `ws/link/../f`
 * （link → 外部目录）错折成 `ws/f`（workspace 之内），而 OS 实际解析
 * 到外部位置——这是逃逸向量。实测依据：Node 24.21.0 / darwin 25 上
 * fs.realpathSync("/rp/ws2/link/../f.txt")（JS 实现）返回 ws2/f.txt，
 * realpathSync.native（libuv/OS POSIX 语义）返回真实位置。
 *
 * 实际算法：从物理根（"/" 或已解析的 cwd）出发，逐段处理输入：
 * 1. "" / "." 跳过；".." 弹出**当前物理路径**的父目录（current 每步
 *    都已解析符号链接，弹出的是物理父目录，与 OS 语义一致；根的
 *    ".." 钳制在根）。
 * 2. 普通段：先 lstat（不跟随符号链接）确认该名字存在于目录项中，
 *    再 realpathSync.native 解析到物理位置（解析末段符号链接、
 *    收敛大小写，见下）。
 * 3. lstat ENOENT/ENOTDIR：进入「不存在后缀」模式——剩余段全部
 *    词法拼接到当前物理路径之后。后缀的父目录不存在，因此后缀中
 *    不可能有符号链接；**但若后缀中还有 ".."，直接返回 null**：
 *    OS 打开这种形态必然 ENOENT/ENOTDIR（内核不做词法折叠），
 *    词法折叠会预测一个 OS 根本不会访问的位置，fail closed 才是
 *    如实的行为。
 * 4. lstat 成功但 realpath 失败：dangling symlink（或竞态删除/权限）
 *    → 返回 null。写入目标是悬空符号链接时，O_CREAT 会穿透到链接
 *    目标位置创建文件，策略层无法可靠判定，一律拒绝。
 *
 * 大小写语义（实测 macOS darwin 25 / APFS + realpathSync.native）：
 * - **已存在组件**经 OS realpath 收敛到盘上真实大小写（输入
 *   .../CASEPROBE 返回 .../CaseProbe）。因此在大小写不敏感的文件
 *   系统上，root 部分大小写不一致的请求会收敛并与配置 root 匹配
 *   （OS 也确实能解析到该目录，判定为 allow 是如实的）；
 * - **不存在后缀**保留输入大小写（没有盘上形态可对齐）。因此
 *   大小写敏感的文件系统上 root 部分不一致 → 保留 → 前缀不匹配 →
 *   拒绝（fail closed，OS 也确实 ENOENT）；不存在的新文件之间，
 *   大小写不同的目标不互相匹配授权（严格方向）。
 * 包含性比较（isPathWithin）因此按**精确字符串前缀**进行即可：
 * 在能被 OS 验证的情形里 canonical 已收敛，在不能验证的情形里
 * fail closed。
 *
 * 保证：返回值为绝对路径、无 `.`/`..`/重复斜杠，且到最后一个已存在
 * 组件为止不含符号链接。任何解析失败返回 null——调用方必须把 null
 * 当作「拒绝」，绝不能当作「在范围内」。
 *
 * 安全表述：这是应用层策略的路径校验，**不是 OS 沙箱，不构成安全边界**。
 * 竞态（TOCTOU）、硬链接、挂载点等绕过手段见 README「不能防御的风险」。
 */
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, parse, resolve, sep } from "node:path";

function joinSegments(root: string, segments: readonly string[]): string {
  let out = root;
  for (const segment of segments) {
    // 调用方已保证不含 ".."；空段（来自重复斜杠）与 "." 无害跳过。
    if (segment === "" || segment === ".") continue;
    out = out.endsWith(sep) ? out + segment : out + sep + segment;
  }
  return out;
}

/**
 * 从一个**已物理解析**的起点（无符号链接、无 `.`/`..`）出发，
 * 逐段处理输入段，返回物理 canonical 路径；无法可靠解析返回 null。
 */
function resolveFrom(current: string, segments: readonly string[]): string | null {
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === undefined) break;
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      // current 已是物理路径：弹出物理父目录与 OS 语义一致。
      // dirname("/") === "/"：根的 ".." 钳制在根。
      current = dirname(current);
      continue;
    }
    const candidate = current.endsWith(sep) ? current + segment : current + sep + segment;
    let exists: boolean;
    try {
      lstatSync(candidate);
      exists = true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        // 名字不存在（或父级是文件）：进入不存在后缀模式。
        exists = false;
      } else {
        // EACCES 等其他错误：无法判定 → fail closed。
        return null;
      }
    }
    if (!exists) {
      const rest = segments.slice(i);
      // 后缀中不得再出现 ".."：OS 打开这种形态必然失败（内核不做
      // 词法折叠），词法折叠会预测一个 OS 不会访问的位置 → fail closed。
      if (rest.includes("..")) return null;
      return joinSegments(current, rest);
    }
    try {
      // native = libuv/OS POSIX 语义（先解析符号链接再应用 `..`、
      // 收敛已存在组件的盘上大小写）。绝不可用 Node 默认的 JS 实现
      // 或 path.resolve/normalize 预处理输入，见文件头注释。
      current = realpathSync.native(candidate);
    } catch {
      // dangling symlink / 竞态删除 / 权限问题 → fail closed。
      return null;
    }
  }
  return current;
}

/**
 * 把输入路径规范化为 canonical 绝对路径。
 *
 * @returns canonical 路径；无法可靠解析（悬空符号链接、不存在后缀
 *          含 `..`、权限错误、非字符串/空输入）时返回 null。
 *          调用方对 null 一律拒绝。
 */
export function canonicalizePath(input: string, cwd?: string): string | null {
  if (typeof input !== "string" || input.length === 0) return null;
  if (isAbsolute(input)) {
    return resolveFrom(parse(input).root || sep, input.split(sep));
  }
  let base = cwd ?? process.cwd();
  if (!isAbsolute(base)) {
    // cwd 由调用方（配置）提供；进程 cwd 本身是物理路径，这里对
    // 相对 cwd 只做绝对化。不可信输入永远走上面的 input 分支。
    base = resolve(process.cwd(), base);
  }
  const baseCanonical = resolveFrom(parse(base).root || sep, base.split(sep));
  if (baseCanonical === null) return null;
  return resolveFrom(baseCanonical, input.split(sep));
}

/**
 * 包含性检查：canonical target 是否位于 canonical root 之内（含 root 本身）。
 *
 * 两个输入都必须先经过 canonicalizePath。前缀比较按字符串精确匹配
 * （大小写语义见文件头：已存在组件已被收敛，不可验证的情形 fail
 * closed，精确比较因此既如实又安全）：
 * - 注意 "/a/bc" 不在 "/a/b" 内（前缀必须落在目录边界上）。
 */
export function isPathWithin(target: string, root: string): boolean {
  if (typeof target !== "string" || typeof root !== "string") return false;
  if (target === root) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return target.startsWith(prefix);
}
