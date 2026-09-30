/**
 * D4-8 大规模树导航 —— B9 冻结数据集的确定性生成器（结构真值 + 装载载荷）。
 *
 * 权威规格：`tests/fixtures/d4/b9-nav/spec.json`（冻结；本模块实现该规格，
 * 绝不修改规格——修改=范围变更，须回负责人）。规格要点与实现映射：
 *
 *  - trees.count = 100：六棵特殊树（b9-big / b9-deep / b9-wide / b9-empty /
 *    b9-samename / b9-longtitle）+ 94 棵普通树；
 *  - trees.totalBranches = 10000：按「非根 Branch 节点共 10000」实现——每棵
 *    树在产品中必须有一条 trunk（根 Branch），trunk 不计入 10000；因此整库
 *    Branch 行数 = 10100，无论按「含 trunk」还是「不含 trunk」口径都满足
 *    B9 验收「总计 ≥10000 条 Branch」（歧义解决记录，随 D4-8 报告回写）；
 *  - b9-big：整树恰 5000 节点（含 trunk），广度优先生成，逐节点分支因子
 *    2–5 混合（最后一个展开节点截断到 5000，可有 1 个孩子）；
 *  - b9-deep：trunk 起一条 100 层深链（最深节点 depth=100，链共 101 节点，
 *    「根到叶 100 层」两种数法均满足），旁枝 10 条（挂于链上 depth 5..95，
 *    不加深最大深度）；
 *  - b9-wide：trunk 下 220 个直接子枝（≥200）+ 每 5 号子枝 1 个孙枝（44 个）；
 *  - b9-empty：仅 trunk，且 trunk 无任何 Turn（空树=从未提问，标题为 null）；
 *  - b9-samename：66 个完全同名 Branch（同一标题字符串）分布于 35 个不同
 *    父节点（30 个 depth-1 父 ×2、4 个 depth-3 父、trunk ×2），另设 4 个
 *    「同名+（续）」诱饵节点验证 exact 与 substring 的语义差；
 *  - b9-longtitle：120 个标题 ≥200 UTF-16 单元的节点（实现构造到 ≥240）；
 *  - 标题：中英混排模板派生（nodeTitle：主题×侧面×6 种句式）；trunk 标题
 *    即树标题——产品事实里 Tree 无标题列（trees 表只有 id/forest/createdAt），
 *    树标题=trunk 首个 user Turn 的文本（该歧义的解决记录随 D4-8 报告回写）；
 *  - sourceMix：部分 Branch 带 Turn 来源、部分带 Material 来源。分配规则
 *    （全局非根节点序号 g，从 1 起）：g%13===5 → Turn 来源；否则 g%29===11
 *    → Material 来源（约 7.7% / 3.4%，全部经真实来源表 + selection 纪律）；
 *  - 确定性：seed `d4-b9-2026-09-30`；每一步以 `seed+步骤名` 初始化
 *    DeterministicRng（xorshift128）；标题/回答/选区以 `seed+实体id` 独立
 *    派生（与生成顺序无关）；无 Math.random()、无时间戳——同一 seed 两次
 *    生成字节级相同（结构真值 JSON 的 SHA-256 恒等，测试与 runner 双验）。
 *
 * 结构真值（spec.determinism.outputRecording）：每节点 id、父 id、标题、
 * 深度、来源类型标记 + 完整父路径（parentPath：trunk→父的祖先 id 链），
 * 外加来源引用全字段（Turn：source/anchor/选区；Material：材料/版本/块/
 * 区间/摘录）与回答文本（Turn 来源锚点的装载载荷）。
 *
 * 材料来自「最小 md fixture」（spec.sourceMix 允许 b6 数据集或最小 md；
 * b6 生成器属 D4-6 未实现，本生成器内置 4 份确定性 markdown 材料，经
 * 真实 d4-md-v1 解析器取得 canonicalText + 块图，选区满足 ADR-003 §2
 * 锚定纪律：excerpt === canonicalText.slice(start,end)、区间含于块、
 * sourceHash === canonicalText SHA-256——由真实仓储在装载时再校验一遍）。
 */

import { createHash } from "node:crypto";
import { DeterministicRng } from "./deterministic-rng.ts";
import { parseMarkdownMaterial } from "../materials/markdown-parser.ts";

/* ------------------------------------------------------------------ */
/* 冻结常量（spec.json 的实现面）                                        */
/* ------------------------------------------------------------------ */

export const B9_SET_ID = "b9-nav";
export const B9_SEED = "d4-b9-2026-09-30";

export const B9_FOREST_ID = "b9-forest";

export const B9_BIG_TREE_ID = "b9-big";
export const B9_DEEP_TREE_ID = "b9-deep";
export const B9_WIDE_TREE_ID = "b9-wide";
export const B9_EMPTY_TREE_ID = "b9-empty";
export const B9_SAMENAME_TREE_ID = "b9-samename";
export const B9_LONGTITLE_TREE_ID = "b9-longtitle";

/** 全部非根 Branch 节点总数（trunk 之外；trunk 行另计 100）。 */
export const B9_TOTAL_NON_TRUNK_BRANCHES = 10000;
export const B9_TREE_COUNT = 100;

const BIG_TOTAL_NODES = 5000;
const DEEP_CHAIN_DEPTH = 100;
const DEEP_SIDE_BRANCHES = 10;
const WIDE_ROOT_CHILDREN = 220;
const WIDE_GRANDCHILDREN_STEP = 5;
const SAMENAME_PARENTS = 30;
const SAMENAME_PER_PARENT = 2;
const SAMENAME_DEPTH3 = 4;
const SAMENAME_UNDER_TRUNK = 2;
const SAMENAME_DECOYS = 4;
const LONGTITLE_NODES = 120;
const LONGTITLE_MIN_UTF16 = 200;
const LONGTITLE_BUILD_TARGET = 240;
const NORMAL_TREE_COUNT = 94;
const NORMAL_SIZE_MIN = 12;
const NORMAL_SIZE_MAX = 110;

/** Turn/Material 来源的全局分配规则（非根节点全局序号 g，从 1 起）。 */
const TURN_ORIGIN_MOD = 13;
const TURN_ORIGIN_REMAINDER = 5;
const MATERIAL_ORIGIN_MOD = 29;
const MATERIAL_ORIGIN_REMAINDER = 11;

/** b9-samename 全部同名节点共享的标题（完全相同字符串）。 */
export const B9_SAME_NAME_TITLE = "同名节点：重点回顾（Same-Name Review）";

