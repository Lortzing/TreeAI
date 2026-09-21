/**
 * RunState 投影测试（任务书 §5 Agent E 第 3 项）：
 * - **全部** 合法迁移（冻结迁移表的每条边）经显式事件生效；
 * - **全部** 非法迁移（表外 26 对）被拒绝且留下对应异常种类
 *   （非法回退/跳级 → illegal-transition；离开终态/双终态 → double-terminal）；
 * - 派生迁移（agent.started / run.abort-requested / runtime.error /
 *   agent.settled / runtime.recovered），含 running→aborted 的两步收敛；
 * - 失步显式事件（out-of-sync）、畸形 payload（invalid-payload）；
 * - 未知事件类型不改状态不崩溃（前向兼容）；
 * - 乱序输入按 seq 排序后投影。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RunState, TreeAIEvent } from "@treeai/contracts";
import {
  isLegalRunStateTransition,
  isTerminalRunState,
  projectRunEvents,
} from "../src/projector.js";
import { evtIdOf, makeEvent, runIdOf } from "./helpers.js";

const RUN = runIdOf("proj");

/** 与冻结契约独立枚举的期望合法边（测试对照表，不引用被测实现）。 */
const EXPECTED_LEGAL_EDGES: readonly (readonly [RunState, RunState])[] = [
  ["queued", "running"],
  ["queued", "failed"],
  ["running", "aborting"],
  ["running", "succeeded"],
  ["running", "failed"],
  ["aborting", "aborted"],
  ["aborting", "failed"],
];

const ALL_STATES: readonly RunState[] = [
  "queued",
  "running",
  "aborting",
  "succeeded",
  "failed",
  "aborted",
];

function stateEvent(payload: Record<string, unknown>, seq = 1): TreeAIEvent {
  return makeEvent({
    runId: RUN,
    seq,
    eventId: evtIdOf(`s${seq}`),
    type: "run.state-changed",
    payload,
  }) as TreeAIEvent;
}

function eventOf(
  type: string,
  payload: Record<string, unknown>,
  seq = 1,
): TreeAIEvent {
  return makeEvent({
    runId: RUN,
    seq,
    eventId: evtIdOf(`e${seq}`),
    type,
    payload,
  }) as TreeAIEvent;
}

/** 把投影驱动到指定状态的前置事件序列（全部走合法路径）。 */
function reachState(state: RunState): TreeAIEvent[] {
  switch (state) {
    case "queued":
      return [eventOf("message.started", {}, 1)];
    case "running":
      return [eventOf("agent.started", {}, 1)];
    case "aborting":
      return [eventOf("agent.started", {}, 1), eventOf("run.abort-requested", {}, 2)];
    case "succeeded":
      return [eventOf("agent.started", {}, 1), eventOf("agent.settled", { status: "succeeded" }, 2)];
    case "failed":
      return [
        eventOf("agent.started", {}, 1),
        stateEvent({ from: "running", to: "failed", failure: { code: "upstream", message: "x" } }, 2),
      ];
    case "aborted":
      return [
        eventOf("agent.started", {}, 1),
        eventOf("run.abort-requested", {}, 2),
        eventOf("agent.settled", { status: "aborted" }, 3),
      ];
  }
}

/* ------------------------------------------------------------------ */
/* 显式迁移：全部合法边                                                */
/* ------------------------------------------------------------------ */

test("every legal edge of the frozen transition table applies via run.state-changed", () => {
  for (const [from, to] of EXPECTED_LEGAL_EDGES) {
    const events = [...reachState(from), stateEvent({ from, to }, 10)];
    const projection = projectRunEvents(RUN, events);
    assert.equal(projection.state, to, `${from} -> ${to}`);
    assert.equal(projection.anomalies.length, 0, `${from} -> ${to}`);
    const last = projection.transitions[projection.transitions.length - 1];
    assert.equal(last?.cause, "explicit:run.state-changed", `${from} -> ${to}`);
    assert.equal(last?.to, to, `${from} -> ${to}`);
    if (isTerminalRunState(to)) {
      assert.ok(projection.terminalAt !== null, `${from} -> ${to}`);
    }
  }
});

