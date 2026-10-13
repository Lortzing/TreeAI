
/** api-observation runner operations with the original shared run state Instance-owned state and dependencies. */

export function createApiObservation(deps) {

  async function phaseSse() {
    await deps.runCheck("sse-event-surface", async () => {
      deps.assert(deps.sc.sse !== null, "scenario wiring: SSE stream missing");
      await deps.sc.sse.drain();
      const frames = deps.sc.sse.frames;
      const snapshots = frames.filter((frame) => frame.event === "snapshot");
      const started = frames.filter((frame) => frame.event === "run-started");
      const terminal = frames.filter((frame) => frame.event === "run-terminal");
      const deltas = frames.filter((frame) => frame.event === "message-delta");
      const aborts = frames.filter((frame) => frame.event === "abort-requested");
      const tools = frames.filter((frame) => frame.event === "tool-activity");
      /* A5 产品面场景在独立探针树上运行——主树计数与无工具基线一致。 */
      const expectedRuns = deps.MODE === "echo-selftest" ? 9 : 7;
      deps.assert(snapshots.length === 1, `expected exactly one snapshot frame (got ${String(snapshots.length)})`);
      deps.assert(snapshots[0].data?.treeId === deps.sc.treeId, "snapshot frame is not for this tree");
      deps.assert(started.length === expectedRuns, `expected ${String(expectedRuns)} run-started frames (got ${String(started.length)})`);
      deps.assert(terminal.length === expectedRuns, `expected ${String(expectedRuns)} run-terminal frames (got ${String(terminal.length)})`);
      const stateMix = {};
      for (const frame of terminal) {
        const state = frame.data?.state;
        deps.assert(typeof state === "string", "run-terminal frame without a state");
        stateMix[state] = (stateMix[state] ?? 0) + 1;
        deps.assert(frame.data?.treeId === deps.sc.treeId, "run-terminal frame for a different tree");
      }
      const expectedMix = deps.MODE === "echo-selftest" ? { succeeded: 8, failed: 1 } : { succeeded: 7 };
      for (const [state, count] of Object.entries(expectedMix)) {
        deps.assert((stateMix[state] ?? 0) === count, `run-terminal state mix: ${state} x ${String(stateMix[state] ?? 0)} (expected ${String(count)})`);
      }
      if (deps.MODE === "echo-selftest") {
        deps.assert(deltas.length === 16, `expected 16 message-delta frames (2 per echo answer; got ${String(deltas.length)})`);
      } else {
        /* 每个成功 run 至少一个文本增量（real-pi 主树 7 个 run 全部成功）。 */
        deps.assert(deltas.length >= 7, `expected >= 7 message-delta frames (got ${String(deltas.length)})`);
      }
      deps.assert(aborts.length === 0, "unexpected abort-requested frames");
      /* 两段式结构：SSE 流覆盖零工具引导——不可能出现 tool-activity 帧
         （工具缝仅在 A5 阶段的第二次引导出现；其帧面由 A5 检查在探针树
         上断言）。 */
      deps.assert(tools.length === 0, "unexpected tool-activity frames (the scenario runs on a zero-tools boot)");
      const startedIds = new Set(started.map((frame) => frame.data?.runId));
      const terminalIds = new Set(terminal.map((frame) => frame.data?.runId));
      deps.assert(startedIds.size === expectedRuns && terminalIds.size === expectedRuns, "duplicate run ids in SSE frames");
      const missing = [...deps.sc.runIds].filter((id) => !startedIds.has(id));
      deps.assert(missing.length === 0, `runs missing from the SSE stream: ${missing.join(", ")}`);
      const extra = [...startedIds].filter((id) => !deps.sc.runIds.has(id));
      deps.assert(extra.length === 0, `unknown runs in the SSE stream: ${extra.join(", ")}`);
      await deps.sc.sse.close();
      return {
        detail: `${String(started.length)} run-started / ${String(terminal.length)} run-terminal (mix ${JSON.stringify(stateMix)}) / ${String(deltas.length)} message-delta / 0 abort`,
      };
    });
  }

  async function phaseDiagnostics() {
    await deps.runCheck("diagnostics-projection", async () => {
      const diag = await deps.api(deps.sc.port, "GET", deps.treePath("diagnostics"));
      deps.assert(diag.status === 200, `diagnostics failed: ${deps.errDetail(diag)}`);
      const body = diag.body;
      deps.assert(body?.runtimeState === "idle", `runtimeState is ${String(body?.runtimeState)} (expected idle at rest)`);
      deps.assert(body?.activeRun === null, "activeRun is not null at rest");
      /* A5 产品面场景在独立探针树上运行——主树计数与无工具基线一致。 */
      const expectedRuns = deps.MODE === "echo-selftest" ? 9 : 7;
      deps.assert(body?.runs?.length === expectedRuns, `diagnostics lists ${String(body?.runs?.length)} runs (expected ${String(expectedRuns)})`);
      const stateMix = {};
      for (const run of body.runs) {
        const keys = Object.keys(run).sort();
        deps.assert(
          JSON.stringify(keys) === JSON.stringify(deps.RUN_ROW_KEYS),
          `run row key set mismatch: ${JSON.stringify(keys)}`,
        );
        stateMix[run.state] = (stateMix[run.state] ?? 0) + 1;
        deps.assert(run.terminalAt !== null, `run ${String(run.runId)} has no terminalAt`);
        if (run.state !== "failed") deps.assert(run.failure === null, `non-failed run ${String(run.runId)} carries a failure`);
      }
      const expectedMix = deps.MODE === "echo-selftest" ? { succeeded: 8, failed: 1 } : { succeeded: 7 };
      for (const [state, count] of Object.entries(expectedMix)) {
        deps.assert((stateMix[state] ?? 0) === count, `run state mix: ${state} x ${String(stateMix[state] ?? 0)} (expected ${String(count)})`);
      }
      if (deps.MODE === "echo-selftest") {
        const failedRun = body.runs.find((run) => run.state === "failed");
        deps.assert(failedRun?.failure?.code === "upstream", "failed run code is not upstream");
        deps.assert(
          JSON.stringify(Object.keys(failedRun.failure).sort()) === JSON.stringify(["code", "message"]),
          "failure projection key set mismatch",
        );
      }
      /* 两段式结构：诊断面在零工具引导上读取——observed 必须如实为 false
        （工具面观测在 A5 阶段的探针树诊断上断言）。 */
      deps.assert(body?.policyDecisions?.observed === false, "policyDecisions.observed must be false (zero-tools boot)");
      deps.assert(typeof body?.policyDecisions?.reason === "string" && body.policyDecisions.reason.length > 0, "policyDecisions.reason missing");
      return { detail: `safe projection verified for ${String(body.runs.length)} runs; policy note honest for this wiring` };
    });
  }

  async function phaseJournal() {
    await deps.runCheck("journal-no-leak", async () => {
      const res = await deps.api(deps.sc.port, "GET", `${deps.treePath("journal")}?limit=500`);
      deps.assert(res.status === 200, `journal endpoint failed: ${deps.errDetail(res)}`);
      const events = res.body?.events;
      deps.assert(Array.isArray(events), "journal response has no events array");
      const minimum = deps.MODE === "echo-selftest" ? 50 : 10;
      deps.assert(events.length >= minimum, `journal lists only ${String(events.length)} events (expected >= ${String(minimum)})`);
      const blob = [];
      for (const event of events) {
        const keys = Object.keys(event).sort();
        deps.assert(
          JSON.stringify(keys) === JSON.stringify(deps.JOURNAL_EVENT_KEYS),
          `journal event key set mismatch: ${JSON.stringify(keys)}`,
        );
        deps.assert(typeof event.summary === "string" && event.summary.length > 0, "journal event without a summary");
        blob.push(`${String(event.type)} ${event.summary}`);
      }
      const text = blob.join("\n");
      /* 两段式结构：journal 检查在零工具引导、A5 阶段之前读取——主树
         journal 不含任何 A5 场景内容（探针树 journal 的 canary/marker 扫描
         由 A5-product-tool-policy-deny-provenance 在探针树上执行）。 */
      for (const canary of deps.CANARIES) {
        deps.assert(!deps.containsIgnoreCase(text, canary), `journal projection leaks the scenario canary '${canary}'`);
      }
      return { detail: `${String(events.length)} journal events, whitelist key set exact, no scenario canary leakage` };
    });
  }

  async function phaseRestart() {
    await deps.runCheck("restart-persistence", async () => {
      /* 重启前的权威状态快照。 */
      const pre = await deps.fetchState();
      const preCounts = {
        [deps.sc.trunkId]: deps.turnCount(pre, deps.sc.trunkId),
        [deps.sc.branchA]: deps.turnCount(pre, deps.sc.branchA),
        [deps.sc.branchB]: deps.turnCount(pre, deps.sc.branchB),
      };
      /* A5 场景在独立探针树上运行——主树回合数与无工具基线一致。 */
      const expectedPre =
        deps.MODE === "echo-selftest"
          ? { trunk: 7, branchA: 4, branchB: 6 }
          : { trunk: 7, branchA: 4, branchB: 4 };
      deps.assert(preCounts[deps.sc.trunkId] === expectedPre.trunk, `pre-restart trunk turns ${String(preCounts[deps.sc.trunkId])} (expected ${String(expectedPre.trunk)})`);
      deps.assert(preCounts[deps.sc.branchA] === expectedPre.branchA, `pre-restart branch A turns ${String(preCounts[deps.sc.branchA])}`);
      deps.assert(preCounts[deps.sc.branchB] === expectedPre.branchB, `pre-restart branch B turns ${String(preCounts[deps.sc.branchB])}`);
      const preBranchIds = pre.branches.map((view) => view.branch.id).sort();

      /* 宿主重启（kill -9，无优雅关闭）→ 同数据目录重启。 */
      const first = deps.sc.studios[0];
      first.child.kill("SIGKILL");
      await deps.waitForExit(first.child, 10_000);
      const second = await deps.startStudio(deps.sc.dataDir);
      deps.sc.studios.push(second);
      deps.sc.port = second.port;

      const listed = await deps.api(deps.sc.port, "GET", "/api/trees");
      /* A5 探针树随数据目录一同落库——重启后树列表 = 主树 + （A5 运行过的）
         探针树，逐棵对照 ID 而非只数数量。 */
      const expectedTreeIds = [deps.sc.treeId, ...(deps.sc.toolPolicy.treeId !== null ? [deps.sc.toolPolicy.treeId] : [])].sort();
      const listedIds = (listed.body?.trees ?? []).map((tree) => tree.id).sort();
      deps.assert(
        listed.status === 200 && JSON.stringify(listedIds) === JSON.stringify(expectedTreeIds),
        `tree list after restart is ${JSON.stringify(listedIds)} (expected ${JSON.stringify(expectedTreeIds)})`,
      );
      deps.assert(listedIds.includes(deps.sc.treeId), "the scenario tree did not survive the restart");

      const post = await deps.fetchState();
      deps.assert(post.trunkBranchId === deps.sc.trunkId, "trunkBranchId changed across the restart");
      deps.assert(post.branches.length === 3, `branch count after restart is ${String(post.branches.length)}`);
      const postBranchIds = post.branches.map((view) => view.branch.id).sort();
      deps.assert(JSON.stringify(postBranchIds) === JSON.stringify(preBranchIds), "branch ids changed across the restart");
      for (const view of post.branches) {
        deps.assert(view.sessionAvailability === "available", `branch ${String(view.branch.id)} sessionAvailability is ${String(view.sessionAvailability)} after restart`);
      }
      for (const [branchId, count] of Object.entries(preCounts)) {
        deps.assert(deps.turnCount(post, branchId) === count, `turn count for ${branchId} changed across the restart`);
      }
      deps.assert(JSON.stringify(post.cursor) === JSON.stringify(pre.cursor), "cursor (persisted navigation) changed across the restart");

      /* 重启后主干续聊（restoreSession 路径）。 */
      const t4 = await deps.promptOk(deps.sc.trunkId, deps.SCENARIO.t4);
      deps.sc.answers.t4 = t4.outcome.assistantTurn.text;
      if (deps.MODE === "echo-selftest") {
        deps.assertEchoMode(deps.sc.answers.t4, deps.echoAnswer(deps.SCENARIO.t1, deps.SCENARIO.t2, deps.sc.composedT3, deps.SCENARIO.t4), "post-restart trunk turn");
      } else {
        deps.assertContainsMarkers(deps.sc.answers.t4, ["maple", "4127", "aspen"], "post-restart trunk answer");
        deps.assertAbsentMarkers(deps.sc.answers.t4, ["cedar", "birch"], "post-restart trunk answer");
      }
      const diag = await deps.api(deps.sc.port, "GET", deps.treePath("diagnostics"));
      deps.assert(diag.body?.runtimeState === "idle", "runtimeState is not idle after the restart prompt");
      for (const run of diag.body?.runs ?? []) {
        deps.assert(run.terminalAt !== null, `run ${String(run.runId)} is not terminal after the restart`);
      }
      return { detail: "SIGKILL + same-data restart: tree/branches/turns/cursor intact; trunk continuation works" };
    });
  }

  return {
    phaseSse,
    phaseDiagnostics,
    phaseJournal,
    phaseRestart,
  };
}
