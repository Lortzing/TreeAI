
/** browser-conversation original runner scenarios/helpers Instance-owned state and dependencies. */

export function createBrowserConversation(deps) {

  async function phaseConversation() {

    /* ---- A1 主线与两条支线 ---- */

    let treeCreated = null;
    await deps.runCheck("tree-create", async () => {
      await deps.click("#new-tree");
      await deps.waitForJs("document.getElementById('tree-view') !== null && !document.getElementById('tree-view').hidden", 10_000, "tree view visible");
      const summary = await deps.snap("tree-create");
      deps.assert(summary.sidebar.treeCount === 1, `tree list count ${String(summary.sidebar.treeCount)} (expected 1)`);
      const stateRes = await deps.api("GET", "/api/trees");
      deps.assert(stateRes.status === 200 && Array.isArray(stateRes.body?.trees) && stateRes.body.trees.length === 1,
        `GET /api/trees disagrees: ${String(stateRes.status)}`);
      treeCreated = stateRes.body.trees[0];
      deps.sc.treeId = treeCreated.id;
      return { detail: `tree created via real click; trunk view open; branch tabs: ${summary.branchTabs.map((t) => t.text).join(" / ")}` };
    });

    await deps.runCheck("trunk-main-line", async () => {
      await deps.sendTrunkPrompt(deps.SCENARIO.t1, { keyboard: false });
      await deps.waitForAnswerMarkers("#conversation", deps.MODE === "selftest" ? ["maple"] : ["apples", "maple"], deps.CLI.promptTimeoutMs, 1);
      await deps.sendTrunkPrompt(deps.SCENARIO.t2, { keyboard: true });
      await deps.waitForAnswerMarkers("#conversation", deps.MODE === "selftest" ? ["4127"] : ["4127"], deps.CLI.promptTimeoutMs, 2);
      const summary = await deps.snap("trunk-main-line");
      deps.sc.trunkTurnCount = 4; /* 断言前登记：后续检查不因本检查失败而失去基线 */
      const turns = summary.conversation.turns;
      deps.assert(turns.length === 4, `trunk conversation has ${String(turns.length)} turns (expected 4: 2 user + 2 assistant)`);
      deps.assert(turns.filter((t) => t.role === "user").length === 2 && turns.filter((t) => t.role === "assistant").length === 2,
        `trunk turn roles wrong: ${JSON.stringify(turns.map((t) => t.role))}`);
      deps.assert(turns[0].text === deps.SCENARIO.t1, "first user turn text mismatch");
      const stateRes = await deps.api("GET", `/api/trees/${encodeURIComponent(deps.sc.treeId)}/state`);
      deps.assert(stateRes.status === 200, `state fetch ${String(stateRes.status)}`);
      const serverTurns = stateRes.body?.branches?.[0]?.turns?.length ?? -1;
      deps.assert(serverTurns === 4, `server trunk view has ${String(serverTurns)} turns (expected 4)`);
      deps.sc.trunkTurnCount = 4; /* 断言前登记：后续检查不因本检查失败而失去基线 */
      return { detail: `two trunk prompts (t2 via ⌘+Enter keyboard path); 4 turns rendered; API state agrees (4 turns server-side)` };
    });

    const firstAnswerSelector = await deps.runCheck("selection-anchoring", async () => {
      const selector = await deps.assistantTurnSelector("#conversation", 0);
      await deps.dragSelect(selector, deps.SELECT_A.from, deps.SELECT_A.to);
      const state = await deps.evalJs(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); ` +
        "const button = el === null ? null : el.querySelector('.branch-here'); " +
        "return { hasSelection: el === null ? false : el.classList.contains('has-selection'), " +
        "buttonText: button === null ? null : button.textContent, " +
        "selectionText: String(window.getSelection()) }; })()",
      );
      deps.assert(state.hasSelection === true, "assistant turn did not enter .has-selection state after real drag selection");
      deps.assert(state.buttonText === "⑃ 从选文展开支线", `branch button text is ${String(state.buttonText)}`);
      deps.assert(state.selectionText.length > 0, "native selection is empty after drag");
      deps.sc.branchAAnswerExcerpt = state.selectionText;
      deps.sc.branchAAnchorTurnId = await deps.evalJs(`document.querySelector(${JSON.stringify(selector)})?.dataset.turnId ?? null`);
      deps.assert(deps.sc.branchAAnchorTurnId !== null, "the first selection has no turn identity");
      await deps.snap("selection-anchoring");
      return { selector, detail: `real mouse drag produced a native selection (「${deps.truncate(state.selectionText, 40)}」); affordance switched to ⑃ 从选文展开支线` };
    });
    const firstAnswer = firstAnswerSelector?.selector ?? "#conversation .turn.assistant";

    await deps.runCheck("branch-a-create", async () => {
      await deps.click(`${firstAnswer} .branch-here`);
      await deps.waitForJs("document.getElementById('branch-panel') !== null && !document.getElementById('branch-panel').hidden", 10_000, "branch panel open");
      const summary = await deps.snap("branch-a-create");
      const stateRes = await deps.api("GET", `/api/trees/${encodeURIComponent(deps.sc.treeId)}/state`);
      deps.assert(stateRes.status === 200, `state fetch ${String(stateRes.status)}`);
      const anchored = (stateRes.body?.branches ?? []).filter((view) => view.origin?.anchorTurnId === deps.sc.branchAAnchorTurnId);
      deps.assert(anchored.length === 1, `expected one branch from answer ${String(deps.sc.branchAAnchorTurnId)}, found ${String(anchored.length)}`);
      deps.assert(anchored[0].origin.sourceBranchId === stateRes.body.trunkBranchId, "branch A origin is not the trunk answer selected in the browser");
      deps.assert(summary.panel.branchId === anchored[0].branch.id, `panel branch ${String(summary.panel.branchId)} does not match API origin branch ${String(anchored[0].branch.id)}`);
      const tab = summary.branchTabs.find((item) => item.branchId === anchored[0].branch.id);
      deps.assert(tab !== undefined && summary.panel.title.length > 0 && tab.text.startsWith(summary.panel.title),
        `branch A title/tab do not identify API branch ${String(anchored[0].branch.id)}: ${JSON.stringify({ title: summary.panel.title, tab })}`);
      const anchorCtx = summary.panel.anchorContext ?? "";
      deps.assert(anchorCtx.includes(deps.truncate(deps.sc.branchAAnswerExcerpt, 20)) || anchorCtx.includes(deps.sc.branchAAnswerExcerpt.slice(0, 12)),
        `anchor context does not carry the selected excerpt: ${deps.truncate(anchorCtx, 120)}`);
      deps.sc.branchAId = anchored[0].branch.id;
      return { detail: `branch A created from the real selection; panel open with anchor excerpt; title "${String(summary.panel.title)}" identifies the API-verified branch` };
    });

    await deps.runCheck("branch-a-followups", async () => {
      await deps.sendPanelPrompt(deps.SCENARIO.a1, { keyboard: false });
      await deps.waitForAnswerMarkers("#panel-conversation", deps.MODE === "selftest" ? ["cedar"] : ["ok-a1"], deps.CLI.promptTimeoutMs, 1);
      await deps.sendPanelPrompt(deps.SCENARIO.a2, { keyboard: true });
      await deps.waitForAnswerMarkers("#panel-conversation", deps.MODE === "selftest" ? ["cedar", "maple"] : ["cedar", "maple"], deps.CLI.promptTimeoutMs, 2);
      const summary = await deps.snap("branch-a-followups");
      const turns = summary.panelConversation.turns;
      deps.assert(turns.length === 4, `branch A panel shows ${String(turns.length)} turns (expected 4: 2 rounds of user+assistant)`);
      return { detail: `branch A two follow-up rounds (a2 via Ctrl+Enter); ${String(turns.length)} turns rendered in panel` };
    });

    await deps.runCheck("switch-navigation", async () => {
      /* 面板 → 主线（panel-close），主线回合不受支线影响。 */
      await deps.click("#panel-close");
      await deps.waitForJs("document.getElementById('branch-panel') === null || document.getElementById('branch-panel').hidden", 10_000, "branch panel closed");
      let summary = await deps.evalJs(deps.pageSummaryExpression());
      deps.assert(summary.conversation.turns.length === deps.sc.trunkTurnCount,
        `trunk conversation changed after branch work: ${String(summary.conversation.turns.length)} turns (expected ${String(deps.sc.trunkTurnCount)})`);
      /* 主线 → 支线 A（branch tab），支线内容完整且与主线不串。 */
      const tabSelector = `#branch-tabs button[data-branch-id="${deps.sc.branchAId}"]`;
      const tabExists = await deps.evalJs(`document.querySelector(${JSON.stringify(tabSelector)}) !== null`);
      deps.assert(tabExists === true, `branch tab for ${String(deps.sc.branchAId)} not found`);
      await deps.click(tabSelector);
      await deps.waitForJs("document.getElementById('branch-panel') !== null && !document.getElementById('branch-panel').hidden", 10_000, "branch panel reopened");
      summary = await deps.evalJs(deps.pageSummaryExpression());
      deps.assert(summary.panelConversation.turns.length === 4, `branch A panel lost turns after switch: ${String(summary.panelConversation.turns.length)}`);
      deps.assert(!summary.conversation.turns.some((t) => (t.text ?? "").includes("avocados")), "trunk conversation leaked branch A content");
      await deps.snap("switch-navigation");
      return { detail: "panel→trunk→panel navigation via real clicks; trunk untouched by branch turns; branch A content intact" };
    });

    await deps.runCheck("branch-b-create", async () => {
      await deps.click("#panel-close");
      await deps.waitForJs("document.getElementById('branch-panel') === null || document.getElementById('branch-panel').hidden", 10_000, "panel closed before branch B");
      /* 第二个锚点：主干第 2 轮答案的不同子区间（.turn.assistant 序号 1）。 */
      const secondAnswer = await deps.assistantTurnSelector("#conversation", 1);
      deps.sc.branchBAnchorTurnId = await deps.evalJs(`document.querySelector(${JSON.stringify(secondAnswer)})?.dataset.turnId ?? null`);
      deps.assert(deps.sc.branchBAnchorTurnId !== null, "the second selection has no turn identity");
      await deps.dragSelect(secondAnswer, deps.SELECT_B.from, deps.SELECT_B.to);
      const state = await deps.evalJs(
        `(() => { const el = document.querySelector(${JSON.stringify(secondAnswer)}); ` +
        "const button = el === null ? null : el.querySelector('.branch-here'); " +
        "return { hasSelection: el === null ? false : el.classList.contains('has-selection'), buttonText: button === null ? null : button.textContent, selectionText: String(window.getSelection()) }; })()",
      );
      deps.assert(state.hasSelection === true, "second answer did not enter has-selection after drag");
      deps.assert(state.selectionText !== deps.sc.branchAAnswerExcerpt, "branch B selection is identical to branch A selection (expected a different anchor)");
      await deps.click(`${secondAnswer} .branch-here`);
      await deps.waitForJs("document.getElementById('branch-panel') !== null && !document.getElementById('branch-panel').hidden", 10_000, "branch B panel open");
      const summary = await deps.snap("branch-b-create");
      const stateRes = await deps.api("GET", `/api/trees/${encodeURIComponent(deps.sc.treeId)}/state`);
      deps.assert(stateRes.status === 200, `state fetch ${String(stateRes.status)}`);
      const anchored = (stateRes.body?.branches ?? []).filter((view) => view.origin?.anchorTurnId === deps.sc.branchBAnchorTurnId);
      deps.assert(anchored.length === 1, `expected one branch from answer ${String(deps.sc.branchBAnchorTurnId)}, found ${String(anchored.length)}`);
      deps.assert(anchored[0].origin.sourceBranchId === stateRes.body.trunkBranchId, "branch B origin is not the trunk answer selected in the browser");
      deps.assert(summary.panel.branchId === anchored[0].branch.id, `panel branch ${String(summary.panel.branchId)} does not match API origin branch ${String(anchored[0].branch.id)}`);
      const tab = summary.branchTabs.find((item) => item.branchId === anchored[0].branch.id);
      deps.assert(tab !== undefined && summary.panel.title.length > 0 && tab.text.startsWith(summary.panel.title),
        `branch B title/tab do not identify API branch ${String(anchored[0].branch.id)}: ${JSON.stringify({ title: summary.panel.title, tab })}`);
      deps.sc.branchBId = anchored[0].branch.id;
      return { detail: `branch B from a different anchor on the second trunk answer (「${deps.truncate(state.selectionText, 30)}」); panel identity matches the API origin` };
    });

    await deps.runCheck("branch-b-followups", async () => {
      await deps.sendPanelPrompt(deps.SCENARIO.b1, { keyboard: false });
      await deps.waitForAnswerMarkers("#panel-conversation", deps.MODE === "selftest" ? ["birch"] : ["ok-b1"], deps.CLI.promptTimeoutMs, 1);
      await deps.sendPanelPrompt(deps.SCENARIO.b2, { keyboard: false });
      await deps.waitForAnswerMarkers("#panel-conversation", deps.MODE === "selftest" ? ["birch"] : ["birch"], deps.CLI.promptTimeoutMs, 2);
      const summary = await deps.snap("branch-b-followups");
      deps.assert(summary.panelConversation.turns.length === 4, `branch B panel shows ${String(summary.panelConversation.turns.length)} turns (expected 4)`);
      return { detail: "branch B two follow-up rounds; 6 turns rendered in panel" };
    });

    await deps.runCheck("no-context-bleed", async () => {
      /* 支线 B 面板：echo 语义下可见 = 主干可见文本 + 本支线文本。
         B 只应见到 birch（自身）与主干词（maple/4127），绝不见 cedar。 */
      const bText = (await deps.evalJs("document.getElementById('panel-conversation').textContent")).trim();
      deps.assert(bText.includes("birch"), "branch B panel does not show its own codeword birch");
      deps.assert(!bText.includes("cedar"), "branch B panel leaked branch A codeword cedar");
      /* 真实模型的「列举可见词」措辞有方差（b2 可能只回 "birch"——模型行为，
         非串扰证据）：正向可见性断言改为 session entry 树的 parentId 路径
         （= 续聊点可见的完整上下文，机械证明）；echo 模式回声语义本身确定，
         维持面板断言不变。 */
      if (deps.MODE === "selftest") {
        deps.assert(bText.includes("maple"), "branch B panel lost trunk-visible codeword maple");
      } else {
        const bPath = deps.sessionEntryPathText(deps.findTreeSessionFile("Branch B, turn two"), "Branch B, turn two");
        deps.assert(bPath.includes("birch"), "branch B session path lost its own codeword birch");
        deps.assert(bPath.includes("maple"), "branch B session path lost trunk-visible codeword maple");
        deps.assert(bPath.includes("4127"), "branch B session path lost trunk-visible secret number 4127");
        deps.assert(!bPath.includes("cedar"), "branch B session path leaked branch A codeword cedar");
      }
      /* 切回支线 A：A 只见 cedar + 主干词，绝不见 birch。 */
      const tabSelector = `#branch-tabs button[data-branch-id="${deps.sc.branchAId}"]`;
      await deps.click(tabSelector);
      await deps.waitForJs(
        `(() => { const p = document.getElementById('branch-panel'); const tab = document.querySelector(${JSON.stringify(tabSelector)}); ` +
          "return p !== null && !p.hidden && tab !== null && tab.classList.contains('panel-open'); })()",
        10_000,
        "branch A panel actually switched by branch identity",
      );
      const switchedSummary = await deps.evalJs(deps.pageSummaryExpression());
      deps.assert(switchedSummary.panel.branchId === deps.sc.branchAId, "branch A panel identity differs from the selected branch tab");
      const aText = (await deps.evalJs("document.getElementById('panel-conversation').textContent")).trim();
      deps.assert(aText.includes("cedar"), "branch A panel does not show its own codeword cedar");
      deps.assert(!aText.includes("birch"), "branch A panel leaked branch B codeword birch");
      if (deps.MODE === "selftest") {
        deps.assert(aText.includes("maple"), "branch A panel lost trunk-visible codeword maple");
      } else {
        /* A 的锚点在主干第 1 轮答案上：路径含 t1 史（maple）+ cedar，
           绝不含锚点后的主干第 2 轮（4127）与支线 B（birch）。 */
        const aPath = deps.sessionEntryPathText(deps.findTreeSessionFile("Branch A, turn two"), "Branch A, turn two");
        deps.assert(aPath.includes("cedar"), "branch A session path lost its own codeword cedar");
        deps.assert(aPath.includes("maple"), "branch A session path lost trunk-visible codeword maple");
        deps.assert(!aPath.includes("4127"), "branch A session path leaked post-anchor trunk secret number 4127");
        deps.assert(!aPath.includes("birch"), "branch A session path leaked branch B codeword birch");
      }
      await deps.snap("no-context-bleed");
      return {
        detail:
          deps.MODE === "selftest"
            ? "rendered branch panels carry no cross-branch codewords (cedar/birch probe on both sides)"
            : "rendered panels carry no cross-branch codewords; per-branch visibility proven on the session entry path (parentId chain to the root) for both branches",
      };
    });
  }

  async function phaseReturn() {

    /* ---- A3 Return 语义 ---- */

    await deps.runCheck("return-flow", async () => {
      /* 支线 A 面板仍开着：填写 Return 草稿并显式提交。
         注意 #return-input 按产品语义预填上一答案（W1 §2.1 草稿）——
         全选覆盖后再注入（真实用户的编辑路径）。 */
      /* 源支线显式断言：A3 场景的 Return 必须发自支线 A——面板若停在其他
         支线（切换被吞等），Return 的锚点/来源会静默漂移而下游断言照常
         通过（20260929T162759Z 复盘）。 */
      const returnSourceId = await deps.evalJs(
        "document.querySelector('#branch-tabs button.panel-open')?.dataset.branchId ?? null",
      );
      deps.assert(returnSourceId === deps.sc.branchAId,
        `the A3 return must be submitted from branch A ${String(deps.sc.branchAId)}, but the open panel branch is ${String(returnSourceId)}`);
      const returnState = await deps.api("GET", `/api/trees/${encodeURIComponent(deps.sc.treeId)}/state`);
      deps.assert(returnState.status === 200, `state fetch ${String(returnState.status)}`);
      const returnSource = (returnState.body?.branches ?? []).find((view) => view.branch.id === returnSourceId);
      deps.assert(returnSource?.origin?.anchorTurnId === deps.sc.branchAAnchorTurnId && returnSource.origin.sourceBranchId === returnState.body.trunkBranchId,
        "the A3 return branch does not match branch A's API-verified trunk origin");
      await deps.typeInto("#return-input", deps.SCENARIO.returnText, { replace: true });
      await deps.click("#submit-return");
      /* 提交后面板收起、主干出现 anchored Return 卡（待送达）。 */
      await deps.waitForJs("document.getElementById('branch-panel') === null || document.getElementById('branch-panel').hidden", 10_000, "panel closed after return submit");
      await deps.waitForJs("document.querySelectorAll('#conversation .turn.return').length > 0", 10_000, "return card rendered on trunk");
      const summary = await deps.snap("return-flow");
      const card = summary.returnCards[summary.returnCards.length - 1];
      deps.assert(card !== undefined, "no return card on trunk after submit");
      deps.assert(card.text.includes("aspen"), `return card does not carry the return text: ${deps.truncate(card.text, 120)}`);
      deps.assert(card.delivered === false, "return card is already delivered before the next trunk run");
      deps.assert((card.deliveryText ?? "").includes("saved — pending adoption"), `pending delivery badge text unexpected: ${String(card.deliveryText)}`);
      /* 来源抽屉：Returns 区显示 not yet delivered。 */
      await deps.click("#source-drawer-toggle");
      await deps.waitForJs("document.getElementById('source-drawer') !== null && !document.getElementById('source-drawer').hidden", 10_000, "sources drawer open");
      const drawerText = await deps.evalJs("document.getElementById('source-drawer').textContent");
      deps.assert(drawerText.includes("saved, pending adoption"), `drawer return entry missing pending state: ${deps.truncate(drawerText, 200)}`);
      await deps.snap("return-flow-drawer");
      /* 抽屉头部的可见关闭按钮（issue #6 附-4 的鼠标关闭路径）：覆盖层开着
         时真实点击 #drawer-close——click 助手的 elementFromPoint 防护证明
         按钮在覆盖层打开时确实可点（此前鼠标无关闭入口，Esc 是唯一路径；
         Esc 的逐层键盘语义覆盖保在 a11y-semantics / narrow-window-layout）。 */
      await deps.click("#drawer-close");
      await deps.waitForJs("document.getElementById('source-drawer') === null || document.getElementById('source-drawer').hidden", 5_000, "drawer closed via #drawer-close after reading");
      const stateRes = await deps.api("GET", `/api/trees/${encodeURIComponent(deps.sc.treeId)}/state`);
      const returnTurns = (stateRes.body?.branches ?? []).flatMap((view) => (view.turns ?? []).filter((t) => t.role === "return"));
      deps.assert(returnTurns.length === 1, `${String(returnTurns.length)} return turns server-side (expected 1)`);
      deps.assert(returnTurns[0].deliveredRunId === null, "server already marks the return delivered before the next trunk run");
      deps.sc.returnIdempotencyKey = returnTurns[0].idempotencyKey;
      return { detail: `return submitted from branch A panel (draft prefilled → select-all overwrite); anchored card on trunk in confirmed/pending state; drawer shows "not yet delivered"; server agrees (1 return, deliveredRunId null)` };
    });

    await deps.runCheck("return-delivery", async () => {
      /* 主干第 3 轮：下一次 Trunk prompt 必须采用已送达的 Return。 */
      await deps.sendTrunkPrompt(deps.SCENARIO.t3, { keyboard: false });
      await deps.waitForAnswerMarkers("#conversation", deps.MODE === "selftest" ? ["aspen"] : ["aspen"], deps.CLI.promptTimeoutMs, 3);
      const deliverySummary = await deps.evalJs(deps.pageSummaryExpression());
      const cardState = deliverySummary.returnCards.at(-1) ?? { text: null, delivered: false, deliveryText: null };
      deps.assert(cardState.delivered === true, `return card not in delivered state after next trunk run: ${deps.truncate(JSON.stringify(cardState), 200)}`);
      const stateRes = await deps.api("GET", `/api/trees/${encodeURIComponent(deps.sc.treeId)}/state`);
      const returnTurns = (stateRes.body?.branches ?? []).flatMap((view) => (view.turns ?? []).filter((t) => t.role === "return"));
      const delivered = returnTurns.find((t) => t.deliveredRunId !== null);
      deps.assert(delivered !== undefined, "server shows no delivered return after the next trunk run");
      const runs = (await deps.api("GET", `/api/trees/${encodeURIComponent(deps.sc.treeId)}/diagnostics`)).body?.runs ?? [];
      const latestTrunkRun = runs.filter((r) => r.state === "succeeded").at(-1);
      deps.assert(latestTrunkRun !== undefined, "no succeeded run found for delivery cross-check");
      deps.assert(delivered.deliveredRunId === latestTrunkRun.runId,
        `deliveredRunId ${String(delivered.deliveredRunId)} does not match the next trunk run ${String(latestTrunkRun.runId)}`);
      deps.sc.trunkTurnCount += 2;
      await deps.snap("return-delivery");
      return { detail: `return adopted by the next trunk run; card badge → delivered; deliveredRunId === the t3 run (server-verified)` };
    });

    /* 模型错误检查的双时序（镜像 run-d3-real-pi.mjs main()）：selftest 在
       此处经 /fail 钩子注入主树（原位置、原断言面——断言自 v1.0.0 逐字节
       不变，v1.3.0 仅提取为 stepModelErrorEcho）；real-pi 改为错误配置
       registry 的重启舞步，为不扰动其后重启/缺失 session/响应丢失/无障碍/
       窄窗/A2 深选区各检查的主树基线计数，挪到 A2 相之后、工具相引导之前
       执行（独立探针树——见 stepModelErrorRealPi）。 */
    if (deps.MODE === "selftest") {
      await deps.runCheck("model-error-convergence", deps.stepModelErrorEcho);
    }
  }

  return {
    phaseConversation,
    phaseReturn,
  };
}
