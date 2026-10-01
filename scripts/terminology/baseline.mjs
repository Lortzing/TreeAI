#!/usr/bin/env node
/**
 * 术语提取零依赖基线（issue #7 §4：冻结评测「基线/强模型对照」的基线侧）。
 *
 * 纯 Node（无新依赖）、确定性（同输入同输出——无随机、无时钟、稳定排序、
 * 固定迭代次数）。算法面（诚实声明：这是弱基线，不是质量目标）：
 *
 *   1. 分句 → 候选生成：
 *      - 中文：Han 连续段（标点/空白切开）上滑 2..6 字 n-gram；
 *      - 英文：词 token（停用词/纯数字/全小写短词滤除）＋相邻非停用词对
 *        （二元短语，如 spacing effect）；
 *   2. 剪枝：
 *      - 内部虚字 ≥3 的 n-gram 直接弃（的了吗呢…密集必为垃圾）；
 *      - 同频最长扩张（仅 tf≥2：重复 ≥2 次的串边界才稳定；tf=1 不扩张，
 *        否则单例真术语会被同频毛刺超串吞掉）；
 *      - 边粘合修剪：首/尾二字子串比候选多出现 ≥2 次 → 边界毛刺，弃；
 *   3. TF-IDF（句级文档频率）× 长度因子 × 虚字惩罚 × 边界整齐度：
 *      - 边界整齐度 = 全部出现处左右邻字为「词边界」（标点/空白/虚字/
 *        非表意文字）的比例——把词中间切开的碎片（如「准确率骗过去」的
 *        左邻是「体」）被压低；
 *   4. TextRank：候选为节点，同句共现为边（权重 = 共现句数），幂迭代
 *      PageRank（d=0.85，30 轮，初值 1，节点序固定）；
 *   5. 综合分 = 0.65·minmax(tfidf) + 0.35·minmax(textrank)，稳定排序
 *      （分数降序、词升序、首现升序），取前 K（默认 8，对齐产品
 *      MAX_EXTRACT_TERMS）；
 *   6. 机械纪律（与产品 validateCandidates 同口径）：首现偏移切片全等、
 *      去重、代码/URL 排除带、密度上限、子串包含去冗（更短候选的首现
 *      落在已选候选区间内 → 弃）。
 *
 * 已知局限（如实记录）：无词典的中文字词边界不可完全恢复，单例术语与
 * 边界整齐的非术语短语在文档内信号不足时会竞争失败；混合语种短语
 * （如「F1 分数」）不生成。基线的职责是提供可复现的下限，不是质量目标。
 *
 * 用法（跑批经 scripts/run-terminology-eval.mjs --provider baseline）：
 *   node scripts/terminology/baseline.mjs --selftest
 *   node scripts/terminology/baseline.mjs --text "……"
 *   node scripts/terminology/baseline.mjs --text-file path/to/file
 */

import { readFileSync } from "node:fs";

/* ---------------- 常量（固定：确定性的一部分） ---------------- */

const DEFAULT_MAX_TERMS = 8;
const ZH_NGRAM_MIN = 2;
const ZH_NGRAM_MAX = 6;
const TEXTRANK_DAMPING = 0.85;
const TEXTRANK_ITERATIONS = 30;
const SCORE_TFIDF_WEIGHT = 0.65;
/** 边粘合判定：边缘子串比超串多出现 ≥2 次 → 超串是边界毛刺。 */
const EDGE_GLUE_MARGIN = 2;
/** 虚字惩罚因子（几何衰减：k 个虚字 → FACTOR^k）。 */
const ZH_FUNCTION_PENALTY = 0.5;
/** 边界整齐度因子：coherence ∈ [0,1] → 分数乘 (MIN + (1-MIN)·coherence)。 */
const COHERENCE_FLOOR = 0.3;
/** 长度因子斜率（每多一字 ×(1+SLOPE)，弱加成——长度不是术语性的强证据）。 */
const LENGTH_SLOPE = 0.06;

/**
 * 中文虚字表（惩罚而非硬过滤——只收录在真术语里罕见、在边界毛刺里密集
 * 的虚词/助词；刻意排除「上下中里一」等常进真术语的字）。每字 ×0.5 几何
 * 衰减；≥3 个虚字的 n-gram 直接弃。
 */
