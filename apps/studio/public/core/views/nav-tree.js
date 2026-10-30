import { createDisclosure } from "../dom.js";
/** Shared row geometry for virtual rendering and keyboard scroll positioning. */
export const NAV_ROW_HEIGHT_PX = 34;
const NAV_WINDOW_OVERSCAN = 10;

export function createNavTreeView({
  document, getElement: $, getState, navRowElements,
  navLoadChildrenPage, navToggleExpansion, selectNavNode,
}) {
  /**
   * 可见行序（展开集合的先序走行）：每行是 node（真实分支行）、loading（子
   * 节点在途的占位行）、more（游标续页行——分页加载的显式入口）、failed
   * （子节点加载失败 + Retry）。收起的子树零行（DOM-free——B9「收起子树
   * 不占 DOM」）。
   */
  function navVisibleRows(session) {
    const rows = [];
    const overview = session.overview;
    if (overview === null) return rows;
    const trunk = session.nodes.get(overview.trunkBranchId);
    if (trunk === undefined) return rows;
    rows.push({ kind: "node", node: trunk, depth: 0 });
    const walk = (parentId, depth) => {
      if (!session.expanded.has(parentId)) return;
      const entry = session.childPages.get(parentId);
      if (entry === undefined) {
        rows.push({ kind: "loading", parentId, depth });
        return;
      }
      if (entry.state === "loading" && entry.ids.length === 0) {
        rows.push({ kind: "loading", parentId, depth });
        return;
      }
      for (const id of entry.ids) {
        const node = session.nodes.get(id);
        if (node === undefined) continue;
        rows.push({ kind: "node", node, depth });
        walk(id, depth + 1);
      }
      if (entry.state === "failed" && entry.ids.length === 0) {
        rows.push({ kind: "failed", parentId, depth, error: entry.error });
        return;
      }
      if (entry.nextCursor !== null || entry.state === "loading") {
        rows.push({
          kind: "more",
          parentId,
          depth,
          loading: entry.state === "loading",
          failed: entry.state === "failed",
          loaded: entry.ids.length,
          total: entry.totalChildren,
        });
      }
    };
    walk(trunk.id, 1);
    return rows;
  }

  /** 窗口行元素（node/loading/more/failed 各自的 DOM）。 */
  function navRowElement(row, session) {
    if (row.kind === "node") return navNodeRowElement(row.node, row.depth, session);
    const li = document.createElement("li");
    li.className = "nav-status-row";
    if (row.kind === "loading") {
      li.textContent = row.parentId === null ? "loading the tree…" : "loading branches…";
      return li;
    }
    if (row.kind === "failed") {
      li.classList.add("failed");
      li.append(document.createTextNode(`branches failed to load — ${row.error ?? "unknown error"} `));
      const retry = document.createElement("button");
      retry.className = "drawer-retry";
      retry.textContent = "Retry";
      retry.addEventListener("click", () => {
        void navLoadChildrenPage(session, row.parentId, "first");
        renderNavTree();
      });
      li.append(retry);
      return li;
    }
    /* more */
    li.className = "nav-more-row";
    if (row.loading) {
      li.textContent = "loading more branches…";
      return li;
    }
    if (row.failed) {
      li.textContent = "loading more branches failed — press Retry";
      const retry = document.createElement("button");
      retry.className = "drawer-retry";
      retry.textContent = "Retry";
      retry.addEventListener("click", () => {
        void navLoadChildrenPage(session, row.parentId, "next");
        renderNavTree();
      });
      li.append(document.createTextNode(" "), retry);
      return li;
    }
    const more = document.createElement("button");
    more.className = "nav-more";
    more.textContent = `More branches (${String(row.loaded)} of ${String(row.total)} loaded)`;
    more.addEventListener("click", () => {
      void navLoadChildrenPage(session, row.parentId, "next");
      renderNavTree();
    });
    li.append(more);
    return li;
  }

  /** 分支行：行 li（roving tabindex + treeitem 语义）内 toggle 按钮 + 标签
      按钮（id 即身份——同名节点可区分；长标题 CSS 截断、title 属性全文）。 */
  function navNodeRowElement(node, depth, session) {
    const li = document.createElement("li");
    li.className = "nav-item";
    li.setAttribute("role", "treeitem");
    li.setAttribute("aria-level", String(depth + 1));
    li.dataset.branchId = node.id;
    li.tabIndex = -1;
    if (node.id === session.selectedBranchId) li.classList.add("active");
    const expanded = session.expanded.has(node.id);
    const expandable = node.childCount > 0 || expanded;
    if (expandable) li.setAttribute("aria-expanded", expanded ? "true" : "false");
    if (node.id === session.focusBranchId) {
      li.classList.add("focused");
      li.tabIndex = 0;
    }
    const row = document.createElement("div");
    row.className = "nav-row";
    /* 深链缩进（上限封顶——100 层不溢出；深度事实由 aria-level/title/路径行承载）。 */
    row.setAttribute("style", `padding-left: ${String(Math.min(depth, 12) * 12)}px`);
    let toggle;
    if (expandable) {
      toggle = document.createElement("button");
      toggle.className = "nav-toggle";
      toggle.textContent = expanded ? "▾" : "▸";
      toggle.setAttribute(
        "aria-label",
        expanded
          ? `Collapse ${node.id}`
          : `Expand ${node.id} (${String(node.childCount)} direct branch${node.childCount === 1 ? "" : "es"})`,
      );
      toggle.addEventListener("click", () => {
        session.focusBranchId = node.id;
        navToggleExpansion(node.id);
      });
    } else {
      toggle = document.createElement("span");
      toggle.className = "nav-toggle leaf";
      toggle.textContent = "·";
    }
    const label = document.createElement("button");
    label.className = "nav-label";
    const title = document.createElement("span");
    title.className = "nav-title";
    title.textContent =
      node.title !== null ? node.title : node.parentBranchId === null ? "思考主线" : "未命名支线";
    const idChip = document.createElement("span");
    idChip.className = "nav-id";
    idChip.textContent = node.id;
    idChip.hidden = true;
    label.append(title, idChip);
    if (node.childCount > 0) {
      const count = document.createElement("span");
      count.className = "nav-count";
      count.textContent = String(node.childCount);
      label.append(count);
    }
    const depthNote = node.parentBranchId === null ? "trunk" : `depth ${String(node.depth)} · parent ${node.parentBranchId}`;
    label.title = node.title ?? "未命名支线";
    label.addEventListener("click", () => {
      session.focusBranchId = node.id;
      void selectNavNode(node.id);
    });
    row.append(toggle, label);
    li.append(row);
    navRowElements.set(node.id, li);
    return li;
  }

  /**
   * 树视图渲染（本面所有数据落点共用；幂等）：窗口外的行只留高度占位
   * （spacer）——DOM 数量随可视区域而非全量节点增长。渲染前捕获树内焦点，
   * 重建后还原到焦点行的最新元素（焦点不因窗口重划消失）。窗口内的展开
   * 未载节点与 more 行顺带按需加载（navPumpLoads——滚动即取，请求量以窗
   * 口为界）。
   */
  function renderNavTree() {
    const session = getState().nav.session;
    const treeEl = $("nav-tree");
    const spacerTop = $("nav-tree-spacer-top");
    const spacerBottom = $("nav-tree-spacer-bottom");
    navRowElements.clear();
    if (session === null || session.overview === null) {
      treeEl.replaceChildren();
      spacerTop.setAttribute("style", "height: 0px");
      spacerBottom.setAttribute("style", "height: 0px");
      return;
    }
    const scroller = $("nav-tree-scroll");
    const rows = navVisibleRows(session);
    const scrollTop = scroller.scrollTop;
    const viewport = typeof scroller.clientHeight === "number" ? scroller.clientHeight : 0;
    let start = Math.max(0, Math.floor(scrollTop / NAV_ROW_HEIGHT_PX) - NAV_WINDOW_OVERSCAN);
    let end = Math.min(
      rows.length,
      Math.max(start, Math.ceil((scrollTop + viewport) / NAV_ROW_HEIGHT_PX) + NAV_WINDOW_OVERSCAN),
    );
    if (start >= rows.length) {
      /* 滚过内容末端（收起后内容变短等）：窗口钉在末行。 */
      start = Math.max(0, rows.length - 1);
      end = rows.length;
    }
    if (end < start) end = start;
    const hadFocus = document.activeElement !== null && treeEl.contains(document.activeElement);
    const elements = [];
    for (let i = start; i < end; i += 1) elements.push(navRowElement(rows[i], session));
    treeEl.replaceChildren(...elements);
    spacerTop.setAttribute("style", `height: ${String(start * NAV_ROW_HEIGHT_PX)}px`);
    spacerBottom.setAttribute("style", `height: ${String(Math.max(0, rows.length - end) * NAV_ROW_HEIGHT_PX)}px`);
    session.lastCounts = { rendered: end - start, total: rows.length };
    renderNavTreeStatusOnly(session);
    navPumpLoads(session, rows, start, end);
    if (hadFocus) navRestoreTreeFocus(session);
  }

  /** 状态行（虚拟化口径的如实披露 + 持久化/定位注记；计数取最近一次渲染
      的窗口口径——注记更新不抹掉计数）。 */
  function renderNavTreeStatusOnly(session) {
    const el = $("nav-tree-status");
    const overview = session.overview;
    const counts = session.lastCounts;
    let text = "";
    if (overview !== null && counts !== null) {
      text =
        `rendering ${String(counts.rendered)}/${String(counts.total)} visible rows (virtualized window) · ` +
        `${String(overview.nodeCount)} nodes · max depth ${String(overview.maxDepth)}`;
    }
    if (session.persistError !== null) text += ` · expand state not saved — ${session.persistError}`;
    if (session.locateNote !== null) text += ` · ${session.locateNote}`;
    el.replaceChildren();
    if (session.persistError !== null) el.append(document.createTextNode("路径展开状态暂未保存，请稍后再试。"));
    if (session.locateNote !== null) {
      const pending = session.locateNote.endsWith("…");
      el.append(document.createTextNode(pending ? "正在定位…" : "暂时无法定位这条路径，请查看详情。"));
    }
    if (text) el.append(createDisclosure(document, "显示详情", document.createTextNode(text)));
  }

  /** 窗口内按需加载泵：展开未载节点 → 首页；more 行（非在途/失败）→ 续页。
   *    失败绝不自动重试（Retry 行显式重试——避免失败循环）。 */
  function navPumpLoads(session, rows, start, end) {
    for (let i = start; i < end && i < rows.length; i += 1) {
      const row = rows[i];
      if (row.kind === "node" && session.expanded.has(row.node.id) && !session.childPages.has(row.node.id)) {
        void navLoadChildrenPage(session, row.node.id, "first");
      } else if (row.kind === "more" && !row.loading && !row.failed) {
        void navLoadChildrenPage(session, row.parentId, "next");
      }
    }
  }

  /** 树内焦点还原（窗口重划后）：焦点行的最新元素（不在窗口则回滚容器——
      键盘上下文保持）。 */
  function navRestoreTreeFocus(session) {
    const id = session.focusBranchId;
    if (id === null) return;
    const el = navRowElements.get(id);
    if (el !== undefined) {
      el.focus();
      return;
    }
    $("nav-tree-scroll").focus();
  }

  return { navVisibleRows, renderNavTree, renderNavTreeStatusOnly };
}
