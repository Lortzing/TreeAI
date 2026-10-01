#!/usr/bin/env node
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

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

function usage() {
  console.log(
    "usage: node scripts/run-terminology-eval.mjs [--set dev|frozen] [--mode echo|real] " +
      "[--provider echo|baseline|ID] [--model ID] [--agent-dir DIR] [--limit N] [--retries N] " +
      "[--evidence-root DIR] [--allow-observe]",
  );
}

function parseArgs(argv) {
  const raw = {
    set: "dev",
    mode: "echo",
    provider: null,
    model: null,
    agentDir: DEFAULT_AGENT_DIR,
    limit: null,
    retries: 0,
    evidenceRoot: DEFAULT_EVIDENCE_ROOT,
    allowObserve: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--allow-observe") {
      raw.allowObserve = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) {
      usage();
      throw new Error(`bad or missing value for '${String(flag)}'`);
    }
    if (flag === "--set") raw.set = value;
    else if (flag === "--mode") raw.mode = value;
    else if (flag === "--provider") raw.provider = value;
    else if (flag === "--model") raw.model = value;
    else if (flag === "--agent-dir") raw.agentDir = value;
    else if (flag === "--limit") raw.limit = Number(value);
    else if (flag === "--retries") raw.retries = Number(value);
    else if (flag === "--evidence-root") raw.evidenceRoot = value;
    else {
      usage();
      throw new Error(`unknown flag: ${flag}`);
    }
    i += 1;
  }
  if (raw.set !== "dev" && raw.set !== "frozen") {
    throw new Error(`--set must be 'dev' or 'frozen' (got '${raw.set}')`);
  }
  if (raw.mode !== "echo" && raw.mode !== "real") {
    throw new Error(`--mode must be 'echo' or 'real' (got '${raw.mode}')`);
  }
  if (raw.provider === "echo" || raw.provider === "baseline") {
    if (raw.mode === "real") {
      throw new Error(`--provider ${raw.provider} is offline-only; --mode real needs a real provider id`);
    }
  }
  if (raw.provider === null) raw.provider = raw.mode === "echo" ? "echo" : "deepseek";
  if (raw.model === null) raw.model = raw.mode === "echo" ? raw.provider : "deepseek-flash";
  if (raw.limit !== null && (!Number.isInteger(raw.limit) || raw.limit <= 0)) {
    throw new Error(`--limit must be a positive integer (got '${String(argv)}')`);
  }
  if (!Number.isInteger(raw.retries) || raw.retries < 0) {
    throw new Error(`--retries must be a non-negative integer`);
  }
  return raw;
}

/* ---------------- 机械工具（与产品/测试同口径） ---------------- */

/** 词序数定位（1 起）：第 n 次出现的 {start,end}；未找到 → null。 */
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