const ZH_FUNCTION_CHARS = new Set(
  "了是在我你他她它吧吗呢啊呀嘛么着被把跟很太都就还也又再这那为个和与或但而且如果虽每别只当时地得会能要想看着说用做成为从对其已曾经正将",
);
/** 英文停用词（小写匹配）。 */
const EN_STOPWORDS = new Set(
  ("the a an of to in and or is are was were be been being for on with as at by this that these those it its " +
    "from not but have has had do does did will would can could should may might must shall we you they he she " +
    "i me my your their our us them him her who whom which what when where why how all any both each few more " +
    "most other some such no nor only own same so than too very just also then once here there when while " +
    "about into over after before between during without within upon per via etc").split(" "),
);

/* ---------------- 分句与 token ---------------- */

/** 分句（中英标点；空段丢弃）。确定性：纯扫描。 */
function splitSegments(text) {
  const parts = text.split(/(?<=[.。!！?？;；\n])/);
  const segments = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.length > 0) segments.push(trimmed);
  }
  if (segments.length === 0 && text.trim().length > 0) segments.push(text.trim());
  return segments;
}

const CJK_RUN = /\p{Script=Han}+/gu;
const EN_WORD = /[A-Za-z][A-Za-z0-9'&+#.\-]*/g;

function isEnWordFiltered(word) {
  const lower = word.toLowerCase();
  if (EN_STOPWORDS.has(lower)) return true;
  if (/^\d+$/.test(word)) return true;
  /* 全小写短词（≤3 字符）几乎不是术语；含大写/数字/连字符的（RLHF、Node.js、F1）保留。 */
  if (word.length <= 3 && word === lower && !/[0-9\-]/.test(word)) return true;
  return false;
}

/** 单句英文词序列（保序、滤除后）。 */
function segmentEnWords(segment) {
  const words = [];
  for (const match of segment.matchAll(EN_WORD)) {
    const word = match[0];
    if (word.length >= 2 && !isEnWordFiltered(word)) words.push(word);
  }
  return words;
}

/* ---------------- 候选生成 ---------------- */

function countZhFunctionChars(gram) {
  let count = 0;
  for (const ch of gram) {
    if (ZH_FUNCTION_CHARS.has(ch)) count += 1;
  }
  return count;
}

/**
 * 边界整齐度：候选全部出现处，左右邻字为「词边界」的比例。词边界 = 标点/
 * 空白/虚字/非表意文字；邻字是非虚字的表意文字（或英文字母）视为把词切
 * 在了中间（毛刺）。0 次出现记 1。
 */
function boundaryCoherence(sourceText, term) {
  let edges = 0;
  let clean = 0;
  let from = 0;
  for (;;) {
    const at = sourceText.indexOf(term, from);
    if (at < 0) break;
    for (const ch of [at > 0 ? sourceText[at - 1] : "", sourceText[at + term.length] ?? ""]) {
      edges += 1;
      if (!isGlueChar(ch)) clean += 1;
    }
    from = at + term.length;
  }
  return edges === 0 ? 1 : clean / edges;
}

/** 邻字是否「把词粘在中间」：非虚字表意文字或 ASCII 字母。 */
function isGlueChar(ch) {
  if (ch === "" || ch === undefined) return false;
  const code = ch.codePointAt(0);
  if (code >= 0x41 && code <= 0x7a) return true; /* ASCII 字母 */
  if (/\p{Script=Han}/u.test(ch)) return !ZH_FUNCTION_CHARS.has(ch);
  return false;
}

/**
 * 候选登记。zh：run 的 2..6 字 n-gram；en：词 + 相邻词对（二元短语）。
 * tf = 全文真实出现次数；df = 含该候选的句数；首现偏移 + 边界整齐度一并登记。
 */
function buildCandidates(sourceText, segments) {
  /** term -> entry */
  const candidates = new Map();
  const bump = (term, zh) => {
    let entry = candidates.get(term);
    if (entry === undefined) {
      entry = {
        term,
        tf: 0,
        df: 0,
        firstPos: sourceText.indexOf(term),
        zh,
        charLen: [...term].length,
        functionChars: zh ? countZhFunctionChars(term) : 0,
        coherence: boundaryCoherence(sourceText, term),
      };
      candidates.set(term, entry);
    }
    entry.tf += 1;
  };
  for (const segment of segments) {
    for (const match of segment.matchAll(CJK_RUN)) {
      const run = match[0];
      for (let n = ZH_NGRAM_MIN; n <= ZH_NGRAM_MAX; n += 1) {
        for (let i = 0; i + n <= run.length; i += 1) {
          const gram = run.slice(i, i + n);
          if (countZhFunctionChars(gram) >= 3) continue;
          bump(gram, true);
        }
      }
    }
    const words = segmentEnWords(segment);
    for (let i = 0; i < words.length; i += 1) {
      bump(words[i], false);
      if (i + 1 < words.length) bump(`${words[i]} ${words[i + 1]}`, false);
    }
  }
  /* df：含该候选的句数。 */
  for (const entry of candidates.values()) {
    let df = 0;
    for (const segment of segments) {
      if (segment.includes(entry.term)) df += 1;
    }
    entry.df = df;
  }
  /* 同频最长扩张（仅 tf≥2：重复≥2 次的串边界才稳定；tf=1 的超串多半是
     粘了边界的毛刺，不做扩张——否则单例真术语会被同频毛刺超串吞掉）。
     长度分桶，确定性序；英文同形：parse ⊂ parser 同频 → 弃 parse。 */
  const byLength = new Map();
  for (const entry of candidates.values()) {
    const bucket = byLength.get(entry.term.length) ?? [];
    bucket.push(entry);
    byLength.set(entry.term.length, bucket);
  }
  const dropped = new Set();
  for (const entry of candidates.values()) {
    if (dropped.has(entry.term) || entry.tf < 2) continue;
    const minSuper = entry.term.length + 1;
    const maxSuper = entry.term.length + (entry.zh ? ZH_NGRAM_MAX - ZH_NGRAM_MIN : 1);
    for (let len = minSuper; len <= maxSuper; len += 1) {
      const bucket = byLength.get(len);
      if (bucket === undefined) continue;
      for (const other of bucket) {
        if (other.tf === entry.tf && other.term.includes(entry.term)) {
          dropped.add(entry.term);
          break;
        }
      }
      if (dropped.has(entry.term)) break;
    }
  }
  /* 边粘合修剪：候选的首/尾二字子串（自身是候选）比它多出现
     ≥EDGE_GLUE_MARGIN 次 → 该候选把边界正文粘了进来，弃。阈值取 2：
     只多 1 次的「神经网络 ⊃ 网络」型真术语不误杀（取舍如实记录）。 */
  for (const entry of candidates.values()) {
    if (dropped.has(entry.term) || entry.charLen < 4) continue;
    for (const edge of [entry.term.slice(0, 2), entry.term.slice(-2)]) {
      const sub = candidates.get(edge);
      if (sub !== undefined && sub !== entry && sub.tf - entry.tf >= EDGE_GLUE_MARGIN) {
        dropped.add(entry.term);
        break;
      }
    }
  }
  const kept = [];
  for (const entry of candidates.values()) {
    if (!dropped.has(entry.term)) kept.push(entry);
  }
  return kept;
}

/* ---------------- TF-IDF 与 TextRank ---------------- */

function computeTfidf(entries, segmentCount) {
  const scores = new Map();
  for (const entry of entries) {
    const idf = Math.log(1 + segmentCount / Math.max(1, entry.df));
    const lengthFactor = 1 + LENGTH_SLOPE * Math.max(0, entry.charLen - 2);
    const functionPenalty = Math.pow(ZH_FUNCTION_PENALTY, entry.functionChars);
    const coherenceFactor = COHERENCE_FLOOR + (1 - COHERENCE_FLOOR) * entry.coherence;
    scores.set(entry.term, (1 + Math.log(entry.tf)) * idf * lengthFactor * functionPenalty * coherenceFactor);
  }
  return scores;
}

/**
 * TextRank（句级共现）：候选为节点，同句共现为边（权重 = 共现句数），
 * PageRank 幂迭代（d=0.85、30 轮、初值 1）。节点序固定（词升序）——
 * 确定性。不用位置窗口：重叠 n-gram 会形成位置邻接团，把毛刺顶上去。
 */
function computeTextrank(entries, segments) {
  const nodes = [...entries].sort((a, b) => (a.term < b.term ? -1 : a.term > b.term ? 1 : 0));
  const index = new Map(nodes.map((entry, i) => [entry.term, i]));
  const edges = nodes.map(() => new Map());
  for (const segment of segments) {
    const present = [];
    for (const entry of nodes) {
      if (segment.includes(entry.term)) present.push(index.get(entry.term));
    }
    for (let a = 0; a < present.length; a += 1) {
      for (let b = a + 1; b < present.length; b += 1) {
        const u = present[a];
        const v = present[b];
        if (u === v) continue;
        edges[u].set(v, (edges[u].get(v) ?? 0) + 1);
        edges[v].set(u, (edges[v].get(u) ?? 0) + 1);
      }
    }
  }
  const weightSum = edges.map((adj) => {
    let sum = 0;
    for (const w of adj.values()) sum += w;
    return sum;
  });
  let rank = nodes.map(() => 1);
  for (let iter = 0; iter < TEXTRANK_ITERATIONS; iter += 1) {
    const next = nodes.map(() => 1 - TEXTRANK_DAMPING);
    for (let u = 0; u < nodes.length; u += 1) {
      if (weightSum[u] === 0) continue;
      for (const [v, w] of edges[u]) {
        next[v] += (TEXTRANK_DAMPING * w * rank[u]) / weightSum[u];
      }
    }
    rank = next;
  }
  const scores = new Map();
  nodes.forEach((entry, i) => scores.set(entry.term, rank[i]));
  return scores;
}

function minmaxNormalize(scores) {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of scores.values()) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const normalized = new Map();
  if (max === min) {
    for (const term of scores.keys()) normalized.set(term, 0.5);
    return normalized;
  }
  for (const [term, value] of scores) {
    normalized.set(term, (value - min) / (max - min));
  }
  return normalized;
}

