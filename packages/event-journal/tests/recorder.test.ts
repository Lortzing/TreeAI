/**
 * Recorder + Audit 测试（任务书 §5 Agent E 第 5、7 项）：
 * - PiRuntimeEvent 转换（已知 kind 一一映射、steer 重命名、未知 kind →
 *   pi.unknown + rawKind、非 record payload 包装、同一 Pi 事件重复记录拒绝）；
 * - recordError 不持久化 cause（contracts errors.ts 义务）；
 * - session reference 变化与 tree navigation 记录（含家目录路径兜底脱敏）；
 * - duration.recorded 与 payload.timing；
 * - buildRunAudit 提取错误/耗时/session 变化/导航；
 * - appendNext seq 自动分配。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  PiEntryId,
  PiRuntimeEvent,
  PiRuntimeEventKind,
  PiSessionId,
  PiVersion,
  SessionReference,
  TreeAIError,
} from "@treeai/contracts";
import { EventRecorder, piRuntimeEventKindToType } from "../src/recorder.js";
import { buildRunAudit } from "../src/audit.js";
import { MemoryEventJournal } from "../src/journal.js";
import { SYNTH, assertNoSynthSecrets, evtIdOf, runIdOf, T0, T1, T2 } from "./helpers.js";

const RUN = runIdOf("rec");

function piEvent(
  kind: PiRuntimeEventKind,
  payload: PiRuntimeEvent["payload"],
  label = "pi",
): PiRuntimeEvent {
  return {
    eventId: evtIdOf(label),
    seq: 1,
    occurredAt: T0,
    kind,
    payload,
  };
}

const availableRef = (n: number, sessionFile: string): SessionReference => ({
  sessionId: `sess-${n}` as PiSessionId,
  sessionFile,
  entryId: `entry-${n}` as PiEntryId,
  piVersion: "0.85.1" as PiVersion,
  availability: { status: "available" },
});

/* ------------------------------------------------------------------ */
/* PiRuntimeEvent 转换                                                 */
/* ------------------------------------------------------------------ */

test("piRuntimeEventKindToType maps known kinds, renames steer, and routes unknowns", () => {
  const identity: PiRuntimeEventKind[] = [
    "session.created",
    "session.restored",
    "session.replaced",
    "agent.started",
    "agent.settled",
    "turn.started",
    "turn.completed",
    "message.started",
    "message.updated",
    "message.completed",
    "tool.execution.started",
    "tool.execution.finished",
    "runtime.error",
    "tree.navigated",
    "run.abort-requested",
  ];
  for (const kind of identity) {
    assert.equal(piRuntimeEventKindToType(kind), kind);
  }
  assert.equal(piRuntimeEventKindToType("steer.enqueued"), "run.steer-enqueued");
  assert.equal(piRuntimeEventKindToType("future.tool.batch-finished" as PiRuntimeEventKind), "pi.unknown");
});

test("recordPiRuntimeEvent: known kind maps 1:1 with pi-runtime evidence and caller timestamp", async () => {
  const journal = new MemoryEventJournal();
  const recorder = new EventRecorder(journal);
  const outcome = await recorder.recordPiRuntimeEvent(RUN, piEvent("message.started", { text: "hi" }, "known"));
  assert.equal(outcome.status, "appended");
  const events = journal.getRunEvents(RUN);
  assert.equal(events.length, 1);
  const stored = events[0]!;
  assert.equal(stored.type, "message.started");
  assert.equal(stored.seq, 1);
  assert.equal(stored.occurredAt, T0);
  assert.deepEqual(stored.evidence, [{ source: "pi-runtime", refId: "evt-known" }]);
  assert.deepEqual(stored.payload, { text: "hi" });
  await journal.close();
});

test("recordPiRuntimeEvent: steer.enqueued becomes run.steer-enqueued", async () => {
  const journal = new MemoryEventJournal();
  const recorder = new EventRecorder(journal);
  await recorder.recordPiRuntimeEvent(RUN, piEvent("steer.enqueued", { text: "more" }, "steer"));
  const stored = journal.getRunEvents(RUN)[0]!;
  assert.equal(stored.type, "run.steer-enqueued");
  await journal.close();
});