/* ------------------------------------------------------------------ */
/* 类型（结构真值的序列化形状）                                          */
/* ------------------------------------------------------------------ */

export type B9OriginKind = "none" | "turn" | "material";

export interface B9OriginRefTurn {
  readonly kind: "turn";
  readonly sourceBranchId: string;
  readonly anchorTurnId: string;
  readonly anchorEntryId: string;
  readonly selStart: number;
  readonly selEnd: number;
  readonly selText: string;
}

export interface B9OriginRefMaterial {
  readonly kind: "material";
  readonly materialId: string;
  readonly versionId: string;
  readonly blockId: string;
  readonly start: number;
  readonly end: number;
  readonly excerpt: string;
}

export type B9OriginRef = B9OriginRefTurn | B9OriginRefMaterial;

export interface B9Node {
  readonly id: string;
  readonly parentId: string | null;
  /** 分支标题 = 该分支首个 user Turn 的文本（产品事实）；null = 无首问（b9-empty trunk）。 */
  readonly title: string | null;
  readonly depth: number;
  readonly originKind: B9OriginKind;
  /** 来源引用全字段；originKind === "none" 时为 null。 */
  readonly origin: B9OriginRef | null;
  /** 完整父路径：trunk→…→父 的祖先 id 链（不含本节点）；trunk 为空数组。 */
  readonly parentPath: readonly string[];
  /**
   * Turn 来源锚点所需的回答文本（该节点作为 source 时 assistant Turn 的
   * 全文）。仅 Turn 来源的 source 节点非 null；属结构真值的装载载荷。
   */
  readonly answerText: string | null;
}

export interface B9Tree {
  readonly treeId: string;
  readonly kind: "special" | "normal";
  /** 特殊树的规格规则描述（普通树为 null）。 */
  readonly rule: string | null;
  readonly title: string | null;
  readonly trunkBranchId: string;
  readonly nodes: readonly B9Node[];
}

export interface B9Material {
  readonly materialId: string;
  readonly versionId: string;
  readonly title: string;
  readonly filename: string;
  /** markdown 原文（UTF-8 装载字节由此派生；真实 d4-md-v1 解析）。 */
  readonly markdown: string;
}

export interface B9Totals {
  readonly trees: number;
  readonly specialTrees: number;
  readonly normalTrees: number;
  readonly branchRows: number;
  readonly nonTrunkBranches: number;
  readonly maxDepth: number;
  readonly turnOrigins: number;
  readonly materialOrigins: number;
  readonly titledNodes: number;
}

export interface B9Dataset {
  readonly version: 1;
  readonly setId: "b9-nav";
  readonly seed: string;
  readonly forestId: string;
  readonly materials: readonly B9Material[];
  readonly trees: readonly B9Tree[];
  readonly totals: B9Totals;
}

export interface B9TreeStats {
  readonly treeId: string;
  readonly kind: "special" | "normal";
  readonly rule: string | null;
  readonly nodes: number;
  readonly nonTrunkBranches: number;
  readonly maxDepth: number;
  readonly turnOrigins: number;
  readonly materialOrigins: number;
}

export interface B9Manifest {
  readonly version: 1;
  readonly setId: "b9-nav";
  readonly seed: string;
  readonly structureTruthSha256: string;
  readonly structureTruthBytes: number;
  readonly trees: readonly B9TreeStats[];
  readonly totals: B9Totals;
}

/* ------------------------------------------------------------------ */
/* 标题模板（中英混排派生）                                              */
/* ------------------------------------------------------------------ */

const TOPICS_ZH = [
  "概率图模型", "唐诗的意象", "光合作用", "城市交通规划", "贝叶斯推断",
  "宋代货币史", "量子纠缠", "统计机器翻译", "古罗马道路", "湿地生态系统",
  "神经可塑性", "文艺复兴透视法", "算法复杂度", "板块构造", "茶汤风味", "明代漕运",
] as const;

const TOPICS_EN = [
  "Bayesian inference", "Tang poetry imagery", "photosynthesis", "urban transit",
  "quantum entanglement", "statistical machine translation", "Roman roads",
  "wetland ecosystems", "neural plasticity", "Renaissance perspective",
  "algorithm complexity", "plate tectonics", "tea flavor", "Ming grain transport",
] as const;

const ASPECTS_ZH = [
  "入门路径", "核心疑问", "对比实验", "历史脉络", "常见误解",
  "延伸问题", "实践笔记", "关键反例", "复习要点", "方法论辨析",
] as const;

/** 普通节点标题：主题×侧面×句式（6 种，中英混排）。 */
function nodeTitle(rng: DeterministicRng, seq: number): string {
  const zh = rng.pick(TOPICS_ZH);
  const en = rng.pick(TOPICS_EN);
  const aspect = rng.pick(ASPECTS_ZH);
  switch (rng.int(0, 5)) {
    case 0:
      return `${zh}的${aspect}`;
    case 1:
      return `${en} — ${aspect}`;
    case 2:
      return `关于${zh}的${aspect}（${en}）`;
    case 3:
      return `Notes on ${en}: ${aspect}`;
    case 4:
      return `${aspect}·${zh}·第${seq}问`;
    default:
      return `${zh} × ${en}：${aspect}`;
  }
}

/** 特殊树 trunk 标题（即树标题）：模板派生的中英混排固定句式。 */
function specialTreeTitle(nameZh: string, nameEn: string): string {
  return `B9 特殊树·${nameZh}（${nameEn}）`;
}

const LONG_FILLER = "在方法与反例之间反复对照、把边界条件逐一列清，再把每一步的依据写回主干问题；";

/** 长标题：构造到 ≥240 UTF-16 单元（规格下限 200，留 20% 余量）。 */
function longTitle(rng: DeterministicRng, treeId: string, seq: number): string {
  const head = `长标题节点 ${treeId} 第${seq}号 Long-title node ${String(seq)}: `;
  let body = `围绕${rng.pick(TOPICS_ZH)}与${rng.pick(TOPICS_EN)}的${rng.pick(ASPECTS_ZH)}展开。`;
  while (head.length + body.length < LONGTITLE_BUILD_TARGET) {
    body += LONG_FILLER;
  }
  return head + body;
}

/** Turn 来源锚点的回答文本（作为 source 的分支的 assistant Turn 全文）。 */
function answerTextFor(rng: DeterministicRng, forTitle: string): string {
  const topic = rng.pick(TOPICS_ZH);
  const en = rng.pick(TOPICS_EN);
  let text = `关于「${forTitle}」的回答：${topic}与${en}的要点在于先建立主干再收集细节。`;
  text += "先给出结论的适用边界，再列证据与反例，最后回到原问题的表述检验是否已经回答完整。";
  text += `补充：${topic}里最常见的误解是把相关当因果，复习时应专门准备至少一个反例并写清它推翻的是哪一步。`;
  return text;
}

