/** Native Chrome + real Echo/SQLite: drop a committed response and the first
 * reconciliation read, reload the page, then verify that Send only queries.
 * Usage: node scripts/probe-prompt-reconciliation.mjs [artifacts-directory]
 * Synthetic input only. This is mechanism evidence, never real-model quality. */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createChromeHost } from "./d4/browser/chrome-host.mjs";
import { createStudioServer } from "../apps/studio/src/server.ts";
import { makeStudioInstance, makeTempDataDir, cleanupDir } from "../apps/studio/tests/helpers.ts";

const artifactsDir = resolve(process.argv[2] ?? "/tmp/treeai-prompt-browser");
mkdirSync(artifactsDir, { recursive: true });
const dir = makeTempDataDir(), instance = makeStudioInstance(dir);
const server = createStudioServer({ service: instance.service,
  staticDir: resolve(import.meta.dirname, "../apps/studio/public") });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const host = createChromeHost({ cli: { chromeExecutable: null }, viewport: { width: 1280, height: 900 },
  getContext: () => ({ artifactsDir }), sanitizeText: text => text, truncate: (s, n) => s.slice(0, n), sleep });
async function waitFor(expression) {
  for (let i = 0; i < 200; i++) {
    if (await host.evalJs(expression)) return;
    await sleep(50);
  }
  console.error(await host.evalJs(`JSON.stringify({ready: document.readyState, error: document.querySelector("#error-banner")?.textContent, sendDisabled: document.querySelector("#send")?.disabled, tree: localStorage.getItem("treeai:last-tree"), pending: Object.keys(localStorage).filter(k => k.startsWith("treeai:prompt:")), text: document.querySelector("#prompt-input")?.value})`));
  throw new Error(`browser condition timed out: ${expression}`);
}
let postResponses = 0, droppedQueries = 0;
const interceptionErrors = [];
try {
  const port = await server.listen(0);
  await host.startChrome();
  host.chrome.cdp.on("Fetch.requestPaused", event => {
    void (async () => {
      if (event.responseStatusCode !== undefined && event.request.method === "POST") {
        postResponses++;
        await host.chrome.cdp.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "Failed" });
      } else if (droppedQueries === 0 && event.request.url.includes("/prompt-requests/")) {
        droppedQueries++;
        await host.chrome.cdp.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "Failed" });
      } else await host.chrome.cdp.send("Fetch.continueRequest", { requestId: event.requestId });
    })().catch(error => interceptionErrors.push(String(error)));
  });
  await host.chrome.cdp.send("Fetch.enable", { patterns: [
    { urlPattern: "*/api/trees/*/prompt", requestStage: "Response" },
    { urlPattern: "*/api/trees/*/prompt-requests/*", requestStage: "Request" },
  ] });
  await host.navigate(`http://127.0.0.1:${port}`);
  await waitFor(`document.querySelector('#new-tree') && !document.querySelector('#new-tree').disabled`);
  await host.evalJs(`document.querySelector('#new-tree').click()`);
  await waitFor(`document.querySelector('#prompt-input') && !document.querySelector('#prompt-input').disabled`);
  await host.evalJs(`document.querySelector('#prompt-input').value = 'Synthetic response-loss question'; document.querySelector('#send').click()`);
  await waitFor(`!document.querySelector('#error-banner').hidden && !document.querySelector('#send').disabled`);
  assert.equal(postResponses, 1);
  assert.equal(droppedQueries, 1);
  const tree = instance.service.listTrees()[0];
  assert.ok(tree);
  const branchId = instance.service.getTreeState(tree.id).trunkBranchId;
  const turnsBefore = instance.repository.listTurns(branchId);
  assert.equal(turnsBefore.filter(t => t.role === "user").length, 1);
  assert.equal(await host.evalJs(`document.querySelector('#prompt-input').value`), "Synthetic response-loss question");
  const pending = await host.evalJs(`Object.keys(localStorage).filter(k => k.startsWith('treeai:prompt:')).map(k => JSON.parse(localStorage.getItem(k)))`);
  assert.equal(pending.length, 1);
  const requestKey = pending[0].requestKey;
  assert.equal(instance.service.getPromptRequest(tree.id, requestKey).status, "succeeded");
  rmSync(join(dir, "sessions"), { recursive: true, force: true });
  await host.chrome.cdp.send("Page.reload");
  await sleep(700);
  await waitFor(`document.querySelector('#send') && !document.querySelector('#send').disabled && document.querySelector('#prompt-input') && !document.querySelector('#prompt-input').disabled`);
  // Empty editor after reload: Send must still reconcile the persisted request.
  await host.evalJs(`document.querySelector('#send').click()`);
  await waitFor(`!Object.keys(localStorage).some(k => k.startsWith('treeai:prompt:')) && !document.querySelector('#prompt-input').disabled`);
  assert.equal(await host.evalJs(`document.querySelector('#send').disabled`), true, "ordinary sending remains disabled for missing sessions after pure reconciliation");
  assert.equal(postResponses, 1, "reload/reconciliation must not issue another POST");
  assert.deepEqual(instance.repository.listTurns(branchId), turnsBefore);
  assert.equal(instance.repository.listEpisodes(branchId).length, 1);
  assert.deepEqual(interceptionErrors, []);
  const screenshot = await host.screenshot("reconciled-after-reload");
  const summary = { status: "PASS", mode: "offline-echo", gitCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    gitDirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() !== "",
    postResponses, droppedQueries, savedUserTurns: 1, savedAssistantTurns: 1, episodes: 1,
    checks: ["committed POST response dropped", "first status GET dropped", "pending request survived page reload", "missing Pi sessions did not block read-only reconciliation", "empty composer Send reconciled by GET", "no duplicate Episode, Run or Turn"], screenshot };
  writeFileSync(join(artifactsDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
} finally {
  host.stopChrome();
  await server.close();
  await instance.shutdown();
  cleanupDir(dir);
}