test("recordPiRuntimeEvent: unknown kind is preserved as pi.unknown with rawKind, no throw", async () => {
  const journal = new MemoryEventJournal();
  const recorder = new EventRecorder(journal);
  const outcome = await recorder.recordPiRuntimeEvent(
    RUN,
    piEvent("future.tool.batch-finished" as PiRuntimeEventKind, { tool: "bash", count: 3 }, "unk"),
  );
  assert.equal(outcome.status, "appended");
  const stored = journal.getRunEvents(RUN)[0]!;
  assert.equal(stored.type, "pi.unknown");
  assert.equal(stored.payload["rawKind"], "future.tool.batch-finished");
  assert.equal(stored.payload["tool"], "bash");
  assert.equal(stored.payload["count"], 3);

  // 回放：读回后信息完整。
  const replayed = journal.getRunEvents(RUN);
  assert.equal(replayed[0]?.payload["rawKind"], "future.tool.batch-finished");
  await journal.close();
});

test("recordPiRuntimeEvent: non-record payloads are wrapped as { value }", async () => {
  const journal = new MemoryEventJournal();
  const recorder = new EventRecorder(journal);
  await recorder.recordPiRuntimeEvent(RUN, piEvent("future.scalar.event" as PiRuntimeEventKind, "plain", "scalar"));
  const stored = journal.getRunEvents(RUN)[0]!;
  assert.equal(stored.payload["value"], "plain");
  assert.equal(stored.payload["rawKind"], "future.scalar.event");
  await journal.close();
});

test("recordPiRuntimeEvent: secrets in an unredacted payload are caught by the journal safety net", async () => {
  const journal = new MemoryEventJournal();
  const recorder = new EventRecorder(journal);
  await recorder.recordPiRuntimeEvent(
    RUN,
    piEvent("message.updated", { text: `retry with ${SYNTH.anthropicKey}` }, "dirty"),
  );
  const stored = journal.getRunEvents(RUN)[0]!;
  assertNoSynthSecrets("recorded pi event", JSON.stringify(stored));
  assert.ok(!String(stored.payload["text"]).includes("sk-"));
  await journal.close();
});

test("recording the same PiRuntimeEvent twice is rejected as duplicate-event-id", async () => {
  const journal = new MemoryEventJournal();
  const recorder = new EventRecorder(journal);
  const event = piEvent("message.started", { text: "x" }, "dup");
  const first = await recorder.recordPiRuntimeEvent(RUN, event);
  assert.equal(first.status, "appended");
  const second = await recorder.recordPiRuntimeEvent(RUN, event);
  assert.equal(second.status, "rejected");
  assert.equal(second.reason, "duplicate-event-id");
  assert.equal(journal.getRunEvents(RUN).length, 1);
  await journal.close();
});

/* ------------------------------------------------------------------ */
/* 错误记录：cause 不入库                                              */
/* ------------------------------------------------------------------ */

test("recordError persists code/message/details but never the cause", async () => {
  const journal = new MemoryEventJournal();
  const recorder = new EventRecorder(journal);
  const error: TreeAIError = {
    code: "upstream",
    message: "provider 502",
    details: { attempt: 2 },
    cause: new Error(`inner ${SYNTH.githubToken}`),
  };
  await recorder.recordError(RUN, error);
  const stored = journal.getRunEvents(RUN)[0]!;
  assert.equal(stored.type, "runtime.error");
  assertNoSynthSecrets("recordError", JSON.stringify(stored));
  assert.equal(JSON.stringify(stored).includes("cause"), false);
  assert.deepEqual(stored.payload["error"], { code: "upstream", message: "provider 502", details: { attempt: 2 } });
  await journal.close();
});

/* ------------------------------------------------------------------ */
/* session 引用变化 / 树导航 / 耗时                                    */
/* ------------------------------------------------------------------ */

