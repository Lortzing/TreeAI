/** Instance UI adapters, API errors, composer busy/session locks and saved-tree view helpers. Instance-owned state and dependencies. */
import { createIsAtBottom } from "../../shared/reading-position/scroll.js";

export function createStudioBasics(deps) {
  // Keep the injected fetch callable unbound, matching the browser bootstrap contract.
  const fetch = deps.fetch;

  const $ = (id) => deps.document.getElementById(id);


  /* ------------------------------ 动效辅助（M7 / reduced-motion） ------------------------------ */

  /** W2 §3：JS 侧滚动定位尊重 prefers-reduced-motion（reduce → auto 直接跳转）。 */
  function prefersReducedMotion() {
    return typeof deps.window.matchMedia === "function" && deps.window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function scrollBehavior() {
    return prefersReducedMotion() ? "auto" : "smooth";
  }


  /** 贴底阈值（issue #3）：视口底边距内容底部 ≤48px 视为“正在跟随底部”。 */
  const AT_BOTTOM_PX = 48;


  /** 贴底判定：强制贴底（新内容跟随）只允许发生在用户本就在底部的容器上
      （issue #3 P1：流式增量 / 新 turn 到达时，已向上阅读的视图不得被拉回
      底部）。判定须在写入新内容之前取值——写入本身会增高 scrollHeight。 */
  const isAtBottom = createIsAtBottom(AT_BOTTOM_PX);


  async function api(path, method = "GET", body = undefined) {
    const response = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      /* non-JSON error body */
    }
    if (!response.ok) {
      const message = payload && payload.error ? `${payload.error.code}: ${payload.error.message}` : `HTTP ${response.status}`;
      const error = new Error(message);
      if (payload && payload.error && typeof payload.error.code === "string") {
        error.code = payload.error.code;
      }
      throw error;
    }
    return payload;
  }


  /** 错误横幅按视图落位：面板内动作的失败呈现在面板（W2 §2.3），其余主线。
   *  横幅具朗读语义（W2 §2.4：role="alert" 隐式 aria-live + tabindex="0"
   *  可 Tab 触达）：先置可见再写入文本——内容变化发生在可访问性树内，
   *  朗读触发更可靠；8 秒自动隐藏的既有行为不变。 */
  function showError(message, view = "main") {
    const banner = $(view === "panel" ? "panel-error-banner" : "error-banner");
    banner.hidden = false;
    banner.textContent = message;
    deps.window.setTimeout(() => {
      banner.hidden = true;
    }, 8000);
  }


  async function guard(fn, view = "main") {
    if (deps.state.busy) return;
    deps.state.busy = true;
    updateComposerLocks();
    try {
      await fn();
    } catch (err) {
      showError(String(err && err.message ? err.message : err), view);
    } finally {
      deps.state.busy = false;
      updateComposerLocks();
    }
  }


  /**
   * 续聊入口锁定（W2 §2.2 在途锁定 + §2.8 fail-closed + v3 §4.4）：
   * busy（单在途 prompt）→ 输入与发送全禁；
   * 目标分支 session 不可用 → **发送 fail-closed 禁用**，但输入保持可输入
   * （v3 §4.4：用户在新探索的首问就是在被禁的普通续聊入口旁输入的——
   * 「⑃ Start new exploration」按钮随可用性显隐，承接显式换轨提交）。
   * 占位文案同步换轨语境（不可用时引导输入新探索首问）。
   */
  function updateComposerLocks() {
    const busy = deps.state.busy;
    const trunkView = deps.state.treeState === null ? null : branchView(trunkBranchId());
    const trunkUnavailable = trunkView !== null && trunkView.sessionAvailability === "unavailable";
    const trunkLocked = busy || trunkUnavailable;
    $("prompt-input").disabled = busy;
    $("prompt-input").placeholder = trunkUnavailable
      ? "Session missing on the Trunk — type the first question of a new exploration, then “Start new exploration”…"
      : "继续对话…";
    $("send").disabled = trunkLocked;
    $("new-exploration").hidden = !trunkUnavailable;
    $("new-exploration").disabled = busy;
    const panelView = deps.state.panelBranchId === null ? null : branchView(deps.state.panelBranchId);
    const panelUnavailable = panelView !== null && panelView.sessionAvailability === "unavailable";
    const panelLocked = busy || panelUnavailable;
    $("panel-prompt-input").disabled = busy;
    $("panel-prompt-input").placeholder = panelUnavailable
      ? "Session missing on this branch — type the first question of a new exploration, then “Start new exploration”…"
      : "继续对话…";
    $("panel-send").disabled = panelLocked;
    $("panel-new-exploration").hidden = !panelUnavailable;
    $("panel-new-exploration").disabled = busy;
    $("submit-return").disabled = busy;
    $("new-tree").disabled = busy;
  }


  /* ------------------------------ 视图辅助 ------------------------------ */

  function trunkBranchId() {
    return deps.state.treeState === null ? null : deps.state.treeState.trunkBranchId;
  }


  function branchView(branchId) {
    if (deps.state.treeState === null || branchId === null) return null;
    return deps.state.treeState.branches.find((view) => view.branch.id === branchId) ?? null;
  }


  /** 每分支阅读位置键（W2 §4：切树/切分支后回来恢复原位）。 */
  function scrollKey(branchId) {
    const view = branchView(branchId);
    const round = view ? deps.currentSessionRound(view).round : null;
    return `${deps.state.currentTreeId}:${branchId}:${round?.id || "empty"}`;
  }


  /** 流式占位 turn 所属的滚动容器（主线 or 面板）。 */
  function conversationContainerId(branchId) {
    return branchId === trunkBranchId() ? "conversation" : "panel-conversation";
  }


  /* ------------------------------ 渲染 ------------------------------ */

  function branchLabel(branchId) {
    const st = deps.state.treeState;
    if (st === null) return branchId;
    if (branchId === st.trunkBranchId) return "Trunk";
    const index = st.branches.findIndex((view) => view.branch.id === branchId);
    return `Branch ${index}`;
  }
   /* `${treeId}:${turnId}` → epoch ms */

  /** 该 Return 的采用尝试记录（signed v3 §3.2：save ≠ 尝试 ≠ 首次成功采用）。
      视图字段缺失（旧快照）时按空列表处理——卡片降级回“已保存”语义。 */
  function returnAttemptsFor(view, turnId) {
    return (view.returnAttempts ?? []).filter((attempt) => attempt.turnId === turnId);
  }


  /** 时间戳的产品事实格式化（P1：确认/采用时间都取产品 turn/run 字段）。 */
  function formatProductTime(iso) {
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  }

  function mutedLine(text) {
    const p = deps.document.createElement("p");
    p.className = "muted";
    p.textContent = text;
    return p;
  }


  /** 列表状态行（li.muted 通用件）。 */
  function mutedListItem(text) {
    const li = deps.document.createElement("li");
    li.className = "muted";
    li.textContent = text;
    return li;
  }


  /* ------------------------------ 窄窗侧栏抽屉 ------------------------------ */

  function closeSidebar() {
    deps.document.body.classList.remove("sidebar-open");
    $("sidebar-toggle").setAttribute("aria-expanded", "false");
  }

  return {
    api,
    trunkBranchId,
    $,
    branchView,
    scrollBehavior,
    closeSidebar,
    guard,
    branchLabel,
    isAtBottom,
    returnAttemptsFor,
    scrollKey,
    conversationContainerId,
    mutedLine,
    showError,
    formatProductTime,
    updateComposerLocks,
    mutedListItem,
  };
}
