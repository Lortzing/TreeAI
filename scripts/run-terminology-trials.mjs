#!/usr/bin/env node
/**
 * 术语质量试标跑批器（issue #7 C ①：隔离 provider/参数/usage 与 60 条试标；
 * 冻结质量集 = apps/studio/terminology/quality-set.json）。
 *
 * 用法：
 *   node scripts/run-terminology-trials.mjs [--mode selftest|real-pi]
 *     [--provider ID] [--model ID] [--agent-dir DIR] [--limit N] [--out FILE]
 *
 * 模式：
 *   - selftest（离线，缺省）：术语执行器跑在 echo 驱动上——验证**跑批器
 *     机械面**（质量集完整性：每条 span 按词序数机械解析、切片全等；
 *     explain 任务链路）。echo 不是模型——selftest 结果绝不是质量证据
 *     （evidence/d3/README.md 规则 5 同款纪律）。
 *   - real-pi：凭据仅经 TREEAI_STUDIO_API_KEY 环境注入（值绝不进日志/
 *     报告）；术语执行器用真实 provider/model（--provider/--model，缺省
 *     deepseek/deepseek-flash），agent 目录受控（--agent-dir，缺省仓库内
 *     .pi-d2-live）。缺失凭据 → BLOCKED，exit 3。
 *
 * 试标口径（issue #7 C 冻结质量目标；报告逐项给出分子/分母）：
 *   - 来源匹配：机械（span 按词序数解析 + 切片全等，构造性 100%——
 *     每条试标前后断言）；
 *   - 覆盖（extract 关键理解障碍 ≥80% 的机械代理）：expectedTerms 命中率；
 *   - 负例误标（≤10%）：候选 ∩ negativeTerms / 全部候选；
 *   - 有用率（≥90%）：**人工标注**——跑批器输出标注工作表（逐条解释 +
 *     空白标注列），未标注前如实呈 PENDING，绝不自行声称通过；
 *   - 空输出 / 漏触发 / 延迟与费用：逐项记录（延迟毫秒 + requests/
 *     estTokens 诚实口径——chars/4 估算）。
 *
 * 输出：stdout 摘要 + --out JSON 报告（缺省不写文件；报告只含脱敏事实，
 * 绝不含凭据值）。
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const QUALITY_SET_PATH = join(ROOT, "apps", "studio", "terminology", "quality-set.json");
const PI_API_KEY_ENV = "TREEAI_STUDIO_API_KEY";
const DEFAULT_AGENT_DIR = join(ROOT, ".pi-d2-live");

function usage() {
  console.log(
    "usage: node scripts/run-terminology-trials.mjs [--mode selftest|real-pi] " +
      "[--provider ID] [--model ID] [--agent-dir DIR] [--limit N] [--out FILE]",
  );
}

function parseArgs(argv) {
  const raw = { mode: "selftest", provider: "deepseek", model: "deepseek-flash", agentDir: DEFAULT_AGENT_DIR, limit: null, out: null };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === undefined || value === undefined) {
      usage();
      throw new Error(`bad or missing value for '${String(flag)}'`);
    }
    if (flag === "--mode") raw.mode = value;
    else if (flag === "--provider") raw.provider = value;
    else if (flag === "--model") raw.model = value;
    else if (flag === "--agent-dir") raw.agentDir = value;
    else if (flag === "--limit") raw.limit = Number(value);
    else if (flag === "--out") raw.out = value;
    else {
      usage();
      throw new Error(`unknown flag: ${flag}`);
    }
  }
  if (raw.mode !== "selftest" && raw.mode !== "real-pi") {
    throw new Error(`--mode must be 'selftest' or 'real-pi' (got '${raw.mode}')`);
  }
  if (raw.limit !== null && (!Number.isInteger(raw.limit) || raw.limit <= 0)) {
    throw new Error(`--limit must be a positive integer (got '${String(argv.limit)}')`);
  }
  return raw;
}

/** 冻结质量集加载 + 机械完整性校验（span 按词序数解析，切片全等）。 */
function loadQualitySet(limit) {
  const parsed = JSON.parse(readFileSync(QUALITY_SET_PATH, "utf8"));
  const items = parsed.items;
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("quality set has no items");
  }
  const explain = [];
  const extract = [];
  for (const item of items) {
    if (item.kind === "explain") {
      const span = nthOccurrence(item.source, item.term, item.occurrence ?? 1);
      if (span === null) {
        throw new Error(`set integrity: explain item ${item.id} — term '${item.term}' occurrence ${String(item.occurrence ?? 1)} not found`);
      }
      explain.push({ ...item, span });
    } else if (item.kind === "extract") {
      for (const term of [...item.expectedTerms, ...item.negativeTerms]) {
        if (nthOccurrence(item.source, term, 1) === null) {
          throw new Error(`set integrity: extract item ${item.id} — term '${term}' not found in source`);
        }
      }
      extract.push(item);
    } else {
      throw new Error(`set integrity: unknown kind '${String(item.kind)}' (${item.id})`);
    }
  }
  const selected = limit === null ? { explain, extract } : {
    explain: explain.slice(0, limit),
    extract: extract.slice(0, Math.max(0, limit - explain.length)),
  };
  return { version: parsed.version, frozenAt: parsed.frozenAt, total: items.length, ...selected };
}

