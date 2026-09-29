/**
 * 请求时工具策略门（issue #5 P0 离线段）：fake port 单测。
 *
 * 覆盖：
 * - 分类映射 classifyPiToolCall（Pi 0.85.1 内建工具 → 策略请求；
 *   未知工具 fail closed）；
 * - allow → 工具执行（execution 事件照常）+ tool.decision(allow) 事件
 *   （白名单载荷：工具名/outcome/category/risk/reason/ruleId——参数、
 *   路径、命令绝不入载荷）；
 * - deny / require-approval → **不执行** + tool.decision 事件 + prompt 以
 *   TreeAIError("policy-denied") 拒绝 + runtime.error(code policy-denied)
 *   （fail-closed 终态语义，见 README）；
 * - 未注入 toolPolicy → 不安门、无 decision 事件（既有行为不变）；
 * - restore 路径同样安装（恢复后的会话继续受门约束）。
 *
 * 评估器用结构 fake（PiToolPolicyEvaluator 缝）；真实 ToolPolicyEngine 的
 * 端到端（假 Pi 驱动 + 真实 SDK 离线）在 runtime-smoke 场景与
 * tests/real-port/ 验证。
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PiRuntimeEvent, ToolActionCategory, ToolDecision } from "@treeai/contracts";
import { createPiRuntimeFromConfig } from "../../src/pi-runtime.ts";
import { classifyPiToolCall } from "../../src/tool-policy.ts";
import type { PiToolPolicyEvaluator, PiToolPolicyRequest } from "../../src/tool-policy.ts";
import { makeFakePort } from "../helpers.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "treeai-runtime-pi-policy-"));
}

function decision(
  outcome: ToolDecision["outcome"],
  category: ToolActionCategory,
  reason: string,
  ruleId: string | null = null,
): ToolDecision {
  return Object.freeze({
    outcome,
    category,
    risk: category === "read" ? "low" : "high",
    reason,
    ruleId,
    scope: { roots: [] },
  });
}

/** 结构评估器：按请求的（类别, 目标）路由到测试给定的决定。 */
function makeEvaluator(route: (request: PiToolPolicyRequest) => ToolDecision): PiToolPolicyEvaluator {
  return { evaluate: route };
}

function collect(runtime: ReturnType<typeof createPiRuntimeFromConfig>): PiRuntimeEvent[] {
  const events: PiRuntimeEvent[] = [];
  runtime.subscribe((event) => {
    events.push(event);
  });
  return events;
}

async function makeReadyRuntime(options: {
  readonly policy?: PiToolPolicyEvaluator;
  readonly sessionDir?: string;
}) {
  const port = makeFakePort();
  const runtime = createPiRuntimeFromConfig({
    port,
    defaultCwd: tempDir(),
    ...(options.policy === undefined ? {} : { toolPolicy: options.policy }),
  });
  await runtime.createSession({
    model: { providerId: "fake-provider", modelId: "fake-model" },
    ...(options.sessionDir === undefined ? {} : { sessionDir: options.sessionDir }),
  });
  return { runtime, events: collect(runtime), port };
}

/* ------------------------------------------------------------------ */
/* 分类映射                                                             */
/* ------------------------------------------------------------------ */

test("classifyPiToolCall maps Pi built-in tools; unknown tools fail closed", () => {
  assert.deepEqual(classifyPiToolCall({ toolName: "read", args: { path: "/a/b.txt" } }), {
    category: "read",
    targetPath: "/a/b.txt",
  });
  assert.deepEqual(classifyPiToolCall({ toolName: "grep", args: { pattern: "x", path: "/ws" } }), {
    category: "read",
    targetPath: "/ws",
  });
  // grep/find/ls 的 path 可选：缺失 → 无路径的 read（引擎将 fail-closed deny）。
  assert.deepEqual(classifyPiToolCall({ toolName: "ls", args: {} }), { category: "read" });
  assert.deepEqual(classifyPiToolCall({ toolName: "write", args: { path: "/ws/out.txt", content: "x" } }), {
    category: "write",
    targetPath: "/ws/out.txt",
  });
  assert.deepEqual(classifyPiToolCall({ toolName: "edit", args: { path: "/ws/a", edits: [] } }), {
    category: "write",
    targetPath: "/ws/a",
  });
  assert.deepEqual(classifyPiToolCall({ toolName: "bash", args: { command: "ls" } }), {
    category: "shell",
    command: "ls",
  });
  assert.deepEqual(classifyPiToolCall({ toolName: "powershell", args: { command: "dir" } }), {
    category: "shell",
    command: "dir",
  });
  // 未知（扩展/自定义）工具：other-high-risk + action 标签，无路径可限定。
  assert.deepEqual(classifyPiToolCall({ toolName: "deploy-remote", args: { anything: 1 } }), {
    category: "other-high-risk",
    action: "deploy-remote",
  });
  // 不可信参数的防御性提取：非对象/非字符串/空串一律视为缺失。
  assert.deepEqual(classifyPiToolCall({ toolName: "read", args: null }), { category: "read" });
  assert.deepEqual(classifyPiToolCall({ toolName: "read", args: { path: 42 } }), { category: "read" });
  assert.deepEqual(classifyPiToolCall({ toolName: "read", args: { path: "" } }), { category: "read" });
  assert.deepEqual(classifyPiToolCall({ toolName: "bash", args: { command: "" } }), { category: "shell" });
});

