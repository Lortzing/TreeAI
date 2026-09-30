/**
 * D4-6 性能 —— B6 冻结数据集的确定性生成引擎（规格实现面）。
 *
 * 权威规格：`tests/fixtures/d4/b6-scale/spec.json`（冻结；本模块实现该规格，
 * 绝不修改规格——修改=范围变更，须回负责人）。规格要点与实现映射：
 *
 *  - materials.count = 100（70 markdown + 30 pdf，pdf 由 scripts/d4 PDF 生成
 *    设施按固定内容模板确定性生成——见 scripts/d4/gen-b6-scale-dataset.mjs）；
 *  - totalCanonicalTextUnits = 1,000,000（全部材料 canonicalText 的 UTF-16
 *    码元之和，精确等于；单位分配冻结于 MATERIAL_UNIT_PLANS 派生规则）；
 *  - contentRule：中文/英文混合的真实感学习笔记；每份材料含唯一 needle
 *    （搜索目标）；≥10 份长文（≥5 万单元）——实现为 12 份（8 md × 52,000 +
 *    4 pdf × 51,000）；
 *  - savedFacts.count = 10,000：turn 6,000（3,000 组 user/assistant 对，按
 *    既有产品事实形态：episode/run/session 引用/assistant piEntryId）+
 *    annotation 2,500（锚定 assistant Turn、选区切片一致、sourceHash）+
 *    return 1,500（role="return" Turn + fromBranchId + 幂等键 + targetAnchor）；
 *    只生成已保存产品事实，不含草稿/缓存；
 *  - branches.count = 1,000：按「非根 Branch 共 1,000」实现（与 B9 的歧义
 *    解决同款——含 trunk 口径为 1,010 行，两种数法都满足规格；解决记录随
 *    D4-6 报告回写），分布于 10 棵树（dataset.trees 由本生成器定义，与
 *    b9 数据集相互独立、不同库）；
 *  - determinism：seed `d4-b6-2026-09-30`（spec.determinism.seed）；每个
 *    生成步骤/每条事实以 `seed+步骤名`/`seed+实体id` 初始化
 *    DeterministicRng（apps/studio/src/nav/deterministic-rng.ts——该模块
 *    文档即声明为 b6/b9 冻结规格的同规则实现）；禁止 Math.random() 与
 *    时间戳；同 seed 两次生成字节级恒等（CLI 双跑自验 + verify:d4 跨进程
 *    复核）。
 *
 * 本模块是纯数据/纯函数引擎（无 IO）：生成数据集计划（材料内容、树/分支
 * 结构、事实、冻结查询集）与结构真值（每份材料的期望 canonicalText、
 * needle 位置、PDF 页/行计划）。PDF 字节由 scripts/d4 PDF 生成设施从页/
 * 行计划构建（scripts/d4/gen-b6-scale-dataset.mjs CLI）；装载经真实仓储
 * API（tests/support/verifier/d4-b6-loader.ts）。
 *
 * 另含导入探针样例（spec.performanceProbes「import-10mib-100p」）的冻结
 * 配方：100 页、2,000 行/页、每行 4 单元的 songti 密排文字层，落盘
 * ≥10 MiB（且 ≤11 MiB）而 canonicalText ≤100 万单元（charter §5 单材料
 * 上限内）——短行密排是「10 MiB 文件 + ≤100 万单元」约束下最大化真实
 * 解析工作量的诚实实现（每一行都是真实 Tj + ToUnicode 映射，无填充字节）。
 */

import { createHash } from "node:crypto";

import { DeterministicRng } from "../../../apps/studio/src/nav/deterministic-rng.ts";

/* ------------------------------------------------------------------ */
/* 冻结常量（spec.json 的实现面）                                        */
/* ------------------------------------------------------------------ */

export const B6_SET_ID = "b6-scale";
export const B6_SEED = "d4-b6-2026-09-30";
export const B6_FOREST_ID = "b6-forest";

/** 材料：100 份 = 70 markdown + 30 pdf（spec.dataset.materials.composition）。 */
export const B6_MATERIAL_COUNT = 100;
export const B6_MARKDOWN_COUNT = 70;
export const B6_PDF_COUNT = 30;

/** 全部材料 canonicalText 的 UTF-16 码元总和（精确等于）。 */
export const B6_TOTAL_TEXT_UNITS = 1_000_000;

/** 长文：≥10 份 ≥5 万单元（实现 12 份：8 md × 52,000 + 4 pdf × 51,000）。 */
export const B6_LONG_MARKDOWN_COUNT = 8;
export const B6_LONG_MARKDOWN_UNITS = 52_000;
export const B6_LONG_PDF_COUNT = 4;
export const B6_LONG_PDF_UNITS = 51_000;

/** 保存事实：10,000 = 6,000 turn（3,000 组问答对）+ 2,500 annotation + 1,500 return。 */
export const B6_TURN_COUNT = 6_000;
export const B6_QA_PAIR_COUNT = 3_000;
export const B6_ANNOTATION_COUNT = 2_500;
export const B6_RETURN_COUNT = 1_500;

