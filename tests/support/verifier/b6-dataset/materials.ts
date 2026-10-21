/** materials owner; frozen probe bodies and order preserved. */

import { DeterministicRng } from "../../../../apps/studio/src/nav/deterministic-rng.ts";
import { B6_LONG_MARKDOWN_COUNT, B6_LONG_MARKDOWN_UNITS, B6_LONG_PDF_COUNT, B6_LONG_PDF_UNITS, B6_MATERIAL_COUNT, B6_MARKDOWN_COUNT, B6_TOTAL_TEXT_UNITS, B6_TREE_COUNT, B6_SEED, B6_PDF_TITLE_FONT_SIZE, B6_PDF_BODY_LINE_UNITS, B6_PDF_BODY_FONT_SIZE, B6_PDF_LINES_PER_PAGE } from './policy.ts';
import { type B6MaterialKind, type B6PdfLinePlan } from './models.ts';
import { pad, TOPICS_ZH, ASPECTS_ZH, TOPICS_EN, b6Needle, paragraph, calibrationText, sentence } from './text.ts';


/* ------------------------------------------------------------------ */
/* 单位分配（冻结规则；总和精确 1,000,000）                              */
/* ------------------------------------------------------------------ */

/** 长文合计单元（8 md × 52,000 + 4 pdf × 51,000）。 */
export const B6_LONG_MD_TOTAL_UNITS = B6_LONG_MARKDOWN_COUNT * B6_LONG_MARKDOWN_UNITS;
 // 416,000
export const B6_LONG_PDF_TOTAL_UNITS = B6_LONG_PDF_COUNT * B6_LONG_PDF_UNITS;
 // 204,000
export const B6_SHORT_MATERIAL_COUNT =
  B6_MATERIAL_COUNT - B6_LONG_MARKDOWN_COUNT - B6_LONG_PDF_COUNT;
 // 88

/**
 * 材料 i 的计划单元数：
 *  - md idx 0..7（长文）= 52,000；pdf idx 70..73（长文）= 51,000；
 *  - 其余 88 份均分余量 380,000：基线 4,318，前 16 份（md idx 8..23）各 +1。
 * 总和 = 416,000 + 204,000 + 16×4,319 + 72×4,318 = 1,000,000（构造性成立）。
 */
export function b6MaterialUnits(materialIndex: number): number {
  if (materialIndex < B6_LONG_MARKDOWN_COUNT) return B6_LONG_MARKDOWN_UNITS;
  if (materialIndex >= B6_MARKDOWN_COUNT && materialIndex < B6_MARKDOWN_COUNT + B6_LONG_PDF_COUNT) {
    return B6_LONG_PDF_UNITS;
  }
  const shortsBudget = B6_TOTAL_TEXT_UNITS - B6_LONG_MD_TOTAL_UNITS - B6_LONG_PDF_TOTAL_UNITS; // 380,000
  const base = Math.floor(shortsBudget / B6_SHORT_MATERIAL_COUNT); // 4,318
  const remainder = shortsBudget - base * B6_SHORT_MATERIAL_COUNT; // 16
  const shortIndex =
    materialIndex < B6_MARKDOWN_COUNT
      ? materialIndex - B6_LONG_MARKDOWN_COUNT // md 短文 0..61
      : 62 + (materialIndex - B6_MARKDOWN_COUNT - B6_LONG_PDF_COUNT); // pdf 短文 62..87
  return base + (shortIndex < remainder ? 1 : 0);
}


export function b6MaterialKind(materialIndex: number): B6MaterialKind {
  return materialIndex < B6_MARKDOWN_COUNT ? "markdown" : "pdf";
}


export function b6MaterialTreeId(materialIndex: number): string {
  return `b6-t${pad((materialIndex % B6_TREE_COUNT) + 1, 2)}`;
}


/* ------------------------------------------------------------------ */
/* canonicalText 精确构造                                               */
/* ------------------------------------------------------------------ */

/**
 * markdown 源文件 = 段落以单个空行相接 + 单个尾随换行。
 * canonicalText（d4-md-v1）= Σ_{i<k}(len(p_i)+2) + len(p_k) + 1（精确公式）。
 */
