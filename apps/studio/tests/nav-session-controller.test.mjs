import { test } from "node:test";
import assert from "node:assert/strict";
import { createNavSessionController } from "../public/core/controllers/nav-session.js";
import { createNavPersistenceController } from "../public/core/controllers/nav-persistence.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));
function harness() {
  const state = { nav: { session: null } };
  const requests = [];
  const selections = [];
  const reveals = [];
  const elements = new Map();
  const api = (path, method, body) => new Promise((resolve, reject) => requests.push({ path, method, body, resolve, reject }));
  const noop = () => {};
  const controller = createNavSessionController({
    getState: () => state,
    getElement: (id) => {
      if (!elements.has(id)) elements.set(id, { replaceChildren() {} });
      return elements.get(id);
    },
    api,
    renderNavSurfaceChrome: noop, renderNavTree: noop, renderNavPath: noop,
    renderNavNodeResults: noop, renderNavFinder: noop,
    selectNavNode: (...args) => selections.push(args),
    navRevealBranch: (...args) => reveals.push(args),
  });
  const persistence = createNavPersistenceController({ getState: () => state, api, renderNavTreeStatusOnly: noop });
  return { state, requests, controller, persistence, selections, reveals };
}
const overview = (id) => ({ trunkBranchId: `${id}-root`, title: null, createdAt: "now" });
const page = { nodes: [], nextCursor: null, totalChildren: 0 };

async function open(h, id = "tree/a", saved = null) {
  const pending = h.controller.openNavTree(id);
  h.requests.at(-1).resolve(overview(id));
  await tick();
  h.requests.at(-2).resolve(page);
  h.requests.at(-1).resolve({ expandState: saved });
  await pending;
  return h.state.nav.session;
}

test("navigation sessions ignore obsolete overview failures and closed-tree responses independently", async () => {
  const h = harness();
  const other = harness();
  const old = h.controller.openNavTree("old");
  const current = await open(h, "current");
  h.requests[0].reject(new Error("obsolete"));
  await old;
  assert.equal(current.overviewState, "loaded");
  const pending = other.controller.openNavTree("closed");
  other.controller.closeNavTree();
  other.requests[0].resolve(overview("closed"));
  await pending;
  assert.equal(other.state.nav.session, null);
  assert.equal(other.requests.length, 1);
  assert.equal(h.state.nav.session, current);
});

test("restoring shallow and deep selection stays read-only and preserves the full expanded set", async () => {
  const h = harness();
  await open(h, "shallow", { selectedBranchId: "shallow-root", expandedBranchIds: ["shallow-root"] });
  assert.deepEqual(h.selections, [["shallow-root", { scroll: true, persist: false }]]);
  const deep = await open(h, "deep", { selectedBranchId: "deep-leaf", expandedBranchIds: ["deep-root", "deep-parent"] });
  assert.deepEqual([...deep.expanded], ["deep-root", "deep-parent"]);
  assert.deepEqual(h.reveals, [[deep, "deep-leaf", undefined, { persist: false }]]);
  assert.ok(h.requests.every((request) => request.method !== "PUT"));
});

test("child paging merges in-flight requests and recovers stale cursors from the first page", async () => {
  const h = harness();
  const session = await open(h);
  const root = session.overview.trunkBranchId;
  const entry = h.controller.navChildEntry(session, root);
  entry.ids = ["obsolete"];
  entry.state = "partial";
  entry.nextCursor = "cursor/a";
  session.nodes.set("obsolete", { id: "obsolete" });
  const first = h.controller.navLoadChildrenPage(session, root, "next");
  const second = h.controller.navLoadChildrenPage(session, root, "next");
  assert.equal(h.requests.length, 4);
  assert.match(h.requests[3].path, /limit=50&cursor=cursor%2Fa$/);
  h.requests[3].reject(Object.assign(new Error("invalidated"), { code: "stale-cursor" }));
  await tick();
  assert.equal(h.requests.length, 5);
  assert.doesNotMatch(h.requests[4].path, /cursor=/);
  h.requests[4].resolve({ nodes: [{ id: "fresh" }], totalChildren: 1, nextCursor: null });
  await Promise.all([first, second]);
  assert.equal(session.nodes.has("obsolete"), false);
  assert.deepEqual(h.controller.navChildEntry(session, root).ids, ["fresh"]);
  assert.equal(session.nodes.get(root).childCount, 1);
});

test("navigation persistence serializes writes and coalesces rapid changes to the newest full snapshot", async () => {
  const h = harness();
  const session = await open(h);
  session.expanded.add("a");
  h.persistence.scheduleNavPersist(session);
  session.expanded.add("b");
  h.persistence.scheduleNavPersist(session);
  session.expanded.delete("a");
  session.selectedBranchId = "b";
  h.persistence.scheduleNavPersist(session);
  assert.equal(h.requests.length, 4);
  assert.deepEqual(h.requests[3].body, { expandedBranchIds: ["a"], selectedBranchId: null });
  h.requests[3].reject(new Error("offline"));
  await tick();
  assert.equal(session.persistError, "offline");
  assert.equal(h.requests.length, 5);
  assert.deepEqual(h.requests[4].body, { expandedBranchIds: ["b"], selectedBranchId: "b" });
  h.requests[4].resolve(null);
  await tick();
  assert.equal(session.persistError, null);
  assert.equal(session.persistRunning, false);
});

test("a late persistence failure after navigation closes never contaminates the next session", async () => {
  const h = harness();
  const previous = await open(h, "old");
  h.persistence.scheduleNavPersist(previous);
  const request = h.requests.at(-1);
  h.persistence.scheduleNavPersist(previous);
  const next = await open(h, "next");
  request.reject(new Error("old failure"));
  await tick();
  assert.equal(next.persistError, null);
  assert.equal(h.requests.filter((item) => item.method === "PUT").length, 1);
});
