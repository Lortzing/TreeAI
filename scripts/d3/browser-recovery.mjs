import { join } from "node:path";
import { existsSync, readdirSync, renameSync } from "node:fs";
/** browser-recovery original runner scenarios/helpers Instance-owned state and dependencies. */

export function createBrowserRecovery(deps) {

  async function phaseRecovery() {

    /* ---- A4 恢复与故障 ---- */

    await deps.runCheck("server-restart-recovery", async () => {
      /* 在途无 run 时 SIGKILL：下一动作前杀进程 = 「响应丢失（杀进程）」
         故障类的页面侧呈现；随后同数据目录重启 + 整页刷新对账。 */
      try {
        deps.chrome.expectPageErrors = true;
        deps.killStudio();
        await deps.sleep(400);
        /* 页面在服务已死后发 prompt：必须呈现错误横幅而非静默丢弃。 */
        await deps.typeInto("#prompt-input", "This prompt is sent while the server is down.", { replace: true });
        await deps.click("#send");
        const banner = await deps.waitForJs(
          "(() => { const b = document.getElementById('error-banner'); return b !== null && !b.hidden && b.textContent.length > 0 ? b.textContent : false; })()",
          30_000,
          "error banner after server-down prompt",
        );
        /* 同数据目录重启（server 进程重启；数据全在磁盘）。 */
        await deps.startStudio(deps.sc.dataDir);
        await deps.navigate(deps.sc.studioUrl);
        const summary = await deps.snap("server-restart");
        deps.assert(summary.conversation.turns.length >= deps.sc.trunkTurnCount,
          `trunk turns lost across restart+reload: ${String(summary.conversation.turns.length)} (expected >= ${String(deps.sc.trunkTurnCount)})`);
        const stateRes = await deps.api("GET", `/api/trees/${encodeURIComponent(deps.sc.treeId)}/state`);
        const branchCount = (stateRes.body?.branches ?? []).length;
        deps.assert(branchCount === 3, `branch count after restart is ${String(branchCount)} (expected 3: trunk + A + B)`);
        /* 重启后主线续聊可用。 */
        await deps.sendTrunkPrompt("After the restart, the main line continues. Reply with: restart-ok.", { keyboard: false });
        await deps.waitForAnswerMarkers("#conversation", deps.MODE === "selftest" ? ["restart-ok"] : ["restart-ok"], deps.CLI.promptTimeoutMs, deps.MODE === "selftest" ? 5 : 4);
      } finally {
        deps.chrome.expectPageErrors = false;
      }
      await deps.snap("server-restart-recovered");
      return { detail: `server SIGKILL → page showed an honest error banner on the next prompt; same-data restart + reload kept the trunk turns and all 3 branches; continuation works` };
    });

    await deps.runCheck("missing-session-degradation", async () => {
      /* 移走 session 文件（本机受控数据目录内；echo session 为 *.jsonl）→
         整页刷新 → 降级呈现。 */
      const sessionsDir = join(deps.sc.dataDir, "sessions");
      deps.assert(existsSync(sessionsDir), `no sessions dir under data dir`);
      const files = readdirSync(sessionsDir).filter((f) => !f.startsWith("."));
      deps.assert(files.length > 0, "no session files to move");
      const moved = [];
      for (const file of files) {
        renameSync(join(sessionsDir, file), join(sessionsDir, `${file}.moved`));
        moved.push(file);
      }
      await deps.navigate(deps.sc.studioUrl);
      const summary = await deps.snap("missing-session");
      const bannerVisible = !summary.main.sessionBanner.hidden && (summary.main.sessionBanner.text ?? "").length > 0;
      deps.assert(bannerVisible, `session banner not visible after session loss: ${JSON.stringify(summary.main.sessionBanner)}`);
      /* fail-closed + v3 §4.4：发送禁用（普通续聊 fail-closed），输入保持
         可输入（新探索首问的输入面），「⑃ Start new exploration」显式换轨
         入口出现且可用，恢复动作如实呈现。 */
      const composerState = await deps.evalJs(
        `(() => { const input = document.getElementById('prompt-input'); ` +
        "const send = document.getElementById('send'); " +
        "const explore = document.getElementById('new-exploration'); " +
        "const recovery = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Branch from latest available answer')); " +
        "return { inputDisabled: input === null ? null : input.disabled, sendDisabled: send === null ? null : send.disabled, " +
        "exploreHidden: explore === null ? null : explore.hidden, exploreDisabled: explore === null ? null : explore.disabled, " +
        "recoveryPresent: recovery !== undefined && recovery !== null, recoveryDisabled: recovery === undefined || recovery === null ? null : recovery.disabled, " +
        "bannerText: document.getElementById('session-banner') === null ? '' : document.getElementById('session-banner').textContent }; })()",
      );
      deps.assert(composerState.inputDisabled === false, `trunk input should stay typed-in for the new exploration's first question (disabled=${String(composerState.inputDisabled)})`);
      deps.assert(composerState.sendDisabled === true, `trunk send not disabled after session loss (disabled=${String(composerState.sendDisabled)})`);
      deps.assert(composerState.exploreHidden === false, "the explicit new-exploration entry (v3 §4.4) is not presented");
      deps.assert(composerState.exploreDisabled === false, "the new-exploration entry is not actionable");
      deps.assert(composerState.recoveryPresent === true, "recovery affordance (Branch from latest available answer) not presented");
      /* 还原 session 文件 → 刷新即恢复。 */
      for (const file of moved) {
        renameSync(join(sessionsDir, `${file}.moved`), join(sessionsDir, file));
      }
      await deps.navigate(deps.sc.studioUrl);
      const recovered = await deps.evalJs(
        "(() => { const input = document.getElementById('prompt-input'); const b = document.getElementById('session-banner'); " +
        "return { disabled: input === null ? null : input.disabled, bannerHidden: b === null ? true : b.hidden }; })()",
      );
      deps.assert(recovered.disabled === false && recovered.bannerHidden === true,
        `page did not recover after session restore: ${JSON.stringify(recovered)}`);
      await deps.snap("missing-session-recovered");
      return { detail: `session file(s) moved away → banner + fail-closed send + typed-in input + new-exploration entry (v3 §4.4) + recovery affordance; restored → full recovery on reload (${String(moved.length)} file(s))` };
    });

    await deps.runCheck("new-exploration-flow", async () => {
      /* v3 §4.4（issue #7 P0-2）浏览器面：真实 confirm 对话框的取消/确认两
         路都驱动——取消零 POST；确认后换轨成功、横幅下线、发送解锁、标记
         回合渲染；主树分支集不变、回合 +2（phase 末 containment）。 */
      const stateBefore = await deps.api("GET", `/api/trees/${encodeURIComponent(deps.sc.treeId)}/state`);
      const branchesBefore = (stateBefore.body?.branches ?? []).length;
      const mainTrunkId = stateBefore.body?.trunkBranchId;
      deps.assert(typeof mainTrunkId === "string" && mainTrunkId.length > 0, "main tree state has no trunk branch id");
      const trunkViewBefore = (stateBefore.body?.branches ?? []).find((view) => view.branch?.id === mainTrunkId);
      const trunkTurnsBefore = trunkViewBefore?.turns?.length ?? 0;

      /* 移走 session 文件 → 整页刷新 → 降级。 */
      const sessionsDir = join(deps.sc.dataDir, "sessions");
      const files = readdirSync(sessionsDir).filter((f) => !f.startsWith("."));
      deps.assert(files.length > 0, "no session files to move");
      const moved = [];
      for (const file of files) {
        renameSync(join(sessionsDir, file), join(sessionsDir, `${file}.moved`));
        moved.push(file);
      }
      await deps.navigate(deps.sc.studioUrl);
      await deps.waitForJs("document.getElementById('session-banner') !== null && !document.getElementById('session-banner').hidden", 10_000, "banner visible after session loss");

      /* confirm 对话框的 CDP 处理：**单例**一次性监听（累积多个监听会在
         第二个对话框上竞争应答）；未应答的对话框会阻塞页面——意外对话框
         一律 accept 解锁。 */
      let dialogResolveNext = null;
      let dialogAcceptNext = true;
      let dialogHandlerInstalled = false;
      const installDialogHandler = () => {
        if (dialogHandlerInstalled) return;
        dialogHandlerInstalled = true;
        deps.chrome.cdp.on("Page.javascriptDialogOpening", (params) => {
          const resolve = dialogResolveNext;
          dialogResolveNext = null;
          const accept = resolve !== null ? dialogAcceptNext : true;
          deps.chrome.cdp
            .send("Page.handleJavaScriptDialog", { accept, promptText: "" })
            .then(
              () => {
                if (resolve !== null) resolve(params);
              },
              () => {
                if (resolve !== null) resolve(params);
              },
            );
        });
      };
      installDialogHandler();
      const dialogPromise = (accept) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            dialogResolveNext = null;
            reject(new Error("no javascript dialog opened within 5s"));
          }, 5_000);
          dialogAcceptNext = accept;
          dialogResolveNext = (params) => {
            clearTimeout(timer);
            resolve(params);
          };
        });

      /* 取消路径：输入首问 → 点换轨 → confirm 取消 → 零 POST、横幅仍在。
         （期望先于点击注册：对话框可能在 click 的 ACK 之前打开。） */
      await deps.typeInto("#prompt-input", "The browser-face first question of the new exploration.", { replace: true });
      const cancelDialogP = dialogPromise(false);
      await deps.click("#new-exploration");
      const cancelledDialog = await cancelDialogP;
      deps.assert(cancelledDialog !== null, "the confirm dialog opened");
      deps.assert(String(cancelledDialog.message ?? "").includes("NOT restored"), `the dialog states the consequences honestly: ${String(cancelledDialog.message).slice(0, 120)}`);
      await deps.sleep(400);
      const postedWhileCancelled = deps.chrome.netLog.some((e) => e.url.includes("/new-exploration"));
      deps.assert(!postedWhileCancelled, "a cancelled confirmation posts nothing");
      deps.assert(
        (await deps.evalJs("document.getElementById('session-banner').hidden")) === false,
        "the banner stays after the cancelled confirmation",
      );

      /* 确认路径：再点 → confirm 确认 → POST → 横幅下线、发送解锁、输入清空。 */
      const acceptDialogP = dialogPromise(true);
      await deps.click("#new-exploration");
      await acceptDialogP;
      await deps.waitForJs(
        "document.getElementById('session-banner').hidden === true && document.getElementById('send').disabled === false",
        deps.CLI.promptTimeoutMs,
        "the confirmed new exploration clears the banner and unlocks the composer",
      );
      await deps.waitForJs(
        "document.getElementById('conversation').textContent.includes('[new exploration from saved content')",
        deps.CLI.promptTimeoutMs,
        "the marker turn renders in the conversation",
      );
      const cleared = await deps.evalJs(
        "(() => { return { input: document.getElementById('prompt-input').value, exploreHidden: document.getElementById('new-exploration').hidden, marker: document.getElementById('conversation').textContent.includes('The browser-face first question of the new exploration.') }; })()",
      );
      deps.assert(cleared.input === "", "the input clears after the confirmed exploration");
      deps.assert(cleared.exploreHidden === true, "the new-exploration entry hides once available");
      deps.assert(cleared.marker === true, "the typed question stays readable after the marker");

      /* 服务器核对：trunk 恢复可用、回合 +2、user turn 携带标记。 */
      const stateAfter = await deps.api("GET", `/api/trees/${encodeURIComponent(deps.sc.treeId)}/state`);
      const trunkView = (stateAfter.body?.branches ?? []).find((view) => view.branch?.id === mainTrunkId);
      deps.assert(
        trunkView?.sessionAvailability === "available",
        `the trunk recovers on the new session (server-verified; got ${JSON.stringify(trunkView?.sessionAvailability)})`,
      );
      deps.assert((trunkView?.turns ?? []).length === trunkTurnsBefore + 2, `trunk turns +2 (got ${String((trunkView?.turns ?? []).length)} vs ${String(trunkTurnsBefore)})`);
      deps.assert(
        typeof trunkView.turns[trunkView.turns.length - 2]?.text === "string" &&
          trunkView.turns[trunkView.turns.length - 2].text.includes("[new exploration from saved content"),
        "the persisted user turn carries the honest not-restored marker",
      );

      /* Phase-end containment：分支集不变。 */
      deps.assert(
        (stateAfter.body?.branches ?? []).length === branchesBefore,
        `branch set unchanged (got ${String((stateAfter.body?.branches ?? []).length)} vs ${String(branchesBefore)})`,
      );

      /* 还原被移走的旧 session 文件（新会话已是事实源；旧文件恢复为惰性文件，供后续检查整洁）。 */
      for (const file of moved) {
        renameSync(join(sessionsDir, `${file}.moved`), join(sessionsDir, file));
      }
      await deps.snap("new-exploration-flow");
      return {
        detail:
          "v3 §4.4 browser face: session moved away → banner + fail-closed; typed first question → confirm cancel (zero POST, dialog states NOT restored) → confirm accept → POST /new-exploration → banner clears, composer unlocks, honest marker turn renders (page + server), trunk +2 turns, branch set unchanged",
      };
    });

    await deps.runCheck("response-loss-midstream", async () => {
      /* real-pi 专属：真实模型时延窗口内整页刷新（响应丢失），
         刷新后页面以权威状态对账，绝不停留在流式占位中间态。 */
      await deps.typeInto("#prompt-input", "Please write a short paragraph (about 80 words) about tides. Then reply with: done-tides.", { replace: true });
      await deps.click("#send");
      await deps.sleep(700); /* 流式进行中 */
      await deps.navigate(deps.sc.studioUrl);
      const settled = await deps.waitForJs(
        "(() => { const placeholder = document.getElementById('streaming-turn'); " +
        "const status = document.getElementById('run-status'); " +
        "return placeholder === null && status !== null && status.classList.contains('idle'); })()",
        deps.CLI.promptTimeoutMs,
        "page settles after mid-stream reload (no stuck placeholder)",
      );
      const summary = await deps.snap("response-loss-midstream");
      const hasAnswer = summary.conversation.turns.some((t) => t.role === "assistant" && (t.text ?? "").length > 0);
      const stateRes = await deps.api("GET", `/api/trees/${encodeURIComponent(deps.sc.treeId)}/state`);
      const runs = (await deps.api("GET", `/api/trees/${encodeURIComponent(deps.sc.treeId)}/diagnostics`)).body?.runs ?? [];
      deps.assert(stateRes.status === 200, "state fetch failed after midstream reload");
      return { detail: `mid-stream reload reconciled to authoritative state (placeholder cleared, status ${String((await deps.evalJs("document.getElementById('run-status').textContent")))}); last run state ${String(runs.at(-1)?.state ?? "?")}; answer present: ${String(hasAnswer)}` };
    });
  }

  return {
    phaseRecovery,
  };
}