export function buildMarkdownSource(paragraphs: readonly string[]): string {
  return `${paragraphs.join("\n\n")}\n`;
}


export function markdownCanonicalLength(paragraphs: readonly string[]): number {
  if (paragraphs.length === 0) return 0;
  let total = 1;
  for (let i = 0; i < paragraphs.length; i += 1) {
    total += paragraphs[i]!.length;
    if (i < paragraphs.length - 1) total += 2;
  }
  return total;
}


/**
 * PDF canonicalText（d4-pdf-v1）= 每页行以 "\n" 相接、非末页块尾加 "\n"。
 * 本引擎按同一规则从页/行计划构造期望 canonicalText（真实解析器输出必须
 * 与之逐字相等——CLI/装载器双向复核）。
 */
export function pdfPageText(lines: readonly B6PdfLinePlan[]): string {
  return lines.map((line) => line.text).join("\n");
}


export function buildPdfCanonicalText(pages: readonly (readonly B6PdfLinePlan[])[]): string {
  const parts: string[] = [];
  for (let i = 0; i < pages.length; i += 1) {
    const text = pdfPageText(pages[i]!);
    parts.push(i < pages.length - 1 ? `${text}\n` : text);
  }
  return parts.join("");
}


/* ------------------------------------------------------------------ */
/* 材料内容生成                                                          */
/* ------------------------------------------------------------------ */

export interface MaterialIdentity {
  readonly materialId: string;
  readonly versionId: string;
  readonly title: string;
  readonly filename: string;
  readonly treeId: string;
  readonly units: number;
  readonly needle: string;
}


export function materialIdentity(index: number): MaterialIdentity {
  const id = `b6-mat-${pad(index, 3)}`;
  const rng = DeterministicRng.forStep(B6_SEED, `title:${id}`);
  const title = `${rng.pick(TOPICS_ZH)}·${rng.pick(ASPECTS_ZH)}（${rng.pick(TOPICS_EN)}）B6-${pad(index, 3)}`;
  return {
    materialId: id,
    versionId: `${id}-v1`,
    title,
    filename: `${id}.${b6MaterialKind(index) === "markdown" ? "md" : "pdf"}`,
    treeId: b6MaterialTreeId(index),
    units: b6MaterialUnits(index),
    needle: b6Needle(index),
  };
}


/** 段落流（标题段 → needle 段 → 正文段…），返回段落列表与 needle 位置。 */
export function buildMarkdownParagraphs(identity: MaterialIdentity): {
  paragraphs: string[];
  needleIndex: number;
} {
  const rng = DeterministicRng.forStep(B6_SEED, `md:${identity.materialId}`);
  const paragraphs: string[] = [];
  // p0：标题行（markdown 一级标题语法逐字保留）。
  paragraphs.push(`# ${identity.title}`);
  // p1：needle 段（含唯一 needle + 上下文）。
  const needleParagraph =
    `本份材料的检索标记为 ${identity.needle}，后续复习与引用都以它定位；` +
    `标记本身不参与正文论述，只在搜索时用作锚。`;
  paragraphs.push(needleParagraph);

  // 预算：canonical = Σ_{i<k}(len+2) + len_k + 1。
  let used = 1; // 尾随换行
  for (let i = 0; i < paragraphs.length; i += 1) {
    used += paragraphs[i]!.length + (i < paragraphs.length - 1 ? 2 : 0);
  }
  // used 目前含「p_{k-1} 的 +2」（最后一段尚未追加）；剩余 = units − used − 2（末段接续）。
  let remaining = identity.units - used - 2;
  while (remaining > 700) {
    const p = paragraph(rng, rng.int(3, 5));
    paragraphs.push(p);
    remaining -= p.length + 2;
  }
  if (remaining < 60) {
    throw new Error(
      `b6-dataset: markdown ${identity.materialId} calibration remainder ${String(remaining)} < 60 (allocation bug)`,
    );
  }
  paragraphs.push(calibrationText(`md-cal:${identity.materialId}`, remaining));

  const canonical = buildMarkdownSource(paragraphs);
  const needleIndex = canonical.indexOf(identity.needle);
  if (needleIndex < 0) {
    throw new Error(`b6-dataset: markdown ${identity.materialId} lost its needle`);
  }
  return { paragraphs, needleIndex };
}


