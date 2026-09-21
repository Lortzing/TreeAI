/**
 * Run 状态机测试：合法/非法迁移矩阵（对照 contracts 冻结迁移表）、
 * 单终态（I3）、终态吸收（I2）、failure iff failed、同连接双终态拒绝。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RunId, RunState, TreeAIError } from "@treeai/contracts";
import {
  EntityNotFoundError,
  InvalidArgumentError,
  InvalidRunStateTransitionError,
  RunTerminalConflictError,
  TreeRepository,
} from "../src/index.ts";
import {
  hostInterruptedFailure,
  makeClock,
  makeIdGenerator,
  makeSessionReference,
  modelFailure,
} from "./helpers.ts";

/** 冻结迁移表（与 contracts RunStateTransitions 一致；本测试为其运行时镜像）。 */
const ALLOWED: Readonly<Record<RunState, readonly RunState[]>> = {
  queued: ["running", "failed"],
  running: ["aborting", "succeeded", "failed"],
  aborting: ["aborted", "failed"],
  succeeded: [],
  failed: [],
  aborted: [],
};

function makeRunningRun(repo: TreeRepository): RunId {
  const forest = repo.createForest();
  const tree = repo.createTree(forest.id);
  const branch = repo.createBranch(tree.id);
  const episode = repo.createEpisode(branch.id);
  const run = repo.createRun(episode.id, makeSessionReference());
  repo.updateRunState(run.id, "running");
  return run.id;
}

function makeQueuedRun(repo: TreeRepository): RunId {
  const forest = repo.createForest();
  const tree = repo.createTree(forest.id);
  const branch = repo.createBranch(tree.id);
  const episode = repo.createEpisode(branch.id);
  const run = repo.createRun(episode.id, makeSessionReference());
  return run.id;
}

test("every legal transition in the frozen table is accepted", () => {
  const repo = TreeRepository.open({
    path: ":memory:",
    now: makeClock(),
    generateId: makeIdGenerator("t"),
  });
  for (const from of Object.keys(ALLOWED) as RunState[]) {
    for (const to of ALLOWED[from]) {
      const runId = makeQueuedRun(repo);
      // 先把 run 置于 from 态
      if (from === "running") {
        repo.updateRunState(runId, "running");
      } else if (from === "aborting") {
        repo.updateRunState(runId, "running");
        repo.updateRunState(runId, "aborting");
      } else if (from === "queued") {
        // 已是 queued
      } else {
        continue; // 终态 from 无法作为起点构造（I2 吸收）——由专门测试覆盖
      }
      const options = to === "failed" ? { failure: modelFailure() } : undefined;
      const updated = repo.updateRunState(runId, to, options);
      assert.equal(updated.state, to, `transition ${from} -> ${to} must be accepted`);
      if (to === "succeeded" || to === "failed" || to === "aborted") {
        assert.notEqual(updated.terminalAt, null, `${to} must set terminalAt`);
      } else {
        assert.equal(updated.terminalAt, null);
      }
    }
  }
  repo.close();
});

test("illegal transitions are rejected (I5 no-skip, no-rollback; I7 exhaustive table)", () => {
  const repo = TreeRepository.open({
    path: ":memory:",
    now: makeClock(),
    generateId: makeIdGenerator("t"),
  });

  // queued 起点的非法目标
  const queued = makeQueuedRun(repo);
  for (const to of ["succeeded", "aborted", "aborting"] as RunState[]) {
    assert.throws(
      () => repo.updateRunState(queued, to, to === "failed" ? { failure: modelFailure() } : undefined),
      (e: unknown) =>
        e instanceof InvalidRunStateTransitionError && e.fromState === "queued" && e.toState === to,
      `queued -> ${to} must be rejected`,
    );
  }
  // queued -> failed 合法
  repo.updateRunState(queued, "failed", { failure: modelFailure() });

  // running 起点的非法目标（含回退与跳过 aborting）
  const running = makeRunningRun(repo);
  for (const to of ["queued", "aborted"] as RunState[]) {
    assert.throws(
      () => repo.updateRunState(running, to),
      (e: unknown) => e instanceof InvalidRunStateTransitionError && e.fromState === "running",
      `running -> ${to} must be rejected`,
    );
  }
  // aborting 起点的非法目标
  const aborting = makeRunningRun(repo);
  repo.updateRunState(aborting, "aborting");
  for (const to of ["queued", "running", "succeeded"] as RunState[]) {
    assert.throws(
      () => repo.updateRunState(aborting, to),
      (e: unknown) => e instanceof InvalidRunStateTransitionError && e.fromState === "aborting",
      `aborting -> ${to} must be rejected`,
    );
  }
  // 非法迁移不改变状态
  assert.equal(repo.getRun(aborting).state, "aborting");
  repo.close();
});

