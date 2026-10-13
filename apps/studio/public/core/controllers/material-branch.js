/** Explicit material exploration intents, first-question idempotency/reconciliation, resume and continuation. Instance-owned state and dependencies. */

export function createMaterialBranchController(deps) {


  /* ------------------------------ D4-3 材料建枝（issue #8 charter §3.3 / ADR-004） ------------------------------ */

  /** D4-3 建枝流程世代号（迟到响应丢弃——P1 同族规则）。 */
  let materialBranchingSeq = 0;

  /**
   * 材料 Branch 判定（树态结构信号）：非 Trunk 分支且无 Turn 来源（turn 来源
   * 分支恒有 origin；材料来源只落 material_branch_origins——与后端
   * service.submitReturn 的判定同口径）。材料 Return 的主线识别同用。
   */
  function isMaterialBranchView(view) {
    const st = deps.state.treeState;
    if (st === null || view === null) return false;
    return view.branch.id !== st.trunkBranchId && view.origin === null;
  }


  /**
   * 建枝入口（捕获条按钮）：resolve-selection → from-material 两步。
   * 1. 规范选区：阅读器的捕获载荷不含 sourceHash（窗口可能被裁剪，客户端
   *    不伪造）——经 D4-2 resolve-selection 由服务端复核切片/块/边界并签发
   *    规范 MaterialSelection（含 sourceHash；捕获过期时如实 400）；
   * 2. from-material {selection, intentKey, mode:"resume-or-create"}——
   *    同来源已有探索则进入恢复/另开二选，无则按 intentKey 新建（响应携带
   *    提交前的材料范围声明）。挂起的 intentKey（同选区身份）复用——建枝后
   *    未问的流程经同键幂等续走（刷新/重启后直达声明面）。
   * 建枝零 Run/Turn（首问是独立显式提交）；本调用不触碰对话游标（无
   * POST /switch——阅读与探索互不干扰，D4-2 同纪律）。
   */
  async function startMaterialBranchFlow(selection) {
    const treeId = deps.state.currentTreeId;
    if (treeId === null) return;
    const token = ++materialBranchingSeq;
    const identity = deps.materialSelectionIdentity(selection);
    const pending = deps.readPendingMaterialIntent(treeId, identity);
    const intentKey = pending !== null ? pending.intentKey : deps.crypto.randomUUID();
    deps.state.materialBranching = {
      phase: "creating",
      selection,
      intentKey,
      branchId: null,
      context: null,
      mode: null,
      created: false,
      restore: null,
      firstQuestion: pending !== null ? String(pending.firstQuestion ?? "") : "",
      submitting: false,
      dispatchNote: null,
      error: null,
      conflict: null,
      token,
    };
    deps.renderMaterialReader();
    const flowElement = deps.document.getElementById("mat-branch-flow");
    if (flowElement !== null) flowElement.focus();
    try {
      /* 步骤一：规范选区（服务端复核 + sourceHash 签发）。 */
      const resolved = await deps.api(
        `/api/trees/${encodeURIComponent(treeId)}/materials/${encodeURIComponent(selection.materialId)}` +
          `/versions/${encodeURIComponent(selection.versionId)}/resolve-selection`,
        "POST",
        {
          locator: { kind: "utf16-range", start: selection.start, end: selection.end },
          excerpt: selection.excerpt,
          blockId: selection.blockId,
        },
      );
      const canonical = resolved.selection;
      /* 步骤二：建枝/恢复（resume-or-create）。 */
      const payload = await deps.api(
        `/api/trees/${encodeURIComponent(treeId)}/branches/from-material`,
        "POST",
        { selection: canonical, intentKey, mode: "resume-or-create" },
      );
      if (deps.state.materialBranching === null || deps.state.materialBranching.token !== token) return; /* 迟到丢弃 */
      deps.state.treeState = payload.state;
      const branchId = payload.branch.id;
      deps.rememberMaterialBranchOrigin(treeId, branchId, {
        selection: canonical,
        materialTitle: payload.context.materialTitle,
      });
      if (payload.mode === "restored") {
        const view = deps.branchView(branchId);
        const hasTurns = view !== null && view.turns.length > 0;
        /* 恢复 + 挂起键 + 零 turn：该键正是这枝的未落库首问——直达声明面
           （同键幂等续走）。其余恢复进入明确二选。 */
        if (!hasTurns && pending !== null) {
          deps.state.materialBranching = {
            ...deps.state.materialBranching,
            phase: "declared",
            mode: "restored",
            created: false,
            branchId,
            context: payload.context,
            dispatchNote:
              "reopened the branch this pending intent key created (no first question has landed on it yet) — the flow resumes with the same key",
          };
          deps.persistPendingMaterialIntent(treeId, identity, intentKey, deps.state.materialBranching.firstQuestion);
        } else {
          deps.state.materialBranching = {
            ...deps.state.materialBranching,
            phase: "choice",
            mode: "restored",
            created: false,
            branchId,
            context: payload.context,
            restore: {
              created: payload.created === true,
              navigation: payload.navigation ?? null,
              sessionAvailability: payload.sessionAvailability ?? null,
              hasTurns,
            },
          };
        }
      } else {
        deps.state.materialBranching = {
          ...deps.state.materialBranching,
          phase: "declared",
          mode: "created",
          created: payload.created === true,
          branchId,
          context: payload.context,
        };
        deps.persistPendingMaterialIntent(treeId, identity, intentKey, deps.state.materialBranching.firstQuestion);
      }
    } catch (err) {
      if (deps.state.materialBranching === null || deps.state.materialBranching.token !== token) return; /* 迟到丢弃 */
      deps.state.materialBranching = {
        ...deps.state.materialBranching,
        phase: "failed",
        error: String(err && err.message ? err.message : err),
      };
    }
    deps.renderMaterialReader();
  }

  /**
   * 幂等首问提交（先对账后动作在服务端；客户端纪律 = 在途锁不重发 + 结局
   * 如实呈现）：dispatch succeeded（outcome null = 同键重放，零重发）→ 收流
   * 程面、关阅读器、开新枝面板；failed → 诚实错误 + 同键可重试（显式新尝
   * 试）；unknown → 在途对账不决，**不盲发**（无自动重试）；409
   * material-first-question-conflict → 冲突面 + 「改问走普通续聊」去向。
   */
  async function submitMaterialFirstQuestion() {
    const flow = deps.state.materialBranching;
    if (flow === null || flow.phase !== "declared" || flow.submitting) return;
    const treeId = deps.state.currentTreeId;
    if (treeId === null) return;
    const firstQuestion = flow.firstQuestion;
    if (firstQuestion.trim() === "") {
      const input = deps.document.getElementById("mat-branch-first-question");
      if (input !== null) input.focus();
      deps.showError("Type the first question for the exploration first.");
      return;
    }
    const token = flow.token;
    const branchId = flow.branchId;
    const identity = deps.materialSelectionIdentity(flow.selection);
    deps.state.materialBranching = { ...flow, submitting: true, dispatchNote: null, conflict: null };
    deps.renderMaterialReader();
    try {
      const payload = await deps.api(
        `/api/trees/${encodeURIComponent(treeId)}/material-first-question`,
        "POST",
        { intentKey: flow.intentKey, firstQuestion },
      );
      if (deps.state.materialBranching === null || deps.state.materialBranching.token !== token) return; /* 迟到丢弃 */
      deps.state.treeState = payload.state;
      if (payload.dispatch === "succeeded") {
        deps.clearPendingMaterialIntent(treeId, identity); /* 首问已落库：逻辑提交完成 */
        deps.state.materialBranching = null;
        await deps.closeMaterialReader();
        await deps.openBranchPanel(branchId, {
          alignCursor: false,
          trigger: { kind: "material-button", materialId: flow.selection.materialId },
        });
        if (payload.outcome === null) {
          deps.showError(
            "Opened the branch — the first question had already landed with this intent key (idempotent replay, no duplicate dispatch).",
            "panel",
          );
        }
        return;
      }
      if (payload.dispatch === "failed") {
        deps.state.materialBranching = {
          ...deps.state.materialBranching,
          submitting: false,
          dispatchNote: `dispatch failed — ${String(payload.error?.code)}: ${String(payload.error?.message)}`,
        };
      } else {
        deps.state.materialBranching = {
          ...deps.state.materialBranching,
          submitting: false,
          dispatchNote:
            "the first question for this branch was dispatched but never reached a terminal state (the process may have exited " +
            "mid-dispatch, or another dispatch may still be in flight) — it was NOT re-sent; reconcile the branch's runs, then retry",
        };
      }
    } catch (err) {
      if (deps.state.materialBranching === null || deps.state.materialBranching.token !== token) return; /* 迟到丢弃 */
      if (err !== null && typeof err === "object" && err.code === "material-first-question-conflict") {
        deps.state.materialBranching = {
          ...deps.state.materialBranching,
          submitting: false,
          conflict: String(err && err.message ? err.message : err),
        };
      } else {
        deps.state.materialBranching = { ...deps.state.materialBranching, submitting: false };
        deps.renderMaterialReader();
        throw err; /* 网络/传输失败：guard 呈现横幅，流程面保留可重试 */
      }
    }
    deps.renderMaterialReader();
  }


  /** 恢复二选之「打开既有探索」：收流程面 + 关阅读器，面板打开恢复分支。 */
  async function materialBranchResumeExisting() {
    const flow = deps.state.materialBranching;
    if (flow === null || flow.phase !== "choice" || flow.branchId === null) return;
    const branchId = flow.branchId;
    deps.state.materialBranching = null;
    await deps.closeMaterialReader();
    /* alignCursor:false——恢复响应的 navigation 已是诚实的服务端对齐尝试
       （失败/不可用时如实随恢复分离携带，上面已呈现）；重放 /switch 只会
       复现同一失败。 */
    await deps.openBranchPanel(branchId, {
      alignCursor: false,
      trigger: { kind: "material-button", materialId: flow.selection.materialId },
    });
  }


  /** 恢复二选之「显式另开」：新键新提交（from-material mode:"new"）。 */
  async function materialBranchStartNew() {
    const flow = deps.state.materialBranching;
    if (flow === null || flow.phase !== "choice") return;
    const treeId = deps.state.currentTreeId;
    if (treeId === null) return;
    const token = flow.token;
    const intentKey = deps.crypto.randomUUID(); /* 另开 = 新提交：换新键 */
    deps.state.materialBranching = {
      ...flow,
      phase: "creating",
      intentKey,
      branchId: null,
      context: null,
      mode: null,
      created: false,
      restore: null,
      dispatchNote: null,
      conflict: null,
      submitting: false,
    };
    deps.renderMaterialReader();
    try {
      /* 规范选区已由入口步骤一签发（同一选区身份）——恢复响应的 context
         携带同值（确定性）；缺失（理论不可达）时如实失败，不伪造 sourceHash。 */
      const sourceHash =
        flow.context !== null && flow.context.selection !== null ? flow.context.selection.sourceHash : null;
      if (sourceHash === null || sourceHash === "") {
        throw new Error("the canonical selection for this source is not available — restart the flow from the capture bar");
      }
      const payload = await deps.api(
        `/api/trees/${encodeURIComponent(treeId)}/branches/from-material`,
        "POST",
        {
          selection: {
            materialId: flow.selection.materialId,
            versionId: flow.selection.versionId,
            blockId: flow.selection.blockId,
            start: flow.selection.start,
            end: flow.selection.end,
            excerpt: flow.selection.excerpt,
            sourceHash,
          },
          intentKey,
          mode: "new",
        },
      );
      if (deps.state.materialBranching === null || deps.state.materialBranching.token !== token) return; /* 迟到丢弃 */
      deps.state.treeState = payload.state;
      deps.state.materialBranching = {
        ...deps.state.materialBranching,
        phase: "declared",
        mode: "created",
        created: payload.created === true,
        branchId: payload.branch.id,
        context: payload.context,
      };
      deps.rememberMaterialBranchOrigin(treeId, payload.branch.id, {
        selection: payload.origin.selection,
        materialTitle: payload.context.materialTitle,
      });
      deps.persistPendingMaterialIntent(
        treeId,
        deps.materialSelectionIdentity(flow.selection),
        intentKey,
        deps.state.materialBranching.firstQuestion,
      );
    } catch (err) {
      if (deps.state.materialBranching === null || deps.state.materialBranching.token !== token) return; /* 迟到丢弃 */
      deps.state.materialBranching = {
        ...deps.state.materialBranching,
        phase: "failed",
        error: String(err && err.message ? err.message : err),
      };
    }
    deps.renderMaterialReader();
  }


  /**
   * 409 冲突的「改问走普通续聊」去向：收流程面 + 关阅读器，面板打开该分支
   * 并把改后的问题预填进面板 composer——发送是用户的显式动作（普通续聊，
   * 组合材料上下文已在分支既有首问的会话历史里）。输入文本保留在面板
   * composer 中待审阅。
   */
  async function materialBranchContinueWithQuestion() {
    const flow = deps.state.materialBranching;
    if (flow === null || flow.branchId === null) return;
    const branchId = flow.branchId;
    const question = flow.firstQuestion;
    deps.state.materialBranching = null;
    await deps.closeMaterialReader();
    await deps.openBranchPanel(branchId, {
      alignCursor: false,
      trigger: { kind: "material-button", materialId: flow.selection.materialId },
    });
    const input = deps.$("panel-prompt-input");
    if (input !== null && question.trim() !== "") {
      input.value = question;
      input.focus();
    }
    deps.showError(
      "The first question on this branch is immutable — review the question below and send it as a normal continuation " +
        "(the material context already sits in the branch's first-question session).",
      "panel",
    );
  }


  /** 收起建枝流程面（回纯阅读；挂起的 intentKey 保留——同选区重进可续走）。 */
  function closeMaterialBranchFlow() {
    if (deps.state.materialBranching === null) return;
    deps.state.materialBranching = null;
    deps.renderMaterialReader();
  }


  /**
   * 材料 Branch 的「⌖ View source」（D4-3）：跳原文——阅读器打开来源材料
   * 的**锚定版本**并定位到选区所在块（sourceJump 语义：materialId/versionId/
   * blockId——不伪造主线位置）。来源缓存缺失时如实失败（无法定位即不跳）。
   */
  async function materialSourceJump(branchId) {
    const origin = deps.recallMaterialBranchOrigin(deps.state.currentTreeId, branchId);
    if (origin === null) {
      throw new Error(
        "the material source details for this branch are not cached in this browser — it cannot be located for jumping",
      );
    }
    await deps.openMaterial(origin.selection.materialId, {
      trigger: { kind: "element", element: deps.$("panel-view-source") },
      versionId: origin.selection.versionId,
      focusBlockId: origin.selection.blockId,
      arrival: "return-source",
    });
  }

  return {
    isMaterialBranchView,
    startMaterialBranchFlow,
    materialBranchResumeExisting,
    materialBranchStartNew,
    submitMaterialFirstQuestion,
    materialBranchContinueWithQuestion,
    closeMaterialBranchFlow,
    materialSourceJump,
  };
}
