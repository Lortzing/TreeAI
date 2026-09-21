/**
 * Journal 测试（任务书 §5 Agent E 第 1、2 项）：
 * - seq 单调/重复检测（duplicate-seq / seq-below-max / 空洞允许）；
 * - 重复 event 检测（duplicate-event-id，含跨重开）；
 * - 结构校验拒绝（各 invalid-* reason）；
 * - 查询/回放 API（runId/type/types/afterSeq/limit）；
 * - 持久化文件不含秘密（兜底脱敏）；
 * - 重开重载、torn tail 修复、中部损坏显式报错、close 后写入拒绝。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EventJournalError } from "../src/errors.js";
import { JsonlEventJournal, MemoryEventJournal } from "../src/journal.js";
import {
  SYNTH,
  assertNoSynthSecrets,
  cleanupTempDir,
  evtIdOf,
  makeEvent,
  makeTempDir,
  runIdOf,
} from "./helpers.js";

const tempDirs: string[] = [];
after(async () => {
  for (const dir of tempDirs) await cleanupTempDir(dir);
});

/* ------------------------------------------------------------------ */
/* seq 纪律                                                            */
/* ------------------------------------------------------------------ */

test("seq strictly increasing within a run is accepted (1,2,3 and gaps)", async () => {
  const journal = new MemoryEventJournal();
  const run = runIdOf("mono");
  const first = await journal.append(makeEvent({ runId: run, seq: 1, eventId: evtIdOf("m1") }));
  assert.equal(first.status, "appended");
  const second = await journal.append(makeEvent({ runId: run, seq: 2, eventId: evtIdOf("m2") }));
  assert.equal(second.status, "appended");
  const third = await journal.append(makeEvent({ runId: run, seq: 5, eventId: evtIdOf("m3") }));
  assert.equal(third.status, "appended"); // 空洞允许（推荐实践非硬性）
  assert.equal(journal.getRunEvents(run).length, 3);
  await journal.close();
});

test("duplicate seq in the same run is detected and rejected", async () => {
  const journal = new MemoryEventJournal();
  const run = runIdOf("dup-seq");
  await journal.append(makeEvent({ runId: run, seq: 1, eventId: evtIdOf("d1") }));
  const outcome = await journal.append(makeEvent({ runId: run, seq: 1, eventId: evtIdOf("d2") }));
  assert.equal(outcome.status, "rejected");
  assert.equal(outcome.reason, "duplicate-seq");
  assert.equal(outcome.attemptedSeq, 1);
  assert.equal(outcome.currentMaxSeq, 1);
  assert.equal(journal.getRunEvents(run).length, 1);
  await journal.close();
});

test("seq below the current max is rejected (strict monotonicity)", async () => {
  const journal = new MemoryEventJournal();
  const run = runIdOf("below-max");
  await journal.append(makeEvent({ runId: run, seq: 3, eventId: evtIdOf("b1") }));
  const outcome = await journal.append(makeEvent({ runId: run, seq: 2, eventId: evtIdOf("b2") }));
  assert.equal(outcome.status, "rejected");
  assert.equal(outcome.reason, "seq-below-max");
  assert.equal(journal.getRunEvents(run).length, 1);
  await journal.close();
});

test("same seq across different runs is fine (seq scope is per run)", async () => {
  const journal = new MemoryEventJournal();
  await journal.append(makeEvent({ runId: runIdOf("a"), seq: 1, eventId: evtIdOf("a1") }));
  const outcome = await journal.append(makeEvent({ runId: runIdOf("b"), seq: 1, eventId: evtIdOf("b1") }));
  assert.equal(outcome.status, "appended");
  await journal.close();
});

test("duplicate eventId is detected and rejected", async () => {
  const journal = new MemoryEventJournal();
  const outcome = await journal.append(
    makeEvent({ runId: runIdOf("r"), seq: 2, eventId: evtIdOf("same") }),
  );
  assert.equal(outcome.status, "appended");
  const dup = await journal.append(
    makeEvent({ runId: runIdOf("r"), seq: 3, eventId: evtIdOf("same") }),
  );
  assert.equal(dup.status, "rejected");
  assert.equal(dup.reason, "duplicate-event-id");
  await journal.close();
});