test("terminal states are absorbing (I2) and singular (I3): same-connection double terminal rejected", () => {
  const repo = TreeRepository.open({
    path: ":memory:",
    now: makeClock(),
    generateId: makeIdGenerator("t"),
  });
  const runId = makeRunningRun(repo);
  const done = repo.updateRunState(runId, "succeeded");
  assert.equal(done.state, "succeeded");
  assert.notEqual(done.terminalAt, null);

  // 第二个终态（任意目标）→ RunTerminalConflictError
  assert.throws(
    () => repo.updateRunState(runId, "aborted"),
    (e: unknown) => e instanceof RunTerminalConflictError && e.currentTerminalState === "succeeded",
  );
  assert.throws(
    () => repo.updateRunState(runId, "failed", { failure: modelFailure() }),
    RunTerminalConflictError,
  );
  // 非终态迁移同样被拒绝（终态吸收）
  assert.throws(() => repo.updateRunState(runId, "running"), RunTerminalConflictError);

  const after = repo.getRun(runId);
  assert.equal(after.state, "succeeded");
  assert.equal(after.failure, undefined);
  repo.close();
});

test("failure is stored iff state is failed", () => {
  const repo = TreeRepository.open({
    path: ":memory:",
    now: makeClock(),
    generateId: makeIdGenerator("t"),
  });
  // to=failed 必须给 failure
  const runId = makeRunningRun(repo);
  assert.throws(
    () => repo.updateRunState(runId, "failed"),
    (e: unknown) => e instanceof InvalidArgumentError && /requires a failure/.test(e.message),
  );
  // 给了 failure 后成功落库（code/message/details 往返；cause 不入库）
  const failure: TreeAIError = { ...modelFailure(), cause: new Error("secret-token-should-not-leak") };
  const failed = repo.updateRunState(runId, "failed", { failure });
  assert.equal(failed.state, "failed");
  assert.equal(failed.failure?.code, "upstream");
  assert.equal(failed.failure?.message, "model request failed");
  assert.deepEqual(failed.failure?.details, { provider: "test-provider", model: "test-model" });
  assert.equal(failed.failure?.cause, undefined, "cause must never be persisted");

  // 非 failed 目标带 failure → 拒绝
  const other = makeRunningRun(repo);
  assert.throws(
    () => repo.updateRunState(other, "succeeded", { failure: modelFailure() }),
    (e: unknown) => e instanceof InvalidArgumentError && /must not be provided/.test(e.message),
  );
  assert.throws(
    () => repo.updateRunState(other, "aborting", { failure: modelFailure() }),
    InvalidArgumentError,
  );
  repo.close();
});

test("aborting converges to aborted (I4) and leaves no permanent aborting state", () => {
  const repo = TreeRepository.open({
    path: ":memory:",
    now: makeClock(),
    generateId: makeIdGenerator("t"),
  });
  const runId = makeRunningRun(repo);
  const aborting = repo.updateRunState(runId, "aborting");
  assert.equal(aborting.state, "aborting");
  assert.equal(aborting.terminalAt, null);
  const aborted = repo.updateRunState(runId, "aborted");
  assert.equal(aborted.state, "aborted");
  assert.notEqual(aborted.terminalAt, null);
  // aborted 后不再迁移
  assert.throws(() => repo.updateRunState(runId, "failed", { failure: hostInterruptedFailure() }), RunTerminalConflictError);
  repo.close();
});

test("updateRunState on unknown run is EntityNotFoundError", () => {
  const repo = TreeRepository.open({ path: ":memory:" });
  assert.throws(
    () => repo.updateRunState("missing-run" as RunId, "running"),
    EntityNotFoundError,
  );
  repo.close();
});
