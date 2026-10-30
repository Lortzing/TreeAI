import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createStudioServer } from "../src/server.ts";
import { exportPackage, restorePackage } from "../src/portability/index.ts";
import { cleanupDir, makeStudioInstance, makeTempDataDir } from "./helpers.ts";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("ordinary prompt keys reconcile during execution, reject changed payloads and remain Tree-scoped", async () => {
  const dir = makeTempDataDir(), instance = makeStudioInstance(dir, { echoTurnDelayMs: 40 });
  const { service, repository } = instance;
  try {
    const { tree, trunkBranch } = service.createTree();
    const first = service.submitPromptRequest(tree.id, trunkBranch.id, "original", "same-key");
    const accepted = service.getPromptRequest(tree.id, "same-key");
    assert.equal(accepted?.status, "accepted", "acceptance precedes asynchronous session alignment");
    const replay = await service.submitPromptRequest(tree.id, trunkBranch.id, "original", "same-key");
    assert.ok(["accepted", "queued", "running"].includes(replay.status));
    for (const options of [{ model: { providerId: "other", modelId: "model" } }, { composedPrefix: "other attachment version" }, {}]) {
      await assert.rejects(service.submitPromptRequest(tree.id, trunkBranch.id, options.model || options.composedPrefix ? "original" : "edited", "same-key", options), TypeError);
    }
    await assert.rejects(service.submitPromptRequest(tree.id, trunkBranch.id, "original", "other-key"), TypeError);
    assert.equal(service.getPromptRequest(tree.id, "other-key"), null, "busy refusal is not acceptance");
    const result = await first;
    assert.equal(result.status, "succeeded");
    assert.deepEqual(await service.submitPromptRequest(tree.id, trunkBranch.id, "original", "same-key"), result);
    assert.equal(repository.listEpisodes(trunkBranch.id).length, 1);
    assert.equal(repository.listTurns(trunkBranch.id).length, 2);
    const other = service.createTree();
    assert.equal(service.getPromptRequest(other.tree.id, "same-key"), null);
    assert.equal((await service.submitPromptRequest(other.tree.id, other.trunkBranch.id, "different", "same-key")).status, "succeeded");
    assert.ok(!JSON.stringify(result).includes("sessionFile"), "query exposes no runtime reference");
  } finally { await instance.shutdown(); cleanupDir(dir); }
});

test("abort is terminal for a request key; only a deliberate new request can execute again", async () => {
  const dir = makeTempDataDir(), instance = makeStudioInstance(dir, { echoTurnDelayMs: 100 });
  try {
    const { service, repository } = instance, { tree, trunkBranch } = service.createTree();
    const first = service.submitPromptRequest(tree.id, trunkBranch.id, "question", "abort-me");
    for (let i = 0; i < 500 && service.getTreeDiagnostics(tree.id).activeRun === null; i++) await tick();
    const active = service.getTreeDiagnostics(tree.id).activeRun;
    assert.ok(active);
    await service.abort(tree.id, active.runId);
    assert.equal((await first).status, "aborted");
    assert.equal((await service.submitPromptRequest(tree.id, trunkBranch.id, "question", "abort-me")).status, "aborted");
    assert.equal(repository.listEpisodes(trunkBranch.id).length, 1);
    assert.equal((await service.submitPromptRequest(tree.id, trunkBranch.id, "question", "retry-explicitly")).status, "succeeded");
  } finally { await instance.shutdown(); cleanupDir(dir); }
});

test("saved outcomes reconcile after restart without Pi sessions; interrupted acceptance never redispatches", async () => {
  const dir = makeTempDataDir();
  let instance = makeStudioInstance(dir);
  try {
    const { tree, trunkBranch } = instance.service.createTree();
    const done = await instance.service.submitPromptRequest(tree.id, trunkBranch.id, "saved", "done");
    instance.repository.promptRequests.create(tree.id, "prelude-crash", trunkBranch.id, "f".repeat(64));
    const episode = instance.repository.createEpisode(trunkBranch.id);
    const interruptedRun = instance.repository.createRun(episode.id, instance.repository.getRun(done.runId!).session);
    instance.repository.updateRunState(interruptedRun.id, "running");
    instance.repository.promptRequests.create(tree.id, "run-crash", trunkBranch.id, "e".repeat(64));
    instance.repository.promptRequests.bind(tree.id, "run-crash", interruptedRun.id);
    await instance.shutdown();
    rmSync(join(dir, "sessions"), { recursive: true, force: true });
    instance = makeStudioInstance(dir);
    assert.deepEqual(await instance.service.submitPromptRequest(tree.id, trunkBranch.id, "saved", "done"), done);
    const interrupted = instance.service.getPromptRequest(tree.id, "prelude-crash");
    assert.equal(interrupted?.status, "failed");
    assert.equal(interrupted?.runId, null);
    assert.match(interrupted?.failure?.message ?? "", /中断/);
    assert.equal(instance.service.getPromptRequest(tree.id, "run-crash")?.status, "failed");
    assert.equal(instance.service.getPromptRequest(tree.id, "run-crash")?.runId, interruptedRun.id);
    const failedBeforeRun = await instance.service.submitPromptRequest(tree.id, trunkBranch.id, "missing session", "missing-session");
    assert.equal(failedBeforeRun.status, "failed");
    assert.equal(failedBeforeRun.failure?.code, "session-corrupt");
    assert.equal(failedBeforeRun.runId, null);
    assert.equal(instance.repository.listEpisodes(trunkBranch.id).length, 2);
    assert.equal(instance.repository.listTurns(trunkBranch.id).length, 2);
  } finally { await instance.shutdown(); cleanupDir(dir); }
});

