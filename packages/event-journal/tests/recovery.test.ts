/**
 * 恢复测试（任务书 §5 Agent E 第 4 项 / contracts run-state.ts I6）：
 * - host-crash：非终态 run 收敛为 failed(unknown, hostInterrupted)；
 * - host-dispose：running/aborting 收敛为 aborted(user-abort)；
 *  queued 收敛为 failed(unknown, hostInterrupted+neverStarted)；
 * - 幂等：第二次恢复 / 已终态 run 不再处理；
 * - runIds 过滤与 unknownRuns 上报；
 * - 文件 journal 的 重开→恢复→重开→恢复 持久化语义；
 * - 恢复事件本身被 journal 追加（审计可见），不改写既有事件。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { JsonlEventJournal, MemoryEventJournal } from "../src/journal.js";
import { resolveRecoveryConvergence } from "../src/recovery.js";
import {
  cleanupTempDir,
  evtIdOf,
  makeEvent,
  makeTempDir,
  runIdOf,
  T2,
} from "./helpers.js";

const tempDirs: string[] = [];
after(async () => {
  for (const dir of tempDirs) await cleanupTempDir(dir);
});

/** 构造一个投影处于 target 状态的内存 journal。 */
async function journalAt(
  setup: "queued" | "running" | "aborting" | "succeeded",
): Promise<MemoryEventJournal> {
  const journal = new MemoryEventJournal();
  const run = runIdOf(setup);
  if (setup === "queued") {
    await journal.append(makeEvent({ runId: run, seq: 1, eventId: evtIdOf("q1"), type: "message.started" }));
  } else if (setup === "running") {
    await journal.append(makeEvent({ runId: run, seq: 1, eventId: evtIdOf("r1"), type: "agent.started" }));
  } else if (setup === "aborting") {
    await journal.append(makeEvent({ runId: run, seq: 1, eventId: evtIdOf("a1"), type: "agent.started" }));
    await journal.append(makeEvent({ runId: run, seq: 2, eventId: evtIdOf("a2"), type: "run.abort-requested" }));
  } else {
    await journal.append(makeEvent({ runId: run, seq: 1, eventId: evtIdOf("s1"), type: "agent.started" }));
    await journal.append(
      makeEvent({ runId: run, seq: 2, eventId: evtIdOf("s2"), type: "agent.settled", payload: { status: "succeeded" } }),
    );
  }
  return journal;
}

/* ------------------------------------------------------------------ */
/* 收敛决策表（纯函数）                                                */
/* ------------------------------------------------------------------ */

test("resolveRecoveryConvergence implements the host-crash / host-dispose table", () => {
  const crash = resolveRecoveryConvergence("running", "host-crash");
  assert.equal(crash.resolvedTo, "failed");
  assert.equal(crash.error.code, "unknown");
  assert.deepEqual(crash.error.details, { hostInterrupted: true });

  const crashQueued = resolveRecoveryConvergence("queued", "host-crash");
  assert.equal(crashQueued.resolvedTo, "failed");
  assert.deepEqual(crashQueued.error.details, { hostInterrupted: true });

  const crashAborting = resolveRecoveryConvergence("aborting", "host-crash");
  assert.equal(crashAborting.resolvedTo, "failed");

  const disposeRunning = resolveRecoveryConvergence("running", "host-dispose");
  assert.equal(disposeRunning.resolvedTo, "aborted");
  assert.equal(disposeRunning.error.code, "user-abort");

  const disposeAborting = resolveRecoveryConvergence("aborting", "host-dispose");
  assert.equal(disposeAborting.resolvedTo, "aborted");
  assert.equal(disposeAborting.error.code, "user-abort");

  // I6 解释：dispose 只覆盖"在途"的 run；queued 只能收敛为 failed。
  const disposeQueued = resolveRecoveryConvergence("queued", "host-dispose");
  assert.equal(disposeQueued.resolvedTo, "failed");
  assert.equal(disposeQueued.error.code, "unknown");
  assert.deepEqual(disposeQueued.error.details, { hostInterrupted: true, neverStarted: true });
});

/* ------------------------------------------------------------------ */
/* 内存 journal 恢复                                                   */
/* ------------------------------------------------------------------ */

