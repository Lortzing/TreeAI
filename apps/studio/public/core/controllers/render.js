/** Coordinated Studio refresh with selection-drag deferral; domain views retain their own DOM/state ownership. Instance-owned state and dependencies. */

export function createStudioRenderer(deps) {


  function renderAll(opts = {}) {
    /* ③ 选择期间不重绘：选区拖拽窗口（mousedown→mouseup）内整树重渲延后
       （pendingRerender），mouseup 后冲刷——正文层绝不从用户光标下被换走。
       未变化的异步刷新本就零 DOM 变更（reconcileTopLevel 快路径），这里的
       延后覆盖「拖拽期间恰有区间覆盖/结构变化」的窗口。 */
    if (deps.state.selectionDragActive) {
      deps.state.pendingRerender = true;
      return;
    }
    const stickBranch = opts.stick ?? null;
    /* 渲染期注册表重建（焦点还原 / 锚点定位取最新 DOM）。 */
    deps.tabButtons.clear();
    deps.branchHereButtons.clear();
    deps.turnElements.clear();
    deps.assistantTurns.clear();
    deps.termExplainButtons.clear();
    const hasTree = deps.state.treeState !== null;
    deps.$("empty-state").hidden = hasTree;
    deps.$("tree-view").hidden = !hasTree;
    /* 无树打开 → 无源可溯：来源抽屉入口（顶栏）直接隐藏，优于必然为空的
       诚实空态；有树后随 renderAll 恢复。 */
    deps.$("source-drawer-toggle").hidden = !hasTree;
    deps.renderReadingHeading();
    deps.renderTopbarPath();
    if (hasTree) {
      deps.renderBranchTabs();
      deps.renderSessionBanner();
      deps.renderMainConversation(stickBranch !== null && stickBranch === deps.trunkBranchId());
      deps.renderPanel(stickBranch !== null && stickBranch === deps.state.panelBranchId);
      deps.updateComposerLocks();
    }
    deps.renderTrees();
    /* D4-2 材料列表（侧栏 Materials 段）随 renderAll 渲染（三态幂等；阅读
       器的块容器不在此路径——与树态正交，SSE 刷新对已载块零触碰）。 */
    deps.renderMaterialsSection();
    /* D4-4 搜索面（侧栏 Search 段）：静态表单只同步开关态（焦点/输入值不
       触碰），结果列表按当前读模型重建（注册表随之重建——焦点还原取最新
       DOM，同 materialListButtons 纪律）。 */
    deps.renderSearchSection();
    /* D4-8 导航面（侧栏 Navigate 段）：只同步动作可用性——树查找/树视图/
       路径行/命中列表由 D4-8 函数独占管理（虚拟化窗口与焦点不随整树重渲
       重建）。 */
    deps.renderNavSection();
    deps.renderSessionWorkspace();
  }

  return {
    renderAll,
  };
}