/* ------------------------------------------------------------------ */
/* 码点安全区间（选区不落在代理对中间；防御性——本数据集正文为 BMP）       */
/* ------------------------------------------------------------------ */

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** 在 text 内取长度约 length 的半开区间，边界移出代理对中间。 */
function codePointSafeRange(text: string, start: number, length: number): { start: number; end: number } {
  const maxStart = Math.max(0, text.length - length - 1);
  let s = Math.min(Math.max(0, start), maxStart);
  let e = Math.min(text.length, s + length);
  while (s > 0 && isLowSurrogate(text.charCodeAt(s))) s += 1;
  while (e < text.length && isLowSurrogate(text.charCodeAt(e))) e += 1;
  return { start: s, end: e };
}

/* ------------------------------------------------------------------ */
/* 材料（最小 md fixture；真实 d4-md-v1 解析取得 canonicalText/块图）     */
/* ------------------------------------------------------------------ */

interface MaterialSpec {
  readonly materialId: string;
  readonly title: string;
  readonly filename: string;
  readonly markdown: string;
}

const MATERIAL_SPECS: readonly MaterialSpec[] = [
  {
    materialId: "b9-mat-a",
    title: "B9 材料甲：学习方法论 Study methodology",
    filename: "b9-material-a.md",
    markdown: [
      "# B9 材料甲：学习方法论 Study methodology",
      "",
      "学习一门新学科的第一步是建立主干问题，而不是收集细节。The first step is a mainline question, not a pile of details.",
      "",
      "## 间隔重复 Spaced repetition",
      "",
      "间隔重复的核心是把复习安排在遗忘曲线的临界点上，让每次回忆都发生在即将遗忘之前。Spaced repetition schedules each review just before the forgetting threshold.",
      "",
      "## 主动回忆 Active recall",
      "",
      "主动回忆要求合上材料自我测试，而不是反复重读；重读制造熟悉感，回忆才暴露真实的掌握程度。Active recall means testing yourself with the material closed; re-reading only manufactures familiarity.",
      "",
      "## 交叉练习 Interleaving",
      "",
      "交叉练习把不同主题混排训练辨析能力，短期看更吃力，长期保留显著更好。Interleaving mixes topics to train discrimination; it feels harder but retains better.",
      "",
      "## 边界条件 Boundaries",
      "",
      "以上方法的前提是概念已经初步理解；对完全陌生的领域，先建立最小可用的主干框架再谈优化。These methods presuppose a first-pass understanding; build the smallest usable mainline first.",
      "",
    ].join("\n"),
  },
  {
    materialId: "b9-mat-b",
    title: "B9 材料乙：唐诗的意象 Tang imagery",
    filename: "b9-material-b.md",
    markdown: [
      "# B9 材料乙：唐诗的意象 Tang poetry imagery",
      "",
      "意象是诗人把外物转化为心境的枢纽：月不只是月，是归途的坐标。The image is the hinge where the poet turns outer things into inner weather.",
      "",
      "## 明月 The moon",
      "",
      "明月多用于思乡与怀人：举头见月，低头思故乡，月亮把远方折叠进同一片夜空。The moon folds a distant home into one shared night.",
      "",
      "## 长亭 The roadside pavilion",
      "",
      "长亭是送别的舞台，柳条是留下的请求，两者共同构成离别的仪式空间。The pavilion and the willow together stage the ritual of parting.",
      "",
      "## 大漠 The desert",
      "",
      "大漠孤烟与长河落日把边塞的空旷推向极致，孤独因此获得了几何学的秩序。Desert imagery gives loneliness a geometric order.",
      "",
      "## 意象的边界 Boundaries of imagery",
      "",
      "意象不能脱离诗题孤立解释：同一轮月在送别诗与田园诗中的指向并不相同。The same image points differently in farewell and pastoral poems.",
      "",
    ].join("\n"),
  },
  {
    materialId: "b9-mat-c",
    title: "B9 材料丙：贝叶斯推断 Bayesian reasoning",
    filename: "b9-material-c.md",
    markdown: [
      "# B9 材料丙：贝叶斯推断 Bayesian reasoning",
      "",
      "贝叶斯推断把信念的更新写成乘法：先验乘以证据的似然，再归一化为后验。Bayesian inference writes belief updates as multiplication: prior times likelihood, normalized.",
      "",
      "## 先验 The prior",
      "",
      "先验是见到证据之前的信念分布；它不必客观，但必须显式。The prior need not be objective, but it must be explicit.",
      "",
      "## 似然与证据 Likelihood and evidence",
      "",
      "似然刻画假设解释当前证据的能力，证据项把所有假设的贡献加总归一。Likelihood measures how well a hypothesis explains the data; the evidence normalizes across hypotheses.",
      "",
      "## 后验与迭代 Posterior and iteration",
      "",
      "今天的后验就是明天的先验，推断因此是一个持续的过程而非一次性计算。Today's posterior is tomorrow's prior; inference is a loop, not a single step.",
      "",
      "## 常见误用 Common misuse",
      "",
      "把后验概率当成假设为真的确定性，忽略先验敏感性与模型本身的不确定性，是初学者最常见的两个错误。Treating the posterior as certainty and ignoring prior sensitivity are the two classic mistakes.",
      "",
    ].join("\n"),
  },
  {
    materialId: "b9-mat-d",
    title: "B9 材料丁：湿地生态系统 Wetland ecosystems",
    filename: "b9-material-d.md",
    markdown: [
      "# B9 材料丁：湿地生态系统 Wetland ecosystems",
      "",
      "湿地是水文、土壤与生物三重过滤器的叠加：它减慢水流，沉淀营养物质，支撑高密度生物多样性。Wetlands stack hydrology, soil and biology into one living filter.",
      "",
      "## 水文节律 Hydrological rhythm",
      "",
      "丰水期与枯水期的交替决定了植被带状分布，节律的改变会重排整个群落。The flood-dry rhythm arranges the vegetation bands; changing it rearranges the community.",
      "",
      "## 碳汇功能 Carbon sink",
      "",
      "湿地土壤的缺氧环境减缓分解，使泥炭层成为长期的碳库；排水开垦会把碳库翻转为碳源。Anoxic peat locks carbon; drainage flips the sink into a source.",
      "",
      "## 指示物种 Indicator species",
      "",
      " indicator 物种对水质变化敏感，其出现与消失是生态系统健康的低成本读数。Indicator species are a cheap readout of ecosystem health.",
      "",
      "## 修复的边界 Limits of restoration",
      "",
      "修复可以恢复结构与部分功能，但原始群落的历史组合不可复制；修复目标应当显式分层。Restoration recovers structure and some function, never the original historical assemblage.",
      "",
    ].join("\n"),
  },
];