/** URL / 反引号围栏排除带（与 apps/studio/src/terminology.ts 的正则一致）。 */
function excludedSpans(sourceText) {
  const spans = [];
  const url = /https?:\/\/[^\s））》>"']+|www\.[^\s））》>"']+/g;
  for (const match of sourceText.matchAll(url)) {
    if (match.index === undefined) continue;
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  const fence = /`[^`]*`/g;
  for (const match of sourceText.matchAll(fence)) {
    if (match.index === undefined) continue;
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return spans;
}

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function utcRunId() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(".", "");
}

function percentile(sortedValues, q) {
  if (sortedValues.length === 0) return null;
  return sortedValues[Math.min(sortedValues.length - 1, Math.floor(q * sortedValues.length))];
}

/* ---------------- 评测集完整性（与测试文件同口径的运行前门禁） ---------------- */

function loadSet(split) {
  const path = join(ROOT, "apps", "studio", "terminology", `eval-set-${split}.json`);
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.items)) throw new Error(`eval-set-${split}.json has no items array`);
  return { raw, parsed, path };
}

function verifySetIntegrity(devSet, frozenSet) {
  const problems = [];
  const dev = devSet.parsed.items;
  const frozen = frozenSet.parsed.items;
  const all = [...dev, ...frozen];
  if (dev.length !== 180) problems.push(`dev has ${dev.length} items (expected 180)`);
  if (frozen.length !== 180) problems.push(`frozen has ${frozen.length} items (expected 180)`);
  const ids = new Set();
  for (const item of all) {
    if (ids.has(item.id)) problems.push(`duplicate id ${item.id}`);
    ids.add(item.id);
  }
  /* 分组防泄漏：组 id 与来源文本都不得跨集。 */
  const devGroups = new Set(dev.map((i) => i.group));
  const frozenGroups = new Set(frozen.map((i) => i.group));
  for (const group of devGroups) {
    if (frozenGroups.has(group)) problems.push(`group ${group} straddles dev and frozen`);
  }
  const devSources = new Set(dev.map((i) => i.source));
  for (const item of frozen) {
    if (devSources.has(item.source)) problems.push(`source text of ${item.id} also appears in dev`);
  }
  /* 中文 ≥240（跨 360）。 */
  const zhCount = all.filter((i) => i.lang === "zh").length;
  if (zhCount < 240) problems.push(`zh items ${zhCount} < 240 across 360`);
  /* 负例 ≥25%（跨 360）：全负例提取条目 + 解释非术语条目。 */
  const negatives = all.filter(
    (i) => (i.kind === "extract" && (i.expectedTerms ?? []).length === 0) ||
      (i.kind === "explain" && i.expectation === "not-a-term"),
  ).length;
  if (negatives / all.length < 0.25) {
    problems.push(`negatives ${negatives}/${all.length} = ${(negatives / all.length * 100).toFixed(1)}% < 25%`);
  }
  /* 六类覆盖（两文件各自齐备）。 */
  for (const [name, items] of [["dev", dev], ["frozen", frozen]]) {
    const categories = new Set(items.map((i) => i.category));
    for (const category of SIX_CATEGORIES) {
      if (!categories.has(category)) problems.push(`${name} misses category ${category}`);
    }
  }
  /* 逐条机械可解析性（解释词序数切片全等；提取词表在原文且不入排除带）。 */
  const spans = new Map();
  for (const item of all) {
    if (item.kind === "explain") {
      const span = nthOccurrence(item.source, item.term, item.occurrence ?? 1);
      if (span === null) {
        problems.push(`${item.id}: term '${item.term}' occurrence ${String(item.occurrence ?? 1)} not found`);
      } else if (item.source.slice(span.start, span.end) !== item.term) {
        problems.push(`${item.id}: slice mismatch at occurrence`);
      } else {
        spans.set(item.id, span);
      }
    } else if (item.kind === "extract") {
      const expected = item.expectedTerms ?? [];
      const negative = item.negativeTerms ?? [];
      if (expected.length === 0 && negative.length === 0) {
        problems.push(`${item.id}: full negative without negativeTerms`);
      }
      const excluded = excludedSpans(item.source);
      for (const term of [...expected, ...negative]) {
        if (!item.source.includes(term)) problems.push(`${item.id}: term '${term}' not in source`);
      }
      for (const term of expected) {
        const at = item.source.indexOf(term);
        if (at >= 0 && excluded.some((span) => at < span.end && span.start < at + term.length)) {
          problems.push(`${item.id}: expectedTerm '${term}' inside code/URL span`);
        }
      }
    } else {
      problems.push(`${item.id}: unknown kind '${String(item.kind)}'`);
    }
  }
  return { problems, spans, zhCount, negatives };
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
    advisoryP95TargetMs: ADVISORY_EXPLAIN_P95_MS,
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
    advisoryP95TargetMs: ADVISORY_EXTRACT_P95_MS,
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
    const pass = rate !== null && rate <= GATE_NEGATIVE_MISLABEL_MAX;
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
      `有用率 (≥${GATE_USEFULNESS_MIN * 100}%) needs two-person annotation of annotation-sheet.csv ` +
      "(rater1/rater2 + arbitration); never asserted mechanically",
  });
  gates.push({
    name: "key-obstacle-coverage",
    binding: false,
    status: "PENDING",
    detail:
      `关键理解障碍覆盖率 (≥${GATE_OBSTACLE_COVERAGE_MIN * 100}%) needs two-person annotation ` +
      "(key_obstacle columns + arbitrated useful explanations); never asserted mechanically",
  });
  return gates;
}

/** frozen 一次性锁判定（纯函数）：已有同 setHash 的已执行 real 冻结裁决即锁定。 */
function isFrozenVerdictLocked(existingRuns, setHash) {
  for (const run of existingRuns) {
    if (
      run.mode === "real" &&
      run.set === "frozen" &&
      run.executed === true &&
      run.observe !== true &&
      run.setHash === setHash
    ) {
      return run;
    }
  }
  return null;
}

/** 密钥扫描（纯函数）：报告文本中出现凭据值 → true。 */
function containsSecret(text, secret) {
  return typeof secret === "string" && secret.length > 0 && text.includes(secret);
}

/* ---------------- 受控假 provider（echo 模式提取任务；测试同款注入机制） ---------------- */

/**
 * 脚本化术语 runtime（与 apps/studio/tests/terminology.test.ts 的
 * scriptedTerminologyRuntime 同形）：createSession 恒成功，prompt 按
 * answerFor 脚本回答。零真实调用。
 */
function scriptedTerminologyRuntime(answerFor) {
  const reference = () => ({
    sessionId: "term-eval-scripted",
    sessionFile: "/nonexistent/term-eval-scripted.jsonl",
    entryId: "entry-scripted",
    piVersion: "0.85.1",
    availability: { status: "available" },
  });
  const delay = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
  return {
    get piVersion() {
      return "0.85.1";
    },
    createSession() {
      return Promise.resolve({ reference: reference() });
    },
    restoreSession() {
      return Promise.resolve({ reference: reference() });
    },
    async prompt(input) {
      await delay(1);
      return { message: answerFor(input.text), reference: reference() };
    },
    steer() {
      return Promise.resolve();
    },
    abort() {
      return Promise.resolve();
    },
    navigateTree() {
      return Promise.resolve(reference());
    },
    subscribe() {
      return () => undefined;
    },
    dispose() {
      return Promise.resolve();
    },
  };
}

const EXTRACT_PROMPT_MARKER = "Reply with ONLY a JSON array";
const PASSAGE_MARKER = "[Passage]\n";

/**
 * 受控假 provider 的提取回答（确定性瑕疵注入——验证指标计算与机械校验能
 * 处理非完美输出；绝不是模型质量证据）：
 * - 候选 = expectedTerms 的机械首现解析（不读取任何存储偏移）；
 * - index%7===3 漏标末词（recall <1）；
 * - index%20===5 命中一个 negativeTerm（mislabel >0 但远低于门禁）；
 * - index%11===2 注入偏移错位条目（validateCandidates 应剔除）；
 * - index%5===1 前后噪声（parseCandidates 容忍）。
 */
function makeControlledEchoAnswer(itemsByPassage) {
  return (promptText) => {
    if (!promptText.includes(EXTRACT_PROMPT_MARKER)) {
      return `echo:[${promptText}]`;
    }
    const at = promptText.indexOf(PASSAGE_MARKER);
    const passage = at >= 0 ? promptText.slice(at + PASSAGE_MARKER.length) : "";
    const entry = itemsByPassage.get(passage);
    if (entry === undefined) {
      return "[]";
    }
    const { item, index } = entry;
    const entries = [];
    for (const term of item.expectedTerms ?? []) {
      const at2 = passage.indexOf(term);
      if (at2 >= 0) entries.push({ term, start: at2, end: at2 + term.length });
    }
    if (index % 7 === 3 && entries.length > 1) entries.pop();
    if (index % 20 === 5 && (item.negativeTerms ?? []).length > 0) {
      const term = item.negativeTerms[0];
      const at2 = passage.indexOf(term);
      if (at2 >= 0) entries.push({ term, start: at2, end: at2 + term.length });
    }
    if (index % 11 === 2) entries.push({ term: "echo-misaligned", start: 0, end: 3 });
    const json = JSON.stringify(entries);
    return index % 5 === 1 ? `Sure! ${json} hope that helps` : json;
  };
}

/** baseline provider 的提取回答：对提示词内嵌原文跑零依赖基线（离线确定性）。 */
function makeBaselineAnswer(extractCandidatesFn) {
  return (promptText) => {
    if (!promptText.includes(EXTRACT_PROMPT_MARKER)) {
      return `echo:[${promptText}]`;
    }
    const at = promptText.indexOf(PASSAGE_MARKER);
    const passage = at >= 0 ? promptText.slice(at + PASSAGE_MARKER.length) : "";
    const candidates = extractCandidatesFn(passage).map((c) => ({ term: c.term, start: c.start, end: c.end }));
    return JSON.stringify(candidates);
  };
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
  lines.push(`- runner v${String(RUNNER_VERSION)}; prompt versions explain v${String(report.promptVersions.explain)} / extract v${String(report.promptVersions.extract)}`);
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
      `latency p50 ${explain.latencyMs.p50 ?? "n/a"}ms / p95 ${explain.latencyMs.p95 ?? "n/a"}ms (advisory ≤${String(ADVISORY_EXPLAIN_P95_MS)}ms) / max ${explain.latencyMs.max ?? "n/a"}ms`,
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
      `latency p50 ${extract.latencyMs.p50 ?? "n/a"}ms / p95 ${extract.latencyMs.p95 ?? "n/a"}ms (advisory ≤${String(ADVISORY_EXTRACT_P95_MS)}ms)`,
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
    `- 有用率 (≥${GATE_USEFULNESS_MIN * 100}%): PENDING — two-person annotation of \`annotation-sheet.csv\` (rater1/rater2 + arbitrated).`,
  );
  lines.push(
    `- 关键理解障碍覆盖率 (≥${GATE_OBSTACLE_COVERAGE_MIN * 100}%): PENDING — key_obstacle columns + arbitrated useful explanations.`,
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

/* ---------------- echo 模式自检（合成输入验证指标/门禁/基线/扫描） ---------------- */

async function runEchoSelfcheck(baselineModule) {
  const checks = [];
  const push = (name, ok, detail) => checks.push({ name, status: ok ? "PASS" : "FAIL", detail });

  /* 指标数学：合成提取行（与真实行同形：candidates 为 {term,start,end} 对象）。 */
  const syntheticExtractRows = [
    {
      status: "succeeded", latencyMs: 10, usage: { requests: 1, promptChars: 100, completionChars: 40 },
      expectedTerms: ["甲", "乙", "丙"], negativeTerms: ["丁", "戊"],
      candidates: [
        { term: "甲", start: 0, end: 1 },
        { term: "丁", start: 5, end: 6 },
        { term: "未列词", start: 9, end: 12 },
      ],
    },
    {
      status: "succeeded", latencyMs: 20, usage: { requests: 1, promptChars: 80, completionChars: 30 },
      expectedTerms: ["己"], negativeTerms: ["庚"], candidates: [{ term: "庚", start: 0, end: 1 }],
    },
  ];
  const extractMetrics = computeExtractMetrics(syntheticExtractRows);
  push(
    "selftest:extract-metrics",
    extractMetrics.expectedFound === 1 &&
      extractMetrics.expectedTotal === 4 &&
      extractMetrics.recall === 0.25 &&
      extractMetrics.precision === 0.25 &&
      extractMetrics.negativeTermsHit === 2 &&
      extractMetrics.negativeTermsTotal === 3 &&
      Math.abs(extractMetrics.mislabelRate - 2 / 3) < 1e-12 &&
      extractMetrics.extraTerms === 1 &&
      extractMetrics.fullNegativeItemsWithMarks === 0,
    `recall 1/4, precision 1/4, mislabel 2/3, extras 1 (got ${String(extractMetrics.expectedFound)}/${String(extractMetrics.expectedTotal)}, ` +
      `${String(extractMetrics.expectedFound)}/${String(extractMetrics.markedTotal)}, ${String(extractMetrics.negativeTermsHit)}/${String(extractMetrics.negativeTermsTotal)}, ${String(extractMetrics.extraTerms)})`,
  );

  /* 指标数学：合成解释行（一条来源匹配失败 → 门禁应 FAIL）。 */
  const syntheticExplainRows = [
    { status: "succeeded", latencyMs: 5, usage: { requests: 1, promptChars: 50, completionChars: 20 }, sourceMatch: true, explanation: "ok" },
    { status: "succeeded", latencyMs: 15, usage: { requests: 1, promptChars: 60, completionChars: 20 }, sourceMatch: false, explanation: "ok" },
  ];
  const explainMetrics = computeExplainMetrics(syntheticExplainRows);
  push(
    "selftest:explain-metrics",
    explainMetrics.sourceMatchOk === 1 && explainMetrics.ran === 2 && explainMetrics.sourceMatchRate === 0.5,
    `source match 1/2 = 50% (gate must FAIL below 100%)`,
  );
  const syntheticGates = evaluateGates({
    mode: "real",
    provider: "x",
    explain: explainMetrics,
    extract: extractMetrics,
    pipelineIntegrity: { ok: true, detail: "synthetic" },
  });
  const sourceMatchGate = syntheticGates.find((g) => g.name === "explain-source-match");
  const mislabelGate = syntheticGates.find((g) => g.name === "extract-negative-mislabel");
  push(
    "selftest:gate-flip",
    sourceMatchGate.status === "FAIL" && mislabelGate.status === "FAIL" && sourceMatchGate.binding && mislabelGate.binding,
    "binding quality gates flip to FAIL on synthetic violations (50% source match; 66.7% mislabel)",
  );
  const baselineGates = evaluateGates({
    mode: "echo",
    provider: "baseline",
    explain: explainMetrics,
    extract: extractMetrics,
    pipelineIntegrity: { ok: true, detail: "synthetic" },
  });
  push(
    "selftest:baseline-nonbinding",
    baselineGates.find((g) => g.name === "explain-source-match").binding === false,
    "baseline provider quality gates are reported-only (weak baseline is expected, not a runner defect)",
  );

  /* 词序数定位。 */
  const nth = nthOccurrence("bank is a river bank; bank again", "bank", 3);
  push(
    "selftest:nth-occurrence",
    nth !== null && nth.start === 22 && "bank is a river bank; bank again".slice(nth.start, nth.end) === "bank",
    `3rd occurrence resolves at ${String(nth?.start)} with slice equality`,
  );

  /* frozen 锁判定。 */
  const locked = isFrozenVerdictLocked(
    [
      { mode: "echo", set: "frozen", executed: true, setHash: "h1" },
      { mode: "real", set: "frozen", executed: true, observe: true, setHash: "h1" },
      { mode: "real", set: "dev", executed: true, setHash: "h1" },
    ],
    "h1",
  );
  push(
    "selftest:frozen-lock",
    locked === null,
    "echo runs, observe-only real runs and dev runs never lock the frozen verdict",
  );
  const locked2 = isFrozenVerdictLocked([{ mode: "real", set: "frozen", executed: true, setHash: "h1" }], "h1");
  push("selftest:frozen-lock-2", locked2 !== null, "an executed real frozen run with matching set hash locks the verdict");

  /* 密钥扫描。 */
  push(
    "selftest:secret-scan",
    containsSecret(JSON.stringify({ a: "prefix-SECRET-VALUE suffix" }), "SECRET-VALUE") &&
      !containsSecret(JSON.stringify({ a: "clean" }), "SECRET-VALUE"),
    "secret values are detected in serialized reports",
  );

  /* 基线：确定性 + 自检。 */
  if (baselineModule !== null) {
    const baselineChecks = baselineModule.baselineSelfcheck();
    for (const check of baselineChecks) {
      push(`baseline:${check.name}`, check.pass, check.detail);
    }
    const sample =
      "免疫保护有个人差异：有人演习后兵力旺盛。当接种的人足够多，病毒在人与人之间传递的链条被打断，" +
      "不能接种的人也间接得到了保护。这个现象叫群体免疫。群体免疫是疫苗给社会的红利。";
    const once = JSON.stringify(baselineModule.extractCandidates(sample));
    const again = JSON.stringify(baselineModule.extractCandidates(sample));
    push("baseline:determinism-set-item", once === again, "same set-style input twice -> byte-equal output");
  }
  return checks;
}

/* ---------------- 主流程 ---------------- */

async function main() {
  const cli = parseArgs(process.argv.slice(2));
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
    runnerVersion: RUNNER_VERSION,
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

await main().catch((err) => {
  console.error(`term-eval: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
