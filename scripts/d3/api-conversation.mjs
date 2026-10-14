
/** api-conversation runner operations with the original shared run state Instance-owned state and dependencies. */

export function createApiConversation(deps) {

  /* ------------------------------------------------------------------ */
  /* 阶段实现                                                            */
  /* ------------------------------------------------------------------ */

  async function phaseBoot() {
    await deps.runCheck("studio-boot", async () => {
      const studio = await deps.startStudio(deps.sc.dataDir);
      deps.sc.studios.push(studio);
      deps.sc.port = studio.port;
      const health = await deps.api(deps.sc.port, "GET", "/api/health");
      deps.assert(health.status === 200 && health.body?.ok === true, `health check failed: ${deps.errDetail(health)}`);
      const banner = studio.stdout;
      const driver = deps.MODE === "real-pi" ? "pi" : "echo";
      deps.assert(banner.includes(`driver=${driver}`), `banner does not report driver=${driver}: ${deps.truncate(deps.stripSecret(banner), 300)}`);
      if (deps.MODE === "real-pi") {
        deps.assert(banner.includes("pi agent-dir="), "banner does not report the controlled agent dir");
        deps.assert(banner.includes(`pi api key=${deps.PI_API_KEY_ENV} env`), `banner does not report the ${deps.PI_API_KEY_ENV} env seam`);
        /* 工具缝的两段式：本引导恒为零工具（工具旗标仅在 A5 阶段的第二次
           引导转发；其横幅证明由 A5-product-tool-policy 的 setup 断言）。 */
        deps.assert(!banner.includes("pi tools="), "zero-tools boot unexpectedly reports a pi tools allowlist");
      }
      deps.booted = true;
      return { detail: `${driver} driver on 127.0.0.1:${deps.sc.port}, /api/health ok` };
    });
  }

  async function phaseTrunk() {
    await deps.runCheck("tree-create", async () => {
      const created = await deps.api(deps.sc.port, "POST", "/api/trees");
      deps.assert(created.status === 201, `tree creation failed: ${deps.errDetail(created)}`);
      deps.sc.treeId = created.body?.tree?.id;
      deps.sc.trunkId = created.body?.trunkBranchId;
      deps.assert(typeof deps.sc.treeId === "string" && deps.sc.treeId.length > 0, "no tree id in creation response");
      deps.assert(typeof deps.sc.trunkId === "string" && deps.sc.trunkId.length > 0, "no trunk branch id in creation response");
      const state = created.body.state;
      deps.assert(state?.branches?.length === 1, "a fresh tree must have exactly one (trunk) branch");
      deps.assert(state.branches[0].branch.id === deps.sc.trunkId, "the single branch is not the trunk");
      deps.assert(state.cursor === null, "cursor must be null before the first prompt");
      const listed = await deps.api(deps.sc.port, "GET", "/api/trees");
      deps.assert(listed.status === 200 && listed.body?.trees?.length === 1, "tree list does not show exactly one tree");
      /* 订阅 SSE（在任何 prompt 之前，捕获全部事件）。 */
      deps.sc.sse = await deps.openSse(deps.sc.port, deps.treePath("events"));
      return { detail: `tree + trunk created; SSE stream attached before any prompt` };
    });

    await deps.runCheck("trunk-main-line", async () => {
      const t1 = await deps.promptOk(deps.sc.trunkId, deps.SCENARIO.t1);
      deps.sc.answers.t1 = t1.outcome.assistantTurn.text;
      deps.sc.anchorATurnId = t1.outcome.assistantTurn.id;
      deps.assertEchoMode(deps.sc.answers.t1, deps.echoAnswer(deps.SCENARIO.t1), "trunk turn 1");
      const t2 = await deps.promptOk(deps.sc.trunkId, deps.SCENARIO.t2);
      deps.sc.answers.t2 = t2.outcome.assistantTurn.text;
      deps.sc.anchorBTurnId = t2.outcome.assistantTurn.id;
      deps.assertEchoMode(deps.sc.answers.t2, deps.echoAnswer(deps.SCENARIO.t1, deps.SCENARIO.t2), "trunk turn 2");
      const state = await deps.fetchState();
      deps.assert(deps.turnCount(state, deps.sc.trunkId) === 4, `trunk must hold 4 turns after two prompts (got ${String(deps.turnCount(state, deps.sc.trunkId))})`);
      deps.assert(state.cursor?.branchId === deps.sc.trunkId, "cursor is not on the trunk after trunk prompts");
      return { detail: "two trunk prompts succeeded; cursor on trunk; 4 turns persisted" };
    });
  }

  async function phaseBranchA() {
    await deps.runCheck("branch-a-create", async () => {
      const selection = deps.selectionOf(deps.sc.answers.t1);
      const res = await deps.api(deps.sc.port, "POST", deps.treePath("branches"), {
        sourceBranchId: deps.sc.trunkId,
        anchorTurnId: deps.sc.anchorATurnId,
        selection,
      });
      deps.assert(res.status === 201, `branch A creation failed: ${deps.errDetail(res)}`);
      deps.sc.branchA = res.body?.branch?.id;
      const origin = res.body?.origin;
      deps.assert(typeof deps.sc.branchA === "string", "no branch id in branch creation response");
      deps.assert(origin?.sourceBranchId === deps.sc.trunkId, "branch A origin source is not the trunk");
      deps.assert(origin?.anchorTurnId === deps.sc.anchorATurnId, "branch A origin anchor is not the trunk turn-1 answer");
      deps.assert(
        origin?.selection?.start === selection.start &&
          origin.selection.end === selection.end &&
          origin.selection.text === selection.text,
        "branch A origin selection mismatch",
      );
      const state = await deps.fetchState();
      deps.assert(state.branches.length === 2, `expected 2 branches after creating branch A (got ${String(state.branches.length)})`);
      const view = deps.branchView(state, deps.sc.branchA);
      deps.assert(view.originStatus === "available", `branch A anchor status is ${String(view.originStatus)} (expected available)`);
      return { detail: "branch A forked from the trunk turn-1 answer anchor (origin + selection recorded)" };
    });

    await deps.runCheck("branch-a-followups", async () => {
      const a1 = await deps.promptOk(deps.sc.branchA, deps.SCENARIO.a1);
      deps.sc.answers.a1 = a1.outcome.assistantTurn.text;
      deps.assertEchoMode(deps.sc.answers.a1, deps.echoAnswer(deps.SCENARIO.t1, deps.SCENARIO.a1), "branch A turn 1");
      const a2 = await deps.promptOk(deps.sc.branchA, deps.SCENARIO.a2);
      deps.sc.answers.a2 = a2.outcome.assistantTurn.text;
      deps.sc.a2SessionFile = a2.outcome.run.session?.sessionFile ?? null;
      deps.assertEchoMode(deps.sc.answers.a2, deps.echoAnswer(deps.SCENARIO.t1, deps.SCENARIO.a1, deps.SCENARIO.a2), "branch A turn 2");
      const state = await deps.fetchState();
      deps.assert(deps.turnCount(state, deps.sc.branchA) === 4, `branch A must hold 4 turns after two follow-ups (got ${String(deps.turnCount(state, deps.sc.branchA))})`);
      return { detail: "two branch-A follow-ups succeeded (>= 2 turns per branch)" };
    });
  }

  async function phaseSwitch() {
    await deps.runCheck("switch-navigation", async () => {
      const res = await deps.api(deps.sc.port, "POST", deps.treePath("switch"), { branchId: deps.sc.trunkId });
      deps.assert(res.status === 200, `switch to trunk failed: ${deps.errDetail(res)}`);
      deps.assert(res.body?.cursor?.branchId === deps.sc.trunkId, "switch response cursor is not the trunk");
      const state = await deps.fetchState();
      deps.assert(state.cursor?.branchId === deps.sc.trunkId, "state cursor is not the trunk after switching back");
      return { detail: "explicit switch back to the trunk (session leaf re-navigated)" };
    });
  }

  async function phaseBranchB() {
    await deps.runCheck("branch-b-create", async () => {
      const selection = deps.selectionOf(deps.sc.answers.t2);
      const res = await deps.api(deps.sc.port, "POST", deps.treePath("branches"), {
        sourceBranchId: deps.sc.trunkId,
        anchorTurnId: deps.sc.anchorBTurnId,
        selection,
      });
      deps.assert(res.status === 201, `branch B creation failed: ${deps.errDetail(res)}`);
      deps.sc.branchB = res.body?.branch?.id;
      const origin = res.body?.origin;
      deps.assert(typeof deps.sc.branchB === "string", "no branch id in branch creation response");
      deps.assert(origin?.sourceBranchId === deps.sc.trunkId, "branch B origin source is not the trunk");
      deps.assert(origin?.anchorTurnId === deps.sc.anchorBTurnId, "branch B origin anchor is not the trunk turn-2 answer");
      deps.assert(origin.anchorTurnId !== deps.sc.anchorATurnId, "branch B must anchor on a DIFFERENT turn than branch A");
      const state = await deps.fetchState();
      deps.assert(state.branches.length === 3, `expected 3 branches after creating branch B (got ${String(state.branches.length)})`);
      const view = deps.branchView(state, deps.sc.branchB);
      deps.assert(view.originStatus === "available", `branch B anchor status is ${String(view.originStatus)} (expected available)`);
      return { detail: "branch B forked from the trunk turn-2 answer anchor (different anchor from branch A)" };
    });

    await deps.runCheck("branch-b-followups", async () => {
      const b1 = await deps.promptOk(deps.sc.branchB, deps.SCENARIO.b1);
      deps.sc.answers.b1 = b1.outcome.assistantTurn.text;
      deps.assertEchoMode(deps.sc.answers.b1, deps.echoAnswer(deps.SCENARIO.t1, deps.SCENARIO.t2, deps.SCENARIO.b1), "branch B turn 1");
      const b2 = await deps.promptOk(deps.sc.branchB, deps.SCENARIO.b2);
      deps.sc.answers.b2 = b2.outcome.assistantTurn.text;
      deps.sc.b2SessionFile = b2.outcome.run.session?.sessionFile ?? null;
      deps.assertEchoMode(deps.sc.answers.b2, deps.echoAnswer(deps.SCENARIO.t1, deps.SCENARIO.t2, deps.SCENARIO.b1, deps.SCENARIO.b2), "branch B turn 2");
      const state = await deps.fetchState();
      deps.assert(deps.turnCount(state, deps.sc.branchB) === 4, `branch B must hold 4 turns (got ${String(deps.turnCount(state, deps.sc.branchB))})`);
      return { detail: "two branch-B follow-ups succeeded (>= 2 turns per branch)" };
    });
  }

  async function phaseNoBleed() {
    await deps.runCheck("no-context-bleed", async () => {
      deps.assert(typeof deps.sc.answers.a2 === "string" && deps.sc.answers.a2.length > 0, "scenario wiring: branch A probe answer missing");
      deps.assert(typeof deps.sc.answers.b2 === "string" && deps.sc.answers.b2.length > 0, "scenario wiring: branch B probe answer missing");
      /* echo 模式：回声答案确定（回声携带本支线可见的全部用户文本），
         维持答案面断言。 */
      if (deps.MODE === "echo-selftest") {
        /* 分支 A：可见锚点前主干历史（maple）+ 自己的 cedar；不可见锚点后的
           主干第二轮（4127）与分支 B（birch）。 */
        deps.assertContainsMarkers(deps.sc.answers.a2, ["cedar", "maple"], "branch A probe answer");
        deps.assertAbsentMarkers(deps.sc.answers.a2, ["4127", "birch"], "branch A probe answer");
        /* 分支 B：锚点在主干第二轮答案上——两轮主干历史（maple + 4127）+ 自己
           的 birch 都可见；分支 A 的 cedar 不可见。 */
        deps.assertContainsMarkers(deps.sc.answers.b2, ["birch", "maple", "4127"], "branch B probe answer");
        deps.assertAbsentMarkers(deps.sc.answers.b2, ["cedar"], "branch B probe answer");
        return {
          detail:
            "branch A sees cedar+maple only; branch B sees birch+maple+4127 only; no cross-branch or post-anchor trunk leakage (echo answer surface)",
        };
      }
      /* 真实模型：「列举可见词」措辞有方差（b2 可能只回 "birch"——模型行为，
         非串扰证据）。正向可见性改为 session entry 树的 parentId 路径机械证明
         （= 续聊点可见的完整上下文）；负向（绝不见 cedar/birch 跨支线、A 不见
         锚点后 4127）同路径断言。 */
      const aPath = deps.sessionEntryPathText(deps.sc.a2SessionFile, "Branch A, turn two");
      deps.assertContainsMarkers(aPath, ["cedar", "maple"], "branch A session path");
      deps.assertAbsentMarkers(aPath, ["4127", "birch"], "branch A session path");
      const bPath = deps.sessionEntryPathText(deps.sc.b2SessionFile, "Branch B, turn two");
      deps.assertContainsMarkers(bPath, ["birch", "maple", "4127"], "branch B session path");
      deps.assertAbsentMarkers(bPath, ["cedar"], "branch B session path");
      return {
        detail:
          "branch A sees cedar+maple only; branch B sees birch+maple+4127 only (session entry path proof — model wording decoupled); no cross-branch or post-anchor trunk leakage",
      };
    });
  }

  async function phaseAnchorReveal() {
    await deps.runCheck("anchor-reveal", async () => {
      const res = await deps.api(
        deps.sc.port,
        "POST",
        `/api/trees/${encodeURIComponent(deps.sc.treeId)}/branches/${encodeURIComponent(deps.sc.branchA)}/source`,
      );
      deps.assert(res.status === 200, `reveal branch A origin failed: ${deps.errDetail(res)}`);
      const source = res.body?.source;
      deps.assert(source?.status === "available", `anchor status is ${String(source?.status)} (expected available)`);
      deps.assert(source?.sourceBranchId === deps.sc.trunkId, "revealed source branch is not the trunk");
      deps.assert(source?.anchorTurnId === deps.sc.anchorATurnId, "revealed anchor turn is not the trunk turn-1 answer");
      deps.assert(
        source?.selection?.text === deps.sc.answers.t1.slice(0, Math.min(16, deps.sc.answers.t1.length)),
        "revealed selection text does not match the anchor answer slice",
      );
      deps.assert(res.body?.state?.cursor?.branchId === deps.sc.trunkId, "reveal did not re-align the cursor to the source branch");
      return { detail: "branch A origin revealed: anchor available, selection intact, cursor re-aligned" };
    });
  }

  async function phaseReturn() {
    await deps.runCheck("return-submit", async () => {
      const res = await deps.api(deps.sc.port, "POST", deps.treePath("return"), {
        fromBranchId: deps.sc.branchA,
        text: deps.SCENARIO.returnText,
        idempotencyKey: deps.SCENARIO.returnKey,
      });
      deps.assert(res.status === 201, `return submission failed: ${deps.errDetail(res)}`);
      const turn = res.body?.returnTurn;
      deps.assert(turn?.branchId === deps.sc.trunkId, "return turn is not recorded on the trunk");
      deps.assert(turn?.fromBranchId === deps.sc.branchA, "return turn fromBranch is not branch A");
      deps.assert(turn?.idempotencyKey === deps.SCENARIO.returnKey, "return turn idempotency key mismatch");
      deps.assert(turn?.deliveredRunId === null, "a fresh return must not be delivered yet");
      deps.assert(turn?.targetAnchor?.anchorTurnId === deps.sc.anchorATurnId, "return targetAnchor is not the branch A anchor");
      deps.assert(turn?.targetAnchor?.sourceBranchId === deps.sc.trunkId, "return targetAnchor source is not the trunk");
      const state = await deps.fetchState();
      deps.assert(deps.returnTurns(state).length === 1, "exactly one return turn expected on the trunk");
      return { detail: "return submitted (201) with targetAnchor snapshot; deliveredRunId null (confirmed, not delivered)" };
    });

    await deps.runCheck("return-idempotency", async () => {
      /* 同键同内容重放 → 200，同一 returnTurn，零新写入。 */
      const replay = await deps.api(deps.sc.port, "POST", deps.treePath("return"), {
        fromBranchId: deps.sc.branchA,
        text: deps.SCENARIO.returnText,
        idempotencyKey: deps.SCENARIO.returnKey,
      });
      deps.assert(replay.status === 200, `same-key replay must be 200 (got ${String(replay.status)})`);
      const first = deps.returnTurns(await deps.fetchState())[0];
      deps.assert(replay.body?.returnTurn?.id === first.id, "same-key replay must return the SAME return turn");
      /* 同键不同内容 → 409 return-conflict，既有 Return 不变。 */
      const conflict = await deps.api(deps.sc.port, "POST", deps.treePath("return"), {
        fromBranchId: deps.sc.branchA,
        text: `${deps.SCENARIO.returnText} TAMPERED`,
        idempotencyKey: deps.SCENARIO.returnKey,
      });
      deps.assert(conflict.status === 409, `same-key different-content must be 409 (got ${String(conflict.status)})`);
      deps.assert(conflict.body?.error?.code === "return-conflict", `conflict code is ${String(conflict.body?.error?.code)}`);
      const after = deps.returnTurns(await deps.fetchState());
      deps.assert(after.length === 1 && after[0].id === first.id, "conflict must leave the existing return unchanged");
      deps.assert(after[0].text === deps.SCENARIO.returnText, "conflict must not modify the return text");
      return { detail: "replay 200 (same turn), same-key different-content 409 return-conflict, exactly one return row" };
    });

    await deps.runCheck("return-delivery", async () => {
      deps.sc.composedT3 = `[Return from branch ${deps.sc.branchA}]\n${deps.SCENARIO.returnText}\n\n${deps.SCENARIO.t3}`;
      const t3 = await deps.promptOk(deps.sc.trunkId, deps.SCENARIO.t3);
      deps.sc.answers.t3 = t3.outcome.assistantTurn.text;
      deps.assert(t3.outcome.deliveredReturns === 1, `deliveredReturns is ${String(t3.outcome.deliveredReturns)} (expected 1)`);
      if (deps.MODE === "echo-selftest") {
        deps.assertEchoMode(deps.sc.answers.t3, deps.echoAnswer(deps.SCENARIO.t1, deps.SCENARIO.t2, deps.sc.composedT3), "trunk turn 3 (return delivery)");
      } else {
        deps.assertContainsMarkers(deps.sc.answers.t3, ["aspen", "maple"], "trunk turn 3 answer");
        deps.assertAbsentMarkers(deps.sc.answers.t3, ["cedar", "birch"], "trunk turn 3 answer");
      }
      const state = await deps.fetchState();
      const returns = deps.returnTurns(state);
      deps.assert(returns.length === 1 && returns[0].deliveredRunId === t3.outcome.run.id, "the return turn is not marked delivered by the T3 run");
      deps.assert(deps.turnCount(state, deps.sc.trunkId) === 7, `trunk must hold 7 turns after delivery (got ${String(deps.turnCount(state, deps.sc.trunkId))})`);
      return { detail: "return delivered exactly once with the next trunk prompt (deliveredRunId set)" };
    });
  }

  return {
    phaseBoot,
    phaseTrunk,
    phaseBranchA,
    phaseSwitch,
    phaseBranchB,
    phaseNoBleed,
    phaseAnchorReveal,
    phaseReturn,
  };
}
