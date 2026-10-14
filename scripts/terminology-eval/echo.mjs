
/** Terminology evaluator echo with unchanged denominator and gates Instance-owned state and dependencies. */

export function createEvalEcho(deps) {

  /* ---------------- 受控假 provider（echo 模式提取任务；测试同款注入机制） ---------------- */

  /**
   * 脚本化术语 runtime（与 apps/studio/tests/terminology.test.ts 的
   * scriptedTerminologyRuntime 同形）：createSession 恒成功，prompt 按
   * answerFor 脚本回答。零真实调用。
   */
  function scriptedTerminologyRuntime(answerFor) {
    const reference = () => ({
      sessionId: "term-eval-scripted",
      sessionFile: "/nonexistent/term-eval-scripted.jsonl",
      entryId: "entry-scripted",
      piVersion: "0.85.1",
      availability: { status: "available" },
    });
    const delay = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
    return {
      get piVersion() {
        return "0.85.1";
      },
      createSession() {
        return Promise.resolve({ reference: reference() });
      },
      restoreSession() {
        return Promise.resolve({ reference: reference() });
      },
      async prompt(input) {
        await delay(1);
        return { message: answerFor(input.text), reference: reference() };
      },
      steer() {
        return Promise.resolve();
      },
      abort() {
        return Promise.resolve();
      },
      navigateTree() {
        return Promise.resolve(reference());
      },
      subscribe() {
        return () => undefined;
      },
      dispose() {
        return Promise.resolve();
      },
    };
  }

  const EXTRACT_PROMPT_MARKER = "Reply with ONLY a JSON array";

  const PASSAGE_MARKER = "[Passage]\n";

  /**
   * 受控假 provider 的提取回答（确定性瑕疵注入——验证指标计算与机械校验能
   * 处理非完美输出；绝不是模型质量证据）：
   * - 候选 = expectedTerms 的机械首现解析（不读取任何存储偏移）；
   * - index%7===3 漏标末词（recall <1）；
   * - index%20===5 命中一个 negativeTerm（mislabel >0 但远低于门禁）；
   * - index%11===2 注入偏移错位条目（validateCandidates 应剔除）；
   * - index%5===1 前后噪声（parseCandidates 容忍）。
   */
  function makeControlledEchoAnswer(itemsByPassage) {
    return (promptText) => {
      if (!promptText.includes(EXTRACT_PROMPT_MARKER)) {
        return `echo:[${promptText}]`;
      }
      const at = promptText.indexOf(PASSAGE_MARKER);
      const passage = at >= 0 ? promptText.slice(at + PASSAGE_MARKER.length) : "";
      const entry = itemsByPassage.get(passage);
      if (entry === undefined) {
        return "[]";
      }
      const { item, index } = entry;
      const entries = [];
      for (const term of item.expectedTerms ?? []) {
        const at2 = passage.indexOf(term);
        if (at2 >= 0) entries.push({ term, start: at2, end: at2 + term.length });
      }
      if (index % 7 === 3 && entries.length > 1) entries.pop();
      if (index % 20 === 5 && (item.negativeTerms ?? []).length > 0) {
        const term = item.negativeTerms[0];
        const at2 = passage.indexOf(term);
        if (at2 >= 0) entries.push({ term, start: at2, end: at2 + term.length });
      }
      if (index % 11 === 2) entries.push({ term: "echo-misaligned", start: 0, end: 3 });
      const json = JSON.stringify(entries);
      return index % 5 === 1 ? `Sure! ${json} hope that helps` : json;
    };
  }

  /** baseline provider 的提取回答：对提示词内嵌原文跑零依赖基线（离线确定性）。 */
  function makeBaselineAnswer(extractCandidatesFn) {
    return (promptText) => {
      if (!promptText.includes(EXTRACT_PROMPT_MARKER)) {
        return `echo:[${promptText}]`;
      }
      const at = promptText.indexOf(PASSAGE_MARKER);
      const passage = at >= 0 ? promptText.slice(at + PASSAGE_MARKER.length) : "";
      const candidates = extractCandidatesFn(passage).map((c) => ({ term: c.term, start: c.start, end: c.end }));
      return JSON.stringify(candidates);
    };
  }

  /* ---------------- echo 模式自检（合成输入验证指标/门禁/基线/扫描） ---------------- */

  async function runEchoSelfcheck(baselineModule) {
    const checks = [];
    const push = (name, ok, detail) => checks.push({ name, status: ok ? "PASS" : "FAIL", detail });

    /* 指标数学：合成提取行（与真实行同形：candidates 为 {term,start,end} 对象）。 */
    const syntheticExtractRows = [
      {
        status: "succeeded", latencyMs: 10, usage: { requests: 1, promptChars: 100, completionChars: 40 },
        expectedTerms: ["甲", "乙", "丙"], negativeTerms: ["丁", "戊"],
        candidates: [
          { term: "甲", start: 0, end: 1 },
          { term: "丁", start: 5, end: 6 },
          { term: "未列词", start: 9, end: 12 },
        ],
      },
      {
        status: "succeeded", latencyMs: 20, usage: { requests: 1, promptChars: 80, completionChars: 30 },
        expectedTerms: ["己"], negativeTerms: ["庚"], candidates: [{ term: "庚", start: 0, end: 1 }],
      },
    ];
    const extractMetrics = deps.computeExtractMetrics(syntheticExtractRows);
    push(
      "selftest:extract-metrics",
      extractMetrics.expectedFound === 1 &&
        extractMetrics.expectedTotal === 4 &&
        extractMetrics.recall === 0.25 &&
        extractMetrics.precision === 0.25 &&
        extractMetrics.negativeTermsHit === 2 &&
        extractMetrics.negativeTermsTotal === 3 &&
        Math.abs(extractMetrics.mislabelRate - 2 / 3) < 1e-12 &&
        extractMetrics.extraTerms === 1 &&
        extractMetrics.fullNegativeItemsWithMarks === 0,
      `recall 1/4, precision 1/4, mislabel 2/3, extras 1 (got ${String(extractMetrics.expectedFound)}/${String(extractMetrics.expectedTotal)}, ` +
        `${String(extractMetrics.expectedFound)}/${String(extractMetrics.markedTotal)}, ${String(extractMetrics.negativeTermsHit)}/${String(extractMetrics.negativeTermsTotal)}, ${String(extractMetrics.extraTerms)})`,
    );

    /* 指标数学：合成解释行（一条来源匹配失败 → 门禁应 FAIL）。 */
    const syntheticExplainRows = [
      { status: "succeeded", latencyMs: 5, usage: { requests: 1, promptChars: 50, completionChars: 20 }, sourceMatch: true, explanation: "ok" },
      { status: "succeeded", latencyMs: 15, usage: { requests: 1, promptChars: 60, completionChars: 20 }, sourceMatch: false, explanation: "ok" },
    ];
    const explainMetrics = deps.computeExplainMetrics(syntheticExplainRows);
    push(
      "selftest:explain-metrics",
      explainMetrics.sourceMatchOk === 1 && explainMetrics.ran === 2 && explainMetrics.sourceMatchRate === 0.5,
      `source match 1/2 = 50% (gate must FAIL below 100%)`,
    );
    const syntheticGates = deps.evaluateGates({
      mode: "real",
      provider: "x",
      explain: explainMetrics,
      extract: extractMetrics,
      pipelineIntegrity: { ok: true, detail: "synthetic" },
    });
    const sourceMatchGate = syntheticGates.find((g) => g.name === "explain-source-match");
    const mislabelGate = syntheticGates.find((g) => g.name === "extract-negative-mislabel");
    push(
      "selftest:gate-flip",
      sourceMatchGate.status === "FAIL" && mislabelGate.status === "FAIL" && sourceMatchGate.binding && mislabelGate.binding,
      "binding quality gates flip to FAIL on synthetic violations (50% source match; 66.7% mislabel)",
    );
    const baselineGates = deps.evaluateGates({
      mode: "echo",
      provider: "baseline",
      explain: explainMetrics,
      extract: extractMetrics,
      pipelineIntegrity: { ok: true, detail: "synthetic" },
    });
    push(
      "selftest:baseline-nonbinding",
      baselineGates.find((g) => g.name === "explain-source-match").binding === false,
      "baseline provider quality gates are reported-only (weak baseline is expected, not a runner defect)",
    );

    /* 词序数定位。 */
    const nth = deps.nthOccurrence("bank is a river bank; bank again", "bank", 3);
    push(
      "selftest:nth-occurrence",
      nth !== null && nth.start === 22 && "bank is a river bank; bank again".slice(nth.start, nth.end) === "bank",
      `3rd occurrence resolves at ${String(nth?.start)} with slice equality`,
    );

    /* frozen 锁判定。 */
    const locked = deps.isFrozenVerdictLocked(
      [
        { mode: "echo", set: "frozen", executed: true, setHash: "h1" },
        { mode: "real", set: "frozen", executed: true, observe: true, setHash: "h1" },
        { mode: "real", set: "dev", executed: true, setHash: "h1" },
      ],
      "h1",
    );
    push(
      "selftest:frozen-lock",
      locked === null,
      "echo runs, observe-only real runs and dev runs never lock the frozen verdict",
    );
    const locked2 = deps.isFrozenVerdictLocked([{ mode: "real", set: "frozen", executed: true, setHash: "h1" }], "h1");
    push("selftest:frozen-lock-2", locked2 !== null, "an executed real frozen run with matching set hash locks the verdict");

    /* 密钥扫描。 */
    push(
      "selftest:secret-scan",
      deps.containsSecret(JSON.stringify({ a: "prefix-SECRET-VALUE suffix" }), "SECRET-VALUE") &&
        !deps.containsSecret(JSON.stringify({ a: "clean" }), "SECRET-VALUE"),
      "secret values are detected in serialized reports",
    );

    /* 基线：确定性 + 自检。 */
    if (baselineModule !== null) {
      const baselineChecks = baselineModule.baselineSelfcheck();
      for (const check of baselineChecks) {
        push(`baseline:${check.name}`, check.pass, check.detail);
      }
      const sample =
        "免疫保护有个人差异：有人演习后兵力旺盛。当接种的人足够多，病毒在人与人之间传递的链条被打断，" +
        "不能接种的人也间接得到了保护。这个现象叫群体免疫。群体免疫是疫苗给社会的红利。";
      const once = JSON.stringify(baselineModule.extractCandidates(sample));
      const again = JSON.stringify(baselineModule.extractCandidates(sample));
      push("baseline:determinism-set-item", once === again, "same set-style input twice -> byte-equal output");
    }
    return checks;
  }

  return {
    runEchoSelfcheck,
    scriptedTerminologyRuntime,
    makeControlledEchoAnswer,
    makeBaselineAnswer,
  };
}
