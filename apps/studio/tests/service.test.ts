/**
 * D3 Core MVP 领域核心测试（离线 echo 驱动 + 真实 PiRuntime + 真实 SQLite）。
 *
 * 覆盖任务书要求的完整竖切：
 *  1. 创建/打开 Tree（Trunk 根分支）；
 *  2. Trunk 对话（Turn/Episode/Run 落库，echo 断言上下文）；
 *  3. 从锚定答案选区创建 Branch（选区完整性落库；同一 session 文件内分叉）；
 *  4. 继续分支（分支上下文 = 选区答案之前的 Trunk 上下文 + 分支自身）；
 *  5. 导航回 Trunk（navigateTree 同 session 切换；Trunk 上下文不受分支影响）；
 *  6. 编辑并显式提交 Return（Trunk 落库 + 下一次 Trunk prompt 送入上下文）；
 *  7. 持久化/重载（新进程：新 repo + 新 runtime + 新 service 完整恢复并续聊）。
 * 外加：I6 启动恢复、输入校验与错误路径。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  BranchId,
  PiEntryId,
  PiSessionId,
  PiVersion,
  RunId,
  TreeId,
  TurnId,
} from "@treeai/contracts";
import { EntityNotFoundError, InvalidArgumentError } from "@treeai/persistence";
import type { TreeState } from "../src/service.ts";
import { composePromptText, RunNotActiveError } from "../src/service.ts";
import type { TreeStudioService } from "../src/service.ts";
import { cleanupDir, makeStudioInstance, makeTempDataDir } from "./helpers.ts";
function findBranchView(state: TreeState, branchId: BranchId) {
  const view = state.branches.find((v) => v.branch.id === branchId);
  assert.ok(view !== undefined, `branch view for ${branchId} must exist`);
  return view;
}

/**
 * 等待服务的在途 run 出现（prompt 的同步链在微任务中推进到
 * runtime.prompt 的第一个计时器步进；setImmediate 轮询足以确定性观测）。
 */
