/** Serial navigation snapshots; only user actions enqueue writes, restoration stays read-only. */
export function createNavPersistenceController(deps) {
  const { getState, api, renderNavTreeStatusOnly } = deps;
  const state = getState();

  /**
   * 整组持久化（PUT expand-state：expandedBranchIds 全集 + selectedBranchId
   * ——服务端校验成员归属）。串行 + 最新快照胜出：连续展开/收起不等逐个
   * PUT 完成，队列只发最新整组（乱序到达不落旧态）。失败如实注记（浏览不
   * 阻断），成功清除注记。
   */
  function scheduleNavPersist(session) {
    session.persistQueued = true;
    if (session.persistRunning) return;
    session.persistRunning = true;
    const run = async () => {
      for (;;) {
        if (!session.persistQueued) break;
        session.persistQueued = false;
        const body = {
          expandedBranchIds: [...session.expanded],
          selectedBranchId: session.selectedBranchId,
        };
        try {
          await api(`/api/nav/trees/${encodeURIComponent(session.treeId)}/expand-state`, "PUT", body);
          if (state.nav.session !== session) return;
          session.persistError = null;
        } catch (err) {
          if (state.nav.session !== session) return;
          session.persistError = String(err && err.message ? err.message : err);
        }
      }
      session.persistRunning = false;
      if (state.nav.session === session) renderNavTreeStatusOnly(session);
    };
    void run();
  }

  return { scheduleNavPersist };
}
