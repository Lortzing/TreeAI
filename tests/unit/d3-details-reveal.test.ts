import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
// @ts-expect-error Native browser runner modules have no declarations.
import { createBrowserInput } from "../../scripts/d3/browser-input.mjs";

test("D3 input opens a closed details through a summary with its own id, then hit-tests the target", async () => {
  const rect = { x: 20, y: 20, width: 50, height: 30, top: 20, bottom: 50 };
  const details = { tagName: "DETAILS", open: false, parentElement: null, querySelector: () => summary };
  const summary = { id: "workspace-library-toggle", parentElement: details, contains: (node: unknown) => node === summary,
    scrollIntoView() {}, getBoundingClientRect: () => rect };
  const target = { parentElement: details, contains: (node: unknown) => node === target,
    scrollIntoView() {}, getBoundingClientRect: () => rect };
  const queried: string[] = [];
  const context = { CSS: { escape: (id: string) => id }, window: { innerHeight: 900 }, document: {
    querySelector(selector: string) {
      queried.push(selector);
      if (selector === "#target") return target;
      if (selector === "#workspace-library-toggle") return summary;
      throw new Error(`invalid or unexpected selector: ${selector}`);
    },
    elementFromPoint: () => details.open ? target : summary,
  } };
  const input = createBrowserInput({ chrome: { cdp: { send: async (method: string, params: { expression: string; type: string }) => {
    if (method === "Runtime.evaluate") return { result: { value: await runInNewContext(params.expression, context) } };
    if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") details.open = true;
    return {};
  } } }, sleep: async () => {}, assert: (condition: unknown, message: string) => assert.ok(condition, message), truncate: (s: string) => s }) as { click(selector: string): Promise<void> };
  await input.click("#target");
  assert.equal(details.open, true);
  assert.ok(queried.includes("#workspace-library-toggle"));
  assert.ok(queried.every(selector => !selector.endsWith("> ")));
});
