/** policy ownership for b9-dataset.ts; compatibility entrypoint remains one level above. */
import type {
  MaterialSpec,
} from "./model.ts";

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

export const BIG_TOTAL_NODES = 5000;


export const DEEP_CHAIN_DEPTH = 100;


export const DEEP_SIDE_BRANCHES = 10;


export const WIDE_ROOT_CHILDREN = 220;


export const WIDE_GRANDCHILDREN_STEP = 5;


export const SAMENAME_PARENTS = 30;


export const SAMENAME_PER_PARENT = 2;


export const SAMENAME_DEPTH3 = 4;


export const SAMENAME_UNDER_TRUNK = 2;


export const SAMENAME_DECOYS = 4;


export const LONGTITLE_NODES = 120;


export const LONGTITLE_MIN_UTF16 = 200;


export const LONGTITLE_BUILD_TARGET = 240;


export const NORMAL_TREE_COUNT = 94;


export const NORMAL_SIZE_MIN = 12;


export const NORMAL_SIZE_MAX = 110;

/** Turn/Material 来源的全局分配规则（非根节点全局序号 g，从 1 起）。 */
export const TURN_ORIGIN_MOD = 13;


export const TURN_ORIGIN_REMAINDER = 5;


export const MATERIAL_ORIGIN_MOD = 29;


export const MATERIAL_ORIGIN_REMAINDER = 11;

/** b9-samename 全部同名节点共享的标题（完全相同字符串）。 */
export const B9_SAME_NAME_TITLE = "同名节点：重点回顾（Same-Name Review）";

/* ------------------------------------------------------------------ */
/* 标题模板（中英混排派生）                                              */
/* ------------------------------------------------------------------ */

export const TOPICS_ZH = [
  "概率图模型", "唐诗的意象", "光合作用", "城市交通规划", "贝叶斯推断",
  "宋代货币史", "量子纠缠", "统计机器翻译", "古罗马道路", "湿地生态系统",
  "神经可塑性", "文艺复兴透视法", "算法复杂度", "板块构造", "茶汤风味", "明代漕运",
] as const;

export const TOPICS_EN = [
  "Bayesian inference", "Tang poetry imagery", "photosynthesis", "urban transit",
  "quantum entanglement", "statistical machine translation", "Roman roads",
  "wetland ecosystems", "neural plasticity", "Renaissance perspective",
  "algorithm complexity", "plate tectonics", "tea flavor", "Ming grain transport",
] as const;

export const ASPECTS_ZH = [
  "入门路径", "核心疑问", "对比实验", "历史脉络", "常见误解",
  "延伸问题", "实践笔记", "关键反例", "复习要点", "方法论辨析",
] as const;

export const LONG_FILLER = "在方法与反例之间反复对照、把边界条件逐一列清，再把每一步的依据写回主干问题；";

export const MATERIAL_SPECS: readonly MaterialSpec[] = [
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
