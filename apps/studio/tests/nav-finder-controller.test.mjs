import { test } from "node:test";
import assert from "node:assert/strict";
import { createNavFinderController } from "../public/core/controllers/nav-finder.js";

function harness() {
  const finder = { phase: "idle", mode: "listing", listing: null, hits: [], hitCursor: null, moreLoading: false };
  const requests = [];
  let query = "";
  const controller = createNavFinderController({
    getState: () => ({ nav: { finder } }),
    getQuery: () => query,
    renderNavFinder() {},
    api: (path) => new Promise((resolve, reject) => requests.push({ path, resolve, reject })),
  });
  return { finder, requests, controller, query: (value) => { query = value; } };
}

test("finder epochs discard superseded listing successes and search failures independently per instance", async () => {
  const a = harness();
  const b = harness();
  const oldListing = a.controller.refreshNavForestListing();
  a.query(" new tree ");
  const oldSearch = a.controller.runNavTreeFind();
  const latest = a.controller.refreshNavForestListing();
  const other = b.controller.refreshNavForestListing();
  const payload = { trees: [{ treeId: "new" }], nextCursor: null, totalTrees: 1 };
  a.requests[2].resolve(payload);
  b.requests[0].resolve(payload);
  await Promise.all([latest, other]);
  a.requests[0].resolve({ trees: [], nextCursor: null, totalTrees: 0 });
  a.requests[1].reject(new Error("obsolete failure"));
  await Promise.all([oldListing, oldSearch]);
  assert.equal(a.finder.phase, "loaded");
  assert.equal(a.finder.error, null);
  assert.deepEqual(a.finder.listing, payload);
  assert.deepEqual(b.finder.listing, payload);
  assert.match(a.requests[1].path, /text=new%20tree&mode=substring&limit=20$/);
});

test("finder keeps loaded pages on failure and retries the same cursor without duplicate in-flight requests", async () => {
  const h = harness();
  const first = h.controller.refreshNavForestListing();
  h.requests[0].resolve({ trees: [{ treeId: "a" }], nextCursor: "a/b", totalTrees: 2 });
  await first;
  const more = h.controller.loadNavForestMore();
  await h.controller.loadNavForestMore();
  assert.equal(h.requests.length, 2);
  h.requests[1].reject(new Error("offline"));
  await more;
  assert.equal(h.finder.moreError, "offline");
  assert.equal(h.finder.moreLoading, false);
  assert.deepEqual(h.finder.listing.trees, [{ treeId: "a" }]);
  const retry = h.controller.loadNavForestMore();
  assert.equal(h.requests[2].path, h.requests[1].path);
  assert.match(h.requests[2].path, /cursor=a%2Fb$/);
  h.requests[2].resolve({ trees: [{ treeId: "b" }], nextCursor: null, totalTrees: 2 });
  await retry;
  assert.deepEqual(h.finder.listing.trees, [{ treeId: "a" }, { treeId: "b" }]);
  assert.equal(h.finder.moreError, null);
});

test("blank finder input replaces search and ignores its late continuation", async () => {
  const h = harness();
  h.query("alpha");
  const search = h.controller.runNavTreeFind();
  h.requests[0].resolve({ hits: [{ treeId: "a" }], nextCursor: "next" });
  await search;
  const more = h.controller.loadNavTreeSearchMore();
  h.query("   ");
  const listing = h.controller.runNavTreeFind();
  h.requests[2].resolve({ trees: [], nextCursor: null, totalTrees: 0 });
  await listing;
  h.requests[1].resolve({ hits: [{ treeId: "obsolete" }], nextCursor: null });
  await more;
  assert.equal(h.finder.mode, "listing");
  assert.equal(h.finder.moreLoading, false);
  assert.deepEqual(h.finder.hits, [{ treeId: "a" }]);
  assert.deepEqual(h.finder.listing.trees, []);
});
