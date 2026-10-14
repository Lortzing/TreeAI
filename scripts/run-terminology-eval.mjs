#!/usr/bin/env node
import { createEvalReporting } from "./terminology-eval/reporting.mjs";
import { createEvalEcho } from "./terminology-eval/echo.mjs";
import { createEvalMetrics } from "./terminology-eval/metrics.mjs";
import { createEvalSetIntegrity } from "./terminology-eval/set-integrity.mjs";
import { createEvalCli } from "./terminology-eval/cli.mjs";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 术语冻结评测 runner（issue #7 §4「符合 v2 口径的冻结质量评测」的基建）。
 *
 * 用法：
 *   node scripts/run-terminology-eval.mjs --set dev --mode echo                 # 离线全链路（受控假 provider）
 *   node scripts/run-terminology-eval.mjs --set dev --mode echo --provider baseline   # 零依赖基线（离线）
 *   node scripts/run-terminology-eval.mjs --set dev --mode real --provider X --model Y   # 真实跑批（owner）
 *   node scripts/run-terminology-eval.mjs --set frozen --mode real ...         # 冻结一次性（owner）
 *
 * 参数：--set dev|frozen（缺省 dev）｜--mode echo|real（缺省 echo）｜
 *   --provider echo|baseline|<真实 provider id>（echo 模式缺省 echo；real 模式
 *   缺省 deepseek）｜--model ID（real 模式缺省 deepseek-flash）｜--agent-dir DIR
 *   （缺省仓库内 .pi-d2-live）｜--limit N（开发迭代截断）｜--retries N（失败
 *   重试上限，缺省 0；逐条记录 attempts）｜--evidence-root DIR（缺省
 *   evidence/terminology/eval）｜--allow-observe（frozen 已锁定后的观察性复跑）。
 *
 * 凭据（real 模式）：仅经 TREEAI_STUDIO_API_KEY 环境注入；值绝不写入日志、
 * 报告或证据目录（落盘前密钥扫描，命中即删除证据目录并 exit 1）。缺失 →
 * BLOCKED exit 3，不伪装运行。
 *
 * 退出码（对齐 scripts/verify-d4.js 冻结约定）：
 *   0 — 干净完成（echo：全链路校验通过；real：机械门禁全 PASS 且无 PENDING）
 *   1 — 工具自身错误（参数/IO/覆盖拒绝/密钥扫描命中）
 *   2 — FAIL（集完整性、echo 自检、管线故障，或绑定门禁失败——real 模式与
 *       受控 echo provider 的质量门禁绑定；baseline 的门禁值仅如实报告不绑定）
 *   3 — BLOCKED/NOT_RUN（凭据缺失、frozen 已锁定、real 模式标注门禁 PENDING）
 *
 * 分任务指标（解释/提取分开；分子/分母显式给出）：
 *   解释：来源匹配 100% 机械门禁（代码按词序数解析 term 在原文第 N 次出现
 *         并校验切片全等——不用模型返回的偏移）；延迟分位（p50/p95/max，
 *         目标 ≤5s 仅参考不设门禁）；空输出如实计数。
 *   提取：negativeTerms 误标率 ≤10% 机械门禁（term 级：命中负词数/全部负词
 *         数；另单列全负例条目级误标率与未列名单 extraTerms——分母各自
 *         显式）；expectedTerms 命中 precision/recall；空输出如实计数。
 *   人工门禁：有用率 ≥90%、关键理解障碍覆盖率 ≥80% ——无人标注时 PENDING
 *         并输出两人标注表（annotation-sheet.csv：条目 id、任务类型、输出、
 *         rater1/rater2/arbitrated 标注列），绝不机械冒充。
 *
 * 费用口径（issue #7 §4「不能改换口径」）：逐条记录 requests、输入/输出
 * 字符数、重试次数；tokens 如实记 UNKNOWN（Pi 契约面不透出 token 用量），
 * chars/4 估算单列，绝不与真实 usage 混写。
 *
 * 证据纪律（同 verify-d4/verify-d2）：每次执行追加
 * evidence/terminology/eval/<runId>/{run.json,summary.md,annotation-sheet.csv}，
 * 绝不覆盖历史运行（目录已存在 → exit 1）。frozen 的 real 模式一次性：同
 * setHash 已有已执行的 real 冻结裁决 → 拒绝（exit 3），除非 --allow-observe
 * （观察性复跑，observe 标记，永不改写首个裁决）。
 *
 * echo 模式（离线、零真实调用）：
 *   - 解释任务走产品真实装配：createPiRuntimeFromConfig + EchoSdkPort（与
 *     apps/studio/tests/terminology.test.ts 的缺省注入同机制），解释 = 提示
 *     词回声；
 *   - 提取任务走测试的脚本化 runtime 注入机制（scriptedTerminologyRuntime
 *     同形）：受控假 provider 依据提示词内嵌原文机械解析候选并以 JSON 回答
 *     （含确定性瑕疵注入：漏标末词/负词命中/偏移错位条目/前后噪声——用于
 *     验证指标计算与机械校验能正确处理非完美输出）；
 *   - 自检阶段以合成输入验证指标数学、门禁翻转、基线确定性、密钥扫描；
 *   - echo 结果绝不是模型质量证据（evidence/d3/README.md 规则 5 同款纪律）。
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PI_API_KEY_ENV = "TREEAI_STUDIO_API_KEY";
const DEFAULT_AGENT_DIR = join(ROOT, ".pi-d2-live");
const DEFAULT_EVIDENCE_ROOT = join(ROOT, "evidence", "terminology", "eval");
const RUNNER_VERSION = 1;
const GATE_NEGATIVE_MISLABEL_MAX = 0.1;
const GATE_USEFULNESS_MIN = 0.9;
const GATE_OBSTACLE_COVERAGE_MIN = 0.8;
const ADVISORY_EXPLAIN_P95_MS = 5000;
const ADVISORY_EXTRACT_P95_MS = 8000;
const SIX_CATEGORIES = [
  "technical-concept",
  "general-explanation",
  "homonym-polysemy",
  "already-defined",
  "code-mixed",
  "long-answer",
];
const evalCli = createEvalCli({
  get DEFAULT_AGENT_DIR() { return DEFAULT_AGENT_DIR; },
  get DEFAULT_EVIDENCE_ROOT() { return DEFAULT_EVIDENCE_ROOT; },
});
const { parseArgs } = evalCli;
const evalSetIntegrity = createEvalSetIntegrity({
  get ROOT() { return ROOT; },
  get SIX_CATEGORIES() { return SIX_CATEGORIES; },
});
const { nthOccurrence, isFrozenVerdictLocked, loadSet, sha256Hex, verifySetIntegrity } = evalSetIntegrity;
const evalReporting = createEvalReporting({
  get RUNNER_VERSION() { return RUNNER_VERSION; },
  get ADVISORY_EXPLAIN_P95_MS() { return ADVISORY_EXPLAIN_P95_MS; },
  get ADVISORY_EXTRACT_P95_MS() { return ADVISORY_EXTRACT_P95_MS; },
  get GATE_USEFULNESS_MIN() { return GATE_USEFULNESS_MIN; },
  get GATE_OBSTACLE_COVERAGE_MIN() { return GATE_OBSTACLE_COVERAGE_MIN; },
});
const { containsSecret, finishWithFailure, listExistingRuns, summarize, utcRunId, buildAnnotationSheetCsv, buildSummaryMd } = evalReporting;

