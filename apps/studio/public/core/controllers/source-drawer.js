/** Explicit source drawer opening, safe journal fetch and focus restoration. Instance-owned state and dependencies. */

export function createSourceDrawerController(deps) {

  /* ------------------------------ 来源抽屉（P1 + 反查） ------------------------------ */

  async function toggleDrawer() {
    if (deps.state.drawerOpen) {
      closeDrawer();
      return;
    }
    await openDrawer({ trigger: { kind: "element", element: deps.$("source-drawer-toggle") } });
  }


  /**
   * 打开来源抽屉；opts.focusRunId = delivered 卡反查定位的 run（渲染后滚动
   * 到该 run 的出处条目）。打开时拉取 journal 尾部（保守摘要）。
   */
  async function openDrawer(opts = {}) {
    deps.$("materials-section").open = false;
    deps.$("reading-materials").setAttribute("aria-expanded", "false");
    if (deps.state.drawerOpen) {
      /* 已开（如 delivered 卡点击时抽屉已开）：只更新定位目标。 */
      deps.state.drawerFocusRunId = opts.focusRunId ?? null;
      if (opts.trigger !== undefined) deps.state.drawerFocusReturn = opts.trigger;
      deps.renderDrawer();
      return;
    }
    deps.state.drawerOpen = true;
    deps.state.drawerFocusRunId = opts.focusRunId ?? null;
    deps.state.drawerFocusReturn = opts.trigger ?? { kind: "element", element: deps.$("source-drawer-toggle") };
    deps.state.journalEvents = null; /* 三态复位：进入加载中（防上次的陈旧态闪现） */
    deps.state.terminology = null; /* 术语读模型同批拉取 */
    deps.renderDrawer();
    deps.showDrawer();
    deps.$("source-drawer").focus(); /* 焦点入抽屉（W2 §2.7） */
    void loadJournal();
    void deps.refreshTerminology().then(() => {
      if (deps.state.drawerOpen) deps.renderDrawer();
    });
  }


  /**
   * journal 拉取（打开与重试共用）：成功 / 失败如实落三态（W2 §2.7
   * 打开-加载失败；issue #3 P1——失败绝不折叠成空数组伪装成“无事件”）。
   */
  async function loadJournal() {
    if (deps.state.currentTreeId === null) return;
    const treeId = deps.state.currentTreeId;
    deps.state.journalEvents = null;
    deps.renderDrawer();
    try {
      const payload = await deps.api(`/api/trees/${encodeURIComponent(treeId)}/journal?limit=20`);
      /* P1 同族规则（issue #7 增量验收）：迟到的 journal 响应（切树后到达）
         不写入当前树的共享状态（三态属于当前打开的树）。 */
      if (deps.state.currentTreeId !== treeId) return;
      deps.state.journalEvents = { ok: true, events: payload.events };
    } catch {
      if (deps.state.currentTreeId !== treeId) return;
      deps.state.journalEvents = { ok: false };
    }
    deps.renderDrawer();
  }


  /** 关闭抽屉：焦点还原到触发元素（W2 §2.7）。 */
  function closeDrawer() {
    if (!deps.state.drawerOpen) return;
    deps.state.drawerOpen = false;
    deps.state.drawerFocusRunId = null;
    deps.hideDrawer();
    /* 开关的 aria-expanded / 文案只在 renderDrawer 对齐——Esc 关闭不经过
       renderAll，不补一次则读屏器持续播报已展开（浏览器面跑批器发现：
       关闭后 3 秒仍为 true，直到下一次无关重渲）。drawerOpen 已为 false，
       renderDrawer 更新开关后立即返回，不触碰抽屉内容/退出动画。 */
    deps.renderDrawer();
    const ref = deps.state.drawerFocusReturn;
    deps.state.drawerFocusReturn = null;
    deps.restoreFocusRef(ref);
  }

  return {
    closeDrawer,
    loadJournal,
    openDrawer,
    toggleDrawer,
  };
}
