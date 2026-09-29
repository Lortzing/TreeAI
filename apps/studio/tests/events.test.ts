/**
 * P1「Run/权限与异常恢复」界面状态面测试（API 级：无浏览器 harness，
 * 断言 UI 所渲染的状态面——SSE 事件流、诊断面、journal 投影与降级标记；
 * 目标 Mac 的手动 UI 验证另行记录于 docs/d3/W2-frontend-prototype.md）。
 *
 * 覆盖：
 *  1. SSE 流式：snapshot → run-started → message-delta* → run-terminal
 *     （在途 echo prompt 期间），客户端断开后连接干净关闭；
 *  2. 模型错误（echo 驱动 /fail 注入，确定性、已文档化）：run 收敛 failed，
 *     失败呈现在诊断面 + journal + SSE 终态事件，journal 投影与 DB 一致
 *     （无投影异常）；
 *  3. abort：SSE abort-requested → run-terminal aborted 顺序 + journal
 *     投影一致；
 *  4. session 删除（A4）：getTreeState 仍成功且分支 sessionAvailability
 *     降级为 unavailable（树保持可读）；prompt 失败 session-corrupt（502）
 *     且零部分写入（无新 run/turn 行、无新 journal 事件）；恢复路径
 *     （健康树/分支上继续）成功；
 *  5. 进程重启：journal 与 DB/诊断面一致收敛（host-crash 恢复）；
 *  6. 权限越权（诚实边界）：Studio 离线空工具 allowlist → policyDecisions
 *     恒为 {observed:false}，journal/SSE 无工具事件；合成 tool.decision
 *     事件经 /journal 投影保守呈现（原始参数/路径不外泄）；
 *  7. journal 端点：按树过滤、最新在后、limit 生效、未知树 404、非法
 *     limit 400；
 *  8. 服务级事件面：tool-activity 只投影工具名+阶段（脚本化 runtime 注入
 *     携带敏感参数的工具事件，断言不外泄）；退订生效；
 *  9. 请求时策略门（issue #5 P0）：真实 ToolPolicyEngine 注入 runtime，
 *     echo 驱动的工具调用脚本经真实请求路径评估——allow 执行、deny 不
 *     执行；拒绝以 tool-activity(denied)+provenance / journal
 *     tool.decision / 诊断面观测呈现；run 收敛 failed(policy-denied)
 *     （fail closed）；目标路径/参数绝不外泄。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BranchId,
  PiEntryId,
  PiRuntime,
  PiRuntimeEvent,
  PiSessionId,
  PiSessionSnapshot,
  PiVersion,
  RunId,
  TreeId,
} from "@treeai/contracts";
import { EventRecorder, JsonlEventJournal, MemoryEventJournal } from "@treeai/event-journal";
import { createPiRuntimeFromConfig } from "@treeai/runtime-pi";
import { ToolPolicyEngine } from "@treeai/tool-policy";
import { EchoSdkPort } from "../src/echo-port.ts";
import { createStudioServer } from "../src/server.ts";
import {
  cleanupDir,
  makeStudioInstance,
  makeTempDataDir,
  type StudioInstance,
  type StudioInstanceOptions,
} from "./helpers.ts";

const staticDir = fileURLToPath(new URL("../public/", import.meta.url));

/* ------------------------------------------------------------------ */
/* HTTP + SSE 辅助                                                      */
/* ------------------------------------------------------------------ */

interface JsonOutcome {
  status: number;
  body: any;
}

async function call(url: string, method: string, body?: unknown): Promise<JsonOutcome> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed: any = null;
  try {
    parsed = await response.json();
  } catch {
    /* 非 JSON 响应体 */
  }
  return { status: response.status, body: parsed };
}

interface SseFrame {
  event: string;
  data: any;
}

interface SseReader {
  /** 等待下一帧（5s 安全超时，防测试挂死）。 */
  next(): Promise<SseFrame>;
  /** 非阻塞读取已缓冲的帧。 */
  drain(): SseFrame[];
  /** 等待并收集直到满足条件或超时（返回收集结果）。 */
  collectUntil(predicate: (frame: SseFrame) => boolean, timeoutMs?: number): Promise<SseFrame[]>;
  close(): Promise<void>;
}

/**
 * fetch + ReadableStream 的最小 SSE 读取器：按空行分帧，解析 event:/data:
 * 行（注释/心跳帧跳过）。close() 中止连接（服务端 req close 即退订）。
 */
async function openSse(url: string): Promise<SseReader> {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  if (!response.ok || response.body === null) {
    throw new Error(`SSE connect failed: HTTP ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;
  const pending: SseFrame[] = [];
  const waiters: Array<(frame: SseFrame | null) => void> = [];
  const pushFrame = (frame: SseFrame): void => {
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter(frame);
    else pending.push(frame);
  };
  const parseBuffer = (): void => {
    for (let index = buffer.indexOf("\n\n"); index >= 0; index = buffer.indexOf("\n\n")) {
      const frameText = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const eventName = /^event: (.+)$/m.exec(frameText);
      const dataLine = /^data: (.+)$/m.exec(frameText);
      if (eventName === null || dataLine === null) continue; // ": connected" / ": heartbeat"
      pushFrame({ event: eventName[1]!, data: JSON.parse(dataLine[1]!) });
    }
  };
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done: finished } = await reader.read();
        if (finished) break;
        buffer += decoder.decode(value, { stream: true });
        parseBuffer();
      }
    } catch {
      /* 客户端 abort：正常关闭路径 */
    }
    done = true;
    while (waiters.length > 0) {
      waiters.shift()!(null);
    }
  })();
  return {
    async next() {
      const buffered = pending.shift();
      if (buffered !== undefined) return buffered;
      if (done) throw new Error("SSE stream ended before the next frame arrived");
      const frame = await Promise.race([
        new Promise<SseFrame | null>((resolve) => {
          waiters.push(resolve);
        }),
        new Promise<null>((resolve) => {
          setTimeout(() => resolve(null), 5000).unref?.();
        }),
      ]);
      if (frame === null) throw new Error("timed out waiting for the next SSE frame");
      return frame;
    },
    drain() {
      return pending.splice(0);
    },
    async collectUntil(predicate, timeoutMs = 5000) {
      const collected: SseFrame[] = [];
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return collected;
        const buffered = pending.shift();
        if (buffered !== undefined) {
          collected.push(buffered);
          if (predicate(buffered)) return collected;
          continue;
        }
        if (done) return collected;
        const frame = await Promise.race([
          new Promise<SseFrame | null>((resolve) => {
            waiters.push(resolve);
          }),
          new Promise<null>((resolve) => {
            setTimeout(() => resolve(null), remaining).unref?.();
          }),
        ]);
        if (frame === null) return collected;
        collected.push(frame);
        if (predicate(frame)) return collected;
      }
    },
    async close() {
      controller.abort();
      await pump.catch(() => undefined);
    },
  };
}

interface RunningStudio {
  port: number;
  instance: StudioInstance;
  url(path: string): string;
  close(): Promise<void>;
}

async function startStudio(
  dir: string,
  registry: RunningStudio[],
  options?: StudioInstanceOptions,
): Promise<RunningStudio> {
  const studio = makeStudioInstance(dir, options);
  const server = createStudioServer({ service: studio.service, staticDir });
  const port = await server.listen(0);
  let closed = false;
  const running: RunningStudio = {
    port,
    instance: studio,
    url: (path: string) => `http://127.0.0.1:${port}${path}`,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await server.close();
      await studio.shutdown();
    },
  };
  registry.push(running);
  return running;
}

