/**
 * policy.test.ts —— ToolPolicyEngine 决策矩阵单元测试。
 *
 * 覆盖任务书 Agent D「必须测试」：
 * 未配置全部拒绝 / fixtures 读取允许 / 未授权目录 / 目录穿越 /
 * 符号链接逃逸 / shell 与 network 默认拒绝 / workspace 外写入拒绝 /
 * 授权只对目标操作、目标路径和有效期生效。
 *
 * fixture 全部使用 os.tmpdir() 下的临时目录，after() 钩子递归清理。
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import type { ToolActionCategory, ToolDecision } from "@treeai/contracts";
import {
  canonicalizePath,
  createToolPolicy,
  DEFAULT_TOOL_POLICY_CONFIG,
  RULE_IDS,
} from "../src/index.js";

let tempRoot: string;
let canonRoot: string;
let fixtures: string;
let canonFixtures: string;
let ws: string;
let canonWs: string;
let outside: string;

before(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "treeai-tool-policy-policy-"));
  canonRoot = canonicalizePath(tempRoot) ?? "";
  fixtures = join(tempRoot, "fixtures");
  ws = join(tempRoot, "ws");
  outside = join(tempRoot, "outside");
  mkdirSync(fixtures);
  mkdirSync(ws);
  mkdirSync(outside);
  writeFileSync(join(fixtures, "file.txt"), "fixture file content");
  writeFileSync(join(outside, "outside-file.txt"), "outside file content");
  // 指向授权目录之外的符号链接（逃逸探针）。
  symlinkSync(join(outside, "outside-file.txt"), join(fixtures, "escape-link.txt"));
  // 悬空符号链接（不可解析探针）。
  symlinkSync(join(outside, "never-created.txt"), join(fixtures, "dangling.txt"));
  assert.ok(canonRoot.length > 0);
  canonFixtures = canonicalizePath(fixtures) ?? "";
  canonWs = canonicalizePath(ws) ?? "";
});

after(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function makeEngine() {
  return createToolPolicy({ readRoots: [fixtures], workspaceRoots: [ws] });
}

/* ------------------------------------------------------------------ */
/* 1. 默认 deny：未配置全部拒绝                                          */
/* ------------------------------------------------------------------ */

test("默认配置下全部类别拒绝（DEFAULT_TOOL_POLICY_CONFIG）", () => {
  const engine = createToolPolicy(DEFAULT_TOOL_POLICY_CONFIG);
  const somePath = join(outside, "some-file.txt");
  const decisions: ToolDecision[] = [
    engine.evaluate({ category: "read", targetPath: somePath }),
    engine.evaluate({ category: "write", targetPath: somePath }),
    engine.evaluate({ category: "shell", command: "ls -la" }),
    engine.evaluate({ category: "network", host: "example.invalid" }),
    engine.evaluate({ category: "other-high-risk", targetPath: somePath, action: "delete" }),
  ];
  for (const decision of decisions) {
    assert.equal(decision.outcome, "deny");
    assert.equal(decision.ruleId, null, "默认拒绝的 ruleId 必须为 null");
  }
  // 空配置对象同样全拒绝（缺省即 DEFAULT）。
  const emptyEngine = createToolPolicy();
  assert.equal(emptyEngine.evaluate({ category: "read", targetPath: somePath }).outcome, "deny");
});

test("readRoots 为空时 fixtures 式目录也拒绝（目录必须由调用方显式传入）", () => {
  const engine = createToolPolicy({ workspaceRoots: [ws] });
  const decision = engine.evaluate({ category: "read", targetPath: join(fixtures, "file.txt") });
  assert.equal(decision.outcome, "deny");
  assert.equal(decision.ruleId, null);
});

/* ------------------------------------------------------------------ */
/* 2. fixtures 读取允许                                                  */
/* ------------------------------------------------------------------ */