/** 词序数定位（1 起）：返回 {start,end}；未找到 → null。重复词消歧的唯一机械口径。 */
function nthOccurrence(text, term, n) {
  let from = 0;
  for (let i = 0; i < n; i += 1) {
    const at = text.indexOf(term, from);
    if (at < 0) return null;
    if (i === n - 1) return { start: at, end: at + term.length };
    from = at + term.length;
  }
  return null;
}

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
  const sha = commit.status === 0 ? commit.stdout.trim() : "unknown";
  const dirty = spawnSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" });

  const set = loadQualitySet(cli.limit);
  const checks = [];
  const push = (name, pass, detail) => checks.push({ name, status: pass ? "PASS" : "FAIL", detail });
  const pushNotRun = (name, detail) => checks.push({ name, status: "NOT_RUN", detail });

  /* ---- 质量集完整性（机械门禁） ---- */
  push(
    "set-integrity",
    true,
    `frozen v${String(set.version)} (${set.frozenAt}): ${String(set.total)} items — ` +
      `${String(set.explain.length)} explain + ${String(set.extract.length)} extract in this run` +
      (cli.limit === null ? "" : ` (limited from ${String(set.total)} by --limit ${String(cli.limit)})`) +
      "; every span resolves by occurrence with slice equality",
  );

  /* ---- 凭据（real-pi 模式） ---- */
  let apiKey = null;
  if (cli.mode === "real-pi") {
    const envValue = process.env[PI_API_KEY_ENV];
    if (typeof envValue !== "string" || envValue.trim() === "") {
      push("credentials", false, `missing ${PI_API_KEY_ENV} (in-memory only; the value is never logged)`);
      summarizeAndExit(checks, cli, set, sha, dirty, /* ran */ false);
      return;
    }
    apiKey = envValue.trim();
    push("credentials", true, `${PI_API_KEY_ENV} present (value never logged)`);
    if (!existsSync(cli.agentDir)) {
      push("agent-dir", false, `agent dir not found: ${cli.agentDir}`);
      summarizeAndExit(checks, cli, set, sha, dirty, false);
      return;
    }
    push("agent-dir", true, `controlled agent dir ${cli.agentDir}`);
  }

  /* ---- 模块装配（术语栈：隔离执行器；主服务仅作推广装配面，试标不用） ---- */
  const { TreeRepository } = await import(join(ROOT, "packages", "persistence", "src", "index.ts"));
  const { createPiRuntime, createPiRuntimeFromConfig } = await import(join(ROOT, "packages", "runtime-pi", "src", "index.ts"));
  const { EchoSdkPort } = await import(join(ROOT, "apps", "studio", "src", "echo-port.ts"));
  const { TreeStudioService } = await import(join(ROOT, "apps", "studio", "src", "service.ts"));
  const { TerminologyExecutor, TerminologyService } = await import(join(ROOT, "apps", "studio", "src", "terminology.ts"));

  const dataDir = mkdtempSync(join(tmpdir(), "treeai-term-trials-"));
  const sessionsDir = join(dataDir, "terminology", "sessions");
  const workspace = join(dataDir, "terminology", "workspace");
  const mainSessions = join(dataDir, "sessions");
  const mainWorkspace = join(dataDir, "workspace");
  for (const d of [sessionsDir, workspace, mainSessions, mainWorkspace]) mkdirSync(d, { recursive: true });

  const model = { providerId: cli.provider, modelId: cli.model };
  const repository = TreeRepository.open({ path: join(dataDir, "treeai.db") });
  const mainRuntime = createPiRuntimeFromConfig({ port: new EchoSdkPort(), defaultCwd: mainWorkspace });
  const service = new TreeStudioService({
    repository,
    runtime: mainRuntime,
    model: { providerId: "studio-provider", modelId: "studio-model" },
    sessionDir: mainSessions,
    cwd: mainWorkspace,
  });
  let terminologyRuntime;
  if (cli.mode === "real-pi") {
    terminologyRuntime = createPiRuntime({
      agentDir: resolve(cli.agentDir),
      defaultCwd: workspace,
      credentials: { providerId: cli.provider, apiKey },
      thinkingLevel: "off",
    });
  } else {
    terminologyRuntime = createPiRuntimeFromConfig({ port: new EchoSdkPort({ model }), defaultCwd: workspace, thinkingLevel: "off" });
  }
  const executor = new TerminologyExecutor({
    runtime: terminologyRuntime,
    model,
    sessionDir: sessionsDir,
    cwd: workspace,
    budgetTokens: 5_000_000,
    cacheEnabled: false,
  });
  const terminology = new TerminologyService({ repository, executor, studio: service });

  const fabricatedSession = () => ({
    sessionId: "trial-session",
    sessionFile: join(sessionsDir, "trial-session.jsonl"),
    entryId: "trial-entry",
    piVersion: "0.85.1",
    availability: { status: "available" },
  });

  const labelingSheet = [];
  const explainRows = [];
  const extractRows = [];
  let expectedTotal = 0;
  let expectedFound = 0;
  let falseMarks = 0;
  let markedTotal = 0;
  let emptyOutputs = 0;

  for (const item of set.explain) {
    /* 铺设锚点答案（仓储层，正文 = 冻结集原文——试标的确定性来源）。 */
    const tree = repository.createTree(repository.createForest().id);
    const trunk = repository.createBranch(tree.id);
    const episode = repository.createEpisode(trunk.id);
    const run = repository.createRun(episode.id, fabricatedSession());
    const answer = repository.createTurn({
      treeId: tree.id,
      branchId: trunk.id,
      episodeId: episode.id,
      runId: run.id,
      role: "assistant",
      text: item.source,
      piEntryId: "trial-answer",
    });
    const started = Date.now();
    const outcome = await terminology.explain({
      treeId: tree.id,
      branchId: trunk.id,
      anchorTurnId: answer.id,
      selection: { start: item.span.start, end: item.span.end, text: item.term },
      mode: "term",
    });
    const latencyMs = Date.now() - started;
    const task = outcome.task;
    const ok = task !== null && task.state.kind === "succeeded" && typeof task.state.explanation === "string" && task.state.explanation.trim().length > 0;
    /* 来源匹配（机械）：任务携带的选区与冻结集 span 全等。 */
    const sourceMatch = task !== null && task.selection !== null &&
      task.selection.start === item.span.start && task.selection.end === item.span.end && task.selection.text === item.term;
    if (!sourceMatch) push(`source-match:${item.id}`, false, "the task's span does not round-trip");
    if (ok) emptyOutputs += 0;
    else emptyOutputs += 1;
    explainRows.push({
      id: item.id,
      expectation: item.expectation,
      ok,
      latencyMs,
      explanation: ok ? task.state.explanation : null,
      failure: task !== null && task.state.kind === "failed" ? `${task.state.code}: ${task.state.message}` : null,
    });
    labelingSheet.push({ id: item.id, kind: "explain", term: item.term, expectation: item.expectation, explanation: ok ? task.state.explanation : "", useful: null });
  }

  for (const item of set.extract) {
    const tree = repository.createTree(repository.createForest().id);
    const trunk = repository.createBranch(tree.id);
    const episode = repository.createEpisode(trunk.id);
    const run = repository.createRun(episode.id, fabricatedSession());
    const answer = repository.createTurn({
      treeId: tree.id,
      branchId: trunk.id,
      episodeId: episode.id,
      runId: run.id,
      role: "assistant",
      text: item.source,
      piEntryId: "trial-answer",
    });
    const started = Date.now();
    const task = await terminology.extract({ treeId: tree.id, branchId: trunk.id, anchorTurnId: answer.id });
    const latencyMs = Date.now() - started;
    if (task.state.kind !== "succeeded") {
      extractRows.push({ id: item.id, ok: false, latencyMs, failure: `${task.state.kind === "failed" ? `${task.state.code}: ${task.state.message}` : task.state.kind}` });
      expectedTotal += item.expectedTerms.length;
      emptyOutputs += 1;
      continue;
    }
    const terms = task.state.candidates.map((c) => c.term);
    const found = item.expectedTerms.filter((t) => terms.includes(t));
    const negativesHit = terms.filter((t) => item.negativeTerms.includes(t));
    expectedTotal += item.expectedTerms.length;
    expectedFound += found.length;
    falseMarks += negativesHit.length;
    markedTotal += terms.length;
    if (terms.length === 0) emptyOutputs += 1;
    extractRows.push({ id: item.id, ok: true, latencyMs, expected: item.expectedTerms, found, negativesHit, candidates: terms });
  }

  await executor.dispose();
  await service.dispose();
  repository.close();
  rmSync(dataDir, { recursive: true, force: true });

  /* ---- 指标（分子/分母 + 不确定性如实） ---- */
  const explainOk = explainRows.filter((r) => r.ok).length;
  const latencies = [...explainRows, ...extractRows].map((r) => r.latencyMs).sort((a, b) => a - b);
  const p = (q) => (latencies.length === 0 ? 0 : latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))]);
  const usage = executor.usage();
  const coverage = expectedTotal === 0 ? null : expectedFound / expectedTotal;
  const falseMarkRate = markedTotal === 0 ? null : falseMarks / markedTotal;

  push(
    "explain-trials",
    true,
    `${String(explainOk)}/${String(explainRows.length)} explain tasks succeeded ` +
      `(empty/failed outputs: ${String(explainRows.length - explainOk)}); latency p50 ${String(p(0.5))}ms / p95 ${String(p(0.95))}ms`,
  );
  if (cli.mode === "selftest") {
    pushNotRun(
      "extract-trials",
      "echo answers are not JSON — extract quality needs --mode real-pi (echo results are never real evidence)",
    );
    pushNotRun("extract-coverage", "needs --mode real-pi");
    pushNotRun("extract-false-marks", "needs --mode real-pi");
  } else {
    push(
      "extract-coverage",
      coverage !== null && coverage >= 0.8,
      coverage === null
        ? "no extract items ran"
        : `coverage (mechanical proxy: expectedTerms found) = ${String(expectedFound)}/${String(expectedTotal)} = ${(coverage * 100).toFixed(1)}% (gate ≥80%)`,
    );
    push(
      "extract-false-marks",
      falseMarkRate !== null && falseMarkRate <= 0.1,
      falseMarkRate === null
        ? "no candidates were marked"
        : `negative false-marking = ${String(falseMarks)}/${String(markedTotal)} = ${(falseMarkRate * 100).toFixed(1)}% (gate ≤10%)`,
    );
  }
  push(
    "cost-accounting",
    true,
    `usage: ${String(usage.total.requests)} request(s), est. ${String(usage.estTokens)} tokens (chars/4 estimate — the Pi seam does not expose token counts), ` +
      `${String(usage.lateResultsDiscarded)} late result(s) discarded, budget ${String(usage.budgetTokens)}`,
  );
  pushNotRun(
    "usefulness-pending-human-labeling",
    "有用率 (≥90%) needs human labels — the labeling sheet is in the report (useful: null); the gate cannot pass mechanically",
  );

  const report = {
    mode: cli.mode,
    model: `${cli.provider}/${cli.model}`,
    sha,
    gitDirty: dirty.status === 0 ? dirty.stdout.trim().length > 0 : null,
    qualitySet: { version: set.version, frozenAt: set.frozenAt, total: set.total, ran: set.explain.length + set.extract.length },
    metrics: {
      explain: { ok: explainOk, total: explainRows.length, emptyOrFailed: explainRows.length - explainOk },
      extract: { expectedFound, expectedTotal, coverage, falseMarks, markedTotal, falseMarkRate, emptyOutputs },
      latencyMs: { p50: p(0.5), p95: p(0.95) },
      usage,
    },
    explainRows,
    extractRows,
    labelingSheet,
    checks,
    note:
      cli.mode === "selftest"
        ? "offline echo selftest — harness mechanics and set integrity only; never real-Pi quality evidence"
        : "real-Pi trial run; usefulness gate pending human labeling of labelingSheet",
  };
  if (cli.out !== null) {
    writeFileSync(cli.out, JSON.stringify(report, null, 2), "utf8");
    console.log(`report written: ${cli.out}`);
  }
  summarizeAndExit(checks, cli, set, sha, dirty, true, report);
}

function summarizeAndExit(checks, cli, set, sha, dirty, ran) {
  const pass = checks.filter((c) => c.status === "PASS").length;
  const fail = checks.filter((c) => c.status === "FAIL").length;
  const notRun = checks.filter((c) => c.status === "NOT_RUN").length;
  console.log("");
  for (const check of checks) {
    console.log(`  [${check.status}] ${check.name} — ${check.detail}`);
  }
  console.log("");
  console.log(`run-terminology-trials: ${String(pass)} PASS / ${String(fail)} FAIL / ${String(notRun)} NOT_RUN (mode ${cli.mode})`);
  console.log(`  note: ${cli.mode === "selftest" ? "echo selftest — never real-Pi evidence" : "real-Pi trial; usefulness gate pending human labels"}`);
  if (ran && cli.out === null) {
    console.log("  (pass --out FILE to write the full report with the labeling sheet)");
  }
  /* d2 verifier 约定：FAIL → 1；无 FAIL 但有 NOT_RUN（授权/人工门）→ 3。 */
  process.exit(fail > 0 ? 1 : notRun > 0 ? 3 : 0);
}

await main().catch((err) => {
  console.error(`run-terminology-trials: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
});
