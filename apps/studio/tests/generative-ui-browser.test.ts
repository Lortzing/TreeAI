import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error Browser modules deliberately have no declaration files.
import { createGenerativeUiController } from "../public/core/controllers/generative-ui.js";
// @ts-expect-error Browser modules deliberately have no declaration files.
import { createReturnController } from "../public/core/controllers/return.js";
import { offlineComparisonAnswer } from "../src/generative-ui/offline.ts";
import { createMemoryStorage } from "./support/browser-stubs.ts";

class Element extends EventTarget {
  tag: string; textContent = ""; className = ""; value = ""; type = ""; open = false; isConnected = true;
  disabled = false; hidden = false; checked = false; children: Element[] = []; dataset: Record<string, string> = {};
  attrs = new Map<string, string>(); focused = false; parent: Element | null = null;
  constructor(tag: string) { super(); this.tag = tag; }
  append(...children: Element[]) { for (const child of children) { if (child.parent) child.parent.children = child.parent.children.filter(n => n !== child); child.parent = this; this.children.push(child); } }
  replaceChildren(...children: Element[]) { this.children = []; this.append(...children); }
  setAttribute(name: string, value: string) { this.attrs.set(name, value); }
  click() { if (!this.disabled) this.dispatchEvent(new Event("click")); }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatchEvent(new Event("close")); }
  focus() { this.focused = true; }
  scrollIntoView() {}
}
const nodes = (root: Element): Element[] => [root, ...root.children.flatMap(nodes)];
const byText = (root: Element, text: string) => { const node = nodes(root).find(n => n.textContent === text); assert.ok(node, text); return node; };
const tick = async () => { await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r)); };
const context = { instruction: "", sources: [{ kind: "turn", key: "s1", title: "当前回答", text: "原文 😀", turnId: "turn", branchId: "branch", start: 0, end: 5, sourceHash: "a".repeat(64) }] };
function task(id = "saved", revision = 1) {
  return { id, revision, intentId: "already-saved", state: "succeeded", createdAt: "2026-10-29T00:00:00Z", context,
    artifact: { schemaVersion: 1, catalogVersion: "comparison-v1", document: JSON.parse(offlineComparisonAnswer()), fallbackText: "plain fallback" } };
}
type Options = { method: string; body?: string; signal: AbortSignal };
function setup(handler: (path: string, options: Options) => Promise<unknown>) {
  const state = { currentTreeId: "tree", panelBranchId: "branch", treeState: { trunkBranchId: "trunk" }, busy: false };
  const store = new Map<string, string>(); const timers = new Map<number, () => void>(); let timerId = 0, uuid = 0;
  const requests: { path: string; options: Options }[] = []; const drafts: string[] = [];
  const controller = createGenerativeUiController({ state, document: { createElement: (tag: string) => new Element(tag) },
    window: { localStorage: createMemoryStorage(store), setTimeout: (fn: () => void) => { timers.set(++timerId, fn); return timerId; }, clearTimeout: (id: number) => timers.delete(id) },
    crypto: { randomUUID: () => `intent-${++uuid}` }, appendDraft: (_id: string, text: string) => drafts.push(text), locateSource: async () => {},
    fetch: async (path: string, options: Options) => { requests.push({ path, options }); return { ok: true, status: 200, json: async () => handler(path, options) }; },
  });
  const card = controller.card({ id: "turn", text: "原文 😀" }, "branch") as Element;
  const open = async () => { card.open = true; card.dispatchEvent(new Event("toggle")); await tick(); };
  return { state, store, timers, requests, drafts, controller, card, open };
}
const response = (tasks = [task()]) => ({ tasks, context, contextError: null, usage: { offline: true, usedChars: 100, dailyBudgetChars: 250000 } });

test("comparison is lazy, uses text nodes and keeps local selection across unchanged refreshes", async () => {
  const saved = task(); saved.artifact.document.rows[0].cells[0].text = "<img src=x onerror=alert(1)>";
  const ui = setup(async () => response([saved]));
  try {
    assert.equal(ui.requests.length, 0); await ui.open();
    assert.equal(nodes(ui.card).filter(n => n.tag === "img" || n.tag === "script").length, 0);
    assert.ok(byText(ui.card, "<img src=x onerror=alert(1)>"));
    const check = nodes(ui.card).find(n => n.type === "checkbox")!; check.checked = true; check.dispatchEvent(new Event("change"));
    byText(ui.card, "将 1 条收获填入 Return 草稿").click(); assert.equal(ui.drafts.length, 1); assert.match(ui.drafts[0]!, /模型推断/);
    assert.equal(ui.requests.length, 1, "checkbox and draft handoff are local");
    ui.card.dispatchEvent(new Event("toggle")); await tick();
    assert.ok(nodes(ui.card).includes(check)); assert.equal(check.checked, true, "same saved version retains DOM and selection");
  } finally { ui.controller.dispose(); }
});

