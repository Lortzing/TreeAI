/** Terminology read-model epochs, explicit explain/save/promotion requests, modes and bounded suggestion following. Instance-owned state and dependencies. */

export function createTerminologyController(deps) {


  /** 解释请求世代号（迟到响应按 token 丢弃——目标卡已换/已关时不覆盖）。 */
  let termExplainSeq = 0;

  /** 解释卡进场动效只在新卡打开的那一次渲染播放（重建即止，不重播）。 */
  let termCardEnterPending = false;

  /** 抽屉内缓存偏好切换的在途/失败态（PUT preferences；失败如实 + 重试）。 */
  let termPrefsPending = false;

  let termPrefsError = null;

  /** 抽屉内阅读模式切换的在途/失败态（PUT settings/reading-mode；issue #7 ①）。 */
  let termModePending = false;

  let termModeError = null;

  /**
   * 术语建议在途跟随（issue #7 ①阅读模式）：回答完成后的读模型刷新若见
   * pending 建议集，则有界轮询至终态（1s 间隔、至多 90 次；切树/无 pending
   * 即停）。进程内瞬态跟随——不是产品事实；建议提取走隔离执行器串行链，
   * 回答完成的 POST /prompt 响应可能先于提取终态到达（诚实呈现 pending）。
   */
  let termSuggestFollowActive = false;

  const TERM_SUGGEST_FOLLOW_MAX_POLLS = 90;

  const TERM_SUGGEST_FOLLOW_INTERVAL_MS = 1000;


  /* ------------------------------ 术语三部分（issue #7 C ③ 完整前端） ------------------------------ */

  /** 术语读模型世代号（P1，issue #7 增量验收 2026-09-30）：写 state.terminology
      前双验证之一——同一树上被更新请求取代、或切树后迟到到达的响应按世代
      作废（末次请求胜出）。 */
  let terminologyEpoch = 0;


  /** 术语读模型拉取（解释卡保存/推广后、抽屉打开时与开树时刷新；失败不伪
      装空态——三态：null = 未载 / {ok:true,…} = 已载 / {ok:false} = 拉取
      失败。批注区间覆盖（turnOverlaysFor）只在已载时渲染）。
      P1 竞态整改：写 state 前先验「请求树 + 世代号」——A 树的响应在切到
      B 树后迟到到达时整包丢弃（成功与失败两路同守卫；原先 then 里的树守卫
      只拦渲染、不拦写入，探针实测 A 的批注会写进 B 的读模型）；守卫在写
      点，开树/保存/推广/抽屉/重试等全部调用方自动继承同一规则。 */
  async function refreshTerminology() {
    if (deps.state.currentTreeId === null) return;
    const treeId = deps.state.currentTreeId;
    const epoch = ++terminologyEpoch;
    try {
      const payload = await deps.api(`/api/trees/${encodeURIComponent(treeId)}/terminology`);
      if (epoch !== terminologyEpoch || deps.state.currentTreeId !== treeId) return; /* 迟到丢弃 */
      deps.state.terminology = { ok: true, ...payload };
      followPendingTermSuggestions(); /* ①阅读模式：pending 建议集的有界跟随 */
    } catch {
      if (epoch !== terminologyEpoch || deps.state.currentTreeId !== treeId) return; /* 迟到丢弃 */
      deps.state.terminology = { ok: false };
    }
  }


  /** 开树时拉取术语读模型（批注区间覆盖的数据面）；迟到响应在
      refreshTerminology 的写点丢弃，此处只守卫重渲（树已切换不重渲）。 */
  function refreshTerminologyForTree(treeId) {
    void refreshTerminology().then(() => {
      if (deps.state.currentTreeId === treeId) deps.renderAll();
    });
  }


  /**
   * 解释选区（瞬态任务——不落任何树产品事实；隔离执行器）。任务态在卡内
   * 如实呈现（loading/explained/saved/failed/cancelled——含迟到丢弃注记），
   * 保存与推广是显式后续动作。token 是请求世代号：迟到的响应（目标卡已被
   * 替换/关闭）如实丢弃并计数（termDiscardedLate，抽屉用量行呈现），绝不
   * 覆盖新状态——「late-result-discarded（stale 目标离开视图）」的客户端面。
   */
  async function explainSelection(branchId, turn, selection) {
    const mode = selection.text.trim().includes(" ") ? "range" : "term";
    termExplainSeq += 1;
    const token = termExplainSeq;
    termCardEnterPending = true;
    deps.state.termExplain = {
      branchId,
      turnId: turn.id,
      selection,
      mode,
      state: "loading",
      explanation: null,
      error: null,
      cached: false,
      lateDiscard: false,
      saveOutcome: null,
      annotation: null,
      promotionKey: null,
      promoting: false,
      promotionConflict: null,
      firstQuestion: "",
      token,
    };
    /* 解释已捕获明确区间：选区交互收束（工具条退场，卡成为活跃面）。 */
    if (deps.state.armedSelection !== null) deps.disarmArmedSelection();
    deps.renderAll();
    const cardElement = deps.document.getElementById("term-explain-card");
    if (cardElement !== null) cardElement.focus();
    try {
      const payload = await deps.api(
        `/api/trees/${encodeURIComponent(deps.state.currentTreeId)}/terminology/explain`,
        "POST",
        { branchId, anchorTurnId: turn.id, selection, mode },
      );
      if (deps.state.termExplain === null || deps.state.termExplain.token !== token) {
        deps.state.termDiscardedLate += 1; /* stale 目标已离开/被替换：如实丢弃 */
        return;
      }
      const card = deps.state.termExplain;
      if (payload.annotation != null) {
        /* 服务端同选区去重命中：零模型调用，直接呈现既有批注（已推广时
           卡面给出 resume-or-create 明确去向）。 */
        deps.state.termExplain = {
          ...card,
          state: "saved",
          annotation: payload.annotation,
          explanation: payload.annotation.explanation,
          saveOutcome: "duplicate",
        };
      } else if (payload.task != null && payload.task.state.kind === "succeeded") {
        deps.state.termExplain = {
          ...card,
          state: "explained",
          explanation: payload.task.state.explanation,
          cached: payload.task.state.cached === true,
        };
      } else if (payload.task != null && payload.task.state.kind === "failed") {
        deps.state.termExplain = {
          ...card,
          state: "failed",
          error: `${payload.task.state.code}: ${payload.task.state.message}`,
        };
      } else if (payload.task != null && payload.task.state.kind === "cancelled") {
        deps.state.termExplain = {
          ...card,
          state: "cancelled",
          lateDiscard: payload.task.state.lateResultDiscarded === true,
        };
      } else {
        deps.state.termExplain = { ...card, state: "failed", error: "the explain task ended without a result" };
      }
    } catch (err) {
      if (deps.state.termExplain === null || deps.state.termExplain.token !== token) {
        deps.state.termDiscardedLate += 1;
        return;
      }
      deps.state.termExplain = {
        ...deps.state.termExplain,
        state: "failed",
        error: String(err && err.message ? err.message : err),
      };
    }
    deps.renderAll();
  }


  /**
   * 显式保存批注（产品事实；同选区幂等——服务端返回既有批注，created:false
   * 时卡面如实呈现「已存在，显示既有批注」，不伪装成新建）。
   * P1 同族规则（issue #7 增量验收）：请求期间卡被关闭/替换（token 失配）→
   * 卡面状态如实丢弃（批注已保存为产品事实，随读模型刷新自然可见），绝不
   * 复活已关的卡。
   */
  async function saveTermAnnotation() {
    const card = deps.state.termExplain;
    if (card === null || card.explanation === null) return;
    const token = card.token;
    const payload = await deps.api(
      `/api/trees/${encodeURIComponent(deps.state.currentTreeId)}/terminology/annotations`,
      "POST",
      {
        branchId: card.branchId,
        anchorTurnId: card.turnId,
        selection: card.selection,
        mode: card.mode,
        term: card.selection.text,
        explanation: card.explanation,
      },
    );
    const current = deps.state.termExplain;
    if (current !== null && current.token === token) {
      deps.state.termExplain = {
        ...current,
        state: "saved",
        annotation: payload.annotation,
        saveOutcome: payload.created === true ? "created" : "duplicate",
      };
    }
    await refreshTerminology();
    deps.renderAll();
  }


  /**
   * 幂等推广（issue #7 C ②）：从已保存批注建枝并派发首问（复用底层
   * Anchor/Branch/Origin/Run/回程/Return）。幂等键跨失败重试稳定；成功后
   * 以支线面板打开新分支（同键重放返回同一分支——created:false 如实呈现
   * 「打开的是既有推广」）。冲突（同批注异键，409）如实呈现在卡面（不吞
   * 错、不静默换目标），并刷新读模型以给出「恢复既有探索」的去向。
   */
  async function promoteTermAnnotation() {
    const card = deps.state.termExplain;
    if (card === null || card.annotation === null) return;
    const firstQuestion = card.firstQuestion;
    if (firstQuestion.trim() === "") {
      deps.showError("Type the first question for the follow-up branch first.", "panel");
      deps.$("term-first-question").focus();
      return;
    }
    const promotionKey = card.promotionKey ?? deps.crypto.randomUUID();
    deps.state.termExplain = { ...card, promotionKey, promoting: true, promotionConflict: null };
    deps.renderAll();
    try {
      const payload = await deps.api(
        `/api/trees/${encodeURIComponent(deps.state.currentTreeId)}/terminology/annotations/${encodeURIComponent(card.annotation.id)}/promote`,
        "POST",
        { idempotencyKey: promotionKey, firstQuestion },
      );
      deps.state.treeState = payload.state;
      await refreshTerminology();
      if (deps.state.termExplain !== null && deps.state.termExplain.token === card.token) {
        deps.state.termExplain = null; /* P1 同族：请求期间卡已被替换时不误关新卡 */
      }
      deps.renderAll();
      await deps.openBranchPanel(payload.branch.id, {
        alignCursor: false,
        trigger: { kind: "main-input" },
      });
      if (payload.firstQuestionError !== null) {
        deps.showError(
          `Branch created, but the first question failed (${payload.firstQuestionError.code}: ${payload.firstQuestionError.message}). ` +
            "The saved annotation keeps its promotion — reopen the term and promote again with the same key to retry.",
          "panel",
        );
      } else if (payload.created === false) {
        /* 同键重放：既有推广的分支（首问已成功不重复派发——issue #7 ②）。 */
        deps.showError(`Opened the existing follow-up branch (same promotion key — no duplicate dispatch).`, "panel");
      }
    } catch (err) {
      /* 冲突/失败：如实呈现在卡面（完整失败状态），读模型刷新后给出恢复
         既有探索的明确去向；原始错误仍由 guard 呈现横幅。
         P1 同族竞态（真实浏览器面发现；DOM 桩无 SSE 并发测不出）：推广自身
         派发的首问完成会触发 SSE run-terminal 的读模型刷新，与本路径的
         refreshTerminology 竞争世代号——本路径的写入被作废时，卡面会锁定
         陈旧批注（「恢复既有探索」去向永不出现）。对账补一次直接读
         （submitReturn 响应丢失同款纪律）：以该响应为准更新卡面批注；
         共享读模型仍由常规刷新收敛。 */
      await refreshTerminology().catch(() => {});
      let reconciled = null;
      try {
        reconciled = await deps.api(`/api/trees/${encodeURIComponent(deps.state.currentTreeId)}/terminology`);
      } catch {
        /* 对账读取失败：卡面按现有读模型如实呈现（下方 find 走 state.terminology） */
      }
      const current = deps.state.termExplain;
      if (current !== null && current.token === card.token) {
        const model =
          reconciled !== null
            ? reconciled
            : deps.state.terminology !== null && deps.state.terminology.ok
              ? deps.state.terminology
              : null;
        const freshAnnotation =
          model !== null
            ? (model.annotations.find((a) => a.id === card.annotation.id) ?? current.annotation)
            : current.annotation;
        deps.state.termExplain = {
          ...current,
          promoting: false,
          promotionConflict: String(err && err.message ? err.message : err),
          annotation: freshAnnotation,
        };
        deps.renderAll();
      }
      throw err;
    }
  }


  /** 打开已保存批注的卡（读模型数据面，零请求——与服务端同选区去重语义
      一致）；focusFirstQuestion = 工具条推广捷径直达首问输入。 */
  function openSavedAnnotationCard(annotation, branchId, turn, opts = {}) {
    termCardEnterPending = true;
    termExplainSeq += 1;
    deps.state.termExplain = {
      branchId,
      turnId: turn.id,
      selection: annotation.selection,
      mode: annotation.mode === "range" ? "range" : "term",
      state: "saved",
      explanation: annotation.explanation,
      error: null,
      cached: false,
      lateDiscard: false,
      saveOutcome: "duplicate",
      annotation,
      promotionKey: null,
      promoting: false,
      promotionConflict: null,
      firstQuestion: "",
      token: termExplainSeq,
    };
    if (deps.state.armedSelection !== null) deps.disarmArmedSelection();
    deps.renderAll();
    if (opts.focusFirstQuestion === true) {
      const input = deps.document.getElementById("term-first-question");
      if (input !== null) input.focus();
    } else {
      const cardElement = deps.document.getElementById("term-explain-card");
      if (cardElement !== null) cardElement.focus();
    }
  }


  /** 关闭解释卡：焦点还原到该答案的解释入口；解释入口不可聚焦（无武装
      选区时是 disabled 按钮——真实浏览器 disabled 控件 focus() 静默无操作，
      DOM 桩可聚焦测不出；turn 元素本身无 tabindex）时还原到该视图的
      composer（W2「常驻主焦点」回退，与 closePanel 同款）。 */
  function closeTermExplain() {
    const card = deps.state.termExplain;
    deps.state.termExplain = null;
    deps.renderAll();
    if (card === null) return;
    const target = deps.termExplainButtons.get(card.turnId);
    if (target !== undefined && target.disabled !== true) {
      target.focus();
      return;
    }
    deps.focusComposerWhenSelectable(card.branchId === deps.trunkBranchId() ? deps.$("prompt-input") : deps.$("panel-prompt-input"));
  }


  /**
   * 抽屉内的缓存偏好切换（③：执行器偏好面）：PUT preferences；在途禁用
      明示，失败如实呈现 + 重试（不伪装成功），成功后读模型与抽屉同步。
      P1 同族规则（issue #7 增量验收）：偏好响应只写「请求树」的读模型
      （切树后迟到到达即丢弃）；本写入即读模型新一代——并发在途的旧读模型
      响应（其快照早于本次偏好变化）一并作废，防止把偏好改回旧值。
   */
  async function setTerminologyCachePreference(enabled) {
    const treeId = deps.state.currentTreeId;
    termPrefsPending = true;
    termPrefsError = null;
    deps.renderDrawer();
    try {
      const payload = await deps.api(
        `/api/trees/${encodeURIComponent(treeId)}/terminology/preferences`,
        "PUT",
        { cacheEnabled: enabled },
      );
      terminologyEpoch += 1;
      if (deps.state.currentTreeId === treeId && deps.state.terminology !== null && deps.state.terminology.ok) {
        deps.state.terminology = { ...deps.state.terminology, cacheEnabled: payload.cacheEnabled === true };
      }
    } catch (err) {
      termPrefsError = String(err && err.message ? err.message : err);
    } finally {
      termPrefsPending = false;
      if (deps.state.drawerOpen) deps.renderDrawer();
    }
  }


  /**
   * 抽屉内的阅读模式切换（issue #7 ①阅读模式）：PUT settings/reading-mode。
   * 在途禁用明示；失败如实呈现 + 重试；成功后读模型同步（模式字段就地更新
   * ——P1 同族：请求树守卫 + 世代号作废并发旧响应）。gate 未过时模式仍可
   * 保存切换（旁注如实说明自动建议保持关闭——绝不伪装启用）。
   */
  async function setTerminologyReadingMode(mode) {
    const treeId = deps.state.currentTreeId;
    if (treeId === null) return;
    termModePending = true;
    termModeError = null;
    deps.renderDrawer();
    try {
      const payload = await deps.api(
        `/api/trees/${encodeURIComponent(treeId)}/terminology/settings/reading-mode`,
        "PUT",
        { mode },
      );
      terminologyEpoch += 1;
      if (deps.state.currentTreeId === treeId && deps.state.terminology !== null && deps.state.terminology.ok) {
        /* 就地同步：readingMode + autoSuggestions 生效态（gate × 模式）。
           gate 未过（quality-gate-pending）不因模式切换改变；gate 开时模式
           决定生效与否（manual-only ↔ 其余两档）——服务端是权威面，下一次
           读模型刷新自然对齐（P1 同族：世代号作废并发旧响应）。 */
        const auto = deps.state.terminology.autoSuggestions ?? null;
        const nextAuto =
          auto === null
            ? null
            : auto.reason === "quality-gate-pending"
              ? auto
              : payload.readingMode === "manual-only"
                ? { ...auto, enabled: false, reason: "manual-only" }
                : { ...auto, enabled: true, reason: null };
        deps.state.terminology = {
          ...deps.state.terminology,
          readingMode: payload.readingMode,
          ...(nextAuto === null ? {} : { autoSuggestions: nextAuto }),
        };
      }
    } catch (err) {
      termModeError = String(err && err.message ? err.message : err);
    } finally {
      termModePending = false;
      if (deps.state.drawerOpen) deps.renderDrawer();
    }
  }


  /**
   * 建议集的显式重试（budget-paused/failed 的「可恢复入口」——用户显式动
   * 作）：POST suggestions/:anchorTurnId/retry → 读模型刷新重渲。失败由
   * guard 呈现横幅（按钮态如实回到原状，绝不伪装成功）。
   */
  async function retryTermSuggestions(anchorTurnId) {
    const treeId = deps.state.currentTreeId;
    if (treeId === null) return;
    await deps.api(
      `/api/trees/${encodeURIComponent(treeId)}/terminology/suggestions/${encodeURIComponent(anchorTurnId)}/retry`,
      "POST",
    );
    await refreshTerminology();
    deps.renderAll();
  }


  /** 当前树读模型里是否存在 pending 建议集（跟随轮询的继续条件）。 */
  function treeHasPendingSuggestionSets() {
    const terminology = deps.state.terminology;
    if (terminology === null || !terminology.ok) return false;
    const auto = terminology.autoSuggestions;
    if (auto === null || typeof auto !== "object" || !Array.isArray(auto.sets)) return false;
    return auto.sets.some((set) => set.status === "pending");
  }


  /**
   * pending 建议集的有界跟随轮询（refreshTerminology 成功写入后调用——所有
   * 刷新入口（回答完成/开树/保存/推广/重试/抽屉重试）自动继承）：仍在途则
   * 1s 后再刷，至多 90 次；切树/终态即停。回答完成的 POST 响应可能先于隔离
   * 执行器的提取终态（串行链 + 真实模型耗时），诚实呈现 pending 而非空态。
   */
  function followPendingTermSuggestions() {
    if (termSuggestFollowActive) return;
    const treeId = deps.state.currentTreeId;
    if (treeId === null || !treeHasPendingSuggestionSets()) return;
    termSuggestFollowActive = true;
    let polls = 0;
    const tick = () => {
      if (
        deps.state.currentTreeId !== treeId ||
        polls >= TERM_SUGGEST_FOLLOW_MAX_POLLS ||
        !treeHasPendingSuggestionSets()
      ) {
        termSuggestFollowActive = false;
        return;
      }
      polls += 1;
      void refreshTerminology().then(() => {
        if (deps.state.currentTreeId !== treeId) {
          termSuggestFollowActive = false;
          return;
        }
        deps.renderAll();
        if (
          polls >= TERM_SUGGEST_FOLLOW_MAX_POLLS ||
          !treeHasPendingSuggestionSets()
        ) {
          termSuggestFollowActive = false;
          return;
        }
        deps.window.setTimeout(tick, TERM_SUGGEST_FOLLOW_INTERVAL_MS);
      });
    };
    deps.window.setTimeout(tick, TERM_SUGGEST_FOLLOW_INTERVAL_MS);
  }


  /** 建议 chip 的重定位聚焦（Esc 解除武装后还原键盘位置——按词文本匹配）。 */
  function focusTermSuggestionChip(term) {
    for (const chip of deps.document.querySelectorAll(".term-suggest-chip")) {
      if (chip.textContent === term) {
        chip.focus();
        return;
      }
    }
  }


  /**
   * 解除武装的建议预填（Esc / Dismiss 共用）：清 state.termSuggest、重渲、
   * 焦点还原到该词的 chip（键盘位置不丢）。
   */
  function disarmTermSuggestion() {
    const armed = deps.state.termSuggest;
    if (armed === null) return;
    deps.state.termSuggest = null;
    deps.renderAll();
    focusTermSuggestionChip(armed.term);
  }

  return {
    openSavedAnnotationCard,
    explainSelection,
    saveTermAnnotation,
    refreshTerminology,
    refreshTerminologyForTree,
    get termPrefsPending() { return termPrefsPending; },
    set termPrefsPending(value) { termPrefsPending = value; },
    setTerminologyCachePreference,
    get termPrefsError() { return termPrefsError; },
    set termPrefsError(value) { termPrefsError = value; },
    get termModePending() { return termModePending; },
    set termModePending(value) { termModePending = value; },
    setTerminologyReadingMode,
    get termModeError() { return termModeError; },
    set termModeError(value) { termModeError = value; },
    disarmTermSuggestion,
    retryTermSuggestions,
    closeTermExplain,
    get termCardEnterPending() { return termCardEnterPending; },
    set termCardEnterPending(value) { termCardEnterPending = value; },
    promoteTermAnnotation,
  };
}