test("Run binding failure rolls back Episode and Run together and leaves a queryable failure", async () => {
  const dir = makeTempDataDir(), instance = makeStudioInstance(dir);
  try {
    const { service, repository } = instance, { tree, trunkBranch } = service.createTree();
    repository.promptRequests.bind = () => { throw new Error("binding injection"); };
    const failed = await service.submitPromptRequest(tree.id, trunkBranch.id, "q", "atomic");
    assert.equal(failed.status, "failed");
    assert.equal(failed.runId, null);
    assert.equal(repository.listEpisodes(trunkBranch.id).length, 0);
    assert.equal(repository.listTurns(trunkBranch.id).length, 0);
    assert.deepEqual(await service.submitPromptRequest(tree.id, trunkBranch.id, "q", "atomic"), failed);
  } finally { await instance.shutdown(); cleanupDir(dir); }
});

test("HTTP keyed prompt supports query/replay and keeps the legacy unkeyed API", async () => {
  const dir = makeTempDataDir(), instance = makeStudioInstance(dir);
  const server = createStudioServer({ service: instance.service, staticDir: join(import.meta.dirname, "../public") });
  try {
    const port = await server.listen(0), { tree, trunkBranch } = instance.service.createTree();
    const base = `http://127.0.0.1:${port}/api/trees/${tree.id}`;
    const send = (body: object) => fetch(`${base}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const body = { branchId: trunkBranch.id, text: "HTTP question", requestKey: "http-key" };
    assert.equal((await send(body)).status, 200); // Deliberately discard the first response body.
    const queried = await (await fetch(`${base}/prompt-requests/http-key`)).json() as { request: { status: string; runId: string } };
    assert.equal(queried.request.status, "succeeded");
    assert.equal(((await (await send(body)).json()) as typeof queried).request.runId, queried.request.runId);
    assert.equal((await send({ ...body, text: "other" })).status, 409);
    assert.equal((await send({ ...body, requestKey: "" })).status, 400);
    assert.equal(((await (await fetch(`${base}/prompt-requests/never-accepted`)).json()) as {request: null}).request, null);
    assert.equal(((await (await send({ branchId: trunkBranch.id, text: "legacy" })).json()) as {outcome: {userTurn: {text: string}}}).outcome.userTurn.text, "legacy");
    assert.equal(instance.repository.listEpisodes(trunkBranch.id).length, 2);
  } finally { await server.close(); await instance.shutdown(); cleanupDir(dir); }
});

test("export and restore retain request identity and saved outcome without session files", async () => {
  const dir = makeTempDataDir(), source = makeStudioInstance(join(dir, "source"));
  let restored: ReturnType<typeof makeStudioInstance> | undefined;
  try {
    const { tree, trunkBranch } = source.service.createTree();
    const result = await source.service.submitPromptRequest(tree.id, trunkBranch.id, "portable", "portable-key");
    await exportPackage({ dbPath: join(dir, "source", "treeai.db"), outDir: join(dir, "package") });
    await restorePackage({ packageDir: join(dir, "package"), dataDir: join(dir, "restored") });
    restored = makeStudioInstance(join(dir, "restored"));
    assert.deepEqual(await restored.service.submitPromptRequest(tree.id, trunkBranch.id, "portable", "portable-key"), result);
    assert.equal(restored.repository.listEpisodes(trunkBranch.id).length, 1);
  } finally { await restored?.shutdown(); await source.shutdown(); cleanupDir(dir); }
});
