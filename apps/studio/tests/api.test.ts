/**
 * Studio HTTP 面测试：真实 node:http 服务（随机端口）+ fetch + 离线 echo 驱动。
 *
 * 覆盖：静态页、健康检查、Tree CRUD、prompt、anchored branch、switch、
 * return（含 delivery）、错误码映射（400/404）、以及整进程重启恢复
 * （同一数据目录上重建 server + service + repo 后树状态与续聊能力完整）。
 * 外加 return 失败/重试一致性回归：session 文件缺失时 502 发生在任何
 * Return 落库之前，同一失败上重试不产生重复 Return。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BranchId } from "@treeai/contracts";
import { createStudioServer } from "../src/server.ts";
import { cleanupDir, makeStudioInstance, makeTempDataDir, type StudioInstance } from "./helpers.ts";

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
async function startStudio(dir: string, registry: RunningStudio[]): Promise<RunningStudio> {
  const studio = makeStudioInstance(dir);
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

    /* 切回 Trunk 并提交 return。 */
    const switchRes = await call(studio.url(treePath("switch")), "POST", { branchId: trunkBranchId });
    assert.equal(switchRes.status, 200);
    assert.equal(switchRes.body.cursor.branchId, trunkBranchId);

    const returnRes = await call(studio.url(treePath("return")), "POST", {
      fromBranchId: branchId,
      text: "RETURN: use hi",
    });
    assert.equal(returnRes.status, 201);
    assert.equal(returnRes.body.returnTurn.branchId, trunkBranchId);
    assert.equal(returnRes.body.returnTurn.fromBranchId, branchId);
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

test("return with a missing Pi session file: 502 before any write; retry creates no duplicate Return", async () => {
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

    /* 第一次提交 Return：导航回 Trunk 无法恢复缺失的 session 文件
       → 502 session-corrupt，且 Return 尚未写入。 */
    const first = await call(studio2.url(treePath("return")), "POST", {
      fromBranchId: branchId,
      text: "RETURN: use hi",
    });
    assert.equal(first.status, 502);
    assert.equal(first.body.error.code, "session-corrupt");

    /* 同一失败上重试：仍 502，且仍零条 Return（不产生重复）。 */
    const retry = await call(studio2.url(treePath("return")), "POST", {
      fromBranchId: branchId,
      text: "RETURN: use hi",
    });
    assert.equal(retry.status, 502);
    assert.equal(retry.body.error.code, "session-corrupt");
    assert.equal(countPersistedReturns(), 0, "no Return turn persisted after two failed submissions");
    const failedState = await call(studio2.url(treePath("state")), "GET");
    assert.equal(
      failedState.body.branches.flatMap((view: any) => view.turns).filter((turn: any) => turn.role === "return").length,
      0,
      "product state agrees: no Return turns visible",
    );

    /* session 文件恢复（缺失可修复）后重试：Return 恰好落库一次，
       cursor 一致地在 Trunk，下一次 Trunk prompt 正常送达。 */
    writeFileSync(sessionFile, sessionContent, "utf8");
    const recovered = await call(studio2.url(treePath("return")), "POST", {
      fromBranchId: branchId,
      text: "RETURN: use hi",
    });
    assert.equal(recovered.status, 201);
    assert.equal(recovered.body.returnTurn.branchId, trunkBranchId);
    assert.equal(recovered.body.returnTurn.fromBranchId, branchId);
    assert.equal(recovered.body.state.cursor.branchId, trunkBranchId, "trunk cursor consistency after success");
    assert.equal(countPersistedReturns(), 1, "exactly one Return turn after the successful retry");

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
