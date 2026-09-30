#!/usr/bin/env node
/**
 * TreeAI D4-6 — deterministic B6 scale dataset generator, implementing the
 * FROZEN spec at tests/fixtures/d4/b6-scale/spec.json (never modified here).
 *
 * Charter: docs/d4/D4-project-v1.md §4 D4-6, §5 建议首版支持上限, §6 B6.
 * Engine module: tests/support/verifier/d4-b6-dataset.ts (pure, deterministic).
 * Loader (for --load-check): tests/support/verifier/d4-b6-loader.ts.
 *
 * Dataset shape (per spec): 100 materials (70 markdown + 30 pdf — the pdfs are
 * built by the scripts/d4 PDF facility from the engine's frozen page/line
 * plans, fixed content templates), 1,000,000 canonical UTF-16 units in total
 * (exact), 10,000 saved facts (6,000 turns / 2,500 annotations / 1,500
 * returns), 1,000 non-trunk branches over 10 trees. Plus the frozen
 * import-probe sample: 100 pages / ≥10 MiB (see the engine header for the
 * recipe rationale).
 *
 * Determinism: seed d4-b6-2026-09-30, per-step DeterministicRng (xorshift128),
 * no Math.random(), no timestamps — the whole output set is built twice and
 * must be byte-identical (self-verified on every run before anything is
 * written). PDF generation goes through scripts/d4/pdf/ (LayoutDoc pinned
 * reading order + deterministic subsetted Songti + fixed /Info dates +
 * content-hash /ID).
 *
 * Generated dataset files are NOT committed: tests/fixtures/d4/b6-scale/ holds
 * only the frozen spec. This script refuses to write into the fixtures tree
 * and produces its output into an explicit --out dir.
 *
 * Self-verification performed on every run, before anything is written:
 *   1. engine invariants — checkB6Invariants must return zero problems;
 *   2. determinism — the full output set (materials + sample + truth +
 *      manifest) is built twice and every file must be byte-identical;
 *   3. real-parser round-trips — every markdown file parses with the real
 *      d4-md-v1 into exactly the engine's canonical text; every pdf parses
 *      with the real d4-pdf-v1 into exactly the engine's canonical text and
 *      page plan; the sample parses ready with 100 pages / ≤1M units and its
 *      bytes sit in [10 MiB, 11 MiB);
 *   4. manifest hashes — truthSha256 matches the serialized truth bytes.
 *
 * Usage:
 *   node scripts/d4/gen-b6-scale-dataset.mjs --out DIR
 *   node scripts/d4/gen-b6-scale-dataset.mjs --out DIR --quiet
 *   node scripts/d4/gen-b6-scale-dataset.mjs --out DIR --load-check
 *
 * Exit codes (verify-d4 convention): 0 = all checks pass + written;
 * 1 = tool error; 2 = verification failure (nothing written).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { SfntFont, buildSubset } from "./pdf/font.mjs";
import { LayoutDoc } from "./pdf/layout.mjs";
import { TextPdfBuilder, pdfHex } from "./pdf/pdfwriter.mjs";
import { assert, sha256hex } from "./pdf/util.mjs";

import {
  B6_PDF_LINE_STEP,
  B6_PDF_TITLE_FONT_SIZE,
  B6_PDF_TOP_Y,
  B6_PDF_X,
  B6_SAMPLE_FILENAME,
  B6_SAMPLE_MAX_BYTES,
  B6_SAMPLE_MIN_BYTES,
  buildMarkdownSource,
  buildPdfCanonicalText,
  checkB6Invariants,
  generateB6Dataset,
  generateB6ImportSamplePlan,
  serializeB6Dataset,
  serializeB6Manifest,
  buildB6Manifest,
  sha256Hex,
} from "../../tests/support/verifier/d4-b6-dataset.ts";
import { parseMarkdownMaterial } from "../../apps/studio/src/materials/markdown-parser.ts";
import { parsePdfMaterial } from "../../apps/studio/src/materials/pdf-parser.ts";
import { loadB6IntoFreshDir } from "../../tests/support/verifier/d4-b6-loader.ts";

const SCRIPT_DIR = new URL(".", import.meta.url);
const REPO_ROOT = join(fileURLToPath(SCRIPT_DIR), "..", "..");
const FIXTURES_D4_DIR = join(REPO_ROOT, "tests", "fixtures", "d4");

const FONT_SOURCES = {
  songti: {
    path: "/System/Library/Fonts/Supplemental/Songti.ttc",
    ttcIndex: 0,
    family: "SongtiSC",
    tag: "SO",
  },
};

const MEDIA_BOX = [0, 0, 595.28, 841.89];

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

const args = process.argv.slice(2);

function argValue(name) {
  const prefix = `--${name}=`;
  for (const a of args) {
    if (a.startsWith(prefix)) return a.slice(prefix.length);
  }
  const i = args.indexOf(`--${name}`);
  if (i !== -1 && i + 1 < args.length && !args[i + 1].startsWith("--")) {
    return args[i + 1];
  }
  return null;
}

const outDir = argValue("out");
const quiet = args.includes("--quiet");
const loadCheck = args.includes("--load-check");

if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(
    [
      "usage: node scripts/d4/gen-b6-scale-dataset.mjs --out DIR [--quiet] [--load-check]",
      "",
      "  Deterministically generates the B6 scale dataset per the frozen spec",
      "  (tests/fixtures/d4/b6-scale/spec.json) into DIR:",
      "    materials/b6-mat-000.md … b6-mat-099.pdf — the 100-material corpus",
      "      (70 markdown + 30 pdf built by the scripts/d4 PDF facility)",
      "    sample/b6-import-sample.pdf — the frozen 10 MiB / 100-page import probe",
      "    b6-truth.json — structure truth (trees/branches/facts/queries/plans)",
      "    b6-manifest.json — per-file sha256 + units/pages/blocks + totals",
      "",
      "  Self-verifies invariants, byte-identical double builds and real-parser",
      "  round-trips (d4-md-v1 / d4-pdf-v1) BEFORE writing anything. With",
      "  --load-check it additionally loads the dataset into a REAL persistence",
      "  database in a fresh temp dir via the repository APIs, verifies row",
      "  counts, then removes the temp dir.",
      "  Exit codes: 0 pass, 1 tool error, 2 verification failure.",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

if (outDir === null) {
  process.stderr.write("error: --out DIR is required (see --help)\n");
  process.exit(1);
}

function fail(message, code = 2) {
  process.stderr.write(`gen-b6-scale-dataset: ${message}\n`);
  process.exit(code);
}

// 防御：绝不允许把生成物写进冻结 fixtures 树（spec 的修改=范围变更）。
const resolvedOut = isAbsolute(outDir) ? outDir : join(process.cwd(), outDir);
const relToFixtures = relative(FIXTURES_D4_DIR, resolvedOut);
if (relToFixtures === "" || (!relToFixtures.startsWith("..") && !isAbsolute(relToFixtures))) {
  fail(`refusing to write into the frozen fixtures tree (${FIXTURES_D4_DIR}); generated datasets are produced on demand elsewhere`);
}
if (existsSync(join(resolvedOut, "b6-truth.json"))) {
  fail(`output already exists at ${join(resolvedOut, "b6-truth.json")} (append-only discipline: choose a fresh directory)`);
}

const log = (line) => {
  if (!quiet) process.stdout.write(line);
};

/* ------------------------------------------------------------------ */
/* PDF 构建（页/行计划 → LayoutDoc → 字节）                              */
/* ------------------------------------------------------------------ */