test("fixtures 目录内读取允许", () => {
  const engine = makeEngine();
  const decision = engine.evaluate({ category: "read", targetPath: join(fixtures, "file.txt") });
  assert.equal(decision.outcome, "allow");
  assert.equal(decision.category, "read");
  assert.equal(decision.risk, "low");
  assert.equal(decision.ruleId, RULE_IDS.allowReadRoots);
  assert.deepEqual(decision.scope.roots, [canonFixtures]);
  assert.ok(Object.isFrozen(decision), "决定对象应不可变");
});

test("readRoot 内尚不存在的目标路径也可评估（规范化到最近存在祖先）", () => {
  const engine = makeEngine();
  const decision = engine.evaluate({
    category: "read",
    targetPath: join(fixtures, "not-yet-created", "file.txt"),
  });
  assert.equal(decision.outcome, "allow");
});

/* ------------------------------------------------------------------ */
/* 3. 未授权目录 / 目录穿越 / 符号链接逃逸拒绝                            */
/* ------------------------------------------------------------------ */

test("授权目录之外的读取拒绝", () => {
  const engine = makeEngine();
  const decision = engine.evaluate({ category: "read", targetPath: join(outside, "outside-file.txt") });
  assert.equal(decision.outcome, "deny");
  assert.equal(decision.ruleId, null);
  assert.deepEqual(decision.scope.roots, []);
});

test("`..` 穿越出 read root 拒绝", () => {
  const engine = makeEngine();
  // 手工拼接保留 ".."（path.join 会先词法折叠，穿越形态就丢了）：
  // fixtures/../outside/outside-file.txt 的物理解析结果在 root 之外。
  const messy = `${fixtures}/../outside/outside-file.txt`;
  const decision = engine.evaluate({ category: "read", targetPath: messy });
  assert.equal(decision.outcome, "deny");
});

test("符号链接逃逸拒绝（链接位于 read root 内、真实位置在外）", () => {
  const engine = makeEngine();
  const decision = engine.evaluate({ category: "read", targetPath: join(fixtures, "escape-link.txt") });
  assert.equal(decision.outcome, "deny");
});

test("read 请求缺失目标路径拒绝（fail closed）", () => {
  const engine = makeEngine();
  const decision = engine.evaluate({ category: "read" });
  assert.equal(decision.outcome, "deny");
});

test("read 目标不可规范化（悬空符号链接）拒绝", () => {
  const engine = makeEngine();
  const decision = engine.evaluate({ category: "read", targetPath: join(fixtures, "dangling.txt") });
  assert.equal(decision.outcome, "deny");
});

/* ------------------------------------------------------------------ */
/* 4. shell / network 默认拒绝                                           */
/* ------------------------------------------------------------------ */

test("shell 默认拒绝", () => {
  const engine = makeEngine();
  const decision = engine.evaluate({ category: "shell", command: "ls -la /" });
  assert.equal(decision.outcome, "deny");
  assert.equal(decision.risk, "high");
  assert.equal(decision.ruleId, null);
  assert.deepEqual(decision.scope.roots, []);
});

test("network 默认拒绝", () => {
  const engine = makeEngine();
  const decision = engine.evaluate({ category: "network", host: "example.invalid" });
  assert.equal(decision.outcome, "deny");
  assert.equal(decision.risk, "high");
  assert.equal(decision.ruleId, null);
});

test("显式配置 allowShell 后 shell 才允许（risk 仍为 high）", () => {
  const engine = createToolPolicy({ allowShell: true });
  const decision = engine.evaluate({ category: "shell", command: "ls" });
  assert.equal(decision.outcome, "allow");
  assert.equal(decision.risk, "high");
  assert.equal(decision.ruleId, RULE_IDS.explicitAllowShell);
});

test("显式配置 allowNetwork 后 network 才允许", () => {
  const engine = createToolPolicy({ allowNetwork: true });
  const decision = engine.evaluate({ category: "network", host: "example.invalid" });
  assert.equal(decision.outcome, "allow");
  assert.equal(decision.ruleId, RULE_IDS.explicitAllowNetwork);
});

