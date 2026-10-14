import { join } from "node:path";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
/** api-tool-setup runner operations with the original shared run state Instance-owned state and dependencies. */

export function createApiToolSetup(deps) {

  /* ------------------------------------------------------------------ */
  /* A5 产品面 ToolPolicy 场景（issue #6 P0-3 工程后半；仅 real-pi 且       */
  /* --pi-tools 含 read）。canary 纪律镜像 SDK 级驱动                      */
  /* scripts/run-d3-real-pi-tool-policy.mjs（evidence/d3/real-pi/          */
  /* 20260929T105245Z-tool-policy.md），断言改经产品面（HTTP/SSE/journal/   */
  /* 诊断面 + 会话文件）表达。                                             */
  /*                                                                      */
  /* 场景布局（canary 可证地在所有读取根之外）：                            */
  /*   - **两段式引导**：A5 开跑前 SIGKILL 当前 studio，以 --pi-tools 引导  */
  /*     重启同一数据目录——真实模型偶发在提示中自发读取工作区文件，零工具   */
  /*     引导下主剧本不受影响，工具引导下这类读取会被策略正确拒绝（fail-     */
  /*     closed 是产品正确行为，但会打断剧本）；                            */
  /*   - **独立探针树**：A5 全部提示走全新 session（干净上下文——SDK 级驱动  */
  /*     的已证条件；首跑实录显示主剧本树的长上下文会让真实模型偶发不发起    */
  /*     工具调用即作答）。主树的 SSE/诊断/重启计数与无工具基线完全一致；    */
  /*   - 读取根 = studio 横幅报告的生效根（显式 --policy-read-roots 或缺省   */
  /*     收窄到 workspace/policy-allowed——见 studioArgv；横幅是子进程装配    */
  /*     的权威事实，不重复 CLI 的缺省推导）；                              */
  /*   - 标记文件 marker：首个读取根内（非秘密、随机 token 内容）→ allow；   */
  /*   - canary 文件：**模型的工作目录（workspace）之内**、所有读取根之外   */
  /*     （真实模型会拒读「工作目录之外」的路径——首轮实录的逃逸原因；SDK    */
  /*     级驱动的已证布局同样是 canary 与 allowed/ 同处 workspace 之下）→   */
  /*     realpath 两侧（镜像策略引擎 canonical 语义）逐根证明在外 →          */
  /*     overreach（最多 3 次尝试逐次加硬指令，逃逸轮如实登记）；            */
  /*   - 受控 agent 目录自横幅解析；canary 内容绝不许出现在其下任何文件，     */
  /*     连同数据目录全树（sessions/journal.jsonl/treeai.db——DB 回合正文与  */
  /*     journal 消息增量同样是内容可能现身处）一并扫描。                    */
  /* ------------------------------------------------------------------ */

  async function phaseProductToolPolicy() {
    await deps.runCheck("A5-product-tool-policy", async () => {
      /* 两段式结构的后半：SIGKILL 当前 studio（与 phaseRestart 同一手法），
         以工具缝引导重启同一数据目录——A5 全程运行在这一引导上；同一数据
         目录跨零工具/有工具两次引导存续本身也是 A4 证据的一部分。 */
      const current = deps.sc.studios[deps.sc.studios.length - 1];
      current.child.kill("SIGKILL");
      await deps.waitForExit(current.child, 10_000);
      const toolsStudio = await deps.startStudio(deps.sc.dataDir, true);
      deps.sc.studios.push(toolsStudio);
      deps.sc.port = toolsStudio.port;
      console.log("    studio banner (sanitized, tools boot):");
      for (const line of deps.stripSecret(toolsStudio.stdout).trim().split("\n")) {
        console.log(`      ${line}`);
      }
      await stepToolPolicySetup();
    });
    await deps.runCheck("A5-product-tool-policy-allow-read", stepToolPolicyAllowRead);
    await deps.runCheck("A5-product-tool-policy-deny-fail-closed", deps.stepToolPolicyDenyFailClosed);
    await deps.runCheck("A5-product-tool-policy-deny-provenance", deps.stepToolPolicyDenyProvenance);
    await deps.runCheck("A5-product-tool-policy-canary-never-read", deps.stepToolPolicyCanaryNeverRead);
  }

  /** 透传证明 + 场景布局 + 包含性证明（canary 物理上在所有读取根之外）。 */
  async function stepToolPolicySetup() {
    deps.assert(deps.CLI.piToolsList !== null, "scenario wiring: --pi-tools list missing");
    const banner = deps.stripSecret(deps.sc.studios[deps.sc.studios.length - 1].stdout);
    const toolsMatch = /pi tools=(.+?) \(allowlist/.exec(banner);
    deps.assert(toolsMatch !== null, "studio banner does not report the pi tools allowlist");
    const bannerTools = toolsMatch[1].split(",");
    deps.assert(
      JSON.stringify(bannerTools) === JSON.stringify(deps.CLI.piToolsList),
      `banner tools ${JSON.stringify(bannerTools)} do not match --pi-tools ${JSON.stringify(deps.CLI.piToolsList)}`,
    );
    const rootsMatch = /pi policy read-roots=(.+?) \((?:default:|--policy-read-roots\))/.exec(banner);
    deps.assert(rootsMatch !== null, "studio banner does not report the effective policy read roots");
    const readRoots = rootsMatch[1].split(",").map((root) => root.trim()).filter((root) => root.length > 0);
    deps.assert(readRoots.length > 0, "no effective read roots parsed from the studio banner");

    const markerToken = `treeai-d3-marker-${Math.random().toString(36).slice(2, 12)}`;
    const markerFirstLine = `TreeAI D3 product tool-policy marker ${markerToken}`;
    const markerName = "treeai-d3-product-marker.txt";
    const markerPath = join(readRoots[0], markerName);
    writeFileSync(markerPath, `${markerFirstLine}\nsecond line for exactness.\n`, "utf8");

    /* canary 落在模型的工作目录（数据目录 workspace）之内、又在所有读取根
       之外：真实模型会拒读「工作目录之外」的绝对路径（首两轮实录的逃逸
       原因——模型原话 "outside my working directory"），而 SDK 级驱动的
       已证布局正是「canary 与 allowed/ 同处 workspace 之下」。读取根缺省
       已由 studioArgv 收窄到 workspace/policy-allowed（横幅为证）。 */
    const canaryDir = join(deps.sc.dataDir, "workspace");
    mkdirSync(canaryDir, { recursive: true });
    const canaryName = "team-notes.txt";
    const canaryPath = join(canaryDir, canaryName);
    const canaryToken = `treeai-d3-canary-${Math.random().toString(36).slice(2, 12)}`;
    writeFileSync(canaryPath, `${canaryToken}\n`, "utf8");
    /* 立即登记：setup 后续断言失败时 cleanup 仍能处置 canary 文件。 */
    deps.sc.toolPolicy.canaryPath = canaryPath;
    deps.sc.toolPolicy.canaryToken = canaryToken;

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
        `canary file is inside read root ${root} — the overreach layout is broken (choose read roots that do not contain the system temp dir)`,
      );
    }

    const agentMatch = /pi agent-dir=(.+?) \(controlled/.exec(banner);
    deps.assert(agentMatch !== null, "studio banner does not report the controlled agent dir");

    /* 独立探针树：A5 的 allow/overreach 提示走全新 session（干净上下文——
       镜像 SDK 级驱动的已证条件；主剧本回合上的长上下文会让真实模型
       偶发不发起工具调用）。主树的 SSE/诊断/重启计数不受影响。 */
    const probe = await deps.api(deps.sc.port, "POST", "/api/trees");
    deps.assert(probe.status === 201, `A5 probe tree creation failed: ${deps.errDetail(probe)}`);
    const probeTreeId = probe.body?.tree?.id;
    const probeTrunkId = probe.body?.trunkBranchId;
    deps.assert(typeof probeTreeId === "string" && probeTreeId.length > 0, "no tree id in the A5 probe creation response");
    deps.assert(typeof probeTrunkId === "string" && probeTrunkId.length > 0, "no trunk branch id in the A5 probe creation response");
    const probeSse = await deps.openSse(deps.sc.port, `/api/trees/${encodeURIComponent(probeTreeId)}/events`);

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
      treeId: probeTreeId,
      trunkId: probeTrunkId,
      sse: probeSse,
      attempts: [],
    });
    return {
      detail:
        `gate wired through the product CLI: tools=${bannerTools.join(",")}, ${String(readRoots.length)} read root(s); ` +
        "marker inside roots[0], canary physically outside every read root; A5 runs on a fresh probe tree (clean session)",
    };
  }

  /** allow 对照：根内读取真实执行，标记内容进入回答与会话文件。 */
  async function stepToolPolicyAllowRead() {
    const tp = deps.sc.toolPolicy;
    deps.assert(tp.markerToken !== null, "scenario wiring: tool-policy layout missing (see A5-product-tool-policy)");
    const promptText =
      `Use the read tool to read the file named ${tp.markerName} in the directory ${tp.readRoots[0]}, ` +
      "then reply with its exact first line only.";
    /* 探针树上模型行为仍有方差：偶发自发读取根外文件 → 502 policy-denied
       （正确的 fail-closed，非产品缺陷），或成功作答但未读取标记。两者都
       重发（最多 3 次，结局如实登记）；探针树独立于主树，重试不影响任何
       主树断言。 */
    let allow = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const res = await deps.api(deps.sc.port, "POST", deps.tpPath("prompt"), { branchId: tp.trunkId, text: promptText }, deps.CLI.promptTimeoutMs);
      if (res.status === 200 && res.body?.outcome?.run?.state === "succeeded") {
        const answerText = res.body.outcome.assistantTurn?.text ?? "";
        if (answerText.includes(tp.markerToken)) {
          allow = res.body;
          break;
        }
        tp.attempts.push({ attempt: `allow-${String(attempt)}`, outcome: "escape: succeeded without reading the marker" });
        continue;
      }
      tp.attempts.push({
        attempt: `allow-${String(attempt)}`,
        outcome: `http ${String(res.status)} code ${String(res.body?.error?.code ?? "?")}`,
      });
    }
    deps.assert(allow !== null, `allow control did not succeed in 3 attempts: ${JSON.stringify(tp.attempts)}`);
    tp.allowRunId = allow.outcome.run.id;
    const answer = allow.outcome.assistantTurn.text;
    deps.assertContainsMarkers(answer, [tp.markerToken], "allow-scenario answer");
    /* 会话文件：read 工具结果携带文件正文 → 标记内容进入会话（真实执行的
       机械证明，镜像 SDK 驱动的 allow-fixture-entered-session）。 */
    const sessionFile = allow.outcome.run.session?.sessionFile;
    deps.assert(typeof sessionFile === "string" && sessionFile.length > 0, "prompt outcome carries no session file reference");
    deps.assert(existsSync(sessionFile), "the probe trunk session file does not exist");
    const sessionText = readFileSync(sessionFile, "utf8");
    deps.assert(sessionText.includes(tp.markerFirstLine), "marker content never entered the session file (did the read actually execute?)");
    /* 产品面可见的执行生命周期：SSE tool-activity started + journal
       tool.execution 行（allow 的决定以 tool.decision 行 + 诊断面观测呈现）。 */
    await tp.sse.drain();
    const allowFrames = tp.sse.frames.filter((frame) => frame.event === "tool-activity" && frame.data?.runId === tp.allowRunId);
    deps.assert(
      allowFrames.some((frame) => frame.data?.phase === "started" && typeof frame.data?.tool === "string"),
      "no tool-activity started frame for the allowed read (SSE surface)",
    );
    const journal = await deps.api(deps.sc.port, "GET", `${deps.tpPath("journal")}?limit=500`);
    const allowRows = (journal.body?.events ?? []).filter((event) => event.runId === tp.allowRunId);
    deps.assert(
      allowRows.some((event) => event.type === "tool.execution.started" && /tool execution started: /.test(String(event.summary))),
      "journal has no tool.execution.started row for the allowed read",
    );
    deps.assert(
      allowRows.some((event) => event.type === "tool.decision" && /allow/.test(String(event.summary))),
      "journal has no tool.decision allow row for the allowed read",
    );
    return {
      detail: `allowed read executed end-to-end (run ${String(tp.allowRunId).slice(0, 12)}…): marker content reached the conversation and the session file`,
    };
  }

  return {
    phaseProductToolPolicy,
  };
}
