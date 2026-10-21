/** Browser Return drafts, saved-return reconciliation and tree-scoped idempotent submission before navigation. Instance-owned state and dependencies. */

export function createReturnController(deps) {


  /* ------------------------------ Return 草稿（持久化） ------------------------------ */

  const RETURN_DRAFT_STORAGE_PREFIX = "treeai-return-draft:";


  function returnDraftStorageKey(treeId, branchId) {
    return `${RETURN_DRAFT_STORAGE_PREFIX}${treeId}:${branchId}`;
  }


  /**
   * 持久草稿读取（localStorage；W1 §2.1：draft 仅客户端，不进 TreeAI DB）。
   * localStorage 不可用（隐私模式等）时静默降级为会话内草稿。
   */
  function readPersistedDraft(treeId, branchId) {
    if (treeId === null) return null;
    try {
      const raw = deps.window.localStorage.getItem(returnDraftStorageKey(treeId, branchId));
      if (raw === null) return null;
      const parsed = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object") return null;
      if (typeof parsed.idempotencyKey !== "string" || typeof parsed.text !== "string") return null;
      return {
        branchId,
        idempotencyKey: parsed.idempotencyKey,
        text: parsed.text,
        failed: parsed.failed === true,
      };
    } catch {
      return null;
    }
  }


  function persistReturnDraft() {
    const draft = deps.state.returnDraft;
    if (draft === null) return;
    if (deps.state.currentTreeId === null) return;
    try {
      if (draft.text.trim() === "") {
        deps.window.localStorage.removeItem(returnDraftStorageKey(deps.state.currentTreeId, draft.branchId));
        return;
      }
      deps.window.localStorage.setItem(
        returnDraftStorageKey(deps.state.currentTreeId, draft.branchId),
        JSON.stringify({ idempotencyKey: draft.idempotencyKey, text: draft.text, failed: draft.failed }),
      );
    } catch {
      /* 存储不可用：会话内草稿仍有效（刷新后不恢复，如实如此） */
    }
  }


  function removePersistedDraft(treeId, branchId) {
    if (treeId === null) return;
    try {
      deps.window.localStorage.removeItem(returnDraftStorageKey(treeId, branchId));
    } catch {
      /* 同上 */
    }
  }


  /** 分支最近一条 assistant 回答（草稿预填惯例）。 */
  function lastAnswerText(branchId) {
    const view = deps.branchView(branchId);
    if (view === null) return null;
    const lastAnswer = [...view.turns].reverse().find((t) => t.role === "assistant");
    return lastAnswer === undefined ? null : lastAnswer.text;
  }


  /**
   * 面板草稿同步（每次面板渲染调用，幂等）。先对账（W1 §2.5 客户端侧）：
   * 草稿对应的 Return 已按（幂等键 + 来源分支 + 文本）落库（如提交成功但
   * 本地未清账、或另一标签页已提交）→ 草稿使命已完成，丢弃（会话内 +
   * localStorage），树面呈现已提交的 confirmed/delivered 卡，不把陈旧草稿
   * 恢复进输入框——编辑陈旧草稿会换新键，等于把已提交内容重复提交。其余：
   * 1) 该分支已有会话内草稿 → 原样维持；空草稿且分支已有回答 → 预填
   *    （W2 §2.4：空持久草稿不得覆盖“prefill from last answer”惯例）；
   * 2) 无会话草稿但 localStorage 有持久草稿（非空）→ 恢复文本与幂等键
   *    （跨视图切换 / 页面刷新）；
   * 3) 都没有 → 以预填（或空）开一份新草稿。
   */
  function syncReturnDraftForBranch(branchId) {
    const input = deps.$("return-input");
    if (deps.state.returnDraft !== null && deps.state.returnDraft.branchId === branchId) {
      if (
        findReconciledReturn(
          deps.state.treeState,
          deps.state.returnDraft.idempotencyKey,
          branchId,
          deps.state.returnDraft.text,
        ) !== null
      ) {
        removePersistedDraft(deps.state.currentTreeId, branchId);
        deps.state.returnDraft = null;
      } else {
        if (deps.state.returnDraft.text.trim() === "" && input.value.trim() === "") {
          const prefill = lastAnswerText(branchId);
          if (prefill !== null && prefill.trim() !== "") {
            deps.state.returnDraft.text = prefill;
            input.value = prefill;
          }
        }
        return;
      }
    }
    const persisted = readPersistedDraft(deps.state.currentTreeId, branchId);
    if (persisted !== null && persisted.text.trim() !== "") {
      if (
        findReconciledReturn(deps.state.treeState, persisted.idempotencyKey, branchId, persisted.text) ===
        null
      ) {
        deps.state.returnDraft = persisted;
        input.value = persisted.text;
        return;
      }
      /* 对账命中：持久草稿已落库 → 丢弃（localStorage 一并清除），走预填。 */
      removePersistedDraft(deps.state.currentTreeId, branchId);
    }
    const prefill = lastAnswerText(branchId) ?? "";
    deps.state.returnDraft = {
      branchId,
      idempotencyKey: deps.crypto.randomUUID(),
      text: prefill,
      failed: false,
    };
    input.value = prefill;
  }


  /** 提交前兜底：草稿不存在（面板未经同步等边角）时以当前输入开一份。 */
  function ensureReturnDraft(branchId) {
    if (deps.state.returnDraft === null || deps.state.returnDraft.branchId !== branchId) {
      deps.state.returnDraft = {
        branchId,
        idempotencyKey: deps.crypto.randomUUID(),
        text: deps.$("return-input").value,
        failed: false,
      };
    }
    return deps.state.returnDraft;
  }


  /** 提交成功 / 响应丢失对账命中：清空草稿（会话内 + localStorage）。 */
  function clearReturnDraft() {
    const draft = deps.state.returnDraft;
    if (draft !== null) removePersistedDraft(deps.state.currentTreeId, draft.branchId);
    deps.state.returnDraft = null;
    deps.$("return-input").value = "";
  }


  /** 在树状态里按幂等键找已落库的 Return（同键探查；内容比对见 returnMatchesDraft）。 */
  function findReturnByKey(treeState, idempotencyKey) {
    for (const view of treeState.branches) {
      for (const turn of view.turns) {
        if (turn.role === "return" && turn.idempotencyKey === idempotencyKey) {
          return turn;
        }
      }
    }
    return null;
  }


  /**
   * 对账命中判定（W1 §2.3/§2.5 的客户端镜像）：幂等键 + fromBranchId + text
   * 三者全同才视为「同一逻辑提交已落库」（响应丢失对账命中 / 服务端 200
   * 重放语义）。同键异容 = 冲突（服务端 409 return-conflict：旧键已绑定
   * 另一内容，同键重试必然再被拒）——绝不能只按键命中就当成功，否则会把
   * 旧 Return 伪装成已提交、清掉用户刚编辑的文本。
   */
  function returnMatchesDraft(turn, idempotencyKey, fromBranchId, text) {
    return (
      turn.role === "return" &&
      turn.idempotencyKey === idempotencyKey &&
      turn.fromBranchId === fromBranchId &&
      turn.text === text
    );
  }


  /** 按（键, 来源分支, 文本）全同找已落库 Return：命中 = 可按已提交处理。 */
  function findReconciledReturn(treeState, idempotencyKey, fromBranchId, text) {
    for (const view of treeState.branches) {
      for (const turn of view.turns) {
        if (returnMatchesDraft(turn, idempotencyKey, fromBranchId, text)) {
          return turn;
        }
      }
    }
    return null;
  }


  /** 同键异容冲突的显式提示（面板横幅）：冲突事实 + 草稿保留的后续动作。 */
  function returnConflictError(existing, fromBranchId, text) {
    const differences = [];
    if (existing.fromBranchId !== fromBranchId) {
      differences.push(`fromBranchId ${fromBranchId} does not match ${existing.fromBranchId}`);
    }
    if (existing.text !== text) {
      differences.push("text differs");
    }
    const error = new Error(
      `Return conflict: this draft's idempotency key is already bound to a different Return ` +
        `(${differences.join("; ")}). Your draft is kept in the panel — edit the text to submit it as a new Return.`,
    );
    error.code = "return-conflict";
    return error;
  }


  /**
   * 显式提交 Return（面板分支 → 主干；W2 §2.4）：幂等键跨失败重试稳定；
   * 200 重放与 201 新建同为成功。服务端先保存后导航（signed v3 §3.5）：
   * 响应携带 navigation（navigated / no-session / failed），保存结果与
   * 导航结果分开控制收尾——保存成功 → 草稿清除、面板收起、焦点回主线
   * 输入框、主线滚到新 Return 卡（原分叉点附近）；导航失败 → 不立即重放
   * /switch（closePanel skipSwitch），主线横幅如实呈现「已保存，返回主线
   * 失败」+ 重新导航指引，绝不诱导重复提交、也不把已保存的 Return 伪装
   * 成未提交。响应丢失先按 /state 对账（键 + 来源分支 + 文本全同命中 →
   * 按成功处理，不重复提交；同键异容 → 显式冲突：保留草稿与面板、不清空
   * 已编辑文本、不把旧 Return 伪装成成功，编辑即换新键）。失败 → 草稿与
   * 键保留（localStorage 持久化），同键可重试、改写即换新键。
   */
  async function submitReturn() {
    const branchId = deps.state.panelBranchId;
    if (branchId === null) return;
    const input = deps.$("return-input");
    const text = input.value;
    if (text.trim() === "") return;
    const draft = ensureReturnDraft(branchId);
    /* 材料 Branch（D4-3）走 material-return——响应携带材料来源卡（主线卡渲
       染的数据面）；幂等键/草稿/对账纪律与 Turn 来源 Return 完全共用。 */
    const materialBranch = deps.isMaterialBranchView(deps.branchView(branchId));
    let submittedTurnId = null;
    let navigation = null;
    try {
      const payload = await deps.api(
        `/api/trees/${encodeURIComponent(deps.state.currentTreeId)}${materialBranch ? "/material-return" : "/return"}`,
        "POST",
        {
          fromBranchId: branchId,
          text,
          idempotencyKey: draft.idempotencyKey,
        },
      );
      /* 200（同键重放）与 201（新建）同为成功：Return 已保存，清空草稿。 */
      deps.state.treeState = payload.state;
      submittedTurnId = payload.returnTurn.id;
      navigation = payload.navigation ?? null;
      if (materialBranch && payload.card != null) {
        deps.rememberMaterialReturnCard(deps.state.currentTreeId, payload.returnTurn.id, payload.card);
      }
      clearReturnDraft();
    } catch (err) {
      /* 失败先查证（响应丢失：服务端已成功、响应未达客户端）：刷新树状态。
         同键且（来源分支 + 文本）全同 → 按成功处理；同键异容 → 显式冲突
         （草稿保留、面板不收、输入文本不动，编辑换新键后即为新的逻辑提交）；
         未命中 → 保留草稿与键（输入文本不动并落 localStorage），刷新后的
         状态照常呈现，错误交由 guard 呈现——用户可直接重试（同键）或改写
         （改写即换新键）。 */
      const refreshed = await deps.api(`/api/trees/${encodeURIComponent(deps.state.currentTreeId)}/state`);
      deps.state.treeState = refreshed;
      const existing = findReturnByKey(refreshed, draft.idempotencyKey);
      if (existing !== null && !returnMatchesDraft(existing, draft.idempotencyKey, branchId, text)) {
        draft.failed = true;
        persistReturnDraft();
        deps.renderAll();
        throw returnConflictError(existing, branchId, text);
      }
      if (existing !== null) {
        clearReturnDraft();
      } else {
        draft.failed = true;
        persistReturnDraft();
        deps.renderAll();
        throw err;
      }
    }
    /* 收尾（回主干 + 滚到新 Return 卡）：保存结果与导航结果分别控制
       （signed v3 §3.5）。导航已由服务端在保存后尝试：failed → 不再重放
       /switch（skipSwitch），面板照常收起（保存已成功，留着面板会诱导
       重复提交），主线横幅如实告知「已保存，返回主线失败」+ 重新导航
       指引；navigated / no-session → 按既有语义收尾（客户端游标对齐失败
       仍呈现在主线横幅——可见面，不吞错，也不把已成功的提交伪装成失败）。 */
    if (submittedTurnId !== null) deps.selectRoundForTurn(submittedTurnId);
    if (navigation !== null && navigation.status === "failed") {
      await deps.closePanel({ focus: "main-input", skipSwitch: true });
      deps.showError(
        `Return saved — returning to the Trunk failed (${navigation.code}: ${navigation.message}). ` +
          `The Return is saved on the Trunk and pending adoption; use the Trunk tab to re-align the session.`,
      );
    } else {
      try {
        await deps.closePanel({ focus: "main-input" });
      } catch (err) {
        deps.showError(
          `Return saved — returning to the Trunk failed (${String(err && err.message ? err.message : err)}). ` +
            `The Return is saved on the Trunk and pending adoption.`,
        );
      }
    }
    if (submittedTurnId !== null) {
      const card = deps.turnElements.get(submittedTurnId);
      if (card !== undefined && typeof card.scrollIntoView === "function") {
        card.scrollIntoView({ block: "center", behavior: deps.scrollBehavior() });
      }
    }
  }

  return {
    syncReturnDraftForBranch,
    persistReturnDraft,
    submitReturn,
  };
}