interface ParsedMaterial {
  readonly spec: MaterialSpec;
  readonly canonicalText: string;
  readonly blocks: ReadonlyArray<{ blockId: string; start: number; end: number }>;
}

function parseMaterialSpec(spec: MaterialSpec): ParsedMaterial {
  const bytes = new TextEncoder().encode(spec.markdown);
  const parsed = parseMarkdownMaterial(bytes);
  if (!parsed.ok) {
    throw new Error(`b9-dataset: built-in material ${spec.materialId} failed d4-md-v1 parse (${parsed.reason}): ${parsed.message}`);
  }
  return {
    spec,
    canonicalText: parsed.canonicalText,
    blocks: parsed.blocks.map((block) => ({ blockId: block.blockId, start: block.start, end: block.end })),
  };
}

/* ------------------------------------------------------------------ */
/* 生成过程中的可变工作形状（终结时冻结为 B9Node/B9Tree）                 */
/* ------------------------------------------------------------------ */

interface WorkingNode {
  id: string;
  parentId: string | null;
  title: string | null;
  depth: number;
  parentPath: string[];
  answerText: string | null;
  originKind: B9OriginKind;
  origin: B9OriginRef | null;
}

interface WorkingTree {
  treeId: string;
  kind: "special" | "normal";
  rule: string | null;
  nodes: WorkingNode[];
}