/**
 * 页/行计划。恒等式（d4-pdf-v1）：canonicalText 单元总数
 *   T = Σ行长度 + (行数 − 1)
 * （每行跟一个 "\n"，只有末页末行例外；页分隔符已被计入行的换行——与页
 * 分组方式无关）。因此：标题行 + K 条整 30 单元正文行 + 1 条标定行，
 * N = K + 2 行 → 标定行长 C = T − 标题长 − 30K − (N − 1)。
 * 取 N = floor((T − 标题长 + 43)/31) 使 C ∈ [18, 49)。行按每页 28 条分组；
 * needle 行替换一条正文行（第 3 页首行，全局行号 56）。
 */
export function buildPdfPages(identity: MaterialIdentity): {
  pages: B6PdfLinePlan[][];
  needleIndex: number;
} {
  const rng = DeterministicRng.forStep(B6_SEED, `pdf:${identity.materialId}`);
  const titleLine: B6PdfLinePlan = { text: identity.title, size: B6_PDF_TITLE_FONT_SIZE };
  const totalLines = Math.floor((identity.units - titleLine.text.length + 43) / 31);
  const calibrationLength =
    identity.units - titleLine.text.length - B6_PDF_BODY_LINE_UNITS * (totalLines - 2) - (totalLines - 1);
  if (calibrationLength < 8 || calibrationLength > 60) {
    throw new Error(
      `b6-dataset: pdf ${identity.materialId} calibration length ${String(calibrationLength)} out of band (allocation bug)`,
    );
  }

  // 句子流（确定性）→ 精确 30 单元/行的正文行（行内任意断点，模拟折行）。
  let stream = "";
  const bodyLine = (): string => {
    while (stream.length < B6_PDF_BODY_LINE_UNITS) stream += sentence(rng);
    const line = stream.slice(0, B6_PDF_BODY_LINE_UNITS);
    stream = stream.slice(B6_PDF_BODY_LINE_UNITS);
    return line;
  };
  const needleLine = (() => {
    // 恰 30 单位、以唯一 needle 为核心的行。
    const head = "标记 ";
    const tailBudget = B6_PDF_BODY_LINE_UNITS - head.length - identity.needle.length;
    const tail = tailBudget > 0 ? ` 定位复习${"·".repeat(Math.max(0, tailBudget - 4))}` : "";
    return `${head}${identity.needle}${tail}`.slice(0, B6_PDF_BODY_LINE_UNITS);
  })();

  const lines: B6PdfLinePlan[] = [titleLine];
  for (let i = 1; i < totalLines - 1; i += 1) {
    lines.push(i === 56 ? { text: needleLine, size: B6_PDF_BODY_FONT_SIZE } : { text: bodyLine(), size: B6_PDF_BODY_FONT_SIZE });
  }
  lines.push({ text: calibrationText(`pdf-cal:${identity.materialId}`, calibrationLength), size: B6_PDF_BODY_FONT_SIZE });

  const pages: B6PdfLinePlan[][] = [];
  for (let i = 0; i < lines.length; i += B6_PDF_LINES_PER_PAGE) {
    pages.push(lines.slice(i, i + B6_PDF_LINES_PER_PAGE));
  }

  const canonical = buildPdfCanonicalText(pages);
  if (canonical.length !== identity.units) {
    throw new Error(
      `b6-dataset: pdf ${identity.materialId} canonical ${String(canonical.length)} != plan ${String(identity.units)}`,
    );
  }
  const needleIndex = canonical.indexOf(identity.needle);
  if (needleIndex < 0) {
    throw new Error(`b6-dataset: pdf ${identity.materialId} lost its needle`);
  }
  return { pages, needleIndex };
}