test("every illegal edge is rejected with the right anomaly kind", () => {
  for (const from of ALL_STATES) {
    for (const to of ALL_STATES) {
      const legal =
        EXPECTED_LEGAL_EDGES.some(([f, t]) => f === from && t === to) ||
        (isTerminalRunState(from) && from === to); // 终态自确认是容忍的幂等
      if (legal) continue;

      const events = [...reachState(from), stateEvent({ from, to }, 10)];
      const projection = projectRunEvents(RUN, events);
      const label = `${from} -> ${to}`;

      // 状态不变。
      assert.equal(projection.state, from, label);
      // 恰好一条异常。
      assert.equal(projection.anomalies.length, 1, label);
      const anomaly = projection.anomalies[0];
      assert.ok(anomaly, label);
      // 异常种类正确：离开终态（含双终态）vs 表外非终态迁移。
      const expectedKind = isTerminalRunState(from) ? "double-terminal" : "illegal-transition";
      assert.equal(anomaly?.kind, expectedKind, label);
      assert.equal(anomaly?.attemptedTo, to, label);
      assert.ok(anomaly?.detail.length > 0, label);
    }
  }
});

test("illegal regression examples: running->queued and queued->succeeded", () => {
  const regression = projectRunEvents(RUN, [
    eventOf("agent.started", {}, 1),
    stateEvent({ from: "running", to: "queued" }, 2),
  ]);
  assert.equal(regression.state, "running");
  assert.equal(regression.anomalies[0]?.kind, "illegal-transition");

  const skip = projectRunEvents(RUN, [stateEvent({ from: "queued", to: "succeeded" }, 1)]);
  assert.equal(skip.state, "queued");
  assert.equal(skip.anomalies[0]?.kind, "illegal-transition");
});

test("terminal self-confirmation is tolerated as an idempotent no-op", () => {
  const projection = projectRunEvents(RUN, [
    eventOf("agent.started", {}, 1),
    stateEvent({ from: "running", to: "failed", failure: { code: "upstream", message: "boom" } }, 2),
    stateEvent({ from: "failed", to: "failed" }, 3),
  ]);
  assert.equal(projection.state, "failed");
  assert.equal(projection.anomalies.length, 0);
});

/* ------------------------------------------------------------------ */
/* 显式迁移的失败信息与失步                                            */
/* ------------------------------------------------------------------ */

test("explicit failed transition records the failure from payload", () => {
  const projection = projectRunEvents(RUN, [
    eventOf("agent.started", {}, 1),
    stateEvent(
      { from: "running", to: "failed", failure: { code: "model-unavailable", message: "gone" } },
      2,
    ),
  ]);
  assert.equal(projection.state, "failed");
  assert.equal(projection.failure?.code, "model-unavailable");
  assert.equal(projection.failure?.message, "gone");
});

test("explicit failed transition without failure payload defaults to unknown", () => {
  const projection = projectRunEvents(RUN, [stateEvent({ from: "queued", to: "failed" }, 1)]);
  assert.equal(projection.state, "failed");
  assert.equal(projection.failure?.code, "unknown");
});

test("out-of-sync explicit transition is rejected with the current state preserved", () => {
  const projection = projectRunEvents(RUN, [
    eventOf("agent.started", {}, 1),
    stateEvent({ from: "queued", to: "failed" }, 2), // 声称从 queued，实际在 running
  ]);
  assert.equal(projection.state, "running");
  assert.equal(projection.anomalies[0]?.kind, "out-of-sync");
  assert.equal(projection.anomalies[0]?.from, "running");
});

/* ------------------------------------------------------------------ */
/* 派生迁移                                                            */
/* ------------------------------------------------------------------ */

test("agent.started derives queued->running; repeats are idempotent", () => {
  const projection = projectRunEvents(RUN, [
    eventOf("agent.started", {}, 1),
    eventOf("agent.started", {}, 2),
  ]);
  assert.equal(projection.state, "running");
  assert.equal(projection.transitions.length, 1);
  assert.equal(projection.transitions[0]?.cause, "derived:agent.started");
});

test("run.abort-requested derives running->aborting; from queued it is illegal", () => {
  const ok = projectRunEvents(RUN, [
    eventOf("agent.started", {}, 1),
    eventOf("run.abort-requested", {}, 2),
  ]);
  assert.equal(ok.state, "aborting");
  assert.equal(ok.transitions[1]?.cause, "derived:run.abort-requested");

  const bad = projectRunEvents(RUN, [eventOf("run.abort-requested", {}, 1)]);
  assert.equal(bad.state, "queued");
  assert.equal(bad.anomalies[0]?.kind, "illegal-transition");
});

