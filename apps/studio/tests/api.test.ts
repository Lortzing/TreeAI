/**
 * Studio HTTP 面测试：真实 node:http 服务（随机端口）+ fetch + 离线 echo 驱动。
 *
 * 覆盖：静态页、健康检查、Tree CRUD、prompt、anchored branch、switch、
 * return（含 delivery）、错误码映射（400/404）、以及整进程重启恢复
 * （同一数据目录上重建 server + service + repo 后树状态与续聊能力完整）。
 * 外加 return 失败/重试一致性回归：session 文件缺失时 502 发生在任何
 * Return 落库之前，同一失败上重试不产生重复 Return。
 * 外加 Return 幂等（idempotencyKey 必填）：201 新建 / 200 同键同内容
 * 重放 / 409 return-conflict（同键异容）/ 400 缺键或空白键；响应丢失
 * 重发与双击（并发相同 POST）收敛为恰一条 Return。
 * 外加 A5 诊断面：GET diagnostics 安全投影（无 session 引用/详情/cause）、
 * POST runs/:runId/abort 的 404/400/409 映射、在途 abort 的 user-abort
 * 收敛（409 + run 落库 aborted）、并发 prompt 冲突、I6 恢复 run 的
 * 失败码+消息投影。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BranchId, PiEntryId, PiSessionId, PiVersion } from "@treeai/contracts";
import { createStudioServer } from "../src/server.ts";
import {
  cleanupDir,
  makeStudioInstance,
  makeTempDataDir,
  type StudioInstance,
  type StudioInstanceOptions,
} from "./helpers.ts";

const staticDir = fileURLToPath(new URL("../public/", import.meta.url));

interface JsonOutcome {
  status: number;
  body: any;
}

async function call(url: string, method: string, body?: unknown): Promise<JsonOutcome> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed: any = null;
  try {
    parsed = await response.json();
  } catch {
    /* 非 JSON 响应体 */
  }
  return { status: response.status, body: parsed };
}

interface RunningStudio {
  port: number;
  /** 底层实例（repository 直读 SQLite，用于持久化断言）。 */
  instance: StudioInstance;
  url(path: string): string;
  close(): Promise<void>;
}

/**
 * 启动一个 studio 实例并登记到 registry；测试的 finally 里统一关闭，
 * 保证断言失败时监听中的 server 不会挂住测试进程。
 */
async function startStudio(
  dir: string,
  registry: RunningStudio[],
  options?: StudioInstanceOptions,
): Promise<RunningStudio> {
  const studio = makeStudioInstance(dir, options);
  const server = createStudioServer({ service: studio.service, staticDir });
  const port = await server.listen(0);
  let closed = false;
  const running: RunningStudio = {
    port,
    instance: studio,
    url: (path: string) => `http://127.0.0.1:${port}${path}`,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await server.close();
      await studio.shutdown();
    },
  };
  registry.push(running);
  return running;
}

async function closeAll(registry: RunningStudio[]): Promise<void> {
  for (const running of registry) {
    try {
      await running.close();
    } catch {
      /* 关闭失败不掩盖测试断言失败 */
    }
  }
}

/** 造一棵带锚定分支的树（Trunk 一问一答 + 分支一轮），供 Return 幂等类测试复用。 */
async function makeTreeWithAnchoredBranch(studio: RunningStudio) {
  const created = await call(studio.url("/api/trees"), "POST", {});
  const treeId: string = created.body.tree.id;
  const trunkBranchId: string = created.body.trunkBranchId;
  const treePath = (action?: string) =>
    `/api/trees/${encodeURIComponent(treeId)}${action === undefined ? "" : `/${action}`}`;
  const t1 = await call(studio.url(treePath("prompt")), "POST", { branchId: trunkBranchId, text: "hi" });
  const answer = t1.body.outcome.assistantTurn;
  const branchRes = await call(studio.url(treePath("branches")), "POST", {
    sourceBranchId: trunkBranchId,
    anchorTurnId: answer.id,
    selection: { start: 0, end: 2, text: answer.text.slice(0, 2) },
  });
  const branchId: string = branchRes.body.branch.id;
  await call(studio.url(treePath("prompt")), "POST", { branchId, text: "b1" });
  return { treeId, trunkBranchId, branchId, treePath };
}