test("session lifecycle records carry the reference and the previous snapshot", async () => {
  const journal = new MemoryEventJournal();
  const recorder = new EventRecorder(journal);
  const homeFile = `/Users/${SYNTH.homeAlice}/.pi/sessions/s1.jsonl`;
  await recorder.recordSessionCreated(RUN, availableRef(1, homeFile));
  await recorder.recordSessionReplaced(RUN, availableRef(2, homeFile), availableRef(1, homeFile));
  await recorder.recordSessionRestored(RUN, availableRef(2, homeFile));

  const events = journal.getRunEvents(RUN);
  assert.deepEqual(events.map((e) => e.type), ["session.created", "session.replaced", "session.restored"]);

  // sessionFile 中的家目录被兜底脱敏。
  const created = events[0]!;
  const reference = created.payload["reference"] as Record<string, unknown>;
  assert.ok(String(reference["sessionFile"]).startsWith("~/"));
  assert.ok(!String(reference["sessionFile"]).includes(SYNTH.homeAlice));
  assert.equal(reference["sessionId"], "sess-1");
  assert.equal(reference["piVersion"], "0.85.1");
  assert.deepEqual(reference["availability"], { status: "available" });

  const replaced = events[1]!;
  const previous = replaced.payload["previous"] as Record<string, unknown>;
  assert.equal(previous["sessionId"], "sess-1");
  await journal.close();
});

test("tree navigation records the entry pointer move", async () => {
  const journal = new MemoryEventJournal();
  const recorder = new EventRecorder(journal);
  await recorder.recordTreeNavigation(RUN, {
    fromEntryId: "entry-1" as PiEntryId,
    toEntryId: "entry-9" as PiEntryId,
    sessionId: "sess-1" as PiSessionId,
    context: { treeId: "tree-1", reason: "user-jump" },
  });
  const stored = journal.getRunEvents(RUN)[0]!;
  assert.equal(stored.type, "tree.navigated");
  assert.equal(stored.payload["fromEntryId"], "entry-1");
  assert.equal(stored.payload["toEntryId"], "entry-9");
  assert.equal(stored.payload["sessionId"], "sess-1");
  assert.deepEqual(stored.payload["context"], { treeId: "tree-1", reason: "user-jump" });
  await journal.close();
});

test("recordDuration emits duration.recorded with phase/timing/attributes", async () => {
  const journal = new MemoryEventJournal();
  const recorder = new EventRecorder(journal);
  await recorder.recordDuration(RUN, {
    phase: "run",
    timing: { startedAt: T0, endedAt: T1 },
    attributes: { turn: 2 },
  });
  const stored = journal.getRunEvents(RUN)[0]!;
  assert.equal(stored.type, "duration.recorded");
  assert.equal(stored.payload["phase"], "run");
  const timing = stored.payload["timing"] as Record<string, unknown>;
  assert.equal(timing["startedAt"], T0);
  assert.equal(timing["endedAt"], T1);
  assert.deepEqual(stored.payload["attributes"], { turn: 2 });
  await journal.close();
});

/* ------------------------------------------------------------------ */
/* appendNext seq 自动分配                                             */
/* ------------------------------------------------------------------ */

test("recorder allocates strictly increasing seq across all record methods", async () => {
  const journal = new MemoryEventJournal();
  const recorder = new EventRecorder(journal);
  await recorder.recordAgentStarted(RUN);
  await recorder.recordAbortRequested(RUN);
  await recorder.recordSteerEnqueued(RUN, "hurry");
  await recorder.recordError(RUN, { code: "timeout", message: "t/o" });
  await recorder.recordAgentSettled(RUN, { status: "aborted" });
  const seqs = journal.getRunEvents(RUN).map((e) => e.seq);
  assert.deepEqual(seqs, [1, 2, 3, 4, 5]);
  // 端到端投影：running → aborting → failed（runtime.error timeout 收敛），
  // 随后 settled(aborted) 与已收敛终态冲突 → double-terminal 异常
  // （事件被保留、状态不被改写）。
  const projection = journal.projectRunState(RUN);
  assert.equal(projection?.state, "failed");
  assert.equal(projection?.anomalies.length, 1);
  assert.equal(projection?.anomalies[0]?.kind, "double-terminal");
  const last = projection?.transitions[projection.transitions.length - 1];
  assert.equal(`${last?.from}->${last?.to}`, "aborting->failed");
  await journal.close();
});

