import { test } from "node:test";
import assert from "node:assert/strict";
import { createIsAtBottom } from "../public/shared/reading-position/scroll.js";
import { createSelectionOffsetsWithin } from "../public/shared/source/selection.js";
import { isElementNode, findReusableTurnElement } from "../public/core/dom.js";
import { createMarkdownRenderer } from "../public/core/views/markdown.js";
import { createSearchView } from "../public/core/views/search.js";
import { createReturnCardRenderer } from "../public/core/views/return.js";
import { createDiagnosticsView } from "../public/core/views/diagnostics.js";
import { clampToGraphemeBoundaries } from "../public/shared/source/grapheme.js";

test("scroll follow keeps the 48px threshold and does not pull users reading above", () => {
  const isAtBottom = createIsAtBottom(48);
  assert.equal(isAtBottom({scrollTop:752,clientHeight:200,scrollHeight:1000}),true);
  assert.equal(isAtBottom({scrollTop:751,clientHeight:200,scrollHeight:1000}),false);
});
test("selection offsets reject source mismatch without creating an incorrect anchor", () => {
  const anchor = {};
  const range = {commonAncestorContainer:anchor,startContainer:anchor,startOffset:2,toString:()=> "llo",
    cloneRange:()=>({selectNodeContents(){},setEnd(){},toString:()=> "he"})};
  const select=createSelectionOffsetsWithin({getSelection:()=>({rangeCount:1,getRangeAt:()=>range})});
  const element={contains:node=>node===anchor};
  assert.deepEqual(select(element,"hello"),{start:2,end:5,text:"llo"});
  assert.deepEqual(select(element,"hillo"),{start:2,end:5,text:"llo"}); // unchanged selected slice
  assert.equal(select(element,"helxo"),null); // selected excerpt mismatch
});
test("DOM turn reuse excludes Return cards and requires exact turn text", () => {
  const make=(id,text,isReturn=false)=>({dataset:{turnId:id,turnText:text},
    classList:{contains:c=>c==="turn"||(isReturn&&c==="return")}});
  const normal=make("t1","text"),ret=make("t1","text",true);
  assert.equal(isElementNode(normal),true);
  assert.equal(findReusableTurnElement({children:[ret,normal]}, {id:"t1",text:"text"}),normal);
  assert.equal(findReusableTurnElement({children:[ret,normal]}, {id:"t1",text:"other"}),null);
});


test("R1 Markdown view preserves syntax, source offsets and styled text", () => {
  function element(tag) {
    return {
      tag, className: "", title: "", children: [],
      append(...nodes) { this.children.push(...nodes); },
      set textContent(value) { this.children = [{ textContent: value }]; },
      get textContent() { return this.children.map((node) => node.textContent).join(""); },
    };
  }
  const document = { createElement: element, createTextNode: (value) => ({ textContent: value }) };
  const { renderMarkdownInto } = createMarkdownRenderer(document);
  const source = "# Heading\nA **strong** [link](url) and 🚀\n\n~~~\nconst x = 1;\n~~~";
  const container = element("div");
  assert.equal(renderMarkdownInto(container, source, false), false);
  assert.equal(container.textContent, source);
  assert.ok(container.children.some((child) => child.className === "mat-h1"));
  assert.ok(container.children.some((child) => child.className === "mat-code-line"));
  assert.equal(container.textContent.indexOf("🚀"), source.indexOf("🚀"));
});

test("R1 Markdown view carries fenced-code state between material blocks", () => {
  const element = () => ({
    children: [], append(...nodes) { this.children.push(...nodes); },
    set textContent(value) { this.children = [{ textContent: value }]; },
    get textContent() { return this.children.map((node) => node.textContent).join(""); },
  });
  const document = { createElement: element, createTextNode: (value) => ({ textContent: value }) };
  const { renderMarkdownInto } = createMarkdownRenderer(document);
  const first = element();
  const open = renderMarkdownInto(first, "~~~\nconst x = 1;", false);
  assert.equal(open, true);
  assert.equal(first.textContent, "~~~\nconst x = 1;");
  const second = element();
  assert.equal(renderMarkdownInto(second, "const y = 2;\n~~~", open), false);
  assert.equal(second.textContent, "const y = 2;\n~~~");
});


test("R1 material selection snaps surrogate pairs and combining graphemes outwards", () => {
  assert.deepEqual(clampToGraphemeBoundaries("x🚀y", 2, 3), { start: 1, end: 3, snapped: true });
  assert.deepEqual(clampToGraphemeBoundaries("a\u0301b", 1, 2), { start: 0, end: 2, snapped: true });
  assert.deepEqual(clampToGraphemeBoundaries("x", 0, 1), { start: 0, end: 1, snapped: false });
  assert.equal(clampToGraphemeBoundaries("x", 0, 0), null);
});

