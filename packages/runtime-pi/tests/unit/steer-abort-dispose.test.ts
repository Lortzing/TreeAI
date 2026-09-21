/**
 * steer / abort / dispose 语义：fake port 单测。
 * 覆盖：steer 同一 agent run 新 turn（单 agent.started）、abort 即时
 * resolve + prompt 以 user-abort 收敛 + 非 streaming、abort 幂等、
 * 安全计时器兜底、dispose 幂等、dispose 收敛在途 run、dispose 后
 * 方法违规、事件停止。
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
  return mkdtempSync(join(tmpdir(), "treeai-runtime-pi-abort-"));
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

test("steer during in-flight run: same agent run, new turn, steer.enqueued event", async () => {
  const { runtime, events } = await makeReadyRuntime({
    defaultScript: { answer: "base answer", interDelayMs: 20 },
  });

  const promptPromise = runtime.prompt({ text: "first question" });
  // 等 agent.started 出现后再 steer（保证在途）。
  await waitFor(events, (event) => event.kind === "agent.started");
  await runtime.steer({ text: "steering input" });
  const result = await promptPromise;

  assert.equal(result.message, "base answer");
  // 同一 agent run：整个 prompt+steer 只有一个 agent.started。
  assert.equal(events.filter((event) => event.kind === "agent.started").length, 1);
  // steer 派生了第二个 turn。
  assert.equal(events.filter((event) => event.kind === "turn.started").length, 2);
  // steer.enqueued 事件已推送。
  assert.equal(events.filter((event) => event.kind === "steer.enqueued").length, 1);

  await runtime.dispose();
});

test("abort during hanging run: abort resolves fast, prompt rejects user-abort, runtime non-streaming", async () => {
  const { runtime, events, port } = await makeReadyRuntime({
    defaultScript: { answer: "never", hang: true, interDelayMs: 5 },
  });

  const promptPromise = runtime.prompt({ text: "long question" });
  // 先挂接拒绝断言（避免 dispose/abort 触发的拒绝短暂未处理）。
  const rejectionPromise = assert.rejects(promptPromise, (err: unknown) => {
    assert.equal((err as { code?: string }).code, "user-abort");
    return true;
  });
  await waitFor(events, (event) => event.kind === "message.updated" || event.kind === "message.started");

  const abortStart = Date.now();
  await runtime.abort();
  const abortDuration = Date.now() - abortStart;

  await rejectionPromise;
  assert.ok(abortDuration < 500, `abort() resolved quickly (took ${abortDuration}ms)`);
  assert.equal(events.filter((event) => event.kind === "run.abort-requested").length, 1);

  // 收敛后回到非 streaming：换正常脚本后可再次 prompt。
  port.createdSessions[0]?.setScript({ answer: "after abort" });
  await runtime.prompt({ text: "after abort" });

  await runtime.dispose();
});

test("double abort: idempotent, single run.abort-requested, no error", async () => {
  const { runtime, events } = await makeReadyRuntime({
    defaultScript: { answer: "never", hang: true, interDelayMs: 5 },
  });

  const promptPromise = runtime.prompt({ text: "q" });
  // 先挂接拒绝断言，避免 abort 触发的拒绝短暂未处理。
  const rejectionPromise = assert.rejects(promptPromise, (err: unknown) => {
    assert.equal((err as { code?: string }).code, "user-abort");
    return true;
  });
  await waitFor(events, (event) => event.kind === "agent.started");
  await runtime.abort();
  await runtime.abort();
  await rejectionPromise;
  assert.equal(events.filter((event) => event.kind === "run.abort-requested").length, 1);
  await runtime.dispose();
});

test("abort with no in-flight run: silent no-op", async () => {
  const { runtime, events } = await makeReadyRuntime();
  await runtime.abort();
  await runtime.abort();
  assert.equal(events.filter((event) => event.kind === "run.abort-requested").length, 0);
  await runtime.dispose();
});

test("safety timer: prompt still settles user-abort when Pi abort never converges", async () => {
  const port = makeFakePort({
    defaultScript: { answer: "never", hang: true, ignoreAbort: true, interDelayMs: 5 },
  });
  const runtime = createPiRuntimeFromConfig({ port, defaultCwd: tempDir(), abortConvergenceMs: 60 });
  await runtime.createSession({ model: { providerId: "fake-provider", modelId: "fake-model" } });
  const events = collect(runtime);

  const promptPromise = runtime.prompt({ text: "evil hang" });
  const rejectionPromise = assert.rejects(promptPromise, (err: unknown) => {
    assert.equal((err as { code?: string }).code, "user-abort");
    return true;
  });
  await waitFor(events, (event) => event.kind === "agent.started");
  await runtime.abort();

  await rejectionPromise;
  await runtime.dispose();
});

test("dispose with in-flight run: prompt settles user-abort, dispose idempotent, events stop", async () => {
  const { runtime, events } = await makeReadyRuntime({
    defaultScript: { answer: "never", hang: true, interDelayMs: 5 },
  });

  const promptPromise = runtime.prompt({ text: "in flight" });
  // 先挂接拒绝断言：dispose 会在 settleRun 中同步 reject 该 promise，
  // 晚于 dispose 才挂处理函数会触发 Node 的 unhandled rejection。
  const rejectionPromise = assert.rejects(promptPromise, (err: unknown) => {
    assert.equal((err as { code?: string }).code, "user-abort");
    return true;
  });
  await waitFor(events, (event) => event.kind === "agent.started");
  const eventCountAtDispose = events.length;

  await runtime.dispose();
  await runtime.dispose(); // 幂等：重复 dispose 安全 resolve。

  await rejectionPromise;
  assert.equal(events.length, eventCountAtDispose, "no events after dispose");

  // dispose 后任何方法（除 dispose）都是调用方契约违规。
  assert.throws(() => runtime.prompt({ text: "x" }), TypeError);
  assert.throws(() => runtime.subscribe(() => undefined), TypeError);
  await assert.rejects(runtime.createSession({ model: { providerId: "fake-provider", modelId: "fake-model" } }), TypeError);
  await assert.rejects(runtime.abort(), TypeError);
});

test("dispose with idle runtime: clean resolve", async () => {
  const { runtime } = await makeReadyRuntime();
  await runtime.dispose();
  await runtime.dispose();
});

/** 轮询等待事件出现（fake 的 turn 推进有真实延时）。 */
function waitFor(
  events: PiRuntimeEvent[],
  predicate: (event: PiRuntimeEvent) => boolean,
  timeoutMs = 2000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const check = () => {
      if (events.some(predicate)) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error("waitFor timeout"));
        return;
      }
      setTimeout(check, 5);
    };
    check();
  });
}
