import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { UiGenerationTask, TreeId } from "@treeai/contracts";
import { createPiRuntimeFromConfig } from "@treeai/runtime-pi";
import { TreeRepository } from "@treeai/persistence";
import { EchoSdkPort } from "../src/echo-port.ts";
import { GenerativeUiService, comparisonPrompt } from "../src/generative-ui/service.ts";
import { offlineComparisonAnswer } from "../src/generative-ui/offline.ts";
import { createStudioServer } from "../src/server.ts";
import { MaterialBranchingService } from "../src/materials/branching.ts";
import { MaterialRangeResolver } from "../src/materials/range-resolver.ts";
import { exportPackage, restorePackage, MANIFEST_FILENAME, PortabilityError } from "../src/portability/index.ts";
import { makeStudioInstance, makeTempDataDir, cleanupDir, STUDIO_MODEL } from "./helpers.ts";

async function setup(options: { delay?: number; answer?: () => string; budget?: number; timeout?: number } = {}) {
  const dir = makeTempDataDir(); const studio = makeStudioInstance(dir);
  const tree = studio.service.createTree(); const treeId = tree.tree.id;
  const root = (await studio.service.prompt(treeId, tree.trunkBranch.id, "贝叶斯：先验与后验 😀")).assistantTurn;
  const branch = studio.service.createBranchFromSelection(treeId, tree.trunkBranch.id, root.id, { start: 6, end: root.text.length - 1, text: root.text.slice(6, -1) }).branch;
  const turn = (await studio.service.prompt(treeId, branch.id, "比较它们的适用条件")).assistantTurn;
  const sessions = join(dir, "generative-ui", "sessions"); const cwd = join(dir, "generative-ui", "workspace");
  mkdirSync(sessions, { recursive: true }); mkdirSync(cwd, { recursive: true });
  const port = new EchoSdkPort({ answer: options.answer ?? offlineComparisonAnswer, turnDelayMs: options.delay ?? 1 });
  const runtime = createPiRuntimeFromConfig({ port, defaultCwd: cwd, thinkingLevel: "off" });
  const gen = new GenerativeUiService({ repository: studio.repository, materials: studio.materialRepository, runtime, model: STUDIO_MODEL, sessionDir: sessions, cwd,
    ...(options.budget === undefined ? {} : { dailyBudgetChars: options.budget }), ...(options.timeout === undefined ? {} : { timeoutMs: options.timeout }) });
  const create = (intent = "request-1") => gen.create(treeId, branch.id, turn.id, intent, "");
  return { dir, studio, tree, treeId, root, branch, turn, port, gen, create,
    async close() { await gen.dispose(); await studio.shutdown(); cleanupDir(dir); } };
}
async function settled(gen: GenerativeUiService, task: UiGenerationTask): Promise<UiGenerationTask> {
  for (let i = 0; i < 400; i++) {
    const current = gen.get(task.treeId, task.id);
    if (!["queued", "running"].includes(current.state)) return current;
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error("generation did not settle");
}

test("explicit comparison is isolated from turns, Returns and the main Pi cursor; intent replay dispatches once", async () => {
  const f = await setup();
  try {
    const before = f.studio.service.getTreeState(f.treeId);
    const source = f.gen.preview(f.treeId, f.branch.id, f.turn.id);
    assert.equal(source.sources.length, 2);
    const forged = structuredClone(source);
    const origin = forged.sources[1];
    assert.ok(origin?.kind === "turn");
    const wrongRange = { ...origin, start: origin.start + 1, end: origin.end + 1 };
    assert.throws(() => f.studio.repository.generativeUi.create({ treeId: f.treeId, branchId: f.branch.id, anchorTurnId: f.turn.id, intentId: "forged-origin", context: { ...forged, sources: [forged.sources[0]!, wrongRange] }, model: "test", reservedChars: 12000, dailyBudgetChars: 250000 }), /原选区/);
    assert.equal(f.port.createdSessions.length, 0, "preview must not call a model");
    const task = f.create(); assert.equal(f.create().id, task.id);
    assert.throws(() => f.gen.create(f.treeId, f.branch.id, f.turn.id, "request-1", "changed"));
    const done = await settled(f.gen, task);
    assert.equal(done.state, "succeeded"); assert.ok(done.artifact?.fallbackText.includes("离线示例"));
    assert.equal(f.port.createdSessions.length, 1); assert.equal(f.create().id, task.id);
    assert.deepEqual(f.studio.service.getTreeState(f.treeId), before);
    assert.deepEqual(f.gen.source(f.treeId, task.id, "s2"), source.sources[1]);
    assert.throws(() => f.gen.get("other-tree" as TreeId, task.id));
    assert.throws(() => f.gen.create(f.treeId, f.tree.trunkBranch.id, f.root.id, "root", ""));
    const second = await settled(f.gen, f.create("request-2"));
    assert.equal(second.revision, 2); assert.equal(f.gen.get(f.treeId, task.id).artifact?.fallbackText, done.artifact?.fallbackText);
  } finally { await f.close(); }
});

test("budget reservations block before dispatch; unknown output is rejected without writing a card", async () => {
  const low = await setup({ budget: 1 });
  try { assert.throws(() => low.create(), /额度/); assert.equal(low.port.createdSessions.length, 0); }
  finally { await low.close(); }
  const invalid = await setup({ answer: () => JSON.stringify({ kind: "iframe", src: "javascript:alert(1)" }) });
  try {
    const task = await settled(invalid.gen, invalid.create());
    assert.equal(task.state, "failed"); assert.equal(task.artifact, null); assert.equal(task.costUnknown, false); assert.ok(task.chargedChars > 0);
    assert.equal(invalid.gen.create(invalid.treeId, invalid.branch.id, invalid.turn.id, "request-1", "").id, task.id);
  } finally { await invalid.close(); }
});

test("queued cancellation is free; running cancellation retains reservation and ignores late results", async () => {
  const f = await setup({ delay: 60 });
  try {
    const first = f.create(); const queued = f.create("queued");
    const cancelled = f.gen.cancel(f.treeId, queued.id);
    assert.equal(cancelled.state, "cancelled"); assert.equal(cancelled.chargedChars, 0);
    for (let i = 0; i < 80 && f.port.createdSessions.length === 0; i++) await new Promise(r => setTimeout(r, 5));
    await new Promise(r => setTimeout(r, 10));
    const running = f.gen.cancel(f.treeId, first.id);
    assert.equal(running.costUnknown, true); assert.equal(running.chargedChars, first.reservedChars);
    await f.gen.dispose();
    assert.equal(f.gen.get(f.treeId, first.id).state, "cancelled");
    assert.equal(f.port.createdSessions.length, 1);
  } finally { await f.close(); }
});

test("timeout aborts once and keeps unknown cost; startup interrupts queued/running without automatic dispatch", async () => {
  const f = await setup({ delay: 80, timeout: 5 });
  try {
    const timed = await settled(f.gen, f.create()); assert.equal(timed.state, "failed"); assert.match(timed.error!, /超时/); assert.equal(timed.costUnknown, true);
    const context = f.gen.preview(f.treeId, f.branch.id, f.turn.id);
    const input = { treeId: f.treeId, branchId: f.branch.id, anchorTurnId: f.turn.id, context, model: "test", reservedChars: comparisonPrompt(context).length + 12000, dailyBudgetChars: 250000 };
    const running = f.studio.repository.generativeUi.create({ ...input, intentId: "crashed" }); f.studio.repository.generativeUi.start(f.treeId, running.id);
    const queued = f.studio.repository.generativeUi.create({ ...input, intentId: "waiting" });
    f.studio.repository.generativeUi.recover();
    assert.equal(f.gen.get(f.treeId, running.id).state, "interrupted"); assert.equal(f.gen.get(f.treeId, running.id).costUnknown, true);
    assert.equal(f.gen.get(f.treeId, queued.id).chargedChars, 0); assert.equal(f.port.createdSessions.length, 1);
  } finally { await f.close(); }
});

test("cards and source snapshots export/restore without Pi sessions; schema-10 packages restore with an empty card set", async () => {
  const f = await setup();
  try {
    const task = await settled(f.gen, f.create());
    const out = join(f.dir, "package"); exportPackage({ dbPath: join(f.dir, "treeai.db"), outDir: out, readable: true });
    assert.match(readFileSync(join(out, "readable", "trees", `${f.treeId}.md`), "utf8"), /Generated comparisons/);
    const target = join(f.dir, "restored"); restorePackage({ packageDir: out, dataDir: target });
    const repo = TreeRepository.open({ path: join(target, "treeai.db") });
    try { assert.deepEqual(repo.generativeUi.get(f.treeId, task.id), task); } finally { repo.close(); }
    assert.equal(existsSync(join(target, "sessions")), false);
    const manifestPath = join(out, MANIFEST_FILENAME); const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.productSchemaVersion = 10;
    manifest.entries = manifest.entries.filter((e: { path: string }) => e.path !== "facts/generative_ui_tasks.json");
    delete manifest.counts.generative_ui_tasks; rmSync(join(out, "facts", "generative_ui_tasks.json"));
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const legacy = join(f.dir, "legacy"); restorePackage({ packageDir: out, dataDir: legacy });
    const old = TreeRepository.open({ path: join(legacy, "treeai.db") });
    try { assert.deepEqual(old.generativeUi.list(f.treeId, f.turn.id), []); } finally { old.close(); }
  } finally { await f.close(); }
});

test("restore rejects re-signed forged card JSON and publishes no partial database", async () => {
  const f = await setup();
  try {
    await settled(f.gen, f.create()); const out = join(f.dir, "package"); exportPackage({ dbPath: join(f.dir, "treeai.db"), outDir: out });
    const path = join(out, "facts", "generative_ui_tasks.json"); const shape = JSON.parse(readFileSync(path, "utf8"));
    shape.rows[0][shape.columns.indexOf("artifact_json")] = JSON.stringify({ kind: "iframe" }); writeFileSync(path, JSON.stringify(shape));
    const manifestPath = join(out, MANIFEST_FILENAME); const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const entry = manifest.entries.find((e: { path: string }) => e.path === "facts/generative_ui_tasks.json"); const bytes = readFileSync(path);
    entry.bytes = bytes.length; entry.sha256 = createHash("sha256").update(bytes).digest("hex"); writeFileSync(manifestPath, JSON.stringify(manifest));
    const target = join(f.dir, "rejected"); assert.throws(() => restorePackage({ packageDir: out, dataDir: target }), (error: unknown) => error instanceof PortabilityError && error.code === "integrity-failed");
    assert.equal(existsSync(join(target, "treeai.db")), false);
  } finally { await f.close(); }
});

test("initialization deadline settles even when createSession stalls; late initialization cannot dispatch a cancelled prompt", async () => {
  const f = await setup();
  try {
    let release: (() => void) | undefined; let prompts = 0;
    const runtime = f.gen.options.runtime;
    const createSession = runtime.createSession.bind(runtime);
    const prompt = runtime.prompt.bind(runtime);
    runtime.createSession = async init => { await new Promise<void>(resolve => { release = resolve; }); return createSession(init); };
    runtime.prompt = async input => { prompts++; return prompt(input); };
    f.gen.options.timeoutMs = 5;
    const task = await settled(f.gen, f.create());
    assert.equal(task.state, "failed"); assert.match(task.error!, /初始化超时/); assert.equal(task.chargedChars, 0);
    assert.throws(() => f.create("while-stalled"), /尚未停止/);
    release!(); await new Promise(r => setTimeout(r, 30));
    assert.equal(prompts, 0); assert.equal(f.gen.get(f.treeId, task.id).state, "failed");
  } finally { await f.close(); }
});

test("changed source loses location but preserves the saved card and immutable excerpt", async () => {
  const f = await setup();
  try {
    const task = await settled(f.gen, f.create());
    const db = new DatabaseSync(join(f.dir, "treeai.db"));
    try { db.prepare("UPDATE turns SET text=? WHERE id=?").run("changed source", f.turn.id); } finally { db.close(); }
    assert.throws(() => f.gen.source(f.treeId, task.id, "s1"), /来源已变化/);
    assert.deepEqual(f.gen.get(f.treeId, task.id), task);
    assert.equal(f.create().id, task.id, "replay resolves before rebuilding changed sources");
  } finally { await f.close(); }
});

test("material comparisons retain version/block/UTF-16 identity through export and restore", async () => {
  const f = await setup();
  try {
    const text = "# 概率\n\n先验 😀 与后验：先验在观察之前，后验在观察之后。";
    const imported = await f.studio.materials.importMaterial(f.treeId, { filename: "概率.md", bytes: new TextEncoder().encode(text) });
    for (let i = 0; i < 100 && f.studio.materials.getMaterialDetail(f.treeId, imported.material.id).versions[0]!.parseStatus !== "ready"; i++) await new Promise(r => setTimeout(r, 5));
    const resolved = new MaterialRangeResolver({ repository: f.studio.materialRepository }).resolve({ materialId: imported.material.id, versionId: imported.version.id, locator: { kind: "text-occurrence", needle: "先验 😀 与后验", occurrence: 1 } });
    assert.ok(resolved.ok); const selection = resolved.result.selection;
    const branching = new MaterialBranchingService({ treeRepository: f.studio.repository, materialRepository: f.studio.materialRepository, studio: f.studio.service });
    const branch = branching.createMaterialBranch({ treeId: f.treeId, selection, intentKey: "material-ui" }).branch;
    const first = await branching.firstQuestion({ treeId: f.treeId, intentKey: "material-ui", firstQuestion: "比较先验与后验" });
    assert.ok(first.outcome);
    const task = await settled(f.gen, f.gen.create(f.treeId, branch.id, first.outcome.assistantTurn.id, "material-card", ""));
    assert.equal(task.state, "succeeded"); const source = f.gen.source(f.treeId, task.id, "s2"); assert.equal(source.kind, "material");
    if (source.kind === "material") assert.deepEqual(source.selection, selection);
    const out = join(f.dir, "material-package"); exportPackage({ dbPath: join(f.dir, "treeai.db"), outDir: out });
    const target = join(f.dir, "material-restored"); restorePackage({ packageDir: out, dataDir: target });
    const repo = TreeRepository.open({ path: join(target, "treeai.db") });
    try { assert.deepEqual(repo.generativeUi.get(f.treeId, task.id).context, task.context); } finally { repo.close(); }
  } finally { await f.close(); }
});

test("HTTP protects explicit dispatch with local origin/header and scopes task reads to a Tree", async () => {
  const f = await setup(); const server = createStudioServer({ service: f.studio.service, generativeUi: f.gen, staticDir: new URL("../public/", import.meta.url).pathname });
  let listening = false;
  try {
    const port = await server.listen(0); listening = true; const base = `http://127.0.0.1:${port}/api/trees/${f.treeId}/generative-ui`;
    const body = JSON.stringify({ branchId: f.branch.id, anchorTurnId: f.turn.id, intentId: "http" });
    assert.equal((await fetch(base, { method: "POST", body })).status, 403);
    assert.equal((await fetch(base, { method: "POST", body, headers: { "x-treeai-generative-ui": "1", Origin: "https://evil.invalid" } })).status, 403);
    const response = await fetch(base, { method: "POST", body, headers: { "x-treeai-generative-ui": "1" } });
    assert.equal(response.status, 202); const { task } = await response.json() as { task: UiGenerationTask };
    assert.equal((await fetch(base.replace(f.treeId, "other") + `/${task.id}`)).status, 404);
    assert.equal((await fetch(base, { method: "POST", body: JSON.stringify({ branchId: f.branch.id, anchorTurnId: f.turn.id, intentId: "bad", instruction: 5 }), headers: { "x-treeai-generative-ui": "1" } })).status, 400);
    await settled(f.gen, task); assert.equal(f.port.createdSessions.length, 1);
  } finally { if (listening) await server.close(); await f.close(); }
});
