/** Branch panel session alignment, source reveal/recovery and explicit branch creation from saved selections. Instance-owned state and dependencies. */

export function createBranchController(deps) {


  /**
   * 打开支线局部面板（W2 §2.3）。面板分支已在面板中（重复点击）只重对齐游标。
   * opts.alignCursor = false 用于建支线（首次续聊由 prompt 显式导航——与既有
   * 行为一致）与锚点揭示（reveal 内服务端已对准 source 分支）。
   */
  async function openBranchPanel(branchId, opts = {}) {
    const st = deps.state.treeState;
    if (st === null || branchId === null || branchId === st.trunkBranchId) return;
    const wasOpen = deps.state.panelBranchId !== null;
    const switching = deps.state.panelBranchId !== branchId;
    let switchFailed = false;
    if (opts.alignCursor !== false) {
      /* 切换语义保留：打开支线面板 = 服务端游标对齐该分支（POST /switch）。
         对齐失败不阻断打开（恢复数据缺 session 的分支实测 502：面板内容是
         产品事实照常可读——降级为既有会话不可用注记 + 换轨入口，此前整链
         抛错只留一条错误横幅，合法的搜索跳转被挡，issue #8 浏览器证据波）。 */
      try {
        const payload = await deps.api(`/api/trees/${encodeURIComponent(deps.state.currentTreeId)}/switch`, "POST", {
          branchId,
        });
        deps.state.treeState = payload.state;
      } catch {
        switchFailed = true;
      }
    }
    if (switching) {
      deps.state.panelBranchId = branchId;
      deps.state.forcePanelSessionNote = false;
    }
    if (switchFailed) deps.state.forcePanelSessionNote = true;
    if (opts.trigger !== undefined) deps.state.panelFocusReturn = opts.trigger;
    deps.renderAll();
    if (!wasOpen) deps.showPanel();
    /* 键盘焦点：面板打开 / 分支切换 → 焦点移入面板（W2 §2.3）。 */
    if (opts.focus === "anchor") {
      /* 揭示打开：焦点交给锚点 turn（由调用方随后 revealAnchorTurn）。 */
    } else {
      deps.focusIntoPanel();
    }
  }


  /**
   * 收起支线面板、回主线（W2 §1 固定回程）。面板内容与阅读位置按分支记忆，
   * 重开可恢复；回主线同时把服务端游标对齐回 Trunk（POST /switch）。
   * 收起即开始退出动效（M2），树面渲染在游标对齐返回后统一刷新一次
   * （避免双次 renderAll 掐断 Return 卡插入/徽标动效）。
   * opts.skipSwitch（signed v3 §3.5）：跳过 POST /switch——服务端提交
   * Return 时已尝试回程导航且失败（响应 navigation.failed），立即重放
   * /switch 只会复现同一失败；重新导航由 Trunk tab / 下次主干讨论承担。
   */
  async function closePanel(opts = {}) {
    if (deps.state.panelBranchId === null) return;
    deps.state.panelBranchId = null;
    deps.state.forcePanelSessionNote = false;
    deps.hidePanel();
    /* 回主线：对齐游标到 Trunk（失败不阻断收起——错误交由 guard 呈现，
       树照常可读；游标以服务端状态为准）。 */
    const trunk = deps.trunkBranchId();
    let switchError = null;
    if (!opts.skipSwitch && trunk !== null && deps.state.currentTreeId !== null) {
      try {
        const payload = await deps.api(`/api/trees/${encodeURIComponent(deps.state.currentTreeId)}/switch`, "POST", {
          branchId: trunk,
        });
        deps.state.treeState = payload.state;
      } catch (err) {
        switchError = err;
      }
    }
    deps.renderAll();
    /* 焦点还原（W2 §2.3）：显式指定（如 Trunk tab / 主线输入框）优先；
       默认回触发元素；无引用 → 主线输入框（常驻主焦点）。 */
    if (opts.focus === "main-input") {
      deps.focusComposerWhenSelectable(deps.$("prompt-input"));
    } else if (opts.focus !== "none") {
      deps.restoreFocusRef(opts.focus === undefined ? deps.state.panelFocusReturn : opts.focus);
    }
    deps.state.panelFocusReturn = null;
    if (switchError !== null) throw switchError;
  }


  /** Trunk tab：收面板回主线；已在主线时重复点击仍对齐游标（旧行为）。 */
  async function returnToTrunk(trunkId) {
    if (deps.state.panelBranchId !== null) {
      await closePanel({ focus: { kind: "tab", branchId: trunkId } });
      return;
    }
    const payload = await deps.api(`/api/trees/${encodeURIComponent(deps.state.currentTreeId)}/switch`, "POST", {
      branchId: trunkId,
    });
    deps.state.treeState = payload.state;
    deps.renderAll();
  }


  /**
   * 锚点揭示（W2 §2.6 + signed v3 §1.2：来源定位与 Pi 游标对齐分离）：
   * status available → 定位 + 一次性脉冲高亮 + 滚动 + 焦点移至锚点 turn——
   * **无论 navigation 成败**（产品定位来自数据库原文，session 缺失/损坏不再
   * 阻断准确高亮）；navigation failed → 如实以面板横幅提示「定位成功但
   * 活动会话未能对准」（后续 prompt 自导航，不受影响）。锚点在主线 → 主
   * 面板内揭示（面板保持打开）；锚点在其他支线 → 打开该支线面板呈现。
   * changed/unavailable → 降级不伪造：摘录仍在面板头部可读，如实报告状态。
   * 降级路径同样先落地服务端返回的 state——徽标 / 降级提示必须与服务端
   * 判定一致（W1 §3.4 如实呈现），绝不能出现「错误说降级、徽标仍
   * available」的矛盾 UI。
   */
  async function revealOrigin(branchId) {
    if (branchId === null || deps.state.currentTreeId === null) return;
    const payload = await deps.api(
      `/api/trees/${encodeURIComponent(deps.state.currentTreeId)}/branches/${encodeURIComponent(branchId)}/source`,
      "POST",
    );
    deps.state.treeState = payload.state;
    deps.state.sourceHighlight = null;
    if (payload.source.status !== "available") {
      deps.renderAll();
      deps.showError(`Source reference ${payload.source.status}; saved excerpt remains available.`, "panel");
      /* 降级焦点（W2 §2.6 键盘焦点行）：焦点移到说明区。取面板头部锚点
         上下文（摘录 + 状态徽标，常驻可读、tabindex=-1 程序聚焦）而非错误
         横幅——横幅 8 秒自动隐藏会连焦点一起丢，锚点上下文才是持久的说明
         区（实现取舍已记入 W2 §2.6 行内，owner 可改判）。 */
      deps.$("panel-anchor-context").focus();
      return;
    }
    deps.state.sourceHighlight = {
      branchId: payload.source.sourceBranchId,
      turnId: payload.source.anchorTurnId,
      start: payload.source.selection.start,
      end: payload.source.selection.end,
    };
    const navigation = payload.source.navigation ?? null;
    const navigationFailed =
      navigation !== null && navigation.status === "failed"
        ? `${navigation.code}: ${navigation.message}`
        : null;
    if (payload.source.sourceBranchId === deps.trunkBranchId()) {
      deps.renderAll();
      deps.revealAnchorTurn(payload.source.anchorTurnId);
      if (navigationFailed !== null) {
        deps.showError(
          `Source located from the saved database text (highlighted above); aligning the live session failed ` +
            `(${navigationFailed}). Prompts navigate on their own, so continuing is unaffected.`,
          "panel",
        );
      }
      return;
    }
    await openBranchPanel(payload.source.sourceBranchId, {
      alignCursor: false,
      focus: "anchor",
      trigger: { kind: "element", element: deps.$("panel-view-source") },
    });
    deps.revealAnchorTurn(payload.source.anchorTurnId);
    if (navigationFailed !== null) {
      deps.showError(
        `Source located from the saved database text (highlighted); aligning the live session failed ` +
          `(${navigationFailed}). Prompts navigate on their own, so continuing is unaffected.`,
        "panel",
      );
    }
  }


  /**
   * 从某条 assistant turn 建支线（W2 §2.3）：无选区 = 整条答案；选区以
   * 绝对偏移提交（W1 §1.1）。新支线以局部面板打开（主线不动）；建支线
   * 不对齐游标（首次续聊由 prompt 显式导航——与既有行为一致）。
   * ③：选区从注册表取该 turn 的最新元素读取（复用元素跨重渲有效）。
   */
  async function branchFromTurn(turn) {
    const entry = deps.assistantTurns.get(turn.id);
    const selection =
      (entry !== undefined ? deps.selectionOffsetsWithin(entry.element, turn.text) : null) ??
      { start: 0, end: turn.text.length, text: turn.text };
    const payload = await deps.api(
      `/api/trees/${encodeURIComponent(deps.state.currentTreeId)}/branches`,
      "POST",
      {
        sourceBranchId: turn.branchId,
        anchorTurnId: turn.id,
        selection,
      },
    );
    deps.state.treeState = payload.state;
    await openBranchPanel(payload.branch.id, {
      alignCursor: false,
      trigger: { kind: "branch-button", turnId: turn.id },
    });
  }


  /**
   * 恢复动作（issue #3 P1 / W2 §2.8「可直接执行」）：从 session 仍可用的
   * 最新 assistant 答案（findSessionRecoveryAnchor）整条建支线，并以局部
   * 面板打开。不变量：新支线无 run，其续聊点 = origin 锚点 run 的 session
   * 引用（服务端语义），而锚点所在分支视图的 sessionAvailability 为
   * available——故新支线的续聊点按构造可用（面板续聊入口随之启用）。
   * 建支线不对齐游标（与 branchFromTurn 一致：首次续聊由 prompt 显式
   * 导航）。失败按调用面呈现错误横幅（guard）。
   */
  async function branchFromLatestAvailableAnswer() {
    const anchor = deps.findSessionRecoveryAnchor();
    if (anchor === null) return; /* 渲染期已禁用；兜底防竞态 */
    const payload = await deps.api(
      `/api/trees/${encodeURIComponent(deps.state.currentTreeId)}/branches`,
      "POST",
      {
        sourceBranchId: anchor.branchId,
        anchorTurnId: anchor.id,
        selection: { start: 0, end: anchor.text.length, text: anchor.text },
      },
    );
    deps.state.treeState = payload.state;
    /* 用户选择了恢复动作：清除主横幅的 dismiss 记录——横幅此后按当前事实
       呈现（主干仍不可用则如实继续显示），不因旧 dismiss 被压制。 */
    const trunk = deps.trunkBranchId();
    if (trunk !== null) deps.state.dismissedSessionBannerTrunks.delete(trunk);
    await openBranchPanel(payload.branch.id, {
      alignCursor: false,
      trigger: { kind: "main-input" },
    });
  }

  return {
    branchFromTurn,
    openBranchPanel,
    returnToTrunk,
    branchFromLatestAvailableAnswer,
    closePanel,
    revealOrigin,
  };
}
