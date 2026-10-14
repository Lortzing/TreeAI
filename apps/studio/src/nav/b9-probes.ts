/**
 * D4-8 大规模树导航 —— B9 冻结探针集 + 引擎级校验 + 性能序列（离线、确定性）。
 *
 * 覆盖（对照 tests/fixtures/d4/b9-nav/spec.json functionalProbes 的引擎侧
 * 可执行子集；DOM/虚拟化/键盘/重启状态属接线与前端增量，不在本模块）：
 *  - locate-correctness：固定探针集（六棵特殊树 + 普通树抽样）的定位/
 *    祖先链/路径/标题/兄弟位次/来源 100% 对照结构真值；
 *  - origins-100：全部 Turn/Material 来源节点逐一对照（来源定位正确率
 *    100%——失败样例保留在分母，绝不以近似节点替代）；
 *  - wide-pagination：b9-wide 根下 220 直接子枝按页翻完（无重复/无空洞/
 *    末页 nextCursor=null）；b9-big/b9-empty 分页对照；
 *  - deep-path：b9-deep 最深节点（depth 100）完整父路径迭代计算（100
 *    祖先），无栈溢出；
 *  - samename-disambiguation：66 同名节点按完整路径消歧——exact 全集
 *    恰好等于真值同名集（诱饵不混入），substring 覆盖诱饵；
 *  - search-locate：树/分支按标题与标识搜索（exact/prefix/substring、
 *    大小写折算、树范围、诚实零命中）对照真值独立复算；
 *  - empty-tree：b9-empty 诚实空页；
 *  - big-tree-shape：5000 节点树概览与深度受限展开对照真值（BFS 序）；
 *  - tree-list：100 棵树分页无重复/无空洞；
 *  - nav-p95-engine：预热后 60 次展开/切换/搜索操作（脚本化确定性顺序，
 *    覆盖 b9-big/b9-deep/b9-wide 与跨树搜索），p95 ≤ 300ms（引擎级证据，
 *    非浏览器 verdict）；
 *  - big-tree-first-open：初次打开 b9-big（索引冷构建）到可查询 ≤ 2s
 *    （引擎级；浏览器侧另测）。
 *
 * 确定性：探针集与操作序列完全由数据集派生（无随机、无时间依赖——
 * 计时不影响结果集合，只影响性能读数）。
 */

/** Stable public B9 engine probe entrypoint. */
export type {
  B9ProbeOutcome,
  B9PerfOpTiming,
  B9PerfReport,
  B9EngineCheckResult,
} from "./probes/model.ts";
export {
  B9_NAV_P95_LIMIT_MS,
  B9_BIG_FIRST_OPEN_LIMIT_MS,
} from "./probes/policy.ts";
export {
  locateProbeIds,
} from "./probes/truth.ts";
export {
  buildPerfOps,
} from "./probes/performance.ts";
export {
  runB9EngineChecks,
} from "./probes/runner.ts";