test("HTTP API serves the UI and the full D3 flow, surviving a restart", async () => {
  const dir = makeTempDataDir();
  const running: RunningStudio[] = [];
  try {
    const studio = await startStudio(dir, running);

    /* 静态页与健康检查。 */
    const index = await fetch(studio.url("/"));
    assert.equal(index.status, 200);
    assert.match(index.headers.get("content-type") ?? "", /text\/html/);
    assert.ok((await index.text()).includes("TreeAI Studio"));
    const health = await call(studio.url("/api/health"), "GET");
    assert.equal(health.status, 200);
    assert.deepEqual(health.body, { ok: true });

    /* 空 Tree 列表 → 创建 → 列表。 */
    assert.deepEqual((await call(studio.url("/api/trees"), "GET")).body, { trees: [] });
    const created = await call(studio.url("/api/trees"), "POST", {});
    assert.equal(created.status, 201);
    const treeId: string = created.body.tree.id;
    const trunkBranchId: string = created.body.trunkBranchId;
    assert.equal(created.body.state.branches.length, 1);
    const listed = await call(studio.url("/api/trees"), "GET");
    assert.equal(listed.body.trees.length, 1);

    const treePath = (action?: string) =>
      `/api/trees/${encodeURIComponent(treeId)}${action === undefined ? "" : `/${action}`}`;

    /* Trunk prompt。 */
    const t1 = await call(studio.url(treePath("prompt")), "POST", { branchId: trunkBranchId, text: "hi" });
    assert.equal(t1.status, 200);
    assert.equal(t1.body.outcome.assistantTurn.text, "echo:[hi]");
    assert.equal(t1.body.outcome.run.state, "succeeded");
    const anchorTurnId: string = t1.body.outcome.assistantTurn.id;
    const anchorText: string = t1.body.outcome.assistantTurn.text;

    /* 从锚定选区创建 Branch 并续聊。 */
    const branchRes = await call(studio.url(treePath("branches")), "POST", {
      sourceBranchId: trunkBranchId,
      anchorTurnId,
      selection: { start: 0, end: 2, text: anchorText.slice(0, 2) },
    });
    assert.equal(branchRes.status, 201);
    const branchId: string = branchRes.body.branch.id;
    assert.equal(branchRes.body.origin.anchorTurnId, anchorTurnId);

    const b1 = await call(studio.url(treePath("prompt")), "POST", { branchId, text: "b1" });
    assert.equal(b1.status, 200);
    assert.equal(b1.body.outcome.assistantTurn.text, "echo:[hi|b1]");

    const source = await call(
      studio.url(`/api/trees/${encodeURIComponent(treeId)}/branches/${encodeURIComponent(branchId)}/source`),
      "POST",
    );
    assert.equal(source.status, 200);
    assert.equal(source.body.source.status, "available");
    assert.equal(source.body.source.sourceBranchId, trunkBranchId);
    assert.equal(source.body.source.anchorTurnId, anchorTurnId);
    assert.equal(source.body.state.cursor.branchId, trunkBranchId);

    /* 切回 Trunk 并提交 return。 */
    const switchRes = await call(studio.url(treePath("switch")), "POST", { branchId: trunkBranchId });
    assert.equal(switchRes.status, 200);
    assert.equal(switchRes.body.cursor.branchId, trunkBranchId);

    const returnRes = await call(studio.url(treePath("return")), "POST", {
      fromBranchId: branchId,
      text: "RETURN: use hi",
      idempotencyKey: "key-main-flow",
    });
    assert.equal(returnRes.status, 201);
    assert.equal(returnRes.body.returnTurn.branchId, trunkBranchId);
    assert.equal(returnRes.body.returnTurn.fromBranchId, branchId);
    assert.equal(returnRes.body.returnTurn.idempotencyKey, "key-main-flow");
    assert.ok(returnRes.body.returnTurn.targetAnchor !== null);
    assert.equal(returnRes.body.returnTurn.targetAnchor.anchorTurnId, anchorTurnId);
    assert.equal(returnRes.body.navigation.status, "navigated", "save-then-navigate: the response separates the navigation result");
    assert.equal(returnRes.body.state.cursor.branchId, trunkBranchId);

    /* 下一次 Trunk prompt 送达 return。 */
    const t2 = await call(studio.url(treePath("prompt")), "POST", { branchId: trunkBranchId, text: "t2" });
    assert.equal(t2.status, 200);
    assert.equal(t2.body.outcome.deliveredReturns, 1);
    assert.ok(t2.body.outcome.assistantTurn.text.includes("RETURN: use hi"));

    /* 错误码映射。 */
    const noText = await call(studio.url(treePath("prompt")), "POST", { branchId: trunkBranchId });
    assert.equal(noText.status, 400);
    assert.equal(noText.body.error.code, "invalid-argument");
    const unknownTree = await call(studio.url(`/api/trees/${encodeURIComponent("tree-missing")}/state`), "GET");
    assert.equal(unknownTree.status, 404);
    assert.equal(unknownTree.body.error.code, "not-found");
    const badSelection = await call(studio.url(treePath("branches")), "POST", {
      sourceBranchId: trunkBranchId,
      anchorTurnId,
      selection: { start: 0, end: 3, text: "WRONG" },
    });
    assert.equal(badSelection.status, 400);
    const trunkReturn = await call(studio.url(treePath("return")), "POST", {
      fromBranchId: trunkBranchId,
      text: "not allowed",
      idempotencyKey: "key-trunk-rejected",
    });
    assert.equal(trunkReturn.status, 400);
    const unknownRoute = await call(studio.url("/api/nope"), "GET");
    assert.equal(unknownRoute.status, 404);

    /* 重启：同一数据目录上整进程重建（新 repo + 新 runtime + 新 server）。 */
    const stateBefore = await call(studio.url(treePath("state")), "GET");
    await studio.close();

    const studio2 = await startStudio(dir, running);
    const relisted = await call(studio2.url("/api/trees"), "GET");
    assert.equal(relisted.body.trees.length, 1);
    assert.equal(relisted.body.trees[0].id, treeId);

    /* 产品状态（branches/origins/turns/cursor）跨重启完整。 */
    const stateAfter = await call(studio2.url(treePath("state")), "GET");
    assert.deepEqual(stateAfter.body.cursor, stateBefore.body.cursor);
    assert.deepEqual(
      { tree: stateAfter.body.tree, trunkBranchId: stateAfter.body.trunkBranchId, branches: stateAfter.body.branches },
      { tree: stateBefore.body.tree, trunkBranchId: stateBefore.body.trunkBranchId, branches: stateBefore.body.branches },
      "product state survives a restart",
    );

    /* 重启后分支续聊（restoreSession 路径）。 */
    const b2 = await call(studio2.url(treePath("prompt")), "POST", { branchId, text: "b2" });
    assert.equal(b2.status, 200);
    assert.equal(b2.body.outcome.assistantTurn.text, "echo:[hi|b1|b2]");

    /* 切回 Trunk 后 cursor 重建到与重启前相同的续聊点（b2 新增了 turns，
       故此处只比较 cursor——它证明重启后 navigateTree 恢复到同一叶位置）。 */
    await call(studio2.url(treePath("switch")), "POST", { branchId: trunkBranchId });
    const stateAfterSwitch = await call(studio2.url(treePath("state")), "GET");
    assert.deepEqual(stateAfterSwitch.body.cursor, stateBefore.body.cursor);
  } finally {
    await closeAll(running);
    cleanupDir(dir);
  }
});