/**
 * 从页/行计划构建 PDF 字节。行放置在单一 x 栏（单栏带、y 严格递减 →
 * 阅读序 = 发射序）；每行恰好一个 Tj（d4-pdf-v1 钉死阅读序的前提）。
 * 返回 { bytes, canonicalText, blocks }——canonicalText/blocks 来自
 * LayoutDoc.finish()（钉死阅读序的唯一实现），调用方与引擎期望逐字比对。
 */
function buildPdfFromPlan({ pages, title, songti, subsetCache, baseName, topY, lineStep }) {
  const fonts = new Map([["zh", { kind: "cid", font: songti }]]);
  const doc = new LayoutDoc({ fonts, mediaBox: MEDIA_BOX });
  for (let p = 0; p < pages.length; p += 1) {
    const page = pages[p];
    for (let i = 0; i < page.length; i += 1) {
      const line = page[i];
      doc.placeLine(line.text, { font: "zh", size: line.size, x: B6_PDF_X, y: topY - i * lineStep });
    }
    if (p < pages.length - 1) doc.pageBreak();
  }
  const layout = doc.finish();

  // 字体子集（按码点集合缓存：同集合复用字节，确定性）。
  const cpText = layout.usedCodepoints.get("zh");
  assert(cpText !== undefined && cpText.size > 0, `${baseName}: no codepoints collected`);
  const cacheKey = [...cpText.keys()].sort((a, b) => a - b).join(",");
  let subset = subsetCache.get(cacheKey);
  if (subset === undefined) {
    subset = buildSubset(songti, cpText);
    subsetCache.set(cacheKey, subset);
  }

  const builder = new TextPdfBuilder({ title });
  builder.cidFont("zh", baseName, subset);
  const gidOf = (ch) => {
    const gid = songti.gidOf(ch.codePointAt(0));
    assert(gid !== 0, `${baseName}: songti has no glyph for ${JSON.stringify(ch)}`);
    return gid;
  };
  for (const page of layout.pages) {
    const encoded = page.lines.map((line) => {
      const chars = [...line.text]; // 码点（BMP 语料 → 每码点一个 2 字节 CID）
      const bytes = Buffer.alloc(2 * chars.length);
      chars.forEach((ch, idx) => bytes.writeUInt16BE(gidOf(ch), idx * 2));
      return { font: "zh", size: line.size, x: line.x, y: line.y, encoded: pdfHex(bytes) };
    });
    builder.addPage(encoded, page.mediaBox);
  }
  return {
    bytes: builder.build(),
    canonicalText: layout.canonicalText,
    blocks: layout.blocks,
  };
}

