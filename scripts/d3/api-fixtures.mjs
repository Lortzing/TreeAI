
/** api-fixtures original runner scenarios/helpers Instance-owned state and dependencies. */

export function createApiFixtures(deps) {

  /* ------------------------------------------------------------------ */
  /* 剧本（固定文本；canary 标记词用于真实模型的上下文串扰探针）           */
  /* ------------------------------------------------------------------ */

  const SCENARIO = {
    t1: "This is the main line, turn one. The trunk topic is apples. Remember the trunk codeword: maple. Reply with: understood.",
    t2: "Main line, turn two. The trunk secret number is 4127. Reply with: noted.",
    a1: "We are now on branch A, about avocados. Remember branch A's codeword: cedar. Reply with: ok-a1.",
    a2: "Branch A, turn two. List every codeword and every secret number you can see in this conversation so far, comma-separated, nothing else.",
    b1: "We are now on branch B, about batteries. Remember branch B's codeword: birch. Reply with: ok-b1.",
    b2: "Branch B, turn two. List every codeword and every secret number you can see in this conversation so far, comma-separated, nothing else.",
    returnText:
      "Branch A return note: the agreed delivery marker is aspen. Acknowledge the marker when asked on the main line.",
    returnKey: "d3-real-pi-return-key-1",
    t3: "Back on the main line, turn three. If a return note was delivered to you, reply with its delivery marker word and the trunk codeword, comma-separated.",
    fail: "/fail simulated upstream outage for the deterministic echo hook",
    recoverB: "Branch B again, after the previous error. Reply with: recovered-b.",
    t4: "The host process restarted. Reply with the trunk codeword, the trunk secret number, and any delivered return marker word, comma-separated.",
    abortEssay: "Write a 400-word essay about the history of the bicycle, then stop.",
    abortRecovered: "Reply with the single word: recovered.",
  };

  /** journal/诊断面 canary：这些词绝不允许出现在任何投影 summary 里。 */
  const CANARIES = ["maple", "4127", "cedar", "birch", "aspen"];

  const RUN_ROW_KEYS = ["branchId", "createdAt", "episodeId", "failure", "runId", "state", "terminalAt"];

  const JOURNAL_EVENT_KEYS = ["eventId", "occurredAt", "runId", "seq", "summary", "type"];

  /* ------------------------------------------------------------------ */
  /* 检查清单（id → 适用模式；门控原因逐模式登记）                        */
  /* ------------------------------------------------------------------ */

  const BOTH = deps.MODES;

  const CHECK_DEFS = [
    { id: "studio-boot", modes: BOTH },
    { id: "tree-create", modes: BOTH },
    { id: "trunk-main-line", modes: BOTH },
    { id: "branch-a-create", modes: BOTH },
    { id: "branch-a-followups", modes: BOTH },
    { id: "switch-navigation", modes: BOTH },
    { id: "branch-b-create", modes: BOTH },
    { id: "branch-b-followups", modes: BOTH },
    { id: "no-context-bleed", modes: BOTH },
    { id: "anchor-reveal", modes: BOTH },
    { id: "return-submit", modes: BOTH },
    { id: "return-idempotency", modes: BOTH },
    { id: "return-delivery", modes: BOTH },
    /* 模型错误收敛在两种模式各有一条确定性注入路径：echo 模式经 /fail
       钩子（主树，本清单第 14 项位置执行）；real-pi 模式经错误配置
       registry 的重启舞步（探针树，phaseAbort 之后执行）——见
       phaseModelError 与 main() 的双时序注释。 */
    { id: "model-error-convergence", modes: BOTH },
    {
      id: "A5-product-tool-policy",
      modes: ["real-pi"],
      toolsGate: true,
      notRun: {
        "echo-selftest":
          "the product-path ToolPolicy scenario needs the real Pi request-time gate driven through the studio CLI (--driver pi + --pi-tools read); the echo driver has no tool executor and --pi-tools is rejected in echo mode — the offline lock-in is apps/studio/tests/events.test.ts (request-time policy gate) and the SDK-level real-model half is evidence/d3/real-pi/20260929T105245Z-tool-policy.md",
      },
    },
    {
      id: "A5-product-tool-policy-allow-read",
      modes: ["real-pi"],
      toolsGate: true,
      notRun: {
        "echo-selftest":
          "part of the A5 product tool-policy phase — see A5-product-tool-policy (needs --mode real-pi with --pi-tools read)",
      },
    },
    {
      id: "A5-product-tool-policy-deny-fail-closed",
      modes: ["real-pi"],
      toolsGate: true,
      notRun: {
        "echo-selftest":
          "part of the A5 product tool-policy phase — see A5-product-tool-policy (needs --mode real-pi with --pi-tools read)",
      },
    },
    {
      id: "A5-product-tool-policy-deny-provenance",
      modes: ["real-pi"],
      toolsGate: true,
      notRun: {
        "echo-selftest":
          "part of the A5 product tool-policy phase — see A5-product-tool-policy (needs --mode real-pi with --pi-tools read)",
      },
    },
    {
      id: "A5-product-tool-policy-canary-never-read",
      modes: ["real-pi"],
      toolsGate: true,
      notRun: {
        "echo-selftest":
          "part of the A5 product tool-policy phase — see A5-product-tool-policy (needs --mode real-pi with --pi-tools read)",
      },
    },
    { id: "sse-event-surface", modes: BOTH },
    { id: "diagnostics-projection", modes: BOTH },
    { id: "journal-no-leak", modes: BOTH },
    { id: "restart-persistence", modes: BOTH },
    { id: "new-exploration", modes: BOTH },
    {
      id: "mid-flight-abort",
      modes: ["real-pi"],
      notRun: {
        "echo-selftest":
          "the echo driver's ~1ms turn delay leaves no deterministic in-flight window through the production CLI (no delay flag); abort semantics are covered offline by the studio suite with a widened echo window and run for real in --mode real-pi",
      },
    },
  ];

  return {
    CHECK_DEFS,
    SCENARIO,
    RUN_ROW_KEYS,
    JOURNAL_EVENT_KEYS,
    CANARIES,
  };
}