test("appendNext auto-allocates strictly increasing seq and fresh ids", async () => {
  const journal = new MemoryEventJournal();
  const run = runIdOf("auto");
  const o1 = await journal.appendNext(run, { type: "agent.started", payload: {} });
  const o2 = await journal.appendNext(run, { type: "message.started", payload: {} });
  const o3 = await journal.appendNext(run, { type: "message.completed", payload: {} });
  assert.equal(o1.status, "appended");
  assert.equal(o2.status, "appended");
  assert.equal(o3.status, "appended");
  if (o1.status === "appended" && o2.status === "appended" && o3.status === "appended") {
    assert.deepEqual(
      [o1.event.seq, o2.event.seq, o3.event.seq],
      [1, 2, 3],
    );
    assert.notEqual(o1.event.eventId, o2.event.eventId);
    assert.match(o1.event.occurredAt, /^\d{4}-\d{2}-\d{2}T/);
  }
  await journal.close();
});

/* ------------------------------------------------------------------ */
/* 结构校验                                                            */
/* ------------------------------------------------------------------ */

test("invalid event shapes are rejected with precise reasons", async () => {
  const journal = new MemoryEventJournal();
  const cases: readonly { label: string; overrides: Record<string, unknown>; reason: string }[] = [
    { label: "empty eventId", overrides: { eventId: "" }, reason: "invalid-event-id" },
    { label: "non-string eventId", overrides: { eventId: 42 }, reason: "invalid-event-id" },
    { label: "empty runId", overrides: { runId: "" }, reason: "invalid-run-id" },
    { label: "zero seq", overrides: { seq: 0 }, reason: "invalid-seq" },
    { label: "negative seq", overrides: { seq: -1 }, reason: "invalid-seq" },
    { label: "fractional seq", overrides: { seq: 1.5 }, reason: "invalid-seq" },
    { label: "string seq", overrides: { seq: "1" }, reason: "invalid-seq" },
    { label: "bad occurredAt", overrides: { occurredAt: "yesterday" }, reason: "invalid-occurred-at" },
    { label: "numeric occurredAt", overrides: { occurredAt: 1695000000000 }, reason: "invalid-occurred-at" },
    { label: "empty type", overrides: { type: "" }, reason: "invalid-type" },
    { label: "null payload", overrides: { payload: null }, reason: "invalid-payload" },
    { label: "string payload", overrides: { payload: "text" }, reason: "invalid-payload" },
    { label: "array payload", overrides: { payload: [] }, reason: "invalid-payload" },
    { label: "string evidence", overrides: { evidence: "pi-runtime" }, reason: "invalid-evidence" },
    {
      label: "unknown evidence source",
      overrides: { evidence: [{ source: "bogus", refId: "r" }] },
      reason: "invalid-evidence",
    },
    {
      label: "evidence missing refId",
      overrides: { evidence: [{ source: "pi-runtime" }] },
      reason: "invalid-evidence",
    },
    {
      label: "non-string locator",
      overrides: { evidence: [{ source: "pi-runtime", refId: "r", locator: 5 }] },
      reason: "invalid-evidence",
    },
  ];
  for (const { label, overrides, reason } of cases) {
    // 只有用例本身不针对 eventId 时才补默认 eventId（避免覆盖待测的非法值）。
    const effective =
      overrides.eventId === undefined ? { ...overrides, eventId: evtIdOf(label) } : overrides;
    const outcome = await journal.append(makeEvent(effective));
    assert.equal(outcome.status, "rejected", label);
    if (outcome.status === "rejected") {
      assert.equal(outcome.reason, reason, label);
      assert.ok(outcome.detail.length > 0, label);
    }
  }
  // 所有被拒绝的事件都不留下痕迹。
  assert.deepEqual(journal.listEvents(), []);
  await journal.close();
});