test("runtime.error with user-abort code from running converges via two steps to aborted", () => {
  const projection = projectRunEvents(RUN, [
    eventOf("agent.started", {}, 1),
    eventOf("runtime.error", { error: { code: "user-abort", message: "cancelled" } }, 2),
  ]);
  assert.equal(projection.state, "aborted");
  const causes = projection.transitions.map((t) => `${t.from}->${t.to}(${t.cause})`);
  assert.deepEqual(causes, [
    "queued->running(derived:agent.started)",
    "running->aborting(implicit:user-abort-via-aborting)",
    "aborting->aborted(derived:runtime.error)",
  ]);
});

test("runtime.error with a non-abort code converges to failed with the failure recorded", () => {
  const projection = projectRunEvents(RUN, [
    eventOf("agent.started", {}, 1),
    eventOf("runtime.error", { error: { code: "timeout", message: "t/o", details: { ms: 100 } } }, 2),
  ]);
  assert.equal(projection.state, "failed");
  assert.equal(projection.failure?.code, "timeout");
  assert.deepEqual(projection.failure?.details, { ms: 100 });
  assert.equal(projection.terminalAt !== null, true);
});

test("runtime.error from queued converges directly to failed (queued->failed is legal)", () => {
  const projection = projectRunEvents(RUN, [
    eventOf("runtime.error", { error: { code: "auth", message: "no key" } }, 1),
  ]);
  assert.equal(projection.state, "failed");
  assert.equal(projection.failure?.code, "auth");
});

test("runtime.error user-abort from queued has no legal path (illegal-convergence)", () => {
  const projection = projectRunEvents(RUN, [
    eventOf("runtime.error", { error: { code: "user-abort", message: "x" } }, 1),
  ]);
  assert.equal(projection.state, "queued");
  assert.equal(projection.anomalies[0]?.kind, "illegal-convergence");
});

test("agent.settled statuses converge from running (succeeded / failed / aborted via two steps)", () => {
  const ok = projectRunEvents(RUN, [
    eventOf("agent.started", {}, 1),
    eventOf("agent.settled", { status: "succeeded" }, 2),
  ]);
  assert.equal(ok.state, "succeeded");
  assert.equal(ok.failure, null);

  const failed = projectRunEvents(RUN, [
    eventOf("agent.started", {}, 1),
    eventOf("agent.settled", { status: "failed", error: { code: "upstream", message: "502" } }, 2),
  ]);
  assert.equal(failed.state, "failed");
  assert.equal(failed.failure?.code, "upstream");

  const aborted = projectRunEvents(RUN, [
    eventOf("agent.started", {}, 1),
    eventOf("agent.settled", { status: "aborted" }, 2),
  ]);
  assert.equal(aborted.state, "aborted");
  assert.deepEqual(
    aborted.transitions.map((t) => `${t.from}->${t.to}`),
    ["queued->running", "running->aborting", "aborting->aborted"],
  );
});

test("agent.settled aborted from aborting converges directly", () => {
  const projection = projectRunEvents(RUN, [
    eventOf("agent.started", {}, 1),
    eventOf("run.abort-requested", {}, 2),
    eventOf("agent.settled", { status: "aborted" }, 3),
  ]);
  assert.equal(projection.state, "aborted");
  assert.equal(projection.transitions.length, 3);
});

test("agent.settled without status derives from state: running->succeeded, aborting->aborted", () => {
  const fromRunning = projectRunEvents(RUN, [
    eventOf("agent.started", {}, 1),
    eventOf("agent.settled", {}, 2),
  ]);
  assert.equal(fromRunning.state, "succeeded");

  const fromAborting = projectRunEvents(RUN, [
    eventOf("agent.started", {}, 1),
    eventOf("run.abort-requested", {}, 2),
    eventOf("agent.settled", {}, 3),
  ]);
  assert.equal(fromAborting.state, "aborted");
});

test("agent.settled after a terminal state is informational (no status) or a double-terminal (with status)", () => {
  const informational = projectRunEvents(RUN, [
    eventOf("agent.started", {}, 1),
    eventOf("agent.settled", { status: "succeeded" }, 2),
    eventOf("agent.settled", {}, 3),
  ]);
  assert.equal(informational.state, "succeeded");
  assert.equal(informational.anomalies.length, 0);

  const conflicting = projectRunEvents(RUN, [
    eventOf("agent.started", {}, 1),
    eventOf("agent.settled", { status: "succeeded" }, 2),
    eventOf("agent.settled", { status: "failed" }, 3),
  ]);
  assert.equal(conflicting.state, "succeeded");
  assert.equal(conflicting.anomalies[0]?.kind, "double-terminal");
});

