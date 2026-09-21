/**
 * 会话创建与恢复：fake port 单测。
 * 覆盖：in-memory 创建、持久化创建、快照引用、恢复（成功/各失败形态）、
 * 恢复后可用、restore 不写文件（条目数不变）。
 */

import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPiRuntimeFromConfig, PINNED_PI_VERSION } from "../../src/pi-runtime.ts";
import type { PiRuntimeEvent } from "@treeai/contracts";
import { makeFakePort } from "../helpers.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "treeai-runtime-pi-create-"));
}

function collect(runtime: ReturnType<typeof createPiRuntimeFromConfig>): PiRuntimeEvent[] {
  const events: PiRuntimeEvent[] = [];
  runtime.subscribe((event) => {
    events.push(event);
  });
  return events;
}

test("createSession in-memory: snapshot, event, no file", async () => {
  const port = makeFakePort();
  const runtime = createPiRuntimeFromConfig({ port, defaultCwd: tempDir() });
  const events = collect(runtime);

  const snapshot = await runtime.createSession({
    model: { providerId: "fake-provider", modelId: "fake-model" },
  });

  assert.equal(runtime.piVersion, "0.85.1");
  assert.equal(snapshot.reference.piVersion, PINNED_PI_VERSION);
  assert.equal(snapshot.reference.sessionFile, "", "in-memory session has empty sessionFile sentinel");
  // Pi 0.85.1 新建会话即追加 model_change + thinking_level_change 条目
  // （sdk.js 新会话路径），因此创建后的 entryId 是叶条目而非根。
  assert.ok(
    typeof snapshot.reference.entryId === "string" && snapshot.reference.entryId.length > 0,
    "fresh session leaf points at the creation entries",
  );
  assert.ok(typeof snapshot.reference.sessionId === "string" && snapshot.reference.sessionId.length > 0);
  assert.deepEqual(snapshot.reference.availability, { status: "available" });

  const created = events.filter((event) => event.kind === "session.created");
  assert.equal(created.length, 1);
  assert.equal(created[0]?.seq, 1, "first event has seq 1");
  assert.equal(events.filter((event) => event.kind === "session.replaced").length, 0);

  await runtime.dispose();
});

test("createSession with sessionDir: file lazily flushed at first assistant message (Pi behavior)", async () => {
  const port = makeFakePort({ defaultScript: { answer: "first answer" } });
  const sessionDir = join(tempDir(), "sessions");
  const runtime = createPiRuntimeFromConfig({ port, defaultCwd: tempDir() });

  const snapshot = await runtime.createSession({
    model: { providerId: "fake-provider", modelId: "fake-model" },
    sessionDir,
  });

  const file = snapshot.reference.sessionFile;
  assert.notEqual(file, "");
  // Pi 0.85.1 懒 flush：首条 assistant 消息前，创建期条目只驻内存，
  // 文件不落盘（真实 SDK _persist 已实证，fake 镜像）。
  assert.equal(existsSync(file), false, "no session file before the first assistant message");

  const result = await runtime.prompt({ text: "hello" });
  assert.equal(result.message, "first answer");
  assert.ok(existsSync(file), "session file flushed once an assistant message exists");

  const content = readFileSync(file, "utf8");
  const firstLine = content.split("\n")[0];
  const header = JSON.parse(firstLine ?? "") as { type: string; id: string };
  assert.equal(header.type, "session");
  assert.equal(header.id, snapshot.reference.sessionId);

  await runtime.dispose();
});

test("createSession unknown model: TreeAIError model-unavailable + runtime.error event", async () => {
  const port = makeFakePort();
  const runtime = createPiRuntimeFromConfig({ port, defaultCwd: tempDir() });
  const events = collect(runtime);

  await assert.rejects(
    runtime.createSession({ model: { providerId: "nope", modelId: "nope-model" } }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      const treeai = err as { code?: string; details?: { providerId?: string } };
      assert.equal(treeai.code, "model-unavailable");
      assert.equal(treeai.details?.providerId, "nope");
      return true;
    },
  );
  const errors = events.filter((event) => event.kind === "runtime.error");
  assert.equal(errors.length, 1);
  assert.equal((errors[0]?.payload as { code?: string }).code, "model-unavailable");
  assert.equal(events.filter((event) => event.kind === "session.created").length, 0, "no session.created on failure");

  await runtime.dispose();
});