test("host-crash converges a running run to failed(unknown) with hostInterrupted details", async () => {
  const journal = await journalAt("running");
  const run = runIdOf("running");
  const report = await journal.recoverInterruptedRuns("host-crash", { occurredAt: T2 });

  assert.equal(report.recovered.length, 1);
  const recovered = report.recovered[0]!;
  assert.equal(recovered.runId as string, run as string);
  assert.equal(recovered.from, "running");
  assert.equal(recovered.resolvedTo, "failed");
  assert.equal(recovered.error.code, "unknown");
  assert.deepEqual(recovered.error.details, { hostInterrupted: true });

  const projection = journal.projectRunState(run);
  assert.equal(projection?.state, "failed");
  assert.equal(projection?.failure?.code, "unknown");
  assert.deepEqual(projection?.failure?.details, { hostInterrupted: true });
  assert.equal(projection?.terminalAt, T2);

  // 恢复事件被追加且引用 journal 自身（不改写既有事件）。
  const events = journal.getRunEvents(run);
  assert.equal(events.length, 2);
  assert.equal(events[1]?.type, "runtime.recovered");
  assert.deepEqual(events[1]?.evidence, [
    { source: "treeai-journal", refId: "recovery:host-crash" },
  ]);
  await journal.close();
});

test("host-dispose converges running via aborting to aborted(user-abort)", async () => {
  const journal = await journalAt("running");
  const run = runIdOf("running");
  const report = await journal.recoverInterruptedRuns("host-dispose");

  assert.equal(report.recovered[0]?.resolvedTo, "aborted");
  const projection = journal.projectRunState(run);
  assert.equal(projection?.state, "aborted");
  const lastTwo = projection?.transitions.slice(-2) ?? [];
  assert.deepEqual(
    lastTwo.map((t) => `${t.from}->${t.to}`),
    ["running->aborting", "aborting->aborted"],
  );
  await journal.close();
});

test("host-dispose converges aborting directly to aborted", async () => {
  const journal = await journalAt("aborting");
  const run = runIdOf("aborting");
  await journal.recoverInterruptedRuns("host-dispose");
  const projection = journal.projectRunState(run);
  assert.equal(projection?.state, "aborted");
  const last = projection?.transitions[projection.transitions.length - 1];
  assert.equal(last?.cause, "recovery:runtime.recovered");
  await journal.close();
});

test("queued runs at dispose converge to failed(unknown, neverStarted)", async () => {
  const journal = await journalAt("queued");
  const run = runIdOf("queued");
  const report = await journal.recoverInterruptedRuns("host-dispose");
  assert.equal(report.recovered[0]?.resolvedTo, "failed");

  const projection = journal.projectRunState(run);
  assert.equal(projection?.state, "failed");
  assert.deepEqual(projection?.failure?.details, { hostInterrupted: true, neverStarted: true });
  await journal.close();
});

test("recovery is idempotent: a second call finds the run already terminal", async () => {
  const journal = await journalAt("running");
  const run = runIdOf("running");
  const first = await journal.recoverInterruptedRuns("host-crash");
  assert.equal(first.recovered.length, 1);
  const eventsAfterFirst = journal.getRunEvents(run).length;

  const second = await journal.recoverInterruptedRuns("host-crash");
  assert.equal(second.recovered.length, 0);
  assert.deepEqual(second.alreadyTerminal, [{ runId: run, state: "failed" }]);
  assert.equal(journal.getRunEvents(run).length, eventsAfterFirst);
  await journal.close();
});

test("already-terminal runs are reported and left untouched", async () => {
  const journal = await journalAt("succeeded");
  const run = runIdOf("succeeded");
  const before = journal.getRunEvents(run).length;
  const report = await journal.recoverInterruptedRuns("host-crash");
  assert.equal(report.recovered.length, 0);
  assert.deepEqual(report.alreadyTerminal, [{ runId: run, state: "succeeded" }]);
  assert.equal(journal.getRunEvents(run).length, before);
  await journal.close();
});

