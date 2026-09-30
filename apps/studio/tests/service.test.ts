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
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  BranchId,
  PiEntryId,
  PiRuntime,
  PiSessionId,
  PiVersion,
  RunId,
  TreeId,
  TurnId,
} from "@treeai/contracts";
import { EntityNotFoundError, InvalidArgumentError } from "@treeai/persistence";
import { classifyPiFailure, createPiRuntimeFromConfig } from "@treeai/runtime-pi";
import type { TreeState } from "../src/service.ts";
import { composePromptText, NewExplorationConflictError, ReturnConflictError, RunNotActiveError } from "../src/service.ts";
import type { TreeStudioService } from "../src/service.ts";
import { EchoSdkPort, ECHO_FAILURE_MESSAGE } from "../src/echo-port.ts";
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

/** 造一棵带锚定分支的树（Trunk 一问一答 + 分支一轮），供 Return 类测试复用。 */
async function makeTreeWithAnchoredBranch(service: TreeStudioService) {
  const created = service.createTree();
  const treeId = created.tree.id;
  const trunkId = created.trunkBranch.id;
  const t1 = await service.prompt(treeId, trunkId, "q1");
  const answer = t1.assistantTurn;
  const creation = service.createBranchFromSelection(treeId, trunkId, answer.id, {
    start: 0,
    end: 5,
    text: answer.text.slice(0, 5),
  });
  await service.prompt(treeId, creation.branch.id, "b1");
  return { treeId, trunkId, branchId: creation.branch.id, origin: creation.origin, anchorAnswer: answer };
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

    /* 6. 编辑并显式提交 Return（记录在 Trunk，含出处与锚点快照；先导航后落库）。 */
    const returnText = `RETURN: use ${selection.text} as the answer`;
    const returnSubmission = await service.submitReturn(treeId, branchId, returnText, "key-vertical-slice");
    assert.equal(returnSubmission.created, true, "the first submission creates the return");
    const returnTurn = returnSubmission.turn;
    assert.equal(returnTurn.role, "return");
    assert.equal(returnTurn.branchId, trunkId, "the return lands on the Trunk");
    assert.equal(returnTurn.fromBranchId, branchId);
    assert.equal(returnTurn.deliveredRunId, null, "not yet delivered");
    assert.equal(returnTurn.idempotencyKey, "key-vertical-slice");
    assert.deepEqual(returnTurn.targetAnchor, {
      sourceBranchId: creation.origin.sourceBranchId,
      anchorTurnId: creation.origin.anchorTurnId,
      anchorEntryId: creation.origin.anchorEntryId,
      selection: creation.origin.selection,
    });

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
    await assert.rejects(() => service.submitReturn(treeId, trunkId, "text", "key-a"), InvalidArgumentError);
    // return 文本不能为空；幂等键必填（空白同缺失）；跨树引用被拒绝。
    const other = service.createTree();
    const t = await service.prompt(other.tree.id, other.trunkBranch.id, "q");
    const branch = service.createBranchFromSelection(other.tree.id, other.trunkBranch.id, t.assistantTurn.id, {
      start: 0,
      end: 2,
      text: t.assistantTurn.text.slice(0, 2),
    });
    await assert.rejects(
      () => service.submitReturn(other.tree.id, branch.branch.id, "  ", "key-b"),
      InvalidArgumentError,
    );
    await assert.rejects(
      () => service.submitReturn(other.tree.id, branch.branch.id, "text", ""),
      InvalidArgumentError,
    );
    await assert.rejects(
      () => service.submitReturn(other.tree.id, branch.branch.id, "text", "   "),
      InvalidArgumentError,
    );
    await assert.rejects(
      () => service.submitReturn(treeId, branch.branch.id, "cross-tree", "key-c"),
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

test("anchor status preserves duplicate and cross-line selections; session unavailability stays a separate dimension (v3 §1.2)", async () => {
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

    /* 来源定位与 session 可用性分离（signed v3 §1.2，issue #7 P0-1）：
       锚点 run 的 session 降级（DB 缓存评 unavailable）不再降格来源状态——
       来源身份与选区文本未变，originStatus 如实保持 available。（session
       维度的呈现与文件级缺失场景由下方 P0-1/P0-2 两个用例覆盖：这里文件
       仍在，实时探针如实把 missing-file 降级修复为 available。） */
    repository.updateSessionAvailability(answer.run.id, { status: "unavailable", reason: "missing-file" });
    const sessionDegraded = service.getTreeState(created.tree.id);
    assert.equal(
      sessionDegraded.branches.find((v) => v.branch.id === duplicateBranch.branch.id)?.originStatus,
      "available",
      "session unavailability does not degrade the anchor status (v3 §1.2 dimension separation)",
    );
    await studio.shutdown();
  } finally {
    cleanupDir(dir);
  }
});

test("changed anchor (DB-constructed): originStatus reports changed, the excerpt stays readable, reveal refuses without fallback, nothing is silently repaired (W1 §6-3)", async () => {
  const dir = makeTempDataDir();
  try {
    const studio = makeStudioInstance(dir);
    const { service } = studio;
    const created = service.createTree();
    const treeId = created.tree.id;
    const trunkId = created.trunkBranch.id;
    const t1 = await service.prompt(treeId, trunkId, "q1");
    const answer = t1.assistantTurn;
    assert.equal(answer.text, "echo:[q1]");

    /* 同一答案上的两个锚：prefix 选区（改写后切片失配 → changed）与
       tail 选区（改写后仍逐字匹配 → available 对照组，证明判定按各 origin
       逐条计算，不是一刀切降级）。 */
    const changedCreation = service.createBranchFromSelection(treeId, trunkId, answer.id, {
      start: 0,
      end: 5,
      text: "echo:",
    });
    const controlCreation = service.createBranchFromSelection(treeId, trunkId, answer.id, {
      start: 6,
      end: 9,
      text: "q1]",
    });
    let state = service.getTreeState(treeId);
    assert.equal(findBranchView(state, changedCreation.branch.id).originStatus, "available");
    assert.equal(findBranchView(state, controlCreation.branch.id).originStatus, "available");
    await studio.shutdown();

    /* 不变量破坏（W1 §6-3 认可的补测路线）：产品没有改写 turn 文本的路径，
       `changed` 态只能直改 DB 构造——同长度前缀改写锚点答案（"echo:" →
       "ECHO:"），令 prefix 选区在原偏移处失配、tail 选区不变。仓储层
       （setBranchOrigin 写入校验）与产品流都拒绝这种状态，直改 SQL 是
       唯一入口。 */
    const db = new DatabaseSync(join(dir, "treeai.db"));
    db.prepare("UPDATE turns SET text = ? WHERE id = ?").run("ECHO:[q1]", answer.id);
    db.close();

    /* 整实例重启（新 repo + 新 runtime + 新 service）后读改写后的库。 */
    const studio2 = makeStudioInstance(dir);
    const { service: service2, repository: repository2 } = studio2;

    /* 三态判定（真实 #anchorStatus 对真实 DB 事实）：失配选区如实报
       `changed`（既不伪造 available，也不降格为 unavailable）；同一 turn
       上仍匹配的选区仍 available。 */
    state = service2.getTreeState(treeId);
    const changedView = findBranchView(state, changedCreation.branch.id);
    const controlView = findBranchView(state, controlCreation.branch.id);
    assert.equal(changedView.originStatus, "changed", "the rewritten slice reports changed");
    assert.equal(controlView.originStatus, "available", "the still-matching slice on the same turn stays available");
    /* 摘录始终可读（§1.3）：降级不删除、不遮蔽落库的选区快照；树照常
       可读，改写后的答案文本按 DB 事实原样呈现（不遮蔽、不修复）。 */
    assert.ok(changedView.origin !== null);
    assert.deepEqual(changedView.origin.selection, changedCreation.origin.selection, "the saved excerpt stays readable");
    const mutatedAnswer = findBranchView(state, trunkId).turns.find((t) => t.id === answer.id);
    assert.ok(mutatedAnswer !== undefined);
    assert.equal(mutatedAnswer.text, "ECHO:[q1]", "the read model shows the DB truth");

    /* 揭示拒绝且如实报告（§1.3）：changed → 不定位；返回的 selection 是
       落库快照原文（不是改写后文本的切片——无 whole-answer 回退，也无
       按首次出现重新定位），且导航零副作用（游标不动）。 */
    const cursorBeforeReveal = state.cursor;
    const reveal = await service2.revealBranchOrigin(treeId, changedCreation.branch.id);
    assert.equal(reveal.status, "changed", "reveal reports the degraded status honestly");
    assert.equal(reveal.sourceBranchId, trunkId);
    assert.equal(reveal.anchorTurnId, answer.id);
    assert.deepEqual(reveal.selection, changedCreation.origin.selection, "reveal returns the saved excerpt verbatim");
    assert.deepEqual(
      service2.getTreeState(treeId).cursor,
      cursorBeforeReveal,
      "the refused reveal navigates nothing",
    );

    /* 对照：同一答案上仍匹配的选区照常可揭示（拒绝源于该 origin 的
       changed 判定，不是揭示路径整体失灵）。 */
    const controlReveal = await service2.revealBranchOrigin(treeId, controlCreation.branch.id);
    assert.equal(controlReveal.status, "available");
    assert.deepEqual(controlReveal.selection, controlCreation.origin.selection);

    /* 续聊边界（如实锁定实际行为，非契约背书）：服务层续聊（prompt /
       switchBranch）只由「续聊点可解析 + session 可用性」门控，不查锚点
       状态——changed 锚点不阻断分支首聊：分支仍从记录在案的锚点条目分叉
       （echo 上下文 = 锚点前主干 + 分支自身，与锚点完好时逐字一致，无
       whole-answer / 首次出现回退）。W1 §1.3 字面的「changed → 续聊拒绝」
       未在服务层实现（§1.3 实现对照本身把续聊 fail-closed 指向 §3.4 的
       session 不可用路径）；按实现如实断言，偏差随 §6-3 呈报 owner。 */
    const branchPrompt = await service2.prompt(treeId, changedCreation.branch.id, "b1-q");
    assert.equal(branchPrompt.run.state, "succeeded", "a changed anchor does not block branch continuation");
    assert.equal(
      branchPrompt.assistantTurn.text,
      "echo:[q1|b1-q]",
      "continuation forks from the recorded anchor entry (no re-anchoring fallback)",
    );

    /* 无静默修复：改写后的 DB 事实与落库选区快照原样保留；重复读取判定
       稳定（不自我恢复、不改写事实、不隐瞒降级）。 */
    assert.equal(repository2.getTurn(answer.id).text, "ECHO:[q1]", "the mutated fact is preserved, not repaired");
    assert.deepEqual(
      repository2.findBranchOrigin(changedCreation.branch.id)?.selection,
      changedCreation.origin.selection,
      "the anchored selection snapshot is never rewritten",
    );
    const finalState = service2.getTreeState(treeId);
    assert.equal(findBranchView(finalState, changedCreation.branch.id).originStatus, "changed");
    assert.equal(findBranchView(finalState, controlCreation.branch.id).originStatus, "available");
    await studio2.shutdown();
  } finally {
    cleanupDir(dir);
  }
});

test("return idempotency: same key+content replays the same turn; different content conflicts", async () => {
  const dir = makeTempDataDir();
  try {
    const studio = makeStudioInstance(dir);
    const { service, repository } = studio;
    const { treeId, trunkId, branchId, anchorAnswer } = await makeTreeWithAnchoredBranch(service);
    const countReturns = () =>
      repository.listTurns(trunkId).filter((t) => t.role === "return").length;

    /* 首次提交：新建（created true）。 */
    const first = await service.submitReturn(treeId, branchId, "RETURN: use hi", "key-replay");
    assert.equal(first.created, true);
    assert.equal(first.turn.role, "return");
    assert.equal(first.turn.idempotencyKey, "key-replay");

    /* 同键同内容重试（响应丢失场景）：零写入返回同一条 Return。 */
    const replay = await service.submitReturn(treeId, branchId, "RETURN: use hi", "key-replay");
    assert.equal(replay.created, false);
    assert.equal(replay.turn.id, first.turn.id, "replay resolves to the same turn id");
    assert.equal(countReturns(), 1, "exactly one return row after the replay");

    /* 同键不同文本 → 冲突；消息含键、既有 turn id 与“内容不同”。 */
    await assert.rejects(
      () => service.submitReturn(treeId, branchId, "RETURN: different text", "key-replay"),
      (err: unknown) =>
        err instanceof ReturnConflictError &&
        err.message.includes("key-replay") &&
        err.message.includes(first.turn.id) &&
        err.message.includes("different content"),
    );

    /* 同键不同出处分支 → 冲突。 */
    const second = service.createBranchFromSelection(treeId, trunkId, anchorAnswer.id, {
      start: 0,
      end: 4,
      text: anchorAnswer.text.slice(0, 4),
    });
    await assert.rejects(
      () => service.submitReturn(treeId, second.branch.id, "RETURN: use hi", "key-replay"),
      ReturnConflictError,
    );

    assert.equal(countReturns(), 1, "conflicts persist nothing");
    await studio.shutdown();
  } finally {
    cleanupDir(dir);
  }
});

test("return idempotency is scoped per tree: the same key lands independently in two trees (signed v3 §3.4)", async () => {
  const dir = makeTempDataDir();
  try {
    const studio = makeStudioInstance(dir);
    const { service } = studio;
    const one = await makeTreeWithAnchoredBranch(service);
    const two = await makeTreeWithAnchoredBranch(service);

    /* 同一逻辑键在两棵树内各自有效：两次提交均为新建，互不干扰。 */
    const inOne = await service.submitReturn(one.treeId, one.branchId, "RETURN: from tree one", "key-cross-tree");
    const inTwo = await service.submitReturn(two.treeId, two.branchId, "RETURN: from tree two", "key-cross-tree");
    assert.equal(inOne.created, true, "the shared key is new in tree one");
    assert.equal(inTwo.created, true, "the same key is also new in tree two (per-tree scope)");
    assert.notEqual(inOne.turn.id, inTwo.turn.id);
    assert.equal(inOne.navigation.status, "navigated");
    assert.equal(inTwo.navigation.status, "navigated");

    /* 树内重放/冲突语义不变：tree two 内同键同内容重放、同键异容冲突。 */
    const replayInTwo = await service.submitReturn(two.treeId, two.branchId, "RETURN: from tree two", "key-cross-tree");
    assert.equal(replayInTwo.created, false);
    assert.equal(replayInTwo.turn.id, inTwo.turn.id);
    await assert.rejects(
      () => service.submitReturn(two.treeId, two.branchId, "RETURN: different text", "key-cross-tree"),
      ReturnConflictError,
    );
    await assert.rejects(
      () => service.submitReturn(one.treeId, one.branchId, "RETURN: different text", "key-cross-tree"),
      ReturnConflictError,
    );
    await studio.shutdown();
  } finally {
    cleanupDir(dir);
  }
});

test("concurrent same-key submits converge to one return (race-safe, no dangling episode)", async () => {
  const dir = makeTempDataDir();
  try {
    const studio = makeStudioInstance(dir);
    const { service, repository } = studio;
    const { treeId, trunkId, branchId } = await makeTreeWithAnchoredBranch(service);
    const countReturns = () =>
      repository.listTurns(trunkId).filter((t) => t.role === "return").length;

    /* 同键同内容并发：两个提交都成功，解析到同一条 Return，恰一新建。 */
    const episodesBefore = repository.listEpisodes(trunkId).length;
    const [a, b] = await Promise.all([
      service.submitReturn(treeId, branchId, "RETURN: race", "key-race"),
      service.submitReturn(treeId, branchId, "RETURN: race", "key-race"),
    ]);
    assert.equal(a.turn.id, b.turn.id, "both concurrent submits resolve to the same return turn");
    assert.notEqual(a.created, b.created, "exactly one of the two created the row");
    assert.equal(countReturns(), 1, "exactly one return row after the race");
    assert.equal(
      repository.listEpisodes(trunkId).length,
      episodesBefore + 1,
      "the loser's transaction rolled back (no dangling episode)",
    );

    /* 同键不同内容并发：恰一胜一败，败者以 ReturnConflictError 拒绝。 */
    const settled = await Promise.allSettled([
      service.submitReturn(treeId, branchId, "RETURN: conflict A", "key-race-conflict"),
      service.submitReturn(treeId, branchId, "RETURN: conflict B", "key-race-conflict"),
    ]);
    let fulfilled = 0;
    let conflict: unknown = null;
    for (const result of settled) {
      if (result.status === "fulfilled") fulfilled += 1;
      else conflict = result.reason;
    }
    assert.equal(fulfilled, 1, "exactly one concurrent submit wins");
    assert.ok(conflict instanceof ReturnConflictError, "the loser is rejected with ReturnConflictError");
    assert.equal(countReturns(), 2, "one new return row from the winner (2 total)");
    await studio.shutdown();
  } finally {
    cleanupDir(dir);
  }
});

test("missing session: submit saves the return first, navigation fails separately; same-key retries replay without duplicates (signed v3 §3.5)", async () => {
  const dir = makeTempDataDir();
  try {
    const studio = makeStudioInstance(dir);
    const { service } = studio;
    const { treeId, trunkId, branchId } = await makeTreeWithAnchoredBranch(service);

    /* 整实例重启（内存 cursor 清空）+ session 文件缺失（保留内容供恢复）。 */
    const sessionsDir = join(dir, "sessions");
    const sessionFiles = readdirSync(sessionsDir);
    assert.equal(sessionFiles.length, 1, "one session file per tree");
    const sessionFile = join(sessionsDir, sessionFiles[0]!);
    const sessionContent = readFileSync(sessionFile, "utf8");
    await studio.shutdown();
    rmSync(sessionFile);

    const studio2 = makeStudioInstance(dir);
    const countReturns = () =>
      studio2.repository.listTurns(trunkId).filter((t) => t.role === "return").length;

    /* 保存先于导航：session 文件缺失时 Return 照常落库，导航失败作为
       分离结果返回（failed + session-corrupt），绝不回滚已保存的 Return。 */
    const saved = await studio2.service.submitReturn(treeId, branchId, "RETURN: retry me", "key-missing-session");
    assert.equal(saved.created, true, "the return is saved although the session file is missing");
    assert.equal(saved.turn.role, "return");
    assert.equal(saved.turn.idempotencyKey, "key-missing-session");
    assert.equal(countReturns(), 1, "the return is persisted before navigation runs");
    assert.equal(saved.navigation.status, "failed", "navigation fails separately from the save");
    assert.equal(saved.navigation.status === "failed" ? saved.navigation.code : "", "session-corrupt");

    /* session 仍缺失时同键重试：重放（零新写入），导航再次失败——重试
       不会产生第二条 Return，也不会把已保存的 Return 伪装成失败。 */
    const replayedWhileBroken = await studio2.service.submitReturn(treeId, branchId, "RETURN: retry me", "key-missing-session");
    assert.equal(replayedWhileBroken.created, false, "the same-key retry replays the saved return");
    assert.equal(replayedWhileBroken.turn.id, saved.turn.id);
    assert.equal(countReturns(), 1, "still exactly one return row");
    assert.equal(replayedWhileBroken.navigation.status, "failed");
    assert.equal(
      replayedWhileBroken.navigation.status === "failed" ? replayedWhileBroken.navigation.code : "",
      "session-corrupt",
    );

    /* session 文件恢复后同键重试：仍是重放（保存早已完成），但这次导航
       成功——重试即重新导航的载体。 */
    writeFileSync(sessionFile, sessionContent, "utf8");
    const retried = await studio2.service.submitReturn(treeId, branchId, "RETURN: retry me", "key-missing-session");
    assert.equal(retried.created, false, "restore + retry still replays (no duplicate)");
    assert.equal(retried.turn.id, saved.turn.id);
    assert.equal(countReturns(), 1, "exactly one return after restore + same-key retry");
    assert.equal(retried.navigation.status, "navigated", "the retry navigates back once the session is restored");
    const stateAfterRestore = studio2.service.getTreeState(treeId);
    assert.notEqual(stateAfterRestore.cursor, null, "the replay's navigation moved the cursor to the trunk");
    assert.equal(stateAfterRestore.cursor?.branchId, trunkId);

    /* 后续主干 prompt 采用该 Return（保存成功 + 导航曾失败 ≠ 已采用）。 */
    const adopted = await studio2.service.prompt(treeId, trunkId, "trunk question after recovery");
    assert.equal(adopted.run.state, "succeeded");
    assert.equal(adopted.deliveredReturns, 1);
    await studio2.shutdown();
  } finally {
    cleanupDir(dir);
  }
});

test("source reveal is decoupled from session availability (v3 §1.2, issue #7 P0-1): a deleted session still locates the database original; cursor alignment fails separately", async () => {
  const dir = makeTempDataDir();
  try {
    const studio = makeStudioInstance(dir);
    const { service } = studio;
    const { treeId, trunkId, branchId, origin } = await makeTreeWithAnchoredBranch(service);

    /* 整实例重启 + session 文件缺失（保留内容供恢复）。 */
    const sessionsDir = join(dir, "sessions");
    const sessionFiles = readdirSync(sessionsDir);
    assert.equal(sessionFiles.length, 1, "one session file per tree");
    const sessionFile = join(sessionsDir, sessionFiles[0]!);
    const sessionContent = readFileSync(sessionFile, "utf8");
    await studio.shutdown();
    rmSync(sessionFile);

    const studio2 = makeStudioInstance(dir);
    const { service: service2 } = studio2;

    /* 维度分离：session 维度如实 unavailable；来源维度（身份/切片未变）
       如实 available——删除 session 后数据库原文仍可准确定位。 */
    const state = service2.getTreeState(treeId);
    const branchView = findBranchView(state, branchId);
    assert.equal(branchView.sessionAvailability, "unavailable", "the session dimension degrades honestly");
    assert.equal(branchView.originStatus, "available", "the source dimension is untouched by session loss (v3 §1.2)");

    /* 揭示：纯产品定位照常成功（available + 落库快照原文）；Pi 游标对齐
       作为独立结果失败（session-corrupt），不降格来源状态。 */
    const cursorBeforeReveal = state.cursor;
    const reveal = await service2.revealBranchOrigin(treeId, branchId);
    assert.equal(reveal.status, "available", "the source is locatable from the database despite the missing session");
    assert.equal(reveal.sourceBranchId, trunkId);
    assert.deepEqual(reveal.selection, origin.selection, "reveal returns the saved excerpt verbatim");
    assert.ok(reveal.navigation !== null, "a navigation outcome is always present for an available source");
    assert.equal(reveal.navigation.status, "failed", "cursor alignment fails separately (session-corrupt)");
    assert.equal(reveal.navigation.status === "failed" ? reveal.navigation.code : "", "session-corrupt");
    assert.deepEqual(
      service2.getTreeState(treeId).cursor,
      cursorBeforeReveal,
      "the failed alignment leaves the cursor untouched",
    );

    /* session 文件恢复后重揭示：定位不变，游标对齐这次成功（分离结果的
       另一面——对齐恢复不影响来源判定的稳定性）。 */
    writeFileSync(sessionFile, sessionContent, "utf8");
    const reReveal = await service2.revealBranchOrigin(treeId, branchId);
    assert.equal(reReveal.status, "available");
    assert.deepEqual(reReveal.selection, origin.selection);
    assert.equal(reReveal.navigation?.status, "navigated", "alignment recovers once the session file is back");
    assert.equal(service2.getTreeState(treeId).cursor?.branchId, trunkId);
    await studio2.shutdown();
  } finally {
    cleanupDir(dir);
  }
});

test("whole-tree session loss: explicit new exploration creates a new session, carries the saved content into the first prompt, and leaves the old history readable (v3 §4.4, issue #7 P0-2)", async () => {
  const dir = makeTempDataDir();
  try {
    const studio = makeStudioInstance(dir);
    const { service } = studio;
    const { treeId, trunkId, branchId, origin } = await makeTreeWithAnchoredBranch(service);
    const oldBranchTurns = service.getTreeState(treeId).branches
      .find((v) => v.branch.id === branchId)!
      .turns.map((t) => ({ id: t.id, role: t.role, text: t.text }));
    assert.equal(oldBranchTurns.length, 2, "the branch has its own follow-up round before the loss");

    const sessionsDir = join(dir, "sessions");
    const sessionFiles = readdirSync(sessionsDir);
    assert.equal(sessionFiles.length, 1, "one session file per tree");
    const oldSessionFile = sessionFiles[0]!;
    await studio.shutdown();
    rmSync(join(sessionsDir, oldSessionFile));

    const studio2 = makeStudioInstance(dir);
    const { service: service2 } = studio2;

    /* fail-closed 纪律不变：普通续聊照常拒绝（绝不静默重建 session）。 */
    await assert.rejects(
      () => service2.prompt(treeId, branchId, "normal continuation must fail closed"),
      (err: unknown) => err instanceof Error && (err as { code?: unknown }).code === "session-corrupt",
    );

    /* 显式换轨：新 session + 保存内容上下文 + 首问必须成功。 */
    const outcome = await service2.promptNewExploration(treeId, branchId, "fresh start question");
    assert.equal(outcome.run.state, "succeeded", "the first question of the new exploration succeeds");
    assert.ok(outcome.userTurn.text.includes("[new exploration from saved content"));
    assert.ok(outcome.userTurn.text.endsWith("fresh start question"), "the typed question stays readable after the marker");
    /* 保存内容确实进入了模型上下文（echo 答案 = 新 session 上全部 user
       文本的回声——上下文块 + 首问，含锚点摘录与旧历史）。 */
    assert.ok(outcome.assistantTurn.text.includes(origin.selection.text), "the anchored excerpt is carried in");
    assert.ok(outcome.assistantTurn.text.includes("fresh start question"));
    assert.ok(
      oldBranchTurns.some((t) => t.role === "assistant" && outcome.assistantTurn.text.includes(t.text)),
      "the saved branch history is carried in",
    );

    /* 新 session 是事实上的新文件（旧文件已删；新 run 引用它）。 */
    const newSessionFiles = readdirSync(sessionsDir).filter((f) => !f.startsWith("."));
    assert.equal(newSessionFiles.length, 1, "a new session file exists after the exploration");
    assert.notEqual(newSessionFiles[0], oldSessionFile, "the new session is a different file");
    assert.equal(outcome.run.session.sessionFile.endsWith(newSessionFiles[0]!), true);

    /* 旧历史保持可读 + 来源关系不动（不冒充旧会话恢复：旧 turn 原样追加
       在后，origin 不改写）。 */
    const stateAfter = service2.getTreeState(treeId);
    const branchViewAfter = findBranchView(stateAfter, branchId);
    const turnsAfter = branchViewAfter.turns;
    assert.equal(turnsAfter.length, oldBranchTurns.length + 2, "old turns stay, exactly two new turns append");
    for (let i = 0; i < oldBranchTurns.length; i += 1) {
      assert.equal(turnsAfter[i]!.id, oldBranchTurns[i]!.id, `old turn ${String(i)} is untouched`);
      assert.equal(turnsAfter[i]!.text, oldBranchTurns[i]!.text);
    }
    assert.deepEqual(
      studio2.repository.findBranchOrigin(branchId)?.selection,
      origin.selection,
      "the source relation (origin) is preserved, not rewritten",
    );
    assert.equal(branchViewAfter.sessionAvailability, "available", "the branch continues on the new session");
    assert.equal(branchViewAfter.originStatus, "available", "the source stays locatable (P0-1)");

    /* 换轨后普通续聊恢复（续聊点 = 新 session 的最新 run）。 */
    const normal = await service2.prompt(treeId, branchId, "back to normal continuation");
    assert.equal(normal.run.state, "succeeded");
    assert.ok(normal.assistantTurn.text.includes("back to normal continuation"));

    /* session 已可用时再次换轨 → 前置条件冲突（应走普通续聊），零写入。 */
    const turnsBeforeConflict = service2.getTreeState(treeId).branches
      .find((v) => v.branch.id === branchId)!
      .turns.length;
    await assert.rejects(
      () => service2.promptNewExploration(treeId, branchId, "should conflict now"),
      (err: unknown) => err instanceof NewExplorationConflictError,
    );
    assert.equal(
      service2.getTreeState(treeId).branches.find((v) => v.branch.id === branchId)!.turns.length,
      turnsBeforeConflict,
      "the rejected new exploration writes nothing",
    );
    await studio2.shutdown();
  } finally {
    cleanupDir(dir);
  }
});

test("new exploration preconditions (v3 §4.4): available session and never-prompted trunks are refused as conflicts; an anchored branch with a lost anchor session explores from the excerpt alone", async () => {
  const dir = makeTempDataDir();
  try {
    const studio = makeStudioInstance(dir);
    const { service } = studio;
    const created = service.createTree();
    const treeId = created.tree.id;
    const trunkId = created.trunkBranch.id;

    /* 无历史 session（Trunk 从未 prompt）：换轨拒绝——普通 prompt 即新建。 */
    await assert.rejects(
      () => service.promptNewExploration(treeId, trunkId, "nothing to explore from"),
      (err: unknown) => err instanceof NewExplorationConflictError,
    );

    /* 健康分支（session 可用）：换轨拒绝——应走普通续聊。 */
    await service.prompt(treeId, trunkId, "tree-one question");
    await assert.rejects(
      () => service.promptNewExploration(treeId, trunkId, "still healthy"),
      (err: unknown) =>
        err instanceof NewExplorationConflictError && err.message.includes("available session"),
    );

    /* issue #7 场景 6：以保存的原答案建锚定支线（无 run），其续聊点 =
       锚点 run 的 session 引用；session 丢失后首次 prompt 失败，显式新探索
       以锚点摘录为起点成功（不能以「可创建但首问失败」交差）。 */
    const tree2 = service.createTree();
    const treeId2 = tree2.tree.id;
    const trunk2 = tree2.trunkBranch.id;
    const t1 = await service.prompt(treeId2, trunk2, "q1");
    const branch = service.createBranchFromSelection(treeId2, trunk2, t1.assistantTurn.id, {
      start: 0,
      end: 5,
      text: t1.assistantTurn.text.slice(0, 5),
    });
    const sessionsDir = join(dir, "sessions");
    const sessionFiles = readdirSync(sessionsDir);
    assert.equal(sessionFiles.length, 2, "one session file per tree lineage");
    /* 按内容定位 tree-2 的 session 文件：含其 trunk prompt "q1"，不含
       tree-1 的 "tree-one question"。 */
    const tree2File = sessionFiles
      .map((f) => join(sessionsDir, f))
      .find((p) => {
        const content = readFileSync(p, "utf8");
        return content.includes("q1") && !content.includes("tree-one question");
      });
    assert.ok(tree2File !== undefined, "the tree-2 session file is identifiable");
    await studio.shutdown();
    rmSync(tree2File);

    const studio2 = makeStudioInstance(dir);
    const { service: service2 } = studio2;
    const branchState = service2.getTreeState(treeId2);
    const branchView = branchState.branches.find((v) => v.branch.id === branch.branch.id);
    assert.ok(branchView !== undefined);
    assert.equal(branchView.sessionAvailability, "unavailable", "the anchored branch's continuation point is the lost anchor session");

    await assert.rejects(
      () => service2.prompt(treeId2, branch.branch.id, "first prompt fails closed"),
      (err: unknown) => err instanceof Error && (err as { code?: unknown }).code === "session-corrupt",
    );

    const outcome = await service2.promptNewExploration(treeId2, branch.branch.id, "explore from the excerpt");
    assert.equal(outcome.run.state, "succeeded", "the new exploration's first question succeeds where the normal prompt failed");
    assert.ok(
      outcome.assistantTurn.text.includes(t1.assistantTurn.text.slice(0, 5)),
      "the anchor excerpt is the carried-in starting context",
    );
    assert.ok(outcome.userTurn.text.includes("explore from the excerpt"));
    /* 分支自身无历史（无 run）：上下文块不含「Saved history」段。 */
    assert.ok(!outcome.assistantTurn.text.includes("[Saved history on this branch]"));
    await studio2.shutdown();
  } finally {
    cleanupDir(dir);
  }
});

test("empty-trunk return: submit persists directly without a session; the first trunk prompt creates the session and delivers it exactly once (W1 §6-7)", async () => {
  const dir = makeTempDataDir();
  try {
    const studio = makeStudioInstance(dir);
    const { service, repository } = studio;
    const sessionsDir = join(dir, "sessions");

    /* 「主干尚无 session + 已存在锚定分支」在产品流里不可达（任何树的
       首个 prompt 必然落在主干——锚点答案先要有 prompt 才存在），唯一
       构造途径是仓储层铺设锚点（与 legacy-shape / startup-recovery 用例
       同款）：主干零 episode / 零 run，锚点回合挂在非主干分支上。 */
    const created = service.createTree();
    const treeId = created.tree.id;
    const trunkId = created.trunkBranch.id;
    const sourceBranch = repository.createBranch(treeId, { parentBranchId: trunkId });
    const anchorEpisode = repository.createEpisode(sourceBranch.id);
    const anchorRun = repository.createRun(anchorEpisode.id, {
      sessionId: "sess-anchor-only" as PiSessionId,
      sessionFile: "sessions/anchor-only.jsonl", // 只作锚点记录，从不恢复（磁盘上不存在）
      entryId: "entry-anchor" as PiEntryId,
      piVersion: "0.85.1" as PiVersion,
      availability: { status: "available" },
    });
    const anchorTurn = repository.createTurn({
      treeId,
      branchId: sourceBranch.id,
      episodeId: anchorEpisode.id,
      runId: anchorRun.id,
      role: "assistant",
      text: "anchor answer with a selectable part",
      piEntryId: "entry-anchor",
    });
    const branchCreation = service.createBranchFromSelection(treeId, sourceBranch.id, anchorTurn.id, {
      start: 0,
      end: 6,
      text: "anchor",
    });
    const branchId = branchCreation.branch.id;

    /* 前置：主干无 episode / 无 session / 无导航；锚定分支判定 available
       （铺设本身是完好的锚，不是意外降级态）。 */
    assert.equal(repository.listEpisodes(trunkId).length, 0, "the trunk has never been prompted");
    assert.equal(readdirSync(sessionsDir).length, 0, "no Pi session file exists yet");
    let state = service.getTreeState(treeId);
    assert.equal(state.cursor, null, "no navigation has happened");
    assert.equal(findBranchView(state, trunkId).sessionAvailability, null, "the trunk has no session yet");
    assert.equal(findBranchView(state, branchId).originStatus, "available", "the fabricated anchor is well-formed");

    /* 提交 Return（W1 §2.4 直落库分支）：switchBranch 对主干的
       new-session 续聊点显式不导航、不建会话，Return 直接落库。 */
    const returnText = "RETURN: the branch settled this before the trunk ever started";
    const submission = await service.submitReturn(treeId, branchId, returnText, "key-empty-trunk");
    assert.equal(submission.created, true);
    assert.equal(submission.turn.role, "return");
    assert.equal(submission.turn.branchId, trunkId, "the return lands on the Trunk");
    assert.equal(submission.turn.fromBranchId, branchId);
    assert.equal(submission.turn.deliveredRunId, null, "saved, pending adoption");
    assert.equal(
      submission.navigation.status,
      "no-session",
      "a fresh trunk without a session saves the return; navigation reports no-session (not a failure)",
    );
    assert.deepEqual(submission.turn.targetAnchor, {
      sourceBranchId: branchCreation.origin.sourceBranchId,
      anchorTurnId: branchCreation.origin.anchorTurnId,
      anchorEntryId: branchCreation.origin.anchorEntryId,
      selection: branchCreation.origin.selection,
    });

    /* 不建会话、不导航、不建 run：session 目录仍空、游标仍 null；Return
       落在主干自己的首个 episode 里，但该 episode 无 run（session 由首次
       主干 prompt 创建，不由 Return 创建）。 */
    assert.equal(readdirSync(sessionsDir).length, 0, "submitting the return creates no Pi session");
    state = service.getTreeState(treeId);
    assert.equal(state.cursor, null, "submitting the return navigates nothing (new-session trunk)");
    const trunkEpisodes = repository.listEpisodes(trunkId);
    assert.equal(trunkEpisodes.length, 1, "the return's episode is the trunk's first");
    assert.deepEqual(
      trunkEpisodes.flatMap((episode) => repository.listRuns(episode.id)),
      [],
      "no run is created by the return",
    );
    assert.equal(service.getTreeDiagnostics(treeId).runs.length, 1, "only the fabricated anchor run exists");

    /* 首次主干 prompt：此刻才建 session，并把 pending Return 送入 Pi
       上下文（送达恰一次，deliveredRunId 绑定本次 run）。 */
    const first = await service.prompt(treeId, trunkId, "first trunk question");
    assert.equal(first.run.state, "succeeded");
    assert.equal(first.deliveredReturns, 1, "the pending return is delivered by the first trunk prompt");
    assert.equal(readdirSync(sessionsDir).length, 1, "the session is created exactly now");
    assert.ok(
      first.assistantTurn.text.includes(returnText),
      `the composed context carries the return: ${first.assistantTurn.text}`,
    );
    assert.ok(first.assistantTurn.text.includes("first trunk question"));
    state = service.getTreeState(treeId);
    assert.notEqual(state.cursor, null, "the first prompt navigates the fresh session");
    assert.equal(state.cursor?.branchId, trunkId);
    const delivered = findBranchView(state, trunkId).turns.find((t) => t.role === "return");
    assert.ok(delivered !== undefined);
    assert.equal(delivered.deliveredRunId, first.run.id, "delivery is bound to the first trunk run");

    /* 再一次主干 prompt：不重送（送达恰一次）。 */
    const second = await service.prompt(treeId, trunkId, "second trunk question");
    assert.equal(second.deliveredReturns, 0, "the return is never re-sent after delivery");
    await studio.shutdown();
  } finally {
    cleanupDir(dir);
  }
});

test("failed prompt never delivers the pending return; the next successful trunk prompt delivers it exactly once (W1 §6-4)", async () => {
  const dir = makeTempDataDir();
  try {
    /* 失败注入（问二裁决后的补测，关上 W1 §6-4 的证据缺口）：echo 的
       /fail 前缀钩子在此不可用——待送达 Return 会让 composePromptText
       先行加前缀，组合文本不再以 /fail 开头（钩子只看原文开头）。因此
       在 runtime 层注入：真实 echo 栈（EchoSdkPort +
       createPiRuntimeFromConfig，与 helpers.ts 同款装配）外包一层代理，
       PiRuntime 全成员原样转发（箭头函数闭包固定被包装实例，this 绑定
       正确），仅 prompt 文本命中哨兵时以「真实 /fail 路径同款」的错误
       拒绝——classifyPiFailure 对 ECHO_FAILURE_MESSAGE 的归一结果与
       runtime-pi drivePrompt 对 stopReason "error" 终态的分类逐字节一致
       （"500" 命中 upstream 模式 → TreeAIError code "upstream"）。 */
    const FAILURE_SENTINEL = "TRIGGER-UPSTREAM-FAILURE";
    const echoRuntime = createPiRuntimeFromConfig({
      port: new EchoSdkPort(),
      defaultCwd: join(dir, "workspace"),
    });
    const runtime: PiRuntime = {
      get piVersion() {
        return echoRuntime.piVersion;
      },
      createSession: (init) => echoRuntime.createSession(init),
      restoreSession: (reference) => echoRuntime.restoreSession(reference),
      prompt: (input) =>
        input.text.includes(FAILURE_SENTINEL)
          ? Promise.reject(classifyPiFailure(new Error(ECHO_FAILURE_MESSAGE), "Pi run failed"))
          : echoRuntime.prompt(input),
      steer: (input) => echoRuntime.steer(input),
      abort: () => echoRuntime.abort(),
      navigateTree: (target) => echoRuntime.navigateTree(target),
      subscribe: (listener) => echoRuntime.subscribe(listener),
      dispose: () => echoRuntime.dispose(),
    };
    const studio = makeStudioInstance(dir, { runtime });
    const { service } = studio;
    const { treeId, trunkId, branchId } = await makeTreeWithAnchoredBranch(service);

    /* 1. 提交 Return：confirmed（deliveredRunId === null）。 */
    const returnText = "RETURN: the branch settled on approach B";
    const submission = await service.submitReturn(treeId, branchId, returnText, "key-failed-prompt-delivery");
    assert.equal(submission.created, true);
    assert.equal(submission.turn.role, "return");
    assert.equal(submission.turn.deliveredRunId, null, "saved, pending adoption");

    /* 2. 带哨兵的 Trunk prompt：以真实 echo /fail 同款的上游错误拒绝。 */
    await assert.rejects(
      () => service.prompt(treeId, trunkId, `${FAILURE_SENTINEL}: will this one fail?`),
      (err: unknown) =>
        err instanceof Error &&
        (err as { code?: unknown }).code === "upstream" &&
        /simulated upstream failure/.test(err.message),
    );

    /* 3. 失败诊断：该 run 收敛 failed（failure.code "upstream"）；运行面
       回到 idle；失败的 prompt 不落任何 turn（Trunk 视图 turn 序不变）。 */
    const diagnostics = service.getTreeDiagnostics(treeId);
    assert.equal(diagnostics.runtimeState, "idle");
    assert.equal(diagnostics.activeRun, null);
    const failedRuns = diagnostics.runs.filter((r) => r.state === "failed");
    assert.equal(failedRuns.length, 1, "exactly the sentinel prompt's run failed");
    const failedRun = failedRuns[0]!;
    assert.equal(failedRun.branchId, trunkId);
    assert.equal(failedRun.failure?.code, "upstream");
    assert.match(failedRun.failure?.message ?? "", /simulated upstream failure/);
    assert.deepEqual(
      findBranchView(service.getTreeState(treeId), trunkId).turns.map((t) => t.role),
      ["user", "assistant", "return"],
      "the failed prompt persists no turns",
    );

    /* 4. Return 仍待送达：失败的 run 绝不标记送达——但它构成一次采用尝试
       （signed v3 §3.2：该 run 的确定输入已包含此 Return；失败尝试不消耗
       Return，pending 重注入语义不变）。 */
    const stateAfterFailure = service.getTreeState(treeId);
    const trunkViewAfterFailure = findBranchView(stateAfterFailure, trunkId);
    const stillPending = trunkViewAfterFailure.turns.find((t) => t.role === "return");
    assert.ok(stillPending !== undefined);
    assert.equal(stillPending.deliveredRunId, null, "the failed run must not deliver the return");
    assert.deepEqual(
      trunkViewAfterFailure.returnAttempts.map((a) => ({ runId: a.runId, runState: a.runState, failure: a.failure?.code ?? null })),
      [{ runId: failedRun.runId, runState: "failed", failure: "upstream" }],
      "the failed run is recorded as an adoption attempt with its outcome",
    );
    const attemptView = trunkViewAfterFailure.returnAttempts[0]!;
    assert.equal(attemptView.turnId, stillPending.id, "the attempt is scoped to the return turn");
    assert.notEqual(attemptView.attemptedAt, "");
    assert.notEqual(attemptView.terminalAt, null, "the failed attempt's run carries a terminal timestamp");

    /* 5. 下一次成功的 Trunk prompt 送达恰一次（同一 runtime 实例：无哨兵
       的 prompt 原样转发给 echo）。 */
    const next = await service.prompt(treeId, trunkId, "next-q");
    assert.equal(next.run.state, "succeeded");
    assert.equal(next.deliveredReturns, 1);
    assert.ok(
      next.assistantTurn.text.includes(returnText),
      `the delivered return is composed into the trunk prompt: ${next.assistantTurn.text}`,
    );
    assert.ok(next.assistantTurn.text.includes("next-q"));
    const delivered = findBranchView(service.getTreeState(treeId), trunkId).turns.find(
      (t) => t.role === "return",
    );
    assert.ok(delivered !== undefined);
    assert.equal(delivered.deliveredRunId, next.run.id, "delivery is bound to the successful run");
    assert.notEqual(delivered.deliveredRunId, failedRun.runId, "never bound to the failed run");

    /* 采用尝试与成功采用并存（signed v3 §3.2）：尝试面完整保留两次
       （失败 + 成功），deliveredRunId 只记录首次成功的那次。 */
    const trunkViewAfterSuccess = findBranchView(service.getTreeState(treeId), trunkId);
    assert.deepEqual(
      trunkViewAfterSuccess.returnAttempts.map((a) => ({ runId: a.runId, runState: a.runState })),
      [
        { runId: failedRun.runId, runState: "failed" },
        { runId: next.run.id, runState: "succeeded" },
      ],
      "both the failed and the first successful run are recorded as adoption attempts",
    );

    /* 6. 再一次 Trunk prompt：不重送（送达恰一次），也不再新增采用尝试
       （成功后不再组装该 Return）。 */
    const final = await service.prompt(treeId, trunkId, "final-q");
    assert.equal(final.deliveredReturns, 0, "the return is never re-sent after delivery");
    assert.equal(
      findBranchView(service.getTreeState(treeId), trunkId).returnAttempts.length,
      2,
      "no further adoption attempt is recorded after the first success",
    );
    await studio.shutdown();
  } finally {
    cleanupDir(dir);
  }
});

test("return persists its target anchor snapshot of the branch origin", async () => {
  const dir = makeTempDataDir();
  try {
    const studio = makeStudioInstance(dir);
    const { service } = studio;
    const { treeId, trunkId, branchId, origin } = await makeTreeWithAnchoredBranch(service);

    const submission = await service.submitReturn(treeId, branchId, "RETURN: anchored", "key-anchor");
    assert.equal(submission.turn.idempotencyKey, "key-anchor");
    assert.deepEqual(submission.turn.targetAnchor, {
      sourceBranchId: origin.sourceBranchId,
      anchorTurnId: origin.anchorTurnId,
      anchorEntryId: origin.anchorEntryId,
      selection: origin.selection,
    });

    /* 读模型同样携带（前端据此在锚点答案附近渲染）。 */
    const state = service.getTreeState(treeId);
    const persisted = findBranchView(state, trunkId).turns.find((t) => t.role === "return");
    assert.ok(persisted !== undefined);
    assert.deepEqual(persisted.targetAnchor, submission.turn.targetAnchor);
    await studio.shutdown();
  } finally {
    cleanupDir(dir);
  }
});

test("repository-level return without a key still round-trips (legacy shape)", async () => {
  const dir = makeTempDataDir();
  try {
    const studio = makeStudioInstance(dir);
    const { service, repository } = studio;
    const created = service.createTree();
    const branch = repository.createBranch(created.tree.id, { parentBranchId: created.trunkBranch.id });
    const episode = repository.createEpisode(created.trunkBranch.id);
    const turn = repository.createTurn({
      treeId: created.tree.id,
      branchId: created.trunkBranch.id,
      episodeId: episode.id,
      role: "return",
      text: "legacy return without a key",
      fromBranchId: branch.id,
    });
    assert.equal(turn.idempotencyKey, null);
    assert.equal(turn.targetAnchor, null);
    assert.equal(repository.findReturnByIdempotencyKey(created.tree.id, "any-key"), null);
    await studio.shutdown();
  } finally {
    cleanupDir(dir);
  }
});
