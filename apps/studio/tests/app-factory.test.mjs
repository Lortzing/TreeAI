import { test } from "node:test";
import assert from "node:assert/strict";
import { createStudioApp } from "../public/core/create-studio-app.js";

test("Studio exposes independently constructed instance lifecycle without eager DOM side effects", () => {
  const deps = { document: null, window: null, fetch: null, EventSource: null };
  const first = createStudioApp(deps);
  const second = createStudioApp(deps);
  assert.notEqual(first, second);
  assert.equal(typeof first.start, "function");
  assert.equal(typeof second.dispose, "function");
  first.dispose();
  second.dispose();
});
