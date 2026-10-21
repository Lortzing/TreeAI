/** dataset owner; frozen probe bodies and order preserved. */
import { createHash } from "node:crypto";
import { DeterministicRng } from "../../../../apps/studio/src/nav/deterministic-rng.ts";
import { type B6Dataset, type B6Material, type B6Totals, type B6FrozenQuery, type B6ImportSamplePlan, type B6PdfLinePlan, type B6Manifest, type B6MaterialStats } from './models.ts';
import { B6_MATERIAL_COUNT, B6_SET_ID, B6_SEED, B6_FOREST_ID, B6_FROZEN_QUERY_COUNT, B6_SAMPLE_PAGES, B6_SAMPLE_LINES_PER_PAGE, B6_SAMPLE_FILENAME } from './policy.ts';
import { materialIdentity, b6MaterialKind, buildMarkdownParagraphs, buildMarkdownSource, buildPdfPages, buildPdfCanonicalText } from './materials.ts';
import { buildTrees, buildFacts } from './facts.ts';
import { TOPICS_ZH } from './text.ts';


/* ------------------------------------------------------------------ */
/* 生成主入口                                                           */
/* ------------------------------------------------------------------ */

/** 生成完整 B6 数据集（纯函数：无 IO、无随机源、无时间——同 seed 字节级恒等）。 */
export function generateB6Dataset(): B6Dataset {
  const materials: B6Material[] = [];
  for (let index = 0; index < B6_MATERIAL_COUNT; index += 1) {
    const identity = materialIdentity(index);
    if (b6MaterialKind(index) === "markdown") {
      const built = buildMarkdownParagraphs(identity);
      const canonical = buildMarkdownSource(built.paragraphs);
      if (canonical.length !== identity.units) {
        throw new Error(
          `b6-dataset: markdown ${identity.materialId} canonical ${String(canonical.length)} != plan ${String(identity.units)}`,
        );
      }
      materials.push({
        kind: "markdown",
        materialId: identity.materialId,
        versionId: identity.versionId,
        title: identity.title,
        filename: identity.filename,
        treeId: identity.treeId,
        units: identity.units,
        needle: identity.needle,
        needleIndex: built.needleIndex,
        paragraphs: built.paragraphs,
      });
    } else {
      const built = buildPdfPages(identity);
      materials.push({
        kind: "pdf",
        materialId: identity.materialId,
        versionId: identity.versionId,
        title: identity.title,
        filename: identity.filename,
        treeId: identity.treeId,
        units: identity.units,
        needle: identity.needle,
        needleIndex: built.needleIndex,
        pages: built.pages,
      });
    }
  }

  const trees = buildTrees();
  const { qaPairs, annotations, returns } = buildFacts(trees);

  const totalTextUnits = materials.reduce((sum, material) => sum + material.units, 0);
  const branchRows = trees.reduce((sum, tree) => sum + tree.branches.length, 0);
  const totals: B6Totals = {
    materials: materials.length,
    markdownMaterials: materials.filter((m) => m.kind === "markdown").length,
    pdfMaterials: materials.filter((m) => m.kind === "pdf").length,
    totalTextUnits,
    longMaterials: materials.filter((m) => m.units >= 50_000).length,
    trees: trees.length,
    branchRows,
    nonTrunkBranches: branchRows - trees.length,
    qaPairs: qaPairs.length,
    turnFacts: qaPairs.length * 2,
    annotationFacts: annotations.length,
    returnFacts: returns.length,
    savedFacts: qaPairs.length * 2 + annotations.length + returns.length,
  };
  return {
    version: 1,
    setId: B6_SET_ID,
    seed: B6_SEED,
    forestId: B6_FOREST_ID,
    materials,
    trees,
    qaPairs,
    annotations,
    returns,
    totals,
  };
}


/* ------------------------------------------------------------------ */
/* 冻结查询集（50 条；由 needles 派生——偶数号材料的 needle）              */
/* ------------------------------------------------------------------ */

/**
 * 冻结查询集：query i = 材料 (2i) 的 needle（i = 0..49 → 材料 0,2,…,98）。
 * 每条携带期望命中的 materialId 与 needle 偏移（检索正确性断言用）。
 */
