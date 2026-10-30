import { attachedQuestion } from "../controllers/composer-tools.js";
/** navigation feature composition for one Studio instance. Instance-owned state and dependencies. */
import { createNavFinderController } from "../controllers/nav-finder.js";
import { createNavPathView } from "../views/nav-path.js";
import { createNavNodeResultsView } from "../views/nav-node-results.js";
import { createNavNodeSearchController } from "../controllers/nav-node-search.js";
import { createNavLocateController } from "../controllers/nav-locate.js";
import { createNavPersistenceController } from "../controllers/nav-persistence.js";
import { createNavInteractionController } from "../controllers/nav-interaction.js";
import { createNavSessionController } from "../controllers/nav-session.js";
import { createNavFinderView } from "../views/nav-finder.js";
import { createNavTreeView } from "../views/nav-tree.js";
import { createNavChromeView } from "../views/nav-chrome.js";

export function createNavigationFeatures(deps) {

      /* ============================== D4-8 大规模树导航 ==============================
       * （issue #8 工作包 D4-8，charter §5 + §6 B9；消费 /api/nav/* 只读产品事实
       * 面——nav-engine 的 HTTP 裁剪形状见文件头 typedef）。
       *
       * 分区：树查找（finder）→ 会话（open/close）→ 子节点分页加载 → 展开/选中
       * → 持久化（PUT expand-state 整组）→ 可见行序 + 虚拟化窗口渲染 → 键盘 →
       * 路径行 → 分支搜索 → 揭示（reveal/locate/source）。所有异步写点按
       * `state.nav.session !== session` 世代守卫（迟到的旧会话响应绝不写进新会
       * 话）；所有入口自捕获失败（导航是只读面，不进 guard/busy 锁——绝不锁住
       * composer）。 */


      /** 渲染期注册表（renderNavTree 重建）：焦点还原与键盘定位按 id 取最新 DOM。 */
      const navRowElements = new Map();

      const navFinderButtons = new Map();

      const navNodeHitButtons = new Map();

    /* ------------------------------ 树查找（finder） ------------------------------ */

    const {
      refreshNavForestListing,
      loadNavForestMore,
      loadNavTreeSearchMore,
      runNavTreeFind,
    } = createNavFinderController({
        getState: () => deps.environment.state,
        getQuery: () => deps.$("nav-tree-search").value,
        api: (...args) => deps.api(...args),
        renderNavFinder: () => renderNavFinder(),
      });

    /** 列表重建 + 焦点保持（行按钮按 data 键还原；More 按钮按形态还原——
        重渲不丢正在操作的面）。 */
    function navReplaceList(list, elements, registry) {
      const active = deps.environment.document.activeElement;
      const hadFocus = active !== null && list.contains(active);
      const wasMore = hadFocus && active.classList.contains("nav-more");
      const focusKey =
        hadFocus && active.dataset !== undefined ? active.dataset.treeId ?? active.dataset.branchId ?? null : null;
      list.replaceChildren(...elements);
      if (focusKey !== null) {
        const restored = registry.get(focusKey);
        if (restored !== undefined) restored.focus();
      } else if (wasMore) {
        const more = list.querySelector(".nav-more");
        if (more !== null) more.focus();
      }
    }

    const {
      renderNavPath,
    } = createNavPathView({
      document: deps.environment.document, getElement: (...args) => deps.$(...args), getState: () => deps.environment.state,
      selectNavNode: (...args) => selectNavNode(...args),
    });


    const {
      renderNavNodeResults,
    } = createNavNodeResultsView({
      document: deps.environment.document, getElement: (...args) => deps.$(...args), getState: () => deps.environment.state, mutedListItem: (...args) => deps.mutedListItem(...args), navNodeHitButtons, navReplaceList: (...args) => navReplaceList(...args),
      runNavNodeSearch: () => runNavNodeSearch(),
      loadNavNodeSearchMore: () => loadNavNodeSearchMore(),
      navRevealBranch: (...args) => navRevealBranch(...args),
    });


    const {
      runNavNodeSearch,
      loadNavNodeSearchMore,
    } = createNavNodeSearchController({
      getElement: (...args) => deps.$(...args), getState: () => deps.environment.state, api: (...args) => deps.api(...args), renderNavNodeResults: (...args) => renderNavNodeResults(...args),
    });


    const {
      navRevealBranch,
      navLocateCurrent,
      navJumpToSource,
    } = createNavLocateController({
      getElement: (...args) => deps.$(...args), getState: () => deps.environment.state, api: (...args) => deps.api(...args),
      navChildEntry: (...args) => navChildEntry(...args),
      navLoadChildrenPage: (...args) => navLoadChildrenPage(...args),
      selectNavNode: (...args) => selectNavNode(...args),
      openNavTree: (...args) => openNavTree(...args),
      renderNavTree: () => renderNavTree(),
      renderNavTreeActions: () => renderNavTreeActions(),
      openTree: (...args) => deps.openTree(...args), revealOrigin: (...args) => deps.revealOrigin(...args), openMaterial: (...args) => deps.openMaterial(...args),
    });

    const {
      scheduleNavPersist,
    } = createNavPersistenceController({
      getState: () => deps.environment.state,
      api: (...args) => deps.api(...args),
      renderNavTreeStatusOnly: (session) => renderNavTreeStatusOnly(session),
    });


    const {
      navToggleExpansion,
      selectNavNode,
      navTreeKeydown,
    } = createNavInteractionController({
      getState: () => deps.environment.state,
      getElement: (...args) => deps.$(...args),
      api: (...args) => deps.api(...args),
      navVisibleRows: (session) => navVisibleRows(session),
      navRowElements,
      navLoadChildrenPage: (...args) => navLoadChildrenPage(...args),
      scheduleNavPersist: (...args) => scheduleNavPersist(...args),
      renderNavTree: () => renderNavTree(),
      renderNavPath: (...args) => renderNavPath(...args),
      renderNavTreeActions: () => renderNavTreeActions(),
    });


    const {
      openNavTree,
      closeNavTree,
      navLoadChildrenPage,
      navChildEntry,
    } = createNavSessionController({
      getState: () => deps.environment.state,
      getElement: (...args) => deps.$(...args),
      api: (...args) => deps.api(...args),
      renderNavSurfaceChrome: () => renderNavSurfaceChrome(),
      renderNavTree: () => renderNavTree(),
      renderNavPath: (...args) => renderNavPath(...args),
      renderNavNodeResults: (...args) => renderNavNodeResults(...args),
      renderNavFinder: () => renderNavFinder(),
      selectNavNode: (...args) => selectNavNode(...args),
      navRevealBranch: (...args) => navRevealBranch(...args),
    });

    const {
      renderNavFinder,
    } = createNavFinderView({
      rememberTreeTitles: (trees) => {
        let changed = false;
        for (const tree of trees) {
          const title = attachedQuestion(tree.title ?? "").text.replace(/\s+/g, " ").trim();
          if (title && deps.readingTitles.get(tree.treeId) !== title) { deps.readingTitles.set(tree.treeId, title); changed = true; }
        }
        if (changed) deps.renderTrees();
      },
      document: deps.environment.document,
      getElement: (...args) => deps.$(...args),
      getState: () => deps.environment.state,
      mutedListItem: (...args) => deps.mutedListItem(...args),
      formatProductTime: (...args) => deps.formatProductTime(...args),
      closeSidebar: (...args) => deps.closeSidebar(...args),
      openNavTree: (...args) => openNavTree(...args),
      runNavTreeFind: (...args) => runNavTreeFind(...args),
      refreshNavForestListing: (...args) => refreshNavForestListing(...args),
      loadNavForestMore: (...args) => loadNavForestMore(...args),
      loadNavTreeSearchMore: (...args) => loadNavTreeSearchMore(...args),
      navFinderButtons,
      replaceList: (...args) => navReplaceList(...args),
    });

    /* ------------------------------ 展开 / 选中 ------------------------------ */

    /* ------------------------------ 可见行序 + 虚拟化窗口 ------------------------------ */

    const {
      navVisibleRows,
      renderNavTree,
      renderNavTreeStatusOnly,
    } = createNavTreeView({
      document: deps.environment.document,
      getElement: (...args) => deps.$(...args),
      getState: () => deps.environment.state,
      navRowElements,
      navLoadChildrenPage: (...args) => navLoadChildrenPage(...args),
      navToggleExpansion: (...args) => navToggleExpansion(...args),
      selectNavNode: (...args) => selectNavNode(...args),
    });

    const {
      renderNavSurfaceChrome,
      renderNavTreeActions,
    } = createNavChromeView({
      document: deps.environment.document,
      getElement: (...args) => deps.$(...args),
      getState: () => deps.environment.state,
      openNavTree: (...args) => openNavTree(...args),
    });

    /* ------------------------------ 面板 chrome / renderAll 接线 ------------------------------ */

    /** renderAll 接线面：只同步动作可用性（树查找/树视图/路径行/命中列表由
        本面函数独占管理——SSE 刷新/面板开合绝不重建虚拟化窗口）。 */
    function renderNavSection() {
      renderNavTreeActions();
    }

  return {
    renderNavSection,
    runNavTreeFind,
    runNavNodeSearch,
    renderNavTree,
    navTreeKeydown,
    navLocateCurrent,
    navJumpToSource,
    closeNavTree,
    refreshNavForestListing,
  };
}
