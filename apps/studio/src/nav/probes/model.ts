/** model ownership for b9-probes.ts; compatibility entrypoint remains one level above. */
import type {
  B9Dataset,
} from "../b9-dataset.ts";
import type {
  TreeNavEngine,
} from "../nav-engine.ts";

/* ------------------------------------------------------------------ */
/* 结果形状                                                             */
/* ------------------------------------------------------------------ */

export interface B9ProbeOutcome {
  readonly id: string;
  readonly status: "PASS" | "FAIL";
  readonly detail: string;
  readonly durationMs: number;
  readonly failures: readonly string[];
}

export interface B9PerfOpTiming {
  readonly opId: string;
  readonly kind: "expand" | "switch" | "page" | "search";
  readonly durationMs: number;
}

export interface B9PerfReport {
  readonly warmupMs: number;
  readonly firstOpenMs: number;
  readonly ops: readonly B9PerfOpTiming[];
  readonly opCount: number;
  readonly p95Ms: number;
  readonly medianMs: number;
  readonly maxMs: number;
}

export interface B9EngineCheckResult {
  readonly probes: readonly B9ProbeOutcome[];
  readonly perf: B9PerfReport;
  readonly pass: boolean;
  readonly passedCount: number;
  readonly failedCount: number;
}

/* ------------------------------------------------------------------ */
/* 单探针实现                                                           */
/* ------------------------------------------------------------------ */

export interface ProbeContext {
  readonly dataset: B9Dataset;
  readonly engine: TreeNavEngine;
}

/* ------------------------------------------------------------------ */
/* 性能序列（脚本化、确定性；预热后计时）                                */
/* ------------------------------------------------------------------ */

export interface PerfOp {
  readonly opId: string;
  readonly kind: "expand" | "switch" | "page" | "search";
  readonly run: () => unknown;
}
