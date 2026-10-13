import test from "node:test";
import assert from "node:assert/strict";
import { createStubText, flattenNodes } from "./support/dom-primitives.ts";
import { createStubRange, createStubTextRange } from "./support/selection-stubs.ts";
import { createMemoryStorage, createStubEventSource, stubResponse } from "./support/browser-stubs.ts";

interface Element { parentElement: Element | null; children: Node[] }
const Text = createStubText<Element>();
type Text = InstanceType<typeof Text>;
type Node = Element | Text;

test("shared factories preserve constructor and SSE registry isolation", () => {
  const OtherText = createStubText<Element>();
  const text = new Text("same data");
  assert.ok(text instanceof Text);
  assert.ok(!(text instanceof OtherText));
  const Source = createStubEventSource();
  const OtherSource = createStubEventSource();
  const source = new Source("/events");
  assert.equal(Source.latest(), source);
  assert.equal(OtherSource.latest(), null);
  OtherSource.resetRegistry();
  assert.equal(Source.latest(), source);
  source.close();
});

test("material ranges retain cross-node offsets and fresh text after edits", () => {
  const root: Element = { parentElement: null, children: [] };
  const first = new Text("alpha ");
  const second = new Text("beta");
  first.parentElement = root;
  second.parentElement = root;
  root.children = [first, second];
  const snapshot = () => flattenNodes<Node>(root, n => n instanceof Text ? n.data : null,
    n => n instanceof Text ? [] : n.children);
  const doc = { root, flattenedText: () => snapshot().text,
    textStartOf: (n: Node) => snapshot().starts.get(n) ?? 0,
    subtreeTextLength: (n: Node) => (snapshot().ends.get(n) ?? 0) - (snapshot().starts.get(n) ?? 0) };
  const Range = createStubRange<Node, Element, Text>(Text);
  const range = new Range(doc, first, 3, second, 2);
  assert.equal(range.toString(), "ha be");
  assert.equal(range.commonAncestorContainer, root);
  assert.ok(range.cloneRange() instanceof Range);
  first.data = "omega ";
  assert.equal(range.toString(), "ga be");
  range.selectNodeContents(root);
  range.setEnd(root, 1);
  assert.equal(range.toString(), "omega ");
});

test("text ranges reject another node while preserving reversed endpoint slices", () => {
  const Range = createStubTextRange<Node, Text, Element>();
  const text = new Text("abcdef");
  const range = new Range(text, 5, 2);
  assert.equal(range.toString(), "cde");
  assert.equal(range.cloneRange().toString(), "cde");
  assert.throws(() => range.setEnd(new Text("abcdef"), 3), /own text node/);
});

test("storage and response stubs retain separate stores and payload identity", async () => {
  const values = new Map<string, string>();
  const first = createMemoryStorage(values);
  const second = createMemoryStorage(new Map());
  first.setItem("draft", "saved");
  assert.equal(values.get("draft"), "saved");
  assert.equal(second.getItem("draft"), null);
  second.clear();
  assert.equal(first.getItem("draft"), "saved");
  const payload = { error: "conflict" };
  const response = stubResponse(409, payload);
  assert.equal(response.ok, false);
  assert.equal(await response.json(), payload);
});