test("runIds filter scopes recovery; unknown ids are reported", async () => {
  const journal = new MemoryEventJournal();
  const runA = runIdOf("ra");
  const runB = runIdOf("rb");
  await journal.append(makeEvent({ runId: runA, seq: 1, eventId: evtIdOf("ra1"), type: "agent.started" }));
  await journal.append(makeEvent({ runId: runB, seq: 1, eventId: evtIdOf("rb1"), type: "agent.started" }));
  await journal.append(makeEvent({ runId: runIdOf("done"), seq: 1, eventId: evtIdOf("d1"), type: "agent.started" }));
  await journal.append(
    makeEvent({ runId: runIdOf("done"), seq: 2, eventId: evtIdOf("d2"), type: "agent.settled", payload: { status: "succeeded" } }),
  );

  const report = await journal.recoverInterruptedRuns("host-crash", {
    runIds: [runA, runIdOf("ghost")],
  });
  assert.deepEqual(
    report.recovered.map((r) => r.runId as string),
    [runA as string],
  );
  assert.deepEqual(report.alreadyTerminal.map((r) => r.runId as string), []);
  assert.deepEqual(report.unknownRuns.map((r) => r as string), [runIdOf("ghost") as string]);
  // runB 不在过滤名单，未被处理。
  assert.equal(journal.projectRunState(runB)?.state, "running");
  await journal.close();
});

test("mixed journal recovers every non-terminal run", async () => {
  const journal = new MemoryEventJournal();
  const ids = ["queued", "running", "aborting"] as const;
  await journal.append(makeEvent({ runId: runIdOf("queued"), seq: 1, eventId: evtIdOf("m1"), type: "message.started" }));
  await journal.append(makeEvent({ runId: runIdOf("running"), seq: 1, eventId: evtIdOf("m2"), type: "agent.started" }));
  await journal.append(makeEvent({ runId: runIdOf("aborting"), seq: 1, eventId: evtIdOf("m3"), type: "agent.started" }));
  await journal.append(makeEvent({ runId: runIdOf("aborting"), seq: 2, eventId: evtIdOf("m4"), type: "run.abort-requested" }));

  const report = await journal.recoverInterruptedRuns("host-crash");
  assert.equal(report.recovered.length, ids.length);
  for (const r of report.recovered) {
    assert.equal(r.resolvedTo, "failed");
    assert.equal(journal.projectRunState(r.runId)?.state, "failed");
  }
  await journal.close();
});

/* ------------------------------------------------------------------ */
/* 文件 journal 的恢复持久化                                           */
/* ------------------------------------------------------------------ */

test("file journal: crash -> reopen -> recover -> reopen keeps converged state", async () => {
  const dir = await makeTempDir();
  tempDirs.push(dir);
  const path = join(dir, "journal.jsonl");

  // 第一次生命周期：run 进入 running 后宿主"崩溃"（close 不收敛）。
  const first = await JsonlEventJournal.open(path);
  await first.append(makeEvent({ runId: runIdOf("live"), seq: 1, eventId: evtIdOf("f1"), type: "agent.started" }));
  await first.append(makeEvent({ runId: runIdOf("live"), seq: 2, eventId: evtIdOf("f2"), type: "message.started" }));
  await first.close();

  // 第二次生命周期：重开并恢复。
  const second = await JsonlEventJournal.open(path);
  assert.equal(second.openReport.eventsLoaded, 2);
  const report = await second.recoverInterruptedRuns("host-crash", { occurredAt: T2 });
  assert.equal(report.recovered.length, 1);
  await second.close();

  // 第三次生命周期：状态仍是收敛后的终态；再次恢复为 no-op。
  const third = await JsonlEventJournal.open(path);
  assert.equal(third.openReport.eventsLoaded, 3);
  const projection = third.projectRunState(runIdOf("live"));
  assert.equal(projection?.state, "failed");
  assert.equal(projection?.failure?.code, "unknown");
  assert.deepEqual(projection?.failure?.details, { hostInterrupted: true });
  assert.equal(projection?.terminalAt, T2);

  const again = await third.recoverInterruptedRuns("host-crash");
  assert.equal(again.recovered.length, 0);
  assert.deepEqual(again.alreadyTerminal, [{ runId: runIdOf("live"), state: "failed" }]);
  await third.close();
  await cleanupTempDir(dir);
});
