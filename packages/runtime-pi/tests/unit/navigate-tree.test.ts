/**
 * navigateTree 语义：fake port 单测。
 * 覆盖：同 session/sessionFile/条目数不变（不新建会话）、叶移动、
 * user 消息目标 → 父节点（Pi 0.85.1 语义）、tree.navigated 事件、
 * 无在途 run 前置、目标不存在 → session-corrupt、导航后可继续 prompt
 * （追加式树）、当前叶目标 no-op。
 */

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPiRuntimeFromConfig } from "../../src/pi-runtime.ts";
import type { PiEntryId, PiRuntimeEvent } from "@treeai/contracts";
import { makeFakePort } from "../helpers.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "treeai-runtime-pi-nav-"));
}

function collect(runtime: ReturnType<typeof createPiRuntimeFromConfig>): PiRuntimeEvent[] {
  const events: PiRuntimeEvent[] = [];
  runtime.subscribe((event) => {
    events.push(event);
  });
  return events;
}

function countEntries(file: string): number {
  const lines = readFileSync(file, "utf8").split("\n").filter((line) => line.length > 0);
  return lines.length - 1; // 减去 header
}

test("navigateTree to assistant entry: same session/file, leaf moved, no new session", async () => {
  const root = tempDir();
  const sessionDir = join(root, "sessions");
  const port = makeFakePort({ defaultScript: { answer: "answer text" } });
  const runtime = createPiRuntimeFromConfig({ port, defaultCwd: root });
  const events = collect(runtime);

  await runtime.createSession({ model: { providerId: "fake-provider", modelId: "fake-model" }, sessionDir });
  const first = await runtime.prompt({ text: "turn one" });
  await runtime.prompt({ text: "turn two" });
  const sessionFile = first.reference.sessionFile;
  const entriesBefore = countEntries(sessionFile);

  const target = first.reference.entryId;
  const navigated = await runtime.navigateTree({ entryId: target });

  // D2 回归不变量：同 session、同文件、追加式（条目数不变）。
  assert.equal(navigated.sessionId, first.reference.sessionId);
  assert.equal(navigated.sessionFile, sessionFile);
  assert.equal(navigated.entryId, target, "leaf moved to target");
  assert.equal(countEntries(sessionFile), entriesBefore, "navigation appended nothing to the file");
  assert.equal(existsSync(sessionFile), true);

  // tree.navigated 事件（携带目标与结果叶）。
  const navEvents = events.filter((event) => event.kind === "tree.navigated");
  assert.equal(navEvents.length, 1);
  const payload = navEvents[0]?.payload as { targetEntryId?: string; leafEntryId?: string; sessionId?: string };
  assert.equal(payload.targetEntryId, target);
  assert.equal(payload.leafEntryId, target);
  assert.equal(payload.sessionId, first.reference.sessionId);

  // 未新建/替换会话。
  assert.equal(events.filter((event) => event.kind === "session.created").length, 1);
  assert.equal(events.filter((event) => event.kind === "session.replaced").length, 0);
  assert.equal(port.createdSessions.length, 1, "navigation did not create a new Pi session");

  // 导航后从新叶继续：追加式增长，旧条目保留。
  const after = await runtime.prompt({ text: "branched turn" });
  assert.notEqual(after.reference.entryId, target);
  assert.ok(countEntries(sessionFile) > entriesBefore, "prompt after navigation appended entries");
  assert.equal(after.reference.sessionId, first.reference.sessionId, "same session after branch prompt");

  await runtime.dispose();
});

test("navigateTree to user entry: leaf moves to parent (Pi 0.85.1 semantics)", async () => {
  const root = tempDir();
  const sessionDir = join(root, "sessions");
  const port = makeFakePort({ defaultScript: { answer: "a" } });
  const runtime = createPiRuntimeFromConfig({ port, defaultCwd: root });

  await runtime.createSession({ model: { providerId: "fake-provider", modelId: "fake-model" }, sessionDir });
  await runtime.prompt({ text: "user turn" });

  // 找到 user 消息条目（Pi navigateTree 对 user 消息目标：叶移到父节点，
  // 原文作为 editorText 返回——契约面只暴露叶位置，editorText 不出包）。
  const manager = port.createdManagers[0];
  assert.ok(manager !== undefined, "session manager tracked");
  const userEntry = manager
    .getEntries()
    .find((entry) => entry.type === "message" && entry.role === "user");
  assert.ok(userEntry !== undefined, "user entry exists");

  const navigated = await runtime.navigateTree({ entryId: userEntry.id as PiEntryId });

  assert.equal(navigated.entryId, userEntry.parentId, "leaf sits at the parent of the user message");
  assert.equal(manager.getLeafId(), userEntry.parentId);

  // 从父节点继续 prompt（重写该 user turn 的分支）。
  const after = await runtime.prompt({ text: "rewritten turn" });
  assert.notEqual(after.reference.entryId, navigated.entryId);
  assert.equal(after.reference.sessionId, navigated.sessionId);

  await runtime.dispose();
});

test("navigateTree to current leaf: no-op success", async () => {
  const root = tempDir();
  const runtime = createPiRuntimeFromConfig({ port: makeFakePort(), defaultCwd: root });
  const created = await runtime.createSession({ model: { providerId: "fake-provider", modelId: "fake-model" } });

  const again = await runtime.navigateTree({ entryId: created.reference.entryId });
  assert.equal(again.entryId, created.reference.entryId);

  await runtime.dispose();
});

test("navigateTree preconditions: TypeError for bad input, in-flight run, missing session", async () => {
  const root = tempDir();
  const runtime = createPiRuntimeFromConfig({
    port: makeFakePort({ defaultScript: { answer: "never", hang: true, interDelayMs: 5 } }),
    defaultCwd: root,
  });

  // 无活跃会话。
  await assert.rejects(runtime.navigateTree({ entryId: "x" as PiEntryId }), TypeError);

  await runtime.createSession({ model: { providerId: "fake-provider", modelId: "fake-model" } });

  // 形状非法（navigateTree 为 async 方法：前置违规以拒绝形式出现；
  // 故意以非法形态调用，as never 绕过品牌类型）。
  await assert.rejects(runtime.navigateTree(null as never), TypeError);
  await assert.rejects(runtime.navigateTree({ entryId: "" } as never), TypeError);
  await assert.rejects(runtime.navigateTree({ entryId: 42 } as never), TypeError);
  await assert.rejects(runtime.navigateTree({ entryId: "no-such-entry" as PiEntryId }), (err: unknown) => {
    const treeai = err as { code?: string; details?: { kind?: string } };
    assert.equal(treeai.code, "session-corrupt");
    assert.equal(treeai.details?.kind, "entry-not-found");
    return true;
  });

  // 在途 run 中导航 → TypeError（调用方契约违规）。
  const promptPromise = runtime.prompt({ text: "in flight" });
  const rejectionPromise = assert.rejects(promptPromise, (err: unknown) => {
    assert.equal((err as { code?: string }).code, "user-abort");
    return true;
  });
  await assert.rejects(runtime.navigateTree({ entryId: "some-entry" as PiEntryId }), TypeError);
  await runtime.abort();
  await rejectionPromise;

  await runtime.dispose();
});
