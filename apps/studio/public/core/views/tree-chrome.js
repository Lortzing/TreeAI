/** Forest/branch buttons, topbar path, missing-session banner and explicit recovery affordances. Instance-owned state and dependencies. */

export function createTreeChromeView(deps) {


  /* 渲染期元素注册表（renderAll 重建）：焦点还原与锚点定位按 id 取最新 DOM。 */
  const tabButtons = new Map();


  function renderTrees() {
    const list = deps.$("tree-list");
    list.replaceChildren();
    for (const tree of deps.state.trees) {
      const li = deps.document.createElement("li");
      const button = deps.document.createElement("button");
      if (tree.id === deps.state.currentTreeId) button.classList.add("active");
      const name = deps.document.createElement("span");
      button.dataset.treeId = tree.id;
      const summary = deps.readingTitles.get(tree.id);
      name.textContent = summary || tree.id;
      button.title = summary ? `${summary}\n${tree.id}` : tree.id;
      const date = deps.document.createElement("span");
      date.className = "tree-date";
      /* 列表层只保留日粒度（当年省年份——安静的事实）；精确到秒的完整
         创建时间收进 tooltip（可溯源不丢，但不上岗当视觉噪音）。 */
      const created = new Date(tree.createdAt);
      date.textContent = created.toLocaleDateString(
        undefined,
        created.getFullYear() === new Date().getFullYear()
          ? { month: "short", day: "numeric" }
          : { year: "numeric", month: "short" },
      );
      date.title = created.toLocaleString();
      button.append(name, date);
      button.addEventListener("click", () => {
        deps.closeSidebar(); /* 窄窗：选树后收起侧栏抽屉 */
        deps.guard(() => deps.openTree(tree.id));
      });
      li.append(button);
      list.append(li);
    }
  }


  function renderBranchTabs() {
    const st = deps.state.treeState;
    const tabs = deps.$("branch-tabs");
    tabs.replaceChildren();
    tabButtons.clear();
    for (const view of st.branches) {
      const isTrunk = view.branch.id === st.trunkBranchId;
      const button = deps.document.createElement("button");
      button.dataset.branchId = view.branch.id;
      /* 主线 tab 恒为 active（主阅读面板）；打开的支线 tab 呈 panel-open。 */
      if (isTrunk) button.classList.add("active");
      else if (view.branch.id === deps.state.panelBranchId) button.classList.add("panel-open");
      const label = deps.document.createElement("span");
      /* 阅读位给意义名（D1）：主线恒为「思考主线」，支线以首个问题/
         锚定摘录为名；机械序号（branchLabel）收进 title 等身份语境。 */
      label.textContent = isTrunk ? "思考主线" : deps.branchDisplayName(view.branch.id);
      button.append(label);
      const summary = deps.questionTitle(view) || view.origin?.selection.text || "";
      /* 摘要行只在与主行不同源时补充（同名重复是噪音，不是信息）；
         比较前折叠空白——主行名字已折叠，原文里的换行不应造成伪差异。 */
      const collapseWs = (text) => text.replace(/\s+/g, " ").trim();
      if (summary && collapseWs(summary) !== label.textContent) {
        const excerpt = deps.document.createElement("span");
        excerpt.className = "branch-summary";
        excerpt.textContent = summary;
        button.append(excerpt);
      }
      if (view.origin !== null) {
        const anchorStatus = view.originStatus ?? "unavailable";
        button.title = `branched from ${deps.branchLabel(view.origin.sourceBranchId)} · “${view.origin.selection.text}” · source ${anchorStatus}`;
        const dot = deps.document.createElement("span");
        dot.className = "dot";
        dot.textContent = " °";
        button.append(dot);
      } else if (!isTrunk) {
        /* D4-3 材料 Branch：无 Turn 来源——可辨认标记（来源细节在面板头部）。 */
        const badge = deps.document.createElement("span");
        badge.className = "material-badge";
        badge.textContent = "· material";
        badge.title = "branched from a material selection (D4-3) — the source context is shown in the branch panel";
        button.append(badge);
      }
      /* A4 缺失 session：分支徽标（续聊将 fail-closed；详情见降级提示）。 */
      if (view.sessionAvailability === "unavailable") {
        const badge = deps.document.createElement("span");
        badge.className = "session-badge";
        badge.textContent = "· session missing";
        badge.title = "the session file for this branch's continuation point is missing; the tree stays readable but continuing here will fail";
        button.append(badge);
      }
      /* 切换语义保留：tab 点击仍 POST /switch（服务端对齐 Pi 游标）；
         UI 层面支线只开局部面板、Trunk tab 收面板回主线（不整页换视图）。
         失败时面板可能未开/已收 → 错误呈现在主线横幅。
         窄窗（<720px）：与 Forest 树行/材料按钮/搜索命中同一纪律——从抽屉
         选中分支即收起侧栏，否则抽屉盖住刚打开的面板（B7 beta 可用性探针
         发现：elementFromPoint 于面板输入框命中抽屉遮罩）。 */
      button.addEventListener("click", () => {
        deps.closeSidebar();
        if (deps.sessionUI.mode !== "chat") deps.setWorkspaceView("chat", view.branch.id);
        if (isTrunk) {
          void deps.guard(() => deps.returnToTrunk(view.branch.id));
        } else {
          void deps.guard(() =>
            deps.openBranchPanel(view.branch.id, { trigger: { kind: "tab", branchId: view.branch.id } }),
          );
        }
      });
      tabButtons.set(view.branch.id, button);
      tabs.append(button);
    }
    const cursor = st.cursor;
    deps.$("cursor-note").textContent =
      cursor === null
        ? "session: —"
        : `session @ ${deps.branchLabel(cursor.branchId)} · ${cursor.entryId}`;
    if (deps.$("cursor-note-details")) deps.$("cursor-note-details").textContent = deps.$("cursor-note").textContent;
  }


  /* 顶栏位置路径（源设计 §二 顶栏行；D1 意义命名层）：无树 → 空；有树 →
     `<树名> / 思考主线 [ / 支线名 ]`——阅读位一律给意义名（树名与森林
     列表同源 = readingTitles，无标题树回退 id）；完整身份路径（树 id +
     机械分支名）收进 tooltip，可溯源不上岗。路径由 renderAll 统一刷新
     （面板开合、切树、SSE 终态重渲都经过 renderAll）。 */
  function renderTopbarPath() {
    const el = deps.$("topbar-path");
    const st = deps.state.treeState;
    if (st === null || deps.state.currentTreeId === null) {
      el.textContent = "";
      el.title = "";
      return;
    }
    const treeName = deps.readingTitles.get(deps.state.currentTreeId) ?? deps.state.currentTreeId;
    const segments = [treeName, "思考主线"];
    const identity = [deps.state.currentTreeId, deps.branchLabel(st.trunkBranchId)];
    if (deps.state.panelBranchId !== null) {
      segments.push(deps.branchDisplayName(deps.state.panelBranchId));
      identity.push(deps.branchLabel(deps.state.panelBranchId));
    }
    el.textContent = segments.join(" / ");
    el.title = identity.join(" / ");
  }


  /**
   * A4 缺失 session 横幅（主线视角，可关闭、不自动消失）：树保持完全可读
   * （数据库是事实源），Trunk 续聊将 fail-closed；可执行恢复方式 = 横幅内
   * 的恢复按钮（sessionRecoveryControls，从 session 仍可用的 turn 建新
   * 分支）或新建 Tree。session-corrupt 的 Trunk prompt 失败同样强制显示
   * （forceSessionBanner，下一次成功 Trunk prompt 清除）。
   *
   * dismiss 是页面级持久状态（dismissedSessionBannerTrunks，按 trunk 分支
   * 记忆）：重渲（SSE 终态刷新 / 面板开合 / 树面动作）不复活已关闭的横幅；
   * 仅当该主干 session 恢复可用（触发条件消失）、或用户执行恢复动作时清除
   * 记录——未来再次不可用时横幅可重新出现。
   */
  function renderSessionBanner() {
    const banner = deps.$("session-banner");
    const trunk = deps.trunkBranchId();
    const view = deps.branchView(trunk);
    const unavailable = view !== null && view.sessionAvailability === "unavailable";
    const forced = deps.state.forceSessionBanner;
    if (!unavailable && !forced) {
      /* 触发条件消失（主干恢复可用 / 成功 Trunk prompt 清除 force）：清除该
         主干的 dismiss 记录，横幅回到「可出现」状态。 */
      if (trunk !== null) deps.state.dismissedSessionBannerTrunks.delete(trunk);
      banner.hidden = true;
      return;
    }
    if (trunk !== null && deps.state.dismissedSessionBannerTrunks.has(trunk)) {
      /* 用户已 dismiss：本次条件仍成立也不复活（页面级记忆，非一次性 DOM
         hidden——renderAll 重建 DOM 不会把它带回来）。 */
      banner.hidden = true;
      return;
    }
    banner.replaceChildren();
    const text = deps.document.createElement("span");
    text.className = "session-banner-text";
    text.textContent =
      "Session missing on this branch — the tree stays fully readable (the database is the source of truth), " +
      "but continuing here will fail. Recovery: start a new exploration from saved content (button next to the " +
      "composer below), branch from a turn whose session is still available, or start a fresh Tree.";
    banner.append(text);
    banner.append(sessionRecoveryControls("main"));
    const dismiss = deps.document.createElement("button");
    dismiss.className = "session-banner-dismiss";
    dismiss.textContent = "Dismiss";
    dismiss.addEventListener("click", () => {
      if (trunk !== null) deps.state.dismissedSessionBannerTrunks.add(trunk);
      banner.hidden = true;
    });
    banner.append(dismiss);
    banner.hidden = false;
  }


  /**
   * 恢复候选（W2 §2.8「可直接执行」的依据）：session 可用分支的最新
   * assistant 答案。近似（诚实边界）：TreeStateT 不提供逐 turn 的 session
   * 判定——BranchViewT.sessionAvailability 是分支续聊点（latest run 的
   * session 引用；无 run 分支为 origin 锚点 run 的引用）的可用性，同分支
   * 各 run 共享会话文件，故以分支视图推断其 turn 的可用性。主线优先，
   * 其次其余分支（读模型顺序，稳定）。残余边界：某分支 prompt 刚以
   * session-corrupt 失败而读模型仍报 available 时可能被选中（服务端对
   * corrupt 会话在读模型中标 unavailable，正常不出现）。
   */
  function findSessionRecoveryAnchor() {
    const st = deps.state.treeState;
    if (st === null) return null;
    const ordered = st.trunkBranchId === null ? [] : [st.trunkBranchId];
    for (const view of st.branches) {
      if (view.branch.id !== st.trunkBranchId) ordered.push(view.branch.id);
    }
    for (const branchId of ordered) {
      const view = deps.branchView(branchId);
      if (view === null || view.sessionAvailability !== "available") continue;
      const turn = [...view.turns].reverse().find((t) => t.role === "assistant");
      if (turn !== undefined) return turn;
    }
    return null;
  }


  /**
   * 恢复按钮（issue #3 P1：恢复说明从纯文字变为可执行操作）：主线横幅与
   * 面板降级提示共用。有候选 → 可点击（title 如实标注来源分支）；无候选 →
   * 禁用并说明原因（新建 Tree / 恢复 session 文件）。不削弱 fail-closed 的
   * 续聊禁用——按钮是旁路恢复动作，不是对被禁入口的解禁。
   */
  function sessionRecoveryControls(surface) {
    const wrap = deps.document.createElement("span");
    wrap.className = "session-recovery";
    const button = deps.document.createElement("button");
    button.className = "session-recovery-button";
    button.textContent = "⑃ Branch from latest available answer";
    const anchor = findSessionRecoveryAnchor();
    if (anchor === null) {
      button.disabled = true;
      const reason = deps.document.createElement("span");
      reason.className = "session-recovery-reason";
      reason.textContent =
        "no session currently available — start a new exploration from saved content (composer below), or start a new Tree / restore the session file";
      wrap.append(button, reason);
    } else {
      button.title = `branch from the latest answer on ${deps.branchLabel(anchor.branchId)} (whose session is still available)`;
      wrap.append(button);
    }
    button.addEventListener("click", () => deps.guard(() => deps.branchFromLatestAvailableAnswer(), surface));
    return wrap;
  }

  return {
    sessionRecoveryControls,
    tabButtons,
    renderTopbarPath,
    renderBranchTabs,
    renderSessionBanner,
    renderTrees,
    findSessionRecoveryAnchor,
  };
}
