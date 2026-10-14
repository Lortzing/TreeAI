import { join } from "node:path";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
/** browser-tool-setup runner operations with the original shared run state Instance-owned state and dependencies. */

export function createBrowserToolSetup(deps) {

  /** 两段式引导的后半：SIGKILL + 工具缝重启同一数据目录 + 透传证明（横幅
   *  解析）+ 场景布局（marker/canary + 包含性证明）+ 全新探针树（真实
   *  #new-tree 点击）。 */
  async function stepToolPolicyBoot() {
    deps.assert(deps.CLI.piToolsList !== null, "scenario wiring: --pi-tools list missing");
    /* SIGKILL 当前 studio → 工具缝重启同一数据目录（与 server-restart-
       recovery 同一手法；同一数据目录跨零工具/有工具两次引导存续）。
       SIGKILL 窗口内页面 SSE 重连失败是预期的页面网络错误。 */
    deps.chrome.expectPageErrors = true;
    try {
      await deps.killStudioAndWait();
      await deps.startStudio(deps.sc.dataDir, { withTools: true, logName: "studio-tools.log" });
      await deps.navigate(deps.sc.studioUrl);
    } finally {
      deps.chrome.expectPageErrors = false;
    }
    /* 横幅解析（raw stdout；banner 在 listen 后的同一同步块写出——健康
       检查通过时必然已在管道上，等它到达即可）。 */
    const bannerDeadline = Date.now() + 5_000;
    while (!/pi tools=/.test(deps.studio.stdoutRaw) && Date.now() < bannerDeadline) await deps.sleep(50);
    const banner = deps.studio.stdoutRaw;
    const toolsMatch = /pi tools=(.+?) \(allowlist/.exec(banner);
    deps.assert(
      toolsMatch !== null,
      "studio banner does not report the pi tools allowlist (tools boot may have failed; see artifacts studio-tools.log)",
    );
    const bannerTools = toolsMatch[1].split(",");
    deps.assert(
      JSON.stringify(bannerTools) === JSON.stringify(deps.CLI.piToolsList),
      `banner tools ${JSON.stringify(bannerTools)} do not match --pi-tools ${JSON.stringify(deps.CLI.piToolsList)}`,
    );
    deps.assert(bannerTools.includes("read"), "banner tools do not include 'read' (the phase requires the read tool)");
    const rootsMatch = /pi policy read-roots=(.+?) \((?:default:|--policy-read-roots\))/.exec(banner);
    deps.assert(rootsMatch !== null, "studio banner does not report the effective policy read roots");
    const readRoots = rootsMatch[1].split(",").map((root) => root.trim()).filter((root) => root.length > 0);
    deps.assert(readRoots.length > 0, "no effective read roots parsed from the studio banner");
    const requestedRoots = deps.CLI.policyReadRootsList ?? [join(deps.sc.dataDir, "workspace", "policy-allowed")];
    deps.assert(
      JSON.stringify(readRoots) === JSON.stringify(requestedRoots),
      `banner read roots ${JSON.stringify(readRoots)} do not match what was requested ${JSON.stringify(requestedRoots)}`,
    );
    const agentMatch = /pi agent-dir=(.+?) \(controlled/.exec(banner);
    deps.assert(agentMatch !== null, "studio banner does not report the controlled agent dir");

    /* 布局：marker（首个读取根内）+ canary（workspace 内、所有读取根之外）。 */
    const markerToken = `treeai-d3-marker-${Math.random().toString(36).slice(2, 12)}`;
    const markerFirstLine = `TreeAI D3 browser tool-policy marker ${markerToken}`;
    const markerName = "treeai-d3-product-marker.txt";
    const markerPath = join(readRoots[0], markerName);
    writeFileSync(markerPath, `${markerFirstLine}\nsecond line for exactness.\n`, "utf8");
    const canaryDir = join(deps.sc.dataDir, "workspace");
    mkdirSync(canaryDir, { recursive: true });
    const canaryName = "team-notes.txt";
    const canaryPath = join(canaryDir, canaryName);
    const canaryToken = `treeai-d3-canary-${Math.random().toString(36).slice(2, 12)}`;
    writeFileSync(canaryPath, `${canaryToken}\n`, "utf8");
    /* 立即登记：后续断言失败时 cleanup 仍能处置 canary/marker 文件。 */
    deps.sc.toolPolicy.canaryPath = canaryPath;
    deps.sc.toolPolicy.canaryToken = canaryToken;
    deps.sc.toolPolicy.markerPath = markerPath;

    /* 包含性证明（realpath 两侧，镜像策略引擎的 canonical 语义）。 */
    const markerPhysical = deps.physicalPath(markerPath);
    const rootPhysical = deps.physicalPath(readRoots[0]);
    deps.assert(markerPhysical !== null && rootPhysical !== null, "marker or first read root cannot be physically resolved");
    deps.assert(deps.isPathWithin(markerPhysical, rootPhysical), "marker file is not inside the first read root (scenario layout broken)");
    const canaryPhysical = deps.physicalPath(canaryPath);
    deps.assert(canaryPhysical !== null, "canary file cannot be physically resolved");
    for (const root of readRoots) {
      const physical = deps.physicalPath(root);
      deps.assert(physical !== null, `read root cannot be physically resolved: ${root}`);
      deps.assert(
        !deps.isPathWithin(canaryPhysical, physical),
        `canary file is inside read root ${root} — the overreach layout is broken (choose read roots that do not contain the canary's directory)`,
      );
    }

    /* 全新探针树：真实 #new-tree 点击（新树自动打开——干净 session；主树
       各检查已在零工具引导上完成，计数不受工具面方差影响）。 */
    const treesBefore = await deps.api("GET", "/api/trees");
    deps.assert(treesBefore.status === 200, `GET /api/trees failed: ${String(treesBefore.status)}`);
    const knownIds = new Set((treesBefore.body?.trees ?? []).map((tree) => tree.id));
    await deps.click("#new-tree");
    await deps.waitForJs(
      "document.getElementById('tree-view') !== null && !document.getElementById('tree-view').hidden",
      10_000,
      "probe tree view visible after the new-tree click",
    );
    const treesAfter = await deps.api("GET", "/api/trees");
    const newTrees = (treesAfter.body?.trees ?? []).filter((tree) => !knownIds.has(tree.id));
    deps.assert(newTrees.length === 1, `the new-tree click created ${String(newTrees.length)} new trees (expected exactly 1)`);
    const probeTreeId = newTrees[0].id;
    const probeState = await deps.api("GET", `/api/trees/${encodeURIComponent(probeTreeId)}/state`);
    deps.assert(probeState.status === 200, `probe tree state fetch failed: ${String(probeState.status)}`);
    const probeTrunkId = probeState.body?.trunkBranchId;
    deps.assert(typeof probeTrunkId === "string" && probeTrunkId.length > 0, "probe tree state has no trunk branch id");
    /* sessions 目录快照（递归）：探针树是工具引导下唯一被 prompt 的树——
       此后新建的 session 文件必然属于探针树（allow 对照的会话文件交叉核对）。 */
    const sessionsDir = join(deps.sc.dataDir, "sessions");
    const sessionsBefore = new Set(deps.walkFiles(sessionsDir));
    /* EventSource 建连窗口：抽屉 Tool activity 的数据源是页面 SSE 流——
       建树后稍候，避免首个 prompt 抢在流建立之前发出。 */
    await deps.sleep(400);
    Object.assign(deps.sc.toolPolicy, {
      readRoots,
      agentDir: agentMatch[1],
      markerPath,
      markerName,
      markerToken,
      markerFirstLine,
      canaryDir,
      canaryPath,
      canaryName,
      canaryToken,
      probeTreeId,
      probeTrunkId,
      sessionsBefore,
      attempts: [],
    });
    return {
      detail:
        `tools boot wired through the product CLI: tools=${bannerTools.join(",")}, ${String(readRoots.length)} read root(s); ` +
        "marker inside roots[0], canary physically outside every read root; fresh probe tree opened via a real new-tree click (clean session)",
    };
  }

  /** allow 对照：根内读取真实执行——回答含标记 token、渲染抽屉呈现 Tool
   *  activity（started 相位）、（API 交叉核对）探针会话文件含标记内容。 */
  async function stepToolPolicyAllowRead() {
    const tp = deps.sc.toolPolicy;
    deps.assert(tp.markerToken !== null, "scenario wiring: tool-policy layout missing (see tool-policy-boot)");
    const promptText =
      `Use the read tool to read the file named ${tp.markerName} in the directory ${tp.readRoots[0]}, ` +
      "then reply with its exact first line only.";
    /* 探针树上模型行为仍有方差（镜像 API 跑批器）：偶发自发读取根外文件 →
       502 policy-denied（正确的 fail-closed，非产品缺陷），或成功作答但
       未读取标记。两者都重发（最多 3 次，结局如实登记）。页面没有 HTTP
       状态——结局检测不可知论（新回合 / 错误呈现）；502 的页面网络错误
       按预期不计入 console-clean（expectPageErrors 窗口，镜像
       model-error-convergence 的 /fail 处理）。 */
    let allow = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await deps.resetErrorSurfaces();
      const assistantBefore = await deps.probeAssistantTurnCount();
      deps.chrome.expectPageErrors = true;
      let outcome;
      try {
        await deps.sendTrunkPrompt(promptText, { keyboard: false });
        outcome = await deps.waitForProbeOutcome(assistantBefore, deps.CLI.promptTimeoutMs);
      } finally {
        deps.chrome.expectPageErrors = false;
      }
      if (outcome.kind === "answer") {
        if (typeof outcome.text === "string" && outcome.text.includes(tp.markerToken)) {
          allow = outcome;
          break;
        }
        tp.attempts.push({ attempt: `allow-${String(attempt)}`, outcome: "escape: answered without reading the marker" });
        continue;
      }
      tp.attempts.push({
        attempt: `allow-${String(attempt)}`,
        outcome: `error: ${deps.failureErrorCode(outcome.bannerText, outcome.panelText) ?? deps.truncate(deps.sanitizeText(outcome.bannerText ?? outcome.panelText ?? ""), 80)}`,
      });
    }
    deps.assert(allow !== null, `allow control did not succeed in 3 attempts: ${JSON.stringify(tp.attempts)}`);
    /* allow run id（诊断面最新成功 run——本轮刚收敛成功）。 */
    const diag = await deps.api("GET", deps.tpPath("diagnostics"));
    const succeededRuns = (diag.body?.runs ?? []).filter((run) => run.state === "succeeded");
    deps.assert(succeededRuns.length > 0, "diagnostics shows no succeeded run for the probe tree after the allowed read");
    tp.allowRunId = succeededRuns[succeededRuns.length - 1].runId;
    /* 渲染抽屉（真实点击开关）：Tool activity 区呈现本次读取（started 相位
       ——数据源是页面 SSE 流，端到端证明事件面到达浏览器渲染层）。 */
    await deps.click("#source-drawer-toggle");
    await deps.waitForJs(
      "document.getElementById('source-drawer') !== null && !document.getElementById('source-drawer').hidden",
      10_000,
      "sources drawer open (allow read)",
    );
    const drawerText = await deps.evalJs("document.getElementById('source-drawer').textContent");
    deps.assert(
      /· read started/.test(drawerText),
      `drawer Tool activity has no 'read started' entry for the allowed read: ${deps.truncate(deps.sanitizeText(drawerText), 200)}`,
    );
    await deps.snap("tool-policy-allow-read");
    /* 覆盖层盖住主线 composer——deny 阶段还要发 prompt，用抽屉头部的关闭
       按钮收起（issue #6 附-4 的鼠标关闭路径；Esc 路径覆盖保在
       a11y-semantics / narrow-window-layout）。 */
    await deps.click("#drawer-close");
    await deps.waitForJs(
      "document.getElementById('source-drawer') === null || document.getElementById('source-drawer').hidden",
      5_000,
      "drawer closed via #drawer-close after the allow-read inspection",
    );
    /* API 交叉核对：新建 session 文件即探针干线会话（探针树是工具引导下
       唯一被 prompt 的树）；标记内容必须真实进入（read 真实执行的机械证明，
       镜像 API 跑批器的 session 断言）。 */
    const sessionsDir = join(deps.sc.dataDir, "sessions");
    const newSessionFiles = deps.walkFiles(sessionsDir).filter((path) => !tp.sessionsBefore.has(path));
    deps.assert(newSessionFiles.length > 0, "no new session file appeared under the data dir for the probe tree");
    const withMarker = newSessionFiles.filter((path) => {
      try {
        return readFileSync(path, "utf8").includes(tp.markerFirstLine);
      } catch {
        return false;
      }
    });
    deps.assert(withMarker.length > 0, "marker content never entered the probe session file (did the read actually execute?)");
    return {
      detail:
        `allowed read executed end-to-end via the real composer (run ${String(tp.allowRunId).slice(0, 12)}…): answer carries the marker token; drawer shows the read activity; marker content reached the probe session file` +
        (tp.attempts.length > 0 ? `; ${String(tp.attempts.length)} earlier model-variance attempt(s) recorded honestly` : ""),
    };
  }

  return {
    stepToolPolicyBoot,
    stepToolPolicyAllowRead,
  };
}
