/**
 * 并发终态写入测试（任务书要求：并发 terminal 更新不会双终态）。
 *
 * 1. 同一数据库两个仓储实例：后到终态写入被拒绝、状态不变；
 * 2. worker_threads 真并行竞态（Atomics 屏障对齐后同时写 succeeded/failed）：
 *    恰好一胜、败者 RunTerminalConflictError、数据库单终态；
 * 3. worker_threads 真并行 I6 清扫：全部 run 收敛到 failed、不重复；
 * 4. 裸 SQL 直接改写终态行被触发器拦截（第三层防御）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import type { EpisodeId, RunId } from "@treeai/contracts";
import { RunTerminalConflictError, TreeRepository } from "../src/index.ts";
import {
  cleanupTempDir,
  dbPath,
  makeClock,
  makeIdGenerator,
  makeSessionReference,
  makeTempDir,
  modelFailure,
} from "./helpers.ts";

interface WorkerResult {
  readonly index: number;
  readonly kind: string;
  readonly ok: boolean;
  readonly finalState?: string;
  readonly swept?: number;
  readonly errorName?: string;
  readonly currentTerminalState?: string;
  readonly errorMessage?: string;
}

function runWorker(input: {
  kind: "terminal-update" | "sweep";
  dbPath: string;
  runId?: string;
  target?: "succeeded" | "failed";
  barrier: SharedArrayBuffer;
  index: number;
  total: number;
}): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./concurrency-worker.ts", import.meta.url), { workerData: input });
    worker.on("message", (message: WorkerResult) => resolve(message));
    worker.on("error", (error) => reject(error));
  });
}

function setupEpisode(repo: TreeRepository): EpisodeId {
  const forest = repo.createForest();
  const tree = repo.createTree(forest.id);
  const branch = repo.createBranch(tree.id);
  const episode = repo.createEpisode(branch.id);
  return episode.id;
}

test("two repository handles on one file: second terminal update conflicts, no double terminal", () => {
  const dir = makeTempDir();
  try {
    const path = dbPath(dir);
    const a = TreeRepository.open({ path, now: makeClock(), generateId: makeIdGenerator("c") });
    const b = TreeRepository.open({ path, now: makeClock(), generateId: makeIdGenerator("d") });
    const episodeId = setupEpisode(a);
    const run = a.createRun(episodeId, makeSessionReference());
    a.updateRunState(run.id, "running");

    const won = a.updateRunState(run.id, "succeeded");
    assert.equal(won.state, "succeeded");
    assert.notEqual(won.terminalAt, null);

    // 另一连接读到同一终态
    assert.equal(b.getRun(run.id).state, "succeeded");
    // 另一连接的终态写入被拒绝
    assert.throws(
      () => b.updateRunState(run.id, "failed", { failure: modelFailure() }),
      (e: unknown) => e instanceof RunTerminalConflictError && e.currentTerminalState === "succeeded",
    );
    // 非终态迁移同样被拒绝（终态吸收）
    assert.throws(() => b.updateRunState(run.id, "running"), RunTerminalConflictError);

    // a 的终态未被 b 的失败尝试改变
    const after = a.getRun(run.id);
    assert.equal(after.state, "succeeded");
    assert.equal(after.failure, undefined);
    assert.notEqual(after.terminalAt, null);
    a.close();
    b.close();
  } finally {
    cleanupTempDir(dir);
  }
});

test("parallel terminal updates from two worker threads produce exactly one terminal state", async () => {
  const dir = makeTempDir();
  try {
    const path = dbPath(dir);
    const repo = TreeRepository.open({ path, now: makeClock(), generateId: makeIdGenerator("race") });
    const episodeId = setupEpisode(repo);
    const rounds = 5;

    for (let round = 0; round < rounds; round++) {
      const run = repo.createRun(episodeId, makeSessionReference({ sessionId: `race-${round}` }));
      repo.updateRunState(run.id, "running");

      const barrier = new SharedArrayBuffer(4);
      const results = await Promise.all([
        runWorker({
          kind: "terminal-update",
          dbPath: path,
          runId: run.id,
          target: "succeeded",
          barrier,
          index: 0,
          total: 2,
        }),
        runWorker({
          kind: "terminal-update",
          dbPath: path,
          runId: run.id,
          target: "failed",
          barrier,
          index: 1,
          total: 2,
        }),
      ]);

      // 恰好一胜
      const winners = results.filter((r) => r.ok);
      assert.equal(winners.length, 1, `round ${round}: exactly one winner, got ${JSON.stringify(results)}`);
      const losers = results.filter((r) => !r.ok);
      assert.equal(losers.length, 1);
      assert.equal(
        losers[0]!.errorName,
        "RunTerminalConflictError",
        `round ${round}: loser must see terminal conflict, got ${JSON.stringify(losers[0])}`,
      );

      // 胜者索引决定终态；数据库内 state/terminalAt/failure 完全一致（无双终态）
      const winnerIndex = winners[0]!.index;
      const final = repo.getRun(run.id);
      if (winnerIndex === 0) {
        assert.equal(final.state, "succeeded");
        assert.equal(final.failure, undefined);
      } else {
        assert.equal(final.state, "failed");
        assert.ok(final.failure !== undefined, "failed winner must carry a failure");
        assert.equal(final.failure.code, "unknown");
      }
      assert.notEqual(final.terminalAt, null);
    }

    // 全部 5 个 run 都恰好一次终态
    const runs = repo.listRuns(episodeId);
    assert.equal(runs.length, rounds);
    for (const run of runs) {
      assert.notEqual(run.terminalAt, null);
      assert.ok(["succeeded", "failed"].includes(run.state));
      assert.equal(run.state === "failed", run.failure !== undefined);
    }
    repo.close();
  } finally {
    cleanupTempDir(dir);
  }
});

test("parallel restart sweeps converge all runs to failed exactly once", async () => {
  const dir = makeTempDir();
  try {
    const path = dbPath(dir);
    const repo = TreeRepository.open({ path, now: makeClock(), generateId: makeIdGenerator("sweep") });
    const episodeId = setupEpisode(repo);

    // 6 个非终态 run，状态覆盖 queued/running/aborting
    const runIds: RunId[] = [];
    for (let i = 0; i < 6; i++) {
      const run = repo.createRun(episodeId, makeSessionReference({ sessionId: `sweep-${i}` }));
      if (i % 3 === 1) repo.updateRunState(run.id, "running");
      if (i % 3 === 2) {
        repo.updateRunState(run.id, "running");
        repo.updateRunState(run.id, "aborting");
      }
      runIds.push(run.id);
    }

    const barrier = new SharedArrayBuffer(4);
    const results = await Promise.all([
      runWorker({ kind: "sweep", dbPath: path, barrier, index: 0, total: 2 }),
      runWorker({ kind: "sweep", dbPath: path, barrier, index: 1, total: 2 }),
    ]);

    // 两个 worker 都成功，清扫总数恰好等于 run 数（每行只被置终态一次）
    for (const r of results) {
      assert.ok(r.ok, `sweep worker must succeed, got ${JSON.stringify(r)}`);
    }
    const sweptTotal = results.reduce((sum, r) => sum + (r.swept ?? 0), 0);
    assert.equal(sweptTotal, runIds.length, "each non-terminal run swept exactly once across both workers");

    for (const runId of runIds) {
      const run = repo.getRun(runId);
      assert.equal(run.state, "failed");
      assert.notEqual(run.terminalAt, null);
      assert.ok(run.failure !== undefined && run.failure.code === "unknown");
    }
    assert.deepEqual(repo.listNonTerminalRuns(), []);
    repo.close();
  } finally {
    cleanupTempDir(dir);
  }
});

test("direct SQL mutation of a terminal run is blocked by the trigger (third defense layer)", () => {
  const dir = makeTempDir();
  try {
    const path = dbPath(dir);
    const repo = TreeRepository.open({ path, now: makeClock(), generateId: makeIdGenerator("trig") });
    const episodeId = setupEpisode(repo);
    const run = repo.createRun(episodeId, makeSessionReference());
    repo.updateRunState(run.id, "running");
    repo.updateRunState(run.id, "succeeded");
    repo.close();

    // 绕过仓储的裸 SQL：改 state / terminal_state / failure_json 都被触发器 ABORT
    const raw = new DatabaseSync(path);
    assert.throws(
      () => raw.prepare("UPDATE runs SET state = 'aborted' WHERE id = ?").run(run.id),
      /already in terminal state/,
    );
    assert.throws(
      () => raw.prepare("UPDATE runs SET terminal_state = 'aborted' WHERE id = ?").run(run.id),
      /already in terminal state/,
    );
    assert.throws(
      () =>
        raw
          .prepare("UPDATE runs SET failure_json = '{\"code\":\"unknown\",\"message\":\"x\"}' WHERE id = ?")
          .run(run.id),
      /already in terminal state/,
    );
    // 等值重写（no-op 同值）不触发
    raw.prepare("UPDATE runs SET state = 'succeeded' WHERE id = ?").run(run.id);
    raw.close();

    const reopened = TreeRepository.open({ path });
    const after = reopened.getRun(run.id);
    assert.equal(after.state, "succeeded");
    assert.equal(after.failure, undefined);
    reopened.close();
  } finally {
    cleanupTempDir(dir);
  }
});
