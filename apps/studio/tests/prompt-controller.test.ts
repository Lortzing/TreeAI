import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
const { createPromptController } = await import(new URL("../public/core/controllers/prompt.js", import.meta.url).href) as {
  createPromptController(deps: Record<string, unknown>): { sendPrompt(view: string): Promise<void> };
};
const done = { status: "succeeded", failure: null };
function harness(store = new Map<string, string>()) {
  const input = { value: "original question", dataset: {} as Record<string, string>, focus() {} };
  const state = { currentTreeId: "tree", panelBranchId: "branch", treeState: null as unknown,
    activeRunInfo: null, streaming: null, forceSessionBanner: false };
  const document = { documentElement: { dataset: {} as Record<string, string> } };
  let hAvailability = "available";
  const calls: {path: string; method?: string; body?: Record<string, unknown>}[] = [];
  let handler: (path: string, method?: string, body?: Record<string, unknown>) => Promise<unknown> = async () => ({ request: done, state: "saved" });
  const noop = () => {};
  const controller = createPromptController({ state, document, crypto: { randomUUID },
    window: { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) } },
    $: () => input, trunkBranchId: () => "trunk", sessionUI: { followBranchId: null },
    studioEventsController: { sseHealthy: true },
    api: async (path: string, method?: string, body?: Record<string, unknown>) => { calls.push({path,method,body}); return handler(path, method, body); },
    branchView: () => ({ sessionAvailability: hAvailability }),
    renderAll: noop, startDiagnosticsPolling: noop, stopDiagnosticsPolling: noop, focusComposerWhenSelectable: noop,
    refreshDiagnostics: async () => {}, refreshTerminology: async () => {},
  });
  return { controller, state, input, document, store, calls, unavailable: () => { hAvailability = "unavailable"; }, handle: (fn: typeof handler) => { handler = fn; } };
}

test("lost POST response reconciles saved success by GET without another prompt", async () => {
  const h = harness();
  h.handle(async (_path, method) => {
    if (method === "POST") throw new Error("response lost after commit");
    return { request: done, state: "committed" };
  });
  await h.controller.sendPrompt("main");
  assert.deepEqual(h.calls.map(c => c.method ?? "GET"), ["POST", "GET"]);
  assert.equal(typeof h.calls[0]!.body?.requestKey, "string");
  assert.equal(h.input.value, "");
  assert.equal(h.state.treeState, "committed");
  assert.equal(h.store.size, 0);
});

test("unconfirmed request retains its key across refresh; retry reads first and reuses that key", async () => {
  const h = harness();
  h.handle(async () => { throw new Error("offline"); });
  await assert.rejects(h.controller.sendPrompt("panel"), /offline/);
  const firstKey = h.calls[0]!.body?.requestKey;
  assert.equal(h.input.value, "original question");
  const reloaded = harness(h.store);
  reloaded.handle(async (_path, method) => method === "POST" ? { request: done, state: "saved" } : { request: null });
  await reloaded.controller.sendPrompt("panel");
  assert.deepEqual(reloaded.calls.map(c => c.method ?? "GET"), ["GET", "POST"]);
  assert.equal(reloaded.calls[1]!.body?.requestKey, firstKey);
  assert.equal(reloaded.store.size, 0);
});

test("in-flight reconciliation keeps edited question and never dispatches it automatically", async () => {
  const h = harness();
  h.handle(async () => ({ request: { status: "running" }, state: "running" }));
  await assert.rejects(h.controller.sendPrompt("main"), /仍在执行/);
  h.input.value = "a later edited question";
  await assert.rejects(h.controller.sendPrompt("main"), /仍在执行/);
  assert.equal(h.calls.filter(c => c.method === "POST").length, 1);
  h.handle(async () => ({ request: done, state: "saved" }));
  await h.controller.sendPrompt("main");
  assert.equal(h.input.value, "a later edited question");
  assert.equal(h.store.size, 0);
  assert.equal(h.calls.filter(c => c.method === "POST").length, 1);
});

test("success preserves text, attachments, and model edits made while the response was pending", async () => {
  for (const edit of ["text", "attachment", "model", "tree"]) {
    const h = harness();
    h.handle(async () => {
      if (edit === "text") h.input.value = "later draft";
      if (edit === "attachment") h.input.dataset.attachments = JSON.stringify([{ versionId: "later" }]);
      if (edit === "model") h.document.documentElement.dataset.composerModel = JSON.stringify({ providerId: "later", modelId: "model" });
      if (edit === "tree") { h.state.currentTreeId = "other"; h.state.treeState = "other state"; }
      return { request: done, state: "saved" };
    });
    await h.controller.sendPrompt("main");
    assert.equal(h.input.value, edit === "text" ? "later draft" : "original question", edit);
    if (edit === "tree") assert.equal(h.state.treeState, "other state");
    assert.equal(h.store.size, 0);
  }
});

test("terminal failure keeps the question and requires a fresh key on the next explicit send", async () => {
  const h = harness();
  h.handle(async () => ({ request: { status: "failed", failure: { code: "upstream", message: "provider failed" } }, state: "failed" }));
  await assert.rejects(h.controller.sendPrompt("main"), /provider failed/);
  assert.equal(h.input.value, "original question");
  assert.equal(h.store.size, 0);
  const firstKey = h.calls[0]!.body?.requestKey;
  h.handle(async () => ({ request: done, state: "saved" }));
  await h.controller.sendPrompt("main");
  assert.notEqual(h.calls[1]!.body?.requestKey, firstKey);
});

test("unknown acceptance blocks changing the original payload under an existing key", async () => {
  const h = harness();
  h.handle(async () => { throw new Error("offline"); });
  await assert.rejects(h.controller.sendPrompt("main"));
  h.input.value = "changed question";
  h.handle(async () => ({ request: null }));
  await assert.rejects(h.controller.sendPrompt("main"), /恢复原问题/);
  assert.equal(h.calls.filter(c => c.method === "POST").length, 1);
  assert.equal(h.input.value, "changed question");
  assert.equal(h.store.size, 1);
});


test("missing Pi session still permits read-only reconciliation and never retries unknown acceptance", async () => {
  const h = harness();
  h.handle(async () => { throw new Error("offline"); });
  await assert.rejects(h.controller.sendPrompt("main"));
  h.unavailable();
  h.handle(async () => ({ request: null }));
  await assert.rejects(h.controller.sendPrompt("main"), /旧会话不可用/);
  assert.equal(h.calls.filter(c => c.method === "POST").length, 1);
  h.handle(async () => ({ request: done, state: "saved" }));
  await h.controller.sendPrompt("main");
  assert.equal(h.input.value, "");
  assert.equal(h.store.size, 0);
});