async function waitForActiveRun(service: TreeStudioService, treeId: TreeId) {
  for (let i = 0; i < 200; i += 1) {
    const activeRun = service.getTreeDiagnostics(treeId).activeRun;
    if (activeRun !== null) return activeRun;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("active run never appeared in diagnostics");
}

test("full D3 vertical slice: trunk → anchored branch → continue → navigate back → return → reload", async () => {
  const dir = makeTempDataDir();
  try {
    const studio = makeStudioInstance(dir);
    const { service } = studio;

    /* 1. 创建 Tree（自动建 Trunk）。 */
    const created = service.createTree();
    const treeId: TreeId = created.tree.id;
    const trunkId: BranchId = created.trunkBranch.id;
    assert.equal(created.trunkBranch.parentBranchId, null, "trunk is the root branch");
    assert.equal(service.listTrees().length, 1);

    /* 2. Trunk 对话两轮。 */
    const t1 = await service.prompt(treeId, trunkId, "t1-q");
    assert.equal(t1.assistantTurn.text, "echo:[t1-q]");
    assert.equal(t1.run.state, "succeeded");
    assert.equal(t1.userTurn.piEntryId, null);
    assert.ok(t1.assistantTurn.piEntryId !== null, "assistant turns carry the Pi leaf anchor");

    const t2 = await service.prompt(treeId, trunkId, "t2-q");
    assert.equal(t2.assistantTurn.text, "echo:[t1-q|t2-q]");

    let state = service.getTreeState(treeId);
    const trunkView = findBranchView(state, trunkId);
    assert.deepEqual(
      trunkView.turns.map((t) => t.role),
      ["user", "assistant", "user", "assistant"],
    );

    /* 3. 从锚定答案选区创建 Branch（选 t1 答案里的一段）。 */
    const t1Answer = t1.assistantTurn.text; // "echo:[t1-q]"
    const selStart = 6; // "[t1-q]" 内的 "t1-q"（"[" 在 index 5）
    const selEnd = selStart + "t1-q".length;
    const selection = { start: selStart, end: selEnd, text: t1Answer.slice(selStart, selEnd) };
    assert.equal(selection.text, "t1-q");

    const creation = service.createBranchFromSelection(treeId, trunkId, t1.assistantTurn.id, selection);
    const branchId = creation.branch.id;
    assert.equal(creation.branch.parentBranchId, trunkId);
    assert.equal(creation.origin.anchorTurnId, t1.assistantTurn.id);
    assert.equal(creation.origin.anchorEntryId, t1.assistantTurn.piEntryId);
    assert.deepEqual(creation.origin.selection, selection);

    /* 4. 继续分支：上下文 = 选区答案为止的 Trunk（只见 t1）+ 分支自身。 */
    const b1 = await service.prompt(treeId, branchId, "b1-q");
    assert.equal(b1.assistantTurn.text, "echo:[t1-q|b1-q]", "branch sees trunk context up to the anchored answer only");
    assert.notEqual(b1.assistantTurn.text, "echo:[t1-q|t2-q|b1-q]", "branch must NOT see post-anchor trunk turns");

    /* 5. 导航回 Trunk 并继续：Trunk 上下文不受分支影响。 */
    const cursorAfterSwitch = await service.switchBranch(treeId, trunkId);
    assert.equal(cursorAfterSwitch?.branchId, trunkId);
    const t3 = await service.prompt(treeId, trunkId, "t3-q");
    assert.equal(t3.assistantTurn.text, "echo:[t1-q|t2-q|t3-q]", "trunk context is isolated from branch turns");

    /* 同一 Tree 的全部 run 共享一个 session 文件（分叉在会话树内，D2 语义）。 */
    state = service.getTreeState(treeId);
    const sessionFiles = new Set<string>();
    for (const view of state.branches) {
      for (const turn of view.turns) {
        if (turn.runId === null) continue;
        sessionFiles.add(studio.repository.getRun(turn.runId).session.sessionFile);
      }
    }
    assert.equal(sessionFiles.size, 1, "one session file per tree (fork-in-session)");

    /* 6. 编辑并显式提交 Return（记录在 Trunk，含出处；先导航后落库）。 */
    const returnText = `RETURN: use ${selection.text} as the answer`;
    const returnTurn = await service.submitReturn(treeId, branchId, returnText);
    assert.equal(returnTurn.role, "return");
    assert.equal(returnTurn.branchId, trunkId, "the return lands on the Trunk");
    assert.equal(returnTurn.fromBranchId, branchId);
    assert.equal(returnTurn.deliveredRunId, null, "not yet delivered");

    /* 下一次 Trunk prompt 把 return 送入 Pi 上下文（echo 可见）。 */
    const t4 = await service.prompt(treeId, trunkId, "t4-q");
    assert.equal(t4.deliveredReturns, 1);
    assert.ok(
      t4.assistantTurn.text.includes(returnText),
      `trunk echo must contain the delivered return text: ${t4.assistantTurn.text}`,
    );
    assert.ok(t4.assistantTurn.text.includes("t4-q"));

    state = service.getTreeState(treeId);
    const deliveredReturn = findBranchView(state, trunkId).turns.find((t) => t.role === "return");
    assert.ok(deliveredReturn !== undefined);
    assert.equal(deliveredReturn.deliveredRunId, t4.run.id, "delivery is recorded on the return turn");
    assert.deepEqual(
      findBranchView(state, branchId).turns.map((t) => t.role),
      ["user", "assistant"],
      "the branch conversation is unaffected by the return",
    );

    /* 7. 持久化/重载：新 repo + 新 runtime + 新 service，状态完整恢复。 */
    await service.switchBranch(treeId, branchId);
    const stateBeforeReload = service.getTreeState(treeId);
    await studio.shutdown();

    const studio2 = makeStudioInstance(dir);
    const stateAfterReload = studio2.service.getTreeState(treeId);
    assert.deepEqual(stateAfterReload.cursor, stateBeforeReload.cursor, "active branch/cursor survives restart");
    assert.deepEqual(
      stateAfterReload.branches.map((v) => ({
        branch: v.branch,
        origin: v.origin,
        turns: v.turns,
      })),
      stateBeforeReload.branches.map((v) => ({
        branch: v.branch,
        origin: v.origin,
        turns: v.turns,
      })),
      "product state survives a full restart",
    );

    /* 重载后在分支上续聊（restoreSession 恢复路径）。 */
    const b2 = await studio2.service.prompt(treeId, branchId, "b2-q");
    assert.equal(
      b2.assistantTurn.text,
      "echo:[t1-q|b1-q|b2-q]",
      "branch continuation after reload restores the forked context",
    );

    /* 重载后 Trunk 续聊同理。 */
    const t5 = await studio2.service.prompt(treeId, trunkId, "t5-q");
    assert.ok(t5.assistantTurn.text.includes("t5-q"));
    assert.ok(!t5.assistantTurn.text.includes("b1-q"), "trunk still excludes branch turns after reload");
    assert.equal(t5.deliveredReturns, 0, "the return was already delivered and is not re-sent");

    await studio2.shutdown();
  } finally {
    cleanupDir(dir);
  }
});

test("composePromptText prefixes pending returns deterministically", () => {
  const pendingReturn = (id: string, from: string, text: string) =>
    ({
      id,
      treeId: "tree",
      branchId: "trunk",
      episodeId: "ep",
      runId: null,
      role: "return",
      text,
      piEntryId: null,
      fromBranchId: from,
      deliveredRunId: null,
      createdAt: "2026-09-28T00:00:00.000Z",
    }) as Parameters<typeof composePromptText>[0][number];
  assert.equal(composePromptText([], "question"), "question");
  assert.equal(
    composePromptText([pendingReturn("t1", "b_1", "first return"), pendingReturn("t2", "b_2", "second return")], "question"),
    "[Return from branch b_1]\nfirst return\n\n[Return from branch b_2]\nsecond return\n\nquestion",
  );
});

test("branch anchoring is validated (answer role, slice integrity, bounds)", async () => {
  const dir = makeTempDataDir();
  try {
    const studio = makeStudioInstance(dir);
    const { service } = studio;
    const created = service.createTree();
    const t1 = await service.prompt(created.tree.id, created.trunkBranch.id, "hello");

    // 用户 turn 不能作锚点（只有答案可以）。createBranchFromSelection 为同步方法 → assert.throws。
    assert.throws(
      () =>
        service.createBranchFromSelection(created.tree.id, created.trunkBranch.id, t1.userTurn.id, {
          start: 0,
          end: 2,
          text: "he",
        }),
      InvalidArgumentError,
    );
    // 选区文本与偏移不一致（锚点完整性）。
    assert.throws(
      () =>
        service.createBranchFromSelection(created.tree.id, created.trunkBranch.id, t1.assistantTurn.id, {
          start: 0,
          end: 5,
          text: "WRONG",
        }),
      InvalidArgumentError,
    );
    // 越界选区。
    assert.throws(
      () =>
        service.createBranchFromSelection(created.tree.id, created.trunkBranch.id, t1.assistantTurn.id, {
          start: 0,
          end: 9999,
          text: t1.assistantTurn.text.padEnd(9999, "x"),
        }),
      InvalidArgumentError,
    );
    // 未知 turn。
    assert.throws(
      () =>
        service.createBranchFromSelection(created.tree.id, created.trunkBranch.id, "turn-missing" as TurnId, {
          start: 0,
          end: 0,
          text: "",
        }),
      EntityNotFoundError,
    );
    assert.equal(service.getTreeState(created.tree.id).branches.length, 1, "no branch created on failures");
    await studio.shutdown();
  } finally {
    cleanupDir(dir);
  }
});

test("return and prompt validation errors", async () => {
  const dir = makeTempDataDir();
  try {
    const studio = makeStudioInstance(dir);
    const { service } = studio;
    const created = service.createTree();
    const treeId = created.tree.id;
    const trunkId = created.trunkBranch.id;
    await service.prompt(treeId, trunkId, "q1");

    // 空 prompt 文本。
    await assert.rejects(() => service.prompt(treeId, trunkId, "   "), InvalidArgumentError);
    // 未知分支 / 未知树。
    await assert.rejects(
      () => service.prompt(treeId, "branch-missing" as BranchId, "q"),
      EntityNotFoundError,
    );
    await assert.rejects(
      () => service.prompt("tree-missing" as TreeId, trunkId, "q"),
      EntityNotFoundError,
    );
    // Trunk 无 origin，不能提交 return（submitReturn 为 async 方法）。
    await assert.rejects(() => service.submitReturn(treeId, trunkId, "text"), InvalidArgumentError);
    // return 文本不能为空；跨树引用被拒绝。
    const other = service.createTree();
    const t = await service.prompt(other.tree.id, other.trunkBranch.id, "q");
    const branch = service.createBranchFromSelection(other.tree.id, other.trunkBranch.id, t.assistantTurn.id, {
      start: 0,
      end: 2,
      text: t.assistantTurn.text.slice(0, 2),
    });
    await assert.rejects(() => service.submitReturn(other.tree.id, branch.branch.id, "  "), InvalidArgumentError);
    await assert.rejects(
      () => service.submitReturn(treeId, branch.branch.id, "cross-tree"),
      InvalidArgumentError,
    );
    await studio.shutdown();
  } finally {
    cleanupDir(dir);
  }
});

test("startup recovery converges interrupted runs to failed (I6 host-interrupt semantics)", async () => {
  const dir = makeTempDataDir();
  try {
    // 直接用仓储制造一个非终态 run（模拟宿主崩溃残留）。
    const bootstrap = makeStudioInstance(dir);
    const created = bootstrap.service.createTree();
    const episode = bootstrap.repository.createEpisode(created.trunkBranch.id);
    const interrupted = bootstrap.repository.createRun(episode.id, {
      sessionId: "s" as PiSessionId,
      sessionFile: "sessions/never.jsonl",
      entryId: "e" as PiEntryId,
      piVersion: "0.85.1" as PiVersion,
      availability: { status: "available" },
    });
    await bootstrap.shutdown();

    const studio = makeStudioInstance(dir);
    const recovered = studio.repository.getRun(interrupted.id);
    assert.equal(recovered.state, "failed");
    assert.equal(recovered.failure?.code, "unknown");
    assert.deepEqual(recovered.failure?.details, { hostInterrupted: true });
    assert.ok(recovered.terminalAt !== null);
    await studio.shutdown();
  } finally {
    cleanupDir(dir);
  }
});

test("diagnostics read model: safe projection only (no session refs, details, causes, paths)", async () => {
  const dir = makeTempDataDir();
  try {
    const studio = makeStudioInstance(dir);
    const { service, repository } = studio;
    const created = service.createTree();
    const treeId = created.tree.id;
    const trunkId = created.trunkBranch.id;
    await service.prompt(treeId, trunkId, "q1");

    // 制造一个携带敏感 details/cause 的 failed run（上游失败语义）。
    const episode = repository.createEpisode(trunkId);
    const sensitiveRun = repository.createRun(episode.id, {
      sessionId: "session-secret-id" as PiSessionId,
      sessionFile: "/Users/tal/Projects/secret-session.jsonl",
      entryId: "entry-secret" as PiEntryId,
      piVersion: "0.85.1" as PiVersion,
      availability: { status: "available" },
    });
    repository.updateRunState(sensitiveRun.id, "running");
    repository.updateRunState(sensitiveRun.id, "failed", {
      failure: {
        code: "upstream",
        message: "upstream request failed",
        details: { secretPath: "/Users/tal/secret-target.txt", token: "sk-secret" },
        cause: new Error("cause-with-secret"),
      },
    });

    const diagnostics = service.getTreeDiagnostics(treeId);
    assert.equal(diagnostics.treeId, treeId);
    assert.equal(diagnostics.runtimeState, "idle");
    assert.equal(diagnostics.activeRun, null);
    assert.equal(diagnostics.policyDecisions.observed, false);

    // 键集合精确锁定（多一个键即失败：防字段外泄回归）。
    assert.deepEqual(
      Object.keys(diagnostics).sort(),
      ["activeRun", "policyDecisions", "runs", "runtimeState", "treeId"],
    );
    const failed = diagnostics.runs.find((r) => r.runId === sensitiveRun.id);
    assert.ok(failed !== undefined);
    assert.deepEqual(
      Object.keys(failed).sort(),
      ["branchId", "createdAt", "episodeId", "failure", "runId", "state", "terminalAt"],
    );
    assert.equal(failed.state, "failed");
    assert.deepEqual(Object.keys(failed.failure!).sort(), ["code", "message"]);
    assert.equal(failed.failure!.code, "upstream");
    assert.equal(failed.failure!.message, "upstream request failed");
    assert.equal(failed.branchId, trunkId);
    assert.ok(failed.terminalAt !== null);

    const succeeded = diagnostics.runs.find((r) => r.state === "succeeded");
    assert.ok(succeeded !== undefined);
    assert.equal(succeeded.failure, null);
    assert.ok(succeeded.terminalAt !== null);

    // 全文扫描：敏感材料与被排除的字段名一律不得出现。
    const serialized = JSON.stringify(diagnostics);
    for (const forbidden of [
      "session-secret-id",
      "secret-session.jsonl",
      "entry-secret",
      "secretPath",
      "secret-target.txt",
      "sk-secret",
      "cause-with-secret",
      "sessionFile",
      "sessionId",
      "entryId",
      "piVersion",
      "availability",
      "details",
      "cause",
    ]) {
      assert.ok(!serialized.includes(forbidden), `diagnostics must not expose '${forbidden}'`);
    }

    // 未知树 → 404 语义（EntityNotFoundError）。
    assert.throws(() => service.getTreeDiagnostics("tree-missing" as TreeId), EntityNotFoundError);
    await studio.shutdown();
  } finally {
    cleanupDir(dir);
  }
});

test("abort: only the active run of the tree is abortable; user-abort converges to aborted, not failed", async () => {
  const dir = makeTempDataDir();
  try {
    // 拉宽 echo 在途窗口（turnDelayMs），保证 abort 类观测确定性。
    const studio = makeStudioInstance(dir, { echoTurnDelayMs: 25 });
    const { service, repository } = studio;
    const created = service.createTree();
    const treeId = created.tree.id;
    const trunkId = created.trunkBranch.id;

    const t1 = await service.prompt(treeId, trunkId, "q1");
    const priorRunId = t1.run.id;

    /* 校验映射（HTTP 前置）：未知树/run → 404；空 runId/跨树 run → 400；
       非活动 run（已终态）→ RunNotActiveError（409）。 */
    await assert.rejects(() => service.abort("tree-missing" as TreeId, priorRunId), EntityNotFoundError);
    await assert.rejects(() => service.abort(treeId, "run-missing" as RunId), EntityNotFoundError);
    await assert.rejects(() => service.abort(treeId, "" as RunId), InvalidArgumentError);
    await assert.rejects(() => service.abort(treeId, priorRunId), RunNotActiveError);

    const other = service.createTree();
    const otherPrompt = await service.prompt(other.tree.id, other.trunkBranch.id, "q-other");
    await assert.rejects(() => service.abort(treeId, otherPrompt.run.id), InvalidArgumentError);

    /* 在途 prompt：诊断面 streaming + activeRun 定位；abort 后 prompt 以
       user-abort 拒绝，run 单事务收敛 aborted（running → aborting → aborted）。
       拒绝断言先挂接（prompt 在 abort 后随时可能 settle）。 */
    const promptPromise = service.prompt(treeId, trunkId, "please-abort-me");
    const rejectionAssertion = assert.rejects(
      () => promptPromise,
      (err: unknown) => err instanceof Error && (err as { code?: unknown }).code === "user-abort",
    );
    const activeRun = await waitForActiveRun(service, treeId);
    assert.equal(activeRun.branchId, trunkId);
    assert.notEqual(activeRun.runId, priorRunId);

    const during = service.getTreeDiagnostics(treeId);
    assert.equal(during.runtimeState, "streaming");
    assert.deepEqual(during.activeRun, activeRun);

    /* abort() 的同步前缀已置 abortRequested：prompt 收敛前诊断面可观测 aborting。 */
    const abortPromise = service.abort(treeId, activeRun.runId);
    assert.equal(service.getTreeDiagnostics(treeId).runtimeState, "aborting");
    await abortPromise;

    await rejectionAssertion;

    const aborted = repository.getRun(activeRun.runId);
    assert.equal(aborted.state, "aborted");
    assert.equal(aborted.failure, undefined);
    assert.ok(aborted.terminalAt !== null);

    /* 中止不产生 turn；诊断面回到 idle，run 行为 aborted 且无 failure。 */
    assert.deepEqual(
      repository.listTurns(trunkId).map((t) => t.role),
      ["user", "assistant"],
      "the aborted prompt persists no turns",
    );
    const after = service.getTreeDiagnostics(treeId);
    assert.equal(after.runtimeState, "idle");
    assert.equal(after.activeRun, null);
    const abortedView = after.runs.find((r) => r.runId === activeRun.runId);
    assert.ok(abortedView !== undefined);
    assert.equal(abortedView.state, "aborted");
    assert.equal(abortedView.failure, null);

    /* 中止后续聊：会话叶已回位到续聊点，被中止的提问不进入上下文。 */
    const t2 = await service.prompt(treeId, trunkId, "q2");
    assert.equal(t2.assistantTurn.text, "echo:[q1|q2]");
    assert.ok(!t2.assistantTurn.text.includes("please-abort-me"));
    await studio.shutdown();
  } finally {
    cleanupDir(dir);
  }
});



test("concurrent prompt is rejected as a conflict and leaves no phantom run", async () => {
  const dir = makeTempDataDir();
  try {
    const studio = makeStudioInstance(dir, { echoTurnDelayMs: 25 });
    const { service } = studio;
    const created = service.createTree();
    const treeId = created.tree.id;
    const trunkId = created.trunkBranch.id;

    // 服务侧单 prompt 操作锁在同步前缀内置位：紧随其后的第二个 prompt
    // 确定性冲突（TypeError → HTTP 409），且不产生任何写入。
    const first = service.prompt(treeId, trunkId, "first");
    await assert.rejects(() => service.prompt(treeId, trunkId, "second"), TypeError);
    const outcome = await first;
    assert.equal(outcome.assistantTurn.text, "echo:[first]");

    const diagnostics = service.getTreeDiagnostics(treeId);
    assert.equal(diagnostics.runs.length, 1, "the rejected concurrent prompt creates no run");
    assert.equal(diagnostics.runs[0]!.state, "succeeded");
    await studio.shutdown();
  } finally {
    cleanupDir(dir);
  }
});

test("anchor status preserves duplicate and cross-line selections and degrades when source is unavailable", async () => {
  const dir = makeTempDataDir();
  try {
    const studio = makeStudioInstance(dir);
    const { service, repository } = studio;
    const created = service.createTree();
    const answer = await service.prompt(created.tree.id, created.trunkBranch.id, "repeat repeat\nrepeat");
    const text = answer.assistantTurn.text;
    const first = text.indexOf("repeat");
    const last = text.lastIndexOf("repeat");
    assert.ok(first >= 0 && last > first, "echo answer contains duplicate anchor text");

    const duplicateBranch = service.createBranchFromSelection(
      created.tree.id,
      created.trunkBranch.id,
      answer.assistantTurn.id,
      { start: last, end: last + "repeat".length, text: "repeat" },
    );
    const crossLineStart = text.indexOf("repeat\nrepeat");
    assert.ok(crossLineStart >= 0, "echo answer contains a cross-line anchor");
    const crossLineBranch = service.createBranchFromSelection(
      created.tree.id,
      created.trunkBranch.id,
      answer.assistantTurn.id,
      { start: crossLineStart, end: crossLineStart + "repeat\nrepeat".length, text: "repeat\nrepeat" },
    );

    const available = service.getTreeState(created.tree.id);
    assert.equal(available.branches.find((v) => v.branch.id === duplicateBranch.branch.id)?.originStatus, "available");
    assert.equal(available.branches.find((v) => v.branch.id === crossLineBranch.branch.id)?.originStatus, "available");

    repository.updateSessionAvailability(answer.run.id, { status: "unavailable", reason: "missing-file" });
    const unavailable = service.getTreeState(created.tree.id);
    assert.equal(
      unavailable.branches.find((v) => v.branch.id === duplicateBranch.branch.id)?.originStatus,
      "unavailable",
    );
    await studio.shutdown();
  } finally {
    cleanupDir(dir);
  }
});