/* ---------------- 机械纪律（与产品 validateCandidates 同口径） ---------------- */

/** URL / 反引号围栏排除带（正则与 apps/studio/src/terminology.ts 一致）。 */
export function excludedSpans(sourceText) {
  const spans = [];
  const url = /https?:\/\/[^\s）)》>"']+|www\.[^\s）)》>"']+/g;
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

/* ---------------- 对外 API ---------------- */

/**
 * 术词候选抽取（确定性）。
 * @param {string} sourceText 原文
 * @param {{ maxTerms?: number }} [options]
 * @returns {{ term: string, start: number, end: number, score: number }[]}
 *   已过机械纪律：首现偏移切片全等、去重、排除带、密度上限、子串包含去冗。
 */
export function extractCandidates(sourceText, options = {}) {
  if (typeof sourceText !== "string" || sourceText.length === 0) return [];
  const maxTerms = Number.isInteger(options.maxTerms) && options.maxTerms > 0 ? options.maxTerms : DEFAULT_MAX_TERMS;
  const segments = splitSegments(sourceText);
  const entries = buildCandidates(sourceText, segments);
  if (entries.length === 0) return [];
  const tfidf = minmaxNormalize(computeTfidf(entries, segments.length));
  const textrank = minmaxNormalize(computeTextrank(entries, segments));
  const scored = entries.map((entry) => ({
    term: entry.term,
    firstPos: entry.firstPos,
    score:
      SCORE_TFIDF_WEIGHT * (tfidf.get(entry.term) ?? 0) +
      (1 - SCORE_TFIDF_WEIGHT) * (textrank.get(entry.term) ?? 0),
  }));
  /* 稳定排序：分数降序、term 升序、首现升序。 */
  scored.sort(
    (a, b) => b.score - a.score || (a.term < b.term ? -1 : a.term > b.term ? 1 : 0) || a.firstPos - b.firstPos,
  );

  const excluded = excludedSpans(sourceText);
  const accepted = [];
  for (const candidate of scored) {
    if (accepted.length >= maxTerms) break;
    const start = candidate.firstPos;
    const end = start + candidate.term.length;
    if (start < 0 || end > sourceText.length) continue;
    if (sourceText.slice(start, end) !== candidate.term) continue;
    if (excluded.some((span) => start < span.end && span.start < end)) continue;
    if (accepted.some((a) => a.term === candidate.term)) continue;
    /* 子串包含去冗：更短候选的首现落在已选候选的区间内 → 弃（保留完整术语形）。 */
    if (accepted.some((a) => start >= a.start && end <= a.end)) continue;
    accepted.push({ term: candidate.term, start, end, score: round6(candidate.score) });
  }
  return accepted;
}

function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

/* ---------------- 自检（确定性 + 机械纪律 + 已知答案） ---------------- */

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 基线自检：确定性（同输入两次结果全等）、机械纪律（切片全等/上限/排除带/
 * 去冗）、已知答案（重复技术词被抽出、粘边毛刺被压低、代码围栏内不被抽出）。
 * @returns {{ name: string, pass: boolean, detail: string }[]}
 */
export function baselineSelfcheck() {
  const checks = [];
  const push = (name, pass, detail) => checks.push({ name, pass, detail });

  const zhText =
    "训练时靠梯度下降更新参数：每一步都沿损失下降最快的方向挪一小步。学习率决定每一步的幅度。" +
    "梯度下降设太大容易震荡发散，所以梯度下降要配衰减计划。参考 `lr=0.01` 的默认值与 https://example.com/docs。";
  const enText =
    "The spacing effect shows up in every spaced repetition system: retrieval with delay beats rereading. " +
    "Interleaving is the other one: mixed practice feels worse and works better. Run `npm ci` first.";

  const zhOnce = extractCandidates(zhText);
  const zhAgain = extractCandidates(zhText);
  push("determinism-zh", deepEqual(zhOnce, zhAgain), `same input twice -> ${zhOnce.length} candidates, byte-equal JSON`);
  const enOnce = extractCandidates(enText);
  const enAgain = extractCandidates(enText);
  push("determinism-en", deepEqual(enOnce, enAgain), `same input twice -> ${enOnce.length} candidates, byte-equal JSON`);

  const structuralOk = (label, candidates, source) => {
    const seen = new Set();
    for (const c of candidates) {
      if (source.slice(c.start, c.end) !== c.term) return `${label}: slice mismatch for ${c.term}`;
      if (seen.has(c.term)) return `${label}: duplicate ${c.term}`;
      seen.add(c.term);
    }
    if (candidates.length > 8) return `${label}: density cap exceeded (${candidates.length})`;
    return null;
  };
  const zhProblem = structuralOk("zh", zhOnce, zhText);
  push("mechanical-zh", zhProblem === null, zhProblem ?? "slice equality + dedup + density cap hold");
  const enProblem = structuralOk("en", enOnce, enText);
  push("mechanical-en", enProblem === null, enProblem ?? "slice equality + dedup + density cap hold");

  push(
    "known-answer-zh",
    zhOnce.some((c) => c.term === "梯度下降"),
    `repeated technical n-gram 梯度下降 ranks above glued boundary junk (top: ${zhOnce
      .slice(0, 3)
      .map((c) => c.term)
      .join(", ")})`,
  );
  push(
    "known-answer-en",
    enOnce.some((c) => c.term === "spacing effect"),
    `repeated en bigram phrase is among the candidates (top: ${enOnce
      .slice(0, 4)
      .map((c) => c.term)
      .join(", ")})`,
  );
  push(
    "code-exclusion",
    !zhOnce.some((c) => c.term.includes("lr=0.01")) && !enOnce.some((c) => c.term.includes("npm ci")),
    "backtick-fenced code is never a candidate",
  );
  push(
    "url-exclusion",
    !zhOnce.some((c) => c.term.includes("example.com")),
    "URL text is never a candidate",
  );
  return checks;
}

/* ---------------- CLI ---------------- */

function runCli(argv) {
  const args = argv.slice(2);
  if (args[0] === "--selftest") {
    const checks = baselineSelfcheck();
    let failed = 0;
    for (const check of checks) {
      console.log(`  [${check.pass ? "PASS" : "FAIL"}] ${check.name} — ${check.detail}`);
      if (!check.pass) failed += 1;
    }
    console.log(`terminology-baseline selftest: ${checks.length - failed}/${checks.length} PASS`);
    process.exit(failed > 0 ? 2 : 0);
  }
  let text = null;
  if (args[0] === "--text") text = args[1];
  else if (args[0] === "--text-file") text = readFileSync(args[1], "utf8");
  if (text === null) {
    console.log("usage: node scripts/terminology/baseline.mjs --selftest | --text TEXT | --text-file FILE");
    process.exit(1);
  }
  console.log(JSON.stringify(extractCandidates(text), null, 2));
}

if (process.argv[1] !== undefined && process.argv[1].replace(/\\/g, "/").endsWith("/terminology/baseline.mjs")) {
  runCli(process.argv);
}