async function closeAll(registry: RunningStudio[]): Promise<void> {
  for (const running of registry) {
    try {
      await running.close();
    } catch {
      /* 关闭失败不掩盖测试断言失败 */
    }
  }
}

async function createTree(studio: RunningStudio): Promise<{ treeId: string; trunkBranchId: string; treePath: (action?: string) => string }> {
  const created = await call(studio.url("/api/trees"), "POST", {});
  assert.equal(created.status, 201);
  const treeId: string = created.body.tree.id;
  // action 含前导斜杠（如 "/prompt"）；无 action 返回树根路径。
  const treePath = (action?: string) => `/api/trees/${encodeURIComponent(treeId)}${action ?? ""}`;
  return { treeId, trunkBranchId: created.body.trunkBranchId, treePath };
}

/* ------------------------------------------------------------------ */
/* 脚本化 runtime（服务级 tool-activity 保守投影测试）                   */
/* ------------------------------------------------------------------ */

/**
 * 最小脚本化 PiRuntime：createSession 返回固定引用；prompt 同步推送
 * agent.started → tool.execution.started（携带敏感参数——用于断言保守
 * 投影）→ tool.execution.finished → message.updated → agent.settled 后
 * resolve。不触文件系统；只为验证服务的事件面/journal 投影。
 */
