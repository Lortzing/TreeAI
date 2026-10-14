/** runner ownership for b9-probes.ts; compatibility entrypoint remains one level above. */
import {
  B9_BIG_TREE_ID,
  type B9Dataset,
} from "../b9-dataset.ts";
import type {
  TreeNavEngine,
} from "../nav-engine.ts";
import {
  probeDeepPath,
  probeLocateCorrectness,
  probeOrigins100,
  probeSamenameDisambiguation,
  probeSearchLocate,
  probeWidePagination,
} from "./correctness.ts";
import type {
  B9EngineCheckResult,
  B9PerfOpTiming,
  B9ProbeOutcome,
  ProbeContext,
} from "./model.ts";
import {
  buildPerfOps,
  percentile,
} from "./performance.ts";
import {
  B9_BIG_FIRST_OPEN_LIMIT_MS,
  B9_NAV_P95_LIMIT_MS,
} from "./policy.ts";
import {
  probeBigTreeShape,
  probeEmptyTree,
  probeTreeList,
} from "./shape.ts";
import {
  performance,
} from "node:perf_hooks";

/* ------------------------------------------------------------------ */
/* 主入口                                                               */
/* ------------------------------------------------------------------ */

/**
 * 运行 B9 引擎级全量检查。`engine` 必须是**冷引擎**（未构建任何索引）——
 * big-tree-first-open 探针需要测量初次打开的索引冷构建。
 */
export function runB9EngineChecks(options: {
  readonly dataset: B9Dataset;
  readonly engine: TreeNavEngine;
}): B9EngineCheckResult {
  const context: ProbeContext = { dataset: options.dataset, engine: options.engine };
  const probes: B9ProbeOutcome[] = [];

  // —— big-tree-first-open：冷引擎初次打开 b9-big（索引构建 + 首页） ——
  const firstOpenStarted = performance.now();
  let firstOpenError: string | null = null;
  try {
    context.engine.listChildren(B9_BIG_TREE_ID, "b9-big-trunk", { limit: 50 });
  } catch (error) {
    firstOpenError = error instanceof Error ? error.message : String(error);
  }
  const firstOpenMs = performance.now() - firstOpenStarted;
  probes.push({
    id: "big-tree-first-open",
    status: firstOpenError === null && firstOpenMs <= B9_BIG_FIRST_OPEN_LIMIT_MS ? "PASS" : "FAIL",
    detail:
      firstOpenError === null
        ? `cold first open of b9-big (index build + first children page): ${firstOpenMs.toFixed(1)}ms (limit ${String(B9_BIG_FIRST_OPEN_LIMIT_MS)}ms, engine-level)`
        : `threw: ${firstOpenError}`,
    durationMs: firstOpenMs,
    failures:
      firstOpenError !== null
        ? [`first open threw: ${firstOpenError}`]
        : firstOpenMs > B9_BIG_FIRST_OPEN_LIMIT_MS
          ? [`first open ${firstOpenMs.toFixed(1)}ms > ${String(B9_BIG_FIRST_OPEN_LIMIT_MS)}ms`]
          : [],
  });

  // —— 正确性探针（会按需构建其余索引） ——
  probes.push(probeLocateCorrectness(context));
  probes.push(probeOrigins100(context));
  probes.push(probeWidePagination(context));
  probes.push(probeDeepPath(context));
  probes.push(probeSamenameDisambiguation(context));
  probes.push(probeSearchLocate(context));
  probes.push(probeEmptyTree(context));
  probes.push(probeBigTreeShape(context));
  probes.push(probeTreeList(context));

  // —— nav-p95-engine：预热（同一序列跑一遍，不计时）+ 正式计时 ——
  const ops = buildPerfOps(context);
  const warmupStarted = performance.now();
  for (const op of ops) {
    try {
      op.run();
    } catch (error) {
      probes.push({
        id: "nav-p95-engine",
        status: "FAIL",
        detail: `warmup op ${op.opId} threw: ${error instanceof Error ? error.message : String(error)}`,
        durationMs: 0,
        failures: [`warmup op ${op.opId} threw`],
      });
      break;
    }
  }
  const warmupMs = performance.now() - warmupStarted;
  const timings: B9PerfOpTiming[] = [];
  for (const op of ops) {
    const startedAt = performance.now();
    op.run();
    timings.push({ opId: op.opId, kind: op.kind, durationMs: performance.now() - startedAt });
  }
  const sorted = timings.map((timing) => timing.durationMs).sort((a, b) => a - b);
  const p95Ms = percentile(sorted, 0.95);
  const medianMs = percentile(sorted, 0.5);
  const maxMs = sorted[sorted.length - 1] ?? 0;
  const alreadyFailed = probes.some((probe) => probe.id === "nav-p95-engine");
  if (!alreadyFailed) {
    probes.push({
      id: "nav-p95-engine",
      status: timings.length >= 50 && p95Ms <= B9_NAV_P95_LIMIT_MS ? "PASS" : "FAIL",
      detail:
        `${String(timings.length)} scripted expand/switch/search ops (warm; b9-big/b9-deep/b9-wide + cross-tree search): ` +
        `p95 ${p95Ms.toFixed(1)}ms ≤ ${String(B9_NAV_P95_LIMIT_MS)}ms (median ${medianMs.toFixed(1)}ms, max ${maxMs.toFixed(1)}ms, warmup ${warmupMs.toFixed(0)}ms; engine-level evidence, not the browser verdict)`,
      durationMs: maxMs,
      failures: timings.length < 50 ? [`only ${String(timings.length)} ops (< 50)`] : p95Ms > B9_NAV_P95_LIMIT_MS ? [`p95 ${p95Ms.toFixed(1)}ms > ${String(B9_NAV_P95_LIMIT_MS)}ms`] : [],
    });
  }

  const passedCount = probes.filter((probe) => probe.status === "PASS").length;
  const failedCount = probes.length - passedCount;
  return {
    probes,
    perf: {
      warmupMs,
      firstOpenMs,
      ops: timings,
      opCount: timings.length,
      p95Ms,
      medianMs,
      maxMs,
    },
    pass: failedCount === 0,
    passedCount,
    failedCount,
  };
}