test("createSession invalid inputs: TypeError (caller contract violations)", async () => {
  const runtime = createPiRuntimeFromConfig({ port: makeFakePort(), defaultCwd: tempDir() });
  await assert.rejects(
    runtime.createSession(null as unknown as { model: never }),
    TypeError,
  );
  await assert.rejects(
    runtime.createSession({ model: { providerId: "", modelId: "x" } }),
    TypeError,
  );
  await assert.rejects(
    runtime.createSession({
      model: { providerId: "p", modelId: "m" },
      cwd: 123 as unknown as string,
    }),
    TypeError,
  );
  await runtime.dispose();
});

test("restoreSession after persisted prompts: same ids, entry advanced, prompt works", async () => {
  const root = tempDir();
  const sessionDir = join(root, "sessions");
  const portA = makeFakePort({ defaultScript: { answer: "first answer" } });
  const runtimeA = createPiRuntimeFromConfig({ port: portA, defaultCwd: root });

  const created = await runtimeA.createSession({
    model: { providerId: "fake-provider", modelId: "fake-model" },
    sessionDir,
  });
  const promptResult = await runtimeA.prompt({ text: "hello" });
  assert.equal(promptResult.message, "first answer");
  assert.notEqual(promptResult.reference.entryId, created.reference.entryId, "entry advanced after prompt");
  const referenceAfterPrompt = promptResult.reference;
  await runtimeA.dispose();

  // 新运行时实例恢复（模拟宿主重启后的恢复路径）。
  const portB = makeFakePort({ defaultScript: { answer: "second answer" } });
  const runtimeB = createPiRuntimeFromConfig({ port: portB, defaultCwd: root });
  const events = collect(runtimeB);
  const entryCountBefore = countEntries(referenceAfterPrompt.sessionFile);

  const restored = await runtimeB.restoreSession(referenceAfterPrompt);
  assert.equal(restored.reference.sessionId, referenceAfterPrompt.sessionId);
  assert.equal(restored.reference.sessionFile, referenceAfterPrompt.sessionFile);
  assert.equal(restored.reference.entryId, referenceAfterPrompt.entryId, "leaf repositioned at reference");
  assert.equal(countEntries(restored.reference.sessionFile), entryCountBefore, "restore did not write session file");

  const restoredEvents = events.filter((event) => event.kind === "session.restored");
  assert.equal(restoredEvents.length, 1);

  // 恢复后可继续 prompt（模型从 model_change 恢复）。
  const second = await runtimeB.prompt({ text: "again" });
  assert.equal(second.message, "second answer");
  assert.notEqual(second.reference.entryId, restored.reference.entryId);

  await runtimeB.dispose();
});

function countEntries(file: string): number {
  const lines = readFileSync(file, "utf8").split("\n").filter((line) => line.length > 0);
  return lines.length - 1; // 减去 header
}