function workingNode(id: string, parent: WorkingNode | null, title: string | null): WorkingNode {
  return {
    id,
    parentId: parent === null ? null : parent.id,
    title,
    depth: parent === null ? 0 : parent.depth + 1,
    parentPath: parent === null ? [] : [...parent.parentPath, parent.id],
    answerText: null,
    originKind: "none",
    origin: null,
  };
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/* ------------------------------------------------------------------ */
/* 六棵特殊树                                                           */
/* ------------------------------------------------------------------ */

function buildBigTree(): WorkingTree {
  const rng = DeterministicRng.forStep(B9_SEED, "b9-big");
  const treeId = B9_BIG_TREE_ID;
  const nodes: WorkingNode[] = [
    workingNode(`${treeId}-trunk`, null, specialTreeTitle("广度优先大树", "Mixed-branching BFS tree")),
  ];
  // 广度优先：nodes 数组即 BFS 队列；逐节点分支因子 2–5，整树截断在 5000。
  let cursor = 0;
  let seq = 0;
  while (nodes.length < BIG_TOTAL_NODES) {
    const parent = nodes[cursor]!;
    const factor = rng.int(2, 5);
    for (let k = 0; k < factor && nodes.length < BIG_TOTAL_NODES; k += 1) {
      seq += 1;
      nodes.push(workingNode(`${treeId}-n${pad(seq, 4)}`, parent, nodeTitle(rng, seq)));
    }
    cursor += 1;
  }
  return { treeId, kind: "special", rule: "单棵 5000 节点树（广度优先生成，分支因子混合 2–5）", nodes };
}

function buildDeepTree(): WorkingTree {
  const rng = DeterministicRng.forStep(B9_SEED, "b9-deep");
  const treeId = B9_DEEP_TREE_ID;
  const nodes: WorkingNode[] = [
    workingNode(`${treeId}-trunk`, null, specialTreeTitle("一百层深链", "100-level deep chain")),
  ];
  const chain: WorkingNode[] = [nodes[0]!];
  for (let depth = 1; depth <= DEEP_CHAIN_DEPTH; depth += 1) {
    const node = workingNode(`${treeId}-c${pad(depth, 3)}`, chain[depth - 1]!, nodeTitle(rng, depth));
    chain.push(node);
    nodes.push(node);
  }
  // 少量旁枝：挂在链上 depth 5,15,…,95 的节点下（每处 1 条，单节点叶子），
  // 不超过链深 100。
  for (let k = 1; k <= DEEP_SIDE_BRANCHES; k += 1) {
    const chainDepth = k * 10 - 5; // 5, 15, …, 95
    const anchor = chain[chainDepth]!;
    nodes.push(workingNode(`${treeId}-s${pad(k, 2)}`, anchor, nodeTitle(rng, 1000 + k)));
  }
  return { treeId, kind: "special", rule: "100 层深链（一条根到叶 100 层的链，可带少量旁枝）", nodes };
}

function buildWideTree(): WorkingTree {
  const rng = DeterministicRng.forStep(B9_SEED, "b9-wide");
  const treeId = B9_WIDE_TREE_ID;
  const trunk = workingNode(`${treeId}-trunk`, null, specialTreeTitle("宽树", "Wide tree"));
  const nodes: WorkingNode[] = [trunk];
  const rootChildren: WorkingNode[] = [];
  for (let i = 1; i <= WIDE_ROOT_CHILDREN; i += 1) {
    const node = workingNode(`${treeId}-w${pad(i, 3)}`, trunk, nodeTitle(rng, i));
    rootChildren.push(node);
    nodes.push(node);
  }
  for (let i = WIDE_GRANDCHILDREN_STEP; i <= WIDE_ROOT_CHILDREN; i += WIDE_GRANDCHILDREN_STEP) {
    const parent = rootChildren[i - 1]!;
    nodes.push(workingNode(`${treeId}-g${pad(i / WIDE_GRANDCHILDREN_STEP, 2)}`, parent, nodeTitle(rng, 500 + i)));
  }
  return {
    treeId,
    kind: "special",
    rule: "宽树：根下 ≥200 个直接子枝",
    nodes,
  };
}

function buildEmptyTree(): WorkingTree {
  const treeId = B9_EMPTY_TREE_ID;
  // 空树：仅 trunk，且无任何 Turn——标题为 null（诚实呈现，不伪造标题）。
  const nodes: WorkingNode[] = [workingNode(`${treeId}-trunk`, null, null)];
  return { treeId, kind: "special", rule: "空树（仅 trunk）", nodes };
}

function buildSamenameTree(): WorkingTree {
  const rng = DeterministicRng.forStep(B9_SEED, "b9-samename");
  const treeId = B9_SAMENAME_TREE_ID;
  const trunk = workingNode(`${treeId}-trunk`, null, specialTreeTitle("同名节点树", "Same-name branches"));
  const nodes: WorkingNode[] = [trunk];
  const parents: WorkingNode[] = [];
  for (let p = 1; p <= SAMENAME_PARENTS; p += 1) {
    const node = workingNode(`${treeId}-p${pad(p, 2)}`, trunk, nodeTitle(rng, p));
    parents.push(node);
    nodes.push(node);
  }
  // trunk 下的直接同名子枝（父 = trunk）。
  for (let k = 1; k <= SAMENAME_UNDER_TRUNK; k += 1) {
    nodes.push(workingNode(`${treeId}-same-root-${k}`, trunk, B9_SAME_NAME_TITLE));
  }
  // 每个父下 2 个同名子枝（depth 2）。
  const depth2: WorkingNode[] = [];
  for (const parent of parents) {
    for (let k = 1; k <= SAMENAME_PER_PARENT; k += 1) {
      const node = workingNode(`${treeId}-same-${parent.id.slice(-2)}-${k}`, parent, B9_SAME_NAME_TITLE);
      depth2.push(node);
      nodes.push(node);
    }
  }
  // 4 个 depth-3 同名孙枝（挂在同名节点之下——同名节点自身也可作父）。
  for (let k = 1; k <= SAMENAME_DEPTH3; k += 1) {
    const anchor = depth2[(k - 1) * SAMENAME_PER_PARENT]!;
    nodes.push(workingNode(`${treeId}-same-d3-${k}`, anchor, B9_SAME_NAME_TITLE));
  }
  // 4 个诱饵：同名标题 + 「（续）」——exact 不得命中，substring 命中。
  for (let k = 1; k <= SAMENAME_DECOYS; k += 1) {
    const anchor = parents[SAMENAME_PARENTS - SAMENAME_DECOYS + k - 1]!;
    nodes.push(workingNode(`${treeId}-decoy-${k}`, anchor, `${B9_SAME_NAME_TITLE}（续）`));
  }
  return { treeId, kind: "special", rule: "同名节点树：≥50 个同名 Branch 分布在不同父下", nodes };
}

function buildLongtitleTree(): WorkingTree {
  const rng = DeterministicRng.forStep(B9_SEED, "b9-longtitle");
  const treeId = B9_LONGTITLE_TREE_ID;
  const trunk = workingNode(`${treeId}-trunk`, null, specialTreeTitle("长标题树", "Long titles"));
  const nodes: WorkingNode[] = [trunk];
  let seq = 0;
  const spine: WorkingNode[] = [];
  let spineParent: WorkingNode = trunk;
  for (let k = 1; k <= 20; k += 1) {
    seq += 1;
    const node = workingNode(`${treeId}-spine-${pad(k, 2)}`, spineParent, longTitle(rng, treeId, seq));
    spine.push(node);
    nodes.push(node);
    spineParent = node;
  }
  // trunk 的 20 个直接子枝（depth 1）。
  for (let k = 1; k <= 20; k += 1) {
    seq += 1;
    nodes.push(workingNode(`${treeId}-bush-${pad(k, 2)}`, trunk, longTitle(rng, treeId, seq)));
  }
  // 每个脊柱节点 4 个子枝（depth 2..21）。
  for (const parent of spine) {
    for (let k = 1; k <= 4; k += 1) {
      seq += 1;
      nodes.push(workingNode(`${treeId}-leaf-${parent.id.slice(-2)}-${k}`, parent, longTitle(rng, treeId, seq)));
    }
  }
  const nonTrunk = nodes.length - 1;
  if (nonTrunk !== LONGTITLE_NODES) {
    throw new Error(`b9-dataset: b9-longtitle built ${String(nonTrunk)} non-trunk nodes, expected ${String(LONGTITLE_NODES)}`);
  }
  return { treeId, kind: "special", rule: "长标题树：≥100 个标题长度 ≥200 字符的节点", nodes };
}

/* ------------------------------------------------------------------ */
/* 94 棵普通树（规模合计把非根节点补足到 10000）                         */
/* ------------------------------------------------------------------ */

function planNormalTreeSizes(): number[] {
  const rng = DeterministicRng.forStep(B9_SEED, "normal-sizes");
  // 基线：4407 ÷ 94 → 83 棵 47 + 11 棵 46（由特殊树规模反推，见 buildDataset）。
  const specialNonTrunk =
    (BIG_TOTAL_NODES - 1) +
    (DEEP_CHAIN_DEPTH + DEEP_SIDE_BRANCHES) +
    (WIDE_ROOT_CHILDREN + WIDE_ROOT_CHILDREN / WIDE_GRANDCHILDREN_STEP) +
    0 +
    (SAMENAME_PARENTS + SAMENAME_UNDER_TRUNK + SAMENAME_PARENTS * SAMENAME_PER_PARENT + SAMENAME_DEPTH3 + SAMENAME_DECOYS) +
    LONGTITLE_NODES;
  const remaining = B9_TOTAL_NON_TRUNK_BRANCHES - specialNonTrunk;
  const base = Math.floor(remaining / NORMAL_TREE_COUNT);
  let extra = remaining - base * NORMAL_TREE_COUNT;
  const sizes: number[] = [];
  for (let i = 0; i < NORMAL_TREE_COUNT; i += 1) {
    let size = base;
    if (extra > 0) {
      size += 1;
      extra -= 1;
    }
    sizes.push(size);
  }
  // 确定性抖动：在 [12,110] 界内成对搬运，总量不变。
  for (let step = 0; step < 220; step += 1) {
    const i = rng.int(0, sizes.length - 1);
    const j = rng.int(0, sizes.length - 1);
    if (i === j) continue;
    const move = rng.int(1, 15);
    if (sizes[i]! - move >= NORMAL_SIZE_MIN && sizes[j]! + move <= NORMAL_SIZE_MAX) {
      sizes[i]! -= move;
      sizes[j]! += move;
    }
  }
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total !== remaining) {
    throw new Error(`b9-dataset: normal tree sizes sum to ${String(total)}, expected ${String(remaining)}`);
  }
  return sizes;
}

