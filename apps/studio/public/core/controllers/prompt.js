/** Conversation prompts, explicit new explorations, abort requests and authoritative quiet refresh. Instance-owned state and dependencies. */

export function createPromptController(deps) {


  /**
   * 发送 prompt（主线 or 面板）：branchId 显式携带（prompt 端点自导航，
   * 不依赖游标）；在途观测走 SSE（不可用时降级轮询）；接收新 turn 的视图
   * 贴底，另一视图恢复原位；发送后焦点保持在发送视图的输入框（W2 §2.2）。
   *
   * 终局渲染是硬保证（成功 / 中止 / 失败共用收尾）：流式占位清除、
   * session-corrupt 后的恢复横幅/降级提示、最终树态与诊断面都在错误上抛
   * 之前落位——即使 SSE 全程无事件（无 run-terminal 推送收尾），失败后
   * 页面也绝不停留在「占位悬空 / 横幅缺失」的中间态。
   */
  async function sendPrompt(viewKind) {
    const isPanel = viewKind === "panel";
    const branchId = isPanel ? deps.state.panelBranchId : deps.trunkBranchId();
    const input = deps.$(isPanel ? "panel-prompt-input" : "prompt-input");
    const text = input.value;
    if (branchId === null || text.trim() === "") return;
    if (!deps.studioEventsController.sseHealthy) deps.startDiagnosticsPolling();
    let promptError = null;
    try {
      const payload = await deps.api(`/api/trees/${encodeURIComponent(deps.state.currentTreeId)}/prompt`, "POST", {
        branchId,
        text,
      });
      deps.state.treeState = payload.state;
      input.value = "";
      if (isPanel) deps.state.forcePanelSessionNote = false;
      else deps.state.forceSessionBanner = false;
      /* ①阅读模式：回答完成后刷新术语读模型（SSE run-terminal 同路径幂等；
         写入点守卫在 refreshTerminology 内——切树迟到响应整包丢弃）。 */
      await deps.refreshTerminology();
    } catch (err) {
      if (err !== null && typeof err === "object" && err.code === "user-abort") {
        /* 用户主动中止：run 已收敛为 aborted（无新 turn）。保留输入文本供改写重发，
           刷新树状态与诊断面后如常呈现。 */
        await refreshTreeStateQuietly();
      } else {
        promptError = err;
        if (err !== null && typeof err === "object" && err.code === "session-corrupt") {
          /* A4：缺失/损坏 session 的可执行恢复提示（不只有瞬时错误横幅）。 */
          if (isPanel) deps.state.forcePanelSessionNote = true;
          else deps.state.forceSessionBanner = true;
          await refreshTreeStateQuietly();
        }
      }
    } finally {
      deps.stopDiagnosticsPolling();
      deps.state.activeRunInfo = null;
      deps.state.streaming = null;
    }
    /* 终局渲染（所有收尾路径共用）：清掉流式占位、呈现恢复横幅与最终树态。
       失败路径的诊断面刷新尽力而为——刷新失败不得掩盖原始 prompt 错误。 */
    deps.renderAll({ stick: branchId });
    if (promptError === null) {
      await deps.refreshDiagnostics();
      deps.focusComposerWhenSelectable(input);
    } else {
      await deps.refreshDiagnostics().catch(() => {});
      throw promptError;
    }
  }


  /** 失败收尾的尽力状态刷新：刷新失败不掩盖/替换原始错误（保留既有树态照常渲染）。 */
  async function refreshTreeStateQuietly() {
    if (deps.state.currentTreeId === null) return;
    try {
      deps.state.treeState = await deps.api(`/api/trees/${encodeURIComponent(deps.state.currentTreeId)}/state`);
    } catch {
      /* 保留当前树态；原始错误照常上抛由 guard 呈现 */
    }
  }


  /**
   * 「以保存内容开始新的探索」（signed v3 §4.4）：session 不可用分支的显式
   * 换轨入口（主线/面板 composer 的「⑃ Start new exploration」）。首问文本
   * 取自当前输入框；点击即用户确认流（confirm 二次确认：新会话、旧上下文
   * 不恢复、旧历史保持可读——不冒充旧会话恢复）。成功 → 树态落地、输入清
   * 空、session 恢复可用（横幅/降级提示随之下线）、焦点回输入框；前置条件
   * 不满足（409，session 仍可用/无历史 session）由 guard 呈现原错误。
   */
  async function startNewExploration(viewKind) {
    const isPanel = viewKind === "panel";
    const branchId = isPanel ? deps.state.panelBranchId : deps.trunkBranchId();
    const input = deps.$(isPanel ? "panel-prompt-input" : "prompt-input");
    if (branchId === null) return;
    const text = input.value;
    if (text.trim() === "") {
      deps.showError(
        "Type the first question for the new exploration first, then start it.",
        isPanel ? "panel" : "main",
      );
      input.focus();
      return;
    }
    const confirmed = deps.window.confirm(
      "Start a new exploration on this branch from saved content?\n\n" +
        "A new session will be created: the anchored excerpt and the saved history are re-included as the " +
        "first question's context, but the previous run context is NOT restored (this is not a session restore). " +
        "The old history stays readable.",
    );
    if (!confirmed) return;
    /* 材料 Branch（D4-3）走 material-new-exploration——材料来源上下文随行
       （#newExplorationMaterialContext）；可见性/确认流/收尾与 Turn 来源分支
       的换轨入口完全一致（v3 §4.4 既有语义）。 */
    const materialBranch = deps.isMaterialBranchView(deps.branchView(branchId));
    const payload = await deps.api(
      `/api/trees/${encodeURIComponent(deps.state.currentTreeId)}/branches/${encodeURIComponent(branchId)}` +
        `${materialBranch ? "/material-new-exploration" : "/new-exploration"}`,
      "POST",
      { text },
    );
    deps.state.treeState = payload.state;
    input.value = "";
    if (isPanel) deps.state.forcePanelSessionNote = false;
    else deps.state.forceSessionBanner = false;
    /* 用户执行了换轨动作：清除横幅 dismiss 记录（横幅按当前事实重新呈现）。 */
    const trunk = deps.trunkBranchId();
    if (trunk !== null) deps.state.dismissedSessionBannerTrunks.delete(trunk);
    deps.renderAll({ stick: branchId });
    await deps.refreshDiagnostics();
    deps.focusComposerWhenSelectable(input);
  }


  /** Abort the active run. Bypasses the busy guard on purpose: the whole point
   *  is to be clickable while a prompt is in flight. */
  async function abortActiveRun() {
    const diag = deps.state.diagnostics;
    if (diag === null || diag.activeRun === null || deps.state.currentTreeId === null) return;
    const button = deps.$("abort-run");
    button.disabled = true;
    button.textContent = "Aborting…";
    try {
      await deps.api(
        `/api/trees/${encodeURIComponent(deps.state.currentTreeId)}/runs/${encodeURIComponent(diag.activeRun.runId)}/abort`,
        "POST",
      );
    } catch (err) {
      deps.showError(String(err && err.message ? err.message : err));
    }
    await deps.refreshDiagnostics();
  }

  return {
    sendPrompt,
    startNewExploration,
    abortActiveRun,
  };
}
