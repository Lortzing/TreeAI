/**
 * D4-8 大规模树导航 —— 查询内核（纯服务层，架在真实持久化之上）。
 *
 * 定位（docs/d4/D4-project-v1.md §4 D4-8、§5「大规模树导航」；B9 规格
 * tests/fixtures/d4/b9-nav/spec.json）：
 *  - Forest/Tree 查找：分页树列表 + 按标题/标识搜索树；
 *  - 可搜索层级树：子节点分页（page/cursor 语义——按需加载是重点：单次
 *    查询永不要求调用方取整棵 5000 节点树）；
 *  - 深度受限子树展开（BFS、节点上限 + 游标续页）；
 *  - 任意节点完整父路径（迭代上溯，无递归——b9-deep 100 层深链乃至
 *    万级深度不触栈溢出）；
 *  - 定位节点：按 id 跨树找到所属树、祖先链、兄弟位次、来源引用；
 *  - 按标题搜索 Branch（exact/prefix/substring；大小写折算与既有检索
 *    仓库约定一致：String.prototype.toLowerCase()，无区域依赖、无
 *    Unicode 归一化）；结果携带 treeId + 完整路径（标题+id）以消歧——
 *    同名节点（b9-samename）绝不返回含糊的「最近匹配」，每条命中都
 *    携带可机械复核的身份；
 *  - 宽树安全：b9-wide 根下 220 直接子枝按页正确翻完（无重复/无空洞）；
 *  - 空树诚实：b9-empty（仅 trunk）返回真实空页，不伪造内容。
 *
 * 数据纪律（镜像 D4-4 search-engine 的「索引不是事实源」）：
 *  - 全部事实读取经真实仓储（TreeRepository / MaterialRepository）；
 *  - 每树一个惰性构建的读索引（listBranches 一次 + 每分支 listTurns 取
 *    首个 user Turn 作标题 + getBranchOriginKind 逐页取来源类型）——
 *    索引是派生缓存：可用 invalidate(treeId) 显式失效重建，游标携带
 *    索引版本号，跨版本游标按「过期游标」显式报错（不静默跳页）；
 *  - 本内核不持久化任何 UI 状态：展开/折叠/阅读位置的持久化在接线
 *    增量落地（packages/persistence migration 0010 nav_tree_expand_state +
 *    TreeRepository.saveNavExpandState；引擎索引跨进程重建是惰性的，
 *    重启即重算——索引不是事实源）。
 *
 * 诚实边界：引擎级 p95（B9 nav-p95 的引擎侧证据）≠ 浏览器 verdict——
 * DOM/虚拟化/键盘属前端增量；跨进程缓存失效策略（写入方主动 invalidate
 * 或进程重启重建）属接线增量。
 */

/** Stable public navigation engine entrypoint. */
export type {
  NavOriginKind,
  NavNodeView,
  NavChildrenPage,
  NavSubtreePage,
  NavAncestor,
  NavOriginSelection,
  NavOriginTurnView,
  NavOriginMaterialView,
  NavOriginView,
  NavLocation,
  NavTreeSummary,
  NavTreeOverview,
  NavTreesPage,
  NavSearchMode,
  NavBranchSearchHit,
  NavTreeSearchHit,
  NavTreeSearchPage,
  NavBranchSearchPage,
  NavEngineErrorCode,
  NavEngineOptions,
} from "./engine/model.ts";
export {
  NavEngineError,
} from "./engine/errors.ts";
export {
  NAV_CHILDREN_DEFAULT_LIMIT,
  NAV_CHILDREN_MAX_LIMIT,
  NAV_SUBTREE_DEFAULT_LIMIT,
  NAV_SUBTREE_MAX_LIMIT,
  NAV_SUBTREE_MAX_DEPTH,
  NAV_TREES_DEFAULT_LIMIT,
  NAV_TREES_MAX_LIMIT,
  NAV_SEARCH_DEFAULT_LIMIT,
  NAV_SEARCH_MAX_LIMIT,
} from "./engine/policy.ts";
export {
  TreeNavEngine,
} from "./engine/engine.ts";