test("runtime.recovered converges to resolvedTo with the recovered failure", () => {
  const projection = projectRunEvents(RUN, [
    eventOf("agent.started", {}, 1),
    eventOf(
      "runtime.recovered",
      {
        cause: "host-crash",
        from: "running",
        resolvedTo: "failed",
        error: { code: "unknown", message: "interrupted", details: { hostInterrupted: true } },
      },
      2,
    ),
  ]);
  assert.equal(projection.state, "failed");
  assert.equal(projection.failure?.code, "unknown");
  assert.deepEqual(projection.failure?.details, { hostInterrupted: true });
  assert.equal(projection.transitions[projection.transitions.length - 1]?.cause, "recovery:runtime.recovered");
});

/* ------------------------------------------------------------------ */
/* 畸形 payload 与未知类型                                             */
/* ------------------------------------------------------------------ */

test("malformed state-bearing payloads yield invalid-payload anomalies", () => {
  const badState = projectRunEvents(RUN, [stateEvent({ from: 42, to: "running" }, 1)]);
  assert.equal(badState.state, "queued");
  assert.equal(badState.anomalies[0]?.kind, "invalid-payload");

  const badError = projectRunEvents(RUN, [eventOf("runtime.error", { error: "oops" }, 1)]);
  assert.equal(badError.state, "queued");
  assert.equal(badError.anomalies[0]?.kind, "invalid-payload");

  const badStatus = projectRunEvents(RUN, [
    eventOf("agent.started", {}, 1),
    eventOf("agent.settled", { status: "exploded" }, 2),
  ]);
  assert.equal(badStatus.state, "running");
  assert.equal(badStatus.anomalies[0]?.kind, "invalid-payload");

  const badRecovered = projectRunEvents(RUN, [
    eventOf("agent.started", {}, 1),
    eventOf("runtime.recovered", { resolvedTo: "succeeded" }, 2),
  ]);
  assert.equal(badRecovered.state, "running");
  assert.equal(badRecovered.anomalies[0]?.kind, "invalid-payload");
});

test("unknown event types (pi.unknown, message.*, custom) never affect state and never throw", () => {
  const projection = projectRunEvents(RUN, [
    eventOf("pi.unknown", { rawKind: "future.tool.batch-finished", tool: "bash" }, 1),
    eventOf("message.started", { text: "hi" }, 2),
    eventOf("tool.execution.started", { tool: "read" }, 3),
    eventOf("tree.navigated", { fromEntryId: "a", toEntryId: "b" }, 4),
    eventOf("run.steer-enqueued", { text: "go" }, 5),
    eventOf("duration.recorded", { phase: "run" }, 6),
    eventOf("totally.new.event.v9", { anything: true }, 7),
  ]);
  assert.equal(projection.state, "queued");
  assert.equal(projection.anomalies.length, 0);
  assert.equal(projection.eventCount, 7);
  assert.equal(projection.lastSeq, 7);
});

/* ------------------------------------------------------------------ */
/* 排序与空流                                                          */
/* ------------------------------------------------------------------ */

test("events are processed in seq order regardless of input order", () => {
  const projection = projectRunEvents(RUN, [
    eventOf("agent.settled", { status: "succeeded" }, 2),
    eventOf("agent.started", {}, 1),
  ]);
  assert.equal(projection.state, "succeeded");
  assert.equal(projection.anomalies.length, 0);
});

test("empty stream yields the zero-event queued projection", () => {
  const projection = projectRunEvents(RUN, []);
  assert.equal(projection.state, "queued");
  assert.equal(projection.terminalAt, null);
  assert.equal(projection.failure, null);
  assert.equal(projection.eventCount, 0);
  assert.equal(projection.lastSeq, null);
});

/* ------------------------------------------------------------------ */
/* 迁移表助手（与期望表交叉验证）                                      */
/* ------------------------------------------------------------------ */

test("isLegalRunStateTransition agrees with the expected edge table", () => {
  for (const from of ALL_STATES) {
    for (const to of ALL_STATES) {
      const expected = EXPECTED_LEGAL_EDGES.some(([f, t]) => f === from && t === to);
      assert.equal(
        isLegalRunStateTransition(from, to),
        expected,
        `${from} -> ${to}`,
      );
    }
  }
});