test("R1 material selection keeps a joined emoji grapheme intact", () => {
  const text = "x👩‍💻y";
  assert.deepEqual(clampToGraphemeBoundaries(text, 2, text.length - 1), {
    start: 1, end: text.length - 1, snapped: true,
  });
});


test("R1 Search view preserves honest idle, loading, failed, empty, and populated states", async () => {
  function element(tag) {
    const node = {
      tag,
      className: "",
      title: "",
      disabled: false,
      dataset: {},
      children: [],
      attributes: {},
      listeners: {},
      focused: false,
      append(...nodes) { this.children.push(...nodes); },
      replaceChildren(...nodes) { this.children = [...nodes]; },
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(name, listener) { this.listeners[name] = listener; },
      focus() { this.focused = true; },
      classList: {
        toggle(name, on) { node.className = on ? `${node.className} ${name}`.trim() : node.className; },
      },
      set textContent(value) { this.children = [{ textContent: String(value) }]; },
      get textContent() { return this.children.map((child) => child.textContent ?? "").join(""); },
    };
    return node;
  }
  const document = { createElement: element, createTextNode: (value) => ({ textContent: String(value) }) };
  const nodes = new Map();
  for (const id of [
    "search-scope-tree", "search-scope-all", "search-kind-material", "search-kind-annotation",
    "search-kind-return", "search-kind-turn", "search-status", "search-results",
    "prompt-input", "panel-prompt-input",
  ]) nodes.set(id, element(id));
  const state = {
    currentTreeId: null,
    treeState: null,
    search: {
      scope: "tree", kinds: ["material", "annotation", "return", "turn"], phase: "idle", note: null,
      resultScope: "all", resultQuery: null, hits: [], error: null,
    },
  };
  let jumped = null;
  let openedBranch = null;
  const view = createSearchView({
    document,
    getElement: (id) => nodes.get(id),
    getState: () => state,
    mutedListItem: (text) => { const item = element("li"); item.textContent = text; return item; },
    formatProductTime: () => "2026-10-10",
    closeSidebar: () => {},
    guard: async (fn) => fn(),
    jumpToSearchHit: (hit) => { jumped = hit; },
    locateAnnotationHit: () => null,
    locateTurnHit: (hit) => ({ view: { branch: { id: hit.target.branchId } } }),
    branchView: (branchId) => branchId === "b1" ? { sessionAvailability: "unavailable" } : null,
    trunkBranchId: () => "trunk",
    openBranchPanel: async (branchId) => { openedBranch = branchId; },
  });

  view.renderSearchSection();
  assert.equal(nodes.get("search-scope-tree").disabled, true);
  assert.match(nodes.get("search-status").textContent, /saved facts/);
  assert.equal(nodes.get("search-results").children.length, 0);

  state.search.phase = "loading";
  view.renderSearchSection();
  assert.equal(nodes.get("search-results").textContent, "searching…");

  state.search.phase = "failed";
  state.search.error = "network down";
  view.renderSearchSection();
  assert.match(nodes.get("search-status").textContent, /network down/);
  assert.match(nodes.get("search-results").textContent, /network down/);

  state.search.phase = "loaded";
  state.search.error = null;
  state.search.resultQuery = "missing";
  state.search.hits = [];
  view.renderSearchSection();
  assert.match(nodes.get("search-status").textContent, /0 hits/);
  assert.match(nodes.get("search-results").textContent, /no results/);

  state.currentTreeId = "t1";
  state.search.scope = "all";
  state.search.resultScope = "all";
  state.search.resultQuery = "alpha";
  const materialHit = {
    kind: "material", treeId: "t2", treeTitle: "other tree", materialTitle: "Notes",
    versionLabel: "v1", oldVersion: true, createdAt: "2026-10-10T00:00:00Z", title: "Notes",
    excerpt: "alpha", target: { kind: "material", treeId: "t2", materialId: "m1", versionId: "v1", blockId: "b1" },
  };
  state.search.hits = [materialHit];
  view.renderSearchSection();
  assert.match(nodes.get("search-results").textContent, /旧版本/);
  assert.match(nodes.get("search-results").textContent, /other tree/);
  assert.equal(view.getSearchHitButton("material:t2:m1:v1:b1").dataset.hitKey, "material:t2:m1:v1:b1");

  state.treeState = { branches: [] };
  const turnHit = {
    kind: "turn", treeId: "t1", treeTitle: "current", oldVersion: false,
    createdAt: "2026-10-10T00:00:00Z", title: "Answer", excerpt: "saved", target: {
      kind: "turn", treeId: "t1", branchId: "b1", turnId: "turn-1",
    },
  };
  state.search.hits = [turnHit];
  view.renderSearchSection();
  assert.match(nodes.get("search-results").textContent, /session unavailable/);
  const explore = nodes.get("search-results").children[0].children[1].children[1];
  explore.listeners.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(openedBranch, "b1");
  assert.equal(jumped, null);
});


