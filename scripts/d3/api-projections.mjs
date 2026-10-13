import { existsSync, readFileSync } from "node:fs";
/** api-projections original runner scenarios/helpers Instance-owned state and dependencies. */

export function createApiProjections(deps) {

  function treePath(action) {
    return `/api/trees/${encodeURIComponent(deps.sc.treeId)}${action === undefined ? "" : `/${action}`}`;
  }

  function branchView(state, branchId) {
    const view = state?.branches?.find((candidate) => candidate.branch.id === branchId);
    deps.assert(view !== undefined, `state has no branch view for ${branchId}`);
    return view;
  }

  async function fetchState() {
    const res = await deps.api(deps.sc.port, "GET", treePath("state"));
    deps.assert(res.status === 200, `GET state failed: ${deps.errDetail(res)}`);
    return res.body;
  }

  function turnCount(state, branchId) {
    return branchView(state, branchId).turns.length;
  }

  function returnTurns(state) {
    return branchView(state, deps.sc.trunkId).turns.filter((turn) => turn.role === "return");
  }

  /** 成功 prompt 助手：200 + run succeeded + 非空回答；登记 runId。 */
  async function promptOk(branchId, text) {
    const res = await deps.api(deps.sc.port, "POST", treePath("prompt"), { branchId, text }, deps.CLI.promptTimeoutMs);
    deps.assert(res.status === 200, `prompt HTTP ${String(res.status)}: ${deps.errDetail(res)}`);
    const outcome = res.body?.outcome;
    deps.assert(outcome !== undefined && outcome !== null, "prompt response has no outcome");
    deps.assert(outcome.run?.state === "succeeded", `run state is ${String(outcome.run?.state)} (expected succeeded)`);
    deps.assert(
      typeof outcome.assistantTurn?.text === "string" && outcome.assistantTurn.text.trim().length > 0,
      "assistant message is empty",
    );
    deps.sc.runIds.add(outcome.run.id);
    return res.body;
  }

  /* ---------------- A5 探针树助手（独立于主剧本树） ---------------- */

  /** A5 探针树的 API 路径。 */
  function tpPath(action) {
    const tp = deps.sc.toolPolicy;
    deps.assert(tp !== null && tp.treeId !== null, "scenario wiring: A5 probe tree missing (see A5-product-tool-policy)");
    return `/api/trees/${encodeURIComponent(tp.treeId)}${action === undefined ? "" : `/${action}`}`;
  }

  /** A5 探针树的状态读取。 */
  async function tpFetchState() {
    const res = await deps.api(deps.sc.port, "GET", tpPath("state"));
    deps.assert(res.status === 200, `GET state failed: ${deps.errDetail(res)}`);
    return res.body;
  }

  /** echo 模式的精确回声断言（echo 答案即分支隔离的机械证明）。 */
  function assertEchoMode(actual, expected, what) {
    if (deps.MODE !== "echo-selftest") return;
    deps.assert(
      actual === expected,
      `${what}: echo mismatch\n    expected: ${deps.truncate(expected, 240)}\n    actual:   ${deps.truncate(actual, 240)}`,
    );
  }

  function assertContainsMarkers(text, needles, what) {
    for (const needle of needles) {
      deps.assert(deps.containsIgnoreCase(text, needle), `${what}: expected to mention '${needle}' (got: ${deps.truncate(text, 200)})`);
    }
  }

  function assertAbsentMarkers(text, needles, what) {
    for (const needle of needles) {
      deps.assert(!deps.containsIgnoreCase(text, needle), `${what}: must NOT mention '${needle}' — context bleed signal (got: ${deps.truncate(text, 200)})`);
    }
  }

  /** session entry 树的可见性路径（真实模型下列举措辞有方差——浏览器面
   *  跑批器 20260929T161646Z 实测 b2 只回 "birch"，模型行为不构成串扰
   *  证据）：从含 promptNeedle 的用户 entry 沿 parentId 走到根，收集路径
   *  上全部 message 文本。这条链正是 navigateTree 续聊点的完整可见上下文
   *  ——标记词在/不在路径上即上下文可见性的机械证明，与模型措辞无关
   *  （与 run-d3-browser.mjs v1.1.2 同法）。 */
  function sessionEntryPathText(sessionFile, promptNeedle) {
    deps.assert(typeof sessionFile === "string" && sessionFile.length > 0, "scenario wiring: probe prompt carried no session file reference");
    deps.assert(existsSync(sessionFile), "the tree session file does not exist");
    let entries;
    try {
      entries = readFileSync(sessionFile, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line));
    } catch (err) {
      throw new Error(`the tree session file could not be read/parsed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const byId = new Map(entries.filter((e) => typeof e.id === "string").map((e) => [e.id, e]));
    const leaf = entries.find(
      (e) =>
        e.type === "message" &&
        e.message !== null &&
        typeof e.message === "object" &&
        e.message.role === "user" &&
        JSON.stringify(e.message.content ?? "").includes(promptNeedle),
    );
    if (leaf === undefined) {
      throw new Error(`no user entry carrying the ${JSON.stringify(promptNeedle)} prompt found in the tree session file`);
    }
    const texts = [];
    let current = leaf;
    while (current !== undefined) {
      if (current.type === "message" && Array.isArray(current.message?.content)) {
        for (const part of current.message.content) {
          if (typeof part?.text === "string") texts.push(part.text);
        }
      }
      const parent = current.parentId;
      current = typeof parent === "string" ? byId.get(parent) : undefined;
    }
    return texts.join("\n");
  }

  function selectionOf(text) {
    const end = Math.min(16, text.length);
    return { start: 0, end, text: text.slice(0, end) };
  }

  return {
    treePath,
    promptOk,
    assertEchoMode,
    fetchState,
    turnCount,
    selectionOf,
    branchView,
    assertContainsMarkers,
    assertAbsentMarkers,
    sessionEntryPathText,
    returnTurns,
    tpPath,
    tpFetchState,
  };
}