/* ------------------------------------------------------------------ */
/* 5. workspace 外写入拒绝 / workspace 内需授权                          */
/* ------------------------------------------------------------------ */

test("workspace 外写入拒绝", () => {
  const engine = makeEngine();
  const decision = engine.evaluate({ category: "write", targetPath: join(outside, "new-file.txt") });
  assert.equal(decision.outcome, "deny");
  assert.equal(decision.risk, "high");
  assert.equal(decision.ruleId, null);
});

test("workspace 内未授权写入返回 require-approval（不是 allow）", () => {
  const engine = makeEngine();
  const decision = engine.evaluate({ category: "write", targetPath: join(ws, "out.txt") });
  assert.equal(decision.outcome, "require-approval");
  assert.equal(decision.risk, "high");
  assert.equal(decision.ruleId, RULE_IDS.writeNeedsApproval);
  assert.deepEqual(decision.scope.roots, [canonWs]);
});

test("workspace 内不存在的新路径（嵌套目录）同样 require-approval", () => {
  const engine = makeEngine();
  const decision = engine.evaluate({
    category: "write",
    targetPath: join(ws, "new-dir", "sub", "new-file.txt"),
  });
  assert.equal(decision.outcome, "require-approval");
});

test("write 目标不可规范化拒绝", () => {
  const engine = makeEngine();
  const decision = engine.evaluate({ category: "write", targetPath: join(fixtures, "dangling.txt") });
  assert.equal(decision.outcome, "deny");
});

/* ------------------------------------------------------------------ */
/* 6. 授权：目标操作 / 目标路径 / 有效期精确匹配                          */
/* ------------------------------------------------------------------ */

test("单次授权：产生一次 allow 后即消费，不可复用", () => {
  const engine = makeEngine();
  const grant = engine.authorizations.issue({
    category: "write",
    targetPath: join(ws, "single.txt"),
    expiresInMs: 60_000,
  });
  const first = engine.evaluate({ category: "write", targetPath: join(ws, "single.txt") });
  assert.equal(first.outcome, "allow");
  assert.equal(first.ruleId, `authorization-grant:${grant.grantId}`);
  const second = engine.evaluate({ category: "write", targetPath: join(ws, "single.txt") });
  assert.equal(second.outcome, "require-approval", "单次授权消费后不得复用");
});

test("限时多次授权：有效期内可复用，过期后失效", () => {
  let now = 1_000_000;
  const engine = createToolPolicy({ workspaceRoots: [ws] }, { now: () => now });
  engine.authorizations.issue({
    category: "write",
    targetPath: join(ws, "timed.txt"),
    expiresInMs: 5_000,
    singleUse: false,
  });
  assert.equal(engine.evaluate({ category: "write", targetPath: join(ws, "timed.txt") }).outcome, "allow");
  now += 4_999;
  assert.equal(engine.evaluate({ category: "write", targetPath: join(ws, "timed.txt") }).outcome, "allow");
  now += 1; // 到达 expiresAt 即失效
  assert.equal(
    engine.evaluate({ category: "write", targetPath: join(ws, "timed.txt") }).outcome,
    "require-approval",
    "到达 expiry 的授权必须失效",
  );
});

test("授权路径精确匹配：授权 A 路径不覆盖 B 路径", () => {
  const engine = makeEngine();
  engine.authorizations.issue({
    category: "write",
    targetPath: join(ws, "a.txt"),
    expiresInMs: 60_000,
  });
  const other = engine.evaluate({ category: "write", targetPath: join(ws, "b.txt") });
  assert.equal(other.outcome, "require-approval");
});

test("授权类别精确匹配：write 授权不覆盖 other-high-risk", () => {
  const engine = makeEngine();
  engine.authorizations.issue({
    category: "write",
    targetPath: join(ws, "shared.txt"),
    expiresInMs: 60_000,
  });
  const decision = engine.evaluate({
    category: "other-high-risk",
    targetPath: join(ws, "shared.txt"),
    action: "delete",
  });
  assert.equal(decision.outcome, "require-approval");
});