/** 树与分支：10 棵树 ×（1 trunk + 100 非根分支）= 1,000 非根 / 1,010 行。 */
export const B6_TREE_COUNT = 10;
export const B6_NON_TRUNK_BRANCHES_PER_TREE = 100;
export const B6_NON_TRUNK_BRANCH_COUNT = B6_TREE_COUNT * B6_NON_TRUNK_BRANCHES_PER_TREE;

/** 冻结查询集：50 条（spec performanceProbes search-p95：repetitions 50）。 */
export const B6_FROZEN_QUERY_COUNT = 50;

/** per-material 上限（charter §5；生成侧防御性复核）。 */
export const B6_PER_MATERIAL_MAX_UNITS = 1_000_000;
export const B6_PER_MATERIAL_MAX_PAGES = 200;
export const B6_PER_MATERIAL_MAX_BYTES = 20 * 1024 * 1024;

/** 装载确定性时钟纪元（与 b9 同款纪律：真实时间戳不进产品库）。 */
export const B6_EPOCH_MS = Date.parse("2026-09-30T00:00:00.000Z");

/** PDF 页面配方（语料 pdf；每页 28 行 × 30 单元正文 + 页首标题行）。 */
export const B6_PDF_LINES_PER_PAGE = 28;
export const B6_PDF_BODY_LINE_UNITS = 30;
export const B6_PDF_BODY_FONT_SIZE = 10.5;
export const B6_PDF_TITLE_FONT_SIZE = 15;
export const B6_PDF_LINE_STEP = 17;
export const B6_PDF_TOP_Y = 760;
export const B6_PDF_X = 72;

/** 导入样例配方（10 MiB / 100 页；见文件头「导入探针样例」段）。 */
export const B6_SAMPLE_FILENAME = "b6-import-sample.pdf";
export const B6_SAMPLE_PAGES = 100;
export const B6_SAMPLE_LINES_PER_PAGE = 2_000;
export const B6_SAMPLE_LINE_UNITS = 4;
export const B6_SAMPLE_MIN_BYTES = 10 * 1024 * 1024; // 10 MiB（含）
export const B6_SAMPLE_MAX_BYTES = 11 * 1024 * 1024; // 11 MiB（不含上限——留确定性余量）

/* ------------------------------------------------------------------ */
/* 类型（数据集计划的序列化形状）                                        */
/* ------------------------------------------------------------------ */

export type B6MaterialKind = "markdown" | "pdf";

/** markdown 材料：段落文本（源文件 = 段落以空行相接 + 单个尾随换行）。 */
export interface B6MarkdownMaterial {
  readonly kind: "markdown";
  readonly materialId: string;
  readonly versionId: string;
  readonly title: string;
  readonly filename: string;
  readonly treeId: string;
  /** 计划 canonicalText 单元数（精确）。 */
  readonly units: number;
  readonly needle: string;
  /** needle 在 canonicalText 内的 UTF-16 起始偏移（精确计算）。 */
  readonly needleIndex: number;
  /** 段落文本（canonical 段落，不含分隔空行）。 */
  readonly paragraphs: readonly string[];
}

/** PDF 材料：页/行计划（scripts/d4 PDF 设施按此构建字节）。 */
export interface B6PdfLinePlan {
  readonly text: string;
  readonly size: number;
}
export interface B6PdfMaterial {
  readonly kind: "pdf";
  readonly materialId: string;
  readonly versionId: string;
  readonly title: string;
  readonly filename: string;
  readonly treeId: string;
  readonly units: number;
  readonly needle: string;
  readonly needleIndex: number;
  /** 每页的行计划（行序 = 页内自上而下发射序 = 阅读序）。 */
  readonly pages: readonly (readonly B6PdfLinePlan[])[];
}

export type B6Material = B6MarkdownMaterial | B6PdfMaterial;

export interface B6Branch {
  readonly id: string;
  readonly parentId: string | null;
  readonly depth: number;
}

export interface B6Tree {
  readonly treeId: string;
  readonly trunkBranchId: string;
  readonly branches: readonly B6Branch[];
}

/** 问答对（user + assistant 两 Turn；同 branch 的对共享 episode/run）。 */
export interface B6QaPair {
  readonly pairIndex: number;
  readonly treeId: string;
  readonly branchId: string;
  readonly episodeId: string;
  readonly runId: string;
  readonly userTurnId: string;
  readonly assistantTurnId: string;
  readonly question: string;
  readonly answer: string;
}

export interface B6Annotation {
  readonly treeId: string;
  readonly branchId: string;
  readonly anchorTurnId: string;
  readonly selStart: number;
  readonly selEnd: number;
  readonly selText: string;
  readonly sourceHash: string;
  readonly term: string;
  readonly explanation: string;
}

export interface B6Return {
  readonly treeId: string;
  readonly branchId: string;
  readonly returnTurnId: string;
  readonly fromBranchId: string;
  readonly idempotencyKey: string;
  readonly text: string;
  readonly anchorTurnId: string;
  readonly anchorEntryId: string;
  readonly selStart: number;
  readonly selEnd: number;
  readonly selText: string;
}

