
/** browser-deep-selection runner operations with the original shared run state Instance-owned state and dependencies. */

export function createBrowserDeepSelection(deps) {

  /* ------------------------------------------------------------------ */
  /* A2 深选区相（issue #6 P1 / W2 §4；双模式，无需工具缝）。把 ui-probe   */
  /* 的三个脚本化 DOM 场景——数千字符长答案的后段选区（非整条回退）、重复    */
  /* 词**第二处**（绝不允许首处顶替）、跨渲染行选区——抬到真实浏览器操作：    */
  /* 每场景一棵全新探针树（真实 #new-tree 点击，干净 session——主剧本树不受   */
  /* 影响，相末核对计数不变），经真实 composer 产生数千字符答案（echo =      */
  /* 精确回声 → 确定性偏移；real-pi = 逐字复述指令 + 从实际渲染答案动态计算  */
  /* + 逃逸逐次加硬重试），真实鼠标拖选按字符盒精确落位，断言浏览器侧偏移、   */
  /* 面板摘录、服务器 origin.selection、揭示切片四面对齐。                   */
  /* ------------------------------------------------------------------ */

  /** 全新探针树（真实 #new-tree 点击，镜像 tool-policy-boot 的模式：新建即
   *  打开——干净 session；knownIds 差分确保恰好一棵新树）。 */
  async function openDeepProbeTree(label) {
    const treesBefore = await deps.api("GET", "/api/trees");
    deps.assert(treesBefore.status === 200, `GET /api/trees failed: ${String(treesBefore.status)}`);
    const knownIds = new Set((treesBefore.body?.trees ?? []).map((tree) => tree.id));
    await deps.click("#new-tree");
    await deps.waitForJs(
      "document.getElementById('tree-view') !== null && !document.getElementById('tree-view').hidden",
      10_000,
      `${label} probe tree view visible after the new-tree click`,
    );
    const treesAfter = await deps.api("GET", "/api/trees");
    deps.assert(treesAfter.status === 200, `GET /api/trees failed after the ${label} new-tree click: ${String(treesAfter.status)}`);
    const newTrees = (treesAfter.body?.trees ?? []).filter((tree) => !knownIds.has(tree.id));
    deps.assert(newTrees.length === 1, `the ${label} new-tree click created ${String(newTrees.length)} new trees (expected exactly 1)`);
    const treeId = newTrees[0].id;
    const state = await deps.api("GET", `/api/trees/${encodeURIComponent(treeId)}/state`);
    deps.assert(state.status === 200, `${label} probe tree state fetch failed: ${String(state.status)}`);
    const trunkBranchId = state.body?.trunkBranchId;
    deps.assert(typeof trunkBranchId === "string" && trunkBranchId.length > 0, `${label} probe tree state has no trunk branch id`);
    deps.sc.deepSelection.probeTreeIds.push(treeId);
    return { treeId, trunkBranchId };
  }

  /** 探针 prompt → 完成答案 → 动态期望。真实模型方差（答案 <3000 字符、
   *  结构缺失、上游错误）= 逃逸/失败轮：如实登记，逐次加硬指令最多
   *  DEEP_ASKS.length 次尝试，PASS 仅要求其中一次结构成立（镜像工具相的
   *  有界重试纪律；echo 面第 1 条恒中——回声即 prompt 的确定性回放）。
   *  尝试窗口内 expectPageErrors：可重试的 prompt 失败轮（如 502 上游错误）
   *  的页面网络错误按预期不计入 console-clean（结局仍如实登记于 attempts）。 */
  async function deepPromptForAnswer({ label, block, validate }) {
    for (let attempt = 1; attempt <= deps.DEEP_ASKS.length; attempt += 1) {
      await deps.resetErrorSurfaces();
      const assistantBefore = await deps.probeAssistantTurnCount();
      const prompt = `${deps.DEEP_ASKS[attempt - 1]}\n\n${block}`;
      let outcome;
      deps.chrome.expectPageErrors = true;
      try {
        await deps.sendTrunkPrompt(prompt, { keyboard: false });
        outcome = await deps.waitForProbeOutcome(assistantBefore, deps.CLI.promptTimeoutMs);
      } finally {
        deps.chrome.expectPageErrors = false;
      }
      if (outcome.kind === "error") {
        deps.sc.deepSelection.attempts.push({
          scenario: label,
          attempt,
          outcome: `error: ${deps.failureErrorCode(outcome.bannerText, outcome.panelText) ?? deps.truncate(deps.sanitizeText(outcome.bannerText ?? outcome.panelText ?? ""), 80)}`,
        });
        continue;
      }
      const answerText = outcome.text;
      if (typeof answerText !== "string" || answerText.length < deps.DEEP_MIN_ANSWER_CHARS) {
        deps.sc.deepSelection.attempts.push({
          scenario: label,
          attempt,
          outcome: `escape: answer ${typeof answerText === "string" ? `${String(answerText.length)} chars` : "not text"} (< ${String(deps.DEEP_MIN_ANSWER_CHARS)})`,
        });
        continue;
      }
      const expectation = validate(answerText);
      if (expectation.ok !== true) {
        deps.sc.deepSelection.attempts.push({ scenario: label, attempt, outcome: `escape: ${expectation.reason}` });
        continue;
      }
      return { prompt, answerText, expectation, attempt };
    }
    deps.assert(
      false,
      `the ${label} probe did not produce a structurally valid answer in ${String(deps.DEEP_ASKS.length)} attempts: ${JSON.stringify(deps.sc.deepSelection.attempts)}`,
    );
  }

  /** 最后一条已完成 assistant 回合的稳定选择器（等流式占位清除后按
   *  data-turn-id 取——跨重渲稳定；重试轮下此即被验证的那条答案）。 */
  async function deepLastAnswerSelector() {
    await deps.waitForJs(
      "document.getElementById('streaming-turn') === null",
      5_000,
      "streaming placeholder cleared before the deep-selection drag",
    );
    const turnId = await deps.evalJs(
      "(() => { const turns = [...document.querySelectorAll('#conversation .turn.assistant:not(#streaming-turn)')]; " +
        "return turns.length === 0 ? null : turns[turns.length - 1].dataset.turnId ?? null; })()",
    );
    deps.assert(turnId !== null, "no completed assistant answer found in the probe tree trunk");
    return { selector: `#conversation .turn.assistant[data-turn-id="${turnId}"]`, turnId };
  }

  /** 页面侧选区事实：武装态 + 原生选区的绝对偏移（复刻 app.js
   *  selectionOffsetsWithin 的前缀长度数学——这正是 .branch-here 点击时
   *  将提交的 {start,end,text}）；携带选区原文/矩形计数与滚动容器实况
   * （失败时的取证面——镜像 waitForAnswerMarkers 的超时诊断纪律）。 */
  function deepSelectionStateExpression(selector) {
    return `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (el === null) return null;
      const button = el.querySelector('.branch-here');
      const selection = window.getSelection();
      let offsets = null;
      if (selection !== null && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        if (el.contains(range.commonAncestorContainer)) {
          const selected = range.toString();
          if (selected.length > 0) {
            const before = range.cloneRange();
            before.selectNodeContents(el);
            before.setEnd(range.startContainer, range.startOffset);
            const start = before.toString().length;
            if (el.dataset.turnText.slice(start, start + selected.length) === selected) {
              offsets = { start, end: start + selected.length, text: selected };
            }
          }
        }
      }
      let scroller = el.parentElement;
      while (scroller !== null && scroller !== document.body) {
        const cs = getComputedStyle(scroller);
        if (/(auto|scroll|overlay)/.test(cs.overflowY) && scroller.scrollHeight > scroller.clientHeight) break;
        scroller = scroller.parentElement;
      }
      return {
        hasSelection: el.classList.contains('has-selection'),
        buttonText: button === null ? null : button.textContent,
        offsets,
        selectionText: selection === null ? null : String(selection).slice(0, 80),
        selectionRectCount: selection !== null && selection.rangeCount > 0 ? selection.getRangeAt(0).getClientRects().length : 0,
        scroller: scroller === null ? null : { scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight },
        viewport: { innerHeight: window.innerHeight, scrollY: window.scrollY },
      };
    })()`;
  }

  /** 跨行几何证明：原生选区的 client rects（跨渲染行 = 多矩形）+ 选区两端
   *  字符所在渲染行的 top（不同行 = 真实行边界跨越——pre-wrap 下的实况，
   *  非仅字符偏移含换行）。 */
  function deepSelectionGeometryExpression(selector, start, end) {
    return `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      const selection = window.getSelection();
      if (el === null || selection === null || selection.rangeCount === 0) return null;
      const rectCount = selection.getRangeAt(0).getClientRects().length;
      const walker = [];
      for (const node of el.childNodes) {
        if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'BR') break;
        if (node.nodeType === Node.TEXT_NODE) walker.push(node);
        if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'MARK') {
          for (const inner of node.childNodes) if (inner.nodeType === Node.TEXT_NODE) walker.push(inner);
        }
      }
      const charTop = (target) => {
        let acc = 0;
        for (const node of walker) {
          const len = node.textContent.length;
          if (target < acc + len) {
            const range = document.createRange();
            range.setStart(node, target - acc);
            range.setEnd(node, target - acc + 1);
            const boxes = range.getClientRects();
            return boxes.length === 0 ? null : boxes[boxes.length - 1].top;
          }
          acc += len;
        }
        return null;
      };
      return { rectCount, fromTop: charTop(${String(start)}), toTop: charTop(${String(end)} - 1) };
    })()`;
  }

  /** 揭示切片事实（镜像 ui-probe 的 assertRevealSlices 语义）：揭示后的
   *  锚点 turn 渲染为 [前缀文本节点, mark 高亮, 后缀文本节点]——前后缀与
   *  高亮必须恰为 turn 文本按绝对偏移的三段切片（偏移定位的 UI 级证明，
   *  非字符串搜索近似）；焦点移至锚点 turn（tabindex=-1 + anchor-focus）。 */
  function deepRevealSlicesExpression(selector) {
    return `(() => {
      const turn = document.querySelector(${JSON.stringify(selector)});
      if (turn === null) return null;
      const mark = turn.querySelector('.source-highlight');
      if (mark === null) return null;
      const nodes = [...turn.childNodes];
      const markIndex = nodes.indexOf(mark);
      const prefix = markIndex > 0 ? nodes[markIndex - 1] : null;
      const suffix = markIndex >= 0 && markIndex + 1 < nodes.length ? nodes[markIndex + 1] : null;
      return {
        markText: mark.textContent,
        prefixText: prefix !== null && prefix.nodeType === Node.TEXT_NODE ? prefix.data : null,
        suffixText: suffix !== null && suffix.nodeType === Node.TEXT_NODE ? suffix.data : null,
        anchorFocus: turn.classList.contains('anchor-focus'),
        tabindex: turn.getAttribute('tabindex'),
        focused: document.activeElement === turn,
      };
    })()`;
  }

  /** 场景专属断言挂点之后的公共链路：fresh 探针树 → prompt/答案/期望 →
   *  （echo 确定性）→ 服务器 turn 文本对齐 → 真实拖选（字符盒精确落点）→
   *  武装态 + 浏览器侧偏移全等 →（场景几何证明）→ 建支线 → 面板摘录精确
   *  携带 → API 交叉核对 origin.selection 全等 → 揭示切片 → 锚定支线可
   *  续聊（短 follow-up + 标记等待）→ 关面板。 */
  async function runDeepSelectionScenario({ label, block, validate, followUp, selectionAssert = null, echoAssert = null }) {
    const probe = await openDeepProbeTree(label);
    const { prompt, answerText, expectation } = await deepPromptForAnswer({ label, block, validate });
    /* echo 确定性（selftest）：答案 = prompt 的精确回声 → 动态计算即落在
       已知确定位置；场景专属确定性断言（出现次数/体量/深度）由 echoAssert
       补充（镜像 ui-probe 的精确断言语义）。 */
    if (deps.MODE === "selftest") {
      deps.assert(
        answerText === `echo:[${prompt}]`,
        "the echo answer is not the exact prompt echo (the deterministic echo contract is broken — see apps/studio/src/echo-port.ts echoAnswer)",
      );
      if (echoAssert !== null) echoAssert(answerText, prompt);
    }
    /* 服务器权威 turn 文本与渲染一致（动态期望的事实基础两侧对齐）。 */
    const probeState = await deps.api("GET", `/api/trees/${encodeURIComponent(probe.treeId)}/state`);
    deps.assert(probeState.status === 200, `${label} probe tree state fetch failed: ${String(probeState.status)}`);
    const trunkView = (probeState.body?.branches ?? []).find((view) => view.branch.id === probe.trunkBranchId);
    deps.assert(trunkView !== undefined, `${label} probe tree state has no trunk branch view`);
    const serverAnswer = (trunkView.turns ?? []).filter((turn) => turn.role === "assistant").at(-1);
    deps.assert(serverAnswer !== undefined, `${label} probe trunk has no assistant answer server-side`);
    deps.assert(serverAnswer.text === answerText, `${label} rendered answer text disagrees with the server turn text`);

    /* 真实拖选（精确 [from,to) 落点）→ 选区武装 + 浏览器侧偏移与计算目标
       全等（非整条回退/非首处顶替的第一道证明——偏移即目标出现位置）。 */
    const { selector, turnId } = await deepLastAnswerSelector();
    const dragPoints = await deps.dragSelect(selector, expectation.start, expectation.end);
    const selState = await deps.evalJs(deepSelectionStateExpression(selector));
    deps.assert(
      selState !== null && selState.hasSelection === true,
      `${label}: the answer did not enter .has-selection after the real drag; drag points ${JSON.stringify(dragPoints)}; page selection state ${JSON.stringify(selState)}`,
    );
    deps.assert(selState.buttonText === "⑃ Branch from selection", `${label}: branch button text is ${String(selState.buttonText)}`);
    deps.assert(selState.offsets !== null, `${label}: the native selection is empty or not contained in the answer turn`);
    deps.assert(
      selState.offsets.start === expectation.start && selState.offsets.end === expectation.end && selState.offsets.text === expectation.text,
      `${label}: browser-side selection ${JSON.stringify(selState.offsets)} does not equal the computed target ${JSON.stringify({ start: expectation.start, end: expectation.end, text: expectation.text })}`,
    );
    if (selectionAssert !== null) await selectionAssert(selector, answerText, expectation);
    await deps.snap(`${label}-anchor`);

    /* 建支线（真实点击）→ 面板摘录精确携带所选文本。 */
    await deps.click(`${selector} .branch-here`);
    await deps.waitForJs(
      "document.getElementById('branch-panel') !== null && !document.getElementById('branch-panel').hidden",
      10_000,
      `${label} branch panel open`,
    );
    const branchSummary = await deps.snap(`${label}-branch`);
    deps.assert(branchSummary.panel.title === "Branch 1", `${label}: panel title is ${String(branchSummary.panel.title)} (expected "Branch 1")`);
    const anchorCtx = branchSummary.panel.anchorContext ?? "";
    deps.assert(
      anchorCtx.includes(`“${expectation.text}”`),
      `${label}: the panel anchor context does not carry the exact selected excerpt: ${deps.truncate(anchorCtx, 160)}`,
    );

    /* API 交叉核对：服务器 branch 记录的 origin.selection 与浏览器侧全等
       （锚点 {start,end,text} 逐字段；originStatus available）。 */
    const afterState = await deps.api("GET", `/api/trees/${encodeURIComponent(probe.treeId)}/state`);
    deps.assert(afterState.status === 200, `${label}: probe tree state fetch failed after branching: ${String(afterState.status)}`);
    const views = afterState.body?.branches ?? [];
    deps.assert(views.length === 2, `${label}: probe tree has ${String(views.length)} branch views (expected trunk + the anchored branch)`);
    const anchored = views.filter((view) => view.origin !== null && view.origin.anchorTurnId === turnId);
    deps.assert(anchored.length === 1, `${label}: expected exactly one branch anchored on the probed answer turn, found ${String(anchored.length)}`);
    const origin = anchored[0].origin;
    deps.assert(
      origin.selection.start === expectation.start && origin.selection.end === expectation.end && origin.selection.text === expectation.text,
      `${label}: server anchor record ${JSON.stringify(origin.selection)} does not equal the browser-side selection`,
    );
    deps.assert(anchored[0].originStatus === "available", `${label}: anchored branch originStatus is ${String(anchored[0].originStatus)}`);

    /* 揭示（真实点击 ⌖ View source）：高亮按服务端偏移切片——前缀/后缀恰
       切两侧；焦点移至锚点 turn。 */
    await deps.click("#panel-view-source");
    await deps.waitForJs(
      `document.querySelector(${JSON.stringify(`${selector} .source-highlight`)}) !== null`,
      10_000,
      `${label} reveal highlight rendered`,
    );
    const revealed = await deps.evalJs(deepRevealSlicesExpression(selector));
    deps.assert(revealed !== null, `${label}: the revealed turn carries no highlight mark`);
    deps.assert(revealed.markText === expectation.text, `${label}: the highlight is not exactly the anchored selection text`);
    deps.assert(
      revealed.prefixText === answerText.slice(0, expectation.start),
      `${label}: the reveal prefix does not end exactly at the anchor start offset`,
    );
    deps.assert(
      revealed.suffixText === answerText.slice(expectation.end),
      `${label}: the reveal suffix does not resume exactly at the anchor end offset`,
    );
    deps.assert(revealed.anchorFocus === true && revealed.tabindex === "-1", `${label}: the revealed turn lacks the anchor-focus contract`);
    deps.assert(revealed.focused === true, `${label}: focus did not move to the revealed anchor turn`);
    await deps.snap(`${label}-reveal`);

    /* 锚定支线可续聊：一条短 follow-up + 标记等待（echo 面答案 = 支线谱系
       用户文本的精确回声，必含标记；real-pi 依「Reply with exactly」指令）。 */
    await deps.sendPanelPrompt(followUp.prompt, { keyboard: false });
    await deps.waitForAnswerMarkers("#panel-conversation", [followUp.marker], deps.CLI.promptTimeoutMs, 1);
    const panelSummary = await deps.snap(`${label}-followup`);
    deps.assert(
      panelSummary.panelConversation.turns.length === 2,
      `${label}: the anchored branch panel shows ${String(panelSummary.panelConversation.turns.length)} turns (expected 2: follow-up user + assistant)`,
    );
    await deps.click("#panel-close");
    await deps.waitForJs(
      "document.getElementById('branch-panel') === null || document.getElementById('branch-panel').hidden",
      10_000,
      `${label} branch panel closed`,
    );
    return { answerText, expectation, probe, dragPoints };
  }

  /** 场景真实模型方差尝试的如实登记说明（detail 尾注）。 */
  function deepAttemptNote(label) {
    const count = deps.sc.deepSelection.attempts.filter((entry) => entry.scenario === label).length;
    return count === 0 ? "" : `; ${String(count)} earlier model-variance attempt(s) recorded honestly`;
  }

  /** 场景 1（长答案后段，ui-probe LONG_A2 的浏览器面）：数千字符多段答案的
   *  末段短语选区——精确 {start,end,text}，深度 ≥ 门槛（echo 面 >0.9 镜像
   *  ui-probe），anchor.text ≪ 答案长度（非整条回退）。相首落主剧本树基线
   *  （相末由 selection-deep-cross-line 核对不变）。 */
  async function stepSelectionDeepLong() {
    const baseline = await deps.api("GET", `/api/trees/${encodeURIComponent(deps.sc.treeId)}/state`);
    deps.assert(baseline.status === 200, `main tree state fetch failed: ${String(baseline.status)}`);
    const baselineTrunk = (baseline.body?.branches ?? []).find((view) => view.branch.id === baseline.body?.trunkBranchId);
    deps.assert(baselineTrunk !== undefined, "main tree state has no trunk branch view");
    deps.sc.deepSelection.mainBaseline = {
      branchIds: (baseline.body?.branches ?? []).map((view) => view.branch.id),
      trunkTurnCount: (baselineTrunk.turns ?? []).length,
    };
    const { answerText, expectation, dragPoints } = await runDeepSelectionScenario({
      label: "selection-deep-long",
      block: deps.DEEP_BLOCKS.long,
      validate: deps.deepLongExpectation,
      followUp: {
        prompt: "Follow-up on the deep-anchored branch. Reply with exactly: deep-long-branch-live.",
        marker: "deep-long-branch-live",
      },
      echoAssert: (echoAnswer) => {
        deps.assert(echoAnswer.length > 5000, "the echo answer is not multi-thousand-character (ui-probe parity: >5000)");
        const start = echoAnswer.lastIndexOf(deps.DEEP_LATE_PHRASE);
        deps.assert(start > echoAnswer.length * 0.9, "the selection does not sit in the late tail of the echo answer (ui-probe parity: depth >0.9)");
      },
    });
    deps.assert(
      expectation.end - expectation.start < answerText.length && expectation.start > 0,
      "the anchored excerpt covers the whole answer (the whole-answer fallback must not trigger)",
    );
    /* 长答案下的滚动实况（产品布局发现，如实随 detail 登记由 owner 裁决）：
       本产品该体量下滚动发生在文档层（#conversation 内部滚动容器不启用），
       阅读位置记忆/贴底跟随等以 #conversation 滚动为前提的语义随之失效。 */
    const scrollNote =
      dragPoints.scrolledBy === "document"
        ? "; layout note: at this answer length the page scrolls at the document level (#conversation's internal scroller stays inactive — reading-position memory and stick-to-bottom bind to it; product finding, owner to rule)"
        : "";
    return {
      detail:
        `late-tail selection on a ${String(answerText.length)}-char answer anchored at exact offsets ${String(expectation.start)}–${String(expectation.end)} ` +
        `(depth ${expectation.depth.toFixed(3)}, excerpt ${String(expectation.text.length)} chars ≪ answer — no whole-answer fallback): ` +
        "browser selection === panel excerpt === server origin.selection; reveal slices exact; anchored branch conversable" +
        scrollNote +
        deepAttemptNote("selection-deep-long"),
    };
  }

  /** 场景 2（重复词第二处，ui-probe DUP_A2 的浏览器面）：同一词两次出现，
   *  选**第二处**——提交偏移即第二处位置（首处在 first，绝不许首处字符串
   *  匹配顶替）；揭示前缀恰切到第二处之前（首处顶替会使前缀短得多）。 */
  async function stepSelectionDeepDuplicate() {
    const { expectation } = await runDeepSelectionScenario({
      label: "selection-deep-duplicate",
      block: deps.DEEP_BLOCKS.duplicate,
      validate: deps.deepDuplicateExpectation,
      followUp: {
        prompt: "Follow-up on the second-occurrence branch. Reply with exactly: deep-dup-branch-live.",
        marker: "deep-dup-branch-live",
      },
      echoAssert: (echoAnswer) => {
        const occurrences = echoAnswer.split(deps.DEEP_DUP_WORD).length - 1;
        deps.assert(
          occurrences === 2,
          `the echo answer carries ${String(occurrences)} occurrences of the duplicated word (expected exactly 2 at the two known positions)`,
        );
      },
    });
    deps.assert(expectation.start !== expectation.first, "the anchor offset collapsed onto the FIRST occurrence (first-match substitution)");
    return {
      detail:
        `second occurrence of "${deps.DEEP_DUP_WORD}" anchored at exact offsets ${String(expectation.start)}–${String(expectation.end)} ` +
        `(first occurrence at ${String(expectation.first)} — no first-match substitution): ` +
        "browser selection === panel excerpt === server origin.selection; reveal slices exact; anchored branch conversable" +
        deepAttemptNote("selection-deep-duplicate"),
    };
  }

  /** 场景 3（跨行选区，ui-probe CROSS_A2 的浏览器面）：选区跨一个换行——
   *  偏移跨换行精确、文本含换行不截断、揭示切片含换行完整；并以真实渲染
   *  几何证明（原生选区多 client rect + 两端字符在不同渲染行）。相末核对
   *  主剧本树计数不变（探针树隔离的机械证明）。 */
  async function stepSelectionDeepCrossLine() {
    const { expectation } = await runDeepSelectionScenario({
      label: "selection-deep-cross-line",
      block: deps.DEEP_BLOCKS.crossLine,
      validate: deps.deepCrossLineExpectation,
      followUp: {
        prompt: "Follow-up on the cross-line branch. Reply with exactly: deep-cross-branch-live.",
        marker: "deep-cross-branch-live",
      },
      selectionAssert: async (selector, scenarioAnswerText, scenarioExpectation) => {
        const geometry = await deps.evalJs(deepSelectionGeometryExpression(selector, scenarioExpectation.start, scenarioExpectation.end));
        deps.assert(geometry !== null, "selection geometry could not be read (cross-line proof)");
        deps.assert(
          geometry.rectCount >= 2,
          `the native selection has ${String(geometry.rectCount)} client rect(s) — expected a multi-line (cross-line) selection`,
        );
        deps.assert(
          geometry.fromTop !== null && geometry.toTop !== null && Math.abs(geometry.fromTop - geometry.toTop) > 5,
          `the drag endpoints sit on the same rendered line (fromTop ${String(geometry?.fromTop)} vs toTop ${String(geometry?.toTop)}) — not a real cross-line drag`,
        );
      },
    });
    deps.assert(
      expectation.text.includes("\n") && (expectation.text.match(/\n/g) ?? []).length === 1,
      "the anchored cross-line excerpt does not carry exactly one intact line break",
    );
    /* 相末核对：主剧本树的分支集与干线回合数跨相不变 + 侧栏树数 = 主树 +
       本相探针树（每场景一棵）。 */
    const after = await deps.api("GET", `/api/trees/${encodeURIComponent(deps.sc.treeId)}/state`);
    deps.assert(after.status === 200, `main tree state fetch failed after the deep-selection phase: ${String(after.status)}`);
    const baseline = deps.sc.deepSelection.mainBaseline;
    deps.assert(baseline !== null, "scenario wiring: the main-tree baseline snapshot is missing (see selection-deep-long)");
    const afterBranchIds = (after.body?.branches ?? []).map((view) => view.branch.id);
    deps.assert(
      JSON.stringify(afterBranchIds) === JSON.stringify(baseline.branchIds),
      `main tree branch set drifted across the deep-selection phase: ${JSON.stringify(baseline.branchIds)} → ${JSON.stringify(afterBranchIds)}`,
    );
    const afterTrunk = (after.body?.branches ?? []).find((view) => view.branch.id === after.body?.trunkBranchId);
    deps.assert(
      (afterTrunk.turns ?? []).length === baseline.trunkTurnCount,
      `main tree trunk turns drifted across the deep-selection phase: ${String(baseline.trunkTurnCount)} → ${String(afterTrunk?.turns?.length ?? -1)}`,
    );
    const sidebarTrees = await deps.evalJs("document.getElementById('tree-list') === null ? null : document.getElementById('tree-list').children.length");
    deps.assert(
      sidebarTrees === 1 + deps.sc.deepSelection.probeTreeIds.length,
      `sidebar tree count is ${String(sidebarTrees)} (expected 1 main + ${String(deps.sc.deepSelection.probeTreeIds.length)} deep-selection probe tree(s))`,
    );
    return {
      detail:
        `cross-line selection anchored at exact offsets ${String(expectation.start)}–${String(expectation.end)} ` +
        `(spans exactly 1 line break, excerpt keeps the newline intact; multi-rect native selection with endpoints on different rendered lines): ` +
        "browser selection === panel excerpt === server origin.selection; reveal slices exact; anchored branch conversable; " +
        `main choreography tree unchanged across the phase (${String(baseline.branchIds.length)} branches / ${String(baseline.trunkTurnCount)} trunk turns before and after)` +
        deepAttemptNote("selection-deep-cross-line"),
    };
  }

  return {
    stepSelectionDeepLong,
    stepSelectionDeepDuplicate,
    stepSelectionDeepCrossLine,
  };
}