test("restoreSession failure taxonomy", async () => {
  const root = tempDir();
  const sessionDir = join(root, "sessions");
  const port = makeFakePort();
  const runtime = createPiRuntimeFromConfig({ port, defaultCwd: root });

  const created = await runtime.createSession({
    model: { providerId: "fake-provider", modelId: "fake-model" },
    sessionDir,
  });
  const afterPrompt = await runtime.prompt({ text: "hi" });
  const good = afterPrompt.reference;

  // 版本不一致 → session-corrupt (version-mismatch)。
  await assert.rejects(
    runtime.restoreSession({ ...good, piVersion: "0.84.0" as typeof good.piVersion }),
    (err: unknown) => {
      const treeai = err as { code?: string; details?: { reason?: string } };
      assert.equal(treeai.code, "session-corrupt");
      assert.equal(treeai.details?.reason, "version-mismatch");
      return true;
    },
  );

  // 内存会话引用（sessionFile ""）→ missing-file。
  await assert.rejects(
    runtime.restoreSession({ ...good, sessionFile: "" }),
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, "session-corrupt");
      return true;
    },
  );

  // 文件缺失 → missing-file。
  await assert.rejects(
    runtime.restoreSession({ ...good, sessionFile: join(root, "missing.jsonl") }),
    (err: unknown) => {
      const treeai = err as { code?: string; details?: { reason?: string } };
      assert.equal(treeai.code, "session-corrupt");
      assert.equal(treeai.details?.reason, "missing-file");
      return true;
    },
  );

  // 损坏文件（非 JSON）→ corrupt。
  const corruptFile = join(root, "corrupt.jsonl");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(corruptFile, "this is not json\nat all\n", "utf8");
  await assert.rejects(
    runtime.restoreSession({ ...good, sessionFile: corruptFile }),
    (err: unknown) => {
      const treeai = err as { code?: string; details?: { reason?: string } };
      assert.equal(treeai.code, "session-corrupt");
      assert.equal(treeai.details?.reason, "corrupt");
      return true;
    },
  );

  // sessionId 不匹配 → corrupt。
  await assert.rejects(
    runtime.restoreSession({ ...good, sessionId: "wrong-session-id" as typeof good.sessionId }),
    (err: unknown) => {
      const treeai = err as { code?: string; details?: { reason?: string } };
      assert.equal(treeai.code, "session-corrupt");
      assert.equal(treeai.details?.reason, "corrupt");
      return true;
    },
  );

  // entryId 不存在 → corrupt (entry-not-found)。
  await assert.rejects(
    runtime.restoreSession({ ...good, entryId: "no-such-entry" as typeof good.entryId }),
    (err: unknown) => {
      const treeai = err as { code?: string; details?: { reason?: string; kind?: string } };
      assert.equal(treeai.code, "session-corrupt");
      assert.equal(treeai.details?.kind, "entry-not-found");
      return true;
    },
  );

  // entryId "" 但文件已有条目 → stale-root-reference。
  await assert.rejects(
    runtime.restoreSession({ ...good, entryId: "" as typeof good.entryId }),
    (err: unknown) => {
      const treeai = err as { code?: string; details?: { kind?: string } };
      assert.equal(treeai.code, "session-corrupt");
      assert.equal(treeai.details?.kind, "stale-root-reference");
      return true;
    },
  );

  // 空会话文件（仅 header，无条目）+ entryId "" 是合法恢复
  // （运行时产出的引用不会是 ""——创建即有条目；此路径服务手写/遗留引用）。
  const { writeFileSync: writeFile } = await import("node:fs");
  const headerOnlyFile = join(root, "header-only.jsonl");
  const headerOnlyId = "fake-header-only-session";
  writeFile(headerOnlyFile, `${JSON.stringify({ type: "session", id: headerOnlyId, cwd: root })}\n`, "utf8");
  const restoredEmpty = await runtime.restoreSession({
    sessionId: headerOnlyId as typeof good.sessionId,
    sessionFile: headerOnlyFile,
    entryId: "" as typeof good.entryId,
    piVersion: good.piVersion,
    availability: { status: "available" },
  });
  assert.equal(restoredEmpty.reference.sessionId, headerOnlyId);
  assert.equal(restoredEmpty.reference.entryId, "");

  // 引用形状非法 → TypeError。
  await assert.rejects(
    runtime.restoreSession(null as never),
    TypeError,
  );

  await runtime.dispose();
});

test("restoreSession mid-tree reference: leaf repositioned via branch", async () => {
  const root = tempDir();
  const sessionDir = join(root, "sessions");
  const port = makeFakePort({ defaultScript: { answer: "answer" } });
  const runtime = createPiRuntimeFromConfig({ port, defaultCwd: root });

  const created = await runtime.createSession({
    model: { providerId: "fake-provider", modelId: "fake-model" },
    sessionDir,
  });
  const first = await runtime.prompt({ text: "turn one" });

  // 把引用固定在首轮结果（叶在中间位置），再前进一个 turn。
  const midReference = first.reference;
  await runtime.prompt({ text: "turn two" });

  // 用 mid 引用恢复：叶应回到 midReference.entryId。
  const runtime2 = createPiRuntimeFromConfig({ port: makeFakePort({ defaultScript: { answer: "answer" } }), defaultCwd: root });
  const restored = await runtime2.restoreSession(midReference);
  assert.equal(restored.reference.entryId, midReference.entryId);

  await runtime.dispose();
  await runtime2.dispose();
});