/* ------------------------------------------------------------------ */
/* buildRunAudit                                                       */
/* ------------------------------------------------------------------ */

test("buildRunAudit aggregates errors, durations, session changes and navigations", async () => {
  const journal = new MemoryEventJournal();
  const recorder = new EventRecorder(journal);
  const run = runIdOf("audit");

  await recorder.recordSessionCreated(run, availableRef(1, `/Users/${SYNTH.homeBob}/.pi/s.jsonl`), { occurredAt: T0 });
  await recorder.recordAgentStarted(run, { occurredAt: T0, timing: { startedAt: T0, endedAt: T1, durationMs: 1500 } });
  await recorder.recordError(run, { code: "upstream", message: "502" }, { occurredAt: T1 });
  await recorder.recordTreeNavigation(
    run,
    { fromEntryId: "entry-1" as PiEntryId, toEntryId: "entry-2" as PiEntryId, sessionId: "sess-1" as PiSessionId },
    { occurredAt: T1 },
  );
  await recorder.recordSessionReplaced(run, availableRef(2, "/tmp/s2.jsonl"), availableRef(1, "/tmp/s1.jsonl"), { occurredAt: T1 });
  await recorder.recordAgentSettled(
    run,
    { status: "failed", error: { code: "upstream", message: "502" }, timing: { startedAt: T0, endedAt: T2 } },
    { occurredAt: T2 },
  );
  await recorder.recordDuration(run, { phase: "turn", timing: { startedAt: T0, endedAt: T1 } }, { occurredAt: T1 });

  const events = journal.getRunEvents(run);
  const audit = buildRunAudit(run, events);

  assert.equal(audit.runId as string, run as string);
  assert.equal(audit.eventCount, 7);
  assert.equal(audit.projection.state, "failed");
  assert.equal(audit.projection.failure?.code, "upstream");

  // 错误：runtime.error + agent.settled(failed)。
  assert.equal(audit.errors.length, 2);
  assert.deepEqual(
    audit.errors.map((e) => e.source),
    ["runtime.error", "agent.settled"],
  );
  assert.equal(audit.errors[0]?.error.code, "upstream");
  assert.equal(audit.errors[1]?.error.code, "upstream");

  // 耗时：agent.started(1500) + agent.settled(推导) + duration.recorded(1500)。
  const phases = audit.durations.map((d) => d.phase);
  assert.deepEqual(phases, ["agent.started", "agent.settled", "turn"]);
  const started = audit.durations[0]!;
  assert.equal(started.durationMs, 1500);
  assert.equal(audit.durations[2]?.durationMs, 1500); // durationMs 缺失时由时间戳推导

  // session 引用变化：created + replaced(带 previous)。
  assert.equal(audit.sessionReferenceChanges.length, 2);
  assert.equal(audit.sessionReferenceChanges[0]?.changeType, "created");
  const replaced = audit.sessionReferenceChanges[1]!;
  assert.equal(replaced.changeType, "replaced");
  assert.equal((replaced.previous as Record<string, unknown>)["sessionId"], "sess-1");

  // 树导航。
  assert.equal(audit.treeNavigations.length, 1);
  const nav = audit.treeNavigations[0]!;
  assert.equal(nav.fromEntryId, "entry-1");
  assert.equal(nav.toEntryId, "entry-2");
  assert.equal(nav.sessionId, "sess-1");
  await journal.close();
});

test("buildRunAudit on an empty stream yields a queued projection and empty records", () => {
  const audit = buildRunAudit(runIdOf("empty"), []);
  assert.equal(audit.eventCount, 0);
  assert.equal(audit.projection.state, "queued");
  assert.deepEqual(audit.errors, []);
  assert.deepEqual(audit.durations, []);
  assert.deepEqual(audit.sessionReferenceChanges, []);
  assert.deepEqual(audit.treeNavigations, []);
});