test("return with a missing Pi session file: saved first (201), navigation failed in the response; same-key retries replay without duplicates (signed v3 §3.5)", async () => {
  const dir = makeTempDataDir();
  const running: RunningStudio[] = [];
  try {
    const studio = await startStudio(dir, running);
    const created = await call(studio.url("/api/trees"), "POST", {});
    const treeId: string = created.body.tree.id;
    const trunkBranchId: string = created.body.trunkBranchId;
    const treePath = (action?: string) =>
      `/api/trees/${encodeURIComponent(treeId)}${action === undefined ? "" : `/${action}`}`;

    /* 建立带 session 文件的树：Trunk prompt → 锚定分支 → 分支 prompt。 */
    const t1 = await call(studio.url(treePath("prompt")), "POST", { branchId: trunkBranchId, text: "hi" });
    assert.equal(t1.status, 200);
    const branchRes = await call(studio.url(treePath("branches")), "POST", {
      sourceBranchId: trunkBranchId,
      anchorTurnId: t1.body.outcome.assistantTurn.id,
      selection: { start: 0, end: 2, text: t1.body.outcome.assistantTurn.text.slice(0, 2) },
    });
    assert.equal(branchRes.status, 201);
    const branchId: string = branchRes.body.branch.id;
    const b1 = await call(studio.url(treePath("prompt")), "POST", { branchId, text: "b1" });
    assert.equal(b1.status, 200);

    /* 整进程重启（内存 cursor 清空，回 Trunk 的导航走 restoreSession）。 */
    await studio.close();

    /* 破坏 Pi session 存储：session 文件缺失（保留内容供稍后恢复）。 */
    const sessionsDir = join(dir, "sessions");
    const sessionFiles = readdirSync(sessionsDir);
    assert.equal(sessionFiles.length, 1, "one session file per tree");
    const sessionFile = join(sessionsDir, sessionFiles[0]!);
    const sessionContent = readFileSync(sessionFile, "utf8");
    rmSync(sessionFile);

    const studio2 = await startStudio(dir, running);
    const countPersistedReturns = (): number =>
      studio2.instance.repository.listTurns(trunkBranchId as BranchId).filter((turn) => turn.role === "return").length;

    /* 重启后基线游标（持久化的活动导航——仍指向分支续聊点）。 */
    const baselineState = await call(studio2.url(treePath("state")), "GET");
    const baselineCursor = baselineState.body.cursor;

    /* 第一次提交 Return：保存先于导航——Return 落库（201），导航失败作为
       分离结果随 navigation 字段返回（不是 HTTP 错误）。 */
    const first = await call(studio2.url(treePath("return")), "POST", {
      fromBranchId: branchId,
      text: "RETURN: use hi",
      idempotencyKey: "key-missing-session",
    });
    assert.equal(first.status, 201, "the save succeeds although the session file is missing");
    assert.equal(first.body.returnTurn.branchId, trunkBranchId);
    assert.equal(first.body.navigation.status, "failed", "navigation fails separately from the save");
    assert.equal(first.body.navigation.code, "session-corrupt");
    assert.match(first.body.navigation.message, /session/i);
    assert.equal(countPersistedReturns(), 1, "the Return is persisted before navigation runs");

    /* 同键重试（session 仍缺失）：200 重放同一 Return，导航再次失败，
       零新写入。 */
    const retry = await call(studio2.url(treePath("return")), "POST", {
      fromBranchId: branchId,
      text: "RETURN: use hi",
      idempotencyKey: "key-missing-session",
    });
    assert.equal(retry.status, 200, "the same-key retry replays the saved Return");
    assert.equal(retry.body.returnTurn.id, first.body.returnTurn.id);
    assert.equal(retry.body.navigation.status, "failed");
    assert.equal(retry.body.navigation.code, "session-corrupt");
    assert.equal(countPersistedReturns(), 1, "no duplicate Return after the retry");
    const brokenState = await call(studio2.url(treePath("state")), "GET");
    assert.equal(
      brokenState.body.branches.flatMap((view: any) => view.turns).filter((turn: any) => turn.role === "return").length,
      1,
      "product state agrees: exactly one Return turn is visible",
    );
    assert.deepEqual(
      brokenState.body.cursor,
      baselineCursor,
      "the failed navigation leaves the cursor exactly where it was (still on the branch)",
    );

    /* session 文件恢复（缺失可修复）后同键重试：仍 200 重放（保存早已
       完成），这次导航成功——重试即重新导航的载体；下一次 Trunk prompt
       正常送达。 */
    writeFileSync(sessionFile, sessionContent, "utf8");
    const recovered = await call(studio2.url(treePath("return")), "POST", {
      fromBranchId: branchId,
      text: "RETURN: use hi",
      idempotencyKey: "key-missing-session",
    });
    assert.equal(recovered.status, 200, "restore + retry still replays (no duplicate)");
    assert.equal(recovered.body.returnTurn.id, first.body.returnTurn.id);
    assert.equal(recovered.body.navigation.status, "navigated", "the retry navigates once the session is restored");
    assert.equal(recovered.body.state.cursor.branchId, trunkBranchId, "trunk cursor consistency after the replay's navigation");
    assert.equal(countPersistedReturns(), 1, "still exactly one Return turn");

    const t2 = await call(studio2.url(treePath("prompt")), "POST", { branchId: trunkBranchId, text: "t2" });
    assert.equal(t2.status, 200);
    assert.equal(t2.body.outcome.deliveredReturns, 1);
    assert.ok(t2.body.outcome.assistantTurn.text.includes("RETURN: use hi"));
  } finally {
    await closeAll(running);
    cleanupDir(dir);
  }
});

