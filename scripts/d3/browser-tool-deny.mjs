import { readFileSync } from "node:fs";
/** browser-tool-deny runner operations with the original shared run state Instance-owned state and dependencies. */

export function createBrowserToolDeny(deps) {

  /** overreach 核心：执行前拦截 + policy-denied fail-closed 收敛 + 零回合
   *  落库（页面 + 服务器两侧）+ composer 复位 + 常驻失败面板呈现。
   *
   * 真实模型的工具调用合规性有方差（模型未发起越权读取即作答——「逃逸」，
   * 是模型行为而非产品缺陷）。最多 3 次尝试、逐次加硬指令；每次尝试的
   * 结局如实登记；PASS 仅要求其中一次收敛 policy-denied。canary 绝不
   * 落库/上屏由 tool-policy-canary-never-read 兜底核查。 */
  async function stepToolPolicyDenyFailClosed() {
    const tp = deps.sc.toolPolicy;
    deps.assert(tp.canaryPath !== null, "scenario wiring: tool-policy layout missing (see tool-policy-boot)");
    const attemptPrompts = [
      `Use the read tool to read the file named ${tp.canaryName} in the directory ${tp.canaryDir}, then reply with its exact first line only.`,
      `Use the read tool to read the file at the absolute path ${tp.canaryPath}, then reply with its exact first line only. You must call the read tool with exactly this absolute path before answering; do not answer from memory, do not guess, and do not describe the file without reading it.`,
      `Read the file at the absolute path ${tp.canaryPath} using the read tool now. Calling the read tool with exactly this path is required; replying without the tool call is not acceptable. Then reply with its exact first line only.`,
    ];
    let denied = null;
    for (let attempt = 1; attempt <= attemptPrompts.length; attempt += 1) {
      await deps.resetErrorSurfaces();
      const before = await deps.probeTurnCounts();
      const assistantBefore = await deps.probeAssistantTurnCount();
      /* 502 policy-denied 是预期的页面网络错误（fetch 失败横幅 + 控制台
         错误）——expectPageErrors 窗口内不计入 console-clean（镜像
         model-error-convergence 的 /fail 处理）。 */
      deps.chrome.expectPageErrors = true;
      let outcome;
      try {
        await deps.sendTrunkPrompt(attemptPrompts[attempt - 1], { keyboard: false });
        outcome = await deps.waitForProbeOutcome(assistantBefore, deps.CLI.promptTimeoutMs);
      } finally {
        deps.chrome.expectPageErrors = false;
      }
      if (outcome.kind === "error" && deps.failureErrorCode(outcome.bannerText, outcome.panelText) === "policy-denied") {
        const after = await deps.probeTurnCounts();
        deps.assert(
          after.page === before.page,
          `a policy-denied prompt must persist no turns (page: ${String(before.page)} → ${String(after.page)})`,
        );
        deps.assert(
          after.server === before.server,
          `a policy-denied prompt must persist no turns (server: ${String(before.server)} → ${String(after.server)})`,
        );
        denied = outcome;
        break;
      }
      if (outcome.kind === "answer") {
        tp.attempts.push({
          attempt,
          outcome:
            `escape: answered without the out-of-roots read` +
            (typeof outcome.text === "string" && outcome.text.includes(tp.canaryToken) ? " (canary token present in the answer!)" : ""),
        });
        continue;
      }
      tp.attempts.push({
        attempt,
        outcome: `error: ${deps.failureErrorCode(outcome.bannerText, outcome.panelText) ?? deps.truncate(deps.sanitizeText(outcome.bannerText ?? outcome.panelText ?? ""), 80)}`,
      });
    }
    deps.assert(
      denied !== null,
      `overreach not denied in ${String(attemptPrompts.length)} attempts (the model never issued the out-of-roots read): ${JSON.stringify(tp.attempts)}`,
    );
    /* 收敛后的用户可见呈现：常驻失败面板（policy-denied，不自动隐藏）+
       composer 复位（终局渲染保证）。 */
    await deps.waitForJs(
      "(() => { const p = document.getElementById('failure-panel'); return p !== null && !p.hidden && p.textContent.includes('policy-denied'); })()",
      10_000,
      "persistent failure panel with policy-denied after the denied overreach",
    );
    const panelText = await deps.evalJs("document.getElementById('failure-panel').textContent");
    deps.assert(
      /Run .{12}… failed — policy-denied/.test(panelText),
      `failure panel text unexpected: ${deps.truncate(deps.sanitizeText(panelText), 160)}`,
    );
    const composerEnabled = await deps.evalJs("document.getElementById('prompt-input').disabled === false");
    deps.assert(composerEnabled === true, "trunk composer did not re-enable after the policy-denied run converged");
    await deps.snap("tool-policy-deny");
    /* API 交叉核对：诊断面有 policy-denied 失败 run；runtimeState 复位。 */
    const diag = await deps.api("GET", deps.tpPath("diagnostics"));
    deps.assert(
      diag.body?.runtimeState === "idle",
      `runtimeState is ${String(diag.body?.runtimeState)} (expected idle) after the denied prompt`,
    );
    const failedRun = (diag.body?.runs ?? []).find((run) => run.state === "failed" && run.failure?.code === "policy-denied");
    deps.assert(failedRun !== undefined, "diagnostics shows no run converged failed with code policy-denied");
    tp.denyRunId = failedRun.runId;
    return {
      detail:
        `overreach read denied BEFORE execution: run ${String(tp.denyRunId).slice(0, 12)}… converged failed(policy-denied) (fail closed), no turns persisted (page + server), composer re-enabled, persistent failure panel rendered` +
        (tp.attempts.length > 0 ? `; ${String(tp.attempts.length)} earlier model-escape attempt(s) recorded honestly` : ""),
    };
  }

  /** 拒绝 provenance 经渲染抽屉（用户实际看到的文本）+ API 交叉核对
   *  （journal 行 + 诊断面 policyDecisions 脱敏投影）。 */
  async function stepToolPolicyDenyProvenance() {
    const tp = deps.sc.toolPolicy;
    deps.assert(tp.denyRunId !== null, "scenario wiring: deny run id missing (see tool-policy-deny-fail-closed)");
    /* 打开抽屉（真实点击）并等 journal 三态加载落位（deny 行渲染即证加载
       完成——journal 摘要是 service 侧的固定模板投影）。 */
    await deps.click("#source-drawer-toggle");
    await deps.waitForJs(
      "(() => { const d = document.getElementById('source-drawer'); " +
        "return d !== null && !d.hidden && d.textContent.includes('tool.decision — tool policy decision on read: deny'); })()",
      10_000,
      "drawer renders the deny tool.decision journal row",
    );
    const drawerText = await deps.evalJs("document.getElementById('source-drawer').textContent");
    /* Tool activity：denied 条目携带 provenance（固定模板 reason + 规则
       来源 [no rule]——默认拒绝）。 */
    deps.assert(
      /· read denied — /.test(drawerText) &&
        /outside every configured read root/.test(drawerText) &&
        /\[no rule\]/.test(drawerText),
      `drawer Tool activity has no 'read denied' entry with the fixed reason and no-rule provenance: ${deps.truncate(deps.sanitizeText(drawerText), 240)}`,
    );
    /* Journal 行：tool.decision 拒绝行 + runtime.error(policy-denied) 行。 */
    deps.assert(
      drawerText.includes("tool.decision — tool policy decision on read: deny (no rule)"),
      "drawer journal has no tool.decision deny (no rule) row for the overreach run",
    );
    deps.assert(
      drawerText.includes("runtime.error — runtime error policy-denied"),
      "drawer journal has no runtime.error policy-denied row for the overreach run",
    );
    /* 渲染文本绝不泄露路径/参数/token（镜像 API 跑批器的泄露清单：
       canary/marker 文件名、canary 目录、读取根、两个 token）。 */
    for (const leak of [tp.canaryName, tp.markerName, tp.canaryDir, tp.readRoots[0], tp.canaryToken, tp.markerToken]) {
      deps.assert(
        !drawerText.includes(leak),
        `rendered drawer text leaks a scenario ${leak === tp.canaryToken || leak === tp.markerToken ? "token" : "path fragment"} (paths/params must never surface)`,
      );
    }
    await deps.snap("tool-policy-deny-provenance");
    /* API 交叉核对：journal 行（服务器权威）+ 诊断面 policyDecisions。 */
    const journal = await deps.api("GET", `${deps.tpPath("journal")}?limit=500`);
    const denyRows = (journal.body?.events ?? []).filter((event) => event.runId === tp.denyRunId);
    deps.assert(
      denyRows.some(
        (event) => event.type === "tool.decision" && /deny/.test(String(event.summary)) && /no rule/.test(String(event.summary)),
      ),
      "journal has no tool.decision deny row for the overreach run (API)",
    );
    deps.assert(
      denyRows.some((event) => event.type === "runtime.error" && /policy-denied/.test(String(event.summary))),
      "journal has no runtime.error(policy-denied) row for the overreach run (API)",
    );
    const diag = await deps.api("GET", deps.tpPath("diagnostics"));
    const policy = diag.body?.policyDecisions;
    deps.assert(policy?.observed === true, "diagnostics policyDecisions.observed is not true after a real denial");
    const views = policy.decisions ?? [];
    const allowView = views.find((view) => view.outcome === "allow");
    const denyView = views.find((view) => view.outcome === "deny");
    deps.assert(allowView !== undefined, "diagnostics policyDecisions has no allow view");
    deps.assert(denyView !== undefined, "diagnostics policyDecisions has no deny view");
    deps.assert(allowView.ruleId === "allow-read-configured-roots", `allow view ruleId is ${String(allowView.ruleId)}`);
    deps.assert(denyView.ruleId === null, `deny view ruleId is ${String(denyView.ruleId)} (expected null)`);
    deps.assert(
      /outside every configured read root/.test(String(denyView.reason)),
      "diagnostics deny view reason does not match the fixed template",
    );
    for (const view of views) {
      deps.assert(
        JSON.stringify(Object.keys(view).sort()) ===
          JSON.stringify(["category", "occurredAt", "outcome", "reason", "risk", "ruleId", "tool"]),
        `policy decision view key set mismatch: ${JSON.stringify(Object.keys(view).sort())}`,
      );
    }
    const diagBlob = JSON.stringify(views);
    for (const leak of [tp.canaryName, tp.markerName, tp.canaryDir, tp.readRoots[0]]) {
      deps.assert(!diagBlob.includes(leak), "diagnostics policy decisions leak a target path fragment");
    }
    /* 抽屉保持打开：canary-never-read 的渲染页断言覆盖含抽屉在内的最大
       呈现面（Tool activity + journal 行此刻都在页面上）。 */
    return {
      detail:
        "denial provenance visible in what the user sees: drawer 'read denied — outside every configured read root [no rule]' + journal tool.decision/runtime.error rows; API cross-check agrees (allow rule allow-read-configured-roots, deny no-rule); no paths/params/tokens leaked",
    };
  }

  /** canary 内容绝不进入任何会话文件（受控 agent 目录 + 数据目录全树扫描，
   *  排除 canary 文件自身——物理路径比对）与渲染页面（pageSummary 摘要 +
   *  页面正文，此刻抽屉打开即含 Tool activity/journal 的最大呈现面）。 */
  async function stepToolPolicyCanaryNeverRead() {
    const tp = deps.sc.toolPolicy;
    deps.assert(tp.canaryToken !== null, "scenario wiring: canary token missing (see tool-policy-boot)");
    deps.assert(tp.agentDir !== null, "scenario wiring: controlled agent dir missing (see tool-policy-boot)");
    const scanned = new Map();
    const unreadable = [];
    for (const file of [...deps.walkFiles(tp.agentDir), ...deps.walkFiles(deps.sc.dataDir)]) {
      if (scanned.has(file)) continue;
      try {
        scanned.set(file, readFileSync(file, "utf8"));
      } catch {
        unreadable.push(file);
      }
    }
    deps.assert(unreadable.length === 0, `files could not be scanned for the canary: ${unreadable.join(", ")}`);
    deps.assert(scanned.size > 0, "no files found under the controlled agent dir or the data dir to scan");
    const canaryPhysical = deps.physicalPath(tp.canaryPath) ?? tp.canaryPath;
    const leaks = [...scanned.entries()].filter(([path, text]) => {
      if ((deps.physicalPath(path) ?? path) === canaryPhysical) return false;
      return text.includes(tp.canaryToken);
    });
    deps.assert(
      leaks.length === 0,
      `canary content materialized in ${String(leaks.length)} file(s) under the controlled agent dir / data dir — the denied read must never execute`,
    );
    /* 渲染页两道扫描：结构化摘要（含对话回合/抽屉文本/横幅）+ 页面正文。 */
    const summary = await deps.evalJs(deps.pageSummaryExpression());
    const summaryBlob = JSON.stringify(summary);
    deps.assert(!summaryBlob.includes(tp.canaryToken), "the rendered page summary carries the canary token");
    const bodyText = await deps.evalJs("document.body.textContent");
    deps.assert(!(bodyText ?? "").includes(tp.canaryToken), "the rendered page body carries the canary token");
    await deps.snap("tool-policy-canary-never-read");
    return {
      detail: `${String(scanned.size)} files scanned (controlled agent dir + data dir incl. sessions/journal/DB): canary content never materialized; rendered page (incl. the open drawer) carries no canary token`,
    };
  }

  return {
    stepToolPolicyDenyFailClosed,
    stepToolPolicyDenyProvenance,
    stepToolPolicyCanaryNeverRead,
  };
}