function buildNormalTree(index: number, size: number): WorkingTree {
  const treeId = `b9-tree-${pad(index, 2)}`;
  const rng = DeterministicRng.forStep(B9_SEED, `normal-tree-${treeId}`);
  const maxAllowedDepth = rng.int(3, 8);
  const nodes: WorkingNode[] = [workingNode(`${treeId}-trunk`, null, nodeTitle(rng, 0))];
  let seq = 0;
  while (nodes.length - 1 < size) {
    seq += 1;
    // 在深度上限内的节点中均匀选父；确定性重试 + 兜底（首个可行节点）。
    let parent: WorkingNode | null = null;
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const candidate = nodes[rng.int(0, nodes.length - 1)]!;
      if (candidate.depth < maxAllowedDepth) {
        parent = candidate;
        break;
      }
    }
    if (parent === null) {
      for (const candidate of nodes) {
        if (candidate.depth < maxAllowedDepth) {
          parent = candidate;
          break;
        }
      }
    }
    if (parent === null) {
      throw new Error(`b9-dataset: ${treeId} has no node below maxAllowedDepth ${String(maxAllowedDepth)}`);
    }
    nodes.push(workingNode(`${treeId}-n${pad(seq, 3)}`, parent, nodeTitle(rng, seq)));
  }
  return { treeId, kind: "normal", rule: null, nodes };
}

/* ------------------------------------------------------------------ */
/* 来源分配（Turn / Material；全局序号规则）                             */
/* ------------------------------------------------------------------ */

