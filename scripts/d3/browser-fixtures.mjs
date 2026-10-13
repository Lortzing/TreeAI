
/** browser-fixtures original runner scenarios/helpers Instance-owned state and dependencies. */

export function createBrowserFixtures(deps) {

  /* ------------------------------------------------------------------ */
  /* 剧本（与 run-d3-real-pi.mjs 同一 codeword 场景；canary 词为跨支线    */
  /* 上下文串扰探针；echo 答案 = 可见用户文本的精确回声，串扰机械可见）    */
  /* ------------------------------------------------------------------ */

  const SCENARIO = {
    /* 指令要求「逐字短语」——真实模型照办；短语长度保证浏览器面拖选有
       稳定的字符区间（真实模型对 "Reply with: understood." 只回一个词，
       拖选会被钳到整条答案，锚定区间失真）。 */
    t1: "This is the main line, turn one. The trunk topic is apples. Remember the trunk codeword: maple. Reply with exactly: understood — the trunk topic is apples and the codeword is maple.",
    t2: "Main line, turn two. The trunk secret number is 4127. Reply with exactly: noted — the secret number 4127 is registered on the main line.",
    t3: "Main line, turn three. Did any branch return a delivery marker to you? Quote it exactly if so, otherwise reply: none.",
    a1: "We are now on branch A, about avocados. Remember branch A's codeword: cedar. Reply with: ok-a1.",
    a2: "Branch A, turn two. List every codeword and every secret number you can see in this conversation so far, comma-separated, nothing else.",
    b1: "We are now on branch B, about batteries. Remember branch B's codeword: birch. Reply with: ok-b1.",
    b2: "Branch B, turn two. List every codeword and every secret number you can see in this conversation so far, comma-separated, nothing else.",
    returnText:
      "Branch A return note: the agreed delivery marker is aspen. Acknowledge the marker when asked on the main line.",
    fail: "/fail this prompt must converge as a simulated upstream model error",
    recovery: "After the earlier failure, the main line continues. Reply with: back-online.",
    /* 模型错误注入相（real-pi 专属，探针树）：失败轮与恢复轮用同一文本
       ——「上一次失败的同一 prompt 在配置修复 + 重启后成功」即恢复语义
       本身（镜像 run-d3-real-pi.mjs phaseModelError 的 real-pi 分支）。 */
    modelErrorProbe: "Reply with the single word: online.",
  };

  const CANARIES = ["maple", "4127", "cedar", "birch", "aspen"];

  /** 支线拖选的字符子区间（答案内、避开句首句尾标点的稳定窗口）。 */
  const SELECT_A = { from: 24, to: 52 };

  const SELECT_B = { from: 30, to: 61 };

  /* ------------------------------------------------------------------ */
  /* A2 深选区场景文本（issue #6 P1 / W2 §4；镜像 ui-probe 的三个脚本化     */
  /* DOM 场景：LONG_A2 / DUP_A2 / CROSS_A2——这里以「prompt 携带确定性分节   */
  /* 长块」的形态经真实 composer 发送：echo 答案 = 精确回声 → 确定性偏移；   */
  /* real-pi 以逐字复述指令驱动，期望从实际渲染答案动态计算）。              */
  /* ------------------------------------------------------------------ */

  /** 与 ui-probe LONG_A2_PARAGRAPH 同源的节文本（125 字符）。 */
  const DEEP_SECTION_TEXT =
    "lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ";

  const DEEP_INTRO = "A long structured block follows, composed of numbered sections separated by newlines.";

  /** 长答案场景的后段目标短语（块尾行携带；ask 文本绝不含它）。 */
  const DEEP_LATE_PHRASE = "late anchor target phrase";

  /** 重复词场景的故意重复词（第 12/33 节各一次；ask 文本绝不含它）。 */
  const DEEP_DUP_WORD = "alpha";

  /** 跨行场景的换行两侧短语（插在第 20/21 节之间两行的行中/行中）。 */
  const DEEP_CROSS_OPEN = "anchor start:";

  const DEEP_CROSS_CLOSE = "next rendered line";

  /** real-pi 模型方差门槛：答案低于此长度视为逃逸（逐次加硬重试）。 */
  const DEEP_MIN_ANSWER_CHARS = 3000;

  /** 后段选区深度门槛：目标短语出现位置须 ≥ 该比例（ui-probe echo 面 >0.9，
   * real-pi 面放宽到 0.85——模型可能附言，但不得远离尾部）。 */
  const DEEP_LATE_DEPTH = 0.85;

  /** 数千字符分节长块（36 节 × 375 字符节文 ≈ 13k，镜像 LONG_A2 的体量）。 */
  function deepSections({ decorate = null, insertAfter20 = null, closing = "The closing paragraph ends the block." } = {}) {
    const lines = [DEEP_INTRO];
    for (let i = 1; i <= 36; i += 1) {
      let line = `Section ${i}: ${DEEP_SECTION_TEXT.repeat(3)}`;
      if (decorate !== null) line += decorate(i);
      lines.push(line);
      if (i === 20 && insertAfter20 !== null) lines.push(...insertAfter20);
    }
    lines.push(closing);
    return lines.join("\n");
  }

  /** 三场景的确定性长块（互不包含对方的锚点短语——动态定位不串场）。 */
  const DEEP_BLOCKS = {
    long: deepSections({ closing: `The closing paragraph carries the ${DEEP_LATE_PHRASE}.` }),
    duplicate: deepSections({
      decorate: (i) =>
        i === 12 ? ` The marker word for this probe is ${DEEP_DUP_WORD}.` : i === 33 ? ` The marker word returns here: ${DEEP_DUP_WORD}.` : "",
    }),
    crossLine: deepSections({
      insertAfter20: [
        `Cross-line ${DEEP_CROSS_OPEN} the selection opens on this rendered line.`,
        `the selection closes on the ${DEEP_CROSS_CLOSE} after the break.`,
      ],
    }),
  };

  /** real-pi 逐次加硬的复述指令（echo 面恒第 1 条即中）。 */
  const DEEP_ASKS = [
    "Selection probe. Repeat the block below verbatim in your reply, then stop.",
    "Selection probe, second attempt. Repeat the ENTIRE block below verbatim — every line, exactly as written, no summary, no truncation, no added commentary before or after.",
    "Selection probe, final attempt. You must repeat the whole block below character-for-character, from its first line to its last line, with nothing else in your reply.",
  ];

  /** 期望计算：从实际渲染答案动态求目标 {start,end,text}；不满足场景结构
   * （短语缺失/深度不足/出现次数不足/跨行窗口不恰含一个换行）→ ok:false
   * （真实模型方差，如实登记后重试）。 */
  function deepLongExpectation(answerText) {
    const start = answerText.lastIndexOf(DEEP_LATE_PHRASE);
    if (start < 0) return { ok: false, reason: "the late-tail phrase never appeared in the answer" };
    const depth = start / answerText.length;
    if (depth < DEEP_LATE_DEPTH) {
      return { ok: false, reason: `the phrase occurrence sits at depth ${depth.toFixed(3)} (< ${String(DEEP_LATE_DEPTH)} — answer shape escaped)` };
    }
    return { ok: true, start, end: start + DEEP_LATE_PHRASE.length, text: DEEP_LATE_PHRASE, depth };
  }

  function deepDuplicateExpectation(answerText) {
    const word = DEEP_DUP_WORD;
    const first = answerText.indexOf(word);
    const second = first < 0 ? -1 : answerText.indexOf(word, first + word.length);
    if (second < 0) {
      return { ok: false, reason: `the duplicated word appeared ${first < 0 ? "0" : "1"} time(s) in the answer (needs at least 2)` };
    }
    return { ok: true, start: second, end: second + word.length, text: word, first };
  }

  function deepCrossLineExpectation(answerText) {
    const start = answerText.indexOf(DEEP_CROSS_OPEN);
    if (start < 0) return { ok: false, reason: "the cross-line opening phrase never appeared in the answer" };
    const closeAt = answerText.indexOf(DEEP_CROSS_CLOSE, start);
    if (closeAt < 0) return { ok: false, reason: "the cross-line closing phrase never appeared after the opening one" };
    const end = closeAt + DEEP_CROSS_CLOSE.length;
    const text = answerText.slice(start, end);
    const newlines = text.split("\n").length - 1;
    if (newlines !== 1) {
      return { ok: false, reason: `the computed window spans ${String(newlines)} line break(s) (needs exactly 1)` };
    }
    return { ok: true, start, end, text, newlines };
  }

  const CHECK_DEFS = [
    { id: "chrome-boot", modes: deps.MODES },
    { id: "studio-boot", modes: deps.MODES },
    { id: "page-boot", modes: deps.MODES },
    { id: "tree-create", modes: deps.MODES },
    { id: "trunk-main-line", modes: deps.MODES },
    { id: "selection-anchoring", modes: deps.MODES },
    { id: "branch-a-create", modes: deps.MODES },
    { id: "branch-a-followups", modes: deps.MODES },
    { id: "switch-navigation", modes: deps.MODES },
    { id: "branch-b-create", modes: deps.MODES },
    { id: "branch-b-followups", modes: deps.MODES },
    { id: "no-context-bleed", modes: deps.MODES },
    { id: "return-flow", modes: deps.MODES },
    { id: "return-delivery", modes: deps.MODES },
    /* 模型错误收敛在两种模式各有一条确定性注入路径：selftest 经 /fail
       钩子（主树，本清单原位置执行）；real-pi 经错误配置 registry 的
       重启舞步（独立探针树，A2 深选区相之后、工具相引导之前执行）——
       见 main() 的双时序注释与 stepModelErrorRealPi。 */
    { id: "model-error-convergence", modes: deps.MODES },
    { id: "server-restart-recovery", modes: deps.MODES },
    { id: "missing-session-degradation", modes: deps.MODES },
    { id: "new-exploration-flow", modes: deps.MODES },
    {
      id: "response-loss-midstream",
      modes: ["real-pi"],
      notRun: {
        selftest:
          "the echo driver's ~1ms turn delay leaves no deterministic in-flight window for a mid-stream page reload; the server-down-between-prompts half is covered by server-restart-recovery in both modes",
      },
    },
    { id: "a11y-semantics", modes: deps.MODES },
    { id: "narrow-window-layout", modes: deps.MODES },
    { id: "reduced-motion", modes: deps.MODES },
    /* A2 深选区相（issue #6 P1 / W2 §4；双模式，无需工具缝）：每场景一棵
       全新探针树，主剧本树计数不受影响（相末由 selection-deep-cross-line
       核对）。置于主剧本全部检查之后、工具相引导之前——real-pi 下本相
       全程零工具引导（深选区无需工具；工具方差不沾染）。 */
    { id: "selection-deep-long", modes: deps.MODES },
    { id: "selection-deep-duplicate", modes: deps.MODES },
    { id: "selection-deep-cross-line", modes: deps.MODES },
    {
      id: "tool-policy-boot",
      modes: ["real-pi"],
      toolsGate: true,
      notRun: {
        selftest:
          "the browser tool-policy phase needs the real Pi request-time gate booted with --pi-tools read through the studio CLI (--driver pi); the echo driver has no tool executor and --pi-tools is rejected in echo mode — the offline lock-ins are apps/studio/tests/events.test.ts + cli.test.ts and the API-level product-path recording is evidence/d3/real-pi/20260929T124851Z-product-loop-tools.md",
      },
    },
    {
      id: "tool-policy-allow-read",
      modes: ["real-pi"],
      toolsGate: true,
      notRun: {
        selftest: "part of the browser tool-policy phase — see tool-policy-boot (needs --mode real-pi with --pi-tools read)",
      },
    },
    {
      id: "tool-policy-deny-fail-closed",
      modes: ["real-pi"],
      toolsGate: true,
      notRun: {
        selftest: "part of the browser tool-policy phase — see tool-policy-boot (needs --mode real-pi with --pi-tools read)",
      },
    },
    {
      id: "tool-policy-deny-provenance",
      modes: ["real-pi"],
      toolsGate: true,
      notRun: {
        selftest: "part of the browser tool-policy phase — see tool-policy-boot (needs --mode real-pi with --pi-tools read)",
      },
    },
    {
      id: "tool-policy-canary-never-read",
      modes: ["real-pi"],
      toolsGate: true,
      notRun: {
        selftest: "part of the browser tool-policy phase — see tool-policy-boot (needs --mode real-pi with --pi-tools read)",
      },
    },
    { id: "console-clean", modes: deps.MODES },
  ];

  return {
    CHECK_DEFS,
    SCENARIO,
    DEEP_ASKS,
    DEEP_MIN_ANSWER_CHARS,
    DEEP_BLOCKS,
    deepLongExpectation,
    DEEP_LATE_PHRASE,
    deepDuplicateExpectation,
    DEEP_DUP_WORD,
    deepCrossLineExpectation,
    SELECT_A,
    SELECT_B,
  };
}