test("HTTP layer rejects malformed bodies and unknown routes predictably", async () => {
  const dir = makeTempDataDir();
  const running: RunningStudio[] = [];
  try {
    const studio = await startStudio(dir, running);
    const created = await call(studio.url("/api/trees"), "POST", {});
    const treeId: string = created.body.tree.id;
    const trunkBranchId: string = created.body.trunkBranchId;
    const treePath = (action?: string) =>
      `/api/trees/${encodeURIComponent(treeId)}${action === undefined ? "" : `/${action}`}`;

    /* 非 JSON 请求体。 */
    const raw = await fetch(studio.url(treePath("prompt")), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    assert.equal(raw.status, 400);

    /* 缺少必填字段。 */
    const missing = await call(studio.url(treePath("prompt")), "POST", { text: "no branch" });
    assert.equal(missing.status, 400);
    assert.match(missing.body.error.message, /branchId/);

    /* 未知分支 prompt → 404。 */
    const unknownBranch = await call(studio.url(treePath("prompt")), "POST", {
      branchId: "branch-missing",
      text: "q",
    });
    assert.equal(unknownBranch.status, 404);

    /* 不支持的动词。 */
    const wrongMethod = await call(studio.url("/api/trees"), "DELETE");
    assert.equal(wrongMethod.status, 405);

    /* 未知静态文件仍走 API 404。 */
    const unknownStatic = await fetch(studio.url("/unknown.js"));
    assert.equal(unknownStatic.status, 404);
  } finally {
    await closeAll(running);
    cleanupDir(dir);
  }
});

test("diagnostics and abort endpoints: safe projection, 404/400/409, user-abort convergence", async () => {
  const dir = makeTempDataDir();
  const running: RunningStudio[] = [];
  try {
    // 拉宽 echo 在途窗口（turnDelayMs），让在途观测/abort 确定性成立。
    const studio = await startStudio(dir, running, { echoTurnDelayMs: 25 });

    const created = await call(studio.url("/api/trees"), "POST", {});
    const treeId: string = created.body.tree.id;
    const trunkBranchId: string = created.body.trunkBranchId;
    const treePath = (action?: string) => `/api/trees/${encodeURIComponent(treeId)}${action ?? ""}`;

    /* 新树诊断面：idle、无在途、无 run、如实报告未观测策略决策。 */
    const diag0 = await call(studio.url(treePath("/diagnostics")), "GET");
    assert.equal(diag0.status, 200);
    assert.equal(diag0.body.runtimeState, "idle");
    assert.equal(diag0.body.activeRun, null);
    assert.deepEqual(diag0.body.runs, []);
    assert.equal(diag0.body.policyDecisions.observed, false);
    assert.ok(
      typeof diag0.body.policyDecisions.reason === "string" && diag0.body.policyDecisions.reason.length > 0,
    );

    /* 一次成功 prompt → 诊断面出现安全投影的 run 行（键集合精确锁定）。 */
    const t1 = await call(studio.url(treePath("/prompt")), "POST", { branchId: trunkBranchId, text: "hi" });
    assert.equal(t1.status, 200);
    const diag1 = await call(studio.url(treePath("/diagnostics")), "GET");
    assert.equal(diag1.body.runs.length, 1);
    const runView = diag1.body.runs[0];
    assert.deepEqual(
      Object.keys(runView).sort(),
      ["branchId", "createdAt", "episodeId", "failure", "runId", "state", "terminalAt"],
    );
    assert.equal(runView.state, "succeeded");
    assert.equal(runView.failure, null);
    assert.equal(runView.branchId, trunkBranchId);
    const serialized = JSON.stringify(diag1.body);
    for (const forbidden of ["sessionFile", "sessionId", "entryId", "piVersion", "availability", "details", "cause"]) {
      assert.ok(!serialized.includes(forbidden), `diagnostics must not expose '${forbidden}'`);
    }

    /* 404 / 405 映射。 */
    const unknownTreeDiag = await call(
      studio.url(`/api/trees/${encodeURIComponent("tree-missing")}/diagnostics`),
      "GET",
    );
    assert.equal(unknownTreeDiag.status, 404);
    assert.equal((await call(studio.url(treePath("/diagnostics")), "POST", {})).status, 405);
    const abortUnknownTree = await call(
      studio.url(`/api/trees/${encodeURIComponent("tree-missing")}/runs/${encodeURIComponent("run-x")}/abort`),
      "POST",
    );
    assert.equal(abortUnknownTree.status, 404);
    const abortUnknownRun = await call(
      studio.url(treePath(`/runs/${encodeURIComponent("run-missing")}/abort`)),
      "POST",
    );
    assert.equal(abortUnknownRun.status, 404);

    /* 已终态 run 的 abort → 409 conflict；错误动词 → 405。 */
    const doneRunId: string = diag1.body.runs[0].runId;
    const abortTerminal = await call(
      studio.url(treePath(`/runs/${encodeURIComponent(doneRunId)}/abort`)),
      "POST",
    );
    assert.equal(abortTerminal.status, 409);
    assert.equal(abortTerminal.body.error.code, "conflict");
    const abortWrongMethod = await call(
      studio.url(treePath(`/runs/${encodeURIComponent(doneRunId)}/abort`)),
      "GET",
    );
    assert.equal(abortWrongMethod.status, 405);

    /* 跨树 run 的 abort → 400。 */
    const other = await call(studio.url("/api/trees"), "POST", {});
    const otherPrompt = await call(
      studio.url(`/api/trees/${encodeURIComponent(other.body.tree.id)}/prompt`),
      "POST",
      { branchId: other.body.trunkBranchId, text: "x" },
    );
    assert.equal(otherPrompt.status, 200);
    const crossTree = await call(
      studio.url(treePath(`/runs/${encodeURIComponent(otherPrompt.body.outcome.run.id)}/abort`)),
      "POST",
    );
    assert.equal(crossTree.status, 400);

    /* 在途 run：诊断面 streaming；abort 200；prompt 以 409 user-abort
       收敛（不改写为 failed/502），run 落库 aborted，无 turn。 */
    const promptPromise = call(studio.url(treePath("/prompt")), "POST", {
      branchId: trunkBranchId,
      text: "in-flight",
    });
    let activeRunId: string | null = null;
    for (let i = 0; i < 100 && activeRunId === null; i += 1) {
      const diag = await call(studio.url(treePath("/diagnostics")), "GET");
      if (diag.body.activeRun !== null) {
        assert.equal(diag.body.runtimeState, "streaming");
        assert.equal(diag.body.activeRun.branchId, trunkBranchId);
        activeRunId = diag.body.activeRun.runId;
      }
    }
    assert.ok(activeRunId !== null, "diagnostics must expose the in-flight run");

    const abortRes = await call(
      studio.url(treePath(`/runs/${encodeURIComponent(activeRunId)}/abort`)),
      "POST",
    );
    assert.equal(abortRes.status, 200);
    assert.deepEqual(abortRes.body, { ok: true });

    const promptRes = await promptPromise;
    assert.equal(promptRes.status, 409);
    assert.equal(promptRes.body.error.code, "user-abort");

    const diag2 = await call(studio.url(treePath("/diagnostics")), "GET");
    assert.equal(diag2.body.runtimeState, "idle");
    assert.equal(diag2.body.activeRun, null);
    const abortedView = diag2.body.runs.find((r: any) => r.runId === activeRunId);
    assert.ok(abortedView !== undefined);
    assert.equal(abortedView.state, "aborted");
    assert.equal(abortedView.failure, null);

    const stateAfter = await call(studio.url(treePath("/state")), "GET");
    const trunkTurns = stateAfter.body.branches.find((v: any) => v.branch.id === trunkBranchId).turns;
    assert.deepEqual(
      trunkTurns.map((t: any) => t.role),
      ["user", "assistant"],
      "the aborted prompt persists no turns",
    );

    /* 并发 prompt → 409（单用户冲突语义），且不产生幽灵 run。 */
    const runsBefore: number = diag2.body.runs.length;
    const p1 = call(studio.url(treePath("/prompt")), "POST", { branchId: trunkBranchId, text: "c1" });
    let concurrentActive: string | null = null;
    for (let i = 0; i < 100 && concurrentActive === null; i += 1) {
      const diag = await call(studio.url(treePath("/diagnostics")), "GET");
      if (diag.body.activeRun !== null) concurrentActive = diag.body.activeRun.runId;
    }
    assert.ok(concurrentActive !== null);
    const concurrent = await call(studio.url(treePath("/prompt")), "POST", {
      branchId: trunkBranchId,
      text: "c2",
    });
    assert.equal(concurrent.status, 409);
    assert.equal(concurrent.body.error.code, "conflict");
    const r1 = await p1;
    assert.equal(r1.status, 200);
    const diag3 = await call(studio.url(treePath("/diagnostics")), "GET");
    assert.equal(diag3.body.runs.length, runsBefore + 1, "the rejected concurrent prompt creates no phantom run");

    /* 失败投影 + I6 恢复：宿主崩溃残留 run 重启后收敛 failed，
       诊断面只投影 code+message（details/路径不外泄）。 */
    const episode = studio.instance.repository.createEpisode(trunkBranchId as BranchId);
    const interrupted = studio.instance.repository.createRun(episode.id, {
      sessionId: "session-secret-id" as PiSessionId,
      sessionFile: "/Users/tal/Projects/secret-session.jsonl",
      entryId: "entry-secret" as PiEntryId,
      piVersion: "0.85.1" as PiVersion,
      availability: { status: "available" },
    });
    await studio.close();

    const studio2 = await startStudio(dir, running, { echoTurnDelayMs: 25 });
    const diag4 = await call(studio2.url(treePath("/diagnostics")), "GET");
    const recovered = diag4.body.runs.find((r: any) => r.runId === interrupted.id);
    assert.ok(recovered !== undefined);
    assert.equal(recovered.state, "failed");
    assert.deepEqual(Object.keys(recovered.failure).sort(), ["code", "message"]);
    assert.equal(recovered.failure.code, "unknown");
    const serialized4 = JSON.stringify(diag4.body);
    assert.ok(!serialized4.includes("hostInterrupted"), "failure details must not leak");
    assert.ok(!serialized4.includes("secret-session"), "session file paths must not leak");
  } finally {
    await closeAll(running);
    cleanupDir(dir);
  }
});

test("return idempotency over HTTP: 201 create, 200 replay, 409 conflict, 400 missing key", async () => {
  const dir = makeTempDataDir();
  const running: RunningStudio[] = [];
  try {
    const studio = await startStudio(dir, running);
    const { trunkBranchId, branchId, treePath } = await makeTreeWithAnchoredBranch(studio);
    const countReturns = () =>
      studio.instance.repository.listTurns(trunkBranchId as BranchId).filter((t) => t.role === "return").length;

    /* 新建 → 201（body 含 returnTurn 与完整 state）。 */
    const first = await call(studio.url(treePath("return")), "POST", {
      fromBranchId: branchId,
      text: "RETURN: use hi",
      idempotencyKey: "key-api",
    });
    assert.equal(first.status, 201);
    assert.equal(first.body.returnTurn.idempotencyKey, "key-api");
    assert.ok(first.body.returnTurn.targetAnchor !== null);
    assert.ok(first.body.state !== undefined);

    /* 同键同内容重放 → 200，同一 returnTurn，仍恰一条 Return。 */
    const replay = await call(studio.url(treePath("return")), "POST", {
      fromBranchId: branchId,
      text: "RETURN: use hi",
      idempotencyKey: "key-api",
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.returnTurn.id, first.body.returnTurn.id);
    assert.equal(countReturns(), 1, "exactly one return row after the replay");

    /* 同键不同文本 → 409 return-conflict；消息含键、既有 turn id 与内容差异。 */
    const conflict = await call(studio.url(treePath("return")), "POST", {
      fromBranchId: branchId,
      text: "RETURN: different text",
      idempotencyKey: "key-api",
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, "return-conflict");
    assert.ok(conflict.body.error.message.includes("key-api"));
    assert.ok(conflict.body.error.message.includes(first.body.returnTurn.id));
    assert.ok(conflict.body.error.message.includes("different content"));
    assert.equal(countReturns(), 1, "the conflict persists nothing");

    /* 幂等键缺失/空白 → 400 invalid-argument（字段名进消息）。 */
    const missingKey = await call(studio.url(treePath("return")), "POST", {
      fromBranchId: branchId,
      text: "RETURN: no key",
    });
    assert.equal(missingKey.status, 400);
    assert.equal(missingKey.body.error.code, "invalid-argument");
    assert.match(missingKey.body.error.message, /idempotencyKey/);
    for (const badKey of ["", "   "]) {
      const bad = await call(studio.url(treePath("return")), "POST", {
        fromBranchId: branchId,
        text: "RETURN: bad key",
        idempotencyKey: badKey,
      });
      assert.equal(bad.status, 400);
    }
    assert.equal(countReturns(), 1, "invalid keys persist nothing");
  } finally {
    await closeAll(running);
    cleanupDir(dir);
  }
});

test("response-loss resubmit and double-click converge to exactly one return", async () => {
  const dir = makeTempDataDir();
  const running: RunningStudio[] = [];
  try {
    const studio = await startStudio(dir, running);
    const { trunkBranchId, branchId, treePath } = await makeTreeWithAnchoredBranch(studio);
    const countReturns = () =>
      studio.instance.repository.listTurns(trunkBranchId as BranchId).filter((t) => t.role === "return").length;

    /* 响应丢失：第一次提交服务端已成功（201），响应体按“未达客户端”
       处理（不复用其内容）；同键同文本重发 → 200 重放，同一条 Return。 */
    const lost = await call(studio.url(treePath("return")), "POST", {
      fromBranchId: branchId,
      text: "RETURN: lost response",
      idempotencyKey: "key-response-loss",
    });
    assert.equal(lost.status, 201);
    const resubmit = await call(studio.url(treePath("return")), "POST", {
      fromBranchId: branchId,
      text: "RETURN: lost response",
      idempotencyKey: "key-response-loss",
    });
    assert.equal(resubmit.status, 200);
    assert.equal(resubmit.body.returnTurn.id, lost.body.returnTurn.id);
    assert.equal(countReturns(), 1, "exactly one return after response loss + resubmit");

    /* 双击：两个并发的相同 POST（同键同文本）→ 一胜（201）一重放（200），
       恰一条 Return。 */
    const [click1, click2] = await Promise.all([
      call(studio.url(treePath("return")), "POST", {
        fromBranchId: branchId,
        text: "RETURN: double click",
        idempotencyKey: "key-double-click",
      }),
      call(studio.url(treePath("return")), "POST", {
        fromBranchId: branchId,
        text: "RETURN: double click",
        idempotencyKey: "key-double-click",
      }),
    ]);
    assert.deepEqual(
      [click1.status, click2.status].sort(),
      [200, 201],
      "one concurrent POST creates (201), the other replays (200)",
    );
    assert.equal(click1.body.returnTurn.id, click2.body.returnTurn.id);
    assert.equal(countReturns(), 2, "the double click persists exactly one more return (2 total)");

    /* 状态读模型一致：全树恰两条 Return（response-loss 与 double-click 各一）。 */
    const state = await call(studio.url(treePath("state")), "GET");
    const returnsInView = state.body.branches
      .flatMap((view: any) => view.turns)
      .filter((turn: any) => turn.role === "return");
    assert.equal(returnsInView.length, 2);
    for (const turn of returnsInView) {
      assert.ok(turn.idempotencyKey !== null && turn.targetAnchor !== null);
    }
  } finally {
    await closeAll(running);
    cleanupDir(dir);
  }
});