test("授权匹配规范化路径：等价路径形式命中同一授权", () => {
  const engine = makeEngine();
  // 注意：不能用 path.join 构造（join 会先做词法折叠），手工拼接保留
  // "./"、 "//" 与穿越已存在目录的 ".." 形态，验证签发与评估两侧都
  // 收敛到同一 canonical 路径。中间目录 real 必须存在——不存在后缀
  // 中的 ".." 按定义 fail closed（见 paths.test）。
  mkdirSync(join(ws, "real"));
  const messyIssue = `${ws}/real/../norm-target.txt`;
  const messyEvaluate = `${ws}//./norm-target.txt`;
  engine.authorizations.issue({
    category: "write",
    targetPath: messyIssue,
    expiresInMs: 60_000,
  });
  const decision = engine.evaluate({ category: "write", targetPath: messyEvaluate });
  assert.equal(decision.outcome, "allow", "规范化后相同的路径应命中授权");
});

test("授权签发校验：不可授权类别 / 越界目标 / 非法有效期 / 不可解析路径", () => {
  const engine = makeEngine();
  assert.throws(
    () => engine.authorizations.issue({ category: "read", targetPath: join(fixtures, "file.txt"), expiresInMs: 1000 }),
    TypeError,
  );
  assert.throws(
    () => engine.authorizations.issue({ category: "shell", targetPath: join(ws, "x"), expiresInMs: 1000 }),
    TypeError,
  );
  assert.throws(
    () => engine.authorizations.issue({ category: "network", targetPath: join(ws, "x"), expiresInMs: 1000 }),
    TypeError,
  );
  assert.throws(
    () => engine.authorizations.issue({ category: "write", targetPath: join(outside, "x.txt"), expiresInMs: 1000 }),
    TypeError,
    "workspace 外目标不得签发授权",
  );
  assert.throws(
    () => engine.authorizations.issue({ category: "write", targetPath: join(ws, "x.txt"), expiresInMs: 0 }),
    TypeError,
    "每笔授权都必须有显式 expiry",
  );
  assert.throws(
    () => engine.authorizations.issue({ category: "write", targetPath: join(ws, "x.txt"), expiresInMs: -5 }),
    TypeError,
  );
  assert.throws(
    () => engine.authorizations.issue({ category: "write", targetPath: join(fixtures, "dangling.txt"), expiresInMs: 1000 }),
    TypeError,
    "不可解析目标不得签发授权",
  );
});

/* ------------------------------------------------------------------ */
/* 7. other-high-risk 类别                                              */
/* ------------------------------------------------------------------ */

test("other-high-risk：无路径拒绝、越界拒绝、workspace 内需授权、授权后允许", () => {
  const engine = makeEngine();
  assert.equal(engine.evaluate({ category: "other-high-risk", action: "delete" }).outcome, "deny");
  assert.equal(
    engine.evaluate({ category: "other-high-risk", targetPath: join(outside, "x"), action: "delete" }).outcome,
    "deny",
  );
  const needs = engine.evaluate({ category: "other-high-risk", targetPath: join(ws, "x"), action: "delete" });
  assert.equal(needs.outcome, "require-approval");
  assert.equal(needs.ruleId, RULE_IDS.highRiskNeedsApproval);
  engine.authorizations.issue({
    category: "other-high-risk",
    targetPath: join(ws, "x"),
    expiresInMs: 60_000,
  });
  const allowed = engine.evaluate({ category: "other-high-risk", targetPath: join(ws, "x"), action: "delete" });
  assert.equal(allowed.outcome, "allow");
  // 默认 singleUse：一次后消费。
  assert.equal(engine.evaluate({ category: "other-high-risk", targetPath: join(ws, "x"), action: "delete" }).outcome, "require-approval");
});

