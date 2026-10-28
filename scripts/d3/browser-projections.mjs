import { join } from "node:path";
import { writeFileSync } from "node:fs";
/** browser-projections original runner scenarios/helpers Instance-owned state and dependencies. */

export function createBrowserProjections(deps) {
  const pageProbeCacheName = `__treeaiD3TurnProbe_${Math.random().toString(36).slice(2)}`;

  /** 结构化 DOM 摘要（证据 JSON 的来源；写盘前统一脱敏）。 */
  function pageSummaryExpression() {
    return `(async () => {
      const $ = (id) => document.getElementById(id);
      const visible = (id) => { const el = $(id); return el !== null && !el.hidden && getComputedStyle(el).display !== 'none'; };
      const text = (id) => { const el = $(id); return el === null ? null : el.textContent; };
      const cache = window[${JSON.stringify(pageProbeCacheName)}] ?? (window[${JSON.stringify(pageProbeCacheName)}] = Object.create(null));
      const treeId = document.querySelector('#tree-list button.active')?.dataset.treeId ?? null;
      const tabs = [...document.querySelectorAll('#branch-tabs button')];
      const trunkBranchId = tabs.find((button) => button.classList.contains('active'))?.dataset.branchId ?? null;
      const panelVisible = $('branch-panel') !== null && !$('branch-panel').hidden;
      const panelBranchId = tabs.find((button) => button.classList.contains('panel-open'))?.dataset.branchId ?? null;
      const activeBranchId = panelVisible ? panelBranchId : trunkBranchId;
      const activeContainer = panelVisible ? '#panel-conversation' : '#conversation';
      const cacheKey = (branchId) => treeId === null || branchId === null ? null : String(treeId) + ':' + String(branchId);
      const readPosition = () => {
        const match = /([0-9]+)\\s*\\/\\s*([0-9]+)/.exec(text('round-position') ?? '');
        return match === null ? { index: 0, count: 0 } : { index: Number(match[1]), count: Number(match[2]) };
      };
      const readTurns = (containerId, roundIndex) => [...document.querySelectorAll(containerId + ' .turn:not(#streaming-turn)')].map((turn) => ({
        role: turn.classList.contains('user') ? 'user' : turn.classList.contains('assistant') ? 'assistant' : 'return',
        turnId: turn.dataset.turnId ?? null,
        text: turn.dataset.turnText ?? null,
        roundIndex,
      }));
      const readReturnCards = (roundIndex) => [...document.querySelectorAll('#conversation .turn.return')].map((card, index) => ({
        turnId: card.dataset.turnId ?? null,
        text: card.textContent,
        delivered: card.querySelector('.delivery') !== null && card.querySelector('.delivery').classList.contains('delivered'),
        deliveryText: card.querySelector('.delivery') === null ? null : card.querySelector('.delivery').textContent,
        roundIndex,
        index,
      }));
      const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
      const pager = $('round-navigation');
      const previous = $('round-previous');
      const next = $('round-next');
      const originalPosition = readPosition();
      let scannedRoundCount = originalPosition.count;
      const activeConversation = $(panelVisible ? 'panel-conversation' : 'conversation');
      const originalScrollTop = activeConversation?.scrollTop ?? 0;
      const originalFocus = document.activeElement;
      const key = cacheKey(activeBranchId);
      if (key !== null && activeContainer === (panelVisible ? '#panel-conversation' : '#conversation')) {
        const turns = new Map();
        const returnCards = new Map();
        const addPage = (roundIndex) => {
          readTurns(activeContainer, roundIndex).forEach((turn, index) => turns.set(turn.turnId ?? [roundIndex, 'turn', index].join(':'), turn));
          readReturnCards(roundIndex).forEach((card) => returnCards.set(card.turnId ?? [roundIndex, 'return', card.index].join(':'), card));
        };
        const selectionActive = (window.getSelection()?.toString() ?? "").length > 0;
        let complete = pager !== null && !pager.hidden && previous !== null && next !== null && !selectionActive;
        if (complete && originalPosition.count > 0) {
          while (!previous.disabled) {
            previous.click();
            await settle();
          }
          let roundIndex = Math.max(0, readPosition().index - 1);
          for (;;) {
            addPage(roundIndex);
            if (next.disabled) break;
            next.click();
            await settle();
            roundIndex = Math.max(0, readPosition().index - 1);
          }
          scannedRoundCount = readPosition().count;
          const targetPosition = Math.min(originalPosition.index, scannedRoundCount);
          while (readPosition().index < targetPosition && !next.disabled) {
            next.click();
            await settle();
          }
          while (readPosition().index > targetPosition && !previous.disabled) {
            previous.click();
            await settle();
          }
          if (activeConversation !== null) activeConversation.scrollTop = originalScrollTop;
          if (originalFocus !== document.body && originalFocus?.isConnected && document.activeElement !== originalFocus) {
            originalFocus.focus({ preventScroll: true });
          }
        } else if (complete) {
          complete = true;
        } else if (selectionActive || originalPosition.count <= 1) {
          addPage(Math.max(0, originalPosition.index - 1));
        }
        if (complete) {
          cache[key] = {
            turns: [...turns.values()],
            returnCards: [...returnCards.values()],
            roundCount: scannedRoundCount,
            currentRoundIndex: Math.min(originalPosition.index, scannedRoundCount),
            complete: true,
          };
        } else if (cache[key] === undefined) {
          cache[key] = {
            turns: [...turns.values()],
            returnCards: [...returnCards.values()],
            roundCount: originalPosition.count,
            currentRoundIndex: originalPosition.index,
            complete: false,
          };
        }
      }
      const entryFor = (branchId) => {
        const entryKey = cacheKey(branchId);
        return entryKey === null ? null : cache[entryKey] ?? null;
      };
      const trunkEntry = entryFor(trunkBranchId);
      const panelEntry = entryFor(panelBranchId);
      const activeTab = tabs.find((el) => el.classList.contains('panel-open')) ?? tabs.find((el) => el.classList.contains('active'));
      return {
        url: location.pathname,
        readyState: document.readyState,
        treeId,
        activeElementId: document.activeElement === null ? null : document.activeElement.id,
        activePagerContainer: activeContainer,
        sidebar: { toggleExpanded: $('sidebar-toggle') === null ? null : $('sidebar-toggle').getAttribute('aria-expanded'), treeCount: $('tree-list') === null ? 0 : $('tree-list').children.length, driverNote: text('driver-note') },
        main: { emptyStateVisible: visible('empty-state'), treeViewVisible: visible('tree-view'), runStatus: text('run-status'), runDetail: text('run-detail'), abortVisible: visible('abort-run'), failurePanel: { hidden: $('failure-panel') === null ? null : $('failure-panel').hidden, text: text('failure-panel') }, sessionBanner: { hidden: $('session-banner') === null ? null : $('session-banner').hidden, text: text('session-banner') }, errorBanner: { hidden: $('error-banner') === null ? null : $('error-banner').hidden, role: $('error-banner') === null ? null : $('error-banner').getAttribute('role'), text: text('error-banner') } },
        panel: { hidden: $('branch-panel') === null ? null : $('branch-panel').hidden, branchId: panelBranchId, title: text('panel-title'), anchorContext: text('panel-anchor-context'), sessionNote: { hidden: $('panel-session-note') === null ? null : $('panel-session-note').hidden, text: text('panel-session-note') }, errorBanner: { hidden: $('panel-error-banner') === null ? null : $('panel-error-banner').hidden, text: text('panel-error-banner') } },
        conversation: { branchId: trunkBranchId, turns: trunkEntry?.turns ?? [], roundCount: trunkEntry?.roundCount ?? 0, currentRoundIndex: trunkEntry?.currentRoundIndex ?? 0, complete: trunkEntry?.complete ?? false },
        panelConversation: { branchId: panelBranchId, turns: panelEntry?.turns ?? [], roundCount: panelEntry?.roundCount ?? 0, currentRoundIndex: panelEntry?.currentRoundIndex ?? 0, complete: panelEntry?.complete ?? false },
        branchTabs: tabs.map((button) => ({ branchId: button.dataset.branchId ?? null, text: button.textContent, ariaCurrent: button.getAttribute('aria-current'), active: button.classList.contains('active'), panelOpen: button.classList.contains('panel-open') })),
        returnCards: trunkEntry?.returnCards ?? [],
        activeTab: activeTab === undefined ? null : activeTab.textContent,
        drawer: { open: $('source-drawer') !== null && !$('source-drawer').hidden, toggleExpanded: $('source-drawer-toggle') === null ? null : $('source-drawer-toggle').getAttribute('aria-expanded'), text: text('source-drawer') },
        composers: { trunkDisabled: $('prompt-input') === null ? null : $('prompt-input').disabled, panelDisabled: $('panel-prompt-input') === null ? null : $('panel-prompt-input').disabled, returnDisabled: $('return-input') === null ? null : $('return-input').disabled },
      };
    })()`;
  }

  async function snap(label) {
    const summary = await deps.evalJs(pageSummaryExpression());
    const file = join(deps.sc.artifactsDir, `${String(deps.chrome.screenshotSeq + 1).padStart(2, "0")}-${label}.json`);
    writeFileSync(file, `${JSON.stringify(sanitizeSummary(summary), null, 2)}\n`);
    await deps.screenshot(label);
    return summary;
  }

  function sanitizeSummary(summary) {
    return JSON.parse(deps.sanitizeText(JSON.stringify(summary)));
  }

  /** 页面侧等待：该分支视图的第 minAssistantTurns 轮 assistant 答案出现
   * 且包含标记词集合。计数前置条件防「上一个答案已含标记词」的竞态
   * （真实模型可能把 t1/t2 的指令词写进同一句回答）。
   * 只数已完成回合（.turn.assistant 排除 #streaming-turn 流式占位）——
   * 真实模型的答案增量流经占位文本，部分文本可能提前含标记词
   * （20260929T162759Z：b2 答案流式到 "birch" 一词时等待即返回，回合
   * 未完成/未落库，计数断言随即失败，还把后续 tab 点击暴露在 prompt
   * 响应重渲窗口里被吞）。超时诊断附带当前页面事实（末轮答案/输入框
   * 残留/run 状态）。 */
  async function waitForAnswerMarkers(containerSelector, needles, timeoutMs, minAssistantTurns = 1) {
    const deadline = Date.now() + timeoutMs;
    try {
      for (;;) {
        const composerId = containerSelector === "#panel-conversation" ? "panel-prompt-input" : "prompt-input";
        const settled = await deps.evalJs(
          `(() => { const input = document.getElementById(${JSON.stringify(composerId)}); const status = document.getElementById('run-status'); ` +
            "return input !== null && !input.disabled && status !== null && status.classList.contains('idle'); })()",
        );
        if (settled) {
          const summary = await deps.evalJs(pageSummaryExpression());
          if (summary.activePagerContainer === containerSelector) {
            const answers = summary[containerSelector === "#panel-conversation" ? "panelConversation" : "conversation"].turns
              .filter((turn) => turn.role === "assistant");
            const lastAnswer = answers.at(-1)?.text ?? "";
            if (answers.length >= minAssistantTurns && needles.every((needle) => lastAnswer.includes(needle))) return lastAnswer;
          }
        }
        if (Date.now() >= deadline) {
          throw new Error(`timeout (${String(timeoutMs)}ms) waiting for: assistant answer #${String(minAssistantTurns)} containing ${needles.join(",")}`);
        }
        await deps.sleep(80);
      }
    } catch (err) {
      const context = await deps.evalJs(
        `(() => { const turns = [...document.querySelectorAll(${JSON.stringify(containerSelector)} + ' .turn.assistant')]; ` +
        "return JSON.stringify({ lastAnswer: turns.length === 0 ? null : (turns[turns.length - 1].dataset.turnText ?? '').slice(0, 200), " +
        "composerValue: document.getElementById('prompt-input') === null ? null : document.getElementById('prompt-input').value.slice(0, 120), " +
        "runStatus: document.getElementById('run-status') === null ? null : document.getElementById('run-status').textContent, " +
        "banner: document.getElementById('error-banner') === null ? null : document.getElementById('error-banner').textContent.slice(0, 160) }); })()",
      ).catch(() => null);
      /* 服务器侧活性对照：区分「页面 fetch 悬挂」与「服务器悬挂」。 */
      const liveness = await deps.api("GET", "/api/health", undefined, 5_000)
        .then((res) => `health ${String(res.status)}`)
        .catch((e) => `health unreachable (${e instanceof Error ? e.message : String(e)})`);
      const recentNet = deps.chrome.netLog.filter((e) => e.url.includes("/prompt") || e.url.includes("/return") || e.url.includes("/switch")).slice(-8);
      throw new Error(
        `${err instanceof Error ? err.message : String(err)}; page context: ${String(context)}; server liveness: ${liveness}; recent control requests: ${JSON.stringify(recentNet)}`,
      );
    }
  }

  async function sendTrunkPrompt(text, { keyboard = false } = {}) {
    /* replace：失败 prompt 会把文本留在输入框（sendPrompt 仅成功路径清空），
       残留文本 + 追加会把恢复 prompt 拼成 /fail… 前缀——全选覆盖是唯一
       确定性且符合真实用户编辑的路径。 */
    await deps.typeInto("#prompt-input", text, { replace: true });
    if (keyboard) {
      await deps.pressModifierEnter("meta");
    } else {
      await deps.click("#send");
    }
  }

  async function sendPanelPrompt(text, { keyboard = false } = {}) {
    await deps.typeInto("#panel-prompt-input", text, { replace: true });
    if (keyboard) {
      await deps.pressModifierEnter("ctrl");
    } else {
      await deps.click("#panel-send");
    }
  }

  /** 按序号取渲染内 assistant turn 的稳定选择器（data-turn-id 跨重渲稳定；
   *  nth-of-type 会把 user turn 一并计数，这里显式按 .turn.assistant 序）。 */
  async function assistantTurnSelector(container, index) {
    const summary = await deps.evalJs(pageSummaryExpression());
    deps.assert(summary.activePagerContainer === container, `cannot select a turn in inactive pager ${container}`);
    const conversation = container === "#panel-conversation" ? summary.panelConversation : summary.conversation;
    const target = conversation.turns.filter((turn) => turn.role === "assistant")[index];
    deps.assert(target !== undefined && target.turnId !== null, `assistant turn #${String(index)} not found in ${container}`);
    const turnId = await deps.evalJs(
      `(async () => {
        const container = ${JSON.stringify(container)};
        const targetPosition = ${String(target.roundIndex + 1)};
        const position = () => Number((document.getElementById('round-position')?.textContent ?? '').split('/')[0].trim()) || 0;
        const previous = document.getElementById('round-previous');
        const next = document.getElementById('round-next');
        const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
        while (position() < targetPosition && next !== null && !next.disabled) { next.click(); await settle(); }
        while (position() > targetPosition && previous !== null && !previous.disabled) { previous.click(); await settle(); }
        await Promise.race([Promise.all((document.getAnimations?.() ?? []).filter((animation) => animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => {}))), new Promise((resolve) => setTimeout(resolve, 600))]);
        const turn = [...document.querySelectorAll(container + ' .turn.assistant:not(#streaming-turn)')]
          .find((candidate) => candidate.dataset.turnId === ${JSON.stringify(target.turnId)});
        return turn?.dataset.turnId ?? null;
      })()`,
    );
    deps.assert(turnId === target.turnId, `assistant turn #${String(index)} is not visible in its pager round`);
    return `${container} .turn.assistant[data-turn-id="${turnId}"]`;
  }

  /* ------------------------------------------------------------------ */
  /* A5 浏览器面工具策略场景（issue #6 P0-3 浏览器后半；仅 real-pi 且      */
  /* --pi-tools 含 read）。镜像 API 面跑批器 run-d3-real-pi.mjs 的 A5 相，  */
  /* 断言面从 HTTP/SSE 抬到真实浏览器：真实输入事件（composer 打字 + 点击   */
  /* 发送、#new-tree 点击建树、抽屉开关/关闭点击）驱动，断言用户实际看到的   */
  /* 渲染 DOM（回答文本、错误横幅、常驻失败面板、抽屉 Tool activity/journal */
  /* 文本、composer 锁定），并以 HTTP API 交叉核对服务器权威状态。          */
  /*                                                                      */
  /* 场景布局（canary 可证地在所有读取根之外）：                            */
  /*   - 两段式引导：主剧本检查（至 reduced-motion）全程零工具；工具相先    */
  /*     SIGKILL 当前 studio，再以 --pi-tools read 引导重启同一数据目录；   */
  /*   - 全新探针树（真实 #new-tree 点击）：工具面提示走干净 session（镜像  */
  /*     API 跑批器的独立探针树），主树计数不受工具面方差影响；             */
  /*   - 读取根 = studio 横幅报告的生效根（显式 --policy-read-roots 或缺省  */
  /*     收窄 workspace/policy-allowed——横幅是子进程装配的权威事实）；     */
  /*   - marker：首个读取根内（非秘密随机 token 内容）→ allow 对照；        */
  /*   - canary：<data>/workspace/team-notes.txt——模型工作目录之内、所有    */
  /*     读取根之外（真实模型会拒读「工作目录之外」的路径；realpath 两侧    */
  /*     逐根证明）→ overreach；                                           */
  /*   - 受控 agent 目录自横幅解析；canary 内容绝不许进入其下任何文件、      */
  /*     数据目录全树或渲染页面。                                          */
  /* ------------------------------------------------------------------ */

  /** 探针树 API 路径。 */
  function tpPath(action) {
    const tp = deps.sc.toolPolicy;
    deps.assert(tp !== null && tp.probeTreeId !== null, "scenario wiring: tool-policy probe tree missing (see tool-policy-boot)");
    return `/api/trees/${encodeURIComponent(tp.probeTreeId)}${action === undefined ? "" : `/${action}`}`;
  }

  /** 探针树主线分页 DOM 采集到的 assistant 回合数（探针树自动打开在主线视图）。
   * 流式占位（#streaming-turn，瞬态 .turn.assistant 元素）不是已完成回合：
   * 真实模型首录（20260929T160209Z）证明把它计入会让结局检测在占位刚挂载
   * 时就误读「新回答」（空文本）并误判 escape——本函数与 waitForProbeOutcome
   * 只数已完成回合。 */
  async function probeAssistantTurnCount() {
    const summary = await deps.evalJs(pageSummaryExpression());
    return summary.conversation.turns.filter((turn) => turn.role === "assistant").length;
  }

  /** 探针干线回合数：页面侧（#conversation 已完成 .turn 总数——流式占位
   *  #streaming-turn 是瞬态 UI 回显，不是落库回合，policy-denied 断言不得
   *  把它数进去）+ 服务器侧（state 的 trunk turns）——policy-denied 的
   *  「零回合落库」两侧同时核对。 */
  async function probeTurnCounts() {
    const summary = await deps.evalJs(pageSummaryExpression());
    const pageTurns = summary.conversation.turns.length;
    const state = await deps.api("GET", tpPath("state"));
    deps.assert(state.status === 200, `probe tree state fetch failed: ${String(state.status)}`);
    const trunkView = (state.body?.branches ?? []).find((view) => view.branch.id === deps.sc.toolPolicy.probeTrunkId);
    deps.assert(trunkView !== undefined, "probe tree state has no trunk branch view");
    return { page: pageTurns, server: trunkView.turns.length };
  }

  /** 清场上一轮失败呈现（真实用户路径）：常驻失败面板 → 点 Dismiss 收起；
   *  错误横幅 8 秒自动隐藏 → 等待隐藏；composer 解锁后才能注入下一轮。
   *  不清场会让结局检测把上一轮的残留横幅/面板误读为本轮结局。 */
  async function resetErrorSurfaces() {
    const panelVisible = await deps.evalJs(
      "(() => { const p = document.getElementById('failure-panel'); return p !== null && !p.hidden; })()",
    );
    if (panelVisible === true) {
      await deps.click(".failure-panel-dismiss");
      await deps.waitForJs(
        "(() => { const p = document.getElementById('failure-panel'); return p === null || p.hidden; })()",
        5_000,
        "failure panel dismissed before the next attempt",
      );
    }
    await deps.waitForJs(
      "(() => { const b = document.getElementById('error-banner'); return b === null || b.hidden; })()",
      10_000,
      "error banner hidden (8s auto-hide) before the next attempt",
    );
    await deps.waitForJs(
      "(() => { const i = document.getElementById('prompt-input'); return i !== null && i.disabled === false; })()",
      10_000,
      "trunk composer re-enabled before the next attempt",
    );
  }

  /** 失败呈现文本中的错误码（横幅 "code: message"；常驻失败面板
   *  "Run … failed — code: message"——app.js 的 api() 把 code 拼进 message）。 */
  function failureErrorCode(bannerText, panelText) {
    const fromBanner = /^([a-z][a-z-]*):/i.exec(String(bannerText ?? ""));
    if (fromBanner !== null) return fromBanner[1];
    const fromPanel = /failed — ([a-z][a-z-]*):/i.exec(String(panelText ?? ""));
    if (fromPanel !== null) return fromPanel[1];
    return null;
  }

  /**
   * 探针 prompt 的结局检测（页面没有 HTTP 状态可看，结局不可知论）：
   * 轮询直到「新 assistant 回合出现」（成功或逃逸——由调用方看文本是否
   * 携带标记）或「错误横幅/常驻失败面板可见」（失败——文本携带错误码）。
   * 只数已完成回合（.turn.assistant 排除 #streaming-turn 流式占位——真实
   * 模型首录证明占位一挂载就满足「新回合」会把空占位误读为逃逸回答）。
   * 超时附带页面事实与服务器活性对照（镜像 waitForAnswerMarkers 的诊断）。 */
  async function waitForProbeOutcome(assistantBefore, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const pageState = await deps.evalJs(
        `(() => {
          const banner = document.getElementById('error-banner');
          const bannerVisible = banner !== null && !banner.hidden && banner.textContent.length > 0;
          const panel = document.getElementById('failure-panel');
          const panelVisible = panel !== null && !panel.hidden && panel.textContent.length > 0;
          const input = document.getElementById('prompt-input');
          const status = document.getElementById('run-status');
          const turns = [...document.querySelectorAll('#conversation .turn.assistant:not(#streaming-turn)')];
          return {
            bannerVisible,
            bannerText: bannerVisible ? banner.textContent : null,
            panelVisible,
            panelText: panelVisible ? panel.textContent : null,
            assistantCount: turns.length,
            lastAnswer: turns.length === 0 ? null : (turns[turns.length - 1].dataset.turnText ?? turns[turns.length - 1].textContent),
            settled: input !== null && !input.disabled && status !== null && status.classList.contains('idle'),
          };
        })()`,
      );
      if (pageState.bannerVisible === true || pageState.panelVisible === true) {
        return { kind: "error", bannerText: pageState.bannerText, panelText: pageState.panelText };
      }
      if (pageState.settled === true) {
        const summary = await deps.evalJs(pageSummaryExpression());
        const answers = summary.conversation.turns.filter((turn) => turn.role === "assistant");
        if (answers.length > assistantBefore) return { kind: "answer", text: answers.at(-1)?.text ?? null };
      }
      if (Date.now() >= deadline) {
        const context = await deps.evalJs(
          "(() => JSON.stringify({ runStatus: document.getElementById('run-status') === null ? null : document.getElementById('run-status').textContent, " +
            "composerDisabled: document.getElementById('prompt-input') === null ? null : document.getElementById('prompt-input').disabled }))()",
        ).catch(() => null);
        const liveness = await deps.api("GET", "/api/health", undefined, 5_000)
          .then((res) => `health ${String(res.status)}`)
          .catch((e) => `health unreachable (${e instanceof Error ? e.message : String(e)})`);
        throw new Error(
          `probe prompt did not settle within ${String(timeoutMs)}ms (banner ${String(pageState.bannerVisible)}, assistant turns ${String(pageState.assistantCount)}); ` +
            `page context: ${String(context)}; server liveness: ${liveness}`,
        );
      }
      await deps.sleep(150);
    }
  }

  return {
    resetErrorSurfaces,
    probeAssistantTurnCount,
    sendTrunkPrompt,
    waitForProbeOutcome,
    failureErrorCode,
    tpPath,
    snap,
    probeTurnCounts,
    pageSummaryExpression,
    waitForAnswerMarkers,
    sendPanelPrompt,
    sanitizeSummary,
    assistantTurnSelector,
  };
}
