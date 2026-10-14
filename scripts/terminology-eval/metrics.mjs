
/** Terminology evaluator metrics with unchanged denominator and gates Instance-owned state and dependencies. */

export function createEvalMetrics(deps) {

  function percentile(sortedValues, q) {
    if (sortedValues.length === 0) return null;
    return sortedValues[Math.min(sortedValues.length - 1, Math.floor(q * sortedValues.length))];
  }

  /* ---------------- 指标（纯函数：echo 自检可合成输入验证） ---------------- */

  function computeExplainMetrics(rows) {
    const ran = rows.filter((r) => r.status !== "notApplicable");
    const succeeded = ran.filter((r) => r.status === "succeeded");
    const sourceMatchOk = ran.filter((r) => r.sourceMatch).length;
    const emptyOutputs = succeeded.filter((r) => (r.explanation ?? "").trim().length === 0).length;
    const latencies = ran.map((r) => r.latencyMs).sort((a, b) => a - b);
    const usage = sumUsage(ran);
    return {
      ran: ran.length,
      succeeded: succeeded.length,
      failed: ran.filter((r) => r.status === "failed").length,
      sourceMatchOk,
      sourceMatchRate: ran.length === 0 ? null : sourceMatchOk / ran.length,
      emptyOutputs,
      latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), max: latencies.length === 0 ? null : latencies[latencies.length - 1] },
      advisoryP95TargetMs: deps.ADVISORY_EXPLAIN_P95_MS,
      usage,
    };
  }

  function computeExtractMetrics(rows) {
    const ran = rows.filter((r) => r.status !== "notApplicable");
    const succeeded = ran.filter((r) => r.status === "succeeded");
    const positives = ran.filter((r) => (r.expectedTerms ?? []).length > 0);
    const fullNegatives = ran.filter((r) => (r.expectedTerms ?? []).length === 0);
    let expectedTotal = 0;
    let expectedFound = 0;
    let markedTotal = 0;
    let negativeTermsTotal = 0;
    let negativeTermsHit = 0;
    let extraTerms = 0;
    for (const row of ran) {
      const terms = (row.candidates ?? []).map((c) => (typeof c === "string" ? c : c.term));
      expectedTotal += (row.expectedTerms ?? []).length;
      expectedFound += (row.expectedTerms ?? []).filter((t) => terms.includes(t)).length;
      markedTotal += terms.length;
      negativeTermsTotal += (row.negativeTerms ?? []).length;
      negativeTermsHit += terms.filter((t) => (row.negativeTerms ?? []).includes(t)).length;
      extraTerms += terms.filter(
        (t) => !(row.expectedTerms ?? []).includes(t) && !(row.negativeTerms ?? []).includes(t),
      ).length;
    }
    const fullNegativeWithMarks = fullNegatives.filter((r) => (r.candidates ?? []).length > 0).length;
    const latencies = ran.map((r) => r.latencyMs).sort((a, b) => a - b);
    const usage = sumUsage(ran);
    return {
      ran: ran.length,
      succeeded: succeeded.length,
      failed: ran.filter((r) => r.status === "failed").length,
      positives: positives.length,
      fullNegatives: fullNegatives.length,
      expectedTotal,
      expectedFound,
      recall: expectedTotal === 0 ? null : expectedFound / expectedTotal,
      precision: markedTotal === 0 ? null : expectedFound / markedTotal,
      markedTotal,
      negativeTermsTotal,
      negativeTermsHit,
      mislabelRate: negativeTermsTotal === 0 ? null : negativeTermsHit / negativeTermsTotal,
      fullNegativeItemsWithMarks: fullNegativeWithMarks,
      fullNegativeItemMislabelRate: fullNegatives.length === 0 ? null : fullNegativeWithMarks / fullNegatives.length,
      extraTerms,
      emptyOutputsOnPositives: positives.filter((r) => r.status === "succeeded" && (r.candidates ?? []).length === 0).length,
      latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), max: latencies.length === 0 ? null : latencies[latencies.length - 1] },
      advisoryP95TargetMs: deps.ADVISORY_EXTRACT_P95_MS,
      usage,
    };
  }

  function sumUsage(rows) {
    const total = { requests: 0, promptChars: 0, completionChars: 0 };
    for (const row of rows) {
      const usage = row.usage;
      if (usage === null || usage === undefined) continue;
      total.requests += usage.requests ?? 0;
      total.promptChars += usage.promptChars ?? 0;
      total.completionChars += usage.completionChars ?? 0;
    }
    total.estimatedTokensCharsOver4 = Math.ceil((total.promptChars + total.completionChars) / 4);
    return total;
  }

  /**
   * 门禁装配。绑定规则（如实区分，不搞一刀切）：
   * - real 模式：质量门禁绑定（这是模型质量裁决）；
   * - echo 模式 + 受控假 provider：门禁绑定（受控行为应满足门禁，违反即
   *   管线缺陷）；
   * - echo 模式 + baseline：门禁值如实报告但不绑定（基线是对照下限，弱是
   *   预期，不是 runner 缺陷）。
   */
  function evaluateGates({ mode, provider, explain, extract, pipelineIntegrity }) {
    const gates = [];
    const qualityBinding = mode === "real" || (mode === "echo" && provider === "echo");
    gates.push({
      name: "pipeline-integrity",
      binding: true,
      status: pipelineIntegrity.ok ? "PASS" : "FAIL",
      detail: pipelineIntegrity.detail,
    });
    if (explain.ran === 0) {
      gates.push({
        name: "explain-source-match",
        binding: qualityBinding,
        status: "NOT_RUN",
        detail: explain.notApplicableReason ?? "no explain items ran",
      });
    } else {
      const rate = explain.sourceMatchRate;
      const pass = rate === 1;
      gates.push({
        name: "explain-source-match",
        binding: qualityBinding,
        status: pass ? "PASS" : "FAIL",
        detail:
          `source match (mechanical: term resolved at its Nth occurrence, slice equality — model offsets unused) = ` +
          `${String(explain.sourceMatchOk)}/${String(explain.ran)} = ${(rate * 100).toFixed(1)}% (gate 100%)`,
      });
    }
    if (extract.ran === 0) {
      gates.push({
        name: "extract-negative-mislabel",
        binding: qualityBinding,
        status: "NOT_RUN",
        detail: extract.notApplicableReason ?? "no extract items ran",
      });
    } else {
      const rate = extract.mislabelRate;
      const pass = rate !== null && rate <= deps.GATE_NEGATIVE_MISLABEL_MAX;
      gates.push({
        name: "extract-negative-mislabel",
        binding: qualityBinding,
        status: pass ? "PASS" : "FAIL",
        detail:
          `negativeTerms mislabel (term level) = ${String(extract.negativeTermsHit)}/${String(extract.negativeTermsTotal)} = ` +
          `${rate === null ? "n/a" : `${(rate * 100).toFixed(1)}%`} (gate ≤10%); separately: full-negative item level ` +
          `${String(extract.fullNegativeItemsWithMarks)}/${String(extract.fullNegatives)} = ` +
          `${extract.fullNegativeItemMislabelRate === null ? "n/a" : `${(extract.fullNegativeItemMislabelRate * 100).toFixed(1)}%`}, ` +
          `unlisted extra marks ${String(extract.extraTerms)}`,
      });
    }
    gates.push({
      name: "usefulness",
      binding: false,
      status: "PENDING",
      detail:
        `有用率 (≥${deps.GATE_USEFULNESS_MIN * 100}%) needs two-person annotation of annotation-sheet.csv ` +
        "(rater1/rater2 + arbitration); never asserted mechanically",
    });
    gates.push({
      name: "key-obstacle-coverage",
      binding: false,
      status: "PENDING",
      detail:
        `关键理解障碍覆盖率 (≥${deps.GATE_OBSTACLE_COVERAGE_MIN * 100}%) needs two-person annotation ` +
        "(key_obstacle columns + arbitrated useful explanations); never asserted mechanically",
    });
    return gates;
  }

  return {
    computeExtractMetrics,
    computeExplainMetrics,
    evaluateGates,
  };
}