/* ------------------------------------------------------------------ */
/* 8. 相对路径 / 大小写 / 风险映射 / 配置校验                            */
/* ------------------------------------------------------------------ */

test("相对 targetPath 按配置 cwd 解析", () => {
  const engine = createToolPolicy({ readRoots: [fixtures], workspaceRoots: [ws], cwd: fixtures });
  assert.equal(engine.evaluate({ category: "read", targetPath: "file.txt" }).outcome, "allow");
  assert.equal(engine.evaluate({ category: "read", targetPath: join("..", "outside", "outside-file.txt") }).outcome, "deny");
});

test("大小写差异：已存在组件按平台语义收敛，不存在后缀精确匹配（fail closed）", () => {
  const engine = makeEngine();
  // (a) root 部分大小写正确、文件名大小写差异：root 前缀精确匹配，
  //     包含性与文件名大小写无关 → allow（实际能否读到该文件由文件
  //     系统语义决定：大小写敏感 FS 上 ENOENT）。
  const fileCase = engine.evaluate({ category: "read", targetPath: join(fixtures, "FILE.TXT") });
  assert.equal(fileCase.outcome, "allow");
  // (b) root 部分大小写与配置不一致（fixtures → FIXTURES）：
  //     - 大小写不敏感 FS（macOS 默认）：OS realpath 把已存在组件
  //       收敛到盘上真实大小写 → 与配置 root 匹配 → allow 是如实的
  //       （OS 也确实解析到该目录，无逃逸）；
  //     - 大小写敏感 FS（Linux 默认）：FIXTURES 不存在 → canonical
  //       保留输入大小写 → 前缀不匹配 → deny（fail closed）。
  const caseInsensitive = existsSync(join(tempRoot, "FIXTURES"));
  const rootCase = engine.evaluate({
    category: "read",
    targetPath: join(tempRoot, "FIXTURES", "file.txt"),
  });
  assert.equal(rootCase.outcome, caseInsensitive ? "allow" : "deny");
  // (c) 不存在的新文件：大小写差异不会被收敛（没有盘上形态可对齐），
  //     授权按 canonical 字符串精确匹配 → 大小写不同的目标不共享授权。
  const wsEngine = createToolPolicy({ workspaceRoots: [ws] });
  wsEngine.authorizations.issue({
    category: "write",
    targetPath: join(ws, "newfile.txt"),
    expiresInMs: 60_000,
  });
  const differentCase = wsEngine.evaluate({ category: "write", targetPath: join(ws, "NEWFILE.txt") });
  assert.equal(differentCase.outcome, "require-approval");
});

test("风险级别映射：read=low，其余=high", () => {
  const engine = createToolPolicy({ allowShell: true, allowNetwork: true });
  assert.equal(engine.evaluate({ category: "read", targetPath: "/x" }).risk, "low");
  assert.equal(engine.evaluate({ category: "write", targetPath: "/x" }).risk, "high");
  assert.equal(engine.evaluate({ category: "shell" }).risk, "high");
  assert.equal(engine.evaluate({ category: "network" }).risk, "high");
  assert.equal(engine.evaluate({ category: "other-high-risk" }).risk, "high");
});

test("配置结构非法抛 TypeError（编程错误，不产出决定）", () => {
  assert.throws(() => createToolPolicy({ readRoots: "" } as never), TypeError);
  assert.throws(() => createToolPolicy({ readRoots: [""] }), TypeError);
  assert.throws(() => createToolPolicy({ allowShell: "yes" as never }), TypeError);
  assert.throws(() => createToolPolicy({ workspaceRoots: [join(fixtures, "dangling.txt")] }), TypeError,
    "配置 root 不可解析必须在构造期暴露");
});

test("请求类别不在封闭枚举内抛 TypeError", () => {
  const engine = makeEngine();
  assert.throws(() => engine.evaluate({ category: "exec" as ToolActionCategory }), TypeError);
});
