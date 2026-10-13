/** Tree-scoped SSE lifecycle, prompt diagnostic polling and safe terminal-state refresh. Instance-owned state and dependencies. */

export function createStudioEventsController(deps) {


  /** Diagnostics poll timer — fallback while a prompt is active and SSE is down. */
  let diagnosticsTimer = null;

  const DIAGNOSTICS_POLL_MS = 500;


  /** SSE connection for the open tree (null when disconnected). */
  let eventSource = null;

  let sseHealthy = false;


  async function refreshDiagnostics() {
    if (deps.state.currentTreeId === null) {
      deps.state.diagnostics = null;
      deps.renderDiagnostics();
      return;
    }
    const diagnostics = await deps.api(`/api/trees/${encodeURIComponent(deps.state.currentTreeId)}/diagnostics`);
    if (deps.state.currentTreeId !== diagnostics.treeId) return; /* stale after a tree switch */
    deps.state.diagnostics = diagnostics;
    deps.renderDiagnostics();
  }


  function startDiagnosticsPolling() {
    if (diagnosticsTimer !== null) return;
    diagnosticsTimer = deps.window.setInterval(() => {
      void refreshDiagnostics().catch(() => {
        /* 轮询失败不打断在途 prompt；收尾刷新会呈现最终状态 */
      });
    }, DIAGNOSTICS_POLL_MS);
  }


  function stopDiagnosticsPolling() {
    if (diagnosticsTimer === null) return;
    deps.window.clearInterval(diagnosticsTimer);
    diagnosticsTimer = null;
  }


  /* ------------------------------ SSE 事件流（P1） ------------------------------ */

  function disconnectEvents() {
    if (eventSource !== null) {
      eventSource.close();
      eventSource = null;
    }
    sseHealthy = false;
  }


  /**
   * 订阅当前树的事件流。连接即收到 snapshot（诊断面）；随后按事件类型
   * 推送。SSE 出错时降级为轮询（EventSource 会自动重连，重连成功即恢复
   * 事件流并停止轮询）。
   */
  function connectEvents(treeId) {
    disconnectEvents();
    if (typeof deps.EventSource === "undefined") return; /* 降级：轮询兜底 */
    const source = new deps.EventSource(`/api/trees/${encodeURIComponent(treeId)}/events`);
    eventSource = source;
    source.onopen = () => {
      sseHealthy = true;
      stopDiagnosticsPolling();
    };
    source.onerror = () => {
      /* 断开/重连中：降级轮询；重连后 onopen 恢复。 */
      sseHealthy = false;
      if (deps.state.currentTreeId === treeId) startDiagnosticsPolling();
    };
    const isCurrent = () => deps.state.currentTreeId === treeId;
    source.addEventListener("snapshot", (event) => {
      if (!isCurrent()) return;
      const diag = JSON.parse(event.data);
      if (diag.treeId !== deps.state.currentTreeId) return;
      deps.state.diagnostics = diag;
      deps.renderDiagnostics();
    });
    source.addEventListener("run-started", (event) => {
      if (!isCurrent()) return;
      const info = JSON.parse(event.data);
      deps.state.activeRunInfo = info;
      if (deps.state.diagnostics !== null) {
        deps.state.diagnostics.runtimeState = "streaming";
        deps.state.diagnostics.activeRun = {
          runId: info.runId,
          branchId: info.branchId,
          episodeId: info.episodeId,
        };
      }
      /* 流式占位：在途 run 位于主线或打开的面板分支时呈现（接收视图贴底）。 */
      if (info.branchId === deps.trunkBranchId() || info.branchId === deps.state.panelBranchId) {
        deps.state.streaming = { runId: info.runId, branchId: info.branchId, text: "" };
        deps.renderAll({ stick: info.branchId });
      }
      deps.renderDiagnostics();
    });
    source.addEventListener("message-delta", (event) => {
      if (!isCurrent()) return;
      const delta = JSON.parse(event.data);
      const active = deps.state.activeRunInfo;
      if (active === null || delta.runId !== active.runId) return;
      if (active.branchId !== deps.trunkBranchId() && active.branchId !== deps.state.panelBranchId) {
        return; /* 在途 run 不在可见视图（如面板已收起）：不呈现占位 */
      }
      if (deps.state.streaming === null || deps.state.streaming.runId !== delta.runId) {
        deps.state.streaming = { runId: delta.runId, branchId: active.branchId, text: "" };
      }
      deps.state.streaming.text += delta.delta;
      deps.updateStreamingPlaceholder();
    });
    source.addEventListener("abort-requested", (event) => {
      if (!isCurrent()) return;
      const payload = JSON.parse(event.data);
      if (deps.state.diagnostics !== null && deps.state.activeRunInfo !== null && payload.runId === deps.state.activeRunInfo.runId) {
        deps.state.diagnostics.runtimeState = "aborting";
      }
      deps.renderDiagnostics();
    });
    source.addEventListener("run-terminal", (event) => {
      if (!isCurrent()) return;
      JSON.parse(event.data);
      const terminalBranchId = deps.state.activeRunInfo === null ? null : deps.state.activeRunInfo.branchId;
      deps.state.activeRunInfo = null;
      deps.state.streaming = null;
      /* /state 是权威读模型：终态后整树刷新（prompt 响应也会刷新，幂等）。
         接收新 turn 的视图贴底；另一视图恢复其阅读位置。P1 同族规则（issue
         #7 增量验收）：刷新期间切树 → 迟到的旧树 state 不写共享树态。
         ①阅读模式：回答完成后同步刷新术语读模型（自动建议集 pending→终态
         的入口——写入点守卫同 refreshTerminology；仍在途则由有界跟随轮询
         收口）。 */
      void (async () => {
        const treeId = deps.state.currentTreeId;
        if (treeId === null) return;
        try {
          const treeState = await deps.api(`/api/trees/${encodeURIComponent(treeId)}/state`);
          if (deps.state.currentTreeId !== treeId) return; /* 迟到丢弃 */
          deps.state.treeState = treeState;
          deps.renderAll({ stick: terminalBranchId });
        } catch {
          /* 刷新失败不打断；sendPrompt 的收尾刷新会重试 */
        }
        await deps.refreshTerminology();
        if (deps.state.currentTreeId === treeId) deps.renderAll();
        await refreshDiagnostics().catch(() => {});
      })();
    });
    source.addEventListener("tool-activity", (event) => {
      if (!isCurrent()) return;
      const activity = JSON.parse(event.data);
      deps.state.toolActivity = [...deps.state.toolActivity.slice(-19), activity];
      if (deps.state.drawerOpen) deps.renderDrawer();
    });
  }

  return {
    refreshDiagnostics,
    connectEvents,
    get sseHealthy() { return sseHealthy; },
    set sseHealthy(value) { sseHealthy = value; },
    startDiagnosticsPolling,
    stopDiagnosticsPolling,
    disconnectEvents,
  };
}