/* ------------------------------------------------------------------ */
/* allow：执行 + decision 事件（载荷白名单）                            */
/* ------------------------------------------------------------------ */

test("tool policy allow: tool executes and the decision surfaces with provenance", async () => {
  const policy = makeEvaluator((request) =>
    request.category === "read"
      ? decision("allow", "read", "read target resolves inside a configured read root (explicit allow rule)", "allow-read-configured-roots")
      : decision("deny", request.category, "unit-test default deny"),
  );
  const { runtime, events, port } = await makeReadyRuntime({ policy });
  const session = port.createdSessions[0]!;
  session.setScript({ answer: "done", toolCalls: [{ name: "read", args: { path: "/root/notes.txt" } }] });

  const result = await runtime.prompt({ text: "use the tool" });
  assert.equal(result.message, "done");

  // (a) 放行的工具确实执行。
  assert.deepEqual(session.executedToolCalls, ["read"]);
  assert.deepEqual(session.blockedToolCalls, []);

  // execution 事件照常；decision 事件携带 provenance。
  const decisionEvents = events.filter((event) => event.kind === "tool.decision");
  assert.equal(decisionEvents.length, 1);
  const payload = decisionEvents[0]!.payload as Record<string, unknown>;
  assert.deepEqual(Object.keys(payload).sort(), [
    "category",
    "decision",
    "reason",
    "risk",
    "ruleId",
    "toolName",
  ]);
  assert.equal(payload["toolName"], "read");
  assert.equal(payload["decision"], "allow");
  assert.equal(payload["category"], "read");
  assert.equal(payload["risk"], "low");
  assert.equal(payload["ruleId"], "allow-read-configured-roots");
  assert.equal(
    payload["reason"],
    "read target resolves inside a configured read root (explicit allow rule)",
  );

  const kinds = events.map((event) => event.kind);
  assert.ok(kinds.includes("tool.execution.started"));
  assert.ok(kinds.includes("tool.execution.finished"));
  // 载荷绝不携带参数/路径。
  assert.ok(!JSON.stringify(events).includes("notes.txt"));

  await runtime.dispose();
});

/* ------------------------------------------------------------------ */
/* deny：不执行 + decision + policy-denied 终态                          */
/* ------------------------------------------------------------------ */

test("tool policy deny: request-time rejection, no execution, run fails policy-denied", async () => {
  const secretPath = "/outside/secret-target.txt";
  const policy = makeEvaluator((request) =>
    decision("deny", request.category, "read target resolves outside every configured read root; no rule allows it"),
  );
  const { runtime, events, port } = await makeReadyRuntime({ policy });
  const session = port.createdSessions[0]!;
  session.setScript({
    answer: "should not matter",
    toolCalls: [
      { name: "read", args: { path: "/root/ok.txt" } },
      { name: "read", args: { path: secretPath } },
    ],
  });

  await assert.rejects(
    runtime.prompt({ text: "overreach" }),
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, "policy-denied");
      assert.ok(err instanceof Error && err.message.includes("tool policy"));
      return true;
    },
  );

  // (b) 两个调用都被拒：均未执行（执行日志为空）。
  assert.deepEqual(session.executedToolCalls, []);
  assert.deepEqual(session.blockedToolCalls, ["read", "read"]);

  // (c) 拒绝决定可见 + provenance；runtime.error 以 policy-denied 上报。
  const decisionEvents = events.filter((event) => event.kind === "tool.decision");
  assert.equal(decisionEvents.length, 2);
  for (const event of decisionEvents) {
    const payload = event.payload as Record<string, unknown>;
    assert.equal(payload["decision"], "deny");
    assert.equal(payload["toolName"], "read");
    assert.equal(payload["ruleId"], null);
    assert.equal(
      payload["reason"],
      "read target resolves outside every configured read root; no rule allows it",
    );
  }
  const errors = events.filter((event) => event.kind === "runtime.error");
  assert.equal(errors.length, 1);
  assert.equal((errors[0]!.payload as { code?: string }).code, "policy-denied");

  // 载荷绝不携带参数/路径/命令。
  const serialized = JSON.stringify(events);
  assert.ok(!serialized.includes(secretPath));
  assert.ok(!serialized.includes("ok.txt"));

  // (d) 终态后运行时回到非 streaming：可再次 prompt。
  session.setScript({ answer: "recovered" });
  const next = await runtime.prompt({ text: "again" });
  assert.equal(next.message, "recovered");

  await runtime.dispose();
});