/* ------------------------------------------------------------------ */
/* 兜底脱敏（含持久化文件级检查）                                      */
/* ------------------------------------------------------------------ */

test("journal deep-redacts payloads and evidence locators before persisting", async () => {
  const journal = new MemoryEventJournal();
  const outcome = await journal.append(
    makeEvent({
      runId: runIdOf("dirty"),
      seq: 1,
      eventId: evtIdOf("dirty"),
      type: "message.started",
      payload: {
        apiKey: SYNTH.anthropicKey,
        text: `failed with ${SYNTH.githubToken}`,
        home: `/Users/${SYNTH.homeAlice}/.pi/s.jsonl`,
      },
      evidence: [{ source: "pi-runtime", refId: "pi-1", locator: `/home/${SYNTH.homeBob}/line/3` }],
    }),
  );
  assert.equal(outcome.status, "appended");
  if (outcome.status !== "appended") return;
  const serialized = JSON.stringify(outcome.event);
  assertNoSynthSecrets("append result", serialized);
  assert.ok(outcome.redactionApplied.length > 0);
  const stored = journal.getRunEvents(runIdOf("dirty"))[0]!;
  assertNoSynthSecrets("journal query", JSON.stringify(stored));
  assert.equal(stored.payload["apiKey"], "[REDACTED:d2-v1]");
  const locator = stored.evidence[0]?.locator ?? "";
  assert.ok(!locator.includes(SYNTH.homeBob));
  await journal.close();
});

test("JSONL file on disk never contains secrets after append", async () => {
  const dir = await makeTempDir();
  tempDirs.push(dir);
  const path = join(dir, "journal.jsonl");
  const journal = await JsonlEventJournal.open(path);
  assert.equal(journal.openReport.created, true);
  await journal.appendNext(runIdOf("file"), {
    type: "message.started",
    payload: {
      authorization: `Bearer ${SYNTH.bearerValue}`,
      cookie: `Cookie: session=${SYNTH.cookieValue}`,
      sessionFile: `/Users/${SYNTH.homeCarol}/.pi/s.jsonl`,
      plain: "kept",
    },
  });
  await journal.close();
  const raw = await readFile(path, "utf8");
  assertNoSynthSecrets("journal file", raw);
  assert.ok(raw.includes("plain"));
  await cleanupTempDir(dir);
});

/* ------------------------------------------------------------------ */
/* 查询 / 回放                                                         */
/* ------------------------------------------------------------------ */

test("query API filters by runId, type, types, afterSeq and limit", async () => {
  const journal = new MemoryEventJournal();
  const runA = runIdOf("qa");
  const runB = runIdOf("qb");
  await journal.appendNext(runA, { type: "agent.started", payload: {} });
  await journal.appendNext(runA, { type: "message.started", payload: {} });
  await journal.appendNext(runA, { type: "message.completed", payload: {} });
  await journal.appendNext(runB, { type: "agent.started", payload: {} });
  await journal.appendNext(runB, { type: "agent.settled", payload: { status: "succeeded" } });

  const runAEvents = journal.getRunEvents(runA);
  assert.equal(runAEvents.length, 3);
  assert.deepEqual(runAEvents.map((e) => e.seq), [1, 2, 3]);

  assert.deepEqual(
    journal.listEvents({ runId: runB }).map((e) => e.type),
    ["agent.started", "agent.settled"],
  );
  assert.equal(journal.listEvents({ type: "message.started" }).length, 1);
  assert.equal(
    journal.listEvents({ types: ["message.started", "message.completed"] }).length,
    2,
  );
  assert.deepEqual(
    journal.listEvents({ runId: runA, afterSeq: 1 }).map((e) => e.seq),
    [2, 3],
  );
  assert.deepEqual(
    journal.listEvents({ runId: runA, limit: 2 }).map((e) => e.seq),
    [1, 2],
  );
  assert.equal(journal.listEvents().length, 5);
  assert.deepEqual(
    journal.getRunIds().map((r) => r as string).sort(),
    [runA as string, runB as string].sort(),
  );
  await journal.close();
});