export interface B6Totals {
  readonly materials: number;
  readonly markdownMaterials: number;
  readonly pdfMaterials: number;
  readonly totalTextUnits: number;
  readonly longMaterials: number;
  readonly trees: number;
  readonly branchRows: number;
  readonly nonTrunkBranches: number;
  readonly qaPairs: number;
  readonly turnFacts: number;
  readonly annotationFacts: number;
  readonly returnFacts: number;
  readonly savedFacts: number;
}

export interface B6Dataset {
  readonly version: 1;
  readonly setId: typeof B6_SET_ID;
  readonly seed: string;
  readonly forestId: string;
  readonly materials: readonly B6Material[];
  readonly trees: readonly B6Tree[];
  readonly qaPairs: readonly B6QaPair[];
  readonly annotations: readonly B6Annotation[];
  readonly returns: readonly B6Return[];
  readonly totals: B6Totals;
}

/** 冻结查询集条目（由 needles 派生；期望命中材料一并冻结）。 */
export interface B6FrozenQuery {
  readonly text: string;
  readonly expectedMaterialId: string;
  readonly expectedNeedleIndex: number;
}

export interface B6MaterialStats {
  readonly materialId: string;
  readonly kind: B6MaterialKind;
  readonly filename: string;
  readonly units: number;
  readonly pages: number;
  readonly blocks: number;
  readonly needleIndex: number;
  readonly canonicalSha256: string;
}

export interface B6Manifest {
  readonly version: 1;
  readonly setId: typeof B6_SET_ID;
  readonly seed: string;
  readonly truthSha256: string;
  readonly truthBytes: number;
  readonly materials: readonly B6MaterialStats[];
  readonly totals: B6Totals;
}

/* ------------------------------------------------------------------ */
/* 词表与句式模板（中英混排真实感学习笔记；全部 BMP、Songti 可覆盖）      */
/* ------------------------------------------------------------------ */

const TOPICS_ZH = [
  "贝叶斯推断", "光合作用", "唐代诗歌意象", "城市交通规划", "量子纠缠",
  "统计机器翻译", "古罗马道路", "湿地生态系统", "神经可塑性", "文艺复兴透视法",
  "算法复杂度", "板块构造", "茶汤风味化学", "明代漕运", "概率图模型",
  "宋代货币史", "湿地碳循环", "机器学习评估", "古文献校勘", "河口泥沙输运",
] as const;

const TOPICS_EN = [
  "Bayesian inference", "photosynthesis", "Tang poetry imagery", "urban transit",
  "quantum entanglement", "statistical machine translation", "Roman roads",
  "wetland ecosystems", "neural plasticity", "Renaissance perspective",
  "algorithm complexity", "plate tectonics", "tea flavor chemistry",
  "Ming grain transport", "probabilistic graphical models", "Song dynasty coinage",
  "wetland carbon cycling", "model evaluation", "textual criticism", "estuary sediment",
] as const;

const ASPECTS_ZH = [
  "入门路径", "核心疑问", "对比实验", "历史脉络", "常见误解", "延伸问题",
  "实践笔记", "关键反例", "复习要点", "方法论辨析", "适用边界", "证据等级",
] as const;

const VERBS = ["建立", "检验", "记录", "对比", "拆解", "复核", "归纳", "追问"] as const;
const OBJECTS_ZH = [
  "主干问题", "边界条件", "反例清单", "证据链", "前提假设", "术语定义",
  "量级估计", "失败模式", "复习间隔", "交叉验证",
] as const;

/** 单句模板（确定性句式族；单位量级 20–70）。 */
function sentence(rng: DeterministicRng): string {
  const zh = rng.pick(TOPICS_ZH);
  const en = rng.pick(TOPICS_EN);
  const aspect = rng.pick(ASPECTS_ZH);
  const verb = rng.pick(VERBS);
  const obj = rng.pick(OBJECTS_ZH);
  switch (rng.int(0, 7)) {
    case 0:
      return `学习${zh}时，${aspect}要求先${verb}${obj}，再谈细节；${en} gives the same lesson from another angle.`;
    case 1:
      return `${zh}的${aspect}里最常见的误解，是把相关当因果；复习时应专门准备一个反例并写清它推翻的是哪一步。`;
    case 2:
      return `对照${en}的表述回看${zh}：两套语言各自强调什么、省略什么，正是${aspect}要回答的问题。`;
    case 3:
      return `笔记先${verb}${obj}，再把${zh}的${aspect}放回主干；细节只有挂在主干上才留得住。`;
    case 4:
      return `把${aspect}写成问题而不是结论：${zh}在什么条件下成立？证据来自哪类${obj}？`;
    case 5:
      return `间隔复习${zh}：第一次只核对${obj}是否仍然成立，第二次才展开${aspect}的细节推导。`;
    case 6:
      return `${en} literature treats this as settled; the interesting question for ${zh} is where its ${aspect} breaks.`;
    default:
      return `凡引入新术语，先写一句话定义再${verb}${obj}——${zh}的${aspect}尤其如此。`;
  }
}