test("restoreSession of never-prompted session: no file on disk (Pi lazy flush) -> missing-file", async () => {
  const root = tempDir();
  const sessionDir = join(root, "sessions");
  const port = makeFakePort();
  const runtime = createPiRuntimeFromConfig({ port, defaultCwd: root });

  // Pi 0.85.1 懒 flush：没有 assistant 消息的持久化会话从未落盘，
  // 其引用不可恢复（运行时以 missing-file 拒绝——真实语义，非缺陷）。
  const created = await runtime.createSession({
    model: { providerId: "fake-provider", modelId: "fake-model" },
    sessionDir,
  });
  assert.notEqual(created.reference.sessionFile, "");
  assert.equal(existsSync(created.reference.sessionFile), false);
  await runtime.dispose();

  const runtime2 = createPiRuntimeFromConfig({
    port: makeFakePort({ defaultScript: { answer: "after restore" } }),
    defaultCwd: root,
  });
  await assert.rejects(
    runtime2.restoreSession(created.reference),
    (err: unknown) => {
      const treeai = err as { code?: string; details?: { reason?: string } };
      assert.equal(treeai.code, "session-corrupt");
      assert.equal(treeai.details?.reason, "missing-file");
      return true;
    },
  );
  await runtime2.dispose();
});

test("restoreSession pins the stored model across a completed-prompt session", async () => {
  const root = tempDir();
  const sessionDir = join(root, "sessions");
  const port = makeFakePort();
  const runtime = createPiRuntimeFromConfig({ port, defaultCwd: root });

  // 用模型表中的第二项创建并完成一轮 prompt（assistant 落盘，文件存在）。
  const created = await runtime.createSession({
    model: { providerId: "fake-provider", modelId: "fake-model-2" },
    sessionDir,
  });
  const afterPrompt = await runtime.prompt({ text: "hello" });
  assert.equal(existsSync(created.reference.sessionFile), true, "file flushed after assistant message");
  await runtime.dispose();

  const port2 = makeFakePort({ defaultScript: { answer: "second answer" } });
  const runtime2 = createPiRuntimeFromConfig({ port: port2, defaultCwd: root });
  const restored = await runtime2.restoreSession(afterPrompt.reference);

  assert.equal(restored.reference.sessionId, afterPrompt.reference.sessionId);
  assert.equal(restored.reference.entryId, afterPrompt.reference.entryId);

  // 存储模型固定：恢复出的会话显式使用 model_change 记录的 fake-model-2
  // （而非环境默认的第一项 fake-model）。
  const restoredSession = port2.createdSessions[0];
  assert.equal(restoredSession?.model?.id, "fake-model-2");

  const answer = await runtime2.prompt({ text: "again" });
  assert.equal(answer.message, "second answer");
  await runtime2.dispose();
});

test("restoreSession model not resolvable: model-unavailable with fallback marker", async () => {
  const root = tempDir();
  const sessionDir = join(root, "sessions");
  // 会话用 fake-model 创建，但恢复端口的模型表里没有它。
  const portCreate = makeFakePort();
  const runtimeCreate = createPiRuntimeFromConfig({ port: portCreate, defaultCwd: root });
  const created = await runtimeCreate.createSession({
    model: { providerId: "fake-provider", modelId: "fake-model" },
    sessionDir,
  });
  const after = await runtimeCreate.prompt({ text: "hi" });
  await runtimeCreate.dispose();

  const emptyModels = new Map();
  const portRestore = makeFakePort({ models: emptyModels });
  const runtimeRestore = createPiRuntimeFromConfig({ port: portRestore, defaultCwd: root });

  await assert.rejects(
    runtimeRestore.restoreSession(after.reference),
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, "model-unavailable");
      return true;
    },
  );
  await runtimeRestore.dispose();
});

test("sessionDir directory is created if missing (file itself is lazily flushed)", async () => {
  const root = tempDir();
  const nested = join(root, "a", "b", "c");
  const runtime = createPiRuntimeFromConfig({ port: makeFakePort(), defaultCwd: root });
  const snapshot = await runtime.createSession({
    model: { providerId: "fake-provider", modelId: "fake-model" },
    sessionDir: nested,
  });
  // 目录立即创建（Pi SessionManager 构造行为）；文件路径指向该目录，
  // 但内容在首条 assistant 消息前不落盘。
  assert.ok(existsSync(nested), "sessionDir created eagerly");
  assert.ok(snapshot.reference.sessionFile.startsWith(nested));
  assert.equal(existsSync(snapshot.reference.sessionFile), false, "file itself is lazy");
  await runtime.dispose();
});
