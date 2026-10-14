/**
 * scripts/d4/browser/nav-probes.mjs — D4-8 大规模树导航浏览器探针
 * （issue #8 charter §5 大规模树导航 + §6 B9 的浏览器面）。
 *
 * 由 scripts/run-d4-browser.mjs 驱动：真实 headless Chromium（CDP）+
 * 真实 Studio 进程。B9 数据集（冻结 spec tests/fixtures/d4/b9-nav/spec.json，
 * 种子 d4-b9-2026-09-30）经真实生成引擎在探针内确定性生成、结构不变量
 * 自检后由真实装载器（repository API）装入专用数据目录；真实 Studio 进程
 * 在该目录上服务 /api/nav/* 与静态前端。浏览器面度量（charter B9）：
 *
 *   - 初次打开 b9-big（5000 节点）至可操作 ≤ 2s（真实 finder → 树打开）；
 *   - 固定 ≥50 次脚本化展开/切换操作（确定性顺序，全部由结构真值派生），
 *     逐操作计时（performance.now——页内 MutationObserver 结算探针），
 *     p95 ≤ 300ms（本地机器工程证据，环境如实记录，不跨机器宣称）；
 *   - 虚拟化：DOM 行数随可视窗口而非节点总数增长（b9-wide 220 子枝全量
 *     装入后逐偏移采样 .nav-item 数 + 状态行 X/Y 口径）；
 *   - 键盘逐层移动（→ 展开/入首子、← 收起/回父、↑↓ 沿可见行、Home/End
 *     大跳）且焦点在窗口重划后保持在焦点行（.focused + activeElement）；
 *   - 展开状态跨真实进程重启存活（SIGTERM + 同数据目录新进程：服务端
 *     GET expand-state 逐字节恒等 + UI 重开恢复展开与选中）；
 *   - 当前节点/祖先/来源定位对结构真值抽样对照（搜索命中行携带的完整
 *     路径/深度/来源 + 选中后的完整路径行 + 材料来源节点的 ⌖ Source of
 *     selected 跳转打开阅读器于锚定块）。
 *
 * 引擎面（离线 b9-large-tree-nav）已覆盖 locate/subtree 100% 对照；本探针
 * 只做浏览器侧的抽样 UI 对照（UI 渲染与真值一致）。
 *
 * 计时口径（诚实披露）：每次操作的 t0 在结算探针安装时捕获（距真实点击
 * 一至两次 CDP 往返，~1-5ms——计入测量，方向保守）；结算条件由页内
 * MutationObserver + 20ms tick 求值，DOM 到位即结算（无轮询量化误差）。
 */

/** Stable public native browser probe entrypoint. */
export {
  armWaiterExpr,
  awaitWaiter,
} from "./navigation/settlement.mjs";
export {
  probeNavBrowser,
} from "./navigation/probe.mjs";