/** 段落（3–5 句；句式模板单句 ≤~95 单元，段落因此 ≤~475 单元）。 */
function paragraph(rng: DeterministicRng, sentenceCount: number): string {
  const parts: string[] = [];
  for (let i = 0; i < sentenceCount; i += 1) parts.push(sentence(rng));
  return parts.join("");
}

/** 标定文本：精确 remaining 单元的确定性收尾（重复短语裁到精确长度）。 */
const CALIBRATION_FILLER = "把每一步的依据写回主干问题，边界条件逐一列清；";
function calibrationText(seedStep: string, remaining: number): string {
  if (remaining < 8) {
    // 极短余量：以「要点 + 数字」短语填满（仍为非空行）。
    return `要点${String(remaining).padStart(2, "0")}`.slice(0, remaining);
  }
  const rng = DeterministicRng.forStep(B6_SEED, seedStep);
  let text = `${rng.pick(TOPICS_ZH)}的收束：`;
  while (text.length + CALIBRATION_FILLER.length <= remaining) text += CALIBRATION_FILLER;
  if (text.length < remaining) {
    text += CALIBRATION_FILLER.slice(0, remaining - text.length);
  }
  return text.slice(0, remaining);
}

/** 唯一 needle（模板永不产出；跨语料唯一性由不变量复核）。 */
export function b6Needle(materialIndex: number): string {
  return `【针标B6-${String(materialIndex).padStart(3, "0")}】`;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/* ------------------------------------------------------------------ */
/* 单位分配（冻结规则；总和精确 1,000,000）                              */
/* ------------------------------------------------------------------ */

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
  const base = Math.floor((B6_TOTAL_TEXT_UNITS - 416_000 - 204_000) / 88); // 4,318
  const remainder = B6_TOTAL_TEXT_UNITS - 416_000 - 204_000 - base * 88; // 16
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

interface MaterialIdentity {
  readonly materialId: string;
  readonly versionId: string;
  readonly title: string;
  readonly filename: string;
  readonly treeId: string;
  readonly units: number;
  readonly needle: string;
}

function materialIdentity(index: number): MaterialIdentity {
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
function buildMarkdownParagraphs(identity: MaterialIdentity): {
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
function buildPdfPages(identity: MaterialIdentity): {
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

/* ------------------------------------------------------------------ */
/* 树结构（10 棵 × trunk + 100 非根；确定性形状）                        */
/* ------------------------------------------------------------------ */

function buildTrees(): B6Tree[] {
  const trees: B6Tree[] = [];
  for (let t = 1; t <= B6_TREE_COUNT; t += 1) {
    const treeId = `b6-t${pad(t, 2)}`;
    const trunkId = `${treeId}-trunk`;
    const rng = DeterministicRng.forStep(B6_SEED, `tree:${treeId}`);
    const branches: B6Branch[] = [{ id: trunkId, parentId: null, depth: 0 }];
    // 主脊柱：长度 6..10（t 决定），其余节点在深度上限内确定性挂靠。
    const spineLength = 6 + (t % 5);
    const maxDepth = 4 + (t % 4); // 4..7
    const byId = new Map<string, B6Branch>([[trunkId, branches[0]!]]);
    let spineParent = trunkId;
    for (let s = 1; s <= spineLength; s += 1) {
      const id = `${treeId}-n${pad(s, 3)}`;
      const parent = byId.get(spineParent)!;
      const branch: B6Branch = { id, parentId: spineParent, depth: parent.depth + 1 };
      branches.push(branch);
      byId.set(id, branch);
      spineParent = id;
    }
    let seq = branches.length;
    while (branches.length < 1 + B6_NON_TRUNK_BRANCHES_PER_TREE) {
      // 在深度上限内的节点中确定性选父（重试 + 兜底，与 b9 普通树同款）。
      let parent: B6Branch | undefined;
      for (let attempt = 0; attempt < 16; attempt += 1) {
        const candidate = branches[rng.int(0, branches.length - 1)]!;
        if (candidate.depth < maxDepth) {
          parent = candidate;
          break;
        }
      }
      if (parent === undefined) {
        parent = branches.find((candidate) => candidate.depth < maxDepth);
      }
      if (parent === undefined) {
        throw new Error(`b6-dataset: ${treeId} exhausted parents below depth ${String(maxDepth)}`);
      }
      seq += 1;
      const id = `${treeId}-n${pad(seq, 3)}`;
      const branch: B6Branch = { id, parentId: parent.id, depth: parent.depth + 1 };
      branches.push(branch);
      byId.set(id, branch);
    }
    trees.push({ treeId, trunkBranchId: trunkId, branches });
  }
  return trees;
}

/** 展平的分支序（trunk 在首；事实分配的全局确定性顺序）。 */
function flattenBranches(trees: readonly B6Tree[]): B6Branch[] {
  const out: B6Branch[] = [];
  for (const tree of trees) out.push(...tree.branches);
  return out;
}

/* ------------------------------------------------------------------ */
/* 事实生成（3,000 问答对 + 2,500 批注 + 1,500 Return）                  */
/* ------------------------------------------------------------------ */

function questionText(pairIndex: number): string {
  const rng = DeterministicRng.forStep(B6_SEED, `q:${pad(pairIndex, 4)}`);
  const zh = rng.pick(TOPICS_ZH);
  const en = rng.pick(TOPICS_EN);
  const aspect = rng.pick(ASPECTS_ZH);
  switch (rng.int(0, 4)) {
    case 0:
      return `${zh}的${aspect}应该从哪个问题入手？`;
    case 1:
      return `帮我用三句话讲清${zh}里${aspect}的要点。`;
    case 2:
      return `${en} 与${zh}在${aspect}上的说法矛盾吗？`;
    case 3:
      return `复习${zh}时，${aspect}最容易错的地方是什么？`;
    default:
      return `把${zh}的${aspect}整理成一张自查清单，可以吗？`;
  }
}

function answerTextOf(pairIndex: number): string {
  const rng = DeterministicRng.forStep(B6_SEED, `a:${pad(pairIndex, 4)}`);
  const zh = rng.pick(TOPICS_ZH);
  const en = rng.pick(TOPICS_EN);
  const aspect = rng.pick(ASPECTS_ZH);
  return (
    `关于${zh}的${aspect}：先给结论的适用边界，再列证据与反例，最后回到原问题的表述检验是否已经回答完整。` +
    `${zh}与${en}的文献在这一点上结论一致——先建立主干，细节随后归位。` +
    `补充：${aspect}最常见的错误是把相关当因果；复习时应专门准备至少一个反例，并写清它推翻的是推理链的哪一步。` +
    `如果时间只够做一件事，就把${rng.pick(OBJECTS_ZH)}重写一遍——写不下去的地方就是没懂的地方。`
  );
}

function annotationText(index: number): { term: string; explanation: string } {
  const rng = DeterministicRng.forStep(B6_SEED, `anno:${pad(index, 4)}`);
  const zh = rng.pick(TOPICS_ZH);
  const aspect = rng.pick(ASPECTS_ZH);
  const term = `${zh}·${aspect}`;
  return {
    term,
    explanation: `批注「${term}」：在${zh}的语境里，${aspect}指先立主干再收细节的路径；与近义表述的差别在于它显式要求写出适用边界。`,
  };
}

function returnTextOf(index: number): string {
  const rng = DeterministicRng.forStep(B6_SEED, `ret:${pad(index, 4)}`);
  const zh = rng.pick(TOPICS_ZH);
  return `收获：${zh}的${rng.pick(ASPECTS_ZH)}要先写边界再列证据，反例至少备一个——写不下去处即未懂处。`;
}

/** 码点安全区间（选区不落在代理对中间；语料为 BMP，防御性保留）。 */
function codePointSafeRange(text: string, start: number, length: number): { start: number; end: number } {
  const maxStart = Math.max(0, text.length - length - 1);
  let s = Math.min(Math.max(0, start), maxStart);
  let e = Math.min(text.length, s + length);
  while (s > 0 && text.charCodeAt(s) >= 0xdc00 && text.charCodeAt(s) <= 0xdfff) s += 1;
  while (e < text.length && text.charCodeAt(e) >= 0xdc00 && text.charCodeAt(e) <= 0xdfff) e += 1;
  return { start: s, end: e };
}

function buildFacts(trees: readonly B6Tree[]): {
  qaPairs: B6QaPair[];
  annotations: B6Annotation[];
  returns: B6Return[];
} {
  const flat = flattenBranches(trees);

  // —— 问答对（3,000 组；branchIndex = pairIndex mod 分支总数）——
  const qaPairs: B6QaPair[] = [];
  for (let p = 0; p < B6_QA_PAIR_COUNT; p += 1) {
    const branch = flat[p % flat.length]!;
    qaPairs.push({
      pairIndex: p,
      treeId: branchIdToTreeId(branch.id),
      branchId: branch.id,
      episodeId: `b6-ep-${branch.id}`,
      runId: `b6-run-${branch.id}`,
      userTurnId: `b6-turn-u${pad(p, 4)}`,
      assistantTurnId: `b6-turn-a${pad(p, 4)}`,
      question: questionText(p),
      answer: answerTextOf(p),
    });
  }

  // 每分支一组 episode/run（承载其全部问答；会话引用为确定性合成——
  // 离线数据集，可用性按 available 记账，与 b9 装载纪律一致）。
  // —— 批注（2,500；锚定同分支 assistant Turn、选区切片一致）——
  const annotations: B6Annotation[] = [];
  for (let j = 0; j < B6_ANNOTATION_COUNT; j += 1) {
    const branch = flat[j % flat.length]!;
    const treeId = branchIdToTreeId(branch.id);
    const anchors = qaPairs
      .filter((pair) => pair.branchId === branch.id)
      .sort((a, b) => a.pairIndex - b.pairIndex);
    const round = Math.floor(j / flat.length);
    const anchor = anchors[round % anchors.length]!;
    const rng = DeterministicRng.forStep(B6_SEED, `anno-sel:${pad(j, 4)}`);
    const range = codePointSafeRange(
      anchor.answer,
      rng.int(0, Math.max(0, anchor.answer.length - 40)),
      rng.int(8, 24),
    );
    const { term, explanation } = annotationText(j);
    annotations.push({
      treeId,
      branchId: branch.id,
      anchorTurnId: anchor.assistantTurnId,
      selStart: range.start,
      selEnd: range.end,
      selText: anchor.answer.slice(range.start, range.end),
      sourceHash: sha256Hex(anchor.answer),
      term,
      explanation,
    });
  }

  // —— Return（1,500；落点分支 + fromBranch（同树内）+ 幂等键 + targetAnchor）——
  const returns: B6Return[] = [];
  const perTree = 1 + B6_NON_TRUNK_BRANCHES_PER_TREE;
  for (let r = 0; r < B6_RETURN_COUNT; r += 1) {
    const branchIndex = r % flat.length;
    const branch = flat[branchIndex]!;
    const treeId = branchIdToTreeId(branch.id);
    // from 分支与落点同树（产品语义：材料/子分支探索在同树内进行）；
    // 树内偏移确定性派生，避开落点自身。
    const treeStart = Math.floor(branchIndex / perTree) * perTree;
    const branchOffset = branchIndex - treeStart;
    let fromOffset = (r * 7 + 3) % perTree;
    if (fromOffset === branchOffset) fromOffset = (fromOffset + 1) % perTree;
    const fromBranch = flat[treeStart + fromOffset]!;
    const anchors = qaPairs
      .filter((pair) => pair.branchId === branch.id)
      .sort((a, b) => a.pairIndex - b.pairIndex);
    const round = Math.floor(r / flat.length);
    const anchor = anchors[round % anchors.length]!;
    const rng = DeterministicRng.forStep(B6_SEED, `ret-sel:${pad(r, 4)}`);
    const range = codePointSafeRange(
      anchor.answer,
      rng.int(0, Math.max(0, anchor.answer.length - 40)),
      rng.int(8, 24),
    );
    returns.push({
      treeId,
      branchId: branch.id,
      returnTurnId: `b6-turn-r${pad(r, 4)}`,
      fromBranchId: fromBranch.id,
      idempotencyKey: `b6-ret-${pad(r, 4)}`,
      text: returnTextOf(r),
      anchorTurnId: anchor.assistantTurnId,
      anchorEntryId: `${anchor.assistantTurnId}-entry`,
      selStart: range.start,
      selEnd: range.end,
      selText: anchor.answer.slice(range.start, range.end),
    });
  }

  return { qaPairs, annotations, returns };
}

/** 分支 id → 树 id（b6-tNN-nnnn → b6-tNN；构造性成立，防御性校验）。 */
function branchIdToTreeId(branchId: string): string {
  const match = /^(b6-t\d{2})-/.exec(branchId);
  if (match === null) {
    throw new Error(`b6-dataset: branch id ${branchId} does not follow the b6-tNN-* shape`);
  }
  return match[1]!;
}

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

/* ------------------------------------------------------------------ */
/* 导入样例（import-10mib-100p 冻结配方）                                */
/* ------------------------------------------------------------------ */

export interface B6ImportSamplePlan {
  readonly filename: string;
  readonly pages: readonly (readonly B6PdfLinePlan[])[];
  readonly expectedUnits: number;
  readonly expectedPages: number;
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

/* ------------------------------------------------------------------ */
/* 不变量（机械复核；返回问题清单，空 = 全部通过）                        */
/* ------------------------------------------------------------------ */

export function checkB6Invariants(dataset: B6Dataset): string[] {
  const problems: string[] = [];
  const push = (message: string): void => {
    problems.push(message);
  };

  // —— 材料总量与构成（spec.dataset.materials）——
  if (dataset.materials.length !== B6_MATERIAL_COUNT) {
    push(`materials: expected ${String(B6_MATERIAL_COUNT)}, got ${String(dataset.materials.length)}`);
  }
  const md = dataset.materials.filter((m) => m.kind === "markdown");
  const pdf = dataset.materials.filter((m) => m.kind === "pdf");
  if (md.length !== B6_MARKDOWN_COUNT) push(`markdown materials: ${String(md.length)} != ${String(B6_MARKDOWN_COUNT)}`);
  if (pdf.length !== B6_PDF_COUNT) push(`pdf materials: ${String(pdf.length)} != ${String(B6_PDF_COUNT)}`);
  if (dataset.totals.totalTextUnits !== B6_TOTAL_TEXT_UNITS) {
    push(`totalTextUnits: ${String(dataset.totals.totalTextUnits)} != ${String(B6_TOTAL_TEXT_UNITS)} (must be EXACT)`);
  }
  let unitsSeen = 0;
  for (const material of dataset.materials) {
    unitsSeen += material.units;
    if (material.units > B6_PER_MATERIAL_MAX_UNITS) {
      push(`material ${material.materialId}: ${String(material.units)} units > per-material cap`);
    }
    if (material.kind === "pdf" && material.pages.length > B6_PER_MATERIAL_MAX_PAGES) {
      push(`material ${material.materialId}: ${String(material.pages.length)} pages > 200-page cap`);
    }
    const canonical = b6MaterialCanonicalText(material);
    if (canonical.length !== material.units) {
      push(
        `material ${material.materialId}: canonical length ${String(canonical.length)} != plan ${String(material.units)}`,
      );
    }
    if (canonical.indexOf(material.needle) !== material.needleIndex || material.needleIndex < 0) {
      push(`material ${material.materialId}: needle index diverges from canonical text`);
    }
    if (canonical.indexOf(material.needle, material.needleIndex + 1) >= 0) {
      push(`material ${material.materialId}: needle appears more than once`);
    }
    for (const ch of material.needle) {
      if (ch.codePointAt(0)! > 0xffff) {
        push(`material ${material.materialId}: needle contains astral characters (needleIndex is UTF-16)`);
      }
    }
  }
  if (unitsSeen !== B6_TOTAL_TEXT_UNITS) {
    push(`summed units ${String(unitsSeen)} != ${String(B6_TOTAL_TEXT_UNITS)}`);
  }
  const long = dataset.materials.filter((m) => m.units >= 50_000);
  if (long.length < 10) {
    push(`long materials (>=50k units): ${String(long.length)} < 10`);
  }

  // —— needle 跨语料唯一 ——
  const needleCounts = new Map<string, number>();
  for (const material of dataset.materials) {
    needleCounts.set(material.needle, (needleCounts.get(material.needle) ?? 0) + 1);
  }
  for (const [needle, count] of needleCounts) {
    if (count > 1) push(`needle ${needle} used by ${String(count)} materials (must be unique)`);
  }
  // 事实文本不得包含任何 needle（否则查询集的期望命中被污染）。
  const allNeedles = dataset.materials.map((m) => m.needle);
  const factTexts = [
    ...dataset.qaPairs.flatMap((pair) => [pair.question, pair.answer]),
    ...dataset.annotations.map((a) => `${a.term}${a.explanation}${a.selText}`),
    ...dataset.returns.map((r) => r.text),
  ];
  for (let i = 0; i < factTexts.length; i += 1) {
    for (const needle of allNeedles) {
      if (factTexts[i]!.includes(needle)) {
        push(`fact #${String(i)} contains a material needle (query expectations polluted)`);
      }
    }
  }

  // —— 树/分支结构 ——
  if (dataset.trees.length !== B6_TREE_COUNT) push(`trees: ${String(dataset.trees.length)} != ${String(B6_TREE_COUNT)}`);
  const branchIds = new Set<string>();
  let nonTrunk = 0;
  for (const tree of dataset.trees) {
    if (tree.branches.length !== 1 + B6_NON_TRUNK_BRANCHES_PER_TREE) {
      push(`tree ${tree.treeId}: ${String(tree.branches.length)} branch rows`);
    }
    const localById = new Map<string, B6Branch>();
    for (const branch of tree.branches) {
      if (branchIds.has(branch.id)) push(`duplicate branch id ${branch.id}`);
      branchIds.add(branch.id);
      localById.set(branch.id, branch);
      if (branch.parentId === null) {
        if (branch.id !== tree.trunkBranchId) push(`tree ${tree.treeId}: non-trunk root ${branch.id}`);
      } else {
        nonTrunk += 1;
        const parent = localById.get(branch.parentId);
        if (parent === undefined) {
          push(`branch ${branch.id}: parent ${branch.parentId} not created before child`);
        } else if (branch.depth !== parent.depth + 1) {
          push(`branch ${branch.id}: depth ${String(branch.depth)} != parent depth + 1`);
        }
      }
    }
  }
  if (nonTrunk !== B6_NON_TRUNK_BRANCH_COUNT) {
    push(`non-trunk branches: ${String(nonTrunk)} != ${String(B6_NON_TRUNK_BRANCH_COUNT)}`);
  }
  if (dataset.totals.branchRows !== branchIds.size) {
    push(`totals.branchRows ${String(dataset.totals.branchRows)} != ${String(branchIds.size)}`);
  }

  // —— 保存事实（spec.dataset.savedFacts）——
  if (dataset.qaPairs.length !== B6_QA_PAIR_COUNT) {
    push(`qa pairs: ${String(dataset.qaPairs.length)} != ${String(B6_QA_PAIR_COUNT)}`);
  }
  if (dataset.totals.turnFacts !== B6_TURN_COUNT) {
    push(`turn facts: ${String(dataset.totals.turnFacts)} != ${String(B6_TURN_COUNT)}`);
  }
  if (dataset.annotations.length !== B6_ANNOTATION_COUNT) {
    push(`annotations: ${String(dataset.annotations.length)} != ${String(B6_ANNOTATION_COUNT)}`);
  }
  if (dataset.returns.length !== B6_RETURN_COUNT) {
    push(`returns: ${String(dataset.returns.length)} != ${String(B6_RETURN_COUNT)}`);
  }
  if (dataset.totals.savedFacts !== 10_000) {
    push(`saved facts: ${String(dataset.totals.savedFacts)} != 10000`);
  }
  const turnIds = new Set<string>();
  for (const pair of dataset.qaPairs) {
    turnIds.add(pair.userTurnId);
    turnIds.add(pair.assistantTurnId);
    if (!branchIds.has(pair.branchId)) push(`qa pair ${String(pair.pairIndex)} references unknown branch ${pair.branchId}`);
    if (pair.userTurnId.slice(-4) !== pair.assistantTurnId.slice(-4)) {
      push(`qa pair ${String(pair.pairIndex)} user/assistant turn ids diverge`);
    }
    if (pair.answer.length === 0 || pair.question.length === 0) {
      push(`qa pair ${String(pair.pairIndex)} has empty text`);
    }
  }
  if (turnIds.size !== B6_TURN_COUNT) push(`turn ids: ${String(turnIds.size)} distinct != ${String(B6_TURN_COUNT)}`);

  const answersByTurnId = new Map<string, string>(
    dataset.qaPairs.map((pair) => [pair.assistantTurnId, pair.answer] as const),
  );
  const pairByBranch = new Map<string, B6QaPair[]>();
  for (const pair of dataset.qaPairs) {
    const list = pairByBranch.get(pair.branchId) ?? [];
    list.push(pair);
    pairByBranch.set(pair.branchId, list);
  }
  for (let j = 0; j < dataset.annotations.length; j += 1) {
    const annotation = dataset.annotations[j]!;
    if (!branchIds.has(annotation.branchId)) {
      push(`annotation ${String(j)} references unknown branch ${annotation.branchId}`);
      continue;
    }
    const answer = answersByTurnId.get(annotation.anchorTurnId);
    if (answer === undefined) {
      push(`annotation ${String(j)} anchors unknown assistant turn ${annotation.anchorTurnId}`);
      continue;
    }
    const anchorPair = dataset.qaPairs.find((pair) => pair.assistantTurnId === annotation.anchorTurnId);
    if (anchorPair === undefined || anchorPair.branchId !== annotation.branchId) {
      push(`annotation ${String(j)} anchor turn is not on the annotation's branch`);
      continue;
    }
    if (answer.slice(annotation.selStart, annotation.selEnd) !== annotation.selText) {
      push(`annotation ${String(j)} selection does not slice-match the anchor answer`);
    }
    if (annotation.sourceHash !== sha256Hex(answer)) {
      push(`annotation ${String(j)} sourceHash != sha256(anchor answer)`);
    }
    if (annotation.selText.length === 0 || annotation.term.length === 0) {
      push(`annotation ${String(j)} has empty selection/term`);
    }
  }
  const idempotencyKeys = new Set<string>();
  for (let r = 0; r < dataset.returns.length; r += 1) {
    const item = dataset.returns[r]!;
    if (!branchIds.has(item.branchId) || !branchIds.has(item.fromBranchId)) {
      push(`return ${String(r)} references unknown branch`);
      continue;
    }
    if (item.branchId === item.fromBranchId) {
      push(`return ${String(r)} from-branch equals its landing branch`);
    }
    if (branchIdToTreeId(item.branchId) !== branchIdToTreeId(item.fromBranchId)) {
      // 产品语义：Return 落回同树主线（from 分支在同一树内探索）。
      push(`return ${String(r)} crosses trees (from ${item.fromBranchId} to ${item.branchId})`);
    }
    if (idempotencyKeys.has(item.idempotencyKey)) {
      push(`return ${String(r)} duplicate idempotency key ${item.idempotencyKey}`);
    }
    idempotencyKeys.add(item.idempotencyKey);
    const answer = answersByTurnId.get(item.anchorTurnId);
    if (answer === undefined) {
      push(`return ${String(r)} target anchor turn unknown`);
      continue;
    }
    const anchorPair = dataset.qaPairs.find((pair) => pair.assistantTurnId === item.anchorTurnId);
    if (anchorPair === undefined || anchorPair.branchId !== item.branchId) {
      push(`return ${String(r)} target anchor is not on the landing branch`);
      continue;
    }
    if (answer.slice(item.selStart, item.selEnd) !== item.selText) {
      push(`return ${String(r)} target selection does not slice-match the anchor answer`);
    }
  }

  // —— 冻结查询集 ——
  const queries = deriveB6FrozenQueries(dataset);
  if (queries.length !== B6_FROZEN_QUERY_COUNT) {
    push(`frozen queries: ${String(queries.length)} != ${String(B6_FROZEN_QUERY_COUNT)}`);
  }
  const queryTexts = new Set(queries.map((query) => query.text));
  if (queryTexts.size !== queries.length) push("frozen queries contain duplicates");

  // —— 导入样例（冻结配方边界）——
  const sample = generateB6ImportSamplePlan();
  if (sample.expectedPages !== B6_SAMPLE_PAGES) {
    push(`import sample pages: ${String(sample.expectedPages)} != ${String(B6_SAMPLE_PAGES)}`);
  }
  if (sample.expectedUnits > B6_PER_MATERIAL_MAX_UNITS) {
    push(`import sample units ${String(sample.expectedUnits)} > per-material cap`);
  }
  return problems;
}
