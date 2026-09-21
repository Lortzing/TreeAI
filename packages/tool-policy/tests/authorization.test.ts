/**
 * authorization.test.ts —— AuthorizationStore 单元测试。
 *
 * 覆盖：签发固化（canonical 目标 / 显式 expiry / 单次默认）、
 * 撤销、过期清理、有效列表、审计事件。
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { canonicalizePath, createToolPolicy } from "../src/index.js";

let tempRoot: string;
let ws: string;
let canonWs: string;

before(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "treeai-tool-policy-authz-"));
  ws = join(tempRoot, "ws");
  mkdirSync(ws);
  // 混乱路径测试的中间目录：`${ws}/./a/../target.txt` 里的 ".." 穿越的
  // 必须是已存在目录（不存在后缀中的 ".." 按定义 fail closed）。
  mkdirSync(join(ws, "a"));
  canonWs = canonicalizePath(ws) ?? "";
});

after(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

test("issue 固化 canonical 目标路径与显式有效期", () => {
  let now = 5_000;
  const engine = createToolPolicy({ workspaceRoots: [ws] }, { now: () => now });
  const grant = engine.authorizations.issue({
    category: "write",
    targetPath: `${ws}/./a/../target.txt`,
    expiresInMs: 30_000,
  });
  assert.match(grant.grantId, /^grant-/);
  assert.equal(grant.category, "write");
  assert.equal(grant.targetPath, join(canonWs, "target.txt"), "目标路径签发时规范化");
  assert.equal(grant.issuedAt, 5_000);
  assert.equal(grant.expiresAt, 35_000);
  assert.equal(grant.singleUse, true, "默认逐次授权");
  assert.equal(grant.consumed, false);
});

test("revoke 后授权立即失效，重复 revoke 返回 false", () => {
  const engine = createToolPolicy({ workspaceRoots: [ws] });
  const grant = engine.authorizations.issue({
    category: "write",
    targetPath: join(ws, "revoked.txt"),
    expiresInMs: 60_000,
  });
  assert.equal(engine.authorizations.revoke(grant.grantId), true);
  assert.equal(
    engine.evaluate({ category: "write", targetPath: join(ws, "revoked.txt") }).outcome,
    "require-approval",
  );
  assert.equal(engine.authorizations.revoke(grant.grantId), false);
});

test("purgeExpired 清理过期授权并返回数量", () => {
  let now = 0;
  const engine = createToolPolicy({ workspaceRoots: [ws] }, { now: () => now });
  engine.authorizations.issue({ category: "write", targetPath: join(ws, "short.txt"), expiresInMs: 1_000 });
  engine.authorizations.issue({ category: "write", targetPath: join(ws, "long.txt"), expiresInMs: 1_000_000 });
  now = 2_000;
  assert.equal(engine.authorizations.purgeExpired(), 1);
  assert.equal(engine.authorizations.listActive().length, 1);
  assert.equal(engine.authorizations.listActive()[0]?.targetPath, join(canonWs, "long.txt"));
});

test("listActive 不含已消费的单次授权与过期授权", () => {
  let now = 0;
  const engine = createToolPolicy({ workspaceRoots: [ws] }, { now: () => now });
  const single = engine.authorizations.issue({
    category: "write",
    targetPath: join(ws, "one-shot.txt"),
    expiresInMs: 1_000_000,
  });
  const expired = engine.authorizations.issue({
    category: "write",
    targetPath: join(ws, "stale.txt"),
    expiresInMs: 1_000,
  });
  assert.equal(engine.evaluate({ category: "write", targetPath: join(ws, "one-shot.txt") }).outcome, "allow");
  now = 2_000;
  const active = engine.authorizations.listActive();
  assert.equal(active.length, 0, "单次已消费与过期的授权都不应出现在有效列表");
  assert.equal(expired.expiresAt, 1_000);
  assert.equal(single.consumed, false, "授权对象是不可变快照；消费状态经内部更新体现");
});

test("过期边界：now === expiresAt 即失效", () => {
  let now = 100;
  const engine = createToolPolicy({ workspaceRoots: [ws] }, { now: () => now });
  engine.authorizations.issue({
    category: "write",
    targetPath: join(ws, "edge.txt"),
    expiresInMs: 900,
    singleUse: false,
  });
  now = 999;
  assert.equal(engine.evaluate({ category: "write", targetPath: join(ws, "edge.txt") }).outcome, "allow");
  now = 1000;
  assert.equal(engine.evaluate({ category: "write", targetPath: join(ws, "edge.txt") }).outcome, "require-approval");
});

test("授权生命周期写入审计（issued/consumed/revoked/purged）", () => {
  let now = 0;
  const engine = createToolPolicy({ workspaceRoots: [ws] }, { now: () => now });
  const grant = engine.authorizations.issue({
    category: "write",
    targetPath: join(ws, "audited.txt"),
    expiresInMs: 500,
  });
  engine.evaluate({ category: "write", targetPath: join(ws, "audited.txt") }); // allow + consume
  engine.authorizations.revoke(grant.grantId);
  engine.authorizations.issue({ category: "write", targetPath: join(ws, "purge-me.txt"), expiresInMs: 1 });
  now = 10_000;
  engine.authorizations.purgeExpired();
  const kinds = engine.audit.records.map((r) => r.kind);
  assert.ok(kinds.includes("grant-issued"));
  assert.ok(kinds.includes("grant-consumed"));
  assert.ok(kinds.includes("grant-revoked"));
  assert.ok(kinds.includes("grant-purged"));
});