test("R1 Return view preserves anchored/fallback source facts and adoption states", () => {
  function element(tag) {
    const node = {
      tag,
      className: "",
      title: "",
      dataset: {},
      children: [],
      listeners: {},
      append(...nodes) { this.children.push(...nodes); },
      addEventListener(name, listener) { this.listeners[name] = listener; },
      focus() {},
      classList: {
        add(...names) { node.className = [...new Set(`${node.className} ${names.join(" ")}`.trim().split(/\s+/))].join(" "); },
        contains(name) { return node.className.split(/\s+/).includes(name); },
      },
      set textContent(value) { this.children = [{ textContent: String(value) }]; },
      get textContent() { return this.children.map((child) => child.textContent ?? "").join(""); },
    };
    return node;
  }
  const document = { createElement: element, createTextNode: (value) => ({ textContent: String(value) }) };
  const knownReturnIds = new Set();
  const seenDeliveredRunIds = new Map();
  const turnElements = new Map();
  const returnInsertedAt = new Map();
  const deliveredChangedAt = new Map();
  let treeState = {
    branches: [{ turns: [{ id: "anchor-1", branchId: "branch-1", role: "assistant", text: "The answer" }] }],
  };
  const drawerCalls = [];
  const renderer = createReturnCardRenderer({
    document,
    getCurrentTreeId: () => "tree-1",
    getTreeState: () => treeState,
    knownReturnIds,
    seenDeliveredRunIds,
    turnElements,
    returnInsertedAt,
    deliveredChangedAt,
    motionEpochMs: 260,
    branchLabel: (id) => id === "branch-1" ? "Branch 1" : id,
    formatProductTime: (value) => value,
    openDrawer: (opts) => { drawerCalls.push(opts); },
  });
  const anchor = {
    sourceBranchId: "branch-1", anchorTurnId: "anchor-1", anchorEntryId: "entry-1",
    selection: { start: 4, end: 10, text: "answer" },
  };
  const makeTurn = (overrides = {}) => ({
    id: "return-1", fromBranchId: "branch-1", text: "Returned conclusion.", createdAt: "saved-at",
    deliveredRunId: null, targetAnchor: anchor, ...overrides,
  });

  const anchored = renderer.returnCard(makeTurn(), anchor, [], "anchored");
  assert.ok(anchored.classList.contains("turn"));
  assert.ok(anchored.classList.contains("return"));
  assert.ok(anchored.classList.contains("insert"));
  assert.match(anchored.textContent, /anchored on “answer” from Branch 1/);
  assert.match(anchored.textContent, /saved — pending adoption on the next Trunk discussion/);
  assert.equal(turnElements.get("return-1"), anchored);
  assert.equal(returnInsertedAt.size, 1);

  const elsewhere = renderer.returnCard(makeTurn({ id: "return-elsewhere" }), anchor, [], "fallback");
  assert.match(elsewhere.textContent, /source on Branch 1/);
  treeState = { branches: [{ turns: [{ id: "anchor-1", branchId: "branch-1", role: "assistant", text: "Changed answer" }] }] };
  const changed = renderer.returnCard(makeTurn({ id: "return-changed" }), anchor, [], "fallback");
  assert.match(changed.textContent, /source changed/);
  treeState = { branches: [] };
  const missing = renderer.returnCard(makeTurn({ id: "return-missing" }), anchor, [], "fallback");
  assert.match(missing.textContent, /source missing/);

  const longText = "x".repeat(121);
  const longAnchor = { ...anchor, selection: { ...anchor.selection, text: longText } };
  const longCard = renderer.returnCard(makeTurn({ id: "return-long", targetAnchor: longAnchor }), longAnchor, [], "anchored");
  const details = longCard.children.find((child) => child.className === "return-excerpt collapsible");
  assert.ok(details !== undefined);
  assert.equal(details.textContent, `“${longText.slice(0, 100)}…”“${longText}”`);

  const attempted = renderer.returnCard(
    makeTurn({ id: "return-attempted" }),
    anchor,
    [{ turnId: "return-attempted", runId: "run-failed", runState: "failed", failure: { code: "model-error" } }],
    "anchored",
  );
  assert.match(attempted.textContent, /adoption attempted \(1\) — still pending/);

  const deliveredId = "run-delivered-123456789";
  seenDeliveredRunIds.set("tree-1:return-delivered", null);
  const delivered = renderer.returnCard(
    makeTurn({ id: "return-delivered", deliveredRunId: deliveredId }),
    anchor,
    [{ turnId: "return-delivered", runId: deliveredId, runState: "succeeded", failure: null, terminalAt: "adopted-at" }],
    "anchored",
  );
  assert.match(delivered.textContent, /successfully adopted into Trunk context/);
  assert.match(delivered.textContent, /adopted-at/);
  assert.ok(delivered.children[0].children[1].classList.contains("delivered"));
  assert.ok(delivered.children[0].children[1].classList.contains("badge-change"));
  delivered.children[0].children[1].listeners.click();
  assert.deepEqual(drawerCalls, [{
    focusRunId: deliveredId,
    trigger: { kind: "return-card", turnId: "return-delivered" },
  }]);
});