test("enlarged reading moves the same card DOM and preserves checks without model calls", async () => {
  const ui = setup(async () => response());
  try {
    await ui.open(); const check = nodes(ui.card).find(n => n.type === "checkbox")!;
    check.checked = true; check.dispatchEvent(new Event("change"));
    byText(ui.card, "放大阅读").click(); const dialog = nodes(ui.card).find(n => n.tag === "dialog")!;
    assert.equal(dialog.open, true); assert.ok(nodes(dialog).includes(check));
    let stopped = false; const key = new Event("keydown", { bubbles: true, cancelable: true }); key.stopPropagation = () => { stopped = true; }; dialog.dispatchEvent(key);
    assert.equal(stopped, true, "modal keys must not close the underlying branch"); assert.equal(key.defaultPrevented, false, "native Escape remains available");
    byText(ui.card, "关闭放大阅读").click(); assert.equal(dialog.open, false); assert.equal(nodes(dialog).includes(check), false);
    assert.ok(nodes(ui.card).includes(check)); assert.equal(check.checked, true); assert.equal(ui.requests.length, 1);
  } finally { ui.controller.dispose(); }
});

test("lost POST response keeps intent across retry and double-click causes one request", async () => {
  let attempts = 0;
  const ui = setup(async (_path, options) => {
    if (options.method === "GET") return response([]);
    attempts++; if (attempts === 1) throw new TypeError("network lost");
    return { task: { ...task(), intentId: JSON.parse(options.body!).intentId } };
  });
  try {
    await ui.open(); const generate = byText(ui.card, "生成对比卡"); generate.click(); generate.click(); await tick();
    assert.equal(attempts, 1); assert.equal(ui.store.size, 1);
    byText(ui.card, "重试本次请求").click(); await tick(); assert.equal(attempts, 2);
    const posts = ui.requests.filter(r => r.options.method === "POST");
    assert.equal(JSON.parse(posts[0]!.options.body!).intentId, JSON.parse(posts[1]!.options.body!).intentId); assert.equal(ui.store.size, 0);
  } finally { ui.controller.dispose(); }
});

test("late reads cannot render into another Tree; reopening after abort refreshes again", async () => {
  let resolve: (value: unknown) => void = () => {}; let count = 0;
  const ui = setup(async () => { count++; return count === 1 ? new Promise(r => { resolve = r; }) : response(); });
  try {
    ui.card.open = true; ui.card.dispatchEvent(new Event("toggle")); await tick();
    ui.state.currentTreeId = "other"; resolve(response()); await tick();
    assert.equal(nodes(ui.card).filter(n => n.type === "checkbox").length, 0);
    ui.state.currentTreeId = "tree"; await ui.open(); assert.equal(count, 2);
    assert.equal(nodes(ui.card).filter(n => n.type === "checkbox").length, 1);
  } finally { ui.controller.dispose(); assert.equal(ui.timers.size, 0); }
});

test("new saved revisions never replace the user's selected revision without choosing it", async () => {
  let tasks = [task()]; const ui = setup(async () => response(tasks));
  try {
    await ui.open(); const first = nodes(ui.card).find(n => n.dataset.taskId === "saved")!;
    tasks = [task("new", 2), ...tasks]; await ui.open(); assert.ok(nodes(ui.card).includes(first));
    const select = nodes(ui.card).find(n => n.tag === "select")!; assert.equal(select.hidden, false); assert.equal(select.value, "saved");
    select.value = "new"; select.dispatchEvent(new Event("change")); assert.ok(nodes(ui.card).some(n => n.dataset.taskId === "new"));
  } finally { ui.controller.dispose(); }
});

test("Return draft append preserves edits, rotates a failed request key, and never submits", () => {
  const input = new Element("textarea"); input.value = "我的原有编辑"; const panel = new Element("details");
  const state = { panelBranchId: "branch", currentTreeId: "tree", treeState: { branches: [] }, returnDraft: { branchId: "branch", idempotencyKey: "failed", text: input.value, failed: true } };
  const store = new Map<string, string>();
  const controller = createReturnController({ state, window: { localStorage: createMemoryStorage(store) }, crypto: { randomUUID: () => "fresh" }, $: (id: string) => id === "return-input" ? input : panel,
    branchView: () => ({ turns: [] }), api: () => assert.fail("draft handoff must not submit") });
  controller.appendReturnDraft("branch", "新收获");
  assert.equal(input.value, "我的原有编辑\n\n新收获"); assert.equal(state.returnDraft.idempotencyKey, "fresh"); assert.equal(panel.open, true); assert.equal(store.size, 1);
  controller.appendReturnDraft("other", "不能写入"); assert.equal(input.value, "我的原有编辑\n\n新收获");
});
