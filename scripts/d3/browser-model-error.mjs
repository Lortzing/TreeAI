import { existsSync, mkdtempSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
/** browser-model-error runner operations with the original shared run state Instance-owned state and dependencies. */

export function createBrowserModelError(deps) {

  /* ------------------------------------------------------------------ */
  /* 模型错误注入相（issue #6 P0-2 清单第 4 项模型错误腿的浏览器面）。       */
  /* 两种模式各有一条确定性注入路径（同一检查 id，双时序执行——见 main()）：  */
  /*   - selftest：echo /fail 钩子，主树，原位置（断言面自 v1.0.0 不变）；   */
  /*   - real-pi：错误配置 registry 的重启舞步（镜像 run-d3-real-pi.mjs      */
  /*     phaseModelError 的 real-pi 分支与 evidence/d3/real-pi/             */
  /*     20260929T104445Z-faults-model-error.md 已证手法）：受控 agent 目录   */
  /*     副本仅改 provider baseUrl 为不可路由回环地址（绝不产生真实 provider  */
  /*     请求；凭据全程环境注入且不变）→ SIGKILL 重启同一数据目录 → 全新     */
  /*     探针树 prompt：502 / Run failed / 零回合 / composer 复位（浏览器面  */
  /*     断言用户实际看到的呈现 + HTTP 交叉核对权威状态）→ 换回原 registry   */
  /*     重启 → 同树同一 prompt 成功（failed → succeeded 恢复闭环）。        */
  /* ------------------------------------------------------------------ */

  /** selftest 路径：/fail 钩子注入（本函数仅把原 main() 内联块原样提出——
   *  断言与执行时序逐字节不变；runCheck 包装留在调用点）。 */
  async function stepModelErrorEcho() {
    /* echo /fail 注入（selftest 专属确定性钩子）→ upstream 模拟失败。
       /fail 的 502 是预期的页面网络错误——采集窗口内不计入 console-clean。 */
    deps.chrome.expectPageErrors = true;
    try {
      await deps.sendTrunkPrompt(deps.SCENARIO.fail, { keyboard: false });
      await deps.waitForJs(
        "(() => { const b = document.getElementById('error-banner'); return b !== null && !b.hidden && b.textContent.length > 0; })()",
        deps.CLI.promptTimeoutMs,
        "error banner visible after /fail",
      );
    } finally {
      deps.chrome.expectPageErrors = false;
    }
    const summary = await deps.snap("model-error");
    deps.assert(summary.main.errorBanner.role === "alert", `error banner role is ${String(summary.main.errorBanner.role)}`);
    deps.assert((summary.main.errorBanner.text ?? "").includes("upstream"), `error banner text unexpected: ${deps.truncate(summary.main.errorBanner.text ?? "", 120)}`);
    /* 常驻失败面板：Run … failed — upstream: …（不自动隐藏）。 */
    await deps.waitForJs(
      "(() => { const p = document.getElementById('failure-panel'); return p !== null && !p.hidden && p.textContent.includes('upstream'); })()",
      10_000,
      "persistent failure panel with upstream code",
    );
    /* 失败后 composer 解锁（终局渲染保证）且主线可续用（恢复路径）。 */
    const composerEnabled = await deps.evalJs("document.getElementById('prompt-input').disabled === false");
    deps.assert(composerEnabled === true, "trunk composer did not re-enable after the failed run converged");
    await deps.sendTrunkPrompt(deps.SCENARIO.recovery, { keyboard: false });
    await deps.waitForAnswerMarkers("#conversation", deps.MODE === "selftest" ? ["back-online"] : ["back-online"], deps.CLI.promptTimeoutMs, 4);
    deps.sc.trunkTurnCount += 2; /* /fail 零回合落库；恢复 prompt 落 1 对回合（断言前登记） */
    const runs = (await deps.api("GET", `/api/trees/${encodeURIComponent(deps.sc.treeId)}/diagnostics`)).body?.runs ?? [];
    const failedRun = runs.find((r) => r.state === "failed");
    deps.assert(failedRun !== undefined, "no failed run recorded server-side after /fail");
    deps.assert((failedRun.failure?.code ?? "") === "upstream", `failed run code is ${String(failedRun.failure?.code)}`);
    await deps.snap("model-error-recovered");
    return { detail: `/fail converged as a failed run (banner role=alert text upstream, persistent failure panel, composer re-enabled); follow-up prompt succeeded; server shows the failed run (upstream)` };
  }

  /** 模型错误相探针树 API 路径。 */
  function mePath(action) {
    const me = deps.sc.modelError;
    deps.assert(me !== null && me.probeTreeId !== null, "scenario wiring: model-error probe tree missing (see stepModelErrorRealPi)");
    return `/api/trees/${encodeURIComponent(me.probeTreeId)}${action === undefined ? "" : `/${action}`}`;
  }

  async function renderedTurnCounts() {
    return deps.evalJs(
      `(async () => {
        const position = () => Number((document.getElementById('round-position')?.textContent ?? '').split('/')[0].trim()) || 0;
        const previous = document.getElementById('round-previous');
        const next = document.getElementById('round-next');
        const nav = document.getElementById('round-navigation');
        const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
        const original = position();
        const all = new Set();
        const assistants = new Set();
        const addPage = () => {
          for (const turn of document.querySelectorAll('#conversation .turn:not(#streaming-turn)')) {
            const id = turn.dataset.turnId ?? String(position()) + ':' + String(all.size);
            all.add(id);
            if (turn.classList.contains('assistant')) assistants.add(id);
          }
        };
        if (nav !== null && !nav.hidden && previous !== null && next !== null && position() > 0) {
          while (!previous.disabled) { previous.click(); await settle(); }
          for (;;) {
            addPage();
            if (next.disabled) break;
            next.click();
            await settle();
          }
          while (position() > original && !previous.disabled) { previous.click(); await settle(); }
        } else {
          addPage();
        }
        return { all: all.size, assistants: assistants.size };
      })()`,
    );
  }

  /** 真实侧栏点击选中指定树。整页刷新后 app.js 引导逻辑自动打开 trees[0]
   *  （repository 按创建序返回 = 最旧的主剧本树）——模型错误相的恢复
   *  prompt 必须落在探针树上，故先以真实点击切换（app.js renderTrees：
   *  #tree-list li button，首个 span = 完整树 id，选中态 = .active）。 */
  async function selectTreeInSidebar(treeId) {
    const target = JSON.stringify(treeId);
    const index = await deps.evalJs(
      "(() => { const items = [...document.querySelectorAll('#tree-list li button')]; " +
      `const hit = items.findIndex((b) => { const span = b.querySelector('span'); return span !== null && span.textContent === ${target}; }); ` +
      "return hit; })()",
    );
    deps.assert(typeof index === "number" && index >= 0, `tree ${String(treeId).slice(0, 8)}… not found in the sidebar tree list`);
    await deps.click(`#tree-list li:nth-of-type(${String(index + 1)}) button`);
    await deps.waitForJs(
      "(() => { const items = [...document.querySelectorAll('#tree-list li button')]; " +
      `const b = items[${String(index)}]; return b !== undefined && b.classList.contains('active') === true; })()`,
      10_000,
      "probe tree active in the sidebar after the click",
    );
  }

  /** 模型错误相的全新探针树（真实 #new-tree 点击，镜像 tool-policy-boot /
   *  openDeepProbeTree 的模式：新建即打开——干净 session；knownIds 差分
   *  确保恰好一棵新树；登记入 sc.modelError，不沾染 A2 相的探针树登记）。 */
  async function openModelErrorProbeTree() {
    const me = deps.sc.modelError;
    deps.assert(me !== null, "scenario wiring: model-error state missing (see main())");
    const treesBefore = await deps.api("GET", "/api/trees");
    deps.assert(treesBefore.status === 200, `GET /api/trees failed: ${String(treesBefore.status)}`);
    const knownIds = new Set((treesBefore.body?.trees ?? []).map((tree) => tree.id));
    await deps.click("#new-tree");
    await deps.waitForJs(
      "document.getElementById('tree-view') !== null && !document.getElementById('tree-view').hidden",
      10_000,
      "model-error probe tree view visible after the new-tree click",
    );
    const treesAfter = await deps.api("GET", "/api/trees");
    deps.assert(treesAfter.status === 200, `GET /api/trees failed after the model-error new-tree click: ${String(treesAfter.status)}`);
    const newTrees = (treesAfter.body?.trees ?? []).filter((tree) => !knownIds.has(tree.id));
    deps.assert(newTrees.length === 1, `the model-error new-tree click created ${String(newTrees.length)} new trees (expected exactly 1)`);
    const treeId = newTrees[0].id;
    const state = await deps.api("GET", `/api/trees/${encodeURIComponent(treeId)}/state`);
    deps.assert(state.status === 200, `model-error probe tree state fetch failed: ${String(state.status)}`);
    const trunkBranchId = state.body?.trunkBranchId;
    deps.assert(typeof trunkBranchId === "string" && trunkBranchId.length > 0, "model-error probe tree state has no trunk branch id");
    me.probeTreeId = treeId;
    me.probeTrunkId = trunkBranchId;
    return { treeId, trunkBranchId };
  }

  /** real-pi 路径：错误配置 registry 的重启舞步（独立探针树）。断言面 =
   *  用户实际看到的渲染 DOM（真实输入事件驱动）+ HTTP 交叉核对权威状态；
   *  错误码按现行分类器如实登记（连接类错误现行归 unknown——是否细化属
   *  owner 契约决定，断言只要求渲染面与诊断面一致）。 */
  async function stepModelErrorRealPi() {
    const me = deps.sc.modelError;
    deps.assert(deps.MODE === "real-pi" && me !== null, "scenario wiring: the model-error dance requires real-pi mode (see main())");

    /* 受控 agent 目录自当前引导横幅解析（原始 registry）。studio.stdoutRaw
       是唯一未脱敏的子进程输出留存（横幅路径正则需要原文）；任何派生
       输出必经 sanitizeText。 */
    const waitStudioBanner = async () => {
      const deadline = Date.now() + 5_000;
      for (;;) {
        if (/pi agent-dir=/.test(deps.studio.stdoutRaw) || Date.now() >= deadline) return deps.studio.stdoutRaw;
        await deps.sleep(100);
      }
    };
    const sourceAgentDir = (/pi agent-dir=(.+?) \(controlled/.exec(await waitStudioBanner()) ?? [])[1];
    deps.assert(typeof sourceAgentDir === "string" && sourceAgentDir.length > 0, "studio banner does not report the controlled agent dir");
    deps.assert(existsSync(sourceAgentDir), `the controlled agent dir reported by the banner does not exist: ${deps.sanitizeText(sourceAgentDir)}`);
    me.agentDir = sourceAgentDir;

    /* 主树遏制基线 + 既有树集合（相末核对：本相只新增自己的探针树）。 */
    const treesListBefore = await deps.api("GET", "/api/trees");
    deps.assert(treesListBefore.status === 200, `GET /api/trees failed: ${String(treesListBefore.status)}`);
    const mainBefore = await deps.api("GET", `/api/trees/${encodeURIComponent(deps.sc.treeId)}/state`);
    deps.assert(mainBefore.status === 200, `main tree state fetch failed: ${String(mainBefore.status)}`);
    const mainBeforeTrunk = (mainBefore.body?.branches ?? []).find((view) => view.branch.id === mainBefore.body?.trunkBranchId);
    me.baseline = {
      branchIds: (mainBefore.body?.branches ?? []).map((view) => view.branch.id),
      trunkTurnCount: (mainBeforeTrunk?.turns ?? []).length,
      treeIds: (treesListBefore.body?.trees ?? []).map((tree) => tree.id),
    };

    /* 副本 + 仅改 provider baseUrl（其余 registry 字段逐字节保留；副本位于
       系统临时目录——数据目录/canary 扫描与 gitInfo().dirty 均不受影响，
       cleanup 按保留/失败语义处置）。 */
    const misconfigDir = mkdtempSync(join(tmpdir(), "treeai-d3-misconfig-agent-"));
    me.misconfigDir = misconfigDir;
    cpSync(sourceAgentDir, misconfigDir, { recursive: true });
    const modelsPath = join(misconfigDir, "models.json");
    deps.assert(existsSync(modelsPath), `the controlled agent dir carries no models.json registry to misconfigure: ${deps.sanitizeText(sourceAgentDir)}`);
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

    /* 注入引导：SIGKILL 当前 studio（killStudioAndWait 防 studio.exited 竞态
       ——旧子进程迟到的 exit 事件会误标新引导），以错配副本引导同一数据
       目录；SSE 随服务死掉 → 整页刷新窗口的预期网络错误不计入
       console-clean。 */
    deps.chrome.expectPageErrors = true;
    let misconfigBanner = "";
    try {
      await deps.killStudioAndWait();
      await deps.startStudio(deps.sc.dataDir, { agentDir: misconfigDir, logName: "studio-misconfig.log" });
      await deps.navigate(deps.sc.studioUrl);
      misconfigBanner = await waitStudioBanner();
    } finally {
      deps.chrome.expectPageErrors = false;
    }
    deps.assert(
      misconfigBanner.includes(`pi agent-dir=${misconfigDir} (controlled`),
      "the misconfigured boot does not report the registry copy as its controlled agent dir",
    );

    /* 全新探针树：错误 prompt 与恢复 prompt 都走全新 session（干净面，
       主树各检查计数不受影响）。 */
    await openModelErrorProbeTree();

    /* 错误 prompt（真实 composer 输入 + 点击发送）：provider 不可达 → 502。
       SDK 内部重试有固定时长，promptTimeoutMs 覆盖；502 是预期的页面网络
       错误（采集窗口内不计入 console-clean）。 */
    const assistantBefore = await deps.probeAssistantTurnCount();
    deps.assert(assistantBefore === 0, `the fresh probe tree should render zero assistant turns (got ${String(assistantBefore)})`);
    let outcome;
    deps.chrome.expectPageErrors = true;
    try {
      await deps.sendTrunkPrompt(deps.SCENARIO.modelErrorProbe, { keyboard: false });
      outcome = await deps.waitForProbeOutcome(assistantBefore, deps.CLI.promptTimeoutMs);
    } finally {
      deps.chrome.expectPageErrors = false;
    }
    deps.assert(
      outcome.kind === "error",
      `the misconfigured prompt did not converge to an error presentation: ${deps.truncate(deps.sanitizeText(JSON.stringify(outcome)), 300)}`,
    );
    const errorCode = deps.failureErrorCode(outcome.bannerText, outcome.panelText);
    deps.assert(
      typeof errorCode === "string" && errorCode.length > 0,
      `no error code rendered in the banner/failure panel: ${deps.truncate(deps.sanitizeText(String(outcome.bannerText ?? outcome.panelText ?? "")), 160)}`,
    );
    me.errorCode = errorCode;

    /* 用户实际看到的失败呈现：横幅 role=alert 且携带错误码（8 秒自动隐藏
       窗口内先等待可见再读取，不依赖 snap 时序）；常驻失败面板 Run …
       failed — code: …（不自动隐藏）；composer 解锁；run-status 收敛
       idle；零回合渲染。 */
    await deps.waitForJs(
      "(() => { const b = document.getElementById('error-banner'); return b !== null && !b.hidden && b.textContent.length > 0; })()",
      10_000,
      "error banner visible after the misconfigured prompt",
    );
    const bannerFacts = await deps.evalJs(
      "(() => { const b = document.getElementById('error-banner'); " +
      "return { role: b === null ? null : b.getAttribute('role'), visible: b !== null && !b.hidden, text: b === null ? '' : b.textContent }; })()",
    );
    deps.assert(bannerFacts.role === "alert", `error banner role is ${String(bannerFacts.role)}`);
    deps.assert(bannerFacts.visible === true, "error banner not visible when the failed prompt converged");
    deps.assert(String(bannerFacts.text).includes(errorCode), `error banner text does not carry the code '${errorCode}': ${deps.truncate(deps.sanitizeText(String(bannerFacts.text)), 120)}`);
    await deps.waitForJs(
      "(() => { const p = document.getElementById('failure-panel'); return p !== null && !p.hidden && p.textContent.length > 0; })()",
      10_000,
      "persistent failure panel after the misconfigured prompt",
    );
    const panelText = String(await deps.evalJs("document.getElementById('failure-panel').textContent"));
    deps.assert(
      new RegExp(`failed — ${errorCode}:`).test(panelText),
      `failure panel does not show 'Run … failed — ${errorCode}:': ${deps.truncate(deps.sanitizeText(panelText), 160)}`,
    );
    const renderedAssistant = await deps.probeAssistantTurnCount();
    const renderedAll = (await renderedTurnCounts()).all;
    deps.assert(renderedAssistant === 0 && renderedAll === 0, `a failed prompt must render no turns (assistant ${String(renderedAssistant)}, all ${String(renderedAll)})`);
    const composerEnabled = await deps.evalJs("document.getElementById('prompt-input').disabled === false");
    deps.assert(composerEnabled === true, "trunk composer did not re-enable after the failed run converged");
    await deps.waitForJs(
      "document.getElementById('run-status') !== null && document.getElementById('run-status').textContent === 'idle'",
      10_000,
      "#run-status back to idle after the failed prompt converged",
    );
    await deps.snap("model-error-misconfig");

    /* 服务器权威状态交叉核对（HTTP 面 = API 跑批器同一断言面）。 */
    const probeState = await deps.api("GET", mePath("state"));
    deps.assert(probeState.status === 200, `probe tree state fetch failed: ${String(probeState.status)}`);
    const probeTrunkView = (probeState.body?.branches ?? []).find((view) => view.branch.id === me.probeTrunkId);
    deps.assert(probeTrunkView !== undefined, "probe tree state has no trunk branch view");
    deps.assert((probeTrunkView.turns ?? []).length === 0, "a failed prompt must persist no turns");
    let probeDiag = await deps.api("GET", mePath("diagnostics"));
    deps.assert(probeDiag.body?.runtimeState === "idle", `runtimeState is ${String(probeDiag.body?.runtimeState)} (expected idle) after the misconfigured prompt`);
    deps.assert(probeDiag.body?.activeRun === null, "activeRun is not null after the misconfigured prompt");
    const failedRun = (probeDiag.body?.runs ?? []).find((run) => run.state === "failed");
    deps.assert(failedRun !== undefined, "diagnostics shows no failed run for the misconfigured prompt");
    deps.assert(
      failedRun.failure?.code === errorCode,
      `the failed run carries code ${String(failedRun.failure?.code)} while the rendered presentation carried ${errorCode}`,
    );
    me.failedRunId = failedRun.runId;
    deps.assert(typeof me.failedRunId === "string" && me.failedRunId.length > 0, "the failed run has no run id");

    /* 恢复引导：SIGKILL，换回原 registry 重启同一数据目录（配置修复）。 */
    deps.chrome.expectPageErrors = true;
    let recoveryBanner = "";
    try {
      await deps.killStudioAndWait();
      await deps.startStudio(deps.sc.dataDir, { logName: "studio-recovery.log" });
      await deps.navigate(deps.sc.studioUrl);
      recoveryBanner = await waitStudioBanner();
    } finally {
      deps.chrome.expectPageErrors = false;
    }
    deps.assert(
      recoveryBanner.includes(`pi agent-dir=${sourceAgentDir} (controlled`),
      "the recovery boot does not report the original controlled agent dir",
    );

    /* 整页刷新后页面自动打开最旧树（主剧本树）——先以真实侧栏点击选中
       探针树。失败呈现自权威状态重建（常驻失败面板 sticky 语义）：同一
       run 前缀 + 同一错误码重现，零回合不变——「失败事实跨进程重启保留」
       的浏览器面证明。 */
    await selectTreeInSidebar(me.probeTreeId);
    await deps.waitForJs(
      "(() => { const p = document.getElementById('failure-panel'); return p !== null && !p.hidden && p.textContent.length > 0; })()",
      10_000,
      "failure panel reconstructed from authoritative state after the restart",
    );
    const reconstructedPanel = String(await deps.evalJs("document.getElementById('failure-panel').textContent"));
    deps.assert(
      reconstructedPanel.includes(me.failedRunId.slice(0, 12)),
      `the reconstructed failure panel does not reference the failed run ${me.failedRunId.slice(0, 8)}…: ${deps.truncate(deps.sanitizeText(reconstructedPanel), 160)}`,
    );
    deps.assert(
      new RegExp(`failed — ${errorCode}:`).test(reconstructedPanel),
      `the reconstructed failure panel lost the code '${errorCode}': ${deps.truncate(deps.sanitizeText(reconstructedPanel), 160)}`,
    );
    const renderedAfterRestart = (await renderedTurnCounts()).all;
    deps.assert(renderedAfterRestart === 0, `rendered turns after restart+reload is ${String(renderedAfterRestart)} (expected 0)`);

    /* 同一探针树、同一 prompt：配置修复 + 重启后成功（failed → succeeded）。
       常驻失败面板先经真实 Dismiss 清场（sticky 面板会让结局检测立即误读
       error——waitForProbeOutcome 的既有纪律）。 */
    await deps.resetErrorSurfaces();
    const before = await deps.probeAssistantTurnCount();
    let recovery;
    deps.chrome.expectPageErrors = true;
    try {
      await deps.sendTrunkPrompt(deps.SCENARIO.modelErrorProbe, { keyboard: false });
      recovery = await deps.waitForProbeOutcome(before, deps.CLI.promptTimeoutMs);
    } finally {
      deps.chrome.expectPageErrors = false;
    }
    deps.assert(
      recovery.kind === "answer",
      `the recovery prompt did not produce an answer: ${deps.truncate(deps.sanitizeText(JSON.stringify(recovery)), 300)}`,
    );
    deps.assert(typeof recovery.text === "string" && recovery.text.trim().length > 0, "the recovery answer is empty");

    /* 页面终局：2 渲染回合（1 user + 1 assistant）、run-status idle；
       服务器侧：同树 2 回合落库、run 序列 failed(code) → succeeded。 */
    const renderedFinal = (await renderedTurnCounts()).all;
    deps.assert(renderedFinal === 2, `rendered turns after recovery is ${String(renderedFinal)} (expected 2: user + assistant)`);
    await deps.waitForJs(
      "document.getElementById('run-status') !== null && document.getElementById('run-status').textContent === 'idle'",
      10_000,
      "#run-status back to idle after the recovery prompt",
    );
    const probeState2 = await deps.api("GET", mePath("state"));
    const probeTrunkView2 = (probeState2.body?.branches ?? []).find((view) => view.branch.id === me.probeTrunkId);
    deps.assert((probeTrunkView2?.turns ?? []).length === 2, `the recovery prompt did not persist its turn pair (${String(probeTrunkView2?.turns?.length ?? -1)})`);
    probeDiag = await deps.api("GET", mePath("diagnostics"));
    deps.assert(probeDiag.body?.runtimeState === "idle", "runtimeState is not idle after the recovery prompt");
    const runStates = (probeDiag.body?.runs ?? []).map((run) => `${run.state}${run.failure === null ? "" : `(${String(run.failure.code)})`}`);
    deps.assert(
      JSON.stringify(runStates) === JSON.stringify([`failed(${errorCode})`, "succeeded"]),
      `the probe run sequence is ${JSON.stringify(runStates)} (expected [failed(${errorCode}), succeeded])`,
    );
    await deps.snap("model-error-recovery");

    /* 相末遏制核对：主剧本树分支集与干线回合数跨相不变；树集合恰增一棵
       （本相探针树）——探针隔离的机械证明。 */
    const mainAfter = await deps.api("GET", `/api/trees/${encodeURIComponent(deps.sc.treeId)}/state`);
    deps.assert(mainAfter.status === 200, `main tree state fetch failed after the model-error phase: ${String(mainAfter.status)}`);
    const afterBranchIds = (mainAfter.body?.branches ?? []).map((view) => view.branch.id);
    deps.assert(
      JSON.stringify(afterBranchIds) === JSON.stringify(me.baseline.branchIds),
      `main tree branch set drifted across the model-error phase: ${JSON.stringify(me.baseline.branchIds)} → ${JSON.stringify(afterBranchIds)}`,
    );
    const afterTrunkView = (mainAfter.body?.branches ?? []).find((view) => view.branch.id === mainAfter.body?.trunkBranchId);
    deps.assert(
      (afterTrunkView?.turns ?? []).length === me.baseline.trunkTurnCount,
      `main tree trunk turns drifted across the model-error phase: ${String(me.baseline.trunkTurnCount)} → ${String(afterTrunkView?.turns?.length ?? -1)}`,
    );
    const afterTreeIds = ((await deps.api("GET", "/api/trees")).body?.trees ?? []).map((tree) => tree.id);
    deps.assert(
      JSON.stringify(afterTreeIds) === JSON.stringify([...me.baseline.treeIds, me.probeTreeId]),
      `the tree set drifted beyond the model-error probe tree: ${JSON.stringify(afterTreeIds)}`,
    );

    return {
      detail:
        `misconfigured registry (unroutable baseUrl) booted through the product CLI: the browser rendered the failed run (banner role=alert code ${errorCode}, persistent failure panel, composer re-enabled, zero turns on page and server, diagnostics idle) on a fresh probe tree; ` +
        `original-registry restart + reload reconstructed the failure presentation from authoritative state and the same tree then succeeded (failed(${errorCode}) → succeeded)`,
    };
  }

  return {
    stepModelErrorEcho,
    stepModelErrorRealPi,
  };
}
