/**
 * paths.test.ts —— canonicalizePath / isPathWithin 单元测试。
 *
 * fixture 全部使用 os.tmpdir() 下的临时目录，after() 钩子递归清理。
 * 注意：macOS 上 os.tmpdir() 的 /var/... 前缀会被 realpath 解析为
 * /private/var/...，因此期望值一律用 realpathSync 计算的 canonical
 * 基准构造，不做裸字符串拼接。
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { canonicalizePath, isPathWithin } from "../src/index.js";

let tempRoot: string;
let canonRoot: string;

before(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "treeai-tool-policy-paths-"));
  canonRoot = (canonicalizePath(tempRoot) ?? "") as string;
  assert.ok(canonRoot.length > 0, "temp root must canonicalize");
});

after(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

test("absolute path with redundant separators and dot segments normalizes", () => {
  assert.equal(canonicalizePath("/a//b/./c/"), "/a/b/c");
});

test("root traversal clamps at filesystem root", () => {
  assert.equal(canonicalizePath("/../../../../../../.."), "/");
});

test("relative path resolves against the provided cwd", () => {
  const canonical = canonicalizePath(join("sub", "file.txt"), tempRoot);
  assert.equal(canonical, join(canonRoot, "sub", "file.txt"));
});

test("relative path without cwd resolves against process.cwd()", () => {
  const canonical = canonicalizePath("definitely-not-existing-segment");
  assert.ok(canonical !== null);
  assert.ok(
    canonical.endsWith("definitely-not-existing-segment"),
    "non-existent relative segment stays under cwd",
  );
});

test("non-existent suffix stays under the nearest existing ancestor", () => {
  mkdirSync(join(tempRoot, "ws"));
  const canonical = canonicalizePath(join(tempRoot, "ws", "new-dir", "new-file.txt"));
  assert.equal(canonical, join(canonRoot, "ws", "new-dir", "new-file.txt"));
});

test("fully existing path resolves symlinks to the real location", () => {
  const real = join(tempRoot, "real-target.txt");
  writeFileSync(real, "x");
  const link = join(tempRoot, "link-to-real.txt");
  symlinkSync(real, link);
  assert.equal(canonicalizePath(link), canonicalizePath(real));
  assert.equal(canonicalizePath(real), join(canonRoot, "real-target.txt"));
});

test("symlink escape resolves outside the linking directory", () => {
  mkdirSync(join(tempRoot, "ws-escape"));
  mkdirSync(join(tempRoot, "outside-target"));
  symlinkSync(join(tempRoot, "outside-target"), join(tempRoot, "ws-escape", "escape-link"));
  const canonical = canonicalizePath(join(tempRoot, "ws-escape", "escape-link", "data", "f.txt"));
  const canonWs = canonicalizePath(join(tempRoot, "ws-escape"));
  assert.equal(canonical, join(canonRoot, "outside-target", "data", "f.txt"));
  assert.ok(!isPathWithin(canonical ?? "", canonWs ?? ""), "escaped target is outside ws");
});

test("dot-dot after a symlink follows OS semantics, not lexical collapse", () => {
  // ws2/link -> tempRoot/outside2；因此 ws2/link/.. 的真实位置是
  // tempRoot，而不是 ws2。词法先行规范化会把 ws2/link/../f.txt 错算
  // 成 ws2/f.txt。注意：不能用 path.join 构造输入——join 同样会先做
  // 词法折叠，必须手工拼接保留 ".." 形态。
  mkdirSync(join(tempRoot, "ws2"));
  mkdirSync(join(tempRoot, "outside2"));
  symlinkSync(join(tempRoot, "outside2"), join(tempRoot, "ws2", "link"));
  const messy = `${tempRoot}/ws2/link/../f.txt`;
  const canonical = canonicalizePath(messy);
  assert.equal(canonical, join(canonRoot, "f.txt"));
  assert.notEqual(canonical, join(canonRoot, "ws2", "f.txt"));
});

test("dangling symlink as final target is unresolvable (null)", () => {
  symlinkSync(join(tempRoot, "never-created-target.txt"), join(tempRoot, "dangling.txt"));
  assert.equal(canonicalizePath(join(tempRoot, "dangling.txt")), null);
});

test("dangling symlink as intermediate component is unresolvable (null)", () => {
  symlinkSync(join(tempRoot, "never-created-dir"), join(tempRoot, "dangling-dir"));
  assert.equal(canonicalizePath(join(tempRoot, "dangling-dir", "x.txt")), null);
});

test("path under a file component stays under it lexically (OS would fail)", () => {
  writeFileSync(join(tempRoot, "plain-file.txt"), "x");
  const canonical = canonicalizePath(join(tempRoot, "plain-file.txt", "sub"));
  // OS 打开该路径必然 ENOTDIR；规范化结果仍位于 tempRoot 词法之下，
  // 不构成逃逸。
  assert.equal(canonical, join(canonRoot, "plain-file.txt", "sub"));
});

test("empty input returns null (fail closed)", () => {
  assert.equal(canonicalizePath(""), null);
});

test("大小写语义：已存在组件收敛到盘上真实大小写，不存在后缀保留输入大小写", () => {
  mkdirSync(join(tempRoot, "CaseProbe"));
  const caseInsensitive = existsSync(join(tempRoot, "CASEPROBE"));
  const canonical = canonicalizePath(join(tempRoot, "CASEPROBE"));
  assert.ok(canonical !== null);
  if (caseInsensitive) {
    // 大小写不敏感 FS（macOS 默认 APFS）：OS realpath 把已存在组件
    // 收敛到盘上真实大小写（实测 Node 24.21.0 / darwin 25），
    // canonical 与真实目录一致，包含性成立——OS 也确实能解析到
    // 该目录，这是如实的判定。
    assert.equal(canonical, join(canonRoot, "CaseProbe"));
    assert.equal(isPathWithin(canonical, join(canonRoot, "CaseProbe")), true);
  } else {
    // 大小写敏感 FS（Linux 默认）：CASEPROBE 不存在 → 保留输入大小写
    // 作为不存在后缀 → 与真实目录名不相等 → 包含性失败（fail closed，
    // OS 也确实 ENOENT）。
    assert.equal(canonical, join(canonRoot, "CASEPROBE"));
    assert.equal(isPathWithin(canonical, join(canonRoot, "CaseProbe")), false);
  }
  // 不存在后缀在两种平台都保留输入大小写（没有盘上形态可对齐）：
  // 大小写不同的新目标不互相匹配（fail closed 的严格方向）。
  const suffixCanonical = canonicalizePath(join(tempRoot, "CaseProbe", "NEW-FILE.TXT"));
  assert.equal(suffixCanonical, join(canonRoot, "CaseProbe", "NEW-FILE.TXT"));
});

test("不存在后缀中的 `..` 不可解析（fail closed）", () => {
  // OS 打开 `<存在>/<不存在>/../f` 必然 ENOENT（内核不做词法折叠）；
  // 词法折叠会预测一个 OS 不会访问的位置，因此返回 null。
  // 手工拼接保留 ".."（path.join 会先词法折叠）。
  assert.equal(canonicalizePath(`${tempRoot}/no-such-dir/../f.txt`), null);
  assert.equal(canonicalizePath(`${tempRoot}/no-such-dir/sub/../f.txt`), null);
  // 对照：已存在组件后的 `..` 是物理语义，正常解析。
  mkdirSync(join(tempRoot, "real-dir"));
  assert.equal(
    canonicalizePath(join(tempRoot, "real-dir", "..", "f2.txt")),
    join(canonRoot, "f2.txt"),
  );
});

test("isPathWithin: containment boundaries", () => {
  assert.equal(isPathWithin("/a/b", "/a/b"), true);
  assert.equal(isPathWithin("/a/b/c.txt", "/a/b"), true);
  assert.equal(isPathWithin("/a/bc", "/a/b"), false, "sibling prefix must not match");
  assert.equal(isPathWithin("/a", "/a/b"), false, "parent is not within child");
  assert.equal(isPathWithin("/x", "/a/b"), false);
  assert.equal(isPathWithin("/a/b/", "/a/b"), true);
});
