/** Navigation nav-locate; preserves the existing D4 endpoint and display contracts. */
export function createNavLocateController(deps) {
  const {
    getElement: $,
    getState,
    api,
    navChildEntry,
    navLoadChildrenPage,
    selectNavNode,
    openNavTree,
    renderNavTree,
    renderNavTreeActions,
    openTree,
    revealOrigin,
    openMaterial,
  } = deps;
  const state = getState();

  const NAV_REVEAL_PAGE_GUARD = 2000;

  /**
   * 揭示某分支：沿根→该节点的完整路径逐层展开并续页（页序即创建序，目标
   * 不在已载页时按游标翻页直到出现/翻尽——有界），然后选中 + 滚动 + 聚焦。
   * locate / 分支搜索命中 / 重启恢复的深层选中共用本函数。opts.persist =
   * false 透传给收尾选中（恢复读回不回写；locate/搜索命中是用户动作，照常
   * 持久化）。
   */
  async function navRevealBranch(session, branchId, pathSteps, opts = {}) {
    try {
      let steps = pathSteps;
      if (steps === undefined) {
        const payload = await api(
          `/api/nav/trees/${encodeURIComponent(session.treeId)}/branches/${encodeURIComponent(branchId)}/path`,
        );
        if (state.nav.session !== session) return;
        steps = payload.path;
      }
      if (steps === undefined || steps.length === 0) return;
      for (let i = 0; i + 1 < steps.length; i += 1) {
        const parentId = steps[i].id;
        const wantedId = steps[i + 1].id;
        if (!session.expanded.has(parentId)) session.expanded.add(parentId);
        let guard = 0;
        for (;;) {
          if (state.nav.session !== session) return;
          if (session.nodes.has(wantedId)) break;
          const entry = navChildEntry(session, parentId);
          if (entry.state === "loading" && entry.inFlight !== null) {
            await entry.inFlight; /* 与在途页合并，完成后复查 */
            continue;
          }
          if (entry.state === "failed") break; /* 该层加载失败——如实停下（Retry 行在场） */
          if (entry.ids.length === 0) {
            /* 该层从未加载（恢复早于窗口泵触发）：直接取首页。 */
            await navLoadChildrenPage(session, parentId, "first");
            guard += 1;
            continue;
          }
          if (entry.nextCursor === null) break; /* 翻尽未见——节点已不在当前事实 */
          await navLoadChildrenPage(session, parentId, "next");
          guard += 1;
          if (guard > NAV_REVEAL_PAGE_GUARD) break;
        }
      }
      if (state.nav.session !== session) return;
      if (!session.nodes.has(branchId)) {
        session.locateNote = `${branchId} is no longer reachable in this tree's current facts — no approximate node is substituted`;
        renderNavTree();
        return;
      }
      await selectNavNode(branchId, { scroll: true, persist: opts.persist !== false });
    } catch (err) {
      if (state.nav.session !== session) return;
      session.locateNote = `locating ${branchId} failed — ${String(err && err.message ? err.message : err)}`;
      renderNavTree();
    }
  }

  /** 定位工作台当前分支（跨树：locate 携带目标树与完整路径——切换导航树
      并续走揭示）。 */
  async function navLocateCurrent() {
    const session = state.nav.session;
    if (session === null) return;
    const st = state.treeState;
    const branchId = st === null ? null : st.cursor !== null ? st.cursor.branchId : st.trunkBranchId;
    if (branchId === null || st === null) return;
    $("nav-locate-current").disabled = true;
    session.locateNote = "locating the workbench's current branch…";
    renderNavTree();
    try {
      const payload = await api(`/api/nav/branches/${encodeURIComponent(branchId)}/locate`);
      if (state.nav.session !== session) return;
      session.locateNote = null;
      if (payload.treeId !== session.treeId) {
        await openNavTree(payload.treeId, { reveal: { branchId: payload.node.id, path: payload.path } });
        return;
      }
      await navRevealBranch(session, payload.node.id, payload.path);
    } catch (err) {
      if (state.nav.session !== session) return;
      session.locateNote = `locating the current branch failed — ${String(err && err.message ? err.message : err)}`;
    } finally {
      renderNavTreeActions();
      renderNavTree();
    }
  }

  /**
   * 跳回所选节点的来源（既有揭示约定，产品事实——绝不由 session 可用性决
   * 定）：locate 携带 origin——turn 来源走 revealOrigin（/source 揭示 + 降级
   * 纪律）；material 来源走阅读器按版本+块定位（sourceJump 语义）；无来源
   * 如实说明。目标树不在工作台时先 openTree 进入（工作台既有开树行为）。
   */
  async function navJumpToSource() {
    const session = state.nav.session;
    if (session === null || session.selectedBranchId === null) return;
    const branchId = session.selectedBranchId;
    $("nav-source-selected").disabled = true;
    session.locateNote = `revealing the origin of ${branchId}…`;
    renderNavTree();
    try {
      const locate = await api(`/api/nav/branches/${encodeURIComponent(branchId)}/locate`);
      if (state.nav.session !== session) return;
      const origin = locate.origin;
      if (origin === null) {
        session.locateNote =
          `${branchId} has no saved origin to reveal (the trunk, or a branch created without one) — nothing is faked`;
        renderNavTree();
        return;
      }
      if (state.currentTreeId !== locate.treeId) {
        await openTree(locate.treeId);
        if (state.currentTreeId !== locate.treeId) {
          throw new Error(`opening tree ${locate.treeId} in the workbench did not complete — cannot reveal the origin here`);
        }
      }
      session.locateNote = null;
      renderNavTree();
      // The source is displayed outside the tools; release the overlay before arrival.
      if ($("workspace-library")) $("workspace-library").open = false;
      if (origin.kind === "turn") {
        await revealOrigin(branchId);
      } else {
        await openMaterial(origin.materialId, {
          versionId: origin.versionId,
          focusBlockId: origin.blockId,
          arrival: "return-source",
          trigger: { kind: "element", element: $("nav-source-selected") },
        });
      }
    } catch (err) {
      if (state.nav.session !== session) return;
      session.locateNote = `revealing the origin failed — ${String(err && err.message ? err.message : err)}`;
      renderNavTree();
    } finally {
      renderNavTreeActions();
    }
  }

  return { navRevealBranch, navLocateCurrent, navJumpToSource };
}
