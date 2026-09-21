/**
 * 并发测试 worker：与其他 worker 在共享计数屏障上对齐后，
 * 并发对同一数据库执行终态写入（updateRunState / failNonTerminalRuns）。
 *
 * 由 tests/concurrency.test.ts 以 `new Worker(new URL(...))` 启动；
 * 本文件不是独立测试（命名不含 .test.，不会被 node --test 收集）。
 */
import { parentPort, workerData } from "node:worker_threads";
import type { RunId, RunState, TreeAIError } from "@treeai/contracts";
import { TreeRepository } from "../src/index.ts";

interface WorkerInput {
  readonly kind: "terminal-update" | "sweep";
  readonly dbPath: string;
  readonly runId?: string;
  readonly target?: RunState;
  readonly barrier: SharedArrayBuffer;
  readonly index: number;
  readonly total: number;
}

interface WorkerResult {
  readonly index: number;
  readonly kind: string;
  readonly ok: boolean;
  readonly finalState?: RunState;
  readonly swept?: number;
  readonly errorName?: string;
  readonly currentTerminalState?: string;
  readonly errorMessage?: string;
}

const input = workerData as WorkerInput;
if (parentPort === null) {
  throw new Error("concurrency worker must be started from a parent thread");
}
const port = parentPort;

/** 忙等屏障：所有 worker 互相可见后才放行（保证写入真正并发发起）。 */
function waitForPeers(): void {
  const counter = new Int32Array(input.barrier);
  Atomics.add(counter, 0, 1);
  const deadline = Date.now() + 10_000;
  while (Atomics.load(counter, 0) < input.total) {
    if (Date.now() > deadline) {
      throw new Error(`worker ${input.index}: barrier timeout`);
    }
  }
}

function postResult(result: WorkerResult): void {
  port.postMessage(result);
  port.close();
}

function raceFailure(): TreeAIError {
  return {
    code: "unknown",
    message: `worker ${input.index} race failure`,
    details: { worker: input.index },
  };
}

try {
  const repo = TreeRepository.open({ path: input.dbPath });
  let result: WorkerResult;
  try {
    waitForPeers();
    if (input.kind === "terminal-update") {
      const options = input.target === "failed" ? { failure: raceFailure() } : undefined;
      const updated = repo.updateRunState(input.runId as RunId, input.target as RunState, options);
      result = { index: input.index, kind: input.kind, ok: true, finalState: updated.state };
    } else {
      const swept = repo.failNonTerminalRuns({
        code: "unknown",
        message: "host process interrupted before run reached a terminal state",
        details: { hostInterrupted: true, worker: input.index },
      });
      result = { index: input.index, kind: input.kind, ok: true, swept: swept.length };
    }
  } finally {
    repo.close();
  }
  postResult(result);
} catch (error) {
  const err = error as { name?: string; message?: string; currentTerminalState?: string };
  postResult({
    index: input.index,
    kind: input.kind,
    ok: false,
    errorName: err.name ?? "Error",
    errorMessage: err.message,
    currentTerminalState: typeof err.currentTerminalState === "string" ? err.currentTerminalState : undefined,
  });
}