export function deriveB6FrozenQueries(dataset: B6Dataset): B6FrozenQuery[] {
  const queries: B6FrozenQuery[] = [];
  for (let i = 0; i < B6_FROZEN_QUERY_COUNT; i += 1) {
    const material = dataset.materials[2 * i]!;
    queries.push({
      text: material.needle,
      expectedMaterialId: material.materialId,
      expectedNeedleIndex: material.needleIndex,
    });
  }
  return queries;
}


/**
 * 10 MiB / 100 页导入样例（冻结配方）：100 页 × 2,000 行 × 4 单位
 * （songti 密排；每行真实 Tj + ToUnicode 映射——短行密排是「文件 ≥10 MiB
 * 且 canonicalText ≤100 万单元（charter §5）」约束下最大化真实解析量的
 * 诚实实现，无任何填充字节）。期望 canonicalText 由引擎按 d4-pdf-v1 规则
 * 精确构造（CLI 构建字节后必须经真实解析器逐字复核）。
 */
export function generateB6ImportSamplePlan(): B6ImportSamplePlan {
  const rng = DeterministicRng.forStep(B6_SEED, "import-sample");
  const fragments = [...TOPICS_ZH];
  const pages: B6PdfLinePlan[][] = [];
  // 行文本恰 4 单位：主题词截 3 单元 + 1 位十六进制序号（确定性词表派生）。
  const lineText = (seq: number): string => {
    const word = fragments[seq % fragments.length]!;
    const head = word.slice(0, 3);
    return `${head}${"0123456789abcdef"[seq % 16]}`;
  };
  for (let page = 0; page < B6_SAMPLE_PAGES; page += 1) {
    const lines: B6PdfLinePlan[] = [];
    for (let line = 0; line < B6_SAMPLE_LINES_PER_PAGE; line += 1) {
      const seq = page * B6_SAMPLE_LINES_PER_PAGE + line;
      lines.push(page === 0 && line === 0
        ? { text: "B6样例", size: 10 }
        : { text: lineText(seq), size: 10 });
    }
    pages.push(lines);
  }
  const expectedUnits = (() => {
    let total = 0;
    for (let p = 0; p < pages.length; p += 1) {
      total += pages[p]!.reduce((sum, line) => sum + line.text.length, 0);
      total += pages[p]!.length - 1;
      if (p < pages.length - 1) total += 1;
    }
    return total;
  })();
  return {
    filename: B6_SAMPLE_FILENAME,
    pages,
    expectedUnits,
    expectedPages: B6_SAMPLE_PAGES,
  };
}


/* ------------------------------------------------------------------ */
/* 序列化 + manifest                                                    */
/* ------------------------------------------------------------------ */

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}


/** 材料 canonicalText（真实解析器输出必须与之逐字相等）。 */
export function b6MaterialCanonicalText(material: B6Material): string {
  return material.kind === "markdown"
    ? buildMarkdownSource(material.paragraphs)
    : buildPdfCanonicalText(material.pages);
}


/** 结构真值 JSON（紧凑、键序固定——同数据集字节级恒等）。 */
export function serializeB6Dataset(dataset: B6Dataset): string {
  return JSON.stringify(dataset);
}


export function buildB6Manifest(
  dataset: B6Dataset,
  truthJson: string,
  fileInfos: ReadonlyMap<string, { sha256: string; bytes: number; blocks: number; pages: number }>,
): B6Manifest {
  const materials: B6MaterialStats[] = dataset.materials.map((material) => {
    const info = fileInfos.get(material.filename);
    if (info === undefined) {
      throw new Error(`b6-dataset: manifest missing file info for ${material.filename}`);
    }
    return {
      materialId: material.materialId,
      kind: material.kind,
      filename: material.filename,
      units: material.units,
      pages: material.kind === "pdf" ? material.pages.length : 0,
      blocks: info.blocks,
      needleIndex: material.needleIndex,
      canonicalSha256: sha256Hex(b6MaterialCanonicalText(material)),
    };
  });
  return {
    version: 1,
    setId: B6_SET_ID,
    seed: dataset.seed,
    truthSha256: sha256Hex(truthJson),
    truthBytes: Buffer.byteLength(truthJson, "utf8"),
    materials,
    totals: dataset.totals,
  };
}


export function serializeB6Manifest(manifest: B6Manifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
