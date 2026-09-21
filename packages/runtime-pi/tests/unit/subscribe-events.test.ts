/**
 * 订阅与事件语义：fake port 单测。
 * 覆盖：多监听器、退订（幂等）、无历史回放、seq 严格递增 + eventId
 * 格式、会话替换（旧订阅失效/新订阅生效、在途 run 收敛、seq 跨替换
 * 连续）、监听器异常隔离、dispose 后订阅违规。
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
  return mkdtempSync(join(tmpdir(), "treeai-runtime-pi-sub-"));
}

function collect(runtime: ReturnType<typeof createPiRuntimeFromConfig>): PiRuntimeEvent[] {
  const events: PiRuntimeEvent[] = [];
  runtime.subscribe((event) => {
    events.push(event);
  });
  return events;
}

test("multiple listeners, unsubscribe, no history replay", async () => {
  const runtime = createPiRuntimeFromConfig({
    port: makeFakePort({ defaultScript: { answer: "ok" } }),
    defaultCwd: tempDir(),
  });

  const eventsA: PiRuntimeEvent[] = [];
  const eventsB: PiRuntimeEvent[] = [];
  const offA = runtime.subscribe((event) => eventsA.push(event));
  runtime.subscribe((event) => eventsB.push(event));

  await runtime.createSession({ model: { providerId: "fake-provider", modelId: "fake-model" } });
  assert.ok(eventsA.length > 0, "A received session.created");
  assert.equal(eventsA.length, eventsB.length, "both listeners saw the same events");

  offA();
  offA(); // 退订幂等。
  const countA = eventsA.length;

  await runtime.prompt({ text: "hi" });
  assert.equal(eventsA.length, countA, "unsubscribed listener receives nothing");
  assert.ok(eventsB.length > countA, "remaining listener still receives events");

  // 新订阅者无历史回放：只看到订阅之后的事件。
  const eventsC: PiRuntimeEvent[] = [];
  runtime.subscribe((event) => eventsC.push(event));
  assert.equal(eventsC.length, 0, "late subscriber gets no history");
  await runtime.prompt({ text: "again" });
  assert.ok(eventsC.length > 0, "late subscriber sees new events only");

  await runtime.dispose();
});

test("eventId format, seq strict monotonic, occurredAt ISO", async () => {
  const runtime = createPiRuntimeFromConfig({
    port: makeFakePort({ defaultScript: { answer: "ok", interDelayMs: 1 } }),
    defaultCwd: tempDir(),
  });
  const events = collect(runtime);

  await runtime.createSession({ model: { providerId: "fake-provider", modelId: "fake-model" } });
  await runtime.prompt({ text: "one" });
  await runtime.prompt({ text: "two" });

  assert.ok(events.length >= 3);
  let lastSeq = 0;
  for (const event of events) {
    assert.equal(event.eventId, `pi-runtime-${event.seq}`);
    assert.ok(event.seq > lastSeq, `seq strictly increasing (got ${event.seq} after ${lastSeq})`);
    assert.ok(!Number.isNaN(Date.parse(event.occurredAt)), `occurredAt is ISO datetime (${event.occurredAt})`);
    lastSeq = event.seq;
  }
  assert.equal(events[0]?.seq, 1, "seq starts at 1 for a fresh runtime");

  await runtime.dispose();
});

test("session replacement: old subscription invalidated, new effective, seq continuous, in-flight settled", async () => {
  const root = tempDir();
  const port = makeFakePort({ defaultScript: { answer: "never", hang: true, interDelayMs: 5 } });
  const runtime = createPiRuntimeFromConfig({ port, defaultCwd: root });
  const events = collect(runtime);

  const first = await runtime.createSession({ model: { providerId: "fake-provider", modelId: "fake-model" } });
  const seqAfterFirstCreate = events[events.length - 1]?.seq;
  assert.ok(seqAfterFirstCreate !== undefined);

  // 旧会话上的在途 run：替换时以 user-abort 收敛。
  const promptPromise = runtime.prompt({ text: "doomed" });
  const rejectionPromise = assert.rejects(promptPromise, (err: unknown) => {
    assert.equal((err as { code?: string }).code, "user-abort");
    return true;
  });

  const second = await runtime.createSession({ model: { providerId: "fake-provider", modelId: "fake-model" } });
  await rejectionPromise;
  assert.notEqual(second.reference.sessionId, first.reference.sessionId);

  // 事件顺序：session.replaced（旧）→ session.created（新），seq 连续。
  const replaced = events.filter((event) => event.kind === "session.replaced");
  const created = events.filter((event) => event.kind === "session.created");
  assert.equal(replaced.length, 1);
  assert.equal(created.length, 2);
  assert.equal((replaced[0]?.payload as { sessionId?: string }).sessionId, first.reference.sessionId);
  assert.ok(
    replaced[0] !== undefined && created[1] !== undefined && replaced[0].seq < created[1].seq,
    "replaced precedes new created, seq continuous",
  );
  assert.ok(
    replaced[0] !== undefined && replaced[0].seq > (seqAfterFirstCreate ?? 0),
    "replacement events continue the same seq space",
  );

  // 旧会话的迟到 Pi 事件不再投递（旧订阅已失效）。
  const countBefore = events.length;
  const oldSession = port.createdSessions[0];
  assert.ok(oldSession !== undefined);
  oldSession.emit({ type: "agent_start" });
  assert.equal(events.length, countBefore, "late event from replaced session dropped");

  // 新会话订阅生效：换正常脚本后 prompt，事件流动且引用指向新会话。
  port.createdSessions[1]?.setScript({ answer: "new session answer" });
  const result = await runtime.prompt({ text: "on new session" });
  assert.equal(result.message, "new session answer");
  assert.equal(result.reference.sessionId, second.reference.sessionId);
  assert.ok(events.length > countBefore, "new session events flow to listeners");

  await runtime.dispose();
});

test("listener exceptions are isolated: other listeners and the runtime survive", async () => {
  const runtime = createPiRuntimeFromConfig({
    port: makeFakePort({ defaultScript: { answer: "ok" } }),
    defaultCwd: tempDir(),
  });
  const events: PiRuntimeEvent[] = [];
  let throws = 0;
  runtime.subscribe(() => {
    throws += 1;
    throw new Error("listener bug");
  });
  runtime.subscribe((event) => events.push(event));

  const snapshot = await runtime.createSession({ model: { providerId: "fake-provider", modelId: "fake-model" } });
  assert.ok(events.some((event) => event.kind === "session.created"));
  assert.ok(throws > 0, "faulty listener was invoked and threw");

  // 运行时未受影响：可继续 prompt 且事件继续投递。
  const result = await runtime.prompt({ text: "still alive" });
  assert.equal(result.message, "ok");
  assert.ok(events.some((event) => event.kind === "agent.started"));

  await runtime.dispose();
});

test("subscribe preconditions: TypeError for non-function and after dispose", async () => {
  const runtime = createPiRuntimeFromConfig({ port: makeFakePort(), defaultCwd: tempDir() });
  assert.throws(() => runtime.subscribe(null as never), TypeError);
  assert.throws(() => runtime.subscribe("not a function" as never), TypeError);

  await runtime.dispose();
  assert.throws(() => runtime.subscribe(() => undefined), TypeError, "subscribe after dispose is a caller violation");
});