test("R1 diagnostics view preserves run, policy, and failure-panel states", () => {
  function element(tag) {
    const node = {
      tag,
      className: "",
      hidden: false,
      disabled: false,
      children: [],
      listeners: {},
      append(...nodes) { this.children.push(...nodes); },
      replaceChildren(...nodes) { this.children = [...nodes]; },
      addEventListener(name, listener) { this.listeners[name] = listener; },
      set textContent(value) { this.children = [{ textContent: String(value) }]; },
      get textContent() { return this.children.map((child) => child.textContent ?? "").join(""); },
    };
    return node;
  }
  const document = { createElement: element, createTextNode: (value) => ({ textContent: String(value) }) };
  const nodes = new Map();
  for (const id of ["diagnostics-bar", "failure-panel", "run-status", "run-detail", "abort-run", "policy-note"]) {
    nodes.set(id, element(id));
  }
  const state = { diagnostics: null, treeState: null, dismissedFailureRunIds: new Set() };
  const view = createDiagnosticsView({
    document,
    getElement: (id) => nodes.get(id),
    getState: () => state,
    branchLabel: (id) => id === "branch-1" ? "Branch 1" : id,
  });

  view.renderDiagnostics();
  assert.equal(nodes.get("diagnostics-bar").hidden, true);
  assert.equal(nodes.get("failure-panel").hidden, true);

  state.treeState = {};
  state.diagnostics = {
    runtimeState: "idle", activeRun: null, runs: [],
    policyDecisions: { observed: false, reason: "offline" },
  };
  view.renderDiagnostics();
  assert.equal(nodes.get("diagnostics-bar").hidden, false);
  assert.equal(nodes.get("run-status").textContent, "idle");
  assert.equal(nodes.get("run-detail").textContent, "no runs yet");
  assert.equal(nodes.get("abort-run").hidden, true);
  assert.equal(nodes.get("policy-note").textContent, "policy: no decisions observed — offline");

  state.diagnostics = {
    runtimeState: "streaming",
    activeRun: { runId: "run-active", branchId: "branch-1" },
    runs: [{ runId: "run-old", state: "aborted", failure: null }],
    policyDecisions: {
      observed: true,
      decisions: [{ tool: "read", outcome: "allow", ruleId: "rule-1" }],
    },
  };
  view.renderDiagnostics();
  assert.equal(nodes.get("run-status").className, "run-status streaming");
  assert.match(nodes.get("run-detail").textContent, /active run on Branch 1/);
  assert.match(nodes.get("run-detail").textContent, /last run: aborted/);
  assert.equal(nodes.get("abort-run").textContent, "Abort run");
  assert.equal(nodes.get("abort-run").disabled, false);
  assert.match(nodes.get("policy-note").textContent, /1 decision\(s\) observed/);
  assert.match(nodes.get("policy-note").textContent, /latest: read allow \(rule-1\)/);

  state.diagnostics.runtimeState = "aborting";
  view.renderDiagnostics();
  assert.equal(nodes.get("abort-run").textContent, "Aborting…");
  assert.equal(nodes.get("abort-run").disabled, true);

  state.diagnostics = {
    runtimeState: "idle", activeRun: null,
    runs: [{ runId: "run-failed-123456789", state: "failed", failure: { code: "session-corrupt", message: "missing session" } }],
    policyDecisions: { observed: false, reason: "offline" },
  };
  view.renderDiagnostics();
  assert.match(nodes.get("failure-panel").textContent, /session-corrupt: missing session/);
  assert.equal(nodes.get("failure-panel").children[0].className, "failure-panel-label");
  assert.match(nodes.get("failure-panel").children[0].textContent, /Run run-failed-1… failed/);
  assert.equal(nodes.get("failure-panel").children[1].className, "failure-panel-dismiss");
  nodes.get("failure-panel").children[1].listeners.click();
  assert.equal(nodes.get("failure-panel").hidden, true);
  view.renderDiagnostics();
  assert.equal(nodes.get("failure-panel").hidden, true);

  state.diagnostics.runs.push({ runId: "run-new-failed", state: "failed", failure: { code: "other", message: "new failure" } });
  view.renderDiagnostics();
  assert.match(nodes.get("failure-panel").textContent, /new failure/);
});