/* ------------------------------------------------------------------ */
/* 输出集构建（纯内存；path → Buffer）                                   */
/* ------------------------------------------------------------------ */

function buildOutputSet({ verify }) {
  const dataset = generateB6Dataset();
  if (verify) {
    const problems = checkB6Invariants(dataset);
    if (problems.length > 0) {
      for (const problem of problems.slice(0, 20)) {
        process.stderr.write(`  invariant problem: ${problem}\n`);
      }
      fail(`invariant check FAILED: ${problems.length} problem(s)`);
    }
    log(`  invariants: 0 problems (100 materials / 1,000,000 units / 10 trees / 1,000 non-trunk branches / 10,000 saved facts)\n`);
  }

  const songti = SfntFont.load(FONT_SOURCES.songti.path, FONT_SOURCES.songti.ttcIndex);
  const subsetCache = new Map();
  const files = new Map();
  /** filename → { sha256, bytes, blocks, pages }（manifest 用）。 */
  const fileInfos = new Map();

  // —— 语料材料 ——
  for (const material of dataset.materials) {
    // 块数可从计划推导（md：每段一块；pdf：每页一块）——两次构建的
    // manifest 因此字节恒等；verify 路径再以真实解析器复核同数。
    const plannedBlocks =
      material.kind === "markdown" ? material.paragraphs.length : material.pages.length;
    if (material.kind === "markdown") {
      const source = buildMarkdownSource(material.paragraphs);
      const bytes = Buffer.from(source, "utf8");
      if (verify) {
        const parsed = parseMarkdownMaterial(new Uint8Array(bytes));
        assert(parsed.ok, `${material.materialId}: d4-md-v1 parse failed (${parsed.reason})`);
        assert(parsed.canonicalText === source, `${material.materialId}: d4-md-v1 canonical text diverges from the engine truth`);
        assert(parsed.canonicalText.length === material.units, `${material.materialId}: unit count diverges`);
        assert(parsed.blocks.length === plannedBlocks, `${material.materialId}: block count != paragraphs`);
      }
      fileInfos.set(material.filename, { sha256: sha256hex(bytes), bytes: bytes.length, blocks: plannedBlocks, pages: 0 });
      files.set(`materials/${material.filename}`, bytes);
      continue;
    }
    const built = buildPdfFromPlan({
      pages: material.pages,
      title: material.title,
      songti,
      subsetCache,
      baseName: `B6${material.materialId.slice(-3)}${FONT_SOURCES.songti.tag}+${FONT_SOURCES.songti.family}`,
      topY: B6_PDF_TOP_Y,
      lineStep: B6_PDF_LINE_STEP,
    });
    if (verify) {
      const expected = buildPdfCanonicalText(material.pages);
      assert(
        built.canonicalText === expected,
        `${material.materialId}: layout canonical text diverges from the engine truth`,
      );
      const parsed = parsePdfMaterial(new Uint8Array(built.bytes));
      assert(parsed.ok, `${material.materialId}: d4-pdf-v1 parse failed (${parsed.reason}): ${parsed.message}`);
      assert(parsed.canonicalText === expected, `${material.materialId}: d4-pdf-v1 canonical text diverges from the engine truth`);
      assert(parsed.pages === material.pages.length, `${material.materialId}: page count diverges`);
      assert(parsed.blocks.length === plannedBlocks, `${material.materialId}: block count != pages`);
    }
    fileInfos.set(material.filename, {
      sha256: sha256hex(built.bytes),
      bytes: built.bytes.length,
      blocks: plannedBlocks,
      pages: material.pages.length,
    });
    files.set(`materials/${material.filename}`, built.bytes);
  }

  // —— 导入样例（10 MiB / 100 页；冻结配方见引擎文件头） ——
  const samplePlan = generateB6ImportSamplePlan();
  const sampleBuilt = buildPdfFromPlan({
    pages: samplePlan.pages,
    title: "B6 import sample: 10 MiB / 100 pages",
    songti,
    subsetCache,
    baseName: `B6SMP${FONT_SOURCES.songti.tag}+${FONT_SOURCES.songti.family}`,
    topY: 800,
    lineStep: 0.4,
  });
  if (verify) {
    const expected = buildPdfCanonicalText(samplePlan.pages);
    assert(sampleBuilt.canonicalText === expected, "import sample: layout canonical text diverges from the plan");
    const parsed = parsePdfMaterial(new Uint8Array(sampleBuilt.bytes));
    assert(parsed.ok, `import sample: d4-pdf-v1 parse failed (${parsed.reason}): ${parsed.message}`);
    assert(parsed.canonicalText === expected, "import sample: d4-pdf-v1 canonical text diverges from the plan");
    assert(parsed.pages === samplePlan.expectedPages, `import sample: pages ${String(parsed.pages)} != 100`);
    assert(parsed.canonicalText.length === samplePlan.expectedUnits, "import sample: unit count diverges");
    assert(parsed.canonicalText.length <= 1_000_000, "import sample exceeds the 1M-unit per-material cap");
    assert(
      sampleBuilt.bytes.length >= B6_SAMPLE_MIN_BYTES && sampleBuilt.bytes.length < B6_SAMPLE_MAX_BYTES,
      `import sample bytes ${String(sampleBuilt.bytes.length)} outside [${String(B6_SAMPLE_MIN_BYTES)}, ${String(B6_SAMPLE_MAX_BYTES)})`,
    );
  }
  fileInfos.set(samplePlan.filename, {
    sha256: sha256hex(sampleBuilt.bytes),
    bytes: sampleBuilt.bytes.length,
    blocks: samplePlan.pages.length,
    pages: samplePlan.expectedPages,
  });
  files.set(`sample/${samplePlan.filename}`, sampleBuilt.bytes);

  // —— 真值 + manifest ——
  const truthJson = serializeB6Dataset(dataset);
  const manifest = buildB6Manifest(dataset, truthJson, fileInfos);
  const manifestJson = serializeB6Manifest(manifest);
  if (verify) {
    assert(manifest.truthSha256 === sha256Hex(truthJson), "manifest truthSha256 does not match the serialized truth");
  }
  files.set("b6-truth.json", Buffer.from(truthJson, "utf8"));
  files.set("b6-manifest.json", Buffer.from(manifestJson, "utf8"));

  return { files, dataset, sampleBytes: sampleBuilt.bytes.length, sampleSha256: sha256hex(sampleBuilt.bytes) };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                               */
/* ------------------------------------------------------------------ */

log(`gen-b6-scale-dataset: seed=d4-b6-2026-09-30 setId=b6-scale\n`);

// 1) 全量构建 + 全部自校验（不变量 / 真实解析器往返 / 样例边界）。
const t0 = Date.now();
const first = buildOutputSet({ verify: true });
log(`  built: 100 materials + import sample; all real-parser round-trips exact (${String(Date.now() - t0)}ms)\n`);
log(`  import sample: ${String(first.sampleBytes)} bytes (${(first.sampleBytes / 1024 / 1024).toFixed(2)} MiB), sha256 ${first.sampleSha256.slice(0, 16)}…\n`);

// 2) 确定性：全新构建一遍，逐文件字节级恒等（含全新字体子集缓存）。
const t1 = Date.now();
const second = buildOutputSet({ verify: false });
assert(first.files.size === second.files.size, "determinism: output set size changed");
let identical = 0;
for (const [path, bytes] of first.files) {
  const other = second.files.get(path);
  assert(other !== undefined && other.equals(bytes), `determinism: ${path} differs between two builds`);
  identical += 1;
}
log(`  determinism: ${String(identical)}/${String(first.files.size)} files byte-identical across two fresh builds (${String(Date.now() - t1)}ms)\n`);

// 3) 写盘（全部校验通过后）。
for (const [relPath, bytes] of first.files) {
  const abs = join(resolvedOut, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, bytes);
}
log(`  wrote: ${String(first.files.size)} files under ${resolvedOut}\n`);

/* ------------------------------------------------------------------ */
/* 可选：装载自检（真实仓储 API → 临时库 → 行数核对 → 删除）              */
/* ------------------------------------------------------------------ */

if (loadCheck) {
  const dataDir = mkdtempSync(join(tmpdir(), "b6-gen-loadcheck-"));
  const loaded = loadB6IntoFreshDir(resolvedOut, dataDir);
  try {
    const s = loaded.loadStats;
    log(
      `  load check: ${String(s.materialVersions)} ready versions (${String(s.totalCanonicalUnits)} units) + ` +
        `${String(s.branches)} branch rows + ${String(s.userTurns + s.assistantTurns)} qa turns + ` +
        `${String(s.annotations)} annotations + ${String(s.returnTurns)} returns into a real persistence DB ` +
        `in ${s.elapsedMs.toFixed(0)}ms via repository APIs; sqlite integrity ok\n`,
    );
  } finally {
    loaded.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

log("gen-b6-scale-dataset: OK\n");
process.exit(0);
