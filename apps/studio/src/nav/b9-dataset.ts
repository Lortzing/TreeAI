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

/** Stable public B9 dataset entrypoint. */
export {
  B9_SET_ID,
  B9_SEED,
  B9_FOREST_ID,
  B9_BIG_TREE_ID,
  B9_DEEP_TREE_ID,
  B9_WIDE_TREE_ID,
  B9_EMPTY_TREE_ID,
  B9_SAMENAME_TREE_ID,
  B9_LONGTITLE_TREE_ID,
  B9_TOTAL_NON_TRUNK_BRANCHES,
  B9_TREE_COUNT,
  B9_SAME_NAME_TITLE,
} from "./dataset/policy.ts";
export type {
  B9OriginKind,
  B9OriginRefTurn,
  B9OriginRefMaterial,
  B9OriginRef,
  B9Node,
  B9Tree,
  B9Material,
  B9Totals,
  B9Dataset,
  B9TreeStats,
  B9Manifest,
} from "./dataset/model.ts";
export {
  generateB9Dataset,
} from "./dataset/generator.ts";
export {
  serializeB9Dataset,
  sha256Hex,
  buildB9Manifest,
  serializeB9Manifest,
} from "./dataset/manifest.ts";
export {
  checkB9Invariants,
} from "./dataset/invariants.ts";