function assignOrigins(trees: readonly WorkingTree[], materials: readonly ParsedMaterial[]): void {
  // 回答文本以「seed+实体id」独立派生，与遍历顺序无关（确定性可独立复算）。
  const answerFor = (node: WorkingNode): string => {
    if (node.answerText === null) {
      const rng = DeterministicRng.forStep(B9_SEED, `answer:${node.id}`);
      node.answerText = answerTextFor(rng, node.title ?? node.id);
    }
    return node.answerText;
  };

  let g = 0;
  for (const tree of trees) {
    const byId = new Map<string, WorkingNode>(tree.nodes.map((node) => [node.id, node]));
    for (const node of tree.nodes) {
      if (node.parentId === null) continue; // trunk 无来源
      g += 1;
      if (g % TURN_ORIGIN_MOD === TURN_ORIGIN_REMAINDER) {
        const parent = byId.get(node.parentId)!;
        const answer = answerFor(parent);
        const rng = DeterministicRng.forStep(B9_SEED, `origin-sel:${node.id}`);
        const range = codePointSafeRange(answer, rng.int(0, Math.max(0, answer.length - 32)), 24);
        node.originKind = "turn";
        node.origin = {
          kind: "turn",
          sourceBranchId: parent.id,
          anchorTurnId: `${parent.id}-a1`,
          anchorEntryId: `${parent.id}-a1-entry`,
          selStart: range.start,
          selEnd: range.end,
          selText: answer.slice(range.start, range.end),
        };
      } else if (g % MATERIAL_ORIGIN_MOD === MATERIAL_ORIGIN_REMAINDER) {
        const rng = DeterministicRng.forStep(B9_SEED, `origin-mat:${node.id}`);
        const material = rng.pick(materials);
        const block = rng.pick(material.blocks);
        const blockText = material.canonicalText.slice(block.start, block.end);
        const range = codePointSafeRange(blockText, rng.int(0, Math.max(0, blockText.length - 32)), 24);
        const start = block.start + range.start;
        const end = start + (range.end - range.start);
        node.originKind = "material";
        node.origin = {
          kind: "material",
          materialId: material.spec.materialId,
          versionId: `${material.spec.materialId}-v1`,
          blockId: block.blockId,
          start,
          end,
          excerpt: material.canonicalText.slice(start, end),
        };
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 生成主入口                                                           */
/* ------------------------------------------------------------------ */

function freezeTree(tree: WorkingTree): B9Tree {
  const nodes: B9Node[] = tree.nodes.map((node) => ({
    id: node.id,
    parentId: node.parentId,
    title: node.title,
    depth: node.depth,
    originKind: node.originKind,
    origin: node.origin,
    parentPath: node.parentPath,
    answerText: node.answerText,
  }));
  return {
    treeId: tree.treeId,
    kind: tree.kind,
    rule: tree.rule,
    title: nodes[0]?.title ?? null,
    trunkBranchId: nodes[0]?.id ?? "",
    nodes,
  };
}

/** 生成完整 B9 数据集（纯函数：无 IO、无随机源、无时间——同 seed 字节级恒等）。 */
export function generateB9Dataset(): B9Dataset {
  const materials = MATERIAL_SPECS.map(parseMaterialSpec);
  const trees: WorkingTree[] = [
    buildBigTree(),
    buildDeepTree(),
    buildWideTree(),
    buildEmptyTree(),
    buildSamenameTree(),
    buildLongtitleTree(),
  ];
  const sizes = planNormalTreeSizes();
  sizes.forEach((size, index) => {
    trees.push(buildNormalTree(index + 1, size));
  });
  assignOrigins(trees, materials);

  const frozenTrees = trees.map(freezeTree);
  let branchRows = 0;
  let maxDepth = 0;
  let turnOrigins = 0;
  let materialOrigins = 0;
  let titledNodes = 0;
  for (const tree of frozenTrees) {
    branchRows += tree.nodes.length;
    for (const node of tree.nodes) {
      if (node.depth > maxDepth) maxDepth = node.depth;
      if (node.originKind === "turn") turnOrigins += 1;
      if (node.originKind === "material") materialOrigins += 1;
      if (node.title !== null) titledNodes += 1;
    }
  }
  const totals: B9Totals = {
    trees: frozenTrees.length,
    specialTrees: frozenTrees.filter((tree) => tree.kind === "special").length,
    normalTrees: frozenTrees.filter((tree) => tree.kind === "normal").length,
    branchRows,
    nonTrunkBranches: branchRows - frozenTrees.length,
    maxDepth,
    turnOrigins,
    materialOrigins,
    titledNodes,
  };
  return {
    version: 1,
    setId: B9_SET_ID,
    seed: B9_SEED,
    forestId: B9_FOREST_ID,
    materials: MATERIAL_SPECS.map((spec) => ({
      materialId: spec.materialId,
      versionId: `${spec.materialId}-v1`,
      title: spec.title,
      filename: spec.filename,
      markdown: spec.markdown,
    })),
    trees: frozenTrees,
    totals,
  };
}

/* ------------------------------------------------------------------ */
/* 序列化 + manifest                                                    */
/* ------------------------------------------------------------------ */

/** 结构真值 JSON（紧凑、键序固定——同一数据集字节级恒等）。 */
export function serializeB9Dataset(dataset: B9Dataset): string {
  return JSON.stringify(dataset);
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function buildB9Manifest(dataset: B9Dataset, structureTruthJson: string): B9Manifest {
  const trees: B9TreeStats[] = dataset.trees.map((tree) => {
    let maxDepth = 0;
    let turnOrigins = 0;
    let materialOrigins = 0;
    for (const node of tree.nodes) {
      if (node.depth > maxDepth) maxDepth = node.depth;
      if (node.originKind === "turn") turnOrigins += 1;
      if (node.originKind === "material") materialOrigins += 1;
    }
    return {
      treeId: tree.treeId,
      kind: tree.kind,
      rule: tree.rule,
      nodes: tree.nodes.length,
      nonTrunkBranches: tree.nodes.length - 1,
      maxDepth,
      turnOrigins,
      materialOrigins,
    };
  });
  return {
    version: 1,
    setId: B9_SET_ID,
    seed: dataset.seed,
    structureTruthSha256: sha256Hex(structureTruthJson),
    structureTruthBytes: Buffer.byteLength(structureTruthJson, "utf8"),
    trees,
    totals: dataset.totals,
  };
}

export function serializeB9Manifest(manifest: B9Manifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/* ------------------------------------------------------------------ */
/* 结构真值不变量（机械复核；返回问题清单，空 = 全部通过）                */
/* ------------------------------------------------------------------ */

export function checkB9Invariants(dataset: B9Dataset): string[] {
  const problems: string[] = [];
  const push = (message: string): void => {
    problems.push(message);
  };

  // —— 总量与树数 ——
  if (dataset.trees.length !== B9_TREE_COUNT) {
    push(`trees: expected ${String(B9_TREE_COUNT)}, got ${String(dataset.trees.length)}`);
  }
  if (dataset.totals.nonTrunkBranches !== B9_TOTAL_NON_TRUNK_BRANCHES) {
    push(`totals.nonTrunkBranches: expected ${String(B9_TOTAL_NON_TRUNK_BRANCHES)}, got ${String(dataset.totals.nonTrunkBranches)}`);
  }
  if (dataset.totals.branchRows !== B9_TREE_COUNT + B9_TOTAL_NON_TRUNK_BRANCHES) {
    push(`totals.branchRows: expected ${String(B9_TREE_COUNT + B9_TOTAL_NON_TRUNK_BRANCHES)}, got ${String(dataset.totals.branchRows)}`);
  }

  const treeIds = new Set<string>();
  const branchIds = new Set<string>();
  const byId = new Map<string, B9Node>();
  let nonTrunkSeen = 0;
  let sameNameNodes = 0;
  const sameNameParents = new Set<string>();
  let longTitleNodes = 0;

  for (const tree of dataset.trees) {
    if (treeIds.has(tree.treeId)) push(`duplicate tree id ${tree.treeId}`);
    treeIds.add(tree.treeId);
    if (tree.nodes.length === 0) {
      push(`tree ${tree.treeId} has no nodes`);
      continue;
    }
    const trunk = tree.nodes[0]!;
    if (trunk.parentId !== null) push(`tree ${tree.treeId}: nodes[0] (${trunk.id}) is not the trunk (parentId=${trunk.parentId})`);
    if (trunk.id !== tree.trunkBranchId) push(`tree ${tree.treeId}: trunkBranchId mismatch`);
    const roots = tree.nodes.filter((node) => node.parentId === null);
    if (roots.length !== 1) push(`tree ${tree.treeId}: expected exactly 1 root, got ${String(roots.length)}`);

    // 同树内 parent/深度/路径一致性 + id 全局唯一。
    const localById = new Map<string, B9Node>();
    for (const node of tree.nodes) {
      if (branchIds.has(node.id)) push(`duplicate branch id ${node.id}`);
      branchIds.add(node.id);
      localById.set(node.id, node);
      byId.set(node.id, node);
      if (node.parentId === null) {
        if (node.depth !== 0) push(`node ${node.id}: root with depth ${String(node.depth)}`);
        if (node.parentPath.length !== 0) push(`node ${node.id}: root with non-empty parentPath`);
      } else {
        nonTrunkSeen += 1;
        const parent = localById.get(node.parentId);
        if (parent === undefined) {
          push(`node ${node.id}: parent ${node.parentId} not found (or not created before child)`);
        } else {
          if (node.depth !== parent.depth + 1) {
            push(`node ${node.id}: depth ${String(node.depth)} !== parent depth + 1 (${String(parent.depth + 1)})`);
          }
          const expectedPath = [...parent.parentPath, parent.id];
          if (node.parentPath.length !== expectedPath.length || node.parentPath.some((id, i) => id !== expectedPath[i])) {
            push(`node ${node.id}: parentPath mismatch (expected ${expectedPath.join(">")})`);
          }
        }
      }
      if (node.originKind === "none" && node.origin !== null) {
        push(`node ${node.id}: originKind none but origin set`);
      }
      if (node.originKind !== "none" && node.origin === null) {
        push(`node ${node.id}: originKind ${node.originKind} but origin missing`);
      }
      if (node.origin?.kind === "turn") {
        const origin = node.origin;
        if (origin.sourceBranchId !== node.parentId) {
          push(`node ${node.id}: turn origin source ${origin.sourceBranchId} !== parent ${String(node.parentId)}`);
        }
        const source = byId.get(origin.sourceBranchId);
        if (source === undefined) {
          push(`node ${node.id}: turn origin source ${origin.sourceBranchId} unknown`);
        } else if (source.answerText === null) {
          push(`node ${node.id}: turn origin source ${origin.sourceBranchId} has no answerText`);
        } else if (
          origin.selStart < 0 || origin.selEnd > source.answerText.length || origin.selEnd <= origin.selStart ||
          source.answerText.slice(origin.selStart, origin.selEnd) !== origin.selText
        ) {
          push(`node ${node.id}: turn origin selection does not slice-match source answer`);
        }
      }
      if (node.origin?.kind === "material") {
        const origin = node.origin;
        const material = dataset.materials.find((m) => m.materialId === origin.materialId);
        if (material === undefined) {
          push(`node ${node.id}: material origin references unknown material ${origin.materialId}`);
        } else if (origin.versionId !== material.versionId) {
          push(`node ${node.id}: material origin version ${origin.versionId} !== ${material.versionId}`);
        } else {
          const parsed = parseMaterialSpec({
            materialId: material.materialId,
            title: material.title,
            filename: material.filename,
            markdown: material.markdown,
          });
          const block = parsed.blocks.find((b) => b.blockId === origin.blockId);
          if (block === undefined) {
            push(`node ${node.id}: material origin block ${origin.blockId} not in ${material.materialId}`);
          } else if (origin.start < block.start || origin.end > block.end) {
            push(`node ${node.id}: material origin range outside block ${origin.blockId}`);
          } else if (parsed.canonicalText.slice(origin.start, origin.end) !== origin.excerpt) {
            push(`node ${node.id}: material origin excerpt does not slice-match canonicalText`);
          }
        }
      }
      if (node.title === null && tree.treeId !== B9_EMPTY_TREE_ID) {
        push(`node ${node.id}: null title outside b9-empty`);
      }
      if (node.title === B9_SAME_NAME_TITLE) {
        sameNameNodes += 1;
        sameNameParents.add(node.parentId ?? "");
      }
      if (node.title !== null && node.title.length >= LONGTITLE_MIN_UTF16) {
        longTitleNodes += 1;
      }
    }
  }

  // —— 特殊树形状规则（spec.specialTrees 逐条） ——
  const special = (treeId: string): B9Tree | undefined => dataset.trees.find((tree) => tree.treeId === treeId);
  const requireTree = (treeId: string): B9Tree => {
    const tree = special(treeId);
    if (tree === undefined) push(`special tree ${treeId} missing`);
    return tree ?? { treeId, kind: "special", rule: null, title: null, trunkBranchId: "", nodes: [] };
  };

  const big = requireTree(B9_BIG_TREE_ID);
  if (big.nodes.length !== BIG_TOTAL_NODES) {
    push(`b9-big: expected ${String(BIG_TOTAL_NODES)} nodes, got ${String(big.nodes.length)}`);
  }
  const bigChildCounts = new Map<string, number>();
  for (const node of big.nodes) {
    if (node.parentId !== null) bigChildCounts.set(node.parentId, (bigChildCounts.get(node.parentId) ?? 0) + 1);
  }
  for (const [parentId, count] of bigChildCounts) {
    if (count > 5) push(`b9-big: node ${parentId} has ${String(count)} children (branching factor must be 2–5)`);
  }
  const oneChildCount = [...bigChildCounts.entries()].filter(([, count]) => count === 1).length;
  if (oneChildCount > 1) {
    push(`b9-big: ${String(oneChildCount)} nodes with exactly 1 child (only the truncated tail may have 1)`);
  }
  let previousDepth = 0;
  for (const node of big.nodes) {
    if (node.depth < previousDepth) push(`b9-big: creation order is not breadth-first (depth regression at ${node.id})`);
    previousDepth = node.depth;
  }

  const deep = requireTree(B9_DEEP_TREE_ID);
  let deepest = 0;
  for (const node of deep.nodes) {
    if (node.depth > deepest) deepest = node.depth;
  }
  if (deepest !== DEEP_CHAIN_DEPTH) {
    push(`b9-deep: max depth ${String(deepest)} !== ${String(DEEP_CHAIN_DEPTH)}`);
  }
  // 深链存在性：从最深节点沿 parentPath 走回 trunk 必须恰好 100 步。
  {
    const deepestNode = deep.nodes.find((node) => node.depth === DEEP_CHAIN_DEPTH);
    if (deepestNode === undefined) {
      push("b9-deep: no node at depth 100");
    } else if (deepestNode.parentPath.length !== DEEP_CHAIN_DEPTH) {
      push(`b9-deep: deepest node parentPath length ${String(deepestNode.parentPath.length)} !== 100`);
    }
    const sideBranches = deep.nodes.filter((node) => node.id.includes("-s"));
    if (sideBranches.length !== DEEP_SIDE_BRANCHES) {
      push(`b9-deep: expected ${String(DEEP_SIDE_BRANCHES)} side branches, got ${String(sideBranches.length)}`);
    }
  }

  const wide = requireTree(B9_WIDE_TREE_ID);
  const trunkChildren = wide.nodes.filter((node) => node.parentId === wide.trunkBranchId);
  if (trunkChildren.length < 200) {
    push(`b9-wide: trunk has ${String(trunkChildren.length)} direct children (< 200)`);
  }

  const empty = requireTree(B9_EMPTY_TREE_ID);
  if (empty.nodes.length !== 1) {
    push(`b9-empty: expected exactly 1 node, got ${String(empty.nodes.length)}`);
  }
  if (empty.nodes[0]?.title !== null) push("b9-empty: trunk must have no title (no turns)");

  const samename = requireTree(B9_SAMENAME_TREE_ID);
  const treeSameName = samename.nodes.filter((node) => node.title === B9_SAME_NAME_TITLE);
  if (treeSameName.length < 50) {
    push(`b9-samename: ${String(treeSameName.length)} same-titled nodes (< 50)`);
  }
  if (sameNameParents.size < 30) {
    push(`b9-samename: same-titled nodes spread over only ${String(sameNameParents.size)} distinct parents (< 30)`);
  }

  const longtitle = requireTree(B9_LONGTITLE_TREE_ID);
  const treeLongTitles = longtitle.nodes.filter((node) => node.title !== null && node.title.length >= LONGTITLE_MIN_UTF16);
  if (treeLongTitles.length < 100) {
    push(`b9-longtitle: ${String(treeLongTitles.length)} nodes with titles ≥200 chars (< 100)`);
  }
  if (longTitleNodes < 100) {
    push(`totals: long-title nodes across dataset = ${String(longTitleNodes)} (< 100)`);
  }

  // —— 来源混合（sourceMix）：除 b9-empty 外每棵特殊树都应两种来源兼备 ——
  for (const tree of dataset.trees) {
    if (tree.kind !== "special" || tree.treeId === B9_EMPTY_TREE_ID) continue;
    const hasTurn = tree.nodes.some((node) => node.originKind === "turn");
    const hasMaterial = tree.nodes.some((node) => node.originKind === "material");
    if (!hasTurn || !hasMaterial) {
      push(`special tree ${tree.treeId}: source mix incomplete (turn=${String(hasTurn)}, material=${String(hasMaterial)})`);
    }
  }
  if (dataset.totals.turnOrigins === 0 || dataset.totals.materialOrigins === 0) {
    push("totals: source mix must contain both turn and material origins");
  }

  if (nonTrunkSeen !== dataset.totals.nonTrunkBranches) {
    push(`internal: non-trunk count ${String(nonTrunkSeen)} !== totals.nonTrunkBranches`);
  }
  if (dataset.totals.maxDepth !== DEEP_CHAIN_DEPTH) {
    push(`totals: global max depth ${String(dataset.totals.maxDepth)} !== ${String(DEEP_CHAIN_DEPTH)} (b9-deep must be the deepest)`);
  }
  return problems;
}