const evalMetrics = createEvalMetrics({
  get ADVISORY_EXPLAIN_P95_MS() { return ADVISORY_EXPLAIN_P95_MS; },
  get ADVISORY_EXTRACT_P95_MS() { return ADVISORY_EXTRACT_P95_MS; },
  get GATE_NEGATIVE_MISLABEL_MAX() { return GATE_NEGATIVE_MISLABEL_MAX; },
  get GATE_USEFULNESS_MIN() { return GATE_USEFULNESS_MIN; },
  get GATE_OBSTACLE_COVERAGE_MIN() { return GATE_OBSTACLE_COVERAGE_MIN; },
});
const { computeExtractMetrics, computeExplainMetrics, evaluateGates } = evalMetrics;
const evalEcho = createEvalEcho({
  get computeExtractMetrics() { return computeExtractMetrics; },
  get computeExplainMetrics() { return computeExplainMetrics; },
  get evaluateGates() { return evaluateGates; },
  get nthOccurrence() { return nthOccurrence; },
  get isFrozenVerdictLocked() { return isFrozenVerdictLocked; },
  get containsSecret() { return containsSecret; },
});
const { runEchoSelfcheck, scriptedTerminologyRuntime, makeControlledEchoAnswer, makeBaselineAnswer } = evalEcho;

