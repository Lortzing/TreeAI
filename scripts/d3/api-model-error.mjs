import { existsSync, mkdtempSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
/** api-model-error runner operations with the original shared run state Instance-owned state and dependencies. */

export function createApiModelError(deps) {

  async function phaseModelError() {
    await deps.runCheck("model-error-convergence", async () => {
      if (deps.MODE === "echo-selftest") {
        const before = deps.turnCount(await deps.fetchState(), deps.sc.branchB);
        const failed = await deps.api(deps.sc.port, "POST", deps.treePath("prompt"), { branchId: deps.sc.branchB, text: deps.SCENARIO.fail }, deps.CLI.promptTimeoutMs);
        deps.assert(failed.status === 502, `/fail prompt must map to 502 (got ${String(failed.status)})`);
        deps.assert(failed.body?.error?.code === "upstream", `error code is ${String(failed.body?.error?.code)} (expected upstream)`);
        deps.assert(/simulated upstream failure/.test(String(failed.body?.error?.message ?? "")), "error message does not match the echo failure hook");
        const midState = await deps.fetchState();
        deps.assert(deps.turnCount(midState, deps.sc.branchB) === before, "a failed prompt must persist no turns");
        const diag = await deps.api(deps.sc.port, "GET", deps.treePath("diagnostics"));
        const failedRun = (diag.body?.runs ?? []).find((run) => run.state === "failed");
        deps.assert(failedRun !== undefined, "diagnostics shows no failed run");
        deps.assert(failedRun.failure?.code === "upstream", "diagnostics failed run code is not upstream");
        deps.sc.failedRunId = failedRun.runId;
        deps.sc.runIds.add(failedRun.runId);
        /* 错误后的恢复：同一分支续聊可用。 */
        const recovery = await deps.promptOk(deps.sc.branchB, deps.SCENARIO.recoverB);
        deps.sc.answers.recoverB = recovery.outcome.assistantTurn.text;
        deps.assertEchoMode(
          deps.sc.answers.recoverB,
          deps.echoAnswer(deps.SCENARIO.t1, deps.SCENARIO.t2, deps.SCENARIO.b1, deps.SCENARIO.b2, deps.SCENARIO.fail, deps.SCENARIO.recoverB),
          "branch B recovery turn",
        );
        const after = deps.turnCount(await deps.fetchState(), deps.sc.branchB);
        deps.assert(after === before + 2, `branch B must hold ${String(before + 2)} turns after recovery (got ${String(after)})`);
        return { detail: "injected upstream failure converged failed (502, no turns); branch B usable again afterwards" };
      }

      /* real-pi：错误配置 registry 注入（20260929T104445Z-faults-model-error.md
         已证手法的跑批器化）。受控 agent 目录副本仅把 provider baseUrl 改为
         不可路由回环地址（连接立即被拒，绝不产生真实 provider 请求），凭据
         全程经环境变量注入且不变；错误 prompt 后换回原目录重启同一数据
         目录——「配置修复 + 重启恢复」闭环。独立探针树（同 A5 理由：全新
         session，主树的 SSE/诊断/重启计数不受影响；本检查晚于全部主树
         基线检查执行，见 main() 的双时序注释）。 */
      const banner = deps.stripSecret(deps.sc.studios[deps.sc.studios.length - 1].stdout);
      const agentMatch = /pi agent-dir=(.+?) \(controlled/.exec(banner);
      deps.assert(agentMatch !== null, "studio banner does not report the controlled agent dir");
      const sourceAgentDir = agentMatch[1];
      deps.assert(existsSync(sourceAgentDir), `the controlled agent dir reported by the banner does not exist: ${sourceAgentDir}`);

      /* 副本 + 仅改 provider baseUrl（其余 registry 字段逐字节保留；
         副本位于系统临时目录、数据目录之外——canary/数据目录扫描不受
         影响，cleanup 按绿色/失败语义处置）。 */
      const misconfigDir = mkdtempSync(join(tmpdir(), "treeai-d3-misconfig-agent-"));
      cpSync(sourceAgentDir, misconfigDir, { recursive: true });
      deps.sc.misconfigAgentDir = misconfigDir;
      const modelsPath = join(misconfigDir, "models.json");
      deps.assert(existsSync(modelsPath), `the controlled agent dir carries no models.json registry to misconfigure: ${sourceAgentDir}`);
      let registry;
      try {
        registry = JSON.parse(readFileSync(modelsPath, "utf8"));
      } catch (err) {
        throw new Error(`the registry copy could not be parsed: ${err instanceof Error ? err.message : String(err)}`);
      }
      const provider = registry?.providers?.[deps.CLI.provider];
      deps.assert(provider !== null && typeof provider === "object", `the registry has no provider entry for '${deps.CLI.provider}'`);
      deps.assert(typeof provider.baseUrl === "string" && provider.baseUrl.length > 0, `provider '${deps.CLI.provider}' has no baseUrl to misconfigure`);
      provider.baseUrl = deps.MISCONFIG_BASE_URL;
      writeFileSync(modelsPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

      /* 注入引导：SIGKILL 当前 studio（与 phaseRestart/A5 同一手法），以
         错误配置副本引导同一数据目录。 */
      const current = deps.sc.studios[deps.sc.studios.length - 1];
      current.child.kill("SIGKILL");
      await deps.waitForExit(current.child, 10_000);
      const misconfigStudio = await deps.startStudio(deps.sc.dataDir, false, misconfigDir);
      deps.sc.studios.push(misconfigStudio);
      deps.sc.port = misconfigStudio.port;
      const misconfigBanner = deps.stripSecret(misconfigStudio.stdout);
      deps.assert(
        misconfigBanner.includes(`pi agent-dir=${misconfigDir} (controlled`),
        "the misconfigured boot does not report the registry copy as its controlled agent dir",
      );
      console.log("    studio banner (sanitized, misconfigured boot):");
      for (const line of misconfigBanner.trim().split("\n")) {
        console.log(`      ${line}`);
      }

      /* 独立探针树：错误 prompt 与恢复 prompt 都走全新 session（同 A5 的
         已证条件）。 */
      const probe = await deps.api(deps.sc.port, "POST", "/api/trees");
      deps.assert(probe.status === 201, `probe tree creation failed: ${deps.errDetail(probe)}`);
      const probeTreeId = probe.body?.tree?.id;
      const probeTrunkId = probe.body?.trunkBranchId;
      deps.assert(typeof probeTreeId === "string" && probeTreeId.length > 0, "no tree id in the probe creation response");
      deps.assert(typeof probeTrunkId === "string" && probeTrunkId.length > 0, "no trunk branch id in the probe creation response");
      const probePath = (action) => `/api/trees/${encodeURIComponent(probeTreeId)}${action === undefined ? "" : `/${action}`}`;
      const probeTurnCount = async () => {
        const res = await deps.api(deps.sc.port, "GET", probePath("state"));
        deps.assert(res.status === 200, `probe state fetch failed: ${deps.errDetail(res)}`);
        return deps.turnCount(res.body, probeTrunkId);
      };

      /* 错误 prompt：provider 不可达 → 502、Run failed、零回合落库
         （SDK 内部重试有固定时长，promptTimeoutMs 覆盖；错误码按现行分类
         器如实登记——「连接错误归 unknown」是 104445Z 已记录的现行行为，
         是否需要更细的连接级错误码属 owner 契约决定）。 */
      const failed = await deps.api(
        deps.sc.port,
        "POST",
        probePath("prompt"),
        { branchId: probeTrunkId, text: "Reply with the single word: online." },
        deps.CLI.promptTimeoutMs,
      );
      deps.assert(failed.status === 502, `the misconfigured prompt must map to 502 (got ${String(failed.status)}): ${deps.errDetail(failed)}`);
      const errorCode = failed.body?.error?.code;
      deps.assert(typeof errorCode === "string" && errorCode.length > 0, "the misconfigured prompt returned no error code");
      deps.assert(await probeTurnCount() === 0, "a failed prompt must persist no turns");
      let probeDiag = await deps.api(deps.sc.port, "GET", probePath("diagnostics"));
      deps.assert(probeDiag.body?.runtimeState === "idle", `runtimeState is ${String(probeDiag.body?.runtimeState)} (expected idle) after the misconfigured prompt`);
      deps.assert(probeDiag.body?.activeRun === null, "activeRun is not null after the misconfigured prompt");
      const failedRun = (probeDiag.body?.runs ?? []).find((run) => run.state === "failed");
      deps.assert(failedRun !== undefined, "diagnostics shows no failed run for the misconfigured prompt");
      deps.assert(
        failedRun.failure?.code === errorCode,
        `the failed run carries code ${String(failedRun.failure?.code)} while the HTTP error carried ${String(errorCode)}`,
      );

      /* 恢复引导：SIGKILL，换回原受控目录重启同一数据目录（配置修复）。 */
      misconfigStudio.child.kill("SIGKILL");
      await deps.waitForExit(misconfigStudio.child, 10_000);
      const recoveryStudio = await deps.startStudio(deps.sc.dataDir);
      deps.sc.studios.push(recoveryStudio);
      deps.sc.port = recoveryStudio.port;
      const recoveryBanner = deps.stripSecret(recoveryStudio.stdout);
      deps.assert(
        recoveryBanner.includes(`pi agent-dir=${sourceAgentDir} (controlled`),
        "the recovery boot does not report the original controlled agent dir",
      );

      /* 同一探针树续聊：配置修复 + 重启后恢复（failed → succeeded 序列）。 */
      const recovery = await deps.api(
        deps.sc.port,
        "POST",
        probePath("prompt"),
        { branchId: probeTrunkId, text: "Reply with the single word: online." },
        deps.CLI.promptTimeoutMs,
      );
      deps.assert(recovery.status === 200, `the recovery prompt failed: ${deps.errDetail(recovery)}`);
      deps.assert(recovery.body?.outcome?.run?.state === "succeeded", `recovery run state is ${String(recovery.body?.outcome?.run?.state)}`);
      deps.assert(
        typeof recovery.body?.outcome?.assistantTurn?.text === "string" && recovery.body.outcome.assistantTurn.text.trim().length > 0,
        "the recovery answer is empty",
      );
      deps.assert(await probeTurnCount() === 2, "the recovery prompt did not persist its turn pair");
      probeDiag = await deps.api(deps.sc.port, "GET", probePath("diagnostics"));
      deps.assert(probeDiag.body?.runtimeState === "idle", "runtimeState is not idle after the recovery prompt");
      const runStates = (probeDiag.body?.runs ?? []).map((run) => `${run.state}${run.failure === null ? "" : `(${String(run.failure.code)})`}`);
      deps.assert(
        JSON.stringify(runStates) === JSON.stringify([`failed(${errorCode})`, "succeeded"]),
        `the probe run sequence is ${JSON.stringify(runStates)} (expected [failed(${errorCode}), succeeded])`,
      );
      return {
        detail:
          `misconfigured registry (unroutable baseUrl) converged failed (502 ${errorCode}, no turns) on a fresh probe tree; ` +
          "original-registry restart recovered the same tree (failed → succeeded)",
      };
    });
  }

  return {
    phaseModelError,
  };
}
