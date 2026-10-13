import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
/** Terminology evaluator reporting with unchanged denominator and gates Instance-owned state and dependencies. */

export function createEvalReporting(deps) {

  function utcRunId() {
    return new Date().toISOString().replace(/[-:]/g, "").replace(".", "");
  }

  /** 密钥扫描（纯函数）：报告文本中出现凭据值 → true。 */
  function containsSecret(text, secret) {
    return typeof secret === "string" && secret.length > 0 && text.includes(secret);
  }

  /* ---------------- 证据写出 ---------------- */

  function csvEscape(value) {
    const text = String(value ?? "");
    return `"${text.replace(/"/g, '""').replace(/\r?\n/g, "\\n")}"`;
  }

  function buildAnnotationSheetCsv(setName, items, rowsById) {
    const header = [
      "item_id", "kind", "lang", "category", "group", "expectation", "task_input", "output",
      "rater1_useful", "rater1_key_obstacle", "rater2_useful", "rater2_key_obstacle",
      "arbitrated_useful", "arbitrated_key_obstacle", "notes",
    ];
    const lines = [header.join(",")];
    for (const item of items) {
      const row = rowsById.get(item.id) ?? {};
      let taskInput;
      let output;
      if (item.kind === "explain") {
        taskInput = `term=${item.term} | occurrence=${String(item.occurrence ?? 1)} | mode=${item.mode} | expectation=${item.expectation}`;
        output =
          row.status === "succeeded"
            ? row.explanation
            : row.status === "notApplicable"
              ? "(not applicable: this provider does not explain)"
              : `(no output: ${row.failure ?? row.status})`;
      } else {
        taskInput = `expected=${(item.expectedTerms ?? []).join(";")} | negative=${(item.negativeTerms ?? []).join(";")}`;
        output =
          row.status === "succeeded"
            ? (row.candidates ?? []).map((c) => c.term).join(" | ")
            : row.status === "notApplicable"
              ? "(not applicable)"
              : `(no output: ${row.failure ?? row.status})`;
      }
      lines.push(
        [
          item.id, item.kind, item.lang, item.category, item.group,
          item.kind === "explain" ? item.expectation : "",
          taskInput, output, "", "", "", "", "", "", "",
        ]
          .map(csvEscape)
          .join(","),
      );
    }
    return lines.join("\n") + "\n";
  }

  function buildSummaryMd(report) {
    const lines = [];
    lines.push(`# Terminology eval run ${report.runId}`);
    lines.push("");
    lines.push(`- set: **${report.set}** (hash \`${report.setHash.slice(0, 16)}…\`)`);
    lines.push(`- mode/provider/model: **${report.mode} / ${report.provider} / ${report.model}**`);
    lines.push(`- git: \`${report.git.sha}\` (dirty: ${String(report.git.dirty)}) branch \`${report.git.branch}\``);
    lines.push(`- runner v${String(deps.RUNNER_VERSION)}; prompt versions explain v${String(report.promptVersions.explain)} / extract v${String(report.promptVersions.extract)}`);
    lines.push(`- started/finished: ${report.startedAt} → ${report.finishedAt}`);
    lines.push("");
    lines.push("## Gates");
    lines.push("");
    lines.push("| gate | status | binding | detail |");
    lines.push("| --- | --- | --- | --- |");
    for (const gate of report.gates) {
      lines.push(`| ${gate.name} | ${gate.status} | ${gate.binding ? "yes" : "reported-only"} | ${gate.detail.replace(/\|/g, "\\|")} |`);
    }
    lines.push("");
    lines.push("## Metrics (per task kind)");
    const explain = report.metrics.explain;
    const extract = report.metrics.extract;
    lines.push("");
    lines.push(
      `**explain** — ran ${String(explain.ran)} (succeeded ${String(explain.succeeded)}, failed ${String(explain.failed)}); ` +
        `source match ${String(explain.sourceMatchOk)}/${String(explain.ran)}; empty outputs ${String(explain.emptyOutputs)}; ` +
        `latency p50 ${explain.latencyMs.p50 ?? "n/a"}ms / p95 ${explain.latencyMs.p95 ?? "n/a"}ms (advisory ≤${String(deps.ADVISORY_EXPLAIN_P95_MS)}ms) / max ${explain.latencyMs.max ?? "n/a"}ms`,
    );
    lines.push("");
    lines.push(
      `**extract** — ran ${String(extract.ran)} (positives ${String(extract.positives)}, full negatives ${String(extract.fullNegatives)}, ` +
        `failed ${String(extract.failed)}); expectedTerms recall ${String(extract.expectedFound)}/${String(extract.expectedTotal)}` +
        `${extract.recall === null ? "" : ` = ${(extract.recall * 100).toFixed(1)}%`}; precision ${String(extract.expectedFound)}/${String(extract.markedTotal)}` +
        `${extract.precision === null ? "" : ` = ${(extract.precision * 100).toFixed(1)}%`}; negativeTerms mislabel ` +
        `${String(extract.negativeTermsHit)}/${String(extract.negativeTermsTotal)}` +
        `${extract.mislabelRate === null ? "" : ` = ${(extract.mislabelRate * 100).toFixed(1)}%`}; full-negative item mislabel ` +
        `${String(extract.fullNegativeItemsWithMarks)}/${String(extract.fullNegatives)}` +
        `${extract.fullNegativeItemMislabelRate === null ? "" : ` = ${(extract.fullNegativeItemMislabelRate * 100).toFixed(1)}%`}; ` +
        `unlisted extras ${String(extract.extraTerms)}; empty outputs on positives ${String(extract.emptyOutputsOnPositives)}; ` +
        `latency p50 ${extract.latencyMs.p50 ?? "n/a"}ms / p95 ${extract.latencyMs.p95 ?? "n/a"}ms (advisory ≤${String(deps.ADVISORY_EXTRACT_P95_MS)}ms)`,
    );
    lines.push("");
    lines.push("## Cost accounting (explicit denominators; tokens honestly UNKNOWN)");
    lines.push("");
    const usage = report.usage;
    lines.push(
      `- explain: ${String(usage.explain.requests)} request(s), input ${String(usage.explain.promptChars)} chars / output ${String(usage.explain.completionChars)} chars`,
    );
    lines.push(
      `- extract: ${String(usage.extract.requests)} request(s), input ${String(usage.extract.promptChars)} chars / output ${String(usage.extract.completionChars)} chars`,
    );
    lines.push(
      `- tokens: real usage **UNKNOWN** (the Pi seam does not expose token counts); chars/4 estimate ` +
        `${String(usage.explain.estimatedTokensCharsOver4)} (explain) + ${String(usage.extract.estimatedTokensCharsOver4)} (extract) — ` +
        `listed separately, never mixed`,
    );
    lines.push(`- retries: ${String(report.options.retries)} max; ${String(report.metrics.totalRetries)} actual retry dispatch(es)`);
    lines.push("");
    lines.push("## Pending human gates");
    lines.push("");
    lines.push(
      `- 有用率 (≥${deps.GATE_USEFULNESS_MIN * 100}%): PENDING — two-person annotation of \`annotation-sheet.csv\` (rater1/rater2 + arbitrated).`,
    );
    lines.push(
      `- 关键理解障碍覆盖率 (≥${deps.GATE_OBSTACLE_COVERAGE_MIN * 100}%): PENDING — key_obstacle columns + arbitrated useful explanations.`,
    );
    lines.push("");
    lines.push("## Note");
    lines.push("");
    lines.push(report.note);
    if (report.selftest !== null) {
      lines.push("");
      lines.push("## Echo selftest");
      lines.push("");
      for (const check of report.selftest) {
        lines.push(`- [${check.status}] ${check.name} — ${check.detail}`);
      }
    }
    lines.push("");
    return lines.join("\n");
  }

  function listExistingRuns(evidenceRoot) {
    if (!existsSync(evidenceRoot)) return [];
    const runs = [];
    for (const entry of readdirSync(evidenceRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const runPath = join(evidenceRoot, entry.name, "run.json");
      if (!existsSync(runPath)) continue;
      try {
        runs.push(JSON.parse(readFileSync(runPath, "utf8")));
      } catch {
        /* 损坏的 run.json 不参与锁判定（不阻断，也不冒充裁决）。 */
      }
    }
    return runs;
  }

  /** set-integrity / selftest 失败：仍写最小证据目录（如实记录失败阶段）。 */
  function finishWithFailure(checks, cli, activeSet, setHash, sha, branchName, gitDirty, startedAt, stage) {
    const runId = `term-eval-${utcRunId()}-${cli.set}-${cli.mode}-${cli.provider}-failed`;
    const runDir = join(cli.evidenceRoot, runId);
    if (existsSync(runDir)) {
      console.error(`term-eval: evidence directory already exists (never overwritten): ${runDir}`);
      process.exit(1);
    }
    mkdirSync(runDir, { recursive: true });
    const report = {
      runId,
      runnerVersion: deps.RUNNER_VERSION,
      mode: cli.mode,
      set: cli.set,
      provider: cli.provider,
      model: `${cli.provider}/${cli.model}`,
      executed: false,
      stage,
      git: { sha, dirty: gitDirty, branch: branchName },
      startedAt,
      finishedAt: new Date().toISOString(),
      setHash,
      checks,
      note: `run refused at stage '${stage}' — no items were dispatched; nothing here is model-quality evidence`,
    };
    writeFileSync(join(runDir, "run.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
    console.log("");
    for (const check of checks) console.log(`  [${check.status}] ${check.name} — ${check.detail}`);
    console.log("");
    console.log(`term-eval: FAILED at stage ${stage} (evidence: ${runDir})`);
    process.exit(2);
  }

  function summarize(checks, cli, message) {
    console.log("");
    for (const check of checks) console.log(`  [${check.status}] ${check.name} — ${check.detail}`);
    console.log("");
    console.log(`term-eval: ${message}`);
  }

  return {
    containsSecret,
    finishWithFailure,
    listExistingRuns,
    summarize,
    utcRunId,
    buildAnnotationSheetCsv,
    buildSummaryMd,
  };
}