/* ---------------- 主流程 ---------------- */

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  if (cli.help) return;
  const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
  const sha = commit.status === 0 ? commit.stdout.trim() : "unknown";
  const branchResult = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: ROOT, encoding: "utf8" });
  const branchName = branchResult.status === 0 ? branchResult.stdout.trim() : "unknown";
  const dirtyResult = spawnSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" });
  const gitDirty = dirtyResult.status === 0 ? dirtyResult.stdout.trim().length > 0 : null;
  const startedAt = new Date().toISOString();

  /* 集装载 + 完整性门禁（两集都装载：跨集防泄漏/分母核查）。 */
  const devSet = loadSet("dev");
  const frozenSet = loadSet("frozen");
  const activeSet = cli.set === "dev" ? devSet : frozenSet;
  const setHash = sha256Hex(activeSet.raw);
  const integrity = verifySetIntegrity(devSet, frozenSet);
  const items = cli.limit === null ? activeSet.parsed.items : activeSet.parsed.items.slice(0, cli.limit);
  const explainItems = items.filter((i) => i.kind === "explain");
  const extractItems = items.filter((i) => i.kind === "extract");

  const checks = [];
  const push = (name, status, detail) => checks.push({ name, status, detail });
  push(
    "set-integrity",
    integrity.problems.length === 0 ? "PASS" : "FAIL",
    integrity.problems.length === 0
      ? `dev 180 + frozen 180; group ids and source texts never straddle; zh ${String(integrity.zhCount)}/360; ` +
        `negatives ${String(integrity.negatives)}/360 = ${(integrity.negatives / 360 * 100).toFixed(1)}%; six categories in both; ` +
        `every explain term resolves by occurrence with slice equality; extract term lists verified against sources` +
        (cli.limit === null ? "" : ` (this run is limited to ${String(items.length)} of 180 by --limit)`)
      : `${String(integrity.problems.length)} problem(s): ${integrity.problems.slice(0, 5).join("; ")}`,
  );
  if (integrity.problems.length > 0) {
    finishWithFailure(checks, cli, activeSet, setHash, sha, branchName, gitDirty, startedAt, "set-integrity");
    return;
  }

  /* echo 自检（离线验证指标/门禁/基线/扫描的数学与翻转）。 */
  let selftestChecks = null;
  if (cli.mode === "echo") {
    const baselineModule = await import(join(ROOT, "scripts", "terminology", "baseline.mjs"));
    selftestChecks = await runEchoSelfcheck(baselineModule);
    const failed = selftestChecks.filter((c) => c.status === "FAIL").length;
    push(
      "echo-selftest",
      failed === 0 ? "PASS" : "FAIL",
      `${String(selftestChecks.length - failed)}/${String(selftestChecks.length)} synthetic checks pass (metric math, gate flip, frozen lock, secret scan, baseline determinism)`,
    );
    if (failed > 0) {
      for (const check of selftestChecks) console.log(`  [${check.status}] ${check.name} — ${check.detail}`);
      finishWithFailure(checks, cli, activeSet, setHash, sha, branchName, gitDirty, startedAt, "echo-selftest");
      return;
    }
  }

  /* frozen 一次性锁（real 模式）。 */
  let observe = false;
  if (cli.mode === "real" && cli.set === "frozen") {
    const existingRuns = listExistingRuns(cli.evidenceRoot);
    const lockedBy = isFrozenVerdictLocked(existingRuns, setHash);
    if (lockedBy !== null && !cli.allowObserve) {
      push(
        "frozen-one-shot",
        "BLOCKED",
        `frozen verdict already locked by ${lockedBy.runId} (set hash ${setHash.slice(0, 16)}…); ` +
          "re-run with --allow-observe for an observation-only run (the first verdict is never overwritten)",
      );
      summarize(checks, cli, "blocked: frozen verdict already locked (one-shot discipline)");
      process.exit(3);
    }
    if (lockedBy !== null) {
      observe = true;
      push(
        "frozen-one-shot",
        "PASS",
        `observation-only re-run (${lockedBy.runId} holds the verdict; this run is marked observe=true)`,
      );
    } else {
      push("frozen-one-shot", "PASS", "no prior executed real frozen run for this set hash — this run locks the verdict");
    }
  }

  /* 凭据（real 模式）：仅环境注入，值绝不落盘。 */
  let apiKey = null;
  if (cli.mode === "real") {
    const envValue = process.env[PI_API_KEY_ENV];
    if (typeof envValue !== "string" || envValue.trim() === "") {
      push("credentials", "BLOCKED", `missing ${PI_API_KEY_ENV} (in-memory only; the value is never logged or written)`);
      summarize(checks, cli, `blocked: missing ${PI_API_KEY_ENV}`);
      process.exit(3);
    }
    apiKey = envValue.trim();
    push("credentials", "PASS", `${PI_API_KEY_ENV} present (value never logged)`);
    if (!existsSync(cli.agentDir)) {
      push("agent-dir", "BLOCKED", `agent dir not found: ${cli.agentDir}`);
      summarize(checks, cli, "blocked: controlled agent dir missing");
      process.exit(3);
    }
    push("agent-dir", "PASS", `controlled agent dir ${cli.agentDir}`);
  }

  /* ---- 模块装配（术语栈：隔离执行器直驱——与产品同款提示词/解析/校验/记账） ---- */
  const { createPiRuntime, createPiRuntimeFromConfig } = await import(
    join(ROOT, "packages", "runtime-pi", "src", "index.ts")
  );
  const { EchoSdkPort } = await import(join(ROOT, "apps", "studio", "src", "echo-port.ts"));
  const { TerminologyExecutor, hashSourceText, EXPLAIN_PROMPT_VERSION, EXTRACT_PROMPT_VERSION } = await import(
    join(ROOT, "apps", "studio", "src", "terminology.ts")
  );
  const baselineModule = cli.provider === "baseline" ? await import(join(ROOT, "scripts", "terminology", "baseline.mjs")) : null;

  const dataDir = mkdtempSync(join(tmpdir(), "treeai-term-eval-"));
  const sessionsDir = join(dataDir, "terminology", "sessions");
  const workspace = join(dataDir, "terminology", "workspace");
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(workspace, { recursive: true });

  const explainProvider =
    cli.mode === "echo" && cli.provider === "echo"
      ? { providerId: "echo", modelId: "echo-controlled" }
      : { providerId: cli.provider, modelId: cli.model };
  const extractProvider = { providerId: cli.provider, modelId: cli.model };

  let explainExecutor = null;
  let extractExecutor = null;
  let runtimeForReal = null;
  if (cli.mode === "real") {
    runtimeForReal = createPiRuntime({
      agentDir: resolve(cli.agentDir),
      defaultCwd: workspace,
      credentials: { providerId: cli.provider, apiKey },
      thinkingLevel: "off",
    });
    explainExecutor = new TerminologyExecutor({
      runtime: runtimeForReal,
      model: explainProvider,
      sessionDir: sessionsDir,
      cwd: workspace,
      budgetTokens: 5_000_000,
      cacheEnabled: false,
    });
    extractExecutor = explainExecutor;
  } else if (cli.provider === "echo") {
    /* 解释：产品同款 echo 装配（createPiRuntimeFromConfig + EchoSdkPort——
       测试缺省注入机制）；提取：脚本化 runtime（受控假 provider）。 */
    explainExecutor = new TerminologyExecutor({
      runtime: createPiRuntimeFromConfig({
        port: new EchoSdkPort({ model: explainProvider }),
        defaultCwd: workspace,
        thinkingLevel: "off",
      }),
      model: explainProvider,
      sessionDir: sessionsDir,
      cwd: workspace,
      budgetTokens: 5_000_000,
      cacheEnabled: false,
    });
    const itemsByPassage = new Map();
    extractItems.forEach((item, index) => itemsByPassage.set(item.source, { item, index }));
    extractExecutor = new TerminologyExecutor({
      runtime: scriptedTerminologyRuntime(makeControlledEchoAnswer(itemsByPassage)),
      model: extractProvider,
      sessionDir: sessionsDir,
      cwd: workspace,
      budgetTokens: 5_000_000,
      cacheEnabled: false,
    });
  } else {
    /* baseline：只做提取（解释任务不适用——基线不是解释器，如实记 notApplicable）。 */
    explainExecutor = null;
    extractExecutor = new TerminologyExecutor({
      runtime: scriptedTerminologyRuntime(makeBaselineAnswer(baselineModule.extractCandidates)),
      model: extractProvider,
      sessionDir: sessionsDir,
      cwd: workspace,
      budgetTokens: 5_000_000,
      cacheEnabled: false,
    });
  }

  /* ---- 逐条执行 ---- */
  const explainRows = [];
  const extractRows = [];
  let totalRetries = 0;

  for (const item of explainItems) {
    if (explainExecutor === null) {
      explainRows.push({
        id: item.id, kind: "explain", status: "notApplicable", latencyMs: null, attempts: 0, retries: 0,
        usage: null, tokens: { realUsage: "UNKNOWN", estimatedCharsOver4: 0 },
        sourceMatch: null, explanation: null, failure: null,
        notApplicableReason: "baseline provider does not explain (extraction-only reference)",
      });
      continue;
    }
    const span = integrity.spans.get(item.id);
    const input = {
      treeId: null,
      sourceId: item.id,
      mode: item.mode,
      selection: { start: span.start, end: span.end, text: item.term },
      sourceText: item.source,
      sourceHash: hashSourceText(item.source),
    };
    const started = Date.now();
    let task = await explainExecutor.explain(input);
    let attempts = 1;
    while (task.state.kind === "failed" && attempts <= cli.retries) {
      task = await explainExecutor.explain(input);
      attempts += 1;
    }
    const retriesUsed = attempts - 1;
    totalRetries += retriesUsed;
    const latencyMs = Date.now() - started;
    const state = task.state;
    const sourceMatch =
      task.selection !== null &&
      task.selection.start === span.start &&
      task.selection.end === span.end &&
      task.selection.text === item.term;
    if (state.kind === "succeeded") {
      explainRows.push({
        id: item.id, kind: "explain", status: "succeeded", latencyMs, attempts, retries: retriesUsed,
        usage: state.usage, tokens: { realUsage: "UNKNOWN", estimatedCharsOver4: Math.ceil(((state.usage.promptChars ?? 0) + (state.usage.completionChars ?? 0)) / 4) },
        cached: state.cached, sourceMatch, explanation: state.explanation, failure: null,
      });
    } else {
      explainRows.push({
        id: item.id, kind: "explain",
        status: state.kind === "failed" ? "failed" : state.kind,
        latencyMs, attempts, retries: retriesUsed, usage: null,
        tokens: { realUsage: "UNKNOWN", estimatedCharsOver4: 0 },
        sourceMatch, explanation: null,
        failure: state.kind === "failed" ? `${state.code}: ${state.message}` : String(state.kind),
      });
    }
  }

  for (const item of extractItems) {
    const input = { treeId: null, sourceText: item.source, sourceHash: hashSourceText(item.source) };
    const started = Date.now();
    let task = await extractExecutor.extract(input);
    let attempts = 1;
    while (task.state.kind === "failed" && attempts <= cli.retries) {
      task = await extractExecutor.extract(input);
      attempts += 1;
    }
    const retriesUsed = attempts - 1;
    totalRetries += retriesUsed;
    const latencyMs = Date.now() - started;
    const state = task.state;
    if (state.kind === "succeeded") {
      extractRows.push({
        id: item.id, kind: "extract", status: "succeeded", latencyMs, attempts, retries: retriesUsed,
        usage: state.usage, tokens: { realUsage: "UNKNOWN", estimatedCharsOver4: Math.ceil(((state.usage.promptChars ?? 0) + (state.usage.completionChars ?? 0)) / 4) },
        expectedTerms: item.expectedTerms ?? [], negativeTerms: item.negativeTerms ?? [],
        candidates: state.candidates.map((c) => ({ term: c.term, start: c.start, end: c.end })), failure: null,
      });
    } else {
      extractRows.push({
        id: item.id, kind: "extract",
        status: state.kind === "failed" ? "failed" : state.kind,
        latencyMs, attempts, retries: retriesUsed, usage: null,
        tokens: { realUsage: "UNKNOWN", estimatedCharsOver4: 0 },
        expectedTerms: item.expectedTerms ?? [], negativeTerms: item.negativeTerms ?? [],
        candidates: [], failure: state.kind === "failed" ? `${state.code}: ${state.message}` : String(state.kind),
      });
    }
  }

  await explainExecutor?.dispose();
  if (extractExecutor !== null && extractExecutor !== explainExecutor) await extractExecutor.dispose();
  await runtimeForReal?.dispose();
  rmSync(dataDir, { recursive: true, force: true });

  /* ---- 指标 + 门禁 ---- */
  const explainMetrics = computeExplainMetrics(explainRows);
  const extractMetrics = computeExtractMetrics(extractRows);
  const explainClean = explainRows.filter((r) => r.status === "succeeded" || r.status === "notApplicable").length;
  const extractClean = extractRows.filter((r) => r.status === "succeeded").length;
  const explainNotApplicable = explainRows.filter((r) => r.status === "notApplicable").length;
  const pipelineIntegrity = {
    ok: explainClean === explainRows.length && extractClean === extractRows.length,
    detail:
      `explain: ${String(explainClean)}/${String(explainRows.length)} clean terminal states ` +
      `(${String(explainNotApplicable)} not applicable, ${String(explainRows.length - explainClean)} unexpected); ` +
      `extract: ${String(extractClean)}/${String(extractRows.length)} clean terminal states ` +
      `(${String(extractRows.length - extractClean)} unexpected) — mode ${cli.mode}, provider ${cli.provider}`,
  };
  if (explainMetrics.ran === 0) explainMetrics.notApplicableReason = "provider does not explain (baseline)";
  if (extractMetrics.ran === 0) extractMetrics.notApplicableReason = "no extract items in this run";
  const gates = evaluateGates({ mode: cli.mode, provider: cli.provider, explain: explainMetrics, extract: extractMetrics, pipelineIntegrity });

  /* ---- 证据写出（追加式，绝不覆盖） ---- */
  const runId = `term-eval-${utcRunId()}-${cli.set}-${cli.mode}-${cli.provider}`;
  const runDir = join(cli.evidenceRoot, runId);
  if (existsSync(runDir)) {
    console.error(`term-eval: evidence directory already exists (never overwritten): ${runDir}`);
    process.exit(1);
  }
  mkdirSync(runDir, { recursive: true });

  const finishedAt = new Date().toISOString();
  const report = {
    runId,
    runnerVersion: RUNNER_VERSION,
    mode: cli.mode,
    set: cli.set,
    provider: cli.provider,
    model: `${cli.provider}/${cli.model}`,
    observe,
    git: { sha, dirty: gitDirty, branch: branchName },
    node: process.version,
    startedAt,
    finishedAt,
    setHash,
    configHash: sha256Hex(
      JSON.stringify({
        runnerVersion: RUNNER_VERSION, mode: cli.mode, provider: cli.provider, model: cli.model,
        promptVersions: { explain: EXPLAIN_PROMPT_VERSION, extract: EXTRACT_PROMPT_VERSION },
        cacheEnabled: false, retries: cli.retries,
      }),
    ),
    promptVersions: { explain: EXPLAIN_PROMPT_VERSION, extract: EXTRACT_PROMPT_VERSION },
    options: {
      limit: cli.limit, retries: cli.retries, cacheEnabled: false, budgetTokens: 5_000_000,
      allowObserve: cli.allowObserve,
    },
    executed: true,
    itemsRan: { explain: explainRows.length, extract: extractRows.length, limited: cli.limit !== null },
    metrics: {
      explain: explainMetrics,
      extract: extractMetrics,
      totalRetries,
      pending: {
        usefulness: { gate: ">=90%", status: "PENDING", sheet: "annotation-sheet.csv" },
        keyObstacleCoverage: { gate: ">=80%", status: "PENDING", sheet: "annotation-sheet.csv" },
      },
    },
    usage: { explain: explainMetrics.usage, extract: extractMetrics.usage },
    gates,
    checks,
    selftest: selftestChecks,
    explainRows,
    extractRows,
    note:
      cli.mode === "echo"
        ? cli.provider === "echo"
          ? "echo mode with the controlled fake provider — pipeline validation only (assembly, metric math, mechanical validation, report + annotation sheet); NEVER model-quality evidence"
          : "echo mode with the zero-dependency baseline — offline reference floor for the baseline/strong-model comparison; quality gates are reported, not binding"
        : observe
          ? "observation-only re-run of an already-locked frozen verdict (the first verdict is never overwritten)"
          : "real-model run; mechanical gates binding; usefulness/coverage gates stay PENDING until two-person annotation",
  };

  const rowsById = new Map();
  for (const row of [...explainRows, ...extractRows]) rowsById.set(row.id, row);
  const annotationCsv = buildAnnotationSheetCsv(cli.set, items, rowsById);
  const reportJson = JSON.stringify(report, null, 2);

  /* 密钥扫描：凭据值绝不进任何落盘文件（命中 → 删除目录 + exit 1）。 */
  if (containsSecret(reportJson, apiKey) || containsSecret(annotationCsv, apiKey)) {
    rmSync(runDir, { recursive: true, force: true });
    console.error("term-eval: secret scan FAILED — the credential value appeared in the report; evidence directory removed");
    process.exit(1);
  }

  writeFileSync(join(runDir, "run.json"), reportJson + "\n", "utf8");
  writeFileSync(join(runDir, "summary.md"), buildSummaryMd(report), "utf8");
  writeFileSync(join(runDir, "annotation-sheet.csv"), annotationCsv, "utf8");
  report.evidenceDir = runDir;

  /* ---- 摘要与退出码 ---- */
  const pass = gates.concat(checks).filter((g) => g.status === "PASS").length;
  const fail = gates.concat(checks).filter((g) => g.status === "FAIL").length;
  /* 只有绑定门禁的 FAIL 翻转退出码（baseline 的 reported-only 门禁失败是
     诚实基线结果，不是 runner 缺陷——如实报告、不阻断）。 */
  const bindingFail =
    gates.filter((g) => g.status === "FAIL" && g.binding).length +
    checks.filter((c) => c.status === "FAIL").length;
  const pending = gates.filter((g) => g.status === "PENDING").length;
  const notRun = gates.concat(checks).filter((g) => g.status === "NOT_RUN" || g.status === "BLOCKED").length;
  console.log("");
  for (const gate of gates) {
    console.log(`  [${gate.status}] ${gate.name}${gate.binding ? "" : " (reported-only)"} — ${gate.detail}`);
  }
  for (const check of checks) {
    if (check.status !== "PASS") console.log(`  [${check.status}] ${check.name} — ${check.detail}`);
  }
  console.log("");
  console.log(
    `term-eval: ${String(pass)} PASS / ${String(fail)} FAIL (${String(bindingFail)} binding) / ` +
      `${String(pending)} PENDING / ${String(notRun)} NOT_RUN (set ${cli.set}, mode ${cli.mode}, provider ${cli.provider})`,
  );
  console.log(`  evidence: ${runDir}`);
  console.log(`  annotation sheet (two-person): ${join(runDir, "annotation-sheet.csv")}`);
  console.log(`  note: ${report.note}`);
  if (bindingFail > 0) process.exit(2);
  /* real 模式：PENDING（人工标注）/NOT_RUN 门禁未清 → 3（对齐 verify-d4 约定）。 */
  if (cli.mode === "real" && (pending > 0 || notRun > 0)) process.exit(3);
  process.exit(0);
}

await main().catch((err) => {
  console.error(`term-eval: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
