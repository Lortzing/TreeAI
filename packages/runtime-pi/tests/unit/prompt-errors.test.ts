/**
 * prompt 归一化与错误映射：fake port 单测。
 * 覆盖：成功路径、同步 throw 分类（auth/model/timeout/upstream）、
 * run 级失败（stopReason error / errorMessage）、前置条件（无会话/并发/
 * steer 无在途）、拒绝后回到非 streaming。
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPiRuntimeFromConfig } from "../../src/pi-runtime.ts";
import type { PiRuntimeEvent } from "@treeai/contracts";
import { makeFakePort } from "../helpers.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "treeai-runtime-pi-prompt-"));
}

function collect(runtime: ReturnType<typeof createPiRuntimeFromConfig>): PiRuntimeEvent[] {
  const events: PiRuntimeEvent[] = [];
  runtime.subscribe((event) => {
    events.push(event);
  });
  return events;
}

async function makeReadyRuntime(script?: Parameters<typeof makeFakePort>[0]) {
  const port = makeFakePort(script);
  const runtime = createPiRuntimeFromConfig({ port, defaultCwd: tempDir() });
  await runtime.createSession({ model: { providerId: "fake-provider", modelId: "fake-model" } });
  return { runtime, events: collect(runtime), port };
}

test("prompt success: result message, advanced reference, normalized events", async () => {
  const { runtime, events } = await makeReadyRuntime({ defaultScript: { answer: "the answer text", deltaCount: 3 } });

  const result = await runtime.prompt({ text: "question" });
  assert.equal(result.message, "the answer text");
  assert.ok(typeof result.reference.entryId === "string" && result.reference.entryId.length > 0);

  const kinds = events.map((event) => event.kind);
  assert.ok(kinds.includes("agent.started"));
  assert.ok(kinds.includes("agent.settled"));
  assert.ok(kinds.includes("turn.started"));
  assert.ok(kinds.includes("turn.completed"));
  assert.ok(kinds.includes("message.started"));
  assert.ok(kinds.includes("message.completed"));
  const updates = events.filter((event) => event.kind === "message.updated");
  assert.equal(updates.length, 3, "three text deltas normalized");
  const deltas = updates.map((event) => (event.payload as { delta?: string }).delta).join("");
  assert.equal(deltas, "the answer text");

  // 拒绝后的下一个 prompt 可用（非 streaming）。
  const second = await runtime.prompt({ text: "again" });
  assert.equal(second.message, "the answer text");

  await runtime.dispose();
});

test("prompt sync throw: auth classification (401 unauthorized)", async () => {
  const { runtime, events } = await makeReadyRuntime({
    defaultScript: {
      answer: "unused",
      syncThrow: new Error("Request failed with 401 Unauthorized: invalid API key"),
    },
  });

  await assert.rejects(
    runtime.prompt({ text: "hi" }),
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, "auth");
      assert.ok(err instanceof Error && err.message.includes("401"));
      return true;
    },
  );
  assert.equal(events.filter((event) => event.kind === "runtime.error").length, 1);

  // 拒绝后回到非 streaming：可再次 prompt。
  await assert.rejects(runtime.prompt({ text: "hi again" }));
  await runtime.dispose();
});

test("prompt sync throw: timeout classification", async () => {
  const { runtime } = await makeReadyRuntime({
    defaultScript: { answer: "unused", syncThrow: new Error("Request timed out after 30000ms") },
  });
  await assert.rejects(
    runtime.prompt({ text: "hi" }),
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, "timeout");
      return true;
    },
  );
  await runtime.dispose();
});

test("prompt sync throw: upstream classification (503)", async () => {
  const { runtime } = await makeReadyRuntime({
    defaultScript: { answer: "unused", syncThrow: new Error("503 Service Unavailable from upstream") },
  });
  await assert.rejects(
    runtime.prompt({ text: "hi" }),
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, "upstream");
      return true;
    },
  );
  await runtime.dispose();
});

test("prompt run failure (stopReason error + errorMessage): classified from state", async () => {
  const { runtime, events } = await makeReadyRuntime({
    defaultScript: { answer: "unused", runError: "Overloaded 529 by provider" },
  });

  await assert.rejects(
    runtime.prompt({ text: "hi" }),
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, "upstream");
      return true;
    },
  );
  assert.equal(events.filter((event) => event.kind === "agent.settled").length, 1, "agent.settled still normalized");
  assert.equal(events.filter((event) => event.kind === "runtime.error").length, 1);

  const completed = events.filter((event) => event.kind === "message.completed");
  const last = completed[completed.length - 1]?.payload as { stopReason?: string; hasError?: boolean };
  assert.equal(last?.stopReason, "error");
  assert.equal(last?.hasError, true);

  await runtime.dispose();
});

test("prompt run failure with auth-shaped errorMessage: auth classification", async () => {
  const { runtime } = await makeReadyRuntime({
    defaultScript: { answer: "unused", runError: "401 Unauthorized: API key rejected" },
  });
  await assert.rejects(
    runtime.prompt({ text: "hi" }),
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, "auth");
      return true;
    },
  );
  await runtime.dispose();
});

test("prompt precondition violations: TypeError (thrown synchronously)", async () => {
  const { runtime } = await makeReadyRuntime();

  // prompt() 对调用方契约违规同步抛 TypeError（平台标准错误，非 TreeAIError）。
  assert.throws(() => runtime.prompt({ text: 42 as unknown as string }), TypeError);
  assert.throws(() => runtime.prompt(null as never), TypeError);

  // 在途 run 期间再次 prompt → TypeError（契约：并发 prompt 属调用方违规）。
  const first = runtime.prompt({ text: "first" });
  assert.throws(() => runtime.prompt({ text: "concurrent" }), TypeError);
  await first;

  await runtime.dispose();
});

test("methods without session: TypeError; abort is a safe no-op", async () => {
  const runtime = createPiRuntimeFromConfig({ port: makeFakePort(), defaultCwd: tempDir() });
  assert.throws(() => runtime.prompt({ text: "hi" }), TypeError);
  await assert.rejects(runtime.steer({ text: "hi" }), TypeError);
  await assert.rejects(runtime.navigateTree({ entryId: "x" as never }), TypeError);
  await runtime.abort(); // 无在途 run：静默 no-op resolve
  await runtime.dispose();
});

test("steer without in-flight run: TypeError", async () => {
  const { runtime } = await makeReadyRuntime();
  await assert.rejects(runtime.steer({ text: "hi" }), TypeError);
  await runtime.dispose();
});