/* ------------------------------------------------------------------ */
/* JSONL 持久化 / 重开                                                 */
/* ------------------------------------------------------------------ */

test("reopen reloads events and keeps rejecting duplicates across restarts", async () => {
  const dir = await makeTempDir();
  tempDirs.push(dir);
  const path = join(dir, "journal.jsonl");

  const first = await JsonlEventJournal.open(path);
  await first.append(makeEvent({ runId: runIdOf("p"), seq: 1, eventId: evtIdOf("p1"), type: "agent.started" }));
  await first.append(makeEvent({ runId: runIdOf("p"), seq: 2, eventId: evtIdOf("p2"), type: "message.started" }));
  await first.close();

  const second = await JsonlEventJournal.open(path);
  const report = second.openReport;
  assert.equal(report.created, false);
  assert.equal(report.eventsLoaded, 2);
  assert.equal(report.runsLoaded, 1);
  assert.equal(second.getRunEvents(runIdOf("p")).length, 2);

  // 跨重开的重复 eventId 检测。
  const dup = await second.append(
    makeEvent({ runId: runIdOf("p"), seq: 3, eventId: evtIdOf("p1"), type: "message.started" }),
  );
  assert.equal(dup.status, "rejected");
  assert.equal(dup.reason, "duplicate-event-id");

  // 跨重开的 seq 单调检测。
  const below = await second.append(
    makeEvent({ runId: runIdOf("p"), seq: 2, eventId: evtIdOf("p3"), type: "message.started" }),
  );
  assert.equal(below.status, "rejected");
  assert.equal(below.reason, "duplicate-seq");

  // appendNext 从重载的最大 seq 继续。
  const next = await second.appendNext(runIdOf("p"), { type: "message.completed", payload: {} });
  assert.equal(next.status, "appended");
  if (next.status === "appended") assert.equal(next.event.seq, 3);
  await second.close();

  const third = await JsonlEventJournal.open(path);
  assert.equal(third.getRunEvents(runIdOf("p")).length, 3);
  await third.close();
  await cleanupTempDir(dir);
});

test("torn tail (crash-partial line, no trailing newline) is repaired at open", async () => {
  const dir = await makeTempDir();
  tempDirs.push(dir);
  const path = join(dir, "journal.jsonl");

  const first = await JsonlEventJournal.open(path);
  await first.append(makeEvent({ runId: runIdOf("t"), seq: 1, eventId: evtIdOf("t1"), type: "agent.started" }));
  await first.append(makeEvent({ runId: runIdOf("t"), seq: 2, eventId: evtIdOf("t2"), type: "message.started" }));
  await first.close();

  // 模拟崩溃时的半个写：无换行结尾的 JSON 前缀。
  const partial = '{"eventId":"evt-torn","runId":"run-t","seq":3,"occ';
  await appendFile(path, partial);

  const second = await JsonlEventJournal.open(path);
  const report = second.openReport;
  assert.equal(report.tornTailRepaired, true);
  assert.equal(report.tornTailBytes, Buffer.byteLength(partial, "utf8"));
  assert.equal(report.eventsLoaded, 2);

  const repairedContent = await readFile(path, "utf8");
  assert.ok(repairedContent.endsWith("\n"));
  assert.ok(!repairedContent.includes("evt-torn"));

  const next = await second.appendNext(runIdOf("t"), { type: "message.completed", payload: {} });
  assert.equal(next.status, "appended");
  if (next.status === "appended") assert.equal(next.event.seq, 3);
  await second.close();
  await cleanupTempDir(dir);
});

