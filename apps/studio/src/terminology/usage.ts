/** Terminology usage ownership; public compatibility exports remain in ../terminology.ts. */
import type {
  TerminologyExecutorUsage,
  TerminologyUsageBucket,
} from "./model.ts";
import {
  TERMINOLOGY_V2_INPUT_TOKEN_LIMIT,
} from "./policy.ts";
import type {
  TerminologyUsageDelta,
} from "@treeai/contracts";

/** 旧形状（total + lateResultsDiscarded）兼容还原：缺省字段补零/空。 */
export function normalizeExecutorUsage(raw: unknown): TerminologyExecutorUsage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as {
    total?: unknown;
    lateResultsDiscarded?: unknown;
    unknownCostRequests?: unknown;
    buckets?: unknown;
    dirty?: unknown;
  };
  const total = record.total;
  if (
    typeof total !== "object" ||
    total === null ||
    typeof (total as { requests?: unknown }).requests !== "number" ||
    typeof (total as { promptChars?: unknown }).promptChars !== "number" ||
    typeof (total as { completionChars?: unknown }).completionChars !== "number"
  ) {
    return null;
  }
  const buckets: Record<string, TerminologyUsageBucket> = {};
  if (typeof record.buckets === "object" && record.buckets !== null) {
    for (const [key, value] of Object.entries(record.buckets as Record<string, unknown>)) {
      if (typeof value !== "object" || value === null) continue;
      const bucket = value as { requests?: unknown; promptChars?: unknown; completionChars?: unknown; unknownRequests?: unknown };
      if (
        typeof bucket.requests !== "number" ||
        typeof bucket.promptChars !== "number" ||
        typeof bucket.completionChars !== "number"
      ) {
        continue;
      }
      buckets[key] = {
        requests: bucket.requests,
        promptChars: bucket.promptChars,
        completionChars: bucket.completionChars,
        unknownRequests: typeof bucket.unknownRequests === "number" ? bucket.unknownRequests : 0,
      };
    }
  }
  return {
    total: {
      requests: (total as { requests: number }).requests,
      promptChars: (total as { promptChars: number }).promptChars,
      completionChars: (total as { completionChars: number }).completionChars,
    },
    lateResultsDiscarded: typeof record.lateResultsDiscarded === "number" ? record.lateResultsDiscarded : 0,
    unknownCostRequests: typeof record.unknownCostRequests === "number" ? record.unknownCostRequests : 0,
    buckets,
    dirty: record.dirty === true,
  };
}

/** 估算 token（诚实口径：chars/4；Pi 契约面不透出 token 用量）。 */
export function estimateTokens(usage: TerminologyUsageDelta): number {
  return Math.ceil((usage.promptChars + usage.completionChars) / 4);
}

export function estimatePromptTokens(prompt: string): number {
  return Math.ceil(prompt.length / 4);
}

export function promptBudgetFailure(prompt: string): { readonly code: string; readonly message: string } | null {
  const estimated = estimatePromptTokens(prompt);
  if (estimated <= TERMINOLOGY_V2_INPUT_TOKEN_LIMIT) return null;
  return {
    code: "input-token-budget-exceeded",
    message:
      `the terminology prompt is estimated at ${String(estimated)} input tokens, exceeding the ` +
      `${String(TERMINOLOGY_V2_INPUT_TOKEN_LIMIT)}-token v2 input limit; zero dispatch (chars/4 estimate, provider tokenizer not verified)`,
  };
}

export function addUsage(a: TerminologyUsageDelta, b: TerminologyUsageDelta): TerminologyUsageDelta {
  return {
    requests: a.requests + b.requests,
    promptChars: a.promptChars + b.promptChars,
    completionChars: a.completionChars + b.completionChars,
  };
}

/** 记账失败（不可信账目）时新任务的 fail-closed 错误码。 */
export const USAGE_ACCOUNTING_UNAVAILABLE = "usage-accounting-unavailable";

export function toTreeAIErrorCode(err: unknown): string {
  if (err !== null && typeof err === "object" && "code" in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "unknown";
}

export function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