function makeToolScriptedRuntime(): { runtime: PiRuntime; emitted: PiRuntimeEvent[] } {
  const listeners = new Set<(event: PiRuntimeEvent) => void>();
  let seq = 0;
  const reference = {
    sessionId: "scripted-session" as PiSessionId,
    sessionFile: "sessions/scripted-session.jsonl",
    entryId: "entry-1" as PiEntryId,
    piVersion: "0.85.1" as PiVersion,
    availability: { status: "available" as const },
  };
  const emitted: PiRuntimeEvent[] = [];
  const emit = (kind: PiRuntimeEvent["kind"], payload: unknown): void => {
    seq += 1;
    const event: PiRuntimeEvent = {
      eventId: `scripted-${seq}` as PiRuntimeEvent["eventId"],
      seq,
      occurredAt: new Date().toISOString(),
      kind,
      payload: payload as PiRuntimeEvent["payload"],
    };
    emitted.push(event);
    for (const listener of [...listeners]) listener(event);
  };
  const runtime: PiRuntime = {
    piVersion: "0.85.1" as PiVersion,
    async createSession(): Promise<PiSessionSnapshot> {
      emit("session.created", { sessionId: reference.sessionId, sessionFile: reference.sessionFile });
      return { reference: { ...reference } };
    },
    async restoreSession(): Promise<PiSessionSnapshot> {
      return { reference: { ...reference } };
    },
    async prompt() {
      emit("agent.started", {});
      emit("tool.execution.started", {
        toolName: "bash",
        // 敏感参数：绝不允许进入事件面/journal 投影。
        args: { command: "cat /Users/tal/secret-path.txt" },
        host: "workstation",
      });
      emit("tool.execution.finished", { toolName: "bash", isError: false });
      emit("message.updated", { delta: "scripted answer" });
      emit("agent.settled", {});
      return { message: "scripted answer", reference: { ...reference } };
    },
    async steer(): Promise<void> {},
    async abort(): Promise<void> {},
    async navigateTree(): Promise<never> {
      throw new Error("scripted runtime: navigateTree is not exercised");
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async dispose(): Promise<void> {
      listeners.clear();
    },
  };
  return { runtime, emitted };
}

/* ------------------------------------------------------------------ */
/* 1. SSE 流式                                                          */
/* ------------------------------------------------------------------ */

test("SSE streaming: snapshot, run-started, message deltas, run-terminal; clean disconnect", async () => {
  const dir = makeTempDataDir();
  const running: RunningStudio[] = [];
  try {
    const studio = await startStudio(dir, running, { echoTurnDelayMs: 20 });
    const { treeId, trunkBranchId, treePath } = await createTree(studio);

    const sse = await openSse(studio.url(treePath("/events")));
    const snapshot = await sse.next();
    assert.equal(snapshot.event, "snapshot");
    assert.equal(snapshot.data.treeId, treeId);
    assert.equal(snapshot.data.runtimeState, "idle");
    assert.equal(snapshot.data.activeRun, null);
    assert.deepEqual(snapshot.data.runs, []);

    /* 在途 prompt：SSE 推送流式事件。 */
    const promptPromise = call(studio.url(treePath("/prompt")), "POST", {
      branchId: trunkBranchId,
      text: "stream-me",
    });
    const runStarted = await sse.next();
    assert.equal(runStarted.event, "run-started");
    assert.equal(runStarted.data.treeId, treeId);
    assert.equal(runStarted.data.branchId, trunkBranchId);
    const runId: string = runStarted.data.runId;
    assert.ok(typeof runId === "string" && runId.length > 0);

    const frames = await sse.collectUntil((frame) => frame.event === "run-terminal");
    const deltas = frames.filter((frame) => frame.event === "message-delta");
    assert.ok(deltas.length >= 1, "at least one message-delta must arrive during the in-flight prompt");
    const combined = deltas.map((frame) => frame.data.delta).join("");
    assert.equal(combined, "echo:[stream-me]");
    for (const delta of deltas) {
      assert.deepEqual(Object.keys(delta.data).sort(), ["delta", "runId", "treeId", "type"]);
      assert.equal(delta.data.type, "message-delta");
      assert.equal(delta.data.runId, runId);
    }

    const terminal = frames.find((frame) => frame.event === "run-terminal");
    assert.ok(terminal !== undefined);
    assert.deepEqual(
      Object.keys(terminal.data).sort(),
      ["failure", "runId", "state", "treeId", "type"],
    );
    assert.equal(terminal.data.state, "succeeded");
    assert.equal(terminal.data.failure, null);
    assert.equal(terminal.data.runId, runId);

    /* 无工具活动事件（离线驱动如实无工具）。 */
    assert.equal(frames.filter((frame) => frame.event === "tool-activity").length, 0);

    /* 客户端断开：干净关闭（服务端退订），prompt 如常完成，服务仍健康。 */
    await sse.close();
    const promptRes = await promptPromise;
    assert.equal(promptRes.status, 200);
    assert.equal(promptRes.body.outcome.assistantTurn.text, "echo:[stream-me]");
    const diag = await call(studio.url(treePath("/diagnostics")), "GET");
    assert.equal(diag.status, 200);
    assert.equal(diag.body.runtimeState, "idle");
    assert.equal(diag.body.runs.length, 1);
  } finally {
    await closeAll(running);
    cleanupDir(dir);
  }
});

/* ------------------------------------------------------------------ */
/* 2. 模型错误（echo /fail 注入）                                        */
/* ------------------------------------------------------------------ */

test("model error injection: run converges failed across HTTP, diagnostics, journal and SSE", async () => {
  const dir = makeTempDataDir();
  const running: RunningStudio[] = [];
  const journal = new MemoryEventJournal();
  try {
    const studio = await startStudio(dir, running, { journal });
    const { treeId, trunkBranchId, treePath } = await createTree(studio);

    const sse = await openSse(studio.url(treePath("/events")));
    await sse.next(); // snapshot

    /* /fail 前缀 → 上游失败注入（echo-port 文档化的确定性测试钩子）。 */
    const failed = await call(studio.url(treePath("/prompt")), "POST", {
      branchId: trunkBranchId,
      text: "/fail please",
    });
    assert.equal(failed.status, 502);
    assert.equal(failed.body.error.code, "upstream");
    assert.match(failed.body.error.message, /simulated upstream failure/);

    /* 失败不产生 turn；诊断面呈现失败 run（code+message）。 */
    const state = await call(studio.url(treePath("/state")), "GET");
    const trunkTurns = state.body.branches.find((v: any) => v.branch.id === trunkBranchId).turns;
    assert.equal(trunkTurns.length, 0, "the failed prompt persists no turns");
    const diag = await call(studio.url(treePath("/diagnostics")), "GET");
    assert.equal(diag.body.runs.length, 1);
    const failedRun = diag.body.runs[0];
    assert.equal(failedRun.state, "failed");
    assert.deepEqual(Object.keys(failedRun.failure).sort(), ["code", "message"]);
    assert.equal(failedRun.failure.code, "upstream");

    /* SSE：run-started → run-terminal failed（含失败 code/message）。 */
    const runStarted = await sse.next();
    assert.equal(runStarted.event, "run-started");
    const frames = await sse.collectUntil((frame) => frame.event === "run-terminal");
    const terminal = frames.find((frame) => frame.event === "run-terminal");
    assert.ok(terminal !== undefined);
    assert.equal(terminal.data.state, "failed");
    assert.equal(terminal.data.failure.code, "upstream");
    assert.equal(terminal.data.runId, failedRun.runId);
    await sse.close();

    /* journal：run 生命周期事件落库（含 session.created 归属 + 显式
       queued→running + runtime.error 适配），投影与 DB 一致且无异常。 */
    const runId = failedRun.runId as RunId;
    const projection = journal.projectRunState(runId);
    assert.ok(projection !== null);
    assert.equal(projection.state, "failed", "journal projection must agree with the DB run state");
    assert.equal(projection.failure?.code, "upstream");
    assert.deepEqual(projection.anomalies, [], "no projection anomalies (ordering discipline)");

    const events = studio.instance.service.getTreeJournal(treeId as TreeId);
    const types = events.map((event) => event.type);
    assert.equal(types[0], "session.created", "session alignment events are attributed to the run they enabled");
    assert.ok(types.includes("run.state-changed"));
    assert.ok(types.includes("agent.started"));
    assert.ok(types.includes("runtime.error"));
    const runtimeError = events.find((event) => event.type === "runtime.error");
    assert.ok(runtimeError !== undefined);
    assert.match(runtimeError.summary, /upstream/);
    /* 保守投影键集合精确锁定（多一个键即失败：防 payload 外泄回归）。 */
    for (const event of events) {
      assert.deepEqual(
        Object.keys(event).sort(),
        ["eventId", "occurredAt", "runId", "seq", "summary", "type"],
      );
    }
  } finally {
    await closeAll(running);
    cleanupDir(dir);
  }
});

/* ------------------------------------------------------------------ */
/* 3. abort 顺序（SSE + journal 一致）                                   */
/* ------------------------------------------------------------------ */

test("abort over SSE: abort-requested precedes run-terminal aborted; journal projection agrees", async () => {
  const dir = makeTempDataDir();
  const running: RunningStudio[] = [];
  const journal = new MemoryEventJournal();
  try {
    const studio = await startStudio(dir, running, { echoTurnDelayMs: 25, journal });
    const { treeId, trunkBranchId, treePath } = await createTree(studio);

    const sse = await openSse(studio.url(treePath("/events")));
    await sse.next(); // snapshot

    const promptPromise = call(studio.url(treePath("/prompt")), "POST", {
      branchId: trunkBranchId,
      text: "abort-me",
    });
    const runStarted = await sse.next();
    assert.equal(runStarted.event, "run-started");
    const runId: string = runStarted.data.runId;

    const abortRes = await call(studio.url(treePath(`/runs/${encodeURIComponent(runId)}/abort`)), "POST");
    assert.equal(abortRes.status, 200);

    const frames = await sse.collectUntil((frame) => frame.event === "run-terminal");
    const abortIndex = frames.findIndex((frame) => frame.event === "abort-requested");
    const terminalIndex = frames.findIndex((frame) => frame.event === "run-terminal");
    assert.ok(abortIndex >= 0, "abort-requested must arrive");
    assert.ok(terminalIndex > abortIndex, "run-terminal must follow abort-requested");
    const abortFrame = frames[abortIndex]!;
    assert.deepEqual(abortFrame.data, { type: "abort-requested", treeId, runId });
    const terminal = frames[terminalIndex]!;
    assert.equal(terminal.data.state, "aborted");
    assert.equal(terminal.data.failure, null);
    await sse.close();

    const promptRes = await promptPromise;
    assert.equal(promptRes.status, 409);
    assert.equal(promptRes.body.error.code, "user-abort");

    const diag = await call(studio.url(treePath("/diagnostics")), "GET");
    assert.equal(diag.body.runtimeState, "idle");
    const abortedRun = diag.body.runs.find((r: any) => r.runId === runId);
    assert.equal(abortedRun.state, "aborted");
    assert.equal(abortedRun.failure, null);

    /* journal：aborted 收敛一致、无投影异常（服务侧与运行时侧的
       abort-requested 均记录，投影幂等）。 */
    const projection = journal.projectRunState(runId as RunId);
    assert.equal(projection?.state, "aborted");
    assert.deepEqual(projection?.anomalies, []);
    const abortEvents = studio.instance.service
      .getTreeJournal(treeId as TreeId)
      .filter((event) => event.type === "run.abort-requested");
    assert.ok(abortEvents.length >= 1, "the abort request is journaled");
  } finally {
    await closeAll(running);
    cleanupDir(dir);
  }
});

/* ------------------------------------------------------------------ */
/* 4. session 删除降级（A4）                                             */
/* ------------------------------------------------------------------ */

test("session deletion: readable tree, unavailable branch, fail-closed prompt with no partial writes, recovery path", async () => {
  const dir = makeTempDataDir();
  const running: RunningStudio[] = [];
  const journal = new MemoryEventJournal();
  try {
    const studio = await startStudio(dir, running, { journal });
    const { treeId, trunkBranchId, treePath } = await createTree(studio);

    /* 一次成功 prompt（session 创建）。 */
    const t1 = await call(studio.url(treePath("/prompt")), "POST", { branchId: trunkBranchId, text: "hi" });
    assert.equal(t1.status, 200);
    const healthyState = await call(studio.url(treePath("/state")), "GET");
    const healthyTrunk = healthyState.body.branches.find((v: any) => v.branch.id === trunkBranchId);
    assert.equal(healthyTrunk.sessionAvailability, "available");

    /* 删除 session 文件（保留 DB；D2 语义：域数据绝不级联删除）。
       整进程重启（内存 cursor/会话清空——既有 D2 模式；进程内旧会话在
       文件删除后仍可能续聊，重启后才是 fail-closed 的确定性场景）。 */
    const sessionsDir = join(dir, "sessions");
    const sessionFiles = readdirSync(sessionsDir);
    assert.equal(sessionFiles.length, 1, "one session file per tree");
    rmSync(join(sessionsDir, sessionFiles[0]!));
    await studio.close();
    const studio2 = await startStudio(dir, running, { journal });
    assert.equal(running.length, 2, "the first instance is closed; a fresh one owns the data dir");

    /* A4：getTreeState 仍成功；受影响分支 sessionAvailability 降级；树可读。 */
    const degraded = await call(studio2.url(treePath("/state")), "GET");
    assert.equal(degraded.status, 200);
    const degradedTrunk = degraded.body.branches.find((v: any) => v.branch.id === trunkBranchId);
    assert.equal(degradedTrunk.sessionAvailability, "unavailable");
    assert.equal(degradedTrunk.turns.length, 2, "the tree stays fully readable (DB is the fact source)");
    assert.equal(degradedTrunk.turns.map((t: any) => t.role).join(","), "user,assistant");

    /* 打开 SSE（观测降级期间的失败 prompt 不产生幽灵 run 事件）。 */
    const sse = await openSse(studio2.url(treePath("/events")));
    const snapshot = await sse.next();
    assert.equal(snapshot.event, "snapshot");
    assert.equal(snapshot.data.runtimeState, "idle");

    /* 续聊 fail-closed：prompt 502 session-corrupt，零部分写入。 */
    const runsBefore = (await call(studio2.url(treePath("/diagnostics")), "GET")).body.runs.length;
    const journalEventsBefore = studio2.instance.service.getTreeJournal(treeId as TreeId).length;
    const failedPrompt = await call(studio2.url(treePath("/prompt")), "POST", { branchId: trunkBranchId, text: "again" });
    assert.equal(failedPrompt.status, 502);
    assert.equal(failedPrompt.body.error.code, "session-corrupt");

    const diagAfter = await call(studio2.url(treePath("/diagnostics")), "GET");
    assert.equal(diagAfter.body.runs.length, runsBefore, "no new run row (fail before run creation)");
    const stateAfter = await call(studio2.url(treePath("/state")), "GET");
    const turnsAfter = stateAfter.body.branches.flatMap((v: any) => v.turns);
    assert.equal(turnsAfter.length, 2, "no new turn rows (no partial writes)");
    assert.equal(
      studio2.instance.service.getTreeJournal(treeId as TreeId).length,
      journalEventsBefore,
      "no journal events for a run that was never created",
    );

    /* SSE：失败发生在 run 创建之前 → 无 run 事件（50ms 宽限让帧抵达）。 */
    await new Promise((resolve) => setTimeout(resolve, 50));
    const drained = sse.drain();
    assert.equal(drained.length, 0, "no SSE frames beyond the snapshot (no run was created)");
    await sse.close();

    /* 恢复路径：健康树上从 session 可用的 trunk 答案建分支并续聊。 */
    const tree2 = await createTree(studio2);
    const fresh = await call(studio2.url(tree2.treePath("/prompt")), "POST", {
      branchId: tree2.trunkBranchId,
      text: "fresh",
    });
    assert.equal(fresh.status, 200, "a fresh tree recovers with a new session");
    const branchRes = await call(studio2.url(tree2.treePath("/branches")), "POST", {
      sourceBranchId: tree2.trunkBranchId,
      anchorTurnId: fresh.body.outcome.assistantTurn.id,
      selection: { start: 0, end: 2, text: fresh.body.outcome.assistantTurn.text.slice(0, 2) },
    });
    assert.equal(branchRes.status, 201);
    const continued = await call(studio2.url(tree2.treePath("/prompt")), "POST", {
      branchId: branchRes.body.branch.id,
      text: "continue",
    });
    assert.equal(continued.status, 200, "branching from a turn with an available session recovers");
    assert.equal(continued.body.outcome.assistantTurn.text, "echo:[fresh|continue]");
  } finally {
    await closeAll(running);
    cleanupDir(dir);
  }
});

/* ------------------------------------------------------------------ */
/* 5. 进程重启：journal 与 DB/诊断面一致收敛                             */
/* ------------------------------------------------------------------ */

test("process restart: journal and diagnostics converge consistently (host-crash semantics)", async () => {
  const dir = makeTempDataDir();
  const running: RunningStudio[] = [];
  const journalPath = join(dir, "journal.jsonl");
  try {
    const journal1 = await JsonlEventJournal.open(journalPath);
    const studio = await startStudio(dir, running, { journal: journal1 });
    const { treeId, trunkBranchId, treePath } = await createTree(studio);

    /* 一个成功 run（journal 事件完整落库）。 */
    const t1 = await call(studio.url(treePath("/prompt")), "POST", { branchId: trunkBranchId, text: "q1" });
    assert.equal(t1.status, 200);
    const succeededRunId = t1.body.outcome.run.id as RunId;

    /* 模拟宿主崩溃残留：DB 造一个非终态 run + journal 记录 agent.started
       （run 进入 running 后进程"死亡"——无收敛事件）。 */
    const episode = studio.instance.repository.createEpisode(trunkBranchId as BranchId);
    const interrupted = studio.instance.repository.createRun(episode.id, {
      sessionId: "s-crash" as PiSessionId,
      sessionFile: "sessions/never.jsonl",
      entryId: "e-crash" as PiEntryId,
      piVersion: "0.85.1" as PiVersion,
      availability: { status: "available" },
    });
    studio.instance.repository.updateRunState(interrupted.id, "running");
    await new EventRecorder(journal1).recordAgentStarted(interrupted.id);

    /* "进程死亡" + 重启：同一数据目录、同一 journal 文件、全新实例。 */
    await studio.close();
    await journal1.close();
    const journal2 = await JsonlEventJournal.open(journalPath);
    const studio2 = await startStudio(dir, running, { journal: journal2 });

    /* 构造期自动恢复（service.journalRecovery 可确定性 await）。 */
    const recovery = studio2.instance.service.journalRecovery;
    assert.ok(recovery !== null, "journal recovery runs when a journal is injected");
    const report = await recovery;
    assert.equal(report.recovered.length, 1, "exactly the interrupted run is recovered");
    assert.equal(report.recovered[0]!.runId, interrupted.id);
    assert.equal(report.recovered[0]!.resolvedTo, "failed");

    /* 三方一致：DB run 状态 = journal 投影 = 诊断面投影。 */
    const dbRun = studio2.instance.repository.getRun(interrupted.id);
    assert.equal(dbRun.state, "failed");
    assert.equal(dbRun.failure?.code, "unknown");
    const projection = journal2.projectRunState(interrupted.id);
    assert.equal(projection?.state, "failed");
    assert.deepEqual(projection?.anomalies, []);
    const diag = await call(studio2.url(treePath("/diagnostics")), "GET");
    const recoveredView = diag.body.runs.find((r: any) => r.runId === interrupted.id);
    assert.ok(recoveredView !== undefined);
    assert.equal(recoveredView.state, "failed");
    assert.deepEqual(Object.keys(recoveredView.failure).sort(), ["code", "message"]);
    assert.equal(recoveredView.failure.code, "unknown");

    /* 重启前的成功 run：journal 事件跨重启保留，投影仍 succeeded。 */
    assert.equal(journal2.projectRunState(succeededRunId)?.state, "succeeded");
    const journalView = studio2.instance.service.getTreeJournal(treeId as TreeId);
    assert.ok(journalView.some((event) => event.type === "runtime.recovered"));
    const recoveredEvent = journalView.find((event) => event.type === "runtime.recovered");
    assert.match(recoveredEvent!.summary, /recovered/);
    assert.match(recoveredEvent!.summary, /failed/);
    /* journal 尾部最新在后（恢复事件晚于成功 run 的事件）。 */
    assert.equal(journalView[journalView.length - 1]!.type, "runtime.recovered");
    await journal2.close();
  } finally {
    await closeAll(running);
    cleanupDir(dir);
  }
});

/* ------------------------------------------------------------------ */
/* 6. 权限越权（诚实边界）+ 合成 tool.decision 保守投影                  */
/* ------------------------------------------------------------------ */

test("policy boundary: offline studio observes no tool decisions; synthetic tool.decision projects conservatively", async () => {
  const dir = makeTempDataDir();
  const running: RunningStudio[] = [];
  const journal = new MemoryEventJournal();
  try {
    const studio = await startStudio(dir, running, { journal });
    const { treeId, trunkBranchId, treePath } = await createTree(studio);

    const sse = await openSse(studio.url(treePath("/events")));
    await sse.next(); // snapshot

    const t1 = await call(studio.url(treePath("/prompt")), "POST", { branchId: trunkBranchId, text: "q" });
    assert.equal(t1.status, 200);
    const frames = await sse.collectUntil((frame) => frame.event === "run-terminal");
    await sse.close();

    /* 空工具 allowlist：无工具事件、策略决策如实未观测。 */
    assert.equal(frames.filter((frame) => frame.event === "tool-activity").length, 0);
    const diag = await call(studio.url(treePath("/diagnostics")), "GET");
    assert.equal(diag.body.policyDecisions.observed, false);
    assert.match(diag.body.policyDecisions.reason, /empty tool allowlist/);
    const events = studio.instance.service.getTreeJournal(treeId as TreeId);
    assert.equal(events.filter((event) => event.type.startsWith("tool.")).length, 0);

    /* 合成 tool.decision（真实 Pi + ToolPolicy 集成的形态）直接写入
       journal：/journal 投影必须保守呈现（工具名/判定，参数与路径绝不外泄）。 */
    const runId = t1.body.outcome.run.id as RunId;
    const recorder = new EventRecorder(journal);
    await recorder.recordCustom(runId, "tool.decision", {
      toolName: "bash",
      decision: "denied",
      args: { command: "cat /Users/tal/secret-path.txt" },
    });
    await recorder.recordCustom(runId, "tool.execution.started", {
      toolName: "bash",
      args: { command: "rm -rf /Users/tal/secret-target" },
    });

    const projected = studio.instance.service.getTreeJournal(treeId as TreeId);
    const decision = projected.find((event) => event.type === "tool.decision");
    const toolStart = projected.find((event) => event.type === "tool.execution.started");
    assert.ok(decision !== undefined, "the synthetic tool decision is surfaced (conservatively)");
    assert.match(decision.summary, /bash/);
    assert.match(decision.summary, /denied/);
    assert.ok(toolStart !== undefined);
    assert.match(toolStart.summary, /bash/);

    /* 全投影扫描：合成 payload 中的路径/命令绝不出现。 */
    const serialized = JSON.stringify(projected);
    for (const forbidden of ["secret-path", "secret-target", "rm -rf", "command", "args"]) {
      assert.ok(!serialized.includes(forbidden), `/journal projection must not expose '${forbidden}'`);
    }
  } finally {
    await closeAll(running);
    cleanupDir(dir);
  }
});

/* ------------------------------------------------------------------ */
/* 7. journal 端点                                                       */
/* ------------------------------------------------------------------ */

test("journal endpoint: tree-filtered, newest last, limit respected, 404/400 mapping", async () => {
  const dir = makeTempDataDir();
  const running: RunningStudio[] = [];
  const journal = new MemoryEventJournal();
  try {
    const studio = await startStudio(dir, running, { journal });
    const treeA = await createTree(studio);
    const treeB = await createTree(studio);
    await call(studio.url(treeA.treePath("/prompt")), "POST", { branchId: treeA.trunkBranchId, text: "a1" });
    await call(studio.url(treeA.treePath("/prompt")), "POST", { branchId: treeA.trunkBranchId, text: "a2" });
    await call(studio.url(treeB.treePath("/prompt")), "POST", { branchId: treeB.trunkBranchId, text: "b1" });

    /* 按树过滤：treeA 的 journal 只含 treeA 的 run。 */
    const resA = await call(studio.url(treeA.treePath("/journal")), "GET");
    assert.equal(resA.status, 200);
    const eventsA: any[] = resA.body.events;
    assert.ok(eventsA.length > 0);
    const diagA = await call(studio.url(treeA.treePath("/diagnostics")), "GET");
    const runIdsA = new Set<string>(diagA.body.runs.map((r: any) => r.runId));
    for (const event of eventsA) {
      assert.ok(runIdsA.has(event.runId), "journal events must be filtered to the tree's runs");
    }

    /* 最新在后（occurredAt 非降序）；最后一条是最新 run 的收敛事件。 */
    for (let i = 1; i < eventsA.length; i += 1) {
      assert.ok(eventsA[i - 1]!.occurredAt <= eventsA[i]!.occurredAt, "newest last (chronological order)");
    }
    const lastRunId = diagA.body.runs[diagA.body.runs.length - 1].runId;
    assert.equal(eventsA[eventsA.length - 1]!.runId, lastRunId);
    assert.equal(eventsA[eventsA.length - 1]!.type, "agent.settled");

    /* limit 截尾保留最新 N 条。 */
    const limited = await call(studio.url(`${treeA.treePath("/journal")}?limit=2`), "GET");
    assert.equal(limited.status, 200);
    assert.equal(limited.body.events.length, 2);
    assert.equal(limited.body.events[1]!.type, "agent.settled");
    assert.deepEqual(limited.body.events[1], eventsA[eventsA.length - 1]);

    /* 未知树 → 404；非法 limit → 400；上限 500 放行。 */
    const unknownTree = await call(
      studio.url(`/api/trees/${encodeURIComponent("tree-missing")}/journal`),
      "GET",
    );
    assert.equal(unknownTree.status, 404);
    for (const badLimit of ["0", "-1", "abc", "501", "1.5"]) {
      const bad = await call(studio.url(`${treeA.treePath("/journal")}?limit=${badLimit}`), "GET");
      assert.equal(bad.status, 400, `limit=${badLimit} must be rejected`);
      assert.equal(bad.body.error.code, "invalid-argument");
    }
    const maxLimit = await call(studio.url(`${treeA.treePath("/journal")}?limit=500`), "GET");
    assert.equal(maxLimit.status, 200);

    /* 事件流端点动词守卫与未知树 404（JSON、切流之前）。 */
    const wrongMethod = await call(studio.url(treeA.treePath("/events")), "POST", {});
    assert.equal(wrongMethod.status, 405);
    const unknownTreeEvents = await call(
      studio.url(`/api/trees/${encodeURIComponent("tree-missing")}/events`),
      "GET",
    );
    assert.equal(unknownTreeEvents.status, 404);
    assert.equal(unknownTreeEvents.body.error.code, "not-found");
    const eventsHead = await fetch(studio.url(treeA.treePath("/events")));
    assert.equal(eventsHead.status, 200);
    assert.match(eventsHead.headers.get("content-type") ?? "", /text\/event-stream/);
    assert.equal(eventsHead.headers.get("cache-control"), "no-store");
    await eventsHead.body?.cancel();
  } finally {
    await closeAll(running);
    cleanupDir(dir);
  }
});

/* ------------------------------------------------------------------ */
/* 8. 服务级事件面：tool-activity 保守投影 + 退订                         */
/* ------------------------------------------------------------------ */

test("tool-activity events project tool name and phase only (scripted runtime)", async () => {
  const dir = makeTempDataDir();
  try {
    const { runtime } = makeToolScriptedRuntime();
    const journal = new MemoryEventJournal();
    const studio = makeStudioInstance(dir, { runtime, journal });
    const created = studio.service.createTree();
    const treeId = created.tree.id;

    const collected: any[] = [];
    const unsubscribe = studio.service.subscribeStudioEvents((event) => {
      collected.push(event);
    });

    const outcome = await studio.service.prompt(treeId, created.trunkBranch.id, "use a tool");
    assert.equal(outcome.assistantTurn.text, "scripted answer");

    const toolEvents = collected.filter((event) => event.type === "tool-activity");
    assert.equal(toolEvents.length, 2);
    assert.deepEqual(
      toolEvents.map((event) => ({ tool: event.tool, phase: event.phase })),
      [
        { tool: "bash", phase: "started" },
        { tool: "bash", phase: "finished" },
      ],
    );
    /* 保守投影：键集合锁定；敏感参数/主机/路径绝不外泄。 */
    for (const event of toolEvents) {
      assert.deepEqual(Object.keys(event).sort(), ["phase", "runId", "tool", "treeId", "type"]);
    }
    const serialized = JSON.stringify(collected);
    for (const forbidden of ["secret-path", "command", "args", "workstation", "cat /Users"]) {
      assert.ok(!serialized.includes(forbidden), `studio events must not expose '${forbidden}'`);
    }
    /* message-delta 也经事件面透出。 */
    assert.ok(collected.some((event) => event.type === "message-delta" && event.delta === "scripted answer"));
    /* run 生命周期事件。 */
    assert.ok(collected.some((event) => event.type === "run-started"));
    assert.ok(collected.some((event) => event.type === "run-terminal" && event.state === "succeeded"));

    /* journal 投影：工具事件的 summary 只有工具名（参数留在 payload 内、
       不进投影）。 */
    const journalView = studio.service.getTreeJournal(treeId);
    const toolJournal = journalView.filter((event) => event.type.startsWith("tool."));
    assert.equal(toolJournal.length, 2);
    assert.match(toolJournal[0]!.summary, /bash/);
    const journalSerialized = JSON.stringify(journalView);
    for (const forbidden of ["secret-path", "command", "rm -rf", "workstation"]) {
      assert.ok(!journalSerialized.includes(forbidden), `journal projection must not expose '${forbidden}'`);
    }

    /* 退订生效：退订后不再收到事件。 */
    unsubscribe();
    const before = collected.length;
    await studio.service.prompt(treeId, created.trunkBranch.id, "after unsubscribe");
    assert.equal(collected.length, before, "unsubscribed listeners receive nothing");

    await studio.shutdown();
    await journal.close();
  } finally {
    cleanupDir(dir);
  }
});

/* ------------------------------------------------------------------ */
/* A4 可用性推导边界（服务级）                                           */
/* ------------------------------------------------------------------ */

test("session availability derivation: live probe refines the cached assessment honestly", async () => {
  const dir = makeTempDataDir();
  try {
    const studio = makeStudioInstance(dir);
    const { service, repository } = studio;
    const created = service.createTree();
    const treeId = created.tree.id;
    const t1 = await service.prompt(treeId, created.trunkBranch.id, "q1");
    const sessionFile = repository.getRun(t1.run.id).session.sessionFile;
    const sessionContent = readFileSync(sessionFile, "utf8");

    const availability = (): "available" | "unavailable" | null =>
      service.getTreeState(treeId).branches[0]!.sessionAvailability;

    /* 健康基线。 */
    assert.equal(availability(), "available");

    /* 文件缺失（DB 缓存尚为 available）：实时探针降级。 */
    rmSync(sessionFile);
    assert.equal(availability(), "unavailable", "a missing file degrades the live view immediately");

    /* DB 因 missing-file 降级 + 文件恢复：实时探针回到 available（可修复）。 */
    repository.markSessionFileAvailability(sessionFile, false);
    assert.equal(availability(), "unavailable");
    writeFileSync(sessionFile, sessionContent, "utf8");
    assert.equal(availability(), "available", "a restored file recovers the missing-file degradation");

    /* DB 因其他原因降级（version-mismatch）：文件存在也维持 unavailable
       （存在性探针看不见版本不兼容，不谎报恢复）。 */
    repository.updateSessionAvailability(t1.run.id, { status: "unavailable", reason: "version-mismatch" });
    assert.equal(availability(), "unavailable");

    /* 无 run 无 origin 的 Trunk（新建树）：无会话 → null。 */
    const fresh = service.createTree();
    assert.equal(service.getTreeState(fresh.tree.id).branches[0]!.sessionAvailability, null);

    /* 未知树 → 404 语义。 */
    assert.throws(() => service.getTreeState("tree-missing" as TreeId), /not found/);
    await studio.shutdown();
  } finally {
    cleanupDir(dir);
  }
});

/* ------------------------------------------------------------------ */
/* 9. 请求时策略门（issue #5 P0）：真实 ToolPolicyEngine 经 runtime 门    */
/* ------------------------------------------------------------------ */

test("policy request-time gate: denial surfaces provenance, fails the run, and reports honestly", async () => {
  const dir = makeTempDataDir();
  const workspace = join(dir, "workspace");
  const readRoot = join(dir, "read-root");
  mkdirSync(readRoot, { recursive: true });
  const outsideName = "secret-outside.txt";
  const journal = new MemoryEventJournal();
  try {
    /* 真实 ToolPolicyEngine（@treeai/tool-policy 工作区包）注入真实 PiRuntime；
       echo 驱动以 toolCalls 测试钩「请求」两次 read：root 内（allow）与
       root 外（deny）。决策发生在请求路径上——不是合成事件。 */
    const engine = new ToolPolicyEngine({
      cwd: workspace,
      readRoots: [readRoot],
      workspaceRoots: [workspace],
    });
    const port = new EchoSdkPort({
      toolCalls: [
        { name: "read", args: { path: join(readRoot, "notes.txt") } },
        { name: "read", args: { path: join(dir, outsideName) } },
      ],
    });
    const runtime = createPiRuntimeFromConfig({
      port,
      defaultCwd: workspace,
      toolPolicy: engine,
    });
    const studio = makeStudioInstance(dir, { runtime, journal });
    const created = studio.service.createTree();
    const treeId = created.tree.id;

    const collected: any[] = [];
    const unsubscribe = studio.service.subscribeStudioEvents((event) => {
      collected.push(event);
    });

    /* 越权 prompt 被拒（fail closed），DB run 收敛 failed(policy-denied)。 */
    await assert.rejects(
      studio.service.prompt(treeId, created.trunkBranch.id, "overreach"),
      (err: unknown) => {
        assert.equal((err as { code?: string }).code, "policy-denied");
        return true;
      },
    );

    /* 执行面（echo 驱动日志）：allow 的 read 执行了，deny 的没有。 */
    const session = port.createdSessions[0]!;
    assert.deepEqual(session.executedToolCalls, ["read"]);
    assert.deepEqual(session.blockedToolCalls, ["read"]);

    /* SSE：tool-activity —— allow 调用走 started/finished；被拒调用在
       started 与（error）finished 之间收到 phase "denied" + 决定
       provenance（键集锁定，无参数/路径/命令；denied 是唯一携带
       decision 的事件）。 */
    const toolEvents = collected.filter((event) => event.type === "tool-activity");
    assert.deepEqual(
      toolEvents.map((event) => ({ tool: event.tool, phase: event.phase })),
      [
        { tool: "read", phase: "started" },
        { tool: "read", phase: "finished" },
        { tool: "read", phase: "started" },
        { tool: "read", phase: "denied" },
        { tool: "read", phase: "finished" },
      ],
    );
    toolEvents.forEach((event, index) => {
      const expectedKeys =
        event.phase === "denied"
          ? ["decision", "phase", "runId", "tool", "treeId", "type"]
          : ["phase", "runId", "tool", "treeId", "type"];
      assert.deepEqual(
        Object.keys(event).sort(),
        expectedKeys,
        `tool-activity[${index}] key set`,
      );
    });
    const denied = toolEvents[3];
    assert.deepEqual(Object.keys(denied).sort(), [
      "decision",
      "phase",
      "runId",
      "tool",
      "treeId",
      "type",
    ]);
    assert.equal(denied.decision.outcome, "deny");
    assert.equal(denied.decision.ruleId, null);
    assert.match(denied.decision.reason, /outside every configured read root/);

    /* run-terminal：failed + policy-denied 失败码。 */
    const terminal = collected.find((event) => event.type === "run-terminal");
    assert.ok(terminal !== undefined);
    assert.equal(terminal.state, "failed");
    assert.equal(terminal.failure.code, "policy-denied");

    /* journal：两条 tool.decision（allow + deny）带 provenance summary。 */
    const journalView = studio.service.getTreeJournal(treeId);
    const decisions = journalView.filter((event) => event.type === "tool.decision");
    assert.equal(decisions.length, 2);
    assert.match(decisions[0]!.summary, /read/);
    assert.match(decisions[0]!.summary, /allow/);
    assert.match(decisions[1]!.summary, /deny/);
    assert.match(decisions[1]!.summary, /no rule/);

    /* 诊断面（A5）：观测如实——observed=true，含两条决定的脱敏投影；
       DB run 行 failed/policy-denied。 */
    const diag = studio.service.getTreeDiagnostics(treeId);
    assert.ok(diag.policyDecisions.observed === true);
    const views = diag.policyDecisions.decisions;
    assert.equal(views.length, 2);
    assert.deepEqual(
      views.map((view) => ({ tool: view.tool, outcome: view.outcome, ruleId: view.ruleId })),
      [
        { tool: "read", outcome: "allow", ruleId: "allow-read-configured-roots" },
        { tool: "read", outcome: "deny", ruleId: null },
      ],
    );
    assert.equal(diag.runs.length, 1);
    assert.equal(diag.runs[0]!.state, "failed");
    assert.equal(diag.runs[0]!.failure!.code, "policy-denied");

    /* 脱敏终检：目标路径/参数绝不进入任何界面面。 */
    const serialized =
      JSON.stringify(collected) + JSON.stringify(journalView) + JSON.stringify(diag);
    assert.ok(!serialized.includes(outsideName), "target paths never surface");
    assert.ok(!serialized.includes("notes.txt"), "target paths never surface");
    assert.ok(!serialized.includes("\"path\""), "raw argument keys never surface");

    unsubscribe();
    await studio.shutdown();
    await journal.close();
  } finally {
    cleanupDir(dir);
  }
});