test("corruption in the middle of the file fails loudly (corrupt reason)", async () => {
  const dir = await makeTempDir();
  tempDirs.push(dir);
  const path = join(dir, "journal.jsonl");

  const first = await JsonlEventJournal.open(path);
  await first.append(makeEvent({ runId: runIdOf("c"), seq: 1, eventId: evtIdOf("c1"), type: "agent.started" }));
  await first.append(makeEvent({ runId: runIdOf("c"), seq: 2, eventId: evtIdOf("c2"), type: "message.started" }));
  await first.close();

  // 中部插入非法行。
  const original = await readFile(path, "utf8");
  const lines = original.split("\n");
  lines.splice(1, 0, "this is not json");
  await writeFile(path, lines.join("\n"), "utf8");

  await assert.rejects(
    () => JsonlEventJournal.open(path),
    (error: unknown) => {
      assert.ok(error instanceof EventJournalError);
      assert.equal(error.reason, "corrupt");
      assert.ok(error.message.includes("line 2"));
      return true;
    },
  );
  await cleanupTempDir(dir);
});

test("file-level duplicate seq across restart is treated as corruption", async () => {
  const dir = await makeTempDir();
  tempDirs.push(dir);
  const path = join(dir, "journal.jsonl");

  const first = await JsonlEventJournal.open(path);
  await first.append(makeEvent({ runId: runIdOf("k"), seq: 1, eventId: evtIdOf("k1"), type: "agent.started" }));
  await first.close();

  // 直接追加一行与既有行同 run 同 seq 的合法 JSON（模拟外部损坏写入）。
  const duplicateLine = JSON.stringify(
    makeEvent({ runId: runIdOf("k"), seq: 1, eventId: evtIdOf("k2"), type: "message.started" }),
  );
  await appendFile(path, duplicateLine + "\n");

  await assert.rejects(
    () => JsonlEventJournal.open(path),
    (error: unknown) => {
      assert.ok(error instanceof EventJournalError);
      assert.equal(error.reason, "corrupt");
      return true;
    },
  );
  await cleanupTempDir(dir);
});

/* ------------------------------------------------------------------ */
/* 关闭语义                                                            */
/* ------------------------------------------------------------------ */

test("append and recovery after close throw; queries remain available", async () => {
  const journal = new MemoryEventJournal();
  await journal.appendNext(runIdOf("z"), { type: "agent.started", payload: {} });
  await journal.close();
  await journal.close(); // 幂等

  await assert.rejects(
    () => journal.append(makeEvent({ runId: runIdOf("z"), seq: 2, eventId: evtIdOf("z2") })),
    (error: unknown) => {
      assert.ok(error instanceof EventJournalError);
      assert.equal(error.reason, "closed");
      return true;
    },
  );
  await assert.rejects(
    () => journal.appendNext(runIdOf("z"), { type: "message.started", payload: {} }),
    (error: unknown) => {
      assert.ok(error instanceof EventJournalError);
      assert.equal(error.reason, "closed");
      return true;
    },
  );
  await assert.rejects(
    () => journal.recoverInterruptedRuns("host-crash"),
    (error: unknown) => {
      assert.ok(error instanceof EventJournalError);
      assert.equal(error.reason, "closed");
      return true;
    },
  );
  // 查询仍可用。
  assert.equal(journal.getRunEvents(runIdOf("z")).length, 1);
  assert.equal(journal.projectRunState(runIdOf("z"))?.state, "running");
});

test("concurrent appends are serialized and all seq land strictly increasing", async () => {
  const journal = new MemoryEventJournal();
  const run = runIdOf("concurrent");
  const outcomes = await Promise.all(
    Array.from({ length: 25 }, (_, i) =>
      journal.appendNext(run, { type: "message.started", payload: { i } }),
    ),
  );
  const seqs = outcomes
    .filter((o): o is Extract<typeof o, { status: "appended" }> => o.status === "appended")
    .map((o) => o.event.seq)
    .sort((a, b) => a - b);
  assert.deepEqual(seqs, Array.from({ length: 25 }, (_, i) => i + 1));
  assert.equal(journal.getRunEvents(run).length, 25);
  await journal.close();
});
