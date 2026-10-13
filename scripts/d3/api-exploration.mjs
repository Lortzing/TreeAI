import { join } from "node:path";
import { readdirSync, readFileSync, rmSync } from "node:fs";
/** api-exploration runner operations with the original shared run state Instance-owned state and dependencies. */

export function createApiExploration(deps) {

  /** v3 §4.4（issue #7 P0-2）：session 删除后的 fail-closed 与用户确认的显式换轨（独立探针树，主树计数不动）。 */
  async function phaseNewExploration() {
    await deps.runCheck("new-exploration", async () => {
      /* 主树基线快照（phase 末 containment 校验用）。 */
      const mainBefore = await deps.fetchState();
      const mainCountsBefore = mainBefore.branches.map((view) => `${String(view.branch.id)}:${String(deps.turnCount(mainBefore, view.branch.id))}`);

      /* 探针树：一轮 Trunk prompt（marker 供 session 文件识别）。 */
      const marker = "new-exploration-probe";
      const created = await deps.api(deps.sc.port, "POST", "/api/trees", {});
      const probeTreeId = created.body?.tree?.id;
      const probeTrunk = created.body?.trunkBranchId;
      deps.assert(typeof probeTreeId === "string" && typeof probeTrunk === "string", `probe tree creation failed: ${deps.errDetail(created)}`);
      const t1 = await deps.api(
        deps.sc.port,
        "POST",
        `/api/trees/${encodeURIComponent(probeTreeId)}/prompt`,
        { branchId: probeTrunk, text: `${marker} q1` },
      );
      deps.assert(t1.status === 200, `probe trunk prompt failed: ${deps.errDetail(t1)}`);
      const probeAnswer = t1.body?.outcome?.assistantTurn?.text;

      /* 整进程重启（清内存 cursor/会话）+ 删除探针树的 session 文件（按内容定位）。 */
      const current = deps.sc.studios[deps.sc.studios.length - 1];
      current.child.kill("SIGKILL");
      await deps.waitForExit(current.child, 10_000);
      const sessionsDir = join(deps.sc.dataDir, "sessions");
      const probeSession = readdirSync(sessionsDir)
        .map((f) => join(sessionsDir, f))
        .find((p) => {
          try {
            return readFileSync(p, "utf8").includes(marker);
          } catch {
            return false;
          }
        });
      deps.assert(probeSession !== undefined, "the probe tree's session file is identifiable by its marker");
      rmSync(probeSession);
      const studio = await deps.startStudio(deps.sc.dataDir);
      deps.sc.studios.push(studio);
      deps.sc.port = studio.port;

      /* fail-closed 纪律不变：普通续聊 502 session-corrupt。 */
      const failed = await deps.api(
        deps.sc.port,
        "POST",
        `/api/trees/${encodeURIComponent(probeTreeId)}/prompt`,
        { branchId: probeTrunk, text: "normal continuation must fail closed" },
      );
      deps.assert(
        failed.status === 502 && failed.body?.error?.code === "session-corrupt",
        `normal continuation after session loss: ${String(failed.status)} ${JSON.stringify(failed.body?.error?.code ?? null)}`,
      );

      /* 显式换轨：200 + 首问成功 + 诚实标记 + 旧历史可读 + 恢复可用。 */
      const exploration = await deps.api(
        deps.sc.port,
        "POST",
        `/api/trees/${encodeURIComponent(probeTreeId)}/branches/${encodeURIComponent(probeTrunk)}/new-exploration`,
        { text: "the new exploration first question" },
      );
      deps.assert(exploration.status === 200, `new exploration failed: ${deps.errDetail(exploration)}`);
      deps.assert(exploration.body?.outcome?.run?.state === "succeeded", "the new exploration's first question must succeed");
      const userTurn = exploration.body?.outcome?.userTurn;
      deps.assert(
        typeof userTurn?.text === "string" && userTurn.text.includes("[new exploration from saved content"),
        "the user turn carries the honest not-restored marker",
      );
      deps.assert(userTurn.text.endsWith("the new exploration first question"), "the typed question stays readable after the marker");
      const probeState = await deps.api(deps.sc.port, "GET", `/api/trees/${encodeURIComponent(probeTreeId)}/state`);
      const probeView = (probeState.body?.branches ?? []).find((view) => view.branch.id === probeTrunk);
      deps.assert(probeView?.sessionAvailability === "available", "the probe trunk recovers on the new session");
      deps.assert(probeView.turns.length === 4, `old history + two new turns (got ${String(probeView?.turns?.length ?? -1)})`);
      deps.assert(probeView.turns[0]?.text === `${marker} q1`, "the old user turn is untouched");
      deps.assert(probeView.turns[1]?.text === probeAnswer, "the old assistant turn is untouched");

      /* session 已可用 → 再次换轨 409（应走普通续聊）。 */
      const conflict = await deps.api(
        deps.sc.port,
        "POST",
        `/api/trees/${encodeURIComponent(probeTreeId)}/branches/${encodeURIComponent(probeTrunk)}/new-exploration`,
        { text: "should conflict now" },
      );
      deps.assert(
        conflict.status === 409 && conflict.body?.error?.code === "new-exploration-conflict",
        `healthy-session new exploration must 409 (got ${String(conflict.status)} ${JSON.stringify(conflict.body?.error?.code ?? null)})`,
      );

      /* 普通续聊恢复（续聊点 = 新 session 的最新 run）。 */
      const followUp = await deps.api(
        deps.sc.port,
        "POST",
        `/api/trees/${encodeURIComponent(probeTreeId)}/prompt`,
        { branchId: probeTrunk, text: "back to normal continuation" },
      );
      deps.assert(followUp.status === 200, `normal continuation on the new session failed: ${deps.errDetail(followUp)}`);

      /* Phase-end containment：主树分支集与回合数不变。 */
      const mainAfter = await deps.fetchState();
      const mainCountsAfter = mainAfter.branches.map((view) => `${String(view.branch.id)}:${String(deps.turnCount(mainAfter, view.branch.id))}`);
      deps.assert(
        JSON.stringify(mainCountsAfter) === JSON.stringify(mainCountsBefore),
        `main-tree counts changed during the new-exploration phase: ${JSON.stringify(mainCountsAfter)} vs ${JSON.stringify(mainCountsBefore)}`,
      );
      return {
        detail:
          "v3 §4.4 on a probe tree: session deleted → normal continuation fail-closed (502 session-corrupt) → explicit new exploration 200 (first question succeeds, honest not-restored marker, old history readable, availability recovers) → healthy re-exploration 409 → normal continuation works again; main tree untouched",
      };
    });
  }

  async function phaseAbort() {
    await deps.runCheck("mid-flight-abort", async () => {
      const trunkTurnsBefore = deps.turnCount(await deps.fetchState(), deps.sc.trunkId);
      /* 发起长生成但不等待；轮询诊断面直到 streaming。 */
      const essayPromise = deps.api(
        deps.sc.port,
        "POST",
        deps.treePath("prompt"),
        { branchId: deps.sc.trunkId, text: deps.SCENARIO.abortEssay },
        deps.CLI.promptTimeoutMs + 30_000,
      ).catch((err) => ({
        status: -1,
        body: { error: { code: "fetch-error", message: String(err instanceof Error ? err.message : err) } },
      }));
      let activeRunId = null;
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const diag = await deps.api(deps.sc.port, "GET", deps.treePath("diagnostics"), undefined, 5_000);
        if (diag.body?.runtimeState === "streaming" && diag.body?.activeRun?.runId !== undefined) {
          activeRunId = diag.body.activeRun.runId;
          break;
        }
        await deps.sleep(150);
      }
      deps.assert(activeRunId !== null, "never observed the in-flight run in the streaming state (model settled too fast?)");
      const abortRes = await deps.api(
        deps.sc.port,
        "POST",
        `/api/trees/${encodeURIComponent(deps.sc.treeId)}/runs/${encodeURIComponent(activeRunId)}/abort`,
      );
      deps.assert(abortRes.status === 200 && abortRes.body?.ok === true, `abort request failed: ${deps.errDetail(abortRes)}`);
      const essay = await essayPromise;
      deps.assert(essay.status === 409, `aborted prompt must settle as 409 (got ${String(essay.status)})`);
      deps.assert(essay.body?.error?.code === "user-abort", `aborted prompt code is ${String(essay.body?.error?.code)} (expected user-abort)`);
      const diag = await deps.api(deps.sc.port, "GET", deps.treePath("diagnostics"));
      deps.assert(diag.body?.runtimeState === "idle", "runtimeState is not idle after the abort");
      const abortedRun = (diag.body?.runs ?? []).find((run) => run.runId === activeRunId);
      deps.assert(abortedRun?.state === "aborted", `aborted run state is ${String(abortedRun?.state)}`);
      deps.assert(abortedRun.failure === null, "an aborted run must not carry a failure (user-abort is not a failure)");
      const turnsAfterAbort = deps.turnCount(await deps.fetchState(), deps.sc.trunkId);
      deps.assert(turnsAfterAbort === trunkTurnsBefore, "an aborted prompt must persist no turns");
      /* 中止后的恢复：同一主干续聊可用。 */
      const recovery = await deps.promptOk(deps.sc.trunkId, deps.SCENARIO.abortRecovered);
      const turnsAfterRecovery = deps.turnCount(await deps.fetchState(), deps.sc.trunkId);
      deps.assert(turnsAfterRecovery === trunkTurnsBefore + 2, "recovery prompt did not persist its turn pair");
      return {
        detail: `in-flight run ${String(activeRunId).slice(0, 12)}… aborted (409 user-abort, no turns); trunk usable again afterwards`,
      };
    });
  }

  return {
    phaseNewExploration,
    phaseAbort,
  };
}