test("tool policy require-approval is treated as denial (fail closed; no approval UI on this path)", async () => {
  const policy = makeEvaluator((request) =>
    decision(
      "require-approval",
      request.category,
      "write target is inside an approved workspace root; per-operation or time-limited authorization is required before execution",
      "write-in-workspace-requires-approval",
    ),
  );
  const { runtime, events, port } = await makeReadyRuntime({ policy });
  const session = port.createdSessions[0]!;
  session.setScript({
    answer: "unused",
    toolCalls: [{ name: "write", args: { path: "/ws/draft.txt", content: "x" } }],
  });

  await assert.rejects(runtime.prompt({ text: "write something" }), (err: unknown) => {
    assert.equal((err as { code?: string }).code, "policy-denied");
    return true;
  });
  assert.deepEqual(session.executedToolCalls, [], "require-approval must not execute");
  assert.deepEqual(session.blockedToolCalls, ["write"]);
  const decisionEvents = events.filter((event) => event.kind === "tool.decision");
  assert.equal(decisionEvents.length, 1);
  assert.equal((decisionEvents[0]!.payload as { decision?: string }).decision, "require-approval");

  await runtime.dispose();
});

test("mixed batch: allowed tool executes before the denied one fails the run", async () => {
  const allowedRoot = "/root";
  const policy = makeEvaluator((request) =>
    request.targetPath !== undefined && request.targetPath.startsWith(allowedRoot)
      ? decision("allow", request.category, "inside roots")
      : decision("deny", request.category, "outside roots"),
  );
  const { runtime, events, port } = await makeReadyRuntime({ policy });
  const session = port.createdSessions[0]!;
  session.setScript({
    answer: "partial",
    toolCalls: [
      { name: "read", args: { path: "/root/inside.txt" } },
      { name: "read", args: { path: "/elsewhere/outside.txt" } },
    ],
  });

  await assert.rejects(runtime.prompt({ text: "mixed" }), (err: unknown) => {
    assert.equal((err as { code?: string }).code, "policy-denied");
    return true;
  });
  assert.deepEqual(session.executedToolCalls, ["read"]);
  assert.deepEqual(session.blockedToolCalls, ["read"]);
  const outcomes = events
    .filter((event) => event.kind === "tool.decision")
    .map((event) => (event.payload as { decision?: string }).decision);
  assert.deepEqual(outcomes, ["allow", "deny"]);

  await runtime.dispose();
});

/* ------------------------------------------------------------------ */
/* 未注入策略：行为不变                                                  */
/* ------------------------------------------------------------------ */

test("no tool policy configured: tools execute without decision events (existing behavior)", async () => {
  const { runtime, events, port } = await makeReadyRuntime({});
  const session = port.createdSessions[0]!;
  session.setScript({
    answer: "plain",
    toolCalls: [{ name: "bash", args: { command: "echo hi" } }],
  });
  const result = await runtime.prompt({ text: "go" });
  assert.equal(result.message, "plain");
  assert.deepEqual(session.executedToolCalls, ["bash"]);
  assert.equal(events.filter((event) => event.kind === "tool.decision").length, 0);
  assert.equal(events.filter((event) => event.kind === "runtime.error").length, 0);

  await runtime.dispose();
});

/* ------------------------------------------------------------------ */
/* restore 路径同样安装门                                                */
/* ------------------------------------------------------------------ */

test("restored sessions get the tool gate installed too", async () => {
  const sessionDir = join(tempDir(), "sessions");
  const policy = makeEvaluator(() => decision("deny", "read", "denied for the restore test"));

  // 第一代：允许执行一轮（产生可恢复的持久化会话文件）。
  const first = await makeReadyRuntime({ policy, sessionDir });
  const session1 = first.port.createdSessions[0]!;
  session1.setScript({ answer: "gen one" });
  const run1 = await first.runtime.prompt({ text: "seed" });
  await first.runtime.dispose();

  // 第二代：同一策略恢复会话，工具调用仍被门拦截（fail closed）。
  const port2 = makeFakePort();
  const runtime2 = createPiRuntimeFromConfig({ port: port2, defaultCwd: tempDir(), toolPolicy: policy });
  const events2 = collect(runtime2);
  const restored = await runtime2.restoreSession(run1.reference);
  assert.equal(restored.reference.sessionId, run1.reference.sessionId);
  const session2 = port2.createdSessions[0]!;
  session2.setScript({
    answer: "unused",
    toolCalls: [{ name: "read", args: { path: "/root/x.txt" } }],
  });
  await assert.rejects(runtime2.prompt({ text: "overreach after restore" }), (err: unknown) => {
    assert.equal((err as { code?: string }).code, "policy-denied");
    return true;
  });
  assert.deepEqual(session2.executedToolCalls, []);
  assert.deepEqual(session2.blockedToolCalls, ["read"]);
  assert.equal(events2.filter((event) => event.kind === "tool.decision").length, 1);

  await runtime2.dispose();
});
